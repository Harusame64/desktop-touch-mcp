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
import { enumWindowsInZOrder, getWindowRectByHwnd } from "../engine/win32.js";
import { nativeUia, nativeWin32, nativeL1 } from "../engine/native-engine.js";
import {
  listTabsLight,
  dispatchWheelInTab,
  readScrollPositionInTab,
} from "../engine/cdp-bridge.js";
import { getCdpPort } from "../utils/desktop-config.js";

/**
 * Win32 class name of a Chrome / Edge **top-level** window. Used as the gate
 * for CDP probing — only this exact class triggers a `listTabsLight` HTTP
 * round-trip in `resolveCdpDestinationForHwnd`. The earlier `startsWith
 * "Chrome_WidgetWin"` shape over-matched `Chrome_WidgetWin_0` (Chromium
 * **sub-windows** — popup menus, dropdowns) which can never be a scroll
 * destination, so the gate is now an equality on the top-level class only.
 *
 * **Known carry-over (Electron / multi-Chromium-app desktops)**: Chrome /
 * Edge / Slack / VS Code / Discord / Teams all use the same class name for
 * their top-level windows because they share the Chromium frame. When the
 * user has Chrome running with `--remote-debugging-port=9222` AND scrolls a
 * different Chromium-shell app (Slack, VS Code), the gate matches and the
 * `listTabsLight` probe succeeds — the wheel then mis-routes to Chrome.
 * Phase 3 accepts this risk because:
 *   1. Other Chromium-shell apps rarely run with a public CDP port (they
 *      don't expose `--remote-debugging-port` by default).
 *   2. When they do, the user has opted into CDP control and the
 *      destination ambiguity is theirs to manage (e.g. distinct ports).
 *   3. Phase 5 will tighten by cross-checking the HWND's PID against the
 *      `Target.getTargets()` window-owner PID via CDP — out of scope for
 *      Phase 3 to avoid scope creep. ADR §7 OQ3 / OQ6 carry-over.
 *
 * Future: if Edge's top-level class diverges in a Windows update, extend
 * this to a `new Set([...])` lookup. As of 2026-05 both Chrome and Edge
 * stable channels emit `Chrome_WidgetWin_1`.
 */
const CHROMIUM_TOP_LEVEL_CLASS = "Chrome_WidgetWin_1";

/**
 * Minimum pixel delta required to classify a CDP scroll as `delivered_via_cdp`.
 * 1px is the smallest observable scroll in CSS px; below that, browser pixel
 * snapping or sub-pixel rounding can produce noise on a no-op wheel. (ADR §2.6.2
 * — Tier 2 boundary signal: pre/post `scrollingElement.scrollTop` differ by
 * at least this many px.)
 */
const CDP_SCROLL_DELIVERY_EPSILON_PX = 1;

/**
 * ADR-018 Phase 4 — Tier 3 PostMessage settle delay (ms) before reading
 * `win32_get_scroll_info` post-snapshot. Wheel message handling on the
 * receiver pump is synchronous, but the scrollbar position reflects the next
 * paint. 16 ms ≈ one display frame at 60 Hz; same value Tier 2 CDP uses.
 */
const POSTMESSAGE_SETTLE_MS = 16;

/**
 * ADR-018 Phase 4 — Tier 3 PostMessage minimum observable `nPos` delta to
 * classify the scroll as `delivered_via_postmessage`. Scrollbar position is
 * reported in app-defined units (often pixels for a custom scrollbar, line
 * count for a listbox); a 1-unit movement is the smallest physically
 * observable change.
 */
const POSTMESSAGE_SCROLL_DELIVERY_EPSILON_NPOS = 1;

/**
 * Win32 wheel message constants. Verified against Microsoft Learn:
 * - WM_MOUSEWHEEL  = 0x020A — vertical wheel, HIWORD positive = forward (scroll up)
 * - WM_MOUSEHWHEEL = 0x020E — horizontal wheel, HIWORD positive = tilt right (scroll right)
 */
const WM_MOUSEWHEEL = 0x020a;
const WM_MOUSEHWHEEL = 0x020e;

/**
 * `WM_MOUSEWHEEL` / `WM_MOUSEHWHEEL` HIWORD is read as a signed 16-bit value
 * via `GET_WHEEL_DELTA_WPARAM` on the receiver side. A single message can
 * carry at most ±32767 raw units; large `notch` requests must be chunked so
 * each emitted message stays within the signed 16-bit range (otherwise the
 * sign bit wraps and a "scroll down" emerges as a "scroll up" on the
 * receiver, per Codex PR #305 review).
 */
const WHEEL_DELTA_MAX_PER_MSG = 0x7fff;

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
   * adds `'delivered_via_cdp'`, Phase 4 adds `'delivered_via_postmessage'`;
   * `'wheel_overlay_intercepted'` / `'target_unreachable'` are surfaced by
   * the caller via the typed envelope (see `mouse.ts:scrollHandler`). `null`
   * indicates no ADR-018 reason applies (caller picks the legacy
   * `evaluateScrollDelivery` reason from `mouse.ts`).
   */
  reason:
    | "delivered_via_uia"
    | "delivered_via_cdp"
    | "delivered_via_postmessage"
    | null;
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
    // ADR §2.1 D1 Tier 2 — promote Chrome/Edge top-level HWNDs to a CDP
    // destination when a CDP session is reachable. This is the auto-detect the
    // ADR specifies ("Tier 2: Target is a Chrome/Edge tab (CDP attached via
    // browser_open)") — callers do NOT pass a tabId; the resolver gates by
    // window class and probes only when the gate matches, so non-browser
    // windows pay no CDP latency. The class name is already known to
    // `resolveWindowTarget` (filled in via `safeGetClassName` on the resolved
    // HWND) so the gate does not require a second `enumWindowsInZOrder`
    // syscall — pass it through directly.
    const cdp = await resolveCdpDestinationForHwnd(resolved.hwnd, resolved.className ?? null);
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
        // null by Case 3 design) would never see channel='cdp'. The class name
        // is already on the `match` record (`enumWindowsInZOrder` returns it),
        // so the gate inside `resolveCdpDestinationForHwnd` does not re-enumerate.
        const cdp = await resolveCdpDestinationForHwnd(match.hwnd, match.className ?? null);
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
 * ADR §2.1 D1 Tier 2 — auto-promote a Chrome/Edge HWND to a CDP destination
 * when a CDP session is reachable on the configured port. Returns `null` when
 * the gate fails (non-Chromium-top-level class) OR when the CDP probe fails
 * (browser not running with `--remote-debugging-port`, no tabs, network error)
 * — caller then falls back to `{kind:'hwnd'}` and tries Tier 1 UIA.
 *
 * **The class name is passed in by the caller** (already known from
 * `ResolvedWindow.className` or `enumWindowsInZOrder()`'s record) so this
 * function does NOT re-enumerate windows. Total syscall budget per call is
 * **zero on the gate-miss path** and **one HTTP round-trip** on the gate-hit
 * path. (Opus Round 1 P2 — earlier shape redundantly called
 * `enumWindowsInZOrder` here, doubling the syscall cost per scroll.)
 *
 * Phase 3 picks the first listed tab as the destination — matching
 * `resolveTab(null, port)` semantics in `cdp-bridge.ts`. A future phase may
 * thread a focused-tab hint via the foreground HWND → tab mapping (ADR §7
 * OQ-Electron carry-over).
 *
 * Exported for unit testing.
 */
export async function resolveCdpDestinationForHwnd(
  _hwnd: bigint,
  className: string | null,
): Promise<{ kind: "cdp"; tabId: string } | null> {
  if (className !== CHROMIUM_TOP_LEVEL_CLASS) {
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
 * nutjs path) for the given destination. **Phase 4 strict form** — only
 * `dest.kind === 'unresolved'` is allowed; resolved destinations of any
 * kind (`'uia' | 'cdp' | 'hwnd'`) MUST dispatch through their own transport
 * and surface `target_unreachable` per ADR §2.6.2 path-(b) when every
 * applicable tier (1/2/3) is exhausted. The dispatcher routes Tier 1 → Tier 3
 * for `kind:'hwnd' | 'uia'` so by the time the caller would consider Tier 4
 * the destination was already proven exhausted at the dispatcher layer.
 *
 * History: Phase 1b adopted a lenient form (`'hwnd'` allowed) so the dispatcher
 * could roll out Tier 1 without losing the legacy SendInput fallback for
 * Word / Chrome / Excel before Tier 3 PostMessage landed. Phase 4 tightens
 * to strict because Tier 3 PostMessage now covers those resolved-but-non-UIA
 * destinations.
 *
 * @throws Error if `dest.kind` is `'uia'`, `'cdp'`, or `'hwnd'` (those
 *   destinations must dispatch through Tier 1/2/3 — invoking SendInput
 *   would bypass the destination-explicit contract and re-introduce the
 *   cursor-pixel routing that ADR §1.2 identifies as the root cause of
 *   the 11 reported symptoms).
 */
export function assertTier4Reachable(dest: InputDestination): void {
  if (dest.kind !== "unresolved") {
    throw new Error(
      `Tier 4 SendInput must not be reached when destination kind is '${dest.kind}'. ` +
        "Resolved destinations dispatch through Tier 1 (UIA) / Tier 2 (CDP) / Tier 3 (PostMessage) " +
        "and surface 'target_unreachable' when every applicable tier is exhausted. " +
        "(ADR-018 §2.6.2 path-(b): Tier 4 is reachable only when destination is unresolved.)",
    );
  }
}

// ─── Tier 3 PostMessage helpers (ADR-018 §4 Phase 4) ─────────────────────────

/**
 * Convert (direction, notch) into the Win32-flipped wheel-delta units used in
 * the `WM_MOUSEWHEEL` / `WM_MOUSEHWHEEL` `wParam` high word. UIA convention
 * (down/right positive) → Win32 convention (forward = scroll up = positive
 * for the **vertical** wheel only; horizontal wheel WM_MOUSEHWHEEL keeps
 * UIA's right=positive). 1 notch = 120 raw `WHEEL_DELTA` units.
 *
 * See sub-plan `docs/adr-018-phase-4-subplan.md` §2.3 sign matrix for the
 * load-bearing per-direction expectations. A second flip on the horizontal
 * axis would silently reverse left/right scrolling.
 */
function win32WheelEncoding(params: WheelParams): {
  message: number;
  signedDelta: number;
} {
  const magnitude = 120 * Math.abs(params.notch);
  switch (params.direction) {
    case "down":
      // UIA down=+ → Win32 vertical forward=- (scroll up=+ ⇒ scroll down=-).
      return { message: WM_MOUSEWHEEL, signedDelta: -magnitude };
    case "up":
      return { message: WM_MOUSEWHEEL, signedDelta: magnitude };
    case "right":
      // UIA right=+ matches WM_MOUSEHWHEEL right=+ (Vista+ horizontal wheel).
      return { message: WM_MOUSEHWHEEL, signedDelta: magnitude };
    case "left":
      return { message: WM_MOUSEHWHEEL, signedDelta: -magnitude };
  }
}

/**
 * Pack `MAKEWPARAM(modifiers, wheelDelta)` — Win32 macro that places the
 * modifiers in LOWORD and the signed wheelDelta in HIWORD. Both halves are
 * masked to 16 bits so a negative `wheelDelta` (e.g. -120 for vertical down)
 * round-trips as the two's-complement bit pattern HIWORD would re-extract
 * via `(short)HIWORD(wParam)`.
 */
function makeWheelWParam(modifiers: number, wheelDelta: number): bigint {
  const lo = modifiers & 0xffff;
  const hi = wheelDelta & 0xffff;
  return BigInt((hi << 16) | lo) & 0xffffffffn;
}

/**
 * Pack `MAKELPARAM(screenX, screenY)` — low word = X, high word = Y, both
 * as **screen** coordinates. Negative coords (secondary monitor left of
 * primary) are packed via `& 0xFFFF` so the sign bit survives for the
 * receiver's `(short)HIWORD(lParam)` extraction.
 */
function makeScreenLParam(screenX: number, screenY: number): bigint {
  const lo = screenX & 0xffff;
  const hi = screenY & 0xffff;
  return BigInt((hi << 16) | lo) & 0xffffffffn;
}

/**
 * ADR-018 Phase 4 — Tier 3 PostMessage wheel dispatch.
 *
 * Encodes `WM_MOUSEWHEEL` (vertical) or `WM_MOUSEHWHEEL` (horizontal) via
 * `win32_post_message` and verifies the scroll happened with pre/post
 * `win32_get_scroll_info` snapshots on the axis of interest.
 *
 * Returns `DispatchOutcome` on observable delivery; `null` on any failure
 * (missing native binding, no scrollbar to observe, message not consumed by
 * the target HWND — Word `_WwG` MFC custom-paint case, etc.) so the caller
 * can emit `target_unreachable` per ADR §2.6.2 path-(b). Never throws.
 *
 * lParam is `MAKELPARAM(rect.cx, rect.cy)` from `getWindowRectByHwnd` — the
 * window-center screen coordinate. MFC apps frequently use lParam to find
 * the receiving child via `ChildWindowFromPoint`; the window center is the
 * safest neutral hit point. When the rect lookup fails the lParam falls
 * back to 0 (apps that ignore lParam still scroll; apps that hit-test fail
 * observably and emit `target_unreachable`).
 *
 * Exported for unit testing.
 */
export async function postWheelToHwnd(
  hwnd: bigint,
  params: WheelParams,
): Promise<DispatchOutcome | null> {
  const postMessage = nativeWin32?.win32PostMessage;
  const getScrollInfo = nativeWin32?.win32GetScrollInfo;
  if (typeof postMessage !== "function") return null;
  try {
    const { message, signedDelta } = win32WheelEncoding(params);
    const rect = getWindowRectByHwnd(hwnd);
    const lParam = rect !== null
      ? makeScreenLParam(
          Math.round(rect.x + rect.width / 2),
          Math.round(rect.y + rect.height / 2),
        )
      : 0n;

    const axisIsVertical =
      params.direction === "up" || params.direction === "down";
    const axisName = axisIsVertical ? "vertical" : "horizontal";

    // Pre-snapshot is best-effort. Two distinct "no observation" cases must
    // be kept apart (Codex PR #305 review P2-A):
    //   1. `getScrollInfo` is genuinely missing (mixed-version `.node` build
    //      without the Phase 1 GetScrollInfo binding) — caller cannot detect
    //      `target_unreachable` either, so we presume the post is delivered
    //      and let the caller's own observation (`captureScrollSnapshot`
    //      dHash + Win32 in `mouse.ts`) catch a no-op.
    //   2. `getScrollInfo` is present but returns null for THIS HWND (Word
    //      `_WwG`, modern UWP custom-paint, no Win32 scrollbar) — that IS
    //      the `target_unreachable` signal.
    const getScrollInfoAvailable = typeof getScrollInfo === "function";
    const pre = getScrollInfoAvailable ? getScrollInfo(hwnd, axisName) : null;

    // Chunk the wheel delta into ≤ 16-bit signed messages so the receiver's
    // `GET_WHEEL_DELTA_WPARAM` (signed short) does not wrap. For typical
    // notch counts (1-10) this loops once. For `notch >= 274` the previous
    // single-message implementation wrapped the sign bit and silently
    // reversed scroll direction (Codex PR #305 review P2-B).
    const sign = signedDelta < 0 ? -1 : 1;
    let remaining = Math.abs(signedDelta);
    let postedAny = false;
    while (remaining > 0) {
      const chunkMagnitude = Math.min(remaining, WHEEL_DELTA_MAX_PER_MSG);
      const chunkSigned = sign * chunkMagnitude;
      const wParam = makeWheelWParam(0, chunkSigned);
      const posted = postMessage(hwnd, message, wParam, lParam);
      if (!posted) {
        // Receiver rejected this chunk. If at least one earlier chunk
        // delivered, fall through to observation; if NOTHING posted, return
        // null so the caller emits target_unreachable.
        if (!postedAny) return null;
        break;
      }
      postedAny = true;
      // ADR-007 P5a L1 capture contract — record every successful chunk to
      // the L1 ring for replay-accurate observability. `postMessageToHwnd`
      // in `src/engine/win32.ts:602` does this for the WM_CHAR/WM_KEY
      // paths; Tier 3 wheel posts must follow the same contract or the L1
      // stream loses an entire input class. (Opus PR #305 Round 1 P2-1.)
      nativeL1?.l1PushHwInputPostMessage?.(hwnd, message >>> 0, wParam, lParam);
      remaining -= chunkMagnitude;
    }

    // `notch=0` (or any zero-magnitude call) loops zero times → nothing was
    // ever posted. Surface as null so the caller emits `target_unreachable`
    // rather than claiming a false-positive delivery from the mixed-version
    // observation-API-missing branch below (Opus PR #305 Round 3 P2-1).
    if (!postedAny) return null;

    await new Promise((r) => setTimeout(r, POSTMESSAGE_SETTLE_MS));

    // Case 1 — observation API genuinely missing: presume delivered.
    if (!getScrollInfoAvailable) {
      return {
        scrolled: true,
        channel: "postmessage",
        reason: "delivered_via_postmessage",
      };
    }
    // Case 2 — pre-snapshot null: this HWND has no Win32 scrollbar at all
    // (Word `_WwG` etc.). Caller emits target_unreachable.
    if (pre === null) return null;
    const post = getScrollInfo!(hwnd, axisName);
    if (post === null) return null;

    const delta = Math.abs(post.nPos - pre.nPos);
    if (delta < POSTMESSAGE_SCROLL_DELIVERY_EPSILON_NPOS) return null;

    return {
      scrolled: true,
      channel: "postmessage",
      reason: "delivered_via_postmessage",
    };
  } catch {
    return null;
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
    // ADR §2.1 D1 — try Tier 1 UIA first. The native call returns null /
    // ok:false when the HWND lacks a ScrollPattern ancestor (Word document,
    // modern UWP, accessibility-blind custom paint) so we fall through to
    // Tier 3 PostMessage rather than returning null immediately (Phase 4).
    //
    // `'uia'` branch: today no resolver emits `'uia'` (Phase 1b sub-plan
    // §2.1#1) so the kind is dormant. When a future resolver does emit it
    // (e.g. an explicit-element resolver passing in a UIA AutomationElement),
    // Tier 3 PostMessage on the same HWND is a SAFE escape hatch — the
    // destination is still HWND-anchored, no cursor-pixel routing occurs.
    // If a future design wants `'uia'` to be UIA-only (no Tier 3 fall-back),
    // split this branch. As of Phase 4 the dormant branch matches `'hwnd'`
    // semantics. (Opus PR #305 Round 1 P2-3.)
    try {
      // Resolve the Tier 1 native call through the tolerant `native-engine.ts`
      // loader — NOT a direct `import from "../../index.js"`, which `throw`s at
      // module-init time when the `.node` binary is missing (`index.js:35-43`),
      // defeating the graceful-degradation intent of the guard below (Codex
      // PR #288 Round 6 P1). `nativeUia` is `null` when the addon is absent,
      // and `uiaScrollByWheelAtHwnd` is `undefined` on older `.node` builds
      // without the Phase 1b export — both cases fall through to Tier 3.
      const scrollByWheel = nativeUia?.uiaScrollByWheelAtHwnd;
      if (typeof scrollByWheel === "function") {
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
        // ok:false or scrolled:false → fall through to Tier 3 PostMessage.
      }
    } catch {
      // Tier 1 native crash → fall through to Tier 3 (best-effort).
    }
    // ADR-018 Phase 4 — Tier 3 PostMessage fall-through. Covers Word `_WwG`,
    // Excel cell area, Explorer ListView, and other destinations that have a
    // resolvable HWND but no ScrollPattern. `postWheelToHwnd` returns null on
    // either "message not consumed" or "no observable scrollbar diff"; the
    // caller (`mouse.ts:scrollHandler`) reads `dest.kind === 'hwnd'` AND
    // dispatcher null → emits `target_unreachable` per ADR §2.6.2 path-(b)
    // and does NOT fall through to Tier 4 SendInput.
    return await postWheelToHwnd(dest.hwnd, params);
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
