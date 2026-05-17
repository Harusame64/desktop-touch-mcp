/**
 * `Result<Ok, Err>` — discriminated union for handler control flow.
 *
 * ADR-020 SR-2 PR-SR2-1: TypeScript 慣用の Result 型を新規導入。handler 内部
 * control flow を `throw` から `Result.err(typedError)` に gradual migrate する
 * 際の receiver 型として使用。SR-2 では handler 最外周 try/catch 共通 pattern が
 * 主 scope のため、handler 内部の throw → Result.err 全件 migrate は scope 外
 * (sub-plan §2 北極星 6 = gradual migration 採用)。
 *
 * `failWith` 経路 (176 callsite、`_errors.ts:685-719`、`ToolFailure` shape) は
 * 本 SR-2 scope 外、別 epic carry-over (sub-plan §9 OQ-SR2-4、親 ADR §11 L10)。
 */
export type Result<Ok, Err> =
  | { readonly ok: true; readonly value: Ok }
  | { readonly ok: false; readonly error: Err };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error });
