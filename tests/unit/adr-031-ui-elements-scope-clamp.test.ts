/**
 * ADR-031 §2(d) — `scope_element`'s capture region.
 *
 * The padding around the element used to be clamped with `Math.max(0, …)` on
 * both axes, which assumes the desktop starts at (0, 0). On a monitor placed
 * left of the primary one that assumption pulls the capture onto the primary
 * monitor and returns a picture of somewhere else as if it were the element —
 * the same class of failure the ADR is about.
 *
 * The replacement keeps two behaviours apart, and this pins both:
 *   - element inside the capturable area → trim the padding overhang only;
 *   - element outside it → change nothing, let the capture be refused, and
 *     continue with text alone. A degraded answer that says less is better
 *     than a confident answer about the wrong pixels.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  state: { nativeCapture: true },
  monitors: [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: -1920, y: 0, width: 1920, height: 1080 },
  ],
  captured: [] as { x: number; y: number; width: number; height: number }[],
}));

// Partial: `uia-bridge` reaches for other exports of this module, and the
// only thing this test needs to steer is the capture capability.
vi.mock("../../src/engine/native-engine.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/native-engine.js")>(
    "../../src/engine/native-engine.js",
  );
  return { ...actual, hasNativeCaptureRegion: () => hoisted.state.nativeCapture };
});
vi.mock("../../src/engine/win32.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/win32.js")>(
    "../../src/engine/win32.js",
  );
  return {
    ...actual,
    enumMonitors: () => hoisted.monitors.map((bounds, i) => ({ primary: i === 0, bounds })),
    getPrimaryMonitorBounds: () => hoisted.monitors[0],
  };
});
vi.mock("../../src/engine/diagnostic-log.js", () => ({ logDiagnostic: () => undefined }));

// Pre-emptive, not currently reached: `resolveCaptureRegionAsync` consults the
// nut.js backend for a primary screen size when monitor enumeration yields
// nothing. The win32 mock below still returns bounds, so that path is dormant
// — but if it ever stops doing so, the real nut.js module would load its
// native backend inside a unit test. One line keeps that from happening
// silently.
vi.mock("../../src/engine/nutjs.js", () => ({
  getPrimaryScreenSize: async () => null,
}));

// The capture itself is the choke point's job and is pinned by its own tests;
// here it only has to record what it was asked for and refuse what the real
// one would refuse.
vi.mock("../../src/engine/image.js", () => ({
  captureScreen: async (region: { x: number; y: number; width: number; height: number }) => {
    hoisted.captured.push(region);
    const bounds = hoisted.state.nativeCapture
      ? { x: -1920, y: 0, width: 3840, height: 1080 }
      : hoisted.monitors[0]!;
    const inside =
      region.x >= bounds.x &&
      region.y >= bounds.y &&
      region.x + region.width <= bounds.x + bounds.width &&
      region.y + region.height <= bounds.y + bounds.height;
    if (!inside) throw new Error("RegionOutsideCapturableBounds: refused by the choke point");
    return { base64: "ZmFrZQ==", width: region.width, height: region.height, mimeType: "image/png" as const };
  },
}));

vi.mock("../../src/engine/uia-bridge.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/uia-bridge.js")>(
    "../../src/engine/uia-bridge.js",
  );
  return {
    ...actual,
    getUiElements: vi.fn(),
    clickElement: vi.fn(),
    setElementValue: vi.fn(),
    insertTextViaTextPattern2: vi.fn(),
    getElementBounds: vi.fn(),
    getElementChildren: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: vi.fn().mockResolvedValue({ title: "TestApp", warnings: [] }),
}));
vi.mock("../../src/engine/perception/registry.js", () => ({
  evaluatePreToolGuards: vi.fn(),
  buildEnvelopeFor: vi.fn().mockReturnValue(undefined),
}));
vi.mock("../../src/tools/_action-guard.js", () => ({
  isAutoGuardEnabled: vi.fn().mockReturnValue(false),
  runActionGuard: vi.fn(),
  validateAndPrepareFix: vi.fn(),
  consumeFix: vi.fn(),
}));
vi.mock("../../src/engine/identity-tracker.js", () => ({
  buildHintsForTitle: vi.fn().mockReturnValue(null),
  observeTarget: vi.fn(),
  toTargetHints: vi.fn().mockReturnValue({}),
  buildCacheStateHints: vi.fn().mockReturnValue({}),
}));

import { scopeElementHandler } from "../../src/tools/ui-elements.js";
import { getElementBounds } from "../../src/engine/uia-bridge.js";
import { _resetCaptureBackendForTests } from "../../src/engine/reachable-bounds.js";

const ARGS = {
  windowTitle: "TestApp",
  name: "Save",
  automationId: undefined,
  controlType: undefined,
  hwnd: undefined,
  maxDepth: 3,
  maxElements: 20,
  padding: 20,
};

const scopeWith = async (boundingRect: { x: number; y: number; width: number; height: number }) => {
  vi.mocked(getElementBounds).mockResolvedValue({
    name: "Save",
    controlType: "Button",
    automationId: "",
    boundingRect,
  } as Awaited<ReturnType<typeof getElementBounds>>);
  return scopeElementHandler(ARGS);
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DESKTOP_TOUCH_CAPTURE_BACKEND;
  hoisted.state.nativeCapture = true;
  hoisted.captured.length = 0;
  _resetCaptureBackendForTests();
});

describe("scope_element capture region (ADR-031 §2(d))", () => {
  it("captures the element on the left-hand monitor at its real coordinates", async () => {
    const result = await scopeWith({ x: -1500, y: 400, width: 120, height: 40 });
    expect(hoisted.captured).toEqual([{ x: -1520, y: 380, width: 160, height: 80 }]);
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  it("trims the padding overhang at the far edge without moving the element", async () => {
    const result = await scopeWith({ x: -1920, y: 0, width: 120, height: 40 });
    expect(hoisted.captured).toEqual([{ x: -1920, y: 0, width: 140, height: 60 }]);
    expect(result.content.some((c) => c.type === "image")).toBe(true);
  });

  // The regression this replaces: with `Math.max(0, …)` the region became
  // { x: 0, y: 380 } — the primary monitor — and the handler returned that as
  // the element's screenshot.
  it("does not pull an unreachable element onto the primary monitor", async () => {
    hoisted.state.nativeCapture = false; // nut.js: primary monitor only
    await scopeWith({ x: -1500, y: 400, width: 120, height: 40 });
    expect(hoisted.captured).toEqual([{ x: -1520, y: 380, width: 160, height: 80 }]);
    expect(hoisted.captured[0]!.x).toBeLessThan(0);
  });

  it("continues with text only when that capture is refused", async () => {
    hoisted.state.nativeCapture = false;
    const result = await scopeWith({ x: -1500, y: 400, width: 120, height: 40 });
    expect(result.content.some((c) => c.type === "image")).toBe(false);
    expect(result.content.some((c) => c.type === "text")).toBe(true);
  });
});
