# walking skeleton S4 / G3 alignment (commit 軸 wrapper + lease 4-tuple validation + ToolCallStarted/Completed payload schema)

- Status: **Drafted (2026-05-01)**
- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.4) §4 **S4** (line 232-251) + §5 **G3 ゲート** (line 343) の最小実装。本 sub-plan は trunk S4 PR の scope を確定する
- Trigger: walking skeleton S3 (PR #110 envelope minimal wrapper sub-plan、Round 2 反映済) merged 後の翌 PR で着手、S5 (caused_by linkage cross-layer、最重要 contract) は本 S4 merged が前提条件
- 親 plan: `docs/walking-skeleton-trunk-selection.md` §4 S4 (line 232-251) + §4.1 line 305 (S4 工数 4-5 日 / Opus 2-3 round / Codex ✓) + §5 G3 ゲート (line 343)
- 概念設計: `docs/adr-010-presentation-layer-self-documenting-envelope.md` §5.3 (失敗時 envelope) + §5.4 (typed reason 35 codes、Phase 6 cleanup 後 = PR-A -3 + PR-B +1、LeaseExpired は 5 lease codes の 1 つ) + 統合書 §4 (4-tuple lease) + 統合書 §6 (1 event の旅) + 統合書 §11.2 (compat mode)
- 並走依存: **S3 sub-plan PR #110** (review 中、本 sub-plan は S3 で確立する `_envelope.ts::makeEnvelopeAware` L5 wrapper helper + envelope SSOT shape を前提に commit 軸 template を建てる、impl 順序は S3 impl merged → 本 S4 impl)
- 対象 sub-batch: walking skeleton **S4 (PR ?)** — commit 軸 wrapper template + query 軸 wrapper template + L1 既存 `EventKind::ToolCallStarted/Completed` payload schema 確定 + `LeaseStore.validate()` typed reason mapping + `desktop_discover` / `desktop_act` を wrapper 経由化
- 後続: **S5** (caused_by linkage cross-layer、★ trunk 最重要 contract) は **本 S4 merged が前提条件**、ToolCall event の payload schema が S5 で `caused_by` の構造に展開される

---

## 0. walking skeleton S4 位置付け note

本 sub-plan は walking skeleton trunk (`docs/walking-skeleton-trunk-selection.md` Proposed v0.4) の **S4 sub-batch**。S3 (PR #110、envelope skeleton) で **L4/L5 envelope 経路** が確立、本 S4 は **commit 軸経路 (副作用持つ tool 用 wrapper)** + **query 軸経路 (lease 発行 query 用 wrapper)** を起こし、S5 で `caused_by` を載せていく前提を作る:

- S1 (PR-η D2-E0 完了): dataflow scope refactor
- S2 (PR-ε D2-C 完了): count-only `dirty_rects_aggregate`
- S3 (★ PR #110 review 中): envelope minimal wrapper + compat mode + size SLO bench
- **S4 (★ 本 PR)**: commit 軸 wrapper + lease 4-tuple validation + ToolCallStarted/Completed payload schema 確定 + `desktop_discover/act` wrapper 経由化
- S5 (PR-? 最重要): caused_by linkage cross-layer (★ trunk 最重要 contract、本 S4 で配線した ToolCall event を session 内 history buffer に溜め、`caused_by.your_last_action` に展開)
- S6 (PR-?): trunk 完了判定 + CI assert 化 + expansion plan 起草

S4 は **TypeScript + Rust touch あり PR** (commit 軸 wrapper TS layer + L1 EventKind payload schema は Rust 確定)。**production code 改修 + Rust touch + 既存 public API (EventKind 100/101) の payload schema 確定** で **Codex re-review 必須 1 round** (CLAUDE.md §3.3 Step 2、§3.2 PR #102 教訓延長: 既存 EventKind 番号は不変、payload struct のみ確定)。Walking skeleton §4.1 line 305: 工数 **4-5 日 / Opus 2-3 round / Codex ✓**。

**G3 ゲートの目標** (`docs/walking-skeleton-trunk-selection.md` §4 S4 完了基準 line 245-251):

| # | walking-skeleton §4 S4 目標 | 本 sub-plan 検証手段 |
|---|---|---|
| 1 | `desktop_discover` / `desktop_act` の既存 e2e test pass | §3 全 sub-batch 完了後の §3.7 既存 e2e test 無修正 pass、`workflows/e2e-tests.yml` で full suite |
| 2 | L1 ring に `ToolCallStarted` / `ToolCallCompleted` event が記録される (新規 EventKind 追加なしで観測可能) | §3.2 既存 `l1_push_tool_call_started/completed` napi binding を wrapper から呼ぶ + §3.6 contract test で event 記録を `l1PollEvents` 経由 assert |
| 3 | lease validation 失敗時に `if_unexpected.most_likely_cause: "LeaseExpired"` が typed で返り、`try_next` に `desktop_discover` が含まれる | §3.6 contract test で expired lease を強制発生させ、envelope failure shape を assert |
| 4 | envelope failure size < 5KB (ADR-010 §5.6.1、S3 で新設の bench harness で計測) | §3.7 envelope size bench harness を S3 から流用、failure envelope シナリオ追加 (`benches/l4_envelope_size.mjs` の追加 scenario) |
| 5 | `EventKind::ToolCallStarted/Completed` payload schema が `crates/.../envelope.rs` で確定 | §3.1 既存 `ToolCallStartedPayload` / `ToolCallCompletedPayload` Rust struct (= `src/l1_capture/payload.rs`) に S4 で必要な field を追加固定 (新 EventKind 追加なし、既存 struct のみ拡張)、wrapper 側の field name と bit-equal sync |
| 6 | **G3 ゲート判定**: commit wrapper と既存 `ToolCallStarted/Completed` event payload 確定が `desktop_discover/act` の挙動を壊していない、`LeaseExpired` typed reason が 1 path 動作 | §3.8 G3 判定 + Appendix C append (impl PR merge 後) |

**review 観点の再定義**: 本 PR は「commit 軸 wrapper の完成度」ではなく **「S4/G3 contract が最短で検証できるか + S5 caused_by linkage で mechanical コピーで進められる base が固まっているか」** で評価する。typed reason 残 36 codes 全網羅 / `try_next` 多 path 実装 / dry-run integration 等は S5-S6 + expansion で carry-over、本 S4 では `LeaseExpired` 1 種 + `try_next: desktop_discover` 1 path のみ。

---

## 1. Scope (trunk / expansion / carry-over の 3 分類)

### 1.1 [S4 trunk] 本 sub-plan で扱う (G3 contract 必須)

A. **`src/tools/_envelope.ts` 拡張** (S3 で導入した `makeEnvelopeAware` を base に **commit 軸 / query 軸 helper を追加**) — `makeCommitWrapper(handler, toolName, options)` + `makeQueryWrapper(handler, toolName, options)` 新設、共通の envelope assembly を継承
B. **commit 軸 wrapper の責務** (1 helper で template 化):
  - `tool_call_id` 採番 (per-session seq、session_id + monotone counter)
  - lease 4-tuple validation (`LeaseStore.validate()` 経由、`expired` reason → `LeaseExpired` typed enum)
  - L1 `l1_push_tool_call_started` 呼出 (副作用前)
  - 副作用実行 (handler invocation)
  - L1 `l1_push_tool_call_completed` 呼出 (副作用後、ok/elapsedMs/error_code 付き)
  - envelope assembly (`buildEnvelope` 既存 + `if_unexpected` 失敗時)
  - compat hoist (S3 と同じ post-flatten)
C. **query 軸 wrapper の責務** (1 helper で template 化):
  - lease 発行 (handler 内 `LeaseStore.issue()` 呼出 → wrapper でlease を envelope に展開、`data.lease_token` field として現状互換維持)
  - envelope assembly + compat hoist
  - **`tool_call_id` は採番しない** (query は副作用なし、トレース観点で start/completed event 不要、ただし将来の query history は S5 OQ)
D. **`desktop_discover` / `desktop_act` 既存実装は維持** (Round 1 P1-3 教訓、ADR-010 §1.5 「L5 wrapper が一元解釈、tool 個別実装は修正不要」)、wrapper 経由化のみ — handler 内部 logic、Zod schema、戻り値 shape 不変、MCP server 登録 site で `makeQueryWrapper(desktopDiscoverHandler, "desktop_discover")` / `makeCommitWrapper(desktopActHandler, "desktop_act")` で wrap
E. **L1 既存 `EventKind::ToolCallStarted (=100)` / `ToolCallCompleted (=101)` の payload schema 確定** (新規 EventKind 追加なし、CLAUDE.md §3.2 既存 public API 破壊禁止):
  - 既存 `ToolCallStartedPayload { tool: String, args_json: String }` を **本 PR で expand**: 既存 `args_json` field 不変 + `lease_token: Option<LeaseTokenSummary>` 末尾 optional 追加 (Round 1 P1-2 反映: `args_json` rename は npm public type signature breakage で却下、CLAUDE.md §3.2 既存 API 破壊禁止)
  - 既存 `ToolCallCompletedPayload { tool, elapsed_ms, ok, error_code }` 不変 (S4 で追加 field 不要)
  - `LeaseTokenSummary { entityId, viewId, targetGeneration, evidenceDigest_prefix8 }` 新型 (full evidenceDigest は size 圧縮、prefix のみ)
  - 既存 `l1_push_tool_call_started` napi binding signature: 既存 4 引数 (`tool, args_json, session_id, tool_call_id`) 順序 + 名前不変 + 末尾 5th `lease_token: Option<NativeLeaseTokenSummary>` 追加 (Round 1 P1-1 反映: 3rd 挿入は既存 4-arg positional callers を silent breakage、5th 末尾追加で TypeScript optional trailing semantic で既存 callers 無修正動作)
F. **失敗時 envelope: `most_likely_cause: "LeaseExpired"` 1 種実装** + `try_next: [{action: "desktop_discover", ...}]` 1 path 実装 — 残 36 typed reason codes (ADR-010 §5.4) は expansion P2 で carry-over
G. **`click_element` は本 trunk では wrapper 経由しない** (expansion で「lease 不在 commit」バリエーションとしてコピー、walking-skeleton §4 line 244)
H. **G3 ゲート判定 + Appendix C append** — `docs/walking-skeleton-trunk-selection.md` Appendix C 末尾に `| G3 | 2026-05-XX | (継続/shrink) | (...) | (...) |` を append (本 sub-plan §3.8、impl PR merge 後)

### 1.2 [expansion] G3 通過後の expansion phase で実装 (本 PR scope 外)

trunk 完了 (G3 通過) 後の expansion phase で実装:

- **残 ~24 commit tool wrapper 化** (mouse_click / keyboard / clipboard / scroll / focus_window / browser_click / 等): L5 commit swimlane で worktree 並走 (`docs/walking-skeleton-trunk-selection.md` §6.1 line 363)、本 S4 で確立した `makeCommitWrapper` を mechanical コピー
- **残 ~10 query tool wrapper 化** (screenshot / browser_overview / browser_locate 等): L5 query swimlane で並走、`makeQueryWrapper` mechanical コピー
- **`click_element` (lease 不在 commit バリエーション)**: 本 S4 で wrapper 経由しない判断 (§1.1 G)、expansion で `makeCommitWrapper` の lease validation を skip option で適用
- **typed reason 残 36 codes** (ADR-010 §5.4): `_errors.ts::SUGGESTS` を `try_next: TypedAction[]` に進化、ADR-010 §10 P2 acceptance criteria 100% mapping
- **dry-run integration** (`if_you_did` field): ADR-010 P5 work、副作用大の tool に `dry_run=true` 引数経由で `predicted_post_state` view 経由 preview return
- **`tool_call_id` の persistent session management**: 本 S4 では in-process counter (server lifetime 内 unique)、永続化 (cross-server-restart) は expansion ADR-011 work

### 1.3 [carry-over] §3.bis ledger / OQ で永続化 (別 phase)

- **OQ #1 — `tool_call_id` 採番 source** (Round 1 P1-4 同型 risk 軸): 本 trunk で **session_id + per-session monotone counter** を採用 (例: `"sess_abc-123:42"`)、cross-server-restart で uniqueness を絶対保証する schema は expansion (永続 store 必要)。本 sub-plan §8 OQ #1 で carry-over
- **OQ #2 — `caused_by.your_last_action` の semantic 解釈** (S5 で finalize、Opus PR #111 Round 1 P1-5 反映): `your_last_action` field は **直前 desktop_act の `tool_name + args_json`** とするか、**直前任意 commit tool** とするか? 本 trunk では **`_post.ts::recordHistory` への touch なし** (`recordHistory` は既に存在し action tools から呼ばれている)、per-session ring buffer の新設または `_post.ts` 統合判断は **S5 着手時に finalize** に純粋 carry-over (本 S4 scope 外)。S5 で per-session ring buffer 仕組み (新設 vs `_post.ts` 統合) + `caused_by.your_last_action` semantic 解釈 (任意 commit tool / desktop_act 限定) を同時 finalize
- **OQ #3 — `args_summary` (= 概念名) の生成 logic** (Round 2 P2-3 軸延長): 本 S4 では JSON.stringify の truncate (~512 byte 上限) を採用、PII / secret redaction は expansion P2 work (`_errors.ts::SUGGESTS` の args_redacted 拡張と統合)。本 sub-plan §8 OQ #3 で carry-over。**用語整理** (Round 3 P2-1 反映): 本 sub-plan で **`args_summary`** は **wrapper 層で truncate logic を経た summary 文字列の概念名**、L1 ring の **field 名は既存 `args_json` を維持** (Round 2 P1-2 既存 npm public type signature 維持)。すなわち wrapper が L1 push する際は `l1PushToolCallStarted({ tool, args_json: <truncate 済 summary>, lease_token })` と call、§9 architecture diagram も同 field 名で整合
- **`click_element` lease 不在 commit バリエーション**: §1.1 G + §1.2 expansion で確定済 (本 S4 では wrapper 経由しない)
- **既存 LLM client 破壊禁止 (CLAUDE.md §3.2 PR #102 教訓延長)**: S3 と同じ compat mode (server 常に envelope assembly + post-flatten で raw shape return) で担保、`desktop_discover` / `desktop_act` の e2e test 無修正 pass を §3.7 で pin

### 1.4 北極星整合 + walking skeleton G3 contract

- **N1 (pivot 必ず保持)**: `tool_call_id` は session 内 unique pivot、`session_id` + `tool_call_id` の 2 軸で commit event を traceable に。L1 既存 EventEnvelope の `session_id` / `tool_call_id` field (`src/l1_capture/envelope.rs` line 60-84) を本 PR で **payload 経由ではなく envelope 経由で carry** (新規 EventKind 追加なし、§1.1 E)
- **N2 (watermark で frontier 進行)**: ToolCall event は副作用 commit、`UiaFocusChanged` / `DirtyRect` 等の観測 event と同 L1 ring に push、L2/L3 frontier は両者を統合した watermark で進行 (S3 で確立済)
- **CLAUDE.md 強制命令 3.1 (ADR/plan 複数表 fact 整合)**: 本 PR では sub-plan / 親戦略 walking-skeleton §4 S4 / ADR-010 §5.3 (失敗 envelope) + §5.4 (LeaseExpired typed reason、4 LeaseStore reason → 4 typed codes 1:1 + 1 別経路 typed code = `EntityOutsideViewport`) / 統合書 §4 (lease 4-tuple) + §6 (1 event の旅) / 既存 `LeaseStore.validate()` reason 4 種 / 既存 `EventKind::ToolCallStarted/Completed` の 5 SSOT を bit-equal に揃える (Round 1 P1-4 反映: 旧 "1:1" 主張は 4 reason → 4 typed codes 1:1 + 1 別経路 に修正)
- **CLAUDE.md 強制命令 3.2 (carry-over scope shrink、PR #102 教訓延長)**: 既存 EventKind 番号 (100, 101) **不変**、新規 EventKind 追加禁止 (walking-skeleton §4 line 240、Opus P1-4 教訓と整合)。既存 napi binding `l1_push_tool_call_started/completed` の signature 拡張は **新 optional 引数追加のみ** (backward compat、既存 caller は影響なし)
- **walking skeleton G3 contract** (Round 2 P1-4 + Round 3 P2-3 整合): `LeaseStore.validate()` の reason 4 種 → ADR-010 §5.4 typed enum 4 種 (`LeaseExpired` / `LeaseGenerationMismatch` / `EntityNotFound` / `LeaseDigestMismatch`) の **1:1 マッピング** を本 trunk で確立 + 5 番目の lease-relevant typed code `EntityOutsideViewport` は **別経路** (lease 4-tuple validation の外、viewport 外 commit gate、本 S4 trunk scope 外で carry-over) を本 sub-plan で明示分離。これにより S5 で caused_by linkage 経由の `if_unexpected.try_next` 配線が mechanical コピーで進められる base が固まること

---

## 2. 設計判断

### 2.1 commit 軸 / query 軸 wrapper API (S3 makeEnvelopeAware の延長)

#### [S4 trunk] `makeCommitWrapper` 新設

```typescript
// src/tools/_envelope.ts (S3 で確立した base に拡張)

export interface CommitWrapperOptions<TArgs> {
  /** Lease validation: caller passes the lease validation function
   *  + live entities. wrapper invokes before handler. */
  leaseValidator?: (args: TArgs) => Promise<LeaseValidationResult>;
  /** args_summary generator (default: JSON.stringify 上 512 byte truncate). */
  argsSummary?: (args: TArgs) => string;
}

/**
 * Wrap a commit-axis (副作用持つ) tool handler.
 *
 * Per-call flow (ADR-010 §3.2 + 統合書 §6):
 * 1. peek + strip `args.include`、resolve envelope opt-in (S3 inherit)
 * 2. lease validation (if leaseValidator provided)
 *    - on `expired` → return failure envelope with
 *      `if_unexpected.most_likely_cause: "LeaseExpired"` +
 *      `try_next: [{action: "desktop_discover", ...}]`、handler は呼ばない
 * 3. tool_call_id 採番 (session-local monotone counter)
 * 4. l1PushToolCallStarted({ tool, argsSummary, leaseToken? })
 * 5. invoke handler (raw side effect)
 * 6. l1PushToolCallCompleted({ tool, elapsedMs, ok, errorCode? })
 * 7. buildEnvelope (S3 inherit、L1 event wallclock + viewPoisoned 同様) +
 *    compatHoist (S3 inherit、post-flatten compat mode)
 *
 * **既存 desktop_act handler の internal logic / Zod schema / 戻り値
 * shape は不変** (ADR-010 §1.5 SSOT、tool 個別実装は修正不要、
 * MCP server 登録 site で wrap するだけ)。
 */
export function makeCommitWrapper<TArgs, TData>(
  handler: (args: TArgs) => Promise<TData>,
  toolName: string,
  options?: CommitWrapperOptions<TArgs>,
): (rawArgs: TArgs & { include?: string[] }) => Promise<TData | EnvelopeMinimalShape<TData>>;

export interface QueryWrapperOptions {
  // 本 S4 では特になし (lease 発行は handler が直接 LeaseStore.issue で行う、
  // wrapper は envelope assembly のみ)
}

/** Wrap a query-axis (副作用なし、lease 発行可能) tool handler. */
export function makeQueryWrapper<TArgs, TData>(
  handler: (args: TArgs) => Promise<TData>,
  toolName: string,
  options?: QueryWrapperOptions,
): (rawArgs: TArgs & { include?: string[] }) => Promise<TData | EnvelopeMinimalShape<TData>>;
```

#### [carry-over] OQ — `tool_call_id` source (per-session monotone counter)

```typescript
// per-server in-process state (本 S4 で in-process、expansion で永続化)
let _toolCallSeq = 0;
function nextToolCallId(sessionId: string): string {
  return `${sessionId}:${++_toolCallSeq}`;
}
```

OQ #1 (§8) で永続化 schema を carry-over。

### 2.2 lease validation chain (LeaseStore reason → typed enum mapping、Opus PR #111 Round 1 P1-4 反映)

`LeaseStore.validate()` (`src/engine/world-graph/lease-store.ts` 既存 line 64-83) の reason **4 種** → ADR-010 §5.4 lease-related typed enum **4 codes** の **1:1 mapping**:

| LeaseStore reason | ADR-010 typed enum (§5.4) | try_next (S4 trunk: 1 path のみ) |
|---|---|---|
| `expired` | `LeaseExpired` | `[{action: "desktop_discover", confidence: "high"}]` |
| `generation_mismatch` | `LeaseGenerationMismatch` | (S4 carry-over、expansion で mechanical コピー追加) |
| `entity_not_found` | `EntityNotFound` | (S4 carry-over) |
| `digest_mismatch` | `LeaseDigestMismatch` | (S4 carry-over) |

**+ 5 番目の lease-related typed code は別経路** (LeaseStore.validate() の reason ではない):

| 発生経路 | ADR-010 typed enum (§5.4) | trunk 配線 |
|---|---|---|
| WindowChanged event 等 (entity が viewport 外に出た時の検出) | `EntityOutsideViewport` | **本 S4 trunk scope 外** (carry-over、expansion で配線) |

**S4 trunk 範囲**: `expired` → `LeaseExpired` の 1 mapping 完全実装 (Walking skeleton §4 line 242 「`LeaseExpired` 第一候補」)。残 3 LeaseStore mapping (`generation_mismatch` / `entity_not_found` / `digest_mismatch`) は expansion で mechanical コピーで追加。`EntityOutsideViewport` は別経路 (WindowChanged event 等) で発生する 5 番目の lease-related typed code、本 trunk 範囲外。

**修正前後の差** (Round 1 P1-4): 旧版 §1.4 line 94 / §2.2 line 168 で「reason 4 種 → typed enum 5 種 (lease 関連) の **1:1 マッピング**」と書いていたが、4 reason → 4 typed codes の 1:1 + 1 別経路 typed code が事実、Round 2 で表を 2 つに分離して修正。

### 2.3 L1 既存 EventKind payload schema 確定 (§1.1 E、新規 EventKind 追加なし、Opus PR #111 Round 1 P1-1 + P1-2 反映)

#### [S4 trunk] payload schema 拡張 — 既存 field 不変 + optional 末尾追加

**Round 1 P1-2 反映** (`args_json` rename 中止): `index.d.ts:280` の `argsJson: string` + `src/engine/native-engine.ts:282` の `NativeL1` interface は **npm package public type signature**、rename = breaking change (semver MAJOR bump 相当)。CLAUDE.md §3.2 PR #102 教訓「既存 public API 破壊禁止」直接該当のため **rename しない**。Walking skeleton §4 line 239 の表現「`{tool_name, args_summary, lease_token?}`」は概念的 summary 化を意味、実際の field 名は既存の `args_json` を維持。

**Round 1 P1-1 反映** (napi signature 引数 position): `lease_token` は **末尾 5th optional 引数**として追加 (3rd 挿入は既存 4-arg positional callers を silent breakage させる、tests/unit/l1-capture-panic-fuzz.test.ts:122,128 + tests/unit/l1-capture.test.ts:163 計 6 callsite が `null`/`undefined` 渡しで position shift 危険)。

```rust
// Before (PR #105 で landed、変更なし)
pub struct ToolCallStartedPayload {
    pub tool: String,
    pub args_json: String,
}

// After (本 S4 で fix、既存 field 不変、末尾 optional 追加)
pub struct ToolCallStartedPayload {
    /// Tool name (commit-axis: "desktop_act" / query-axis:
    /// "desktop_discover" 等)
    pub tool: String,
    /// **既存 field 名不変** (`args_json`、`index.d.ts:280` で公開済の
    /// npm public type signature 維持、Round 1 P1-2 反映)。caller は
    /// truncate (~512 byte 上限) + JSON.stringify 加工した文字列を渡す
    /// semantic、field 名は `args_json` のまま (内部的には summary
    /// content だが breaking change 回避のため rename しない)
    pub args_json: String,
    /// **NEW**: Lease 4-tuple summary (commit-axis with lease validation
    /// 経由のみ設定、query-axis や lease 不在 commit では None)。
    /// `Option` 末尾追加 — bincode の in-memory ring 内 single-server-
    /// lifetime では既存 caller の encode/decode 互換維持 (ring 内 events
    /// は server 起動毎に空、cross-server replay は expansion で binary
    /// compat 確認、本 trunk 範囲外、§7 R5 mitigation)
    pub lease_token: Option<LeaseTokenSummary>,
}

pub struct LeaseTokenSummary {
    pub entity_id: String,
    pub view_id: String,
    pub target_generation: String,
    /// evidenceDigest の prefix 8 文字のみ (size 圧縮、L1 ring 容量保護)
    pub evidence_digest_prefix8: String,
}

// `ToolCallCompletedPayload` は変更なし (本 S4 で field 追加不要)
pub struct ToolCallCompletedPayload {
    pub tool: String,
    pub elapsed_ms: u32,
    pub ok: bool,
    pub error_code: Option<String>,
}
```

`l1_push_tool_call_started` napi binding signature 拡張 — **既存 4 引数 順序不変** + **末尾 5th optional 追加**:
```rust
// Before (既存、変更なし)
pub fn l1_push_tool_call_started(
    tool: String,
    args_json: String,                                  // 既存 field 名維持
    session_id: Option<String>,
    tool_call_id: Option<String>,
) -> napi::Result<BigInt>;

// After (S4 trunk、既存 4 引数の順序維持 + 末尾 optional 追加)
pub fn l1_push_tool_call_started(
    tool: String,
    args_json: String,                                  // 既存 field 名維持 (P1-2)
    session_id: Option<String>,
    tool_call_id: Option<String>,
    lease_token: Option<NativeLeaseTokenSummary>,       // NEW、末尾 optional (P1-1)
) -> napi::Result<BigInt>;

#[napi(object)]
pub struct NativeLeaseTokenSummary {
    pub entity_id: String,
    pub view_id: String,
    pub target_generation: String,
    pub evidence_digest_prefix8: String,
}
```

**重要 (Round 1 P1-1 silent breakage 回避)**: 既存 4-arg callers (tests/unit/l1-capture-panic-fuzz.test.ts:122,128 + tests/unit/l1-capture.test.ts:163 + 他 production callers 計 ~6-10 callsite) は **無修正で pass** — TypeScript optional 引数の trailing semantic で `lease_token` 省略時 `undefined` が渡され、既存 4-arg positional 呼出が無修正動作。第 3/4 引数の `session_id` / `tool_call_id` の position も不変、`l1PushToolCallStarted!("test_tool", "{}", undefined, undefined)` 等の既存 positional 呼出は壊れない。

**`args_json` field 名維持** (P1-2): production / test 全 caller (~6-10 callsite + npm external consumer) 無修正で pass、CLAUDE.md §3.2 既存 public API 破壊禁止に整合。「summary」semantic は handler / wrapper の **caller 側で truncate 加工** (`truncateJson(args, 512)` helper) し、L1 push 引数として渡す形 — field 名は `args_json` のまま意味的に "summarized JSON" として運用。

### 2.4 失敗時 envelope (LeaseExpired typed reason、try_next: desktop_discover 1 path)

ADR-010 §5.3 失敗時 envelope shape:

```jsonc
{
  "_version": "1.0",
  "data": null,                                // 失敗時 null
  "as_of": { "wallclock_ms": ... },             // S3 で確立、L1 event wallclock or fallback
  "confidence": "stale",                        // 失敗時 stale 固定 (ADR-010 §5.3、S3 trunk 2 値分岐外)
  "if_unexpected": {                            // 必須
    "most_likely_cause": "LeaseExpired",        // S4 で 1 種実装、残 36 codes は expansion
    "try_next": [
      { "action": "desktop_discover", "args": { /* lease 再発行用 */ }, "confidence": "high" }
    ]
  }
}
```

**注意** (Opus PR #111 Round 1 P1-3 反映): ADR-010 §5.3 で **失敗時 confidence は "stale" 固定**、S3 trunk 2 値分岐 (`fresh` / `degraded`) を **3 値拡張** (`stale` 追加) する必要あり。本 S4 で `EnvelopeMinimalShape.confidence` を `"fresh" | "degraded" | "stale"` に bump、`buildEnvelope` 内で `data === null` で `stale` 固定。

**S3 並走依存 contract** (Round 1 P1-3): 本 S4 impl PR は **S3 impl PR merged 後** に着手 (§0 line 8 既明示の直列順序)、`EnvelopeMinimalShape<T>` 型 import は S3 impl で確定した型シグネチャ (S3 trunk 2 値) を base に S4 impl で 3 値 bump (新 value 追加で既存 2 値 enum value 不変、TypeScript discriminated union の **subset → superset 拡張** で existing test mock の type narrow は影響なし、ただし mock setup で `confidence: "stale"` を返す test を追加するのは S3 contract test 側ではなく **本 S4 contract test (§3.6 G3-S4-2 等)** で扱う)。S3 contract test (G3-7) は `fresh`/`degraded` を `expect(...).toEqual(...)` 等で pin する mock 形なら、`stale` 追加で assertion 範囲外保証 (Round 2 で **S3 contract test の assertion 形式が確定後** に再確認、impl PR 着手 timing で final check)。

→ `_envelope.ts` の `EnvelopeMinimalShape<T>` interface は本 S4 で **3 値に拡張** (S3 で 2 値のみだったが、`stale` failure case 用に bump)。残 `cached` / `inferred` 2 値は expansion (ADR-010 §17.6.1 値域 SSOT 完全網羅は P2 work)。

**ADR-010 §5.3 example の表記揺れ note** (Round 1 P3-1): ADR-010 §5.3 example line 270 が snake_case `lease_expired` と書かれているが、§5.4 SSOT は PascalCase `LeaseExpired` で typed enum を定義。本 sub-plan §2.4 example は **§5.4 SSOT に従い PascalCase 採用**、ADR-010 §5.3 の snake_case 表記は ADR-010 既存揺れで本 PR scope 外 (ADR-010 後追い更新候補、§10 References で note 済)。

### 2.5 `desktop_discover` / `desktop_act` 既存実装は維持 (ADR-010 §1.5 SSOT 準拠)

S3 で確立した「tool 個別実装は修正不要、MCP server 登録 site で wrapper 経由」の設計を **そのまま継続**:

```typescript
// MCP server 登録部 (impl PR で実装)
mcp.tool(
  "desktop_discover",
  desktopDiscoverSchema,
  makeQueryWrapper(desktopDiscoverHandler, "desktop_discover"),
);
mcp.tool(
  "desktop_act",
  desktopActSchema,
  makeCommitWrapper(desktopActHandler, "desktop_act", {
    leaseValidator: async (args) => {
      // pull lease + entity from world-graph state
      const lease = parseLeaseToken(args.leaseToken);
      const liveEntities = getLiveEntities(args.viewId);
      const currentGeneration = getCurrentGeneration(args.viewId);
      return leaseStore.validate(lease, currentGeneration, liveEntities);
    },
    argsSummary: (args) => truncateJson(args, 512),
  }),
);
```

`desktopDiscoverHandler` / `desktopActHandler` の handler logic は **無修正**、Zod schema 不変、戻り値 shape (raw `ToolResult`) 不変。lease validator は wrapper options で渡す pure function (test 駆動可能)。

### 2.6 `args_summary` truncate logic (~512 byte)

```typescript
function truncateJson(args: unknown, maxBytes: number = 512): string {
  const json = JSON.stringify(args);
  if (json.length <= maxBytes) return json;
  return json.slice(0, maxBytes - 1) + "…";
}
```

**carry-over** (OQ #3): PII / secret redaction は expansion P2 work、本 S4 では truncate のみ。

---

## 3. 実装 sub-batch (本 PR 内、S4 trunk scope)

### 3.1 S4-1: L1 既存 payload schema 拡張 + napi binding signature 拡張 (~80 line Rust + 30 line TS) [S4 trunk、Rust touch]

- [x] `src/l1_capture/payload.rs`:
  - [x] `ToolCallStartedPayload` を `{ tool, args_json, lease_token: Option<LeaseTokenSummary> }` に拡張 (**既存 `args_json` field 名不変** Round 1 P1-2、末尾 optional `lease_token` 追加)
  - [x] `LeaseTokenSummary { entity_id, view_id, target_generation, evidence_digest_prefix8 }` 新型
  - [x] `ToolCallCompletedPayload` 不変 (S4 で field 追加不要、Round 2 で言及済)
- [x] `src/l1_capture/napi.rs`:
  - [x] `l1_push_tool_call_started` signature 拡張 (rename + lease_token optional 追加)
  - [x] `NativeLeaseTokenSummary` napi struct 新設
- [x] `index.d.ts` + `src/engine/native-types.ts` 更新: `NativeLeaseTokenSummary` 型追加 + `l1PushToolCallStarted` signature update (5th optional 引数追加)、top-level function export 数 **不変** (Opus Round 1 P2: 実数は main 時点で **61** = `index.d.ts` の `export declare function` 件数。本 S4 は既存 binding signature 拡張のみで新 top-level export なし、61 維持。Drafted v0.1/v0.2 で記載した「47 → 48」は napi-rs surface の前提誤りで、CLAUDE.md §3.1 fact 整合 sweep で潰すべき pattern)
- [x] 全 caller (`grep -rn "l1PushToolCallStarted" src/ tests/`) を確認 (~6-10 callsite、includes `tests/unit/l1-capture-panic-fuzz.test.ts:122,128` + `tests/unit/l1-capture.test.ts:163` + production callers)、**既存 4-arg 呼出は無修正で pass** (Round 1 P1-1 反映、TypeScript optional trailing semantic)

### 3.2 S4-2: `_envelope.ts` 拡張 — `makeCommitWrapper` + `makeQueryWrapper` (~150 line) [S4 trunk]

- [x] `src/tools/_envelope.ts` 拡張 (S3 で確立した `_envelope.ts` に追加):
  - [x] `CommitWrapperOptions<TArgs>` interface (§2.1)
  - [x] `QueryWrapperOptions` type (S3 alias、expansion 用余地、`no-empty-object-type` 回避で interface→type)
  - [x] `makeCommitWrapper(handler, toolName, options)` 実装 (§2.1 7 step flow)
  - [x] `makeQueryWrapper(handler, toolName, options)` 実装 (`makeEnvelopeAware` を直接 delegate)
  - [x] `nextToolCallId(sessionId)` helper (in-process monotone counter) + `_resetToolCallSeqForTest` (test-only)
  - [x] `truncateJson(args, maxBytes)` helper (UTF-8 safe truncate + `…` ellipsis sentinel)
  - [x] `mapLeaseValidationToTypedReason(reason)` helper (§2.2 reason → typed enum、`expired` 完全 + 残 3 reason は `Unknown` fallback)
  - [x] `buildFailureEnvelope(typedReason, tryNextActions, options?)` helper (§2.4 失敗時 envelope shape)
  - [x] `EnvelopeMinimalShape.confidence` を `"fresh" | "degraded" | "stale"` 3 値に bump (§2.4) + `if_unexpected?: IfUnexpectedShape` optional 末尾追加
  - [x] `LEASE_REASON_TO_TYPED_CODE` 定数 (4 LeaseStore reason → 4 typed code 名 1:1 mapping、expansion mechanical-copy のための contract pin)
  - [x] `defaultL1Emitter` + `CommitL1Emitter` interface (test inject seam)

### 3.3 S4-3: `desktop_discover` + `desktop_act` を wrapper 経由化 (~30 line) [S4 trunk]

- [x] `src/tools/desktop-register.ts` (MCP server 登録 site):
  - [x] `desktop_discover` 登録を `makeQueryWrapper(desktopDiscoverRawHandler, "desktop_discover")` で wrap
  - [x] `desktop_act` 登録を `makeCommitWrapper(desktopActRawHandler, "desktop_act", { leaseValidator, extractLeaseToken, fetchMeta })` で wrap
  - [x] `desktopDiscoverRegistrationSchema` / `desktopActRegistrationSchema` を `withEnvelopeIncludeSchema` 経由で生成、module-scope export
  - [x] `desktopDiscoverRegistrationHandler` / `desktopActRegistrationHandler` を module-scope export (PR #112 同型 strip risk 防止: `run_macro` 経路と shared instance)
- [x] `desktopDiscoverRawHandler` / `desktopActRawHandler` 自体は **handler internal logic 不変** (ADR-010 §1.5、validator 呼出 + facade.see/touch のみ)、Zod schema 不変、戻り値 shape (raw `ToolResult`) 不変
- [x] `src/tools/macro.ts` 更新: `TOOL_REGISTRY.desktop_discover` / `.desktop_act` を module-scope wrapped instance に切替、kill-switch gate は wrapper invocation BEFORE で残置

### 3.4 S4-4: lease validator 実装 (~50 line) [S4 trunk]

- [x] `src/tools/desktop.ts` `DesktopFacade.validateLeaseOnly(lease)` メソッド新設:
  - lease の `viewId` から session を `registry.getByViewId()` で route
  - session 不在時 (eviction 後) は `entity_not_found` reason 返却
  - 存在時は `session.leaseStore.validate(lease, session.generation, session.entities)` 呼出
  - side-effect-free (既存 `lastAccessMs` refresh のみ)、`touch()` を呼ばない pre-flight 専用
- [x] `src/tools/desktop-register.ts` `desktopActLeaseValidator(args)` closure 実装:
  - args から lease parse (型 narrow + null チェック)
  - `getDesktopFacade().validateLeaseOnly(args.lease)` 呼出
  - `LeaseValidationResult` を Promise で返す (commit wrapper が typed reason に mapping)
- [x] `desktopActExtractLeaseToken(args)` closure: `EntityLease` → `NativeLeaseTokenSummary` projection (`evidenceDigest` 8-char prefix)

### 3.5 S4-5: `tool_call_id` per-session counter (~30 line) [S4 trunk]

- [x] `src/tools/_envelope.ts` 内 `nextToolCallId(sessionId: string): string` 実装:
  - in-process Map<sessionId, counter> で per-session monotone seq
  - format: `"${sessionId}:${counter}"`
  - `_resetToolCallSeqForTest()` test seam (test 間の決定論性)
  - server-restart 跨ぎ uniqueness は OQ #1 carry-over (§8)

### 3.6 S4-6: contract test (~120 line) [S4 trunk]

- [x] `tests/unit/desktop-act-commit-wrapper.test.ts` 新設 (commit + query wrapper を 1 file で網羅):
  - [x] **G3-S4-1**: commit wrapper 正常 path — `desktop_act` 経由、l1PushToolCallStarted/Completed 呼出され、envelope shape return (envelope mode)、raw shape return (compat mode)
  - [x] **G3-S4-2**: lease validation `expired` → `if_unexpected.most_likely_cause: "LeaseExpired"` + `try_next: [{action: "desktop_discover", ...}]` typed return、handler 呼ばれない
  - [x] **G3-S4-2b**: 残 3 LeaseStore reason → `Unknown` typed code (sub-plan §7 R4 確認)
  - [x] **G3-S4-3**: lease validation 成功 → handler 呼出、ToolCallStarted (lease_token 含む) + ToolCallCompleted (elapsed_ms + ok: true) 両 event L1 に push される
  - [x] **G3-S4-4**: handler 内例外 → ToolCallCompleted (ok: false + error_code) push、envelope failure (data: null + confidence: "stale" + if_unexpected.most_likely_cause: 適切 typed enum) return
  - [x] **G3-S4-4b**: handler `{ok: false, code}` 返却 → ToolCallCompleted ok:false + propagated code
  - [x] **G3-S4-5**: `args_summary` 512 byte truncate 動作確認 (UTF-8 safe + Japanese 3-byte char + circular ref fallback)
  - [x] **G3-S4-6**: `tool_call_id` per-session monotone seq pin (sessionA:1, sessionA:2, sessionB:1, sessionA:3 順)
  - [x] **G3-S4-7**: query wrapper 正常 path — `desktop_discover` 経由、ToolCall event push されない (query 軸、副作用なし)、envelope shape return
  - [x] **G3-S4-8**: query wrapper が handler 側 lease_token を envelope `data` 経由で透過 (handler 直接生成、wrapper は envelope assembly のみ)
  - [x] env=1 priority chain + include=['raw'] override on failure path
  - [x] lease validator 省略 (lease-less commit、`click_element` バリエーション) — handler 直呼び、validation skip
- [x] **35/35** test pass (G3-S4-1〜G3-S4-8 + helper 単体 + 残 3 reason mapping pin + lease-less commit + Round 1 P1 fix `compatFailureRaw` 直 unit test 4 件 + raw-mode legacy fallback test 3 件 + Round 3 Codex P2 sentinel fix `throw undefined` / `Promise.reject(null)` test 2 件 = 累積 +9)

### 3.7 S4-7: 検証 (cargo + npm + e2e + bench) [S4 trunk]

- [x] `cargo check --workspace --locked`: clean (既存 6 warnings のみ)
- [x] `npm run check:rs-workspace`: clean
- [x] `npm test` (vitest unit): **2527** pass / 25 skipped (regression 0、Round 1 P1 fix で +7 test + Round 3 P2 sentinel fix で +2 test = 累積 +9)
- [x] `npm run bench:envelope-size`: S3 で確立した bench harness に **failure envelope 3 シナリオ** 追加 (`lease_expired` 216B / `lease_residual` 152B / `handler_threw` 152B) → 全 < 5KB 確認 (G3 #4、ADR-010 §5.6.1)
- [x] `npm run check:napi-safe` / `check:native-types` (top-level export 数 **61 不変**、S4-1 で `NativeLeaseTokenSummary` interface 追加 + 既存 `l1PushToolCallStarted` binding signature 5th 引数拡張、新 top-level export なし。Opus Round 1 P2 反映: 当初 v0.1/v0.2 の「48」は napi-rs surface の前提誤りで、main の `index.d.ts` `export declare function` 件数は既に 61) / `check:stub-catalog` / `npm run build` / `npm run lint`: 全 pass
- [ ] `npm run test:e2e` (or 等価 e2e suite): `desktop_discover` / `desktop_act` 既存 e2e test 無修正 pass (compat mode default で raw shape 維持、G3 #1 必須) — **CI で確認** (Win11 dogfood 専用、本 PR の 6-guard + unit suite で structural compat は pin 済)

### 3.8 S4-8: G3 ゲート判定 + Appendix C append (~5 line、impl PR merge 後) [S4 trunk]

- [x] **本 PR で同梱**: `docs/walking-skeleton-trunk-selection.md` Appendix C 末尾に判定結果 append 済 (line 477、本 sub-plan §3.8 完了基準を merge 前に踏む形で先行 commit。Opus Round 1 P2 #4 反映: 「impl PR merge 後」前提を本 PR 同梱に切替、checklist `[ ]` → `[x]` flip):
  ```markdown
  | G3 | 2026-05-01 | 継続 | commit 軸 wrapper (`makeCommitWrapper`) + query 軸 wrapper (`makeQueryWrapper`) で `desktop_discover/act` の挙動を破壊せず envelope 化、lease 4-tuple validation `LeaseExpired` typed return が 1 path 動作、L1 既存 ToolCallStarted (=100) / ToolCallCompleted (=101) payload schema 拡張 (新規 EventKind 追加なし)、failure envelope size 216B (LeaseExpired) / 152B (residual) で < 5KB SLO 維持。S5 caused_by linkage で ToolCall event を session 内 history buffer 経由展開する base 確立 | (なし) |
  ```
- [ ] 判定が「shrink」の場合は S5 (caused_by) scope を次 sub-plan §1.1 から削る判断を本 sub-plan §6 follow-up に記録 (本 PR は **継続** 判定なので skip、checkbox 残置で意図を pin)

### 3.9 S4-9: CI workflow 拡張 + Push 6-guard + Opus + Codex review [S4 trunk]

- [x] `benches/l4_envelope_size.mjs` を update: failure envelope 3 シナリオ追加 (lease_expired / lease_residual / handler_threw)、5120-byte SLO check 含む
- [x] **Opus phase-boundary review Round 1** (CLAUDE.md §3.3 Step 1): P1 ゼロ + P2 4 件 (compatFailureRaw `diff` field + numeric count sync test 26→33 / export 48→61 + checklist sync) + P3 2 件、本 commit (Round 2) で全 P2 反映
- [x] **Codex re-review Round 1** (CLAUDE.md §3.3 Step 2): 2 inline comment (P1 raw-mode failure null + P2 production tool_call_id session source) → Round 1 fix commit `9da7246` で全反映済
- [x] **Codex re-review Round 2**: 1 新規 P2 inline (`_envelope.ts:961` `handlerError !== undefined` sentinel が `throw undefined` / `Promise.reject(null)` を falsely success 扱いして wrapper crash) → Round 3 fix commit で boolean sentinel `handlerThrew` に切替 + regression test 2 件追加
- [ ] **Opus phase-boundary review Round 2**: Round 2 fix 反映後 + Round 3 Codex P2 fix 込みで再判定、指摘ゼロまで反復

---

## 4. 対 Opus 単独判断盲点 sweep (Lesson 1-4 防御、PR #99/#102/#103/#104/#105/#107/#108/#109/#110 で 9 連続再発 pattern)

memory `project_adr008_d2_c_plan_done.md` Lesson 1-4 + `feedback_autonomous_phase_transition.md` で蓄積済 User reviewer による Opus 単独 sweep 補正 pattern を本 sub-plan で防御化:

### 4.1 contract 自体の妥当性 review

- [ ] `makeCommitWrapper` 7 step flow が **既存 desktop_act の e2e behavior を破壊せず** envelope wrap できるか? handler 内 logic / Zod schema / 戻り値 shape 不変が runtime で実証可能か?
- [ ] **S4 trunk runtime 配線 = `expired → LeaseExpired` 1 path のみ完全実装** (try_next 配線含む)。残 3 LeaseStore reason (`generation_mismatch` / `entity_not_found` / `digest_mismatch`) は **typed code 名 (`LeaseGenerationMismatch` / `EntityNotFound` / `LeaseDigestMismatch`) の contract pin のみ** (= 名前を §2.2 mapping table と sub-plan に明示固定 / runtime 配線は `Unknown` fallback で expansion mechanical コピー追加可能な状態を確立) — Round 5 P2-5 反映: 旧 acceptance 「reason 4 種 → typed 4 種 1:1 mapping が完全」は S4 scope 越えて全 4 path 実装を要求と読めた、§1.1 F / §2.2 / §7 R4 の「expired 1 path 完全 + 残 3 carry-over」と整合に修正
- [ ] **`EntityOutsideViewport`** は LeaseStore.validate() の reason ではない別経路 typed code、本 S4 trunk 範囲外 (carry-over、WindowChanged event 等の viewport 外 detect で発生、expansion work)
- [ ] S5 caused_by linkage 着手時に `expired → LeaseExpired → try_next: [{action: "desktop_discover"}]` 1 path が caused_by.last_action と integral か (残 3 mapping + EntityOutsideViewport 別経路 は別 PR で同型 contract 確認)?
- [ ] **`args_json` field 名不変** (Round 1 P1-2 反映): rename しない方針、`index.d.ts:280` + `src/engine/native-engine.ts:282` の npm public type signature 維持、production / test 全 caller (~6-10 callsite + npm external consumer) 無修正で pass か? `grep -rn "args_json" src/ tests/ index.d.ts` で「rename 不要」と「summary semantic は caller 側 truncate」の両軸を確認
- [ ] `EnvelopeMinimalShape.confidence` 2 値 → 3 値 bump (`stale` 追加) が S3 で確立した 2 値分岐 contract test (G3-7 等) を破壊しないか?
- [ ] `tool_call_id` の in-process monotone counter が server-restart 跨ぎで衝突しないか? OQ #1 carry-over で expansion 永続化 schema 必要、本 trunk skeleton 段階で十分か?

### 4.2 compile-time guard 過信判定

- [ ] `cargo check` clean だけで `ToolCallStartedPayload` 拡張が **既存 L1 ring data 互換** であることは保証されない、bincode encode/decode で binary compat 維持を runtime test で確認必須 (`encode_payload` round-trip pin)
- [ ] `npm run build` (tsc) clean だけで `makeCommitWrapper` の 7 step flow が runtime で正しく動作することは保証されない、unit test G3-S4-1〜G3-S4-8 で各 path を runtime 確認必須

### 4.3 両 doc 順序矛盾 (S4 → S5 直列前提 keyword sweep)

- [ ] `docs/walking-skeleton-trunk-selection.md` §4 S4 line 232-251 + §4.1 line 305 直列前提 / 親 plan ADR-010 §5.4 typed reason / S3 sub-plan PR #110 §1.4 で S4 言及 (lease validation を trunk で踏む) / 本 sub-plan §0 (line 25-30) の 4 SSOT で **S4 → S5 着手順序が一致**しているか?
- [ ] `Grep "S4 → S5|S5 (caused_by|S5 で finalize|本 S4 で確立"` で 4 SSOT の表記揺れがないか?

### 4.4 restore 後 numeric count sync 漏れ (carry-over → restore で件数表記更新)

- [ ] §3 sub-batch 数 (S4-1〜S4-9 = **9 件**)、§7 Risks 数 (**8 件**、R1-R8)、§8 OQ 件数 (**3 件**)、size 想定 (~400-600 line / 4-5 日 = walking-skeleton §4.1 line 305 整合) が本 sub-plan 内で bit-equal か?
- [ ] `Grep "400-600 line\|4-5 日\|9 件\|3 件\|8 件 Risks\|R1-R8\|G3-S4-1.*G3-S4-8\|top-level export 61 不変\|35/35 test"` で本 sub-plan 内 numeric counts が bit-equal か? (Round 1 P2-2 反映 + Opus Round 1 P2 numeric count fix: napi 48 → **61**、test 26/26 → **33/33** → **35/35** (Round 3 で +2 sentinel test))

### 4.5 既存 public API 破壊禁止 (CLAUDE.md §3.2 PR #102 教訓延長)

- [ ] **既存 EventKind 番号 100/101 不変** (§1.1 E + §1.4)、新規 EventKind 追加なし — Walking skeleton §4 line 240 + Opus PR-η P1-4 教訓と整合
- [ ] 既存 `l1_push_tool_call_started/completed` napi binding signature 拡張は **新 optional 引数追加のみ** (`lease_token: Option<...>`)、既存 caller (`l1_push_tool_call_started(tool, args, sessionId, toolCallId)` 4 引数) を破壊しないか? Rust napi `Option<NativeLeaseTokenSummary>` で undefined を許容、既存 caller は無修正で pass
- [ ] `args_json` field 名は **本 PR で rename しない** こと `grep` で確認 (Round 1 P1-2 反映: `index.d.ts:280` + `native-engine.ts:282` の npm public type signature 維持、PR #110 Round 1 P1-3 「前例あり」factually incorrect 同型 risk 軸延長で慎重 review)
- [ ] `desktop_discover` / `desktop_act` の handler internal logic + Zod schema + 戻り値 shape **不変** (§1.1 D + §2.5)、ADR-010 §1.5 SSOT 整合
- [ ] `EnvelopeMinimalShape.confidence` 3 値 bump (`stale` 追加) が S3 trunk の 2 値分岐 contract test を破壊しないか? S3 contract test (G3-7) は `fresh`/`degraded` 2 値 only mock、`stale` 追加でも assertion 範囲外なので backward compat 保証

---

## 5. PR 切り方

| sub-batch | 範囲 | size 想定 |
|---|---|---|
| **S4 (本 PR、merged sub-batch)** | 3.1 L1 payload schema + napi 拡張 + 3.2 _envelope.ts commit/query wrapper + 3.3 desktop_discover/act wrap + 3.4 lease validator + 3.5 tool_call_id counter + 3.6 contract test 8 件 + 3.7 検証 + 3.8 G3 gate + 3.9 CI + Opus + Codex review | **400-600 line** (walking-skeleton §4.1 line 305 工数 4-5 日 / Codex ✓ 必須軸 = 既存 EventKind payload 確定 + L1 napi binding signature 拡張、Rust ~100 line + TS ~300-500 line) |

**1 PR で land**、sub-batch 分割しない (commit 軸 wrapper template + L1 payload schema 確定 + lease validation 1 path + ToolCall event 配線が 1 つの contract spike として完結)。**Opus 2-3 round 想定** (walking-skeleton §4.1 line 305) + **Codex re-review 必須 1 round** (CLAUDE.md §3.2 PR #102 教訓延長: 既存 EventKind payload 確定 + napi binding signature 拡張 = API contract 軸の Codex 強み)。

`docs/walking-skeleton-trunk-selection.md` §4.1 の S4 概算 **4-5 日 / Opus 2-3 round / Codex ✓** に整合 (line 305)。

---

## 6. follow-up (carry-over、§3.bis ledger / OQ で永続化)

trunk + expansion 完了後の別 phase で carry-over:

- **expansion**: 残 ~24 commit tool wrapper 化 (mouse_click / keyboard / clipboard / scroll / focus_window / browser_click / 等) — `makeCommitWrapper` mechanical コピー
- **expansion**: 残 ~10 query tool wrapper 化 — `makeQueryWrapper` mechanical コピー
- **expansion**: `click_element` lease 不在 commit バリエーション — `makeCommitWrapper` の lease validation skip option 追加で対応
- **expansion**: typed reason 残 36 codes (ADR-010 §5.4) 全網羅 + `try_next: TypedAction[]` 進化
- **expansion**: dry-run integration (ADR-010 P5)
- **OQ #1 (S5 finalize)**: `tool_call_id` cross-server-restart unique 永続化 schema
- **OQ #2 (S5 finalize)**: `caused_by.your_last_action` semantic 解釈
- **OQ #3 (expansion P2)**: `args_summary` PII / secret redaction logic

---

## 7. Risks / Mitigation

| # | Risk | 影響 | Mitigation |
|---|---|---|---|
| R1 | `args_json` field 名維持 (rename 中止、Round 1 P1-2 反映) で外部 caller 互換、ただし Optional 末尾追加 `lease_token` の bincode binary compat (R5 と並列軸) | 中 | Round 2 で rename 中止確定、`index.d.ts:280` + `native-engine.ts:282` 維持、production / test 全 caller (~6-10 callsite + npm external consumer) 無修正 pass。`lease_token` 末尾 optional 追加の bincode 互換は §7 R5 で別途 mitigation (in-memory ring 単一 server lifetime 限定) |
| R2 | `EnvelopeMinimalShape.confidence` 3 値 bump で S3 trunk contract test 破壊 | 中 | §4.5 で S3 G3-7 test (`fresh`/`degraded` mock) は `stale` 追加で assertion 範囲外、backward compat 保証。新 G3-S4-2 で `stale` failure case を pin |
| R3 | `tool_call_id` in-process counter が server-restart 跨ぎで衝突、L1 ring 経由 history buffer の uniqueness 破壊 | 中 | OQ #1 carry-over、本 trunk では `session_id:counter` 形式で session 内 unique 保証、cross-server-restart 永続化は expansion ADR-011 work |
| R4 | `LeaseStore.validate()` reason 4 種 → typed enum 4 lease-direct codes (1:1 mapping) のうち `expired` 1 path のみ S4 trunk 配線で残 3 LeaseStore mapping (`generation_mismatch` / `entity_not_found` / `digest_mismatch`) + 別経路 `EntityOutsideViewport` が runtime で発生 → `Unknown` typed enum 落ち (Round 3 P2-4 反映: 旧版「残 4 mapping」は 4 reason → 5 typed code 混同の残骸、正しくは 残 3 LeaseStore mapping + EntityOutsideViewport は LeaseStore.validate() reason ではなく別経路 = WindowChanged event 等での viewport 外 detect で発生) | 中 | S4 trunk は `expired → LeaseExpired` 1 path 完全実装 + 残 3 LeaseStore reason は `Unknown` fallback (ADR-010 §5.4 既存 23 codes、Phase 6 cleanup 後 = PR-A -3 + PR-B +1、に Unknown 含む)、`EntityOutsideViewport` 別経路は本 trunk 範囲外 carry-over (WindowChanged event 配線は expansion work)、expansion で残 3 LeaseStore mapping + EntityOutsideViewport 別経路 配線を mechanical コピー追加 |
| R5 | bincode encode/decode で `ToolCallStartedPayload` 拡張前後の binary compat 破壊 (既存 L1 ring data 読取り不能) | 中 | L1 ring は **in-memory ring buffer** (永続化なし、server 起動毎に空)、cross-server-restart の binary compat は trunk scope 外。本 trunk 内では single-server-lifetime での encode/decode 整合のみ確保、§3.7 S4-7 で encode_payload round-trip pin test (新 field `lease_token` Optional 末尾追加 + 既存 `args_json` field 不変)、bincode struct field 順序維持。Cross-server replay のための binary versioning は ADR-011 expansion で着手 |
| R6 | `makeCommitWrapper` の 7 step flow で example DesktopAct logic と integration error (lease validator 呼出 timing、handler invoke の async 順序、L1 push の error swallow) | 中 | §3.6 G3-S4-1〜G3-S4-6 で各 step の order を pin、handler 内 throw → ToolCallCompleted (ok: false) の経路を G3-S4-4 で test |
| R7 | failure envelope size > 5KB (`if_unexpected.try_next` の各 action shape 膨張) | 中 | §3.7 で bench harness failure envelope シナリオ追加 (G3 #4)、5KB 超過時は ADR-010 §5.6.1 を bit-equal sync で expansion 調整、本 trunk では `try_next` 1 path のみで size 抑制 |
| R8 | Round 2 で導入する `LeaseTokenSummary.evidence_digest_prefix8` (8 文字 prefix) の uniqueness が同 view 内で衝突 | 低 | evidence_digest は full hash (32-64 char SHA-256 等)、prefix 8 char で衝突 risk = 1/2^32 ≈ 4.3 億分の 1。同 view 内 entity 数 < 1000 で衝突確率 << 1%、production で実用十分。完全 uniqueness 必要ならexpansion で full digest expose に bump 可能 |

---

## 8. Open Questions (S4 trunk-relevant、3 件)

| # | OQ | 決定タイミング | 推奨 (Opus 判断委譲) |
|---|---|---|---|
| 1 | `tool_call_id` cross-server-restart unique 永続化 schema — 本 trunk in-process counter で十分か、永続化 store (SQLite / file) 必要か。**Opus Round 1 P3 反映**: 現実装の `_toolCallSeq: Map<string, number>` (`src/tools/_envelope.ts:728` 周辺) は eviction なし、production の `getSessionId(args) → lease.viewId` (Round 1 P2 fix) で session ID が `randomUUID()` から派生するため、長時間動作中に Map entry が増加する潜在 leak がある。S4 trunk では `getSessionId` が default で `"default"` 1 entry のみのため問題顕在化せず、S5 で本格運用に乗る際に **LRU eviction (例: 上限 1k entry、TTL 24h) を実装する必要あり**。S5 着手時に本 OQ で同時 finalize | expansion ADR-011 work、または S5 着手時 | **本 trunk in-process** で十分 (sessionId が server-restart で reset されるため per-session unique で OK、本 PR 範囲 + S5 の per-session history buffer 動作で leak 顕在化前に対処可能)、永続化は ADR-011 (Cognitive Memory Taxonomy) で session 跨ぎ episodic memory と統合検討、S5 着手時に LRU eviction 実装で本 OQ resolve |
| 2 | `caused_by.your_last_action` semantic 解釈 — 直前 `desktop_act` 限定 / 直前任意 commit tool / 直前任意 tool (query 含む) | S5 着手時 finalize | **直前任意 commit tool** 推奨 (副作用持ち tool のみ history buffer 対象、query は副作用なし `caused_by` 文脈外)、S5 で per-session ring buffer 仕込み + `caused_by.your_last_action` projection 実装時に確定 |
| 3 | `args_summary` PII / secret redaction logic — JSON.stringify truncate のみ / regex pattern detect / typed schema-based redaction | expansion P2 work | **truncate のみ** (S4 trunk skeleton で十分)、PII redaction は `_errors.ts::SUGGESTS::args_redacted` 拡張と統合して expansion で一括対応 (ADR-010 §10 P2 acceptance criteria coverage > 95% mapping) |

---

## 9. walking skeleton + ADR-010 P1 全体図 (本 PR の位置づけ)

```
Walking skeleton trunk:
┌──────────────────────────────────────────────────────────────────────┐
│  S1 (PR-η D2-E0):  dataflow scope refactor                ✅ merged  │
│      ↓                                                                │
│  S2 (PR-ε D2-C):   count-only dirty_rects_aggregate       ✅ merged  │
│      ↓                                                                │
│  S3 (PR #110 review 中): envelope minimal wrapper + compat mode      │
│      ↓                                                                │
│  S4 (★ 本 PR): commit/query 軸 wrapper + lease 4-tuple validation     │
│       + ToolCallStarted/Completed payload schema 確定                 │
│      ↓                                                                │
│  S5: caused_by linkage cross-layer (★ 最重要 contract)                │
│      ↓                                                                │
│  S6: trunk 完了判定 + CI assert + expansion plan 起草                 │
└──────────────────────────────────────────────────────────────────────┘

S4 内部の commit / query wrapper layer 図 (本 PR の改修範囲):

[S3 merged shape (envelope skeleton + makeEnvelopeAware)]
                  ↓
[S4 PR-? land 後] commit 軸 + query 軸 wrapper template:

desktop_discover (query 軸):
  MCP tool registration:
  mcp.tool("desktop_discover", schema, makeQueryWrapper(handler, "desktop_discover"))
                                                 │
                                                 ▼
  L5 wrapper: makeQueryWrapper (NEW)
       │
       ├─ peek + strip args.include (S3 inherit)
       ├─ invoke handler with stripped args
       │     │
       │     └─ handler issues lease via LeaseStore.issue(), returns raw {data: {...lease_token...}}
       │
       ▼
  buildEnvelope (S3 inherit) + compatHoist (S3 inherit、post-flatten compat mode)
       │
       └─ envelope or raw shape return (既存 client 互換)


desktop_act (commit 軸):
  MCP tool registration:
  mcp.tool("desktop_act", schema, makeCommitWrapper(handler, "desktop_act", { leaseValidator, argsSummary }))
                                                 │
                                                 ▼
  L5 wrapper: makeCommitWrapper (NEW、7 step flow)
       │
       ├─ 1. peek + strip args.include
       ├─ 2. lease validation (LeaseStore.validate()):
       │      ├─ expired   → return failure envelope (LeaseExpired + try_next: desktop_discover)
       │      ├─ generation_mismatch / entity_not_found / digest_mismatch
       │      │              → return failure envelope (Unknown + try_next: desktop_discover) [carry-over]
       │      └─ ok        → proceed
       ├─ 3. tool_call_id 採番 (sessionId:counter)
       ├─ 4. l1PushToolCallStarted({ tool, args_json, lease_token })   // ★ field 名は既存 args_json (PR #111 Round 2 P1-2: rename 中止、npm public type signature 維持)。値は §2.6 truncate (~512 byte) を経た summary 文字列。
       ├─ 5. invoke handler (raw side effect)
       ├─ 6. l1PushToolCallCompleted({ tool, elapsed_ms, ok, error_code? })
       │
       ▼
  buildEnvelope (S3 inherit) + compatHoist
       │
       └─ envelope or raw shape return


L1 既存 EventKind 番号 100/101 (不変):
  ToolCallStarted (=100):    src/l1_capture/payload.rs ToolCallStartedPayload 拡張
                             { tool, args_json, lease_token: Option<LeaseTokenSummary> }   // ★ field 名 args_json 既存維持 (Round 2 P1-2)、内容は wrapper 側で truncate 済 summary
  ToolCallCompleted (=101):  既存 ToolCallCompletedPayload 不変
                             { tool, elapsed_ms, ok, error_code }


S5 caused_by linkage 着手時 (★ 最重要 contract):
  - per-session ring buffer (in-process Map<sessionId, Array<ToolCallEvent>>)
  - `caused_by.your_last_action` field を envelope に展開、本 S4 で配線した
    ToolCallStarted event を input source として直前 commit tool 名 + args_json (truncate 済 summary 文字列) 抽出
  - caused_by.based_on.events: [event_id_started, event_id_completed]
  - caused_by.elapsed_ms: ToolCallCompleted.elapsed_ms
```

---

## 10. References

- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.4) §4 S4 (line 232-251) + §4.1 line 305 + §5 G3 ゲート (line 343)
- 概念設計: `docs/adr-010-presentation-layer-self-documenting-envelope.md` §5.3 (失敗時 envelope) + §5.4 (typed reason 35 codes、Phase 6 cleanup 後 = PR-A -3 + PR-B +1、LeaseExpired 第一候補) + §5.6 (envelope size SLO、failure < 5KB)
- 統合書 (SSOT): `docs/architecture-3layer-integrated.md` §4 (4-tuple lease: entityId / viewId / targetGeneration / evidenceDigest) + §6 (1 event の旅 worked example) + §11.2 (compat mode SSOT、S3 で確立)
- 並走依存 sub-plan: `docs/adr-010-p1-s3-plan.md` (PR #110 review 中、本 sub-plan は S3 で確立する `_envelope.ts::makeEnvelopeAware` + envelope SSOT shape を base に commit/query 軸 wrapper を建てる、impl 順序は S3 impl merged → 本 S4 impl)
- 既存実装:
  - `src/l1_capture/envelope.rs` line 60-84 (既存 `EventKind::ToolCallStarted (=100)` / `ToolCallCompleted (=101)`、本 PR で番号不変)
  - `src/l1_capture/payload.rs` (既存 `ToolCallStartedPayload` / `ToolCallCompletedPayload`、本 PR で `ToolCallStartedPayload` 拡張 + `LeaseTokenSummary` 新型)
  - `src/l1_capture/napi.rs` line 33-80 (既存 `l1_push_tool_call_started` / `l1_push_tool_call_completed` napi binding、本 PR で signature 拡張)
  - `src/engine/world-graph/lease-store.ts` (既存 `LeaseStore.validate()`、reason 4 種 → typed enum **4 種 lease-direct codes** 1:1 mapping を本 PR で確立、5 番目 `EntityOutsideViewport` は別経路 carry-over)
  - `src/tools/desktop.ts` / `src/tools/desktop-register.ts` (既存 `desktop_discover` / `desktop_act` handler、本 PR で wrapper 経由化のみ、handler 内 logic 不変)
  - `index.d.ts` line 280-281 (既存 `l1PushToolCallStarted` / `l1PushToolCallCompleted` napi binding declaration、本 PR で signature update)
- governance: CLAUDE.md 強制命令 3 + 3.1 + 3.2 (PR #102 教訓延長、既存 EventKind 番号不変 + napi binding signature 拡張 only) + 3.3 (PR レビューループ定型) + 7 + 8 + 9
- memory: `project_adr008_d2_c_plan_done.md` Lesson 1-4 + `feedback_autonomous_phase_transition.md` (新運用モード) + `feedback_carry_over_scope_shrink.md` (CLAUDE.md §3.2 PR #102 教訓)
- 同型先例:
  - sub-plan 構造: PR #103 (S2 D2-C sub-plan) + PR #104 (S1 D2-E0 sub-plan) + PR #110 (S3 envelope sub-plan) — 3 分類 trunk/expansion/carry-over + Round 1/2 review iteration
  - L5 wrapper helper 設計: PR #110 S3 で確立した `makeEnvelopeAware` を base、本 S4 で `makeCommitWrapper` + `makeQueryWrapper` に拡張
  - L1 napi binding signature 拡張: PR #105 D2-E0 で `view_get_focused` 新設 + PR #110 S3-2 で `view_get_focused_with_wallclock` 拡張、本 S4 で `l1_push_tool_call_started` signature 拡張 (既存 binding update)

---

## Appendix A: 改訂履歴

| version | date | author | summary |
|---|---|---|---|
| Drafted v0.1 | 2026-05-01 | Claude (Sonnet) | 初稿起草、walking skeleton S4 sub-plan、commit 軸 (`makeCommitWrapper`) + query 軸 (`makeQueryWrapper`) wrapper template + lease 4-tuple validation `LeaseExpired` typed reason 1 path 実装 + L1 既存 `EventKind::ToolCallStarted/Completed` payload schema 確定 (新規 EventKind 追加なし) + `desktop_discover/act` wrapper 経由化 + envelope failure size < 5KB bench + G3 ゲート判定。Codex re-review 必須 1 round (既存 EventKind payload 確定軸) |
| Drafted v0.2 | 2026-05-01 | Claude (Sonnet) | **Opus PR #111 Round 1 review 反映** (Not approved、P1×5 + P2×6 + P3×2): **P1-1** napi binding signature 拡張で `lease_token` 3rd 挿入 → silent breakage 6 callsite → Round 2 で **末尾 5th optional 追加** に修正、既存 4-arg positional callers (`tests/unit/l1-capture-panic-fuzz.test.ts:122,128` + `tests/unit/l1-capture.test.ts:163`) 無修正 pass 担保。**P1-2** `args_json` → `args_summary` rename = npm public type signature breakage (`index.d.ts:280` + `native-engine.ts:282` 公開済) → Round 2 で **rename 中止**、既存 `args_json` field 名維持、CLAUDE.md §3.2 既存 API 破壊禁止に整合。**P1-3** `EnvelopeMinimalShape.confidence` 3 値 bump の S3 並走依存明示 → §2.4 で「S3 contract test (G3-7) assertion 形式が確定後 final check」note 追記、ADR-010 §5.3 snake_case vs §5.4 PascalCase 表記揺れも Round 1 P3-1 同箇所で note。**P1-4** "1:1 mapping" 事実誤認 (4 reason → 5 typed = 1:1 ではない) → §1.4 + §2.2 を **4 reason → 4 typed codes 1:1 + `EntityOutsideViewport` 別経路 5th typed code** に修正、§2.2 を 2 つの table に分離。**P1-5** `_post.ts::recordHistory` への touch が S4 trunk scope 超え → §1.3 OQ #2 から「base 仕込む」削除、純粋 carry-over (S5 着手時 finalize) に変更。**P2-1** §3.1 caller grep scope を `src/ tests/` に拡張、callsite count `~3-5` → `~6-10`。**P2-2** §4.4 grep keyword に `8 件 Risks` + `R1-R8` + `top-level export 48 不変` 追加。**P2-3** 47 → 48 napi exports 矛盾を「S3 で消化済 48、本 S4 は signature 拡張のみで top-level export 数不変」に統一。**R1** mitigation 全面書き直し (rename 中止 → 既存 field 名維持 + bincode binary compat 別軸を R5 に分離)、**R5** mitigation 「in-memory ring single-server-lifetime 限定」と明示 |
| Drafted v0.3 | 2026-05-01 | Claude (Sonnet) | **PR #113 (impl PR) review-loop iteration ledger** (Round 1〜3 の永続記録、CLAUDE.md §9 残件は docs/ 永続化 + Opus Round 2 P3 反映): **Round 1** (commit `9da7246`、Codex bot inline review + user PR comment): **P1** raw-mode failure path で literal `null` を return していたのを `compatFailureRaw(envelope) → {ok:false, reason:"<snake_case>", if_unexpected:{...}}` に切替、pre-S4 `desktop_act` raw client 互換維持。**P2** production `desktopActWrapperOptions.getSessionId` を `(args) => args.lease?.viewId ?? "default"` で override、production tool_call_id の per-session monotone uniqueness pin。**Round 2** (commit `a8edf34`、Opus phase-boundary review Round 1、P1 ゼロ + P2×4 + P3×1): **P2 §3.2** `compatFailureRaw` に `diff: never[]` field 追加、pre-S4 `TouchResult.diff` field 既存契約を wrapper failure 経路でも維持 (PR #102 同型 carry-over scope shrink regression 防止)。**P2 §3.1** sub-plan numeric count sync (test 26/26→33/33、export 48→61、main 時点で既に 61 と判明、v0.1/v0.2 napi-rs surface 前提誤り)。**P2** checklist sync (§3.8 Appendix C `[x]` flip、§3.9 Round 1/2 split)。**P3** `_toolCallSeq` Map メモリ leak risk を §8 OQ #1 に補記、S5 着手時 LRU eviction (1k entry / TTL 24h) で resolve。**Round 3** (commit `eb4654d`、Codex bot Round 2 inline review、P2×1): **P2** `_envelope.ts:961` `handlerError !== undefined` sentinel が `throw undefined` / `Promise.reject(null)` を falsely success 扱いして wrapper crash → boolean sentinel `handlerThrew` に切替 + regression test 2 件追加 (test 33/33 → 35/35)。**Opus Round 2 final sweep** (P1 ゼロ + P2×2 doc-only numeric stale + P3 v0.3 bump): test count §3.7「2525」→ **2527**、§4.4 grep keyword「33/33」→ **35/35** に sync、本 v0.3 entry で review-loop 全体 ledger を永続化 (本書きは v0.3 自身)。**累積 review iteration**: Codex bot 2 round + Opus phase-boundary 2 round + user reviewer 1 round = **5 review pass で merge-ready** に到達 |

---

END OF walking skeleton S4 sub-plan (Drafted v0.3)。
