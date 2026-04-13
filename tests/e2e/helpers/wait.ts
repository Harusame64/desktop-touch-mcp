/**
 * wait.ts — shared timing helpers for E2E suites.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll `fn` until it returns a non-null value or the timeout elapses.
 * Returns the resolved value (never null on success) or throws on timeout.
 */
export async function eventually<T>(
  fn: () => Promise<T | null> | (T | null),
  opts: { timeoutMs: number; intervalMs?: number; label?: string }
): Promise<T> {
  const interval = opts.intervalMs ?? 100;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    await sleep(interval);
  }
  throw new Error(
    `eventually timed out after ${opts.timeoutMs}ms${opts.label ? ` (${opts.label})` : ""}`
  );
}

/** Parse a ToolResult's first text content block as JSON. */
export function parsePayload(r: { content: Array<{ type: string; text?: string }> }): any {
  const block = r.content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("parsePayload: first content block is not text");
  }
  return JSON.parse(block.text);
}
