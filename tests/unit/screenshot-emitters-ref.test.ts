/**
 * screenshot-emitters-ref.test.ts — ADR-026 Phase 2.
 *
 * Pins the by-ref delivery of the two image emitters that don't go through the
 * single-image `buildImageResponse` whole-result builder:
 *   - diffMode (per changed/new frame) → default ref, inline only with confirmImage
 *   - mode='background' (screenshotBgHandler) → always inline + ref (§2.2(c) exception)
 *
 * The capture pipeline is mocked so the test is hermetic; the cache is pointed at
 * a throwaway temp dir so `persistCapture` does not write the real runtime dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
const { mockEnumWindowsInZOrder, mockGetWindowTitleW, mockHasBuffer, mockCaptureAllLayers, mockCaptureAndDiff, mockUpdateWindowCache, mockSaveSnapshot, mockGetWindows, mockResolveWindowTarget, mockCaptureWindowBackground, mockCaptureWindowWithFallback } = vi.hoisted(() => ({
  mockEnumWindowsInZOrder: vi.fn(),
  mockGetWindowTitleW: vi.fn(),
  mockHasBuffer: vi.fn(),
  mockCaptureAllLayers: vi.fn(),
  mockCaptureAndDiff: vi.fn(),
  mockUpdateWindowCache: vi.fn(),
  mockSaveSnapshot: vi.fn(),
  mockGetWindows: vi.fn(),
  mockResolveWindowTarget: vi.fn(),
  mockCaptureWindowBackground: vi.fn(),
  mockCaptureWindowWithFallback: vi.fn(),
}));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return { ...actual, enumWindowsInZOrder: mockEnumWindowsInZOrder, getWindowTitleW: mockGetWindowTitleW };
});
vi.mock("../../src/engine/layer-buffer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/layer-buffer.js")>();
  return { ...actual, hasBuffer: mockHasBuffer, captureAllLayers: mockCaptureAllLayers, captureAndDiff: mockCaptureAndDiff };
});
vi.mock("../../src/engine/window-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/window-cache.js")>();
  return { ...actual, updateWindowCache: mockUpdateWindowCache, saveSnapshot: mockSaveSnapshot };
});
// Complete fake (NOT importOriginal): nut-js loads native libXtst at import and
// aborts on a Linux unit runner (Codex review). screenshot.ts only uses
// getWindows from nutjs and no other module in its eval graph imports nutjs, so a
// complete fake keeps the whole suite hermetic on the normal unit lane.
vi.mock("../../src/engine/nutjs.js", () => ({ getWindows: mockGetWindows }));
vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return { ...actual, resolveWindowTarget: mockResolveWindowTarget };
});
// image.js imports nutjs (screen, Region) → complete fake here too so the real
// module (and its native nut-js dep) never loads. screenshot.ts imports four
// image fns; only captureWindowBackground is exercised — the rest are stubs.
vi.mock("../../src/engine/image.js", () => ({
  captureWindowBackground: mockCaptureWindowBackground,
  captureScreen: vi.fn(),
  captureDisplay: vi.fn(),
  captureWindowWithFallback: mockCaptureWindowWithFallback,
}));

const { screenshotHandler, screenshotBgHandler } = await import("../../src/tools/screenshot.js");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8]);
const B64 = PNG.toString("base64");

let cacheDir: string;
beforeEach(() => {
  vi.clearAllMocks();
  cacheDir = path.join(os.tmpdir(), `dt-emit-test-${crypto.randomBytes(6).toString("hex")}`);
  process.env.DESKTOP_TOUCH_SCREENSHOTS_DIR = cacheDir;
});
afterEach(() => {
  delete process.env.DESKTOP_TOUCH_SCREENSHOTS_DIR;
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const baseArgs = {
  maxDimension: 768, dotByDot: false, grayscale: false, webpQuality: 60,
  ocrFallback: "auto" as const, ocrLanguage: "ja", preprocessPolicy: "auto" as const, preprocessAdaptive: false,
};

describe("diffMode — ADR-026 §3 per-frame by-ref", () => {
  function wireDiff(diffs: unknown[]) {
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 1n, title: "W1", region: { x: 0, y: 0, width: 400, height: 300 }, zOrder: 0, isActive: true },
    ]);
    mockHasBuffer.mockReturnValue(false);          // I-frame
    mockCaptureAllLayers.mockResolvedValue(diffs);
  }
  const newFrame = {
    type: "new", title: "W1", region: { x: 0, y: 0, width: 400, height: 300 },
    image: { base64: B64, mimeType: "image/webp", width: 400, height: 300 },
  };

  it("default (no confirmImage) → each changed frame is a resource_link, NO inline image", async () => {
    wireDiff([newFrame]);
    const result = await screenshotHandler({ ...baseArgs, diffMode: true, confirmImage: false, detail: undefined });
    expect(result.content.some((c) => c.type === "resource_link")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(false);
    // The [NEW] verdict label stays bit-equal.
    expect(result.content.some((c) => c.type === "text" && /\[NEW\] "W1"/.test((c as { text: string }).text))).toBe(true);
  });

  it("confirmImage=true → inline image AND resource_link per changed frame", async () => {
    wireDiff([newFrame]);
    const result = await screenshotHandler({ ...baseArgs, diffMode: true, confirmImage: true, detail: undefined });
    expect(result.content.some((c) => c.type === "image")).toBe(true);
    expect(result.content.some((c) => c.type === "resource_link")).toBe(true);
  });

  it("a 'moved' frame carries no image and no ref (only the [MOVED] label)", async () => {
    wireDiff([{ type: "moved", title: "W1", region: { x: 5, y: 5, width: 400, height: 300 }, previousRegion: { x: 0, y: 0 } }]);
    const result = await screenshotHandler({ ...baseArgs, diffMode: true, confirmImage: false, detail: undefined });
    expect(result.content.some((c) => c.type === "image")).toBe(false);
    expect(result.content.some((c) => c.type === "resource_link")).toBe(false);
    expect(result.content.some((c) => c.type === "text" && /\[MOVED\]/.test((c as { text: string }).text))).toBe(true);
  });
});

describe("mode='background' — ADR-026 §3 inline + ref", () => {
  it("returns the inline image AND a resource_link (wantInline always true)", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "My App", hwnd: 999n });
    mockGetWindows.mockResolvedValue([
      { windowHandle: 999, title: Promise.resolve("My App"), region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }) },
    ]);
    mockGetWindowTitleW.mockReturnValue("My App");
    mockCaptureWindowBackground.mockResolvedValue({ base64: B64, mimeType: "image/png", width: 800, height: 600 });

    const result = await screenshotBgHandler({
      windowTitle: "My App", maxDimension: 768, dotByDot: false, grayscale: false, webpQuality: 60, fullContent: true,
    });
    // §2.2(c) exception: mode='background' is itself the pixel request — inline FIRST, then ref.
    expect(result.content[0].type).toBe("image");
    expect(result.content.some((c) => c.type === "resource_link")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-027 Phase 3 — capture-blocked handler surfacing (R9/AC8)
//
// Pins the actual AC8 deliverable to the LLM: the hints.captureBlocked flag, the
// hedged warning text, the SUPERSEDE of the BitBlt "overlapping windows" warning
// in the normal path, and the background-path warning. Engine-level tests pin
// the boolean; these pin the surfacing.
// ─────────────────────────────────────────────────────────────────────────────

/** Find and parse the `{ hints: ... }` JSON text block in a tool response. */
function readHints(result: { content: Array<{ type: string; text?: string }> }): {
  captureSource?: string;
  captureFallbackReason?: string;
  captureBlocked?: boolean;
  warnings?: string[];
} | null {
  for (const c of result.content) {
    if (c.type === "text" && typeof c.text === "string" && c.text.includes("\"hints\"")) {
      try {
        const parsed = JSON.parse(c.text) as { hints?: Record<string, unknown> };
        if (parsed.hints) return parsed.hints as ReturnType<typeof readHints>;
      } catch { /* not the hints block */ }
    }
  }
  return null;
}

describe("capture-blocked surfacing — normal path (ADR-027 Phase 3 / AC8)", () => {
  function wireWindow() {
    mockResolveWindowTarget.mockResolvedValue({ title: "My App", hwnd: 999n });
    mockEnumWindowsInZOrder.mockReturnValue([
      { hwnd: 999n, title: "My App", region: { x: 0, y: 0, width: 800, height: 600 }, zOrder: 0, isActive: true },
    ]);
  }

  it("captureBlocked=true → hints.captureBlocked + hedged warning, SUPERSEDES the overlapping-windows hint", async () => {
    wireWindow();
    mockCaptureWindowWithFallback.mockResolvedValue({
      base64: B64, mimeType: "image/png", width: 800, height: 600,
      source: "bitblt-fallback", fallbackReason: "printwindow-all-black", captureBlocked: true,
    });

    const result = await screenshotHandler({ ...baseArgs, windowTitle: "My App", detail: "image", confirmImage: false });
    const hints = readHints(result);
    expect(hints?.captureBlocked).toBe(true);
    const warnings = (hints?.warnings ?? []).join(" | ");
    // Hedged wording: does NOT assert the content is definitely protected.
    expect(warnings).toMatch(/all-black frame/i);
    expect(warnings).toMatch(/may legitimately be black/i);
    expect(warnings).toMatch(/uncapturable/i);
    // Outcome-only wording: must NOT enumerate which specific rungs ran (some
    // may have failed or been skipped — Codex review).
    expect(warnings).not.toMatch(/PrintWindow, WGC, BitBlt/i);
    // SUPERSEDE: the BitBlt "overlapping windows" / "pass mode='background'"
    // hints must NOT appear — a uniform black frame is not an occluding window.
    expect(warnings).not.toMatch(/overlapping windows/i);
    expect(warnings).not.toMatch(/pass mode='background'/i);
  });

  it("captureBlocked=false + bitblt-fallback all-black → keeps the existing 'pass mode=background' hint, no captureBlocked", async () => {
    wireWindow();
    mockCaptureWindowWithFallback.mockResolvedValue({
      base64: B64, mimeType: "image/png", width: 800, height: 600,
      source: "bitblt-fallback", fallbackReason: "printwindow-all-black", captureBlocked: false,
    });

    const result = await screenshotHandler({ ...baseArgs, windowTitle: "My App", detail: "image", confirmImage: false });
    const hints = readHints(result);
    expect(hints?.captureBlocked).toBeUndefined();
    const warnings = (hints?.warnings ?? []).join(" | ");
    expect(warnings).toMatch(/pass mode='background'/i);
  });

  it("captureBlocked=false + printwindow source → no capture warning, no captureBlocked hint", async () => {
    wireWindow();
    mockCaptureWindowWithFallback.mockResolvedValue({
      base64: B64, mimeType: "image/png", width: 800, height: 600,
      source: "printwindow", fallbackReason: null, captureBlocked: false,
    });

    const result = await screenshotHandler({ ...baseArgs, windowTitle: "My App", detail: "image", confirmImage: false });
    const hints = readHints(result);
    expect(hints?.captureBlocked).toBeUndefined();
    expect(hints?.captureSource).toBe("printwindow");
  });
});

describe("capture-blocked surfacing — background path (ADR-027 Phase 3 / AC8)", () => {
  function wireBgWindow() {
    mockResolveWindowTarget.mockResolvedValue({ title: "My App", hwnd: 999n });
    mockGetWindows.mockResolvedValue([
      { windowHandle: 999, title: Promise.resolve("My App"), region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }) },
    ]);
    mockGetWindowTitleW.mockReturnValue("My App");
  }

  it("captureBlocked=true → hints.captureBlocked + hedged warning in background response", async () => {
    wireBgWindow();
    mockCaptureWindowBackground.mockResolvedValue({ base64: B64, mimeType: "image/png", width: 800, height: 600, captureBlocked: true });

    const result = await screenshotBgHandler({
      windowTitle: "My App", maxDimension: 768, dotByDot: false, grayscale: false, webpQuality: 60, fullContent: true,
    });
    const hints = readHints(result);
    expect(hints?.captureBlocked).toBe(true);
    const warnings = (hints?.warnings ?? []).join(" | ");
    expect(warnings).toMatch(/all-black frame/i);
    expect(warnings).toMatch(/could not be verified/i);
    expect(warnings).toMatch(/may legitimately be black/i);
    expect(warnings).toMatch(/uncapturable/i);
    // Outcome-only: must NOT claim WGC participated (PrintWindow-only paths
    // never attempt WGC — Codex review).
    expect(warnings).not.toMatch(/via both WGC and PrintWindow/i);
  });

  it("captureBlocked absent (real pixels) → no capture-blocked warning", async () => {
    wireBgWindow();
    mockCaptureWindowBackground.mockResolvedValue({ base64: B64, mimeType: "image/png", width: 800, height: 600 });

    const result = await screenshotBgHandler({
      windowTitle: "My App", maxDimension: 768, dotByDot: false, grayscale: false, webpQuality: 60, fullContent: true,
    });
    const hints = readHints(result);
    // No hints block at all (no warnings) OR a hints block without captureBlocked.
    expect(hints?.captureBlocked).toBeUndefined();
  });
});
