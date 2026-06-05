/**
 * ADR-024 Seed-2 S5c-2 — `desktop_act` handler-level frame-diff dispatch tests.
 *
 * S5c-1a/1b shipped the visual-only frame-diff ROI path; the unit tests for the
 * native bbox (`ssim-residual`), the orchestrator (`local-repaint-orchestrator`),
 * the geometry (`roi-region`) and the flag persistence
 * (`roi-capture-flag-persistence`) cover the pieces in isolation. This file pins
 * the **handler-level dispatch** that wires them together inside
 * `desktopActRawHandler` — the routing Opus flagged as untested when S5c-1a/1b
 * deferred the "handler-level dispatch test" to S5c-2:
 *
 *   1. visual-only → frame-diff (pre-frame capture + verifyLocalRepaint), roiBbox
 *      split off the public `result.observation`, localized roiCapture attached.
 *   2. visual-only frame-diff **miss** → degrade with NO DXGI fallback (the F1/F2
 *      regime is never re-entered — Codex PR #431 round 2 P2-A, at handler level).
 *   3. non-visual-only → DXGI path, NO pre-frame capture (structured targets pay
 *      nothing — `feedback_minimize_screenshot_reliance`), no roiCapture.
 *   4. BitBlt-fallback demotion (verifyLocalRepaint returns motion but no roiBbox)
 *      → roiCapture present with the FULL-WINDOW roi, never a wrong localized one
 *      (P1-1, end-to-end).
 *
 * Sub-plan: `desktop-touch-mcp-internal@…:docs/adr-024-seed2-plan.md` §S5c-2.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { EntityLease } from "../../src/engine/world-graph/types.js";

// ── Module-dep mocks (partial — preserve everything else via importOriginal) ──
const mockCaptureFrame = vi.fn();
const mockVerifyLocalRepaint = vi.fn();
const mockVerifyAnyChange = vi.fn();
const mockGetWindowRect = vi.fn();
const mockRunSomPipeline = vi.fn();

vi.mock("../../src/engine/layer-buffer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/layer-buffer.js")>();
  return { ...actual, captureFrame: (...a: unknown[]) => mockCaptureFrame(...a) };
});
vi.mock("../../src/engine/local-repaint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/local-repaint.js")>();
  return { ...actual, verifyLocalRepaint: (...a: unknown[]) => mockVerifyLocalRepaint(...a) };
});
vi.mock("../../src/engine/any-change.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/any-change.js")>();
  return { ...actual, verifyAnyChange: (...a: unknown[]) => mockVerifyAnyChange(...a) };
});
vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return { ...actual, getWindowRectByHwnd: (...a: unknown[]) => mockGetWindowRect(...a) };
});
vi.mock("../../src/engine/ocr-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/ocr-bridge.js")>();
  return { ...actual, runSomPipeline: (...a: unknown[]) => mockRunSomPipeline(...a) };
});

// Import the handler AFTER the mocks so it picks up the mocked module surface.
const { desktopActRawHandler, getDesktopFacade, _resetFacadeForTest } = await import(
  "../../src/tools/desktop-register.js"
);

const FAKE_LEASE: EntityLease = {
  entityId: "e1",
  viewId: "v1",
  targetGeneration: "g1",
  expiresAtMs: Number.MAX_SAFE_INTEGER,
  evidenceDigest: "d1",
};

const WINDOW_RECT = { x: 0, y: 0, width: 800, height: 600 };

function parse(content: ReadonlyArray<{ type: string; text?: string }>): Record<string, unknown> {
  const block = content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected text content");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

/** Configure the facade singleton's resolver spies for a visual-only target. */
function spyFacadeVisualOnly(opts: {
  visualOnly: boolean;
  hwnd?: bigint | null;
}) {
  const facade = getDesktopFacade();
  vi.spyOn(facade, "touch").mockResolvedValue({
    ok: true,
    executor: "mouse",
    diff: [],
    next: "none",
  } as Awaited<ReturnType<typeof facade.touch>>);
  vi.spyOn(facade, "resolveVisualOnlyForViewId").mockReturnValue(opts.visualOnly);
  vi.spyOn(facade, "resolveTargetHwndForFrameDiff").mockResolvedValue(opts.hwnd ?? 123n);
  vi.spyOn(facade, "resolveEntityCenterForViewId").mockReturnValue({ x: 100, y: 100 });
  vi.spyOn(facade, "getDiscoverEntitiesForViewId").mockReturnValue([]);
  vi.spyOn(facade, "resolveHwndForViewId").mockReturnValue(123n);
  return facade;
}

describe("desktop_act frame-diff dispatch (S5c-2 handler-level)", () => {
  let savedStage5: string | undefined;

  beforeEach(() => {
    _resetFacadeForTest();
    vi.clearAllMocks();
    // Post-action verification (frame-diff + DXGI) is gated ON by default.
    savedStage5 = process.env["DESKTOP_TOUCH_STAGE5_DXGI"];
    delete process.env["DESKTOP_TOUCH_STAGE5_DXGI"];
    mockGetWindowRect.mockReturnValue(WINDOW_RECT);
    mockRunSomPipeline.mockResolvedValue({ somImage: { base64: "iVBORw0KGgo=" }, elements: [] });
  });

  afterEach(() => {
    if (savedStage5 === undefined) delete process.env["DESKTOP_TOUCH_STAGE5_DXGI"];
    else process.env["DESKTOP_TOUCH_STAGE5_DXGI"] = savedStage5;
    _resetFacadeForTest();
    vi.restoreAllMocks();
  });

  it("visual-only happy path → captures pre-frame, splits roiBbox off observation, attaches localized roiCapture", async () => {
    spyFacadeVisualOnly({ visualOnly: true });
    mockCaptureFrame.mockResolvedValue({
      rawPixels: Buffer.alloc(800 * 600 * 4),
      width: 800,
      height: 600,
      channels: 4,
      source: "printwindow",
    });
    mockVerifyLocalRepaint.mockResolvedValue({
      motion: "local_repaint",
      source: "ssim_residual",
      roiBbox: { x: 50, y: 60, width: 100, height: 80 },
      framesSampled: 2,
      totalElapsedMs: 80,
    });

    const result = await desktopActRawHandler({ lease: FAKE_LEASE, action: "click" });
    const parsed = parse(result.content);

    // Frame-diff was the motion source.
    expect(mockCaptureFrame).toHaveBeenCalledTimes(1);
    expect(mockVerifyLocalRepaint).toHaveBeenCalledTimes(1);
    // The DXGI verifier must NOT run on the visual-only path (no F1/F2 re-entry).
    expect(mockVerifyAnyChange).not.toHaveBeenCalled();
    // verifyLocalRepaint opted into the ROI bbox surface.
    const vlrArg = mockVerifyLocalRepaint.mock.calls[0]![0] as { includeRoiBbox?: boolean };
    expect(vlrArg.includeRoiBbox).toBe(true);

    // Public observation carries the motion verdict but NOT the internal roiBbox
    // (R2-P1 telemetry byte-equal — the split keeps it off the envelope).
    const observation = parsed["observation"] as Record<string, unknown>;
    expect(observation["motion"]).toBe("local_repaint");
    expect("roiBbox" in observation).toBe(false);

    // The localized bbox reaches the response as roiCapture.roi (S5c-1b integration).
    const cap = parsed["roiCapture"] as { roi?: unknown; source?: unknown };
    expect(cap).toBeDefined();
    expect(cap.roi).toEqual({ x: 50, y: 60, width: 100, height: 80 });
    expect(cap.source).toBe("frame_diff");
  });

  it("visual-only frame-diff miss (pre-frame capture fails) → degrade, NO DXGI fallback, no roiCapture", async () => {
    spyFacadeVisualOnly({ visualOnly: true });
    mockCaptureFrame.mockResolvedValue(null); // PrintWindow capture failed

    const result = await desktopActRawHandler({ lease: FAKE_LEASE, action: "click" });
    const parsed = parse(result.content);

    // Frame-diff setup was attempted (capture) but the verdict step is skipped…
    expect(mockCaptureFrame).toHaveBeenCalledTimes(1);
    expect(mockVerifyLocalRepaint).not.toHaveBeenCalled();
    // …and the DXGI verifier is NEVER used as a fallback (the whole point of the
    // frame-diff regime: F1/F2 must not be reintroduced — Codex #431 R2 P2-A).
    expect(mockVerifyAnyChange).not.toHaveBeenCalled();

    expect(parsed["observation"]).toBeUndefined();
    expect(parsed["roiCapture"]).toBeUndefined();
    expect(parsed["ok"]).toBe(true);
  });

  it("non-visual-only → no pre-frame capture, DXGI verdict, no roiCapture (structured target pays nothing)", async () => {
    spyFacadeVisualOnly({ visualOnly: false });
    mockVerifyAnyChange.mockResolvedValue({
      motion: "any_change",
      source: "dxgi_dirty_rect",
      framesSampled: 1,
      totalElapsedMs: 50,
      dirtyRects: [],
    });

    const result = await desktopActRawHandler({ lease: FAKE_LEASE, action: "click" });
    const parsed = parse(result.content);

    // Structured targets never pay the frame-diff capture cost.
    expect(mockCaptureFrame).not.toHaveBeenCalled();
    expect(mockVerifyLocalRepaint).not.toHaveBeenCalled();
    // DXGI Stage 5 path runs instead.
    expect(mockVerifyAnyChange).toHaveBeenCalledTimes(1);

    const observation = parsed["observation"] as Record<string, unknown>;
    expect(observation["motion"]).toBe("any_change");
    // Gate hard-guards on visualOnly → no roiCapture for structured targets.
    expect(parsed["roiCapture"]).toBeUndefined();
  });

  it("BitBlt-fallback demotion (motion but no roiBbox) → roiCapture present with FULL-WINDOW roi (P1-1 end-to-end)", async () => {
    spyFacadeVisualOnly({ visualOnly: true });
    mockCaptureFrame.mockResolvedValue({
      rawPixels: Buffer.alloc(800 * 600 * 4),
      width: 800,
      height: 600,
      channels: 4,
      source: "bitblt-fallback",
    });
    // verifyLocalRepaint saw a change but, because the capture was not occlusion-
    // immune, withholds the roiBbox (the demote happens inside the orchestrator).
    mockVerifyLocalRepaint.mockResolvedValue({
      motion: "local_repaint",
      source: "ssim_residual",
      framesSampled: 2,
      totalElapsedMs: 80,
      // no roiBbox
    });

    const result = await desktopActRawHandler({ lease: FAKE_LEASE, action: "click" });
    const parsed = parse(result.content);

    const cap = parsed["roiCapture"] as { roi?: unknown; source?: unknown };
    expect(cap).toBeDefined();
    // Demoted to the whole window rather than emitting a wrong localized ROI.
    expect(cap.roi).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(cap.source).toBe("frame_diff");
  });
});

// ── Acceptance ③ — the bbox aggregation stays in native Rust (no new TS pixel loop) ──
describe("S5c-2 acceptance ③ — no TS per-pixel loop in the ROI path", () => {
  // The bbox is aggregated inside the native SSIM scan (`src/ssim.rs`); the TS
  // side must never iterate pixel channels to localize the ROI. A per-pixel loop
  // would index RGBA channels as `buf[i + 1]` / `buf[i + 2]` / `buf[i + 3]`; the
  // legitimate crop helper (`cropRawFrame`) uses a row-wise `Buffer.copy`
  // (memmove) instead. Guard the ROI-dispatch source files against a regression
  // that reintroduces a channel-indexing pixel loop on the TS side.
  const channelIndex = /\[\s*\w+\s*\+\s*[123]\s*\]/;

  for (const rel of ["../../src/engine/local-repaint.ts", "../../src/tools/_roi-region.ts"]) {
    it(`${rel} has no RGBA channel-index pixel loop`, () => {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      expect(src).not.toMatch(channelIndex);
    });
  }
});
