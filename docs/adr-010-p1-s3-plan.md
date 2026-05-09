# ADR-010 P1 — walking skeleton S3 / G3 alignment (envelope minimal wrapper + compat mode)

- Status: **Drafted (2026-05-01)**
- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.4) §4 **S3** (line 211-231) + §5 **G3 ゲート** (line 343) の最小実装。本 sub-plan は trunk S3 PR の scope を確定する
- Trigger: ADR-008 D2-C S2 impl PR #108 merged 2026-05-01 (`7986838`) + post-merge follow-up PR #109 merged で walking skeleton trunk S2 完了、次 phase = S3 着手可
- 親 plan: `docs/walking-skeleton-trunk-selection.md` §4 S3 (line 211-231) + §6.1 expansion swimlanes + ADR-010 §7 Implementation Phases (P1) + 統合書 §11.2 (compat mode)
- 概念設計: `docs/adr-010-presentation-layer-self-documenting-envelope.md` §5 (envelope schema) + §5.6 (size SLO) + §10 P1 acceptance
- 対象 sub-batch: walking skeleton **S3 (PR 1)** — `_envelope.ts` skeleton + **compat mode** (raw shape default、env / include flag で opt-in envelope) + `desktop_state` のみ実適用 + envelope size SLO bench harness
- 後続: S4 (= `desktop_discover/act` commit 軸 wrapper + lease 4-tuple validation) は **本 S3 merged が前提条件**、既存 envelope skeleton を commit-side にも適用

---

## 0. walking skeleton S3 位置付け note

本 sub-plan は walking skeleton trunk (`docs/walking-skeleton-trunk-selection.md` Proposed v0.4) の **S3 sub-batch**。trunk 選定で「contract spike として最小実装」方針が確定済 (§3.2)。S1 (D2-E0、PR #105) → S2 (D2-C、PR #108) で **L3 view 経路** が確立済、S3 は **L4/L5 envelope 経路の skeleton** を起こし、S4-S6 で commit/causal_by を載せていく base となる:

- S1 (PR-η D2-E0 完了): dataflow scope refactor — `build_*(scope, stream) -> (Arranged, View)` signature 統一
- S2 (PR-ε D2-C 完了): count-only `dirty_rects_aggregate` を S1 の同 scope に追加
- **S3 (★ 本 PR)**: envelope minimal wrapper + compat mode + `desktop_state` 実適用 + size SLO bench
- S4 (PR-?): `desktop_discover/act` commit 軸 wrapper + lease 4-tuple validation
- S5 (PR-? 最重要): `caused_by` linkage cross-layer (★ trunk 最重要 contract)
- S6 (PR-?): trunk 完了判定 + CI assert 化 + expansion plan 起草

S3 は **TypeScript-dominant PR** (engine-perception Rust 改修ほぼなし、小さな napi getter 追加検討あり)。production code 改修だが scope が L5 wrapper + 1 tool に局限され、Rust 慎重コストは低い。Walking skeleton §4.1 line 304 の通り **Codex re-review は skip 可** (Opus 1 round で十分、ただし phase 境界 plan PR は推奨)。

**G3 ゲートの目標** (`docs/walking-skeleton-trunk-selection.md` §4 S3 完了基準 line 223-228):

| # | walking-skeleton §4 S3 目標 | 本 sub-plan 検証手段 |
|---|---|---|
| 1 | 既存 LLM session で `desktop_state` 回帰 0 (raw shape 期待 e2e test 無修正で pass) | §3.5 既存 vitest unit + e2e tests を **compat mode default** で回す、無修正 pass |
| 2 | envelope skeleton のサイズ < 1KB (ADR-010 §5.6.1) | §3.6 envelope size bench harness で計測、CI で 5% warning / 20% fail (ADR-010 §5.6.2) |
| 3 | `_version: "1.0"` stamp | §3.3 `_envelope.ts` の skeleton 関数で固定 stamp |
| 4 | `confidence` が `fresh` / `degraded` の 2 値で観測される integration test | §3.5 `confidence` field に対する pin test 追加 (size 超過で degraded、通常 fresh) |
| 5 | envelope size SLO の CI bench harness が main で動く | §3.6 `benches/l4_envelope_size.mjs` 新設、CI 統合は §3.7 |
| 6 | **G3 ゲート判定**: commit wrapper と既存 ToolCallStarted/Completed event payload 確定が `desktop_discover/act` の挙動を壊していない、`LeaseExpired` typed reason が 1 path 動作 | (※ G3 は S4 完了時、本 PR scope 外。S3 完了時は G3 判定材料を S4 に持ち越す形) |

**review 観点の再定義**: 本 PR は「envelope の完成度」ではなく **「S3/G3 contract が最短で検証できるか + S4 commit 軸 wrapper で mechanical コピーで進められる base が固まっているか」** で評価する。`caused_by` / `if_unexpected` / `query_past` 等の他フィールドは S4-S5 で追加、本 S3 では skeleton のみ。

---

## 1. Scope (trunk / expansion / carry-over の 3 分類)

### 1.1 [S3 trunk] 本 sub-plan で扱う (G3 contract 必須)

A. **`src/tools/_envelope.ts` 新設** — `wrapEnvelope(rawData, options)` skeleton 関数 (= server SSOT envelope 組立て) + `_version: "1.0"` 固定 stamp + `as_of.wallclock_ms` + `confidence: "fresh" | "degraded"` 2 値分岐
B. **compat mode 必須** (統合書 §11.2 SSOT、Round 2 で書き直し): server は **常に envelope shape を組立てる** (= envelope SSOT)。**default では `data` field を top-level に hoist して raw shape を return** (compat layer = post-assembly flatten)。opt-in flag (env `DESKTOP_TOUCH_ENVELOPE=1` or `include=["envelope"]`) で hoist せず envelope shape 直接 return。設計上 `confidence: degraded` 監視 / `as_of` self-attestation / size SLO 計測は **default 経路で常時有効**、既存 LLM client (Claude CLI 等 raw shape 期待) には post-flatten で raw shape を return することで互換性維持 (Opus PR #110 Round 1 P1-2 反映)
C. **`src/tools/desktop-state.ts` を envelope 経由に置換** (skeleton のみ、`caused_by` / `if_unexpected` / `query_past` は S4/S5 で carry-over) — `desktop_state` は **`withPostState` を使用しない** (action tool 専用 wrapper、`browser_click` / `browser_eval` / `browser_navigate` 等)、handler 末尾の `ok({...})` 出力を **L5 wrapper helper 経由で envelope 化** (Opus PR #110 Round 1 P1-1 反映、ADR-010 §1.5 「L5 wrapper が一元解釈、tool 個別実装は修正不要」と整合)
D. **`as_of.wallclock_ms` の source 確定** — **L1 event wallclock を採用** (Opus PR #110 Round 1 P1-4 反映)。napi 拡張 (`view_get_focused_with_wallclock` 等) で view が観測した最新 L1 event の wallclock を expose、Date.now() approximation は不採用 (semantic 反転回避、ADR-010 §5 / §4.1 Provenance integral、CLAUDE.md §3.2 既存 LLM client 破壊禁止)
E. **`confidence` 2 値判定** — `fresh` default、size 超過時 / view poisoned 時 / `view_focused_pipeline_status.poisoned == true` 時 `degraded` 降格 (`if_unexpected.most_likely_cause: "EnvelopeSizeExceeded"` は本 trunk 段階では typed enum を**含めず**、text-only marker で carry-over)
F. **L5 wrapper helper 新設** — `_envelope.ts` 内 `makeEnvelopeAware(handler, toolName)` + `withEnvelopeIncludeSchema(baseShape)` 共通 wrapper helper (Opus PR #110 Round 1 P1-3 反映、ADR-010 §1.5 横断 optional 引数 spec、impl PR #112 Round 1 P1 修正反映)。`include` 引数は **registration site で `withEnvelopeIncludeSchema` が generic に schema injection** + **runtime で `makeEnvelopeAware` が peek + strip**。tool source file 自体には `include` 宣言を追加しない (ADR-010 §1.5 spirit 維持、schema injection 自体も L5 wrapper helper の責務に閉じる)。S4 commit 軸 wrapper への mechanical コピーで同 helper pair (`withEnvelopeIncludeSchema` + `makeCommitWrapper`) を貼るだけで両軸 cover (= 「同じ Zod field を毎回 tool 個別 schema に貼る」反復を回避)。impl PR Round 1 教訓 (Codex P1 + Opus P1-1): MCP SDK + `run_macro` どちらも `z.object(schema).parse(args)` を経由するため schema injection 必須、registration site 1 箇所追加 (registration schema export + macro registry の同 instance 参照) で両経路 cover
G. **envelope size SLO bench harness 新設** — `benches/l4_envelope_size.mjs` (Node bench、既存 `benches/d1_ts_baseline.mjs` 同型 pattern) + bench で `desktop_state` の minimal/degraded 両 envelope size を計測 (envelope 段階で計測、hoist 後ではなく)、CI artifact 経由保存 (gitignored、Round 2 P2-2 反映)、5% 増 warning / 20% 増 fail (ADR-010 §5.6.2、G3 #2 必須)
H. **G3 ゲート判定 + Appendix C append** — `docs/walking-skeleton-trunk-selection.md` Appendix C 末尾に `| G3 | 2026-05-XX | (継続/shrink) | (...) | (...) |` を append (本 sub-plan §3.6、impl PR merge 後に実施、ledger 永続化、§3.6 D2-E0-6 と同 pattern)

### 1.2 [expansion] G3 通過後の expansion phase で実装 (本 PR scope 外)

trunk 完了 (G3 通過) 後の expansion phase で実装、本 PR では scope 外として明示:

- **全 tool への envelope rollout**: 本 trunk では `desktop_state` 1 tool のみ。残 ~25 tool (`click_element` / `mouse_click` / `keyboard` / `screenshot` 等) への envelope wrap rollout は L5 swimlane で worktree 並走 (`docs/walking-skeleton-trunk-selection.md` §6.1 line 363)
- **accurate `as_of.wallclock_ms`** (L1 event 由来): napi getter 追加 (`view_get_latest_focus_wallclock() -> Option<u64>` 等) or 既存 `view_focused_pipeline_status` 拡張で view が観測した最新 L1 event の wallclock を expose、Date.now() approximation を置換 (§1.3 OQ #1)
- **`confidence` 残 3 値**: `cached` / `inferred` / `stale` 判定ロジック (cache hit detection / view freshness threshold / time-since-last-event 等)、ADR-010 §17.6.1 値域 SSOT を完全実装
- **envelope `if_unexpected.most_likely_cause` typed enum 化**: ADR-010 §5.4 の 37 typed reason codes 全網羅、`_errors.ts::SUGGESTS` を typed `try_next: TypedAction[]` に進化させる (P2 work、ADR-010 §10 P2 acceptance)
- **`include` 引数 routing**: ADR-010 §5.2 の `causal` / `invariants` / `time_travel` / `working:N` / `episodic:N` の各 include 値の routing 実装 (P3-P6 work)
- **subscribe API envelope**: ADR-008 D2 subscribe 系 tool への envelope 適用 (`docs/adr-010-presentation-layer-self-documenting-envelope.md` §11 OQ #7)

### 1.3 [carry-over] §3.bis ledger / OQ で永続化 (別 phase)

- **OQ #1 — `_post.ts` (existing) と `_envelope.ts` (new) の役割境界 (`desktop_state` 経路は本 S3 で共存問題発生せず)** (Opus Round 1 P1-1 再 framing): `desktop_state` は **`withPostState` を使用しない** (action tool 専用 wrapper) ため、本 trunk では役割境界判断不要。S5 で `desktop_act` (action tool) の commit response wrapper 化時、または S6 finalize で expansion 着手時に役割境界 (統合 / 共存維持) を判断する形に再 framing。本 sub-plan §8 OQ #1 で carry-over
- **既存 LLM client 破壊禁止 (CLAUDE.md §3.2 PR #102 教訓延長)**: compat mode (server 常に envelope 組立て + default `data` hoist) が既存 raw shape 互換を構造で担保、既存 e2e test 無修正 pass を §3.5 で pin (Opus Round 1 P1-2 反映)
- **`as_of.wallclock_ms` semantic 反転回避** (Opus Round 1 P1-4 反映): 本 trunk で **L1 event wallclock を採用** することで、後続 P3 で `freshness_ms = now - as_of.wallclock_ms` を加えた時の意味論が反転しない。Date.now() approximation を採用すると `freshness_ms` が常に 0 になり、後で source 切替時に既存 LLM client 破壊 (CLAUDE.md §3.2 PR #102 P5c-2 同型 risk) が発生するため不採用
- **bench scenario 5 (`viewFocusedPipelineStatus` per-call latency 計測)** (impl PR #112 Round 1 Opus P2-3 反映): 当初 §2.7 / §3.5 で要求した「scenario 5: `viewFocusedPipelineStatus()` per call latency p50/p99 計測」は impl PR では size 計測のみ実装、latency 計測 scenario は不在。`viewPoisoned` 取得 overhead を quantify する §7 R3/R7 mitigation baseline は **expansion ledger に carry-over** (別 PR で `criterion` 等の native bench harness を新設して計測、size bench とは別軸の latency 専用 bench)。本 trunk は size bench 6 scenario (minimal / typical / cursor / screen / document + UTF-8 byte 検証用 japanese) で SLO compliance pin、latency 計測は §7 R3 「`fetchMeta` overhead p99 < 1ms」を後続 PR で確認する acceptance に bump

### 1.4 北極星整合 + walking skeleton G3 contract

- **N1 (pivot 必ず保持)**: envelope の `as_of.wallclock_ms` + 後続 S5 で `caused_by.based_on.events: [event_id]` が L1 event_id pivot を carry — 本 trunk では `as_of` のみで N1 partial 充足
- **N2 (watermark で frontier 進行)**: envelope は read-only projection、worker frontier 進行に影響しない (impact なし)
- **CLAUDE.md 強制命令 3.1 (ADR/plan 複数表 fact 整合)**: 本 PR では sub-plan / 親戦略 walking-skeleton §4 S3 / ADR-010 §5 / 統合書 §11.2 / 既存 `_post.ts` の 4 SSOT を bit-equal に揃える
- **CLAUDE.md 強制命令 3.2 (carry-over scope shrink、PR #102 教訓)**: compat mode 必須 — **既存 raw shape を default で維持** することは「既存 public API の正しい振る舞いを破壊しない」軸の最重要適用例、PR #102 教訓を envelope 化に拡張
- **walking skeleton G3 contract**: S4 で `desktop_discover/act` の commit-side response も同じ envelope skeleton を **mechanical コピー** で wrap できる base が固まること。本 PR の `wrapEnvelope` 関数 + compat mode が S4 着手時の template として機能する

---

## 2. 設計判断

### 2.1 `_envelope.ts` 新 API (Opus PR #110 Round 1 P1-2/P1-3 反映)

#### [S3 trunk] skeleton 関数 + L5 wrapper helper

```typescript
// src/tools/_envelope.ts

export interface EnvelopeMinimalShape<T = unknown> {
  /** Schema version (ADR-010 §5、`_version: "1.0"` for P1). */
  _version: "1.0";
  /** Tool-specific result (raw shape the tool's handler computed). */
  data: T;
  /** Self-attestation: when the data was observed.
   *  **`wallclock_ms` is the L1 event wallclock** (ADR-010 §5 + §4.1
   *  Provenance: `freshness_ms = now - as_of.wallclock_ms`),
   *  NOT server-side `Date.now()`. Falls back to `Date.now()` only
   *  when no view event has been observed yet (initial spawn,
   *  pipeline poisoned). The source distinction is permanent:
   *  switching source post-P1 reverses `freshness_ms` semantic and
   *  breaks LLM clients (CLAUDE.md §3.2 PR #102 P5c-2 教訓 同型). */
  as_of: { wallclock_ms: number };
  /** Confidence: `fresh` (default) / `degraded` (size-over OR view-poisoned).
   *  S3 trunk: 2-value subset; `cached` / `inferred` / `stale` lands in expansion. */
  confidence: "fresh" | "degraded";
}

export interface EnvelopeOptions {
  /** Pre-computed view-poisoned signal (caller passes
   *  `await viewFocusedPipelineStatus()` result so we don't
   *  re-call per envelope). */
  viewPoisoned?: boolean;
  /** L1 event wallclock from view (caller reads via napi getter
   *  added in this PR). When `null/undefined`, falls back to
   *  `Date.now()` (initial spawn / pipeline poisoned cases). */
  asOfWallclockMs?: number;
}

/**
 * Build the server-side envelope SSOT shape for a tool's raw result.
 *
 * **Server is always envelope-first** (統合書 §11.2 SSOT、ADR-010
 * §2.1 #1): the tool handler's raw result is always wrapped in
 * envelope shape with `_version` + `as_of` + `confidence`
 * self-attestation. Compat mode (= post-assembly flatten) is
 * applied by `compatHoist()` below, NOT by skipping envelope
 * assembly — that way `confidence: degraded` monitoring +
 * `as_of` provenance + size SLO measurement all work for default
 * raw-shape clients too.
 */
export function buildEnvelope<T>(
  data: T,
  options?: EnvelopeOptions,
): EnvelopeMinimalShape<T>;

/**
 * Compat mode: hoist `data` field to top-level when caller
 * expects raw shape (default behaviour for existing LLM clients).
 *
 * Returns:
 * - `envelope.data` (raw shape, top-level hoist) when `optInEnvelope=false`
 * - `envelope` unchanged (envelope shape) when `optInEnvelope=true`
 *
 * **Priority chain** for `optInEnvelope`:
 * 1. `include=["raw"]` (per-call explicit raw, overrides env) → false
 * 2. `include=["envelope"]` (per-call explicit envelope) → true
 * 3. env `DESKTOP_TOUCH_ENVELOPE=1` (server-wide default to envelope) → true
 * 4. Default (no per-call, no env) → false (raw shape, compat mode)
 *
 * Resolved by `resolveEnvelopeOptIn(include?)` — see below.
 */
export function compatHoist<T>(
  envelope: EnvelopeMinimalShape<T>,
  optInEnvelope: boolean,
): T | EnvelopeMinimalShape<T>;

/**
 * Resolve the envelope opt-in priority chain. Pure function over
 * `(include, env)` so test fixtures can pin both modes
 * deterministically without mutating process env.
 */
export function resolveEnvelopeOptIn(
  include: string[] | undefined,
  envValue?: string,
): boolean;

/**
 * **L5 wrapper helper** (ADR-010 §1.5 SSOT: `include` / `dry_run` /
 * `as_of` 等は L5 wrapper が一元解釈、tool 個別実装は修正不要)。
 *
 * Wraps a tool handler so that:
 * 1. The handler's raw `ok({...})` output is envelope-built (always).
 * 2. The `include` arg is **peeked + stripped** at the wrapper layer
 *    BEFORE handler invocation, so tool individual Zod schemas do
 *    NOT need to declare `include` themselves.
 * 3. compat hoist is applied based on `resolveEnvelopeOptIn`.
 *
 * Returns the wrapped handler. Used at MCP server registration
 * site (`src/server.ts` or per-tool `register*` functions), not
 * inside individual tool handlers.
 */
export function makeEnvelopeAware<TArgs, TData>(
  handler: (args: TArgs) => Promise<{ data: TData; viewPoisoned?: boolean; asOfWallclockMs?: number }>,
  toolName: string,
): (rawArgs: TArgs & { include?: string[] }) => Promise<TData | EnvelopeMinimalShape<TData>>;

/**
 * Compute estimated payload size of an envelope (or raw shape).
 * Used by the size SLO bench harness + the `confidence: degraded`
 * downgrade trigger when envelope size exceeds the per-Phase
 * threshold (ADR-010 §5.6.1).
 */
export function envelopePayloadSizeBytes(payload: unknown): number;

/** Minimal-envelope size threshold (ADR-010 §5.6.1: `< 1KB` for P1). */
export const ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES: number;
```

### 2.2 compat mode の方向 (Opus PR #110 Round 1 P1-2 反映、統合書 §11.2 SSOT 準拠)

**Server は常に envelope SSOT shape を組立てる** (`buildEnvelope` always called)、compat layer は **post-assembly flatten** (`compatHoist` で `data` を top-level hoist) で raw shape を return する。Round 1 で書いた逆方向 (default raw 維持、opt-in で envelope assembly) は **統合書 §11.2 line 531 + ADR-010 §2.1 #1** と意味が反対だったため reverse:

| 観点 | Round 1 (誤) | Round 2 (正、SSOT 準拠) |
|---|---|---|
| envelope 組立て | opt-in 時のみ assembly、default skip | **常に assembly** (server SSOT shape) |
| `confidence: degraded` 監視 | opt-in 時のみ動作 | **default 経路でも動作** |
| `as_of` self-attestation | opt-in 時のみ計測 | **default 経路でも計測** |
| size SLO bench harness 計測対象 | opt-in 時の envelope only | **envelope 段階で常時計測** (hoist 後ではなく) |
| compat layer | envelope assembly skip | **`data` field を top-level hoist で flatten** |
| ADR-010 P1 acceptance line 477「全 tool が envelope 形式で応答、既存 LLM session で回帰 0」 | **不成立** (envelope 形式で応答 ≠ default skip) | **成立** (envelope 形式で応答 = 内部 SSOT shape は envelope、回帰 0 = compat hoist で raw shape return) |

#### [S3 trunk] flow

```
tool handler invocation
    │
    ├─ handler returns raw `{...}` (data 部分)
    │
    ▼
[L5 wrapper layer] makeEnvelopeAware
    │
    ├─ buildEnvelope(rawData, options)
    │     ├─ envelope assembly: { _version: "1.0", data: rawData, as_of, confidence }
    │     ├─ as_of.wallclock_ms ← L1 event wallclock (caller passed asOfWallclockMs、
    │     │                       絶対 fallback Date.now())
    │     └─ confidence: "fresh" | "degraded" (size + viewPoisoned 判定)
    │
    ├─ resolveEnvelopeOptIn(args.include, env DESKTOP_TOUCH_ENVELOPE)
    │     ├─ include=["raw"]      → false (raw、env override)
    │     ├─ include=["envelope"] → true  (envelope)
    │     ├─ env=1                → true  (envelope)
    │     └─ default              → false (raw、compat mode)
    │
    ▼
[compatHoist] envelope or post-flatten raw
    │
    ├─ optIn=true  → return envelope (full shape)
    └─ optIn=false → return envelope.data (top-level hoist, raw shape)
```

### 2.3 compat mode opt-in priority chain 詳細

Default behavior: **server は envelope を常に assembly + post-flatten で raw shape return** (compat mode default). Opt-in via either:

- **env**: `DESKTOP_TOUCH_ENVELOPE=1` set at server start → server-wide default to envelope shape (skip post-flatten)
- **per-call include argument**: `desktop_state(include=["envelope"])` → forces envelope on for that call only
- **per-call override**: `desktop_state(include=["raw"])` → forces raw on for that call only (override env)

**Priority order** (highest to lowest):
1. Per-call `include=["raw"]` (explicit raw request、overrides env) → raw (post-flatten)
2. Per-call `include=["envelope"]` → envelope (no flatten)
3. env `DESKTOP_TOUCH_ENVELOPE=1` → envelope (no flatten)
4. Default → raw (compat mode、post-flatten、既存 LLM client 互換)

The `include` arg is **NOT added to tool individual Zod schemas** (Round 1 P1-3 反映、ADR-010 §1.5 SSOT)。代わりに **MCP server 登録 layer の `makeEnvelopeAware` wrapper で `args.include` を peek + strip**、tool handler には `include`-stripped args を渡す。env は server startup 時に 1 回 cache、test では `resolveEnvelopeOptIn(include, envValue)` が pure 関数なので `vi.stubEnv` 不要で test 駆動可能。

### 2.4 `desktop_state` での適用 (Opus PR #110 Round 1 P1-1 反映)

#### [S3 trunk] desktopStateHandler 内変更点

`desktop_state` は **`withPostState` を使用しない** (action tool 専用 wrapper、`browser_click` / `browser_eval` / `browser_navigate` のみ使用、`grep -rn "withPostState" src/tools/desktop-state.ts` で 0 件確認済)。本 PR では **MCP server 登録 site で `makeEnvelopeAware` L5 wrapper を `desktopStateHandler` の outer に挿入**:

```typescript
// src/tools/desktop-state.ts (登録部)
mcp.tool(
  "desktop_state",
  desktop_state_schema,  // Zod schema 不変、include は追加しない
  makeEnvelopeAware(desktopStateHandler, "desktop_state"),
);
```

`makeEnvelopeAware` は:
1. raw args (= `{...} & { include?: string[] }`) を受け取り
2. `args.include` を peek + strip して `desktopStateHandler` に渡す (handler 個別実装は include を意識しない、ADR-010 §1.5)
3. handler の返り値 (`ok({...})` 経由 ToolResult) から data を抽出
4. `buildEnvelope(data, { viewPoisoned, asOfWallclockMs })` で envelope assembly
5. `compatHoist(envelope, resolveEnvelopeOptIn(args.include))` で compat 経由 hoist or envelope return

`desktopStateHandler` 自体は **無修正** (handler 内の logic / Zod schema / 戻り値 shape 不変、`withPostState` 不使用も維持)。`viewPoisoned` / `asOfWallclockMs` は handler 内で取得して `ok({..., __envelope_meta: { viewPoisoned, asOfWallclockMs }})` 等の sentinel field 経由で wrapper に渡す (alternative: handler signature を `Promise<{ data: T; viewPoisoned?: boolean; asOfWallclockMs?: number }>` に変更、より cleanup)。**実装方針確定は impl PR で**、S3 sub-plan は contract のみ pin。

#### [carry-over] OQ #1 — `_post.ts` (existing) と `_envelope.ts` (new) の役割境界

`desktop_state` 経路では `withPostState` 不使用のため、本 trunk では役割境界判断不要。S5 で `desktop_act` (action tool、`withPostState` 使用) の commit response wrapper 化時に判断:
- (a) 統合: `_post.ts` の `post` block を `_envelope.ts` envelope の `caused_by` 系セクション (ADR-010 §5.2 `caused_by.your_last_action` / `produced_changes`) に移行
- (b) 共存維持: post block を ADR-010 envelope の `caused_by` の **L4 narration extension** として `caused_by.post_state: PostState` 等の sub-field 化、独立 layer 維持

判断は **S5 着手時** に確定 (本 sub-plan §8 OQ #1 で永続化)。

### 2.5 `as_of.wallclock_ms` source — L1 event wallclock 採用 (Opus PR #110 Round 1 P1-4 反映)

ADR-010 §5 schema line 191-198 + §4.1 Provenance で `as_of.wallclock_ms` は **L1 event の wallclock** ("based on UIA event #87 at wallclock_ms=...")、`freshness_ms = now - as_of.wallclock_ms` の起点。Date.now() approximation 採用すると `freshness_ms` が常に 0 (= now - now)、後続 P3 で `freshness_ms` field 追加時に意味論反転 → 既存 LLM client 破壊 (CLAUDE.md §3.2 PR #102 P5c-2 同型 risk) のため **不採用**。

**本 trunk で L1 event wallclock source 確定**:

- **napi 拡張**: `view_get_focused_with_wallclock() -> Option<NativeFocusedElementWithWallclock>` を engine-perception + `src/l3_bridge/mod.rs` に新設 (~30-50 line Rust 改修)
  ```rust
  #[napi(object)]
  pub struct NativeFocusedElementWithWallclock {
      pub focused: NativeFocusedElement,
      pub latest_event_wallclock_ms: BigInt,
      pub view_poisoned: bool,
  }
  ```
- **engine-perception view 拡張**: `LatestFocusView` に最新 event の wallclock_ms を保持する内部 field 追加 (S2 で touch した dirty_rects_aggregate と同型 pattern、apply_diff 時に最新 logical_time の `first` field を別 atomic に store)
- **fallback**: view が空 (initial spawn、no event observed) or `view_poisoned == true` 時は **`Date.now()` 採用** (代替 source)、`confidence: "degraded"` 降格して LLM client に通知

これにより S3 で source 確定 → P3 で `freshness_ms` 追加時に意味論反転なし、CLAUDE.md §3.2 既存 LLM client 破壊禁止を構造で担保。

**Trade-off**: 本 trunk size 200-300 line → **+50 line Rust 改修 + bench harness + CI workflow + 8 contract test で 250-400 line** に格上げ、Codex re-review 1 round 必須化 (§5 / §3.7 sync 済)。

### 2.6 `confidence` 2 値分岐 (size 超過 + view poisoned 判定)

- **`fresh`** (default): envelope size < `ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES` (= 1024 bytes、ADR-010 §5.6.1) AND view non-poisoned
- **`degraded`**: 上記いずれかの条件 fail
  - size 超過: `JSON.stringify(envelope).length > 1024` (envelope 全体 size 推定)
  - view poisoned: `view_focused_pipeline_status.poisoned === true` (D2-B-1 で expose 済 napi binding)

実装上 `wrapEnvelope` は:
1. envelope skeleton 構築 (`fresh` 仮定で size 推定)
2. size > threshold OR view poisoned → `confidence: "degraded"` 上書き
3. final shape return

`if_unexpected.most_likely_cause: "EnvelopeSizeExceeded"` typed enum stamp は **本 trunk では含まない** (§1.1 E)、ADR-010 §5.4 typed reason 全網羅は P2 expansion。

### 2.7 envelope size SLO bench harness (G3 #2/#5、Opus Round 1 P2-1/P2-2 反映)

- **bench file**: `benches/l4_envelope_size.mjs` (既存 `benches/d1_ts_baseline.mjs` / `benches/d2_desktop_state_roundtrip.mjs` 同型 pattern、Node script)
- **計測対象**: `desktop_state` の **envelope 段階 (post-flatten 前)** で計測 (server SSOT shape を計測対象、Round 2 P1-2 sync)。`buildEnvelope` 結果を直接 `JSON.stringify().length`、4 シナリオ:
  1. **Minimal envelope, no events**: 起動直後の envelope size
  2. **Minimal envelope, after 10 focus events**: 通常負荷時 size
  3. **Minimal envelope, after 1 dirty rect event**: dirty rect view も active 時
  4. **Degraded envelope (induced via large `data` or view-poisoned)**: confidence: degraded 経路の envelope size
- **`viewPoisoned` 取得 overhead 計測** (Opus Round 1 P2-1 反映): bench harness に **シナリオ 5** 追加 — `await viewFocusedPipelineStatus()` per call の平均 latency と p99 を測定、`desktop_state` p99 (D2-B PR #98 で 6.22ms 計測済) に乗る overhead を quantify。impl PR で実測値を §1.1 E size 判定 logic + §7 R3 / R7 size threshold mitigation の baseline として反映
- **size threshold 1024 byte 確定 timing** (Opus Round 1 P2-3 反映): impl PR の **§3 sub-batch S3-1 (envelope helper 実装) + S3-3 (desktop-state 統合) 統合直後**に bench harness (S3-5) 1 回先行実行 → `desktop_state` の minimal envelope size 実測 → `ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES` 確定 (現状 1024 仮値、超過 risk 高なら ADR-010 §5.6.1 を 2KB / 4KB に bit-equal sync で expansion で再調整、§7 R3 mitigation)
- **CI 連携** (G3 #5): `.github/workflows/bench-envelope-size.yml` (新設) で main push 時に実行、前回 main の bench 結果と比較:
  - 5% 増 → warning (`continue-on-error: true` で job fail しないが notification)
  - 20% 増 → fail (PR merge block)
- **結果保存**: `benches/results/l4_envelope_size_*.json` を **gitignored + GitHub Actions artifacts で保存** (Opus Round 1 P2-2 反映、CI auto-commit を main 直 push する設計 = CLAUDE.md §8 spirit と整合性低い → artifacts pattern 採用)。前回比較は GitHub API で前 run の artifact を取得 (Actions Workflow で `actions/download-artifact@v4` + 比較 script)
- **bench 計測 jitter mitigation** (Opus Round 1 P2-7 反映、※ 番号は §7 Risks 元): warm-up runs ≥ 5、3 回計測の median 採用、外れ値除外なし

### 2.8 既存 caller への影響範囲 (Opus Round 1 P1-3 + impl PR Round 1 P1 反映、ADR-010 §1.5 SSOT 準拠)

**impl PR #112 Round 1 修正** (Codex P1 + Opus P1-1): 当初設計「**Zod schema は無修正** (`include` field は tool individual schema に追加しない)」は **MCP SDK の Zod parse 挙動 (unknown key strip) を見落とした設計バグ**。MCP SDK / `run_macro` dispatcher どちらも `z.object(schema).parse(args)` を経由するため、`include` field を schema に明示しないと **handler 呼び出し前に silent strip され per-call opt-in が機能不能**。

修正後設計 (impl PR で確定): tool source file は **依然 `include` を declare しない** (ADR-010 §1.5 spirit 維持) が、registration site で **L5 wrapper helper `withEnvelopeIncludeSchema(baseShape)` が generic に `include?: string[]` を inject** する。schema injection も wrapper helper の責務、tool 実装は envelope-agnostic。

```typescript
// src/tools/desktop-state.ts (impl PR で実装、PR #112 Round 1 P1 修正反映)
import { makeEnvelopeAware, withEnvelopeIncludeSchema } from "./_envelope.js";

// 1. wrapper-layer schema injection (`include?: string[]` 追加)
export const desktopStateRegistrationSchema = withEnvelopeIncludeSchema(desktopStateSchema);

// 2. envelope-aware handler (peek + strip + envelope build + compat hoist)
export const desktopStateRegistrationHandler = makeEnvelopeAware(
  desktopStateHandler,
  "desktop_state",
  { fetchMeta: fetchEnvelopeMeta },
);

// 3. 両 registration site (server.tool + run_macro) で同 module-scope instance 再利用
server.tool("desktop_state", desktopStateRegistrationSchema, desktopStateRegistrationHandler);
// → macro.ts TOOL_REGISTRY も z.object(desktopStateRegistrationSchema) 経由
```

これにより:
- 既存 LLM client (引数指定なし default invocation): `args.include === undefined` → wrapper が default raw mode 経由で `data` field を hoist → 既存 raw shape return → **既存 e2e test 無修正 pass** (§3.5 G3 #1 必須)
- 新 LLM client (envelope opt-in): `args.include = ["envelope"]` → schema injection で Zod parse を survive → wrapper が peek → envelope mode 経由で envelope shape return
- `run_macro({tool:"desktop_state", args:{include:["envelope"]}})` 経由も同 module-scope schema + handler を経由するため同等動作 (Opus P1-1 同型 strip 防止)
- S4 mechanical コピー: `desktop_discover/act` 等の commit 軸 wrapper に同 helper pair (`withEnvelopeIncludeSchema` + `makeCommitWrapper`) を貼る、tool 個別 schema 改修なし、ADR-010 §1.5「L5 wrapper が一元解釈、tool 個別実装は修正不要」と完全整合 (= schema injection は L5 wrapper helper の責務、tool source 不変)

他 tool は本 trunk で envelope 化しない (expansion で rollout、§1.2)。`_post.ts::withPostState` も本 trunk で touch なし — `desktop_state` 経路は元々不使用、action tool への適用は S5 で OQ #1 解消時に判断。

---

## 3. 実装 sub-batch (本 PR 内、S3 trunk scope)

### 3.1 S3-1: `_envelope.ts` skeleton 関数 + L5 wrapper helper (~120 line) [S3 trunk]

- [ ] `src/tools/_envelope.ts` 新設:
  - [ ] `EnvelopeMinimalShape<T>` interface 定義 (§2.1)
  - [ ] `EnvelopeOptions` interface (`viewPoisoned` + `asOfWallclockMs`)
  - [ ] `buildEnvelope<T>(data, options)` 実装 (server SSOT envelope assembly、`as_of.wallclock_ms` ← `options.asOfWallclockMs ?? Date.now()` fallback、`confidence` 2 値判定)
  - [ ] `compatHoist<T>(envelope, optInEnvelope)` 実装 (post-assembly flatten)
  - [ ] `resolveEnvelopeOptIn(include, envValue?)` pure 関数 (priority chain §2.3 実装、test 駆動可能)
  - [ ] `makeEnvelopeAware(handler, toolName)` L5 wrapper helper 実装 (§2.4)
  - [ ] `envelopePayloadSizeBytes(payload)` helper (`JSON.stringify(payload).length` ベース)
  - [ ] `ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES` const (S3-3 で baseline 計測後確定、初期値 1024)
- [ ] doc comment に ADR-010 §5 schema + 統合書 §11.2 compat mode + §1.5 横断 optional 引数 reference 追記
- [ ] env `DESKTOP_TOUCH_ENVELOPE` parsing (server startup 時 1 回、cached、`process.env.DESKTOP_TOUCH_ENVELOPE === "1"` 判定)

### 3.2 S3-2: napi 拡張 — `view_get_focused_with_wallclock` (~50 line Rust) [S3 trunk、Rust 改修]

- [ ] `crates/engine-perception/src/views/latest_focus.rs`:
  - [ ] `LatestFocusView` 内部 state に `latest_event_wallclock_ms: Arc<AtomicU64>` 追加
  - [ ] `apply_diff` 時に最新 logical_time の `first` field (= wallclock_ms) を atomic に store (S2 D2-C `dirty_rects_aggregate` の atomic counter 同型)
  - [ ] `LatestFocusView::latest_event_wallclock_ms() -> Option<u64>` 公開 method (`Some(0)` 値は no-event-yet 扱いで `None` に降格)
- [ ] `src/l3_bridge/mod.rs`:
  - [ ] `NativeFocusedElementWithWallclock` napi struct 新設 (§2.5)
  - [ ] `view_get_focused_with_wallclock() -> NativeFocusedElementWithWallclock` napi binding 新設、既存 `view_get_focused()` は不変 (backward compat)
  - [ ] `wallclock_ms` を `BigInt` で expose
- [ ] `index.d.ts` + `src/engine/native-types.ts` に新型 + 新 fn 追記、`check:native-types` で 47 → 48 napi exports に bump

### 3.3 S3-3: `desktop-state.ts` 統合 + size threshold baseline 計測 (~40 line) [S3 trunk]

- [ ] `src/tools/desktop-state.ts`:
  - [ ] **Zod schema は registration 経路で `withEnvelopeIncludeSchema(desktopStateSchema)` 経由で `include?: string[]` 注入** (impl PR Round 1 P1 反映: 旧版「Zod schema 無修正」は MCP SDK の Zod parse 挙動 = unknown key strip を見落とした設計バグ、`include` を schema 宣言なしで passthrough 不能、§2.8 修正後 SSOT)
  - [ ] tool source file 自体には `include` 宣言を**追加しない** (ADR-010 §1.5 spirit 維持、registration site で wrapper helper が injection 担当)
  - [ ] `desktopStateRegistrationSchema` + `desktopStateRegistrationHandler` を module-scope で export (`server.tool` + `run_macro` 両 registration site で同 instance 再利用、Opus P1-1 同型 strip 防止)
  - [ ] `fetchEnvelopeMeta` を module-scope helper として定義: `viewGetFocusedWithWallclock()` 呼出 → `viewPoisoned` + `asOfWallclockMs` 抽出、napi 失敗時は `(true, null)` 返却で `confidence: degraded` fallback
- [ ] MCP server 登録部 (`src/server.ts` or 同等):
  - [ ] `mcp.tool("desktop_state", desktopStateRegistrationSchema, desktopStateRegistrationHandler)` (module-scope wrapped instance 経由)
- [ ] `src/tools/macro.ts` の `TOOL_REGISTRY.desktop_state`:
  - [ ] `{ schema: z.object(desktopStateRegistrationSchema), handler: desktopStateRegistrationHandler }` で同 module-scope instance を使用 (Opus P1-1: `run_macro` 経由でも同型 strip risk があり、両 registration site で同 wrapped instance を共有することで cover)
- [ ] **size threshold baseline 計測** (Opus Round 1 P2-3 反映): S3-1 + S3-3 統合直後に `npm run bench:envelope-size` 1 回実行 → `desktop_state` minimal envelope size 実測 → 1024 byte 超過 risk 確認、必要なら `ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES` を 2048 byte 等に確定 (4 SSOT bit-equal sync: §1.1 G + §2.6 + §7 R3 + ADR-010 §5.6.1)

### 3.4 S3-4: `desktop_state` envelope contract test (~80 line) [S3 trunk]

- [ ] `tests/unit/desktop-state-envelope.test.ts` 新設:
  - [ ] **Test G3-1**: default (env unset, no include) → raw shape return (post-flatten)、既存 `desktopStateHandler` 戻り値と bit-equal (= 既存 e2e test 無修正 pass の単位 test 版)
  - [ ] **Test G3-2**: `include=["envelope"]` → envelope shape 返却、`_version: "1.0"` / `data` / `as_of.wallclock_ms` / `confidence` 4 field 必須
  - [ ] **Test G3-3**: env `DESKTOP_TOUCH_ENVELOPE=1` mock (envValue 引数経由 `resolveEnvelopeOptIn` 駆動) → envelope shape
  - [ ] **Test G3-4**: `include=["envelope", "raw"]` (両指定) → priority chain で raw 優先 (§2.3)
  - [ ] **Test G3-5**: `include=["unknown_value"]` → invalid include 値の挙動確認 (wrapper layer で warning log + raw fallback、reject 扱いではない、ADR-010 §1.5 横断 optional 引数の defensive 設計)
  - [ ] **Test G3-6**: envelope size > threshold induced → `confidence: "degraded"`
  - [ ] **Test G3-7**: `viewFocusedPipelineStatus.poisoned: true` mock → `confidence: "degraded"` + `as_of.wallclock_ms` Date.now() fallback (view-poisoned 時)
  - [ ] **Test G3-8**: `as_of.wallclock_ms` source verification — view non-poisoned 時、value が `latest_event_wallclock_ms` (mock) と一致、`Date.now()` ではない (Round 1 P1-4 reflection、semantic 反転回避 pin)

### 3.5 S3-5: envelope size bench harness (~70 line) [S3 trunk]

- [ ] `benches/l4_envelope_size.mjs` 新設:
  - [ ] 4 シナリオ計測 (§2.7、envelope 段階で計測):
    - 1. Minimal envelope, no events
    - 2. Minimal envelope, after 10 focus events
    - 3. Minimal envelope, after 1 dirty rect event
    - 4. Degraded envelope (induced via large data or view-poisoned)
  - [ ] **シナリオ 5 (Round 1 P2-1 反映)**: `viewFocusedPipelineStatus()` per call latency p50/p99 計測
  - [ ] warm-up runs ≥ 5、3 回 median 採用
  - [ ] 結果を `benches/results/l4_envelope_size_<timestamp>.json` に JSONL 出力 (gitignored、Round 1 P2-2 反映)
  - [ ] stdout summary table
- [ ] `package.json` に `bench:envelope-size` script 追加
- [ ] `.gitignore` に `benches/results/l4_envelope_size_*.json` 追記

### 3.6 S3-6: 検証 (npm test + bench + 6-guard) [S3 trunk]

- [ ] `cargo check --workspace`: clean (S3-2 napi 拡張で Rust touch、warning 0 必須)
- [ ] `cargo test -p engine-perception --lib`: 既存 + 新 `latest_event_wallclock_ms` 関連 unit test 全 pass
- [ ] `cargo test -p desktop-touch-engine --no-default-features --lib l3_bridge`: 既存 25/25 + 新 napi binding test pass (~26-28/26-28 想定)
- [ ] `npm test` (vitest unit): 既存 + 新 G3-1〜G3-8 全 pass
- [ ] `npm run bench:envelope-size`: 全 4 シナリオ + シナリオ 5 計測完了
- [ ] e2e test 既存無修正 pass (compat mode default で raw shape 維持、Round 1 P1-2 sync)
- [ ] `npm run check:napi-safe` / `check:native-types` (47 → 48 exports) / `check:stub-catalog` / `npm run build`: 全 pass

### 3.7 S3-7: CI workflow + push guard 統合 + Opus + Codex review [S3 trunk]

- [ ] `.github/workflows/bench-envelope-size.yml` 新設 (CI 統合、G3 #5):
  - main push 時 trigger
  - `npm run bench:envelope-size` 実行
  - **GitHub Actions artifact** で結果保存 (`actions/upload-artifact@v4`、Round 1 P2-2 反映、auto-commit pattern を主 push 回避)
  - 前回 main の artifact を `actions/download-artifact@v4` で取得、5%/20% 比較 script で判定
- [ ] **Opus phase-boundary review** (CLAUDE.md §3.3 Step 1): 指摘ゼロまで反復
- [ ] **Codex re-review** (CLAUDE.md §3.3 Step 2): impl PR は **production code 改修 PR + Rust touch** のため Codex re-review **必須 1 round** (Round 1 P2-5 反映、本 plan PR docs only は skip 可、impl PR は必須)

### 3.8 S3-8: G3 ゲート判定 + Appendix C append (~5 line、impl PR merge 後) [S3 trunk]

- [ ] impl PR merged 後、`docs/walking-skeleton-trunk-selection.md` Appendix C 末尾に判定結果を append:
  ```markdown
  | G3 | 2026-05-XX | 継続 | envelope SSOT shape (4 必須 field) + compat mode (post-flatten) で既存 LLM session 回帰 0、`confidence` 2 値分岐 + size SLO bench harness CI 統合済、`as_of.wallclock_ms` L1 event source で semantic 反転回避、L5 wrapper helper で S4 commit 軸 mechanical コピー可能 base 確立。`caused_by` / `if_unexpected` / `query_past` は S4-S5 で carry-over | (なし) |
  ```
- [ ] 判定が「shrink」の場合は S4 scope を sub-plan §1.1 から削る判断を本 sub-plan §6 follow-up に記録

---

## 4. 対 Opus 単独判断盲点 sweep (Lesson 1-4 防御、PR #99/#102/#103/#104/#105/#107/#108/#109 で 8 連続再発 pattern)

memory `project_adr008_d2_c_plan_done.md` Lesson 1-4 + `feedback_autonomous_phase_transition.md` で蓄積済 User reviewer による Opus 単独 sweep 補正 pattern を本 sub-plan で防御化:

### 4.1 contract 自体の妥当性 review (keyword sweep だけでは catch できない)

**確認項目**:
- [ ] `wrapEnvelope` skeleton 関数 signature が S4 (`desktop_discover/act` commit 軸 wrapper) で **mechanical コピー可能** か? S4 sub-plan で同 wrap pattern を `desktop_act` の response に適用するときに shape integral か? (commit response も `data` field に副作用結果が入る前提で envelope skeleton と整合)
- [ ] compat mode の priority chain (`include=raw` > `include=envelope` > env > default raw) が e2e test で deterministic に再現可能か? race condition (env parsing time vs handler call time) なし?
- [ ] `confidence: degraded` の判定が 2 条件 (size 超過 OR view poisoned) で十分か? 他 degraded triggering 候補 (worker_lag 超過、L1 ring overflow 等) は expansion carry-over として明示されているか?
- [ ] `as_of.wallclock_ms` Date.now() approximation の **trade-off が production 観測で許容範囲** (~5-50ms ズレ) か? S4 caused_by elapsed_ms 計測時に同 source を使うとき integral か?

### 4.2 compile-time guard 過信判定 (cargo check 通っただけで OK 判定しない)

**確認項目**:
- [ ] `npm run build` (tsc) clean だけで envelope wrap が **runtime で正しく動作** することは保証されない、unit test G3-1〜G3-7 で各 priority chain path を runtime 確認必須
- [ ] envelope size bench harness が **CI で実際に走る** ことを `.github/workflows/bench-envelope-size.yml` で確認、main push trigger + 結果保存 + 5%/20% 判定が実機で動くか dry-run

### 4.3 両 doc 順序矛盾 (S3 → S4 直列前提 keyword sweep)

**確認項目**:
- [ ] `docs/walking-skeleton-trunk-selection.md` §4 S3 line 211-231 + §4.1 line 304 直列前提 / 親 plan ADR-010 §7 P1 acceptance / 本 sub-plan §0 (line 25-30) の 4 SSOT で **S3 → S4 着手順序が一致**しているか?
- [ ] `Grep "S3 → S4|S4 (commit|envelope skeleton.*commit"` で 4 SSOT の表記揺れがないか?

### 4.4 restore 後 numeric count sync 漏れ (carry-over → restore で件数表記更新)

**確認項目** (Round 2 で sub-batch 7 → 8、OQ 3 → 1、Risks 7 → 8 に bump):
- [ ] §3 sub-batch 数 (S3-1〜S3-8 = **8 件**、Round 2 で napi 拡張 S3-2 + G3 gate S3-8 追加) と §8 OQ 件数 (**1 件**、Round 1 P2-4 で OQ #3 削除 + OQ #2 を OQ #1 に統合) が本 sub-plan 内 / 親 plan walking-skeleton §4.1 line 304 size 想定 (Round 2 で **250-400 line / 1-2 日 + 0.5 日 Rust 改修**) と整合か?
- [ ] `Grep "250-400 line\|1-2 日\|8 件\|1 件\|G3 #1-#5"` で本 sub-plan 内 numeric counts が bit-equal か?

### 4.5 既存 public API 破壊禁止 (CLAUDE.md §3.2 PR #102 教訓延長、Round 2 反映)

**確認項目** (本 trunk の最重要 contract):
- [ ] `desktop_state` の **default behavior が raw shape 維持** (compat mode = server 常に envelope assembly + post-flatten で `data` field を top-level hoist、§1.1 B + §2.2) — env unset + include 引数なしで既存 e2e test 無修正 pass か? (Round 1 P1-2 sync 後)
- [ ] `desktop_state` Zod schema は **無修正** (Round 1 P1-3 sync、`include` field は L5 wrapper layer で peek + strip)、既存 caller の引数 shape 不変 か?
- [ ] `desktop_state` は **`withPostState` を使用しない** (§1.1 C + §2.4) ため、本 trunk で `_post.ts::withPostState` API は touch なし、`post` block 二重構造の懸念は不発 (Round 1 P1-1 sync) — `desktop_state` 経路で role boundary 判断不要、S5 で action tool 統合時に判断
- [ ] `as_of.wallclock_ms` source が **L1 event wallclock** (Round 1 P1-4 sync、§2.5 napi 拡張)、後続 P3 で `freshness_ms` 加える時の semantic 反転による既存 LLM client 破壊 risk が **構造で回避** されているか?
- [ ] `viewFocusedPipelineStatus` napi binding の `processedCount` field が S2 PR #109 で focus-only 化された後の意味 (Codex P2-B + Round 4 P2-B docs sync) を本 sub-plan で binding 経路として正しく利用しているか? (`poisoned` field のみ参照、processedCount は本 trunk で参照不要)
- [ ] 既存 napi binding `view_get_focused()` を **本 PR で touch しない** (S3-2 で新 binding `view_get_focused_with_wallclock` を **追加**、既存 binding 不変、backward compat 維持)、index.d.ts / native-types.ts の既存 export 不変

---

## 5. PR 切り方 (Round 2 で size + Codex review 必須化に格上げ)

| sub-batch | 範囲 | size 想定 |
|---|---|---|
| **S3 (本 PR、merged sub-batch)** | 3.1 _envelope.ts skeleton + L5 wrapper helper + 3.2 napi 拡張 (Rust ~50 line) + 3.3 desktop-state.ts 統合 + size threshold baseline 計測 + 3.4 envelope contract test 8 件 + 3.5 envelope size bench harness + 3.6 検証 + 3.7 CI workflow + Opus + Codex review + 3.8 G3 ゲート判定 | **250-400 line** (Round 2 で napi 拡張 +50 line + Rust touch ありに格上げ、TypeScript ~200-300 + Rust ~50 line) |

**1 PR で land**、sub-batch 分割しない (impl PR は production code 改修 + Rust touch のため Codex re-review **必須 1 round** に格上げ、Round 1 P2-5 反映)。本 plan PR は docs only のため Codex skip 可、Opus 1 round で十分。

`docs/walking-skeleton-trunk-selection.md` §4.1 の S3 概算 **1-2 日 / Opus 1-2 round** + 0.5 日 Rust 改修 = **1.5-2.5 日** に整合更新。

---

## 6. follow-up (carry-over、§3.bis ledger / OQ で永続化、Round 2 反映)

trunk + expansion 完了後の別 phase で carry-over:

- **expansion**: 残 ~25 tool への envelope rollout (L5 swimlane で worktree 並走、`docs/walking-skeleton-trunk-selection.md` §6.1 line 363)、本 S3 で確立した `makeEnvelopeAware` L5 wrapper helper を mechanical コピーで全 tool に適用
- **S5 finalize**: `_post.ts` (existing) と `_envelope.ts` (new) の役割境界判断 (OQ #1、Round 2 で `desktop_state` 経路では withPostState 不使用のため本 trunk 判断不要、`desktop_act` action tool wrapper 化時に S5 で finalize)
- **expansion**: `confidence` 残 3 値 (`cached` / `inferred` / `stale`) 判定 logic、ADR-010 §17.6.1 値域 SSOT 完全実装
- **expansion**: ADR-010 §5.4 typed reason 35 codes (Phase 6 cleanup 後 = PR-A -3 + PR-B +1) 全網羅 (P2 expansion work)、`if_unexpected.most_likely_cause: "EnvelopeSizeExceeded"` typed enum stamp 等

---

## 7. Risks / Mitigation (Round 2 で R1/R2/R3/R4/R5 大幅書き直し + R8 追加)

| # | Risk | 影響 | Mitigation |
|---|---|---|---|
| R1 | compat mode default が誤って envelope shape になり、既存 LLM client 破壊 | **High** | §3.6 既存 e2e test 無修正 pass を G3 #1 完了基準として pin、Test G3-1 (env unset + include なし) で post-flatten = raw shape return を bit-equal regression guard、`compatHoist` の default branch がカバー (Round 1 P1-2 反映 SSOT 準拠) |
| R2 | `as_of.wallclock_ms` source semantic 反転 — Date.now() で進めた後に L1 event wallclock に切替時、既存 LLM client が "freshness" 計算を破壊 | **High** | Round 1 P1-4 反映: 本 trunk で **L1 event wallclock 採用** で source 確定、Date.now() は view-poisoned 時の fallback のみ。`napi` 拡張 (S3-2) で structurally pin、後続 P3 で `freshness_ms` 加える時に意味論不変 (CLAUDE.md §3.2 PR #102 P5c-2 同型 risk 構造で回避) |
| R3 | envelope size threshold (初期 1024 byte) が想定外に低く、本 trunk 段階で頻繁に degraded 降格 | 中 | §3.3 sub-batch (S3-1+S3-3 統合直後) で size bench harness 1 回先行実行 → minimal envelope size 実測 → threshold 確定 (1024 / 2048 / 4096 byte 候補)、必要なら §2.6 + §1.1 G + ADR-010 §5.6.1 を bit-equal sync (Lesson 4 numeric count sync 軸、Round 1 P2-3 反映) |
| R4 | `desktop_state` handler signature 変更 (`Promise<{data, viewPoisoned, asOfWallclockMs}>`) で既存 caller 破壊 | 低 | Round 2 §3.3 で「2 案 (signature 変更 / `__envelope_meta` sentinel) 実測比較」で cleaner alternative を採用、いずれにせよ wrapper layer 内で吸収 (handler 外への shape は既存 `ToolResult` 互換維持) |
| R5 | env `DESKTOP_TOUCH_ENVELOPE` parsing が test 環境で stale (test 順序依存) | 低 | `resolveEnvelopeOptIn(include, envValue?)` を **pure 関数** にして envValue を引数で受ける設計 (§2.1)、test では引数で per-test isolation、`vi.stubEnv` 不要、global shared state 完全回避 |
| R6 | envelope size bench harness の前回 main 比較が CI で flaky (測定誤差で 5% / 20% threshold 跨ぐ) | 中 | warm-up runs ≥ 5、3 回 median 採用 (Round 1 P2-7 反映)、外れ値除外なし、GitHub Actions artifacts 経由前回比較 (Round 1 P2-2 反映、auto-commit 回避) |
| R7 | `viewPoisoned` 取得が `desktop_state` p99 (D2-B PR #98 で 6.22ms) に乗る overhead | 中 | bench harness シナリオ 5 (Round 1 P2-1 反映) で per-call latency p50/p99 計測、impl PR で実測値が許容範囲超過なら caller 側 cache (`desktop_state` 呼出 1 回ごとに 1 回しか read しないため 6.22ms 内に収まる想定) |
| R8 | napi 拡張 (S3-2) で `LatestFocusView` 内 `latest_event_wallclock_ms: AtomicU64` 追加が D2-B-1 PR #96 / S2 PR #108 確立済 view shape を破壊 | 中 | Round 2 で導入の risk: AtomicU64 state 追加は既存 view read API (`get` / `snapshot` / `len` / `is_empty`) と独立、新 method `latest_event_wallclock_ms()` のみ追加、既存 caller (`view_get_focused()` napi binding) は不変。impl PR で既存 D1-3 + D2-B-1 + D2-A unit/integration test 全 pass を guard (~58 test、Round 4 で 47/47 + 25/25 = 72 test pass しているので影響範囲明確) |

---

## 8. Open Questions (S3 trunk-relevant、Round 2 で OQ #2/#3 削除/確定済化、1 件)

| # | OQ | 決定タイミング | 推奨 (Opus 判断委譲) |
|---|---|---|---|
| 1 | `_post.ts` (existing perception envelope + history ring buffer) と `_envelope.ts` (new ADR-010 envelope) の役割境界 — `desktop_state` 経路では `withPostState` 不使用のため本 trunk 判断不要、S5 で `desktop_act` (action tool、`withPostState` 使用) の commit response wrapper 化時に判断 | S5 着手時 | **共存維持** 暫定推奨 (Round 1 P1-1 sync で再 framing)。理由: `_post.ts::post` block は ADR-010 envelope の `caused_by.your_last_action` / `produced_changes` 系に semantic 等価、S5 `caused_by` linkage 実装時に `caused_by.post_state: PostState` sub-field として独立 layer 統合 (ADR-010 §5.2 と整合) も視野、S5 で実装比較で判断 |

**Round 1 で確定済 OQ** (本 sub-plan §1 / §2 で resolve、carry-over なし):

- ~~OQ #2 (旧)~~ → 上の OQ #1 に統合 (Round 2 で再 framing)
- ~~OQ #3 (旧) compat mode opt-in source~~ → §2.2 / §2.3 で **server 常に envelope assembly + post-flatten + 両方 (env / include) サポート + priority chain** に確定済 (Round 2 P1-2 反映、統合書 §11.2 SSOT 準拠)
- ~~OQ (旧) `as_of.wallclock_ms` source~~ → §2.5 で **L1 event wallclock 採用** に確定済 (Round 1 P1-4 反映、semantic 反転回避、napi 拡張 S3-2 で structural pin)

---

## 9. ADR-010 P1 + walking skeleton 全体図 (本 PR の位置づけ)

```
Walking skeleton trunk:
┌──────────────────────────────────────────────────────────────────────┐
│  S1 (PR-η D2-E0): dataflow scope refactor                ✅ merged  │
│      ↓                                                                │
│  S2 (PR-ε D2-C): count-only dirty_rects_aggregate         ✅ merged  │
│      ↓                                                                │
│  S3 (★ 本 PR): ADR-010 P1 envelope minimal wrapper       ⏳ 着手     │
│      + compat mode + desktop_state 適用 + size bench                  │
│      ↓                                                                │
│  S4: desktop_discover/act commit 軸 wrapper (lease 4-tuple)           │
│      ↓                                                                │
│  S5: caused_by linkage cross-layer (★ 最重要 contract)                │
│      ↓                                                                │
│  S6: trunk 完了判定 + CI assert + expansion plan 起草                 │
└──────────────────────────────────────────────────────────────────────┘

S3 内部の envelope wrap layer 図 (本 PR の改修範囲、Round 2 で全面書き直し):

[before、S2 merged shape]                          [after、本 S3 PR-? land 後]
                                                  ──────────────────────────────
desktop_state                                      MCP server registration:
(raw shape return only)                            mcp.tool("desktop_state", schema,
                                                       makeEnvelopeAware(handler, "desktop_state"))
                                                  ──────────────────────────────
                                                          │
                                                          ▼
                                                  L5 wrapper: makeEnvelopeAware (NEW)
                                                          │
                                                          ├─ peek + strip args.include
                                                          │      (ADR-010 §1.5、Zod schema 不変)
                                                          │
                                                          ├─ invoke handler with stripped args
                                                          │
                                                          ▼
                                                  desktopStateHandler (UNCHANGED handler logic)
                                                          │
                                                          │ + S3-2: viewGetFocusedWithWallclock()
                                                          │     (NEW napi binding for L1 event
                                                          │      wallclock + viewPoisoned)
                                                          │
                                                          ▼
                                                  raw `ToolResult` (data + viewPoisoned + asOfWallclockMs)
                                                          │
                                                          ▼
                                                  buildEnvelope (always、SSOT)
                                                          │
                                                          ├─ _version: "1.0"
                                                          ├─ data: rawData
                                                          ├─ as_of.wallclock_ms ← L1 event wallclock
                                                          │      (fallback Date.now() when view-poisoned)
                                                          └─ confidence: "fresh" | "degraded"
                                                                (size 超過 OR view-poisoned で degraded)
                                                          │
                                                          ▼
                                                  compatHoist (post-flatten)
                                                          │
                                                          ├─ optIn=false (default、include なし、env なし):
                                                          │     return envelope.data  ← raw shape、
                                                          │                              既存 LLM client 互換
                                                          │
                                                          └─ optIn=true (include=["envelope"] OR env=1):
                                                                return envelope (full SSOT shape)

resolveEnvelopeOptIn priority chain:
  include=["raw"]     → false (env override)
  include=["envelope"]→ true
  env=1               → true
  default             → false
```

---

## 10. References

- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.4) §4 S3 (line 211-231) + §5 G3 ゲート (line 343) + §3.2 contract spike 方針
- 概念設計 (parent ADR): `docs/adr-010-presentation-layer-self-documenting-envelope.md` §5 (envelope schema、`_version` / `data` / `as_of` / `confidence`) + §5.5 (Phase 別 P1 構造) + §5.6 (size SLO + bench harness) + §7 P1 acceptance + §10 P1 acceptance criteria
- 統合書 (SSOT): `docs/architecture-3layer-integrated.md` §11.2 (compat mode hoist semantic) + §17.6.1 (`confidence` 値域 SSOT)
- 既存実装:
  - `src/tools/_post.ts` (existing perception envelope + history ring buffer、本 trunk で role boundary OQ #2)
  - `src/tools/desktop-state.ts` (本 trunk で envelope wrap 統合対象、~588 line 既存)
  - `index.d.ts::viewFocusedPipelineStatus` napi binding (D2-B-1、本 trunk で `poisoned` field 参照)
- governance: CLAUDE.md 強制命令 3 (Opus 再レビュー義務) + 3.1 (ADR/plan 複数表 fact 整合) + 3.2 (carry-over scope shrink、PR #102 教訓 → compat mode 必須化に拡張) + 3.3 (PR レビューループ定型) + 7 (仕組みで対応) + 8 (main 直 push 禁止) + 9 (残件は memory ではなく docs/)
- memory: `project_adr008_d2_c_plan_done.md` Lesson 1-4 (User reviewer 補正 pattern、本 sub-plan §4 で防御化) + `feedback_autonomous_phase_transition.md` (新運用モード、phase 移行 autonomous + post-PR review 後追い iteration)
- 同型先例 (Round 1 P3-2 反映、PR 番号と phase の対応を明示):
  - sub-plan 構造: **PR #104 (S1 D2-E0 sub-plan)** + **PR #105 (S1 D2-E0 impl)** + **PR #103 (S2 D2-C sub-plan)** + **PR #108 (S2 D2-C impl) + PR #109 (S2 R4 follow-up)** — 3 分類 trunk/expansion/carry-over + post-PR review iteration
  - compat mode 設計: 統合書 §11.2 + 既存 LLM client 互換 e2e test ベース (Round 1 P1-2 SSOT 準拠で書き直し)
  - bench harness 設計: D1-5 PR #92 (`benches/d1_view_latency.rs` + `benches/d1_ts_baseline.mjs`) + D2-B PR #98 (`benches/d2_desktop_state_roundtrip.mjs`) — 既存 mjs Node bench pattern を踏襲、CI artifacts pattern (Round 1 P2-2 反映)
  - napi 拡張: PR #96 D2-B-1 (`view_get_focused` 新設) と同型 mechanical コピー、本 S3-2 で `view_get_focused_with_wallclock` 追加 (既存 binding 不変、新 binding として並立、Round 1 P1-4 反映)

---

## Appendix A: 改訂履歴

| version | date | author | summary |
|---|---|---|---|
| Drafted v0.1 | 2026-05-01 | Claude (Sonnet) | 初稿起草、walking skeleton S3 sub-plan、ADR-010 P1 envelope minimal wrapper + compat mode + `desktop_state` 1 tool 適用 + size SLO bench harness + G3 ゲート判定 |
| Drafted v0.2 | 2026-05-01 | Claude (Sonnet) | **Opus PR #110 Round 1 review 反映** (P1×4 + P2×5 + P3×2、Conditionally Approved): **P1-1** `withPostState` 適用前提が虚偽 → §1.1 C / §2.4 / §4.5 / §7 R4 / §9 architecture diagram で `desktop_state` は `withPostState` 不使用に書き直し、OQ #1 を S5 で finalize に再 framing。**P1-2** compat mode 方向が SSOT と逆 → §1.1 B / §2.2 / §2.3 / §1.4 / §7 R1 を統合書 §11.2 SSOT 準拠で「server 常に envelope assembly + post-flatten compat mode」に書き直し。**P1-3** `include` field を tool Zod schema に追加は ADR-010 §1.5 違反 → §1.1 F / §2.1 / §2.4 / §2.8 / §3.3 / §4.5 で **L5 wrapper helper `makeEnvelopeAware` 新設**、tool schema 不変に書き直し、"前例あり" 虚偽記述削除。**P1-4** `as_of.wallclock_ms` Date.now() で semantic 反転 risk → §1.1 D / §2.5 / §7 R2 で **L1 event wallclock 採用 + napi 拡張 (S3-2、Rust ~50 line)** に書き直し、view-poisoned fallback のみ Date.now()。**P2-1** viewPoisoned bench overhead 計測 → §3.5 シナリオ 5 追加。**P2-2** CI auto-commit 回避 → §2.7 / §3.7 で GitHub Actions artifacts pattern に変更。**P2-3** size threshold baseline 計測 → §2.7 / §3.3 で sub-batch S3-1+S3-3 統合直後に bench 1 回先行実行で確定。**P2-4** OQ #3 削除 + OQ #2 を OQ #1 に統合 → §8 で 1 件に縮小、§4.4 numeric counts (sub-batch 7→8、OQ 3→1、Risks 7→8) sync。**P2-5** Codex review 必須化 → §3.7 / §5 で plan PR docs only skip + impl PR Rust touch あり Codex 必須 1 round に書き分け。**P3-1** §9 diagram 全面書き直し。**P3-2** §10 References で PR #104/#105 表記を「S1 sub-plan/impl」に分離。size 200-300 → 250-400 line に格上げ |

---

END OF ADR-010 P1 S3 sub-plan (Drafted v0.2)。
