/**
 * ADR-031 — absolute-coordinate capture against a real multi-monitor desktop.
 *
 * The unit tests pin the decisions; only real hardware can say whether the
 * pixels come back. The bug that started this ADR was invisible to every fake:
 * libnut validated absolute coordinates against `SM_CXSCREEN` — the primary
 * monitor alone — so `screenshot(displayId:1)` and any region with a negative X
 * failed outright on a second monitor placed to the left.
 *
 * Skipped unless the machine actually has two monitors and the native capture
 * binding is present. CI has neither, which is exactly why the geometry cases
 * live here instead of in the Rust unit tests.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { enumMonitors } from "../../src/engine/win32.js";
import { hasNativeCaptureRegion } from "../../src/engine/native-engine.js";
import { captureScreen, captureDisplay } from "../../src/engine/image.js";
import { screenshotHandler } from "../../src/tools/screenshot.js";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const BASE_ARGS = {
  maxDimension: 1920,
  dotByDot: false,
  grayscale: false,
  webpQuality: 85,
  diffMode: false,
  confirmImage: false,
  detail: undefined,
  ocrFallback: "auto" as const,
  preprocessPolicy: "auto" as const,
  preprocessAdaptive: false,
};

const textOf = (result: { content: { type: string; text?: string }[] }): string =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");

let monitors: { id: number; primary: boolean; bounds: Rect }[] = [];
let primary!: Rect;
let secondary!: Rect;

const eligible = (() => {
  try {
    return hasNativeCaptureRegion() && enumMonitors().length >= 2;
  } catch {
    return false;
  }
})();

describe.skipIf(!eligible)("ADR-031 — capture across every monitor", () => {
  beforeAll(() => {
    monitors = enumMonitors();
    primary = monitors.find((m) => m.primary)!.bounds;
    secondary = monitors.find((m) => !m.primary)!.bounds;
  });

  // The headline failure: before ADR-031 this threw
  // "Error: x coordinate outside of display" for every non-primary monitor.
  it("captures each monitor by displayId at its exact pixel size", async () => {
    for (const monitor of monitors) {
      const shot = await captureDisplay(monitor.bounds, {
        format: "webp",
        webpQuality: 50,
      });
      expect(
        { id: monitor.id, width: shot.width, height: shot.height },
        `display ${monitor.id} at (${monitor.bounds.x}, ${monitor.bounds.y})`,
      ).toEqual({ id: monitor.id, width: monitor.bounds.width, height: monitor.bounds.height });
    }
  });

  it("captures a region whose origin is negative", async () => {
    const negative = monitors.find((m) => m.bounds.x < 0 || m.bounds.y < 0);
    if (!negative) {
      // Right-hand / below layouts are covered by the dogfood checklist; the
      // rest of this file still exercises the non-primary path.
      expect(secondary.x === 0 && secondary.y === 0).toBe(false);
      return;
    }
    const region: Rect = { x: negative.bounds.x, y: negative.bounds.y, width: 400, height: 300 };
    const shot = await captureScreen(region, { format: "webp", webpQuality: 50 });
    expect({ width: shot.width, height: shot.height }).toEqual({ width: 400, height: 300 });
  });

  it("captures a region that spans the seam between two monitors", async () => {
    const left = Math.min(primary.x, secondary.x) === secondary.x ? secondary : primary;
    const seam = left.x + left.width; // the boundary between the two
    const region: Rect = { x: seam - 200, y: Math.max(primary.y, secondary.y) + 100, width: 400, height: 200 };
    const shot = await captureScreen(region, { format: "webp", webpQuality: 50 });
    expect({ width: shot.width, height: shot.height }).toEqual({ width: 400, height: 200 });
  });

  // dot-by-dot coordinates are what the model clicks on afterwards, so the
  // reported origin has to be the region's real (possibly negative) one.
  it("reports the region's own origin in dot-by-dot mode", async () => {
    const region: Rect = { x: secondary.x + 50, y: secondary.y + 60, width: 320, height: 240 };
    const result = await screenshotHandler({ ...BASE_ARGS, region, dotByDot: true });
    const text = textOf(result);
    expect(text).toContain(`origin: (${region.x}, ${region.y})`);
    expect(text).toContain("320x240px");
  });

  // ADR-031 §2(b): the pixels move to BitBlt, the geometry does not. A
  // full-screen capture is still the primary monitor with no origin offset —
  // widening it to the virtual desktop would change the size, the origin and
  // the token cost of every existing multi-monitor caller.
  it("leaves the full-screen capture on the primary monitor, with no origin", async () => {
    const shot = await captureScreen(undefined, { format: "webp", webpQuality: 50 });
    expect({ width: shot.width, height: shot.height }).toEqual({
      width: primary.width,
      height: primary.height,
    });

    const text = textOf(await screenshotHandler({ ...BASE_ARGS, dotByDot: true }));
    expect(text).toContain("Screenshot (dot-by-dot)");
    expect(text).not.toContain("origin: (");
  });

  // Frame diffing compares two buffers, so the same region must come back the
  // same size every time — the property a per-call backend switch would break.
  it("returns identical dimensions for repeated captures of one region", async () => {
    const region: Rect = { x: secondary.x + 10, y: secondary.y + 10, width: 500, height: 400 };
    const first = await captureScreen(region, { format: "webp", webpQuality: 50 });
    const second = await captureScreen(region, { format: "webp", webpQuality: 50 });
    expect({ width: second.width, height: second.height }).toEqual({
      width: first.width,
      height: first.height,
    });
    expect({ width: first.width, height: first.height }).toEqual({ width: 500, height: 400 });
  });

  // The refusal has to be typed and specific, not a raw native throw — this is
  // what `screenshot` turns into `RegionOutsideCapturableBounds` for the caller.
  it("refuses a region that is on no monitor with a typed error", async () => {
    const bounding = monitors.reduce(
      (acc, m) => ({
        minX: Math.min(acc.minX, m.bounds.x),
        minY: Math.min(acc.minY, m.bounds.y),
      }),
      { minX: Infinity, minY: Infinity },
    );
    const offscreen: Rect = { x: bounding.minX - 4000, y: bounding.minY, width: 200, height: 200 };
    await expect(captureScreen(offscreen)).rejects.toMatchObject({
      name: "RegionOutsideCapturableBounds",
    });

    const text = textOf(await screenshotHandler({ ...BASE_ARGS, region: offscreen }));
    expect(text).toContain("RegionOutsideCapturableBounds");
  });
});
