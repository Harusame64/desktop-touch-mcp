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
 * Windows-local; CI does not run the TS unit suite on Linux).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const { mockGrabRegion, mockRestoreAndFocus, mockResolveWindowTarget, mockFindPlain } = vi.hoisted(() => ({
  mockGrabRegion: vi.fn(),
  mockRestoreAndFocus: vi.fn(),
  mockResolveWindowTarget: vi.fn(),
  mockFindPlain: vi.fn(),
}));

// Complete fake for nut-js (the Linux aborter). scroll-capture imports
// screen / keyboard / mouse / Region from it.
vi.mock("../../src/engine/nutjs.js", () => ({
  screen: { grabRegion: mockGrabRegion },
  keyboard: { pressKey: vi.fn(async () => {}), releaseKey: vi.fn(async () => {}) },
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
  return { ...actual, restoreAndFocusWindow: mockRestoreAndFocus };
});
vi.mock("../../src/tools/_resolve-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/_resolve-window.js")>();
  return { ...actual, resolveWindowTarget: mockResolveWindowTarget, findPlainTopLevelWindowByTitle: mockFindPlain };
});

const { scrollCaptureHandler } = await import("../../src/tools/scroll-capture.js");

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
