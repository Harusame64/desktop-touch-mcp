/**
 * ADR-029 — refuse mouse coordinates the current input backend cannot reach.
 *
 * Since Phase 2a the native path (`src/win32/mouse.rs`, driven by
 * `src/engine/cursor.ts`) places the cursor anywhere on the virtual desktop, so
 * the reachable region is every connected monitor. On an installation without
 * that native module, movement falls back to nut.js / libnut, which addresses
 * the primary monitor only and silently pulls any other point into it — there
 * the region stays the primary monitor, exactly as in Phase 1.
 *
 * The region is therefore chosen by capability, not compiled in: widening it
 * unconditionally would hand back the silent misclick on every build that
 * cannot actually reach the other monitors.
 *
 * **Per monitor, not the bounding box.** A point in the gap of an L-shaped or
 * staggered layout is inside the virtual screen's bounding rectangle but on no
 * monitor, and Windows pulls the cursor to the nearest one — i.e. it fires
 * somewhere the caller did not ask for. That is the failure this guard exists
 * to prevent, so containment is tested against each monitor's rectangle.
 *
 * Every caller must run this BEFORE moving the cursor — once a coordinate has
 * been clamped, the wrong position is already in effect.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADR-031 adds a sibling resolver for SCREEN CAPTURE at the bottom of this
 * file. It shares the shape of the input one — a region chosen by capability,
 * `null` for "the layout could not be read" — because the question is the same
 * one ("what can this backend reach?") and answering it in two files is how the
 * two answers drift apart. The deliberate differences are documented there.
 */

import { enumMonitors, getPrimaryMonitorBounds } from "./win32.js";
import { hasNativeCursorMove, hasNativeCaptureRegion } from "./native-engine.js";
import {
  CoordinateOutsideReachableBoundsError,
  RegionOutsideCapturableBoundsError,
} from "../errors/typed-errors.js";
import { logDiagnostic } from "./diagnostic-log.js";

export interface ReachableBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the cursor can currently be placed.
 *
 * - `monitors` — the native path is available: every connected monitor, tested
 *   individually so layout gaps are excluded.
 * - `rect` — a single rectangle: the primary monitor on a build without the
 *   native path, or a caller-supplied override in tests.
 * - `null` — unknown. Monitor enumeration failed, so nothing can be judged.
 */
export type ReachableRegion =
  | { kind: "monitors"; monitors: ReachableBounds[] }
  | { kind: "rect"; rect: ReachableBounds };

function contains(b: ReachableBounds, x: number, y: number): boolean {
  return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
}

let warnedUnknownBounds = false;

/**
 * The layout is read once per gesture rather than once per call.
 *
 * A single drag asks three times — the handler checks both endpoints before
 * pressing, then the move checks again — and `EnumDisplayMonitors` on each was
 * not only wasted work but a correctness gap: the guard could approve a point
 * against one layout while the move ran against another. A short window keeps
 * the whole gesture on one answer.
 *
 * It stays short because a monitor really can be unplugged mid-gesture. That
 * case is not left to this cache: the native move reads the cursor back and
 * reports a placement failure when the OS pulled it elsewhere.
 */
const REGION_CACHE_MS = 250;
let cachedRegion: { at: number; region: ReachableRegion | null } | null = null;

/** Drop the memoised layout — tests that swap the monitor set need this. */
export function _resetReachableRegionCacheForTests(): void {
  cachedRegion = null;
}

/**
 * Resolve the region the cursor can be placed in, or `null` when that cannot
 * be determined.
 *
 * `null` is treated as "allow" by the callers below: refusing every click on a
 * machine whose monitor enumeration fails would be worse than the misclick risk
 * it guards against. Callers that report a failure afterwards need to know this
 * happened, though — a coordinate that was never checked may simply be stale —
 * so the distinction is part of the return type rather than hidden inside.
 */
export function resolveReachableRegion(): ReachableRegion | null {
  const now = Date.now();
  if (cachedRegion && now - cachedRegion.at < REGION_CACHE_MS) return cachedRegion.region;

  let region: ReachableRegion | null;
  try {
    if (hasNativeCursorMove()) {
      const monitors = enumMonitors().map((m) => m.bounds);
      region = monitors.length > 0 ? { kind: "monitors", monitors } : null;
    } else {
      const primary = getPrimaryMonitorBounds();
      region = primary ? { kind: "rect", rect: primary } : null;
    }
  } catch {
    region = null; // Win32 failure → unknown → allow (same stance as the viewport gate)
  }
  if (region === null && !warnedUnknownBounds) {
    // Allowing everything keeps a machine with unreadable monitor info usable, but
    // it also restores the silent-misclick behaviour this guard exists to prevent.
    // Say so once rather than failing quietly in both directions.
    warnedUnknownBounds = true;
    console.error(
      "[reachable-bounds] monitor bounds unavailable — coordinate reachability cannot be checked; " +
        "clicks may land somewhere other than the requested point.",
    );
  }
  cachedRegion = { at: now, region };
  return region;
}

/** Is (x, y) inside `region`? An unknown (`null`) region cannot be judged, so it allows. */
export function isPointInRegion(x: number, y: number, region: ReachableRegion | null): boolean {
  if (!region) return true;
  return region.kind === "monitors"
    ? region.monitors.some((m) => contains(m, x, y))
    : contains(region.rect, x, y);
}

/**
 * @param bounds Override the reachable region (tests). Defaults to the region
 *   resolved from the live monitor layout. A `null` override means "unknown" —
 *   the guard then allows the coordinate rather than blocking every click.
 */
export function isCoordinateReachable(x: number, y: number, bounds?: ReachableBounds | null): boolean {
  const region =
    bounds === undefined
      ? resolveReachableRegion()
      : bounds === null
        ? null
        : ({ kind: "rect", rect: bounds } as const);
  return isPointInRegion(x, y, region);
}

/**
 * Throw {@link CoordinateOutsideReachableBoundsError} when (x, y) is on no
 * monitor the cursor can currently be placed on. No-op otherwise.
 */
export function assertCoordinateReachable(
  x: number,
  y: number,
  bounds?: ReachableBounds | null,
): void {
  const region =
    bounds === undefined
      ? resolveReachableRegion()
      : bounds === null
        ? null
        : ({ kind: "rect", rect: bounds } as const);
  assertPointInRegion(x, y, region);
}

/**
 * Same check against an already-resolved region. `cursor.ts` resolves the
 * region once per move — it needs the same value afterwards to word a placement
 * failure — and would otherwise pay for a second monitor enumeration here.
 */
export function assertPointInRegion(x: number, y: number, region: ReachableRegion | null): void {
  if (isPointInRegion(x, y, region)) return;
  throw new CoordinateOutsideReachableBoundsError(describeUnreachable(x, y, region));
}

/**
 * The user-facing half of the refusal. Which message applies is decided by
 * capability, not by the shape of the region: a single rectangle can equally
 * well be a test override, and telling a test that the native input module is
 * missing would be wrong.
 */
function describeUnreachable(x: number, y: number, region: ReachableRegion | null): string {
  if (region?.kind === "monitors") {
    const layout = region.monitors
      .map((m) => `${m.width}x${m.height} at (${m.x}, ${m.y})`)
      .join(", ");
    return (
      `CoordinateOutsideReachableBounds: (${x}, ${y}) is not on any connected monitor ` +
      `(monitors: ${layout}). Mouse input works on all monitors, so this usually means the ` +
      `coordinates are stale — the window moved or closed after they were read. Re-run ` +
      `desktop_discover (or take a fresh screenshot) and act on the new coordinates.`
    );
  }
  const where =
    region?.kind === "rect"
      ? `${region.rect.width}x${region.rect.height} at (${region.rect.x}, ${region.rect.y})`
      : "the reachable area";
  if (!hasNativeCursorMove()) {
    return (
      `CoordinateOutsideReachableBounds: (${x}, ${y}) is outside the primary monitor ${where}. ` +
      `This installation is running without its built-in Windows input module, so mouse input ` +
      `reaches the primary monitor only — acting on this coordinate would click somewhere else ` +
      `instead. Move the target window onto the primary monitor, or reinstall / update the ` +
      `server to restore multi-monitor input.`
    );
  }
  return (
    `CoordinateOutsideReachableBounds: (${x}, ${y}) is outside ${where}. Acting on this ` +
    `coordinate would click somewhere else instead.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-031 — the same question for screen capture
// ─────────────────────────────────────────────────────────────────────────────
//
// Two things differ from the cursor resolver above, both on purpose:
//
//   - The answer carries BOTH the virtual screen's bounding rectangle and the
//     individual monitors, and the caller says which question to ask of them
//     (see `CaptureBoundsMode`). A rectangle the CALLER supplied has to clear
//     both: inside the bounding rectangle, and overlapping a real monitor. The
//     second half is not redundant — a rectangle sitting in the gap of a
//     staggered layout is inside the bounding rectangle and on no monitor at
//     all, and BitBlt answers it with black pixels reported as a successful
//     capture. Nothing downstream catches that on this path: the blank-capture
//     check runs on the per-window capture ladder only, so this guard is the
//     only thing between the caller and a black picture presented as the place
//     they asked for.
//     A rectangle the MACHINE derived — a window's own screen rect — is held
//     to the overlap half alone. `GetWindowRect` reports a maximised window a
//     few pixels outside the monitor (the invisible resize border), and a
//     window straddling the desktop edge runs off it for real; the native
//     capture clears its bitmap to black before the BitBlt, so the off-screen
//     part comes back black BY CONSTRUCTION rather than as whatever the
//     uninitialised bitmap happened to hold — which is the honest picture of
//     where the window is. Refusing them would take away a capture that works.
//     That last sentence is true of BitBlt and false of libnut, so the
//     relaxation follows the BACKEND, not the caller: libnut cannot clip and
//     throws on any rectangle leaving the primary monitor, so a `primary-rect`
//     resolution keeps the containment requirement in both modes. The boundary
//     is what the backend can read — a rule this file would be undoing if it
//     let a rectangle through on the strength of who supplied it.
//
//   - The layout is read on every call, with no cache. The 250ms window above
//     exists because one drag asks three times and must get one answer; a
//     capture asks once, and `EnumDisplayMonitors` is nothing next to the
//     BitBlt and the PNG encode that follow it.

/** The pixel source a process captures through. Recorded in diagnostic.log. */
export type CaptureBackend = "gdi-bitblt" | "nutjs";

/**
 * The chosen backend and what chose it. The determinant is carried because the
 * refusal message has to name it: "this build has no capture module" and "you
 * set DESKTOP_TOUCH_CAPTURE_BACKEND" have different fixes.
 */
export interface CaptureBackendSelection {
  backend: CaptureBackend;
  determinant: "native-module" | "no-native-module" | "env-override";
}

/**
 * What the capture backend can read.
 *
 * - `virtual-rect` — native path: the bounding rectangle of every connected
 *   monitor, negative origins included.
 * - `primary-rect` — nut.js path: the primary monitor, because libnut
 *   validates absolute coordinates against that monitor alone.
 * - `null` — unknown. Monitor enumeration failed, so nothing can be judged.
 *
 * `monitors` carries the rectangles the bounding one was built from — one
 * element on the `primary-rect` path, where the primary monitor IS the whole
 * capturable area. It is what makes the gap of a staggered layout visible: the
 * bounding rectangle alone cannot tell "on a monitor" from "in the hole
 * between two of them".
 */
export type CaptureRegionResolution =
  | { kind: "virtual-rect"; rect: ReachableBounds; monitors: readonly ReachableBounds[] }
  | { kind: "primary-rect"; rect: ReachableBounds; monitors: readonly [ReachableBounds] };

/**
 * Which question to ask of a resolution.
 *
 * - `contain` — the caller named this rectangle, so hold it to both halves:
 *   inside the capturable area AND overlapping a monitor. Anything else would
 *   answer with black pixels where the caller expected content.
 * - `overlap` — the rectangle came from Windows (a window's own screen rect),
 *   so only require that it touches a monitor. It is passed to the backend
 *   UNCHANGED: the off-screen part comes back black, which is the truthful
 *   picture of a window hanging off the desktop edge, and clamping it would
 *   silently change the buffer's dimensions out from under the window-local
 *   crop the caller applies afterwards.
 *
 * The relaxation applies to the GDI backend only (`virtual-rect`). It is a
 * statement about what the backend can do, not a preference: BitBlt clips
 * against the screen DC, and the native capture clears the bitmap to black
 * before the copy, so the part BitBlt does not write is black rather than
 * uninitialised. (BitBlt itself writes nothing there — the clear is what makes
 * the margin black. The relaxation is unaffected either way: what earns it is
 * that BitBlt CLIPS instead of failing.) libnut cannot clip at all and throws
 * on any rectangle leaving the primary monitor. On a
 * `primary-rect` resolution `overlap` therefore still requires containment —
 * a refusal there is `RegionOutsideCapturableBounds`, which names the missing
 * native module, whereas letting the rectangle through would surface libnut's
 * throw as `CaptureBackendFailed` and send the caller after a locked screen or
 * a UAC prompt that has nothing to do with it.
 */
export type CaptureBoundsMode = "contain" | "overlap";

/** Environment override. Only the nut.js direction is defined — the native
 *  path is already preferred wherever it exists, so forcing it would express
 *  nothing. */
const CAPTURE_BACKEND_ENV = "DESKTOP_TOUCH_CAPTURE_BACKEND";

let captureSelection: CaptureBackendSelection | null = null;
let warnedUnknownCaptureBounds = false;

/** Test-only: forget the memoised backend choice and the warn-once latch. */
export function _resetCaptureBackendForTests(): void {
  captureSelection = null;
  warnedUnknownCaptureBounds = false;
}

/**
 * Which backend this process captures through — decided once, on first use,
 * and never again.
 *
 * The choice is static by design (ADR-031 §2(b)). A per-call "native failed,
 * try nut.js" would hand a rectangle that was validated against the virtual
 * screen to a library that rejects anything off the primary monitor, and it
 * would let the returned dimensions of one region change between two captures
 * in a session under a non-100% DPI layout, which is exactly what frame diffing
 * cannot survive.
 */
export function selectCaptureBackend(): CaptureBackendSelection {
  if (captureSelection) return captureSelection;

  const raw = process.env[CAPTURE_BACKEND_ENV];
  const requested = raw?.trim().toLowerCase();
  let selection: CaptureBackendSelection;
  if (requested === "nutjs") {
    selection = { backend: "nutjs", determinant: "env-override" };
  } else {
    selection = hasNativeCaptureRegion()
      ? { backend: "gdi-bitblt", determinant: "native-module" }
      : { backend: "nutjs", determinant: "no-native-module" };
    if (requested !== undefined && requested !== "") {
      // Ignored rather than fatal: an unreadable value should not take
      // screenshots away. Said once, at the moment it stops mattering.
      logDiagnostic({
        kind: "capture",
        event: "backend_override_ignored",
        backend: selection.backend,
        determinant: selection.determinant,
        reason: `${CAPTURE_BACKEND_ENV}=${JSON.stringify(raw)} is not a backend this build supports (only "nutjs")`,
      });
    }
  }
  captureSelection = selection;
  // Recorded once so a capture can be attributed to a pixel source afterwards
  // (ADR-031 §4.4). Per-capture would say the same thing every time — the
  // choice cannot change while the process lives.
  logDiagnostic({
    kind: "capture",
    event: "backend_selected",
    backend: selection.backend,
    determinant: selection.determinant,
  });
  return selection;
}

/** Bounding rectangle of every monitor. */
function boundingRect(rects: ReachableBounds[]): ReachableBounds {
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Resolve what the capture backend can read, or `null` when the monitor layout
 * cannot be determined.
 *
 * `null` means "do not judge": a machine whose enumeration fails keeps taking
 * screenshots rather than being refused every one of them. The rectangle then
 * goes to the backend unchecked, and a region that turns out to be off-screen
 * comes back black AND UNANNOUNCED — the blank-capture check runs on the
 * per-window capture ladder, not on this path, so nothing downstream notices.
 * That is the price of failing open, and the reason this check is worth making
 * whenever the layout CAN be read.
 *
 * `getVirtualScreen()` is deliberately not reused: it substitutes a hard-coded
 * 1920x1080 rectangle when enumeration returns nothing, which would turn this
 * unknown into a confident wrong answer.
 */
export function resolveCaptureRegion(): CaptureRegionResolution | null {
  const { backend, determinant } = selectCaptureBackend();
  let resolution: CaptureRegionResolution | null;
  try {
    if (backend === "gdi-bitblt") {
      const monitors = enumMonitors().map((m) => m.bounds);
      resolution =
        monitors.length > 0
          ? { kind: "virtual-rect", rect: boundingRect(monitors), monitors }
          : null;
    } else {
      const primary = getPrimaryMonitorBounds();
      resolution = primary ? { kind: "primary-rect", rect: primary, monitors: [primary] } : null;
    }
  } catch {
    resolution = null; // Win32 failure → unknown → allow (same stance as the cursor guard)
  }
  if (resolution === null && !warnedUnknownCaptureBounds) {
    warnedUnknownCaptureBounds = true;
    logDiagnostic({
      kind: "capture",
      event: "bounds_unknown",
      backend,
      determinant,
      reason:
        "monitor bounds unavailable — capture regions cannot be checked; an off-screen region will come back black",
    });
  }
  return resolution;
}

/**
 * {@link resolveCaptureRegion} plus the one bounds source that outlives a
 * missing native addon. Prefer this wherever the caller is already async.
 *
 * The sync core is deliberately unchanged: the plan specifies it as
 * cache-free and synchronous, and every existing caller and test of it keeps
 * that contract. This is an ADDITION on top, not a divergence from it.
 *
 * Why it is needed: `hasNativeCaptureRegion()` selects nut.js when the addon
 * is absent entirely — a supported build. But the primary-rect branch of the
 * sync core reaches its bounds through `getPrimaryMonitorBounds()` →
 * `enumMonitors()` → `requireNativeWin32()`, which throws on exactly that
 * build. The catch turns it into "unknown", the resolver fails open, and an
 * off-primary region then reaches libnut and comes back as
 * `CaptureBackendFailed` — advice about locked screens and UAC prompts for a
 * process whose real problem is that it has no multi-monitor capture. The
 * limitation is knowable without the addon, so it is enforced instead.
 *
 * The GDI path is untouched: a `virtual-rect` resolution never needs this, and
 * a GDI process that cannot enumerate monitors keeps failing open as before —
 * that fail-open is deliberate (a machine whose enumeration breaks keeps
 * taking screenshots).
 *
 * `nutjs.js` is imported dynamically rather than at module scope on purpose:
 * it loads nut.js's own native backend at import time, and pulling that into
 * this module would drag it into every unit test that touches the resolver,
 * including those that mock neither. Loading it only when the fallback
 * actually fires keeps the sync path free of it.
 */
export async function resolveCaptureRegionAsync(): Promise<CaptureRegionResolution | null> {
  const resolution = resolveCaptureRegion();
  if (resolution) return resolution;

  const { backend, determinant } = selectCaptureBackend();
  if (backend !== "nutjs") return null;

  let size: { width: number; height: number } | null = null;
  try {
    const { getPrimaryScreenSize } = await import("./nutjs.js");
    size = await getPrimaryScreenSize();
  } catch {
    size = null; // nut.js unavailable too → genuinely unknown
  }
  if (!size) return null;

  // nut.js reads the primary display, whose origin is (0, 0) by definition.
  const rect = { x: 0, y: 0, width: size.width, height: size.height };
  logDiagnostic({
    kind: "capture",
    event: "bounds_from_nutjs",
    backend,
    determinant,
    reason:
      "monitor enumeration unavailable (no native module); primary-monitor bounds read from the nut.js backend instead",
  });
  return { kind: "primary-rect", rect, monitors: [rect] };
}

/** Is `inner` entirely inside `outer`? */
function containsRect(outer: ReachableBounds, inner: ReachableBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** Do `a` and `b` share any area? Touching edges do not count. */
function intersectsRect(a: ReachableBounds, b: ReachableBounds): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Can `region` be captured? An unknown (`null`) resolution cannot be judged, so
 * it allows.
 *
 * In `contain` mode (the default, for a rectangle the caller named) the region
 * must be inside the capturable area AND overlap a monitor. Containment alone
 * would let through a rectangle lying in the gap of a staggered layout —
 * inside the bounding rectangle, on no monitor — which comes back entirely
 * black and is reported as a success. Overlap alone would let through a
 * rectangle running past the desktop edge, half of which is black for the same
 * reason. Both failures look identical to the caller, so both are refused.
 *
 * In `overlap` mode (for a rectangle Windows produced — a window's own screen
 * rect) only the overlap half applies, and the rectangle reaches the backend
 * unchanged — but only on the GDI resolution, which can clip. See
 * {@link CaptureBoundsMode}.
 */
export function isCaptureRegionInBounds(
  region: ReachableBounds,
  resolution: CaptureRegionResolution | null,
  mode: CaptureBoundsMode = "contain",
): boolean {
  if (!resolution) return true;
  const onSomeMonitor = resolution.monitors.some((m) => intersectsRect(m, region));
  // The relaxation is BitBlt's ability to clip, so it is spelled against the
  // resolution kind rather than the mode alone. libnut has no such ability:
  // an overhanging rectangle there throws, and the throw arrives as
  // `CaptureBackendFailed` — advice about locked screens and UAC prompts, for
  // a process whose real problem is that it has no native capture module.
  if (mode === "overlap" && resolution.kind === "virtual-rect") return onSomeMonitor;
  return onSomeMonitor && containsRect(resolution.rect, region);
}

/**
 * Throw {@link RegionOutsideCapturableBoundsError} when `region` is outside
 * what this process can capture. No-op otherwise.
 */
export function assertCaptureRegionInBounds(
  region: ReachableBounds,
  resolution: CaptureRegionResolution | null,
  selection: CaptureBackendSelection = selectCaptureBackend(),
  mode: CaptureBoundsMode = "contain",
): void {
  if (isCaptureRegionInBounds(region, resolution, mode)) return;
  throw new RegionOutsideCapturableBoundsError(describeUncapturable(region, resolution, selection));
}

/**
 * The user-facing half of the refusal. As with the cursor guard, which wording
 * applies is decided by the capability that was actually used, not by the shape
 * of the rectangle — a single rectangle can equally well be a test override.
 *
 * On the GDI backend there are two ways to be refused, and they need opposite
 * advice. A region that touches NO monitor is usually stale — the window moved
 * or closed — so re-discovering fixes it. A region that DOES overlap a monitor
 * but runs past the capturable area is not stale at all: re-discovering hands
 * back the very same rectangle, and telling the caller to re-discover sends
 * them round a loop that cannot terminate. That case is named separately.
 */
function describeUncapturable(
  region: ReachableBounds,
  resolution: CaptureRegionResolution | null,
  selection: CaptureBackendSelection,
): string {
  const asked = `${region.width}x${region.height} at (${region.x}, ${region.y})`;
  const where = resolution
    ? `${resolution.rect.width}x${resolution.rect.height} at (${resolution.rect.x}, ${resolution.rect.y})`
    : "the capturable area";
  if (selection.backend === "gdi-bitblt") {
    const overlapped = resolution?.monitors.filter((m) => intersectsRect(m, region)) ?? [];
    if (overlapped.length > 0) {
      const which = overlapped
        .map((m) => `${m.width}x${m.height} at (${m.x}, ${m.y})`)
        .join(" and ");
      return (
        `RegionOutsideCapturableBounds: the requested region ${asked} does overlap ` +
        `${overlapped.length === 1 ? "monitor" : "monitors"} ${which}, but it extends past the ` +
        `capturable screen area (which spans ${where}). The coordinates are NOT stale — ` +
        `re-running desktop_discover returns this same region. Shrink the region so it fits ` +
        `inside the screen area, or capture the window itself with screenshot(windowTitle=…), ` +
        `which reads the window wherever it sits.`
      );
    }
    return (
      `RegionOutsideCapturableBounds: the requested region ${asked} is not on any connected ` +
      `monitor (the screen area spans ${where}). Screen capture covers every monitor, so this ` +
      `usually means the coordinates are stale — the window moved or closed after they were ` +
      `read. Re-run desktop_discover (or take a fresh screenshot) and capture the new region.`
    );
  }
  const why =
    selection.determinant === "env-override"
      ? `the ${CAPTURE_BACKEND_ENV} environment variable pins this server to the nut.js capture backend`
      : "this installation is running without its built-in Windows capture module";
  // Same split as the GDI branch above, for the same reason. A maximised window
  // is reported by `GetWindowRect` a few pixels outside its own monitor, so its
  // rect overlaps the primary monitor while overhanging it — and "move the
  // target window onto the primary monitor" is then advice to do what has
  // already been done. Only a region that misses the primary entirely can be
  // fixed by moving the window.
  if (resolution?.monitors.some((m) => intersectsRect(m, region))) {
    return (
      `RegionOutsideCapturableBounds: the requested region ${asked} overlaps the primary ` +
      `monitor ${where} but extends past its edge. Because ${why}, capture is limited to the ` +
      `primary monitor and the overhanging part cannot be read. Moving the window will not ` +
      `help — it is already on the primary monitor. Shrink the region so it fits, or capture ` +
      `the window itself with screenshot(windowTitle=…), which returns the whole window.`
    );
  }
  return (
    `RegionOutsideCapturableBounds: the requested region ${asked} is outside the primary ` +
    `monitor ${where}. Because ${why}, capture is limited to the primary monitor — the region ` +
    `cannot be read from here. Capture the window directly with screenshot(windowTitle=…), ` +
    `move the target window onto the primary monitor, or (for the missing module) reinstall / ` +
    `update the server to restore multi-monitor capture.`
  );
}

/**
 * Grow `rect` by `padding` on every side for a capture, trimming the overhang
 * back to the capturable area.
 *
 * The trim applies only when `rect` itself is inside the capturable area — then
 * the overhang is padding the caller does not need and cutting it keeps the
 * capture working. When `rect` is OUTSIDE (say an element on a monitor a
 * nut.js-backed process cannot read), the padded region is returned untouched
 * so the choke point refuses it: pulling it into the primary monitor instead
 * would answer with a picture of somewhere else and call it a success.
 *
 * "Inside the capturable area" here means inside the BOUNDING rectangle only —
 * an element sitting in the gap of a staggered layout passes this test and is
 * padded normally, and is then refused by the choke point, which does look at
 * the individual monitors. Both outcomes are the same for this function's
 * purpose (hand the region over unpulled and let the check decide), so the
 * cheaper test is the one used.
 *
 * An unknown (`null`) resolution trims nothing, matching the choke point, which
 * checks nothing.
 */
export function padCaptureRegion(
  rect: ReachableBounds,
  padding: number,
  resolution: CaptureRegionResolution | null,
): ReachableBounds {
  const padded = {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
  if (!resolution || !containsRect(resolution.rect, rect)) return padded;
  const bounds = resolution.rect;
  const left = Math.max(padded.x, bounds.x);
  const top = Math.max(padded.y, bounds.y);
  const right = Math.min(padded.x + padded.width, bounds.x + bounds.width);
  const bottom = Math.min(padded.y + padded.height, bounds.y + bounds.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
