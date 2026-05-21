/**
 * `Result<Ok, Err>` — discriminated union for handler control flow.
 *
 * ADR-020 SR-2 PR-SR2-1: TypeScript 慣用の Result 型を新規導入。handler 内部
 * control flow を `throw` から `Result.err(typedError)` に gradual migrate する
 * 際の receiver 型として使用。SR-2 では handler 最外周 try/catch 共通 pattern が
 * 主 scope のため、handler 内部の throw → Result.err 全件 migrate は scope 外
 * (sub-plan §2 北極星 6 = gradual migration 採用)。
 *
 * `failWith` 経路 (`_errors.ts`、`ToolFailure` flat shape) は本 SR-2 scope 外。
 * ADR-021 Phase 2 で B′ presenter family の thin wrapper 化 + canonical 化
 * (OQ-1 RE-DECISION で keep、`errors/typed-errors.ts` ToolFailureError doc 参照)。
 */
export type Result<Ok, Err> =
  | { readonly ok: true; readonly value: Ok }
  | { readonly ok: false; readonly error: Err };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });
