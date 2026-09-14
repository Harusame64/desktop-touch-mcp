/**
 * adr-036-pixel-stage-cold-cache.test.ts — the pixel stage runs on a cold cache.
 *
 * For a window whose content is a PICTURE — a VM viewer, a game, a canvas — pixels are the only
 * evidence there is: UIA sees nothing inside it, and `desktop_discover` returns only the window's
 * own decorations. Stage 4 is the road that answers there, and it was gated on the CACHE-ONLY
 * window reader, so a null answer skipped it in silence.
 *
 * Measured on such a window (win2, `a656b52`): cold, **0 of 9 clicks ran the stage**, and a click
 * that repainted the whole window answered exactly like a click that changed nothing. Warm — after
 * an unrelated `workspace_snapshot` — **10 of 10 ran and every one was right**. `mouse_click` does
 * not warm the cache itself, and neither do `desktop_discover`, `desktop_state`, `window_dock` or
 * `mouse_move`. So the promise was real, accurate, and armed by coincidence.
 *
 * The fix is the sibling reader, whose own doc has argued for it since it was written: "Expiring an
 * entry has to mean re-verify, not unclickable."
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockRunActionGuard, mockEvaluatePreToolGuards, mockBuildEnvelopeFor, mockCaptureFrame,
  mockFindContainingWindow, mockFindContainingWindowFresh,
} = vi.hoisted(() => ({
  mockRunActionGuard: vi.fn(),
  mockEvaluatePreToolGuards: vi.fn(),
  mockBuildEnvelopeFor: vi.fn(),
  mockCaptureFrame: vi.fn(async () => ({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) })),
  /** The cold cache answers nothing; the fresh reader enumerates and finds the picture window. */
  mockFindContainingWindow: vi.fn(() => null),
  mockFindContainingWindowFresh: vi.fn(() => ({
    hwnd: 4242n, title: "VM viewer", region: { x: 0, y: 0, width: 640, height: 480 }, zOrder: 0,
  })),
}));

vi.mock("../../src/engine/cursor.js", () => ({ moveCursorTo: vi.fn(async () => undefined) }));
vi.mock("../../src/tools/_action-guard.js", () => ({
  runActionGuard: mockRunActionGuard,
  isAutoGuardEnabled: () => true,
}));
vi.mock("../../src/engine/perception/registry.js", () => ({
  evaluatePreToolGuards: mockEvaluatePreToolGuards,
  buildEnvelopeFor: mockBuildEnvelopeFor,
}));
vi.mock("../../src/engine/nutjs.js", () => ({
  mouse: {
    config: { mouseSpeed: 1000 },
    setPosition: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    doubleClick: vi.fn().mockResolvedValue(undefined),
  },
  Button: { LEFT: 0, RIGHT: 1, MIDDLE: 2 },
  Point: class { constructor(public x: number, public y: number) {} },
  straightTo: vi.fn((p: unknown) => p),
  DEFAULT_MOUSE_SPEED: 1000,
}));
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(() => []),
  restoreAndFocusWindow: vi.fn(),
  getWindowRectByHwnd: vi.fn(() => ({ x: 0, y: 0, width: 640, height: 480 })),
}));

vi.mock("../../src/engine/window-cache.js", () => ({
  updateWindowCache: vi.fn(),
  findContainingWindow: mockFindContainingWindow,
  findContainingWindowFresh: mockFindContainingWindowFresh,
  getCachedWindowByTitle: vi.fn(() => null),
  computeWindowDelta: vi.fn(() => null),
  getSnapshot: vi.fn(() => null),
  WINDOW_CACHE_TTL_EXPORTED_MS: 60_000,
}));
vi.mock("../../src/engine/layer-buffer.js", () => ({ captureFrame: mockCaptureFrame }));
vi.mock("../../src/engine/uia-bridge.js", () => ({ getElementBounds: vi.fn(() => null) }));
vi.mock("../../src/tools/_narration.js", () => ({
  withRichNarration: (_name: unknown, handler: unknown) => handler,
  narrateParam: undefined,
}));
vi.mock("../../src/tools/_focus.js", () => ({ detectFocusLoss: vi.fn(() => undefined) }));

import { mouseClickHandler } from "../../src/tools/mouse.js";

const ARGS = {
  x: 100, y: 100,
  button: "left" as const,
  doubleClick: false,
  tripleClick: false,
  homing: false,
  trackFocus: false,
  settleMs: 0,
  verifyDelivery: true,
};

beforeEach(() => {
  mockCaptureFrame.mockClear();
  mockFindContainingWindow.mockClear();
  mockFindContainingWindowFresh.mockClear();
  mockRunActionGuard.mockReset();
  mockEvaluatePreToolGuards.mockReset();
  mockBuildEnvelopeFor.mockReset();
  mockRunActionGuard.mockResolvedValue({
    block: false,
    summary: { kind: "auto", status: "ok", canContinue: true, next: "" },
  });
  mockEvaluatePreToolGuards.mockResolvedValue({ ok: true, policy: "block" });
  mockBuildEnvelopeFor.mockReturnValue(null);
});

describe("ADR-036: the pixel stage does not need another call to have warmed a cache", () => {
  it("takes the reference frame with a cold cache, through the fresh reader", async () => {
    await mouseClickHandler(ARGS as never);

    // The stage ran: it asked the FRESH reader and captured a frame for the window it named.
    expect(mockFindContainingWindowFresh).toHaveBeenCalledWith(100, 100);
    expect(mockCaptureFrame).toHaveBeenCalled();
    expect(mockCaptureFrame.mock.calls[0]![0]).toBe(4242n);
  });

  it("does not reach for the cache-only reader on this road", async () => {
    // The pairing that makes the row above mean something: the cold cache is not consulted and
    // then rescued, it is not the gate at all. If the gate still called it first, an empty cache
    // would keep the power to skip the stage — which is the defect, not a detail of how it is
    // fixed.
    await mouseClickHandler(ARGS as never);
    for (const call of mockFindContainingWindow.mock.calls) {
      expect(call, "the pixel stage asked the cache-only reader at the click point").not.toEqual([100, 100]);
    }
  });
});
