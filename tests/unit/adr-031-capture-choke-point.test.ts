/**
 * ADR-031 §2(c) — the capture choke point in `engine/image.ts`.
 *
 * Two properties are being pinned here, and neither survives being checked at
 * the `screenshot` tool entry instead:
 *
 *   1. every absolute-coordinate read of the screen is validated and its
 *      failures are typed — including the reads through `captureDisplay`,
 *      `ui-elements` and `workspace`, whose callers swallow the exception; and
 *   2. the backend never changes mid-call. A native failure surfaces as a typed
 *      error; it does not quietly retry through nut.js, which would hand a
 *      rectangle validated against the virtual screen to a library that only
 *      accepts the primary monitor.
 *
 * The diagnostic-log assertions are part of (1): those two callers keep their
 * `catch {}`, so the log record written HERE is the only trace the failure
 * leaves at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hoisted = vi.hoisted(() => ({
  state: {
    nativeCapture: true,
    monitors: [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: -1920, y: 0, width: 1920, height: 1080 },
    ] as { x: number; y: number; width: number; height: number }[],
    /** Make the primary lookup fail — `null` (no primary) or a throw. */
    primaryFailure: null as null | "null" | "throw",
    /** Make the native capture binding throw. */
    nativeThrows: false,
    /** Make the nut.js grab throw. */
    nutjsThrows: false,
    /** What the nut.js backend reports as the primary screen size, or null. */
    nutScreenSize: { width: 1920, height: 1080 } as { width: number; height: number } | null,
  },
  calls: {
    native: [] as { x: number; y: number; width: number; height: number }[],
    nutGrab: 0,
    nutGrabRegion: [] as { x: number; y: number; width: number; height: number }[],
  },
  events: [] as Record<string, unknown>[],
}));

vi.mock("../../src/engine/native-engine.js", () => ({
  nativeWin32: {},
  nativeEngine: null,
  hasNativeCursorMove: () => true,
  hasNativeCaptureRegion: () => hoisted.state.nativeCapture,
  // This file exercises whole-addon-present / whole-addon-absent builds only —
  // it asserts routing and diagnostics, never the wording of the advice — so
  // the two capture bindings move together here. The resolver test is where
  // they are driven apart.
  hasNativePerWindowCapture: () => hoisted.state.nativeCapture,
}));

vi.mock("../../src/engine/win32.js", () => ({
  enumMonitors: () => hoisted.state.monitors.map((bounds, i) => ({ primary: i === 0, bounds })),
  getPrimaryMonitorBounds: () => {
    if (hoisted.state.primaryFailure === "throw") throw new Error("EnumDisplayMonitors failed");
    if (hoisted.state.primaryFailure === "null") return null;
    return hoisted.state.monitors[0] ?? null;
  },
  captureScreenRegion: (region: { x: number; y: number; width: number; height: number }) => {
    hoisted.calls.native.push(region);
    if (hoisted.state.nativeThrows) throw new Error("BitBlt failed: access denied");
    return {
      data: Buffer.alloc(region.width * region.height * 4, 0x40),
      width: region.width,
      height: region.height,
    };
  },
  printWindowToBuffer: () => {
    throw new Error("not used in these tests");
  },
  captureWindowWgc: () => {
    throw new Error("not used in these tests");
  },
  canCaptureWindowViaWgc: () => false,
}));

const fakeImage = (width: number, height: number) => ({
  toRGB: async () => ({
    data: Buffer.alloc(width * height * 3, 0x20),
    width,
    height,
    hasAlphaChannel: false,
  }),
});

vi.mock("../../src/engine/nutjs.js", () => ({
  screen: {
    grab: async () => {
      hoisted.calls.nutGrab++;
      if (hoisted.state.nutjsThrows) throw new Error("Error: x coordinate outside of display");
      return fakeImage(1920, 1080);
    },
    grabRegion: async (r: { x: number; y: number; width: number; height: number }) => {
      hoisted.calls.nutGrabRegion.push(r);
      if (hoisted.state.nutjsThrows) throw new Error("Error: x coordinate outside of display");
      return fakeImage(r.width, r.height);
    },
  },
  Region: class {
    constructor(
      public x: number,
      public y: number,
      public width: number,
      public height: number,
    ) {}
  },
  getPrimaryScreenSize: async () => hoisted.state.nutScreenSize,
}));

vi.mock("../../src/engine/diagnostic-log.js", () => ({
  logDiagnostic: (e: Record<string, unknown>) => {
    hoisted.events.push(e);
  },
}));

import { grabScreenRegionValidated, captureScreen, captureDisplay } from "../../src/engine/image.js";
import { _resetCaptureBackendForTests } from "../../src/engine/reachable-bounds.js";

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 };
const ON_LEFT_MONITOR = { x: -1500, y: 200, width: 400, height: 300 };
const OFF_EVERY_MONITOR = { x: -5000, y: 200, width: 400, height: 300 };
/** A second monitor to the right AND 600px lower, leaving a hole above it. */
const STAGGERED_TOP_LEFT = { x: 0, y: 0, width: 1920, height: 1080 };
const STAGGERED_LOW_RIGHT = { x: 1920, y: 600, width: 1920, height: 1080 };
/** Inside the desktop's bounding box, on neither monitor. */
const IN_THE_GAP = { x: 2000, y: 100, width: 400, height: 300 };
/** A maximised window as GetWindowRect reports it: 8px out on every side. */
const MAXIMISED_WINDOW = { x: -8, y: -8, width: 1936, height: 1096 };

const eventsOfKind = (event: string) => hoisted.events.filter((e) => e.event === event);

/** Run `fn` and hand back whatever it threw. */
async function thrownBy(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  delete process.env.DESKTOP_TOUCH_CAPTURE_BACKEND;
  hoisted.state.nativeCapture = true;
  hoisted.state.monitors = [PRIMARY, { x: -1920, y: 0, width: 1920, height: 1080 }];
  hoisted.state.primaryFailure = null;
  hoisted.state.nativeThrows = false;
  hoisted.state.nutjsThrows = false;
  hoisted.state.nutScreenSize = { width: 1920, height: 1080 };
  hoisted.calls.native.length = 0;
  hoisted.calls.nutGrab = 0;
  hoisted.calls.nutGrabRegion.length = 0;
  hoisted.events.length = 0;
  _resetCaptureBackendForTests();
});

describe("capture choke point — backend dispatch", () => {
  it("reads a region on the left-hand monitor natively, and does not touch nut.js", async () => {
    const raw = await grabScreenRegionValidated(ON_LEFT_MONITOR);
    expect(hoisted.calls.native).toEqual([ON_LEFT_MONITOR]);
    expect(hoisted.calls.nutGrab + hoisted.calls.nutGrabRegion.length).toBe(0);
    expect(raw).toMatchObject({ width: 400, height: 300, channels: 4 });
  });

  it("uses nut.js on a build without the capture binding", async () => {
    hoisted.state.nativeCapture = false;
    const raw = await grabScreenRegionValidated({ x: 10, y: 20, width: 100, height: 50 });
    expect(hoisted.calls.nutGrabRegion).toEqual([{ x: 10, y: 20, width: 100, height: 50 }]);
    expect(hoisted.calls.native).toEqual([]);
    expect(raw.channels).toBe(3);
  });

  // The strict rule of §2(b): a native failure is a typed error, full stop.
  // Falling back per call would only change the shape of the failure — both
  // backends read the desktop through the same GDI surface — while breaking the
  // boundary design and the dimension stability frame diffing depends on.
  it("surfaces a native failure as CaptureBackendFailed without retrying through nut.js", async () => {
    hoisted.state.nativeThrows = true;
    const err = await thrownBy(() => grabScreenRegionValidated(ON_LEFT_MONITOR));
    expect(err.name).toBe("CaptureBackendFailed");
    expect(err.message).toContain("BitBlt failed");
    expect(hoisted.calls.nutGrab + hoisted.calls.nutGrabRegion.length).toBe(0);
  });

  it("wraps a nut.js failure in the same typed error rather than letting libnut through", async () => {
    hoisted.state.nativeCapture = false;
    hoisted.state.nutjsThrows = true;
    const err = await thrownBy(() => grabScreenRegionValidated({ x: 0, y: 0, width: 100, height: 100 }));
    expect(err.name).toBe("CaptureBackendFailed");
    expect(err.message).toContain("x coordinate outside of display");
  });
});

describe("capture choke point — bounds", () => {
  it("refuses a region that is on no monitor at all", async () => {
    const err = await thrownBy(() => grabScreenRegionValidated(OFF_EVERY_MONITOR));
    expect(err.name).toBe("RegionOutsideCapturableBounds");
    expect(hoisted.calls.native).toEqual([]);
  });

  // The case from the dogfood report: the region IS on a monitor, but a nut.js
  // process cannot read that monitor. Without this check the rectangle reaches
  // libnut and comes back as "x coordinate outside of display".
  it("refuses a region on a non-primary monitor when the process captures via nut.js", async () => {
    hoisted.state.nativeCapture = false;
    const err = await thrownBy(() => grabScreenRegionValidated(ON_LEFT_MONITOR));
    expect(err.name).toBe("RegionOutsideCapturableBounds");
    expect(err.message).toContain("built-in Windows capture module");
    expect(hoisted.calls.nutGrabRegion).toEqual([]);
  });

  // Fail-open: a machine whose enumeration fails keeps taking screenshots. The
  // region goes through unchecked and an off-screen one comes back black with
  // nothing to announce it — the blank-capture check lives on the per-window
  // ladder, not here — which is the acknowledged price of staying usable.
  // "Black" is only guaranteed on the native backend, which clears the bitmap
  // before the copy; the nut.js backend does not reach a black frame at all —
  // it throws on any rectangle off the primary monitor, so that process fails
  // loudly instead of returning a silent black image.
  // A build with NO native addon at all is supported, and it is the one build
  // whose capture really is limited to the primary monitor — yet it was the one
  // that could not enforce the limit: every monitor lookup goes through the
  // addon and throws, the resolver called that "unknown" and failed open, and
  // the off-primary region then reached libnut and came back as
  // CaptureBackendFailed. nut.js knows the primary screen size without the
  // addon, so the limitation is enforced from there instead.
  it("still refuses an off-primary region on a build with no native module at all", async () => {
    hoisted.state.nativeCapture = false;
    hoisted.state.primaryFailure = "throw"; // every monitor lookup needs the addon
    const err = await thrownBy(() => grabScreenRegionValidated(ON_LEFT_MONITOR));
    expect(err.name).toBe("RegionOutsideCapturableBounds");
    // The refusal has to happen BEFORE libnut is asked, or the caller gets
    // libnut's throw dressed up as a backend failure instead.
    expect(hoisted.calls.nutGrabRegion).toEqual([]);
    expect(hoisted.calls.nutGrab).toBe(0);
    expect(eventsOfKind("bounds_from_nutjs")).toHaveLength(1);
    // Bounds were recovered and the region WAS checked, so nothing failed open
    // here — recording it would contradict the refusal above and would spend
    // the warn-once latch that a genuine unknown needs.
    expect(eventsOfKind("bounds_unknown")).toHaveLength(0);
  });

  // The contrast: when nut.js cannot report a size either, nothing is known
  // and the long-standing fail-open stance is unchanged.
  it("still fails open when nut.js cannot report a screen size either", async () => {
    hoisted.state.nativeCapture = false;
    hoisted.state.primaryFailure = "throw";
    hoisted.state.nutScreenSize = null;
    await grabScreenRegionValidated(ON_LEFT_MONITOR);
    expect(hoisted.calls.nutGrabRegion).toEqual([ON_LEFT_MONITOR]);
    expect(eventsOfKind("bounds_from_nutjs")).toHaveLength(0);
    // No route left, so failing open is final here — and this is the one place
    // it gets written down.
    expect(eventsOfKind("bounds_unknown")).toHaveLength(1);
  });

  it("passes a region through unchecked when the layout cannot be read", async () => {
    hoisted.state.monitors = [];
    await grabScreenRegionValidated(OFF_EVERY_MONITOR);
    expect(hoisted.calls.native).toEqual([OFF_EVERY_MONITOR]);
  });

  it("goes through the same check when the caller came in via captureDisplay", async () => {
    hoisted.state.nativeCapture = false;
    const err = await thrownBy(() => captureDisplay(ON_LEFT_MONITOR));
    expect(err.name).toBe("RegionOutsideCapturableBounds");
  });

  // Round 1 (Opus P1 / Codex P2). The two failures the single containment test
  // above could not tell apart, one on each side of the boundary.
  it("refuses a caller's region lying in the gap of a staggered layout", async () => {
    hoisted.state.monitors = [STAGGERED_TOP_LEFT, STAGGERED_LOW_RIGHT];
    const err = await thrownBy(() => grabScreenRegionValidated(IN_THE_GAP));
    expect(err.name).toBe("RegionOutsideCapturableBounds");
    // The point: the rectangle IS inside the desktop's bounding box. Without
    // the per-monitor half it would have reached BitBlt and come back a black
    // image reported as a successful capture.
    expect(hoisted.calls.native).toEqual([]);
  });

  it("hands a maximised window's rect to the backend unchanged in overlap mode", async () => {
    hoisted.state.monitors = [PRIMARY];
    await grabScreenRegionValidated(MAXIMISED_WINDOW, "overlap");
    // Unchanged, not clamped: the buffer must keep the window's own dimensions
    // because the caller's crop is expressed in window-local coordinates.
    expect(hoisted.calls.native).toEqual([MAXIMISED_WINDOW]);
  });

  it("refuses that same rect when the caller named it rather than Windows", async () => {
    hoisted.state.monitors = [PRIMARY];
    const err = await thrownBy(() => grabScreenRegionValidated(MAXIMISED_WINDOW));
    expect(err.name).toBe("RegionOutsideCapturableBounds");
    expect(hoisted.calls.native).toEqual([]);
  });

  it("refuses a window rect that is on no monitor, overlap mode or not", async () => {
    hoisted.state.monitors = [PRIMARY];
    const err = await thrownBy(() => grabScreenRegionValidated(OFF_EVERY_MONITOR, "overlap"));
    expect(err.name).toBe("RegionOutsideCapturableBounds");
    expect(hoisted.calls.native).toEqual([]);
  });

  // Round 2 (Opus P2). The relaxation is BitBlt's ability to clip, so it stops
  // where that ability does. libnut throws on any rectangle leaving the primary
  // monitor, and that throw would leave here as `CaptureBackendFailed` —
  // advice about locked screens and UAC prompts for a process whose actual
  // problem is a missing native module. The refusal names that instead.
  it("keeps the containment requirement in overlap mode on the nut.js resolution", async () => {
    hoisted.state.nativeCapture = false;
    hoisted.state.monitors = [PRIMARY];
    const err = await thrownBy(() => grabScreenRegionValidated(MAXIMISED_WINDOW, "overlap"));
    expect(err.name).toBe("RegionOutsideCapturableBounds");
    expect(err.message).toContain("built-in Windows capture module");
    // Never handed to libnut: the whole point is that it cannot clip this.
    expect(hoisted.calls.nutGrabRegion).toEqual([]);
    // Contain mode was already refusing it; both modes agree here.
    const same = await thrownBy(() => grabScreenRegionValidated(MAXIMISED_WINDOW));
    expect(same.name).toBe("RegionOutsideCapturableBounds");
    expect(hoisted.calls.nutGrabRegion).toEqual([]);
  });

  it("still lets a fully-contained rect through on the nut.js resolution in either mode", async () => {
    hoisted.state.nativeCapture = false;
    hoisted.state.monitors = [PRIMARY];
    const inside = { x: 10, y: 20, width: 100, height: 50 };
    await grabScreenRegionValidated(inside, "overlap");
    await grabScreenRegionValidated(inside);
    expect(hoisted.calls.nutGrabRegion).toEqual([inside, inside]);
  });
});

// ADR-031 §2(b) — what "full screen" means is NOT changed by this ADR. The
// pixels now come from BitBlt, the rectangle is still the primary monitor's,
// and it is resolved in TS rather than being re-derived inside the native code,
// so there is one source for that rectangle instead of two that can disagree.
describe("capture choke point — the full-screen contract stays put", () => {
  it("hands the primary monitor's rectangle to the native capture", async () => {
    await grabScreenRegionValidated();
    expect(hoisted.calls.native).toEqual([PRIMARY]);
  });

  it("uses the primary rectangle even when it is not at the origin", async () => {
    const offsetPrimary = { x: 1920, y: 0, width: 2560, height: 1440 };
    hoisted.state.monitors = [offsetPrimary, { x: 0, y: 0, width: 1920, height: 1080 }];
    await grabScreenRegionValidated();
    expect(hoisted.calls.native).toEqual([offsetPrimary]);
  });

  it("still calls plain screen.grab() on the nut.js path", async () => {
    hoisted.state.nativeCapture = false;
    await grabScreenRegionValidated();
    expect(hoisted.calls.nutGrab).toBe(1);
    expect(hoisted.calls.nutGrabRegion).toEqual([]);
  });

  // The single exception to fail-open (§2(c)): with no rectangle there is no
  // call to let through. Inventing one would answer with a picture of an
  // assumed screen.
  it.each(["null", "throw"] as const)(
    "refuses rather than inventing a rectangle when the primary lookup fails (%s)",
    async (mode) => {
      hoisted.state.primaryFailure = mode;
      const err = await thrownBy(() => grabScreenRegionValidated());
      expect(err.name).toBe("CaptureBackendFailed");
      expect(err.message).toContain("monitor enumeration failed");
      expect(hoisted.calls.native).toEqual([]);
    },
  );

  // nut.js `screen.grab()` does not consult the monitor list, so the same
  // machine keeps working there — the availability loss is confined to native
  // processes whose enumeration fails.
  it("keeps working on the nut.js path when enumeration fails", async () => {
    hoisted.state.nativeCapture = false;
    hoisted.state.primaryFailure = "throw";
    await expect(grabScreenRegionValidated()).resolves.toMatchObject({ width: 1920 });
  });
});

describe("capture choke point — the failure reaches the diagnostic log", () => {
  it("records a refused region with the coordinates, the backend and the boundary", async () => {
    hoisted.state.nativeCapture = false;
    await thrownBy(() => grabScreenRegionValidated(ON_LEFT_MONITOR));
    const [record] = eventsOfKind("region_rejected");
    expect(record).toMatchObject({
      kind: "capture",
      backend: "nutjs",
      determinant: "no-native-module",
      region: ON_LEFT_MONITOR,
      bounds: "primary-rect",
      // Which question was asked of those bounds: a refusal under "overlap"
      // means the window rect is on no monitor at all, a different diagnosis
      // from a caller-named region that merely overhangs one.
      mode: "contain",
    });
    expect(String(record!.reason)).toContain("RegionOutsideCapturableBounds");
  });

  it("records the mode when a window rect is refused, so the two diagnoses stay apart", async () => {
    hoisted.state.monitors = [PRIMARY];
    await thrownBy(() => grabScreenRegionValidated(OFF_EVERY_MONITOR, "overlap"));
    const [record] = eventsOfKind("region_rejected");
    expect(record).toMatchObject({ mode: "overlap", region: OFF_EVERY_MONITOR });
  });

  it("records a backend failure with the underlying message", async () => {
    hoisted.state.nativeThrows = true;
    await thrownBy(() => grabScreenRegionValidated(ON_LEFT_MONITOR));
    const [record] = eventsOfKind("backend_failed");
    expect(record).toMatchObject({ kind: "capture", backend: "gdi-bitblt", region: ON_LEFT_MONITOR });
    expect(String(record!.reason)).toContain("BitBlt failed");
  });

  it("records the full-screen enumeration failure too, where there is no region to report", async () => {
    hoisted.state.primaryFailure = "null";
    await thrownBy(() => grabScreenRegionValidated());
    const [record] = eventsOfKind("backend_failed");
    expect(record).toMatchObject({ kind: "capture", backend: "gdi-bitblt" });
    expect(record!.region).toBeUndefined();
    expect(String(record!.reason)).toContain("monitor enumeration failed");
  });

  // The two production callers of `captureScreen` that matter here swallow the
  // exception whole. The record must already exist by the time they do.
  it("has written the record before the exception leaves captureScreen", async () => {
    hoisted.state.nativeCapture = false;
    await captureScreen(ON_LEFT_MONITOR).catch(() => undefined);
    expect(eventsOfKind("region_rejected")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Structural invariant
// ─────────────────────────────────────────────────────────────────────────────
//
// The checks above are worth nothing if some other module reads absolute screen
// coordinates on its own. Enumerating those by hand is how `scroll-capture.ts`
// went unnoticed through the ADR and both of its reviews — so the rule is the
// stronger one: only the choke point may grab the screen, and only twice.
//
// The allowlist is the point. If a future change makes this fail, the fix is to
// route the new caller through `grabScreenRegionValidated`, not to add a site
// here.
describe("screen capture — only the choke point may grab the screen", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
  const CHOKE_POINT = join(SRC, "engine", "image.ts");
  const GRABS_SCREEN = /\bscreen\.(grab|grabRegion)[ \t]*\(/g;
  // Round 1 (Opus P2-3): nut.js is no longer the only way to read absolute
  // screen pixels — the native binding is the DEFAULT one, and the pattern
  // above cannot see it. Matching the bare identifier (not a call) is
  // deliberate: a module that merely IMPORTS the binding has already left the
  // choke point behind, and the import line is where that starts.
  //
  // Round 2 (Opus P3a): the raw napi export is named too. `win32.ts` wraps it,
  // but nothing stops a module reaching past that wrapper with
  // `nativeWin32.win32CaptureScreenRegion!(…)` — one property access, no
  // import of the wrapper, invisible to the first half of this pattern.
  const NATIVE_GRAB = /(?<!`)\b(?:captureScreenRegion|win32CaptureScreenRegion)\b(?!`)/g;
  // The three legitimate homes, enumerated by reading them rather than by
  // assuming symmetry: `image.ts` is the choke point (import + call),
  // `win32.ts` is the wrapper (definition + the one raw-binding call), and
  // `native-engine.ts` declares the binding's type and probes for its
  // presence. Prose elsewhere writes the name in backticks, which the pattern
  // excludes.
  const NATIVE_WRAPPER = join(SRC, "engine", "win32.ts");
  const NATIVE_BINDING_HOST = join(SRC, "engine", "native-engine.ts");

  function tsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return tsFiles(p);
      return e.isFile() && e.name.endsWith(".ts") ? [p] : [];
    });
  }
  const rel = (f: string) => f.replace(SRC, "src");

  // A rule that cannot match its own subject reads as coverage while proving
  // nothing.
  it("recognises a grab without flagging the surrounding prose", () => {
    expect(new RegExp(GRABS_SCREEN.source).test("const image = await screen.grab();")).toBe(true);
    expect(new RegExp(GRABS_SCREEN.source).test("await screen.grabRegion(new Region(x, y, w, h))")).toBe(true);
    // Prose naming the API, and the nut.js module's own re-export, are not calls.
    expect(new RegExp(GRABS_SCREEN.source).test("// `screen.grabRegion` of the window rect")).toBe(false);
    expect(new RegExp(GRABS_SCREEN.source).test("import { screen } from './nutjs.js';")).toBe(false);
  });

  // Same self-check for the native pattern, and the reason it is looser: the
  // IMPORT is the violation, so the call parentheses are not required. Only
  // backticked prose is exempt.
  it("recognises the native binding by import, by call, and by raw property access", () => {
    const fresh = () => new RegExp(NATIVE_GRAB.source);
    expect(fresh().test('import { captureScreenRegion } from "../engine/win32.js";')).toBe(true);
    expect(fresh().test("const shot = captureScreenRegion(target);")).toBe(true);
    // The wrapper-bypass shape: no import of win32.ts at all.
    expect(fresh().test("nativeWin32.win32CaptureScreenRegion!(x, y, w, h);")).toBe(true);
    expect(fresh().test("// `captureScreenRegion` reads the virtual desktop")).toBe(false);
    expect(fresh().test("/** result of `win32CaptureScreenRegion` */")).toBe(false);
  });

  it("no file other than image.ts grabs the screen", () => {
    const grabbers = tsFiles(SRC).filter(
      (f) => f !== CHOKE_POINT && new RegExp(GRABS_SCREEN.source).test(readFileSync(f, "utf8")),
    );
    expect(grabbers.map(rel)).toEqual([]);
  });

  it("no file other than image.ts and the binding wrapper touches the native capture", () => {
    const allowed = new Set([CHOKE_POINT, NATIVE_WRAPPER, NATIVE_BINDING_HOST]);
    const users = tsFiles(SRC).filter(
      (f) => !allowed.has(f) && new RegExp(NATIVE_GRAB.source).test(readFileSync(f, "utf8")),
    );
    expect(
      users.map(rel),
      "route the new caller through grabScreenRegionValidated instead of adding it here",
    ).toEqual([]);
  });

  it("image.ts grabs the screen in exactly the two places inside the helper", () => {
    // Normalised: the repo checks out with CRLF on Windows, and the
    // end-of-function marker below is anchored on a bare newline.
    const src = readFileSync(CHOKE_POINT, "utf8").replace(/\r\n/g, "\n");
    const start = src.indexOf("export async function grabScreenRegionValidated(");
    expect(start, "the choke-point helper was renamed — update this invariant").toBeGreaterThan(-1);
    // The helper ends at the first closing brace in column 0 after its start.
    const end = src.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const helper = src.slice(start, end);

    const inFile = [...src.matchAll(GRABS_SCREEN)].map((m) => m[0]);
    const inHelper = [...helper.matchAll(GRABS_SCREEN)].map((m) => m[0]);
    expect(inFile).toHaveLength(2);
    expect(inHelper.sort()).toEqual(["screen.grab(", "screen.grabRegion("]);
  });
});
