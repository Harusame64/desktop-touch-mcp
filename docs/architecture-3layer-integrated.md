# Architecture: 3-Layer Integrated Design

- Status: **Draft (起草中、各 ADR の SSOT)**
- Date: 2026-04-29
- Authors: Claude (Opus, max effort) — project `desktop-touch-mcp`
- Scope: ADR-007 / ADR-008 / ADR-010 を 1 つに編む俯瞰設計書
- 役割: 個別 ADR は詳細設計、本書は **Source of Truth** として cross-layer の規約を持つ
- 北極星: 最高パフォーマンス + 最高技術の公開 + LLM ergonomics

---

## 1. Executive Summary

`desktop-touch-mcp` を 3 層に整理し、**全層を 1 つの timely dataflow graph として扱う** 統一設計を提案する。

| 層 | 役割 | 主担当 ADR |
|---|---|---|
| **センサー層** (L1 Capture) | DXGI dirty rect + UIA + tool call + 副作用を統一 event log に押し出す。HW assist は Tier 0-3 で fallback | ADR-007 |
| **データ層** (L2 Storage + L3 Compute) | timely + differential-dataflow による partial-order MVCC + IVM。`arrangement` が **L2/L3 を 1 構造体に畳む** | ADR-008 |
| **プレゼンテーション層** (L4 Projection + L5 Tool Surface) | LLM 不安源 7 つに 1:1 対応する Self-Documenting Envelope。Tool 数を増やさず 1 tool の表現力を上げる | ADR-010 |

### 1.1 主要な発見 (3 件)

1. **Arrangement = MVCC が無料** (ADR-008 §2.3): timely + DD の `arrangement` は `(key, val, time, diff)` の 4-tuple を multi-version で持つ → L2 と L3 が同一構造体で実現
2. **HW 物理基盤は既に揃っている** (ADR-007): DXGI dirty rect / Intel DSA / NVENC / Reflex API / Intel PT を組合せれば、観測コスト・time-travel・hw replay の物理基盤がほぼ全部既製
3. **partial-order time が UI 観測ドメインに必須** (ADR-008 §2.2): UIA out-of-order、tool call と環境変化の並行、Reflex 多軸 hw clock — これらすべてが linear time に潰せない

### 1.2 公開価値 (北極星の片翼)

論文 3 本ぶんが独立に書ける。

- **SIGMOD/VLDB**: GPU-accelerated IVM for LLM agent perception (DXGI dirty rect + CUDA Graph + DD)
- **USENIX ATC/ASPLOS**: HW-assisted deterministic replay for LLM agent debugging (Intel PT + arrangement snapshot)
- **CHI/UIST**: Sub-millisecond UI observation via Reflex Latency API (race-free agent observation)

ナラティブ: Microsoft が WinAppSDK Rust を archive した一方、**Intel/AMD/NVIDIA の hw assist を Rust で結合した Windows MCP server** という空白領域。

---

## 2. 設計原則の体系 (6 原則)

| # | 原則 | 何を保証するか | 出典 |
|---|---|---|---|
| **P1** | Partial-Order Time | UIA out-of-order と多軸 hw clock を正しく扱う | ADR-008 §2.2 |
| **P2** | Arrangement = MVCC | L2/L3 を 1 構造体に畳む。time-travel が無料で来る | ADR-008 §2.3 |
| **P3** | Whole-System Dataflow | L1 Capture も timely input source として graph に組込む。replay / dry-run / subscribe が graph 操作で統一 | 本書 §10 (D1 採用) |
| **P4** | Self-Documenting Envelope | 全 tool 結果が共通 envelope。LLM の不安源 7 つに 1:1 対応 | ADR-010 §1-5 |
| **P5** | Tier Fallback | HW 成熟度の段差を Tier 0-3 で吸収、env で pin 可 | ADR-008 §5 |
| **P6** | 4 LLM-Facing Sub-Principles | Provenance / Causality / Recovery / Time as Affordance | ADR-010 §4 |
| **P7** | Tool Surface 不変原則 | 既存 tool 名 / 関数シグネチャ / 既存 positional args は変更しない、新規 tool 追加なし。envelope wrap は L5 wrapper が一元実装、include 等は横断的 optional 引数 | 本書 §7.4 |

P3 (Whole-System Dataflow) と P7 (Tool Surface 不変原則) は本書で初出の決定。各 ADR には事後追記する。

---

## 3. 5 層アーキ全景図

```
┌──────────────────────────────────────────────────────────────────┐
│ L5: MCP Tool Surface                                              │
│     既存 28 tool が envelope wrap。query / subscribe / commit の  │
│     3 軸にマッピング (§7)                                         │
├──────────────────────────────────────────────────────────────────┤
│ L4: Cognitive Projection + Envelope Assembly                      │
│     Working / Episodic memory を view 化。envelope 段階組立 (§8) │
├──────────────────────────────────────────────────────────────────┤
│ L3: Compute (IVM)                                                 │
│     differential-dataflow operator graph                          │
│     主要 view: current_focused_element / dirty_rects_aggregate /   │
│       semantic_event_stream / predicted_post_state                │
│     cyclic: RPG lens 依存を timely iterative で fixed-point       │
├──────────────────────────────────────────────────────────────────┤
│ L2: Storage (MVCC)                                                │
│     arrangement = (key, val, time, diff) 4-tuple                  │
│     time-travel: arrangement の time slice 走査                   │
├──────────────────────────────────────────────────────────────────┤
│ L1: Capture (whole-system input source)                           │
│     DXGI Desktop Duplication (dirty/move rects)                   │
│     UIA event + tool call + 副作用 → 統一 event ring buffer       │
│     Tier 0-3 hw assist (DSA / NVENC / Intel PT / Reflex API)      │
└──────────────────────────────────────────────────────────────────┘

Data flow:
  hw events → L1 input → timely worker → L2 arrangement → L3 view
                                                              │
                                                              ▼
                                                     L4 envelope projection
                                                              │
                                                              ▼
                                                          L5 tool API
                                                              │
                                                              ▼
                                                    LLM (MCP client)

Side-channel flows:
  WAL ←─── L1 events (record 時、replay 用)
  Replay worker ←── WAL (replay 時、本番 worker と分離、§10)
  Dry-run subgraph ←── 投機 input (本番に書き戻さない、§10)
```

---

## 4. 識別子ヒエラルキー (B2 解消)

すべての層を貫通する 6 つの識別子と、その範囲・生成元・包含関係を確定する。

### 4.1 識別子表

| 識別子 | 範囲 | 生成元 | 形式 | LLM 露出 |
|---|---|---|---|---|
| `session_id` | 1 LLM session 全体 | MCP client (request 開始時) | string (UUID 等) | ✓ |
| `tool_call_id` | 1 tool 呼び出し | L5 wrapper (tool 受信時) | `{session_id}:{seq}` | ✓ |
| `event_id` | 1 observation/action event | L1 Capture (event 発生時) | u64 monotonic | ✓ (envelope.based_on.events) |
| `lease_token` | RPG lease (entity 列挙の有効期間) | desktop_discover (既存) | 4-tuple = `(entityId, viewId, targetGeneration, evidenceDigest)` | ✓ (envelope 内で expanded) |
| `logical_time` | timely epoch + sub_ordinal | L2 (arrangement materialize 時) | `(u64, u32)` partial-order | ✗ (engine 内部のみ) |
| `arrangement_key` | view 内 row | L3 (view ごと固有) | view-defined | ✗ (engine 内部のみ) |

### 4.2 包含関係

```
session_id
    └── tool_call_id (1:N)
            └── event_id (1:N)
                    └── lease_token (1:1 per discover、validate 時に 4-tuple で検証)

logical_time, arrangement_key は engine 内部表現で、外には event_id にマッピングして見せる。
lease_token は単一 ID ではなく、envelope 内で `entity` / `viewId` / `generation` /
`evidenceDigest` の 4 フィールドに展開される (LeaseStore 既存実装と整合)。
```

### 4.3 設計上の効果

- **どの層のログでも event_id が pivot**: L1 ring buffer entry / L2 arrangement record / L3 view delta / L4 envelope.based_on.events のすべてが event_id で trace 可能
- **LLM への露出は 4 識別子のみ**: session/tool_call/event/lease。logical_time は隠蔽、LLM は wallclock_ms のみ見る (§5)
- **replay key は event_id**: WAL の primary key、再生時の anchor

---

## 5. 時刻モデルの統一規約 (B1 解消)

### 5.1 Canonical wallclock_ms

**LLM が見るのは `wallclock_ms` のみ**。他の時刻表現はすべて engine 内部。

| 用途 | 時刻表現 | 露出範囲 |
|---|---|---|
| LLM 向け envelope | `wallclock_ms: u64` | L4-L5 |
| timely 内部 | `(wallclock_ms, sub_ordinal): (u64, u32)` | L2-L3 |
| arrangement 内部 | logical_time = 上記 | L2 |

### 5.2 Wallclock の優先順 (時刻ソース)

| 優先 | ソース | 利用可能性 | 精度 |
|---|---|---|---|
| 1 | NVIDIA Reflex Latency API | NVIDIA GPU + アプリ対応時のみ | < 1ms (hw 真値) |
| 2 | DXGI `IDXGISwapChain::GetFrameStatistics` | Direct3D アプリの場合 | ~1ms |
| 3 | `DwmGetCompositionTimingInfo` | Windows 全環境 | ~1-5ms (compositor 周期) |
| 4 | `QueryPerformanceCounter` (`std::time::Instant`) | always | ~ns 解像度だが hw frame と無関係 |

L1 Capture は起動時に capability detect、各 event tag 時に **取得可能な最上位ソース** を使い、ソース名を `EventEnvelope.timestamp_source` に記録。

### 5.3 Replay 時の wallclock 扱い (B4 解消)

**Record 時の wallclock を canonical**。Replay 時の "now" は計算されない。

| シナリオ | freshness_ms 計算 | 出典 wallclock |
|---|---|---|
| Live (本番) | `wallclock_now - as_of.wallclock_ms` | 観測時刻 |
| Replay | `event.wallclock_at_record - as_of.wallclock_ms` (両方 log から) | 全部 record 時刻 |
| Dry-run | live と同じ (本番 worker の wallclock_now) | 投機実行直前 |

→ **envelope は決定的**。replay で同じ envelope が再生される。

### 5.4 Sub-ordinal の用途

同一 wallclock_ms に複数 event があるとき、L1 Capture が `sub_ordinal` を 0 から順次割当。partial-order 内の deterministic ordering を保証。

---

## 6. データフロー貫通 — 1 event の旅 (Worked Example)

ユーザーが LLM に「次へボタンを押して」と依頼した場面の trace。

### 6.1 タイムライン

```
T+0ms     LLM: click_element(name="次へ") を MCP 送信
            session_id="abc-123"
            
T+0.5ms   L5 wrapper: tool_call_id="abc-123:7" 割当
            commit op を L1 へ submit
            
T+1ms     L1 Capture: 副作用実行 (UIA InvokePattern.Invoke)
            event_id=#87、wallclock_ms=T+1, sub_ordinal=0
            timestamp_source="DwmGetCompositionTimingInfo"
            EventEnvelope を ring buffer + WAL に push
            
T+15ms    UIA event 発火: focus_changed (A → B)
            event_id=#88、wallclock=T+15, sub_ord=0
            
T+16ms    DXGI dirty rect 発火: [120,240,80,30]
            event_id=#89、wallclock=T+16, sub_ord=0
            
T+18ms    L2 arrangement: #87/#88/#89 materialize
            logical_time = (T+18, 0)
            
T+19ms    L3 view 更新:
            current_focused_element: "input_age"
            dirty_rects_aggregate: 1 rect
            semantic_event_stream: ["focus_changed", "no_modal"]
            
T+20ms    L4 envelope assembly:
            caused_by = { your_last_action: "click_element(name='次へ')",
                          tool_call_id: "abc-123:7", elapsed_ms: 19,
                          produced_changes: ["focus: A→B"] }
            invariants_held = ["window_title_stable", "lease_digest_matched"]
            confidence = "fresh"
            
T+21ms    L5 wrap: _version="1.0", data={ ok: true, element: "次へ" }
            return to LLM
```

### 6.2 各層が触る identifier

| 層 | 触る identifier | 触る timestamp |
|---|---|---|
| L5 (受信) | session_id, tool_call_id 生成 | wallclock 開始 |
| L1 | event_id 採番、tool_call_id を tag | wallclock + sub_ord |
| L2 | logical_time 採番 | wallclock 継承 |
| L3 | arrangement_key (view 内部) | logical_time |
| L4 | envelope.based_on.events ← {#87, #88, #89} | as_of.wallclock_ms = T+18 |
| L5 (送信) | _version stamp | freshness_ms = now - T+18 |

### 6.3 Replay 時の同例

WAL に記録された #87/#88/#89 を replay worker に再注入。**logical_time も同じ、wallclock も同じ、envelope も同じ** — bit-for-bit 再生。

---

## 7. API 3 軸 — 全 28 tool のマッピング

### 7.1 軸定義

| 軸 | 副作用 | envelope 特徴 | 例 |
|---|---|---|---|
| **query** | なし | 確定 envelope、`caused_by` は前回 commit との差分のみ | desktop_state, screenshot, browser_overview |
| **subscribe** | なし (push 配信) | delta envelope の連続、各 delta が `as_of` 持つ | (新規、ADR-010 P4 で実装) |
| **commit** | あり | `caused_by` 即時更新 (自分が原因)、`if_unexpected` 失敗時必須 | desktop_act, click_element, keyboard, browser_click |

### 7.2 既存 tool のマッピング (現行 main 基準、29 件列挙)

| tool | 軸 | 備考 |
|---|---|---|
| `desktop_state` | query | 主要 view 4 つを default で集約 |
| `desktop_discover` | query | 副作用なし、lease 発行 |
| `desktop_act` | commit | lease 検証 + 副作用 |
| `screenshot` | query | DXGI Tier 1 経由 |
| `click_element` | commit | UIA InvokePattern |
| `mouse_click` | commit | hw 入力 |
| `mouse_drag` | commit | hw 入力 |
| `keyboard` | commit | hw 入力 |
| `clipboard` | commit | OS 副作用 |
| `scroll` | commit | UIA ScrollPattern + (action='read' は query) |
| `focus_window` | commit | window 副作用 |
| `window_dock` | commit | window 副作用 |
| `wait_until` | query | 観測のみ (時間経過待ち) |
| `notification_show` | commit | OS 副作用 |
| `terminal` | commit | プロセス副作用 |
| `run_macro` | commit | 複合副作用 |
| `workspace_launch` | commit | プロセス起動 |
| `workspace_snapshot` | query | 観測のみ |
| `server_status` | query | engine 情報 |
| `browser_navigate` | commit | navigation 副作用 |
| `browser_click` | commit | DOM 副作用 |
| `browser_fill` | commit | DOM 副作用 |
| `browser_form` | commit | DOM 副作用 |
| `browser_eval` | commit (dual) | 副作用あり得る |
| `browser_locate` | query | DOM 観測 |
| `browser_overview` | query | DOM 観測 |
| `browser_search` | query | DOM 観測 |
| `browser_open` | commit | tab 副作用 |
| `browser_launch` | commit | プロセス起動 |

正確な tool 一覧は `src/stub-tool-catalog.ts` の `name` フィールドから自動生成して維持する (TODO: `scripts/` に generator 追加、ADR-007 P5 着手前)。

### 7.3 設計上の効果

- 各軸ごとに envelope 組立てパターンが固定 → 実装テンプレが 3 つで済む
- subscribe API 追加時、commit/query との整合は軸単位で考えるだけ
- dry-run は **commit 軸の opt-in** (`dry_run=true`)、query/subscribe には不要

### 7.4 Tool Surface 不変原則 (誤読防止、§2 P7 と同期)

3 軸 (query / subscribe / commit) のマッピングは **既存 tool 名と関数シグネチャを維持** する形で行う。本設計は **新規 tool を追加しない**:

| 観点 | 規約 |
|---|---|
| 既存 ~28 tool の応答 shape | envelope に進化 (L5 wrapper で一元 wrap) |
| 新規 tool 追加 | **しない** (本設計のスコープ外、別 ADR で個別判断) |
| tool 関数シグネチャ (positional args) | **変更しない** |
| 既存 tool 名 | **リネームしない** |
| `include` / `dry_run` / `as_of` 等の新引数 | **全 tool に共通する横断的 optional 引数** (各 tool 個別実装の修正は最小、L5 wrapper が一元解釈) |

#### 7.4.1 横断的 optional 引数の解釈

`include` / `dry_run` / `as_of` 等は L5 wrapper が tool 個別実装を呼ぶ前後で解釈する:

- **tool 個別実装** は引数を意識しない (既存実装のまま動く)
- **L5 wrapper** は tool 応答を受けて envelope を組立てる際に include を解釈し、必要なフィールドを enrichment
- **subscribe 軸**の push 配信も同じ wrapper が一元実装

#### 7.4.2 「新規 tool に見える」記述の解釈

本設計書 / ADR で `state_at(t)` / `replay(...)` / `diff(t1, t2)` 等の **疑似コード** が出てくるが、これらは **新規 tool ではない**:

- L4 envelope の `query_past` フィールドが示す **URI / 内部 API**
- LLM が呼ぶ実 tool は既存の `desktop_state` 等で、将来必要なら `as_of` 引数を **既存 tool に追加** する形
- bench / 内部関数として登場する関数名 (LLM 露出 tool ではない)

**LLM 露出する tool surface は本設計で増えない。** `include` / `dry_run` / `as_of` は全 tool 共通の横断的引数として L5 wrapper に注入され、tool 個別の登録・命名・schema は変わらない。

#### 7.4.3 「Tool 数を増やさず 1 tool の表現力を上げる」の意味

統合書冒頭の北極星 (§1.1 / §1.2) と整合:

- ❌ 新規 tool を増やす (例: `desktop_state_v2`、`desktop_state_with_envelope` 等の派生)
- ❌ tool 数を肥大化させて LLM の選択肢を増やす
- ✓ 既存 tool が `include` で必要な情報を **取捨選択** できるようにする (LLM が自分の認知負荷を管理)
- ✓ 既存 tool の応答が **時間文脈・因果・予測** を持つよう envelope で進化させる

---

## 8. Envelope 組立て契約 — 各層の責務 (D3)

### 8.1 段階 enrichment

```
L1 → L2 → L3 → L4 → L5 と段階的に envelope を埋めていく:

L1: as_of.wallclock_ms 始端確定、based_on.events に event_id 追加
L2: arrangement materialize 完了、based_on.events 終端確定、confidence 暫定
L3: data フィールド (view 値)、invariants_held、predicted_post_state (dry_run時)
L4: caused_by, query_past リンク, if_unexpected.try_next (失敗時)
L5: _version stamp、include filter 適用、data 最終形に整形
```

### 8.2 各層責務マトリクス

| Envelope フィールド | L1 | L2 | L3 | L4 | L5 |
|---|---|---|---|---|---|
| `_version` | | | | | ✓ |
| `data` | | | ✓ (raw) | | ✓ (整形) |
| `as_of.wallclock_ms` | ✓ | | | | |
| `freshness_ms` | | | | ✓ (計算) | |
| `based_on.events` | ✓ (start) | ✓ (end) | | | |
| `based_on.sources` | ✓ | | | | |
| `confidence` | | ✓ (暫定) | ✓ (確定) | | |
| `caused_by` | | | | ✓ | |
| `invariants_held` | | | ✓ | | |
| `if_unexpected` | | | | ✓ | |
| `query_past` | | | | ✓ | |
| `if_you_did` (dry_run) | | | ✓ | | |

### 8.3 失敗時 partial envelope

L1〜L5 のどこで失敗しても返せる **失敗テンプレ**:

```jsonc
{
  "_version": "1.0",
  "data": null,
  "as_of": { "wallclock_ms": <最後に確定した値> },
  "confidence": "stale",
  "if_unexpected": {
    "most_likely_cause": <typed enum>,
    "failed_at_layer": "L1" | "L2" | "L3" | "L4" | "L5",
    "try_next": [...]
  },
  "query_past": { ... }  // 過去への戻り口は失敗時こそ重要
}
```

各層は **自層が失敗した時点までの enrichment を残し、`if_unexpected.failed_at_layer` を埋めて return** する。

---

## 9. Tier 0-3 dispatch 統一規約 (B6 解消)

### 9.1 op kind × tier マトリクス

| op kind | Tier 0 (Pure Rust) | Tier 1 (OS API) | Tier 2 (HW Assist) | Tier 3 (Vendor Compute) |
|---|---|---|---|---|
| screen capture | std GDI BitBlt | DXGI Desktop Duplication | DXGI + D3D11 compute shader | (n/a) |
| dirty rect detect | 自前 diff | DXGI GetFrameDirtyRects | (n/a) | CUDA Graph reduce |
| memcpy bulk | std::ptr::copy | rayon parallel chunk | Intel DSA | (n/a) |
| frame ring buffer | Vec<Vec<u8>> | DXGI shared texture | NVENC / Quick Sync / AMF | (n/a) |
| timestamp source | std::time | DwmGetCompositionTimingInfo | DXGI Present statistics | NVIDIA Reflex Latency API |
| change_fraction | scalar | rayon SIMD | (none) | CUDA Graph reduce kernel |
| dHash | scalar | rayon SIMD | (none) | CUDA / HIP / L0 kernel |
| UIA tree walk | windows-rs sync | (n/a) | (n/a) | (n/a — UIA は CPU only) |
| event log persist | std::fs | (n/a) | Intel PT trace | (n/a) |

(空欄は将来検討、(n/a) は本質的に該当 tier が存在しないもの)

### 9.2 Cascade ルール

```
for op in { capture, memcpy, frame_ring, ... }:
    for tier in [T3, T2, T1, T0]:
        if let Some(impl) = registry.find(op, tier):
            match impl.launch(op, inputs):
                Ok(result) => return result
                Err(transient) => continue (try lower tier)
                Err(fatal) => log + continue
    unreachable!  // T0 は必ず存在
```

### 9.3 Failure 集約 (B6)

各 tier failure は `server_status` ツールに集約。

```jsonc
// server_status ツール応答 (envelope wrap 済)
{
  "data": {
    "tier_dispatch_stats": {
      "screen_capture": { "T3": 0, "T2": 1023, "T1": 4521, "T0": 12 },
      "memcpy_bulk": { "T3": 0, "T2": 8923, "T1": 1234, "T0": 0 }
    },
    "recent_failures": [
      { "op": "frame_ring", "tier": "T2", "vendor": "NVIDIA",
        "reason": "NVENC unavailable: driver < 535", "ts": ... }
    ],
    "tier_pin": { "max_tier": 3, "disable_vendor": [] }
  }
}
```

LLM がこれを見て「現在の環境で CUDA 効いてるか」を判断できる。

### 9.4 Vendor 別成熟度 (2026-04 時点)

| Vendor | T1 | T2 | T3 |
|---|---|---|---|
| NVIDIA | ✓ | ✓ NVENC, Reflex | ✓ CUDA Graph (production) |
| AMD | ✓ | ✓ AMF | △ HIP Graph on Windows (ROCm Windows 若い) |
| Intel | ✓ | ✓ Quick Sync, DSA (Sapphire Rapids+) | △ Level Zero (Arc/Battlemage 成熟中) |

→ T1 全環境保証、T2/T3 は capability detect で activate、failure 時自動 fallback。

### 9.6 Tier Fallback Overhead SLO (Gemini review 指摘対応)

Tier dispatch の **fallback コストを op 単位 SLO とは独立に計測** し、SLO に含めない。これにより「Tier 3 で 1ms かかった」のが Tier 3 動作時間そのものなのか fallback overhead を含むのかが分離して評価できる。

| 観点 | 規約 |
|---|---|
| Tier N 失敗検出 + Tier N-1 cascade 開始 overhead | **p99 < 500μs** |
| 個別 op の SLO (例: `view 更新 p99 < 1ms`) | fallback overhead を **含めない**。Tier 3 動作時間のみを測る |
| 5 連続 Tier 3 失敗時 | 強制 Tier 2 pin、5 分後に Tier 3 復帰試行 |
| `tier_fallback_overhead_p99` 超過時 | `server_status` で warning event emit (§17.6) |

bench: `benches/tier_dispatch.rs::bench_tier_fallback_overhead`。

---

## 10. Replay / Dry-run の隔離設計 (B4 + B5 解消)

### 10.1 3 系統の worker

```
┌──────────────────────────────────────────────────────────────┐
│  本番 timely worker (Live)                                    │
│    L1 hw events → arrangement → view 計算                    │
│    WAL に append (record モード時)                           │
│    LLM への応答はここから                                    │
└──────────────────────────────────────────────────────────────┘
                  ▲                           │
                  │                           ▼
                  │                   ┌───────────────────────┐
                  │ (read-only fork)  │  Dry-run subgraph      │
                  │                   │   投機 input を受けて  │
                  └───────────────────┤   predicted_post_state │
                                      │   を計算、書き戻さない │
                                      └───────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  Replay timely worker (オフライン)                            │
│    WAL → event を 順次再注入                                 │
│    本番 worker と完全分離                                    │
│    bug 報告時のみ起動                                        │
└──────────────────────────────────────────────────────────────┘
```

### 10.2 Replay 仕様

- WAL primary key = `event_id`
- 再生は **wallclock も logical_time も log から取る** → 完全決定的
- Replay worker のメモリ空間は本番と隔離、副作用 (UIA Invoke 等) は no-op (再生時は観測再現のみ)
- `replay(session_id, from=event_X, to=event_Y)` ツールで起動 (envelope.query_past.replay_session)
- (任意) Intel PT trace と組合せて hw レベル replay → bug 報告 = WAL + PT log

### 10.3 Dry-run 仕様

- 本番 arrangement の `read-only fork` を timely capability で作る
- 投機 input を fork 上に注入、`predicted_post_state` view を計算
- 本番に書き戻さない (commit せず破棄)
- 結果を `envelope.if_you_did` に格納
- 投機計算と本番計算の干渉はゼロ (worker thread 別、または同 worker の sub-region)

### 10.4 Implementation note

timely-dataflow には [`probe`](https://docs.rs/timely/latest/timely/dataflow/operators/probe/) と worker fork の機能がある。dry-run は probe + drop パターン、replay は別 worker で実現可能。詳細実装は ADR-008 D5/D6 で。

---

## 11. Schema versioning matrix (C6 解消)

### 11.1 各層の version 軸

| 層 | schema 名 | 現行 | 本設計 v1 | v2 候補時期 |
|---|---|---|---|---|
| L1 | EventEnvelope | n/a | v1.0 (本設計) | NPU semantic event 統合時 |
| L2 | Arrangement on-disk | n/a | v1.0 | timely 0.14 移行時 |
| L4-5 | Tool Envelope `_version` | n/a (raw) | "1.0" | dry-run の if_you_did schema 拡張時 |

### 11.2 互換 matrix

| client | server | 対応 |
|---|---|---|
| pre-v1 (raw) | pre-v1 | 現行 (互換維持) |
| pre-v1 (raw) | v1 envelope | server が `data` フィールドを top-level に hoist する compat mode |
| v1 envelope | pre-v1 | client が defensive default を入れる |
| v1 envelope | v1 envelope | full feature |
| v1 envelope | v2 envelope | server が `_version` を見て v1 互換出力 |
| v2 envelope | v1 envelope | client が unknown field 無視 |

### 11.3 MAJOR 上げの条件

- `data` フィールドの shape が破壊的に変わる時のみ MAJOR
- セクション追加 (`if_you_did` 拡張等) は MINOR
- typed enum の追加 (`most_likely_cause` 新値) は PATCH

---

## 12. リリース順序 (C3 解消)

### 12.1 段階導入

| version | 範囲 | 観測効果 |
|---|---|---|
| **v1.x.x** (ADR-007) | koffi → Rust 撤去 + DXGI dirty rect 統合 (L1) | hot path 速度向上、sigsegv 消滅 |
| **v1.x+1.0** (ADR-008 D1-D2) | timely + DD core view 4 つ | desktop_state が view 経由、context 削減開始 |
| **v1.x+2.0** (ADR-008 D3) | time-travel `state_at(t)` | 過去 state クエリ |
| **v1.x+3.0** (ADR-010 P1-P2) | envelope 必須最小 + typed reason | LLM 不安行動の最初の改善 |
| **v1.x+4.0** (ADR-010 P3-P4) | include 拡張 + query_past リンク | causal trail / invariants 提供 |
| **v1.x+5.0** (ADR-010 P5) | dry-run on commit 系 tool | 副作用予測 |
| **v1.x+6.0** (ADR-008 D4-D5 + ADR-010 P6) | cyclic RPG + GPU Tier 3 + working/episodic memory | hot path GPU 化、CoALA Phase A |
| **v1.x+7.0** (ADR-008 D6) | replay (WAL + 任意 Intel PT) | bug 報告が log に |
| **v2.0.0** | breaking change envelope `_version: 2` | (将来、必要時) |

### 12.2 各 release のリスク制御

- 各 minor は **既存 LLM session で回帰なし** が必須 (acceptance criteria)
- envelope 導入は **server 側 compat mode** で旧 client (今の MCP client) も動かす
- Tier 3 (CUDA/HIP/L0) は **default で off**、env で opt-in、安定後 default on

---

## 13. Benchmark / Observability 体系 (C4 + C5 解消)

### 13.1 ベンチハーネス (`bench/` crate)

| 軸 | 対象 | KPI |
|---|---|---|
| latency | view 更新 / envelope assembly / time-travel query | p50/p95/p99 (μs) |
| throughput | event ingest / arrangement compaction | events/sec |
| memory | arrangement size, ring buffer occupancy | MB / event |
| tier dispatch | T3 hit rate / fallback rate | % |
| replay | determinism (bit-for-bit 一致率) | % (must be 100) |

### 13.2 Engine self-observability (`server_status` 拡張)

既存の `server_status` ツール (v0.15.x で追加) を拡張、envelope 化。

```jsonc
// server_status 応答 (envelope wrap)
{
  "data": {
    "uptime_ms": 12345678,
    "worker_lag_ms": { "p50": 0.3, "p95": 1.2, "p99": 8.5 },
    "arrangement": {
      "current_focused_element": { "rows": 1, "memory_mb": 0.001 },
      "dirty_rects_aggregate": { "rows": 47, "memory_mb": 0.012 },
      ...
    },
    "tier_dispatch_stats": { ... },
    "recent_failures": [ ... ],
    "wal_size_mb": 12.4,
    "subscribe_count": 2
  },
  "as_of": { "wallclock_ms": ... },
  "confidence": "fresh"
}
```

LLM が trouble shoot 時にこれを見て、tier の使い方や lag を判断できる。

### 13.3 観測ダッシュボード (将来)

- `server_status` を時系列で可視化する開発者向け UI (本ロードマップ外、ADR-012 候補)
- Materialize や Feldera が Web UI を持つように、本 engine も観測 UI を出す価値がある

---

## 14. Open Questions の集約

各 ADR の Open Questions を 1 表にまとめ、決定タイミング順にソート。

| # | OQ | 決定タイミング | 担当 ADR |
|---|---|---|---|
| 1 | session_id を MCP request id と紐付けるか独自管理か | P1 着手前 | ADR-010 |
| 2 | typed reason enum と `_errors.ts` SUGGESTS の合流方法 | P2 着手前 | ADR-010 |
| 3 | `state_at(t)` を全 view にするか選択 view のみか | D3 着手時 | ADR-008 |
| 4 | Subscribe API transport (MCP notification / WebSocket / 内部 callback) | ADR-008 D2 + ADR-010 P4 整合 | 両方 |
| 5 | `query_past` リンクの URI 形式 (string call: vs structured ref) | ADR-010 P4 着手時 | ADR-010 |
| 6 | dry-run の精度許容ライン (50/80/95%) | ADR-010 P5 着手時 | ADR-010 |
| 7 | working memory の N 上限推奨 default | ADR-010 P6 着手後 bench で | ADR-010 |
| 8 | arrangement snapshot の disk format (bincode/capnproto/自前) | ADR-008 D6 着手時 | ADR-008 |
| 9 | Intel PT 記録は全 session か bug 時のみか | ADR-008 D6 + 運用後 | ADR-008 |
| 10 | HIP Graph on Windows の本番投入時期 | ADR-008 D5 完了後 re-check | ADR-008 |
| 11 | DBSP を logical layer として乗せる protocol 互換要件 | 将来 (SQL UI 必要時) | ADR-008 |

---

## 15. 公開価値ロードマップ

### 15.1 論文候補 (3 本独立)

| # | 領域 | タイトル候補 | 主 contribution |
|---|---|---|---|
| 1 | DB / streaming | "GPU-accelerated incremental view maintenance for LLM agent perception" | DXGI dirty rect + CUDA Graph + DD で UI 観測の IVM、計測 |
| 2 | OS / debugging | "Hardware-assisted deterministic replay for LLM agent debugging" | Intel PT + arrangement snapshot で agent bug の bit-for-bit 再現 |
| 3 | HCI | "Sub-millisecond UI observation timestamps via Reflex Latency API" | race-free agent observation、ユーザビリティ評価 |

### 15.2 Talk / Blog 候補

- **"Self-Documenting Tool Envelopes: How LLM Agents Stop Being Anxious"** — UX 観点、HN/Lobsters/dev.to
- **"Why I Built an MCP Server on top of differential-dataflow"** — Materialize blog 系統での deep dive
- **"Tier 0-3 HW Acceleration for Windows Agent Runtime"** — Intel/AMD/NVIDIA dev forum

### 15.3 OSS リリースタイミング

- 本リポジトリは既に OSS。各 minor リリースで blog post をペアにし、認知を build
- 大きな節目 (envelope 導入 = v1.x+3.0、replay 導入 = v1.x+7.0) は talk 提案に乗せる

### 15.4 ナラティブ (一貫した物語)

> Microsoft が WinAppSDK Rust binding を archive した一方、Intel/AMD/NVIDIA の hw assist を Rust で結合した Windows MCP server が、partial-order time + arrangement-as-MVCC + Self-Documenting Envelope を備えて世に出る。LLM agent は "Tool 数の多さ" ではなく "1 tool あたりの情報密度・時間軸・副作用透明性" でこそ進化する、という設計仮説を実装で証明する。

---

## 16. SSOT としての本書の運用

### 16.1 ルール

- 本書が **3 層に跨る規約の Source of Truth**
- 各 ADR (007/008/010) は本書の節を **詳細化** する形で書かれる
- 不整合発生時は **本書を更新 → ADR を後追い更新**
- 本書の Status が `Approved` に上がった時、各 ADR も Approved に揃える

### 16.2 更新トリガー

- 識別子・時刻モデル・envelope 構造の変更 → 本書 §4-§8 を先に更新
- リリース順序変更 → 本書 §12 を更新
- 新規 OQ 解決 → 本書 §14 から該当行を削除、決定を該当節に反映

### 16.3 関連ファイル

- `docs/adr-007-koffi-to-rust-migration.md` (起草中、L1)
- `docs/adr-008-reactive-perception-engine.md` (起草済、L2-3)
- `docs/adr-009-hw-acceleration-plane.md` (後続、Tier 別実装ガイド)
- `docs/adr-010-presentation-layer-self-documenting-envelope.md` (起草済、L4-5)
- `docs/adr-011-cognitive-memory-extension.md` (後続、Semantic / Procedural)
- `docs/views-catalog.md` (後続、L3 view 一覧)
- `docs/schema-compat-matrix.md` (後続、§11 詳細)
- `bench/` (後続、§13.1)
- **`docs/layer-constraints.md` (本書 §17 の詳細版、各層の制約条件マトリクス)**

---

## 17. 各層の制約条件 (Summary)

詳細は `docs/layer-constraints.md` を参照。本節は俯瞰用の summary のみ。

### 17.1 制約の 6 観点

各層について以下を明文化:

| 観点 | 意味 |
|---|---|
| 入力契約 | 何を、どの形式・順序・レートで受け取るか |
| 出力契約 | 何を、どの形式・SLO で出すか |
| 不変条件 | 必ず保たねばならない invariant |
| 性能制約 | latency / memory / throughput SLO |
| 失敗モード | 典型 failure と recovery |
| 境界 | 越権してはいけないこと (層の責務) |

### 17.2 各層の責務 1 行サマリ

| 層 | 主責務 | やってはいけない |
|---|---|---|
| **L1 Capture** | hw event を統一形式で push、durability 保証 | 計算しない、state を持たない |
| **L2 Storage** | event を arrangement に materialize、time-travel 提供 | view 計算しない、副作用しない |
| **L3 Compute** | view を incremental に維持、dry-run subgraph | L2 に書き戻さない、副作用しない |
| **L4 Projection** | envelope の段階 enrichment、working/episodic memory | 計算しない、event を生成しない |
| **L5 Tool Surface** | MCP API の wrap、3 軸 dispatch | 計算しない、L1 を経由せず副作用しない |

### 17.3 性能 SLO の総覧

| 層 | KPI | 目標 |
|---|---|---|
| L1 | event ingest throughput | 10k/sec @ p99 < 1ms |
| L1 | dirty rect detect | DXGI 60Hz 同期 |
| L2 | materialize | p99 < 100μs/event |
| L2 | `state_at(t)` | p99 < 5ms |
| L3 | view 更新 | p99 < 1ms |
| L3 | dry-run preview | p99 < 50ms |
| L4 | envelope assembly (include 最大) | p99 < 5ms |
| L5 | query round-trip | p99 < 50ms |
| L5 | commit round-trip | p99 < 200ms |
| L5 | subscribe push 遅延 | p99 < 10ms |
| 全層 | replay 一致率 | 100% (bit-for-bit) |

### 17.4 Cross-layer 制約

| # | 制約 | 詳細 |
|---|---|---|
| X1 | Total ordering | partial-order `(wallclock_ms, sub_ordinal)` を全層で共有、L1 で採番、以降 immutable |
| X2 | Memory budget | L1=256MB / L2=512MB / L3=256MB / 合計 1-2GB、env で個別調整 |
| X3 | Error propagation | hw failure → typed event → view warning → envelope confidence 降格、の chain |
| X4 | Schema 整合 | L1 EventEnvelope と L5 Envelope の `_version` 整合チェック (起動時 fatal) |
| X5 | Replay determinism | record 時 wallclock を WAL → bit-for-bit 再生 |
| X6 | Tier dispatch | op 単位で独立、`server_status` で集約観測 |

### 17.5 制約の運用

- 制約変更は **本書 §17 + `layer-constraints.md` を先に更新 → 該当 ADR を後追い**
- bench/ harness で SLO 違反を CI fail に
- server_status で本番 SLO を継続監視
- 新規制約追加は「観測可能か」「違反時の影響を明示できるか」「SLO に根拠があるか」で評価

### 17.6 運用上の継続監視 (Continuous Monitoring SLO、Gemini review 指摘対応)

設計時の SLO を実装後も継続して守るため、`server_status` で常時監視する metric とその閾値を確定する。

| 監視項目 | 仕組み | 閾値 (default) | 超過時の挙動 |
|---|---|---|---|
| `envelope_size_full_p99` | bench + server_status | < 10KB | confidence `degraded`、warning event |
| `tier_fallback_overhead_p99` | server_status | < 500μs | tier 強制 pin 5min |
| `worker_lag_p99` | server_status | < 8.5ms (制約 §3.4 の materialize と整合) | confidence `degraded` |
| `arrangement_size_total` | server_status | < 512MB | compaction 加速 |
| `panic_rate_per_min` | server_status (`#[napi_safe]` の catch_unwind hit) | 0 in steady state | 自動 worker 再起動 + warning event |
| `wal_disk_usage_mb` | server_status | < 1024MB | rotation 加速、最古 WAL 削除 |

#### 17.6.1 `confidence` 値域の拡張

envelope `confidence` の値域を **既存 `fresh | cached | inferred | stale` に `degraded` を追加**:

| 値 | 意味 | LLM 推奨挙動 |
|---|---|---|
| `fresh` | 観測したて、信頼度高 | そのまま使用 |
| `cached` | arrangement 既知、最新でない可能性 | 必要なら refetch |
| `inferred` | 推論経由 (dry-run 等) | 確定情報として扱わない |
| `stale` | 計算失敗 / arrangement 不在 | 再観測必須 |
| **`degraded`** (新) | 監視閾値超過、結果は使えるが品質低下 | **保守的に再観測**、`if_unexpected.try_next` を参照 |

#### 17.6.2 監視データの出口

- `server_status` ツール経由で LLM が直接取得可能 (envelope wrap 済)
- 開発者向け: 将来の dashboard (ADR-012 候補)
- bench harness: CI で閾値違反を fail に (前回 main からの regression 検出)

---

## Appendix A: 用語集

| 用語 | 定義 |
|---|---|
| arrangement | timely+DD の `(key, val, time, diff)` 4-tuple LSM-tree 風 sorted batch、multi-version |
| Z-set | 各 row に整数 weight (`±n`) を持つ集合。delta 表現の基本単位 |
| logical_time | timely の partial-order timestamp。本設計では `(wallclock_ms, sub_ordinal)` |
| view | DD の materialized collection。incremental に更新される |
| capability | timely の subscribe 機構、特定 logical_time での data access 権 |
| frontier | timely の "これ以降の event は届かない" 進行点 |
| envelope | LLM 向け統一 tool 応答 shape (本書 §8、ADR-010 §5) |
| Tier 0-3 | HW assist の段階。Tier 0 = pure Rust、Tier 3 = vendor compute (本書 §9) |
| WAL | Write-Ahead Log。replay 用 event log |

---

## Appendix B: 改訂履歴

| version | date | author | summary |
|---|---|---|---|
| Draft v0.1 | 2026-04-29 | Claude (Opus) | 初版起草、3 ADR を統合、6 設計原則確定、識別子ヒエラルキー / 時刻モデル / Tier 統一規約を確定 |

---

END OF Architecture: 3-Layer Integrated Design (Draft).
