import { describe, it, expect, vi } from "vitest";

// ADR-029 Phase 1 — desktop_act's mouse routes do NOT go through src/tools/mouse.ts;
// the executor drives nut.js directly. Pin that both of them refuse a coordinate the
// input backend cannot reach, so opening the viewport gate cannot regress into a
// silent misclick on the primary monitor.
//
// The primary-monitor lookup is pinned here so the test does not depend on the
// machine's real monitor layout.
vi.mock("../../src/engine/win32.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/engine/win32.js")>()),
  getPrimaryMonitorBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
}));

const { createDesktopExecutor } = await import("../../src/tools/desktop-executor.js");
type ExecutorDeps = import("../../src/tools/desktop-executor.js").ExecutorDeps;
type UiEntity = import("../../src/engine/world-graph/types.js").UiEntity;

function entity(overrides: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "e1",
    role: "button",
    label: "Start",
    confidence: 0.9,
    sources: ["visual_gpu"],
    affordances: [
      { verb: "invoke", executors: ["uia", "mouse"], confidence: 0.9, preconditions: [], postconditions: [] },
    ],
    generation: "gen-1",
    evidenceDigest: "d-e1",
    rect: { x: 100, y: 200, width: 80, height: 30 },
    ...overrides,
  };
}

function mockDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    uiaClick:       vi.fn(async () => {}),
    uiaSetValue:    vi.fn(async () => {}),
    cdpClick:       vi.fn(async () => {}),
    cdpFill:        vi.fn(async () => {}),
    terminalSend:   vi.fn(async () => {}),
    keyboardTypeBg: vi.fn(async () => {}),
    mouseClick:     vi.fn(async () => {}),
    ...overrides,
  };
}

// A window on a monitor to the left of the primary one.
const OFF_PRIMARY_RECT = { x: -1800, y: 300, width: 200, height: 40 };

describe("desktop executor — unreachable coordinates (ADR-029 Phase 1)", () => {
  it("refuses the visual-only mouse route without clicking", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ hwnd: "123" }, deps);
    await expect(exec(entity({ rect: OFF_PRIMARY_RECT }), "click")).rejects.toMatchObject({
      name: "CoordinateOutsideReachableBounds",
    });
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  // The UIA→mouse downgrade is the sneaky one: the entity passes the viewport
  // gate unconditionally (structured source), so without this guard a failed UIA
  // click on a secondary monitor silently clicks the primary one.
  it("refuses the UIA→mouse downgrade without clicking", async () => {
    const deps = mockDeps({
      uiaClick: vi.fn(async () => { throw new Error("element not found"); }),
    });
    const exec = createDesktopExecutor({ hwnd: "123" }, deps);
    const e = entity({ sources: ["uia"], rect: OFF_PRIMARY_RECT });
    await expect(exec(e, "click")).rejects.toMatchObject({
      name: "CoordinateOutsideReachableBounds",
    });
    expect(deps.uiaClick).toHaveBeenCalledOnce();
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  it("still clicks when the entity is on the primary monitor", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ hwnd: "123" }, deps);
    const result = await exec(entity(), "click");
    expect(result).toBe("mouse");
    expect(deps.mouseClick).toHaveBeenCalledWith(140, 215);
  });
});
