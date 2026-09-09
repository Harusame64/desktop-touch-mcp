/**
 * ADR-036 — `desktop_act` aims at the handle the session was keyed by.
 *
 * Measured on Windows 2026-09-09 (`desktop-touch-mcp-internal@4ccf7f3`): with two same-titled
 * windows, `desktop_act(lease)` landed on whichever window `enumWindowsInZOrder()` returned
 * first — not the one `desktop_discover` had been pointed at, not the foreground one, and not
 * the one created first. Three arms separated those: making a non-foreground window topmost
 * moved the action with the z-order, and reversing the creation order did not move it.
 *
 * The handle was never absent. `session-registry.ts` keys a session `hwnd > tabId > windowTitle`,
 * the lease carries `viewId` / `targetGeneration` / `evidenceDigest`, and `uia-bridge` has taken
 * an `options.hwnd` since H3. What was missing was a parameter: every `ExecutorDeps` method took
 * a `windowTitle: string` and nothing else, so the identity had nowhere to go and the executor
 * read the same `TargetSpec` the opposite way round from the registry (`windowTitle ?? hwnd`).
 *
 * These tests hold the seam shut. They are about which window is addressed, not about whether
 * the click lands — that half needs the real machine, and the acceptance arms are written
 * against both directions because a one-directional pass cannot be told from luck.
 */
import { describe, it, expect, vi } from "vitest";
import { createDesktopExecutor, type ExecutorDeps } from "../../src/tools/desktop-executor.js";
import { parseTargetHwnd } from "../../src/engine/world-graph/session-registry.js";
import { WindowExcludedError } from "../../src/engine/tool-exclusion.js";
import type { UiEntity } from "../../src/engine/world-graph/types.js";

function entity(overrides: Partial<UiEntity> = {}): UiEntity {
  return {
    entityId: "e1",
    role: "button",
    label: "Start",
    confidence: 0.9,
    sources: ["uia"],
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

describe("ADR-036 — the handle reaches the backend", () => {
  it("click passes the session's handle alongside the title", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "Untitled - Notepad", hwnd: "4919" }, deps);
    await exec(entity(), "click");
    expect(deps.uiaClick).toHaveBeenCalledWith("Untitled - Notepad", "Start", undefined, 4919n);
  });

  it("type passes it too, and so does the keyboard rung underneath", async () => {
    const deps = mockDeps({
      uiaSetValue: vi.fn(async () => { throw new Error("ValuePattern not found"); }),
    });
    const exec = createDesktopExecutor({ windowTitle: "Untitled - Notepad", hwnd: "4919" }, deps);
    await exec(entity({ role: "textbox" }), "type", "hello");
    expect(deps.uiaSetValue).toHaveBeenCalledWith("Untitled - Notepad", "hello", "Start", undefined, 4919n);
    // The fallback must not quietly go back to aiming by title: it is the rung that actually
    // writes when ValuePattern cannot re-find the element, which is the common Notepad case.
    expect(deps.keyboardTypeBg).toHaveBeenCalledWith("Untitled - Notepad", "hello", 4919n);
  });

  it("a target with no handle passes none — the title is still the whole address", async () => {
    const deps = mockDeps();
    const exec = createDesktopExecutor({ windowTitle: "Untitled - Notepad" }, deps);
    await exec(entity(), "click");
    expect(deps.uiaClick).toHaveBeenCalledWith("Untitled - Notepad", "Start", undefined, undefined);
  });

  it("a handle that is not a number is not a handle", async () => {
    // The field is a string on the wire. `BigInt("")` is 0n and `BigInt("0x…")` is a real
    // number, so a malformed value must not become a handle that names window zero.
    for (const hwnd of ["", "not-a-handle", "0"]) {
      const deps = mockDeps();
      const exec = createDesktopExecutor({ windowTitle: "App", hwnd }, deps);
      await exec(entity(), "click");
      expect(deps.uiaClick, `hwnd = ${JSON.stringify(hwnd)}`)
        .toHaveBeenCalledWith("App", "Start", undefined, undefined);
    }
  });

  it("a handle-only target does not become a window titled with its own digits", async () => {
    // Before this, `resolveWindowTitle` returned `windowTitle ?? hwnd`, so a session known only
    // by handle asked the backend for a window whose title contains "4919".
    const deps = mockDeps();
    const exec = createDesktopExecutor({ hwnd: "4919" }, deps);
    await exec(entity(), "click");
    expect(deps.uiaClick).toHaveBeenCalledWith("@active", "Start", undefined, 4919n);
  });

  it("a refusal is not a rung: an excluded window is not clicked with the mouse instead", async () => {
    // The handle route skips the title-based root search, and with it the title-based
    // exclusion check, so the bridge refuses by handle. If that refusal were treated like any
    // other UIA failure it would fall to `entity.rect` and click the secure dialog by
    // coordinate — routing around the refusal rather than obeying it.
    const deps = mockDeps({
      uiaClick: vi.fn(async () => { throw new WindowExcludedError("excluded"); }),
    });
    const exec = createDesktopExecutor({ windowTitle: "Locker", hwnd: "4919" }, deps);
    await expect(exec(entity(), "click")).rejects.toBeInstanceOf(WindowExcludedError);
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  it("the same for the type ladder — the keyboard rung is not a way around it", async () => {
    const deps = mockDeps({
      uiaSetValue: vi.fn(async () => { throw new WindowExcludedError("excluded"); }),
    });
    const exec = createDesktopExecutor({ windowTitle: "Locker", hwnd: "4919" }, deps);
    await expect(exec(entity({ role: "textbox" }), "type", "hello"))
      .rejects.toBeInstanceOf(WindowExcludedError);
    expect(deps.keyboardTypeBg).not.toHaveBeenCalled();
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  it("the terminal route carries the handle, whatever the entity calls the window", async () => {
    // The executor belongs to one session, so every entity it sees was read from that
    // session's own discover. The terminal provider always fills `locator.terminal.windowTitle`
    // with that same session's title, so a test on that field's presence dropped the handle for
    // every ordinary terminal entity; a test on string equality passed only by coincidence.
    for (const locator of [undefined, { terminal: { windowTitle: "Windows Terminal" } }]) {
      const deps = mockDeps();
      await createDesktopExecutor({ windowTitle: "PowerShell", hwnd: "4919" }, deps)(
        entity({ sources: ["terminal"], ...(locator && { locator }) }),
        "type",
        "dir\n",
      );
      expect(deps.terminalSend).toHaveBeenCalledWith(
        locator ? "Windows Terminal" : "PowerShell",
        "dir\n",
        4919n,
      );
    }
  });
});

describe("ADR-036 — one answer to \"is this a handle\"", () => {
  // The read half and the write half both call this. When each parsed for itself, one threw,
  // one returned null, one fell back to the foreground window and one used the digits as a
  // window title — so a single malformed value could point the two halves at two windows.
  it("takes a decimal handle and refuses everything that is not one", () => {
    expect(parseTargetHwnd({ hwnd: "4919" })).toBe(4919n);
    // `BigInt` also accepts hex and surrounding whitespace. That is left alone deliberately:
    // "0x1337" names a real window, and rejecting it would turn a call that would have worked
    // into a silent fall back to aiming by title — the failure this exists to remove.
    expect(parseTargetHwnd({ hwnd: " 0x1337 " })).toBe(4919n);
    for (const hwnd of ["", "0", "not-a-handle", "12.5"]) {
      expect(parseTargetHwnd({ hwnd }), `hwnd = ${JSON.stringify(hwnd)}`).toBeUndefined();
    }
    expect(parseTargetHwnd({ windowTitle: "App" })).toBeUndefined();
    expect(parseTargetHwnd(undefined)).toBeUndefined();
  });
});
