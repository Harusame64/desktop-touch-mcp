/**
 * dirty-rect-router.test.ts
 *
 * Unit tests for DirtyRectRouter (Phase 3 of visual-gpu-dataplane-plan.md).
 * Uses mock SubscriptionLike so no native addon is required.
 *
 * Mock design: when all scripted responses are consumed, the mock throws
 * E_DUP_DISPOSED so the _loop() exits cleanly (no infinite loop).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { DirtyRectRouter, type SubscriptionLike } from "../../src/engine/vision-gpu/dirty-rect-source.js";

type MockRect = { x: number; y: number; width: number; height: number };

/** Create a mock subscription that terminates after all scripted responses. */
function makeMockSub(responses: Array<MockRect[] | Error>): SubscriptionLike {
  let disposed = false;
  let callIdx = 0;
  return {
    get isDisposed() { return disposed; },
    async next(_timeout: number) {
      if (disposed) throw new Error("E_DUP_DISPOSED: subscription disposed");
      if (callIdx >= responses.length) {
        // All scripted responses consumed — terminate the loop gracefully.
        throw new Error("E_DUP_DISPOSED: all responses consumed");
      }
      const r = responses[callIdx++];
      if (r instanceof Error) throw r;
      return r as MockRect[];
    },
    dispose() { disposed = true; },
  };
}

/** Wait for all pending microtasks to drain. */
async function drain(iterations = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) await Promise.resolve();
}

const RECT: MockRect = { x: 10, y: 20, width: 100, height: 50 };

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Case 1: onRois called on recognize ────────────────────────────────────────
describe("Case 1: recognize mode triggers onRois", () => {
  it("calls onRois when dirty rects are present and no cooldown", async () => {
    const onRois = vi.fn();
    // One dirty rect, then terminate.
    const sub = makeMockSub([[RECT]]);

    const router = new DirtyRectRouter({
      onRois,
      subscriptionFactory: () => sub,
      tickMs: 0,
    });
    router.start();
    await drain(20);

    expect(onRois).toHaveBeenCalledTimes(1);
    const [rois] = onRois.mock.calls[0] as [unknown[]];
    expect(Array.isArray(rois)).toBe(true);
    expect((rois as unknown[]).length).toBeGreaterThan(0);
    router.stop();
  });
});

// ── Case 2: empty frame → continue (no onRois) ───────────────────────────────
describe("Case 2: empty dirty rect frame does not trigger onRois", () => {
  it("skips onRois when rects is empty", async () => {
    const onRois = vi.fn();
    const sub = makeMockSub([[]]);

    const router = new DirtyRectRouter({
      onRois,
      subscriptionFactory: () => sub,
      tickMs: 0,
    });
    router.start();
    await drain(20);

    expect(onRois).not.toHaveBeenCalled();
    router.stop();
  });
});

// ── Case 3: ACCESS_LOST → loop retries ───────────────────────────────────────
describe("Case 3: E_DUP_ACCESS_LOST retries without fallback", () => {
  it("does not call onFallback and continues after ACCESS_LOST", async () => {
    const onRois = vi.fn();
    const onFallback = vi.fn();
    vi.useFakeTimers();

    const sub = makeMockSub([
      new Error("E_DUP_ACCESS_LOST: session lost"),
      [RECT], // second call after back-off succeeds
    ]);

    const router = new DirtyRectRouter({
      onRois,
      onFallback,
      subscriptionFactory: () => sub,
      tickMs: 0,
    });
    router.start();

    // First iteration: ACCESS_LOST → sets up 100ms setTimeout.
    await drain(5);
    // Advance past the 100ms back-off.
    vi.advanceTimersByTime(200);
    await drain(20);

    expect(onFallback).not.toHaveBeenCalled();
    // After retry, RECT is processed.
    expect(onRois).toHaveBeenCalled();

    vi.useRealTimers();
    router.stop();
  });
});

// ── Case 4: DISPOSED → loop exits cleanly ────────────────────────────────────
describe("Case 4: E_DUP_DISPOSED causes loop exit without crash", () => {
  it("exits loop cleanly and does not call onFallback", async () => {
    const onFallback = vi.fn();
    const sub = makeMockSub([new Error("E_DUP_DISPOSED: subscription disposed")]);

    const router = new DirtyRectRouter({
      onRois: vi.fn(),
      onFallback,
      subscriptionFactory: () => sub,
      tickMs: 0,
    });
    router.start();
    await drain(20);

    expect(onFallback).not.toHaveBeenCalled();
    router.stop();
  });
});

// ── Case 5: factory throws → onFallback ───────────────────────────────────────
describe("Case 5: subscriptionFactory throws → onFallback, no crash", () => {
  it("calls onFallback when native subscription cannot be created", () => {
    const onFallback = vi.fn();

    const router = new DirtyRectRouter({
      onRois: vi.fn(),
      onFallback,
      subscriptionFactory: () => { throw new Error("E_DUP_UNSUPPORTED: RDP"); },
    });
    router.start();

    expect(onFallback).toHaveBeenCalledWith(
      expect.stringContaining("E_DUP_UNSUPPORTED"),
    );
    router.stop();
  });
});

// ── Case 6: stop() disposes subscription ─────────────────────────────────────
describe("Case 6: stop() disposes subscription", () => {
  it("marks subscription as disposed after stop()", () => {
    const sub = makeMockSub([[RECT]]);

    const router = new DirtyRectRouter({
      onRois: vi.fn(),
      subscriptionFactory: () => sub,
      tickMs: 0,
    });
    router.start();
    router.stop();

    expect(sub.isDisposed).toBe(true);
  });
});

// ── Case 7: unknown error → onFallback ────────────────────────────────────────
describe("Case 7: unknown loop error triggers onFallback", () => {
  it("calls onFallback on unexpected error", async () => {
    const onFallback = vi.fn();
    const sub = makeMockSub([new Error("E_DUP_OTHER: GPU crash")]);

    const router = new DirtyRectRouter({
      onRois: vi.fn(),
      onFallback,
      subscriptionFactory: () => sub,
      tickMs: 0,
    });
    router.start();
    await drain(20);

    expect(onFallback).toHaveBeenCalledWith(
      expect.stringContaining("GPU crash"),
    );
    router.stop();
  });
});
