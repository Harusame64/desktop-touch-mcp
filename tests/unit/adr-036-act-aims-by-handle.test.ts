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
import { AimedWindowGoneError, AimedRouteFailedError } from "../../src/engine/aim.js";
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

  it("an aimed click does not finish as a blind one, whatever UIA's reason was", async () => {
    // The rect is a screen point, and any window can be under it. Measured on Windows
    // 2026-09-09: with the window frame synthesised into the read but not the write, every
    // pinned press of `Close` and `Minimize` came back ok:true while `executor` said `mouse`
    // and `downgrade` said "Element not found" — the mouse landed on the rect, one of them at
    // -32000,-32000. Success was reported for a press UIA never made.
    const deps = mockDeps({
      uiaClick: vi.fn(async () => { throw new Error("Element not found"); }),
    });
    const exec = createDesktopExecutor({ windowTitle: "Untitled - Notepad", hwnd: "4919" }, deps);
    await expect(exec(entity(), "click")).rejects.toThrow(/named its window/);
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  it("a pinned press refuses a point that is no longer inside the window it named", async () => {
    // The mouse route is not always a downgrade. For an entity whose only affordance is visual —
    // an OCR label, a `read`-only control — it is THE route, so nothing failed first and the
    // guard that ends the ladder after a failed UIA attempt never ran. Measured on Windows
    // 2026-09-09: pinned `desktop_act` on `read` entities pressed the rect remembered at discover
    // time and returned ok:true with no `downgrade` at all — invisible to the caller.
    const deps = mockDeps({
      aimRect: vi.fn(async () => ({ x: 0, y: 0, width: 50, height: 50 })),
    });
    const exec = createDesktopExecutor({ windowTitle: "App", hwnd: "4919" }, deps);
    // entity() sits at 100,200 — outside the window's current rectangle.
    await expect(exec(entity({ sources: ["visual_gpu"] }), "click")).rejects.toThrow(/Refusing to click/);
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  it("…and presses when the point is still inside it", async () => {
    const deps = mockDeps({
      aimRect: vi.fn(async () => ({ x: 0, y: 0, width: 1000, height: 1000 })),
    });
    const exec = createDesktopExecutor({ windowTitle: "App", hwnd: "4919" }, deps);
    await exec(entity({ sources: ["visual_gpu"] }), "click");
    expect(deps.mouseClick).toHaveBeenCalledWith(140, 215);
  });

  it("says the aim is gone when the window has no rectangle AND a source says it is gone", async () => {
    const deps = mockDeps({ aimRect: vi.fn(async () => null), aimIsGone: vi.fn(() => true) });
    const exec = createDesktopExecutor({ windowTitle: "App", hwnd: "4919" }, deps);
    await expect(exec(entity({ sources: ["visual_gpu"] }), "click"))
      .rejects.toBeInstanceOf(AimedWindowGoneError);
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  it("does not call a window gone when nothing could tell — it presses as it did before the check", async () => {
    // A null rectangle is also what a build with no native win32 module returns, and this repo
    // ships those. Reading null as "gone" refused every pinned coordinate press on such a build,
    // with a message about a window that is on screen — the same conflation `isWindowGone` was
    // written to avoid, one file over (2ゲート目の指摘, 2026-09-09). "Cannot tell" leaves the press
    // on the road it took before this ADR: known blind, and better than refusing everything.
    const deps = mockDeps({ aimRect: vi.fn(async () => null), aimIsGone: vi.fn(() => false) });
    const exec = createDesktopExecutor({ windowTitle: "App", hwnd: "4919" }, deps);
    await exec(entity({ sources: ["visual_gpu"] }), "click");
    expect(deps.mouseClick).toHaveBeenCalled();
  });

  it("treats a missing gone-check the same way — absent evidence is not evidence", async () => {
    const deps = mockDeps({ aimRect: vi.fn(async () => null) });
    const exec = createDesktopExecutor({ windowTitle: "App", hwnd: "4919" }, deps);
    await exec(entity({ sources: ["visual_gpu"] }), "click");
    expect(deps.mouseClick).toHaveBeenCalled();
  });

  it("records a containment check it could not make, instead of leaving no row", async () => {
    // A press with a handle and no containment row reads exactly like a build that never reached
    // the line. The probe writes `checked:false` on both roads it can skip by (gate 2).
    const dir = (await import("node:fs")).mkdtempSync(
      (await import("node:path")).join((await import("node:os")).tmpdir(), "aim-route-"),
    );
    const logPath = (await import("node:path")).join(dir, "probe.jsonl");
    process.env.DESKTOP_TOUCH_AIM_PROBE = "1";
    process.env.DESKTOP_TOUCH_AIM_PROBE_PATH = logPath;
    vi.resetModules();
    try {
      const { createDesktopExecutor: freshExecutor } = await import("../../src/tools/desktop-executor.js");
      const deps = mockDeps();                       // no aimRect at all
      const exec = freshExecutor({ windowTitle: "App", hwnd: "4919" }, deps);
      await exec(entity({ sources: ["visual_gpu"] }), "click");

      const rows = (await import("node:fs")).readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const containment = rows.find((r) => r.route === "containment_check");
      expect(containment, "a skipped check must still leave a row").toBeDefined();
      expect(containment!.checked).toBe(false);
      expect(containment!.why).toBe("no_aim_rect_dep");
    } finally {
      delete process.env.DESKTOP_TOUCH_AIM_PROBE;
      delete process.env.DESKTOP_TOUCH_AIM_PROBE_PATH;
      (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("refuses an exhausted WRITE ladder the way it refuses an exhausted click", async () => {
    // Both rungs addressed the handle and both are spent. Reported as `executor_failed`, the
    // caller is told to fall back to click_element / mouse_click at the entity's rect — the blind
    // press the click path refuses. One aim, two actions, opposite advice (2ゲート目の指摘).
    const deps = mockDeps({
      uiaSetValue:    vi.fn(async () => { throw new Error("Element not found"); }),
      keyboardTypeBg: vi.fn(async () => { throw new Error("Background keyboard type not supported"); }),
    });
    const exec = createDesktopExecutor({ windowTitle: "App", hwnd: "4919" }, deps);
    await expect(exec(entity({ sources: ["uia"] }), "setValue", "hi"))
      .rejects.toBeInstanceOf(AimedRouteFailedError);
  });

  it("leaves the unpinned write ladder on the generic reason — it never named a window", async () => {
    const deps = mockDeps({
      uiaSetValue:    vi.fn(async () => { throw new Error("Element not found"); }),
      keyboardTypeBg: vi.fn(async () => { throw new Error("Background keyboard type not supported"); }),
    });
    const exec = createDesktopExecutor({ windowTitle: "App" }, deps);
    const err = await exec(entity({ sources: ["uia"] }), "setValue", "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AimedRouteFailedError);
  });

  it("leaves an unpinned press alone — there is no window to check it against", async () => {
    const deps = mockDeps({ aimRect: vi.fn(async () => ({ x: 0, y: 0, width: 1, height: 1 })) });
    const exec = createDesktopExecutor({ windowTitle: "App" }, deps);
    await exec(entity({ sources: ["visual_gpu"] }), "click");
    expect(deps.mouseClick).toHaveBeenCalled();
    expect(deps.aimRect).not.toHaveBeenCalled();
  });

  it("but an unpinned click still downgrades — a title never promised which window", async () => {
    const deps = mockDeps({
      uiaClick: vi.fn(async () => { throw new Error("Element not found"); }),
    });
    const exec = createDesktopExecutor({ windowTitle: "Untitled - Notepad" }, deps);
    const outcome = await exec(entity(), "click");
    expect(deps.mouseClick).toHaveBeenCalled();
    expect(typeof outcome === "object" && outcome.downgrade?.from).toBe("uia");
  });

  it("a dead aim ends the click ladder — the mouse does not finish what UIA would not start", async () => {
    // `FromHandle` throws for a window that has closed since the lease was taken, and the rect
    // below is where that window used to be. Treating it as an ordinary UIA failure clicks
    // whatever moved in behind it — window drift, one of the five failures the graph exists to
    // stop. The refusal has to end the ladder, the way an excluded window does.
    const deps = mockDeps({
      uiaClick: vi.fn(async () => { throw new AimedWindowGoneError(4919n, "Window not found by hwnd"); }),
    });
    const exec = createDesktopExecutor({ windowTitle: "Untitled - Notepad", hwnd: "4919" }, deps);
    await expect(exec(entity(), "click")).rejects.toBeInstanceOf(AimedWindowGoneError);
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  it("gives the same answer for a gone window whichever action asked", async () => {
    // The keyboard rung is tried (see the cell below), but when it fails too the refusal that
    // was let through is the whole answer. Otherwise typing at a closed window reports an
    // ordinary `executor_failed` while clicking at the same closed window reports the typed
    // refusal — one condition, two answers.
    const deps = mockDeps({
      uiaSetValue:    vi.fn(async () => { throw new AimedWindowGoneError(4919n); }),
      keyboardTypeBg: vi.fn(async () => { throw new Error("hwnd 4919 is not in the enumeration"); }),
    });
    const exec = createDesktopExecutor({ windowTitle: "Untitled - Notepad", hwnd: "4919" }, deps);
    await expect(exec(entity({ role: "textbox" }), "type", "hello"))
      .rejects.toBeInstanceOf(AimedWindowGoneError);
    expect(deps.mouseClick).not.toHaveBeenCalled();
  });

  it("but the type ladder still tries the keyboard, because that rung addresses the handle", async () => {
    // Not symmetry for its own sake: `keyboardTypeBg` looks the window up BY HANDLE and throws
    // when the enumeration does not hold it, so it cannot write into a different window. And a
    // window whose UIA provider has gone while the HWND lives is the case WM_CHAR injection was
    // added for. The click ladder's downgrade is blind by coordinate; this one is not.
    const deps = mockDeps({
      uiaSetValue: vi.fn(async () => { throw new AimedWindowGoneError(4919n, "Window not found by hwnd"); }),
    });
    const exec = createDesktopExecutor({ windowTitle: "Untitled - Notepad", hwnd: "4919" }, deps);
    await exec(entity({ role: "textbox" }), "type", "hello");
    expect(deps.keyboardTypeBg).toHaveBeenCalledWith("Untitled - Notepad", "hello", 4919n);
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
    // `-1` is INVALID_HANDLE_VALUE and arrives from stringified sentinels; taking it as a
    // handle sends the write down the by-handle branch to fail there, instead of using the
    // title that would have worked.
    for (const hwnd of ["", "0", "-1", "-4919", "not-a-handle", "12.5"]) {
      expect(parseTargetHwnd({ hwnd }), `hwnd = ${JSON.stringify(hwnd)}`).toBeUndefined();
    }
    expect(parseTargetHwnd({ windowTitle: "App" })).toBeUndefined();
    expect(parseTargetHwnd(undefined)).toBeUndefined();
  });
});
