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

  it("the terminal route takes the handle only when it is describing that same window", async () => {
    // The handle names the session's window. An entity that carries a terminal window title of
    // its own is naming a different window, and aiming at the session's handle would send the
    // text somewhere the caller did not ask for.
    const own = mockDeps();
    await createDesktopExecutor({ windowTitle: "PowerShell", hwnd: "4919" }, own)(
      entity({ sources: ["terminal"], locator: { terminal: { windowTitle: "Windows Terminal" } } }),
      "type",
      "dir\n",
    );
    expect(own.terminalSend).toHaveBeenCalledWith("Windows Terminal", "dir\n", undefined);

    const same = mockDeps();
    await createDesktopExecutor({ windowTitle: "PowerShell", hwnd: "4919" }, same)(
      entity({ sources: ["terminal"] }),
      "type",
      "dir\n",
    );
    expect(same.terminalSend).toHaveBeenCalledWith("PowerShell", "dir\n", 4919n);
  });
});
