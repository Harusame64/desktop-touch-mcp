/**
 * ADR-018 destination-explicit input pipeline — Phase 1b dispatcher skeleton.
 *
 * Resolves an `InputDestination` (4-discriminator union per ADR §2.3) and
 * dispatches scroll wheel actions through the appropriate tier. Phase 1b
 * implements Tier 1 (UIA `IUIAutomationScrollPattern::SetScrollPercent` via
 * the new napi export `uiaScrollByWheelAtHwnd`); Tier 2 (CDP) lands in
 * Phase 3, Tier 3 (PostMessage WM_MOUSEWHEEL) in Phase 4. Tier 4 (legacy
 * nutjs SendInput) remains in `mouse.ts:scrollHandler` and is invoked by
 * the caller when `dispatchScrollWheel` returns `null` (Phase 1b fall-through
 * path; Phase 4 tightens this to `dest.kind === 'unresolved'` only when
 * Tier 3 PostMessage covers resolved-but-non-UIA destinations).
 *
 * See `docs/adr-018-phase-1b-subplan.md` for the Phase 1b interpretation of
 * §2.6.2 path-(b) (lenient Tier 4 guard during 1b → strict in Phase 4).
 *
 * CLAUDE.md §3.1 (multi-table fact integrity): the channel / reason values
 * emitted here are mirrored at `src/tools/mouse.ts:943-977`
 * (`ScrollVerifyOutcome` union) and `docs/adr-018-input-pipeline-3tier.md`
 * §2.6.1 / §2.6.2. Any rename must sweep all three surfaces.
 */

import { resolveWindowTarget, type ResolvedWindow } from "./_resolve-window.js";
import { getForegroundHwnd, enumWindowsInZOrder } from "../engine/win32.js";
import { findContainingWindow } from "../engine/window-cache.js";

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * ADR §2.3 D3 — Destination as a first-class discriminated union. Every input
 * tool resolves destination **first**, before choosing a tier. Phase 1b's
 * resolver returns either `'hwnd'` (HWND known, tier probed by dispatcher)
 * or `'unresolved'` (no destination → Tier 4 SendInput fallback). The `'uia'`
 * and `'cdp'` discriminators are declared up-front so Phase 3 (CDP) and a
 * future explicit-element resolver can extend the union without contract
 * churn.
 */
export type InputDestination =
  | { kind: "uia"; hwnd: bigint }
  | { kind: "cdp"; tabId: string; nodeId?: number }
  | { kind: "hwnd"; hwnd: bigint }
  | { kind: "unresolved"; reason: string };

/**
 * ADR §2.6.1 — Transport identifier. Always populated; orthogonal to delivery
 * status (caller may emit `channel:'uia'` with `status:'not_delivered'` if the
 * UIA call returned `scrolled:false` and observation confirmed no movement).
 */
export type Channel = "uia" | "cdp" | "postmessage" | "send_input";

/**
 * Wheel parameters in raw notch deltas. Positive `deltaY` scrolls down (matches
 * `WM_MOUSEWHEEL` lParam sign convention reversed: ADR §2.4 will revisit if
 * Phase 4 PostMessage encoding requires sign flip).
 *
 * `notch` is the integer count of mouse-wheel detents (1 notch = 120 raw
 * `WHEEL_DELTA` units). The dispatcher converts this to a percent step
 * inside the Rust UIA path; CDP / PostMessage tiers (Phase 3 / 4) accept
 * the same notch count and convert at their boundary.
 */
export interface WheelParams {
  direction: "up" | "down" | "left" | "right";
  notch: number;
}

/**
 * Outcome of one tier dispatch attempt. `null` return from `dispatchScrollWheel`
 * means "this tier did not handle the dispatch — caller should fall through
 * to the next tier (or to Tier 4 SendInput in Phase 1b)".
 */
export interface DispatchOutcome {
  scrolled: boolean;
  channel: Channel;
  /**
   * ADR §2.6.2 reason value. Phase 1b emits only `'delivered_via_uia'`; the
   * remaining 4 ADR-018 reasons (`delivered_via_cdp` / `delivered_via_postmessage`
   * / `wheel_overlay_intercepted` / `target_unreachable`) are emitted by later
   * phases. `null` indicates no ADR-018 reason applies (caller picks the
   * legacy `evaluateScrollDelivery` reason from `mouse.ts`).
   */
  reason: "delivered_via_uia" | null;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve the input destination using `resolveWindowTarget` (D3 SSOT), with
 * fallbacks for the cursor-position-routing legacy callers (ADR §2.6.3 Public
 * API contract: `scroll({action:'raw', amount:N})` with no destination must
 * still resolve to a foreground HWND so the happy path is preserved).
 *
 * Phase 1b resolver returns only `'hwnd'` or `'unresolved'`. The 'uia' kind
 * is reserved for a future phase that probes ScrollPattern at resolve time;
 * Phase 1b checks pattern availability inside `dispatchScrollWheel` instead
 * to avoid a redundant native crossing.
 */
export async function resolveInputDestination(params: {
  hwnd?: string;
  windowTitle?: string;
  cursor?: { x: number; y: number };
}): Promise<InputDestination> {
  const resolved: ResolvedWindow | null = await resolveWindowTarget({
    hwnd: params.hwnd,
    windowTitle: params.windowTitle,
  });
  if (resolved !== null) {
    return { kind: "hwnd", hwnd: resolved.hwnd };
  }

  // Case 3 from _resolve-window.ts: plain windowTitle that matches a top-level
  // window returns null. Re-enumerate with the same ordering used by the
  // legacy scrollHandler to keep parity (this is a parity step — Phase 5 may
  // collapse this back into resolveWindowTarget once `scroll-read.ts` migrates).
  if (params.windowTitle && params.windowTitle !== "@active") {
    try {
      const wantTitle = params.windowTitle.toLowerCase();
      const win = enumWindowsInZOrder().find(
        (w) => !w.isMinimized && w.title.toLowerCase().includes(wantTitle),
      );
      if (win) return { kind: "hwnd", hwnd: win.hwnd };
    } catch {
      /* best effort */
    }
  }

  // Cursor-position fallback (preserves legacy scroll(action='raw', x, y) callers).
  if (params.cursor !== undefined) {
    try {
      const containing = findContainingWindow(params.cursor.x, params.cursor.y);
      if (containing) return { kind: "hwnd", hwnd: containing.hwnd };
    } catch {
      /* best effort */
    }
  }

  // Foreground last-resort. resolveWindowTarget('@active') would have caught
  // this case if windowTitle was '@active'; here we cover the no-destination
  // legacy path explicitly.
  try {
    const fg = getForegroundHwnd();
    if (fg !== null) return { kind: "hwnd", hwnd: fg };
  } catch {
    /* best effort */
  }

  return { kind: "unresolved", reason: "no_target_window" };
}

// ─── Runtime guard (ADR §4 Phase 1 deliverable) ──────────────────────────────

/**
 * Asserts that the caller is allowed to invoke Tier 4 (legacy SendInput
 * nutjs path) for the given destination. Phase 1b adopts a **lenient** form
 * (`'hwnd'` and `'unresolved'` are both allowed) so resolved-but-non-UIA
 * destinations (Word / Chrome / Excel under the dispatcher's view) preserve
 * the legacy happy path until Tier 3 PostMessage lands in Phase 4.
 *
 * Phase 4 tightens this to `dest.kind === 'unresolved'` only — see
 * `docs/adr-018-phase-1b-subplan.md` §2.2 carry-over.
 *
 * @throws Error if `dest.kind` is `'uia'` or `'cdp'` (those tiers must
 *   dispatch through their own transport — invoking SendInput would
 *   bypass the destination-explicit contract).
 */
export function assertTier4Reachable(dest: InputDestination): void {
  if (dest.kind === "uia" || dest.kind === "cdp") {
    throw new Error(
      `Tier 4 SendInput must not be reached when destination kind is '${dest.kind}'. ` +
        "Use Tier 1/2 dispatch instead. " +
        "(ADR-018 §2.6.2: Tier 4 is reachable only when destination is unresolved or " +
        "Tier 3 PostMessage was exhausted — Phase 1b lenient form allows 'hwnd' as well " +
        "during the dispatcher rollout.)",
    );
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * Phase 1b dispatcher. Returns `DispatchOutcome` when a tier handled the
 * dispatch, or `null` when the caller should fall through to the next tier
 * (Tier 4 SendInput in Phase 1b).
 *
 * - `kind === 'hwnd'`: probes Tier 1 UIA via the native `uiaScrollByWheelAtHwnd`
 *   call. If the HWND exposes a ScrollPattern ancestor and the call succeeds,
 *   returns `{ scrolled: true, channel: 'uia', reason: 'delivered_via_uia' }`.
 *   Otherwise returns `null` (caller falls through to legacy nutjs).
 * - `kind === 'uia'`: future-reserved (Phase 3 or later). Currently treated
 *   identically to `'hwnd'` since the resolver does not emit `'uia'` in Phase 1b.
 * - `kind === 'cdp'`: Phase 3 stub — returns `null` so caller falls through.
 *   The `assertTier4Reachable` guard prevents misuse — see signature note.
 * - `kind === 'unresolved'`: returns `null` (caller invokes Tier 4 SendInput
 *   after `assertTier4Reachable(dest)` passes).
 *
 * Native call is performed via a dynamic import of `index.js` so non-Windows
 * test environments (or builds without the new napi export) cleanly degrade
 * to legacy behaviour: any thrown native error from a missing export causes
 * dispatch to return `null` and the caller falls through.
 */
export async function dispatchScrollWheel(
  dest: InputDestination,
  params: WheelParams,
): Promise<DispatchOutcome | null> {
  if (dest.kind === "hwnd" || dest.kind === "uia") {
    try {
      const native = await import("../../index.js");
      const fn = (native as Record<string, unknown>).uiaScrollByWheelAtHwnd;
      if (typeof fn !== "function") return null; // native binding not available → legacy fall-through
      const wheelDelta = wheelDeltaForNotch(params);
      const result = (await (
        fn as (opts: {
          hwnd: string;
          wheelDeltaY: number;
          wheelDeltaX: number;
        }) => Promise<{ ok: boolean; scrolled: boolean; error?: string | null }>
      )({
        hwnd: dest.hwnd.toString(),
        wheelDeltaY: wheelDelta.y,
        wheelDeltaX: wheelDelta.x,
      })) ?? { ok: false, scrolled: false };
      if (result.ok === true && result.scrolled === true) {
        return {
          scrolled: true,
          channel: "uia",
          reason: "delivered_via_uia",
        };
      }
      return null;
    } catch {
      return null;
    }
  }
  // cdp / unresolved → caller handles (Phase 1b: SendInput fall-through)
  return null;
}

/**
 * Convert (direction, notch) into signed WHEEL_DELTA units. 1 notch = 120
 * units (the value of `WHEEL_DELTA` since Windows 2000); the Rust UIA path
 * scales this against `ScrollPattern.VerticalViewSize` to derive a percent
 * step. Down / right are positive, up / left negative — this matches the
 * `WM_MOUSEWHEEL` lParam convention for Phase 4 reuse.
 */
function wheelDeltaForNotch(params: WheelParams): { x: number; y: number } {
  const unit = 120 * params.notch;
  switch (params.direction) {
    case "down":
      return { x: 0, y: unit };
    case "up":
      return { x: 0, y: -unit };
    case "right":
      return { x: unit, y: 0 };
    case "left":
      return { x: -unit, y: 0 };
  }
}
