# walking skeleton S5 / G5 alignment (caused_by linkage cross-layer — desktop_act → desktop_state)

- Status: **Drafted (2026-05-01)**
- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.4) §4 **S5** (line 254-279) + §5 完了基準 (line 322-333) の最小実装。本 sub-plan は trunk **最重要 contract** = 直前 commit (`desktop_act`) の `tool_call_id` を後続 query (`desktop_state`) の envelope.caused_by に展開する経路を確定する
- Trigger: walking skeleton **S4 (PR #113 merged 2026-05-01)** が前提条件、S4 で確立した **`makeCommitWrapper` 7 step flow** + **`nextToolCallId(sessionId)` per-session counter** + **`defaultL1Emitter` (L1 ToolCallStarted/Completed push)** + **`makeQueryWrapper`** + **`ToolCallStartedPayload { tool, args_json, lease_token }`** schema 拡張を base に history buffer + causal window + caused_by projection を建てる
- 親 plan: `docs/walking-skeleton-trunk-selection.md` §4 S5 (line 254-279) + §4.1 line 306 (S5 工数 3-5 日 / Opus 3+ round 最重要 / Codex ✓) + §5 完了基準 #2 (line 327)
- 概念設計:
  - `docs/adr-010-presentation-layer-self-documenting-envelope.md` §5 envelope schema (line 200-206 caused_by 4 field example、本 sub-plan §2.2 で 4 field CausedByShape + envelope トップレベル `BasedOnShape` に再構成、§6 OQ #6 で ADR-010 後追い update carry-over) + §5.2 任意拡張 (`include=causal` → caused_by) + §5.5 P3 phase (caused_by + invariants_held) + §5.6 Envelope Size SLO (causal include +1KB 以内、§5.6.1 表)
  - `docs/architecture-3layer-integrated.md` §6 (1 event の旅 worked example、T+0 → T+21ms timeline、L4 envelope assembly で caused_by を組立て) + §8 各層責務マトリクス (L4 が caused_by 担当、line 358) + §11.2 (compat mode、S3 で確立した post-flatten 経路を維持)
- 並走依存: 本 S5 sub-plan PR は **PR #113 (S4 impl) merged が前提条件**、本 sub-plan は S4 で確立した base に caused_by linkage を載せる増分のみを describe (S4 で確定した payload schema / wrapper template / `getSessionId` seam を再利用)
- 対象 sub-batch: walking skeleton **S5 (PR ?)** — per-session history buffer + causal window 境界実装 + `makeQueryWrapper` の caused_by projection 拡張 + `desktop_state` envelope への caused_by 注入 + `produced_changes` view diff projection (focus + dirty_rects per-monitor) + integration test (desktop_act → desktop_state caused_by 展開) + envelope size SLO bench harness 拡張 (causal include < 2KB)
- 後続: **S6 trunk 完了判定 + CI assert 化 + expansion plan 起草** は本 S5 merged が前提条件、S5 で確立した caused_by base が S6 で「expansion tool 1 件追加が L5 wrapper の修正のみで完了する」CI assert を機械化する根拠となる

---

## 0. walking skeleton S5 位置付け note

本 sub-plan は walking skeleton trunk (`docs/walking-skeleton-trunk-selection.md` Proposed v0.4) の **S5 sub-batch** = **trunk 最重要 contract**。S4 (PR #113、commit 軸 wrapper + lease validation + ToolCall payload schema) で **commit 経路** が確立、本 S5 で **commit ↔ query 跨ぎの causal linkage** を確定し、S6 で trunk completion を gate する:

- S1 (PR-η D2-E0 完了): dataflow scope refactor
- S2 (PR-ε D2-C 完了): count-only `dirty_rects_aggregate`
- S3 (PR #110 envelope skeleton 完了): envelope minimal wrapper + compat mode + size SLO bench
- S4 (PR #113 merged 2026-05-01): commit 軸 wrapper + lease 4-tuple validation + ToolCallStarted/Completed payload schema 確定
- **S5 (★ 本 PR、最重要 contract)**: caused_by linkage cross-layer (desktop_act → desktop_state)
- S6 (PR-?): trunk 完了判定 + CI assert 化 + expansion plan 起草

S5 は **TypeScript 中心 PR + Rust touch (DXGI dirty rect monitor_index 経由 view diff projection の readback API 必要なら) + Production code 改修 + 既存 envelope contract 拡張** で **Codex re-review 必須 1 round** (CLAUDE.md §3.3 Step 2、§3.2 PR #102 教訓延長: 既存 view API + envelope shape の bit-equal 維持軸)。Walking skeleton §4.1 line 306: 工数 **3-5 日 / Opus 3+ round (最重要) / Codex ✓**。

**G5 ゲートの目標** (`docs/walking-skeleton-trunk-selection.md` §4 S5 完了基準 line 271-277、§5 完了基準 #2 line 327):

| # | walking-skeleton §4/§5 S5 目標 | 本 sub-plan 検証手段 |
|---|---|---|
| 1 | `desktop_act` → `desktop_state` シーケンスで `caused_by` が正しく埋まる integration test | §3.6 G5-S5-1 (基本 path) + G5-S5-3 (multi-event window) integration test |
| 2 | `produced_changes` に focus 遷移 (A→B) と dirty rect 件数 (`monitor_index` 別 count) が含まれる | §3.6 G5-S5-2 produced_changes projection assertion |
| 3 | envelope size < 2KB (causal include、S3 bench harness で CI 計測) | §3.7 `benches/l4_envelope_size.mjs` に causal include シナリオ追加、`< 2048 bytes` assert + 5%/20% 増 warning/fail |
| 4 | lease 経由経路で `caused_by.your_last_action` が `"desktop_act(lease=..., action=...)"` として記録される | §3.6 G5-S5-4 lease commit path で your_last_action format 確認 |
| 5 | `elapsed_ms` が ToolCallStarted/Completed wallclock 差として観測される | §3.6 G5-S5-5 elapsed_ms 計算精度 (handler artificial sleep 50ms → elapsed_ms ≈ 50) |
| 6 | **G5 ゲート判定** (= walking-skeleton §5 完了基準 #2): `caused_by` cross-layer linkage が動き、S6 expansion plan 起草に進める contract が確定 | §3.8 G5 判定 + Appendix C append (impl PR merge 後) |

**review 観点の再定義**: 本 PR は「caused_by 完成度 (LLM context 経済性最適化 / `produced_changes` semantic richness)」ではなく **「S5/G5 contract が最短で検証できるか + S6 で trunk 完了判定 (= expansion tool 1 件追加が L5 wrapper の修正のみで完了することの CI assert) に進める base が固まっているか」** で評価する。`include=causal` 以外の include パターン (working/episodic memory、time_travel link、invariants_held フル拡充) は P3-P6 + expansion で carry-over、本 S5 では **`include=causal` 1 path + `caused_by` 4 field projection + envelope トップレベル `based_on` 並列配置** (Round 3 P1 Opus #1 反映で 5 field → 4 field に縮小、`based_on` を architecture §8.2 責務マトリクス整合で envelope トップレベル分離) + **causal window 右端 (a) frontier check + (b) monotonic timeout の 2 path runtime 配線**に絞る。

---

## 1. Scope (trunk / expansion / carry-over の 3 分類)

### 1.1 [S5 trunk] 本 sub-plan で扱う (G5 contract 必須)

A. **`src/tools/_envelope.ts` 拡張** (S4 で確立した `makeCommitWrapper` / `makeQueryWrapper` / `defaultL1Emitter` を base に、**per-session history buffer + caused_by projection** を追加):

  - **A-1. per-session history buffer**: in-memory `Map<sessionId, ToolCallEventRingBuffer>` (TS 側、ring 容量 8 件 default、超過時 head drop)。**Rust ring buffer 採用は OQ #1 で carry-over (expansion ADR-011 work)** — 理由は §2.1 設計判断
  - **A-2. defaultL1Emitter 拡張**: pushStarted/pushCompleted で L1 napi binding 呼出に加え、history buffer にも同 event を **二重記録** (L1 ring と TS history buffer の sync は best-effort、L1 失敗時も history buffer は記録継続 = LLM 不安解消最優先 § 2.1)
  - **A-3. caused_by projection helper**: `buildCausedBy(sessionId, currentEventFrontier, viewSnapshot): CausedByShape | undefined` 新設 — history buffer から **直前 1 件の commit event ペア** (Started + Completed) を抽出し、causal window 内 (= ToolCallStarted event_id ↔ 現 query event frontier) に発火した focus / dirty_rect view diff を `produced_changes` に projection
  - **A-4. `makeQueryWrapper` 拡張**: `include=causal` opt-in の場合のみ `buildCausedBy` を呼出し、`envelope.caused_by` を埋める (default は付けない、ADR-010 §5.5 P3 align)。`include=causal` 以外の include は本 S5 範囲外 (P4-P6 expansion)

B. **causal window 境界実装** (Walking-skeleton §3.4 + §4 S5 line 263-269):

  - **B-1. 左端**: `ToolCallStarted` event_id 直後 (history buffer entry の `eventIdStarted` field 由来)
  - **B-2. 右端 (a) 次 query frontier**: 現 query (desktop_state 等) が呼ばれた時点の **L1 ring 末尾 event_id** を採用 (= `viewSnapshot.latestEventId`)。trunk **default 採用**
  - **B-3. 右端 (b) timeout 200ms**: history buffer entry の `wallclockStartMs` から経過時間が 200ms 超なら window 強制 close (commit 後 long-tail event を取り逃がさず無限延長を防ぐ)。trunk **safety net として実装、production wiring**
  - **B-4. 右端 (c) first stable observation**: focus 50ms 同 element / dirty rect 50ms 0 件 で stable detect。**本 S5 trunk scope 外 carry-over** (OQ #2 で永続化、§7 R7 fixture 不安定対策の expansion work)

C. **`produced_changes` projection helper** (`buildProducedChanges(beforeView, afterView): string[]`):

  - focus delta: `"focus: <hwnd_or_name_before>→<hwnd_or_name_after>"` 形式 1 entry (focus 不変なら entry 省略)
  - dirty_rect aggregate: monitor_index 別 count = `"dirty_rects[monitor=0]: 3"` 等 (count > 0 monitor のみ entry 化、monitor_index field 維持 = CLAUDE.md §3.2 PR #102 教訓)
  - 本 trunk は **focus + dirty_rect の 2 source のみ**、semantic_event_stream 等 view 拡張は expansion (P3 後半 work)

D. **`desktop_state.ts` 経路で `include=causal` 受領 → `_envelope.ts` 経由 `caused_by` + envelope トップレベル `based_on` 展開** (Round 3 P1 Opus #1 反映で based_on をトップレベル分離):

  - `src/tools/desktop-state.ts` の handler は **不変** (ADR-010 §1.5 SSOT、tool 個別実装は修正不要)
  - **`src/tools/desktop-state.ts` の module-scope registration handler** (Round 4 P1 Opus + Codex 重複 fix、Round 3 P2 Codex #3 取り残しを訂正、PR #112 で確立した shared registration handler pattern 維持) で `makeQueryWrapper(desktopStateRawHandler, "desktop_state", { causedByProjector, getSessionId })` 形式で wrapper option 経由で causal projection を inject、`run_macro` 経路 (`TOOL_REGISTRY.desktop_state`) も同 module-scope shared instance 経由で同じ wrap 動作
  - `desktopStateRawHandler` 自体は raw `ToolResult` を返すまま、wrapper 側で envelope assembly + causal include 解釈 + `caused_by` (4 field) + `based_on` (envelope トップレベル) 並列注入

E. **`getSessionId` source 拡張** (S4 では default `() => "default"` + production override `args.lease?.viewId ?? "default"`):

  - **E-1. commit-axis `desktop_act`**: `args.lease?.viewId ?? "default"` (S4 既存維持、history buffer key)
  - **E-2. query-axis `desktop_state`** (Round 2 P1 Codex #1 fix): MCP transport context 由来 session_id を **第一候補** で resolve、resolve 不可かつ multi-LLM-client 検出時は **`"multi:disabled"` sentinel** を返して buildCausedBy 側で sentinel detect → caused_by 付与 skip (= cross-session leak 防止)、single-LLM-client prototype 確認時のみ `"default"` fallback。本 S5 trunk では sentinel guard + warn log の minimal impl、ADR-011 で MCP transport context schema を完全 finalize
  - **E-3. multi-session 並列 LLM client 完全対応**: ADR-011 (Cognitive Memory Taxonomy) で finalize — 本 S5 trunk skeleton は **sentinel guard 経由の opt-out** で multi-session 環境でも cross-session leak を発生させない (Codex Round 1 P1 #1 反映)、完全 multi-session caused_by projection は ADR-011 work

F. **envelope size SLO bench harness 拡張**:

  - `benches/l4_envelope_size.mjs` に **causal include シナリオ 3 件追加**:
    - `causal_minimal` (focus 遷移 + dirty 0 件): < 1.5KB 想定
    - `causal_typical` (focus 遷移 + 2 monitor dirty + args_summary 100 byte): < 2KB 必達 (G5 #3)
    - `causal_max` (focus 遷移 + 2 monitor dirty + args_summary 512 byte truncate): < 2KB 必達 (size 圧迫上限)
  - 既存 minimal (< 1KB) / failure (< 5KB) シナリオ + S5 で +1KB 以内 = 合計 < 2KB を CI で機械化 (前回 main から 5% 増 warning / 20% 増 fail、ADR-010 §5.6.2)

G. **G5 ゲート判定 + Appendix C append** — `docs/walking-skeleton-trunk-selection.md` Appendix C 末尾に `| G5 | 2026-05-XX | (継続/shrink) | (...) | (...) |` を append (本 sub-plan §3.8、impl PR merge 後 — S4 と異なり history buffer の runtime behavior 確認が S6 trunk 完了判定の前提になるため、Appendix C entry 追記は merge ブロッカーではなく **本 S5 impl PR と S6 PR の間で別 commit として post-merge 追記**)

### 1.2 [expansion] G5 通過後の expansion phase で実装 (本 PR scope 外)

trunk 完了 (G5 通過) 後の expansion phase で実装:

- **caused_by フィールド拡充**: `caused_by.based_on.events` の event_id 配列に L1 ring の **observation event** (UiaFocusChanged / DirtyRect / WindowChanged) も含める拡張 (本 trunk は ToolCallStarted / ToolCallCompleted 2 件のみ、observation event は `produced_changes` の derive 元として使うが `based_on.events` には含めない)
- **`include=causal,working:N` 等の組合せ**: ADR-010 §5.2 の `working:N` (直近 N event compact) / `episodic:N` (直近 N tool call history) は P6 で実装、本 S5 は `include=causal` 単独のみ
- **`include=time_travel` (P4 default-on)**: `query_past` link は本 S5 範囲外、ADR-008 D3 完了後に着手
- **`include=invariants` (P3)**: `invariants_held` projection (window_title_stable / no_concurrent_focus_change / lease_digest_matched 等) は P3 後半 expansion work、本 S5 は caused_by 単独
- **causal window 右端 (c) first stable observation**: focus 50ms 同 element / dirty rect 50ms 0 件 stable detect は §7 R7 fixture 不安定対策、本 trunk skeleton では (a) + (b) の 2 path で十分、(c) は OQ #2 で carry-over
- **multi-session session_id**: MCP transport context 由来 session_id schema は OQ #3、ADR-011 (Cognitive Memory Taxonomy) で session 跨ぎ episodic memory と統合検討
- **history buffer 永続化**: server-restart 跨ぎで history buffer を復元 (cross-session replay) は OQ #1 で carry-over、Rust ring buffer / SQLite / file persist の 3 案は ADR-011 work
- **残 ~24 commit tool wrapper 化**: S4 で確立した `makeCommitWrapper` を mechanical コピー (mouse_click / keyboard / clipboard / ...)、本 S5 で確立した caused_by linkage は wrapper 自動展開で全 commit tool に波及 (= trunk completeness 判定の根拠)

### 1.3 [carry-over] §3.bis ledger / OQ で永続化 (別 phase)

- **OQ #1 — history buffer 設計** (TS Map vs Rust ring): 本 S5 trunk では **TS in-memory `Map<sessionId, ToolCallEventRingBuffer>`** 採用 (§2.1 設計判断、ring 容量 8 件 default、超過時 head drop)。**Rust ring buffer 採用は carry-over** — 理由: (1) trunk = contract spike、persist 不要、(2) 新 napi readback API (history_buffer_drain 等) 追加は既存 L1 ring と semantic 重複 risk、(3) Cross-server-restart replay は ADR-011 work。本 sub-plan §8 OQ #1 で carry-over。
- **OQ #2 — causal window 右端 (c) first stable observation**: focus 50ms 同 element / dirty rect 50ms 0 件 stable detect logic は本 S5 trunk skeleton では未配線、§7 R7 fixture 不安定対策の expansion で実装。本 sub-plan §8 OQ #2 で carry-over。
- **OQ #3 — multi-session session_id source 完全 finalize**: MCP transport context 由来 session_id (request session header / connection-id 等) の完全 finalize は ADR-011 (Cognitive Memory Taxonomy) で。本 S5 trunk skeleton は **sentinel guard (`"multi:disabled"`) + warn log で multi-session 環境でも cross-session leak が起きない安全側 impl** を採用 (Round 2 P1 Codex #1 反映、§1.1 E-2)、single-LLM-client prototype 検出時のみ `"default"` fallback で caused_by 動作。本 sub-plan §8 OQ #3 で carry-over。
- **`caused_by.your_last_action` semantic 解釈** (S4 sub-plan OQ #2 carry-over from PR #113): 本 S5 で **「直前任意 commit tool」を採用** (副作用持ち tool のみ history buffer 対象、query は副作用なし caused_by 文脈外、S4 sub-plan OQ #2 推奨 finalize)。expansion で「直前 desktop_act 限定」モード (commit chain 中の最終 act のみ) を opt-in 選択肢として追加検討は ADR-011 work
- **既存 LLM client 破壊禁止 (CLAUDE.md §3.2 PR #102 教訓延長)**: S3/S4 と同じ compat mode (server 常に envelope assembly + post-flatten で raw shape return) で担保、`desktop_state` の e2e test 無修正 pass を §3.7 で pin。`include=causal` は **opt-in** (default では caused_by を付けない、raw client + envelope client 両者破壊なし)

### 1.4 北極星整合 + walking skeleton G5 contract

- **N1 (pivot 必ず保持)**: history buffer の entry key = `sessionId:toolCallId` (S4 で確立した per-session monotone seq + sessionId の組)。`sessionId + toolCallId` の 2 軸で commit event を traceable に、history buffer drain 時も pivot 保持。`caused_by.tool_call_id` は history buffer entry の同 field を直接 projection (= S4 で確立した per-session counter `${sessionId}:${seq}` 形式の 1:1 mapping)
- **N2 (watermark で frontier 進行)**: causal window 右端 (a) は **L1 ring の latestEventId** = watermark frontier、現 query 時点で advance された frontier を採用 (S2/S3 D1 で確立した N2 contract = quiescent frontier idle advance を活用)。`based_on.events` の終端 event_id は frontier 進行に伴って bounded に増加 (Vec push only、削除なし、L1 ring の bounded retention は L1 既存 invariant に従う)
- **CLAUDE.md 強制命令 3.1 (ADR/plan 複数表 fact 整合)**: 本 PR では **5 SSOT** を bit-equal に揃える sweep:
  1. 本 sub-plan (`docs/adr-010-p1-s5-plan.md`)
  2. 親戦略 walking-skeleton §4 S5 (line 254-279) + §5 完了基準 #2 (line 327) + §3.4 causal window 境界 (line 161-167) + §7 OQ #5 (line 404)
  3. ADR-010 §5 envelope schema (line 200-206 caused_by 4 field example、本 sub-plan §2.2 で `tool_call_id` 採用版に再構成 + envelope トップレベル `based_on` 分離、§6 OQ #6 で後追い update carry-over) + §5.2 任意拡張 (`include=causal`、line 256) + §5.5 P3 phase (line 358) + §5.6 envelope size SLO (`include=causal` +1KB 以内、line 380)
  4. architecture §6 (1 event の旅 worked example、T+0 → T+21ms) + §8 各層責務 (L4 が caused_by、line 358) + §11.2 (compat mode)
  5. S4 sub-plan (`docs/adr-010-p1-s4-plan.md`) §1.3 carry-over OQ #2 (= 本 S5 OQ で finalize) + §9 architecture diagram の S5 部分 (line 610-616)
- **CLAUDE.md 強制命令 3.2 (carry-over scope shrink、PR #102 教訓延長)**: 既存 `desktop_state` handler internal logic + Zod schema + 戻り値 shape **不変** (§1.1 D + §2.5 章で詳述)、`include=causal` は wrapper 経由 opt-in で **既存 raw shape client 破壊なし**。`monitor_index` field 保持は `produced_changes` の dirty_rect entry で必須 (`"dirty_rects[monitor=0]: 3"` 形式、PR #102 同型 regression 防止)
- **walking skeleton G5 contract** (Walking-skeleton §5 完了基準 #2): `caused_by` cross-layer linkage = `desktop_act → desktop_state` シーケンスで commit (L1 ToolCallStarted/Completed) と observation (L3 view diff) が **history buffer 経由で結合**され、`include=causal` opt-in で envelope に展開される runtime path が動作する。本 contract が動けば S6 で trunk 完了判定 (= expansion tool 1 件追加が L5 wrapper の修正のみで完了することの CI assert) に進める

---

## 2. 設計判断

### 2.1 history buffer location: TS in-memory Map (OQ #1 trunk 採用)

#### 採用理由

| 軸 | TS Map (採用) | Rust ring buffer (carry-over) |
|---|---|---|
| 実装複雑度 | 低 (Map<string, ring>、~50 line) | 中-高 (新 napi readback API + cargo crate 改修 + binary compat 担保) |
| trunk = contract spike 整合 | ✅ persist 不要、in-process 即値 | ❌ persist は ADR-011 carry-over、trunk overload |
| L1 ring との semantic 重複 risk | 低 (history は **wrapper 観点の sessionId-keyed pair**、L1 ring は per-event flat) | 中 (history を Rust 側に置くと L1 ring の subset semantic との混同 risk) |
| Cross-server-restart replay | 不可 (in-memory) → OQ #1 carry-over | 可能 (Rust ring + WAL persist) → ADR-011 で再検討 |
| Test 駆動性 | 高 (Map<string, ring> の reset / inject seam が pure JS) | 中 (Rust unit test + napi roundtrip test 必要) |
| envelope size SLO 計測精度 | 高 (TS 側で history → caused_by projection を 1 process 完結) | 中 (napi roundtrip 経由で +overhead) |

**判定**: trunk = contract spike では TS Map 採用が正解。Rust ring buffer は ADR-011 + walking skeleton expansion 後に再検討 (cross-server replay / multi-session persist 要件発生時)。

#### history buffer schema

```typescript
// src/tools/_envelope.ts (S5 で追加)

/**
 * S5 history buffer entry — commit event pair (Started + Completed) と
 * causal window 計算に必要な metadata を保持。
 *
 * sub-plan §1.1 A-1 / §2.1 設計判断 / §3.1 S5-1 で実装。
 */
export interface ToolCallEvent {
  /** S4 で採番済 (`${sessionId}:${seq}` 形式)。caused_by.tool_call_id へ projection。 */
  toolCallId: string;
  /** Tool name (S4 で確立した tool 名、例: "desktop_act") */
  toolName: string;
  /** S4 で確立した args_summary (truncate ≤ 512 byte JSON、§2.6 既存実装) */
  argsSummary: string;
  /** L1 ToolCallStarted の event_id (causal window 左端) */
  eventIdStarted: bigint | undefined;  // L1 push 失敗時 undefined
  /** L1 ToolCallCompleted の event_id (causal window 右端の 1 候補) */
  eventIdCompleted: bigint | undefined;
  /** ToolCallStarted の wallclock (caused_by.elapsed_ms = end - start 計算用、表示用 monotonic 非依存値) */
  wallclockStartMs: number;
  /** ToolCallCompleted の wallclock (caused_by.elapsed_ms = end - start) */
  wallclockEndMs: number | undefined;
  /**
   * Round 2 P2 (Opus #5) NEW: ToolCallStarted の monotonic clock (`performance.now()` 由来、causal window
   * timeout 200ms 計算用、system clock drift 非依存)。L1 emitter pushStarted で `performance.now()` を記録。
   * `wallclockStartMs` (Date.now() 由来、表示用) と並走、用途別に分離。
   */
  monotonicStartMs: number;
  /** handler 実行結果 (caused_by に直接含めないが、failure 時 history buffer から caused_by 抽出時に skip 判断に使用) */
  ok: boolean | undefined;
  /** lease_token summary (S4 で確立、causal include の future expansion で `caused_by.lease_used` 等に projection 余地) */
  leaseToken: NativeLeaseTokenSummary | undefined;
}

/** Per-session ring buffer (容量 8 件 default、超過時 head drop) */
export interface ToolCallEventRingBuffer {
  capacity: number;
  events: ToolCallEvent[];  // length ≤ capacity、最古→最新順
}

/** Module-scoped (in-process) per-session map */
const _historyBuffers = new Map<string, ToolCallEventRingBuffer>();
const HISTORY_BUFFER_CAPACITY = 8;

/** Test seam (test 間決定論性) */
export function _resetHistoryBuffersForTest(): void {
  _historyBuffers.clear();
}

/** S4 既存 nextToolCallId は変更なし、本 S5 で history buffer push を defaultL1Emitter で追加 */
```

#### `defaultL1Emitter` 拡張 (history buffer 二重記録)

```typescript
// src/tools/_envelope.ts (S4 既存 defaultL1Emitter に history push を追加)

export const defaultL1Emitter: CommitL1Emitter = {
  pushStarted({ tool, argsJson, sessionId, toolCallId, leaseToken }) {
    const eventIdStarted: bigint | undefined = (() => {
      try {
        return nativeL1?.l1PushToolCallStarted?.(tool, argsJson, sessionId, toolCallId, leaseToken);
      } catch {
        return undefined;  // L1 telemetry best-effort
      }
    })();
    // S5 NEW: history buffer 二重記録 (L1 失敗時も entry は記録、causal window 計算は monotonic 由来で動作可能)
    // Round 2 P1 (Opus #3) fix: pushHistoryStarted は sessionId 必須 (helper signature line 226 `& { sessionId: string }`)
    // Round 2 P2 (Opus #5) fix: monotonicStartMs を Date.now() と並走で記録、causal window timeout は monotonic 軸で
    pushHistoryStarted({
      sessionId, toolCallId, toolName: tool, argsSummary: argsJson, eventIdStarted,
      wallclockStartMs: Date.now(), monotonicStartMs: performance.now(), leaseToken,
    });
  },
  pushCompleted({ tool, elapsedMs, ok, errorCode, sessionId, toolCallId }) {
    const eventIdCompleted: bigint | undefined = (() => {
      try {
        return nativeL1?.l1PushToolCallCompleted?.(tool, elapsedMs, ok, errorCode, sessionId, toolCallId);
      } catch {
        return undefined;
      }
    })();
    // S5 NEW: history buffer entry を completed marker で update
    pushHistoryCompleted({ toolCallId, sessionId, eventIdCompleted, wallclockEndMs: Date.now(), ok });
  },
};

function pushHistoryStarted(partial: Omit<ToolCallEvent, "eventIdCompleted" | "wallclockEndMs" | "ok"> & { sessionId: string }): void {
  const ring = _historyBuffers.get(partial.sessionId) ?? { capacity: HISTORY_BUFFER_CAPACITY, events: [] };
  ring.events.push({ ...partial, eventIdCompleted: undefined, wallclockEndMs: undefined, ok: undefined });
  while (ring.events.length > ring.capacity) ring.events.shift();
  _historyBuffers.set(partial.sessionId, ring);
}

function pushHistoryCompleted(partial: { toolCallId: string; sessionId: string; eventIdCompleted: bigint | undefined; wallclockEndMs: number; ok: boolean }): void {
  const ring = _historyBuffers.get(partial.sessionId);
  if (!ring) return;  // unmatched completed — best-effort silent (race or eviction)
  const entry = ring.events.find((e) => e.toolCallId === partial.toolCallId);
  if (!entry) return;  // entry already evicted by ring overflow
  entry.eventIdCompleted = partial.eventIdCompleted;
  entry.wallclockEndMs = partial.wallclockEndMs;
  entry.ok = partial.ok;
}
```

**注意 (Round 1 sweep)**: `pushHistoryStarted` の `sessionId` source は CommitL1Emitter args の `sessionId` field (S4 で確立済、`L1ToolCallStartedArgs.sessionId`) を直接 history map key に使用。`getSessionId(args)` の結果が wrapper から L1 emitter に渡る経路は S4 でテスト pin 済 (`G3-S4-6`)、本 S5 は同 path を `_historyBuffers.set(sessionId, ...)` の key として再利用。

### 2.2 `caused_by` projection helper (`buildCausedBy`)

#### API

```typescript
// src/tools/_envelope.ts (S5 で新設)

/** view snapshot — current focus + dirty_rect view rows */
export interface ViewSnapshot {
  /** L3 latest_focus view 値 (focus_view (sessionId|"singleton") → element name/hwnd) */
  focus: { hwnd: bigint | null; elementName: string | null } | null;
  /** L3 dirty_rects_aggregate view rows ((monitor_index, frame_index) → count、S2 で確立) */
  dirtyRectsByMonitor: Map<number, number>;  // monitor_index → aggregate count
  /** L1 ring 末尾 event_id (= 現 query 時点の frontier、causal window 右端 (a)) */
  latestEventId: bigint | undefined;
  /** 現 query の wallclock (causal window 右端 (b) timeout 計算用) */
  queryWallclockMs: number;
}

/** caused_by **4 field** projection (Round 3 P1 Opus/Codex #1 反映で 5 → 4 field に修正)
 *
 * **Round 3 SSOT 整合 (Opus Round 2 P1 #1 反映)**: architecture §6 worked example (line 213-215) +
 * architecture §8.2 各層責務マトリクス (line 355-356) + ADR-010 §5 envelope schema (line 194-206) +
 * walking-skeleton §3.4 line 159 の 4 SSOT は **`based_on` を envelope トップレベル field として一貫扱い**。
 * Round 2 v0.2 で `CausedByShape.based_on` を内包させたのは **3 SSOT divergence 事実誤認**だった。
 * Round 3 v0.3 で `based_on` を `EnvelopeMinimalShape` トップレベルに分離 (architecture §8.2 line 355
 * L1 start / L2 end の責務マトリクス整合)、`CausedByShape` は 4 field に縮小。
 *
 * 4 field 集合:
 *   - your_last_action: 直前 commit summary (本 sub-plan §1.3 carry-over OQ #2 finalize: 直前任意 commit tool)
 *   - tool_call_id: S4 で採番済 (`${sessionId}:${seq}`)、history entry pivot
 *   - elapsed_ms: ToolCallStarted ↔ ToolCallCompleted wallclock 差
 *   - produced_changes: L3 view diff projection (focus delta + dirty_rect per-monitor count)
 *
 * `session_id` は ADR-010 §4 識別子ヒエラルキーで envelope 全体に共通する pivot のため CausedBy field 内には
 * 重複させず、tool_call_id の prefix (`${sessionId}:${seq}`) から逆引可能で十分。ADR-010 §5 example の
 * `session_id` field 採用検討は §6 OQ #6 carry-over (L4 envelope semantic 整合)。
 */
export interface CausedByShape {
  your_last_action: string;     // "desktop_act(action='click', lease=...)" 等の summary
  tool_call_id: string;          // S4 で採番済 (`${sessionId}:${seq}`)
  elapsed_ms: number;            // ToolCallStarted ↔ ToolCallCompleted wallclock 差
  produced_changes: string[];    // L3 view diff projection (本 sub-plan §1.1 C SSOT、produced_changes の dirty_rect format `"dirty_rects[monitor=N]: count"` は本 sub-plan で確定、ADR-010 §5 example update は §6 OQ #6 carry-over)
}

/** envelope トップレベル `based_on` field (architecture §8.2 line 355 L1 start / L2 end 責務マトリクス整合)
 *
 * Round 3 P1 Opus #1 反映で `CausedByShape.based_on` から envelope トップレベルに分離。
 * Round 3 P1 Codex line 370 反映で `events` を **`string[]` (u64 decimal string)** に変更採用 — 内部処理は
 * bigint で扱い、envelope serialize 時に `String(eventId)` 変換。理由: (1) MCP transport JSON.stringify は
 * native bigint で `TypeError: Do not know how to serialize a BigInt` 確実 throw (Codex node -e で実証済、
 * 2026-05-01)、(2) LLM client (Claude CLI 等) は bigint 直接扱えない、(3) string 化で precision loss なし
 * (u64 → decimal string で full 64-bit 表現)、(4) PascalCase typed reason と同様の stable string contract。
 */
export interface BasedOnShape {
  /** L1 event_id range (start: ToolCallStarted, end: ToolCallCompleted or frontier latestEventId)
   *  u64 を decimal string で表現 (precision loss 0、JSON.stringify TypeError 回避) */
  events: string[];
  /** Observation source 由来 (UIA = focus 由来 / DXGI = dirty_rect 由来)、観測されていない source は
   *  empty array、Round 2 で sources 動的 build を採用 (Opus Round 1 P2 #3) */
  sources: string[];
}

/**
 * 直前 1 件の commit event ペア (Started + Completed) を history buffer から抽出し、
 * causal window 内 (= ToolCallStarted event_id ↔ 現 query frontier) に発火した
 * focus / dirty_rect view diff を produced_changes に projection。
 *
 * sub-plan §1.1 A-3 で実装、§2.2 で API 確定、§3.1 S5-2 で配線、§3.6 G5-S5-1〜3 で test pin。
 *
 * 戻り値:
 *   - history buffer 空 (commit 未発火) → undefined
 *   - 直前 commit が causal window 外 (timeout 200ms 経過) → undefined (window expired)
 *   - その他 → CausedByShape
 *
 * トリガー: makeQueryWrapper の include=causal opt-in 経路から呼出 (sub-plan §1.1 A-4)。
 */
export function buildCausedBy(
  sessionId: string,
  viewSnapshot: ViewSnapshot,
  options?: { causalWindowTimeoutMs?: number; monotonicNowMs?: () => number }  // default 200ms (walking-skeleton §4 S5 line 264)
): CausedByShape | undefined {
  const ring = _historyBuffers.get(sessionId);
  if (!ring || ring.events.length === 0) return undefined;
  const lastEvent = ring.events[ring.events.length - 1];
  if (lastEvent.wallclockEndMs === undefined) return undefined;  // commit in-flight、window 未閉

  // Round 2 P2 (Opus #5) fix: causal window timeout は monotonic 軸で計算 (system clock drift / NTP sync で
  // false-positive expire 防止、Lesson 1 causal window 設計同型 risk)。production wiring は performance.now()
  // を採用、test seam で固定可能。wallclock 差は表示用 elapsed_ms (line 後段) の計算にのみ使用。
  // 各 history entry に `monotonicStartMs` field を追加する必要があるが、本 sample では options injection 経由で
  // 表現 (実装は §3.1 S5-1 で entry に monotonic field 追加 + L1 emit 時に同時記録)。
  const timeoutMs = options?.causalWindowTimeoutMs ?? 200;
  const nowMonotonic = options?.monotonicNowMs?.() ?? performance.now();
  if (lastEvent.monotonicStartMs !== undefined && nowMonotonic - lastEvent.monotonicStartMs > timeoutMs) {
    return undefined;  // window expired (右端 (b) safety net)
  }

  // Round 2 P1 (Codex #2) fix: causal window 右端 (a) を runtime enforce — entry の event_id_completed が
  // 現 query 時点の latestEventId frontier を超えている場合、entry はまだ frontier に到達していない (= 後続
  // observation event が未 push) ため、本 query では projection せず undefined return。次 query で再 attempt。
  // この check が無いと、unrelated UI 変化を last tool call に attributed する causal-window contract 違反。
  if (
    viewSnapshot.latestEventId !== undefined &&
    lastEvent.eventIdCompleted !== undefined &&
    lastEvent.eventIdCompleted > viewSnapshot.latestEventId
  ) {
    return undefined;  // frontier がまだ commit completion に追いついていない
  }

  // Round 2 P1 (Opus #3) fix: buildProducedChanges に viewSnapshot 引数渡し
  // produced_changes projection (§2.3、本 trunk skeleton は viewSnapshot 1 引数の近似実装、deep-diff は §6 OQ #4)
  const producedChanges = buildProducedChanges(viewSnapshot);

  return {
    your_last_action: `${lastEvent.toolName}(${lastEvent.argsSummary})`,  // §1.3 「直前任意 commit tool」採用
    tool_call_id: lastEvent.toolCallId,
    elapsed_ms: lastEvent.wallclockEndMs - lastEvent.wallclockStartMs,
    produced_changes: producedChanges,
  };
}

/**
 * envelope トップレベル `based_on` field を build (Round 3 P1 Opus #1 反映で CausedByShape から分離、
 * architecture §8.2 line 355-356 L1 start / L2 end 責務マトリクス整合)。
 *
 * sub-plan §2.2 で API 確定、§3.2 S5-2 で配線、§3.6 G5-S5-1 で test pin。
 *
 * Round 3 P1 Codex line 370 反映: `events` を **`string[]` (u64 decimal string)** で envelope に格納、
 * native bigint JSON.stringify TypeError 完全回避。caller (buildEnvelope) は `String(eventId)` 変換のみで済む。
 *
 * 戻り値:
 *   - history buffer 空 / lastEvent.wallclockEndMs undefined → undefined (envelope に based_on 付与なし)
 *   - その他 → BasedOnShape (events u64 decimal string + sources 動的 build)
 *
 * トリガー: makeQueryWrapper の include=causal opt-in 経路から、buildCausedBy と並列で呼出 (§2.4 flow)。
 */
export function buildBasedOn(
  sessionId: string,
  viewSnapshot: ViewSnapshot,
): BasedOnShape | undefined {
  const ring = _historyBuffers.get(sessionId);
  if (!ring || ring.events.length === 0) return undefined;
  const lastEvent = ring.events[ring.events.length - 1];
  if (lastEvent.wallclockEndMs === undefined) return undefined;

  // events: u64 decimal string で precision loss 0、JSON.stringify TypeError 回避
  const events: string[] = [];
  if (lastEvent.eventIdStarted !== undefined) events.push(String(lastEvent.eventIdStarted));
  if (lastEvent.eventIdCompleted !== undefined) events.push(String(lastEvent.eventIdCompleted));

  // sources: produced_changes 由来動的 build (Round 2 P2 Opus #3、本 Round 3 でも維持)、observation 駆動
  const producedChanges = buildProducedChanges(viewSnapshot);
  const sources: string[] = [];
  if (producedChanges.some((c) => c.startsWith("focus:"))) sources.push("UIA");
  if (producedChanges.some((c) => c.startsWith("dirty_rects["))) sources.push("DXGI");

  return { events, sources };
}
```

#### 設計上の制約

- **直前 1 件のみ**: history buffer の最新 entry を 1 件 projection、複数 entry の chain 表現は P6 (working/episodic) で expansion
- **causal window 右端 (a) は `viewSnapshot.latestEventId` を frontier check で使用** (Round 2 P1 Codex 反映): history entry の `eventIdCompleted` が L1 push 失敗で undefined の場合は events 配列から 1 entry 落ちる (best-effort、§7 R2 で記述)、frontier 未到達 (eventIdCompleted > latestEventId) は projection skip
- **commit 失敗 (ok: false) も history に記録**: failure case の caused_by は LLM 不安解消最優先、`your_last_action` に commit 失敗事実が表示される (S4 で確立した typed reason failure envelope と組合せで LLM が recovery path に到達)
- **bigint serialize 戦略 = u64 decimal string** (Round 3 P1 Codex line 370 反映): MCP transport JSON.stringify で native bigint TypeError 確実回避、Node `node -e "JSON.stringify({events:[1n]})"` で TypeError 実証済 (Codex 2026-05-01)、LLM client 互換性 + precision loss 0 を兼備

### 2.3 `produced_changes` projection helper (`buildProducedChanges`)

```typescript
// src/tools/_envelope.ts (S5 で新設)

/**
 * focus delta + dirty_rects per-monitor count を produced_changes 配列に projection。
 *
 * sub-plan §1.1 C で実装、§3.1 S5-2 で配線、§3.6 G5-S5-2 で test pin。
 *
 * トリガー: buildCausedBy 内から呼出。
 *
 * **注**: S5 trunk skeleton では before view (= 直前 query 時点の view) を保持しないため、
 * focus delta は **「現 view の focus を最終状態として記録」** する近似実装 (§7 R5 で deep-diff carry-over)。
 */
export function buildProducedChanges(viewSnapshot: ViewSnapshot): string[] {
  const changes: string[] = [];
  // focus delta (近似: focus 不在時 entry 省略)
  if (viewSnapshot.focus !== null) {
    changes.push(`focus: → ${viewSnapshot.focus.elementName ?? `hwnd=${viewSnapshot.focus.hwnd}`}`);
  }
  // dirty_rects per-monitor count (count > 0 monitor のみ entry 化、CLAUDE.md §3.2 monitor_index 維持)
  for (const [monitorIndex, count] of viewSnapshot.dirtyRectsByMonitor) {
    if (count > 0) {
      changes.push(`dirty_rects[monitor=${monitorIndex}]: ${count}`);
    }
  }
  return changes;
}
```

**carry-over** (OQ #4): focus delta の **before/after 両表記** (`"focus: A→B"` 形式、walking-skeleton §4 S5 line 261) は本 trunk skeleton では before 保持しない近似で済ます (`"focus: → B"`)。完全 before/after deep-diff は **§7 R5 で expansion carry-over** (per-session view snapshot history が必要、history buffer の view-side counterpart 拡張で対応)。

### 2.4 `makeQueryWrapper` 拡張 (`include=causal` opt-in)

```typescript
// src/tools/_envelope.ts (S4 既存 makeQueryWrapper に causedByProjector option を追加)

export interface QueryWrapperOptions extends MakeEnvelopeAwareOptions {
  /**
   * S5 NEW: caused_by + based_on projection を envelope に注入する callback。
   * `include=causal` opt-in 経路でのみ呼出、default は付けない (ADR-010 §5.5 P3 align)。
   *
   * **Round 3 P1 (Opus + Codex 重複) fix**: signature を `(args, sessionId)` に変更
   * (sentinel guard `multi:disabled` runtime path を closed loop で機能させるため、
   * makeQueryWrapper が getSessionId resolve 結果を projector に伝播)。
   *
   * Production wiring (`src/tools/desktop-state.ts`): closure that
   *   1. sentinel `"multi:disabled"` 受領時は **immediate undefined return** (caused_by skip = cross-session leak 回避)
   *   2. view から ViewSnapshot を build (focus + dirty_rects + latestEventId)
   *   3. buildCausedBy(sessionId, snapshot) + buildBasedOn(sessionId, snapshot) を並列呼出
   *   4. { causedBy, basedOn } を return
   * Tests inject a deterministic projector to pin G5-S5-1〜3 path.
   */
  causedByProjector?: (args: unknown, sessionId: string) => Promise<{ causedBy?: CausedByShape; basedOn?: BasedOnShape } | undefined>;
  /**
   * S5 NEW: getSessionId source (S4 既存 commit-axis と semantic 共有)。
   * Round 3 P1 (Opus + Codex 重複) fix: makeQueryWrapper flow が必ず呼出 (Round 2 dead-loop 修正)、
   * sentinel `"multi:disabled"` を返した場合は projector 内で skip。
   * Default `"default"` fallback は **single-LLM-client prototype 限定 deploy** (本 S5 trunk skeleton scope、
   * §1.1 E-2 + OQ #3 で完全 finalize は ADR-011 work)。
   */
  getSessionId?: (args: unknown) => string;
}
```

`makeQueryWrapper` の internal flow に **include peek + getSessionId resolve + causedByProjector 呼出** を追加:

```typescript
// makeQueryWrapper (S5 で拡張、S4 既存 flow + include peek + Round 3 sentinel runtime path)
async function wrapped(rawArgs: unknown): Promise<unknown> {
  const { handlerArgs, includeArgs } = peekAndStripInclude(rawArgs);  // S3 既存
  const handlerResult = await handler(handlerArgs);                    // S4 既存 (変更なし)
  let causedBy: CausedByShape | undefined;
  let basedOn: BasedOnShape | undefined;
  if (includeArgs.includes("causal") && options.causedByProjector) {
    // Round 3 P1 (Opus + Codex 重複) fix: getSessionId resolve を flow 内で必ず実行、
    // projector 引数として伝播 (dead-loop 回避、sentinel guard runtime path 確立)
    const sessionId = options.getSessionId?.(handlerArgs) ?? "default";
    const projection = await options.causedByProjector(handlerArgs, sessionId);  // S5 NEW
    causedBy = projection?.causedBy;
    basedOn = projection?.basedOn;
  }
  const envelope = buildEnvelope(handlerResult, { causedBy, basedOn });  // S5 NEW: causedBy + basedOn 並列 inject
  return compatHoist(envelope);                                            // S3 既存
}
```

### 2.5 `desktop_state` 経由 wiring (production)

**Round 3 P2 (Codex #3) fix**: 実際の `desktop_state` module-scope schema/handler/server registration は **`src/tools/desktop-state.ts`** に存在し、`run_macro` も同 module から `desktopStateRegistrationHandler` を import。Round 2 で「`src/tools/desktop-register.ts` で wiring」と書いたのは誤り (PR #112 同型 strip risk pattern の延長で、実装 PR で間違った場所を編集する risk あり)。本 §2.5 + §3.4 + §10 References は `desktop-state.ts` に訂正。

`src/tools/desktop-state.ts` で MCP server 登録 site の wrapper 化 (handler 内部 logic + Zod schema + 戻り値 shape 不変):

```typescript
// src/tools/desktop-state.ts (S5 で既存登録 site を makeQueryWrapper で wrap)
// run_macro 経路 (TOOL_REGISTRY.desktop_state) も module-scope shared instance を import するため、
// PR #112 で確立した shared registration handler pattern を維持 (run_macro / direct MCP 両経路で同一 wrap 動作)

export const desktopStateRegistrationSchema = withEnvelopeIncludeSchema(originalDesktopStateSchema);

export const desktopStateRegistrationHandler = makeQueryWrapper(
  desktopStateRawHandler,
  "desktop_state",
  {
    getSessionId: (args) => {
      // Round 2 P1 (Codex #1) fix + Round 3 P1 (Opus + Codex 重複) closed-loop:
      // makeQueryWrapper internal flow が本 closure を必ず呼出、戻り値を causedByProjector に伝播
      const transportSessionId = getMcpTransportSessionId();  // ADR-011 完全 finalize、本 S5 では stub `() => undefined`
      if (transportSessionId !== undefined) return transportSessionId;
      if (!isSingleSessionPrototype()) {
        // multi-session 検出 → sentinel を return、projector 内で immediate undefined return
        return "multi:disabled";
      }
      return "default";  // single-LLM-client prototype (本 S5 trunk スコープ、§1.1 E-2、OQ #3 で完全 finalize)
    },
    causedByProjector: async (_args, sessionId) => {
      // Round 3 P1 (Opus + Codex 重複) fix: sentinel guard runtime check を closed loop で機能させる
      if (sessionId === "multi:disabled") {
        return undefined;  // multi-session 検出時 caused_by + based_on skip = cross-session leak 完全回避
      }
      const focus = await getDesktopFacade().getLatestFocus();        // L3 latest_focus view 経由
      const dirtyRects = await getDesktopFacade().getDirtyRectsAggregate();  // L3 dirty_rects view 経由
      const latestEventId = await getDesktopFacade().getLatestEventId();   // L1 ring 末尾 event_id
      const snapshot: ViewSnapshot = {
        focus: focus ?? null,
        dirtyRectsByMonitor: dirtyRects ?? new Map(),
        latestEventId,
        queryWallclockMs: Date.now(),
      };
      // Round 3 P1 (Opus #1) fix: based_on は envelope トップレベル責務、buildBasedOn を並列呼出
      return {
        causedBy: buildCausedBy(sessionId, snapshot),
        basedOn: buildBasedOn(sessionId, snapshot),
      };
    },
  },
);

// MCP server 登録 (`src/server.ts` 等) は既存の desktopStateRegistrationHandler を直接使用、wrapper 経由化済
mcp.tool("desktop_state", desktopStateRegistrationSchema, desktopStateRegistrationHandler);
```

**重要 (ADR-010 §1.5 SSOT)**: `desktopStateRawHandler` 自体は **handler internal logic / Zod schema / 戻り値 shape 不変**。`getDesktopFacade().getLatestFocus/getDirtyRectsAggregate/getLatestEventId` は既存 facade に **read-only accessor として追加** (新規副作用なし、既存 view 読取り経路 reuse)、必要なら `src/tools/desktop.ts` `DesktopFacade` interface に method 追加。

**`getMcpTransportSessionId()` deploy scope 明示** (Round 3 P2 Opus #2 反映): 本 S5 trunk skeleton では **`getMcpTransportSessionId() = () => undefined`** の stub impl で deploy。`isSingleSessionPrototype() = () => true` も同 stub 戦略。これにより本 S5 trunk skeleton は **single-LLM-client prototype 環境 (= ローカル dev / single Claude CLI session)** のみで deploy 可能 (= production multi-LLM-client deploy は ADR-011 完了前は禁止)、real multi-LLM-client deploy は **ADR-011 で `getMcpTransportSessionId()` を MCP SDK Server.session 由来に finalize した後に解禁**。本 S5 sub-plan §3.1 S5-1 checklist で stub impl と deploy scope を pin、§8 OQ #3 で carry-over reasoning を永続化。

### 2.6 causal window 境界実装の bit-equal sync (Walking-skeleton §3.4 + §4 S5 + §7 OQ #5 整合)

| 軸 | trunk 採用 | 実装場所 | sub-plan ref |
|---|---|---|---|
| **左端** | `ToolCallStarted` event_id (history buffer entry の `eventIdStarted` field) | `buildCausedBy` 内 `based_on.events[0]` | §2.2 |
| **右端 (a) 次 query frontier** | `viewSnapshot.latestEventId` (= L1 ring 末尾 event_id at query time)、`lastEvent.eventIdCompleted > viewSnapshot.latestEventId` で `undefined` return (Round 2 P1 Codex #2 反映) | `buildCausedBy` 内 frontier check + `based_on.events[1]` 上限 | §2.2 |
| **右端 (b) timeout 200ms** | **monotonic 軸** `nowMonotonic - lastEvent.monotonicStartMs > 200ms` で window expired return undefined (Round 2 P2 Opus #5 反映、wallclock drift 非依存) | `buildCausedBy` 内 timeout check | §2.2 |
| **右端 (c) first stable observation** | (本 trunk 範囲外、OQ #2 carry-over、§1.3) | (未実装) | §1.3 OQ #2 |

trunk 範囲: (a) を default で採用、(b) safety net で実装、(c) は OQ #2 carry-over (§7 R7 fixture 不安定対策)。

### 2.7 既存 LLM client 互換 (compat mode、CLAUDE.md §3.2 PR #102 教訓延長)

S3/S4 で確立した compat mode (server 常に envelope assembly + post-flatten で raw shape return) を **そのまま継承**:

- `desktop_state` 既存 e2e test (raw shape 期待) は **無修正 pass** — `include=causal` 未指定時は default で `caused_by` を envelope に付けない (S4 makeQueryWrapper の include opt-in semantic 維持)
- envelope mode (`include=causal` 明示) のみ `caused_by` 注入、raw shape mode (default) は S4 までの動作維持
- §3.7 S5-7 で既存 e2e test 無修正 pass を pin

---

## 3. 実装 sub-batch (本 PR 内、S5 trunk scope)

### 3.1 S5-1: `_envelope.ts` history buffer 拡張 (~120 line) [S5 trunk]

- [ ] `src/tools/_envelope.ts` 拡張 (S4 既存 module に追加):
  - [ ] `ToolCallEvent` interface (§2.1 schema)
  - [ ] `ToolCallEventRingBuffer` interface (capacity 8 件 default)
  - [ ] `_historyBuffers: Map<string, ToolCallEventRingBuffer>` module-scoped state
  - [ ] `HISTORY_BUFFER_CAPACITY = 8` 定数
  - [ ] `_resetHistoryBuffersForTest()` test seam
  - [ ] `pushHistoryStarted(partial)` 内部 helper (Map に entry 追加 + ring overflow head drop)
  - [ ] `pushHistoryCompleted(partial)` 内部 helper (toolCallId match で entry update)
  - [ ] `defaultL1Emitter` 拡張: `pushStarted` / `pushCompleted` 内に `pushHistory*` 呼出を追加 + **monotonicStartMs = `performance.now()`** 記録 (Round 2 P2 Opus #5 反映)。L1 push 失敗時も history 記録継続、best-effort fail-safe
  - [ ] `L1ToolCallStartedArgs` / `L1ToolCallCompletedArgs` 既存 interface (S4 で確立) は変更なし、`defaultL1Emitter` のみ実装拡張
  - [ ] **LRU eviction (Round 2 P2 Opus #6 反映)**: `_historyBuffers` に `set` 経路で **per-Map eviction** logic 追加 — 上限 `HISTORY_BUFFERS_MAX = 1000` (sessionId 数)、TTL `HISTORY_BUFFER_TTL_MS = 24 * 3600 * 1000` (24h)、上限超過時は LRU eviction (最古 access の sessionId entry を drop)、`_resetHistoryBuffersForTest()` で test 間決定論性
  - [ ] **`isSingleSessionPrototype()` + `getMcpTransportSessionId()` helper (Round 2 P1 Codex #1 反映)**: production wiring 用 stub helper 実装、本 S5 trunk skeleton では `getMcpTransportSessionId() = undefined` + `isSingleSessionPrototype() = true` の minimal impl、ADR-011 で完全 finalize

### 3.2 S5-2: caused_by + produced_changes projection helper (~80 line) [S5 trunk]

- [ ] `src/tools/_envelope.ts`:
  - [ ] `ViewSnapshot` interface (§2.2)
  - [ ] `CausedByShape` interface (§2.2、4 field: your_last_action, tool_call_id, elapsed_ms, produced_changes、Round 3 P1 Opus #1 反映で based_on は envelope トップレベル `BasedOnShape` 分離、ADR-010 §5 example の `session_id` field 後追い同期更新は §6 OQ #6 carry-over)
  - [ ] `BasedOnShape` interface (§2.2、Round 3 P1 Opus #1 反映で envelope トップレベル新設、events は u64 decimal `string[]` で表現 = Round 3 P1 Codex line 370 反映で bigint JSON.stringify TypeError 完全回避、sources は produced_changes 由来動的 build)
  - [ ] `buildCausedBy(sessionId, viewSnapshot, options?): CausedByShape | undefined` 実装 (history buffer 抽出 + causal window check + produced_changes projection)
  - [ ] `buildProducedChanges(viewSnapshot): string[]` 実装 (focus delta + dirty_rect per-monitor count)
  - [ ] `EnvelopeMinimalShape` 拡張: `caused_by?: CausedByShape` + **`based_on?: BasedOnShape`** optional 末尾追加 (Round 3 P1 Opus #1 反映、architecture §8.2 line 355-356 責務マトリクス整合、S3/S4 既存 minimal shape 不変、`stale` confidence + `if_unexpected` field と並列の optional)
  - [ ] `buildEnvelope` 既存関数の signature 拡張: `(data, options?: { causedBy?: CausedByShape, basedOn?: BasedOnShape, ... })` で causedBy + basedOn を envelope に並列 inject (S3/S4 既存 caller 無修正)
  - [ ] **`buildBasedOn(sessionId, viewSnapshot): BasedOnShape | undefined`** 新設 (§2.2、Round 3 P1 Opus #1 反映で envelope トップレベル分離、events を u64 decimal `string[]` で表現 = Round 3 P1 Codex line 370 反映で bigint JSON.stringify TypeError 完全回避)

### 3.3 S5-3: `makeQueryWrapper` 拡張 (`include=causal` opt-in) (~50 line) [S5 trunk]

- [ ] `src/tools/_envelope.ts`:
  - [ ] `QueryWrapperOptions` interface 拡張 (`causedByProjector?` signature を `(args, sessionId) => Promise<{causedBy?, basedOn?} | undefined>` に + `getSessionId?` 末尾 optional 追加、Round 3 P1 Opus + Codex 重複反映で sentinel runtime path closed loop、S4 既存 caller 無修正で pass)
  - [ ] `makeQueryWrapper` internal flow 拡張:
    - [ ] include peek + `includeArgs.includes("causal")` 判定
    - [ ] **getSessionId resolve 呼出** (Round 3 P1 Opus + Codex 重複反映): `const sessionId = options.getSessionId?.(handlerArgs) ?? "default"` を flow 内必ず実行
    - [ ] `causedByProjector(handlerArgs, sessionId)` 呼出で `{causedBy, basedOn}` 並列取得、未設定または非 causal include 時は両者 `undefined`
    - [ ] **`buildEnvelope(handlerResult, { causedBy, basedOn })` 経由で envelope inject** (Round 4 P1 Codex line 625 反映、Round 3 P1 Opus #1 で based_on を envelope トップレベル分離、`buildEnvelope` signature を 2 引数並列に拡張)
  - [ ] S3 既存 `peekAndStripInclude` (S3 で確立) を再利用、include schema 拡張なし (`include=causal` は ADR-010 §5.2 で既定済み、S3 で peek logic は string array で 受領)

### 3.4 S5-4: `desktop_state` wiring + `DesktopFacade` accessor 追加 (~60 line) [S5 trunk]

**Round 3 P2 (Codex #3) fix**: 実際の `desktop_state` module-scope schema/handler/server registration は **`src/tools/desktop-state.ts`** に存在 (PR #112 で確立した shared registration handler pattern、`run_macro` も同 module から `desktopStateRegistrationHandler` を import)。本 sub-batch は `desktop-register.ts` ではなく **`desktop-state.ts`** を編集する。

- [ ] `src/tools/desktop.ts` `DesktopFacade` interface に read-only accessor 追加:
  - [ ] `getLatestFocus(): Promise<{hwnd: bigint | null; elementName: string | null} | null>` (既存 latest_focus view binding 経由)
  - [ ] `getDirtyRectsAggregate(): Promise<Map<number, number>>` (既存 dirty_rects view binding 経由、monitor_index → count)
  - [ ] `getLatestEventId(): Promise<bigint | undefined>` (L1 ring 末尾 event_id、既存 napi binding `l1RingDrain` 等の最終 event を peek するか、新 helper `l1RingPeekLatestEventId` を minimal で追加)
- [ ] `src/tools/desktop-state.ts` (Round 3 P2 Codex #3 fix で訂正、PR #112 同型 shared registration handler pattern 維持):
  - [ ] `desktopStateRegistrationSchema` を `withEnvelopeIncludeSchema(originalDesktopStateSchema)` で生成、module-scope export (S4 で確立した PR #112 pattern)
  - [ ] `desktopStateRegistrationHandler` を `makeQueryWrapper(desktopStateRawHandler, "desktop_state", { getSessionId, causedByProjector })` で wrap、module-scope export (run_macro 経路でも同 instance 共有、PR #112 strip risk 防止)
  - [ ] `causedByProjector` closure 実装 (§2.5)、sentinel guard runtime path closed loop (Round 3 P1 Opus + Codex 重複反映)
  - [ ] `desktopStateRawHandler` の handler internal logic + Zod schema + 戻り値 shape **不変** (ADR-010 §1.5 SSOT)
- [ ] `src/server.ts` (or 等価 MCP server 登録 site): `mcp.tool("desktop_state", desktopStateRegistrationSchema, desktopStateRegistrationHandler)` 経由化 (既に `desktop-state.ts` が module-scope export しているため変更最小)
- [ ] `src/tools/macro.ts`: `TOOL_REGISTRY.desktop_state` を module-scope wrapped instance に切替 (S4 で確立した shared registration pattern、kill-switch gate は wrapper invocation BEFORE で残置)

### 3.5 S5-5: `nativeL1` accessor 拡張 (latest_event_id 経由 if 既存 binding 不足) [S5 trunk、Rust touch 可能性あり]

- [ ] `src/engine/native-engine.ts` の `NativeL1` interface に `l1RingPeekLatestEventId(): bigint | undefined` 追加 (既存 binding にあれば reuse、なければ minimal Rust 追加)
- [ ] **既存 binding 確認**: `index.d.ts` / `src/l1_capture/napi.rs` で latest_event_id readback API が既存か確認、なければ:
  - [ ] `src/l1_capture/napi.rs` に `l1_ring_peek_latest_event_id() -> Option<BigInt>` 新規 napi binding 追加 (既存 ring buffer の back peek、副作用なし、~20 line Rust)
  - [ ] `index.d.ts` 自動生成更新 + `src/engine/native-types.ts` 同期 (CLAUDE.md §3.3 push 6-guard `check:napi-safe` / `check:native-types`)
- [ ] **Round 1 carry-over (Rust touch 不要 path)**: 既存 `l1RingDrain(maxN)` 等で latest event_id を抽出可能なら新 binding 不要、**impl PR で確認**して新 binding 追加判断 (sub-plan §6 follow-up に carry-over)

### 3.6 S5-6: contract test (~150 line) [S5 trunk]

- [ ] `tests/unit/desktop-state-causal-include.test.ts` 新設 (caused_by linkage を 1 file で網羅):
  - [ ] **G5-S5-1**: 基本 path — `desktop_act` (commit) → history buffer entry 記録 → `desktop_state(include=["causal"])` で envelope **caused_by 4 field** 全部埋まる (`your_last_action`, `tool_call_id`, `elapsed_ms`, `produced_changes`) **+ envelope トップレベル `based_on` 並列 inject** (`events: string[]`, `sources: string[]`)、Round 3 P1 Opus #1 反映で based_on は envelope トップレベル分離 (architecture §8.2 責務マトリクス整合)、Round 4 P2 Codex 反映で acceptance contract を update
  - [ ] **G5-S5-2**: produced_changes projection — focus 遷移 (A→B) + dirty_rects[monitor=0]: 3 + dirty_rects[monitor=1]: 1 が `produced_changes` 配列に正しく含まれる、`monitor_index` field 維持 (CLAUDE.md §3.2 PR #102 同型 regression 防止)
  - [ ] **G5-S5-3**: multi-event causal window — 連続 2 commit (`desktop_act` → `desktop_act` → `desktop_state`) で history buffer に 2 entry、caused_by は **最新 1 entry のみ** projection (`your_last_action` = 2 件目の commit)
  - [ ] **G5-S5-4**: lease commit path — `desktop_act` (lease 経由) で history entry に `leaseToken` 記録、`your_last_action` に `desktop_act(...)` summary、`tool_call_id` 形式 `${sessionId}:${seq}`
  - [ ] **G5-S5-5**: elapsed_ms 計算 — handler artificial sleep 50ms → caused_by.elapsed_ms ≈ 50 (許容 ±5ms)
  - [ ] **G5-S5-6**: causal window timeout — commit 後 250ms wait (default 200ms 超え) → 後続 `desktop_state(include=causal)` で `caused_by` undefined (window expired、§2.2 (b) safety net)
  - [ ] **G5-S5-7**: include 未指定時 → envelope に `caused_by` field なし (default opt-out、ADR-010 §5.5 P3 align、既存 raw client 互換)
  - [ ] **G5-S5-8**: history buffer ring overflow — 9 件 commit で最古 1 件 head drop、最新 8 件保持 (HISTORY_BUFFER_CAPACITY 8 件 pin)
  - [ ] **G5-S5-9**: failure commit (handler throw) → history entry `ok: false`、後続 `caused_by.your_last_action` に failure 事実が表示 (LLM 不安解消最優先、§2.2 設計判断)
  - [ ] **G5-S5-10**: history buffer reset (multi-session) — sessionA に 2 entry, sessionB に 1 entry → sessionA query で sessionA 最新のみ projection、sessionB query で sessionB 最新のみ
- [ ] **10/10** test pass (G5-S5-1〜G5-S5-10)

### 3.7 S5-7: 検証 (cargo + npm + e2e + bench) [S5 trunk]

- [ ] `cargo check --workspace --locked`: clean (S5-5 で Rust touch 発生時のみ、native-only path なら skip)
- [ ] `npm run check:rs-workspace`: clean
- [ ] `npm test` (vitest unit): **2537 (= 2527 S4 後 + 10 S5)** pass / 25 skipped (regression 0、本 PR で +10 test)
- [ ] `npm run bench:envelope-size`: causal include 3 シナリオ追加 (`causal_minimal` < 1.5KB / `causal_typical` < 2KB / `causal_max` < 2KB)、5%/20% 増 warning/fail enforce — G5 #3 ADR-010 §5.6.1 整合
- [ ] `npm run check:napi-safe` / `check:native-types` (S5-5 で Rust touch 発生時、新 binding `l1RingPeekLatestEventId` 追加 → top-level export +1) / `check:stub-catalog` (envelope shape 拡張のみで stub catalog 影響なし、確認のみ) / `npm run build` / `npm run lint`: 全 pass
- [ ] `npm run test:e2e` (or 等価 e2e suite): `desktop_state` / `desktop_act` 既存 e2e test 無修正 pass (compat mode default で raw shape 維持、`include=causal` opt-in は新規 path のみ)、`include=causal` 経由 e2e は **CI で確認** (Win11 dogfood 専用、本 PR の 6-guard + unit suite で structural compat は pin 済)

### 3.8 S5-8: G5 ゲート判定 + Appendix C append (~5 line、impl PR merge 後) [S5 trunk]

- [ ] **本 PR で同梱 (S4 sub-plan PR #111 同型 pattern)**: `docs/walking-skeleton-trunk-selection.md` Appendix C 末尾に判定結果 append (本 sub-plan §3.8 完了基準を merge 前に踏む形で先行 commit、Opus PR #111 Round 1 P2 #4 反映 pattern 継承):
  ```markdown
  | G5 | 2026-05-XX | 継続 | per-session history buffer (TS Map<sessionId, ring 8 件 cap>) + causal window 境界 (左端 ToolCallStarted event_id / 右端 (a) latest event frontier + (b) timeout 200ms) + buildCausedBy projection (5 field) + buildProducedChanges (focus delta + dirty_rect per-monitor count) で desktop_act → desktop_state(include=causal) シーケンス integration test 10/10 pass、envelope size 1.X KB (causal_typical) で < 2KB SLO 維持 (S3 bench harness で計測)、既存 raw client 互換 default opt-out で破壊なし。S6 trunk 完了判定 (expansion tool 1 件追加が L5 wrapper 修正のみ + CI assert 化) に進める contract base 確立 | (なし) |
  ```
- [ ] 判定が「shrink」の場合は S6 (trunk 完了判定) scope を次 sub-plan §1.1 から削る判断を本 sub-plan §6 follow-up に記録 (本 PR は **継続** 判定想定、checkbox 残置で意図を pin)

### 3.9 S5-9: CI workflow 拡張 + Push 6-guard + Opus + Codex review [S5 trunk]

- [ ] `benches/l4_envelope_size.mjs` を update: causal include 3 シナリオ追加 (causal_minimal / causal_typical / causal_max)、2048-byte SLO check 含む (S4 で確立した failure シナリオと並列)
- [ ] **Opus phase-boundary review Round 1** (CLAUDE.md §3.3 Step 1): 10 要素プロンプト遵守、最重要 contract のため **3+ round 想定**、§3.1 + §3.2 sweep 必須 + Lesson 1-4 sweep 明示
- [ ] **Codex re-review Round 1** (CLAUDE.md §3.3 Step 2): cross-layer linkage 軸の API contract regression 防止、`monitor_index` 維持 / 既存 raw client 互換 / history buffer Map leak risk (S5 で本格運用化、S4 OQ #1 carry-over の resolve timing) を Codex 強み軸でレビュー
- [ ] **Opus phase-boundary review Round 2 / 3**: Round 1 fix 反映後 + Codex P1/P2 fix 込みで再判定、**最重要 contract のため指摘ゼロまで反復必須** (walking-skeleton §4.1 line 306 「3+ round 最重要」整合)
- [ ] **User reviewer 補正 window** (CLAUDE.md §3.3 Step 4): Opus + Codex 指摘ゼロ後、User による Lesson 1-4 同型盲点最終チェックを待つ。PR #99/#102/#103/#104/#107/#108/#109/#110/#111/#113 で 10 連続再発した補正 pattern であり、Opus + Codex 単独では届かない盲点 (causal window 設計 / 順序矛盾 / numeric count sync 等) の最後の防御層

---

## 4. 対 Opus 単独判断盲点 sweep (Lesson 1-4 防御、PR #99/#102/#103/#104/#105/#107/#108/#109/#110/#111/#113 で 10 連続再発 pattern)

memory `project_adr008_d2_c_plan_done.md` Lesson 1-4 + `feedback_autonomous_phase_transition.md` で蓄積済 User reviewer による Opus 単独 sweep 補正 pattern を本 sub-plan で防御化:

### 4.1 Lesson 1: causal window 設計 (PR #103 同型 risk = 「ToolCallCompleted で window 閉じる」設計バグ)

- [ ] **causal window 右端の bit-equal sync**: walking-skeleton §3.4 (line 161-167) + §4 S5 line 263-269 + §7 OQ #5 (line 404) + 本 sub-plan §1.1 B + §2.2 + §2.6 の **5 SSOT** で「右端 = (a) 次 query frontier / (b) timeout 200ms / (c) first stable observation のいずれか先」が一字一句揃っているか? `Grep "ToolCallCompleted で閉じる\|右端 = ToolCallCompleted\|window 閉じる時点"` で **PR #103 で覆した v0.3 設計の残骸が混入していない**ことを確認
- [ ] **`buildCausedBy` 内 timeout 判定が wallclock_ms 軸で動作することを runtime 確認** (compile-time 通過だけで安心しない、§4.2)
- [ ] **commit 後 async event 取り逃がし回避**: G5-S5-2 (produced_changes に focus 遷移 + dirty_rects 含まれる) integration test で causal window 内に **commit return 後 50ms 程度 wait** を含み、async UIA Focus event / DXGI DirtyRect event が capture されることを runtime 実証

### 4.2 Lesson 2: compile-time guard 過信判定 (PR #105 同型 risk = 「Arranged 型 closure 外持出 = compile error」だけで安心しない)

- [ ] `cargo check` clean だけで `l1_ring_peek_latest_event_id` 新 binding が **既存 L1 ring buffer state を mutate しない** (副作用なし、read-only peek) ことは保証されない、unit test で side-effect-free pin 必須
- [ ] `npm run build` (tsc) clean だけで `buildCausedBy` の history buffer 抽出 + causal window check + projection の 3 step flow が runtime で正しく動作することは保証されない、unit test G5-S5-1〜G5-S5-10 で各 path を runtime 確認必須
- [ ] **`Map<string, RingBuffer>` の memory leak risk**: 長時間動作中に sessionId 数増加で entry 蓄積、S4 OQ #1 で carry-over 済 (S5 で LRU eviction 1k entry / TTL 24h で resolve、本 sub-plan §8 OQ #1 で再 confirm)。tsc clean では leak 検出不可、unit test に多 sessionId 注入シナリオ追加 (`G5-S5-10` multi-session)

### 4.3 Lesson 3: 両 doc 順序矛盾 (S4 → S5 → S6 直列前提 keyword sweep)

- [ ] `docs/walking-skeleton-trunk-selection.md` §4 S5 line 254-279 + §4.1 line 306 直列前提 / 親 plan ADR-010 §5.5 P3 phase / S4 sub-plan §1.3 OQ #2 carry-over (= 本 S5 で finalize) / 本 sub-plan §0 (line 17-25) の 4 SSOT で **S4 → S5 → S6 着手順序が一致**しているか?
- [ ] `Grep "S4 → S5|S5 (caused_by|S5 で finalize|本 S5 で確立|S5 trunk|S5 expansion"` で 4 SSOT の表記揺れがないか?
- [ ] **S5 sub-plan PR (本 PR) は S4 impl PR #113 merged 後** の直列順序、本 sub-plan §0 line 6 で明示済、`Grep "S4 (PR #113|PR #113 merged|S4 で確立|S4 既存"` で 5+ 箇所同期確認

### 4.4 Lesson 4: restore 後 numeric count sync 漏れ (carry-over → restore で件数表記更新)

- [ ] §3 sub-batch 数 (S5-1〜S5-9 = **9 件**)、§7 Risks 数 (Round 3 で R11/R12 追加で **12 件**、R1-R12)、§8 OQ 件数 (Round 2 で OQ #4/#5 追加で **5 件**、Round 3 で件数変動なし)、size 想定 (~300-500 line / 3-5 日 = walking-skeleton §4.1 line 306 整合) が本 sub-plan 内で bit-equal か?
- [ ] `Grep "300-500 line\|3-5 日\|9 件 sub-batch\|5 件 OQ\|12 件 Risks\|R1-R12\|G5-S5-1.*G5-S5-10\|10/10 test\|2537 test"` で本 sub-plan 内 numeric counts が bit-equal か?
- [ ] **Round 2 P2 (Opus/Codex 重複) fix sweep**: `Grep "Number(bigint|Number(lastEvent.eventId|Number(.*EventId"` で `Number()` 変換が残っていないか確認、precision loss 防止
- [ ] **Round 3 P1 (Codex line 370) fix sweep**: `Grep ": bigint\\[\\]|bigint\\[\\]"` で envelope shape (CausedByShape / BasedOnShape / EnvelopeMinimalShape) に bigint type が残っていないか確認、JSON.stringify TypeError 防止 (events は string[] = u64 decimal、内部 bigint 処理は OK)
- [ ] **Round 3 P1 (Opus #1) fix sweep**: `Grep "based_on" + "CausedByShape"` で CausedByShape 内に based_on field が残っていないか確認、envelope トップレベル `BasedOnShape` 分離が完了しているか
- [ ] **Round 3 P1 (Opus + Codex 重複) sentinel runtime path sweep**: `Grep "causedByProjector|sessionId.*projector|getSessionId\\?\\.\\("` で makeQueryWrapper flow が getSessionId resolve 呼出 + projector signature `(args, sessionId)` の closed loop 化を確認
- [ ] **Round 3 P2 (Codex #3) file path fix sweep**: `Grep "desktop-register.ts.*desktop_state|desktop_state.*desktop-register"` で `desktop_state` wiring の file path が誤った `desktop-register.ts` 参照に戻っていないか確認、`desktop-state.ts` (実際の registration site) に統一されているか
- [ ] **Round 4 P2 (Opus #1〜#6 + Codex 重複) caused_by 5 field 古表記 sweep**: `Grep "caused_by 5 field|5 field 全部|5 field、|5 field SSOT"` で Round 3 で 4 field に縮小した CausedByShape の古表記が残っていないか確認、Appendix A history record 内 (Round 1/2 当時の事実記述) は OK で persistent 表記のみ check
- [ ] **Round 4 P1 (Codex line 625) buildEnvelope signature sweep**: `Grep "buildEnvelope.*\\{ causedBy \\}|buildEnvelope.*\\{causedBy\\}"` で `{causedBy}` 単独 signature が残っていないか確認、`{causedBy, basedOn}` 並列 inject に統一されているか
- [ ] **test 数の S4 → S5 sync**: S4 で 2527 (= 2520 + 7) → S5 で 2537 (= 2527 + 10) — `npm test` actual count を impl PR で確認、誤りなら numeric を update

### 4.5 既存 public API 破壊禁止 (CLAUDE.md §3.2 PR #102 教訓延長)

- [ ] **既存 `desktop_state` handler internal logic + Zod schema + 戻り値 shape 不変** (§1.1 D + §2.5)、ADR-010 §1.5 SSOT 整合
- [ ] **`include=causal` は default opt-out** — `include` 未指定時は envelope に `caused_by` field 不在 (S4 まで挙動維持)、既存 raw client (`include` 知らない LLM client) 破壊なし、§3.6 G5-S5-7 で pin
- [ ] **`makeQueryWrapper` 既存 caller (S4 で wrap した `desktop_discover` + 本 S5 で wrap する `desktop_state`)** が `causedByProjector` / `getSessionId` 末尾 optional 追加で **無修正 pass** か、`grep -rn "makeQueryWrapper" src/ tests/` で全 caller 確認
- [ ] **`buildEnvelope` signature 拡張 (`{ causedBy? }` 末尾 optional 追加)** が S3/S4 既存 caller 無修正 pass か、`grep -rn "buildEnvelope" src/ tests/` で全 caller 確認
- [ ] **`monitor_index` field 維持** — `produced_changes` の dirty_rect entry で `"dirty_rects[monitor=0]: 3"` 形式、PR #102 同型 regression 防止
- [ ] **L1 既存 binding `l1PushToolCallStarted/Completed` signature 不変** (S4 で 5th optional 追加済、本 S5 で更なる引数追加なし)、新 binding `l1RingPeekLatestEventId` 追加は新 export のみで既存 binding 破壊なし

---

## 5. PR 切り方

| sub-batch | 範囲 | size 想定 |
|---|---|---|
| **S5 (本 PR、merged sub-batch)** | 3.1 history buffer + 3.2 caused_by/produced_changes projection + 3.3 makeQueryWrapper 拡張 + 3.4 desktop_state wiring + 3.5 nativeL1 accessor + 3.6 contract test 10 件 + 3.7 検証 + 3.8 G5 gate + 3.9 CI + Opus + Codex review | **300-500 line** (walking-skeleton §4.1 line 306 工数 3-5 日 / Codex ✓ 必須軸 = cross-layer linkage + API contract regression 防止、TS ~250-400 line + Rust ~50-100 line if 新 binding 必要、Rust 不要なら TS only) |

**1 PR で land**、sub-batch 分割しない (history buffer + causal window + caused_by projection + desktop_state wiring が 1 つの contract spike として完結)。**Opus 3+ round 想定** (walking-skeleton §4.1 line 306 「3+ round 最重要」) + **Codex re-review 必須 1 round** (CLAUDE.md §3.2 cross-layer linkage 軸の API contract regression 防止)。

`docs/walking-skeleton-trunk-selection.md` §4.1 の S5 概算 **3-5 日 / Opus 3+ round (最重要) / Codex ✓** に整合 (line 306)。

---

## 6. follow-up (carry-over、§3.bis ledger / OQ で永続化)

trunk + expansion 完了後の別 phase で carry-over:

- **expansion**: 残 ~24 commit tool wrapper 化 (mouse_click / keyboard / clipboard / scroll / focus_window / browser_click / 等) — `makeCommitWrapper` mechanical コピーで全 commit tool に S5 caused_by linkage が **自動波及** (= trunk completeness 判定の根拠、S6 で CI assert 化)
- **expansion**: 残 ~10 query tool wrapper 化 (screenshot / browser_overview / browser_locate 等) — `makeQueryWrapper` mechanical コピーで `include=causal` opt-in が全 query tool で動作
- **expansion**: causal window 右端 (c) first stable observation 配線 (focus 50ms 同 element / dirty rect 50ms 0 件) — fixture 不安定対策、S5 OQ #2 carry-over
- **expansion**: `caused_by.based_on.events` に observation event (UiaFocusChanged / DirtyRect / WindowChanged) も含める拡張
- **expansion**: `include=working:N` / `episodic:N` (P6) — 直近 N event compact / 直近 N tool call history、本 S5 は include=causal 単独
- **expansion**: `include=invariants` (P3 後半) — invariants_held projection (window_title_stable / no_concurrent_focus_change / lease_digest_matched 等)
- **expansion**: `include=time_travel` (P4 default-on) — query_past link、ADR-008 D3 完了後
- **OQ #1 (S5 trunk → S5 mid-life)**: `_historyBuffers` Map LRU eviction (1k entry / TTL 24h)、本 S5 trunk skeleton で leak 顕在化前に impl (`G5-S5-10` multi-session test で leak path 確認、production wiring で 1k 上限 enforce)
- **OQ #2 (S5 expansion)**: causal window 右端 (c) first stable observation logic
- **OQ #3 (ADR-011)**: multi-session session_id source — MCP transport context 由来 (request session header / connection-id 等)
- **OQ #4 (S5 expansion)**: `produced_changes` の focus delta 完全 before/after (`"focus: A→B"` 形式) — per-session view snapshot history が必要、history buffer の view-side counterpart 拡張
- **OQ #5 (S5 follow-up impl PR)**: `nativeL1.l1RingPeekLatestEventId` 新 binding 追加 vs 既存 `l1RingDrain` reuse 判断 (§3.5 S5-5)
- **OQ #6 (S5 follow-up + ADR-010 後追い更新)** (Round 2 P1 Opus #2 + Round 3 P1 Opus #1 反映、Round 4 P2 で wording 整合 update): ADR-010 §5 envelope schema example (line 200-206) の `caused_by` field 集合 (`your_last_action, session_id, elapsed_ms, produced_changes` の 4 field example) が **本 sub-plan §2.2 (4 field CausedByShape: `your_last_action, tool_call_id, elapsed_ms, produced_changes`) + envelope トップレベル `BasedOnShape` (`events: string[], sources: string[]`、Round 3 で分離) と divergence** (`session_id` vs `tool_call_id` 差異)。本 sub-plan は architecture §6 worked example + §8.2 責務マトリクス (L1 start / L2 end の based_on トップレベル責務) を SSOT に採用、ADR-010 §5 example を後追い同期更新する PR を S5 impl PR と並走または S6 完了時に出す
- **OQ #7 (S5 follow-up)** (Round 2 P2 Opus #1 反映): `_post.ts::recordHistory` (HISTORY_MAX=20 global ring、`src/tools/_post.ts:58-63`) と新 `_historyBuffers` Map<sessionId, ring> の **role 重複**。本 S5 trunk では「両者共存、`_post.ts::recordHistory` は touch なし、新 `_historyBuffers` は ToolCallStarted/Completed のみ tracking」を採用、両者の責務境界を impl PR で明示し既存 `getHistorySnapshot` 経路を破壊しない。完全統合または常駐 ring 統一は ADR-011 work

---

## 7. Risks / Mitigation

| # | Risk | 影響 | Mitigation |
|---|---|---|---|
| R1 | `_historyBuffers` Map memory leak (sessionId 数増加で entry 蓄積、S4 OQ #1 carry-over) が S5 で本格運用化、long-running server で leak | 中 | §6 follow-up OQ #1 で LRU eviction (1k entry / TTL 24h) を本 S5 trunk skeleton で impl、`G5-S5-10` multi-session test で path 確認、production wiring で 1k 上限 enforce |
| R2 | `defaultL1Emitter` の history push 二重記録で L1 push と history buffer の sync ズレ (race condition、L1 push 失敗時の partial state) | 低 | history buffer は best-effort fail-safe (L1 失敗時も entry 記録継続)、`G5-S5-9` failure commit test で `eventIdStarted: undefined` でも `caused_by` 抽出可能を pin、`based_on.events` から該当 event_id が落ちる近似で十分 |
| R3 | `buildCausedBy` の causal window check で wallclock_ms drift (system clock 修正 / NTP sync で時刻飛び) が timeout 200ms 判定を誤らせる | 低 | **Round 2 P2 Opus #5 反映で resolve**: causal window timeout は **monotonic 軸 (`performance.now()` 由来 `monotonicStartMs`) で計算**、wallclock_ms (`Date.now()`) は表示用 elapsed_ms にのみ使用 — system clock drift / NTP sync で false-positive expire 発生せず、§2.1 ToolCallEvent.monotonicStartMs field 追加 + §2.2 buildCausedBy の timeout check が monotonic 軸で動作、`G5-S5-6` test で 250ms wait → caused_by undefined を pin |
| R4 | `produced_changes` の focus delta が **before 不在の近似実装** で LLM が誤読 (`"focus: → B"` を `"focus 不変"` と誤解) | 中 | sub-plan §2.3 で「近似実装」明示 + §6 OQ #4 で完全 before/after carry-over、ADR-010 LLM 不安解消観点で focus 「現状」表記が `"focus 不変"` よりも明示的、production e2e で LLM 動作確認 (本 trunk skeleton では十分) |
| R5 | `produced_changes` の dirty_rect monitor_index 落ち (PR #102 同型 regression) で secondary monitor の dirty が `"dirty_rects[monitor=0]"` と誤ラベル | 中 | §1.4 + §2.3 + §4.5 で `monitor_index` 維持を 3 重 pin、`G5-S5-2` integration test で multi-monitor (monitor_index 0 + 1) シナリオ pin、CLAUDE.md §3.2 PR #102 教訓延長で Codex review API contract 軸で確認 |
| R6 | `makeQueryWrapper` の include peek + causedByProjector 呼出順序 race (handler invocation 中に L1 ring 進行 → frontier 不一致) | 低 | `viewSnapshot.queryWallclockMs = Date.now()` を **handler return 後** に取得、handler invoke 中の frontier 進行は次 query で capture される設計、`based_on.events` 終端は frontier 進行で bounded に増加 (Vec push only) |
| R7 | `desktop_act` → `desktop_state` 間に async UIA Focus event / DXGI DirtyRect event が **遅れて到着** し、causal window 200ms timeout 内に capture されない | 中 | walking-skeleton §3.4 + §4 S5 line 263-269 + 本 sub-plan §1.1 B-3 で causal window 右端 (b) timeout 200ms 既定、production drift は OQ #2 first stable observation (c) で expansion 対応、本 trunk fixture (lease 発行対象 + 確実な focus A→B + primary monitor dirty) で 200ms 内 capture 保証 |
| R8 | `buildCausedBy` の history buffer 抽出が **直前 1 件のみ** projection で、複数 commit chain (`desktop_act` → `desktop_act` → `desktop_state`) の中間 commit が caused_by から落ちる | 低 | `caused_by` は ADR-010 §5 「直前 1 件」semantic と整合、複数 entry chain 表現は P6 (`include=working:N`/`episodic:N`) で expansion、`G5-S5-3` で multi-event 動作 (最新 1 件のみ projection) を pin、LLM 不安解消観点で 1 件 projection が context window 経済性に寄与 |
| R9 | (Round 2 P2 Opus/Codex 重複 line 311 反映) `Number(bigint)` 変換で event_id が 2^53 (9PB events) 超過時 precision loss、long-running server で `based_on.events` の event_id 識別が破綻 | 低 | **Round 2 で initial resolve、Round 3 R11 で superseded**: Round 2 では `bigint[]` 型維持で TS native bigint serialize 経路を採用したが、Round 3 R11 で `JSON.stringify({events:[1n]})` TypeError 実証 (Codex 2026-05-01) のため **R11 で envelope shape の `events` を `string[]` (u64 decimal)** に変更採用、内部 bigint・wire string で precision loss 0 + JSON-safe 兼備。`Number()` 変換禁止 sweep は §4.4 で継続、bigint envelope shape leak sweep は §4.4 line 723 で追加 |
| R10 | (Round 2 P1 Codex #1 反映) concurrent MCP session で `getSessionId() = "default"` hardcode により単一 history buffer 共有 → cross-session caused_by leak、別 LLM client の commit が誤って attributed | 中 | **Round 2 で導入 + Round 3 で runtime path closed loop 化**: §1.1 E-2 で sentinel guard (`"multi:disabled"`) + warn log impl、`isSingleSessionPrototype()` + `getMcpTransportSessionId()` helper を §3.1 S5-1 sub-batch に追加。**Round 3 P1 (Opus + Codex 重複) で `makeQueryWrapper` flow に `getSessionId` resolve 呼出追加 + projector signature を `(args, sessionId)` に拡張 + production wiring で sessionId 再ハードコード除去** で sentinel runtime path を closed loop で機能させる、完全 finalize は ADR-011 (OQ #3) carry-over |
| R11 | (Round 3 P1 Codex line 370 反映、`node -e "JSON.stringify({events:[1n]})"` で TypeError 実証) `CausedByShape.based_on.events: bigint[]` を採用すると MCP transport JSON.stringify で `TypeError: Do not know how to serialize a BigInt` が確実に発生、`include=causal` 全 path で envelope return が runtime crash | 高 | **Round 3 で resolve**: §2.2 で `BasedOnShape.events` を **`string[]` (u64 decimal string)** に変更採用、内部処理 bigint・envelope serialize 時 `String(eventId)` 変換、precision loss 0 + JSON-safe + LLM client 互換性 (Claude CLI bigint 直接扱えず) を兼備。§4.5 push 6-guard に `Grep "bigint\\[\\]|: bigint\\["` で envelope shape に bigint type が残っていないか確認を追加 |
| R12 | (Round 3 P2 Codex #3 反映) `desktop_state` wiring file path を `src/tools/desktop-register.ts` と誤認した場合、impl PR で間違った場所に新 wrapper 登録され、実 `desktop_state` 経路 (`desktop-state.ts` module-scope export + `run_macro` import) が無修正のまま、新 wrap は dead code に | 中 | **Round 3 で resolve**: §2.5 + §3.4 + §10 References を `src/tools/desktop-state.ts` に訂正、`run_macro` 経路の shared registration handler instance を維持 (PR #112 で確立した strip risk pattern 整合)、impl PR Round 1 で grep `Grep "desktop_state.*tool\\(\\|TOOL_REGISTRY\\.desktop_state"` で実際の登録 site を再確認 |

---

## 8. Open Questions (S5 trunk-relevant、5 件、Round 2 で OQ #4/#5 追加)

| # | OQ | 決定タイミング | 推奨 (Opus 判断委譲) |
|---|---|---|---|
| 1 | `_historyBuffers` Map LRU eviction schema (1k entry 上限 / TTL 24h など) — 本 S5 trunk で impl するか、S5 後半 (= mid-life)/expansion carry-over か。S4 sub-plan OQ #1 で carry-over 済、S5 で本格運用化したため leak risk が顕在化 | 本 S5 impl PR Round 1 で finalize | **本 S5 trunk で impl 確定** (Round 2 P2 Opus #6 反映、§3.1 S5-1 sub-batch checklist に追加済、§7 R1 mitigation、`G5-S5-10` test で leak path 確認、1k entry / TTL 24h / 上限超過時 LRU eviction)、Rust ring buffer / SQLite persist は ADR-011 carry-over |
| 2 | causal window 右端 (c) first stable observation 配線 — focus 50ms 同 element / dirty rect 50ms 0 件 stable detect logic を本 S5 trunk で impl するか expansion carry-over か (walking-skeleton §3.4 / §4 S5 line 266 / 本 sub-plan §1.1 B-4) | S5 expansion phase で finalize | **expansion carry-over 推奨** (§7 R7 fixture 不安定対策、本 trunk 範囲では (a) + (b) で十分、stable detect は L4 envelope 組立て側の追加 logic で expansion で配線)、本 sub-plan §6 OQ #2 で carry-over |
| 3 | multi-session session_id source — MCP transport context 由来 (request session header / connection-id 等) を S5 で完全 finalize するか ADR-011 carry-over か。本 S5 trunk では sentinel guard (`"multi:disabled"`) + warn log で multi-session 環境でも cross-session leak が起きない安全側 impl (Round 2 P1 Codex #1 反映) | ADR-011 (Cognitive Memory Taxonomy) で完全 finalize | **本 S5 で sentinel guard 採用 + ADR-011 で完全 finalize** (§1.1 E-2 + §1.3 carry-over、本 S5 は single-LLM-client prototype + multi-session detect 時 caused_by skip で十分、完全な per-session caused_by projection は ADR-011 で session 跨ぎ episodic memory と統合検討) |
| 4 | (Round 2 P1 Opus #2 反映 + Round 3 P1 Opus #1 で SSOT 採用判断を再 revise) caused_by + based_on の envelope shape の SSOT 整合 — Round 3 で **`based_on` を envelope トップレベル field として分離** (architecture §8.2 line 355-356 責務マトリクス整合)、`CausedByShape` は 4 field (`your_last_action, tool_call_id, elapsed_ms, produced_changes`)。ADR-010 §5 example は `session_id` を含む 4 field example で本 sub-plan の 4 field と微妙に異なる (`session_id` vs `tool_call_id`)、後追い同期更新 PR が必要 | S5 impl PR と並走または S6 完了時 | **S6 で ADR-010 §5 example update PR 起草** (本 sub-plan §2.2 4 field CausedByShape + envelope トップレベル `BasedOnShape` を ADR-010 §5 line 200-213 example に反映、`session_id` field 採用検討は L4 envelope semantic 整合、CLAUDE.md §3.1 fact 整合 sweep、PR #99 D2-C0 同型 fact divergence 防止) |
| 5 | (Round 2 P2 Opus #1 反映) `_post.ts::recordHistory` (HISTORY_MAX=20 global ring) と新 `_historyBuffers` Map<sessionId, ring> の **role 重複 / 統合判断** — 両者共存 vs 統合 | S5 impl PR Round 1 で finalize | **両者共存採用** (本 S5 trunk skeleton では `_post.ts::recordHistory` は touch なし、新 `_historyBuffers` は ToolCallStarted/Completed のみ tracking、impl PR で責務境界 docstring 化、`getHistorySnapshot` 既存経路を破壊しない)、完全統合または常駐 ring 統一は ADR-011 work |

---

## 9. walking skeleton + ADR-010 P1 全体図 (本 PR の位置づけ)

```
Walking skeleton trunk:
┌──────────────────────────────────────────────────────────────────────┐
│  S1 (PR-η D2-E0):  dataflow scope refactor                ✅ merged  │
│      ↓                                                                │
│  S2 (PR-ε D2-C):   count-only dirty_rects_aggregate       ✅ merged  │
│      ↓                                                                │
│  S3 (PR #110):     envelope minimal wrapper + compat mode  ✅ merged │
│      ↓                                                                │
│  S4 (PR #113):     commit/query 軸 wrapper +              ✅ merged │
│                    lease 4-tuple validation +                          │
│                    ToolCallStarted/Completed payload schema 確定       │
│      ↓                                                                │
│  S5 (★ 本 PR、最重要 contract): caused_by linkage cross-layer         │
│       (desktop_act → desktop_state)                                    │
│      ↓                                                                │
│  S6: trunk 完了判定 + CI assert + expansion plan 起草                 │
└──────────────────────────────────────────────────────────────────────┘

S5 内部の history buffer + causal window + caused_by projection 図 (本 PR の改修範囲):

[S4 merged shape (commit wrapper + L1 ToolCallStarted/Completed payload)]
                  ↓
[S5 PR-? land 後] history buffer + causal window + caused_by projection:

desktop_act (commit、S4 既存):
  makeCommitWrapper(handler, "desktop_act", { leaseValidator, argsSummary, getSessionId })
                                                 │
                                                 ▼
  defaultL1Emitter.pushStarted (S4 既存) +
  S5 NEW: pushHistoryStarted(sessionId, ToolCallEvent)   ← in-memory ring 8 件 cap
       │
       ├─ history Map<sessionId, RingBuffer> に entry push
       │
  → handler invoke (副作用) →
       │
  defaultL1Emitter.pushCompleted (S4 既存) +
  S5 NEW: pushHistoryCompleted(toolCallId, eventIdCompleted, wallclockEndMs, ok)
       │
       └─ history entry を完了 marker で update


desktop_state (query、S4 で wrap 済 / S5 で causedByProjector inject):
  makeQueryWrapper(handler, "desktop_state", { causedByProjector, getSessionId: () => "default" })
                                                 │
                                                 ▼
  S3 既存: include peek + handler invoke
       │
  S5 NEW: include=causal 受領時 →
       │
       ├─ defaultCausedByProjector(args):
       │     │
       │     ├─ ViewSnapshot build:
       │     │     - focus = facade.getLatestFocus()         (L3 latest_focus view)
       │     │     - dirtyRectsByMonitor = facade.getDirtyRectsAggregate()  (L3 dirty_rects view、monitor_index 維持)
       │     │     - latestEventId = facade.getLatestEventId()              (L1 ring 末尾、causal window 右端 (a))
       │     │     - queryWallclockMs = Date.now()
       │     │
       │     ├─ Round 3 P1 (Opus + Codex 重複) sentinel guard runtime path:
       │     │     if (sessionId === "multi:disabled") return undefined;  // multi-session leak 完全回避
       │     │
       │     ├─ buildCausedBy(sessionId, snapshot) [4 field、Round 3 P1 Opus #1 で based_on 分離]:
       │     │     - history buffer から最新 entry 抽出 (直前 1 件のみ)
       │     │     - causal window check 右端 (a) latestEventId frontier (Round 2 Codex #2)
       │     │     - causal window check 右端 (b) monotonic timeout 200ms (Round 2 Opus #5)
       │     │     - produced_changes projection (buildProducedChanges):
       │     │          * focus delta: "focus: → B" 形式 (本 trunk: before 近似)
       │     │          * dirty_rects[monitor=0]: count 等 (count > 0 monitor のみ entry、monitor_index 維持)
       │     │     - 4 field 構築:
       │     │          * your_last_action = "desktop_act(args_summary)"
       │     │          * tool_call_id = `${sessionId}:${seq}` (S4 既存)
       │     │          * elapsed_ms = wallclockEndMs - wallclockStartMs
       │     │          * produced_changes = [...]
       │     │
       │     └─ buildBasedOn(sessionId, snapshot) [envelope トップレベル、Round 3 P1 Opus #1 で分離]:
       │           - events: string[] (u64 decimal、Round 3 P1 Codex line 370 で bigint TypeError 回避)
       │                * [String(eventIdStarted), String(eventIdCompleted)]
       │           - sources: string[] (Round 2 Opus #3 で動的 build)
       │                * UIA 含む = focus 由来 / DXGI 含む = dirty_rect 由来
       │
       ├─ buildEnvelope(handlerResult, { causedBy, basedOn }) [Round 3 P1 Opus #1 で 2 引数並列]:
       │     - envelope.data = handlerResult (S3 既存)
       │     - envelope.as_of = ... (S3 既存)
       │     - envelope.confidence = "fresh"|"degraded"|"stale" (S3 + S4)
       │     - envelope.caused_by = causedBy (S5 NEW、optional 末尾、4 field)
       │     - envelope.based_on = basedOn (Round 3 NEW、トップレベル、architecture §8.2 整合、events string[])
       │
       ▼
  compatHoist (S3 既存、post-flatten compat mode、include=causal 未指定時は raw shape 維持)
       │
       └─ envelope or raw shape return (既存 client 互換)


L1 ring 内 ToolCall event 番号 (S4 で確立、S5 で history buffer に二重記録):
  ToolCallStarted (=100) + ToolCallCompleted (=101) — 不変
  payload = { tool, args_json, lease_token? }                  (S4 で確定、S5 で変更なし)


S6 trunk 完了判定 (= expansion tool 1 件追加が L5 wrapper 修正のみで完了):
  - expansion-pr-guard.yml (CI assert): PR title/label expansion で
    crates/engine-perception 改変 0 行を機械的に enforce
  - PoC: click_element (lease 不在 commit バリエーション) を pattern コピーで動作実証
  - expansion plan doc (docs/walking-skeleton-expansion-plan.md) を S6 で起草
```

---

## 10. References

- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.4) §4 S5 (line 254-279) + §4.1 line 306 + §5 完了基準 #2 (line 327) + §3.4 causal window 境界 (line 161-167) + §7 OQ #5 (line 404)
- 概念設計: `docs/adr-010-presentation-layer-self-documenting-envelope.md` §5 envelope schema (line 200-206 caused_by 4 field example、本 sub-plan §2.2 で `tool_call_id` 採用版に訂正検討、§6 OQ #6 carry-over) + §5.2 任意拡張 (`include=causal`、line 256) + §5.5 P3 phase (line 358) + §5.6 envelope size SLO (`include=causal` +1KB 以内、line 380)
- 統合書 (SSOT): `docs/architecture-3layer-integrated.md` §6 (1 event の旅 worked example、T+0 → T+21ms timeline) + §8 各層責務マトリクス (L4 が caused_by 担当、line 358) + §11.2 (compat mode SSOT、S3 で確立した post-flatten 経路を維持)
- 並走依存 sub-plan: `docs/adr-010-p1-s4-plan.md` (PR #113 merged 2026-05-01、本 sub-plan は S4 で確立した `makeCommitWrapper` / `nextToolCallId(sessionId)` per-session counter / `defaultL1Emitter` (L1 ToolCallStarted/Completed push) / `makeQueryWrapper` / `ToolCallStartedPayload { tool, args_json, lease_token }` schema 拡張 を base に history buffer + causal window + caused_by projection を載せる増分のみを describe)
- 既存実装:
  - `src/tools/_envelope.ts` line 739-816 (S4 で確立した `nextToolCallId` per-session counter + `defaultL1Emitter` + `CommitL1Emitter` interface、本 PR で history buffer + caused_by/produced_changes projection helper を追加)
  - `src/tools/_envelope.ts` line 818-1000+ (S4 で確立した `makeCommitWrapper` 7 step flow、本 PR で `makeQueryWrapper` を `causedByProjector` option 経由で拡張)
  - `src/tools/_post.ts` line 55-67 (既存 perception envelope の history ring buffer pattern、本 S5 で session-keyed Map に置換、S4 sub-plan OQ #2 carry-over の resolve)
  - `src/tools/desktop.ts` `DesktopFacade` interface (本 PR で `getLatestFocus` / `getDirtyRectsAggregate` / `getLatestEventId` read-only accessor を追加、handler internal logic 不変)
  - **`src/tools/desktop-state.ts`** (Round 3 P2 Codex #3 fix: 実際の `desktop_state` module-scope schema / handler / server registration が存在、本 PR で `makeQueryWrapper(..., { causedByProjector, getSessionId })` で wrap)
  - `src/tools/macro.ts` (Round 3 P2 Codex #3 fix: `TOOL_REGISTRY.desktop_state` を `desktopStateRegistrationHandler` module-scope shared instance に切替、PR #112 で確立した strip risk pattern 防止)
  - `src/l1_capture/napi.rs` (S5-5 で `l1_ring_peek_latest_event_id` 新 binding を追加する可能性、既存 `l1RingDrain` 等 reuse なら不要、impl PR で確認、§6 follow-up OQ #5)
  - `index.d.ts` (S5-5 で Rust touch 発生時のみ自動生成更新 + `src/engine/native-types.ts` 同期)
- governance: CLAUDE.md 強制命令 3 + 3.1 + 3.2 (PR #102 教訓延長、既存 `desktop_state` handler 不変 + `monitor_index` 維持 + 既存 raw client 互換 default opt-out) + 3.3 (PR レビューループ定型) + 3.4 (Max 20x 並走) + 7 + 8 + 9
- memory: `project_adr008_d2_c_plan_done.md` Lesson 1-4 + `feedback_carry_over_scope_shrink.md` (CLAUDE.md §3.2 PR #102 教訓) + `feedback_pr_review_check_all_inline.md` (Codex inline 全件 fetch 必須) + `feedback_main_direct_push_guard.md` (CLAUDE.md §8 main 直 push 禁止)
- 同型先例:
  - sub-plan 構造: PR #103 (S2 D2-C sub-plan) + PR #104 (S1 D2-E0 sub-plan) + PR #110 (S3 envelope sub-plan) + PR #111 (S4 commit wrapper sub-plan) + PR #113 (S4 impl) — 3 分類 trunk/expansion/carry-over + Round 1〜N review iteration
  - L5 wrapper helper 設計: PR #110 S3 で `makeEnvelopeAware` 確立、PR #111/#113 S4 で `makeCommitWrapper`/`makeQueryWrapper` 拡張、本 S5 で `makeQueryWrapper` を `causedByProjector` option で再拡張
  - L1 napi binding signature 拡張: PR #105 D2-E0 で `view_get_focused` 新設 + PR #110 S3 で `view_get_focused_with_wallclock` 拡張 + PR #113 S4 で `l1_push_tool_call_started` signature 拡張 + 本 S5 で `l1_ring_peek_latest_event_id` 新規追加可能性

---

## Appendix A: 改訂履歴

| version | date | author | summary |
|---|---|---|---|
| Drafted v0.1 | 2026-05-01 | Claude (Sonnet) | 初稿起草、walking skeleton S5 sub-plan、per-session history buffer (TS Map<sessionId, ring 8 件 cap>) + causal window 境界 (左端 ToolCallStarted event_id / 右端 (a) latest event frontier + (b) timeout 200ms / (c) first stable observation は OQ #2 carry-over) + buildCausedBy 5 field projection (your_last_action / tool_call_id / based_on.events / elapsed_ms / produced_changes) + buildProducedChanges (focus delta + dirty_rect per-monitor count、monitor_index 維持) + makeQueryWrapper を causedByProjector option で拡張 + desktop_state wiring + envelope size SLO bench harness 拡張 (causal include 3 シナリオ、< 2KB)。S4 sub-plan PR #111 同型 structure (3 分類 trunk/expansion/carry-over タグ + §0-§10 + Appendix A 改訂履歴 + Lesson 1-4 sweep セクション)、Codex re-review 必須 1 round (cross-layer linkage + API contract regression 防止軸)、Opus 3+ round 想定 (最重要 contract、walking-skeleton §4.1 line 306 整合) |
| Drafted v0.2 | 2026-05-01 | Claude (Sonnet) | **Opus + Codex Round 1 review 反映** (Conditionally Approved + Codex P1×2 + P2×2、累積 P1×5 + P2×9): **P1 (Opus #1, line 208-211)** sample code `pushHistoryStarted({...})` の sessionId 欠落 fix、helper signature `& { sessionId: string }` と整合。**P1 (Opus #2, line 266-272 + ADR-010 §5 line 200-206 + architecture §6 line 213-215)** CausedByShape field 集合の 3 SSOT divergence (本 sub-plan 5 field / ADR-010 §5 example 4 field / architecture §6 4 field) → 本 S5 trunk は **architecture §6 を SSOT に採用** (5 field、`tool_call_id` 含む / `session_id` 含まず)、ADR-010 §5 example の後追い更新を §6 OQ #6 で carry-over。**P1 (Opus #3, line 303)** `buildProducedChanges()` 引数欠落 fix、`buildProducedChanges(viewSnapshot)` に修正。**P1 (Codex line 304)** `buildCausedBy` で `latestEventId` 上限 check 未 enforce → Round 2 で `lastEvent.eventIdCompleted > viewSnapshot.latestEventId` の frontier check 追加、causal window 右端 (a) を runtime enforce。**P1 (Codex line 415)** `"default"` hardcode で concurrent MCP session leak risk → §1.1 E-2 + §2.5 で sentinel guard (`"multi:disabled"`) + `isSingleSessionPrototype()` + `getMcpTransportSessionId()` helper 追加、multi-session 検出時 caused_by skip で leak 回避、完全 finalize は ADR-011 carry-over。**P2 (Opus/Codex 重複 line 311)** `Number(bigint)` precision loss → CausedByShape.based_on.events を `bigint[]` 維持、`Number()` 変換禁止を §4.5 push 6-guard 追加、§7 R9 新設。**P2 (Opus #1, line 50/105/615)** `_post.ts::recordHistory` role 重複 → §6 OQ #7 + §8 OQ #5 で「両者共存」採用と明示、`getHistorySnapshot` 既存経路を破壊しない。**P2 (Opus #3, line 313)** sources hardcode → §2.2 buildCausedBy で `producedChanges` の出処から動的 build (UIA = focus 由来 / DXGI = dirty_rect 由来)。**P2 (Opus #5, line 299-300)** wallclock_ms drift で false-positive expire → causal window timeout を **monotonic 軸 (`performance.now()` 由来 `monotonicStartMs`)** で計算、§2.1 ToolCallEvent.monotonicStartMs field 追加、§7 R3 で resolve 明記、§7 R10 (cross-session leak) も新設。**P2 (Opus #6, line 519/627)** LRU eviction が §3 sub-batch 内になし → §3.1 S5-1 checklist に「LRU eviction (1k entry / TTL 24h、上限超過時 LRU drop)」を追加、§8 OQ #1 を「本 S5 trunk で impl 確定」に update。**P2 (Opus #4)** `produced_changes` string format SSOT 明示は §2.2 CausedByShape docstring + §1.1 C で確定、ADR-010 §5 example update は §6 OQ #6 carry-over。**P2 (Codex line 341)** focus before/after は近似実装 + §6 OQ #4 carry-over、G5 acceptance criteria は近似 (`"focus: → B"`) で十分と §7 R4 で resolve 済 (本 S5 carry-over 維持)。**累積 numeric update**: §7 Risks 8 件 → **10 件** (R9/R10 追加)、§8 OQ 3 件 → **5 件** (OQ #4/#5 追加)、§3 sub-batch S5-1 checklist 追加。**Round 2 review iteration ledger**: 本 v0.2 で Opus + Codex 累積 P1×5 + P2×9 を 1 commit に反映、Round 3 Opus + Codex 再 review 待ち |
| Drafted v0.4 | 2026-05-01 | Claude (Sonnet) | **Opus + Codex Round 3 review 反映** (Conditionally Approved + Codex P1×2 + P2×1、累積 Round 3 P1×2 重複 1 件 + P2×6): **P1 (Opus + Codex 重複、line 71)** §1.1 D で `desktop-register.ts` 誤参照が Round 3 P2 Codex #3 fix の取り残し → Round 4 で `src/tools/desktop-state.ts` の module-scope registration handler に訂正、PR #112 shared registration handler pattern 維持。**P1 (Codex line 625)** §3.3 S5-3 checklist で `buildEnvelope(handlerResult, { causedBy })` old signature 残存 → Round 4 で `{ causedBy, basedOn }` 並列 inject に update、Round 3 P1 Opus #1 の based_on トップレベル分離と整合。**P2×6** Round 3 で CausedByShape 4 field 縮小に伴う「caused_by 5 field」古表記が複数 SSOT 言及で取り残し: line 8 (§0 親 plan reference) / line 118 (§1.4 5 SSOT sweep) / line 611 (§3.2 S5-2 CausedByShape interface) / line 655 (§3.6 G5-S5-1 acceptance) / line 766 (§6 OQ #6 wording) / line 783 (§7 R9 mitigation の R11 後追い更新漏れ) → Round 4 で全 6 箇所訂正、`5 field` → `4 field` + `envelope トップレベル BasedOnShape` 並列、R9 mitigation を R11 superseded reference に書き換え、§3.2 S5-2 checklist に `BasedOnShape interface` 追加、G5-S5-1 acceptance に envelope.based_on 並列 assertion 追加。**累積 numeric update**: §7 Risks 12 件 (件数変動なし、R9 mitigation update + R11/R12 維持)、§8 OQ 5 件 (件数変動なし、OQ #6 wording を 4 field 版に update)、§4.4 sweep checklist に Round 4 P1/P2 fix 2 軸 sweep 追加 (5 field 古表記検出 + buildEnvelope signature 検出)。**Round 4 review iteration ledger**: 本 v0.4 で Opus + Codex Round 3 P1×2 + P2×6 を 1 commit に反映、累積 Round 1+2+3 で P1×10 (重複 2 件) + P2×18、Round 5 Opus + Codex 再 review 待ち (構造変更なし文言整合のみ、最重要 contract のため P1 ゼロ化目標) |
| Drafted v0.3 | 2026-05-01 | Claude (Sonnet) | **Opus + Codex Round 2 review 反映** (Not approved + Codex P1×2 + P2×1、累積 P1×3 重複 1 件 + P2×3): **P1 (Opus #1, line 274-301)** Round 2 で「architecture §6 SSOT 採用」と書いた CausedByShape field 集合 (5 field、`based_on` 内包) は **3 SSOT (architecture §6 4 field + §8.2 envelope トップレベル責務 + ADR-010 §5 4 field + walking-skeleton §3.4 line 159) 全部と divergence**、Round 2 SSOT 採用判断自体が事実誤認 → Round 3 で **CausedByShape を 4 field に縮小** (`your_last_action, tool_call_id, elapsed_ms, produced_changes`)、`based_on` を `BasedOnShape` として envelope トップレベル分離 (architecture §8.2 line 355-356 L1 start / L2 end 責務マトリクス整合)。**P1 (Opus #2, line 444-457 + 489-501) + P1 (Codex line 490) 重複** sentinel guard `multi:disabled` が runtime dead-loop (makeQueryWrapper flow に getSessionId 呼出箇所なし + causedByProjector signature に sessionId 引数なし + production wiring `const sessionId = "default"` ハードコード) → Round 3 で **runtime path closed loop 化**: makeQueryWrapper flow に `const sessionId = options.getSessionId?.(handlerArgs) ?? "default"` 追加、causedByProjector signature を `(args, sessionId) => Promise<{causedBy, basedOn} | undefined>` に拡張、production wiring の sessionId 再ハードコード除去 + sentinel detect で early `return undefined`。**P1 (Codex line 370、`node -e "JSON.stringify({events:[1n]})"` で TypeError 実証)** bigint JSON.stringify で `TypeError: Do not know how to serialize a BigInt` 確実発生 → Round 3 で **`BasedOnShape.events` を `string[]` (u64 decimal string)** に変更採用、内部処理は bigint で扱い envelope serialize 時 `String(eventId)` 変換、precision loss 0 + JSON-safe + LLM client 互換 (Claude CLI bigint 直接扱えず) を兼備、§7 R11 新設。**P2 (Opus #2)** `getMcpTransportSessionId()` deploy scope 未明示 → Round 3 で §2.5 + §3.1 S5-1 checklist で「stub `() => undefined` で deploy、本 S5 trunk skeleton は single-LLM-client prototype 環境のみ deploy 可能、real multi-LLM-client deploy は ADR-011 完了前は禁止」と明示。**P2 (Codex #3, line 460-475)** desktop_state wiring file path 誤り (`desktop-register.ts` と書いたが実際は `desktop-state.ts` に module-scope schema/handler 存在 + `run_macro` も同 module から import) → Round 3 で §2.5 + §3.4 + §10 References を `src/tools/desktop-state.ts` に訂正、PR #112 で確立した shared registration handler pattern (run_macro 経路維持) と整合、§7 R12 新設。**累積 numeric update**: §7 Risks 10 件 → **12 件** (R11 bigint serialize + R12 file path 誤り追加)、§8 OQ 5 件 (件数変動なし)、§4.4 sweep checklist に Round 3 P1/P2 fix 4 軸 sweep 追加 (bigint type / based_on field 配置 / sentinel runtime path / file path)。**Round 3 review iteration ledger**: 本 v0.3 で Opus + Codex 累積 (Round 1 + Round 2) P1×8 + P2×12 を 3 commit に反映、Round 4 Opus + Codex 再 review 待ち |

---

END OF S5 sub-plan (Drafted v0.4)。
