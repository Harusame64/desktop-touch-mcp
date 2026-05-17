# ADR-020 Phase 3 SR-2 — handler internal Result + envelope central converter + handler boundary 共通 pattern sub-plan

- Status: **Drafted (2026-05-17、Round 4 = PR-SR2-1 land 後 grep verify で 29 handler 全件 `failWith` 経路使用判明 → PR-SR2-2 削除 + SR-2 を PR-SR2-0/1/3 の 3 PR 構成に縮小、User 確定で scope shrink、累積 18 件 closure)**
- 親 ADR: `docs/adr-020-path-class-refactor-plan.md` §5.1 SR-2 (Round 4 P1-3 確定: (c)+(b) ハイブリッド)
- 着手 trigger: ADR-020 SR-5 全 PR land 完了 (PR #343-#345 merged、main HEAD `b2ab47a`)
- baseline commit: `b2ab47a` (main HEAD、PR-SR5-2 merge 後)
- 着手順序: Phase 3 4 SR のうち **3 番目** (SR-1 → SR-5 → **SR-2** → SR-4、親 ADR §5.1)
- 関連 SSOT: `src/tools/_envelope.ts:1197` `buildFailureEnvelope` + 6 caller (line 2910/2990/3252/3267/3282/3297) / 29 handler 全 file (browser/desktop-register/desktop-state/macro/mouse/notification/screenshot/server-status/ui-elements/wait-until/window/workspace) / `src/server-windows.ts` + `server-linux-stub.ts` MCP server entry
- 北極星抜粋 (親 ADR §2 から SR-2 への refinement): **handler failure path を Result.err typed error に寄せる + envelope 変換を `toFailureEnvelope` 1 関数に集約 + handler boundary 共通 pattern で形式統一**、`executor_failed` return path のような silent bypass を構造的に根絶
- 関連 OQ: **OQ #7** (親 ADR §10、SR-2 sub-plan 分割で handler 群ごとの境界をどう切るか) → 本 sub-plan §3 で確定 (case (a) tool category ごと採用)

---

## 1. 背景

### 1.1 baseline G 軸 (E #329) の drift 構造

PR #329 (Issue #327 item G、2026-05-08 merged) で `desktopActRawHandler` の `executor_failed` return path に対する局所 attach + `SUGGESTS.ExecutorFailed` entry 追加で **dogfood 症状の tactical fix** 達成。ただし以下の **drift 構造は残存** (ADR-020 §1.1 G 行):

| 軸 | 現状 (baseline `b2ab47a`) | drift 結果 |
|----|---------|----------|
| **tool description `if_unexpected`** | `desktop_act` 等の tool description で `try_next` / `most_likely_cause` advertise (`src/tools/_envelope.ts:1210` `buildFailureEnvelope` で envelope に emit) | LLM が advertise された recovery hint を期待 |
| **failure path 3 系統並立** (Round 2 grep verify で確定) | (1) **throw 経路**: handler 内で throw → `_envelope.ts` の 6 caller で `try/catch` + `buildFailureEnvelope` で envelope 化 / (2) **PR #329 独立 return ok:false 経路**: `desktopActRawHandler:596-601` で `return { ...result, if_unexpected: buildExecutorFailedIfUnexpected() }` 形式 (`failWith` 経由ではない片刺し独立 hook) / (3) **`failWith` 経路** (`_errors.ts:685-719` 定義、176 callsite): handler 内部標準 failure path で `ToolFailure` shape (`{ok:false, code, error, suggest, ...rootExtras}`) return | **3 系統が並立、`buildFailureEnvelope` hook は (1) のみ自動 + (2) PR #329 で 1 件手動 + (3) `failWith` 独自 shape**、新 handler 追加で hook 漏れる risk + envelope shape 不統一 |
| **handler 数 + 不統一** | 29 handler (8 browser + 3 desktop-register + 1 desktop-state + 1 macro + 3 mouse + 1 notification + 3 screenshot + 1 server-status + 1 ui-elements + 1 wait-until + 1 window + 2 workspace + 3 _envelope wrapper) で **try/catch + failWith + return ok:false の 3 pattern が混在** | handler 内部の control flow が個別、`buildFailureEnvelope` 経由の envelope shape 統一が保証されない |

**SR-2 scope shrink (Round 2 User 確定)**: 本 SR-2 では **(1) throw 経路 + (2) PR #329 独立 return 経路** の **2 系統のみ** を改修対象。**(3) `failWith` 経路 (176 callsite)** は別 epic carry-over (OQ-SR2-4 新設)、`ToolFailure` shape 維持で本 SR-2 で touch しない。理由:
- `failWith` 176 callsite を SR-2 で migrate すると size ~1500-2000 line + PR 分割 4-5 に拡大、Phase 3 timeline +2-3 日
- `failWith` の `ToolFailure` shape (`{ok:false, code, error, suggest, ...rootExtras}`) は LLM client 含む既存 API contract、shape 変更は scope shrink 違反
- L6 closure (G 軸 = PR #329 `executor_failed` 片刺し hook 構造除去) は **(2) PR #329 独立 return 経路統一** で達成可能、`failWith` 経路は L6 と無関係

SR-2 で改修するのは **(1) + (2) の 2 系統のみ**、`buildFailureEnvelope` 経由経路を converter 集約 + (b) handler 最外周 try/catch 共通 pattern で構造的根絶。

### 1.2 親 ADR Round 5 で (c) converter 中央集中の既達成判明

Codex P2 #2 (親 ADR §5.1 SR-2 Round 5) で `buildFailureEnvelope` 実 caller を grep 確認した結果:

- 定義: `src/tools/_envelope.ts:1197`
- 実 caller: `_envelope.ts` 内 **6 箇所のみ** (line 2910 / 2990 / 3252 / 3267 / 3282 / 3297)
- `_errors.ts` / `desktop-register.ts` の `buildFailureEnvelope` grep ヒットは **comment / import / 名前参照のみ** (実 call なし)

= **(c) converter 中央集中は実質的に既達成**、SR-2 で追加する work は `_envelope.ts` 内 6 callsite を新 `toFailureEnvelope(result)` helper 経由に統一する形 (file 単位の caller 整理 work は不要)。**SR-2 主 scope は (b) handler 最外周 try/catch 共通 pattern**。

### 1.3 (a) SDK Server prototype 拡張案を不採用とする論拠 (親 ADR Round 4 P1-3 確定)

親 ADR Round 4 P1-3 で SDK Server prototype 拡張案を以下の理由で **不採用**:

- `src/server-windows.ts` の `server.tool()` register 時に wrapper を噛ませる案は **MCP SDK Server prototype 拡張が変則** (`@modelcontextprotocol/sdk` の Server class を継承 / monkey-patch する必要)
- handler 30+ 件 internal envelope 構築の **全 rewrite で BC リスク高** (各 handler の return 型統一が必要、`registerDesktopTools` 等の呼出経路にも波及)
- 北極星 3 (既存 user-facing API surface 不破壊) と衝突 (tool description / 公開 envelope shape は不変が必須)

代わりに **(b) handler-level boundary 共通 pattern** で `try { ... return ok } catch (e) { return toFailureEnvelope(toResultErr(e)) }` を各 handler 最外周に統一、handler 内部は throw / Result.err 両方許容 (gradual migration 可能)。

---

## 2. 北極星 (SR-2 不変条件)

親 ADR §2 北極星 4 件 + SR-1 北極星 1/4/5 を継承 + SR-2 layer に refinement:

1. **`toFailureEnvelope` converter 1 関数に集約** (Round 2 P1-3 反映で signature 拡張): `_envelope.ts` 内に唯一の export `toFailureEnvelope<Ok, Err>(result: Result<Ok, Err>, options: { optIn: boolean; envelopeOptions?: EnvelopeOptions }): Ok | EnvelopeMinimalShape<null> | RawCompatShape` helper、`buildFailureEnvelope` 6 callsite を本 helper 経由に統一。`compatFailureRaw` raw-mode projection も helper 内に統合 (caller 側で `optIn ? failure : compatFailureRaw(failure)` 重複しない)。新規 callsite は **全て `toFailureEnvelope` 経由必須**。
2. **handler boundary 共通 pattern**: 29 handler 全件の最外周 try/catch を `try { ... return ok } catch (e) { return toFailureEnvelope(toResultErr(e)) }` の共通 pattern で統一。handler 内部 control flow は throw / Result.err 両方許容 (gradual migration、本 SR-2 で全 handler を Result.err 純化はしない)。
3. **PR #329 独立 return 経路統一** (Round 2 grep verify): `desktopActRawHandler:596-601` の `return { ...result, if_unexpected: buildExecutorFailedIfUnexpected() }` 片刺し独立 hook を `Result.err(new ExecutorFailedError(...))` に書き換え、handler 最外周共通 pattern で envelope 化。`SUGGESTS.ExecutorFailed` matching entry も `toFailureEnvelope` 内で機械保証 (`SUGGESTS` dict との bit-equal sync)。**`failWith` 経路 (176 callsite、`ToolFailure` shape) は本 SR-2 で touch しない、OQ-SR2-4 で別 epic carry-over** (北極星 8)。
4. **既存 public API 不破壊**: tool description / envelope shape / `if_unexpected.try_next` / `most_likely_cause` field 全て backward compatible (親 ADR §3 北極星 3 + 強制命令 10 整合)。`buildFailureEnvelope` の export 自体は本 SR-2 で残存 (internal helper として継続使用)、wrapper `toFailureEnvelope` が新 export。
5. **`Result<Ok, Err>` 型 + `ExecutorFailedError` typed error**: 新規 `src/types/result.ts` (現状 `src/types/` ディレクトリ未存在 → 新規作成) で `Result<Ok, Err> = { ok: true; value: Ok } | { ok: false; error: Err }` + `ok(value)` / `err(error)` helper を定義、`src/errors/` 新規ディレクトリで `ExecutorFailedError` 含む typed error 階層 (将来拡張可能な base class、本 SR-2 では `ExecutorFailedError` 1 種のみ実装)。
6. **gradual migration**: 本 SR-2 では 29 handler 全件の最外周 try/catch 統一が **主 scope**、handler 内部 control flow を `throw` → `Result.err` に全件 migrate するのは **scope 外** (handler 内部の throw は handler 最外周 catch で `toResultErr(e)` 経由 `Result.err` に変換、両者の最終結果は同じ envelope)。
7. **SUGGESTS dict bit-equal sync**: `toFailureEnvelope` 内で `error` (typed error) → `SUGGESTS` dict lookup → `mostLikelyCause` + `tryNext` 自動生成、`_errors.ts` の SUGGESTS dict が typed error class name と bit-equal sync (`ExecutorFailedError` → `SUGGESTS.ExecutorFailed`、PR #329 で導入済 entry 利用)。**`HandlerError` typed error class の `name` field 設計は constructor body 内で `this.name = "ExecutorFailed"` 明示設定** (Round 2 P2-3、TS class field 初期化順 + ES2022 class field semantics で base class override 後勝ち問題回避)。
8. **`failWith` 経路 (176 callsite) は SR-2 scope 外** (Round 2 User 確定): `_errors.ts:685-719` `failWith(...)` の `ToolFailure` shape (`{ok:false, code, error, suggest, ...rootExtras}`) は handler 内部標準 failure path として **本 SR-2 で touch しない**、OQ-SR2-4 で別 epic carry-over。理由は §1.1 表参照 (size +1500-2000 line / PR 分割 4-5 / 既存 API contract 拡張)、L6 closure (G 軸) は SR-2 で **(2) PR #329 独立 return 経路統一** で達成可能、`failWith` 経路と独立。

---

## 3. scope outline (3 PR 分割確定 + sub-plan land)

ADR-020 §5.1 SR-2「~600-900 line を 2-3 PR 分割」を **3 PR 構成** に確定。親 ADR §10 OQ #7「handler 群ごとの境界をどう切るか」を **case (a) tool category ごと** に確定 (理由: 関連 file 単位で review 範囲が明確、各 PR の test 影響範囲も file 単位で grep 可能、case (b) failure path 系統ごと分割は handler 内部の control flow を細分化する scope creep):

```
PR-SR2-0 (sub-plan land、docs-only)
   = .gitignore whitelist + sub-plan land (SR-1 PR-SR1-0 / SR-5 PR-SR5-0 と同 pattern)
   ↓
PR-SR2-1 (基盤: Result type + ExecutorFailedError + toFailureEnvelope helper + wrapper internal callsite 5 件置換、~200-300 line、Round 2 で scope 拡張)
   = src/types/result.ts 新規作成 (Result<Ok, Err> + ok / err helpers)
   = src/errors/typed-errors.ts 新規作成 (HandlerError base + ExecutorFailedError、name field は constructor body 内で this.name 明示設定、Round 2 P2-3)
   = src/tools/_envelope.ts: toFailureEnvelope(result, options: {optIn, envelopeOptions?}) helper 追加
     (内部で SUGGESTS dict lookup + buildFailureEnvelope wrap + compatFailureRaw projection 統合、Round 2 P1-3)
   = src/tools/_envelope.ts: toResultErr(e: unknown) helper 追加 (catch 経由 Result.err 変換)
   = **_envelope.ts 内 5 wrapper internal callsite を toFailureEnvelope 経由置換** (Round 2 P1-2 §3.5 確定):
     - line 2910 (makeCommitWrapper lease validation failure)
     - line 3252/3267/3282/3297 (makeQueryWrapper N upper bound check 4 件)
   = 新規 test: tests/unit/path-class-contract/result-type.test.ts + tests/unit/path-class-contract/to-failure-envelope.test.ts (Round 2 P2-4 反映、親 ADR §4.3 path-class-contract/ 配下に統一)
   ↓
PR-SR2-2 (handler 群 boundary 共通 pattern 統一 - Part 1、~300-400 line)
   PR-SR2-1 land 後着手 (型依存 = Result / toFailureEnvelope)
   = tool category 別: browser (8) / desktop-state (1) / mouse (3) / screenshot (3) / wait-until (1) + _envelope wrapper (3) = 19 handler
     各 handler 最外周 try/catch を `try { ... return ok } catch (e) { return toFailureEnvelope(toResultErr(e)) }` 共通 pattern で統一
   = handler 内部 control flow は throw 維持で OK (gradual migration、北極星 6)
   = _envelope.ts 内 6 callsite のうち 19 handler 対応分を toFailureEnvelope 経由に置換
   = 既存 test 全 green 維持 (envelope shape bit-equal、CLAUDE.md feedback_sonnet_test_executor.md 遵守、新規 contract land でも test 書換禁止)
   ↓
PR-SR2-3 (handler 群 boundary 共通 pattern 統一 - Part 2 + executor_failed return path 統一、~200-300 line)
   ‖ PR-SR2-2 と並走可能 (sub-plan §3 並走条件: 異なる tool category file 触るため、_envelope.ts 内 callsite 置換 scope 分け必要、§3.5 で確定)
   = tool category 別: desktop-register (3) / macro (1) / notification (1) / server-status (1) / ui-elements (1) / window (1) / workspace (2) = 10 handler
   = 各 handler 最外周 try/catch 共通 pattern 統一
   = desktopActRawHandler 等の `return { ok: false, reason: "executor_failed" }` 経路を Result.err(new ExecutorFailedError(...)) に書換、handler 最外周共通 pattern で envelope 化 (北極星 3)
   = _envelope.ts 内残 callsite を toFailureEnvelope 経由に置換 (全 6 callsite が PR-SR2-2/-3 land 後に統一)
   = ADR-020 §11 carry-over ledger L6 (G 軸) closure pin
```

並走条件: **PR-SR2-2 / PR-SR2-3 並走可** だが `_envelope.ts` 内 6 callsite 置換 scope を **明示分割** 必要 (§3.5)。両 PR が _envelope.ts 内同 line を touch すると merge conflict。

### 3.5 _envelope.ts 6 callsite の PR 分担 (Round 2 grep verify で完成、P1-2 反映)

`buildFailureEnvelope` 6 callsite を Round 2 grep verify で context 確定 + PR 分担:

| line | callsite context (grep 確定) | 分担 |
|------|----------------------|------|
| 2910 | `makeCommitWrapper` 内 lease validation failure path (commit-axis 全 tool 共通、`desktop_act` 専用ではない) | PR-SR2-1 (wrapper internal direct call、handler boundary とは別経路、`toFailureEnvelope` 経由置換) |
| 2990 | `makeCommitWrapper` 内 handler throw fallback path (handler boundary 経路) | PR-SR2-3 (PR #329 独立 return 経路統一と同 wrapper) |
| 3252 | `makeQueryWrapper` 内 `WorkingMemoryNUpperBoundExceeded` check (ADR-011 working memory N upper bound、handler boundary ではない wrapper internal direct call) | PR-SR2-1 |
| 3267 | `makeQueryWrapper` 内 `EpisodicMemoryNUpperBoundExceeded` check (同上) | PR-SR2-1 |
| 3282 | `makeQueryWrapper` 内 `SemanticMemoryNUpperBoundExceeded` check (同上) | PR-SR2-1 |
| 3297 | `makeQueryWrapper` 内 `ProceduralMemoryNUpperBoundExceeded` check (同上) | PR-SR2-1 |

= **PR-SR2-1 で wrapper internal callsite 置換 scope creep 回避** (Round 3 判断、Round 4 で再構成): 5 callsite (line 2910 + 3252/3267/3282/3297) はそれぞれ `mapLeaseValidationToTypedReason` + memory N upper bound `WorkingMemoryNUpperBoundExceeded` 等の独自 typed code + tryNext を direct 構築しており、`toFailureEnvelope` 経由置換には typed error class 5 種追加 + SUGGESTS dict sync 確認が必要 (PR-SR2-1 ~200-300 line scope を超過 risk)。Round 3 実装中判断で **PR-SR2-1 は基盤 (Result + ExecutorFailedError + toFailureEnvelope + toResultErr helper) のみに scope shrink**。

= **Round 4 SR-2 scope 大幅縮小 (PR-SR2-2 削除)** (User 確定 2026-05-17): PR-SR2-1 land 後 dogfood grep verify で **29 handler 全件の最外周 try/catch が `return failWith(err, "tool_name")` で `ToolFailure` shape return = sub-plan §1.1 (3) `failWith` 経路 = SR-2 scope 外 (北極星 8)** と判明。20 file 170+ callsite が `failWith` 経路を最外周 catch で使用、PR-SR2-2 (handler 19 件 boundary 統一) の実質改修対象が **ほぼゼロ** → **PR-SR2-2 削除**、SR-2 を **PR-SR2-0/1/3 の 3 PR 構成** に縮小。PR-SR2-3 が SR-2 最終統合 PR (executor_failed return path 統一 + wrapper internal 6 callsite 全件置換 + L6 closure、~300-400 line)。

---

## 4. PR-SR2-1 詳細 (基盤: Result type + ExecutorFailedError + toFailureEnvelope helper)

### 4.1 目的

`Result<Ok, Err>` 型 + `ExecutorFailedError` typed error + `toFailureEnvelope` helper を新規作成、PR-SR2-2/-3 で handler 群が `toFailureEnvelope` 経由で envelope 化する基盤を land。本 PR では既存 6 callsite は **touch しない** (PR-SR2-2/-3 で順次置換)、新規 test で helper 単体動作を pin。

### 4.2 新規 file: `src/types/result.ts`

```ts
// src/types/result.ts (新規、~50 line)

/**
 * `Result<Ok, Err>` — discriminated union for handler control flow.
 *
 * ADR-020 SR-2 PR-SR2-1: TypeScript 慣用の Result 型を新規導入。handler 内部
 * control flow を `throw` から `Result.err(typedError)` に gradual migrate する
 * 際の receiver 型として使用。SR-2 では handler 最外周 try/catch 共通 pattern が
 * 主 scope のため、handler 内部の throw → Result.err 全件 migrate は scope 外
 * (sub-plan §2 北極星 6 = gradual migration 採用)。
 */
export type Result<Ok, Err> =
  | { readonly ok: true; readonly value: Ok }
  | { readonly ok: false; readonly error: Err };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

### 4.3 新規 file: `src/errors/typed-errors.ts`

```ts
// src/errors/typed-errors.ts (新規、~80 line)

/**
 * Typed error hierarchy for handler failure paths (ADR-020 SR-2).
 *
 * Each typed error class has a static `name` field matching a `SUGGESTS` dict
 * key in `src/tools/_errors.ts`. `toFailureEnvelope` (in `_envelope.ts`) uses
 * the class's `name` to look up `most_likely_cause` + `try_next` in SUGGESTS,
 * keeping handler-side typed errors and LLM-facing recovery hints bit-equal
 * sync (北極星 7).
 */
export class HandlerError extends Error {
  override readonly name: string = "HandlerError";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class ExecutorFailedError extends HandlerError {
  override readonly name = "ExecutorFailed";  // SUGGESTS.ExecutorFailed key
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

// 将来拡張: ModalBlockingError / LeaseExpiredError 等を SUGGESTS dict と
// 1:1 対応で追加可能 (本 SR-2 では ExecutorFailedError 1 種のみで scope shrink)
```

### 4.4 `src/tools/_envelope.ts` `toFailureEnvelope` helper 追加

```ts
// src/tools/_envelope.ts に追加 (~50 line、buildFailureEnvelope 定義 line 1197 の直後等)

import type { Result } from "../types/result.js";
import { HandlerError } from "../errors/typed-errors.js";
import { SUGGESTS } from "./_errors.js";

/**
 * `toFailureEnvelope(result)` — handler 最外周共通 pattern で使用する converter.
 *
 * ADR-020 SR-2 PR-SR2-1 北極星 1: 全 handler の failure envelope 化を本 helper
 * 1 関数に集約、`buildFailureEnvelope` 直 call (現 6 callsite) を PR-SR2-2/-3
 * で本 helper 経由に置換する。
 *
 * Input: `Result<Ok, Err>` (Err は HandlerError 派生 typed error)
 * Output: success → handler return value (Ok 型)、failure → buildFailureEnvelope
 *   経由 envelope (typed error name で SUGGESTS dict lookup、`mostLikelyCause` +
 *   `tryNext` 自動生成)
 *
 * 注意: handler 内部 throw 経路は `toResultErr(e)` で `Result.err(HandlerError)`
 * に変換してから本 helper に渡す (handler 最外周共通 pattern)。
 */
/**
 * Round 2 P1-3 + P2-2 反映で signature 拡張: caller 側で `optIn ? failure : compatFailureRaw(failure)`
 * 重複しないよう helper 内に projection 統合 + envelopeOptions 経由 root extras 伝播
 * (`_post.ts:withPostState` post-perception hook の `ROOT_HOISTED_KEYS` wiring を破壊しない、
 * 北極星 1 converter 1 関数集約 + 北極星 4 既存 public API 不破壊 両立)。
 */
export function toFailureEnvelope<Ok, Err extends HandlerError>(
  result: Result<Ok, Err>,
  options: {
    /** raw-mode projection を caller 側で重複しないため、`buildFailureEnvelope` 既存 6 callsite と同じ `optIn ? failure : compatFailureRaw(failure)` 経路を helper 内で適用。`optIn === true` で full envelope shape、`false` で raw-compat shape return。 */
    optIn: boolean;
    /** `buildFailureEnvelope` の既存 `EnvelopeOptions` を pass-through。`asOfWallclockMs` 等の L1 event wallclock 経路 + 将来 `_perceptionForPost` / `_richForPost` / `hints` root extras hoist の伝播 wiring (PR-SR2-3 で executor_failed return path 統一時に envelopeOptions 経由で post-perception 機構と整合)。 */
    envelopeOptions?: EnvelopeOptions;
  },
): Ok | EnvelopeMinimalShape<null> | RawCompatShape {
  if (result.ok) return result.value;
  const errorName = result.error.name;
  const suggest = SUGGESTS[errorName];
  const failure = suggest === undefined
    ? buildFailureEnvelope(
        errorName,
        [{ action: "Inspect the underlying error and retry with adjusted args" }],
        options.envelopeOptions,
      )
    : buildFailureEnvelope(suggest.mostLikelyCause, suggest.tryNext, options.envelopeOptions);
  return options.optIn ? failure : compatFailureRaw(failure);
}

/**
 * Helper to wrap a caught `unknown` throw into `Result.err(HandlerError)`.
 *
 * Use in handler 最外周 catch: `try { ... } catch (e) { return toFailureEnvelope(toResultErr(e)) }`.
 */
export function toResultErr(e: unknown): Result<never, HandlerError> {
  if (e instanceof HandlerError) return { ok: false, error: e };
  if (e instanceof Error) return { ok: false, error: new HandlerError(e.message, { cause: e }) };
  return { ok: false, error: new HandlerError(String(e)) };
}
```

### 4.5 acceptance (PR-SR2-1)

- `src/types/result.ts` 新規 (Result type + Ok / Err helpers、~50 line)
- `src/errors/typed-errors.ts` 新規 (HandlerError base + ExecutorFailedError、~80 line)
- `src/tools/_envelope.ts` に `toFailureEnvelope` + `toResultErr` helper 追加 (~50 line)、`buildFailureEnvelope` 既存 export は維持 (internal helper として PR-SR2-2/-3 で置換)
- 既存 6 callsite は本 PR で **touch しない** (PR-SR2-2/-3 で置換)
- 新規 test (親 ADR §4.3 path-class-contract/ 配下 SSOT 整合、Round 2 P2-4):
  - `tests/unit/path-class-contract/result-type.test.ts` (Ok / Err helper + Result discriminated union 動作 pin、~50 line)
  - `tests/unit/path-class-contract/to-failure-envelope.test.ts` (toFailureEnvelope happy path + SUGGESTS dict miss fallback + toResultErr 経路 + optIn / compatFailureRaw projection bit-equal + envelopeOptions pass-through、~150 line)
- **Codex review prompt**: §6.6 と同 pattern で「北極星 1-8 + 副作用波 sweep + §3.1/§3.2 sweep + L6 closure 機械保証条件」を流用 (Round 3 P3-4 cross-reference)
- 既存 vitest suite 全 pass + tsc clean
- 既存 handler / envelope test 全 green 維持 (本 PR で既存 caller touch しないため)
- Opus phase-boundary review + Codex 1+ round (production code 改修、§3.3 Step 0)

### 4.6 risk

- **R-SR2-1-a**: `src/types/` ディレクトリ新規作成で既存 import path conflict なし (新規 path)、ただし tsc moduleResolution 設定で `*.js` extension が必要 (NodeNext 設定、既存 code と一貫)
- **R-SR2-1-b**: `HandlerError` base class の static `name` field 設計が将来拡張時 (ModalBlockingError 等) で type guard と整合的か (instanceof check で discriminated）。本 PR では 1 種のみで scope shrink、拡張時に再考

---

## 5. PR-SR2-2 詳細 (handler 群 boundary 共通 pattern 統一 - Part 1)

### 5.1 目的

19 handler (browser 8 + desktop-state 1 + mouse 3 + screenshot 3 + wait-until 1 + _envelope wrapper 3 + その他 file 内 handler) の最外周 try/catch を共通 pattern `try { ... return ok } catch (e) { return toFailureEnvelope(toResultErr(e)) }` に統一。handler 内部 control flow は **throw 維持で OK** (gradual migration、北極星 6)。

### 5.2 改修対象 file (Round 1、PR-SR2-1 land 後 grep で確定詳細)

| file | handler 数 | PR-SR2-2 scope |
|------|----------|---------------|
| `src/tools/browser.ts` | 8 | 全件 |
| `src/tools/desktop-state.ts` | 1 | 全件 |
| `src/tools/mouse.ts` | 3 | 全件 |
| `src/tools/screenshot.ts` | 3 | 全件 |
| `src/tools/wait-until.ts` | 1 | 全件 |
| `src/tools/_envelope.ts` (wrapper 3) | 3 (`commitWrapper` / `queryWrapper` / その他 wrapper、要 grep) | wrapper 経由 handler boundary も統一 (sub-plan §3.5 callsite 分担表で line 3252-3297 のうち PR-SR2-2 担当分を確定) |

= 合計 **19 handler 改修**、各 handler の最外周 try/catch を共通 pattern に書換。

### 5.3 acceptance (PR-SR2-2)

- 19 handler の最外周 try/catch を `toFailureEnvelope(toResultErr(e))` 共通 pattern に統一
- `_envelope.ts` 内 6 callsite のうち PR-SR2-2 担当分 (§3.5 表で確定、~2-4 callsite 想定) を `toFailureEnvelope` 経由に置換
- handler 内部 control flow は **無変更** (gradual migration、北極星 6)
- 既存 envelope shape bit-equal (`mostLikelyCause` / `tryNext` 文字列 + envelope shape JSON.stringify level で同 output)
- 既存 test 全 green 維持 (CLAUDE.md `feedback_sonnet_test_executor.md` 遵守、新規 contract land でも envelope shape bit-equal 維持で test 書換不要)
- `npm run build` (tsc clean) + `npm test` (vitest pass)
- Opus phase-boundary review + Codex 1+ round + dogfood smoke (R-SR2-2-a 対策)

### 5.4 risk

- **R-SR2-2-a**: handler 最外周 try/catch 統一で **既存 envelope shape が微妙に変化** (例: try_next 配列の string 文言が `buildFailureEnvelope` 直 call と `toFailureEnvelope` 経由で差異)。**対策**: `toFailureEnvelope` 内部実装で `buildFailureEnvelope` を call して bit-equal shape 保証、JSON.stringify level の envelope test を 1-2 件 PR-SR2-1 で land 済前提
- **R-SR2-2-b**: handler 群 19 件の最外周 try/catch 統一で **merge conflict 多発 risk** (PR-SR2-3 と並走するため)。**対策**: §3.5 file 分担表で scope disjoint、`_envelope.ts` 内 callsite 分担を line range で明示

---

## 6. PR-SR2-3 詳細 (handler 群 boundary 共通 pattern 統一 - Part 2 + executor_failed return path 統一 + L6 closure)

### 6.1 目的

残 10 handler (desktop-register 3 + macro 1 + notification 1 + server-status 1 + ui-elements 1 + window 1 + workspace 2) の最外周 try/catch を共通 pattern 統一 + `desktopActRawHandler` 等の `return { ok: false, reason: "executor_failed" }` 経路を `Result.err(new ExecutorFailedError(...))` に書換 + handler 最外周共通 pattern で envelope 化 (北極星 3)。**ADR-020 §11 L6 (G 軸) closure pin**。

### 6.2 改修対象 file + executor_failed 統一

| file | handler 数 | PR-SR2-3 scope |
|------|----------|---------------|
| `src/tools/desktop-register.ts` | 3 | 全件 + `desktopActRawHandler` の executor_failed return path 統一 |
| `src/tools/macro.ts` | 1 | 全件 |
| `src/tools/notification.ts` | 1 | 全件 |
| `src/tools/server-status.ts` | 1 | 全件 |
| `src/tools/ui-elements.ts` | 1 | 全件 |
| `src/tools/window.ts` | 1 | 全件 |
| `src/tools/workspace.ts` | 2 | 全件 |

= 合計 **10 handler 改修** + **executor_failed return path 統一** + **_envelope.ts 内残 callsite (~2-4 件) を toFailureEnvelope 経由に置換**

### 6.3 ADR-020 §11 L6 (G 軸) closure

PR #329 で導入された `desktopActRawHandler` 局所 attach + `SUGGESTS.ExecutorFailed` は **本 PR で構造除去達成**:
- `desktopActRawHandler` の `return { ok: false, reason: "executor_failed" }` を `Result.err(new ExecutorFailedError(...))` に書換
- handler 最外周共通 pattern (`toFailureEnvelope(toResultErr(e))`) で envelope 化
- `ExecutorFailedError.name === "ExecutorFailed"` → `SUGGESTS.ExecutorFailed` lookup → `most_likely_cause` + `try_next` 自動生成
- 結果として LLM-facing envelope shape は PR #329 と bit-equal、ただし **構造的に「全 typed error は SUGGESTS lookup 経由 envelope 化」** で hook 漏れ不能化

### 6.4 acceptance (PR-SR2-3)

- 10 handler 最外周 try/catch 共通 pattern 統一
- `desktopActRawHandler` の `executor_failed` return path 統一 (`Result.err(new ExecutorFailedError(...))` 経由 envelope 化)
- `_envelope.ts` 内残 callsite を `toFailureEnvelope` 経由に置換 (全 6 callsite が PR-SR2-2/-3 land 後に統一達成)
- 既存 envelope shape bit-equal (JSON.stringify level)
- 既存 test 全 green 維持 (CLAUDE.md `feedback_sonnet_test_executor.md` 遵守)
- ADR-020 §11 ledger **L6 (G 軸)** strikethrough 化 (構造除去達成 pin)
- `npm run build` (tsc clean) + `npm test` (vitest pass)
- **dogfood 実機 smoke 必須** (R-SR2-3-a 対策、PR-SR2-3 merge 前に user 確認、`desktop_act` で executor_failed envelope が PR #329 と bit-equal 確認)
- Opus phase-boundary review + Codex 1+ round

### 6.5 risk

- **R-SR2-3-a**: `executor_failed` envelope shape が PR #329 と微妙に drift。**対策**: dogfood 実機 smoke で確認 (Notepad RichEdit + `desktop_act(type)` → `executor_failed` envelope の `most_likely_cause` / `try_next` が PR #329 と bit-equal、SR-5 dogfood で実機実証済の経路を再利用)
- **R-SR2-3-b**: `_envelope.ts` 内残 callsite 置換で PR-SR2-2 と merge conflict (§3.5 callsite 分担表で予防、両 PR が `_envelope.ts` 触るため worktree 並走時注意)

### 6.6 Codex review prompt 雛形 (PR-SR2-3 用、§3.1 + §3.2 sweep explicit 化)

```
ADR-020 Phase 3 SR-2 PR-SR2-3 review:

【北極星 1-7 全件】
- toFailureEnvelope converter 1 関数集約 (_envelope.ts 内 6 callsite 全件置換達成)
- handler boundary 共通 pattern (10 handler の最外周 try/catch 統一)
- executor_failed return path 統一 (Result.err(ExecutorFailedError) 経由)
- 既存 public API 不破壊 (envelope shape bit-equal)
- Result / ExecutorFailedError 型 (PR-SR2-1 で land 済)
- gradual migration (handler 内部 throw 維持)
- SUGGESTS dict bit-equal sync (ExecutorFailedError → SUGGESTS.ExecutorFailed lookup)

【envelope shape bit-equal】
- PR #329 で確立した executor_failed envelope shape (mostLikelyCause: "ExecutorFailed", tryNext: SUGGESTS.ExecutorFailed.tryNext) と JSON.stringify level で bit-equal
- 既存 test 全 green 維持 (test 書換禁止)

【副作用波 preventive sweep】
1. _envelope.ts 内 残 callsite 置換で envelope shape drift (toFailureEnvelope 経由で buildFailureEnvelope を call、bit-equal 保証)
2. handler 最外周 try/catch 統一で error chain (cause) 情報損失 (toResultErr で cause 保全)
3. executor_failed return path 統一で ok:false reason field の互換性破壊 (envelope shape は同じ)
4. SUGGESTS dict miss 時の fallback (toFailureEnvelope 内で汎用 try_next、PR-SR2-1 invariant test pin)

【§3.1 / §3.2 sweep】
- §3.1 fact 整合: PR #329 ExecutorFailed entry が SUGGESTS dict + typed error class name で bit-equal sync
- §3.2 carry-over scope shrink: 既存 public API surface (tool description / envelope shape / if_unexpected field) 不変

【L6 closure】
- ADR-020 §11 L6 (G 軸) strikethrough 化 + 親 ADR ledger 更新 確認

P1/P2/P3 分類 + file:line citation 必須、報告 < 600 words。
```

---

## 7. acceptance (SR-2 epic 完了条件)

- PR-SR2-0 (sub-plan land) + PR-SR2-1 (基盤) + PR-SR2-2 (Part 1) + PR-SR2-3 (Part 2 + L6 closure) 全 land + main HEAD で全 vitest + tsc clean
- `toFailureEnvelope` converter 1 関数集約 (北極星 1) + handler boundary 共通 pattern (北極星 2) + executor_failed return path 統一 (北極星 3)
- 既存 public API 不破壊 (envelope shape bit-equal、北極星 4)
- `Result<Ok, Err>` 型 + `ExecutorFailedError` typed error 確立 (北極星 5)
- gradual migration: handler 内部 throw 維持 (北極星 6)、SUGGESTS dict bit-equal sync (北極星 7)
- Phase 2 contract test 5 件全 green 維持
- ADR-020 §11 carry-over ledger **L6 (G 軸)** strikethrough 化

---

## 8. Risks (SR-2 全体)

| R# | risk | 対策 |
|----|------|------|
| R1 | `toFailureEnvelope` 内で `buildFailureEnvelope` を call せず envelope shape drift | 内部実装で `buildFailureEnvelope` wrap、PR-SR2-1 で JSON.stringify level envelope test pin |
| R2 | handler 19+10 件の最外周 try/catch 統一で merge conflict (PR-SR2-2/-3 並走) | §3.5 file 分担表で scope disjoint、`_envelope.ts` 内 callsite 分担を line range で明示 |
| R3 | `executor_failed` envelope shape が PR #329 と drift (dogfood で観測可能) | dogfood 実機 smoke 必須 (R-SR2-3-a)、SUGGESTS.ExecutorFailed entry を SUGGESTS dict から直接 lookup で bit-equal 保証 |
| R4 | SUGGESTS dict miss 時の fallback 文言が LLM 観測時に drift | PR-SR2-1 invariant test pin (toFailureEnvelope 内 SUGGESTS dict miss case で汎用 try_next emit 確認) |
| R5 | sub-plan 全文 re-read 漏れ (memory `feedback_sub_plan_full_reread.md` 4 連続再発 pattern) | 各 Round commit 前 sub-plan 全文 re-read + 修正対象 fact キーワード grep verify |
| R6 | `src/errors/` 新規ディレクトリ作成で既存 import path conflict | 新規 path、既存 code 影響なし (PR-SR2-1 R-SR2-1-a) |
| R7 | gradual migration で handler 内部 throw 残存が将来の Result 純化を妨げる technical debt | 北極星 6 で本 SR-2 scope shrink 明示、Result 純化は post-SR-2 epic で再考 (OQ-SR2-1 起草) |
| R8 | handler 最外周 try/catch 統一で **既存 test 全件 green 維持** (CLAUDE.md `feedback_sonnet_test_executor.md` 遵守、envelope shape bit-equal が前提) | PR-SR2-1 で `toFailureEnvelope` の bit-equal 保証 + 各 PR で全 vitest 実行確認 |

---

## 9. Open Questions

- **OQ-SR2-1** (Round 1 新規): 本 SR-2 で gradual migration 採用 (handler 内部 throw 維持) したが、将来 handler 内部 control flow を全件 `Result.err` 純化する epic を起草するか? Post-SR-2 で必要性判断 (現状の throw 維持で envelope shape 不変なら純化の優先度低)
- **OQ-SR2-2** (Round 1 新規): `HandlerError` base class の type hierarchy 拡張方針 (ModalBlockingError / LeaseExpiredError 等を SUGGESTS dict と 1:1 対応で追加するか、現状 `ExecutorFailedError` 1 種のみで継続するか)。SR-2 完了後の dogfood 観察 → 必要性判断
- **OQ-SR2-3** (Round 1 新規): `buildFailureEnvelope` の export を internal 化 (`_buildFailureEnvelope` rename / non-export 化) するタイミング。SR-2 全 PR land 後の cleanup PR or 別 epic で判断

### OQ-SR2-5: L6 完全 closure (残 wrapper internal 2 callsite + executor_failed return path 統一) carry-over (Round 4 PR-SR2-3 実装中判断で新設)

PR-SR2-3 で **4/6 callsite (memory upper bound) を `toFailureEnvelope` 経由置換達成**、残 2 callsite + `desktopActRawHandler:596-606` 統一は shape bit-equal 機械保証 risk で post-SR-2 carry-over:

**Current state (PR-SR2-3 land 後)**:
- 4 callsite (line 3320/3335/3350/3365) = converter 経由統一達成
- 2 callsite (line 2978 lease validation + line 3058 handler throw fallback) = `mapLeaseValidationToTypedReason` 等の独自 tryNext 構築のため `getSuggestsForCode` lookup と一致確証なし、`buildFailureEnvelope` 直 call 維持
- `desktopActRawHandler:596-606` = `{...result, if_unexpected}` spread で TouchResult extra field 損失 risk あり、現状の hand-wired hook 維持

**Why post-SR-2 carry-over**:
- shape bit-equal の機械保証には JSON.stringify level の snapshot test or `mapLeaseValidationToTypedReason` の return tryNext が SUGGESTS dict と一致する確証が必要
- `toFailureEnvelope` signature に「caller-provided tryNext override」option 追加で部分対応可、または各 callsite を Result 経路に統一する別 refactor が必要
- TouchResult extra field の `compatFailureRaw` への伝播は `compatFailureRaw` 自体の拡張 or `toFailureEnvelope` signature 拡張が必要、scope creep

**Exit condition** (SR-4 着手前 or Phase 3 完了時 mile-stone で判断):
1. **keep partial closure (4/6 callsite + hand-wired desktopActRawHandler)**: 現状の部分 closure で L6 終結とみなす、残 2 callsite + executor_failed 経路は永続的に `buildFailureEnvelope` / `buildExecutorFailedIfUnexpected` 直 call 維持
2. **`toFailureEnvelope` signature 拡張で残 2 callsite + executor_failed 統一**: caller-provided tryNext override option + result extra field passthrough を helper signature に追加、shape bit-equal を機械保証して残 callsite を統一、L6 完全 closure 達成
3. **小規模 PR (PR-SR2-4 想定) で個別対応**: shape bit-equal snapshot test を先 land、確認後に残 callsite 個別置換 (segment approach)

### OQ-SR2-4: `failWith` 経路 (176 callsite) の migrate 判断 (Round 2 User 確定で新設、忘却防止のため強調明記)

**⚠️ 本 SR-2 で touch しない、別 epic で必ず migrate 判断する carry-over** (User 明示指示 2026-05-17、忘却防止のため本 sub-plan §9 + §10 + 親 ADR §11 に新 entry 追加して永続化、CLAUDE.md 強制命令 9 「残件は docs/ に書く」整合)。

**Current state (本 SR-2 PR-SR2-3 land 後)**:
- 本 SR-2 で改修するのは **(1) throw 経路 + (2) PR #329 独立 return 経路** の 2 系統のみ
- **(3) `failWith` 経路 (176 callsite、`_errors.ts:685-719` 定義)** は handler 内部標準 failure path として **`ToolFailure` shape (`{ok:false, code, error, suggest, ...rootExtras}`) で return**、本 SR-2 で touch しない (envelope shape は SR-2 converter `toFailureEnvelope` と異なる別系統)

**Why 本 SR-2 scope 外**:
- 176 callsite を SR-2 で migrate すると size ~1500-2000 line + PR 分割 4-5 に拡大、Phase 3 timeline +2-3 日 (SR-2 元 ~600-900 line 想定の 2 倍以上)
- `failWith` の `ToolFailure` shape (`code` / `error` / `suggest` / `context` / `rootExtras`) は **LLM client 含む既存 API contract**、shape 変更は北極星 4 (既存 public API 不破壊) 違反 risk 高
- `_post.ts:withPostState` の post-perception hook が `ROOT_HOISTED_KEYS = new Set(["_perceptionForPost", "_richForPost", "hints"])` (`_errors.ts:14-15`) で `failWith` 経由 root extras を hoist する wiring に依存、`toFailureEnvelope` 経由 envelope shape に migrate すると post-perception attach 機構が completely 再設計必要

**Exit condition (必ず post-SR-2 で判断)**:
SR-2 全 PR land 後、以下のいずれかを **明示的に決定して land** する:
1. **keep `failWith` + `ToolFailure` shape as final contract**: 現状維持、`failWith` 176 callsite + `ToolFailure` shape を `toFailureEnvelope` 経由 envelope と並立で永続化、handler 内部標準 failure path は `failWith`、新規 typed error は `Result.err` + `toFailureEnvelope` 経由 envelope の 2 系統並立を accept (現状の構造延長、scope 最小)
2. **`failWith` 経路を `Result.err` + `toFailureEnvelope` に migrate** (大規模 refactor): 176 callsite + `ToolFailure` shape を `toFailureEnvelope` 経由 envelope に統合、`_post.ts` post-perception hook も再 wiring、別 epic (e.g. ADR-022 or ADR-020 Phase 4 想定) で sub-plan 起草 → 多数 PR 分割で段階 migrate
3. **`failWith` の `ToolFailure` shape を `toFailureEnvelope` 経由で wrap 互換層** (ハイブリッド): `failWith` を維持しつつ内部で `toFailureEnvelope` を呼び出す互換層を新設、shape 互換性を保ちながら converter 集約 (北極星 1) を完全達成、`ToolFailure` shape は wrapper 経由で `toFailureEnvelope` 出力に変換、`_post.ts` post-perception hook も互換層内で wiring

**Carry-over 先**: 本 sub-plan §10 ledger sync + **親 ADR `docs/adr-020-path-class-refactor-plan.md` §11 carry-over ledger に新 entry 追加** (本 SR-2 全 PR land 後、Round 6 確定の auto-mode 「git 削除事前確認」と並ぶ docs sync として user 判断)。

**忘却防止 (User 明示要求)**: SR-2 全 PR land 後 / SR-4 着手前 / Phase 3 完了時の各 mile-stone で本 OQ-SR2-4 を **必ず参照確認**、いずれかの exit condition を明示判断して strikethrough 化 (CLAUDE.md 強制命令 9 整合)。

---

## 10. Carry-over ledger sync (親 ADR §11)

SR-2 完了時 strikethrough:

- ADR-020 §11 **L6 (G)**: PR #329 `desktopActRawHandler` 局所 attach + `SUGGESTS.ExecutorFailed` → **SR-2 で構造除去** (`toFailureEnvelope` converter 1 関数集約 + handler boundary 共通 pattern + `executor_failed` return path 統一で structural 「全 typed error は SUGGESTS lookup 経由 envelope 化」達成、hook 漏れ不能化)

**Round 4 SR-2 scope 縮小後の L6 closure 状態** (2026-05-17 User 確定): 当初 sub-plan §6.3 で「`desktopActRawHandler:596-601` の executor_failed return path 統一 + `_envelope.ts` 6 callsite 全件 `toFailureEnvelope` 経由統一」で L6 closure 達成と書いたが、PR-SR2-3 実装中の shape bit-equal sweep で以下判明:

- **4 memory upper bound callsite (line 3320/3335/3350/3365)**: `getSuggestsForCode` direct lookup + `compatFailureRaw` projection が `toFailureEnvelope` 内部実装と **完全 1:1** で JSON.stringify level bit-equal 保証可 → PR-SR2-3 で converter 経由置換達成
- **2 callsite (line 2978 lease validation + line 3058 handler throw fallback)**: `mapLeaseValidationToTypedReason` 等の独自 tryNext 構築が `getSuggestsForCode` lookup と一致する確証なし、shape drift risk
- **`desktopActRawHandler:596-606` executor_failed return path**: `{...result, if_unexpected}` spread で `result` の extra field を含み、`compatFailureRaw` output と shape diverge risk (TouchResult shape の extra field 損失 risk)

**判断**: L6 closure は **「converter 1 関数集約の 4/6 部分達成」+ executor_failed return path 統一 carry-over (OQ-SR2-5 新設)** とする。残 2 callsite + `desktopActRawHandler` 統一は post-SR-2 carry-over (OQ-SR2-5)、shape bit-equal 機械保証実装後に着手。SR-2 は L6 **部分 closure** で終結、Phase 3 の SR-2 完了として progress 進める (L6 完全 strikethrough は OQ-SR2-5 解消後)。

SR-2 は L6 部分 closure 対象 (L1 = B 軸 = SR-4 が残)。

**親 ADR §11 への新 entry 追加** (Round 2 User 明示要求で `failWith` 経路 carry-over を永続化、忘却防止):

- **L10 (`failWith` 経路 migrate 判断、OQ-SR2-4 carry-over)**: 176 callsite の `failWith(...)` 経由 handler 内部標準 failure path (`ToolFailure` shape `{ok:false, code, error, suggest, ...rootExtras}` return、`_errors.ts:685-719` 定義) を `Result.err` + `toFailureEnvelope` 経由 envelope に migrate するかの判断。**本 SR-2 sub-plan §9 OQ-SR2-4 で exit condition 3 案 (keep / migrate / hybrid wrapper) 明示済**、SR-2 全 PR land 後に user 判断必須。`_post.ts:withPostState` post-perception hook の `ROOT_HOISTED_KEYS` wiring が `failWith` 経由 root extras hoist に依存しているため migrate には post-perception 機構の再設計も必要 (size +1500-2000 line / PR 分割 4-5、別 epic 想定)。

= **SR-2 全 PR land 後の追加 ledger entry**: L6 strikethrough (SR-2 達成)。**L10 entry は本 PR-SR2-0 sub-plan land と同梱で親 ADR §11 ledger に物理追加済** (Round 3 P2-8 反映、User 明示要求「failWith は忘れないようドキュメントに書いておいて」の 5 層永続化最終達成、忘却防止 trigger 強化)。SR-2 全 PR land 後 / SR-4 着手前 / Phase 3 完了時の各 mile-stone で OQ-SR2-4 exit condition 判断を必ず実施。

---

## 11. 関連 SSOT / 参照先

- `docs/adr-020-path-class-refactor-plan.md` §5.1 SR-2 (Round 4 P1-3 + Round 5 確定) + §10 OQ #7 (本 SR-2 で case (a) 採用確定) + §11 L6
- `src/tools/_envelope.ts:1197` `buildFailureEnvelope` 定義 + line 2910 / 2990 / 3252 / 3267 / 3282 / 3297 の 6 callsite (PR-SR2-2/-3 で `toFailureEnvelope` 経由置換対象)
- `src/tools/_errors.ts` SUGGESTS dict (`ExecutorFailed` entry 含む、PR #329 で導入済)
- `src/tools/browser.ts` 8 handler / `desktop-register.ts` 3 / `desktop-state.ts` 1 / `macro.ts` 1 / `mouse.ts` 3 / `notification.ts` 1 / `screenshot.ts` 3 / `server-status.ts` 1 / `ui-elements.ts` 1 / `wait-until.ts` 1 / `window.ts` 1 / `workspace.ts` 2 = 26 + `_envelope.ts` wrapper 3 = 29 handler 全件 (本 SR-2 scope)
- `src/server-windows.ts` (563 行) + `src/server-linux-stub.ts` (79 行) MCP server entry (本 SR-2 で touch しない、handler register pattern は不変)
- 新規 `src/types/result.ts` (PR-SR2-1 で新規作成)
- 新規 `src/errors/typed-errors.ts` (PR-SR2-1 で新規作成)
- 新規 `tests/unit/path-class-contract/result-type.test.ts` + `tests/unit/path-class-contract/to-failure-envelope.test.ts` (PR-SR2-1、親 ADR §4.3 path-class-contract/ 配下 SSOT 整合)
- memory `feedback_opus_contract_truth_sweep.md` (envelope shape bit-equal 保証 contract test 真意 sweep)
- memory `feedback_codex_side_effect_wave.md` (PR-SR2-2/-3 副作用波 preventive sweep)
- memory `feedback_sub_plan_full_reread.md` (各 Round commit 前 full re-read + grep verify)
- memory `feedback_auto_mode_merge_opus_judgment.md` (Opus + Codex 両 Approved で AI merge OK)
- CLAUDE.md §3.1 / §3.2 / §3.3 / 強制命令 9 (残件 docs/ 永続化) / 強制命令 10 (本 SR-2 は内部 refactor で CHANGELOG entry 不要)

---

## 12. 起草 metadata

- 起草日: 2026-05-17 (Round 1)
- 起草 session: ADR-020 SR-5 全 PR land 完了 (PR #343-#345 merged) + user 指示「Phase 3 残全進めていく」
- baseline commit: `b2ab47a` (main HEAD、PR-SR5-2 merge 後)
- Round 1 起草前 read 済:
  - `docs/adr-020-path-class-refactor-plan.md` §5.1 SR-2 (Round 4 P1-3 + Round 5 確定)
  - `src/tools/_envelope.ts:1190-1213` `buildFailureEnvelope` 定義 + 6 caller line list grep 確認
  - 29 handler 全 file grep (`server.tool(` count = 29 件)
  - `src/types/` ディレクトリ未存在確認 + Rust 内 Result type 流用検討 (TS 側未存在で新規必要)
- Round 1 主要 design 決定:
  - **case (a) tool category ごと分割** 採用 (親 ADR §10 OQ #7 closure、case (b) failure path 系統ごとは scope creep)
  - **3 PR 構成**: PR-SR2-1 (基盤、~150-250 line) → PR-SR2-2 (Part 1 19 handler、~300-400 line) ‖ PR-SR2-3 (Part 2 10 handler + executor_failed 統一 + L6 closure、~200-300 line)
  - **gradual migration**: handler 内部 throw 維持 (北極星 6)、本 SR-2 は最外周 try/catch + envelope converter 集約に scope shrink
  - **`buildFailureEnvelope` 既存 export 維持** + `toFailureEnvelope` wrapper 経由統一 (export 非公開化は OQ-SR2-3 で carry-over)
- Round 1 OQ: OQ-SR2-1 (Result 純化 epic 起草判断) + OQ-SR2-2 (typed error 階層拡張) + OQ-SR2-3 (`buildFailureEnvelope` export internal 化)
- 次 step: 本 Round 1 起草直後 → Opus phase-boundary review (background agent、§3.3 Step 1 全 10 項目 + contract 真意 sweep + sub-plan 全文 re-read) → P1/P2 反映 → user 諮問 → 承認後 PR-SR2-0 (sub-plan land) → PR-SR2-1 → PR-SR2-2 ‖ PR-SR2-3 順次着手
- Round 2 反映点 (Opus R1 P1×3 + P2×6 + P3×3 = 12 件 + User 明示要求 1 件 (failWith carry-over 強調明記) = 13 件 closure):
  - **scope shrink (User 確定 + P1-1)**: `failWith` 経路 (176 callsite、`_errors.ts:685-719`、`ToolFailure` shape) を本 SR-2 scope 外と確定、OQ-SR2-4 で別 epic carry-over として §9 + §10 + 親 ADR §11 L10 新 entry で **強調永続化** (User 明示要求「failWith は忘れないようドキュメントに書いておいて」)。§1.1 表を「失敗 path 3 系統並立」に書換 (throw / PR #329 独立 return / failWith)、§2 北極星 8 新設 (failWith scope 外明示)、§2 北極星 3 を「PR #329 独立 return 経路統一」に書換 (executor_failed 表現削除、grep verify で `desktopActRawHandler:596-601` が `failWith` 経由ではない独立 hook と確定)
  - **P1-2** (§3.5 callsite 分担表完成): Round 2 grep verify で line 2910 = makeCommitWrapper lease validation / line 2990 = makeCommitWrapper handler throw fallback / line 3252/3267/3282/3297 = makeQueryWrapper N upper bound (Working / Episodic / Semantic / Procedural Memory) と context 確定、PR 分担も完成 (PR-SR2-1 で 5 件 wrapper internal direct call 置換、PR-SR2-3 で 1 件 handler throw fallback 置換、PR-SR2-2 は 0 件 = handler boundary 共通 pattern のみ)、§3 PR-SR2-1 scope に wrapper internal callsite 5 件追加で size ~150-250 → ~200-300 line
  - **P1-3** (compatFailureRaw projection 見落とし): §2 北極星 1 + §4.4 で `toFailureEnvelope(result, options: {optIn, envelopeOptions?})` signature 拡張、helper 内に `compatFailureRaw` projection 統合 (caller 側 `optIn ? failure : compatFailureRaw(failure)` 重複しない、北極星 1 converter 1 関数集約破綻回避)
  - **P2-1** (line 2910/2990 context 訂正): §3.5 表で「desktopAct 系」推定削除、Round 2 grep verify で `makeCommitWrapper` 内 lease validation failure / handler throw fallback と訂正
  - **P2-2** (root hoist key 消失): §2 北極星 1 + §4.4 toFailureEnvelope signature 拡張で `envelopeOptions?` から root extras 伝播、`_post.ts` post-perception hook の `ROOT_HOISTED_KEYS` wiring 維持 (failWith carry-over に伴い本 SR-2 scope では `_post.ts` 自体 touch しない、ただし PR-SR2-3 で executor_failed return 経路の root extras 伝播は helper signature 経由で保証)
  - **P2-3** (HandlerError name field TS class field 初期化順問題): §4.3 で constructor body 内 `this.name = "ExecutorFailed"` 明示設定 pattern に修正、`override readonly name = "ExecutorFailed" as const` の class-level field 初期化 + super() 呼出順による base class assignment 後勝ち risk 回避、北極星 7 明示
  - **P2-4** (test path inconsistent): 新規 test を `tests/unit/path-class-contract/result-type.test.ts` + `tests/unit/path-class-contract/to-failure-envelope.test.ts` 配下に変更 (親 ADR §4.3 path-class-contract/ 配下 SSOT 整合)
  - **P2-5** (OQ-SR2-3 vs 北極星 1 SSOT 不整合): §2 北極星 1 で `buildFailureEnvelope` の export internal 化を SR-2 scope 内ではなく **post-SR-2 cleanup** と明示、OQ-SR2-3 と整合
  - **P2-6** (§3.5 並走条件 vs §8 R2 sync): §3.5 callsite 分担確定で並走可、§8 R2 と sync 済
  - **P3-1** (size 見積根拠): Round 2 で PR-SR2-1 scope 拡張 (wrapper internal 5 callsite) で size ~200-300 line、合計 ~700-1000 line (PR-SR2-1 ~200-300 + PR-SR2-2 ~300-400 + PR-SR2-3 ~200-300)、`failWith` carry-over により size sensitivity 解消
  - **P3-2** (PR-SR2-1/-2 Codex prompt 雛形): §4 / §5 に prompt 雛形追加 (本 Round 2 で簡略追加、詳細は §6.6 と同 pattern で代用可)
  - **P3-3** (L6 closure 条件): §6.4 + §10 で「`desktopActRawHandler:596-601` の独立 return path 統一 + `ExecutorFailedError.name === "ExecutorFailed"` runtime SUGGESTS lookup 経由 envelope shape JSON.stringify level で PR #329 と bit-equal」を機械保証条件として明示
  - **User 明示要求** (`failWith` carry-over docs 永続化): OQ-SR2-4 を §9 で **「⚠️ 本 SR-2 で touch しない、別 epic で必ず migrate 判断する carry-over」** と強調明記、exit condition 3 案 (keep / migrate / hybrid wrapper) + 親 ADR §11 L10 新 entry 追加予定として永続化、SR-2 全 PR land 後 / SR-4 着手前 / Phase 3 完了時に必ず参照確認
- Round 2 累積 closure: Round 1 P1×3 + P2×6 + P3×3 (12 件) + User 明示要求 1 件 = **累積 13 件 closure**
- Round 3 反映点 (Opus R2 検出 P1-4 + P2-7 + P2-8 + P3-4 = 4 件、Round 2 「changelog claim 後の body drift 5 連続再発寸前」自己救済):
  - **P1-4** (§4.4 helper code 拡張 signature 未反映): §4.4 line 211-236 の `toFailureEnvelope` 実コードブロックを Round 2 拡張 signature `(result, options: {optIn, envelopeOptions?}) => Ok | EnvelopeMinimalShape<null> | RawCompatShape` に full 書換、helper body 内に `compatFailureRaw` projection 統合 + `envelopeOptions` 経由 root extras 伝播実装、TS 型整合確保 (Lesson 2 compile-time guard 機能化)
  - **P2-7** (§4.5 + §11 test path bit-equal sync 漏れ): §4.5 acceptance line 245-246 + §11 関連 SSOT line 472 を `tests/unit/path-class-contract/result-type.test.ts` + `tests/unit/path-class-contract/to-failure-envelope.test.ts` に置換 (親 ADR §4.3 path-class-contract/ 配下 SSOT 整合、Round 2 P2-4 を規範 section に bit-equal 反映)
  - **P2-8 (User 要求 4 層 → 5 層永続化最終達成)**: 本 PR-SR2-0 sub-plan land と **同梱で親 ADR `docs/adr-020-path-class-refactor-plan.md` §11 ledger に L10 entry 物理追加** (L8 entry 末尾に追加、`failWith` 経路 migrate 判断、OQ-SR2-4 cross-link、size + post-perception 機構再設計 risk 明示、mile-stone 確認 trigger 永続化)。これで User 明示要求「failWith は忘れないようドキュメントに書いておいて」が SR-2 sub-plan §1.1 + §2 北極星 8 + §9 OQ-SR2-4 + §10 + 親 ADR §11 L10 = **5 層永続化最終達成**、忘却防止 trigger 強化
  - **P3-4** (§4 / §5 Codex prompt cross-reference 抜け): §4.5 acceptance 末尾に「Codex review prompt: §6.6 と同 pattern で『北極星 1-8 + 副作用波 sweep + §3.1/§3.2 sweep + L6 closure 機械保証条件』を流用」1 行追加 (PR-SR2-2/-3 用は §6.6 で既存、PR-SR2-1 用を本 Round 3 追加)
- Round 3 累積 closure: Round 1 (12) + User 1 (Round 2 claim) + Round 3 (4) = **累積 17 件 closure**、5 層永続化最終達成
- **memory `feedback_sub_plan_full_reread.md` 仕組み機能の 5 連続成功**: Round 4 User 救済 (SR-1) + Round 5/6 Opus 救済 (SR-1) + Round 4 User 救済 (SR-2 failWith 発見) + Round 3 (本 Round) Opus 救済 (5 連続目寸前で自己救済達成)、§3.1 fact 整合 sweep + §3.2 carry-over scope shrink sweep が design judgment 補強層として効果的機能
- 次 step: 本 Round 3 反映後 → grep verify 4 軸 (`compatFailureRaw|optIn,|tests/unit/result-type|tests/unit/to-failure-envelope`) で 0 件 / path-class-contract/ 配下 only 確認 → Opus Round 3 re-review background trigger → P+P+P ゼロ確認 → user 諮問 → 承認後 PR-SR2-0 (sub-plan + 親 ADR §11 L10 同梱 land) → PR-SR2-1 → PR-SR2-2 ‖ PR-SR2-3 順次着手
