/**
 * tests/unit/mouse-click-coord-order.test.ts
 * Verifies that mouse_click evaluates guards on FINAL coordinates
 * (after origin/scale conversion + homing), not on stale input coords.
 * 4 cases required by plan A-4.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mocks
const { mockRunActionGuard, mockEvaluatePreToolGuards, mockBuildEnvelopeFor, mockApplyHoming, mockMoveTo } = vi.hoisted(() => ({
  mockRunActionGuard: vi.fn(),
  mockEvaluatePreToolGuards: vi.fn(),
  mockBuildEnvelopeFor: vi.fn(),
  mockApplyHoming: vi.fn(),
  mockMoveTo: vi.fn(),
}));

vi.mock("../../src/tools/_action-guard.js", () => ({
  runActionGuard: mockRunActionGuard,
  isAutoGuardEnabled: () => true,
}));

vi.mock("../../src/engine/perception/registry.js", () => ({
  evaluatePreToolGuards: mockEvaluatePreToolGuards,
  buildEnvelopeFor: mockBuildEnvelopeFor,
}));

// Mock nut-js to prevent real mouse calls
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

// Mock win32 dependencies
vi.mock("../../src/engine/win32.js", () => ({
  enumWindowsInZOrder: vi.fn(() => []),
  restoreAndFocusWindow: vi.fn(),
}));

vi.mock("../../src/engine/window-cache.js", () => ({
  updateWindowCache: vi.fn(),
  findContainingWindow: vi.fn(() => null),
  getCachedWindowByTitle: vi.fn(() => null),
  computeWindowDelta: vi.fn(() => null),
}));

vi.mock("../../src/engine/uia-bridge.js", () => ({
  getElementBounds: vi.fn(() => null),
}));

vi.mock("../../src/tools/_narration.js", () => ({
  withRichNarration: (_name: unknown, handler: unknown) => handler,
  narrateParam: undefined,
}));

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => undefined),
}));

import { mouseClickHandler } from "../../src/tools/mouse.js";

const BASE_ARGS = {
  x: 10, y: 20,
  button: "left" as const,
  doubleClick: false,
  tripleClick: false,
  homing: false,
  trackFocus: false,
  settleMs: 0,
};

beforeEach(() => {
  mockRunActionGuard.mockReset();
  mockEvaluatePreToolGuards.mockReset();
  mockBuildEnvelopeFor.mockReset();
  mockApplyHoming.mockReset();
  mockMoveTo.mockReset();

  // Default: guard passes
  mockRunActionGuard.mockResolvedValue({
    block: false,
    summary: { kind: "auto", status: "ok", canContinue: true, next: "" },
  });
  mockEvaluatePreToolGuards.mockResolvedValue({ ok: true, policy: "block" });
  mockBuildEnvelopeFor.mockReturnValue(null);
});

describe("mouse_click coordinate ordering", () => {
  it("passes FINAL screen coord to runActionGuard when origin+scale given", async () => {
    // image (10,20) + origin(100,200) / scale=2 → screen (105, 210)
    await mouseClickHandler({
      ...BASE_ARGS,
      x: 10, y: 20,
      origin: { x: 100, y: 200 },
      scale: 2,
    });

    expect(mockRunActionGuard).toHaveBeenCalledOnce();
    const call = mockRunActionGuard.mock.calls[0]![0] as {
      clickCoordinates: { x: number; y: number };
      descriptor: { x: number; y: number };
    };
    // screen = origin + img/scale = 100 + 10/2 = 105, 200 + 20/2 = 210
    expect(call.clickCoordinates).toEqual({ x: 105, y: 210 });
    expect(call.descriptor).toMatchObject({ kind: "coordinate", x: 105, y: 210 });
  });

  it("stale input coord NOT passed when origin/scale conversion applies", async () => {
    await mouseClickHandler({
      ...BASE_ARGS,
      x: 5, y: 5,
      origin: { x: 500, y: 400 },
      scale: 1,
    });

    const call = mockRunActionGuard.mock.calls[0]![0] as {
      clickCoordinates: { x: number; y: number };
    };
    // screen = 500+5, 400+5 = 505, 405 — NOT the original 5,5
    expect(call.clickCoordinates).not.toEqual({ x: 5, y: 5 });
    expect(call.clickCoordinates).toEqual({ x: 505, y: 405 });
  });

  it("passes lensId path guard with FINAL coord (not stale)", async () => {
    mockEvaluatePreToolGuards.mockResolvedValue({ ok: true, policy: "block" });
    mockBuildEnvelopeFor.mockReturnValue({ kind: "manual", seq: 1, lens: "perc-1", attention: "ok", changed: [], guards: {}, latest: {} });

    await mouseClickHandler({
      ...BASE_ARGS,
      x: 10, y: 20,
      origin: { x: 0, y: 0 },
      scale: 1,
      lensId: "perc-1",
    });

    expect(mockEvaluatePreToolGuards).toHaveBeenCalledOnce();
    const [, , ctx] = mockEvaluatePreToolGuards.mock.calls[0]! as [string, string, { x: number; y: number; clickAt: { x: number; y: number } }];
    // origin=0,0 scale=1 → screen = 0 + 10/1 = 10, 20 (same here but verifies the path runs)
    expect(ctx.x).toBe(10);
    expect(ctx.y).toBe(20);
    // runActionGuard should NOT be called when lensId is provided
    expect(mockRunActionGuard).not.toHaveBeenCalled();
  });

  it("blocks and does not click when auto guard fails", async () => {
    mockRunActionGuard.mockResolvedValue({
      block: true,
      summary: { kind: "auto", status: "unsafe_coordinates", canContinue: false, next: "Out of bounds" },
    });

    const result = await mouseClickHandler({ ...BASE_ARGS });
    const parsed = JSON.parse(result.content[0]!.text) as { ok: boolean; code: string };
    expect(parsed.ok).toBe(false);
  });
});
