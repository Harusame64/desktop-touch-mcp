/**
 * internal #235 — the server does not read the window in front unless asked.
 *
 * The dirty-rect router ran from facade creation: on every screen change it captured and OCR'd
 * whichever window was in front, every 2–5 s with no tool call (win2, 2026-10-02). It was a
 * Phase 3 stand-in for per-ROI recognition that never landed, and the cache invalidation it fed
 * was removed in #754. It now starts only with `DESKTOP_TOUCH_ENABLE_DIRTY_RECTS=1`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => ({ count: 0, started: 0 }));

vi.mock("../../src/engine/vision-gpu/dirty-rect-source.js", () => ({
  DirtyRectRouter: class {
    constructor() { constructed.count += 1; }
    start(): void { constructed.started += 1; }
    stop(): void { /* nothing to stop */ }
  },
}));

const { _resetFacadeForTest, getDesktopFacade, shouldStartDirtyRectRouter } = await import(
  "../../src/tools/desktop-register.js"
);

describe("shouldStartDirtyRectRouter", () => {
  it.each([
    ["unset", {}, false],
    ["opt-in", { DESKTOP_TOUCH_ENABLE_DIRTY_RECTS: "1" }, true],
    ["opt-in spelled true", { DESKTOP_TOUCH_ENABLE_DIRTY_RECTS: "true" }, false],
    ["opt-in 0", { DESKTOP_TOUCH_ENABLE_DIRTY_RECTS: "0" }, false],
    ["the old kill switch alone", { DESKTOP_TOUCH_DISABLE_DIRTY_RECTS: "1" }, false],
    ["the old kill switch set to 0", { DESKTOP_TOUCH_DISABLE_DIRTY_RECTS: "0" }, false],
    ["opt-in and the kill switch", { DESKTOP_TOUCH_ENABLE_DIRTY_RECTS: "1", DESKTOP_TOUCH_DISABLE_DIRTY_RECTS: "1" }, false],
  ])("%s → %s", (_name, env, expected) => {
    expect(shouldStartDirtyRectRouter(env as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe("the facade starts the router only when opted in", () => {
  beforeEach(() => {
    _resetFacadeForTest();
    constructed.count = 0;
    constructed.started = 0;
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_VISUAL_GPU", "");
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_DIRTY_RECTS", "");
  });
  afterEach(() => {
    _resetFacadeForTest();
    vi.unstubAllEnvs();
  });

  it("does not create the router by default", () => {
    vi.stubEnv("DESKTOP_TOUCH_ENABLE_DIRTY_RECTS", "");
    getDesktopFacade();
    expect(constructed).toEqual({ count: 0, started: 0 });
  });

  it("creates and starts it with DESKTOP_TOUCH_ENABLE_DIRTY_RECTS=1", () => {
    vi.stubEnv("DESKTOP_TOUCH_ENABLE_DIRTY_RECTS", "1");
    getDesktopFacade();
    expect(constructed).toEqual({ count: 1, started: 1 });
  });
});
