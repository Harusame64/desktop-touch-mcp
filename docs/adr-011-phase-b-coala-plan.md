# ADR-011 Plan — Phase B (Cognitive Memory Layer Expansion: CoALA 4 layer)

- Status: **Drafted v0.4 (Round 1-3 Opus + Round 1 Codex review findings apply 済、最終 review 待ち)**
- Date: 2026-05-07
- Authors: Claude (Sonnet) — project `desktop-touch-mcp`
- 親 plan: `docs/adr-011-cognitive-memory-extension.md` (Phase A、PR #155-#159 で全工程 closure)
- 親 ADR: `docs/adr-010-presentation-layer-self-documenting-envelope.md` §6 (CoALA memory mapping) + §7 P6 acceptance
- 関連:
  - `docs/architecture-3layer-integrated.md` §3.1 (L4 working/episodic 配置) + §16 (SSOT 整合) + §17.7 line 627 OQ #7 working memory N 上限
  - `docs/layer-constraints.md` §5 (L4 working/episodic 上限値 SSOT) + §6 (L5 surface)
  - `docs/walking-skeleton-expansion-plan.md` §6.1 (Phase A carry-over、Phase B では言及のみ)
- 北極星: LLM の不安を消す + 復帰経路を typed に提供 + Tool 数を増やさず 1 tool の表現力を上げる
- スコープ宣言: 本 plan は **Phase B = CoALA 全 4 memory layer (Working / Episodic / Semantic / Procedural) の view 設計 + envelope projection 設計** に scope 限定。ADR-010 §6 で「Working + Episodic = Phase A、Semantic + Procedural = Phase B」と分担されているが、**Phase A は Phase A plan §1.4 で「ADR-010 P6 で view 設計、ADR-011 Phase A は識別子基盤 (session_id) + causal trail (caused_by/based_on) + boundary (compound commit) を wire する」と再 scope** した経緯。本 Phase B plan は ADR-010 P6 acceptance を **吸収統合** + Semantic/Procedural を加えて 4 memory layer を 1 sub-plan で扱う方針。

---

## 1. Context

### 1.1 起源 (Phase A 完了 → Phase B 着手 trigger)

ADR-011 Phase A は 2026-05-07 に全工程 closure (PR #156 A-1 + PR #157 A-3 + PR #158 A-2 + PR #159 bench/docs follow-up)。Phase A 成果:

| 項目 | 達成内容 | Phase B 接続点 |
|---|---|---|
| **session_id 基盤** (A-2) | AsyncLocalStorage + SDK `extra.sessionId` hybrid resolver、`_session-context.ts` 1 SSOT に統合、env mode `single`/`multi`/`auto` で transport-aware 判定 | 4 memory layer の **scope key** として session_id を採用 (cross-session leak 防止) |
| **causal trail** (A-1) | `genericQueryCausedByProjector` + `defaultQuerySessionId` で 9 query tool 全配線、4-axis ViewSnapshot (focus / dirtyRectsByMonitor / latestEventId / queryWallclockMs) を共有 | Working memory の **直近 commit chain projection** の基盤、Episodic memory の **outcome attribution** の基盤 |
| **compound commit boundary** (A-3) | `ToolCallEvent.isCompoundBoundary` + `evictOldestNonBoundary` + `selectLastEventForCausalProjection` で run_macro outer event 保護 | Working memory が long macro を「1 つの logical step」として LLM に見せる単位の基盤 (B-1 で activation) |

Phase A で「**識別子 + causal trail + boundary**」の 3 構造的 contract が確立 → Phase B で **memory layer abstraction** を build。

### 1.2 北極星整合

ADR-010 §1 北極星「LLM の不安を消す + 復帰経路を typed に提供 + Tool 数を増やさず 1 tool の表現力を上げる」に対し、Phase B は以下で寄与:

| 北極星要素 | Phase B 寄与 |
|---|---|
| LLM の不安を消す | `include=["working:10","episodic:5","causal","invariants"]` で **LLM が必要な memory layer を自発 select**、context 不足の不安を構造的に減らす |
| 復帰経路 typed | 過去成功 macro (B-4) を `successful_macros` view で typed expose、失敗時の retry 候補が typed action として見える |
| Tool 数増やさない | 既存 28 tool surface 不変、`desktop_state` の `include` 拡張のみで 4 memory layer を expose (ADR-010 §1.5 Tool Surface 不変原則) |

### 1.3 Phase B scope (CoALA 4 memory layer)

CoALA framework (Sumers et al. 2024) の 4 memory layer を Phase B で全 wire:

| memory type | 提供 view (新規) | LLM 取得方法 | 永続化 | 本 plan PR |
|---|---|---|---|---|
| **Working memory** | `current_state.recent_events: ToolCallEventSummary[]` (recent N event compact) | `include=working:N` (**default N=10、上限 N=50 / `WORKING_MEMORY_N_MAX`**、`HISTORY_BUFFER_CAPACITY = 50` 内、B-1 PR で OQ #1 確定済) | in-memory only (session-scoped) | **B-1** |
| **Episodic memory** | `tool_call_history.episodes: EpisodeSummary[]` (history buffer expose + outcome 含む rich shape) | `include=episodic:N` (default N=5) | in-memory only (session-scoped、TTL 24h、Working と同一 ring を share / projection shape のみ rich 化) | **B-2** |
| **Semantic memory** | `learned_ui_pattern.patterns: UiPatternSummary[]` (page graph 風、操作した UI の構造化記憶) | `include=semantic:K` (default K=3) | 永続化候補 (UI pattern store)、未着手 | **B-3** |
| **Procedural memory** | `successful_macros.suggestions: MacroSuggestion[]` (過去成功 macro の re-use 候補) | `include=procedural:K` (default K=3) | 永続化候補 (macro outcome store)、未着手 | **B-4** |

### 1.4 ADR-010 P6 acceptance との関係

ADR-010 §6 (line 402-409) で「Working + Episodic = Phase A 範囲、Semantic + Procedural = Phase B (ADR-011)」と分担されたが、**ADR-010 Phase A 期間中に Working + Episodic の view 設計は実装されず**、ADR-011 Phase A は識別子基盤 + causal trail + boundary に集中した経緯。本 Phase B plan は:

- **ADR-010 P6 acceptance を吸収統合** — Working + Episodic を本 plan の B-1 / B-2 として実装
- **ADR-010 §6 の表は「Phase A 完了後に ADR-011 Phase B が 4 memory layer 全部を扱う」** に更新する follow-up commit を本 plan land と同時に行う (CLAUDE.md §3.1 fact 整合)

### 1.5 Phase A 成果物との接続点

Phase A の 3 構造的 contract が Phase B でどう活用されるかを明示 (drift 構造的不能):

| Phase A 成果 | Phase B 利用先 |
|---|---|
| `_session-context.ts:getMcpTransportSessionIdFromContext()` | 4 memory layer 全部の **scope key** として使用、`multi:disabled` sentinel で cross-session leak 防止 |
| `genericQueryCausedByProjector` の 4-axis ViewSnapshot | Working memory `recent_events` の **timestamp / event_id 整合性** (latestEventId frontier check) の基盤 |
| `selectLastEventForCausalProjection` (boundary 優先 LIFO) | Working memory が run_macro を **1 logical step** に collapse して expose する基盤 (boundary を anchor として採用) |
| `ToolCallEvent.isCompoundBoundary` field | Episodic memory の `is_compound: boolean` field として直接 expose、LLM が long macro を identify 可能 |

### 1.6 SSOT 参照

本 plan の不変条件・SLO・境界は以下を SSOT とする:
- 識別子ヒエラルキー (session_id) → `architecture-3layer-integrated.md` §4
- L4 envelope assembly 制約 (p99 < 5ms) → `layer-constraints.md` §5
- L5 tool surface 制約 (query SLO) → `layer-constraints.md` §6
- **Working memory N 上限 default 50** → `layer-constraints.md` §5 line 280
- **Episodic memory N 上限 default 100 + LRU** → `layer-constraints.md` §5 line 281, 289
- typed reason 37 codes → ADR-010 §5.4 + `src/tools/_errors.ts`
- HISTORY_BUFFER_CAPACITY (= L4 内 ring 上限) → `src/tools/_envelope.ts` (grep keyword、**B-1 PR で 50 に拡張採用**、§10 OQ #1 Resolved)
- causedByProjector / boundary anchor / session resolver → `src/tools/_envelope.ts` (`genericQueryCausedByProjector` / `selectLastEventForCausalProjection`) + `src/tools/_session-context.ts` (grep keyword)

本 plan で記述された規約と SSOT の間に齟齬が生じた場合、SSOT を優先し、本 plan は後追い更新する (統合書 §16.1 整合)。

**Line ref drift 注記** (Phase A plan §1.5 と同型運用): 本 plan の `file.ts:NNN` 形式 line refs は **drafting 時点の indicative 値**、grep keyword で実 line を検索することを推奨。各 phase land 時に follow-up commit で sync するか、本注記により grep 経路を維持する (CLAUDE.md §3.1 整合)。

---

## 2. Decision

### 2.1 主要決定 (6 項目)

| # | 項目 | 決定 |
|---|---|---|
| 1 | 4 memory layer を **本 plan で一括扱う** | ADR-010 §6 の Phase A/B 分担を吸収統合、Phase A plan §1.4 の方針を維持 |
| 2 | sub-phase **B-1 → B-2 → B-3 → B-4** の sequential 着手 | data model 依存関係 (B-1 working は ToolCallEvent ring の薄い projection、B-2 episodic はその rich shape extension、B-3/B-4 は別 view + 永続化候補で大規模) |
| 3 | **B-1 / B-2 は in-memory only** (session-scoped、TTL 24h)、永続化なし | LLM session の context 寿命と memory 寿命を一致させる、production privacy risk 最小化 |
| 4 | **B-3 / B-4 は永続化候補** (`%USERPROFILE%\.desktop-touch-mcp\memory\` ローカル JSON、暗号化なし、user-controlled) | 過去パターン / 過去 macro を session 跨いで活用、**ただし opt-in 必須** (env var or config flag、§7 OQ で詳細) |
| 5 | view name + include API surface | `current_state` (Working) / `tool_call_history` (Episodic) / `learned_ui_pattern` (Semantic) / `successful_macros` (Procedural)、`include=working:N` / `episodic:N` / `semantic:K` / `procedural:K` 4 axis (ADR-010 §6 line 414 の example と整合) |
| 6 | envelope size budget | 4 layer 全 enable 時の caused_by + based_on + 4 memory layer の **合計 +5KB 以内** (ADR-010 §5.6.1 +1KB は per-feature、4 layer × 1KB + buffer) |

### 2.1.1 ADR-010 §6 follow-up update

**B-1 land と同 PR で** ADR-010 §6 line 402-409 の表を更新 (Round 2 Codex P3 反映で「本 plan land 同 PR」から「B-1 land 同 PR」へ修正、§11.4 carry-over mark と整合)。本 plan 起草 PR では ADR-010 を touch せず、B-1 implementation PR で表 + ADR-010 §5.6.1 size 上限表 (Round 2 P2-A) を同時更新する CLAUDE.md §3.1 fact 整合:

旧:
| Working | ✓ Phase A | `current_state` ... |
| Semantic | ✗ Phase B (ADR-011) | `learned_ui_pattern` ... |

新:
| Working | ✓ ADR-011 Phase B (B-1) | `current_state.recent_events` ... |
| Episodic | ✓ ADR-011 Phase B (B-2) | `tool_call_history.episodes` ... |
| Semantic | ✓ ADR-011 Phase B (B-3) | `learned_ui_pattern.patterns` ... |
| Procedural | ✓ ADR-011 Phase B (B-4) | `successful_macros.suggestions` ... |

### 2.2 設計の核

**B-1〜B-4 はそれぞれ独立 PR** に分離可能、worktree 並走対象 (CLAUDE.md §3.4 Max 20x 並走戦略整合)。各 PR は trunk lock layer 改変ゼロ (engine-perception / l1_capture / l3_bridge 触らず)、L4 envelope + L5 wrapper のみの改変で完結。ただし B-3 / B-4 は **新規 store** (UI pattern / macro outcome) を `src/store/` に新設、永続化 backend 設計が新規範囲。

---

## 3. Architecture

### 3.1 5 層との位置づけ

```
┌─────────────────────────────────────────────────────────┐
│ L5: MCP Tool Surface                                     │
│     desktop_state(include=["working:N","episodic:N",     │
│                            "semantic:K","procedural:K"]) │
│     を経由した envelope.* 配下へ projection               │
├─────────────────────────────────────────────────────────┤
│ L4: Cognitive Projection + Envelope Assembly             │
│     B-1 working: ring buffer last N event projection     │
│     B-2 episodic: ring buffer + outcome rich shape       │
│     B-3 semantic: UI pattern store query (永続化候補)    │
│     B-4 procedural: macro outcome store query (永続化候補)│
├─────────────────────────────────────────────────────────┤
│ L3: Compute (IVM) — 改変ゼロ (Phase A と同型)            │
├─────────────────────────────────────────────────────────┤
│ L2: Storage (MVCC) — 改変ゼロ (B-3/B-4 は L4 内別 store) │
├─────────────────────────────────────────────────────────┤
│ L1: Capture (event ring buffer) — 改変ゼロ               │
└─────────────────────────────────────────────────────────┘
```

trunk lock layer (Phase A と同) は触らない。

### 3.2 4 memory layer の data flow

```
commit tool 呼出 (mouse_click / keyboard / etc.)
    │
    ▼
makeCommitWrapper → l1.pushStarted/pushCompleted
    │
    ├── L1 ring (Rust napi、production 経路) ── 既存
    └── L4 history buffer (TS、A-2/A-3 wire)
        ├── ToolCallEvent (B-1/B-2 source)
        ├── isCompoundBoundary flag (A-3 land、B-1/B-2 で利用)
        └── ────── B-3 hook (UI pattern detector) ──┐
            ────── B-4 hook (macro outcome) ────────┤
                                                     ▼
                                          B-3 / B-4 永続化 store
                                          (%USERPROFILE%\.desktop-touch-mcp\memory\*.json)

query tool 呼出 (desktop_state include=...)
    │
    ▼
makeQueryWrapper → causedByProjector
    │
    ├── caused_by / based_on (A-1 wire) ── 既存
    └── envelope projection (B-1〜B-4 拡張)
        ├── current_state.recent_events (B-1)
        ├── tool_call_history.episodes (B-2)
        ├── learned_ui_pattern.patterns (B-3、永続 store query)
        └── successful_macros.suggestions (B-4、永続 store query)
```

### 3.3 Storage / Retention strategy

| layer | storage | retention | scope key |
|---|---|---|---|
| Working (B-1) | `_envelope.ts` 既存 history ring (`HISTORY_BUFFER_CAPACITY = 50`、B-1 PR で 8 → 50 拡張採用、§10 OQ #1 Resolved、A-3 boundary 保護下) | session-scoped、新 commit で oldest evict (boundary は `evictOldestNonBoundary` で skip) | `sessionId` (`_session-context.ts:getMcpTransportSessionIdFromContext()`) |
| Episodic (B-2) | **同上 ring を共有** (Working と同 ToolCallEvent ring、projection shape のみ rich 拡張)、Working の `_envelope.ts` に新 store を作らない設計 — 新 ring を作ると 2 ring 同期コストが発生、share により drift 構造的不能 | TTL 24h (既存 `HISTORY_BUFFER_TTL_MS`、ring lifecycle と統一) | `sessionId` (Working と同) |
| Semantic (B-3) | 新 store `src/store/ui-pattern-store.ts` + `%USERPROFILE%\.desktop-touch-mcp\memory\ui-patterns.json` (Windows production、Node.js 解決は `path.join(os.homedir(), ".desktop-touch-mcp", "memory", ...)`、CLAUDE.md launcher 経路と整合) | LRU + opt-in env var (`DESKTOP_TOUCH_MEMORY_PERSIST=1`) | `sessionId` (default) or `global` (opt-in) |
| Procedural (B-4) | 新 store `src/store/macro-outcome-store.ts` + `%USERPROFILE%\.desktop-touch-mcp\memory\macros.json` (B-3 同型) | LRU + opt-in、successful only | 同上 |

**B-1 / B-2 の ring 共有設計** (Round 1 P2-2 反映): Working memory は ToolCallEvent の薄い projection、Episodic memory は同 ring 上の **rich shape projection** で、**両者は同 ring を異なる shape で読み出す** だけ。ring SSOT は 1 つ (`_envelope.ts:_historyBuffers` per-session Map、`HISTORY_BUFFER_CAPACITY` 制約下、A-2/A-3 で session 隔離 + boundary 保護済)。

**Privacy / opt-in policy** (重要):
- B-1 / B-2: in-memory only、process exit で消失、external persistence なし
- B-3 / B-4: **default OFF**、`DESKTOP_TOUCH_MEMORY_PERSIST=1` で opt-in、user 確認 (initial CLI banner で warn)
- 全 layer で `multi:disabled` sentinel sessionId は memory expose を skip (cross-session leak 防止、Phase A の sentinel runtime closed loop と整合)

---

## 4. B-1: Working memory (`include=["working:N"]`)

### 4.1 設計

`_envelope.ts:HISTORY_BUFFER_CAPACITY = 50` の ToolCallEvent ring (= B-1 PR で 8 → 50 拡張、§10 OQ #1 Resolved、A-2/A-3 で session-scoped に整備済) を **直近 N 件 compact projection** として `desktop_state` envelope に append。

LLM が「直前の自分の操作 N 件を short summary で見たい」needs に応える。Episodic との差別化:
- Working = **compact** (toolName + argsSummary 64 char + ok flag のみ)
- Episodic = **rich** (Working + elapsed_ms + lease_token + isCompoundBoundary + 完全 argsJson)

### 4.2 view 構造

```typescript
// Phase B-1 新設
export interface ToolCallEventSummary {
  tool_call_id: string;          // sessionId:seq
  tool: string;                   // tool name
  args_summary: string;           // 64 char truncated
  ok: boolean | undefined;        // undefined = in-flight
  is_compound: boolean;           // A-3 boundary flag (true なら inner step は集約表示)
}

// envelope.current_state.recent_events に projection
//   default N = 10 (WORKING_MEMORY_DEFAULT_N、ADR-010 §5.6.1 P6 既定値整合)
//   上限 N = 50 (WORKING_MEMORY_N_MAX、layer-constraints §5 SSOT 整合)
//   capacity = 50 (HISTORY_BUFFER_CAPACITY、B-1 PR で 8 → 50 拡張採用)
//   ※ N <= N_MAX 範囲内で ring 内件数 < N の場合は全件返却 + envelope に
//      `_truncation` notation (ADR-010 §5.6.1 truncation 規約) で「N 要求に対し
//      ring に M 件しかなかった」事実を LLM に明示。silently truncate 禁止。
//   ※ N > N_MAX で typed error WorkingMemoryNUpperBoundExceeded 返却 (短絡)。
```

A-3 boundary 保護と連動: `selectLastEventForCausalProjection` の anchor (boundary 優先 LIFO) と並走、boundary outer event は **常に recent_events 末尾近くに preserve** される。

### 4.3 acceptance (Round 1 P2-1 反映 — silently truncate 防止 strict)

- `include=["working:N"]` で `envelope.current_state.recent_events` に **min(N, ring 内件数, HISTORY_BUFFER_CAPACITY=50)** 件 projection (silently truncate しない、ring 内件数 < N で `_truncation: { requested: N, returned: M, reason: "ring_underflow" | "capacity_cap" }` notation を envelope に付与、ADR-010 §5.6.1)
- `working:N` の N が **`WORKING_MEMORY_N_MAX = 50`** (B-1 PR 確定値、`layer-constraints §5 line 280` SSOT 整合) を超えると typed error `WorkingMemoryNUpperBoundExceeded` (`try_next` に SUGGESTS 3 行 typed action wired)
- **default N = 10 ≤ HISTORY_BUFFER_CAPACITY = 50** で silent truncate なし
- envelope size: `working:10` で +500B 以内 (per-event ~50B × 10、ToolCallEventSummary compact)
- regression: A-3 既存 unit test (compound-commit-boundary.test.ts) + A-1 (causal include) 全 pass

### 4.4 PR 単位

B-1 は **1 PR で完結** (~250-400 line):
- `_envelope.ts`: `ToolCallEventSummary` interface + `projectWorkingMemory(sessionId, N)` helper
- `desktop-state.ts` + 8 wired query tool: `include=["working:N"]` parsing + `envelope.current_state.recent_events` 配置
- `_errors.ts`: `WorkingMemoryNUpperBoundExceeded` typed reason 追加 (37 → 38 codes)
- unit test ~10 case (sentinel skip / N validation / boundary 優先選択 / N=0 edge / capacity overflow)

---

## 5. B-2: Episodic memory (`include=["episodic:N"]`)

### 5.1 設計

`_envelope.ts:ToolCallEvent` の **完全 shape を expose** (Working の compact summary と差別化、history buffer の rich expose)。LLM が「直近の自分の commit の outcome / elapsed / lease_token / boundary 情報を全部見たい」needs に応える。

A-2 で wire 済の `ToolCallEvent` field を そのまま expose:
- `tool_call_id`, `tool_name`, `args_summary`, `ok`, `eventIdStarted/Completed`, `wallclockStartMs/EndMs` → `started_at/ended_at`, `monotonicStartMs` → 内部、`leaseToken`, `isCompoundBoundary`

### 5.2 view 構造

```typescript
// Phase B-2 新設
export interface EpisodeSummary {
  tool_call_id: string;
  tool: string;
  args_summary: string;           // 512 char (B-1 の 64 char より rich)
  ok: boolean;                    // completed only (in-flight は skip)
  started_at_ms: number;          // wallclockStartMs
  elapsed_ms: number;             // wallclockEndMs - wallclockStartMs
  is_compound: boolean;
  lease_token_summary?: string;   // 4-tuple summary (PII safe redact)
  event_id_started?: string;      // u64 decimal string (Phase A bigint→string SSOT)
  event_id_completed?: string;
}

// envelope.tool_call_history.episodes に projection
//   default N = 5、上限 N = 100 (layer-constraints §5 episodic memory N 上限)
```

### 5.3 acceptance

- `include=["episodic:5"]` で `envelope.tool_call_history.episodes` に **完了済** 5 件 (in-flight skip)
- `episodic:N` の N が **`EPISODIC_MEMORY_N_MAX = 100`** (B-2 PR 確定値、`layer-constraints §5 line 281` SSOT 整合) を超えると typed error `EpisodicMemoryNUpperBoundExceeded` (`try_next` に SUGGESTS 3 行 typed action wired、B-1 同型 minimal wiring)
- envelope size: `episodic:5` で +1.5KB 以内 (per-episode ~300B × 5)
- regression: A-1/A-2/A-3 全 unit test pass

### 5.4 PR 単位

B-2 は **1 PR で完結** (~300-450 line):
- `_envelope.ts`: `EpisodeSummary` interface + `projectEpisodicMemory(sessionId, N)` helper
- 9 query tool: `include=["episodic:N"]` parsing + `envelope.tool_call_history.episodes` 配置
- `_errors.ts`: `EpisodicMemoryNUpperBoundExceeded` typed reason 追加 (38 → 39 codes)
- unit test ~12 case (in-flight skip / lease_token redact / monotonic timeout 整合 / boundary 含む episode / TTL eviction 整合)

---

## 6. B-3: Semantic memory (`include=["semantic:K"]`)

### 6.1 設計

LLM が操作した **UI pattern の構造化記憶** を `learned_ui_pattern` view で expose。例:
- 「Notepad の File メニュー → Save As ダイアログの構造」
- 「Chrome のアドレスバー → URL 入力 → Enter で navigate」

これらは過去の commit + UIA 結果から**抽出**し、永続化候補。LLM が新規 UI に遭遇した際「過去類似 pattern」を hint として参照可能。

実装 strategy は **rule-based 開始**、ML-based は OQ #2 で carry-over:

| 軸 | rule-based (推奨初期実装) | ML-based (carry-over) |
|---|---|---|
| 抽出 | 「同 windowTitle で連続 N commit が成功した」series を 1 pattern として記録 | embedding ベースの similarity clustering |
| storage | JSON + LRU | vector store (sqlite-vss 等) |
| query | windowTitle exact match + similar prefix | semantic similarity top-K |
| privacy | windowTitle / element name は redact 候補 | 同上 |

### 6.2 view 構造 + storage

```typescript
// Phase B-3 新設
export interface UiPatternSummary {
  pattern_id: string;             // hash(windowTitle + seq)
  window_title: string;           // redacted by env DESKTOP_TOUCH_MEMORY_REDACT_TITLES=1
  step_count: number;             // pattern の commit 数
  last_seen_at_ms: number;
  success_rate: number;           // 0.0-1.0 (LRU で stale はパージ)
  example_actions: string[];      // top 3 commit name (e.g. ["focus_window", "click_element", "keyboard"])
}

// envelope.learned_ui_pattern.patterns に projection
//   default K = 3、上限 K = 10 (envelope size budget)

// storage: src/store/ui-pattern-store.ts
//   in-memory ring (default 100 patterns、LRU evict)
//   永続化 opt-in: %USERPROFILE%\.desktop-touch-mcp\memory\ui-patterns.json
//   (Windows production、Node.js 解決は path.join(os.homedir(), ".desktop-touch-mcp", "memory", "ui-patterns.json")、
//    CLAUDE.md launcher 経路の `%USERPROFILE%\.desktop-touch-mcp` と整合)
```

### 6.3 acceptance

- `include=["semantic:3"]` で `envelope.learned_ui_pattern.patterns` に top 3 pattern (LRU 末尾の most-recently-used)
- `semantic:K` の K が `> 10` で typed error `SemanticMemoryKUpperBoundExceeded` (default 10、本 plan で新設)
- envelope size: `semantic:3` で +1.2KB 以内 (per-pattern ~400B × 3)
- 永続化 opt-in: `DESKTOP_TOUCH_MEMORY_PERSIST=1` で `%USERPROFILE%\.desktop-touch-mcp\memory\ui-patterns.json` (Node.js 解決は `path.join(os.homedir(), ".desktop-touch-mcp", "memory", "ui-patterns.json")`) に flush、起動時 load
- privacy: `DESKTOP_TOUCH_MEMORY_REDACT_TITLES=1` で window_title redact

### 6.4 PR 単位

B-3 は **1-2 PR**:
- PR-A: Pattern store + extraction pipeline + view 設計 (~500-700 line)
- PR-B: 永続化 backend + opt-in env var + privacy redact (~300-400 line)

または上記 2 PR を 1 大 PR で扱うか、B-3 着手時に判断 (carry-over OQ)。

### 6.5 OQ (B-3 関連)

- 抽出 strategy: rule-based 初期実装で十分か、ML-based を初期から導入か
- redact policy: window_title default redact / opt-in expose、または default expose / opt-in redact

---

## 7. B-4: Procedural memory (`include=["procedural:K"]`)

### 7.1 設計

LLM が **過去成功した macro の re-use 提案** を `successful_macros` view で expose。例:
- 「Notepad で File → New を実行する macro = focus_window + keyboard ctrl+n」
- 「Chrome で URL 入力 = focus_window + keyboard ctrl+l + keyboard type + keyboard enter」

`run_macro` 経由で実行された macro の **success outcome** を store に記録 (A-3 の `isCompoundBoundary: true` outer event を起点)、後続 session で類似 task suggestion として LLM に提供。

### 7.2 view 構造 + storage

```typescript
// Phase B-4 新設
export interface MacroSuggestion {
  macro_id: string;               // hash(steps fingerprint)
  description: string;            // user-supplied or auto-generated
  step_count: number;
  success_count: number;          // 過去成功回数
  failure_count: number;          // 過去失敗回数 (LRU 評価)
  last_used_at_ms: number;
  example_steps: string[];        // top 3 step name
}

// envelope.successful_macros.suggestions に projection
//   default K = 3、上限 K = 10

// storage: src/store/macro-outcome-store.ts
//   in-memory + opt-in JSON 永続化
//   永続化先: %USERPROFILE%\.desktop-touch-mcp\memory\macros.json
//   (Node.js 解決は os.homedir() 経由、B-3 同型)
```

### 7.3 acceptance

- `include=["procedural:3"]` で top 3 macro (success_count 降順)
- `procedural:K` の K が `> 10` で typed error `ProceduralMemoryKUpperBoundExceeded`
- envelope size: `procedural:3` で +1KB 以内
- 永続化 opt-in (B-3 と同じ env var)
- privacy: macro description / step args は default redact、opt-in で expose

### 7.4 PR 単位

B-4 は **1 PR で完結** (~400-600 line)、B-3 完了後の sequential 着手。

### 7.5 OQ (B-4 関連)

- sharing scope: per-session / global / per-app — どこまで cross-session 共有を許容するか
- success 判定 criteria: `isCompoundBoundary: true` outer の `ok: true` のみか、step 単位の partial success も含むか

---

## 8. Acceptance criteria

| Phase B 項目 | 完了基準 |
|---|---|
| **B-1** | `include=["working:N"]` 動作、**N <= 50** (`WORKING_MEMORY_N_MAX`、`layer-constraints §5` SSOT 整合、§4.3 acceptance と sync、B-1 PR で確定)、envelope size +500B 以内 (default N=10、ToolCallEventSummary compact)、unit test 22 case pin |
| **B-2** | `include=["episodic:N"]` 動作、**N <= 100** (`EPISODIC_MEMORY_N_MAX`、`layer-constraints §5` SSOT 整合、§5.3 acceptance と sync、B-2 PR で確定)、in-flight skip + completed only、rich shape (lease_token_summary / event_id u64 decimal / elapsed_ms / is_compound) expose、envelope size +1.5KB 以内 (default N=5)、unit test 18 case pin |
| **B-3** | `include=["semantic:K"]` 動作、K <= 10、永続化 opt-in、redact policy 実装、envelope size +1.2KB 以内、unit test 15+ case pin |
| **B-4** | `include=["procedural:K"]` 動作、K <= 10、永続化 opt-in、success/failure rate tracking、envelope size +1KB 以内、unit test 12+ case pin |
| **横断** | trunk lock layer 改変ゼロ (expansion-pr-guard.yml + check-expansion-disjoint.mjs pass) |
| **横断** | 4 layer 全 enable 時の envelope size: caused_by + based_on + working + episodic + semantic + procedural で **合計 +5KB 以内** (ADR-010 §5.6.1 拡張) |
| **横断** | sentinel runtime closed loop: `multi:disabled` sessionId で 4 layer 全部が undefined return (cross-session leak 防止、Phase A の closed loop と整合) |
| **横断** | privacy: B-3/B-4 default OFF、`DESKTOP_TOUCH_MEMORY_PERSIST=1` opt-in、初回起動時 CLI banner で user 通知 |
| **横断** | ADR-010 §6 の表更新 (本 plan land と同 PR で B-1 land 時) |

---

## 9. Risks

| # | リスク | 影響 | 軽減策 |
|---|---|---|---|
| 1 | envelope size budget の累積 inflation (4 layer 全 enable で +5KB 以内目標が破れる) | High | 各 layer の N/K 上限を layer-constraints SSOT で固定、bench (`benches/l4_envelope_size.mjs`) で per-PR regression 検出。**ADR-010 §5.6.1 全体上限 < 10KB との関係** (Round 2 P3-A 反映): 本 plan +5KB は ADR-010 §5.6.1 既存 increment (P3 causal +1KB / P3 invariants +0.5KB / P4 query_past +0.1KB / P5 dry_run +2KB = 計 +3.6KB) との合算で **base + 3.6KB + 5KB = 約 9.6KB ≤ 10KB** 内に収まる前提、bench で逸脱検出時は B-1/B-2 default N を絞る or §10 OQ #1 で capacity / N 上限見直し |
| 2 | B-3/B-4 永続化で privacy leak (window_title / lease_token / args が disk に書かれる) | High | default OFF、opt-in env var、redact env var、初回 banner、disk 書込前に `truncateJson(512)` |
| 3 | B-3 rule-based extraction が誤った pattern を学習 (誤検知 / false positive) | Medium | success_rate < 0.5 で auto-purge、user 直接削除 API (別 PR で検討) |
| 4 | B-4 procedural memory が destructive macro を suggest (e.g. file delete macro が成功) → LLM が無批判に再 invoke | High | success/failure tracking、`run_macro` の caveat docstring 強化、destructive tool 含む macro は suggest skip |
| 5 | session_id 跨ぎで memory leak (multi-LLM-client deploy で B-3/B-4 が global scope で他 client に expose) | High | sentinel `multi:disabled` で memory expose skip、Phase A の sentinel runtime closed loop を 4 layer 全部に適用 |
| 6 | layer-constraints の N 上限値 (working 50 / episodic 100) が **production で過小** な可能性 | Medium | bench で実 LLM context 消費を測定、`layer-constraints.md` 更新で値調整 (CLAUDE.md §3.1 整合) |
| 7 | B-1〜B-4 sequential 着手で B-3/B-4 が Phase B-1 land 後 1-2 ヶ月後になる、要求 trigger が Phase A 完了時に user 不在 | Low | B-1/B-2 を先 land で Working/Episodic 即時提供、B-3/B-4 は user demand 確認後着手 |

---

## 10. Open Questions

| # | 質問 | 検討タイミング |
|---|---|---|
| 1 | ~~B-1 の HISTORY_BUFFER_CAPACITY (現状 8) を **拡張** するか — 本 plan §1.3 + §4 で **default N=5 に下げて capacity 8 内に収める** 暫定方針を採用 (Round 1 P2-1 反映)。capacity 50 に拡張すれば default N=10 / 上限 50 復活可能だが、ring overflow 時の eviction 計算量・envelope size budget 増・boundary 保護下の effective capacity = `capacity - boundary 件数` の relationship が変わる。**B-1 PR の最初の決定事項** として PR description に明記、`layer-constraints §5` SSOT 更新と同期~~ → **Resolved** (B-1 PR で **(a) capacity 50 拡張 + default N=10 復活** 採用、`HISTORY_BUFFER_CAPACITY = 50` / `WORKING_MEMORY_DEFAULT_N = 10` / `WORKING_MEMORY_N_MAX = 50` SSOT 確定、`layer-constraints §5 line 280` 既定値踏襲、land 2026-05-07) | ~~B-1 着手前~~ |
| 2 | B-3 抽出 strategy: rule-based 初期実装 vs ML-based 初期導入 | B-3 着手時、user demand + Phase A 後の bench/dogfood 経験で判断 |
| 3 | B-4 sharing scope: per-session / global / per-app — どこまで cross-session 共有を許容 | B-4 着手時、privacy policy 詳細策定と並走 |
| 4 | B-3/B-4 の永続化 backend: JSON ローカル / SQLite / 別 process pipe — 選定 | B-3 PR-B 着手前、bench で write/read latency 検証 |
| 5 | layer-constraints `working memory N 上限 default 50` / `episodic memory N 上限 default 100` の現実的妥当性 | B-1/B-2 着手前、Phase A causal_extreme bench (~1475B < 2KB SLO) を Working/Episodic で再 bench |
| 6 | Phase B 着手 trigger: Phase A 完了直後 sequential か、user demand (multi-LLM-client deploy 等) を待つか | Phase A 完了時 = 本 plan land 時の user 判断 |
| 7 | A-4 (Codex 振り返り review) と Phase B 着手の順序: A-4 完了待ちか並走か | 本 plan land 後の user 判断 (A-4 は Codex usage 復帰待ち、本 plan の B-1 着手とは independent で並走可) |
| 8 | **B-4 destructive macro suggest 防止の判定 mechanism** (Round 1 P2-4 反映) — §9 R4 で「destructive tool 含む macro は suggest skip」と書かれているが判定経路 plan 内未定義。**選択肢: (a) `_envelope.ts` の commit-axis tool registry に `isDestructiveCandidate: boolean` flag を追加 + `mouse_click` / `keyboard` / `desktop_act` / `terminal` / `clipboard(set)` を blacklist 化 / (b) `run_macro` の inner steps を AST 走査して destructive tool 含有判定 / (c) 全 macro suggest を user explicit consent 必須にして criteria を統一**。runtime 機械的判定が必要 (CLAUDE.md Lesson 2 compile-time guard 過信 防御)、§9 R4 軽減策の具体化 | B-4 着手時、blacklist 候補 tool list を user judgment で確定 |
| 9 | **B-3/B-4 privacy banner 実装場所** (Round 1 P3-2 反映) — `~/.desktop-touch-mcp/memory/*.json` 永続化 opt-in 時に「初回起動時 CLI banner で user 通知」と §3.3 / §6.3 で明記しているが、launcher (`bin/launcher.js`) で表示するか server.json で表示するか、または server 側 stderr で 1 度だけ表示するかの選定 | B-3 PR-B 着手前、launcher 経路 vs server 経路の lifecycle 整合確認 |

---

## 11. Implementation phases (PR breakdown)

### 11.1 PR 着手順序

| 順 | PR | scope | review 強度 (CLAUDE.md §3.3 Step 0) |
|---|---|---|---|
| 1 | **B-1: Working memory** | `_envelope.ts` extension + 9 query tool wire + ADR-010 §6 表更新 + unit test | Opus 必須 + Codex 必須 (production code 改修) |
| 2 | **B-2: Episodic memory** | 同型 (B-1 と structurally parallel) | Opus 必須 + Codex 必須 |
| 3 | **B-3: Semantic memory** | 大型 — 新 store + 抽出 pipeline + view + 永続化 + redact | Opus 必須 + Codex 必須 + user reviewer 補正 window 重視 |
| 4 | **B-4: Procedural memory** | 大型 — B-3 と同型 + macro outcome tracking | 同上 |

### 11.2 Merge order recommendation

**B-1 → B-2 → B-3 → B-4** sequential が推奨。理由:

- B-1 / B-2 は **既存 history ring 拡張のみ**、新規 store 不要、低リスク (1-3 日 each)
- B-3 / B-4 は **新規 store + 永続化 + privacy** で **新スコープ多数** (1-2 週間 each)
- B-1/B-2 で memory layer の view API surface (`include` 多軸 parsing + envelope.* projection) を確立 → B-3/B-4 で reuse
- B-3 完了後 **user demand 再確認** で B-4 着手判断 (B-4 は最大 risk = destructive macro suggest)

### 11.3 PR review loop (CLAUDE.md §3.3 Step 1-5)

各 PR で:

1. Step 1: PR 作成直後 Opus phase-boundary review
2. Step 2: Codex re-review (production code 改修 PR は必須、API contract 軸 + privacy 軸)
3. Step 3: 反復 (P1 ゼロ化まで)
4. Step 4: User reviewer 補正 window
5. Step 5: User judgment merge (B-3/B-4 は privacy 観点で user 確認重視)

### 11.4 carry-over 解消 mark

各 PR land 時に **両 doc の grep sweep + 同期更新**を実施 (Round 1 P2-5 反映、CLAUDE.md §3.1 複数表 fact 整合):

#### 更新対象 (grep keyword 経路)

ADR-011 Phase A plan (`docs/adr-011-cognitive-memory-extension.md`) 内で以下の grep keyword で "scope 外" 表現が **3 箇所以上散在** (line 50-61 §1.4 / line 495-506 §5 / Appendix § 改訂履歴) のため、各 PR land 時は **全 grep + Resolved 化**を実行:
- `scope 外`
- `Phase B`
- `別 sub-plan`
- `Working memory` / `Episodic memory` / `Semantic memory` / `Procedural memory` の各 layer 名 (4 layer 別)

ADR-010 (`docs/adr-010-presentation-layer-self-documenting-envelope.md`) §6 表 (line 402-409):
- `Phase A` / `Phase B (ADR-011)` の Phase 分担表記
- `current_state` / `learned_ui_pattern` / `successful_macros` / `tool_call_history` の view name

`docs/architecture-3layer-integrated.md` §17.7 line 627 OQ #7 (working memory N 上限) — B-1 land 時に「ADR-010 P6 着手後 bench で」を「ADR-011 Phase B B-1 land 時に決定」に更新。

#### 各 PR land 時の処理

- **B-1 land** → ADR-010 §6 表「Working」行を「ADR-011 Phase B (B-1)」に flip **+ ADR-010 §5.6.1 size 上限表 P6 行 (Round 2 P2-A 反映)** の `working:N (N=10 default、P6)` を確定値 (B-1 PR 最初の決定事項に従う、§10 OQ #1) に更新 + フルパターン `working:10` も同期 + Phase A plan §1.4 / §5 内「Working memory ... scope 外」を Resolved 化 + `architecture-3layer-integrated.md §14 OQ #7` (= 旧 §17.7 と誤記してたが実 section は §14、Round 2 P2-B 反映、grep keyword: `working memory の N 上限推奨`) 更新
- **B-2 land** → 同型 (Episodic 行)、ADR-010 §5.6.1 P6 行 `episodic:N (N=5 default、P6)` も同期確認 + 両 doc + architecture grep
- **B-3 land** → 同型 (Semantic 行) + 永続化 path 統一表記の sync (`%USERPROFILE%\.desktop-touch-mcp\memory\`、本 plan §3.3 / §6.2 + Phase A plan / launcher comment 整合)
- **B-4 land** → 同型 (Procedural 行) + destructive blacklist 確定値の sync (本 plan §10 OQ #8 → Resolved 化)

各 PR の review checklist で「§11.4 grep sweep を実行 + 全ヒット更新」を必須項目に組み込む (Phase A の §3.1 fact 整合 sweep と同型運用)。**特に ADR-010 §5.6.1 size 上限表は「見出し / 主要表は注記より強く読まれる」原則 (CLAUDE.md §3.1 教訓) で更新漏れが盲点化しやすいため、B-1 / B-2 land 時に注意**。

#### 全 layer land で Phase B Completed flip

全 4 layer land で **Phase B v1.0 Completed flip**、ADR-011 全体 (Phase A + Phase B) を Status: Completed v2.0 に flip。flip 時に Phase A plan + Phase B plan + ADR-010 §6 表 + architecture §17.7 OQ #7 の **全 4 doc 同時更新** を 1 follow-up PR で実施 (last-mile sync)。

---

## 12. Related artifacts

- 本 plan: `docs/adr-011-phase-b-coala-plan.md`
- 親 plan (Phase A): `docs/adr-011-cognitive-memory-extension.md`
- 親 ADR: `docs/adr-010-presentation-layer-self-documenting-envelope.md` §6 / §7 P6
- 統合書: `docs/architecture-3layer-integrated.md` §3.1 (L4 working/episodic 配置) / §16 (SSOT 整合)
- Layer constraints: `docs/layer-constraints.md` §5 (working/episodic N 上限 SSOT) / §6
- carry-over (Phase A): `docs/walking-skeleton-expansion-plan.md` §6.1
- 既存実装 SSOT (Phase A land 後、line ref drift 注記参照、grep keyword 推奨):
  - `src/tools/_envelope.ts` history buffer + ring + boundary anchor (`ToolCallEvent` / `selectLastEventForCausalProjection` / `evictOldestNonBoundary` / `pushHistoryStarted` / `buildCausedBy` / `buildBasedOn`)
  - `src/tools/_session-context.ts` (A-2 SSOT、`runWithSessionContext` / `getMcpTransportSessionIdFromContext` / `isSingleSessionPrototype`)
  - `src/tools/desktop-state.ts` causedByProjector + sessionId resolver
  - `src/tools/macro.ts` run_macro registration (B-4 success outcome 起点)
- Phase B 新設 (本 plan land 後):
  - `src/store/ui-pattern-store.ts` (B-3)
  - `src/store/macro-outcome-store.ts` (B-4)
  - `~/.desktop-touch-mcp/memory/*.json` (B-3/B-4 永続化、opt-in)

---

## Appendix A: 改訂履歴

| version | date | author | summary |
|---|---|---|---|
| Drafted v0.1 | 2026-05-07 | Claude (Sonnet) | 初稿起草。Phase A 全工程 closure 後の sub-plan、CoALA 4 memory layer (Working / Episodic / Semantic / Procedural) を本 plan で一括扱う方針。B-1 → B-2 → B-3 → B-4 sequential 着手、B-1/B-2 = in-memory only、B-3/B-4 = 永続化候補 + opt-in policy。ADR-010 §6 表の follow-up update を本 plan land と同 PR で実施 (CLAUDE.md §3.1 fact 整合)。Phase A 成果 (session_id + causal trail + boundary) を §1.5 で Phase B 接続点として明示。Opus phase-boundary review 未実施。 |
| Drafted v0.4 | 2026-05-07 | Claude (Sonnet) | **Round 1 Codex review** (chatgpt-codex-connector、commit `e7e511e2` 対象、P1×0 + P2×4 + P3×2) findings 全件反映 — Round 3 Opus = Approved (累積 P1+P2+P3 ゼロ判定済) **後の Codex 単独検出 (memory `feedback_ai_multi_reviewer.md` の Opus + Codex 補完性、API contract / scope shrink 軸の盲点検出)**: **P2-line232 + P2-line416** working `N <= 50` hard-code と OQ #1 (capacity 8 維持なら N <= 8) の API contract split 解消 → §4.3 acceptance + §8 横断 acceptance 共に **`N_max` 変数表記** に置換、N_max は §10 OQ #1 で B-1 PR 確定 + `layer-constraints` SSOT で書き戻し、`> 50` hard-code 撤去 (本 plan 内に絶対値残さない)。同型 §5.3 episodic acceptance も `N_max_episodic` 変数表記に修正、**P2-line164** §3.2 flow diagram の `~/.desktop-touch-mcp/...` 残存を `%USERPROFILE%\.desktop-touch-mcp\memory\*.json` に修正、**P2-line342** §6.3 acceptance の `~/.desktop-touch-mcp/memory/ui-patterns.json` 残存を `%USERPROFILE%\...` + `os.homedir()` 解決に修正、**P3-line103** §2.1.1 の「本 plan land と同 PR で」 → 「**B-1 land と同 PR で**」修正 (§11.4 carry-over mark と整合、本 plan 起草 PR では ADR-010 を touch せず実装 PR で sync)。Round 3 Opus = Approved 判定だったが Codex が **API contract / runtime path 軸で 6 件追加検出**、Phase A PR #158 (A-2 Codex P1 nested wrapper context overwrite) と同型 pattern。**重要 lesson 再確認**: docs PR でも Codex review は必須、Round N で Opus Approved でも Codex で API contract drift が出る ことを実証 (3 連続再確認: PR #158 / PR #159 (本 PR 軸別) / 本 PR)。Status: Drafted v0.3 → v0.4。 |
| Drafted v0.3 | 2026-05-07 | Claude (Sonnet) | Round 2 Opus phase-boundary review (agentId `a0634dd6bb91d3338`、Conditionally Approved P1×0+P2×2+P3×1) findings 全件反映: **P2-A** ADR-010 §5.6.1 size 上限表 (line 383-385、`working:N (N=10 default、P6)` / `episodic:N (N=5 default、P6)` / フル `working:10+episodic:5`) と本 plan の default 値 SSOT 食い違い (CLAUDE.md §3.1 「見出し / 主要表は注記より強く読まれる」原則直撃) → §11.4 carry-over mark に「B-1 land 時に ADR-010 §5.6.1 P6 行も同 PR で更新」+ B-2 land 時 episodic 同期確認を追記、grep sweep checklist に §5.6.1 を明示組込み、**P2-B** §11.4 line 504 の `architecture-3layer-integrated.md §17.7` を実 section §14 OQ #7 に修正 + grep keyword `working memory の N 上限推奨` 経路化 (line ref drift 注記 §1.6 と同型)、**P3-A** §9 R1 軽減策に ADR-010 §5.6.1 全体上限 < 10KB との関係 1 文追記 (本 plan +5KB は P3-P5 既存 +3.6KB と合算で ~9.6KB ≤ 10KB 内、bench 逸脱時は B-1/B-2 default N 絞 or capacity 見直し)。Round 1 全項目 Resolved 確認済、外部 SSOT (ADR-010 §5.6.1 + architecture §14) drift を修正で plan 内 + 外部 doc 全 fact 整合達成。Status: Drafted v0.2 → v0.3。Round 3 review 待ち。 |
| Drafted v0.2 | 2026-05-07 | Claude (Sonnet) | Round 1 Opus phase-boundary review (agentId `a38677ff05c8c8088`、Conditionally Approved P1×0+P2×5+P3×2) findings 全件反映: **P2-1** Working memory default N=10 → **N=5 に変更** (HISTORY_BUFFER_CAPACITY=8 内に収める) + §4.3 acceptance に `_truncation` notation 必須化 + §10 OQ #1 を「B-1 PR 最初の決定事項」として acceptance に格上げ (silently truncate 防止 strict、ADR-010 §5.6.1 truncation 規約整合)、**P2-2** §3.3 storage 表に Working/Episodic 同 ring 共有設計を明示 (drift 構造的不能、ring SSOT 1 つ)、**P2-3** 永続化 path を `~/.desktop-touch-mcp/...` から `%USERPROFILE%\.desktop-touch-mcp\memory\...` (Windows production、CLAUDE.md launcher 経路整合) + `os.homedir()` 解決 1 文に統一、**P2-4** §10 OQ #8 新設 (B-4 destructive macro suggest 防止の判定 mechanism、3 選択肢 (a) tool registry flag (b) AST 走査 (c) explicit consent、CLAUDE.md Lesson 2 compile-time guard 過信 防御)、**P2-5** §11.4 carry-over 解消 mark を grep keyword 経路 (`scope 外` / `Phase B` / `別 sub-plan` / 4 layer 名) に拡張 + 各 PR review checklist で grep sweep 必須化 (Phase A §3.1 fact 整合 sweep と同型運用) + ADR-010 §6 + architecture §17.7 OQ #7 + Phase A plan §1.4/§5 の 3 doc 同時更新明記、**P3-1** §1.6 SSOT 参照行に OQ #1 への内部リンク (`§10 OQ #1 + §4.3 acceptance 参照`)、**P3-2** §10 OQ #9 新設 (B-3/B-4 privacy banner 実装場所: launcher / server.json / server stderr)。Status: Drafted v0.1 → v0.2、Round 2 review 待ち。 |

---

END OF ADR-011 Phase B Plan (see Status header for current version).
