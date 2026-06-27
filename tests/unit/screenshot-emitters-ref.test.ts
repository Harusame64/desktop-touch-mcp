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
const { mockEnumWindowsInZOrder, mockGetWindowTitleW, mockHasBuffer, mockCaptureAllLayers, mockCaptureAndDiff, mockUpdateWindowCache, mockSaveSnapshot, mockGetWindows, mockResolveWindowTarget, mockCaptureWindowBackground } = vi.hoisted(() => ({
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
vi.mock("../../src/engine/nutjs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/nutjs.js")>();
  return { ...actual, getWindows: mockGetWindows };
});
vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return { ...actual, resolveWindowTarget: mockResolveWindowTarget };
});
vi.mock("../../src/engine/image.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/image.js")>();
  return { ...actual, captureWindowBackground: mockCaptureWindowBackground };
});

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
