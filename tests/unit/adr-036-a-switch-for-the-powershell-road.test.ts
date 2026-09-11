/**
 * DESKTOP_TOUCH_DISABLE_NATIVE_UIA=1 — the native-absent configuration as a switch, not a patched build.
 *
 * ADR-036's all-route check runs every road with the native UIA engine present and absent: item 16's
 * first cut refused a control that was there, on every retry, only when the read and the click went
 * through PowerShell (gate 2 on public PR #624), and the rounds that measured it had to patch `dist`
 * to get there (win2, internal PRs #73 and #74). The switch sends every UIA call down the PowerShell
 * scripts and leaves the rest of the addon loaded, and `nativeUiaState()` says which of the three a
 * process is — in `server_status` and in the probe's row zero — because the addon's export list alone
 * would still name the UIA engine.
 *
 * The addon is a stand-in (`../../index.js` mocked): this machine has none.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * A stand-in addon: the image-diff trio, win32 with the foreground flash, and, unless told otherwise,
 * the UIA engine — counting UIA clicks and keeping the options each flash was given.
 */
function standInAddon(withUia = true) {
  const calls = { uiaClick: 0, flashOptions: [] as unknown[] };
  const binding: Record<string, unknown> = {
    computeChangeFraction: () => 0,
    dhashFromRaw: () => 0n,
    hammingDistance: () => 0,
    win32EnumTopLevelWindows: () => [],
    win32ForegroundFlashInject: (_hwnd: bigint, _pid: number, _text: string, options: unknown) => {
      calls.flashOptions.push(options);
      return { pasted: true };
    },
    ...(withUia && {
      uiaGetElements: async () => ({ windowTitle: "T", elementCount: 0, elements: [] }),
      uiaClickElement: async () => { calls.uiaClick++; return { ok: true, element: "OK", error: null, code: null }; },
    }),
  };
  return { calls, binding };
}

/** Load the real native-engine over the stand-in, with the switch as given (undefined = not set). */
async function engineWith(env: string | undefined, withUia = true) {
  const addon = standInAddon(withUia);
  vi.resetModules();
  vi.doMock("../../index.js", () => ({ default: addon.binding }));
  // Stubbed every time, `undefined` included — vitest deletes the variable then — so a switch left set
  // in the shell cannot turn an "unset" cell red (gate 2 on #626).
  vi.stubEnv("DESKTOP_TOUCH_DISABLE_NATIVE_UIA", env);
  const engine = await import("../../src/engine/native-engine.js");
  return { calls: addon.calls, engine };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("../../index.js");
  vi.doUnmock("node:child_process");
  vi.doUnmock("../../src/engine/win32.js");
  vi.resetModules();
});

describe("DESKTOP_TOUCH_DISABLE_NATIVE_UIA", () => {
  it("leaves the native UIA engine in place when unset, or set to anything but 1", async () => {
    for (const env of [undefined, "0", "true"]) {
      const { engine } = await engineWith(env);
      expect(engine.nativeUia, String(env)).not.toBeNull();
      expect(engine.nativeUiaState(), String(env)).toBe("native");
    }
  });

  it("takes the UIA engine out when set to 1, and leaves the rest of the addon loaded", async () => {
    const { engine } = await engineWith("1");
    expect(engine.nativeUia).toBeNull();
    expect(engine.nativeUiaState()).toBe("disabled");
    expect(engine.nativeEngine).not.toBeNull();
    // Why the state has to be said: the loaded addon still names the UIA engine.
    expect(engine.nativeExportNames()).toContain("uiaGetElements");
  });

  it("says unavailable, not disabled, when the addon has no UIA engine to take out", async () => {
    expect((await engineWith("1", false)).engine.nativeUiaState()).toBe("unavailable");
    expect((await engineWith(undefined, false)).engine.nativeUiaState()).toBe("unavailable");
  });

  it("is what server_status reports", async () => {
    await engineWith("1");
    const { getEngineStatus } = await import("../../src/engine/status.js");
    expect(getEngineStatus()).toMatchObject({ uia: "powershell", nativeUia: "disabled" });
  });

  it("sends a UIA click down the PowerShell script, not to the addon's engine", async () => {
    const { calls } = await engineWith("1");
    const scripts: string[] = [];
    vi.doMock("node:child_process", () => ({
      execFile: (_file: string, args: string[], _options: unknown, cb: (e: unknown, r: { stdout: string; stderr: string }) => void) => {
        scripts.push(args[args.length - 1]!);
        cb(null, { stdout: '{"ok":true,"element":"OK"}', stderr: "" });
      },
    }));
    vi.doMock("../../src/engine/win32.js", () => ({
      enumWindowsInZOrder: () => [], isExcludedTitle: () => false, isExcludedWindowHandle: () => false, isWindowGone: () => false,
    }));
    const { clickElement } = await import("../../src/engine/uia-bridge.js");
    const answer = await clickElement("Untitled - Notepad", "OK");
    expect(calls.uiaClick).toBe(0);
    expect(scripts).toHaveLength(1);
    expect(answer).toMatchObject({ ok: true, via: "powershell" });
  });

  it("keeps foreground_flash from starting the native UIA thread: no paste-warning dialog scan (gate 2 on #626)", async () => {
    // The scan runs on the UIA thread, and once that thread is up it feeds the focus view that
    // desktop_state reads first — native UIA answering while server_status says "disabled".
    const on = await engineWith("1");
    const { injectViaForegroundFlash } = await import("../../src/engine/bg-input.js");
    injectViaForegroundFlash(1n, 1, "x", { pressEnter: false });
    expect(on.calls.flashOptions).toEqual([{ pressEnter: false, scanPasteWarningDialog: false }]);
    // The control: without the switch, the options go through untouched and the scan keeps its default.
    const off = await engineWith(undefined);
    const again = await import("../../src/engine/bg-input.js");
    again.injectViaForegroundFlash(1n, 1, "x", { pressEnter: false });
    expect(off.calls.flashOptions).toEqual([{ pressEnter: false }]);
  });
});
