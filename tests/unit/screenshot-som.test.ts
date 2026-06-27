import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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

// nut-js loads native libXtst at import and aborts on a Linux unit runner. The
// detail='som' path never calls getWindows, and image.js only binds screen/Region
// inside functions, so a complete fake keeps this suite hermetic without
// importOriginal (Codex review parity with screenshot-emitters-ref).
vi.mock("../../src/engine/nutjs.js", () => ({ getWindows: vi.fn(), screen: {}, Region: class {} }));

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
  // ADR-026 Phase 2: detail='som' persists its bitmap to a disk-cache and returns
  // a by-ref link. Point the cache at a throwaway temp dir so the unit test does
  // not write into the real per-user runtime dir.
  let cacheDir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    cacheDir = path.join(os.tmpdir(), `dt-som-test-${crypto.randomBytes(6).toString("hex")}`);
    process.env.DESKTOP_TOUCH_SCREENSHOTS_DIR = cacheDir;
  });
  afterEach(() => {
    delete process.env.DESKTOP_TOUCH_SCREENSHOTS_DIR;
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("detail='som' WITHOUT confirmImage returns elements + a by-ref link, NOT a guard error (guard removed)", async () => {
    // ADR-026 Phase 2 (Opus R2 P2-B): the heavy-payload guard is gone — bare
    // detail='som' now returns its structured elements[] plus a cheap
    // resource_link by default (no inline image), never an isError block.
    mockResolveWindowTarget.mockResolvedValue({ title: "My App", hwnd: 12345n });
    mockRunSomPipeline.mockResolvedValue({
      elements: [{ id: 1, text: "Click Me", region: { x: 10, y: 10, width: 50, height: 20 }, clickAt: { x: 35, y: 20 } }],
      somImage: { base64: "fake-image", mimeType: "image/png" },
      preprocessScale: 1.0,
      resolvedWindowTitle: "My App",
    });

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

    expect(result.isError).toBeUndefined();
    const textContent = JSON.parse(result.content[0].text);
    expect(textContent.detail).toBe("som");
    expect(textContent.elements).toHaveLength(1);
    // default (no confirmImage): a resource_link, NO inline image.
    expect(result.content.some((c) => c.type === "resource_link")).toBe(true);
    expect(result.content.some((c) => c.type === "image")).toBe(false);
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
    expect(mockRunSomPipeline).toHaveBeenCalledWith("My App", 12345n, "ja", 2, "auto", false);
    const textContent = JSON.parse(result.content[0].text);
    expect(textContent.window).toBe("My App");
    expect(textContent.detail).toBe("som");
    expect(textContent.elements).toHaveLength(1);
    // confirmImage=true → inline image first, then the by-ref link (both present).
    expect(result.content[1].type).toBe("image");
    expect(result.content.some((c) => c.type === "resource_link")).toBe(true);
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

    expect(mockRunSomPipeline).toHaveBeenCalledWith("My App", 54321n, "ja", 2, "auto", false);
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
    expect(mockRunSomPipeline).toHaveBeenCalledWith("My App", null, "ja", 2, "auto", false);
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
