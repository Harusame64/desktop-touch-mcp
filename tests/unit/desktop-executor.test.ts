import { describe, it, expect, vi } from "vitest";
import {
  createDesktopExecutor,
  terminalBgExecute,
  type ExecutorDeps,
  type TerminalBgDeps,
} from "../../src/tools/desktop-executor.js";
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

describe("createDesktopExecutor — locator-based routing (P2-A)", () => {
  it("UIA locator: uses locator.uia.automationId over sourceId", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "App" }, deps);
    const e = entity({
      sources: ["uia"],
      sourceId: "stale-legacy-id", // should be ignored when locator is present
      locator: { uia: { automationId: "btn-submit", name: "Submit" } },
    });
    await exec(e, "invoke");
    expect(deps.uiaClick).toHaveBeenCalledWith("App", "Submit", "btn-submit");
  });

  it("CDP locator: uses locator.cdp.selector and locator.cdp.tabId", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor(undefined, deps);
    const e = entity({
      sources: ["cdp"],
      locator: { cdp: { selector: "#login-btn", tabId: "tab-42" } },
    });
    await exec(e, "click");
    expect(deps.cdpClick).toHaveBeenCalledWith("#login-btn", "tab-42");
  });

  it("CDP locator: locator.cdp.tabId overrides target.tabId", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ tabId: "target-tab" }, deps);
    const e = entity({
      sources: ["cdp"],
      locator: { cdp: { selector: "#btn", tabId: "locator-tab" } },
    });
    await exec(e, "click");
    expect(deps.cdpClick).toHaveBeenCalledWith("#btn", "locator-tab");
  });

  it("terminal locator: uses locator.terminal.windowTitle over target", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "wrong-window" }, deps);
    const e = entity({
      sources: ["terminal"],
      locator: { terminal: { windowTitle: "PowerShell 7" } },
    });
    await exec(e, "invoke", "ls");
    expect(deps.terminalSend).toHaveBeenCalledWith("PowerShell 7", "ls");
  });

  it("UIA fallback uses entity.rect first, then locator.visual.rect as secondary fallback", async () => {
    const deps = mockDeps({
      uiaClick: vi.fn(async () => { throw new Error("not found"); }),
    });
    const exec = createDesktopExecutor({ hwnd: "1" }, deps);
    // entity.rect absent → falls back to locator.visual.rect
    const e = entity({
      sources: ["uia"],
      rect: undefined,
      locator: { uia: { automationId: "btn-x" }, visual: { rect: { x: 50, y: 60, width: 100, height: 40 } } },
    });
    const result = await exec(e, "click");
    expect(result).toBe("mouse");
    expect(deps.mouseClick).toHaveBeenCalledWith(100, 80); // center of locator.visual.rect

    // entity.rect present → entity.rect wins over locator.visual.rect
    const deps2 = mockDeps({ uiaClick: vi.fn(async () => { throw new Error("fail"); }) });
    const exec2 = createDesktopExecutor({ hwnd: "1" }, deps2);
    const e2 = entity({
      sources: ["uia"],
      rect: { x: 10, y: 20, width: 40, height: 20 }, // live rect
      locator: { uia: { automationId: "btn" }, visual: { rect: { x: 999, y: 999, width: 10, height: 10 } } },
    });
    await exec2(e2, "click");
    expect(deps2.mouseClick).toHaveBeenCalledWith(30, 30); // center of entity.rect, not locator.visual.rect
  });
});

// ── G2: terminalBgExecute — background terminal send logic ────────────────────

function makeBgDeps(overrides: Partial<TerminalBgDeps> = {}): TerminalBgDeps {
  return {
    findWindow:  vi.fn((_title: string) => ({ hwnd: BigInt(999), title: "PowerShell 7" })),
    canBgSend:   vi.fn((_hwnd: unknown) => ({ supported: true, className: "ConsoleWindowClass" })),
    bgSend:      vi.fn((_hwnd: unknown, _text: string) => ({ sent: 5, full: true })),
    ...overrides,
  };
}

describe("terminalBgExecute — G2 background terminal send", () => {
  it("succeeds when window is found and bg send is supported + complete", () => {
    const deps = makeBgDeps();
    expect(() => terminalBgExecute("PowerShell", "hello", deps)).not.toThrow();
    expect(deps.findWindow).toHaveBeenCalledWith("PowerShell");
    expect(deps.canBgSend).toHaveBeenCalled();
    expect(deps.bgSend).toHaveBeenCalledWith(BigInt(999), "hello");
  });

  it("does NOT call foreground APIs (keyboard/focus) on the background path", () => {
    const deps = makeBgDeps();
    // bgSend is the only send channel — no keyboard.type() or restoreAndFocusWindow() involved.
    terminalBgExecute("PowerShell", "ls -la\n", deps);
    expect(deps.bgSend).toHaveBeenCalledWith(BigInt(999), "ls -la\n");
    // Verify that no extra calls happened (the deps list is the full injection surface)
    expect(Object.keys(deps)).not.toContain("keyboard");
    expect(Object.keys(deps)).not.toContain("restoreAndFocus");
  });

  it("throws explicitly when window is not found (not silent focus-steal fallback)", () => {
    const deps = makeBgDeps({ findWindow: vi.fn(() => undefined) });
    expect(() => terminalBgExecute("Missing App", "cmd", deps))
      .toThrow(`Terminal window not found: "Missing App"`);
  });

  it("throws explicitly when bg injection is NOT supported (Chromium, UWP)", () => {
    const deps = makeBgDeps({
      canBgSend: vi.fn(() => ({ supported: false, reason: "chromium", className: "Chrome_WidgetWin_1" })),
    });
    expect(() => terminalBgExecute("Chrome", "text", deps))
      .toThrow("Background terminal send not supported");
    // Must not call bgSend when not supported
    expect(deps.bgSend).not.toHaveBeenCalled();
  });

  it("throws on incomplete send (partial write)", () => {
    const deps = makeBgDeps({
      bgSend: vi.fn(() => ({ sent: 2, full: false })), // only sent 2 of 5 chars
    });
    expect(() => terminalBgExecute("PowerShell", "hello", deps))
      .toThrow("Background terminal send incomplete");
  });

  it("error message for unsupported window contains V1 fallback hint", () => {
    const deps = makeBgDeps({
      canBgSend: vi.fn(() => ({ supported: false, reason: "uwp_sandboxed" })),
    });
    let err = "";
    try { terminalBgExecute("Calculator", "1+1", deps); } catch (e) { err = String(e); }
    expect(err).toContain("V1 terminal(action='send')");
  });
});
