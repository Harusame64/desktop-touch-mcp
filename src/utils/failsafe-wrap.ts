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
    await preCheck();
    return originalHandler(...handlerArgs);
  };
  return toolArgs;
}
