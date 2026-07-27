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
  // region goes through unchecked and an off-screen one comes back black, which
  // the blank-capture detector already hedges.
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
    });
    expect(String(record!.reason)).toContain("RegionOutsideCapturableBounds");
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

  it("no file other than image.ts grabs the screen", () => {
    const grabbers = tsFiles(SRC).filter(
      (f) => f !== CHOKE_POINT && new RegExp(GRABS_SCREEN.source).test(readFileSync(f, "utf8")),
    );
    expect(grabbers.map(rel)).toEqual([]);
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
