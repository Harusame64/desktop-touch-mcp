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
  /** Polls that answered (null) before the timeout. */
  answeredPolls: number;
  /**
   * Set when the last poll had not answered by the deadline: how long it had run. The wait then
   * answers at its deadline rather than when that poll does, so nothing was seen at the end.
   */
  unfinishedPollMs?: number;
}

export type PollResult<T> = PollSuccess<T> | PollTimeout;

export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
  /** Called before the first poll and after each failed poll (useful for logging). */
  onTick?: (elapsedMs: number) => void;
}

/**
 * The answer comes by `timeoutMs`, however slow a poll is. A poll still running at the deadline is
 * left to finish on its own and its result is dropped (a rejection included). Before this, one slow
 * poll (a CDP call on a busy page waits 15 s) or an intervalMs past the deadline made the wait answer
 * that much late.
 *
 * The last look is still taken near the deadline. When the time left is shorter than an interval
 * plus a poll, the next poll is moved up so that, taking as long as the one before it, it ends just
 * before the deadline, and the wait answers after it. Cutting the sleep to the deadline and stopping
 * there lost the last interval of every wait, so a condition that reads a baseline on its first poll
 * (value_changes) could never answer under a short timeoutMs (/code-review). A poll longer than the
 * time left still starts (at once), so a page that takes 15 s per read is looked at again in the
 * last 2 s of a 17 s wait.
 */
export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  opts: PollOptions
): Promise<PollResult<T>> {
  const { intervalMs, timeoutMs, onTick } = opts;
  const start = Date.now();
  const deadline = start + timeoutMs;
  let answeredPolls = 0;
  /** The poll just taken was moved up to end before the deadline (see the loop's end). */
  let movedUp = false;

  while (true) {
    // A timer that fired late can land past the deadline; a poll started there would be cut at once.
    if (answeredPolls > 0 && Date.now() >= deadline) {
      return { ok: false, timeout: true, elapsedMs: Date.now() - start, answeredPolls };
    }
    const elapsed = Date.now() - start;
    onTick?.(elapsed);

    const pollStart = Date.now();
    const settled = await settleBy(fn, deadline);
    if (settled.late) {
      return { ok: false, timeout: true, elapsedMs: Date.now() - start, answeredPolls, unfinishedPollMs: Date.now() - pollStart };
    }
    answeredPolls += 1;
    const pollMs = Date.now() - pollStart;
    const value = settled.value;
    if (value !== null) {
      return { ok: true, value, elapsedMs: Date.now() - start };
    }

    const left = deadline - Date.now();
    if (left <= 0) {
      return { ok: false, timeout: true, elapsedMs: Date.now() - start, answeredPolls };
    }

    // Aimed to end a little before the deadline (a fifth of the last poll, at least 20 ms), since
    // timers and reads run late (Windows timers by up to about 15.6 ms) and a poll ending just past
    // it is dropped.
    const margin = Math.max(20, Math.round(pollMs / 5));
    const wait = Math.max(0, left - pollMs - margin);
    if (wait >= intervalMs) {
      movedUp = false;
      await new Promise<void>((r) => setTimeout(r, intervalMs));
      continue;
    }
    // Less than an interval and a poll left: the next look is moved up to end before the deadline.
    // The room is measured again after every look. A slow look followed by a fast one can leave
    // seconds, polled as usual when they hold an interval (/code-review), or a shorter span, which
    // is aimed at again (codex on #1041: a 600 ms look then fast ones answered at 780 ms of 1500).
    // The wait answers once a moved-up look leaves no more than a margin; every sleep here then is
    // longer than a margin, so this does not spin.
    if (movedUp && wait <= margin) {
      return { ok: false, timeout: true, elapsedMs: Date.now() - start, answeredPolls };
    }
    movedUp = true;
    await new Promise<void>((r) => setTimeout(r, wait));
  }
}

/** Run one poll, answering `late` if it has not settled by the deadline. A throw before it passes through. */
async function settleBy<T>(fn: () => Promise<T | null>, deadline: number): Promise<{ late: false; value: T | null } | { late: true }> {
  const poll = Promise.resolve().then(fn);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ late: true }>((r) => {
    timer = setTimeout(() => r({ late: true }), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([poll.then((value) => ({ late: false as const, value })), late]);
  } finally {
    // A poll dropped at the deadline may still reject. The race holds a handler on it, so that is
    // not an unhandled rejection (a cell in a-wait-answers-by-its-timeout pins it).
    clearTimeout(timer);
  }
}
