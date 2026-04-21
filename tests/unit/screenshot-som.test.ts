import { describe, it, expect, vi, beforeEach } from "vitest";
import { screenshotHandler } from "../../src/tools/screenshot.js";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockResolveWindowTarget, mockRunSomPipeline, mockEnumWindowsInZOrder } = vi.hoisted(() => ({
  mockResolveWindowTarget: vi.fn(),
  mockRunSomPipeline: vi.fn(),
  mockEnumWindowsInZOrder: vi.fn(),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: mockResolveWindowTarget,
}));

vi.mock("../../src/engine/ocr-bridge.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/ocr-bridge.js")>();
  return {
    ...actual,
    runSomPipeline: mockRunSomPipeline,
  };
});

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    enumWindowsInZOrder: mockEnumWindowsInZOrder,
  };
});

describe("screenshotHandler - detail='som' mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should block 'som' mode unless confirmImage=true is passed", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "My App", hwnd: "12345" });

    const result = await screenshotHandler({
      detail: "som",
      confirmImage: false,
      windowTitle: "My App",
      maxDimension: 768,
      dotByDot: false,
      grayscale: false,
      webpQuality: 60,
      diffMode: false,
      ocrFallback: "auto",
      ocrLanguage: "ja",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("[screenshot-guard] detail='som' was blocked");
  });

  it("should successfully trigger SoM pipeline when confirmImage=true is passed", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "My App", hwnd: "12345" });
    mockRunSomPipeline.mockResolvedValue({
      elements: [{ id: 1, text: "Click Me", region: { x: 10, y: 10, width: 50, height: 20 } }],
      somImage: { base64: "fake-image", mimeType: "image/png" },
      preprocessScale: 1.0,
    });

    const result = await screenshotHandler({
      detail: "som",
      confirmImage: true,
      windowTitle: "My App",
      maxDimension: 768,
      dotByDot: false,
      grayscale: false,
      webpQuality: 60,
      diffMode: false,
      ocrFallback: "auto",
      ocrLanguage: "ja",
    });

    expect(result.isError).toBeUndefined();
    expect(mockRunSomPipeline).toHaveBeenCalledWith("My App", 12345n, "ja");
    const textContent = JSON.parse(result.content[0].text);
    expect(textContent.detail).toBe("som");
    expect(textContent.elements).toHaveLength(1);
    expect(result.content[1].type).toBe("image");
  });

  it("should prioritize hwnd from resolveWindowTarget", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "My App", hwnd: "54321" });
    mockRunSomPipeline.mockResolvedValue({ elements: [], somImage: null });

    await screenshotHandler({
      detail: "som",
      confirmImage: true,
      windowTitle: "My App",
      maxDimension: 768,
      dotByDot: false,
      grayscale: false,
      webpQuality: 60,
      diffMode: false,
      ocrFallback: "auto",
      ocrLanguage: "ja",
    });

    expect(mockRunSomPipeline).toHaveBeenCalledWith("My App", 54321n, "ja");
  });

  it("should fall back to title search if resolveWindowTarget returns null (plain title match)", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    mockEnumWindowsInZOrder.mockReturnValue([
      { title: "My App (Actual)", hwnd: "99999", region: { x: 0, y: 0, width: 100, height: 100 }, zOrder: 0, isActive: true }
    ]);
    mockRunSomPipeline.mockResolvedValue({ elements: [], somImage: null });

    await screenshotHandler({
      detail: "som",
      confirmImage: true,
      windowTitle: "My App",
      maxDimension: 768,
      dotByDot: false,
      grayscale: false,
      webpQuality: 60,
      diffMode: false,
      ocrFallback: "auto",
      ocrLanguage: "ja",
    });

    expect(mockRunSomPipeline).toHaveBeenCalledWith("My App (Actual)", 99999n, "ja");
  });
});
