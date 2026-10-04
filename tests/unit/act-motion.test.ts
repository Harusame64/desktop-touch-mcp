/**
 * internal #211 (D) — the post-action motion verdict reads a handle acquired before the action, and a
 * window that repaints on its own is `indeterminate`.
 *
 * MEASURED win2 (S1, 2026-09-29): the old poll returned `no_change` on 83 of 88 successful acts — it
 * started after the executor had returned and the repaint had gone by. Real changes were 800 px and
 * up; a caret 42–60 px; a console's cursor row 15,624 px and a WinForms / Swing client area repainted
 * every few hundred ms with nothing acting on them.
 */
import { describe, expect, it, vi } from "vitest";

import { ACT_MOTION, largestHit, observeAfterAct, PreActWatch, visibleParts } from "../../src/engine/act-motion.js";

const WINDOW = { x: 100, y: 100, width: 900, height: 600 };
const inside = (width: number, height: number) => ({ x: 200, y: 200, width, height });
const caret = inside(3, 18);          // 54 px
const button = inside(40, 20);        // 800 px, the smallest real change measured

/** A clock the fake handle moves: a wait with nothing queued takes its whole timeout. */
function fakeHandle(queue: Array<Array<{ x: number; y: number; width: number; height: number }>>) {
  let t = 0;
  const sub = {
    outputIndex: 0,
    isDisposed: false,
    next: vi.fn(async (timeoutMs: number) => {
      const b = queue.shift();
      if (b) return b;
      t += timeoutMs;
      return [];
    }),
    dispose: vi.fn(),
  };
  return { sub, now: () => t };
}

describe("largestHit", () => {
  it("counts only the part of a rect inside the window", () => {
    expect(largestHit([{ x: 0, y: 0, width: 150, height: 150 }], WINDOW)).toBe(50 * 50);
    expect(largestHit([{ x: 2000, y: 0, width: 50, height: 50 }], WINDOW)).toBe(0);
  });

  it("is the largest single rect, not the sum", () => {
    expect(largestHit([inside(10, 10), inside(20, 20), inside(5, 5)], WINDOW)).toBe(400);
  });
});

describe("observeAfterAct", () => {
  it("says any_change for the repaint that queued while the executor ran, and stops reading there", async () => {
    const { sub, now } = fakeHandle([[caret], [button], [inside(300, 300)]]);
    const { observation } = await observeAfterAct(sub, WINDOW, { selfRepainting: false, watchedMs: 3000 }, { now });
    expect(observation.motion).toBe("any_change");
    expect(sub.next).toHaveBeenCalledTimes(2);
  });

  it("says no_change when only a caret blinked, with how long it watched", async () => {
    const { sub, now } = fakeHandle([[caret]]);
    const { observation } = await observeAfterAct(sub, WINDOW, undefined, { now });
    expect(observation).toMatchObject({ motion: "no_change", source: "dxgi_dirty_rect", totalElapsedMs: ACT_MOTION.windowMs });
    expect(observation).not.toHaveProperty("watchedBeforeMs");
  });

  it("does not count a large rect whose part inside the window is under 500 px", async () => {
    // 1,000 px in all, 400 of them inside (the window starts at x = 100).
    const { sub, now } = fakeHandle([[{ x: 60, y: 200, width: 50, height: 40 }]]);
    expect((await observeAfterAct(sub, WINDOW, undefined, { now })).observation.motion).toBe("no_change");
  });

  it("counts one whose part inside is 500 px or more", async () => {
    const { sub, now } = fakeHandle([[{ x: 60, y: 200, width: 60, height: 25 }]]);   // 20 x 25 = 500 inside
    expect((await observeAfterAct(sub, WINDOW, undefined, { now })).observation.motion).toBe("any_change");
  });

  it("says indeterminate for a window seen repainting on its own, however large the change", async () => {
    const { sub, now } = fakeHandle([[inside(900, 600)]]);
    const { observation } = await observeAfterAct(sub, WINDOW, { selfRepainting: true, watchedMs: 4000 }, { now });
    expect(observation).toMatchObject({ motion: "indeterminate", selfRepainting: true });
  });

  it("says indeterminate for such a window when nothing came too: its silence proves nothing", async () => {
    const { sub, now } = fakeHandle([]);
    const { observation } = await observeAfterAct(sub, WINDOW, { selfRepainting: true, watchedMs: 4000 }, { now });
    expect(observation.motion).toBe("indeterminate");
  });

  it("leaves selfRepainting out when the watch saw a quiet window, and says how long it watched", async () => {
    const { sub, now } = fakeHandle([[button]]);
    const { observation } = await observeAfterAct(sub, WINDOW, { selfRepainting: false, watchedMs: 4000 }, { now });
    expect(observation).not.toHaveProperty("selfRepainting");
    expect(observation.watchedBeforeMs).toBe(4000);
  });

  it("caps the changed ratio at the whole window, summed over a long read (gate 2)", async () => {
    // 1,400 rects of 400 px each: none a change, 560,000 px in all over a 540,000 px window.
    const { sub, now } = fakeHandle([Array.from({ length: 1400 }, () => inside(20, 20))]);
    const { observation } = await observeAfterAct(sub, WINDOW, undefined, { now });
    expect(observation.motion).toBe("no_change");
    expect(observation.residual?.totalIntersectedAreaPx).toBe(560_000);
    expect(observation.residual?.ratioOfTargetArea).toBe(1);
    expect(observation.residual?.fractionChanged).toBe(1);
  });

  it("counts batches, not rects, as frames sampled", async () => {
    const { sub, now } = fakeHandle([[caret, caret, caret]]);
    const { observation } = await observeAfterAct(sub, WINDOW, undefined, { now });
    expect(observation.framesSampled).toBe(2);   // the batch, then the empty wait to the window's end
  });

  it("says indeterminate when the broker dropped the handle mid-read", async () => {
    const { sub, now } = fakeHandle([]);
    sub.next.mockImplementationOnce(async () => { sub.isDisposed = true; return []; });
    expect((await observeAfterAct(sub, WINDOW, undefined, { now })).observation.motion).toBe("indeterminate");
  });

  it("says indeterminate when the read throws", async () => {
    const { sub, now } = fakeHandle([]);
    sub.next.mockRejectedValueOnce(new Error("AccessLost"));
    expect((await observeAfterAct(sub, WINDOW, undefined, { now })).observation.motion).toBe("indeterminate");
  });

  it("returns every rect it read, for the ROI capture", async () => {
    const { sub, now } = fakeHandle([[caret, { x: 5000, y: 0, width: 10, height: 10 }], [button]]);
    const { dirtyRects } = await observeAfterAct(sub, WINDOW, undefined, { now });
    expect(dirtyRects).toHaveLength(3);
  });

  it("stops at the window's end even when batches keep coming", async () => {
    let t = 0;
    const sub = { outputIndex: 0, isDisposed: false, dispose: vi.fn(), next: vi.fn(async () => { t += 10; return [caret]; }) };
    const { observation } = await observeAfterAct(sub, WINDOW, undefined, { now: () => t });
    expect(observation.motion).toBe("no_change");
    expect(sub.next.mock.calls.length).toBe(ACT_MOTION.windowMs / 10);
  });
});

describe("PreActWatch", () => {
  const monitors = () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
  function broker() {
    let cb: ((rects: Array<{ x: number; y: number; width: number; height: number }>) => void) | undefined;
    const unsubscribe = vi.fn();
    return {
      b: { subscribe: vi.fn((_i: number, f: typeof cb) => { cb = f; return { unsubscribe, state: "hit-subscription" as const }; }) },
      paint: (rects: Array<{ x: number; y: number; width: number; height: number }>) => cb?.(rects),
      unsubscribe,
    };
  }

  it("says a window repainted on its own when rects of 500 px or more landed twice, 300 ms apart", () => {
    const { b, paint } = broker();
    let t = 0;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
    w.start("v", 1n, WINDOW);
    paint([inside(884, 561)]);
    t = 300;
    paint([inside(884, 561)]);
    expect(w.take("v")).toMatchObject({ selfRepainting: true });
  });

  // internal #245 (gate 2 on #771): a video behind the target crossed its rect's invisible strips; the
  // watch counted it and the act read indeterminate, remembered after the video stopped.
  it("does not count repaints outside the parts on screen it was given", () => {
    const { b, paint } = broker();
    let t = 0;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
    const rightHalf = [{ x: 550, y: 100, width: 450, height: 600 }];
    w.start("v", 1n, WINDOW, { visible: rightHalf });
    paint([{ x: 100, y: 100, width: 400, height: 600 }]);
    t = 300;
    paint([{ x: 100, y: 100, width: 400, height: 600 }]);
    t = 2000;
    expect(w.take("v")).toMatchObject({ selfRepainting: false });
  });

  it("does not for one repaint, or two closer than 300 ms (a tooltip, an animation's frames)", () => {
    const { b, paint } = broker();
    let t = 0;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
    w.start("v", 1n, WINDOW);
    paint([inside(884, 561)]);
    t = 299;
    paint([inside(884, 561)]);
    t = 5000;
    expect(w.take("v")).toMatchObject({ selfRepainting: false });
  });

  it("ignores the first second after an act: the act's own repaint is still finishing (gate 2)", () => {
    const { b, paint } = broker();
    let t = 0;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
    w.start("v", 1n, WINDOW, { afterAct: true });
    paint([button]);
    t = 900;
    paint([button]);
    t = 1250;
    paint([button]);
    t = 2200;
    expect(w.take("v")).toMatchObject({ selfRepainting: false });
    w.start("v", 1n, WINDOW, { afterAct: true });   // at t = 2200: counts from 3200
    t = 3300;
    paint([button]);
    t = 3700;
    paint([button]);
    expect(w.take("v")).toMatchObject({ selfRepainting: true });
  });

  it("says nothing of a watch that ended inside its grace: it saw nothing to go by (PR codex P2)", () => {
    const { b } = broker();
    let t = 0;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
    w.start("v", 1n, WINDOW, { afterAct: true });
    t = 5;   // the next act, right after the last
    expect(w.take("v")).toBeUndefined();
  });

  it("still says a window repaints itself inside the grace when an earlier watch saw it do so", () => {
    const { b, paint } = broker();
    let t = 0;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t, identity: () => ({ pid: 42, processStartTimeMs: 7 }) });
    w.start("v", 1n, WINDOW);
    paint([button]);
    t = 400;
    paint([button]);
    expect(w.take("v")).toMatchObject({ selfRepainting: true });
    w.start("v", 1n, WINDOW, { afterAct: true });
    t = 405;
    expect(w.take("v")).toMatchObject({ selfRepainting: true });
  });

  it("does not carry that to another window that took the same handle (PR codex P2)", () => {
    const { b, paint } = broker();
    let t = 0;
    let pid = 42;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t, identity: () => ({ pid, processStartTimeMs: 7 }) });
    w.start("v", 1n, WINDOW);
    paint([button]);
    t = 400;
    paint([button]);
    expect(w.take("v")).toMatchObject({ selfRepainting: true });
    pid = 43;   // the window closed; handle 1 now belongs to another program
    w.start("v", 1n, WINDOW);
    t = 5000;
    expect(w.take("v")).toMatchObject({ selfRepainting: false });
  });

  it("does not watch when the broker answered without attaching (unavailable, backing off) (PR codex P2)", () => {
    for (const state of ["hit-unavailable", "hit-negative-backoff", "miss-init-unavailable"] as const) {
      const b = { subscribe: vi.fn(() => ({ unsubscribe: () => undefined, state })) };
      let t = 0;
      const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
      w.start("v", 1n, WINDOW);
      t = 5000;
      expect(w.take("v")).toBeUndefined();
    }
  });

  it("watches when it attached to a new subscription (miss-init)", () => {
    const b = { subscribe: vi.fn(() => ({ unsubscribe: () => undefined, state: "miss-init" as const })) };
    let t = 0;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
    w.start("v", 1n, WINDOW);
    t = 5000;
    expect(w.take("v")).toEqual({ selfRepainting: false, watchedMs: 5000 });
  });

  it("keeps at most a few watches, dropping the oldest (gate 2: views never acted on)", () => {
    const { b, unsubscribe } = broker();
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => 0 });
    for (let i = 0; i < ACT_MOTION.maxWatches + 3; i++) w.start(`v${i}`, 1n, WINDOW);
    expect(w.size).toBe(ACT_MOTION.maxWatches);
    expect(unsubscribe).toHaveBeenCalledTimes(3);
    expect(w.take("v0")).toBeUndefined();
  });

  it("ends the watch where the broker lost access, and does not count what came after (gate 2)", () => {
    let cb: ((r: Array<{ x: number; y: number; width: number; height: number }>) => void) | undefined;
    let lost: (() => void) | undefined;
    const b = { subscribe: vi.fn((_i: number, f: typeof cb, onInvalidate?: () => void) => { cb = f; lost = onInvalidate; return { unsubscribe: vi.fn(), state: "hit-subscription" as const }; }) };
    let t = 0;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
    w.start("v", 1n, WINDOW);
    cb?.([button]);
    t = 1500;
    lost?.();
    t = 1900;
    cb?.([button]);
    t = 5000;
    expect(w.take("v")).toEqual({ selfRepainting: false, watchedMs: 1500 });
  });

  it("says nothing when the broker lost access too soon to call the window quiet", () => {
    let lost: (() => void) | undefined;
    const b = { subscribe: vi.fn((_i: number, _f: unknown, onInvalidate?: () => void) => { lost = onInvalidate; return { unsubscribe: vi.fn(), state: "hit-subscription" as const }; }) };
    let t = 0;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
    w.start("v", 1n, WINDOW);
    t = 500;
    lost?.();
    t = 5000;
    expect(w.take("v")).toBeUndefined();
  });

  it("calls a window quiet only after 1.1 s of counting: two repaints of a console fit in it (PR codex P2)", () => {
    const { b } = broker();
    let t = 0;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
    w.start("v", 1n, WINDOW);
    t = 1099;
    expect(w.take("v")).toBeUndefined();
    w.start("v", 1n, WINDOW);
    t = 1099 + 1100;
    expect(w.take("v")).toEqual({ selfRepainting: false, watchedMs: 1100 });
  });

  it("drops a watch of a window that moved, or of another window, before the act (PR codex P2)", () => {
    const { b } = broker();
    let t = 0;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
    w.start("v", 1n, WINDOW);
    t = 5000;
    expect(w.take("v", { hwnd: 1n, rect: { ...WINDOW, x: WINDOW.x + 1 } })).toBeUndefined();
    w.start("v", 1n, WINDOW);
    t = 10000;
    expect(w.take("v", { hwnd: 2n, rect: WINDOW })).toBeUndefined();
    w.start("v", 1n, WINDOW);
    t = 15000;
    expect(w.take("v", { hwnd: 1n, rect: { ...WINDOW } })).toMatchObject({ selfRepainting: false });
  });

  it("asks for the broker each time, so a disposed one is not held (gate 2)", () => {
    const first = broker();
    const second = broker();
    let current = first.b;
    const w = new PreActWatch(() => current, { enumerate: monitors, now: () => 0 });
    w.start("v", 1n, WINDOW);
    current = second.b;
    w.start("v", 1n, WINDOW);
    expect(second.b.subscribe).toHaveBeenCalledTimes(1);
  });

  it("does not for a caret blinking every 500 ms (Notepad, S1)", () => {
    const { b, paint } = broker();
    let t = 0;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
    w.start("v", 1n, WINDOW);
    for (let i = 0; i < 6; i++) { t = i * 500; paint([caret]); }
    expect(w.take("v")).toMatchObject({ selfRepainting: false });
  });

  it("does not for a caret, or for a repaint of another window", () => {
    const { b, paint } = broker();
    let t = 0;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
    w.start("v", 1n, WINDOW);
    paint([caret]);
    t = 400;
    paint([{ x: 1200, y: 100, width: 300, height: 300 }]);
    t = 3000;
    expect(w.take("v")).toMatchObject({ selfRepainting: false });
  });

  it("stops listening when taken, and says how long it watched", () => {
    const { b, unsubscribe } = broker();
    let t = 1000;
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t });
    w.start("v", 1n, WINDOW);
    t = 5200;
    expect(w.take("v")).toEqual({ selfRepainting: false, watchedMs: 4200 });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(w.take("v")).toBeUndefined();
  });

  it("stops on its own after its time, keeping what it saw", () => {
    vi.useFakeTimers();
    try {
      const { b, paint, unsubscribe } = broker();
      let t = 0;
      const w = new PreActWatch(() => b, { enumerate: monitors, now: () => t, ttlMs: 1000 });
      w.start("v", 1n, WINDOW);
      paint([button]);
      t = 400;
      paint([button]);
      t = 1000;
      vi.advanceTimersByTime(1000);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      t = 9000;
      expect(w.take("v")).toEqual({ selfRepainting: true, watchedMs: 1000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces the watch of a view that is discovered again", () => {
    const { b, unsubscribe } = broker();
    const w = new PreActWatch(() => b, { enumerate: monitors, now: () => 0 });
    w.start("v", 1n, WINDOW);
    w.start("v", 1n, WINDOW);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(w.size).toBe(1);
  });

  it("watches nothing without a broker, or for a window on no monitor", () => {
    expect(new PreActWatch(() => null).take("v")).toBeUndefined();
    const { b } = broker();
    const w = new PreActWatch(() => b, { enumerate: monitors });
    w.start("v", 1n, { x: 5000, y: 5000, width: 100, height: 100 });
    expect(b.subscribe).not.toHaveBeenCalled();
    expect(w.take("v")).toBeUndefined();
  });
});

/**
 * internal #245 — MEASURED win2 (2026-10-04, internal `spike/245-hidden-act-observation`): an act whose
 * changed label was covered by another window read `no_change` 10 of 12 times, and one whose label
 * was on screen read `any_change` 9 of 9; with a video playing behind the target, its rects crossed
 * the target's rect and every act read as a change. Only what is on screen is read, and a window
 * partly covered says `indeterminate` instead of `no_change`.
 */
describe("visibleParts", () => {
  it("leaves the frame whole when nothing covers it, and nothing when it is covered", () => {
    expect(visibleParts(WINDOW, [])).toEqual([WINDOW]);
    expect(visibleParts(WINDOW, [{ x: 0, y: 0, width: 2000, height: 2000 }])).toEqual([]);
  });

  it("subtracts a cover over the left half, leaving the right half", () => {
    const parts = visibleParts(WINDOW, [{ x: 0, y: 0, width: 550, height: 2000 }]);
    expect(parts).toEqual([{ x: 550, y: 100, width: 450, height: 600 }]);
  });

  it("subtracts a cover in the middle as the four boxes around it", () => {
    const parts = visibleParts(WINDOW, [{ x: 400, y: 300, width: 100, height: 100 }]);
    const area = parts.reduce((s, p) => s + p.width * p.height, 0);
    expect(area).toBe(900 * 600 - 100 * 100);
  });
});

describe("observeAfterAct on a window others cover", () => {
  const leftCovered = visibleParts(WINDOW, [{ x: 0, y: 0, width: 550, height: 2000 }]);

  it("says indeterminate with the visible share, not no_change, when nothing on screen changed", async () => {
    const { sub, now } = fakeHandle([[caret]]);
    const { observation } = await observeAfterAct(sub, WINDOW, undefined, { now, visible: leftCovered });
    expect(observation.motion).toBe("indeterminate");
    expect(observation.visibleFraction).toBe(0.5);
  });

  it("still says any_change for a change on the part that is on screen", async () => {
    const { sub, now } = fakeHandle([[{ x: 700, y: 300, width: 40, height: 20 }]]);
    const { observation } = await observeAfterAct(sub, WINDOW, undefined, { now, visible: leftCovered });
    expect(observation.motion).toBe("any_change");
  });

  it("does not count a repaint under the cover — another window's, not this one's", async () => {
    const { sub, now } = fakeHandle([[{ x: 150, y: 300, width: 300, height: 300 }]]);
    const { observation } = await observeAfterAct(sub, WINDOW, undefined, { now, visible: leftCovered });
    expect(observation.motion).toBe("indeterminate");
  });

  it("says no_change, with no visibleFraction, for a window wholly on screen", async () => {
    const { sub, now } = fakeHandle([[caret]]);
    const { observation } = await observeAfterAct(sub, WINDOW, undefined, { now, visible: [WINDOW] });
    expect(observation.motion).toBe("no_change");
    expect(observation).not.toHaveProperty("visibleFraction");
  });

  it("says indeterminate for a window wholly covered", async () => {
    const { sub, now } = fakeHandle([[inside(900, 600)]]);
    const { observation } = await observeAfterAct(sub, WINDOW, undefined, { now, visible: [] });
    expect(observation.motion).toBe("indeterminate");
    expect(observation.visibleFraction).toBe(0);
  });
});
