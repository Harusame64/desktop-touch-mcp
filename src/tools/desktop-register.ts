/**
 * desktop-register.ts — MCP tool registration for desktop_discover / desktop_act.
 *
 * Registered by default on v0.17+; suppressed only when the kill switch
 * DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1 is set.
 *
 * Facade lifecycle:
 *   - Process-local singleton (shared across all createMcpServer() calls).
 *   - In stateless HTTP mode, multiple requests share the same facade instance;
 *     session state (leases, generations) persists within the process lifetime.
 *     This is required: desktop_discover in request N must be followed by desktop_act
 *     in request N+1 using the same session.
 *   - State bleed between targets is prevented by the per-target SessionRegistry
 *     (each hwnd/tabId/windowTitle has its own LeaseStore and generation counter).
 */

import { runClassic, CLASSIC_NOTE, CLASSIC_NOTE_STILL_RUNNING, CLASSIC_NOTE_NOT_USED, type UiaClient } from "../engine/uia-client-scope.js";
import { nativeUia } from "../engine/native-engine.js";
import { z } from "zod";
import {
  landingAdvice,
  LANDING_ADVICE_TOOL_DESCRIPTION,
} from "../engine/landing-advice.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { coercedBoolean } from "./_coerce.js";
import { executorFailedAdviceFor, failCode, getSuggestsForCode } from "./_errors.js";
import { DesktopFacade, type CandidateProvider, type DesktopSeeInput, type DesktopWindowMeta } from "./desktop.js";
import type {
  EntityLease,
  LeaseValidationResult,
  UiEntity,
} from "../engine/world-graph/types.js";
import {
  makeCommitWrapper,
  makeQueryWrapper,
  withEnvelopeIncludeSchema,
  genericQueryCausedByProjector,
  defaultQuerySessionId,
  toFailureEnvelope,
  type CommitWrapperOptions,
} from "./_envelope.js";
import { nativeViewFocus } from "../engine/native-engine.js";
import type { NativeLeaseTokenSummary } from "../engine/native-types.js";
import type { ToolResult } from "./_types.js";
import { persistCapture, REF_URI_PREFIX } from "../engine/screenshot-cache.js";
import { pngDimensions } from "./screenshot-response.js";
import { Err } from "../types/result.js";
import {
  ExecutorFailedError,
  CoordinateOutsideReachableBoundsError,
  CursorPlacementBlockedError,
  AimWindowGoneError,
  AimPointOutsideWindowError,
  AimOccludedError,
  AimIdentityChangedError,
  AimRouteFailedError,
  ActionNotOfferedError,
  ValueNotAppliedRefusalError,
  WindowExcludedRefusalError,
  AimBlockedByExcludedRefusalError,
  EntityNotFoundRefusalError,
  KeyboardTargetUnsafeRefusalError,
  ForegroundNotAllowedRefusalError,
} from "../errors/typed-errors.js";
import type { WindowBlockAnswer, SnapshotWindowAnswer, TouchAction, RoiCapture, RoiCaptureMaterial, SemanticDiff, ViewportVerdict } from "../engine/world-graph/guarded-touch.js";
import { SnapshotIngress } from "../engine/world-graph/candidate-ingress.js";
import type { TargetSpec } from "../engine/world-graph/session-registry.js";
import { composeCandidates, composeCandidatesOnly } from "./desktop-providers/compose-providers.js";
import { getVisualRuntime } from "../engine/vision-gpu/runtime.js";
import { PocVisualBackend } from "../engine/vision-gpu/poc-backend.js";
import { OnnxBackend } from "../engine/vision-gpu/onnx-backend.js";
import { onDirtySignal } from "../engine/vision-gpu/dirty-signal.js";
import { _resetOcrAdaptersForTest, getOcrVisualAdapter } from "../engine/vision-gpu/ocr-adapter-registry.js";
import { DirtyRectRouter } from "../engine/vision-gpu/dirty-rect-source.js";
import {
  enumWindowsInZOrder,
  getWindowProcessId,
  isWindowProcessFrozen,
  getProcessIdentityByPid,
  getWindowRectByHwnd,
  getVisibleFrameRectByHwnd,
  enumMonitors,
  getVirtualScreen,
  getWindowRenderState,
  getWindowRoot,
  windowIsAlive,
  getWindowOwner,
  isWindowEnabled,
  enumTopLevelWindowHandles,
  getWindowThreadId,
  getWindowTitleW,
  getWindowClassName,
} from "../engine/win32.js";
import { compareAimIdentity, type Aim, type WindowIdentity } from "../engine/aim.js";
import { probeAim } from "../engine/aim-probe.js";
import { computeViewportPosition } from "../utils/viewport-position.js";
import { pickPlainTopLevelWindowByTitle } from "./_resolve-window.js";
import { resolveOutputIndexForHwnd } from "../engine/any-change.js";
import { ACT_MOTION, observeAfterAct, PreActWatch, visibleParts, type QuietRecord } from "../engine/act-motion.js";
import { captureFrame, type RawFrame } from "../engine/layer-buffer.js";
import { verifyLocalRepaint } from "../engine/local-repaint.js";
import { disposeSharedDirtyRectBroker, getSharedDirtyRectBroker, type BrokerSubscription, type CacheAcquireState, type DirtyRectBroker } from "../engine/dxgi-broker.js";
import type { VisualMotionObservation } from "./_input-pipeline.js";
import { shouldReturnRoiCapture, type ReturnCaptureMode } from "./_roi-capture-gate.js";
import { filterDirtyRectsToWindow, boundingBox, clampRectToWindow, resolveFoldOcrRoi } from "./_roi-region.js";
import { buildRoiPreviewEntities, somElementsToCandidates } from "./_roi-preview.js";
import { runSomPipeline } from "../engine/ocr-bridge.js";
import { productionRereadStale } from "./_stale-reread.js";
import { productionWindowIdentity } from "./_window-identity.js";
import type { Rect, UiEntityCandidate } from "../engine/vision-gpu/types.js";
import { createDefaultCapabilityRegistry } from "../capabilities/registry.js";

// ── Advisory registry singleton (PR-SR1-3) ────────────────────────────────────

/**
 * Module-level singleton — pure, no internal state.  Safe for concurrent /
 * parallel test execution and multi-request HTTP mode (北極星 1 + sub-plan §4.2).
 */
const advisoryRegistry = createDefaultCapabilityRegistry();

// ── G1: Production guards (viewport + focus) ──────────────────────────────────

/**
 * G1-B: Production viewport guard. Returns `null` when the touch may proceed,
 * otherwise the reason to block on (ADR-029 Phase 1).
 *
 * Structured sources (uia, cdp, terminal) guarantee that the element is accessible
 * to the OS at the time of candidate resolution — they cannot be truly "out of viewport"
 * from the OS's perspective. We pass these conservatively.
 *
 * Visual-only entities with a rect are checked against the *origin* window — the
 * window that produced the entity at discovery time (`entity.origin`) — not against
 * the foreground window. Before ADR-029 this compared with the foreground window,
 * which blocked every visual-only touch whose target window was not focused (the
 * common case on a multi-monitor desktop, where the entity legitimately lives at
 * coordinates far outside the foreground window's rect).
 *
 * The origin is resolved in identity order — HWND, then window title (providers
 * record the title when the target carried no handle), then a direct probe of an
 * HWND the enumeration filtered out. Verdicts:
 *   - origin window gone (closed / renamed) → entity_outside_viewport (stale view; re-discover)
 *   - origin window minimised / cloaked / hidden → origin_window_not_visible (nothing is
 *     rendered at those coordinates; restore with focus_window, then re-discover). Falling back
 *     to a virtual-screen check here would be a category error: the gate would pass and the click
 *     would land on whatever unrelated window now occupies that area.
 *   - entity centre outside the origin window's current rect → entity_outside_viewport
 *   - unresolvable origin ("@active" / browserTab / absent) → virtual-screen bounds check,
 *     so coordinates off every monitor are still blocked rather than conservatively passed.
 *
 * A title origin is NOT treated as "valid anywhere on screen": that would let a stale
 * element be clicked at its old coordinates after its window moved, hid or closed.
 *
 * Absence from `enumWindowsInZOrder` does NOT mean the window closed: that enumeration
 * drops invisible, untitled and sub-50px windows, and an untitled canvas / game / remote
 * session window is exactly the UIA-less target this gate exists for. Such an HWND is
 * probed directly (`getWindowRenderState`) so a live-but-filtered window is compared
 * against its real rect instead of being blocked as stale.
 *
 * Conservative fallback (`null` = pass) when the window *enumeration* fails, i.e.
 * when the gate cannot judge at all. The per-HWND probe is the one exception: it
 * cannot separate "handle is gone" from "handle unreadable", and both are
 * reported as a stale view, because by then the enumeration has already said the
 * window is not among the live titled ones. That direction is safe — it costs a
 * re-discovery, never a click at the wrong place.
 *
 * `deps` exists for unit tests only — production calls pass nothing and hit the
 * real Win32 enumerators (same injection idiom as `createCachedProductionWindowsProvider`).
 */
export interface ViewportCheckDeps {
  enumerate?: typeof enumWindowsInZOrder;
  virtualScreen?: typeof getVirtualScreen;
  probeWindow?: typeof getWindowRenderState;
}

export function productionCheckViewport(entity: UiEntity, deps: ViewportCheckDeps = {}): ViewportVerdict {
  if (!entity.rect) return null; // no rect → can't check → conservative pass
  // Structured sources: OS guarantees accessibility, skip rect check.
  if (entity.sources.some((s) => s === "uia" || s === "cdp" || s === "terminal")) return null;
  const enumerate = deps.enumerate ?? enumWindowsInZOrder;
  const virtualScreen = deps.virtualScreen ?? getVirtualScreen;
  const probeWindow = deps.probeWindow ?? getWindowRenderState;
  const rect = entity.rect;
  const inView = (region: { x: number; y: number; width: number; height: number }): ViewportVerdict =>
    computeViewportPosition(rect, region) === "in-view" ? null : "entity_outside_viewport";

  // Visual-only: check the entity rect against its origin window's current rect.
  try {
    const originId = entity.origin?.kind === "window" ? entity.origin.id : undefined;
    // The handle the capture resolved, when the producer recorded one. This is a
    // stable identity: `origin.id` is frequently the caller's query, and
    // re-resolving a query at act time can land on a different window if the
    // Z-order changed since discovery.
    const originHwnd = entity.origin?.hwnd;

    // "@active" carries no identity (the provider had neither HWND nor title at
    // discovery time), and a browser tab has no window rect to compare against.
    if (originHwnd !== undefined || (originId !== undefined && originId !== "@active")) {
      // One enumeration snapshot serves every lookup below — it is not cheap, and
      // two snapshots could disagree about the same desktop.
      const windows = enumerate();
      // A recorded handle wins outright; otherwise an all-numeric id is treated as
      // one, since a handle and an all-numeric window title look identical.
      const hwndId = originHwnd ?? (originId !== undefined && /^\d+$/.test(originId) ? originId : undefined);

      // 1. Exact HWND identity. Preferred over a title match: a title is only a
      //    name that several windows can share and that re-resolution can move.
      if (hwndId !== undefined) {
        const byHwnd = windows.find((w) => String(w.hwnd) === hwndId);
        if (byHwnd) {
          if (byHwnd.isMinimized || byHwnd.isCloaked) return "origin_window_not_visible";
          return inView(byHwnd.region);
        }
      }

      // A recorded handle is an identity, not a query: never fall through to title
      // matching for it — an unrelated live window whose title contains the same
      // digits would otherwise be accepted as the origin. Probe it, then stop.
      if (originHwnd !== undefined) {
        const state = probeWindow(BigInt(originHwnd));
        if (!state) return "entity_outside_viewport"; // handle is gone → view is stale
        if (state.minimized || state.cloaked || !state.visible) return "origin_window_not_visible";
        return inView(state.rect);
      }

      // 2. Title identity — the common `desktop_discover({target:{windowTitle}})`
      //    shape, where the provider had no HWND to record. Resolving it matters:
      //    treating a title origin as "valid anywhere on screen" would let a stale
      //    element be clicked at its old coordinates after its window moved, hid
      //    or closed, which is the silent misclick this change exists to remove.
      //
      //    Resolved exactly the way the OCR capture resolved it — `runSomPipeline`
      //    (`engine/ocr-bridge.ts`) picks the window whose pixels became this
      //    entity with a plain case-insensitive substring find over the Z-ordered
      //    list, with NO minimised / dialog / owned filtering. That is the
      //    authority here, not `resolveWindowTarget`, which only probes for a
      //    match and leaves the raw query to reach the providers. Any stricter
      //    rule resolves a different window than the one the entity came from:
      //    equality fails on "Notepad" vs "Untitled - Notepad"; skipping a
      //    minimised or cloaked match retargets to another window sharing the
      //    substring (ordinary with a query like "Chrome" plus a virtual-desktop
      //    switch, which cloaks windows); filtering dialogs skips a dialog whose
      //    pixels OCR actually captured. Resolve first, judge visibility second.
      const match = originId !== undefined
        ? pickPlainTopLevelWindowByTitle(windows, originId, {
            excludeMinimized: false,
            excludeDialogsAndOwned: false,
            // ADR-035 Phase 1: the viewport gate asks "is the entity's origin
            // window still on screen", not "where does this write go". Logging
            // it would mix a read-side judgement into the write-path match-count
            // statistics the phase exists to measure (Opus Round 2 P2).
            logAs: "off",
          })
        : null;
      if (match) {
        if (match.isMinimized || match.isCloaked) return "origin_window_not_visible";
        return inView(match.region);
      }

      // 3. HWND-shaped id, not enumerated and not a live title: the enumeration
      //    drops invisible, untitled and sub-50px windows, so probe the handle
      //    before calling it closed — untitled canvases are this gate's subject.
      if (hwndId !== undefined) {
        const state = probeWindow(BigInt(hwndId));
        if (!state) return "entity_outside_viewport"; // handle is gone → view is stale
        if (state.minimized || state.cloaked || !state.visible) return "origin_window_not_visible";
        return inView(state.rect);
      }

      // 4. A title that no longer matches any live window → closed or renamed.
      return "entity_outside_viewport";
    }

    // No resolvable origin → virtual screen, so coordinates off every monitor are
    // still blocked rather than conservatively passed.
    return inView(virtualScreen());
  } catch {
    return null; // conservative on Win32 error
  }
}

/**
 * internal #126 — is the entity's own window disabled by a dialog?
 *
 * The clear ground the user's rule asks for ("refuse, but only when the grounds are clear",
 * 2026-09-11), read from the OS at the moment of the act: **the entity's top-level window is
 * disabled, and a different window of its owner family is still live.** That is what `ShowDialog`
 * / `MessageBox` / a common dialog does, and the one modal the `desktop_discover` snapshot, scoped
 * to the main window, cannot contain.
 *
 * Three answers (`WindowBlockAnswer`): `blocked` with that dialog; `takes_input` when the element's
 * OWN window (its own handle's root) is enabled — which also sets the snapshot's guess aside;
 * `cannot_say` for everything else, including an enabled window asked about by the entity's recorded
 * or the aim's handle, where the snapshot check still runs. Each writes one `act.modal` row naming
 * what it found.
 *
 * **The family is the top of the `GW_OWNER` chain's**, so a dialog opened by a dialog is seen: the first version
 * asked the entity's window alone (`preferActivePopupIfBlocked`), which answers only one level and
 * demands a title, and a nested or untitled dialog read as "not blocked" (gate 2, round 1).
 *
 * win2 measured the one-level readings on four fixtures before anything depended on them
 * (internal `6e41392`): `ShowDialog` and `MessageBox` → blocked; a non-modal owned window and a
 * NumericUpDown window → NOT blocked, the owner is enabled. A disabled window whose last popup is a
 * non-modal tool window is refused too: input to a disabled window is discarded either way.
 *
 * **Which window is asked: the entity's recorded handle, else the aim's.** The aim is the window
 * this act is aimed at, and it carries who owned that handle when it was taken — on an addon older
 * than #619 the UIA lane records no handle, and the first version asked nothing at all there, a
 * silence indistinguishable from "not blocked" (win2, 2026-09-19). Neither is re-resolved by title:
 * a re-resolution can land on a different window, and a refusal about someone else's window is not a
 * clear ground. **When the window asked is the aim's, its owner must still be the aim's** —
 * `compareAimIdentity`, the executor's own check: a closed window whose handle now names another
 * process's window is not asked (the executor refuses that act as `aim_identity_changed`; gate 2,
 * round 1). A web page's in-page `<dialog>` does not disable the window and is not seen by this.
 *
 * `deps` exists for unit tests only.
 */
export interface BlockingWindowDeps {
  root?: (hwnd: bigint) => bigint | null;
  identityNow?: (hwnd: bigint) => WindowIdentity | undefined;
  owner?: (hwnd: bigint) => bigint | null;
  isEnabled?: (hwnd: bigint) => boolean;
  topLevelWindows?: () => bigint[];
  threadOf?: (hwnd: bigint) => number;
  isVisible?: (hwnd: bigint) => boolean;
  title?: (hwnd: bigint) => string;
  className?: (hwnd: bigint) => string;
}

export function productionFindBlockingWindow(
  entity: UiEntity,
  aim: Aim | undefined,
  deps: BlockingWindowDeps = {},
): WindowBlockAnswer {
  const recorded = entity.origin?.hwnd;
  // The element's OWN window first, when it has one: UIA can show a window owned by the main
  // window as the main window's child, so a dialog's own "OK", discovered from the main window,
  // records the main window's handle — disabled, with that very dialog as its popup — and would be
  // refused as blocked by itself (gate 2, round 2). A Win32 button is its own window; its root is
  // the dialog, which is enabled.
  const own = entity.locator?.uia?.nativeWindowHandle;
  const numeric = (v: string | undefined): bigint | undefined => (v !== undefined && /^\d+$/.test(v) && v !== "0" ? BigInt(v) : undefined);
  const fromOwn = numeric(own);
  const fromOrigin = numeric(recorded);
  const handle = fromOwn ?? fromOrigin ?? aim?.hwnd;
  const askedFrom = fromOwn !== undefined ? "element" : fromOrigin !== undefined ? "entity_origin" : aim?.hwnd !== undefined ? "aim" : null;
  // One `act.modal` row per check, whatever it answers — including that it could not ask.
  const row = (answer: string, extra: Record<string, unknown> = {}): void =>
    probeAim("act.modal", { entityId: entity.entityId, asked: handle !== undefined, askedFrom, handle: handle?.toString() ?? null, answer, ...extra });
  const cannotSay: WindowBlockAnswer = { kind: "cannot_say" };
  if (handle === undefined) {
    row("no_handle");
    return cannotSay;
  }
  try {
    const rootOf = deps.root ?? getWindowRoot;
    const root = rootOf(handle);
    if (root === null) {
      row("no_root");
      return cannotSay;
    }
    // The aim's window, still the aim's owner? Checked whenever the window asked IS the aim's.
    if (aim?.hwnd !== undefined && rootOf(aim.hwnd) === root) {
      const now = (deps.identityNow ?? productionWindowIdentity)(aim.hwnd);
      if (compareAimIdentity(aim, now) === "changed") {
        row("aim_identity_changed", { root: root.toString() });
        return cannotSay;
      }
    }
    const isEnabled = deps.isEnabled ?? isWindowEnabled;
    if (isEnabled(root)) {
      // Only an answer about the element's OWN window outranks the snapshot. The entity's recorded
      // window, or the aim's, is the window the read was made from: UIA lists an owned window's
      // controls under its owner, so a handle-less control in a modeless window W that has opened
      // its own MessageBox is asked about the enabled owner, and setting the snapshot's guess aside
      // on that answer set aside the very MessageBox (gate 2; the parent refused it).
      const outranksSnapshot = askedFrom === "element";
      row("window_enabled", { root: root.toString(), outranksSnapshot });
      return outranksSnapshot ? { kind: "takes_input" } : cannotSay;
    }
    // The top of the OWNER chain, walked by `GW_OWNER`. Not `GA_ROOTOWNER`: that walks `GetParent`,
    // which returns the owner only for a popup-styled window, and a WinForms Form dialog is an
    // overlapped window — owned by the main window, yet its own "root owner". Keyed on that, the
    // WinForms `ShowDialog` and a MessageBox it opened fell out of the family, and the act answered
    // ok:true again (win2, 2026-09-19, internal `e7f3980`). Bounded: an owner loop cannot exist in
    // Windows, but a read that tears must not spin.
    const ownerOf = deps.owner ?? getWindowOwner;
    const topOwnerOf = (w: bigint): bigint => {
      let at = w;
      for (let i = 0; i < 32; i++) {
        const next = ownerOf(at);
        if (next === null || next === at) return at;
        at = next;
      }
      return at;
    };
    const chainTop = topOwnerOf(root);
    // The windows that OWN the entity's — never its blocker: a modal is owned by what it blocks, not
    // the other way round. Without this, an owned palette the app disabled for its own reasons named
    // its enabled main window as the dialog blocking it (gate 2, round 3).
    const ownersOfRoot = new Set<bigint>();
    for (let at = ownerOf(root), i = 0; at !== null && i < 32; at = ownerOf(at), i++) ownersOfRoot.add(at);
    // **The dialog is the window of this owner family that is still live**: visible, enabled, not
    // the entity's own — and of those, the one nearest the top of the Z-order. A modal disables the
    // windows it blocks and stays enabled itself; a nested dialog sits above the one that opened it.
    //
    // The "last active popup" reading this replaced named whatever was activated last: a hidden
    // popup Windows still remembers, or a palette the user clicked while the modal was up — and
    // when WinForms' `MessageBox` had disabled that palette too, the check fell silent and the act
    // answered `ok:true` under a real modal, the defect this exists to end (win2, 2026-09-19,
    // internal `a24d9c3`). The family is every window whose `GW_OWNER` chain tops out
    // where this one's does. The handle list is unfiltered and front-to-back (EnumWindows).
    const isVisible = deps.isVisible ?? isPopupVisible;
    const windows = (deps.topLevelWindows ?? enumTopLevelWindowHandles)();
    const live = (w: bigint): boolean => w !== root && !ownersOfRoot.has(w) && isVisible(w) && isEnabled(w);
    // **An ownerless modal is not in any family**: `MessageBox(NULL, …, MB_TASKMODAL)` and a WPF
    // `ShowDialog()` with no `Owner` disable every top-level window of their THREAD and own none of
    // them (gate 2, round 3 — the #126 shape again, one step out). A modal loop runs on the thread
    // of the windows it blocks, so the thread is the family's fallback: asked only when the owner
    // family has nothing live.
    const threadOf = deps.threadOf ?? getWindowThreadId;
    const rootThread = threadOf(root);
    const popup =
      windows.find((w) => live(w) && topOwnerOf(w) === chainTop) ??
      (rootThread !== 0 ? windows.find((w) => live(w) && threadOf(w) === rootThread) : undefined) ??
      null;
    // Disabled with nothing live in its family or its thread: its own work, not a modal. Not a
    // ground to name — the snapshot check still runs.
    if (popup === null) {
      row("disabled_no_live_window", { root: root.toString() });
      return cannotSay;
    }
    const title = (deps.title ?? getWindowTitleW)(popup);
    // Untitled is still a dialog: the ground is the disabled window, not the name. The handle is
    // what a caller can use to reach it; a class name stands in for the missing title.
    const name = title !== "" ? title : (deps.className ?? getWindowClassName)(popup) || "dialog";
    row("blocked", { root: root.toString(), blocker: String(popup) });
    return { kind: "blocked", blocker: { name, role: "dialog", hwnd: String(popup) } };
  } catch {
    // Unreadable is not a ground: the snapshot check still runs.
    row("unreadable");
    return cannotSay;
  }
}

function isPopupVisible(hwnd: bigint): boolean {
  return getWindowRenderState(hwnd)?.visible ?? false;
}

/**
 * internal #211 items 2 and 9 — what the OS says now about one `Window` of the `desktop_discover`
 * snapshot, asked by that window's own handle ({@link SnapshotWindowAnswer}).
 *
 * - `not_a_dialog`: its top-level window (`GA_ROOT`) is the one the touched element was read from —
 *   reached from the element's own handle, its recorded one, or the aim's while the aim still names
 *   its owner (`compareAimIdentity`, as `productionFindBlockingWindow` asks). Calculator's own title
 *   bar, a `WS_CHILD` of its frame, was refused as the modal blocking its "±" on every act (win2,
 *   internal #212). A child window is not waived by its style alone: a child inside a separate
 *   dialog is that dialog's content (gate 2, round 1).
 * - `closed`: `windowIsAlive` answered a definite no, while a window the element was read from is
 *   still there. When every one of those is gone too, the element's own window has closed, and the
 *   answer is `not_a_dialog`: the executor says that (`aim_window_gone`), not this stale snapshot.
 * - `may_block`: everything else, including no handle, no binding and a read that fails — the
 *   snapshot counts it, as it did before this was asked.
 *
 * An owned dialog is a top-level window of its own, so it stays `may_block` for an element of the
 * window that owns it. **What this gives up**: a modal built as a child window of the element's own
 * top-level window (an MDI modal child) is not counted, and the OS check does not see it either, as
 * the top-level window stays enabled. One `act.modal` row per window asked.
 *
 * `deps` exists for unit tests only.
 */
export interface SnapshotWindowDeps {
  isAlive?: (hwnd: bigint) => boolean | undefined;
  root?: (hwnd: bigint) => bigint | null;
  identityNow?: (hwnd: bigint) => WindowIdentity | undefined;
}

export function productionJudgeSnapshotWindow(
  window: UiEntity,
  entity: UiEntity,
  aim: Aim | undefined,
  deps: SnapshotWindowDeps = {},
): SnapshotWindowAnswer {
  const handle = parseRecordedHandle(window.locator?.uia?.nativeWindowHandle);
  const row = (answer: SnapshotWindowAnswer, because: string): SnapshotWindowAnswer => {
    probeAim("act.modal", { entityId: entity.entityId, check: "snapshot_window", window: window.entityId, handle: handle?.toString() ?? null, answer, because });
    return answer;
  };
  if (handle === undefined) return row("may_block", "no_handle");
  try {
    const isAlive = deps.isAlive ?? windowIsAlive;
    const rootOf = deps.root ?? getWindowRoot;
    // The windows the element was read from. The aim's only while it still names its owner: a
    // recycled handle names someone else's window, and would waive whatever shares its root.
    // The recorded handle is usually the aim's own, so it is dropped with it (gate 2, round 2).
    const recycled =
      aim?.hwnd !== undefined && compareAimIdentity(aim, (deps.identityNow ?? productionWindowIdentity)(aim.hwnd)) === "changed"
        ? aim.hwnd
        : undefined;
    const readFrom = [parseRecordedHandle(entity.locator?.uia?.nativeWindowHandle), parseRecordedHandle(entity.origin?.hwnd), aim?.hwnd]
      .filter((h): h is bigint => h !== undefined && h !== recycled);
    const alive = isAlive(handle);
    if (alive === undefined) return row("may_block", "not_asked");
    if (alive === false) {
      if (readFrom.length > 0 && readFrom.every((h) => isAlive(h) === false)) return row("not_a_dialog", "element_window_gone");
      return row("closed", "not_a_window");
    }
    const root = rootOf(handle);
    if (root === null) return row("may_block", "no_root");
    for (const h of readFrom) {
      if (rootOf(h) === root) return row("not_a_dialog", "same_root");
    }
    return row("may_block", "top_level");
  } catch {
    return row("may_block", "unreadable");
  }
}

/**
 * A window handle recorded as a decimal string; `undefined` for none, a non-number, or zero. Not
 * `keyboard-target`'s `parseHandle`, which masks to 32 bits for the keyboard rung.
 */
function parseRecordedHandle(v: string | undefined): bigint | undefined {
  if (v === undefined || !/^\d+$/.test(v)) return undefined;
  const h = BigInt(v);
  return h === 0n ? undefined : h;
}


/**
 * G1-C: Production focus fingerprint (window-level, best-effort).
 *
 * Returns the foreground window's hwnd as an opaque string.
 * When the foreground shifts between pre- and post-touch snapshots,
 * GuardedTouchLoop emits focus_shifted in the diff.
 * Conservative: returns undefined on any Win32 error.
 */
function productionGetFocusedEntityId(): string | undefined {
  try {
    const wins = enumWindowsInZOrder();
    const fg = wins.find((w) => w.isActive);
    return fg ? `hwnd:${fg.hwnd}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Issue #295 carry-over — foreground HWND resolver for the UIA-cache-stale
 * check in `DesktopFacade.see()`. Returns the active window's HWND as a
 * bigint, or null on enumeration failure / no active window. Reuses the
 * same `enumWindowsInZOrder` source as `productionGetFocusedEntityId` so
 * the two stay consistent across calls.
 */
function productionGetFocusedHwnd(): bigint | null {
  try {
    const wins = enumWindowsInZOrder();
    const fg = wins.find((w) => w.isActive);
    if (!fg) return null;
    return typeof fg.hwnd === "bigint" ? fg.hwnd : BigInt(fg.hwnd);
  } catch {
    return null;
  }
}

/**
 * Production windowsProvider with a short-lived (default 100ms) result cache.
 *
 * Audit P1-1 (docs/v1-release-readiness-review.md §8.2): every desktop_discover
 * call previously re-ran enumWindowsInZOrder + getWindowProcessId +
 * getProcessIdentityByPid for every visible window — on a desktop with 40+
 * windows this is tens of ms per call and shows up in chained workflows
 * (desktop_state → desktop_discover → desktop_act). A coarse TTL cache
 * collapses bursts of see() calls without hiding real focus shifts (the
 * windowsProvider is intentionally re-evaluated whenever the cache TTL
 * expires; OS-level focus changes between snapshots are observed by the
 * separate `getFocusedEntityId` path).
 *
 * Time source: defaults to `performance.now()` (monotonic), so wall-clock
 * adjustments — NTP step-back, manual clock changes, VM snapshot restore —
 * never make a stale entry look fresh. The path also defends with `t >=
 * cached.at` so an injected non-monotonic `nowFn` (or any future regression)
 * still falls through to a re-enumeration on backward time travel rather
 * than serving the previous snapshot. (Codex PR #53 P2.)
 *
 * `nowFn`, `ttlMs`, `enumerate`, and `resolveProcessName` are injectable for
 * unit testing.
 */
export interface WindowsProviderCacheOptions {
  ttlMs?: number;
  nowFn?: () => number;
  /** Override the raw window enumerator. Tests inject a fake; production uses enumWindowsInZOrder. */
  enumerate?: typeof enumWindowsInZOrder;
  /** Override per-hwnd process info. Tests inject a fake; production uses getWindowProcessId + getProcessIdentityByPid. */
  resolveProcessName?: (hwnd: bigint | number) => string | undefined;
  /** Override the frozen-process read (internal #247). Tests inject a fake; production uses isWindowProcessFrozen. */
  isFrozen?: (hwnd: bigint) => boolean | null;
}

function defaultResolveProcessName(hwnd: bigint | number): string | undefined {
  try {
    const pid = getWindowProcessId(hwnd);
    return getProcessIdentityByPid(pid).processName;
  } catch {
    return undefined;
  }
}

export function createCachedProductionWindowsProvider(
  options: WindowsProviderCacheOptions = {},
): () => DesktopWindowMeta[] {
  const ttlMs = options.ttlMs ?? 100;
  const now = options.nowFn ?? (() => performance.now());
  const enumerate = options.enumerate ?? enumWindowsInZOrder;
  const resolveProcessName = options.resolveProcessName ?? defaultResolveProcessName;
  const isFrozen = options.isFrozen ?? isWindowProcessFrozen;
  let cached: { at: number; result: DesktopWindowMeta[] } | undefined;

  return () => {
    const t = now();
    // Defensive: ignore the cached entry if the clock moved backward since it
    // was stored. With the default monotonic clock this branch is unreachable;
    // it exists so an injected non-monotonic `nowFn` (or a future regression)
    // can't keep serving stale windows past the TTL.
    if (cached && t >= cached.at && t - cached.at < ttlMs) return cached.result;
    const result = enumerate().map((w) => {
      const processName = resolveProcessName(w.hwnd);
      return {
        zOrder: w.zOrder,
        title: w.title,
        hwnd: String(w.hwnd),
        region: w.region,
        isActive: w.isActive,
        isMinimized: w.isMinimized,
        isMaximized: w.isMaximized,
        processName,
        // Internal #247: a hidden window is listed like any other. Say so, and whether its process
        // is frozen — then what it shows is its last frame, not its contents now. Only hidden
        // windows are asked (win2 measured every frozen window cloaked); a window on another
        // virtual desktop is hidden and still running.
        ...(w.isCloaked === true && { isCloaked: true as const }),
        ...(w.isCloaked === true && isFrozen(w.hwnd) === true && { isFrozen: true as const }),
      };
    });
    cached = { at: t, result };
    return result;
  };
}

// ── Process-level facade singleton ───────────────────────────────────────────

let _facade: DesktopFacade | undefined;

/** Process-level PoC visual backend. Expose for P3-D pipeline to call updateSnapshot(). */
let _pocBackend: PocVisualBackend | undefined;

/**
 * Phase 4a (ADR-005): OnnxBackend (Rust-internal vision_backend). Attached when:
 *   1. Native vision binding is loaded (`OnnxBackend.isAvailable()`)
 *   2. `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND=1` opt-in is set
 *   3. `DESKTOP_TOUCH_DISABLE_VISUAL_GPU` is unset
 * If any condition fails, falls back to `PocVisualBackend`. This keeps Phase 1-3
 * behaviour intact until the operator explicitly enables Phase 4 path.
 */
let _onnxBackend: OnnxBackend | undefined;

/** Phase 3: dirty-rect router (Desktop Duplication → RoiScheduler → OcrVisualAdapter). */
let _dirtyRouter: DirtyRectRouter | undefined;

/**
 * Whether the dirty-rect router starts with the facade. Off unless the operator sets
 * `DESKTOP_TOUCH_ENABLE_DIRTY_RECTS=1` (internal #235): once started, it captures and OCRs
 * whichever window is in front every few seconds with no tool call, the user's own windows
 * included. `DESKTOP_TOUCH_DISABLE_DIRTY_RECTS=1` still wins over the opt-in.
 */
export function shouldStartDirtyRectRouter(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["DESKTOP_TOUCH_ENABLE_DIRTY_RECTS"] === "1"
    && env["DESKTOP_TOUCH_DISABLE_DIRTY_RECTS"] !== "1";
}

/**
 * @internal Test-only entry point: production feeds the backend via pushDirtySignal.
 * Call backend.updateSnapshot(targetKey, candidates) to deliver stable candidates.
 */
export function getPocVisualBackend(): PocVisualBackend | undefined {
  return _pocBackend;
}

/**
 * @internal Phase 4a — return the OnnxBackend when attached, otherwise undefined.
 * Used by tests that want to verify the Rust-internal vision_backend is wired.
 * Production code should not depend on this; use `getVisualRuntime()` instead.
 */
export function getOnnxBackend(): OnnxBackend | undefined {
  return _onnxBackend;
}

/**
 * P3-B: Attach a visual backend to the global VisualRuntime. Its dirty signals used to mark the
 * ingress's cached read for the target; since internal #218 every discover reads, so they are not
 * listened to here.
 */
async function initVisualRuntime(): Promise<void> {
  // Phase 4a (ADR-005): prefer Rust-internal OnnxBackend when available and
  // explicitly opted in. Falls back to PocVisualBackend otherwise so that
  // Phase 1-3 behaviour is unchanged when the operator has not enabled Phase 4.
  const onnxOptIn = process.env["DESKTOP_TOUCH_ENABLE_ONNX_BACKEND"] === "1";
  const useOnnx = onnxOptIn && OnnxBackend.isAvailable();

  if (useOnnx) {
    const backend = new OnnxBackend();
    _onnxBackend = backend;
    onDirtySignal((targetKey, candidates) => {
      backend.updateSnapshot(targetKey, candidates);
    });
    await getVisualRuntime().attach(backend);
    console.error("[desktop-register] visual lane: OnnxBackend attached (ADR-005 Phase 4a)");
    return;
  }

  // Default: PocVisualBackend (Phase 1-3 behaviour).
  const backend = new PocVisualBackend();
  _pocBackend = backend;
  onDirtySignal((targetKey, candidates) => {
    backend.updateSnapshot(targetKey, candidates);
  });
  await getVisualRuntime().attach(backend);
  if (onnxOptIn) {
    console.error(
      "[desktop-register] visual lane: PocVisualBackend attached " +
      "(ENABLE_ONNX_BACKEND=1 set but native vision addon unavailable — falling back)",
    );
  }
}

/**
 * Return the process-level DesktopFacade.
 * Created lazily on first call; no heavy initialization happens at import time.
 *
 * P2-B: uses composeCandidates() as the provider — routes to browser/terminal/uia
 * based on target type and merges results additively.
 */
export function getDesktopFacade(): DesktopFacade {
  if (!_facade) {
    const provider: CandidateProvider = async (input: DesktopSeeInput) => composeCandidatesOnly(input.target);

    // internal #218: every discover reads; see `SnapshotIngress`.
    const ingress = new SnapshotIngress((key: string) => composeCandidates(targetKeyToSpec(key)));

    _facade = new DesktopFacade(provider, {
      // Sweep stale sessions every 30s. The default sessionTtlMs is 120s
      // (2 min idle), so ~one timer fire after a session goes idle is enough
      // to keep the registry from growing unbounded over a long-running
      // process. The timer is .unref'd inside the facade so it never
      // holds the process open on its own.
      sessionEvictionIntervalMs: 30_000,
      ingress,
      // G1-B: viewport guard — blocks visual-only entities that are no longer
      // reachable at their discovered coordinates (ADR-029 Phase 1).
      checkViewport: productionCheckViewport,
      // internal #126: the OS's answer about the entity's own window, asked before the snapshot.
      findBlockingWindow: productionFindBlockingWindow,
      // internal #211: each `Window` of the snapshot, asked by its own handle — a child window or
      // the element's own top-level window is not a dialog, and a closed one refuses the act.
      judgeSnapshotWindow: productionJudgeSnapshotWindow,
      // G1 (ADR-036 §10): a `stale` target's place is read again before the press.
      rereadStale: productionRereadStale,
      // G1-C: window-level focus fingerprint for focus_shifted diff.
      getFocusedEntityId: productionGetFocusedEntityId,
      // Issue #295 carry-over — foreground HWND for the see() UIA-cache-stale
      // check. Same enumWindowsInZOrder source as getFocusedEntityId above.
      getFocusedHwnd: productionGetFocusedHwnd,
      // G1-A: modal guard — the OS answer above first; the session-aware snapshot default in
      // session-registry.ts (a UIA `Window` in the snapshot) runs unless that answer set it aside.
      // Phase 4 (Codex PR #41 round 5 P1): production windows enumerator —
      // wraps enumWindowsInZOrder + processName resolution. The facade catches
      // any throw and returns [] in that case, so this is allowed to fail.
      // Audit P1-1: 100ms TTL cache prevents the per-window pid+processName
      // round-trip storm when chained tool calls land in the same tick.
      windowsProvider: createCachedProductionWindowsProvider(),
    });

    // Wire the visual runtime (non-blocking — failure does not prevent facade creation).
    // Guarded by DESKTOP_TOUCH_DISABLE_VISUAL_GPU so operators can suppress the
    // entire visual lane (PocVisualBackend never attaches, 50ms warmup never runs).
    //
    // First-request window: `initVisualRuntime` is async. Between `getDesktopFacade()`
    // returning and the attach completing, `runtime.isAvailable()` is false and
    // `fetchVisualCandidates` emits `visual_provider_unavailable`. This is correct
    // behavior (the backend is genuinely not ready yet) and harmless in practice
    // because the first see() call typically arrives after the event loop yields.
    //
    // Before Phase 4 default-on: consider making getDesktopFacade() return
    // Promise<DesktopFacade> and awaiting this to eliminate the window entirely.
    if (process.env["DESKTOP_TOUCH_DISABLE_VISUAL_GPU"] !== "1") {
      initVisualRuntime().catch((err) => {
        console.error("[desktop-register] Failed to initialize visual runtime:", err);
      });

      // Phase 3: start dirty-rect router, opt-in only (see shouldStartDirtyRectRouter).
      // Routes Desktop Duplication events to the foreground window's OcrVisualAdapter
      // for immediate re-polling. A discover's own OCR lane already feeds the same
      // adapter for the window it reads, so the visual lane works without it.
      // Falls back to no-op if native addon is absent (no RDP error, just silence).
      if (shouldStartDirtyRectRouter()) {
        _dirtyRouter = new DirtyRectRouter({
          onRois: (_rois, _nowMs) => {
            // Phase 3: trigger the foreground window's OCR adapter on dirty-rect events.
            // Full per-roi recognition is deferred to Phase 4 (real detector).
            try {
              const wins = enumWindowsInZOrder();
              const fg = wins.find((w) => w.isActive);
              if (!fg) return;
              const target = { hwnd: String(fg.hwnd), windowTitle: fg.title };
              void getOcrVisualAdapter(target).pollOnce(target).catch(() => {});
            } catch { /* best-effort */ }
          },
          onFallback: (reason) => {
            console.error(`[desktop-register] DirtyRectRouter fallback: ${reason}`);
          },
        });
        _dirtyRouter.start();
      }
    }
  }
  return _facade;
}

/**
 * Parse a TargetSessionKey back to a TargetSpec.
 * `window:__default__` returns undefined; composeCandidates() then resolves the
 * current foreground window and routes providers against that live target.
 */
function targetKeyToSpec(key: string): TargetSpec | undefined {
  if (key.startsWith("window:") && key !== "window:__default__") return { hwnd: key.slice(7) };
  if (key.startsWith("tab:"))    return { tabId: key.slice(4) };
  if (key.startsWith("title:"))  return { windowTitle: key.slice(6) };
  return undefined;
}

/**
 * Reset the facade singleton (for testing only).
 * Calls dispose() on the facade and its ingress before clearing.
 */
export function _resetFacadeForTest(): void {
  (_facade as unknown as { dispose?: () => void })?.dispose?.();
  _facade = undefined;
  _pocBackend = undefined;
  void _onnxBackend?.dispose();
  _onnxBackend = undefined;
  _dirtyRouter?.stop();
  _dirtyRouter = undefined;
  // ADR-019 Stage 5 (§6 R2) + ADR-020 SR-4 PR-SR4-2 — release the shared
  // DXGI broker so the DXGI session doesn't leak across test runs.
  disposeSharedDirtyRectBroker();
  _resetOcrAdaptersForTest();
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const targetSchema = z.object({
  windowTitle: z.string().optional(),
  hwnd:        z.string().optional(),
  tabId:       z.string().optional(),
}).optional();

const leaseSchema = z.object({
  entityId:         z.string(),
  viewId:           z.string(),
  targetGeneration: z.string(),
  expiresAtMs:      z.number(),
  evidenceDigest:   z.string(),
});

// internal #216 — the user's decision (2026-10-03): an agent the default client cannot serve may choose
// the classic one, told what it costs (`src/engine/uia-client-scope.ts`).
const uiaClientSchema = z.enum(["default", "classic"]).optional().describe(
  "'classic' reads or acts through the UI Automation client 2.0 used. Use it only when the default client " +
  "cannot read or act on a window. While it acts it moves the keyboard focus: a window behind can come to " +
  "the front and take keys typed meanwhile, and after the window closes the foreground can be left on an " +
  "invisible window, where the mouse and window switching fail until the user clicks. It also waits as long " +
  "as a busy window stays busy; the call still answers within 8 s, but it keeps running, and until it " +
  "finishes further 'classic' calls are refused and acts on that window can move the focus even through the " +
  "default client (the reply's uiaClient.stillRunning says so). The client is released when the call finishes.",
);

// Phase 4 (Codex PR #41 P1): exported so run_macro DSL can register
// desktop_discover / desktop_act in its own TOOL_REGISTRY without duplicating
// the schema literals.
export const desktopSeeSchema = {
  target:      targetSchema.describe("Target window (windowTitle / hwnd) or browser tab (tabId). Omit for foreground window."),
  view:        z.enum(["action", "explore", "debug"]).optional().describe("action (default, ≤20 entities), explore (≤50), debug (includes raw rect)"),
  query:       z.string().optional().describe("Filter entities by label substring (case-insensitive). A Word page also matches by the text visible on it, which is not returned"),
  maxEntities: z.number().int().min(1).max(200).optional().describe("Override entity count limit"),
  debug:       coercedBoolean().optional().describe("Include raw screen coordinates in response (debug only — never relay to end-users)"),
  uiaClient:   uiaClientSchema,
};

export const desktopTouchSchema = {
  lease:  leaseSchema.describe("Lease returned by desktop_discover. Expires after TTL; re-call desktop_discover if desktop_act fails with lease_expired."),
  action: z.enum(["auto", "invoke", "click", "type", "setValue", "select"]).optional().describe(
    "NOTE: action='select' is REFUSED on every target (action_not_offered) — nothing here offers it and no road performs it; click the item instead. " +
    "type/setValue on a button, check box, radio button, hyperlink or menu item (as UI Automation reports it) is refused the same way. " +
    "Action to perform. 'auto' selects the best affordance from the entity. " +
    "'setValue' (Phase 4: absorbs former set_element_value) sets a UIA ValuePattern value or fills a CDP controlled input — pass the new value via text. " +
    "'type' written through UI Automation (response executor 'uia') REPLACES the field's whole value, exactly as 'setValue' does; the field's window is not brought forward (with uiaClient:'classic' it can be); " +
    "when the keyboard road writes it instead (executor 'keyboard'), the text is inserted at the caret."
  ),
  text:   z.string().optional().describe("Text to type or set (required when action='type' or action='setValue')."),
  uiaClient: uiaClientSchema,
  returnCapture: z.enum(["on-change", "always", "never"]).optional().describe(
    "[EXPERIMENTAL] ADR-024 Seed-2 — controls the post-action ROI capture on visual-only targets " +
    "(UIA-blind / RDP / canvas). When it attaches, a successful act carries a 'roiCapture' " +
    "{ roi, somImageRef, entities }: the changed region's PNG crop delivered by-ref (somImageRef is a " +
    "screenshot://by-ref/ resource, also attached as a resource_link; somImage is null by default — open " +
    "the ref only when you need the pixels) plus a lease-less entity " +
    "preview, so you can confirm the result and find the next target without a separate desktop_state / " +
    "screenshot. The entities are previews only (no lease) — re-run desktop_discover to act on them. " +
    "Semantics: 'on-change' (default for visual-only targets) attaches only on a visible change; 'always' " +
    "on any successful visual-only act; 'never' suppresses it. No effect on structured targets " +
    "(browser/CDP, UIA-rich native) — 'roiCapture' is never attached there; use desktop_state."
  ),
};

/**
 * Phase 4 (Codex PR #41 round 3 P1): runtime guard that desktop_act callers
 * must provide `text` for `action='type'` / `action='setValue'`. Without
 * this, the executor falls through to a UIA click — silently triggering an
 * unintended side effect instead of a validation error. Used by both the
 * MCP registration closure below and the run_macro DSL handler in macro.ts.
 *
 * Empty string is *not* missing — `text: ""` is a legitimate clear-field
 * operation that the executor (`text !== undefined` gate in
 * desktop-executor.ts) routes through `uiaSetValue` / `cdpFill` to clear
 * the target. This mirrors the legacy `set_element_value` contract.
 * (Codex PR #41 round 4 P2.)
 *
 * Returns null on success; an error message on failure.
 */
export function validateDesktopTouchTextRequirement(
  action: string | undefined,
  text: string | undefined,
): string | null {
  if ((action === "type" || action === "setValue") && text === undefined) {
    return `desktop_act(action='${action}') requires text — without it the executor falls through to a click on the target entity, which is almost never what you want. Pass text explicitly (use text:'' to clear a field), or use action='click' / 'invoke' for a click-style interaction.`;
  }
  return null;
}

// ── L5 commit / query wrapper integration (ADR-010 P1 S4) ─────────────────────
//
// Sub-plan: `docs/adr-010-p1-s4-plan.md` §2.1 + §2.5 + §3.3.
//
// Same module-scope wrapping pattern as `desktop-state.ts` from S3 (PR
// #112): wrap once here so `server.tool` (this file's
// `registerDesktopTools`) and `run_macro` dispatcher (`./macro.ts`
// `TOOL_REGISTRY`) share the SAME wrapped handler + injected schema.
// Without this, macro 経路 would re-`z.object(rawSchema).parse(args)`
// and silently strip the wrapper-layer `args.include` field, breaking
// per-call envelope opt-in (PR #112 P1-1 同型 risk pattern).

/** desktop_discover (query-axis) raw handler. Calls into the facade
 *  unchanged; the L5 query wrapper takes care of envelope assembly +
 *  compat hoist + per-call `include` opt-in. */
export const desktopDiscoverRawHandler = (input: unknown): Promise<ToolResult> =>
  withClassicNote((input as { uiaClient?: UiaClient } | undefined)?.uiaClient, () => desktopDiscoverRawHandlerInner(input));

/**
 * internal #216 — run a call with the UI Automation client it asked for in scope, and say so on a reply
 * made through the classic one (`uia-client-scope.ts`). The note goes on the reply's JSON, whichever
 * of the handler's returns produced it; a reply that is not JSON is left as it is.
 */
export async function withClassicNote(client: UiaClient | undefined, run: () => Promise<ToolResult>): Promise<ToolResult> {
  if (client !== "classic") return run();
  const { result, used, refusal } = await runClassic(run);
  // Only what the classic client answered is said to come from it, and a call of it that ran past its
  // limit is said to be still running: while it is, the default client's acts on that window move the
  // focus too (gate 2 and codex on `74d5f6bc`).
  const stillRunning = used && (nativeUia?.uiaClassicInUse?.() ?? false);
  const uiaClient = used
    ? { client: "classic", used: true, stillRunning, note: stillRunning ? CLASSIC_NOTE_STILL_RUNNING : CLASSIC_NOTE }
    : { client: "classic", used: false, ...(refusal !== undefined && { why: refusal }), note: CLASSIC_NOTE_NOT_USED };
  const [first, ...rest] = result.content;
  if (first?.type !== "text") return result;
  try {
    const body = JSON.parse(first.text) as Record<string, unknown>;
    return { ...result, content: [{ type: "text" as const, text: JSON.stringify({ ...body, uiaClient }, null, 2) }, ...rest] };
  } catch {
    return result;
  }
}

const desktopDiscoverRawHandlerInner = async (input: unknown): Promise<ToolResult> => {
  const facade = getDesktopFacade();
  const output = await facade.see(input as DesktopSeeInput);
  // internal #211 (D) — watch the window from now to the act, to learn whether it repaints itself.
  if (process.env["DESKTOP_TOUCH_STAGE5_DXGI"] !== "0") await startPreActWatch(facade, output.viewId);
  return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
};

let preActWatch: PreActWatch | undefined;
/** The shared pre-act watch; created on first use, so a server without DXGI never builds one. */
function getPreActWatch(): PreActWatch {
  return (preActWatch ??= new PreActWatch(getSharedDirtyRectBroker));
}

/**
 * Start watching the window a view reads (not for a visual-only view, which verifies by frame-diff).
 * The window is the TARGET, resolved as the frame-diff resolves it, not the foreground: at discover
 * and before an act the foreground can be another window, such as the agent's terminal (gate 2).
 */
async function startPreActWatch(facade: DesktopFacade, viewId: string, opt: { afterAct?: boolean } = {}): Promise<void> {
  try {
    if (facade.resolveVisualOnlyForViewId(viewId)) return;
    const hwnd = await facade.resolveTargetHwndForFrameDiff(viewId);
    if (hwnd === null) return;
    const rect = getWindowRectByHwnd(hwnd);
    if (rect === null || rect.width <= 0 || rect.height <= 0) return;
    // internal #245 — the watch reads the same parts the act's read will (gate 2 on #771).
    getPreActWatch().start(viewId, hwnd, rect, { ...opt, visible: visibleRegionOf(hwnd, rect).visible });
  } catch {
    // Observation only: a watch that cannot start leaves the act's verdict as it was.
  }
}

/** desktop_act (commit-axis) raw handler. Internal logic, Zod schema,
 *  and return shape are unchanged from before S4 (ADR-010 §1.5 spirit:
 *  individual tool implementations stay envelope-agnostic). The L5
 *  commit wrapper layers on lease pre-flight + ToolCall event emission +
 *  envelope assembly.
 *
 *  ADR-019 Stage 5 wiring (sub-plan §2.3.1): resolve the target window's HWND
 *  from the issuing session's `lastTarget`, acquire a DXGI handle BEFORE the
 *  touch, and after a successful one read what it collected (`observeAfterAct`,
 *  internal #211 D), attaching the resulting `VisualMotionObservation` to
 *  `result.observation`. Gated on
 *  `DESKTOP_TOUCH_STAGE5_DXGI !== "0"` (default ON; opt-out by setting
 *  to `"0"`). Failures degrade silently — observation absence is
 *  bit-equal to the pre-Stage-5 envelope. */
export const desktopActRawHandler = (
  input: { lease: EntityLease; action?: TouchAction; text?: string; returnCapture?: ReturnCaptureMode; uiaClient?: UiaClient },
): Promise<ToolResult> => withClassicNote(input?.uiaClient, () => desktopActRawHandlerInner(input));

const desktopActRawHandlerInner = async (
  // ADR-024 Seed-2 S1: `returnCapture` is accepted (and advertised in the schema)
  // so callers can start opting in; population of `result.roiCapture` is wired in
  // S2+ (gate plumbing). In S1 the field is always absent — existing responses are
  // bit-equal.
  input: { lease: EntityLease; action?: TouchAction; text?: string; returnCapture?: ReturnCaptureMode },
): Promise<ToolResult> => {
  const validationError = validateDesktopTouchTextRequirement(input.action, input.text);
  if (validationError) {
    // validationError is already fully-qualified ("desktop_act(action='...') requires
    // text — ..."), so emit it verbatim via failCode (NOT failArgs, which would
    // re-prefix "desktop_act: " and double the tool name — Codex PR #380 P2). Adds
    // the InvalidArgs code + its recovery suggest (OQ-9 c) without touching the message.
    return failCode("InvalidArgs", validationError, { suggest: getSuggestsForCode("InvalidArgs") });
  }
  const facade = getDesktopFacade();

  // ADR-024 Seed-2 S5c-1a — for visual-only targets, derive the post-action
  // motion verdict (and, via buildRoiCapture, the ROI) from a true window
  // frame-diff rather than DXGI dirty rects. A PrintWindow pre/post diff captures
  // only the target window's own pixels (occlusion-immune) and never touches the
  // DXGI dirty-rect broker, so it sidesteps both dogfood defects: F1 (occlusion-
  // blind geometry filter) and F2 (the same-process DirtyRectRouter, opt-in since
  // #235, draining the frame before the act polls). See adr-024-seed2-dogfood-findings. The pre-
  // action frame MUST be captured BEFORE the touch, so resolve the visual-only
  // flag + window geometry up front. Non-visual-only targets keep the DXGI path;
  // since internal #211 D it reads a handle acquired before the touch
  // (`prepareActMotion` / `finishActMotion`) and adds `watchedMs` /
  // `selfRepainting` to `result.observation`.
  const postVerifyEnabled = process.env["DESKTOP_TOUCH_STAGE5_DXGI"] !== "0";
  // ADR-024 Seed-2 S5b — the order-trap fold. When ON (default) a visual-only
  // act folds its post-touch confirmation into a SINGLE ROI-OCR feeding BOTH the
  // diff and the roiCapture (one OCR vs S5's two). `=0` falls back to the S5
  // 2-OCR path (every composeCandidates lane preserved).
  const foldEnabled = process.env["DESKTOP_TOUCH_STAGE5B_FOLD_OCR"] !== "0";
  const visualOnly = facade.resolveVisualOnlyForViewId(input.lease.viewId);
  let preFrame: RawFrame | null = null;
  let frameDiffHwnd: bigint | null = null;
  let frameDiffWindowRect: { x: number; y: number; width: number; height: number } | null = null;
  let frameDiffPoint: { x: number; y: number } | null = null;
  if (postVerifyEnabled && visualOnly) {
    // Resolve the TARGET window (not foreground): the pre-frame is captured
    // before the click, so a not-yet-foreground windowTitle target must still
    // diff the right window (Codex PR #431 P2).
    frameDiffHwnd = await facade.resolveTargetHwndForFrameDiff(input.lease.viewId);
    if (frameDiffHwnd !== null) {
      const wr = getWindowRectByHwnd(frameDiffHwnd);
      if (wr !== null && wr.width > 0 && wr.height > 0) {
        frameDiffWindowRect = wr;
        // Focal point for the frame-diff = the clicked entity's centre, so the
        // diff clips to a padded region around the expected change rather than
        // diluting a small localized repaint across the whole window (→ false
        // `indeterminate`). Resolved before the touch from the discover snapshot.
        //
        // ADR-036 item 5 — `wr` is passed so the centre gets the SAME homing correction the press
        // gets. Without it the region is centred where the entity WAS and the repaint happens
        // where the press went, which for a drag past the padding is a correct press reported as
        // unverified (gate 2, second pass).
        frameDiffPoint = facade.resolveEntityCenterForViewId(
          input.lease.viewId,
          input.lease.entityId,
          wr,
        );
        preFrame = await captureFrame(frameDiffHwnd, wr);
      }
    }
  }

  // ADR-024 Seed-2 S5b — fold gate. Fold only when: enabled; visual-only;
  // pre-frame + window geometry in hand; AND the discover snapshot is OCR-only
  // (D6 — no visual_gpu lane the OCR-only post could silently drop). Otherwise
  // keep the S5 path (legacy 2-OCR) below, which preserves every lane.
  const fold =
    foldEnabled &&
    postVerifyEnabled &&
    visualOnly &&
    preFrame !== null &&
    frameDiffHwnd !== null &&
    frameDiffWindowRect !== null &&
    !facade.discoverHasVisualGpuForViewId(input.lease.viewId);

  // internal #211 (D) — the non-visual verdict reads a handle acquired BEFORE the action: the repaint
  // lands when the executor returns (about 2 s into a UIA act), and a handle taken after it missed it.
  const actMotion = postVerifyEnabled && !visualOnly ? await prepareActMotion(facade, input.lease.viewId) : null;

  const result = await withActMotionHeld(actMotion, () => facade.touch({
    lease: input.lease,
    action: input.action,
    text: input.text,
    // Fold path: the loop invokes this closure (post-execute) in place of
    // env.resolvePostTouchEntities — its single ROI-OCR feeds the diff and the
    // roiCapture. Non-fold: no closure → loop uses the env path (S5, byte-equal).
    ...(fold
      ? {
          postSnapshot: buildFoldPostSnapshot(
            facade,
            input.lease,
            preFrame as RawFrame,
            frameDiffHwnd as bigint,
            frameDiffWindowRect as { x: number; y: number; width: number; height: number },
            frameDiffPoint,
            input.returnCapture,
          ),
        }
      : {}),
  }));

  if (fold) {
    // Fold path — the closure already ran the single ROI-OCR and assembled the
    // roiCapture. Lift its internal `roiMaterial` onto the public fields and
    // strip it before serialization (same split discipline as the Stage 5
    // observation/roiBbox plumbing). No second OCR (buildRoiCapture) here.
    if (result.ok) {
      const rm = (result as { roiMaterial?: RoiCaptureMaterial }).roiMaterial;
      delete (result as { roiMaterial?: RoiCaptureMaterial }).roiMaterial;
      if (rm?.observation) {
        (result as { observation?: VisualMotionObservation }).observation = rm.observation;
      }
      if (rm?.roiCapture) {
        (result as { roiCapture?: RoiCapture }).roiCapture = rm.roiCapture;
      }
      // Internal #166: the fold's diff baseline is discover's own entities carried forward, so an
      // empty entity diff here is not a verified no-change. Say which kinds were not looked for.
      result.diffUnchecked = [...FOLD_DIFF_UNCHECKED];
    }
  } else {
    // ── Legacy S5 path (non-visual / fold-off / visual_gpu present / frame-diff
    // setup missed) — post-verify, then build the roiCapture in a SECOND OCR. ──
    let postVerify: { observation: VisualMotionObservation; dirtyRects: Rect[] } | null = null;
    let frameDiffObservation: VisualMotionObservation | undefined;
    // ADR-024 Seed-2 S5c-1b — the window-relative changed-region bbox from the
    // frame-diff, split off the observation here so it never reaches the public
    // `result.observation` telemetry (R2-P1) and is instead threaded into
    // buildRoiCapture as the localized ROI.
    let frameDiffRoi: Rect | undefined;
    if (result.ok && postVerifyEnabled) {
      if (visualOnly) {
        // Visual-only — frame-diff ONLY. Never fall back to the DXGI verifier:
        // DXGI is exactly the occlusion-blind / drain-race path this phase replaces,
        // so a visual-only frame-diff *miss* (capture/hwnd/rect unavailable) must
        // degrade to no observation — NOT reintroduce F1/F2 via DXGI (Codex PR #431
        // round 2 P2). With no observation the gate sees `motion=undefined` and
        // declines (except `returnCapture:"always"`, whose full-window fallback in
        // buildRoiCapture still applies — a best-effort capture, never DXGI motion).
        if (preFrame !== null && frameDiffHwnd !== null && frameDiffWindowRect !== null) {
          // Stage 4 orchestrator: caller pre-frame + capturePostFrameUntilStable
          // settle + native SIMD computeChangeFraction/SSIM. Its background-animation
          // guard degrades to `indeterminate`, which the gate excludes (so a noisy
          // desktop yields no spurious roiCapture = F1). `observation.source` becomes
          // `ssim_residual` (frame-diff family) on this path only.
          // S5c-1b — opt into the ROI bbox surface so the SAME frame-diff that
          // produces `motion` also yields the localized changed-region rect.
          const frameDiffObs = await verifyLocalRepaint({
            hwnd: frameDiffHwnd,
            hint: {
              windowRect: frameDiffWindowRect,
              ...(frameDiffPoint !== null && { point: frameDiffPoint }),
            },
            preFrame,
            includeRoiBbox: true,
          });
          // Split `roiBbox` off BEFORE assigning `result.observation` (P2-2):
          // `roiBbox` is an internal ROI-source channel, not public Stage 5
          // telemetry — the same split pattern as `tryVerifyAnyChange`'s
          // `dirtyRects`. The destructured `observation` has no `roiBbox` key, so
          // the serialized envelope stays byte-equal with the pre-S5c-1b shape.
          const { roiBbox, ...observation } = frameDiffObs;
          frameDiffObservation = observation;
          frameDiffRoi = roiBbox;
          (result as { observation?: VisualMotionObservation }).observation = observation;
        }
        // else: frame-diff setup missed → degrade silently (no observation, no DXGI).
      } else {
        // Non-visual-only — existing DXGI Stage 5 path (byte-equal). `dirtyRects` is
        // an internal ROI-source channel for buildRoiCapture (S3a), kept off the
        // public `result.observation` telemetry by the split in tryVerifyAnyChange.
        postVerify = actMotion !== null ? await finishActMotion(actMotion) : null;
        if (postVerify !== null) {
          (result as { observation?: VisualMotionObservation }).observation = postVerify.observation;
        }
      }
    }

    // ADR-024 Seed-2 S5 — fold the post-action ROI capture into the act response
    // for visual-only targets. `buildRoiCapture` gates on the visual-only regime +
    // motion verdict, then assembles `{roi, somImageRef, entities, source}`
    // (ADR-026: crop pixels by-ref, somImage null by default). Absent
    // (gate declines / no change / no ROI) → response stays bit-equal with the
    // pre-Seed-2 shape (additive — existing destructures unaffected).
    if (result.ok) {
      const roiCapture = await buildRoiCapture(
        facade,
        input.lease.viewId,
        frameDiffObservation ?? postVerify?.observation,
        postVerify?.dirtyRects ?? [],
        input.returnCapture,
        // Source is regime-determined: buildRoiCapture's gate only passes for
        // visual-only targets (the frame-diff regime), so a visual-only capture
        // is always `frame_diff` — including the `returnCapture:"always"` full-
        // window fallback when the frame-diff observation was a miss.
        visualOnly ? "frame_diff" : "dxgi",
        // S5c-1b — the localized changed-region ROI from the frame-diff (when the
        // capture was occlusion-immune). `undefined` → buildRoiCapture falls back
        // to the DXGI dirty-rect bbox (legacy path) or the full window.
        frameDiffRoi,
      );
      if (roiCapture !== undefined) {
        (result as { roiCapture?: RoiCapture }).roiCapture = roiCapture;
      }
    }
  }

  // internal #211 (D) — the handle is given back whatever the act did, and the window is watched again
  // for the next act, which may follow without a discover.
  if (actMotion !== null) {
    actMotion.dispose();
    await startPreActWatch(facade, input.lease.viewId, { afterAct: true });
  }

  // Issue #327 item G: GuardedTouchLoop.touch returns {ok:false,
  // reason:"executor_failed", diff:[]} on executor exception. Because the handler
  // RETURNS this (does not throw), the L5 makeCommitWrapper treats it as a normal
  // result and would ship no if_unexpected recovery hint. We build the hint here.
  //
  // ADR-021 P1-3: build it through the central toFailureEnvelope converter (north
  // star 1: one failure path) instead of the old hand-spread + local
  // buildExecutorFailedIfUnexpected helper. This handler always returns the RAW
  // shape (the L5 wrapper above applies envelope/optIn), so optIn:false →
  // compatFailureRaw → {ok:false, reason:"executor_failed", diff:[], if_unexpected}.
  // Bit-equal to the pre-migration shape (reason via pascalToSnake("ExecutorFailed"),
  // diff:[] from compatFailureRaw, try_next via SUGGESTS) — pinned by
  // to-failure-envelope-shape-snapshot.test.ts site 7.
  //
  // Scope note: the envelope-mode data->envelope asymmetry (in include=["envelope"]
  // mode the hint surfaces at envelope.data.if_unexpected, not envelope.if_unexpected)
  // is NOT addressed here — normalising it requires the wrapper to treat a
  // handler-returned ok:false as a failure, which is the Phase 5 TOOL_REGISTRY
  // Result-returning change (ADR-021 §2.2 deferred).
  if (!result.ok && result.reason === "executor_failed") {
    // internal #242 — the advice for THIS act: its action, and whether any route ran. The reason's
    // own list told a type that no route could carry that routes had been tried, and offered clicks.
    const failure = toFailureEnvelope(
      Err(new ExecutorFailedError("desktop_act executor failed")),
      {
        optIn: false,
        detail: result.detail,
        tryNext: executorFailedAdviceFor(input.action, result.noRouteTried === true).map((action) => ({ action })),
      },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // ADR-029 Phase 1: same shape for the unreachable-coordinate refusal. It gets
  // its own envelope so `try_next` carries the coordinate-specific recovery
  // (move the window to the primary monitor / use a route that does not move the
  // cursor) instead of executor_failed's "fall back to mouse_click", which would
  // send the caller back into the guard. `reason` is derived from the error name
  // by the same pascalToSnake path, so it matches the TouchFailReason value.
  if (!result.ok && result.reason === "coordinate_outside_reachable_bounds") {
    const failure = toFailureEnvelope(
      Err(new CoordinateOutsideReachableBoundsError(
        "CoordinateOutsideReachableBounds: the entity sits outside the area mouse input can currently reach"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // ADR-029 Phase 2a: the cursor could not be placed at all. Separate envelope
  // for the same reason as above — its recovery (free the cursor, reconnect the
  // session) shares nothing with the unreachable-coordinate advice, and
  // re-discovering would return the same correct point and fail identically.
  if (!result.ok && result.reason === "cursor_placement_blocked") {
    const failure = toFailureEnvelope(
      Err(new CursorPlacementBlockedError(
        "CursorPlacementBlocked: the pointer could not be placed on the entity — nothing was clicked"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // ADR-036: the window this act was aimed at is gone. Its own envelope for the same reason as
  // the two above, and the sharpest case of it: `executor_failed`'s advice is "fall back to
  // mouse_click", and the only coordinates the caller has are the entity's rect — where the
  // window WAS. Measured on Windows 2026-09-09: an excluded window and a closed one came back
  // identical here, down to all four `try_next` items, both pointing at the rect.
  if (!result.ok && result.reason === "aim_window_gone") {
    const failure = toFailureEnvelope(
      Err(new AimWindowGoneError(
        "AimWindowGone: the window this action was aimed at no longer exists — nothing was clicked. " +
        "Re-call desktop_discover to see what is there now; do not click the entity's rect, which is where that window used to be"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // ADR-036 item 2 — the handle now names a different WINDOW. Its own envelope because the
  // recovery is unlike the neighbours': there is something at that handle, and acting on it would
  // have worked, on a stranger. Not always another process: one program can destroy a top-level
  // window and get the same number back for the next one, which is why the class is compared too.
  if (!result.ok && result.reason === "aim_identity_changed") {
    const failure = toFailureEnvelope(
      Err(new AimIdentityChangedError(
        "AimIdentityChanged: the window this act was aimed at has gone and its handle now names a different window — nothing was done. " +
        "Re-run desktop_discover; the lease and every entity taken from it describe a window that is gone"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // PR 側 codex 2026-09-09 — the three refusals below were reaching the caller as
  // `executor_failed`, and its first `try_next` line names a coordinate click at the entity's
  // rect. All three exist to refuse exactly that press, so the envelope was undoing the executor.
  // Each gets its own entry for the same reason the three above have one.
  //
  // ADR-036 item 6 — the coordinates are right and something is drawn over them. Its own envelope
  // because re-discovering, which every neighbour's advice opens with, changes nothing here.
  if (!result.ok && result.reason === "aim_occluded") {
    const failure = toFailureEnvelope(
      Err(new AimOccludedError(
        "AimOccluded: another window drawn over the point this act would have pressed would take the press — nothing was done. Windows' own hit test decides this where the native addon can ask it; otherwise the window list does, and any window on top counts unless it has both WS_EX_TRANSPARENT and WS_EX_LAYERED. " +
        "Bring the intended window forward, or use click_element, which does not press a coordinate"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // The aim went stale in a way the homing correction cannot repair: the window is alive, but it
  // was minimised, or it RESIZED — and a resize may have reflowed the contents, so translating the
  // point through it would be inventing a layout — or it moved while it was being read, or these
  // coordinates came from a lane the bracketed origin cannot describe. A window that moved without
  // resizing reaches here too, whenever the correction declined for one of the last two reasons:
  // the point then stays where it was and leaves the window. Re-discovering is the fix, not a
  // consolation.
  if (!result.ok && result.reason === "aim_point_outside_window") {
    const failure = toFailureEnvelope(
      Err(new AimPointOutsideWindowError(
        "AimPointOutsideWindow: the point this act would have pressed can no longer be followed to the window it named — nothing was clicked. " +
        "Re-run desktop_discover; among the reasons, the window was minimised, was resized so its contents may have moved independently of its origin, was moving while it was being read, the coordinates came from a lane whose measurement moment cannot be established — a stored visual snapshot may have been captured while the window was somewhere else — or they were captured in a window OTHER than the one this act named — a menu, dialog or dropdown has an origin of its own and does not move with the window that owns it, so it is followed only while it is still what sits under the point"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // ADR-036 item 16 — the entity is not there: missing from the live view, or answered "not found"
  // by UIA on the title-only road, where the press at its remembered point is now refused. Both went
  // out as the raw result, with no advice at all.
  if (!result.ok && result.reason === "entity_not_found") {
    const failure = toFailureEnvelope(
      Err(new EntityNotFoundRefusalError(
        "EntityNotFound: the element this act was for could not be found — nothing was clicked or typed. " +
        "Re-run desktop_discover and act on the fresh entity"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // The aim is current and every route to it failed. The ladder stops rather than finishing the
  // aimed act as a blind coordinate press — which is ADR-036's subject arriving as its own cure.
  // Click and write end here alike.
  if (!result.ok && result.reason === "aim_route_failed") {
    const failure = toFailureEnvelope(
      Err(new AimRouteFailedError(
        "AimRouteFailed: the route to the window this act named failed, and the act was not finished as a coordinate press — nothing was clicked or typed. " +
        "Re-run desktop_discover, or try click_element on the same entity"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // The same security boundary, met at a coordinate. Its own reason and its own advice: the lines
  // below `window_excluded` would tell this caller their own window is excluded and to go act on a
  // different one, and their window is fine.
  if (!result.ok && result.reason === "aim_blocked_by_excluded_window") {
    const failure = toFailureEnvelope(
      Err(new AimBlockedByExcludedRefusalError(
        "AimBlockedByExcludedWindow: a window this server may not act through is over the point this act would have pressed — nothing was clicked. " +
        "The window you named is not the excluded one. Act through click_element, or retry once the point is clear"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // ADR-036 family 2 — the keyboard rung would have posted to something other than the field this
  // act named, and its rule could say so. Its own reason: `executor_failed` would advise a foreground
  // type, which puts the characters exactly where this refused to.
  if (!result.ok && result.reason === "keyboard_target_unsafe") {
    const failure = toFailureEnvelope(
      Err(new KeyboardTargetUnsafeRefusalError(
        "KeyboardTargetUnsafe: the characters would not have reached the field this act named — nothing was typed. " +
        "if_unexpected.detail names the ground"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // internal #227 — Windows Terminal takes input only through the foreground, and that was not
  // allowed. Its own reason: `executor_failed` would advise typing through the foreground, which
  // works around the user's no.
  if (!result.ok && result.reason === "foreground_not_allowed") {
    const failure = toFailureEnvelope(
      Err(new ForegroundNotAllowedRefusalError(
        // Not "nothing was typed": a paste that failed after Ctrl+V may have typed (PR codex on #764).
        "ForegroundNotAllowed: Windows Terminal takes input only through the foreground, and the paste did not go through. " +
        "if_unexpected.detail says why, and whether anything was typed — read the terminal before any retry"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // internal #154 — **nothing was done, and that is the part a caller must be able to read.** An
  // envelope is built here rather than letting the raw `{ok:false, reason}` through, because the
  // road this refusal replaces answered `ok:true`: a caller who never sees advice has no way to
  // learn that `select` was never going to do what they meant. (#121 §2 lists the three reasons
  // that still reach a caller with no `if_unexpected`; this one does not join them.)
  if (!result.ok && result.reason === "action_not_offered") {
    const failure = toFailureEnvelope(
      Err(new ActionNotOfferedError(
        "ActionNotOffered: the target does not offer this action, and nothing was done. " +
        "Ask for the action you mean — desktop_act(action='click') or action='invoke' presses it"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // internal #182 — the value road wrote and nothing changed. Its own envelope, because
  // `executor_failed`'s advice is a foreground type into the same control.
  if (!result.ok && result.reason === "value_not_applied") {
    const failure = toFailureEnvelope(
      Err(new ValueNotAppliedRefusalError(
        "ValueNotApplied: the write was accepted, but what it should have changed read back unchanged (a control's value through the native UI Automation client, or Word's page text). " +
        "if_unexpected.detail names the control and what was read"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // A security refusal, not a failed route. `tool-exclusion.ts` has claimed since it was written
  // that this error is wired into `_errors.ts`; it was not, so the one refusal that must never
  // suggest a coordinate press was the loudest about it.
  if (!result.ok && result.reason === "window_excluded") {
    const failure = toFailureEnvelope(
      Err(new WindowExcludedRefusalError(
        "WindowExcluded: this window is excluded from every tool surface of this server — nothing was clicked, and no route here can click it. " +
        "Act on another window"
      )),
      { optIn: false, detail: result.detail },
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(failure, null, 2) }],
    };
  }

  // ADR-026 §3.6: when the act carried a roiCapture crop, attach its by-ref link
  // as a resource_link content block alongside the JSON result. The crop pixels
  // are NOT inlined in the envelope (roiCapture.somImage is null); the agent
  // opens the ref only when it needs to see the crop. The L5 commit wrapper
  // preserves content[1+] (`...result.content.slice(1)`), so the link survives.
  const content: ToolResult["content"] = [
    { type: "text" as const, text: JSON.stringify(result, null, 2) },
  ];
  const roiRef = (result as { roiCapture?: RoiCapture }).roiCapture?.somImageRef;
  if (roiRef) {
    content.push({
      type: "resource_link" as const,
      uri: roiRef,
      name: `roi-${roiRef.slice(REF_URI_PREFIX.length)}`,
      mimeType: "image/png",
      description:
        "ROI crop of the region that changed after this action. Open only if you " +
        "need to inspect the pixels — roiCapture.roi / entities above already " +
        "describe the change.",
    });
  }
  return { content };
};

/**
 * internal #211 (D) — the post-action motion verdict's setup, taken BEFORE the action: the window the
 * view targets (`resolveTargetHwndForFrameDiff`: its pinned handle, else its title resolved, else the
 * foreground — before the action the foreground can be another window), what the pre-act watch saw
 * of it, and a DXGI handle whose
 * queue fills from now — so the repaint that lands when the executor returns is in it. `null` when no
 * window resolves (no observation, as before).
 */
interface ActMotion {
  hwnd: bigint;
  quiet: QuietRecord | undefined;
  sub: BrokerSubscription | null;
  cacheState: CacheAcquireState | undefined;
  dispose(): void;
}

/** Run the action; give the handle back if it throws (the normal path gives it back after the verdict). */
async function withActMotionHeld<T>(m: ActMotion | null, act: () => Promise<T>): Promise<T> {
  try {
    return await act();
  } catch (err) {
    m?.dispose();
    throw err;
  }
}

async function prepareActMotion(facade: DesktopFacade, viewId: string): Promise<ActMotion | null> {
  try {
    const hwnd = await facade.resolveTargetHwndForFrameDiff(viewId);
    if (hwnd === null) return null;
    const rect = getWindowRectByHwnd(hwnd);
    const quiet = getPreActWatch().take(viewId, rect !== null ? { hwnd, rect } : undefined);
    const broker = getSharedDirtyRectBroker();
    const where = rect !== null && rect.width > 0 && rect.height > 0 ? resolveOutputIndexForHwnd(hwnd, rect) : null;
    if (broker === null || where === null || !where.ok) {
      return { hwnd, quiet, sub: null, cacheState: undefined, dispose: () => undefined };
    }
    const acquired = broker.acquire(where.outputIndex);
    const sub = acquired.sub;
    if (sub !== null) await firstBatchReadOrTimeout(broker, where.outputIndex);
    return { hwnd, quiet, sub, cacheState: acquired.state, dispose: () => sub?.dispose() };
  } catch {
    return null;
  }
}

/**
 * internal #235, arm 10 — wait until the duplication has read its initial image, so the act's repaint
 * lands in a batch of its own instead of being dropped with that image. Bounded: an image that never
 * comes costs `ACT_MOTION.firstBatchWaitMs`, not the act.
 */
async function firstBatchReadOrTimeout(broker: DirtyRectBroker, outputIndex: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ACT_MOTION.firstBatchWaitMs);
  });
  try {
    await Promise.race([broker.firstBatchRead(outputIndex), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** WS_EX_LAYERED: a window whose pixels can be see-through; not taken for a cover. */
const WS_EX_LAYERED = 0x0008_0000;

/**
 * internal #245 — the visible frames of the windows above `hwnd` in z-order that are drawn (not
 * minimised, not cloaked) and not layered. A layered window's opacity is unknown — a full-screen one
 * that is mostly transparent sits at the top of win2's desktop (Dell's EAWorkWindow,
 * `point-owner.ts`) and would cover every window (gate 2 on #771) — so it is left out, as before
 * #245. Not seen as covers: windows `enumWindowsInZOrder` does not list (untitled ones such as menus
 * and tooltips, ones under 50 px, the key locker's). Unknown order (the window is not listed) → none.
 */
function coversAbove(hwnd: bigint): { x: number; y: number; width: number; height: number }[] {
  try {
    const wins = enumWindowsInZOrder();
    const self = wins.find((w) => w.hwnd === hwnd);
    if (!self) return [];
    return wins
      .filter((w) => w.zOrder < self.zOrder && !w.isMinimized && !w.isCloaked && ((w.exStyle ?? 0) & WS_EX_LAYERED) === 0)
      .map((w) => getVisibleFrameRectByHwnd(w.hwnd) ?? w.region)
      .filter((r) => r.width > 0 && r.height > 0);
  } catch {
    return [];
  }
}

/**
 * internal #245 — the window's visible frame (its rect includes the invisible resize border, where a
 * window behind shows through), and the parts of it on screen: inside the monitor the watch reads
 * (DXGI reports one output; a part past it never reports — gate 2 on #771), less the windows above.
 */
export function visibleRegionOf(
  hwnd: bigint,
  rect: { x: number; y: number; width: number; height: number },
): { frame: { x: number; y: number; width: number; height: number }; visible: { x: number; y: number; width: number; height: number }[] } {
  const frame = getVisibleFrameRectByHwnd(hwnd) ?? rect;
  let onOutput = frame;
  try {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    const mon = enumMonitors().find((m) => cx >= m.bounds.x && cx < m.bounds.x + m.bounds.width && cy >= m.bounds.y && cy < m.bounds.y + m.bounds.height);
    if (mon) {
      const x = Math.max(frame.x, mon.bounds.x);
      const y = Math.max(frame.y, mon.bounds.y);
      const w = Math.min(frame.x + frame.width, mon.bounds.x + mon.bounds.width) - x;
      const h = Math.min(frame.y + frame.height, mon.bounds.y + mon.bounds.height) - y;
      onOutput = { x, y, width: Math.max(0, w), height: Math.max(0, h) };
    } else {
      // On no monitor (the act minimised it, or moved it off-screen): nothing of it was on screen
      // (codex on 367eb814).
      onOutput = { x: frame.x, y: frame.y, width: 0, height: 0 };
    }
  } catch {
    // Monitors unreadable: the frame as it is.
  }
  const visible = onOutput.width > 0 && onOutput.height > 0 ? visibleParts(onOutput, coversAbove(hwnd)) : [];
  return { frame, visible };
}

/**
 * internal #211 (D) — the verdict, from the handle `prepareActMotion` took. `dirtyRects` is an internal
 * ROI-source channel for buildRoiCapture, split off so it never reaches `result.observation`.
 */
async function finishActMotion(m: ActMotion): Promise<{ observation: VisualMotionObservation; dirtyRects: Rect[] } | null> {
  try {
    const rect = getWindowRectByHwnd(m.hwnd);
    if (rect === null || rect.width <= 0 || rect.height <= 0) return null;
    if (m.sub === null) {
      return {
        observation: {
          motion: "indeterminate",
          source: "dxgi_dirty_rect_unavailable",
          framesSampled: 0,
          totalElapsedMs: 0,
          ...(m.cacheState !== undefined && { cacheState: m.cacheState }),
        },
        dirtyRects: [],
      };
    }
    // internal #245 — read only what was on screen (`visibleRegionOf`).
    const { frame, visible } = visibleRegionOf(m.hwnd, rect);
    return await observeAfterAct(m.sub, frame, m.quiet, {
      ...(m.cacheState !== undefined && { cacheState: m.cacheState }),
      visible,
    });
  } catch {
    return null;
  }
}

/**
 * ADR-024 Seed-2 S5 — gate + fold for the post-action `roiCapture`.
 *
 * Returns the capture to attach to a successful `desktop_act`, or `undefined`
 * when the gate declines (non-visual-only target / no change / opt-out) or no
 * ROI is available.
 *
 * Fold (S5, walking-skeleton Option A — additive; the order-trap compute
 * optimization that avoids the post-touch full-window OCR is deferred to S5b):
 *   1. gate on visual-only regime + motion verdict (`shouldReturnRoiCapture`);
 *   2. turn the S3a per-output dirty rects into window-relative rects
 *      (S3b `filterDirtyRectsToWindow`) and reduce them to one ROI (bounding box);
 *   3. OCR only that ROI (S4 `runSomPipeline(..., roi)`) → `somImage` crop +
 *      `SomElement[]`;
 *   4. map the elements to lease-less `RoiPreviewEntity[]` (OQ-8 (b) MVP),
 *      deduped against the most recent discover snapshot (OQ-10) so the preview
 *      highlights only what changed.
 *
 * Degrades to `undefined` on every miss (no hwnd / no window rect / ROI misses
 * the window / OCR threw or rendered no image) so the act envelope is unaffected.
 */
async function buildRoiCapture(
  facade: DesktopFacade,
  viewId: string,
  observation: VisualMotionObservation | undefined,
  dirtyRects: Rect[],
  returnCapture: ReturnCaptureMode | undefined,
  // S5c-1a — ROI provenance label for the assembled capture. `frame_diff` on the
  // visual-only PrintWindow path; `dxgi` on the legacy dirty-rect path.
  source: RoiCapture["source"],
  // S5c-1b — the localized changed-region ROI from the frame-diff (window-
  // relative), present only when the visual-only capture was occlusion-immune.
  // When present it takes precedence over the DXGI dirty-rect bbox and the
  // full-window fallback (P1-2). `undefined` → legacy dirty-rect / full-window.
  frameDiffRoi?: Rect,
): Promise<RoiCapture | undefined> {
  const gatePassed = shouldReturnRoiCapture({
    ok: true, // only called on the success path
    visualOnly: facade.resolveVisualOnlyForViewId(viewId),
    motion: observation?.motion,
    returnCapture,
  });
  if (!gatePassed) return undefined;

  // buildRoiCapture only runs for visual-only targets (the gate above), so the
  // SoM crop must come from the SAME window the frame-diff motion used — resolve
  // the target window by title, not foreground, for consistency with
  // verifyLocalRepaint (Codex PR #431 round 2 P2, same axis as the motion path).
  const hwnd = await facade.resolveTargetHwndForFrameDiff(viewId);
  if (hwnd === null) return undefined;
  const windowRect = getWindowRectByHwnd(hwnd);
  if (windowRect === null || windowRect.width <= 0 || windowRect.height <= 0) {
    return undefined;
  }

  // ROI resolution priority (S5c-1b P1-2):
  //   1. `frameDiffRoi` — the localized changed-region bbox from an occlusion-
  //      immune frame-diff (visual-only PrintWindow path). Already window-
  //      relative; clamped to the window rect below to stay in bounds.
  //   2. DXGI dirty-rect bbox — `filterDirtyRectsToWindow` → bounding box
  //      (legacy dxgi-source path; `dirtyRects` is empty on the frame-diff
  //      path, so this only fires for the dxgi regime).
  //   3. Full window — the gate already passed, so we owe a capture even when
  //      no localized region is available: `returnCapture: "always"` on a
  //      no-change act, or a frame-diff that was not occlusion-immune
  //      (BitBlt-fallback demotion, P1-1), or a no-change/indeterminate motion.
  const windowRel = filterDirtyRectsToWindow(dirtyRects, windowRect);
  const fullWindow = { x: 0, y: 0, width: windowRect.width, height: windowRect.height };
  const roi =
    (frameDiffRoi !== undefined ? clampRectToWindow(frameDiffRoi, windowRect) : undefined) ??
    boundingBox(windowRel) ??
    fullWindow;

  try {
    // S4 — OCR only the ROI crop. hwnd is provided so the empty windowTitle is
    // unused; no UIA dictionary (visual-only target has no UIA candidates).
    const som = await runSomPipeline("", hwnd, "ja", 2, "auto", false, [], roi);
    return assembleRoiCaptureFromSom(som, roi, source, facade, viewId);
  } catch (err) {
    // OCR is best-effort; never break the act envelope on a pipeline failure.
    console.error(
      `[desktop_act] ROI capture OCR failed for viewId=${viewId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * ADR-024 Seed-2 S5b — OCR-free assembly of a {@link RoiCapture} from an
 * already-computed SoM pipeline result. Extracted from {@link buildRoiCapture}
 * so the S5b fold can reuse the SAME assembly on the single ROI-OCR it already
 * ran (instead of a second `runSomPipeline`), keeping the `roiCapture` output
 * byte-equal between the legacy 2-OCR path and the folded 1-OCR path (S5b
 * acceptance ③). Gate-less: the caller is responsible for the visual-only gate.
 */
function assembleRoiCaptureFromSom(
  som: Awaited<ReturnType<typeof runSomPipeline>>,
  roi: Rect,
  source: RoiCapture["source"],
  facade: DesktopFacade,
  viewId: string,
): RoiCapture | undefined {
  if (som.somImage === null) return undefined; // SoM render unavailable

  // OQ-10 — map ROI-OCR elements to the lease-less preview, deduped against
  // the discover snapshot by geometry AND label (so an in-place text change is
  // preserved). Pure logic in `_roi-preview.ts` (`buildRoiPreviewEntities`).
  const entities = buildRoiPreviewEntities(
    som.elements,
    facade.getDiscoverEntitiesForViewId(viewId),
  );

  // ADR-026 §3.6: persist the ROI crop + deliver it by-ref. `somImage` stays null
  // (pixels deferred to the `resource_link` the act handler attaches from
  // `somImageRef`) so the act envelope stays cheap. R6: on a disk-cache write
  // failure keep `somImage:null` with a warning — never inline base64 (that
  // resurrects the token cost) and never throw (the act already succeeded).
  const base64 = som.somImage.base64;
  const dims = pngDimensions(base64) ?? { width: roi.width, height: roi.height };
  try {
    const persisted = persistCapture(
      Buffer.from(base64, "base64"),
      { mimeType: "image/png", width: dims.width, height: dims.height, tag: `roi-${viewId}` },
    );
    return { roi, somImage: null, somImageRef: persisted.uri, entities, source };
  } catch {
    return {
      roi,
      somImage: null,
      somImageWarning: "ROI crop disk-cache write failed; crop pixels unavailable this turn.",
      entities,
      source,
    };
  }
}

/**
 * Internal #166 — every {@link SemanticDiff} kind the fold cannot detect. Its post snapshot is
 * discover's entities rebuilt with the same ids, so a real change of these kinds leaves pre and post
 * equal (an entity it cannot carry — no rect, or no target id — reads as gone, which is not a look); measured on hardware (win2 arm H3, 2026-09-23), a press that removed
 * the label it pressed answered `["focus_shifted"]` on the fold and
 * `["entity_disappeared","focus_shifted"]` on S5. Focus is read outside the snapshot, so
 * `focus_shifted` is the one kind the fold still reports.
 */
const FOLD_DIFF_UNCHECKED: readonly SemanticDiff[number][] = [
  "entity_disappeared",
  "entity_moved",
  "entity_appeared",
  "value_changed",
  "modal_appeared",
  "modal_dismissed",
];

/**
 * ADR-024 Seed-2 S5b — build the visual-only fold's post-snapshot closure.
 * Captured BEFORE the touch (holds the pre-frame + target identity); invoked by
 * `GuardedTouchLoop.touch()` AFTER execute.
 *
 * **Diff baseline = carry-forward (b).** The post snapshot rebuilds the discover
 * full-window entities as candidates with the SAME `target.id`, so they resolve
 * to the SAME entityIds → post == pre → the touched entity keeps its identity and
 * never reads as a false `entity_disappeared`. This is deliberate: ROI-crop OCR
 * is NOT a reliable substitute for full-window OCR — a crop ≈ the text-line
 * height defeats Windows OCR's line segmentation (Opus S5b-2 root-cause), so the
 * diff must not depend on re-OCRing the ROI. The visual change is surfaced via
 * `roiCapture`, not the structural diff.
 *
 * **roiCapture = padded single OCR (a).** The fold's ONE OCR runs on the PADDED
 * change region (`resolveFoldOcrRoi` gives WinRT OCR the line context a tight
 * crop lacks), and only when the gate passes (`returnCapture:"always"` keeps a
 * full-window capture on no_change/miss — Codex P2-1; other modes omit it).
 * `observation` is always surfaced for telemetry.
 */
function buildFoldPostSnapshot(
  facade: DesktopFacade,
  lease: { viewId: string; entityId: string },
  preFrame: RawFrame,
  hwnd: bigint,
  windowRect: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number } | null,
  returnCapture: ReturnCaptureMode | undefined,
): () => Promise<{ candidates: UiEntityCandidate[]; roiMaterial?: RoiCaptureMaterial }> {
  const viewId = lease.viewId;
  // The SAME target.id the discover OCR lane used → carry-forward entityId parity (R1).
  const targetId = facade.resolveOcrTargetIdForViewId(viewId);

  return async () => {
    // verifyLocalRepaint never throws — it degrades to `indeterminate` (no
    // roiBbox) on any capture/SSIM failure; the gate then declines roiCapture.
    const obs = await verifyLocalRepaint({
      hwnd,
      hint: { windowRect, ...(point !== null && { point }) },
      preFrame,
      includeRoiBbox: true,
    });
    const { roiBbox, ...observation } = obs;

    // Diff baseline (b): carry forward the discover entities, rebuilt as
    // candidates (same target+label+rect → same entityId on resolve → post==pre).
    const discover = facade.getDiscoverEntitiesForViewId(viewId);
    const candidates =
      targetId !== null
        ? somElementsToCandidates(
            discover.map((e) => ({ text: e.label, region: e.rect })),
            { kind: "window", id: targetId },
            Date.now(),
            // ADR-029: the fold already knows the window it verified against, so
            // the carried-forward entities keep the same origin handle the
            // discover lane recorded (outside candidateKey → parity unaffected).
            String(hwnd),
          )
        : [];

    // roiCapture (a): the fold's SINGLE OCR, on the PADDED change region, only
    // when the gate passes. The diff above never depends on this OCR.
    let roiCapture: RoiCapture | undefined;
    const gatePassed = shouldReturnRoiCapture({
      ok: true,
      visualOnly: true, // fold only runs for visual-only targets (handler gate)
      motion: observation.motion,
      returnCapture,
    });
    if (gatePassed) {
      const ocrRoi = resolveFoldOcrRoi(roiBbox, windowRect);
      try {
        const som = await runSomPipeline("", hwnd, "ja", 2, "auto", false, [], ocrRoi);
        roiCapture = assembleRoiCaptureFromSom(som, ocrRoi, "frame_diff", facade, viewId);
      } catch (err) {
        // roiCapture OCR is best-effort; never break the act on a pipeline failure.
        console.error(
          `[desktop_act] S5b fold roiCapture OCR failed for viewId=${viewId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      candidates,
      roiMaterial: {
        ...(roiCapture !== undefined && { roiCapture }),
        observation,
      },
    };
  };
}

/** Pre-flight lease validation closure used by the commit wrapper
 *  (sub-plan §3.4). Routes to the same session the lease was issued
 *  from and runs `LeaseStore.validate()` without executing the touch.
 *  When the lease arg is missing/malformed (caller passed garbage) we
 *  return `entity_not_found` so the wrapper emits a typed envelope
 *  rather than crashing inside the validator. */
function desktopActLeaseValidator(args: unknown): Promise<LeaseValidationResult> {
  const i = args as { lease?: EntityLease };
  if (!i?.lease || typeof i.lease.viewId !== "string") {
    return Promise.resolve({ ok: false, reason: "entity_not_found" });
  }
  return Promise.resolve(getDesktopFacade().validateLeaseOnly(i.lease));
}

/** Project the lease 4-tuple from `desktop_act` args into the
 *  `NativeLeaseTokenSummary` carried on the L1 `ToolCallStarted`
 *  payload (sub-plan §2.3). `evidenceDigestPrefix8` is the first 8
 *  chars of the full digest so the L1 ring stays compact when
 *  lease-aware tool calls are emitted at high rate. */
function desktopActExtractLeaseToken(args: unknown): NativeLeaseTokenSummary | undefined {
  const i = args as { lease?: EntityLease };
  if (!i?.lease) return undefined;
  return {
    entityId: i.lease.entityId,
    viewId: i.lease.viewId,
    targetGeneration: i.lease.targetGeneration,
    evidenceDigestPrefix8: (i.lease.evidenceDigest ?? "").slice(0, 8),
  };
}

/** `fetchMeta` for the envelope `as_of.wallclock_ms` source. Same
 *  pattern as `desktop-state.ts` (PR #112): read the L1 event
 *  wallclock + view-poisoned signal via the `viewGetFocusedWithWallclock`
 *  napi binding. Defensive paths: degrade to `Date.now()` fallback +
 *  `confidence: degraded` when the binding is missing or throws. */
const fetchEnvelopeMeta = async () => {
  if (
    nativeViewFocus &&
    typeof nativeViewFocus.viewGetFocusedWithWallclock === "function"
  ) {
    try {
      const meta = nativeViewFocus.viewGetFocusedWithWallclock();
      return {
        viewPoisoned: meta.viewPoisoned,
        asOfWallclockMs:
          meta.latestEventWallclockMs != null
            ? Number(meta.latestEventWallclockMs)
            : null,
      };
    } catch {
      return { viewPoisoned: true, asOfWallclockMs: null };
    }
  }
  return { viewPoisoned: false, asOfWallclockMs: null };
};

/** Round 1 P2 fix (Codex + user PR review): derive `tool_call_id`'s
 *  session-id source from the lease's `viewId` so the per-session
 *  monotone seq the wrapper emits (`${sessionId}:${seq}`) reflects
 *  the SessionRegistry's per-target session boundaries. Without this
 *  override, `makeCommitWrapper` falls back to the hard-coded
 *  `"default"` session and collapses every desktop_act call across
 *  every target/view into a single global seq — violating sub-plan
 *  §2.1 + §3.5 contract that tool_call_id is session-local.
 *
 *  Falls back to `"default"` when the lease arg is missing/malformed
 *  (the wrapper's leaseValidator has already short-circuited those
 *  cases on the failure path; the fallback is purely defensive). */
function desktopActSessionId(args: unknown): string {
  const lease = (args as { lease?: EntityLease }).lease;
  return typeof lease?.viewId === "string" && lease.viewId.length > 0
    ? lease.viewId
    : "default";
}

const desktopActWrapperOptions: CommitWrapperOptions<Record<string, unknown>> = {
  fetchMeta: fetchEnvelopeMeta,
  leaseValidator: desktopActLeaseValidator,
  extractLeaseToken: desktopActExtractLeaseToken,
  getSessionId: desktopActSessionId,
};

/** Module-scope schema with `include?: string[]` injected so MCP SDK's
 *  `server.tool()` Zod parse step preserves it for `makeQueryWrapper` /
 *  `makeCommitWrapper` to peek (PR #112 Round 1 P1 fix, sub-plan §2.5). */
export const desktopDiscoverRegistrationSchema = withEnvelopeIncludeSchema(desktopSeeSchema);
export const desktopActRegistrationSchema = withEnvelopeIncludeSchema(desktopTouchSchema);

/** Module-scope wrapped handlers (envelope-aware). Used by both the
 *  `server.tool` registration site below and `./macro.ts`
 *  `TOOL_REGISTRY` so the wrapper layer is honoured uniformly across
 *  the direct MCP path and the `run_macro` dispatcher (sub-plan §2.5,
 *  PR #112 same-pattern fix). */
export const desktopDiscoverRegistrationHandler = makeQueryWrapper(
  desktopDiscoverRawHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
  "desktop_discover",
  {
    fetchMeta: fetchEnvelopeMeta,
    causedByProjector: genericQueryCausedByProjector,
    getSessionId: defaultQuerySessionId,
  },
);

export const desktopActRegistrationHandler = makeCommitWrapper(
  desktopActRawHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
  "desktop_act",
  desktopActWrapperOptions,
);

// ── Tool registration ─────────────────────────────────────────────────────────

/**
 * Register desktop_discover and desktop_act on the MCP server.
 * Called by default on v0.17+; suppressed only when DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1.
 * See docs/anti-fukuwarai-v2-activation-policy.md.
 */
export function registerDesktopTools(server: McpServer): void {
  // Eagerly initialise the facade so the visual runtime + dirty-rect
  // router boot at registration time (matches pre-S4 behaviour). The
  // raw handlers below also call `getDesktopFacade()` lazily, but a
  // first-request without prior init would lose the initial 50ms
  // visual warmup window — keep the eager call for parity.
  getDesktopFacade();

  // S4 (sub-plan §2.5): pass the module-scope schema + handler so the
  // run_macro dispatcher reuses the SAME wrapped instances. Side
  // effect: lease pre-flight + ToolCall events + envelope assembly
  // are owned by the L5 wrapper, not the raw handlers.
  server.tool(
    "desktop_discover",
    [
      "[EXPERIMENTAL] Find actionable entities and emit leases for desktop_act. Observe a window or browser tab and return interactive entities as structured data.",
      "Supports multiple source lanes: UIA (native), CDP (browser), terminal buffer, and visual GPU.",
      "Returns entities with leases — pass a lease to desktop_act to interact.",
      "Raw screen coordinates are NOT returned in normal mode (debug=true only).",
      "If response.warnings[] is non-empty, results may be partial — except dialog_resolved_via_owner_chain, parent_disabled_prefer_popup and target_title_mismatch, which say which window was read.",
      "response.constraints (when present) is a structured summary of provider limitations — use it to decide fallback without parsing warnings[] strings.",
      "constraints.entityZeroReason (when entities is empty) explains WHY: foreground_unresolved → add target.windowTitle; query_no_match → query matched nothing read (off-screen text, and text UIA does not expose — spreadsheet cell values, some document bodies and Java windows — are never in the list; a Word page is matched by the lines visible on it; with uia_tree_truncated it may also lie past the cap): scroll it into view and call again, or read visible text with screenshot(detail='ocr'); target_window_gone → the window target.hwnd named has closed; discover the window it belonged to, or call without target.hwnd; window_excluded → the target is excluded from every tool surface of this server (the key locker's own windows): nothing was read, and calling again returns the same, so target another window; window_frozen → the window's app is suspended by Windows (minimised or not shown): UI Automation reads nothing from it and a capture shows its last frame, so nothing was read — restore or show the window, then call again;",
      "response.windows[] lists the top-level windows. isCloaked:true marks a window Windows hides (for example on another virtual desktop, or a packaged app's window while it is not shown) — it can still be running; isFrozen:true marks one whose app Windows has also suspended: it reads nothing and a capture of it is its last frame, not what it shows now.",
      "uia_blind_visual_incapable → the attached visual backend recognises nothing (the default build); waiting never changes it, so enable a recognising backend or use screenshot(ocrFallback=always) / V1 tools;",
      "uia_blind_visual_unready → retry when visual backend is ready or use screenshot(ocrFallback=always);",
      "uia_blind_visual_empty → use screenshot(ocrFallback=always) or V1 click_element;",
      "cdp_failed_visual_empty → check --remote-debugging-port on the port the tab was opened on (browser_open's port, 9222 by default; after a server restart, call browser_open with that port again) and retry;",
      "all_providers_failed → use V1 tools (click_element / terminal(action='read') / screenshot);",
      "constraints.uia=blind_single_pane → PWA/Electron/canvas; try view=debug or screenshot(ocrFallback=always);",
      "constraints.cdp=provider_failed → check --remote-debugging-port on the port the tab was opened on (browser_open's port, 9222 by default; after a server restart, call browser_open with that port again);",
      "constraints.terminal=provider_failed → use V1 terminal(action='read'/'send');",
      "Recovery: no_provider_matched → add target.windowTitle or retry; uia_tree_truncated → the read stopped early (its element cap, or its time on a slow window) and later controls are missing: call again, and if it stays, scroll or narrow the view to the part you need; partial_results_only → compare with V1 click_element; entities_capped → the list was cut at its limit (maxEntities; 20 by default, 50 with view:'explore') and entitiesCapped says how many were read: raise maxEntities (up to 200), use view:'explore', or pass a query for the item you need;",
      "cdp_provider_failed → check --remote-debugging-port on the port the tab was opened on (browser_open's port, 9222 by default; after a server restart, call browser_open with that port again);",
      "visual_provider_unavailable / visual_provider_warming → server retried once (~200ms); if still warned, continue with structured lane or retry later;",
      "uia/terminal_provider_failed → use V1 tools (click_element / terminal(action='read'));",
      "uia_blind_single_pane / uia_blind_too_few_elements → target is PWA/Electron/canvas; try view=debug for visual lane hints, or fall back to screenshot(ocrFallback=always);",
      "visual_not_attempted → GPU backend unavailable; use V1 screenshot+mouse_click or wait and retry;",
      "visual_attempted_empty → visual lane ran but produced no stable candidates; consider screenshot(ocrFallback=always) or V1 tools;",
      "visual_attempted_empty_cdp_fallback → CDP failed and visual also empty (browser); check --remote-debugging-port on the port the tab was opened on (browser_open's port, 9222 by default; after a server restart, call browser_open with that port again) and retry;",
      "dialog_resolved_via_owner_chain → common dialog (Save As/Open) found via owner chain; targeting is now hwnd-based;",
      "parent_disabled_prefer_popup → parent window blocked by a modal; switched to targeting the active popup dialog;",
      "target_title_mismatch → you sent target.hwnd and target.windowTitle, and that window's title does not contain the title you sent; the hwnd's window was read (the hwnd wins), so check it is the window you meant.",
      // ADR-036 item 8 — the shipped sentence for the field #150 added. Without it the field
      // exists and nobody reads it: the caller that needs it is a model reading this description.
      "response.freshness says whether these entities were READ for this call. Every call " +
        "reads the window again. observedAtMs is when that read STARTED; ageMs is observedAtMs to " +
        "this reply. from='read': a fetch ran for this call, which is NOT a promise that it " +
        "succeeded or that any lane looked — ageMs is then how long that fetch took and says " +
        "nothing about how old the entities are, since a lane may replay an earlier snapshot; if " +
        "entities is empty, warnings[] and constraints say why. from='unavailable': nothing was " +
        "read (ingress_fetch_error in warnings[] when the read failed), and then there is no " +
        "observedAtMs and no ageMs. from='cache' or 'staleCache' means the entities were " +
        "remembered from an earlier read: this server does not answer them. A value not listed " +
        "here is to be read as 'unavailable'. If ageMs is missing while observedAtMs is not, the two " +
        "clocks disagreed and the reply cannot be dated. It is NOT attention: that one is the UIA " +
        "cache's TTL and says 'ok' for a hung window.",
      // Internal #158 — the per-entity answer to what freshness says per call. from='read' is about
      // the call, and a lane can still hand back something it did not look at; that is only visible
      // here.
      "Each entity may carry status and observedAtMs. status='observed': a lane looked at the " +
        "window and saw it in the read that produced these entities. " +
        "status='stale': it was handed back from an earlier observation without looking — it may no " +
        "longer be on screen, even when freshness.from is 'read'. desktop_act looks for a stale " +
        "entity's label at its place before acting, and refuses with entity_not_found when the label " +
        "is not there; when it cannot look (no label, or the read fails) it acts unchecked, so confirm " +
        "a stale entity with no label is still there before acting on it. No status: the source did " +
        "not say. observedAtMs is when that entity was " +
        "observed, on the same clock as freshness.observedAtMs.",
      "response.softExpiresAtMs is an advisory timestamp at ~60% of the lease TTL window — past it the LLM should consider re-calling desktop_discover even though leases are still technically valid; lease.expiresAtMs remains the only correctness wall.",
      advisoryRegistry.toolDescriptionAdvisory(),
    ].join(" "),
    desktopDiscoverRegistrationSchema,
    desktopDiscoverRegistrationHandler as (input: unknown) => Promise<ToolResult>,
  );

  server.tool(
    "desktop_act",
    [
      "[EXPERIMENTAL] Act on a discovered entity (click/type/setValue/scroll). Use desktop_act.",
      "Validates the lease before executing — rejects stale, expired, or mismatched leases.",
      "Returns a semantic diff (entity_disappeared, modal_appeared, etc.) and a 'next' hint.",
      "When diffUnchecked is present, diff did not look for the kinds it lists, so their absence from diff does not mean they did not happen; re-call desktop_discover to see the window as it is now.",
      // ADR-036 — THE SHIPPED SENTENCE IS THE RULE; THE REASONS ARE HERE.
      //
      // Fourteen review rounds went into this paragraph, and every one removed a claim the code
      // cannot support: that reading the field back tells you; that the hint's silence means
      // something; that a matching value settles it; that foregrounding and focusing first is
      // enough; that the element can be compared to the one written (`desktop_state.focusedElement`
      // carries no entity id, and a duplicate name with no `automationId` cannot be told apart);
      // that the value is predictable (a background type inserts at the CARET and replaces the
      // SELECTION, exactly as typing does — 6 arms measured, background and foreground identical,
      // win2 `c76b78d`, so "prior text plus typed text" held in 2 of 6); that a field known empty
      // settles it (`text: \"\"` is accepted and sends zero messages, so an already-empty field
      // matches with no write, and autofill can fill between observations); that `diff` has a
      // baseline at the write (its PRE side is the stored discover snapshot); that a retry is free;
      // that taking focus makes the next write confirmable (only a field with a window of its own,
      // and `landing.why` does not separate that from a window that merely had no focused child);
      // that a clear resets (a clear is itself an empty write); and finally the two instructions
      // that had framed it since before the first round.
      //
      // WHAT SHIPS IS THE RULE, because the reasons are what a maintainer needs and the rule is
      // what a caller acts on — and the shipped copy is not free: measured at the four corners on
      // a running server, the long form cost ~667 tokens per session with v2 on and ~336 under the
      // kill switch (win2, `2406b98`). The reasons stay here, where they cost nothing and stop the
      // next round from re-adding a claim.
      landingAdvice(LANDING_ADVICE_TOOL_DESCRIPTION),
      "If ok=false, read 'reason':",
      "  lease_expired / lease_generation_mismatch / lease_digest_mismatch / entity_not_found → re-call desktop_discover; entity_not_found is also the answer when the element this act named is found gone at the act — UIA cannot find it, with evidence that it left and not only that a lookup missed it — or when desktop_discover handed it back from an earlier read and its label is no longer where it was; nothing was pressed or typed;",
      "  modal_blocking → response.blockingElement (when present) names the blocker. role:'dialog' means a separate dialog window has disabled the target's window: blockingElement.hwnd is that dialog — re-call desktop_discover with target.hwnd=blockingElement.hwnd, answer it there, then retry (name is its title, which may be empty or shared, so neither click_element(name) nor focus_window(title=name) reaches it). Any other role: a window the desktop_discover snapshot holds, where the OS could not say whether it blocks this entity — with blockingElement.hwnd, re-call desktop_discover with target.hwnd=blockingElement.hwnd and answer it there; without it, dismiss via V1 click_element(name=blockingElement.name). Then re-call desktop_discover on the original target and act on the new lease — this refusal came from that snapshot, so the same lease is refused again;",
      "  entity_outside_viewport → scroll it back via V1 scroll(action='to_element'/'raw'), or re-call desktop_discover if its window moved or closed;",
      "  origin_window_not_visible → the element's window is minimised or hidden — V1 focus_window(windowTitle) to restore it, then re-call desktop_discover;",
      "  coordinate_outside_reachable_bounds → the point is not on any connected monitor — the coordinates are stale: re-call desktop_discover (on builds without the native input module only the primary monitor is reachable; move the window there first). V1 click_element works without moving the cursor;",
      "  cursor_placement_blocked → the pointer could not be placed at that point (an app is holding the cursor, the session is not interactive right now, or the monitor layout just changed); nothing was clicked. V1 click_element acts without the cursor; otherwise free the cursor or reconnect the session and retry, and re-call desktop_discover if a monitor was added or removed;",
      "  aim_window_gone → the window this act was aimed at no longer exists; nothing was clicked. Re-call desktop_discover — do NOT retry by coordinate, the entity's rect is where that window used to be and another window may occupy it now;",
      "  aim_identity_changed → the window this act named has gone and its handle now names a different window (another process, or another window of the same program); nothing was done, and the lease describes a window that is gone. Re-call desktop_discover — do NOT retry with the same handle or by coordinate;",
      "  aim_occluded → another window drawn over the point would take the press, so nothing was done — by Windows' own hit test, which does not count an overlay that lets presses through there; a build whose native addon cannot ask Windows judges from the window list, where any window on top counts unless it has both WS_EX_TRANSPARENT and WS_EX_LAYERED. Bring the intended window forward, or use V1 click_element, which does not use coordinates — re-calling desktop_discover alone does not help, the coordinates are already right;",
      "  aim_point_outside_window → the window is still open but its coordinates can no longer be followed (among them: minimised; resized, so the contents may have reflowed — refused even where the point still falls inside; moved while it was being read, so that snapshot has no single origin; measured by a lane whose moment cannot be established, such as a stored visual snapshot; or captured in a window other than the one this act named — a menu or dropdown has an origin of its own and is followed only while it is still what sits under the point); nothing was clicked. A window that moved WITHOUT resizing is followed automatically when the coordinates were measured in the same read that measured the window; a move large enough to put the point off the window is usually answered earlier, as entity_outside_viewport (that check does not look at uia / cdp / terminal entities). Re-call desktop_discover — do NOT retry by coordinate;",
      "  aim_route_failed → the route to the window this act named failed (UIA for a click, UIA setValue + background write for type), and the act was NOT finished as a coordinate press. if_unexpected.detail names the failure when this server recognises it (not found, no pattern, disabled, read-only, the window did not answer, the classic client busy or unavailable): in these nothing was clicked or typed — except when it says the window stopped answering during the press or write, which may still take effect when the window answers, so look before trying again. When it says not found or names none: re-call desktop_discover, or try V1 click_element(name=…) on the same entity; when the route may have matched another element by the same text, click_element with controlType narrows it. When it says disabled, the element the route matched — or its whole window — does not take input now: answer or wait out whatever disabled it, then re-call desktop_discover; if it is refused the same way after that, the route may be matching another element by the same text, which click_element(name=…, controlType=…) narrows;",
      "  keyboard_target_unsafe → the background write would not have reached the field this act named (the focus is on a different control or in a different window, the receiving control does not take typed text, or the field — or its window — is disabled); nothing was typed. if_unexpected.detail names which. For disabled, answer or wait out whatever disabled it, then re-call desktop_discover — it does not list a disabled field, so missing there means still disabled; clicking it does not help. For read_only on the field you named, that field does not take text — typing again will not change it; name the field that does. Otherwise put the focus on the field you named, then type again — if_unexpected.detail names the way back for the road this act took: on a window named by title, desktop_act(action='click') on the same entity does it; on a window named by handle no route here focuses a text field yet, so re-call desktop_discover by the window's title and click it from there (a common dialog's title resolves to a handle too, so that road does not open there). For other_window, V1 focus_window on the field's window first — it comes forward with the focus it last had, and a window over the field makes a click answer aim_occluded — do NOT type through the foreground instead;",
      "  foreground_not_allowed → typing into Windows Terminal needs the foreground, and it was not allowed (declined, dismissed, unanswered, cannot ask; the terminal in front, split, not a terminal tab, on another desktop, changed or unreadable; text or title that cannot be shown in full; or the paste failed); if_unexpected.detail says which, and whether anything was typed. Do NOT type into it another way after a no;",
      "  aim_blocked_by_excluded_window → a window this server may not act through is over the point, so nothing was done; the window you named is NOT the excluded one and is still actionable. Use V1 click_element, which does not use coordinates, or retry once the point is clear — do NOT retry by coordinate, and note that nothing in the response describes the window in the way;",
      "  action_not_offered → the target does not offer this action and NOTHING WAS DONE — no road was taken, so it is not a failed executor. Ask for what you mean: action='click' / 'invoke' presses it; the entity's affordances say which actions it offers. No provider advertises 'select', so a select on any target is this refusal. A type or setValue on a control UI Automation reports as a button, check box, radio button, hyperlink or menu item is this refusal too: none of them takes text, and nothing was typed;",
      "  value_not_applied → the write was accepted and nothing read back changed: a type or setValue through the native UI Automation client to a control that is not a text field (not Edit or Document) whose value read back unchanged for a moment after the write (nothing else was tried), or a type into Word's body after which the visible page text read back unchanged (it may have landed out of view). Do not retry it or type into the same control another way (on a WinForms NumericUpDown a keystroke landed at its caret); look at the field or document, or re-call desktop_discover, before writing again;",
      "  window_excluded → this window is excluded from every tool surface of this server (the key locker's own windows are); nothing was clicked and no route here can click it. Act on another window;",
      "  executor_failed → when if_unexpected.detail begins 'Nothing was typed', no route ran and nothing was typed: do what detail says. Otherwise the road this act took failed: for a click or invoke fall back to V1 tools (click_element / mouse_click / browser_click); for a type or setValue, focus the field and use V1 keyboard(action='type', method='foreground'). if_unexpected.try_next carries the lines for this act;",
      "  executor_failed on terminal textbox (action=type) → use V1 terminal(action='send') instead — but never after foreground_not_allowed: terminal send pastes into Windows Terminal without asking;",
      "  unknown → the handler threw before any road named a cause; it is NOT a refusal this tool decided, so it does NOT say the act was skipped — it may have taken effect before the throw. Observe the target again before acting, and do not repeat the call as a retry until you have; if_unexpected.try_next names the instrument for the kind of target.",
      "Check desktop_discover response.constraints for pre-emptive fallback hints before calling desktop_act.",
      "[EXPERIMENTAL] On visual-only targets (UIA-blind / RDP / canvas), a successful act may attach a",
      "'roiCapture' { roi, somImageRef, entities }: the changed region's PNG crop by-ref (somImageRef +",
      "a resource_link; somImage null by default) + a lease-less entity",
      "preview, so you can confirm the result + find the next target in one call (no separate desktop_state /",
      "screenshot). entities are previews (no lease) — re-run desktop_discover to act. Control via returnCapture",
      "('on-change' default / 'always' / 'never'). Never attached on structured targets (browser/CDP, UIA-rich).",
    ].join(" "),
    desktopActRegistrationSchema,
    desktopActRegistrationHandler as (input: unknown) => Promise<ToolResult>,
  );
}
