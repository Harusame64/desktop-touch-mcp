import { describe, it, expect, vi } from "vitest";
import { createDesktopExecutor, type ExecutorDeps } from "../../src/tools/desktop-executor.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

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
    uiaClick:     vi.fn(async () => {}),
    uiaSetValue:  vi.fn(async () => {}),
    cdpClick:     vi.fn(async () => {}),
    cdpFill:      vi.fn(async () => {}),
    terminalSend: vi.fn(async () => {}),
    mouseClick:   vi.fn(async () => {}),
    ...overrides,
  };
}

describe("createDesktopExecutor — route selection", () => {
  it("UIA source + invoke → uiaClick, returns 'uia'", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ hwnd: "123" }, deps);
    const result = await exec(entity({ sources: ["uia"] }), "invoke");
    expect(result).toBe("uia");
    expect(deps.uiaClick).toHaveBeenCalledOnce();
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  it("UIA source + click → uiaClick", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ hwnd: "123" }, deps);
    const result = await exec(entity({ sources: ["uia"] }), "click");
    expect(result).toBe("uia");
    expect(deps.uiaClick).toHaveBeenCalledOnce();
  });

  it("UIA source + type → uiaSetValue with text", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "App" }, deps);
    const result = await exec(entity({ sources: ["uia"] }), "type", "hello");
    expect(result).toBe("uia");
    expect(deps.uiaSetValue).toHaveBeenCalledWith("App", "hello", "Start", undefined);
  });

  it("CDP source + click → cdpClick with sourceId and tabId", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ tabId: "tab-1" }, deps);
    const e = entity({ sources: ["cdp"], sourceId: "#submit-btn" });
    const result = await exec(e, "click");
    expect(result).toBe("cdp");
    expect(deps.cdpClick).toHaveBeenCalledWith("#submit-btn", "tab-1");
  });

  it("CDP source + type → cdpFill with value and tabId", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ tabId: "tab-1" }, deps);
    const e = entity({ sources: ["cdp"], sourceId: "#search-box" });
    const result = await exec(e, "type", "query text");
    expect(result).toBe("cdp");
    expect(deps.cdpFill).toHaveBeenCalledWith("#search-box", "query text", "tab-1");
  });

  it("terminal source → terminalSend with window title and text", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "PowerShell" }, deps);
    const result = await exec(entity({ sources: ["terminal"] }), "invoke", "npm test");
    expect(result).toBe("terminal");
    expect(deps.terminalSend).toHaveBeenCalledWith("PowerShell", "npm test");
  });

  it("visual_gpu (no UIA/CDP/terminal) + rect → mouse click at center", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor(undefined, deps);
    const result = await exec(
      entity({ sources: ["visual_gpu"], rect: { x: 100, y: 200, width: 80, height: 30 } }),
      "click"
    );
    expect(result).toBe("mouse");
    expect(deps.mouseClick).toHaveBeenCalledWith(140, 215); // center of rect
  });
});

describe("createDesktopExecutor — route priority", () => {
  it("uia takes priority over cdp when entity has both sources", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ hwnd: "1" }, deps);
    await exec(entity({ sources: ["uia", "cdp"], sourceId: "#btn" }), "click");
    expect(deps.uiaClick).toHaveBeenCalled();
    expect(deps.cdpClick).not.toHaveBeenCalled();
  });

  it("cdp takes priority over mouse when entity has cdp + visual_gpu", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ tabId: "t" }, deps);
    await exec(entity({ sources: ["cdp", "visual_gpu"], sourceId: "#x" }), "click");
    expect(deps.cdpClick).toHaveBeenCalled();
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });
});

describe("createDesktopExecutor — error handling and UIA fallback", () => {
  it("mouse fallback throws when entity has no rect", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor(undefined, deps);
    await expect(exec(entity({ sources: ["visual_gpu"], rect: undefined }), "click"))
      .rejects.toThrow("no rect for mouse fallback");
  });

  it("UIA click failure falls through to mouse when rect is present", async () => {
    const deps = mockDeps({
      uiaClick: vi.fn(async () => { throw new Error("element not found"); }),
    });
    const exec = createDesktopExecutor({ hwnd: "1" }, deps);
    const result = await exec(
      entity({ sources: ["uia"], rect: { x: 100, y: 200, width: 80, height: 30 } }),
      "click"
    );
    expect(result).toBe("mouse");
    expect(deps.mouseClick).toHaveBeenCalledWith(140, 215);
  });

  it("UIA click failure throws when no rect available (no mouse fallback)", async () => {
    const deps = mockDeps({
      uiaClick: vi.fn(async () => { throw new Error("UIA error"); }),
    });
    const exec = createDesktopExecutor({ hwnd: "1" }, deps);
    await expect(exec(entity({ sources: ["uia"], rect: undefined }), "click"))
      .rejects.toThrow("no rect for mouse fallback");
  });

  it("non-UIA errors are propagated directly", async () => {
    const deps = mockDeps({ cdpClick: vi.fn(async () => { throw new Error("CDP error"); }) });
    const exec = createDesktopExecutor({ tabId: "t" }, deps);
    await expect(exec(entity({ sources: ["cdp"], sourceId: "#x" }), "click")).rejects.toThrow("CDP error");
  });
});

describe("createDesktopExecutor — target spec to windowTitle", () => {
  it("uses windowTitle from TargetSpec for UIA calls", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "Notepad" }, deps);
    await exec(entity({ sources: ["uia"] }), "invoke");
    expect(deps.uiaClick).toHaveBeenCalledWith("Notepad", "Start", undefined);
  });

  it("uses hwnd as windowTitle fallback when windowTitle is absent", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ hwnd: "hwnd-42" }, deps);
    await exec(entity({ sources: ["uia"] }), "invoke");
    expect(deps.uiaClick).toHaveBeenCalledWith("hwnd-42", "Start", undefined);
  });

  it("uses @active when target is undefined", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor(undefined, deps);
    await exec(entity({ sources: ["uia"] }), "invoke");
    expect(deps.uiaClick).toHaveBeenCalledWith("@active", "Start", undefined);
  });
});
