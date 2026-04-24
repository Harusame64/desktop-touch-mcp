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
    mockResolveWindowTarget.mockResolvedValue({ title: "My App", hwnd: 12345n });

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
    mockResolveWindowTarget.mockResolvedValue({ title: "My App", hwnd: 12345n });
    mockRunSomPipeline.mockResolvedValue({
      elements: [{ id: 1, text: "Click Me", region: { x: 10, y: 10, width: 50, height: 20 }, clickAt: { x: 35, y: 20 } }],
      somImage: { base64: "fake-image", mimeType: "image/png" },
      preprocessScale: 1.0,
      resolvedWindowTitle: "My App",
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
    expect(mockRunSomPipeline).toHaveBeenCalledWith("My App", 12345n, "ja", 2, "auto");
    const textContent = JSON.parse(result.content[0].text);
    expect(textContent.window).toBe("My App");
    expect(textContent.detail).toBe("som");
    expect(textContent.elements).toHaveLength(1);
    expect(result.content[1].type).toBe("image");
  });

  it("should prioritize hwnd from resolveWindowTarget and use resolved title in output", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "My App", hwnd: 54321n });
    mockRunSomPipeline.mockResolvedValue({
      elements: [],
      somImage: null,
      preprocessScale: 1.0,
      resolvedWindowTitle: "My App — Full Title",
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

    expect(mockRunSomPipeline).toHaveBeenCalledWith("My App", 54321n, "ja", 2, "auto");
    expect(mockEnumWindowsInZOrder).not.toHaveBeenCalled();
    const textContent = JSON.parse(result.content[0].text);
    expect(textContent.window).toBe("My App — Full Title");
  });

  it("should delegate title search to runSomPipeline when resolveWindowTarget returns null", async () => {
    mockResolveWindowTarget.mockResolvedValue(null);
    mockRunSomPipeline.mockResolvedValue({
      elements: [],
      somImage: null,
      preprocessScale: 1.0,
      resolvedWindowTitle: "My App (Actual)",
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

    // Handler passes null hwnd; runSomPipeline handles its own window search
    expect(mockRunSomPipeline).toHaveBeenCalledWith("My App", null, "ja", 2, "auto");
    expect(mockEnumWindowsInZOrder).not.toHaveBeenCalled();
    // window field must reflect the full resolved title, not the partial input
    const textContent = JSON.parse(result.content[0].text);
    expect(textContent.window).toBe("My App (Actual)");
  });

  it("should return only text content when somImage is null", async () => {
    mockResolveWindowTarget.mockResolvedValue({ title: "My App", hwnd: 12345n });
    mockRunSomPipeline.mockResolvedValue({
      elements: [],
      somImage: null,
      preprocessScale: 1.0,
      resolvedWindowTitle: "My App",
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
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });
});
