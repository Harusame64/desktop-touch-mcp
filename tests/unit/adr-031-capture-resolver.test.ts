/**
 * ADR-031 — the capture-side resolver in `reachable-bounds.ts`.
 *
 * What it decides is a pair, and the pair has to stay consistent: the backend
 * that reads the pixels, and the area that backend can read. A process that
 * captures through nut.js and judges against the whole virtual screen would
 * wave through exactly the coordinates libnut rejects, which is the failure
 * this ADR exists to remove — so every case below asserts both halves.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  state: {
    nativeCapture: true,
    monitors: [{ x: 0, y: 0, width: 1920, height: 1080 }] as {
      x: number;
      y: number;
      width: number;
      height: number;
    }[],
    enumThrows: false,
  },
  enumCalls: { n: 0 },
  events: [] as Record<string, unknown>[],
}));

vi.mock("../../src/engine/native-engine.js", () => ({
  nativeWin32: {},
  hasNativeCursorMove: () => true,
  hasNativeCaptureRegion: () => hoisted.state.nativeCapture,
}));
vi.mock("../../src/engine/win32.js", () => ({
  enumMonitors: () => {
    hoisted.enumCalls.n++;
    if (hoisted.state.enumThrows) throw new Error("EnumDisplayMonitors failed");
    return hoisted.state.monitors.map((bounds, i) => ({ primary: i === 0, bounds }));
  },
  getPrimaryMonitorBounds: () => {
    hoisted.enumCalls.n++;
    if (hoisted.state.enumThrows) throw new Error("EnumDisplayMonitors failed");
    return hoisted.state.monitors[0] ?? null;
  },
}));
vi.mock("../../src/engine/diagnostic-log.js", () => ({
  logDiagnostic: (e: Record<string, unknown>) => {
    hoisted.events.push(e);
  },
}));

import {
  selectCaptureBackend,
  resolveCaptureRegion,
  isCaptureRegionInBounds,
  assertCaptureRegionInBounds,
  padCaptureRegion,
  _resetCaptureBackendForTests,
} from "../../src/engine/reachable-bounds.js";
import { failWith } from "../../src/tools/_errors.js";

/** The dogfood layout: a second monitor placed to the LEFT of the primary. */
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 };
const LEFT = { x: -1920, y: 0, width: 1920, height: 1080 };

const captureEvents = (event: string) => hoisted.events.filter((e) => e.event === event);

beforeEach(() => {
  delete process.env.DESKTOP_TOUCH_CAPTURE_BACKEND;
  hoisted.state.nativeCapture = true;
  hoisted.state.monitors = [PRIMARY, LEFT];
  hoisted.state.enumThrows = false;
  hoisted.enumCalls.n = 0;
  hoisted.events.length = 0;
  _resetCaptureBackendForTests();
});

describe("selectCaptureBackend", () => {
  it("uses the native path when the addon carries the capture binding", () => {
    expect(selectCaptureBackend()).toEqual({
      backend: "gdi-bitblt",
      determinant: "native-module",
    });
  });

  it("falls back to nut.js on a build without the capture binding", () => {
    hoisted.state.nativeCapture = false;
    expect(selectCaptureBackend()).toEqual({
      backend: "nutjs",
      determinant: "no-native-module",
    });
  });

  it("honours the env override even when the native binding is present", () => {
    process.env.DESKTOP_TOUCH_CAPTURE_BACKEND = "nutjs";
    expect(selectCaptureBackend()).toEqual({ backend: "nutjs", determinant: "env-override" });
  });

  it("ignores an unknown env value, says so once, and keeps the capability answer", () => {
    process.env.DESKTOP_TOUCH_CAPTURE_BACKEND = "wgc";
    expect(selectCaptureBackend().backend).toBe("gdi-bitblt");
    selectCaptureBackend();
    selectCaptureBackend();
    const ignored = captureEvents("backend_override_ignored");
    expect(ignored).toHaveLength(1);
    expect(String(ignored[0]!.reason)).toContain("DESKTOP_TOUCH_CAPTURE_BACKEND");
  });

  // The whole boundary design rests on the backend being fixed for the life of
  // the process: a mid-session switch would hand a rectangle validated against
  // the virtual screen to a library that only accepts the primary monitor.
  it("decides once — a later env change does not move the process", () => {
    expect(selectCaptureBackend().backend).toBe("gdi-bitblt");
    process.env.DESKTOP_TOUCH_CAPTURE_BACKEND = "nutjs";
    expect(selectCaptureBackend().backend).toBe("gdi-bitblt");
  });

  it("records the chosen backend once so a capture can be attributed to it", () => {
    selectCaptureBackend();
    selectCaptureBackend();
    expect(captureEvents("backend_selected")).toHaveLength(1);
  });
});

describe("resolveCaptureRegion", () => {
  it("spans every monitor on the native path, negative origins included", () => {
    expect(resolveCaptureRegion()).toEqual({
      kind: "virtual-rect",
      rect: { x: -1920, y: 0, width: 3840, height: 1080 },
      // The individual rectangles come back too: the bounding one cannot tell
      // "on a monitor" from "in the gap between two of them".
      monitors: [PRIMARY, LEFT],
    });
  });

  it("stops at the primary monitor on a build without the capture binding", () => {
    hoisted.state.nativeCapture = false;
    expect(resolveCaptureRegion()).toEqual({
      kind: "primary-rect",
      rect: PRIMARY,
      monitors: [PRIMARY],
    });
  });

  // The boundary follows the backend, whichever of the two determinants put the
  // process there — otherwise the env override would create a process that
  // validates against an area it cannot read.
  it("stops at the primary monitor when the env override forces nut.js", () => {
    process.env.DESKTOP_TOUCH_CAPTURE_BACKEND = "nutjs";
    expect(resolveCaptureRegion()).toEqual({
      kind: "primary-rect",
      rect: PRIMARY,
      monitors: [PRIMARY],
    });
  });

  it("reports unknown, once, when no monitor is enumerated", () => {
    hoisted.state.monitors = [];
    expect(resolveCaptureRegion()).toBeNull();
    expect(resolveCaptureRegion()).toBeNull();
    expect(captureEvents("bounds_unknown")).toHaveLength(1);
  });

  // `enumMonitors` throws on a build without the native addon. That must arrive
  // as "unknown", not as an exception crossing the resolver.
  it("turns an enumeration failure into unknown rather than letting it throw", () => {
    hoisted.state.enumThrows = true;
    expect(() => resolveCaptureRegion()).not.toThrow();
    expect(resolveCaptureRegion()).toBeNull();
  });

  it("does the same on the nut.js path, where the primary lookup throws", () => {
    hoisted.state.nativeCapture = false;
    hoisted.state.enumThrows = true;
    expect(resolveCaptureRegion()).toBeNull();
  });

  // Deliberately un-cached, unlike the cursor resolver: one capture asks once,
  // and a stale layout would be worse than the enumeration it saves.
  it("reads the layout on every call", () => {
    selectCaptureBackend();
    hoisted.enumCalls.n = 0;
    resolveCaptureRegion();
    resolveCaptureRegion();
    resolveCaptureRegion();
    expect(hoisted.enumCalls.n).toBe(3);
  });
});

describe("isCaptureRegionInBounds", () => {
  const virtual = {
    kind: "virtual-rect",
    rect: { x: -1920, y: 0, width: 3840, height: 1080 },
    monitors: [PRIMARY, LEFT],
  } as const;
  const primary = { kind: "primary-rect", rect: PRIMARY, monitors: [PRIMARY] } as const;

  it("accepts a region on the monitor left of the primary one", () => {
    expect(isCaptureRegionInBounds({ x: -1920, y: 0, width: 1920, height: 1080 }, virtual)).toBe(true);
  });

  it("accepts a region straddling two monitors", () => {
    expect(isCaptureRegionInBounds({ x: -200, y: 100, width: 600, height: 400 }, virtual)).toBe(true);
  });

  it("rejects a region that runs past the edge — containment, not overlap", () => {
    expect(isCaptureRegionInBounds({ x: -2000, y: 0, width: 400, height: 400 }, virtual)).toBe(false);
    expect(isCaptureRegionInBounds({ x: 1800, y: 0, width: 400, height: 400 }, virtual)).toBe(false);
    expect(isCaptureRegionInBounds({ x: 0, y: 900, width: 400, height: 400 }, virtual)).toBe(false);
  });

  it("rejects the same negative region on a nut.js process", () => {
    expect(isCaptureRegionInBounds({ x: -1920, y: 0, width: 1920, height: 1080 }, primary)).toBe(false);
  });

  // Unknown means "cannot judge", not "block": a machine whose enumeration
  // fails keeps taking screenshots.
  it("allows anything when the layout is unknown", () => {
    expect(isCaptureRegionInBounds({ x: -9999, y: -9999, width: 100, height: 100 }, null)).toBe(true);
  });
});

// Round 1 (Opus P1 / Codex P2) — the bounding rectangle answered two different
// questions with one number, and both answers were wrong at the edges:
//
//   - a rectangle in the GAP of a staggered layout is inside the bounding
//     rectangle and on no monitor. BitBlt fills it with black and the caller is
//     told the capture succeeded. Nothing else on this path notices — the
//     blank-capture check belongs to the per-window ladder.
//   - a WINDOW's rectangle routinely leaves the bounding rectangle: Windows
//     reports a maximised window ~8px outside its monitor on every side (the
//     invisible resize border). Those were refused outright, though BitBlt
//     captures them fine with a black border.
describe("isCaptureRegionInBounds — the two modes", () => {
  // Staggered: the second monitor sits to the right AND 600px lower, so the
  // rectangle x∈[1920, 3840), y∈[0, 600) is desktop-shaped emptiness.
  const TOP_LEFT = { x: 0, y: 0, width: 1920, height: 1080 };
  const LOW_RIGHT = { x: 1920, y: 600, width: 1920, height: 1080 };
  const staggered = {
    kind: "virtual-rect",
    rect: { x: 0, y: 0, width: 3840, height: 1680 },
    monitors: [TOP_LEFT, LOW_RIGHT],
  } as const;
  /** nut.js layout: the primary monitor is the whole capturable area. */
  const primaryOnly = { kind: "primary-rect", rect: PRIMARY, monitors: [PRIMARY] } as const;

  const IN_THE_GAP = { x: 2000, y: 100, width: 400, height: 300 };
  const ACROSS_THE_SEAM = { x: 1500, y: 300, width: 1000, height: 500 };
  /** A maximised window as GetWindowRect reports it: 8px out on every side. */
  const MAXIMISED_WINDOW = { x: -8, y: -8, width: 1936, height: 1096 };
  const NOWHERE = { x: 5000, y: 5000, width: 800, height: 600 };

  it("refuses a caller's region that falls entirely in the gap between two monitors", () => {
    // Inside the bounding rectangle — containment alone would wave it through.
    expect(isCaptureRegionInBounds(IN_THE_GAP, staggered, "contain")).toBe(false);
  });

  it("still accepts a region spanning both monitors, gap and all", () => {
    // The gap is only a refusal when the WHOLE region sits in it: a rectangle
    // covering real content on both monitors is exactly what a seam-spanning
    // capture is for, and the black wedge between them is the desktop.
    expect(isCaptureRegionInBounds(ACROSS_THE_SEAM, staggered, "contain")).toBe(true);
  });

  it("accepts a maximised window's rect in overlap mode, and refuses it in contain mode", () => {
    expect(isCaptureRegionInBounds(MAXIMISED_WINDOW, staggered, "overlap")).toBe(true);
    // The contain half is what made this a bug report: the same rectangle,
    // judged as if the caller had named it, is outside the desktop.
    expect(isCaptureRegionInBounds(MAXIMISED_WINDOW, staggered, "contain")).toBe(false);
  });

  it("refuses a window rect that is on no monitor at all, even in overlap mode", () => {
    // Overlap is a relaxation, not a bypass: a window whose coordinates are
    // stale still has to be refused, or the capture answers with black.
    expect(isCaptureRegionInBounds(NOWHERE, staggered, "overlap")).toBe(false);
    expect(isCaptureRegionInBounds(IN_THE_GAP, staggered, "overlap")).toBe(false);
  });

  it("defaults to contain, so an un-annotated caller keeps the strict rule", () => {
    expect(isCaptureRegionInBounds(MAXIMISED_WINDOW, staggered)).toBe(false);
    expect(isCaptureRegionInBounds(IN_THE_GAP, staggered)).toBe(false);
  });

  it("applies both modes the same way on the single-monitor nut.js resolution", () => {
    expect(isCaptureRegionInBounds(MAXIMISED_WINDOW, primaryOnly, "overlap")).toBe(true);
    expect(isCaptureRegionInBounds(MAXIMISED_WINDOW, primaryOnly, "contain")).toBe(false);
    expect(isCaptureRegionInBounds({ x: -1920, y: 0, width: 1920, height: 1080 }, primaryOnly, "overlap")).toBe(false);
    expect(isCaptureRegionInBounds({ x: 10, y: 10, width: 100, height: 100 }, primaryOnly, "contain")).toBe(true);
  });

  it("cannot judge an unknown layout in either mode", () => {
    expect(isCaptureRegionInBounds(NOWHERE, null, "contain")).toBe(true);
    expect(isCaptureRegionInBounds(NOWHERE, null, "overlap")).toBe(true);
  });

  it("a rectangle that only touches a monitor's edge shares no pixels with it", () => {
    // Zero-area contact is not coverage: a capture there is all black.
    expect(isCaptureRegionInBounds({ x: 1920, y: 0, width: 80, height: 600 }, staggered, "overlap")).toBe(false);
    expect(isCaptureRegionInBounds({ x: 1919, y: 0, width: 80, height: 600 }, staggered, "overlap")).toBe(true);
  });
});

describe("assertCaptureRegionInBounds — capability-variant wording", () => {
  const offscreen = { x: -1920, y: 0, width: 1920, height: 1080 };

  const refusalFor = (): Error => {
    try {
      assertCaptureRegionInBounds(offscreen, resolveCaptureRegion());
    } catch (e) {
      return e as Error;
    }
    throw new Error("expected a refusal");
  };

  it("blames stale coordinates on the native path, where every monitor is capturable", () => {
    hoisted.state.monitors = [PRIMARY];
    const err = refusalFor();
    expect(err.name).toBe("RegionOutsideCapturableBounds");
    expect(err.message).toContain("1920x1080 at (-1920, 0)");
    expect(err.message).toMatch(/stale/);
    expect(err.message).toMatch(/desktop_discover/);
  });

  it("names the missing module when that is what limits the process", () => {
    hoisted.state.nativeCapture = false;
    const err = refusalFor();
    expect(err.message).toContain("built-in Windows capture module");
    expect(err.message).toContain("primary monitor");
    expect(err.message).not.toContain("DESKTOP_TOUCH_CAPTURE_BACKEND");
  });

  it("names the env override when that is what limits the process", () => {
    process.env.DESKTOP_TOUCH_CAPTURE_BACKEND = "nutjs";
    const err = refusalFor();
    expect(err.message).toContain("DESKTOP_TOUCH_CAPTURE_BACKEND");
    expect(err.message).not.toContain("built-in Windows capture module");
  });

  it("says nothing at all for a region that is in bounds", () => {
    expect(() =>
      assertCaptureRegionInBounds({ x: 0, y: 0, width: 100, height: 100 }, resolveCaptureRegion()),
    ).not.toThrow();
  });
});

describe("ADR-031 typed codes classify with recovery advice", () => {
  it("RegionOutsideCapturableBounds survives failWith and keeps its advice", () => {
    hoisted.state.nativeCapture = false;
    let thrown: unknown;
    try {
      assertCaptureRegionInBounds({ x: -1920, y: 0, width: 1920, height: 1080 }, resolveCaptureRegion());
    } catch (e) {
      thrown = e;
    }
    const body = JSON.parse(failWith(thrown as Error, "screenshot").content[0]!.text);
    expect(body.code).toBe("RegionOutsideCapturableBounds");
    expect(body.suggest.join(" ")).toMatch(/stale|primary monitor/i);
  });

  it("CaptureBackendFailed leads with the per-window route, not with re-discovery", () => {
    const body = JSON.parse(
      failWith(
        new Error("CaptureBackendFailed: the built-in Windows screen-capture backend could not read the primary monitor: GetDC failed"),
        "screenshot",
      ).content[0]!.text,
    );
    expect(body.code).toBe("CaptureBackendFailed");
    expect(body.suggest[0]).toMatch(/windowTitle/);
    expect(body.suggest[0]).not.toMatch(/desktop_discover/);
  });

  // Same ordering defence as the ADR-029 pair: both messages name a window, a
  // monitor layout or a remote session, so a later generic arm could poach them
  // in the shapes that reach the substring cascade.
  it("both codes win over the generic classify arms", () => {
    for (const code of ["RegionOutsideCapturableBounds", "CaptureBackendFailed"]) {
      for (const suffix of ["window not found", "timed out", "element not found"]) {
        for (const prefix of ["", "wrapped: "]) {
          const body = JSON.parse(
            failWith(new Error(`${prefix}${code}: something … ${suffix}`), "screenshot").content[0]!.text,
          );
          expect(body.code, `${code} poached by "${suffix}" (prefix "${prefix}")`).toBe(code);
        }
      }
    }
  });
});

// ADR-031 §2(d) — the `Math.max(0, …)` this replaced assumed the desktop starts
// at the origin. On the left-hand monitor it silently pulled the capture onto
// the primary one and returned that as the element: a picture of somewhere
// else, presented as a success.
describe("padCaptureRegion", () => {
  const virtual = {
    kind: "virtual-rect",
    rect: { x: -1920, y: 0, width: 3840, height: 1080 },
    monitors: [PRIMARY, LEFT],
  } as const;
  const primary = { kind: "primary-rect", rect: PRIMARY, monitors: [PRIMARY] } as const;

  it("adds the padding when there is room for it", () => {
    expect(padCaptureRegion({ x: 500, y: 400, width: 100, height: 50 }, 20, virtual)).toEqual({
      x: 480,
      y: 380,
      width: 140,
      height: 90,
    });
  });

  it("trims only the overhang when the element sits against the edge", () => {
    // Flush with the left edge of the left-hand monitor: the padding overhangs
    // by 20px, the element does not move.
    expect(padCaptureRegion({ x: -1920, y: 0, width: 100, height: 50 }, 20, virtual)).toEqual({
      x: -1920,
      y: 0,
      width: 120,
      height: 70,
    });
  });

  it("leaves an element outside the capturable area exactly where it is", () => {
    // A nut.js process cannot read the left-hand monitor. Pulling this region
    // to x=0 would answer with the primary monitor's pixels.
    expect(padCaptureRegion({ x: -1000, y: 400, width: 100, height: 50 }, 20, primary)).toEqual({
      x: -1020,
      y: 380,
      width: 140,
      height: 90,
    });
  });

  it("clamps nothing when the layout is unknown, matching the unchecked capture", () => {
    expect(padCaptureRegion({ x: -1000, y: 400, width: 100, height: 50 }, 20, null)).toEqual({
      x: -1020,
      y: 380,
      width: 140,
      height: 90,
    });
  });
});
