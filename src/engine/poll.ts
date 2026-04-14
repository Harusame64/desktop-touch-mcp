// ─────────────────────────────────────────────────────────────────────────────
// pollUntil — generic polling helper
// ─────────────────────────────────────────────────────────────────────────────
//
// Calls `fn` repeatedly at `intervalMs` until it returns a non-null value or
// the timeout is reached. Returns a discriminated union so callers can
// pattern-match without try/catch.
//
// Usage:
//   const r = await pollUntil(() => findWindow("電卓"), { intervalMs: 200, timeoutMs: 5000 });
//   if (r.ok) { /* r.value is the window */ } else { /* timed out */ }

export interface PollSuccess<T> {
  ok: true;
  value: T;
  elapsedMs: number;
}

export interface PollTimeout {
  ok: false;
  timeout: true;
  elapsedMs: number;
}

export type PollResult<T> = PollSuccess<T> | PollTimeout;

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  /** Called before the first poll and after each failed poll (useful for logging). */
  onTick?: (elapsedMs: number) => void;
}

export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  opts: PollOptions
): Promise<PollResult<T>> {
  const { intervalMs, timeoutMs, onTick } = opts;
  const start = Date.now();
  const deadline = start + timeoutMs;

  while (true) {
    const elapsed = Date.now() - start;
    onTick?.(elapsed);

    const value = await fn();
    if (value !== null) {
      return { ok: true, value, elapsedMs: Date.now() - start };
    }

    if (Date.now() >= deadline) {
      return { ok: false, timeout: true, elapsedMs: Date.now() - start };
    }

    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}
