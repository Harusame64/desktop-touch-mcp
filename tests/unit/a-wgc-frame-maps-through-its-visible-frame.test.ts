/**
 * internal #246 — a Windows Graphics Capture frame is mapped to the screen through the window's
 * visible frame, not through `GetWindowRect`.
 *
 * WGC crops its frame to the content, which starts at DWM's visible frame; the rect includes the
 * invisible resize border. win2 measured (2026-10-04, internal #243): rect corner (1191,170),
 * visible frame (1198,170), and the image matched the screen only at dx = 7. Every road that maps a
 * captured pixel (dot-by-dot origins, OCR boxes) asks `capturedFrameRect` which rectangle the frame
 * covers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ visible: vi.fn(), rect: vi.fn() }));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return { ...actual, getVisibleFrameRectByHwnd: mocks.visible, getWindowRectByHwnd: mocks.rect };
});
// image.ts imports nut-js, which loads native libXtst at import and aborts a Linux unit runner
// (codex on c183454c); nothing here uses it.
vi.mock("../../src/engine/nutjs.js", () => ({ screen: {}, Region: class {} }));

import { capturedFrameRect } from "../../src/engine/image.js";

const rect = { x: 1191, y: 170, width: 726, height: 860 };
const visible = { x: 1198, y: 170, width: 712, height: 853 };

beforeEach(() => {
  // The window has not moved since the rect was read, unless a cell says otherwise.
  mocks.rect.mockReset().mockReturnValue({ ...rect });
});

describe("capturedFrameRect", () => {
  it("answers the visible frame for a WGC frame", () => {
    mocks.visible.mockReset().mockReturnValue(visible);
    expect(capturedFrameRect(657818n, "wgc", rect)).toEqual(visible);
    expect(mocks.visible).toHaveBeenCalledWith(657818n);
  });

  it("answers null for a WGC frame whose visible frame cannot be read — not the rect", () => {
    mocks.visible.mockReset().mockReturnValue(null);
    expect(capturedFrameRect(657818n, "wgc", rect)).toBeNull();
    expect(capturedFrameRect(657818, "wgc", rect)).toBeNull();
  });

  it("answers the rect for PrintWindow and BitBlt frames, without asking", () => {
    mocks.visible.mockReset().mockReturnValue(visible);
    expect(capturedFrameRect(657818n, "printwindow", rect)).toBe(rect);
    expect(capturedFrameRect(657818n, "bitblt-fallback", rect)).toBe(rect);
    expect(mocks.visible).not.toHaveBeenCalled();
  });

  // Gate 2 on #770: nothing checked that the WGC frame is the visible frame's shape; OCR's scale
  // would stretch any mismatch to fit and hide it.
  it("answers null when the captured image is not the visible frame's shape", () => {
    mocks.visible.mockReset().mockReturnValue(visible);
    expect(capturedFrameRect(657818n, "wgc", rect, { width: 726, height: 860 })).toBeNull(); // the rect's shape
    expect(capturedFrameRect(657818n, "wgc", rect, { width: 1280, height: 720 })).toBeNull();
  });

  it("accepts the frame for a whole or downscaled image of its shape", () => {
    mocks.visible.mockReset().mockReturnValue(visible);
    expect(capturedFrameRect(657818n, "wgc", rect, { width: 712, height: 853 })).toEqual(visible);
    expect(capturedFrameRect(657818n, "wgc", rect, { width: 356, height: 427 })).toEqual(visible);
  });

  // Codex on d5b63769: the frame is read after the capture; a window that moved meanwhile would give
  // old pixels the new corner.
  it("answers null when the window moved or resized since its rect was read", () => {
    mocks.visible.mockReset().mockReturnValue(visible);
    mocks.rect.mockReturnValue({ ...rect, x: rect.x + 40 });
    expect(capturedFrameRect(657818n, "wgc", rect, { width: 712, height: 853 })).toBeNull();
    mocks.rect.mockReturnValue({ ...rect, width: rect.width + 1 });
    expect(capturedFrameRect(657818n, "wgc", rect, { width: 712, height: 853 })).toBeNull();
    mocks.rect.mockReturnValue(null);
    expect(capturedFrameRect(657818n, "wgc", rect, { width: 712, height: 853 })).toBeNull();
  });
});
