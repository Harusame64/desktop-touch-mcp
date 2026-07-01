// ADR-014 v2 R3 Key Locker — L0 engine tool-exclusion registry.
//
// Plan: desktop-touch-mcp-internal@main:docs/adr-014-v2-r3-slice-plan.md (L0)
//
// The Key Locker process (bin/key-locker.exe) hosts a WPF PasswordBox secure dialog whose
// CONTENT is un-capturable by design (D1 spike: no UIA value, masked, no clipboard copy). This
// registry closes the complementary surface: the MCP's WINDOW-TARGETING paths that name a
// specific window (by `hwnd` / title / `@active`). While a locker is alive, its windows are
// dropped from the enumerator and refused by the by-window resolver, so screenshot-by-window /
// perception / desktop_discover / click-by-window / dialog-resolution cannot single out the
// dialog.
//
// This is BOUNDED, not structural. It does NOT (and is not meant to) block a FULLSCREEN capture
// (captureScreen / captureDisplay grab the raw framebuffer, which contains whatever pixels are on
// screen) or a raw mouse-by-coordinate / foreground keystroke — those are the accepted structural
// boundary and are out of §8 scope. The load-bearing secrecy guarantee is D1 (the PasswordBox
// masks the value), NOT this filter; this filter just keeps the honest tool path from casually
// addressing the dialog by identity.
//
// The exclusion key is the locker's PID: the MCP knows it from spawn (see key-locker-host.ts),
// which is robust across HWND reuse and does NOT depend on the locker's self-reported hello.pid
// (non-load-bearing). Enforcement is applied at EVERY by-identity enumerator / resolver / read
// primitive — no single one is a complete chokepoint (Codex R1 P1s: a by-identity path that skips
// one still reaches the dialog through another):
//   1. enumWindowsInZOrder() (win32) drops excluded-PID windows — feeds screenshot-by-window /
//      perception / discover / dialog resolution / the title→hwnd searches.
//   2. getWindows() (nut-js) drops excluded-PID windows — the SEPARATE enumerator behind
//      screenshot(mode:'background') title-match, the window list, workspace, and macro.
//   3. resolveWindowTarget() Cases 1/2 (explicit `hwnd`, `@active`) bypass the enumerators, so
//      they consult the registry directly and throw `WindowExcludedError`; `normalizeTarget`
//      (desktop_discover) re-throws it instead of swallowing it as a normal resolution miss.
//   4. runSomPipeline() (OCR read) refuses an explicit-hwnd target owned by an excluded PID — its
//      title-only branch already relies on the filtered enumerator, so this closes the by-hwnd gap.
// All are gated on a NON-EMPTY exclusion set so idle callers (no locker running — the common case)
// pay ZERO extra syscalls. The shared by-handle predicate is `isExcludedWindowHandle` (win32.ts),
// which co-locates with `getWindowProcessId` to avoid a tool-exclusion↔win32 import cycle.
//
// BOUNDED, not structural: this closes the by-identity (hwnd / title / @active) tool paths for the
// honest-Claude automation flow. It does NOT block a fullscreen `captureScreen`/`captureDisplay`
// (raw framebuffer pixels) or a raw mouse-by-coordinate / foreground keystroke — those are the
// accepted structural boundary, out of §8 scope. The load-bearing secrecy guarantee is D1 (the
// PasswordBox masks the value), NOT this filter. §8 threat model, R3 seed.

/**
 * Thrown when a by-identity window target (explicit `hwnd` / `@active` / an OCR read) resolves to
 * a tool-excluded (key locker) window. A distinct type (not a plain `Error`) so callers that
 * otherwise tolerate resolution misses — e.g. `normalizeTarget` — can single it out and propagate
 * the refusal instead of falling through to a normal-target passthrough. L0-local; L4 wires it
 * into `_errors.ts` (`SUGGESTS` + `classify`).
 */
export class WindowExcludedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowExcludedError";
  }
}

/** PIDs whose windows must be excluded from every engine tool surface. */
const excludedPids = new Set<number>();

/** Register a PID whose windows must be excluded (call on locker spawn). No-op for non-positive ints. */
export function registerExcludedPid(pid: number): void {
  if (Number.isInteger(pid) && pid > 0) excludedPids.add(pid);
}

/** Remove a PID from the exclusion set (call on locker dispose). */
export function unregisterExcludedPid(pid: number): void {
  excludedPids.delete(pid);
}

/**
 * True when at least one PID is excluded — the enumerator's cheap gate. When this is `false`
 * (no locker alive), callers skip the per-window PID syscall entirely, so the exclusion feature
 * costs nothing in the overwhelmingly common case.
 */
export function hasExcludedPids(): boolean {
  return excludedPids.size > 0;
}

/** True when `pid` is currently excluded. */
export function isExcludedPid(pid: number): boolean {
  return excludedPids.has(pid);
}

/** TEST-ONLY: clear the registry so cases don't leak PID state into one another. */
export function _resetExcludedPidsForTest(): void {
  excludedPids.clear();
}
