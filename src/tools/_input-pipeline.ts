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
 * CLAUDE.md §3.1 (multi-table fact integrity): the `reason` values emitted
 * here mirror the `reason?:` union of `ScrollVerifyOutcome` in
 * `src/tools/mouse.ts` and `docs/adr-018-input-pipeline-3tier.md` §2.6.2.
 * The `Channel` type below is the ADR §2.6.1 canonical 4-value enum that the
 * *dispatcher* emits via `DispatchOutcome.channel` (Phase 1b emits only
 * `'uia'`). NOTE: `mouse.ts:scrollHandler` additionally emits the legacy
 * literal `'wheel_send_input'` for its Tier 4 nutjs path — that literal is
 * scrollHandler-local and is folded into this `Channel` enum as `'send_input'`
 * by the Phase 4 §2.6.3 migration. Any rename must sweep all surfaces.
 */

import {
  resolveWindowTarget,
  DIALOG_CLASSNAMES,
  type ResolvedWindow,
} from "./_resolve-window.js";
import { enumWindowsInZOrder } from "../engine/win32.js";
import { nativeUia } from "../engine/native-engine.js";
import {
  listTabsLight,
  dispatchWheelInTab,
  readScrollPositionInTab,
} from "../engine/cdp-bridge.js";
import { getCdpPort } from "../utils/desktop-config.js";

/**
 * Window class prefix that identifies a Chromium-based top-level window
 * (Chrome, Edge, and Electron apps that use the upstream Chromium chrome).
 * Phase 3 uses this as the *gate* for CDP probing — only `Chrome_WidgetWin_*`
 * HWNDs cost a `listTabsLight` HTTP round-trip in `resolveCdpDestinationForHwnd`,
 * so non-browser windows pay zero CDP latency. (ADR §7 OQ3 carry-over: Tier 1
 * UIA inside Chromium is opt-in and not in Phase 3 scope.)
 */
const CHROMIUM_CLASS_PREFIX = "Chrome_WidgetWin";

/**
 * Minimum pixel delta required to classify a CDP scroll as `delivered_via_cdp`.
 * 1px is the smallest observable scroll in CSS px; below that, browser pixel
 * snapping or sub-pixel rounding can produce noise on a no-op wheel. (ADR §2.6.2
 * — Tier 2 boundary signal: pre/post `scrollingElement.scrollTop` differ by
 * at least this many px.)
 */
const CDP_SCROLL_DELIVERY_EPSILON_PX = 1;

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
 * ADR §2.6.1 — Transport identifier emitted by the dispatcher. Always
 * populated; orthogonal to delivery status (caller may emit `channel:'uia'`
 * with `status:'not_delivered'` if the UIA call returned `scrolled:false` and
 * observation confirmed no movement).
 *
 * This is the canonical 4-value ADR §2.6.1 enum. The legacy Tier 4 literal
 * `'wheel_send_input'` emitted by `mouse.ts:scrollHandler` is **not** part of
 * this type — it is scrollHandler-local until the Phase 4 §2.6.3 migration
 * renames it to `'send_input'` and routes it through `DispatchOutcome`.
 */
export type Channel = "uia" | "cdp" | "postmessage" | "send_input";

/**
 * Wheel parameters in raw notch deltas.
 *
 * **Sign convention (UIA-internal, NOT Win32 WM_MOUSEWHEEL-compatible)**: this
 * interface uses the UIA `SetScrollPercent` direction sense — down/right is
 * positive (percent increases toward the bottom/right of content). The Win32
 * `WM_MOUSEWHEEL` `wParam` high word uses the opposite convention (positive
 * = wheel rotated forward, scroll **up**). Phase 4 PostMessage encoding
 * (ADR-018 §4 Phase 4) MUST flip the sign at the `postWheelToHwnd` napi
 * boundary — `WheelParams.notch` carries UIA-direction signed values
 * throughout the TS layer.
 *
 * `notch` is the integer count of mouse-wheel detents (1 notch = 120 raw
 * `WHEEL_DELTA` units). The dispatcher converts this to a percent step
 * inside the Rust UIA path. CDP `dispatchMouseEvent({type:'mouseWheel'})`
 * (Phase 3) uses positive-down convention too (same as UIA / CSS), so no
 * sign flip is needed at the Tier 2 boundary — only Tier 3 PostMessage flips.
 */
export interface WheelParams {
  direction: "up" | "down" | "left" | "right";
  notch: number;
  /**
   * Optional viewport-relative CSS px coordinates for Tier 2 CDP dispatch.
   * CDP `Input.dispatchMouseEvent({type:'mouseWheel'})` requires `(x,y)` but
   * routes the wheel to the tab (not the point) — so for Phase 3 these are
   * a hint only; viewport center is used when omitted. Tier 1 (UIA) and
   * Tier 4 (legacy SendInput) ignore both fields.
   *
   * Phase 3 / ADR §7 OQ6 carry-over: per-element CDP coords land in a future
   * phase (e.g. `scroll(action='to_element', selector=...)` Tier 2 path).
   */
  x?: number;
  y?: number;
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
   * ADR §2.6.2 reason value. Phase 1b emits `'delivered_via_uia'`, Phase 3
   * adds `'delivered_via_cdp'`; `'delivered_via_postmessage'` /
   * `'wheel_overlay_intercepted'` / `'target_unreachable'` arrive in later
   * phases. `null` indicates no ADR-018 reason applies (caller picks the
   * legacy `evaluateScrollDelivery` reason from `mouse.ts`).
   */
  reason: "delivered_via_uia" | "delivered_via_cdp" | null;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve the input destination using `resolveWindowTarget` (ADR §2.3 D3 SSOT).
 *
 * Resolution order:
 *   1. `resolveWindowTarget({hwnd, windowTitle})` — handles explicit `hwnd`,
 *      `@active`, and the H3 dialog owner chain → `{ kind: 'hwnd' }`.
 *   2. **Plain-windowTitle Case 3 recovery**: `resolveWindowTarget` returns
 *      `null` for a plain `windowTitle` that DOES match a top-level window
 *      (`_resolve-window.ts` Case 3 discards the matched HWND by design, to
 *      keep legacy title-based callers unchanged). The dispatcher still needs
 *      that HWND so Tier 1 UIA is reachable for the common windowTitle-only
 *      scroll call (ADR §4 Phase 1 G1 acceptance — otherwise
 *      `scroll(windowTitle:'メモ帳')` could never report `channel:'uia'`). We
 *      re-run an `enumWindowsInZOrder` lookup here with Case 3's predicate
 *      (non-dialog class, no owner window) plus a minimized-window exclusion
 *      (a minimized HWND is not a usable dispatch/observation target) to
 *      recover it → `{ kind: 'hwnd' }`. This is still title-based, not
 *      cursor/foreground.
 *   3. No resolvable target → `{ kind: 'unresolved' }` so the caller falls
 *      through to Tier 4 SendInput (legacy nutjs in Phase 1b). This preserves
 *      the cursor-only / no-destination happy path (`scroll({action:'raw',
 *      direction:'down'})` with no windowTitle).
 *
 * **Dispatcher routing never touches cursor coordinates** — the cursor-pixel
 * routing that ADR-018 §1.2 identified as the root cause of the 11 reported
 * symptoms is confined to Tier 4 (which only fires when the destination is
 * unresolved, or when Tier 3 PostMessage is exhausted in Phase 4).
 *
 * Callers that need a *snapshot* HWND for Win32 GetScrollInfo observation
 * compute that separately — see `mouse.ts:scrollHandler`, which seeds the
 * observation HWND from `dest.hwnd` whenever `dest.kind === 'hwnd'` so
 * observation and action share the same destination (ADR §2.2 invariant).
 */
export async function resolveInputDestination(params: {
  hwnd?: string;
  windowTitle?: string;
}): Promise<InputDestination> {
  const resolved: ResolvedWindow | null = await resolveWindowTarget({
    hwnd: params.hwnd,
    windowTitle: params.windowTitle,
  });
  if (resolved !== null) {
    // ADR §2.1 D1 Tier 2 — promote Chromium HWNDs to a CDP destination when
    // a CDP session is reachable. This is the auto-detect the ADR specifies
    // ("Tier 2: Target is a Chrome/Edge tab (CDP attached via browser_open)")
    // — callers do NOT pass a tabId; the resolver gates by window class and
    // probes only when the gate matches, so non-browser windows pay no CDP
    // latency.
    const cdp = await resolveCdpDestinationForHwnd(resolved.hwnd);
    if (cdp !== null) return cdp;
    return { kind: "hwnd", hwnd: resolved.hwnd };
  }
  // Case 3 recovery (see docstring): `resolveWindowTarget` returns null for a
  // plain `windowTitle` that matches a top-level window — recover that HWND so
  // Tier 1 UIA stays reachable. The predicate below applies `_resolve-window.ts`
  // Case 3's `plainMatch` constraints — non-dialog class (`#32770` excluded)
  // AND no owner window — so we recover a true top-level window, never an
  // owned/modal dialog with a coincidentally-overlapping title substring
  // (Codex PR #288 Round 3 P2). It additionally excludes MINIMIZED windows:
  // a minimized HWND is not a usable dispatch target (UIA scroll on an
  // off-screen window) and — because `mouse.ts:scrollHandler` seeds
  // `observedHwnd` from `dest.hwnd` — would pin observation to a window that
  // cannot be observed, producing false `not_delivered` / `unverifiable`
  // results (Codex PR #288 Round 4 P1). The `mouse.ts` observation ladder
  // filters minimized for the same reason.
  // `@active` is excluded: `resolveWindowTarget` owns that shorthand and a
  // null return there means foreground resolution genuinely failed.
  // Phase 4 carry-over: extract a shared `findPlainTopLevelWindowByTitle`
  // helper so the dialog/owner predicate cannot drift from Case 3 — sub-plan §2.2.
  if (params.windowTitle && params.windowTitle !== "@active") {
    try {
      const want = params.windowTitle.toLowerCase();
      const match = enumWindowsInZOrder().find(
        (w) =>
          !w.isMinimized &&
          w.title.toLowerCase().includes(want) &&
          !DIALOG_CLASSNAMES.has(w.className ?? "") &&
          w.ownerHwnd == null,
      );
      if (match) {
        // Case 3 recovery also gets the CDP Tier 2 promotion — otherwise a
        // plain-windowTitle scroll on Chrome (where resolveWindowTarget returns
        // null by Case 3 design) would never see channel='cdp'.
        const cdp = await resolveCdpDestinationForHwnd(match.hwnd);
        if (cdp !== null) return cdp;
        return { kind: "hwnd", hwnd: match.hwnd };
      }
    } catch {
      /* enumWindowsInZOrder unavailable → fall through to unresolved */
    }
  }
  return { kind: "unresolved", reason: "no_target_window" };
}

/**
 * ADR §2.1 D1 Tier 2 — auto-promote a Chromium HWND to a CDP destination when
 * a CDP session is reachable on the configured port. Returns `null` when the
 * gate fails (non-Chromium class) OR when the CDP probe fails (browser not
 * running with `--remote-debugging-port`, no tabs, network error) — caller
 * then falls back to `{kind:'hwnd'}` and tries Tier 1 UIA.
 *
 * The window-class gate is cheap (already-enumerated `className`); only the
 * gate match incurs a `listTabsLight` HTTP round-trip, so non-browser windows
 * pay no CDP latency.
 *
 * Phase 3 picks the first listed tab as the destination — matching
 * `resolveTab(null, port)` semantics in `cdp-bridge.ts`. A future phase may
 * thread a focused-tab hint via the foreground HWND → tab mapping.
 *
 * Exported for unit testing.
 */
export async function resolveCdpDestinationForHwnd(
  hwnd: bigint,
): Promise<{ kind: "cdp"; tabId: string } | null> {
  let className: string | null = null;
  try {
    const win = enumWindowsInZOrder().find((w) => w.hwnd === hwnd);
    className = win?.className ?? null;
  } catch {
    return null;
  }
  if (className === null || !className.startsWith(CHROMIUM_CLASS_PREFIX)) {
    return null;
  }
  try {
    const port = getCdpPort();
    const tabs = await listTabsLight(port);
    const firstPage = tabs[0];
    if (!firstPage) return null;
    return { kind: "cdp", tabId: firstPage.id };
  } catch {
    return null;
  }
}

// ─── Runtime guard (ADR §4 Phase 1 deliverable) ──────────────────────────────

/**
 * Asserts that the caller is allowed to invoke Tier 4 (legacy SendInput
 * nutjs path) for the given destination. **Phase 1b adopts a LENIENT form**
 * (`'hwnd'` and `'unresolved'` are both allowed) so resolved-but-non-UIA
 * destinations (Word / Chrome / Excel under the dispatcher's view) preserve
 * the legacy happy path until Tier 3 PostMessage lands in Phase 4.
 *
 * ## ⚠ Phase 4 BREAKING CHANGE marker ⚠
 *
 * Phase 4 (when Tier 3 PostMessage lands) **MUST** tighten this guard to
 * `dest.kind === 'unresolved'` only. The Phase 4 tightening will:
 *
 * 1. Throw on `dest.kind === 'hwnd'` (resolved-but-Tier-3-exhausted) instead
 *    of allowing fall-through to SendInput
 * 2. Caller must catch and emit `{status:'not_delivered', channel:'postmessage',
 *    reason:'target_unreachable'}` per ADR §2.6.2 path-(b)
 * 3. The corresponding unit test (currently named "kind='hwnd' → no throw
 *    (Phase 1b lenient form)") must invert to `.toThrow(...)` in the same PR
 *
 * Carry-over: `docs/adr-018-phase-1b-subplan.md` §2.2 "Strict Tier 4 guard
 * (`kind === 'unresolved'` only)" tracks this.
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
 * - `kind === 'hwnd'`: probes Tier 1 UIA via the static-imported
 *   `uiaScrollByWheelAtHwnd` native call. If the HWND exposes a
 *   ScrollPattern ancestor AND the Rust path observes
 *   `|post_percent - pre_percent| >= SCROLL_PERCENT_EPSILON` (ADR §2.6.2
 *   emission condition for `delivered_via_uia`), returns
 *   `{ scrolled: true, channel: 'uia', reason: 'delivered_via_uia' }`.
 *   Otherwise returns `null` (caller falls through to legacy nutjs).
 * - `kind === 'uia'`: future-reserved (Phase 3 or later). The resolver does
 *   not emit `'uia'` in Phase 1b, so this branch is dormant. It dispatches
 *   through the same Tier 1 native path as `'hwnd'` and, like `'hwnd'`,
 *   returns `null` on native failure — `dispatchScrollWheel` itself never
 *   throws. The *failure-path* asymmetry is at the **caller**: `mouse.ts`
 *   calls `assertTier4Reachable(dest)` before the nutjs fallback, which lets
 *   an `'hwnd'` destination fall through but THROWS for `'uia'` (an
 *   explicit-UIA destination must never silently fall to cursor-routed
 *   SendInput — that is the guard's purpose). The asymmetry is intentional
 *   and harmless while the branch is dormant.
 * - `kind === 'cdp'`: Phase 3 stub — returns `null` so caller falls through.
 *   The `assertTier4Reachable` guard prevents misuse — see signature note.
 * - `kind === 'unresolved'`: returns `null` (caller invokes Tier 4 SendInput
 *   after `assertTier4Reachable(dest)` passes).
 *
 * Any thrown native error causes dispatch to return `null` and the caller
 * falls through to legacy.
 */
export async function dispatchScrollWheel(
  dest: InputDestination,
  params: WheelParams,
): Promise<DispatchOutcome | null> {
  if (dest.kind === "hwnd" || dest.kind === "uia") {
    try {
      // Resolve the Tier 1 native call through the tolerant `native-engine.ts`
      // loader — NOT a direct `import from "../../index.js"`, which `throw`s at
      // module-init time when the `.node` binary is missing (`index.js:35-43`),
      // defeating the graceful-degradation intent of the guard below (Codex
      // PR #288 Round 6 P1). `nativeUia` is `null` when the addon is absent,
      // and `uiaScrollByWheelAtHwnd` is `undefined` on older `.node` builds
      // without the Phase 1b export — both cases fall through to legacy nutjs.
      const scrollByWheel = nativeUia?.uiaScrollByWheelAtHwnd;
      if (typeof scrollByWheel !== "function") return null;
      const wheelDelta = wheelDeltaForNotch(params);
      const result = (await scrollByWheel({
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
  if (dest.kind === "cdp") {
    // ADR-018 Phase 3 — Tier 2 CDP wheel dispatch. Pre/post observation via
    // `readScrollPositionInTab` (document.scrollingElement); we declare
    // `delivered_via_cdp` only when both endpoints succeed AND scrollTop /
    // scrollLeft moved by at least CDP_SCROLL_DELIVERY_EPSILON_PX on the
    // axis of interest. Any failure (no session, JS exception, no observable
    // delta) returns null — caller emits `target_unreachable` per §2.6.2
    // path-(b) because Tier 4 SendInput must not be reached for a resolved
    // CDP destination (assertTier4Reachable throws on kind:'cdp').
    try {
      const port = getCdpPort();
      const pre = await readScrollPositionInTab(dest.tabId, port);
      if (pre === null) return null;
      const wheelDelta = wheelDeltaForNotch(params);
      // CDP dispatchMouseEvent requires viewport coordinates. Phase 3 sends
      // wheels at the viewport center; per-element coords (ADR §7 OQ6) are a
      // future phase. The tab is the destination, not the point.
      const cx = params.x ?? Math.floor(pre.clientWidth / 2);
      const cy = params.y ?? Math.floor(pre.clientHeight / 2);
      await dispatchWheelInTab(
        wheelDelta.x,
        wheelDelta.y,
        cx,
        cy,
        dest.tabId,
        port,
      );
      // Settle: CDP wheel handling is synchronous on the renderer side but
      // scrollTop reflects the layout-flushed value. A tiny yield is enough
      // to land on the post-frame state without burning latency.
      await new Promise((r) => setTimeout(r, 16));
      const post = await readScrollPositionInTab(dest.tabId, port);
      if (post === null) return null;
      const axisIsVertical =
        params.direction === "up" || params.direction === "down";
      const observedDelta = axisIsVertical
        ? Math.abs(post.scrollTop - pre.scrollTop)
        : Math.abs(post.scrollLeft - pre.scrollLeft);
      if (observedDelta < CDP_SCROLL_DELIVERY_EPSILON_PX) {
        return null;
      }
      return {
        scrolled: true,
        channel: "cdp",
        reason: "delivered_via_cdp",
      };
    } catch {
      return null;
    }
  }
  // unresolved → caller handles (Tier 4 SendInput fall-through)
  return null;
}

/**
 * Convert (direction, notch) into signed wheel-delta units. 1 notch = 120
 * units (the value of `WHEEL_DELTA` since Windows 2000); the Rust UIA path
 * scales this against `ScrollPattern.VerticalViewSize` to derive a percent
 * step. Down / right are positive, up / left negative — the UIA-internal
 * convention documented on `WheelParams` above. This is the **opposite** of
 * the Win32 `WM_MOUSEWHEEL` wParam high-word convention (positive = wheel
 * rotated forward = scroll up); Phase 4 PostMessage encoding MUST flip the
 * sign at the `postWheelToHwnd` napi boundary.
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
