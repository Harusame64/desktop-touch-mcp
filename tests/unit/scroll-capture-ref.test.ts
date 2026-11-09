/**
 * scroll-capture-ref.test.ts — ADR-026 Phase 2b.
 *
 * Pins the by-ref delivery of scroll(action='capture'): the stitched scroll image
 * is persisted to the disk-cache and returned as a resource_link (ref-only — no
 * confirmImage param). The structured `summary` (frame count / overlap stats /
 * sizeReduced) stays bit-equal.
 *
 * nut-js (libXtst) is the hard native aborter on a Linux unit runner. It reaches
 * this graph two ways, so BOTH are cut off: `engine/nutjs.js` (used directly by
 * scroll-capture) is a complete fake, and `utils/key-map.js` is mocked so its
 * direct raw `@nut-tree-fork/nut-js` import never loads (Codex review). With those
 * faked, screen.grabRegion returns uniform frames → page-end after two identical
 * reads → a single stitched frame goes through REAL sharp. win32 / _resolve-window
 * stay importOriginal: their windows-rs napi addon loads in the unit lane (run
 * Windows-local; CI does not run the TS unit SUITE on Linux — since #662 it runs two
 * files, of which this is not one, in the `wire-schema-pins` job — and that job installs
 * libX11/libXtst for exactly the reason this header gives).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const { mockReadPercent, mockCapture, mockGrabRegion, mockRestoreAndFocus, mockResolveWindowTarget, mockFindPlain, mockForeground, mockPressKey, mockOffDesktop } = vi.hoisted(() => ({
  mockReadPercent: vi.fn(),
  mockCapture: vi.fn(),
  mockOffDesktop: vi.fn(),
  mockForeground: vi.fn(),
  mockPressKey: vi.fn(async () => {}),
  mockGrabRegion: vi.fn(),
  mockRestoreAndFocus: vi.fn(),
  mockResolveWindowTarget: vi.fn(),
  mockFindPlain: vi.fn(),
}));

// Complete fake for nut-js (the Linux aborter). scroll-capture imports
// screen / keyboard / mouse / Region from it.
vi.mock("../../src/engine/nutjs.js", () => ({
  screen: { grabRegion: mockGrabRegion },
  keyboard: { pressKey: mockPressKey, releaseKey: vi.fn(async () => {}) },
  mouse: { scrollRight: vi.fn(async () => {}) },
  Region: class { constructor(public x: number, public y: number, public width: number, public height: number) {} },
}));
// scroll-capture's `parseKeys` comes from key-map.ts, which imports the RAW
// @nut-tree-fork/nut-js (`Key` enum) directly — NOT via engine/nutjs.js — so the
// real package's libXtst aborts at load on a Linux lane (Codex P1). Mock key-map
// itself so the raw package never loads; parseKeys' result is fed to the mocked
// keyboard (no-op), so an empty key list suffices.
vi.mock("../../src/utils/key-map.js", () => ({ parseKeys: () => [] }));
vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return { ...actual, restoreAndFocusWindow: mockRestoreAndFocus, getForegroundHwnd: mockForeground, getWindowRoot: (h: bigint) => h, enumWindowsInZOrder: () => [{ hwnd: 1n, title: "W", isCloaked: false }], getWindowTitleW: () => "Other" };
});
vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return { ...actual, resolveWindowTarget: mockResolveWindowTarget, findPlainTopLevelWindowByTitle: mockFindPlain };
});

// The capture itself is faked at the backend selector, so the frames are the fake's whichever backend
// the machine would pick (gdi-bitblt where the native addon loads skips nut-js entirely; agy on #915).
vi.mock("../../src/engine/image.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/image.js")>();
  return { ...actual, grabScreenRegionValidated: mockCapture };
});
// internal #326 (B): the UIA scroll position. Resolves null (no ScrollPattern) unless a test sets it.
vi.mock("../../src/engine/native-engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/native-engine.js")>();
  return { ...actual, nativeUia: { ...(actual.nativeUia ?? {}), uiaReadScrollPercentAtHwnd: mockReadPercent } };
});
vi.mock("../../src/tools/_off-desktop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_off-desktop.js")>();
  return { ...actual, offDesktopTarget: mockOffDesktop };
});
const { scrollCaptureHandler, scrollPositionReader } = await import("../../src/tools/scroll-capture.js");

/** A uniform-gray RGBA frame; identical reads trigger the page-end break. */
function uniformFrame(w: number, h: number) {
  const data = Buffer.alloc(w * h * 4, 128);
  return { toRGB: async () => ({ data, width: w, height: h, hasAlphaChannel: true }) };
}

let cacheDir: string;
beforeEach(() => {
  vi.clearAllMocks();
  cacheDir = path.join(os.tmpdir(), `dt-scroll-test-${crypto.randomBytes(6).toString("hex")}`);
  process.env.DESKTOP_TOUCH_SCREENSHOTS_DIR = cacheDir;
  mockResolveWindowTarget.mockResolvedValue(null);
  mockFindPlain.mockReturnValue({ hwnd: 1n });
  mockRestoreAndFocus.mockReturnValue({ x: 0, y: 0, width: 200, height: 200 });
  mockGrabRegion.mockResolvedValue(uniformFrame(200, 200));
  mockCapture.mockResolvedValue({ data: Buffer.alloc(200 * 200 * 4, 128), width: 200, height: 200, channels: 4 });
  mockForeground.mockReturnValue(1n);
  mockOffDesktop.mockResolvedValue(null);
  mockReadPercent.mockResolvedValue(null);
});
afterEach(() => {
  delete process.env.DESKTOP_TOUCH_SCREENSHOTS_DIR;
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("scroll(action='capture') — ADR-026 §3 ref-only delivery", () => {
  it("stitched image is a resource_link (no inline) and the summary survives", async () => {
    const result = await scrollCaptureHandler({
      windowTitle: "Doc", direction: "down", maxScrolls: 5, scrollDelayMs: 100, maxWidth: 1280,
    });

    const links = result.content.filter((c) => c.type === "resource_link");
    const images = result.content.filter((c) => c.type === "image");
    expect(links).toHaveLength(1);
    expect(images).toHaveLength(0);

    // The structured summary (frames / overlapMode / direction) is preserved.
    const summaryText = (result.content.find((c) => c.type === "text") as { text: string }).text;
    const summary = JSON.parse(summaryText);
    expect(summary.ok).toBe(true);
    expect(summary.direction).toBe("down");
    expect(typeof summary.frames).toBe("number");
  }, 15000);
});

// internal #326 (win2, 2026-11-09): Windows refused the foreground, keys went to the window in
// front, and the capture answered ok:true with one frame of that window.
describe("scroll(action='capture') needs the window in front (internal #326)", () => {
  it("refuses with ForegroundRestricted, sends no keys and captures nothing, after asking twice (the second time forced)", async () => {
    mockForeground.mockReturnValue(999n);
    const r = await scrollCaptureHandler({ windowTitle: "W", direction: "down", maxScrolls: 3, scrollDelayMs: 0, maxWidth: 800 } as never);
    const body = JSON.parse((r.content[0] as { text: string }).text);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("ForegroundRestricted");
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockPressKey).not.toHaveBeenCalled();
    expect(mockRestoreAndFocus).toHaveBeenCalledTimes(2);
    expect(mockRestoreAndFocus).toHaveBeenLastCalledWith(1n, { force: true });
    expect(body.context?.attemptedForce).toBe(true);
    expect(body.context?.inFront).toBe("Other");
  });

  it("goes on when the forced request brings it in front", async () => {
    mockForeground.mockReturnValueOnce(999n).mockReturnValue(1n);
    const r = await scrollCaptureHandler({ windowTitle: "W", direction: "down", maxScrolls: 1, scrollDelayMs: 0, maxWidth: 800 } as never);
    const text = (r.content as { type: string; text?: string }[]).find((b) => b.type === "text")!.text!;
    expect(JSON.parse(text).ok).toBe(true);
    expect(mockCapture).toHaveBeenCalled();
  });
});

describe("scroll(action='capture') checks the front before every key and frame (gate 2 on #915)", () => {
  const args = { windowTitle: "W", direction: "down", maxScrolls: 3, scrollDelayMs: 0, maxWidth: 800 } as never;
  const textOf = (r: { content: { type: string; text?: string }[] }) => JSON.parse(r.content.find((b) => b.type === "text")!.text!);

  it("refuses before Ctrl+Home when the window lost the front after it was brought forward", async () => {
    mockForeground.mockReturnValueOnce(1n).mockReturnValue(999n);
    const body = textOf(await scrollCaptureHandler(args) as never);
    expect(body.code).toBe("ForegroundRestricted");
    expect(body.context?.lostPartWay ?? body.lostPartWay).toBe(true);
    expect(JSON.stringify(body)).toContain("before any key was sent");
    expect(JSON.stringify(body)).not.toContain("did not bring the window to the front");
    expect(body.context?.inFront).toBe("Other");
    expect(mockPressKey).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("says Ctrl+Home went to the target when the front is lost before the first frame", async () => {
    // brought forward, before Ctrl+Home: in front; before frame 1: not.
    mockForeground.mockReturnValueOnce(1n).mockReturnValueOnce(1n).mockReturnValue(999n);
    const body = textOf(await scrollCaptureHandler(args) as never);
    expect(body.code).toBe("ForegroundRestricted");
    expect(JSON.stringify(body)).toContain("after Ctrl+Home was sent to it");
    expect(JSON.stringify(body)).not.toContain("nothing was sent");
    expect(mockPressKey).toHaveBeenCalledTimes(1);
    expect(mockCapture).not.toHaveBeenCalled();
  });


  it("stops after the frames it took when the window loses the front part way, sends no more keys and is not pulled back", async () => {
    // brought forward, before Ctrl+Home, before frame 1: in front; before the first PageDown: not.
    mockForeground.mockReturnValueOnce(1n).mockReturnValueOnce(1n).mockReturnValueOnce(1n).mockReturnValue(999n);
    const body = textOf(await scrollCaptureHandler(args) as never);
    expect(body.ok).toBe(true);
    expect(body.frames).toBe(1);
    expect(body.stoppedReason).toBe("foreground_lost");
    expect(body.note).toContain("stopped being in front");
    expect(mockPressKey).toHaveBeenCalledTimes(1); // Ctrl+Home only
    expect(mockRestoreAndFocus).toHaveBeenCalledTimes(1);
  });

  it("refuses a window on another virtual desktop without bringing it forward (internal #221)", async () => {
    mockOffDesktop.mockResolvedValue({ hwnd: 1n, title: "W", sameTitleOnScreen: false });
    const r = await scrollCaptureHandler({ ...(args as object), windowTitle: "W" } as never);
    const body = JSON.parse((r.content[0] as { text: string }).text);
    expect(body.code).toBe("WindowOnOtherDesktop");
    expect(mockRestoreAndFocus).not.toHaveBeenCalled();
    expect(mockPressKey).not.toHaveBeenCalled();
  });
});

// internal #326 (B), measured by win2 2026-11-10: on 165 px sections a PageDown changed only the
// section numbers, the strips matched, and the capture stopped after one frame. The pixels cannot tell
// that from a page end, so the UIA scroll position decides where the window has one.
describe("scroll(action='capture') page end on periodic content (internal #326 (B))", () => {
  const run = async (maxScrolls: number) => {
    const r = await scrollCaptureHandler({ windowTitle: "W", direction: "down", maxScrolls, scrollDelayMs: 0, maxWidth: 800 } as never);
    return JSON.parse((r.content as { type: string; text?: string }[]).find((b) => b.type === "text")!.text!);
  };

  it("goes on while the scroll position moves, though the frames look identical", async () => {
    let pct = 0;
    mockReadPercent.mockImplementation(async () => (pct += 10));
    const body = await run(3);
    expect(body.ok).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(4);
    expect(body.warning).toContain("maxScrolls reached");
  });

  it("ends on identical frames once the scroll position stops moving", async () => {
    mockReadPercent.mockResolvedValue(100);
    const body = await run(5);
    expect(body.ok).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(3);
    expect(body.warning).toBeUndefined();
  });

  it("ends on identical frames as before when the window has no scroll position, and stops asking", async () => {
    mockReadPercent.mockResolvedValue(null);
    const body = await run(5);
    expect(body.ok).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(3);
    // The warm-up and the first frame's read come back empty; no more reads after that.
    expect(mockReadPercent).toHaveBeenCalledTimes(2);
  });

  it("keeps the last position across a failed read, so the next good read still shows movement", async () => {
    // warm-up, then frames 0..3: 10, (failed), 30, 40 — the page is still moving throughout.
    mockReadPercent
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(30)
      .mockResolvedValueOnce(40);
    const body = await run(3);
    // frame 1 (failed read) is the first identical hit; frame 2's position moved (10 -> 30), so the
    // run does not end there and reaches maxScrolls.
    expect(mockCapture).toHaveBeenCalledTimes(4);
    expect(body.warning).toContain("maxScrolls reached");
  });
});

describe("scrollPositionReader (internal #326 (B), gate 2 on #916)", () => {
  it("does not queue a read behind one still running", async () => {
    vi.useFakeTimers();
    try {
      mockReadPercent.mockImplementation(() => new Promise(() => {})); // never answers
      const read = scrollPositionReader(1n, "vertical");
      const first = read();
      await vi.advanceTimersByTimeAsync(250);
      expect(await first).toBeNull();
      expect(await read()).toBeNull();
      expect(mockReadPercent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the position and passes the axis", async () => {
    mockReadPercent.mockResolvedValue(42.5);
    const read = scrollPositionReader(7n, "horizontal");
    expect(await read()).toBe(42.5);
    expect(mockReadPercent).toHaveBeenCalledWith({ hwnd: "7", axis: "horizontal" });
  });
});
