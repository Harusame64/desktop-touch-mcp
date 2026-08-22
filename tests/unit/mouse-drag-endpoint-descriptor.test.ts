/**
 * mouse-drag-endpoint-descriptor.test.ts
 *
 * Round 2 P1-2 pin: the endpoint guard descriptor must NOT carry `windowTitle`.
 *
 * The endpoint of a drag is allowed to be in a window other than the named one
 * — that is what a cross-window drag is, and `allowCrossWindowDrag` exists to
 * consent to exactly that. When the endpoint descriptor carried the title, the
 * resolver's title-mismatch refusal (which knows nothing about the flag)
 * vetoed drags the caller explicitly authorised, and even without the flag it
 * pre-empted the dedicated cross-window check — the one whose refusal names
 * the flag.
 *
 * Two pins:
 *   1. start descriptor carries the title, endpoint descriptor does not, and
 *      an authorised cross-window drag executes (negative control).
 *   2. without the flag, an endpoint in another window is refused by the
 *      CrossWindowDragBlocked check — whose message names the flag — not by a
 *      title-mismatch refusal that cannot.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// The cursor is a REAL device (see issue-207 drag pin for the full note) —
// stub the one place that moves it.
vi.mock("../../src/engine/cursor.js", () => ({
  moveCursorTo: vi.fn(async () => undefined),
}));

const { mockRunActionGuard, mockFindContainingWindowFresh } = vi.hoisted(() => ({
  mockRunActionGuard: vi.fn(),
  mockFindContainingWindowFresh: vi.fn(),
}));

vi.mock("../../src/tools/_action-guard.js", () => ({
  runActionGuard: mockRunActionGuard,
  isAutoGuardEnabled: vi.fn(() => true),
}));

vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(() => []),
    restoreAndFocusWindow: vi.fn(),
    getWindowIdentity: vi.fn(() => ({ processName: "test.exe", pid: 1234, processStartTimeMs: 0 })),
    readScrollInfo: vi.fn(() => null),
    getForegroundHwnd: vi.fn(() => null),
    getWindowRectByHwnd: vi.fn(() => null),
  };
});

vi.mock("../../src/engine/window-cache.js", () => ({
  updateWindowCache: vi.fn(),
  findContainingWindow: vi.fn(() => null),
  findContainingWindowFresh: mockFindContainingWindowFresh,
  getCachedWindowByTitle: vi.fn(() => null),
  computeWindowDelta: vi.fn(() => null),
  getSnapshot: vi.fn(() => null),
  WINDOW_CACHE_TTL_EXPORTED_MS: 60_000,
}));

vi.mock("../../src/engine/perception/registry.js", () => ({
  evaluatePreToolGuards: vi.fn(),
  buildEnvelopeFor: vi.fn(),
}));

vi.mock("../../src/engine/perception/tab-drag-heuristic.js", () => ({
  detectTabDragRisk: vi.fn(() => ({ shouldBlock: false, risk: false })),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getElementBounds: vi.fn(() => null),
}));

vi.mock("../../src/engine/reachable-bounds.js", () => ({
  assertCoordinateReachable: vi.fn(),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: {
    click: vi.fn(),
    doubleClick: vi.fn(),
    setPosition: vi.fn(),
    pressButton: vi.fn(),
    releaseButton: vi.fn(),
    drag: vi.fn(),
    config: { mouseSpeed: 1000 },
  },
  Button: { LEFT: "left", RIGHT: "right", MIDDLE: "middle" },
  Point: vi.fn((x, y) => ({ x, y })),
  straightTo: vi.fn((p) => p),
  DEFAULT_MOUSE_SPEED: 1000,
}));

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../../src/tools/_mouse-verify.js", () => ({
  snapshotForVerify: vi.fn(() => Promise.resolve(null)),
  classifyDelivery: vi.fn(() => "unverifiable"),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: vi.fn(async ({ windowTitle }: { windowTitle?: string }) => ({
    title: windowTitle,
    warnings: [],
  })),
  findPlainTopLevelWindowByTitle: vi.fn(() => null),
}));

import { mouseDragHandler } from "../../src/tools/mouse.js";
import * as nutjs from "../../src/engine/nutjs.js";

const mockReleaseButton = vi.mocked(nutjs.mouse.releaseButton);

function cachedWindow(hwnd: bigint, title: string) {
  return {
    hwnd,
    title,
    region: { x: 0, y: 0, width: 800, height: 600 },
    zOrder: 0,
    timestamp: Date.now(),
  };
}

function parseResult(r: { content: { type: string; text: string }[] }) {
  return JSON.parse(r.content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunActionGuard.mockResolvedValue({
    summary: { kind: "auto", status: "ok", canContinue: true, next: "" },
    block: false,
  });
});

describe("mouse_drag endpoint guard descriptor (Round 2 P1-2)", () => {
  it("names the window on the start descriptor but not on the endpoint, and an authorised cross-window drag executes", async () => {
    // Start and end points land in different windows — the authorised case.
    mockFindContainingWindowFresh.mockImplementation((x: number) =>
      x < 300 ? cachedWindow(100n, "Notepad") : cachedWindow(200n, "Explorer")
    );

    const r = parseResult(await mouseDragHandler({
      startX: 100, startY: 100,
      endX: 500, endY: 300,
      windowTitle: "Notepad",
      homing: false,
      speed: 0,
      verifyDelivery: false,
      allowCrossWindowDrag: true,
    }));

    expect(mockRunActionGuard).toHaveBeenCalledTimes(2);
    const [startParams, endParams] = mockRunActionGuard.mock.calls.map((c) => c[0]);
    // The start of a drag must be in the named window — the title stays.
    expect(startParams.descriptor).toMatchObject({ kind: "coordinate", x: 100, y: 100, windowTitle: "Notepad" });
    // The endpoint is allowed to be elsewhere — no title, so the resolver's
    // mismatch refusal cannot veto what allowCrossWindowDrag authorised.
    expect(endParams.descriptor).toMatchObject({ kind: "coordinate", x: 500, y: 300 });
    expect(endParams.descriptor.windowTitle).toBeUndefined();
    // Negative control: the drag actually ran.
    expect(r.ok).toBe(true);
    expect(mockReleaseButton).toHaveBeenCalled();
  });

  it("without the flag, an endpoint in another window is refused by the check that names the flag", async () => {
    mockFindContainingWindowFresh.mockImplementation((x: number) =>
      x < 300 ? cachedWindow(100n, "Notepad") : cachedWindow(200n, "Explorer")
    );

    const r = parseResult(await mouseDragHandler({
      startX: 100, startY: 100,
      endX: 500, endY: 300,
      windowTitle: "Notepad",
      homing: false,
      speed: 0,
      verifyDelivery: false,
    }));

    expect(r.ok).toBe(false);
    // The refusal must be the one that tells the caller how to consent —
    // not a title-mismatch refusal that knows nothing about the flag.
    expect(JSON.stringify(r)).toContain("allowCrossWindowDrag");
    expect(mockReleaseButton).not.toHaveBeenCalled();
  });
});
