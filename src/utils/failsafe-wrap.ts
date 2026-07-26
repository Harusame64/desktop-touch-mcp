/**
 * src/utils/failsafe-wrap.ts
 *
 * Helper for wrapping the handler argument of MCP server tool registrations
 * with a per-call pre-check (typically `checkFailsafe`).
 *
 * Both `McpServer.tool(name, [desc], [schema], handler)` and
 * `McpServer.registerTool(name, config, handler)` take the handler as the
 * LAST argument. Replacing that argument with a wrapper that runs `preCheck`
 * before forwarding to the original handler gives every public tool the same
 * emergency-stop gate, regardless of which registration method it uses.
 *
 * History: Codex PR #40 review (2026-04-26) caught that `server.registerTool`
 * was not being monkey-patched in `createMcpServer`, so Phase 2/3 dispatchers
 * registered through `registerTool` (keyboard, clipboard, window_dock, scroll,
 * terminal, browser_eval) silently bypassed the failsafe wrapper. Extracting
 * this helper makes the wrapping logic exercisable in isolation.
 */

export type HandlerLike = (...args: unknown[]) => Promise<unknown>;

// ADR-030 Phase 1 (plan §3.3 W6): the ACTIVE tool-call counter — the number
// of tool handlers that passed the failsafe pre-check and have not settled
// yet. This is the failsafe watcher's exit-gate input. Module-level so every
// McpServer instance shares it: the per-tool wrap is applied inside
// `createMcpServer`, which the HTTP transport calls per request too, so one
// counter covers both transports.
//
// DO NOT confuse this with the transport-level `inflightIds` in
// server-windows.ts (shutdown grace): that one counts requests BEFORE tool
// dispatch, so a call the failsafe merely refuses is still "in flight" there
// (a refusal response must still be delivered). Gating the watcher on it
// would let an idle corner-park + LLM retry burst kill the server (plan
// Round 4 Codex P2) — which is exactly the bug this counter exists to avoid.
let _activeToolCalls = 0;

/** Number of tool handlers currently executing past the failsafe pre-check. */
export function getActiveToolCallCount(): number {
  return _activeToolCalls;
}

/** Test-only: reset the counter between cases. Not exposed via the public index. */
export function _resetActiveToolCallsForTest(): void {
  _activeToolCalls = 0;
}

/**
 * Replace the last entry of `toolArgs` (the handler) with a wrapper that
 * `await preCheck()`s before delegating to the original handler. Mutates and
 * returns the same array for convenience at the call site.
 *
 * The handler's return value, this binding, and argument list are forwarded
 * verbatim. If `preCheck` throws (e.g. emergency-stop active), the original
 * handler is not invoked and the throw propagates up to the MCP transport
 * layer as a tool-call failure.
 */
export function wrapHandlerArg(
  toolArgs: unknown[],
  preCheck: () => Promise<void>,
): unknown[] {
  if (toolArgs.length === 0) return toolArgs;
  const lastIdx = toolArgs.length - 1;
  const originalHandler = toolArgs[lastIdx] as HandlerLike;
  if (typeof originalHandler !== "function") return toolArgs;
  toolArgs[lastIdx] = async (...handlerArgs: unknown[]) => {
    // A refused call never reaches the increment: `preCheck` throws here and
    // the counter stays untouched (plan §3.3 — refusals are NOT active).
    await preCheck();
    // Same synchronous segment as the preCheck resolution — no await between
    // the increment and the `try`, so no exception can skip the `finally`
    // and the watcher tick cannot interleave.
    _activeToolCalls++;
    try {
      // `return await` (NOT `return originalHandler(...)`) so the `finally`
      // runs after the handler settles — a bare return would decrement
      // before the promise resolves and the watcher would see 0 mid-call.
      return await originalHandler(...handlerArgs);
    } finally {
      _activeToolCalls--;
    }
  };
  return toolArgs;
}
