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
 * Acceptance coverage (sub-plan §S5c): this file pins ③ (no TS pixel loop),
 * ④ (non-visual byte-equal + pre-frame not captured for structured targets) and
 * ⑤ (BitBlt-fallback → full-window). Acceptance ① (busy desktop static window →
 * no_change) and ② (localized change → ROI tracks) need a live busy/occluded
 * desktop and are covered by the S5c-1b manual dogfood
 * (`adr-024-seed2-dogfood-findings.md`); ⑥ (capture-count bound / latency) is an
 * S6 bench measurement. Those three are intentionally deferred here, not missing.
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

/**
 * Configure the facade for the S5b-2 FOLD path. The `touch` spy SIMULATES the
 * loop: when a `postSnapshot` closure is supplied it invokes it (so the fold's
 * single ROI-OCR actually runs through the mocked `runSomPipeline` /
 * `verifyLocalRepaint`) and surfaces the returned `roiMaterial`, exactly as
 * `GuardedTouchLoop.touch` does. Returns the facade so callers can read the
 * `touch` spy's call args (to assert whether a closure was passed = fold on/off).
 */
function spyFacadeFold(opts: { hasVisualGpu?: boolean }) {
  const facade = getDesktopFacade();
  vi.spyOn(facade, "touch").mockImplementation(
    async (input: { postSnapshot?: () => Promise<{ candidates: unknown[]; roiMaterial?: unknown }> }) => {
      const base = { ok: true as const, executor: "mouse" as const, diff: [], next: "none" as const };
      if (input.postSnapshot) {
        const snap = await input.postSnapshot();
        return { ...base, ...(snap.roiMaterial ? { roiMaterial: snap.roiMaterial } : {}) } as Awaited<ReturnType<typeof facade.touch>>;
      }
      return base as Awaited<ReturnType<typeof facade.touch>>;
    },
  );
  vi.spyOn(facade, "resolveVisualOnlyForViewId").mockReturnValue(true);
  vi.spyOn(facade, "resolveTargetHwndForFrameDiff").mockResolvedValue(123n);
  vi.spyOn(facade, "resolveEntityCenterForViewId").mockReturnValue({ x: 100, y: 100 });
  vi.spyOn(facade, "getDiscoverEntitiesForViewId").mockReturnValue([]);
  vi.spyOn(facade, "resolveHwndForViewId").mockReturnValue(123n);
  vi.spyOn(facade, "discoverHasVisualGpuForViewId").mockReturnValue(opts.hasVisualGpu ?? false);
  vi.spyOn(facade, "resolveOcrTargetIdForViewId").mockReturnValue("123");
  return facade;
}

// These pin the LEGACY S5 dispatch (handler-direct verifyLocalRepaint +
// buildRoiCapture). With the S5b-2 fold ON (default) that work moves into the
// postSnapshot closure invoked by the loop, so these run with the fold OFF —
// the legacy path is still reachable (flag off / D6 gate fail / fold miss) and
// must stay byte-equal. The fold dispatch is pinned in the separate describe below.
describe("desktop_act frame-diff dispatch — legacy S5 path (S5b fold off)", () => {
  let savedStage5: string | undefined;
  let savedFold: string | undefined;

  beforeEach(() => {
    _resetFacadeForTest();
    vi.clearAllMocks();
    // Post-action verification (frame-diff + DXGI) is gated ON by default.
    savedStage5 = process.env["DESKTOP_TOUCH_STAGE5_DXGI"];
    delete process.env["DESKTOP_TOUCH_STAGE5_DXGI"];
    // Force the legacy (fold-off) path so the handler-direct dispatch is exercised.
    savedFold = process.env["DESKTOP_TOUCH_STAGE5B_FOLD_OCR"];
    process.env["DESKTOP_TOUCH_STAGE5B_FOLD_OCR"] = "0";
    mockGetWindowRect.mockReturnValue(WINDOW_RECT);
    mockRunSomPipeline.mockResolvedValue({ somImage: { base64: "iVBORw0KGgo=" }, elements: [] });
  });

  afterEach(() => {
    if (savedStage5 === undefined) delete process.env["DESKTOP_TOUCH_STAGE5_DXGI"];
    else process.env["DESKTOP_TOUCH_STAGE5_DXGI"] = savedStage5;
    if (savedFold === undefined) delete process.env["DESKTOP_TOUCH_STAGE5B_FOLD_OCR"];
    else process.env["DESKTOP_TOUCH_STAGE5B_FOLD_OCR"] = savedFold;
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
    // acceptance ④: the structured-target observation keeps the DXGI source verdict
    // (not a frame-diff source) — the Stage 5 telemetry contract is byte-equal.
    expect(observation["source"]).toBe("dxgi_dirty_rect");
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

// ── ADR-024 Seed-2 S5b-2 — the order-trap fold dispatch (default on) ──
describe("desktop_act frame-diff dispatch — S5b-2 fold (default on)", () => {
  let savedStage5: string | undefined;
  let savedFold: string | undefined;

  beforeEach(() => {
    _resetFacadeForTest();
    vi.clearAllMocks();
    savedStage5 = process.env["DESKTOP_TOUCH_STAGE5_DXGI"];
    delete process.env["DESKTOP_TOUCH_STAGE5_DXGI"];
    savedFold = process.env["DESKTOP_TOUCH_STAGE5B_FOLD_OCR"];
    delete process.env["DESKTOP_TOUCH_STAGE5B_FOLD_OCR"]; // fold ON (default)
    mockGetWindowRect.mockReturnValue(WINDOW_RECT);
    mockRunSomPipeline.mockResolvedValue({ somImage: { base64: "iVBORw0KGgo=" }, elements: [] });
    mockCaptureFrame.mockResolvedValue({
      rawPixels: Buffer.alloc(800 * 600 * 4),
      width: 800,
      height: 600,
      channels: 4,
      source: "printwindow",
    });
  });

  afterEach(() => {
    if (savedStage5 === undefined) delete process.env["DESKTOP_TOUCH_STAGE5_DXGI"];
    else process.env["DESKTOP_TOUCH_STAGE5_DXGI"] = savedStage5;
    if (savedFold === undefined) delete process.env["DESKTOP_TOUCH_STAGE5B_FOLD_OCR"];
    else process.env["DESKTOP_TOUCH_STAGE5B_FOLD_OCR"] = savedFold;
    _resetFacadeForTest();
    vi.restoreAllMocks();
  });

  it("order-trap eliminated → ONE OCR (for roiCapture, on the PADDED change region); no DXGI, no second OCR", async () => {
    spyFacadeFold({});
    mockVerifyLocalRepaint.mockResolvedValue({
      motion: "local_repaint",
      source: "ssim_residual",
      roiBbox: { x: 50, y: 60, width: 100, height: 80 },
      framesSampled: 2,
      totalElapsedMs: 80,
    });

    const result = await desktopActRawHandler({ lease: FAKE_LEASE, action: "click", returnCapture: "on-change" });
    const parsed = parse(result.content);

    // Exactly ONE OCR — the roiCapture's. The diff baseline carries the discover
    // entities forward (no OCR), so there is no second / full-window post OCR.
    expect(mockRunSomPipeline).toHaveBeenCalledTimes(1);
    // roiBbox {50,60,100,80} padded by max(24, ceil(80*0.5)=40)=40 → {10,20,180,160}.
    expect(mockRunSomPipeline.mock.calls[0]![7]).toEqual({ x: 10, y: 20, width: 180, height: 160 });
    expect(mockVerifyLocalRepaint).toHaveBeenCalledTimes(1);
    expect(mockVerifyAnyChange).not.toHaveBeenCalled();

    // roiCapture is on the padded ROI; observation lifted, roiBbox stripped.
    const cap = parsed["roiCapture"] as { roi?: unknown; source?: unknown };
    expect(cap.roi).toEqual({ x: 10, y: 20, width: 180, height: 160 });
    expect(cap.source).toBe("frame_diff");
    const obs = parsed["observation"] as Record<string, unknown>;
    expect(obs["motion"]).toBe("local_repaint");
    expect("roiBbox" in obs).toBe(false);
  });

  it("D6 gate — discover has visual_gpu → fold disabled, touch called WITHOUT a postSnapshot closure (S5 legacy path)", async () => {
    const facade = spyFacadeFold({ hasVisualGpu: true });
    mockVerifyLocalRepaint.mockResolvedValue({
      motion: "local_repaint",
      source: "ssim_residual",
      roiBbox: { x: 50, y: 60, width: 100, height: 80 },
      framesSampled: 2,
      totalElapsedMs: 80,
    });

    await desktopActRawHandler({ lease: FAKE_LEASE, action: "click", returnCapture: "on-change" });

    // Fold NOT taken: the loop received no closure → the post OCR runs via the
    // legacy handler path (every composeCandidates lane preserved).
    const calls = (facade.touch as unknown as { mock: { calls: Array<[{ postSnapshot?: unknown }]> } }).mock.calls;
    expect(calls[0]![0].postSnapshot).toBeUndefined();
  });

  it("returnCapture:'always' on no_change → still folds a FULL-WINDOW roiCapture (single OCR; Codex P2-1)", async () => {
    spyFacadeFold({});
    mockVerifyLocalRepaint.mockResolvedValue({
      motion: "no_change",
      source: "ssim_residual",
      framesSampled: 2,
      totalElapsedMs: 40,
    }); // no roiBbox

    const result = await desktopActRawHandler({ lease: FAKE_LEASE, action: "click", returnCapture: "always" });
    const parsed = parse(result.content);

    expect(mockRunSomPipeline).toHaveBeenCalledTimes(1);
    expect(mockRunSomPipeline.mock.calls[0]![7]).toEqual({ x: 0, y: 0, width: 800, height: 600 }); // full window
    const cap = parsed["roiCapture"] as { roi?: unknown; source?: unknown };
    expect(cap.roi).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(cap.source).toBe("frame_diff");
  });

  it("returnCapture:'on-change' on no_change → NO OCR at all (diff is carry-forward; gate declines roiCapture)", async () => {
    spyFacadeFold({});
    mockVerifyLocalRepaint.mockResolvedValue({
      motion: "no_change",
      source: "ssim_residual",
      framesSampled: 2,
      totalElapsedMs: 40,
    });

    const result = await desktopActRawHandler({ lease: FAKE_LEASE, action: "click", returnCapture: "on-change" });
    const parsed = parse(result.content);

    // The diff baseline is carry-forward (no OCR), and the gate declines the
    // roiCapture (no change, not "always") → the fold runs ZERO OCRs here.
    expect(mockRunSomPipeline).not.toHaveBeenCalled();
    expect(parsed["roiCapture"]).toBeUndefined();
  });
});
