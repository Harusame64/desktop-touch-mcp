/**
 * workspace-snapshot-ref.test.ts — ADR-026 Phase 2b.
 *
 * Pins the by-ref delivery of workspace_snapshot thumbnails: each window
 * thumbnail is persisted to the disk-cache and surfaced as a resource_link
 * (ref-only — workspace_snapshot is an orientation call, N inline thumbnails are
 * the heaviest token accumulator). windows[].thumbnailSize + the per-thumb label
 * stay bit-equal; a persist failure degrades to inline per thumbnail (R6).
 *
 * nut-js (libXtst) is the only native dep that aborts on a Linux unit runner, so
 * nutjs + image (which imports nutjs) are complete fakes; the rest are
 * importOriginal overrides (Rust .node loads cross-platform). includeUiSummary
 * is false so the UIA lane is never exercised.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const { mockCaptureScreen, mockEnumMonitors, mockEnumWindowsInZOrder, mockGetVirtualScreen } = vi.hoisted(() => ({
  mockCaptureScreen: vi.fn(),
  mockEnumMonitors: vi.fn(),
  mockEnumWindowsInZOrder: vi.fn(),
  mockGetVirtualScreen: vi.fn(),
}));

// Complete fakes for the only native aborter (nut-js / libXtst) and image.js
// (imports nutjs). workspace.ts uses mouse.getPosition + captureScreen from them.
vi.mock("../../src/engine/nutjs.js", () => ({ mouse: { getPosition: async () => ({ x: 7, y: 9 }) } }));
vi.mock("../../src/engine/image.js", () => ({ captureScreen: mockCaptureScreen }));

vi.mock("../../src/engine/win32.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/win32.js")>();
  return { ...actual, enumMonitors: mockEnumMonitors, enumWindowsInZOrder: mockEnumWindowsInZOrder, getVirtualScreen: mockGetVirtualScreen };
});
vi.mock("../../src/engine/layer-buffer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/layer-buffer.js")>();
  return { ...actual, clearLayers: vi.fn() };
});
vi.mock("../../src/engine/identity-tracker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/identity-tracker.js")>();
  return { ...actual, noteInvalidation: vi.fn() };
});
vi.mock("../../src/engine/window-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/window-cache.js")>();
  return { ...actual, updateWindowCache: vi.fn() };
});

const { workspaceSnapshotHandler } = await import("../../src/tools/workspace.js");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3, 1, 4, 1]);
const B64 = PNG.toString("base64");

let cacheDir: string;
beforeEach(() => {
  vi.clearAllMocks();
  cacheDir = path.join(os.tmpdir(), `dt-ws-test-${crypto.randomBytes(6).toString("hex")}`);
  process.env.DESKTOP_TOUCH_SCREENSHOTS_DIR = cacheDir;
  mockEnumMonitors.mockReturnValue([{ id: 0, primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, dpi: 96, scale: 100 }]);
  mockGetVirtualScreen.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
  mockCaptureScreen.mockResolvedValue({ base64: B64, width: 400, height: 300 });
});
afterEach(() => {
  delete process.env.DESKTOP_TOUCH_SCREENSHOTS_DIR;
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function win(title: string) {
  return { title, region: { x: 0, y: 0, width: 800, height: 600 }, zOrder: 0, isActive: true, isMinimized: false };
}

describe("workspace_snapshot — ADR-026 §3 ref-only thumbnails", () => {
  it("each window thumbnail is a resource_link, NO inline image; thumbnailSize preserved", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([win("Window A"), win("Window B")]);
    const result = await workspaceSnapshotHandler({ thumbnailMaxDimension: 400, includeUiSummary: false });

    const links = result.content.filter((c) => c.type === "resource_link");
    const images = result.content.filter((c) => c.type === "image");
    expect(links).toHaveLength(2);   // one ref per window
    expect(images).toHaveLength(0);  // no inline thumbnails

    // The structured JSON still carries thumbnailSize for each window.
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.windowCount).toBe(2);
    expect(parsed.windows[0].thumbnailSize).toEqual({ width: 400, height: 300 });
    // The per-thumb label survives.
    expect(result.content.some((c) => c.type === "text" && /↑ "Window A"/.test((c as { text: string }).text))).toBe(true);
  });

  it("R6: a persist failure degrades that thumbnail to an inline image + warning", async () => {
    mockEnumWindowsInZOrder.mockReturnValue([win("Window A")]);
    // Point the cache under an existing file so the per-user dir create throws.
    const blockerDir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-ws-blocker-"));
    const blocker = path.join(blockerDir, "file");
    fs.writeFileSync(blocker, "x");
    process.env.DESKTOP_TOUCH_SCREENSHOTS_DIR = path.join(blocker, "sub");
    try {
      const result = await workspaceSnapshotHandler({ thumbnailMaxDimension: 400, includeUiSummary: false });
      expect(result.content.some((c) => c.type === "image")).toBe(true);            // degrade keeps the pixels
      expect(result.content.some((c) => c.type === "resource_link")).toBe(false);   // no ref when persist failed
      expect(result.content.some((c) => c.type === "text" && /disk-cache write failed/i.test((c as { text: string }).text))).toBe(true);
      expect(result.isError).toBeUndefined();
    } finally {
      fs.rmSync(blockerDir, { recursive: true, force: true });
    }
  });
});
