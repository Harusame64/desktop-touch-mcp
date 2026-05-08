/**
 * _mouse-verify.ts — Click / drag delivery verification.
 *
 * Issue #178 (matrix doc §3.1, rows `mouse_click` / `mouse_drag`):
 * `SendInput` only queues the input event — the OS never reports whether the
 * target actually consumed it. Pre v1.3.3 we observed only `detectFocusLoss`,
 * which conflates two cases:
 *   (a) the click was silently dropped (UIPI / off-target / etc), and
 *   (b) the click landed but the receiver kept focus on the same window.
 *
 * This helper takes a pre-side-effect snapshot of (focusedElement,
 * elementFromPoint, foregroundHwnd, optional scrollInfo) and a matching
 * post-side-effect snapshot, then collapses the diff into the three-value
 * `hints.verifyDelivery.status` enum from `docs/operation-verification-matrix.md`
 * §4.4:
 *   - `delivered`     — at least one observable changed (element / focus / scroll)
 *   - `focus_only`    — foreground window held but nothing else moved
 *   - `unverifiable`  — UIA `ElementFromPoint` (or its substitutes) was unusable
 *
 * The shape mirrors `terminal({action:'send'})` BG path (`src/tools/terminal.ts`
 * lines 369-459, the regulative implementation). Failures are signalled by
 * the caller throwing `MouseClickNotDelivered` / `MouseDragNotDelivered`;
 * this module returns *only* the `delivered` / `focus_only` / `unverifiable`
 * triage so the handler can decide whether to surface a typed error or carry
 * on with `ok:true + hints.verifyDelivery`.
 */

import { getFocusedAndPointInfo, type UiaFocusInfo } from "../engine/uia-bridge.js";
import { getForegroundHwnd, readScrollInfo } from "../engine/win32.js";
import { findContainingWindow } from "../engine/window-cache.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Three-value enum from `docs/operation-verification-matrix.md` §4.4.
 *
 * `delivered` is set when at least one of element-under-cursor, focused
 * element, or container scrollInfo changed. `focus_only` is the diagnostic
 * tier (foreground stable but no observable downstream effect). `unverifiable`
 * means the snapshot itself failed (no UIA / timeout / etc) — the caller
 * cannot tell either way.
 */
export type VerifyDeliveryStatus = "delivered" | "focus_only" | "unverifiable";

/**
 * Optional reason enum, aligned with `docs/operation-verification-matrix.md`
 * §4.3. We only emit reasons we can structurally distinguish; richer values
 * (e.g. `wt_xaml_pipeline`) are added as the corresponding heuristics land.
 */
export type VerifyDeliveryReason =
  | "read_back_unsupported"
  | "no_observable_change";

/**
 * Hint shape returned in `hints.verifyDelivery`. Conforms to
 * `docs/operation-verification-matrix.md` §4.2.
 */
export interface VerifyDeliveryHint {
  status: VerifyDeliveryStatus;
  /** "send_input" for native mouse, "uia_invoke" for click_element, etc. */
  channel: string;
  /** Required when status !== 'delivered'; matrix doc §4.4. */
  reason?: VerifyDeliveryReason;
  /** Free-form human-readable note; useful for LLM debug paths. */
  detail?: string;
}

/** Compact pre-state used by both pre/post snapshots. */
export interface MouseVerifySnapshot {
  /** Element under (x, y) at snapshot time. null when UIA failed. */
  elementAtPoint: UiaFocusInfo | null;
  /** Globally focused element. null when UIA failed. */
  focusedElement: UiaFocusInfo | null;
  /** Foreground HWND at snapshot time. null when win32 failed. */
  foregroundHwnd: bigint | null;
  /**
   * Scroll position of the container window at snapshot time. null when
   * the window has no Win32 scrollbar (overlay / Chromium / etc).
   */
  verticalScrollPos: number | null;
}

// ─── Snapshot capture ────────────────────────────────────────────────────────

/**
 * Capture a verification snapshot at point (x, y). Best-effort — every field
 * may be null. Bounded UIA timeout (1500ms) so the call stays well under the
 * 200ms p99 commit budget when the OS is responsive (typical < 50ms via the
 * Rust native path) but does not block forever on a hung target.
 *
 * Pass `containerHwnd` when the caller already knows the window the click is
 * targeting; it is used to read Win32 GetScrollInfo without a second
 * findContainingWindow lookup.
 */
export async function snapshotForVerify(
  x: number,
  y: number,
  containerHwnd?: bigint | null
): Promise<MouseVerifySnapshot> {
  // UIA query (focused + element-at-point in one round-trip).
  let elementAtPoint: UiaFocusInfo | null = null;
  let focusedElement: UiaFocusInfo | null = null;
  try {
    const r = await getFocusedAndPointInfo(x, y, true, 1500);
    elementAtPoint = r.atPoint;
    focusedElement = r.focused;
  } catch {
    // best-effort — leave nulls, downstream will report "unverifiable".
  }

  // Cheap win32 calls, no fallback chain.
  const foregroundHwnd = getForegroundHwnd();

  let verticalScrollPos: number | null = null;
  const hwndForScroll = containerHwnd ?? findContainingWindow(x, y)?.hwnd ?? null;
  if (hwndForScroll) {
    const info = readScrollInfo(hwndForScroll, "vertical");
    if (info) verticalScrollPos = info.nPos;
  }

  return { elementAtPoint, focusedElement, foregroundHwnd, verticalScrollPos };
}

// ─── Diff / status ───────────────────────────────────────────────────────────

/**
 * Did the UIA element identity change between two snapshots? Compares (name,
 * controlType, automationId) — value changes are deliberately excluded so
 * that volatile fields (timer text, blinking caret) do not register as
 * "delivered" without a real interaction.
 */
function elementsDiffer(a: UiaFocusInfo | null, b: UiaFocusInfo | null): boolean {
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return (
    a.name !== b.name ||
    a.controlType !== b.controlType ||
    a.automationId !== b.automationId
  );
}

/**
 * Collapse pre/post snapshots into the matrix doc §4.2 hint.
 *
 * Logic (per matrix doc §3.1 mouse_click row):
 *   - pre.elementAtPoint === null AND pre.focusedElement === null
 *     → "unverifiable" (no observation channel — UIA absent on this host)
 *   - any of (elementAtPoint, focusedElement, verticalScrollPos) changed
 *     → "delivered"
 *   - foregroundHwnd unchanged AND no other change
 *     → "focus_only" (matrix doc §4.4: "focus held but consumption unconfirmed")
 *   - foregroundHwnd changed but nothing else moved (rare — focus thief)
 *     → "delivered" (defensive: foreground delta IS an observable side effect)
 */
export function classifyDelivery(
  pre: MouseVerifySnapshot,
  post: MouseVerifySnapshot,
  channel: string
): VerifyDeliveryHint {
  // Tier 1: did UIA give us anything to compare?
  // If both pre.atPoint and pre.focusedElement are null, we have no UIA at
  // all on this host (or both calls timed out). Don't pretend we observed.
  // Note: we still allow scroll/foreground diff, but the "no change" branch
  // must report unverifiable rather than focus_only.
  const haveUiaPre = pre.elementAtPoint !== null || pre.focusedElement !== null;
  const haveUiaPost = post.elementAtPoint !== null || post.focusedElement !== null;

  // Tier 2: collect change signals.
  const elemAtPointChanged = elementsDiffer(pre.elementAtPoint, post.elementAtPoint);
  const focusedChanged = elementsDiffer(pre.focusedElement, post.focusedElement);
  const scrollChanged =
    pre.verticalScrollPos !== null &&
    post.verticalScrollPos !== null &&
    pre.verticalScrollPos !== post.verticalScrollPos;
  const fgChanged =
    pre.foregroundHwnd !== null &&
    post.foregroundHwnd !== null &&
    pre.foregroundHwnd !== post.foregroundHwnd;

  if (elemAtPointChanged || focusedChanged || scrollChanged || fgChanged) {
    return { status: "delivered", channel };
  }

  // No change observed. Distinguish "no UIA" from "UIA available but flat".
  if (!haveUiaPre || !haveUiaPost) {
    return {
      status: "unverifiable",
      channel,
      reason: "read_back_unsupported",
      detail: "UIA ElementFromPoint returned null pre or post — no observation channel available on this host",
    };
  }

  // UIA was available but nothing moved — focus held inside the same window.
  // Caller decides whether to fail (target-outside-window heuristic) or
  // surface as ok with the focus_only hint.
  return {
    status: "focus_only",
    channel,
    reason: "no_observable_change",
    detail: "foreground stable, element-under-cursor / focused-element / scrollPos all unchanged after click",
  };
}
