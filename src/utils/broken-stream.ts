/**
 * Public #859 — a server whose client is gone must not keep reporting errors to a pipe nobody reads.
 *
 * MEASURED (win2, 2026-10-28, the reporter's bounded script): with stdin open and the parent's end
 * of stderr closed, 1.16.0, 2.3.3 and main bc6d7d7c all stayed alive until the script killed them,
 * writing about 2,500 `uncaught` + `exit` record pairs a second. The reporter's 1.16.0 ran like that
 * for ten hours and wrote 27 GiB. Every exception was `handleUncaught`'s own `console.error` failing
 * with EPIPE. The `try/catch` around it does nothing: the stream error arrives later, on a tick.
 *
 * Why it never exits (Fable's analysis, reproduced in Node): the EPIPE is emitted on `nextTick`,
 * becomes `uncaughtException`, and the handler writes to stderr again, scheduling the next tick.
 * The tick queue throws before the microtask checkpoint every time, so no promise continuation
 * runs, and `shutdown()`'s `Promise.all(...).finally(() => process.exit())` is never reached.
 *
 * The pieces `server-windows.ts` uses:
 *   - `watchBrokenStream`: a permanent 'error' listener on stderr, so a failed write never becomes an
 *     uncaught exception; it silences the console and hands over once.
 *   - `isBrokenStreamError`: the errors that mean the reader is gone.
 *   - `silenceConsole`: once stderr is gone, nothing may write to it again.
 *   - `armExitDeadline`: a timer, not a promise, so it fires even while microtasks are starved.
 *
 * No imports, so a test can load this file in a child process with Node's type stripping.
 */

/** EPIPE (the reader closed its end) and ERR_STREAM_DESTROYED (the stream was torn down). */
export function isBrokenStreamError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

/** The part of a writable stream `watchBrokenStream` needs. */
export interface ErrorEmitting {
  on(event: "error", listener: (err: Error & { code?: string }) => void): unknown;
}

/**
 * Listens for 'error' on `stream` for the life of the process. The first error silences the console
 * and calls `onBroken` once; later ones are absorbed. Any error counts, not only EPIPE: a stream that
 * failed a write cannot be written to again.
 */
export function watchBrokenStream(
  stream: ErrorEmitting,
  onBroken: (err: Error & { code?: string }) => void,
  target: Console = console,
): void {
  let broken = false;
  stream.on("error", (err) => {
    if (broken) return;
    broken = true;
    silenceConsole(target);
    onBroken(err);
  });
}

/**
 * Turns the console's writing methods into no-ops. Only after a stream has failed: muting a live
 * stderr would hide the last crash from whoever is reading it.
 */
export function silenceConsole(target: Console = console): void {
  const noop = (): void => {};
  target.error = noop;
  target.warn = noop;
  target.log = noop;
  target.info = noop;
  target.debug = noop;
  target.trace = noop;
}

/**
 * Exits with `exitCode` after `ms` unless cancelled. Not `unref`'d: the point is to exit even when
 * nothing else keeps the loop alive (the same reasoning as the deferred-shutdown timer in
 * `server-windows.ts`).
 */
export function armExitDeadline(
  exit: (code: number) => void,
  exitCode: number,
  ms: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => exit(exitCode), ms);
}
