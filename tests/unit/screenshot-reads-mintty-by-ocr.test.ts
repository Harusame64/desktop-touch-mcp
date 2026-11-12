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

// internal #363: OCR by handle is the seam; everything else in ocr-bridge is real.
const { mockRecognizeWindowByHwnd } = vi.hoisted(() => ({ mockRecognizeWindowByHwnd: vi.fn() }));
vi.mock("../../src/engine/ocr-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/ocr-bridge.js")>();
  return { ...actual, recognizeWindowByHwnd: mockRecognizeWindowByHwnd };
});

const { screenshotHandler } = await import("../../src/tools/screenshot.js");


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


// internal #363: Git Bash's mintty exposes no text to UI Automation; its text is read with OCR.
describe("screenshot(detail:'text') reads a mintty window with OCR (internal #363)", () => {
  const mintty = { hwnd: 7373n, title: "MINGW64:/c/work", region: { x: 10, y: 20, width: 600, height: 400 }, zOrder: 0, isActive: true, isMinimized: false, isMaximized: false, isCloaked: false };
  const word = (text: string, x: number, y: number) => ({ text, bbox: { x, y, width: 40, height: 16 } });
  function wire(cls: string) {
    mockResolveWindowTarget.mockResolvedValue(null);
    mockEnumWindowsInZOrder.mockReturnValue([mintty]);
    mockIsWindowProcessFrozen.mockReset().mockReturnValue(false);
    mockGetWindowClassName.mockReturnValue(cls);
    mockGetTextViaTextPattern.mockReset();
    mockGetUiElements.mockResolvedValue({
      windowTitle: mintty.title, windowClassName: cls, windowRect: mintty.region, elementCount: 6,
      elements: [{ name: "Line up", controlType: "Button", automationId: "", isEnabled: true, boundingRect: { x: 590, y: 30, width: 16, height: 16 }, patterns: ["InvokePattern"], depth: 2 }],
    });
    mockRecognizeWindowByHwnd.mockReset().mockResolvedValue({ words: [word("$", 0, 0), word("ls", 20, 0), word("README.md", 0, 20)], origin: { x: 10, y: 20 } });
  }

  it("answers the terminal shape with the OCR'd lines, reading that window", async () => {
    wire("mintty");
    const result = await screenshotHandler({ ...baseArgs, windowTitle: "MINGW64", detail: "text" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.hints?.terminalGuard).toBe(true);
    expect(body.hints?.textSource).toBe("ocr");
    expect(body.textContent).toContain("README.md");
    expect(body.actionable).toEqual([]);
    expect(mockRecognizeWindowByHwnd).toHaveBeenCalledWith(7373n, mintty.region, "ja");
    expect(mockGetTextViaTextPattern).not.toHaveBeenCalled();
  });

  it("falls back to the window's controls when OCR cannot run", async () => {
    wire("mintty");
    mockRecognizeWindowByHwnd.mockReset().mockRejectedValue(new Error("win-ocr.exe not found"));
    const result = await screenshotHandler({ ...baseArgs, windowTitle: "MINGW64", detail: "text" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(mockRecognizeWindowByHwnd).toHaveBeenCalled();
    expect(body.hints?.terminalGuard).toBeUndefined();
    expect(JSON.stringify(body.actionable)).toContain("Line up");
  });

  it("does not OCR a mintty window when ocrFallback is 'never'", async () => {
    wire("mintty");
    await screenshotHandler({ ...baseArgs, windowTitle: "MINGW64", detail: "text", ocrFallback: "never" });
    expect(mockRecognizeWindowByHwnd).not.toHaveBeenCalled();
  });

  it("keeps a window of another class on its road (control)", async () => {
    wire("Notepad");
    const result = await screenshotHandler({ ...baseArgs, windowTitle: "MINGW64", detail: "text", ocrFallback: "never" });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.hints?.terminalGuard).toBeUndefined();
    expect(mockRecognizeWindowByHwnd).not.toHaveBeenCalled();
  });
});
