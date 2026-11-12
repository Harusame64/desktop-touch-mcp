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
const { mockGetWindowClassName, mockGetTextViaTextPattern, mockGetUiElements, mockGetWindowProcessId, mockGetProcessIdentityByPid, mockEnumWindowsInZOrder, mockGetWindowTitleW, mockGetWindowRectByHwnd, mockIsWindowProcessFrozen, mockVisibleFrame, mockHasBuffer, mockCaptureAllLayers, mockCaptureAndDiff, mockUpdateWindowCache, mockSaveSnapshot, mockGetWindows, mockResolveWindowTarget, mockCaptureWindowBackground, mockCaptureWindowWithFallback } = vi.hoisted(() => ({
  mockGetWindowClassName: vi.fn(() => ""),
  mockGetTextViaTextPattern: vi.fn(),
  mockGetUiElements: vi.fn(),
  mockGetWindowProcessId: vi.fn(() => 1234),
  mockGetProcessIdentityByPid: vi.fn(() => ({ pid: 1234, processName: "pwsh", processStartTimeMs: 100 })),
  mockEnumWindowsInZOrder: vi.fn(),
  mockGetWindowTitleW: vi.fn(),
  mockGetWindowRectByHwnd: vi.fn(),
  mockIsWindowProcessFrozen: vi.fn(),
  mockVisibleFrame: vi.fn(),
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
  return {
    ...actual,
    enumWindowsInZOrder: mockEnumWindowsInZOrder,
    getWindowTitleW: mockGetWindowTitleW,
    getWindowRectByHwnd: mockGetWindowRectByHwnd,
    isWindowProcessFrozen: mockIsWindowProcessFrozen,
    getWindowClassName: mockGetWindowClassName,
    getWindowProcessId: mockGetWindowProcessId,
    getProcessIdentityByPid: mockGetProcessIdentityByPid,
  };
});
vi.mock("../../src/engine/uia-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/uia-bridge.js")>();
  return { ...actual, getTextViaTextPattern: mockGetTextViaTextPattern, getUiElements: mockGetUiElements };
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
  // Internal #246: the real rule (a WGC frame covers the visible frame), with that frame mocked.
  capturedFrameRect: (_hwnd: unknown, source: string, rect: unknown) => (source === "wgc" ? mockVisibleFrame() : rect),
}));

// internal #357: runOcr and the language warning are seams; by default the real ones run.
const { mockRunOcr, mockOcrLanguageWarning } = vi.hoisted(() => ({ mockRunOcr: vi.fn(), mockOcrLanguageWarning: vi.fn() }));
vi.mock("../../src/engine/ocr-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/ocr-bridge.js")>();
  mockRunOcr.mockImplementation(actual.runOcr);
  mockOcrLanguageWarning.mockImplementation(actual.ocrLanguageWarning);
  return { ...actual, runOcr: mockRunOcr, ocrLanguageWarning: mockOcrLanguageWarning };
});

const { screenshotHandler, screenshotBgHandler, screenshotOcrHandler } = await import("../../src/tools/screenshot.js");

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

// internal #248 (win2): a title two windows carry captured the first with no word that it was ambiguous.
describe("mode='background' — says when a title matched several windows (internal #248)", () => {
  const win = (h: number, title: string) => ({ windowHandle: h, title: Promise.resolve(title), region: Promise.resolve({ left: 0, top: 0, width: 300, height: 200 }) });
  const zrow = (h: bigint, title: string) => ({ hwnd: h, title, region: { x: 0, y: 0, width: 300, height: 200 }, zOrder: 0, isActive: false, isMinimized: false, isMaximized: false, isCloaked: false });
  const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  const titleOf = (h: bigint) => (h === 67756n ? "XBOX Console" : h === 67686n ? "XBOX Accessories" : "Notepad");

  it("captures the first match, and names the others by title and handle in the shared wording", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    mockGetWindows.mockResolvedValue([win(67756, "XBOX Console"), win(67686, "XBOX Accessories"), win(500, "Notepad")]);
    mockGetWindowTitleW.mockImplementation(titleOf);
    mockEnumWindowsInZOrder.mockReturnValue([zrow(67756n, "XBOX Console"), zrow(67686n, "XBOX Accessories"), zrow(500n, "Notepad")]);
    mockGetWindowRectByHwnd.mockReturnValue({ x: 10, y: 20, width: 300, height: 200 });
    mockCaptureWindowBackground.mockClear();
    mockCaptureWindowBackground.mockResolvedValue({ base64: B64, mimeType: "image/png", width: 300, height: 200 });
    const result = await screenshotBgHandler({ windowTitle: "XBOX", maxDimension: 768, dotByDot: false, grayscale: false, webpQuality: 60, fullContent: true } as never);
    expect(mockCaptureWindowBackground.mock.calls[0][0]).toBe(67756n);
    const text = textOf(result as never);
    expect(text).toContain('2 windows match \\"XBOX\\"');
    expect(text).toContain('XBOX Accessories\\" (hwnd 67686)');
    expect(text).toContain("Pass hwnd");
    expect(text).not.toContain("Notepad");
  });

  it("counts the window it captured even when the matcher leaves it out (an owned window; win2 on #924)", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    // nut-js lists the owned window first; the resolver's matcher (owned left out) sees only the other.
    mockGetWindows.mockResolvedValue([win(13569274, "XBOX owned"), win(67756, "XBOX Console")]);
    mockGetWindowTitleW.mockImplementation((h: bigint) => (h === 13569274n ? "XBOX owned" : "XBOX Console"));
    mockEnumWindowsInZOrder.mockReturnValue([zrow(67756n, "XBOX Console")]);
    mockGetWindowRectByHwnd.mockReturnValue({ x: 10, y: 20, width: 300, height: 200 });
    mockCaptureWindowBackground.mockResolvedValue({ base64: B64, mimeType: "image/png", width: 300, height: 200 });
    const result = await screenshotBgHandler({ windowTitle: "XBOX", maxDimension: 768, dotByDot: false, grayscale: false, webpQuality: 60, fullContent: true } as never);
    const text = textOf(result as never);
    expect(text).toContain('2 windows match \\"XBOX\\"');
    expect(text).toContain("(hwnd 13569274), not ");
  });

  it("says nothing when the title matched one window", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    mockGetWindows.mockResolvedValue([win(67756, "XBOX Console"), win(500, "Notepad")]);
    mockGetWindowTitleW.mockImplementation(titleOf);
    mockEnumWindowsInZOrder.mockReturnValue([zrow(67756n, "XBOX Console"), zrow(500n, "Notepad")]);
    mockGetWindowRectByHwnd.mockReturnValue({ x: 10, y: 20, width: 300, height: 200 });
    mockCaptureWindowBackground.mockResolvedValue({ base64: B64, mimeType: "image/png", width: 300, height: 200 });
    const result = await screenshotBgHandler({ windowTitle: "XBOX", maxDimension: 768, dotByDot: false, grayscale: false, webpQuality: 60, fullContent: true } as never);
    expect(textOf(result as never)).not.toContain("windows match");
  });
});

// Internal #243 (win2, 2026-10-04): every background capture failed "screenshot failed: " since at
// least 1.16.0. The handler matched the resolved window's title again over nut-js's list and handed
// nut-js's handle — a number — to natives that take a BigInt, which threw with an empty message.
describe("mode='background' — captures the window it resolved (internal #243)", () => {
  it("hands the resolved BigInt handle to the capture, and does not walk nut-js's list", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "Target", hwnd: 4242n, warnings: [] });
    mockGetWindowRectByHwnd.mockReturnValue({ x: 10, y: 20, width: 300, height: 200 });
    mockGetWindows.mockClear();
    mockCaptureWindowBackground.mockClear();
    mockCaptureWindowBackground.mockResolvedValue({ base64: B64, mimeType: "image/png", width: 300, height: 200 });

    const result = await screenshotBgHandler({
      hwnd: "4242", maxDimension: 768, dotByDot: false, grayscale: false, webpQuality: 60, fullContent: true,
    });
    expect(result.content[0].type).toBe("image");
    expect(mockCaptureWindowBackground).toHaveBeenCalledTimes(1);
    expect(mockCaptureWindowBackground.mock.calls[0][0]).toBe(4242n);
    expect(mockGetWindows).not.toHaveBeenCalled();
  });

  it("takes the dot-by-dot origin from the resolved window's own rect", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "Target", hwnd: 4242n, warnings: [] });
    mockGetWindowRectByHwnd.mockReturnValue({ x: 10, y: 20, width: 300, height: 200 });
    mockCaptureWindowBackground.mockResolvedValue({ base64: B64, mimeType: "image/png", width: 300, height: 200, source: "printwindow" });

    const result = await screenshotBgHandler({
      hwnd: "4242", maxDimension: 768, dotByDot: true, grayscale: false, webpQuality: 60, fullContent: true,
    });
    const text = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    expect(text).toContain("origin: (10, 20)");
    // Only the branch that prints an origin keeps the default link text, which promises coordinates.
    const link = result.content.find((c) => c.type === "resource_link") as { description?: string } | undefined;
    expect(link?.description).toContain("click coordinates");
  });

  // Internal #246: win2 measured the WGC frame starting at the visible frame, 7 px right of the rect.
  it("gives a WGC frame its visible frame's corner as the origin, not the rect's", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "Target", hwnd: 4242n, warnings: [] });
    mockGetWindowRectByHwnd.mockReturnValue({ x: 10, y: 20, width: 300, height: 200 });
    mockVisibleFrame.mockReset().mockReturnValue({ x: 17, y: 20, width: 286, height: 193 });
    mockCaptureWindowBackground.mockResolvedValue({
      base64: B64, mimeType: "image/png", width: 286, height: 193, source: "wgc",
    });

    const result = await screenshotBgHandler({
      hwnd: "4242", maxDimension: 768, dotByDot: true, grayscale: false, webpQuality: 60, fullContent: true,
    });
    const text = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    expect(text).toContain("origin: (17, 20)");
    expect(text).not.toContain("origin: (10, 20)");
  });

  // Codex on c183454c: the crop clamps a negative region offset to 0; the origin added it raw.
  it("adds the crop's clamped offset to the origin, not a negative region offset", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "Target", hwnd: 4242n, warnings: [] });
    mockGetWindowRectByHwnd.mockReturnValue({ x: 10, y: 20, width: 300, height: 200 });
    mockCaptureWindowBackground.mockResolvedValue({
      base64: B64, mimeType: "image/png", width: 50, height: 40, source: "printwindow",
    });

    const result = await screenshotBgHandler({
      hwnd: "4242", maxDimension: 768, dotByDot: true, grayscale: false, webpQuality: 60, fullContent: false,
      region: { x: -5, y: -3, width: 50, height: 40 },
    });
    const text = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    expect(text).toContain("origin: (10, 20)");
  });

  it("gives a WGC frame no screen origin when its visible frame cannot be read", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "Target", hwnd: 4242n, warnings: [] });
    mockGetWindowRectByHwnd.mockReturnValue({ x: 10, y: 20, width: 300, height: 200 });
    mockVisibleFrame.mockReset().mockReturnValue(null);
    mockCaptureWindowBackground.mockResolvedValue({
      base64: B64, mimeType: "image/png", width: 286, height: 193, source: "wgc",
    });

    const result = await screenshotBgHandler({
      hwnd: "4242", maxDimension: 768, dotByDot: true, grayscale: false, webpQuality: 60, fullContent: true,
    });
    const text = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    expect(text).not.toContain("origin: (");
    expect(text).not.toContain("screen_x");
    expect(text).toContain("no screen origin");
    const link = result.content.find((c) => c.type === "resource_link") as { description?: string } | undefined;
    expect(link?.description).toBeDefined();
    expect(link?.description).not.toContain("click coordinates");
    expect(link?.description).toContain("no screen origin for clicking");
  });

  it("does not promise click coordinates in the link when no origin was printed (PrintWindow, scaled)", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "Target", hwnd: 4242n, warnings: [] });
    mockGetWindowRectByHwnd.mockReturnValue({ x: 10, y: 20, width: 300, height: 200 });
    mockCaptureWindowBackground.mockResolvedValue({
      base64: B64, mimeType: "image/png", width: 300, height: 200, source: "printwindow",
    });

    const result = await screenshotBgHandler({
      hwnd: "4242", maxDimension: 768, dotByDot: false, grayscale: false, webpQuality: 60, fullContent: false,
    });
    const link = result.content.find((c) => c.type === "resource_link") as { description?: string } | undefined;
    expect(link?.description).toBeDefined();
    expect(link?.description).not.toContain("click coordinates");
  });

  // Gate 2 on 556d72b5: nut-js clamps a window's region to the primary monitor; the title road took
  // its origin from there.
  it("without a resolved window, takes the window's own rect, not nut-js's clamped region", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    mockGetWindows.mockResolvedValue([
      { windowHandle: 777, title: Promise.resolve("Other"), region: Promise.resolve({ left: 0, top: 0, width: 600, height: 480 }) },
    ]);
    mockGetWindowTitleW.mockReturnValue("Other");
    mockGetWindowRectByHwnd.mockReset().mockReturnValue({ x: -1700, y: 120, width: 640, height: 480 });
    mockCaptureWindowBackground.mockResolvedValue({
      base64: B64, mimeType: "image/png", width: 640, height: 480, source: "printwindow",
    });

    const result = await screenshotBgHandler({
      windowTitle: "Other", maxDimension: 768, dotByDot: true, grayscale: false, webpQuality: 60, fullContent: false,
    });
    const text = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    expect(text).toContain("origin: (-1700, 120)");
  });

  it("without a resolved window, turns nut-js's number handle into a BigInt before any native call", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    mockGetWindows.mockResolvedValue([
      { windowHandle: 777, title: Promise.resolve("Other"), region: Promise.resolve({ left: 0, top: 0, width: 640, height: 480 }) },
    ]);
    mockGetWindowTitleW.mockClear();
    mockGetWindowTitleW.mockReturnValue("Other");
    mockCaptureWindowBackground.mockClear();
    mockCaptureWindowBackground.mockResolvedValue({ base64: B64, mimeType: "image/png", width: 640, height: 480 });

    await screenshotBgHandler({
      windowTitle: "Other", maxDimension: 768, dotByDot: false, grayscale: false, webpQuality: 60, fullContent: true,
    });
    expect(mockGetWindowTitleW.mock.calls[0][0]).toBe(777n);
    expect(mockCaptureWindowBackground.mock.calls[0][0]).toBe(777n);
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

  // Internal #246: normal mode's WGC rescue printed the rect's corner as its origin.
  it("a WGC rescue frame's dot-by-dot origin is the visible frame's corner", async () => {
    wireWindow();
    mockVisibleFrame.mockReset().mockReturnValue({ x: 7, y: 0, width: 786, height: 593 });
    mockCaptureWindowWithFallback.mockResolvedValue({
      base64: B64, mimeType: "image/png", width: 786, height: 593,
      source: "wgc", fallbackReason: "printwindow-all-black", captureBlocked: false,
    });

    const result = await screenshotHandler({ ...baseArgs, windowTitle: "My App", detail: "image", confirmImage: false, dotByDot: true });
    const text = result.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    expect(text).toContain("origin: (7, 0)");
    expect(text).not.toContain("origin: (0, 0)");
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

// ADR-031 Phase V — the full-screen disclosure is a public contract, not a
// cosmetic string. `(full screen, no origin offset)` is what tells the caller
// that coordinates read off this image need no translation before they are
// clicked; a region capture says `origin: (x, y)` instead. ADR-031 moved the
// pixels to BitBlt but deliberately did NOT widen "full screen" to the virtual
// desktop, so this wording has to survive the backend change untouched.
//
// It lives in this file because this is the only unit harness that mocks the
// image engine and invokes the real `screenshotHandler`; the e2e full-screen
// case cannot reach it, since it passes a maxDimension no smaller than the
// primary monitor and `scale` is then undefined.
describe("full-screen dot-by-dot disclosure (ADR-031)", () => {
  it("reports the scale as full screen with no origin offset", async () => {
    // `vi.clearAllMocks()` clears calls but NOT implementations, so a window
    // resolved by an earlier test in this file would still be in place and
    // route us down the window branch (`if (effectiveTitle)`). Say explicitly
    // that no window is targeted — that is what selects the full-screen path.
    mockResolveWindowTarget.mockResolvedValue(undefined);

    const image = await import("../../src/engine/image.js");
    vi.mocked(image.captureScreen).mockResolvedValue({
      base64: B64,
      mimeType: "image/webp",
      width: 960,
      height: 540,
      scale: 0.5,
    } as unknown as Awaited<ReturnType<typeof image.captureScreen>>);

    const result = await screenshotHandler({
      ...baseArgs,
      dotByDot: true,
      confirmImage: false,
      detail: undefined,
    });

    const text = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("\n");
    expect(text).toContain("Screenshot (dot-by-dot): 960x540px");
    expect(text).toContain("(full screen, no origin offset)");
    // The origin form belongs to a region capture; a full-screen one must not
    // grow one, or callers would start offsetting coordinates that are already
    // absolute.
    expect(text).not.toContain("origin: (");
  });
});

// Internal #247 (gate 2 on #769): screenshot(detail='ocr') captured and OCRed the window itself,
// without the OCR entries that refuse a frozen app — so hidden, suspended Settings returned its last
// frame's words, the account name among them, as the window now.
describe("detail='ocr' — the language that read (internal #357)", () => {
  const notepad = { hwnd: 6060n, title: "Notes", zOrder: 0, region: { x: 0, y: 0, width: 300, height: 200 }, isActive: true, isMinimized: false, isMaximized: false, isCloaked: false };
  it("warns when the language asked for was read by another engine", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    mockEnumWindowsInZOrder.mockReturnValue([notepad]);
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(false);
    mockCaptureWindowBackground.mockReset().mockResolvedValue({ base64: B64, mimeType: "image/png", width: 300, height: 200 });
    mockRunOcr.mockResolvedValueOnce([]);
    mockOcrLanguageWarning.mockReturnValueOnce("ocr_language_fallback: no pack for 'en'");
    const result = await screenshotOcrHandler({ windowTitle: "Notes", language: "en" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(mockOcrLanguageWarning).toHaveBeenCalledWith("en");
    expect(body.hints?.warnings).toContain("ocr_language_fallback: no pack for 'en'");
  });
  it("adds no warning when the engine was the one asked for (control)", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    mockEnumWindowsInZOrder.mockReturnValue([notepad]);
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(false);
    mockCaptureWindowBackground.mockReset().mockResolvedValue({ base64: B64, mimeType: "image/png", width: 300, height: 200 });
    mockRunOcr.mockResolvedValueOnce([]);
    mockOcrLanguageWarning.mockReturnValueOnce(null);
    const result = await screenshotOcrHandler({ windowTitle: "Notes", language: "ja" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.hints).toBeUndefined();
  });
});

describe("detail='ocr' — a frozen window is not captured (internal #247)", () => {
  const settings = { hwnd: 527016n, title: "Settings", zOrder: 0, region: { x: 0, y: 1, width: 884, height: 591 }, isActive: false, isMinimized: false, isMaximized: false, isCloaked: true };

  it("refuses with WindowFrozen and its advice, before any capture", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    mockEnumWindowsInZOrder.mockReturnValue([settings]);
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(true);
    mockCaptureWindowBackground.mockClear();

    const result = await screenshotOcrHandler({ windowTitle: "Settings", language: "ja" });
    const body = JSON.parse((result.content[0] as { text: string }).text) as { ok: boolean; code: string; error: string; suggest?: string[] };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("WindowFrozen");
    expect(body.error).toContain("suspended by Windows");
    expect(body.error).not.toContain("runSomPipeline");
    expect(body.suggest?.join(" ")).toMatch(/Restore or show the window/);
    expect(mockCaptureWindowBackground).not.toHaveBeenCalled();
  });

  // Codex on 45cf57d1: detail='text' read UIA first — from a 90 s cache filled while the app was
  // shown — and with elements there no OCR ran, so the refusals in the OCR entries never fired.
  it("detail='text' refuses with WindowFrozen before any UIA read", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    mockEnumWindowsInZOrder.mockReturnValue([settings]);
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(true);

    const result = await screenshotHandler({ ...baseArgs, windowTitle: "Settings", detail: "text" });
    const body = JSON.parse((result.content[0] as { text: string }).text) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("WindowFrozen");
  });

  it("captures a window that is not frozen", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    mockEnumWindowsInZOrder.mockReturnValue([settings]);
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(false);
    mockCaptureWindowBackground.mockReset().mockRejectedValue(new Error("stop: reached the capture"));

    await screenshotOcrHandler({ windowTitle: "Settings", language: "ja" });
    expect(mockCaptureWindowBackground).toHaveBeenCalledTimes(1);
  });
});

// internal #229: the terminal guard is decided by the window's class, not the owning process.
describe("screenshot(detail:'text') terminal guard by window class (internal #229)", () => {
  const con = { hwnd: 4242n, title: "k918-con", region: { x: 0, y: 0, width: 400, height: 300 }, zOrder: 0, isActive: true, isMinimized: false, isMaximized: false, isCloaked: false };
  it("takes a ConsoleWindowClass window down the terminal road", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    mockEnumWindowsInZOrder.mockReturnValue([con]);
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(false);
    mockGetWindowClassName.mockReturnValue("ConsoleWindowClass");
    mockGetTextViaTextPattern.mockResolvedValue("C:\\> dir");
    const result = await screenshotHandler({ ...baseArgs, windowTitle: "k918-con", detail: "text" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.hints?.terminalGuard).toBe(true);
    expect(body.textContent).toContain("dir");
    expect(mockGetWindowClassName).toHaveBeenCalledWith(4242n);
  });

  it("lists the controls of a form a shell owns, instead of taking it down the terminal road", async () => {
    // Owned by pwsh, which the old process-name rule took for a terminal (win2's #229 fixture).
    mockResolveWindowTarget.mockResolvedValue(null);
    mockEnumWindowsInZOrder.mockReturnValue([{ ...con, title: "k918-form" }]);
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(false);
    mockGetWindowClassName.mockReturnValue("WindowsForms10.Window.8.app.0.2bf8098_r6_ad1");
    mockGetTextViaTextPattern.mockClear();
    mockGetUiElements.mockResolvedValue({
      windowTitle: "k918-form",
      windowClassName: "WindowsForms10.Window.8.app.0.2bf8098_r6_ad1",
      windowRect: { x: 0, y: 0, width: 400, height: 300 },
      elementCount: 1,
      elements: [{ name: "Submit", controlType: "Button", automationId: "submit", isEnabled: true, boundingRect: { x: 20, y: 40, width: 80, height: 24 }, patterns: ["InvokePattern"], depth: 1 }],
    });
    // ocrFallback "never": the UIA road only (one element would otherwise read as sparse and try OCR).
    const result = await screenshotHandler({ ...baseArgs, windowTitle: "k918-form", detail: "text", ocrFallback: "never" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.hints?.terminalGuard).toBeUndefined();
    expect(mockGetTextViaTextPattern).not.toHaveBeenCalled();
    expect(JSON.stringify(body.actionable)).toContain("Submit");
  });
  // internal #362: an untitled console (conhost started directly) reached by its handle.
  const other = { ...con, hwnd: 7000n, title: "Notepad", zOrder: 0 };
  const untitled = { ...con, hwnd: 5151n, title: "", zOrder: 1, isActive: false };
  it("takes an untitled console reached by hwnd down the terminal road, reading that window (internal #362)", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "", hwnd: 5151n, warnings: [] });
    mockEnumWindowsInZOrder.mockReturnValue([other, untitled]);
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(false);
    mockGetWindowClassName.mockImplementation((h: bigint) => (h === 5151n ? "ConsoleWindowClass" : "Notepad"));
    mockGetTextViaTextPattern.mockReset().mockResolvedValue("C:\\> dir");
    const result = await screenshotHandler({ ...baseArgs, hwnd: "5151", detail: "text" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.hints?.terminalGuard).toBe(true);
    expect(body.textContent).toContain("dir");
    expect(body.windows).toBeUndefined();
    expect(mockGetTextViaTextPattern).toHaveBeenCalledWith("", undefined, { pinnedHwnd: 5151n });
  });
  it("reads the resolved one of two same-titled consoles (internal #362)", async () => {
    const twin = { ...con, hwnd: 4343n, zOrder: 1, isActive: false };
    mockResolveWindowTarget.mockResolvedValue({ title: "k918-con", hwnd: 4343n, warnings: [] });
    mockEnumWindowsInZOrder.mockReturnValue([con, twin]);
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(false);
    mockGetWindowClassName.mockReturnValue("ConsoleWindowClass");
    mockGetTextViaTextPattern.mockReset().mockResolvedValue("C:\\> dir");
    await screenshotHandler({ ...baseArgs, hwnd: "4343", detail: "text" });
    expect(mockGetTextViaTextPattern).toHaveBeenCalledWith("k918-con", undefined, { pinnedHwnd: 4343n });
  });
  it("observes a console named by hwnd under its handle, so a same-titled twin is not a restart (internal #362)", async () => {
    const a = { ...con, hwnd: 8101n, title: "k960-twin", zOrder: 0 };
    const b = { ...con, hwnd: 8102n, title: "k960-twin", zOrder: 1, isActive: false };
    mockEnumWindowsInZOrder.mockReturnValue([a, b]);
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(false);
    mockGetWindowClassName.mockReturnValue("ConsoleWindowClass");
    mockGetWindowProcessId.mockImplementation((h: bigint) => (h === 8101n ? 5001 : 5002));
    mockGetProcessIdentityByPid.mockImplementation((pid: number) => ({ pid, processName: "cmd", processStartTimeMs: pid }));
    mockGetTextViaTextPattern.mockReset().mockResolvedValue("x");
    try {
      mockResolveWindowTarget.mockResolvedValue({ title: "k960-twin", hwnd: 8101n, warnings: [] });
      await screenshotHandler({ ...baseArgs, hwnd: "8101", detail: "text" });
      mockEnumWindowsInZOrder.mockReturnValue([b]); // A closed in between
      mockResolveWindowTarget.mockResolvedValue({ title: "k960-twin", hwnd: 8102n, warnings: [] });
      const result = await screenshotHandler({ ...baseArgs, hwnd: "8102", detail: "text" });
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(JSON.stringify(body.hints)).not.toContain("process_restarted");
      expect(body.hints?.target?.pid).toBe(5002);
    } finally {
      mockGetWindowProcessId.mockReset().mockReturnValue(1234);
      mockGetProcessIdentityByPid.mockReset().mockReturnValue({ pid: 1234, processName: "pwsh", processStartTimeMs: 100 });
    }
  });
  it("keeps @active on the title's restart question (control, codex on #960)", async () => {
    const r1 = { ...con, hwnd: 8201n, title: "k960-active", zOrder: 0 };
    const r2 = { ...con, hwnd: 8202n, title: "k960-active", zOrder: 0 };
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(false);
    mockGetWindowClassName.mockReturnValue("ConsoleWindowClass");
    mockGetWindowProcessId.mockImplementation((h: bigint) => (h === 8201n ? 6001 : 6002));
    mockGetProcessIdentityByPid.mockImplementation((pid: number) => ({ pid, processName: "cmd", processStartTimeMs: pid }));
    mockGetTextViaTextPattern.mockReset().mockResolvedValue("x");
    try {
      mockEnumWindowsInZOrder.mockReturnValue([r1]);
      mockResolveWindowTarget.mockResolvedValue({ title: "k960-active", hwnd: 8201n, warnings: [] });
      await screenshotHandler({ ...baseArgs, windowTitle: "@active", detail: "text" });
      mockEnumWindowsInZOrder.mockReturnValue([r2]); // the terminal restarted: new window, new process
      mockResolveWindowTarget.mockResolvedValue({ title: "k960-active", hwnd: 8202n, warnings: [] });
      const result = await screenshotHandler({ ...baseArgs, windowTitle: "@active", detail: "text" });
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(JSON.stringify(body.hints)).toContain("process_restarted");
    } finally {
      mockGetWindowProcessId.mockReset().mockReturnValue(1234);
      mockGetProcessIdentityByPid.mockReset().mockReturnValue({ pid: 1234, processName: "pwsh", processStartTimeMs: 100 });
    }
  });
  it("keeps a non-terminal window given by hwnd on the title road, its identity and its tree from one window (internal #362)", async () => {
    // The by-handle read is for terminals only: the UIA tree below is still read by title, so the identity
    // must come from the same (first same-titled) window, not from the handle (gate 2 on #960).
    const a = { ...con, hwnd: 9101n, title: "notes.txt", zOrder: 0 };
    const b = { ...con, hwnd: 9102n, title: "notes.txt", zOrder: 1, isActive: false };
    mockResolveWindowTarget.mockResolvedValue({ title: "notes.txt", hwnd: 9102n, warnings: [] });
    mockEnumWindowsInZOrder.mockReturnValue([a, b]);
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(false);
    mockGetWindowClassName.mockReturnValue("Notepad");
    mockGetTextViaTextPattern.mockClear();
    mockGetUiElements.mockResolvedValue({
      windowTitle: "notes.txt", windowClassName: "Notepad", windowRect: { x: 0, y: 0, width: 400, height: 300 }, elementCount: 1,
      elements: [{ name: "Save", controlType: "Button", automationId: "save", isEnabled: true, boundingRect: { x: 20, y: 40, width: 80, height: 24 }, patterns: ["InvokePattern"], depth: 1 }],
    });
    const result = await screenshotHandler({ ...baseArgs, hwnd: "9102", detail: "text", ocrFallback: "never" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.hints?.terminalGuard).toBeUndefined();
    expect(mockGetTextViaTextPattern).not.toHaveBeenCalled();
    expect(body.hints?.target?.hwnd).toBe("9101");
  });
  it("leaves an untitled window that is not a terminal on its old road (control, internal #362)", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "", hwnd: 5151n, warnings: [] });
    mockEnumWindowsInZOrder.mockReturnValue([other, untitled]);
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(false);
    mockGetWindowClassName.mockReturnValue("Notepad");
    mockGetTextViaTextPattern.mockReset();
    await screenshotHandler({ ...baseArgs, hwnd: "5151", detail: "text" });
    expect(mockGetTextViaTextPattern).not.toHaveBeenCalled();
  });
});
