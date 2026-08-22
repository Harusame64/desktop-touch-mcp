/**
 * auto-guard-env.ts — the `DESKTOP_TOUCH_AUTO_GUARD` kill switch, on its own.
 *
 * A leaf module with no imports, because two very different layers need the
 * answer and one of them must not depend on the other: `_action-guard.ts` (which
 * pulls in the whole perception subsystem) and `_resolve-log.ts` (ADR-035
 * Phase 1 observation, which stamps the flag on every event so a failed run can
 * be attributed to it). Importing the guard from the logger closed a cycle —
 * `_resolve-log` → `_action-guard` → `action-target` → `_resolve-log` — which
 * worked only because every participant happened to export hoisted function
 * declarations, and would have become a `ReferenceError` the first time one of
 * them evaluated a module-level constant during another's initialisation
 * (Opus Round 3 P2).
 *
 * `_action-guard.ts` re-exports this so its own callers are unchanged.
 */

/** True unless `DESKTOP_TOUCH_AUTO_GUARD=0` turns the guard layer off. */
export function isAutoGuardEnabled(): boolean {
  return process.env.DESKTOP_TOUCH_AUTO_GUARD !== "0";
}
