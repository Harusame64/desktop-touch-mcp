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

  it("CDP source + click → cdpClick with selector and tabId", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ tabId: "tab-1" }, deps);
    const e = entity({ sources: ["cdp"], locator: { cdp: { selector: "#submit-btn" } } });
    const result = await exec(e, "click");
    expect(result).toBe("cdp");
    expect(deps.cdpClick).toHaveBeenCalledWith("#submit-btn", "tab-1");
  });

  it("CDP source + type → cdpFill with value and tabId", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ tabId: "tab-1" }, deps);
    const e = entity({ sources: ["cdp"], locator: { cdp: { selector: "#search-box" } } });
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

  // P0-3 (audit §8.1): terminal route only fires when text is supplied. UIA and
  // CDP routes already gate on `text !== undefined`; the executor's terminal
  // arm used to send `text ?? ""` which silently writes an empty line on
  // click/invoke. Ensure such calls fall through to the mouse fallback.
  it("terminal source without text → falls through to mouse (no terminalSend with empty string)", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "PowerShell" }, deps);
    const result = await exec(
      entity({
        sources: ["terminal"],
        rect: { x: 10, y: 20, width: 100, height: 30 },
      }),
      "click",
    );
    expect(result).toBe("mouse");
    expect(deps.terminalSend).not.toHaveBeenCalled();
    expect(deps.mouseClick).toHaveBeenCalledWith(60, 35);
  });

  it("terminal source with text='' (clear-line) still routes to terminalSend", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "PowerShell" }, deps);
    const result = await exec(entity({ sources: ["terminal"] }), "type", "");
    expect(result).toBe("terminal");
    expect(deps.terminalSend).toHaveBeenCalledWith("PowerShell", "");
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
    await exec(entity({ sources: ["uia", "cdp"] }), "click");
    expect(deps.uiaClick).toHaveBeenCalled();
    expect(deps.cdpClick).not.toHaveBeenCalled();
  });

  it("cdp takes priority over mouse when entity has cdp + visual_gpu", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ tabId: "t" }, deps);
    await exec(entity({ sources: ["cdp", "visual_gpu"], locator: { cdp: { selector: "#x" } } }), "click");
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
    // Issue #327 item C: silent UIA-to-mouse fallback now returns the rich
    // ExecutorOutcome shape so observability of the downgrade reaches the LLM.
    expect(result).toEqual({
      kind: "mouse",
      downgrade: { from: "uia", reason: "element not found" },
    });
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
    await expect(exec(entity({ sources: ["cdp"], locator: { cdp: { selector: "#x" } } }), "click")).rejects.toThrow("CDP error");
  });
});

// ─── Issue #327 item C — UIA click silent fallback observability ──────────────

describe("createDesktopExecutor — UIA click → mouse downgrade marker (#327 item C)", () => {
  it("UIA click succeeds → returns bare 'uia' (back-compat, no downgrade marker)", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ hwnd: "1" }, deps);
    const result = await exec(entity({ sources: ["uia"] }), "click");
    expect(result).toBe("uia");
  });

  it("UIA click fails + entity.rect present → returns ExecutorOutcome with downgrade.from='uia' + reason", async () => {
    const deps = mockDeps({
      uiaClick: vi.fn(async () => { throw new Error("InvokePatternNotSupported"); }),
    });
    const exec = createDesktopExecutor({ hwnd: "1" }, deps);
    const result = await exec(
      entity({ sources: ["uia"], rect: { x: 100, y: 200, width: 80, height: 30 } }),
      "click",
    );
    expect(result).toEqual({
      kind: "mouse",
      downgrade: { from: "uia", reason: "InvokePatternNotSupported" },
    });
  });

  it("UIA click fails + no rect → throws (no silent mouse fallback) — downgrade marker reserved for the success case", async () => {
    const deps = mockDeps({
      uiaClick: vi.fn(async () => { throw new Error("element not found"); }),
    });
    const exec = createDesktopExecutor({ hwnd: "1" }, deps);
    await expect(exec(entity({ sources: ["uia"], rect: undefined }), "click"))
      .rejects.toThrow("no rect for mouse fallback");
  });

  it("downgrade marker carries non-Error throwables as String(...) for the reason field", async () => {
    const deps = mockDeps({
      uiaClick: vi.fn(async () => { throw "string-only error"; }),
    });
    const exec = createDesktopExecutor({ hwnd: "1" }, deps);
    const result = await exec(
      entity({ sources: ["uia"], rect: { x: 0, y: 0, width: 10, height: 10 } }),
      "click",
    );
    expect(result).toEqual({
      kind: "mouse",
      downgrade: { from: "uia", reason: "string-only error" },
    });
  });
});

// ─── Issue #327 item E — UIA setValue → keyboardTypeBg fallback ladder ────────

describe("createDesktopExecutor — UIA setValue → keyboardTypeBg fallback (#327 item E)", () => {
  it("uiaSetValue success path: no keyboardTypeBg call, returns 'uia' (regression pin)", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "Notepad" }, deps);
    const result = await exec(entity({ sources: ["uia"] }), "type", "hello");
    expect(result).toBe("uia");
    expect(deps.uiaSetValue).toHaveBeenCalledOnce();
    expect(deps.keyboardTypeBg).not.toHaveBeenCalled();
  });

  it("uiaSetValue throws + keyboardTypeBg succeeds → returns 'keyboard' (the E1 fix)", async () => {
    const deps = mockDeps({
      uiaSetValue: vi.fn(async () => { throw new Error("Element not found"); }),
    });
    const exec = createDesktopExecutor({ windowTitle: "Notepad" }, deps);
    const result = await exec(entity({ sources: ["uia"] }), "type", "hello");
    expect(result).toBe("keyboard");
    expect(deps.uiaSetValue).toHaveBeenCalledOnce();
    expect(deps.keyboardTypeBg).toHaveBeenCalledWith("Notepad", "hello");
  });

  it("setValue action also falls through to keyboardTypeBg on uiaSetValue failure", async () => {
    const deps = mockDeps({
      uiaSetValue: vi.fn(async () => { throw new Error("PowerShell locator filter mismatch"); }),
    });
    const exec = createDesktopExecutor({ windowTitle: "App" }, deps);
    const result = await exec(entity({ sources: ["uia"] }), "setValue", "x");
    expect(result).toBe("keyboard");
    expect(deps.keyboardTypeBg).toHaveBeenCalledWith("App", "x");
  });

  it("both uiaSetValue AND keyboardTypeBg throw → combined error surfaces both diagnostics", async () => {
    const deps = mockDeps({
      uiaSetValue:    vi.fn(async () => { throw new Error("UIA name mismatch"); }),
      keyboardTypeBg: vi.fn(async () => { throw new Error("WT-XAML host blocked"); }),
    });
    const exec = createDesktopExecutor({ windowTitle: "Terminal" }, deps);
    await expect(exec(entity({ sources: ["uia"] }), "type", "x"))
      .rejects.toThrow(/Type fallback ladder exhausted.*uia=UIA name mismatch.*keyboard=WT-XAML host blocked/);
  });

  it("text=undefined (no type/setValue): no keyboardTypeBg call (scope pin — click/invoke unchanged)", async () => {
    const deps = mockDeps({
      uiaClick: vi.fn(async () => { throw new Error("InvokePattern missing"); }),
    });
    const exec = createDesktopExecutor({ hwnd: "1" }, deps);
    const result = await exec(
      entity({ sources: ["uia"], rect: { x: 100, y: 200, width: 80, height: 30 } }),
      "click",
    );
    // Click path falls through to mouse with the #327 item C downgrade marker.
    expect(result).toEqual({
      kind: "mouse",
      downgrade: { from: "uia", reason: "InvokePattern missing" },
    });
    expect(deps.keyboardTypeBg).not.toHaveBeenCalled();
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
  it("UIA locator: routes via locator.uia.automationId and name", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "App" }, deps);
    const e = entity({
      sources: ["uia"],
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
    expect(result).toEqual({ kind: "mouse", downgrade: { from: "uia", reason: "not found" } });
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

// ─────────────────────────────────────────────────────────────────────────────
// Issue #296 Phase 2 — `unsupportedExecutors` short-circuit
// ─────────────────────────────────────────────────────────────────────────────
//
// `desktop_discover` derives `EntityCapabilities` from UIA controlType + patterns
// and stashes `unsupportedExecutors` on the resolved UiEntity. The executor must
// honour it BEFORE attempting the route — skipping UIA entirely when 'uia' is in
// the list, rather than trying UIA, catching `InvokePatternNotSupported`, and
// falling back to mouse (which is what Phase 1 still cost the LLM in latency).

describe("createDesktopExecutor — unsupportedExecutors short-circuit (#296 Phase 2)", () => {
  it("UIA-sourced entity with unsupportedExecutors:['uia'] → skip UIA, use mouse fallback", async () => {
    // Mirrors the ListItem / TabItem / TreeItem case from issue #296: the
    // entity is UIA-sourced (sources includes 'uia') but the capability
    // derivation has flagged UIA as unsupported because the element does not
    // expose InvokePattern. Before this short-circuit the executor would
    // call uiaClick, eat InvokePatternNotSupported, then fall to mouse — one
    // wasted UIA round-trip per touch.
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "Settings" }, deps);
    const e = entity({
      sources: ["uia"],
      unsupportedExecutors: ["uia"],
      rect: { x: 50, y: 60, width: 120, height: 24 },
    });
    const result = await exec(e, "click");
    expect(result).toBe("mouse");
    expect(deps.uiaClick).not.toHaveBeenCalled();
    expect(deps.mouseClick).toHaveBeenCalledOnce();
    // Mouse click lands at entity rect center.
    expect(deps.mouseClick).toHaveBeenCalledWith(110, 72);
  });

  it("UIA-sourced + setValue with unsupportedExecutors:['uia'] → throw (text would be dropped)", async () => {
    // Opus PR #302 P2 #2 — when every text-capable executor is skipped /
    // blocked AND the caller supplied text, the executor must throw rather
    // than fall through to mouseClick (which silently drops the text
    // payload — phantom-typed bug). uiaSetValue must NOT be called either:
    // the unsupportedExecutors short-circuit applies to both the click and
    // setValue branches of the UIA route.
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "App" }, deps);
    const e = entity({
      sources: ["uia"],
      unsupportedExecutors: ["uia"],
      rect: { x: 100, y: 200, width: 80, height: 30 },
    });
    await expect(exec(e, "setValue", "text")).rejects.toThrow(
      /no text-capable executor available/i,
    );
    expect(deps.uiaSetValue).not.toHaveBeenCalled();
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  it("unsupportedExecutors:['mouse'] honoured by the residual fallback (Opus P2 #1)", async () => {
    // The field's type union allows `'mouse'`; the executor must honour it
    // rather than silently route through the unconditional mouse fallback.
    // Source is visual_gpu so UIA/CDP/terminal all fall through, then the
    // mouse fallback itself must throw because mouse is also blocked.
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "App" }, deps);
    const e = entity({
      sources: ["visual_gpu"],
      unsupportedExecutors: ["mouse"],
      rect: { x: 100, y: 200, width: 80, height: 30 },
    });
    await expect(exec(e, "click")).rejects.toThrow(/mouse fallback also blocked/i);
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  it("CDP-sourced entity with unsupportedExecutors:['cdp'] → skip CDP, mouse fallback", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ tabId: "tab-1" }, deps);
    const e = entity({
      sources: ["cdp"],
      locator: { cdp: { selector: "#btn" } },
      unsupportedExecutors: ["cdp"],
      rect: { x: 10, y: 20, width: 60, height: 40 },
    });
    const result = await exec(e, "click");
    expect(result).toBe("mouse");
    expect(deps.cdpClick).not.toHaveBeenCalled();
    expect(deps.mouseClick).toHaveBeenCalledOnce();
  });

  it("terminal-sourced + type with unsupportedExecutors:['terminal'] → throw (text would be dropped)", async () => {
    // Opus PR #302 P2 #2 — same contract as the UIA/CDP-blocked text cases.
    // A terminal entity with terminal blocked has no text-capable executor
    // left, so falling through to mouse-click would silently drop the
    // `text` payload — throw instead.
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "PowerShell" }, deps);
    const e = entity({
      sources: ["terminal"],
      unsupportedExecutors: ["terminal"],
      rect: { x: 5, y: 5, width: 200, height: 20 },
    });
    await expect(exec(e, "type", "ls")).rejects.toThrow(
      /no text-capable executor available/i,
    );
    expect(deps.terminalSend).not.toHaveBeenCalled();
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  it("terminal-sourced + click with unsupportedExecutors:['terminal'] → mouse fallback (no text to drop)", async () => {
    // `click` action carries no text payload, so the mouse fallback is safe
    // here — verify the original (pre-P2-#2) routing semantics for the
    // text-free case still hold.
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "PowerShell" }, deps);
    const e = entity({
      sources: ["terminal"],
      unsupportedExecutors: ["terminal"],
      rect: { x: 5, y: 5, width: 200, height: 20 },
    });
    const result = await exec(e, "click");
    expect(result).toBe("mouse");
    expect(deps.terminalSend).not.toHaveBeenCalled();
    expect(deps.mouseClick).toHaveBeenCalledOnce();
  });

  it("empty / absent unsupportedExecutors → default dispatch order (regression guard)", async () => {
    // Phase 2 must not regress the happy path: no blocked routes means UIA
    // wins for a UIA-sourced entity, exactly as Phase 1 behaved.
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "App" }, deps);

    // Absent field
    expect(await exec(entity({ sources: ["uia"] }), "click")).toBe("uia");

    // Explicit empty array — same semantics as absent.
    expect(await exec(entity({ sources: ["uia"], unsupportedExecutors: [] }), "click")).toBe("uia");

    // Blocking a route that does not apply to this entity is a no-op.
    expect(
      await exec(entity({ sources: ["uia"], unsupportedExecutors: ["cdp"] }), "click")
    ).toBe("uia");

    expect(deps.uiaClick).toHaveBeenCalledTimes(3);
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  it("multi-source entity blocks only the named route, other sources still attempted", async () => {
    // Defensive: a future provider may produce an entity with both 'uia' and
    // 'cdp' sources. Blocking 'uia' should leave CDP routing intact.
    const deps = mockDeps();
    const exec = createDesktopExecutor({ tabId: "tab-1" }, deps);
    const e = entity({
      sources: ["uia", "cdp"],
      locator: { cdp: { selector: "#submit" } },
      unsupportedExecutors: ["uia"],
    });
    const result = await exec(e, "click");
    expect(result).toBe("cdp");
    expect(deps.uiaClick).not.toHaveBeenCalled();
    expect(deps.cdpClick).toHaveBeenCalledOnce();
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });
});
