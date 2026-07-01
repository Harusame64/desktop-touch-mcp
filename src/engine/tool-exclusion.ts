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
// (non-load-bearing). Enforcement lives at two engine layers:
//   1. enumWindowsInZOrder() drops any window whose owning PID is excluded — that enumerator
//      feeds screenshot / perception / discover / dialog resolution. Gated on a NON-EMPTY set so
//      idle callers (no locker running — the common case) pay ZERO extra syscalls.
//   2. resolveWindowTarget() Cases 1/2 (explicit `hwnd`, `@active`) bypass the enumerator, so
//      they consult this registry directly and REFUSE an excluded target (WindowExcluded).
//
// BOUNDED, not structural: this protects the honest-Claude tool path (the locker's own tools
// won't read / click / screenshot the dialog); it is NOT a defense against an adversarial
// same-user process that calls Win32 directly. §8 threat model, R3 seed.

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
