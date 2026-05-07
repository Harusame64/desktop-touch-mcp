/**
 * _session-context.ts — ADR-011 Phase A A-2 (session_id source finalize).
 *
 * AsyncLocalStorage-backed session context propagation. The MCP SDK
 * surfaces `extra.sessionId` (`@modelcontextprotocol/sdk/shared/protocol.d.ts:185`)
 * to tool handlers, but our wrapper layer (`makeCommitWrapper` /
 * `makeQueryWrapper`) discards it for backward compatibility. This
 * module bridges the two: wrappers populate ALS at request reception,
 * downstream `getSessionId` resolvers read the current context.
 *
 * Design (ADR-011 plan §4.2.2 option (b) + SDK `extra.sessionId` hybrid):
 *   - Node.js standard `AsyncLocalStorage`, no SDK API change required
 *   - Transport-agnostic — same path works for stdio (sessionId undefined,
 *     single-session prototype default) and HTTP (StreamableHTTPServerTransport
 *     issues per-request sessionId)
 *   - Test seam pins `_isSingleSessionPrototype` for sentinel branch coverage
 *
 * 2-stub unification (plan §4.2.4):
 *   - `desktop-state.ts:getMcpTransportSessionId` and `_envelope.ts:_defaultQueryTransportSessionId`
 *     now both delegate to `getMcpTransportSessionIdFromContext()` here
 *   - test seams `_setSingleSessionPrototypeForTest` /
 *     `_setDefaultQuerySingleSessionForTest` both forward to this module
 *
 * Pure parser (CLAUDE.md `feedback_pure_parser_for_env_helpers.md`):
 *   `parseSessionMode(value)` is pure, env mutation race 構造的解消 — tests
 *   call the parser directly without `process.env` mutation.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface SessionContext {
  /** Transport-supplied session id (`extra.sessionId` from MCP SDK).
   *  `undefined` when transport doesn't issue session ids (stdio default,
   *  StreamableHTTPServerTransport with `sessionIdGenerator: undefined`). */
  sessionId?: string;
}

/** Module-private ALS instance — accessed via `runWithSessionContext` /
 *  `getMcpTransportSessionIdFromContext`. */
const _sessionAls = new AsyncLocalStorage<SessionContext>();

/**
 * Run `fn` under a session context populated from the SDK's `extra.sessionId`.
 *
 * Wrappers (`makeCommitWrapper` / `makeQueryWrapper`) call this at the
 * outermost handler entry so all downstream `getSessionId` resolvers see
 * the same transport-supplied sessionId. `undefined` is forwarded
 * faithfully — single-session deployments (stdio) keep prototype fallback.
 */
export function runWithSessionContext<T>(
  sessionId: string | undefined,
  fn: () => T,
): T {
  return _sessionAls.run({ sessionId }, fn);
}

/**
 * Read the current ALS-bound transport sessionId, or `undefined` outside
 * a wrapper context (production stdio default).
 *
 * Replaces the A-1 stubs:
 *   - `desktop-state.ts:getMcpTransportSessionId` (single-LLM-client stub)
 *   - `_envelope.ts:_defaultQueryTransportSessionId` (duplicate stub avoiding circular dep)
 *
 * Both files now delegate here so the 2-stub state during A-1 → A-2
 * transit collapses into one resolver (plan §4.2.4).
 */
export function getMcpTransportSessionIdFromContext(): string | undefined {
  return _sessionAls.getStore()?.sessionId;
}

// ─── Single-session prototype gate (env-aware, transport-agnostic) ──────────

/**
 * Parse `DESKTOP_TOUCH_SESSION_MODE` env value. Pure — no `process.env`
 * read here so tests can drive the parser directly without env mutation
 * race (CLAUDE.md `feedback_pure_parser_for_env_helpers.md`).
 *
 * Modes:
 *   - `"single"` → always single-session (sentinel branch off)
 *   - `"multi"`  → always multi-session (sentinel `multi:disabled` active)
 *   - `"auto"`   → SDK's `extra.sessionId` presence drives detection:
 *                    transport supplied → multi-session, undefined → single
 *   - any other / `undefined` → default to `"auto"`
 */
export type SessionMode = "single" | "multi" | "auto";

export function parseSessionMode(raw: string | undefined): SessionMode {
  if (raw === "single" || raw === "multi" || raw === "auto") return raw;
  return "auto";
}

/**
 * Test seam — pin the prototype gate. `undefined` resets to env-aware default.
 *
 * Subsumes the A-1 separate test seams (plan §4.2.4 unification):
 *   - `desktop-state.ts:_setSingleSessionPrototypeForTest`
 *   - `_envelope.ts:_setDefaultQuerySingleSessionForTest`
 *
 * Both now forward here. Tests pass `false` to activate the
 * `multi:disabled` sentinel without env mutation, `true` to pin
 * single-session prototype, `undefined` to restore default.
 */
let _singleSessionPin: boolean | undefined = undefined;

/** @internal Test-only — pin to a fixed boolean. */
export function _setSingleSessionPinForTest(value: boolean): void {
  _singleSessionPin = value;
}

/** @internal Test-only — clear the pin (revert to env-aware default). */
export function _resetSingleSessionPinForTest(): void {
  _singleSessionPin = undefined;
}

/**
 * Resolve "is this deploy single-session?" with the following precedence:
 *   1. test pin (`_singleSessionPin`) — when set, used unconditionally
 *   2. env mode (`DESKTOP_TOUCH_SESSION_MODE`):
 *      - `"single"` → `true`
 *      - `"multi"`  → `false`
 *      - `"auto"`   → derive from current ALS context: sessionId defined → `false` (multi),
 *                     undefined → `true` (single)
 *
 * Production wiring (default `"auto"`): stdio transports leave
 * `extra.sessionId` undefined and `single` is selected; HTTP
 * StreamableHTTPServerTransport with `sessionIdGenerator` issues per-request
 * sessionIds and `multi` is selected — `multi:disabled` sentinel guards
 * cross-session causal trail leak (architecture §4 識別子ヒエラルキー).
 */
export function isSingleSessionPrototype(): boolean {
  if (_singleSessionPin !== undefined) return _singleSessionPin;
  const mode = parseSessionMode(process.env.DESKTOP_TOUCH_SESSION_MODE);
  if (mode === "single") return true;
  if (mode === "multi") return false;
  // auto: ALS context drives detection
  return _sessionAls.getStore()?.sessionId === undefined;
}
