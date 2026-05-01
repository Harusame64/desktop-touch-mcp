# Walking Skeleton — trunk 選定 (ADR-007 / 008 / 010 統合貫通)

- Status: **Proposed (Sonnet 起草、Opus レビュー前)**
- Date: 2026-05-01
- Author: Claude (Sonnet) — Opus レビュー後に Approved 化
- Scope: ADR-007 / 008 / 010 を 3 ADR 並走させる前に「最も細い縦串 1 本」を確定する
- 北極星整合: 各層の **最も難しい contract** を trunk で先に lock し、以降の expansion を並列化可能にする

---

## 1. 背景 — 現状の把握 (2026-05-01 時点)

### 1.1 各 ADR の進捗

| 層 | ADR | 進捗 | 直近マイルストーン |
|---|---|---|---|
| L1 Capture | ADR-007 | 約 90% (P1-P5c-2 完了、P5c-3/4 + P5d 残) | #102 (DXGI dirty rect → L1 ring emit) |
| L2/L3 Storage+Compute | ADR-008 | D1 完了 + D2-A〜D2-C0 完了、D2-C/D/E0/E/F/G 残 | #99/#100 (L1 emitter readiness gate) |
| L4/L5 Projection+Tool | ADR-010 | **未着手 (P1-P7 全て pending)** | (なし、起草段階) |

### 1.2 既に動いている (擬似) trunk

現行 main で以下は接続済み:

```
L1 UIA Focus event → l1-capture ring → L2 focus_pump
                                          ↓
                                    L3 latest_focus + current_focused_element view
                                          ↓
                                    L5 desktop_state.ts (view 経由読み取り)
```

これは **trunk 未満** (L4 未通過、commit 軸未通過、複数 view JOIN 未通過、DXGI 経路未通過、envelope 未通過)。

### 1.3 各層の "最も難しい contract" (trunk 必須通過点)

| 層 | 最も難しい contract | 理由 |
|---|---|---|
| L1 | UIA + DXGI が **同 causal window** に partial-order で押し出される (= 同 logical_time、§3.4 で詳述。wallclock 同一の意味ではない) | 単一 event source 経路は既に動く。複数 source 並走で sub_ordinal の整合と、`monitor_index` 等の payload field 整合性が初めて試される (#102 で hard-coded `monitor_index: 0` が API contract regression を起こした事例、CLAUDE.md §3.2 教訓あり) |
| L2/L3 | **複数 view を 1 dataflow scope 内に build** (D2-E0) | timely `Arranged` の lifetime 制約、view 同士の fan-out が単一 view path では試されていない |
| L4 | **`caused_by` のクロスレイヤー linkage** (commit 軸の tool_call_id を後続 query envelope に binding) | session_id / tool_call_id / event_id の 3 識別子が **時系列を跨いで** 結合される必要があり、L4 で最も実装重 |
| L5 | **query 軸 + commit 軸の両方を 1 wrapper で扱う + lease_token 4-tuple validation** | query 単独 path は擬似 trunk で動く。commit (副作用 + caused_by 注入 + lease 4-tuple 検証) を wrapper に統合する所が新規。lease 4-tuple = `(entityId, viewId, targetGeneration, evidenceDigest)` が architecture §4.2 / `LeaseStore` SSOT で確定済 |

これら 4 点を **同時に踏む** trunk を選ぶ必要がある。1 つでも避けると contract が嘘になり、expansion で全インスタンスに同じ手戻りが発生する。

---

## 2. Trunk 候補 3 案

### 2.1 候補 A: 擬似 trunk + envelope 最小だけ被せる

**範囲**: 既存の `desktop_state` focus path に ADR-010 P1 (envelope minimal: `_version`, `data`, `as_of`, `confidence`) を被せて完了。

**Rust 慎重コスト**: 極小 (Rust 側ほぼ手付かず)。

**locks する contract**:
- L4 envelope skeleton

**lock しない contract**:
- ❌ L1 UIA + DXGI 同 logical_time
- ❌ L2/L3 複数 view scope
- ❌ L4 caused_by linkage
- ❌ L5 commit 軸

**判定**: ❌ **trunk として却下**。fake contract (簡単な path で確定した shape が、難しい path で破綻する)。expansion 段階で commit 軸 / caused_by / 複数 view 全部に同じ設計やり直しが発生する。

### 2.2 候補 B: screenshot + dirty_rects_aggregate で DXGI 経路を貫通

**範囲**: `screenshot` ツールを起点に、L1 DXGI dirty rect → L2 → L3 `dirty_rects_aggregate` view → L4 envelope → L5 で返す。

**Rust 慎重コスト**: 中 (D2-C `dirty_rects_aggregate` view 新設 + DXGI emit 整合)。

**locks する contract**:
- L1 DXGI 経路
- L2/L3 単一 view (新設)
- L4 envelope minimal + `as_of` (DXGI frame timestamp)

**lock しない contract**:
- ❌ L1 UIA + DXGI **同 logical_time** (UIA 経路を踏まない)
- ❌ L2/L3 **複数 view** scope (1 view しか作らない)
- ❌ L4 **caused_by** (commit が無いので「直前 action」の linkage が試されない)
- ❌ L5 commit 軸

**判定**: △ **部分的**。L1 の DXGI 経路は lock するが L4 の最重要 contract (caused_by) と L3 の multi-view scope を lock しない。expansion で commit 系 tool を増やす段階で再設計になる。

### 2.3 候補 C: desktop_discover → desktop_act → desktop_state (architecture §6 "1 event の旅" + lease 4-tuple)

**範囲**: `desktop_discover` (query、lease 発行) → `desktop_act(lease, action="invoke")` (commit、lease 4-tuple validation + UIA InvokePattern 副作用) → UIA Focus event + DXGI dirty rect 両方発火 → 続く `desktop_state` (query) が **caused_by に直前 desktop_act を載せた** envelope を返す。

`click_element` は **expansion / fallback example に降格** (lease 経由しない直接 name match path、契約面では「lease 不在の commit」というバリエーションで、trunk pattern を一度確定すれば mechanical コピーで対応可能)。

**Rust 慎重コスト**: 中〜大 (D2-E0 dataflow scope refactor + D2-C 簡易版 + L4 caused_by 配線 + L5 wrapper + L1 既存 ToolCallStarted/Completed payload 確定)。

**locks する contract**:
- ✅ L1 UIA + DXGI **同 causal window** (desktop_act → 両 event source 同時発火、§3.4)
- ✅ L2/L3 **複数 view JOIN** (focus view + dirty_rects_aggregate view を同 scope で)
- ✅ L4 **caused_by linkage** (tool_call_id="desktop_act の seq" → 次の desktop_state の envelope.caused_by に展開)
- ✅ L5 **query 軸 + commit 軸の両方** (1 wrapper で 2 軸 dispatch、§7 の API 3 軸の最初 2 軸を踏む)
- ✅ L5 **lease_token 4-tuple validation** (`LeaseStore.validate()` の reason → typed enum 経路を trunk で lock、architecture §4.2)
- ✅ L4 **failure envelope** (lease validation 失敗時の `if_unexpected.most_likely_cause = "LeaseExpired"` を typed enum で 1 ケース実装、P2 最小確認 + lease 経路同時カバー)
- ✅ L1 **既存 `EventKind::ToolCallStarted (=100)` / `ToolCallCompleted (=101)` の payload 確定** (新規 EventKind 追加ではなく、L1 既存 schema の payload field を本 trunk で fix、`src/l1_capture/envelope.rs` 既存定義 + `src/l1_capture/napi.rs` の `l1_push_tool_call_started` / `l1_push_tool_call_completed` を活用)

**判定**: ✅ **採用**。architecture-3layer-integrated.md §6 の worked example を **contract spike として最小実装** する。3 ADR の最も難しい contract を **同時に** 踏むが、完成度を上げる実装は expansion に外出しする。Opus review round 1 P1-5 / Counter 3 を反映し、`click_element` 経由から `desktop_act` 経由 (lease 4-tuple 含む) に切替済 (2026-05-01)。

---

## 3. 推奨 trunk: 候補 C (desktop_discover → desktop_act → desktop_state)

### 3.1 採用理由 (要約)

候補 C のみが、各層の最重要 contract を **同時に** 踏む (lease 4-tuple validation + commit 軸 + caused_by + query envelope + L1 既存 ToolCallStarted/Completed)。候補 A/B は「動くけど嘘」の contract を作ってしまい、expansion で再設計コストが発生する。

候補 C を選ぶことで:

1. **Rust 慎重コストが trunk に集中** — D2-E0 (scope refactor) + D2-C 簡易版が trunk のみに必要。expansion phase は Rust 改修ほぼ不要 (新 view 追加は同 scope 内で同型コピー、新 tool 追加は L5 wrapper の TS 改修)
2. **L4 最難 (caused_by) を最初に lock** — caused_by が動けば invariants (P3 残) / query_past (P4) / dry-run (P5) / memory (P6) は全て「caused_by の構造のバリエーション」になる
3. **L5 lease 4-tuple を trunk で踏む** — desktop_act が `LeaseStore.validate()` を経由するため、lease 経路の typed reason (`LeaseExpired` / `LeaseGenerationMismatch` / `LeaseDigestMismatch` / `EntityNotFound` / `EntityOutsideViewport` の 5 codes) と envelope の if_unexpected の linkage が最初から locked される。click_element 維持時にハンディとして残る「lease 経路は expansion で別 PR」が消える
4. **expansion 並列化が真に効く形になる** — trunk 完成後、commit 系 14 tool / query 系 10 tool が **同じ shape のコピー** で増える → worktree 並走で最大限速度が出る。`click_element` (lease 不在 commit) も「lease 経由しないバリエーション」として mechanical コピー対象

### 3.2 方針補正: full implementation ではなく contract spike

本 trunk の目的は「上層機能を完成させる」ことではなく、**全階層をつないだときに嘘になる contract を早期に発見する** こと。したがって候補 C は採用するが、各 PR の完了基準は完成度ではなく contract の成立確認に寄せる。

具体的には:

- `dirty_rects_aggregate` は count のみでよい。RectId list / union 計算 / secondary monitor は expansion。
- `produced_changes` は focus delta + dirty rect count のみでよい。semantic summary は expansion。
- session memory は in-memory の小さな buffer に固定する。永続化 / query_past / working memory taxonomy は expansion。
- failure envelope は 1 typed reason のみでよい。try_next の網羅や recovery quality は expansion。
- performance bench は regression guard に留める。SLO を満たすための最適化は contract が成立してから判断する。

この制約により、trunk 15-21 日の見積 (Opus P1-5 (a) 採用、§4.1) は「最大許容」に近い扱いとし、途中ゲート (G1/G2/G3、§5.1) で scope を絞り直せるようにする。

### 3.3 trunk が踏まない (= expansion で扱う) 部分

| 領域 | trunk 範囲 | expansion 範囲 |
|---|---|---|
| L1 emit sites | UIA Focus + DXGI dirty (既存) + 既存 ToolCallStarted/Completed payload 確定 | P5c-3 Window / P5c-4 Scroll / P5d timestamp 多重化 |
| L1 DXGI payload | `monitor_index` field を **必ず保持** (PR #102 と同型 regression 防止、CLAUDE.md §3.2)、aggregate を per-monitor 分離するかは expansion | secondary monitor の subscription 配線 / per-monitor aggregate 分離 |
| L3 views | focus + dirty_rects_aggregate (簡易版、`monitor_index` field 付き) | semantic_event_stream / predicted_post_state |
| L4 envelope | `_version` + `data` + `as_of` + `confidence` (`fresh` / `degraded` 2 値) + `caused_by` + 失敗時 `if_unexpected.most_likely_cause` 1 種 | invariants_held / query_past / if_you_did / include working/episodic / `cached` / `inferred` / `stale` 残 3 値 |
| L5 wrappers | `desktop_state` (query) + `desktop_discover` (query/lease 発行) + `desktop_act` (commit/lease 検証) | 残り ~25 tool (`click_element` を含む lease 不在 commit パターンも expansion) |
| L5 lease validation | `LeaseStore.validate()` 経由を 1 path 確認、typed reason `LeaseExpired` を 1 ケース実装 | 残り 4 lease codes (`LeaseGenerationMismatch` / `LeaseDigestMismatch` / `EntityNotFound` / `EntityOutsideViewport`) |
| typed reason enum | 1 種類 (`LeaseExpired` 第一候補) | 残り 36 codes |
| envelope compat mode | server が `data` field を top-level に hoist する compat mode を skeleton 段階から実装 (architecture §11.2)、既存 raw shape client 互換 | opt-in flag で envelope shape を要求するスキーム精緻化 |

### 3.4 trunk fixture / causality 前提

候補 C は「desktop_discover → desktop_act すれば UIA Focus event と DXGI dirty rect が両方出る」ことを前提にするため、trunk の e2e は制御された fixture を使う。lease 発行対象の entity が安定して discover でき、desktop_act の InvokePattern で focus 遷移と描画差分が確実に出る対象に固定する。既に focus 済みの要素に対して act して focus delta が出ない、描画差分が出ない、などの環境依存で contract 判定が揺れないようにする。

最小 fixture 条件:

- `desktop_discover` で **lease 発行対象 entity が安定して列挙される** (entityId + viewId + targetGeneration + evidenceDigest が deterministic)。
- `desktop_act(lease, ...)` 前に focus A、act 後に focus B へ確実に遷移する。
- act 後に primary monitor 上で小さな描画差分が確実に出る (DXGI dirty rect が空にならない)。
- modal / animation / debounce など、caused_by の判定を曖昧にする挙動を入れない。
- lease 発行 → desktop_act までの間に lease の `targetGeneration` が変動しない (lease validation を成功 path で踏める)。

「UIA + DXGI 同 logical_time」は、wallclock が同一という意味ではない。UIA event と DXGI dirty rect は自然には別 wallclock で到着するため、L2 で同一 tool_call causal window に属する event 群として materialize され、同じ query envelope の `based_on.events` / `caused_by.produced_changes` に入ることを contract とする。

**causal window 境界 (Proposed v0.4、user feedback 2026-05-01 反映)**: window 左端は `ToolCallStarted` event_id、右端は `ToolCallCompleted` で閉じず、**次のいずれかが先に成立した時点**:

- (a) 次 query (= 次の `desktop_state`) が呼ばれた時点の event frontier
- (b) timeout 経過 (デフォルト 200ms、tunable)
- (c) first stable observation 成立 (focus が 50ms 以上同 element / dirty rect が 50ms 以上 0 件)

trunk では (a) を優先採用、(b) は安全網、(c) は §8 R7 の fixture 不安定対策。Proposed v0.3 まで「`ToolCallCompleted` で閉じる」と書いていたが、`desktop_act` の UIA Invoke 呼出 return 後に **非同期で届く** UIA Focus / DXGI DirtyRect event を取り逃がし、focus delta + dirty rect count が空のまま G5 が失敗する設計バグ → user feedback で v0.4 で修正。実装時の最終境界決定は OQ #5 で。

---

## 4. Trunk PR scope (sub-batch 分解、概算)

各 sub-batch は別 PR として直列で進める (trunk 内は **並列禁止** — contract lock 中なので)。

### S1: D2-E0 dataflow scope refactor (PR 1)

**目的**: arranged + view を同 worker.dataflow closure 内で build する base を作る。

**範囲**:
- `crates/engine-perception/src/lib.rs` (`spawn_perception_worker`) を refactor、複数 view を返す shape に統一
- `current_focused_element` view の build を新 scope に移動 (回帰なし)
- 単一 view scope の lifetime test pass

**完了基準**:
- 既存 D1/D2-A/D2-B integration test 全 pass
- 新 scope で `current_focused_element` が回帰なし
- **Gate G1**: D2-E0 の refactor が想定以上に重い場合、D2-C 以降へ進む前に trunk scope を再評価する

**Rust 慎重 (Opus 厚め review)**: ✓

### S2: D2-C (dirty_rects_aggregate view 簡易版) (PR 2)

**目的**: DXGI dirty rect event を入力に、frame ごとの aggregate を出力する 1 view を S1 の同 scope に追加。

**範囲**:
- L3 view: `dirty_rects_aggregate ((monitor_index, frame_index) → count)` 簡易版 (count のみ、union 計算 / RectId list は expansion)
- **`monitor_index` field を payload / view output から落とさない** (PR #102 同型 regression 防止、CLAUDE.md §3.2)。「count のみ簡易版」とは aggregate 内の RectId list / union 計算を落とす意味であり、key 軸の `monitor_index` は trunk 段階から必須保持
- focus_pump と同様の DXGI pump (L1 ring → DXGI event filter → input handle)
- napi 経由 export 関数 1 つ (`view_get_dirty_rects(monitor_index)`、引数は既存 `DuplicationHandle::spawn(output_index)` public API と整合)
- bench 1 本 (latency p99、regression guard 用途)

**完了基準**:
- DXGI emit (#102 で landed) を入力に view が更新される integration test
- D2-E0 同 scope で focus view と dirty rects view が 共存
- napi export が TS 側から呼べる
- `monitor_index` field を含む view output が TS 側から observable
- **Gate G2**: focus view + dirty rect view の共存が確認できた時点で、S3-S5 に進む価値と scope を再確認する。ここで candidate C が重すぎると判明した場合も、A/B に戻すのではなく C の contract spike をさらに細くする。

**Rust 慎重 (Opus 厚め review + Codex review)**: ✓ ✓ (`monitor_index` payload 整合は Codex API contract 軸が強み、CLAUDE.md §3.2 PR #102 教訓)

### S3: ADR-010 P1 envelope minimal wrapper + compat mode (PR 3)

**目的**: 全 tool の応答を envelope shape で wrap する **L5 wrapper の skeleton**。trunk では `desktop_state` のみ実適用。既存 raw shape client を壊さない compat mode を skeleton 段階から実装。

**範囲**:
- `src/tools/_envelope.ts` 新設 (`_version`, `data`, `as_of`, `confidence` の skeleton 関数)
- **compat mode 必須** (architecture §11.2): default で `data` field を top-level に hoist して raw shape を維持、opt-in flag (env or include 引数) で envelope shape を要求した場合のみ wrap shape を返す。既存 LLM client (Claude CLI など raw shape 期待) を破壊しないことが必須条件
- `src/tools/desktop-state.ts` を envelope 経由に置換 (skeleton のみ、`caused_by` は S5 で)
- `as_of.wallclock_ms` は L1 ring の最新 event を読む (既存 `view_get_focused` が wallclock を持つ前提、なければ S1 で view 戻り値に追加)
- `confidence` は **`fresh` / `degraded` 2 値** (architecture §17.6.1 の値域 SSOT に対し trunk で 2 値分岐を踏む。`degraded` 判定は envelope size 超過 / worker_lag 超過 を最低限実装、残り `cached` / `inferred` / `stale` は expansion)
- envelope size SLO bench harness を本 PR で新設 (`benches/l4_envelope_size.{ts,mjs}` 等)、CI で前回 main から 5% 増 warning / 20% 増 fail (ADR-010 §5.6.2)

**完了基準**:
- 既存 LLM session で desktop_state 回帰 0 (raw shape 期待の e2e test 無修正で pass)
- envelope skeleton のサイズ < 1KB (ADR-010 §5.6.1)
- `_version: "1.0"` stamp
- `confidence` が `fresh` / `degraded` の 2 値で観測される integration test
- envelope size SLO の CI bench harness が main で動く

**Rust 慎重**: 不要 (TS のみ、ただし Opus 1 round で compat mode の hoist 経路は確認)

### S4: desktop_discover + desktop_act commit 軸 wrapper + lease validation + ToolCallStarted/Completed 配線 (PR 4)

**目的**: commit 軸 wrapper を 1 tool (`desktop_act`) で確立。lease 4-tuple validation 経路を trunk で lock。`tool_call_id` を session 内で seq 採番、L1 既存 `EventKind::ToolCallStarted (=100)` / `ToolCallCompleted (=101)` の payload を本 PR で fix。

**範囲**:
- L5 wrapper: commit 軸テンプレ (`tool_call_id` 採番 + lease 4-tuple validation + L1 `l1_push_tool_call_started` 呼出 + 副作用実行 + L1 `l1_push_tool_call_completed` 呼出 + envelope 返却)
- L5 wrapper: query 軸テンプレ (`desktop_discover` 用、lease 発行 + envelope 返却)
- L1 既存 `EventKind::ToolCallStarted (=100)` / `ToolCallCompleted (=101)` の **payload schema を本 PR で確定** (`{tool_name, args_summary, lease_token?}` 等、`session_id` / `tool_call_id` は EventEnvelope 既存 field、`src/l1_capture/envelope.rs` line 60-84 の既存定義を活用)。**新規 EventKind は追加しない** (CLAUDE.md §3.2 既存 public API 破壊禁止 + Opus P1-4 反映)
- `src/l1_capture/napi.rs` の既存 `l1_push_tool_call_started` / `l1_push_tool_call_completed` を L5 wrapper から呼ぶ配線
- `desktop_discover` / `desktop_act` 既存実装は維持、wrapper 経由に変更
- 失敗時 envelope: `most_likely_cause: "LeaseExpired"` を 1 種実装 (`LeaseStore.validate()` の `expired` reason → typed enum、ADR-010 §5.4)、`try_next: [{action: "desktop_discover", ...}]` で recovery hint も合わせて 1 path 実装
- `click_element` は本 trunk では **wrapper 経由しない** (expansion で「lease 不在 commit」バリエーションとしてコピー)

**完了基準**:
- `desktop_discover` / `desktop_act` の既存 e2e test pass
- L1 ring に `ToolCallStarted` / `ToolCallCompleted` event が記録される (新規 EventKind 追加なしで観測可能)
- lease validation 失敗時に `if_unexpected.most_likely_cause: "LeaseExpired"` が typed で返り、`try_next` に desktop_discover が含まれる
- envelope failure size < 5KB (ADR-010 §5.6.1、S3 で新設の bench harness で計測)
- `EventKind::ToolCallStarted/Completed` payload schema が `crates/.../envelope.rs` で確定

**Rust 慎重 (Opus 厚め review + Codex review)**: ✓ ✓ (既存 EventKind の payload schema 確定 = 既存 public API 破壊禁止 = Codex API contract 軸の強み、CLAUDE.md §3.2)

### S5: caused_by linkage (cross-layer) — desktop_act → desktop_state (PR 5)

**目的**: trunk の **最重要 contract**。直前の commit (`desktop_act`) の `tool_call_id` を、次の query (`desktop_state`) の envelope.caused_by に展開する経路。

**範囲**:
- L4 (Rust or TS、設計判断点 = OQ #2): session_id ごとに直近 N 件の `ToolCallStarted/Completed` event を保持する小さな buffer (working memory の最小版、in-memory `Vec<ToolCallEvent>` に固定)
- envelope 組立て時、`caused_by.your_last_action` (= 直前 desktop_act の tool_name + args_summary) / `tool_call_id` / `elapsed_ms` (ToolCallStarted ↔ ToolCallCompleted の wallclock 差) / `produced_changes` を埋める
- `produced_changes` は L3 view diff (focus_view と dirty_rects_aggregate の delta) から組立て。trunk では focus delta (A→B 表記) + dirty rect count (`monitor_index` 別) までに限定する
- session_id は MCP request id にマッピング (OQ #1 を S5 着手前に決定 — trunk のスコープ内で確定する)
- causal window 境界 (User feedback 2026-05-01 反映、Proposed v0.4): **`ToolCallStarted` event_id を window の左端、右端は `ToolCallCompleted` で閉じない**。`desktop_act` の UIA Invoke 呼出が return した後に **非同期で届く** UIA Focus event / DXGI DirtyRect event を取り逃がさないため、右端は以下のいずれかが先に成立した時点とする:
  - (a) **次 query (= 次の `desktop_state`) が呼ばれた時点の event frontier** (commit から query までのギャップ全てが causal window に入る、最も自然な境界)
  - (b) **timeout 経過** (デフォルト 200ms、tunable、commit 後 long-tail event を取り逃がさず無限延長を防ぐ)
  - (c) **first stable observation 成立** (focus が 50ms 以上同 element / dirty rect が 50ms 以上 0 件、stability 検出は L4 envelope 組立て側)
  - 設計判断: trunk では (a) を優先採用、(b) は安全網、(c) は §8 R7 の fixture 不安定対策。`ToolCallCompleted` で window を閉じる v0.3 の設計は user feedback で覆し、§3.4 + OQ #5 で再確定した

  ※ Proposed v0.3 では「`ToolCallCompleted` で閉じる」と書いていたが、user feedback で「commit return 後の async event を取り逃がす設計バグ」と指摘 → focus delta + dirty rect count が空のまま G5 が失敗する重大問題。本 v0.4 で window 右端の三択 ((a)/(b)/(c)) に修正

**完了基準**:
- `desktop_act` → `desktop_state` シーケンスで `caused_by` が正しく埋まる integration test
- `produced_changes` に focus 遷移 (A→B) と dirty rect 件数 (`monitor_index` 別 count) が含まれる
- envelope size < 2KB (causal include、S3 bench harness で CI 計測)
- lease 経由経路で `caused_by.your_last_action` が `"desktop_act(lease=..., action=...)"` として記録される
- `elapsed_ms` が ToolCallStarted/Completed wallclock 差として観測される

**Rust 慎重 (Opus 厚め review + Codex review)**: ✓ ✓ (caused_by の cross-layer linkage は最も間違いやすい、CLAUDE.md §3.2 carry-over scope 解釈 + multi-table fact 整合の両軸)

### S6: trunk 完了判定 + CI assert 化 + docs/expansion plan 起草 (PR 6)

**目的**: trunk 完成判定 + CI による仕組み化 (CLAUDE.md §7) + expansion 並列化計画を docs に永続化。

**範囲**:
- 「次の commit tool (例: `click_element` = lease 不在 commit、または `keyboard`) を trunk pattern コピーで追加できる」ことを実証する 30 分タイムアタック
- **CI assert 化** (CLAUDE.md §7 仕組みで対応): `.github/workflows/expansion-pr-guard.yml` 新設、PR title or label に `expansion` がある場合は `git diff --stat origin/main -- crates/engine-perception` の non-doc 行が 0 行でないと CI fail。または `scripts/check-expansion-disjoint.mjs` 等のローカル checker を pre-push hook 経由で適用 (現時点未存在、本 PR で起草)
- `docs/walking-skeleton-expansion-plan.md` を新規起草 (本書の続編、tool ごとの worktree 並走計画。現時点未存在、本 PR で起草)
- ADR-008 D2-G 部分着手 (本 trunk で確定した分の docs 整合)
- `_post.ts` (perception envelope) と `_envelope.ts` の役割境界を OQ #7 で確定し、必要なら統合 PR を expansion plan に明記

**完了基準**:
- expansion 候補 tool 1 件 (例: `click_element` の lease 不在 commit バリエーション) を pattern コピーで動作させた PoC を本 PR に含める (merge 後すぐ revert OK、判定用)
- expansion plan doc が main にある (現時点未存在からの新規起草)
- CI guard が main で動作 (PR test で expansion label 付き PR が engine-perception 改変ありで fail することを確認)

**Rust 慎重**: 不要

### 4.1 PR 数概算と工程目安

| PR | 範囲 | 概算工数 (連続作業) | Opus review round | Codex review |
|---|---|---|---|---|
| S1 | D2-E0 scope refactor | 2-3 日 | 2-3 | (Opus と並走、追加時間 0) |
| S2 | D2-C 簡易 view + DXGI pump (`monitor_index` 含む) | 3-4 日 | 2-3 | ✓ (PR #102 同型 regression 防止軸) |
| S3 | envelope minimal wrapper + compat mode + size SLO bench harness | 1-2 日 | 1-2 | (Opus 1 round で十分) |
| S4 | desktop_discover/act commit 軸 wrapper + lease validation + ToolCallStarted/Completed payload schema | 4-5 日 | 2-3 | ✓ (既存 EventKind payload 確定軸) |
| S5 | caused_by linkage (cross-layer、desktop_act → desktop_state) | 3-5 日 | 3+ (最重要) | ✓ (cross-layer linkage 軸) |
| S6 | 完了判定 + CI assert 化 + expansion plan 起草 | 2 日 | 1 | (Opus 1 round で十分) |
| **合計** | trunk 全体 | **15-21 日** (Opus P1-5 採用で旧 12-17 日 + 2-4 日) | (累積) | (Opus と並走で追加時間 0) |

工数概算は MAX 20x の Sonnet 並列ではなく、**直列前提** (trunk 中は並列禁止)。Opus review 厚めで Sonnet 単線で進めると逆に速い (強制命令 3)。

15-21 日は「full implementation の約束」ではなく、contract spike が膨らんだ場合の最大許容レンジ。G1/G2/G3 で scope を削れる場合は削る (§5.1)。

工数増分根拠 (Opus P1-5 (a) 採用で +2-4 日):

- S3: compat mode + envelope size CI bench harness 追加で +0-1 日
- S4: lease validation + ToolCallStarted/Completed payload schema 確定で +1-2 日
- S6: CI assert 化 (workflow 新設) で +1 日

---

## 5. Trunk 完了の判定基準

trunk が「contract lock 完了」と言える条件:

1. **expansion tool 1 件追加が L5 wrapper の修正のみで完了する** — engine-perception 層 (Rust) に変更が必要なら trunk 未完了 (contract が嘘)。**判定は CI assert で機械的に強制** (S6 で起こす `expansion-pr-guard.yml`、CLAUDE.md §7 仕組みで対応)、人間 git diff 運用には頼らない
2. **`caused_by` が `desktop_act` → `desktop_state` シーケンスで正しく動く integration test pass**
3. **envelope size SLO 達成** (minimal < 1KB / failure < 5KB / causal include < 2KB)、CI bench harness で前回 main から 5% 増 warning / 20% 増 fail を機械的に強制 (S3 で起こす)
4. **既存 LLM session で回帰 0** (desktop_state + desktop_act + desktop_discover の既存 e2e test 全 pass、compat mode で raw shape 期待 client が壊れない)
5. **D2-E0 scope に新 view 1 件追加するのが mechanical コピー** (S6 の PoC で実証)
6. **lease 4-tuple validation 経路が trunk で踏まれている** (S4 で `LeaseExpired` typed reason が 1 path 動作)

判定 1 が **最も重要**。これを skip して expansion に入ると Brooks's Law 罠 (人を増やすと遅くなる、AI agent でも同じ) を踏む。判定 1 を「人間 git diff で見る」運用に依存させると、worktree 並走の大量 PR を全件 chest-bump できないので CI assert で仕組み化する (CLAUDE.md §7)。

### 5.1 中間見直しゲート

trunk は上層完成のための長期ブランチではなく、contract lock のための spike なので、以下のゲートで必ず継続判断する。

| Gate | タイミング | 継続条件 | 見直し時の方針 |
|---|---|---|---|
| G1 | S1 完了時 | D2-E0 scope refactor が既存 focus path を壊さず、複数 view を置ける形になっている | S2 の dirty rect view をさらに count-only に絞る (`monitor_index` field は維持) |
| G2 | S2 完了時 | focus view + dirty_rects view が同 scope で共存し、TS から最小取得できる (`monitor_index` field 含む) | S3-S5 の envelope / caused_by を最小 field に削る (compat mode と confidence 2 値分岐は残す) |
| G3 | S4 完了時 | commit wrapper と既存 `ToolCallStarted/Completed` event payload 確定が `desktop_discover/act` の挙動を壊していない、`LeaseExpired` typed reason が 1 path 動作 | S5 は in-memory buffer + 直近 1 件のみに固定する |

G1/G2/G3 の目的は candidate C を取り下げることではない。A/B へ戻すと最重要 contract を踏めないため、**C のまま細くする**。

### 5.2 ゲート判定の永続化

各 G1/G2/G3 通過時、本書末尾 (Appendix C) に **判定結果 (date, decision, rationale)** を append する。次セッションでも判定が trace 可能。S1/S2/S4 完了基準に「Appendix C 末尾に判定結果を追記」を含める。LLM session 跨ぎで G1/G2/G3 の存在自体が忘れられる risk (CLAUDE.md §9 / Opus review G-2) への軽減策。

---

## 6. Expansion 並列化計画 (trunk 完了後の戦略)

trunk 完了後、以下を **worktree 並走** で進める。各 worktree は完全に disjoint な scope。

### 6.1 並走 swimlane (例)

| swimlane | scope | 並走可否 | 想定 PR 数 |
|---|---|---|---|
| L1 emit sites | P5c-3 Window event / P5c-4 Scroll event / P5d timestamp 多重化 | ✓ 並走可 (L1 内 disjoint) | 3-4 |
| L3 view 拡充 | semantic_event_stream / predicted_post_state | △ D2-E0 scope は共有、view ごとに直列推奨 | 2-3 |
| L5 commit tool wrapper 化 | `click_element` (lease 不在 commit バリエーション) / mouse_click / keyboard / clipboard / scroll / focus_window / browser_click etc. | ✓✓ 完全並走可 (各 tool 独立) | 8-10 |
| L5 query tool wrapper 化 | screenshot / browser_overview / browser_locate etc. | ✓✓ 完全並走可 | 5-7 |
| L4 envelope 拡張 | invariants_held (P3) / query_past (P4 link only) / dry-run (P5、predicted_post_state 依存) / working memory (P6) / `confidence` 残 3 値 (`cached` / `inferred` / `stale`) | △ 順次 (依存関係あり) | 4-5 |
| ADR-010 P2 typed reason 拡充 | 残 36 codes の `_errors.ts` SUGGESTS 連動 (うち lease 経路 4 codes は trunk pattern コピー) | ✓ 並走可 (code ごと独立) | 4-5 |
| L1 secondary monitor 配線 | DXGI dirty rect の secondary monitor subscription / per-monitor aggregate 分離 | ✓ 並走可 (L1 単独) | 1-2 |

### 6.2 swimlane 共有制約 (conflict 防止)

`src/tools/_envelope.ts` (trunk で確定) が複数 swimlane で共通 import される。**この file を expansion で touch する PR は同時 1 件のみ** (rebase 順守)。

`crates/engine-perception/src/lib.rs` (D2-E0 scope) も同様。新 view 追加は L3 swimlane 内で直列。

### 6.3 MAX 20x の使い方 (再掲)

trunk フェーズ:
- Sonnet 1 session (trunk 直系) × Opus 厚め review (3+ round per PR)
- MAX 20x 余裕は **Opus を贅沢に走らせる** (S2/S4/S5 は Codex review も必須、CLAUDE.md §3.2 の API contract regression 防止)
- **trunk 直系で Sonnet を遊ばせず、別 Sonnet session を並走で動かす**: trunk 中の Sonnet 並走は trunk PR を触らず、以下の **trunk 完了直後に消費される事前作業** を進める:
  - `docs/walking-skeleton-expansion-plan.md` の事前起草 (S6 で finalize)
  - `docs/views-catalog.md` の他 view (semantic_event_stream / predicted_post_state) 仕様事前起草
  - typed reason 残 36 codes の `_errors.ts` SUGGESTS 事前マッピング
  - trunk e2e fixture (lease 発行対象 entity / focus A→B + DXGI dirty 確実発火) の整備
  - `_post.ts` と新 `_envelope.ts` の役割境界 OQ #7 の調査資料起草
- これにより MAX 20x 予算が trunk 直系 review で消費されるだけでなく、expansion phase 着手当日から並列度を最大化できる準備が整う (Opus review G-2 採用)

expansion フェーズ:
- Sonnet × 3-5 worktree session 並走
- Opus は「trunk pattern conformance check」専任、各 PR 1 round の lightweight review
- subagent (`Agent` tool) で test 出力 grep / docs 整合チェックを大量並走
- MAX 20x 並列枠を全消費するのはこのフェーズ

---

## 7. Open Questions (trunk 着手前に決める)

| # | OQ | 決定タイミング |
|---|---|---|
| 1 | session_id を MCP request id と紐付けるか独自管理か (ADR-010 OQ #1 と同) | S5 着手前 (caused_by 経路が確定するまでに) |
| 2 | `caused_by` を L4 で組立てる場所 (Rust 側 or TS L5 wrapper 側) | S5 着手前。production gap bench (#98) の MCP transport 数値を見て判断 |
| 3 | trunk の typed reason 1 種類は **`LeaseExpired` を第一候補** (Opus P1-5 (a) 採用に伴い確定方向)、`LeaseStore.validate()` の `expired` reason → typed enum 経路を踏む。最終確定は S4 着手前 | S4 着手前 |
| 4 | D2-C 簡易版 `dirty_rects_aggregate` の最小定義: count のみ。**ただし `monitor_index` field は payload / view output から落とさない** (PR #102 同型 regression 防止、CLAUDE.md §3.2)。RectId list / union 計算は expansion | S2 着手前 |
| 5 | UIA Focus event と DXGI dirty rect を同一 causal window に束ねる境界: window 左端 = `ToolCallStarted` event_id、**右端 = (a) 次 query frontier / (b) timeout 200ms / (c) first stable observation のいずれか先 (Proposed v0.4、user feedback 2026-05-01)**。trunk 採用は (a)、(b)/(c) は安全網。最終確定は S5 着手前。`同 logical_time` を wallclock 同一と誤解しないよう contract 化する | S2 完了後、S5 着手前 |
| 6 | trunk e2e fixture をどう固定するか: lease 発行対象 entity が安定 discover でき、`desktop_act` で focus A→B + primary monitor dirty rect が確実に発火する対象。modal/animation/debounce を含まない | S4 着手前 |
| 7 | `src/tools/_post.ts` (perception envelope + history ring buffer) と新 `src/tools/_envelope.ts` の役割境界 — 統合するか、両者共存で responsibility を分けるか (ADR-010 §5.6.2 が要求する size 比較 bench も含む) | S3 着手前に方向性、最終確定は S6 |

---

## 8. Risks

| # | リスク | 影響 | 軽減策 |
|---|---|---|---|
| R1 | trunk の caused_by 経路が予想以上に重く、S5 が膨張する | High | session_id buffer は最初は in-memory `Vec<ToolCallEvent>` に固定、永続化は expansion に外出し |
| R2 | D2-E0 scope refactor が既存 D2-A/B test を壊す | Medium | S1 で integration suite を最優先、回帰 0 を gate に |
| R3 | DXGI dirty rect の出力が production 環境で空 (#102 の secondary monitor 問題と同型) で trunk 動作確認できない | Medium | S2 で primary monitor のみで動作確認、secondary monitor の subscription 配線は expansion (carry-over)。**ただし `monitor_index` payload field は trunk 段階から必ず保持**、「primary monitor で確認」と「`monitor_index` field を落とす」は別概念 (PR #102 同型 regression 防止、CLAUDE.md §3.2) |
| R4 | trunk 15-21 日が見積より大幅超過 | Medium | 各 PR で予実差を docs に記録、G1/G2/G3 で scope を削る |
| R5 | Opus review round が増えすぎて trunk が止まる (S5 で 5+ round の可能性) | Low | CLAUDE.md §3.2 の Codex review を Opus と並走させて round 数を圧縮。Opus review round と Sonnet implementation trial は別軸として管理 (review が 3+ round 走るのは正常、Sonnet 同一箇所 trial 2 回で §4 強制 Opus 委譲) |
| R6 | expansion 並走時に L5 wrapper file (`_envelope.ts`) で merge conflict が頻発 | Low | trunk で確定した shape を変えない方針を docs/walking-skeleton-expansion-plan.md に明記 |
| R7 | `desktop_act` が focus delta / dirty rect の片方を発火せず、trunk e2e が不安定になる | Medium | 制御 fixture を用意し、lease 発行対象 entity / focus A→B / primary monitor dirty をテスト前提として固定する (OQ #6) |
| R8 | `同 logical_time` が wallclock 同一と誤読され、UIA/DXGI の自然な到着差で contract が揺れる | Medium | causal window の定義 (`ToolCallStarted` ↔ `ToolCallCompleted` 区間) を S5 前に確定し、`based_on.events` / `produced_changes` の包含条件としてテストする |
| R9 | 既存 `src/tools/_post.ts` (perception envelope + history ring buffer) と新 `_envelope.ts` の役割重複 / 機能 fragmentation | Medium | OQ #7 で S3 着手前に方向性決定 (統合 / 共存 + responsibility 分割)。ADR-010 §5.6.2 が要求する size 比較 bench も S3/S5 で実施 |
| R10 | trunk 15-21 日中に LLM session が複数回 compact / context リセットを跨ぎ、G1/G2/G3 ゲートの存在自体が忘れられる | Medium | 各 G1/G2/G3 通過時、Appendix C 末尾に判定結果 (date / decision / rationale) を append。各 PR DESCRIPTION に「G_n を本 PR で開く」を必須記述、PR template に追加 (CLAUDE.md §9 残件は docs に永続化) |
| R11 | Opus review round と Sonnet implementation trial の境界が曖昧で、CLAUDE.md §4 trial & error 2 回上限と矛盾しているように読める | Low | **Opus review round と Sonnet implementation trial は別軸**。Opus review が 3+ round 走るのは正常 (concept 整合 / API contract / 漏れ確認)。Sonnet が同一 test failure を 2 回連続で revisit したら §4 trial & error 2 回上限に該当、即 Opus 委譲。各 sub-batch 完了基準にこの境界を明示 |

---

## 9. 次アクション

1. ✅ **本書 round 1 を Opus にレビュー依頼済** (2026-05-01、Conditionally Approved、P1 5 件 / P2 7 件 / P3 4 件)
2. ✅ **Opus P1-5 (a) 採用**: trunk tool を `click_element → desktop_state` から `desktop_discover → desktop_act → desktop_state` に切替済 (本 round 2 で反映、2026-05-01)
3. **本書 round 2 を Opus + Codex に再レビュー依頼** (Codex は API contract 軸、特に S2 `monitor_index` / S4 `EventKind` payload / S4 lease 4-tuple)
4. Opus + Codex 指摘ゼロ化後、本書 Status を **Approved** に上げ、§7 の Open Questions **7 件** を解決
5. S1 (D2-E0 scope refactor) 着手、`feature/walking-skeleton-s1-d2e0` ブランチで開始
6. S6 完了時点で expansion plan doc (`docs/walking-skeleton-expansion-plan.md`、現時点未存在) 起草、worktree 並走発射

---

## Appendix A: trunk 候補比較表 (再掲、Opus P1-5 (a) 反映後)

| 観点 | A: 擬似 trunk + envelope | B: screenshot + dirty_rects | **C: discover → act → state caused_by + lease 4-tuple** |
|---|---|---|---|
| L1 UIA + DXGI 同 causal window (= 同 logical_time、§3.4) | ❌ | ❌ | ✅ |
| L1 既存 `ToolCallStarted/Completed` payload 確定 | ❌ | ❌ | ✅ |
| L2/L3 複数 view scope | ❌ | ❌ | ✅ |
| L3 `monitor_index` field 維持 | ❌ | △ (1 view のみ) | ✅ |
| L4 caused_by linkage | ❌ | ❌ | ✅ |
| L4 confidence 2 値分岐 (`fresh`/`degraded`) | ❌ | ❌ | ✅ |
| L4 failure envelope | ❌ | ❌ | ✅ (1 種類 = `LeaseExpired`) |
| L5 query + commit 両軸 | ❌ | ❌ | ✅ |
| L5 lease 4-tuple validation | ❌ | ❌ | ✅ (Opus P1-5 (a) で追加) |
| L5 envelope compat mode (raw shape 互換) | ❌ | ❌ | ✅ |
| Rust 慎重コスト | 極小 | 中 | 中〜大 |
| trunk 完了後の expansion 並列度 | 低 (再設計多発) | 中 | 高 (mechanical コピー、`click_element` も lease 不在 commit バリエーションで対応) |
| 採用 | ❌ | ❌ | ✅ |

---

## Appendix B: 関連文書

- 統合 SSOT: `docs/architecture-3layer-integrated.md` (§6 の "1 event の旅" は本 trunk のそのままの実装ターゲット)
- ADR-007: `docs/adr-007-koffi-to-rust-migration.md` (§6 P5c-2 完了、P5c-3/4 + P5d は expansion)
- ADR-008 D2: `docs/adr-008-d2-plan.md` (D2-E0 + D2-C 簡易版が trunk 範囲)
- ADR-008 D1 follow-ups: `docs/adr-008-d1-followups.md` (§3 残 follow-up は trunk 後の expansion 範囲)
- ADR-010: `docs/adr-010-presentation-layer-self-documenting-envelope.md` (P1 + P2 部分 + P3 caused_by のみが trunk 範囲)

---

## Appendix C: ゲート判定ログ (G1/G2/G3 の永続記録、§5.2)

各 G1/G2/G3 通過時に append。LLM session 跨ぎでも判定が trace 可能 (CLAUDE.md §9 / R10 軽減策)。

| Gate | date | decision | rationale | scope shrink 内容 |
|---|---|---|---|---|
| G1 | 2026-05-01 (PR #105 `4f912c3` merged) | **継続** | `build_*(focus_stream) -> (Arranged, View)` signature 統一が DD 0.23 actual API で成立 (impl PR #105 で実証、cargo check + 37 unit + 19 integration test 全 pass、bench regression 0)。`Arranged<'scope, ...>` の closure 外持ち出し試行は型 system で static error (Codex v2 P2-9 確認)。`spawn_perception_worker` 戻り値 4-tuple 不変 + 既存 production-pipeline lifecycle 経路 8 test 無修正で pass = 既存 caller 破壊 0。S2 `build_dirty_rects_aggregate` が同 template を mechanical コピー可能 (sub-plan §3.3 と shape integral)。Opus round 1 P1×2 + P2×4 + P3×3 → Round 2 全反映、Codex round 1 clean。Round 2 Opus re-review pending (本 G1 判定 commit 時点)、code shape 不変なので新規 P1 確率低 | (なし、S2 (D2-C) 着手は trunk 計画通り 200-300 line / 3-4 日見積、shrink 不要) |
| G2 | (S2 PR merge 時に追記) | (継続 / shrink) | (...) | (S3-S5 の envelope / caused_by を最小 field に削る等) |
| G3 | (S4 PR merge 時に追記) | (継続 / shrink) | (...) | (S5 を in-memory buffer + 直近 1 件のみに固定する等) |

---

## Appendix D: 改訂履歴

| version | date | author | summary |
|---|---|---|---|
| Proposed v0.1 | 2026-05-01 | Claude (Sonnet) | 初稿起草、候補 C (click_element → desktop_state) を採用 |
| Proposed v0.2 | 2026-05-01 | Claude (Sonnet) | user 補正反映: §3.2 contract spike 方針補正、§3.4 fixture / causality 前提、Gate G1/G2/G3、§5.1 中間見直しゲート、OQ #5 / #6、R7 / R8 追加 |
| Proposed v0.3 | 2026-05-01 | Claude (Sonnet) | **Opus review round 1 反映**: P1-5 (a) 採用 = trunk tool を `desktop_discover → desktop_act → desktop_state` に切替、`click_element` を expansion 降格、S4 typed reason `LeaseExpired` 第一候補化、L1 既存 `ToolCallStarted/Completed` 活用、§9 OQ 件数 7 件同期、`monitor_index` payload 維持明記 (S2/R3)、envelope compat mode 追加 (S3)、confidence 2 値分岐 (S3)、`_post.ts` 境界 OQ #7 追加、CI assert 化 (S6)、envelope size SLO bench harness (S3)、§6.3 trunk 中 Sonnet 振り向け先追記、§5.2 ゲート判定永続化、§8 R9/R10/R11 追加、Appendix A 表を C 採用後の contract list に更新、Appendix C ゲート判定ログ枠新設 |
| Proposed v0.4 | 2026-05-01 | Claude (Sonnet) | **User feedback 反映 (PR #103 review)**: causal window 右端を `ToolCallCompleted` から「(a) 次 query frontier / (b) timeout 200ms / (c) first stable observation のいずれか先」に修正 (§3.4 + §5 S5 + §7 OQ #5)。`desktop_act` UIA Invoke return 後に async で届く UIA Focus / DXGI DirtyRect event を取り逃がす設計バグを fix、focus delta + dirty rect count の commit-after-async-event capture を保証 |

---

END OF Walking Skeleton — trunk 選定 (Proposed v0.4)。
