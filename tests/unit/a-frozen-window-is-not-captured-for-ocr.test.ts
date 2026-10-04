/**
 * internal #247 — both OCR entries refuse a window whose app Windows has frozen, before capturing it.
 *
 * `runSomPipeline` (discover's OCR lane, screenshot's SoM, the act read-backs) and
 * `recognizeWindowByHwnd` (screenshot's word OCR, which the SoM path falls through to) both captured
 * the window and OCRed it. For a frozen app that capture is its last frame (win2: two captures 5 s
 * apart differed by 0 px), so what came back was not the window now. See
 * `a-frozen-window-is-not-read-as-now.test.ts` for the lane and the window list.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isWindowProcessFrozen: vi.fn<(h: bigint) => boolean | null>(),
  printWindowToBuffer: vi.fn(),
  captureWindowBackground: vi.fn(),
}));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return {
    ...actual,
    isWindowProcessFrozen: mocks.isWindowProcessFrozen,
    isExcludedWindowHandle: () => false,
    enumWindowsInZOrder: () => [
      { hwnd: 527016n, title: "Settings", zOrder: 0, region: { x: 0, y: 1, width: 884, height: 591 }, isActive: false, isMinimized: false, isMaximized: false, isCloaked: true },
    ],
    getWindowDpi: () => 96,
    printWindowToBuffer: mocks.printWindowToBuffer,
  };
});
vi.mock("../../src/engine/image.js", () => ({ captureWindowBackground: mocks.captureWindowBackground }));

import { recognizeWindowByHwnd, runSomPipeline } from "../../src/engine/ocr-bridge.js";
import { WindowFrozenError } from "../../src/engine/window-frozen.js";

const STOP = new Error("stop: reached the capture");

beforeEach(() => {
  mocks.printWindowToBuffer.mockReset().mockImplementation(() => { throw STOP; });
  mocks.captureWindowBackground.mockReset().mockRejectedValue(STOP);
});

describe("runSomPipeline", () => {
  it("refuses a frozen window before capturing it, by handle and by title", async () => {
    mocks.isWindowProcessFrozen.mockReset().mockReturnValue(true);
    await expect(runSomPipeline("Settings", 527016n)).rejects.toBeInstanceOf(WindowFrozenError);
    await expect(runSomPipeline("Settings", null)).rejects.toBeInstanceOf(WindowFrozenError);
    expect(mocks.printWindowToBuffer).not.toHaveBeenCalled();
  });

  it("captures a window that is not frozen, or one it cannot tell about", async () => {
    for (const answer of [false, null]) {
      mocks.isWindowProcessFrozen.mockReset().mockReturnValue(answer);
      mocks.printWindowToBuffer.mockClear();
      await expect(runSomPipeline("Settings", 527016n)).rejects.toBe(STOP);
      expect(mocks.printWindowToBuffer).toHaveBeenCalledTimes(1);
    }
  });
});

describe("recognizeWindowByHwnd", () => {
  const region = { x: 0, y: 1, width: 884, height: 591 };

  it("refuses a frozen window before capturing it", async () => {
    mocks.isWindowProcessFrozen.mockReset().mockReturnValue(true);
    await expect(recognizeWindowByHwnd(527016n, region)).rejects.toBeInstanceOf(WindowFrozenError);
    expect(mocks.captureWindowBackground).not.toHaveBeenCalled();
  });

  it("captures a window that is not frozen", async () => {
    mocks.isWindowProcessFrozen.mockReset().mockReturnValue(false);
    await expect(recognizeWindowByHwnd(527016n, region)).rejects.toBe(STOP);
    expect(mocks.captureWindowBackground).toHaveBeenCalledTimes(1);
  });

  it("says, in words fit to publish, what to do", () => {
    expect(new WindowFrozenError("x").callerDetail).toMatch(/suspended by Windows.*Restore or show the window/s);
  });
});
