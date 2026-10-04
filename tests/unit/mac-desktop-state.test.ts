/**
 * mac-desktop-state.test.ts: desktop_state on macOS (Mac port M2-1), driven with fake deps.
 */
import { describe, it, expect, vi } from "vitest";
import { macDesktopStateHandler } from "../../src/tools/mac/desktop-state.js";
import { getSuggestsForCode } from "../../src/tools/_errors.js";

const WINDOWS = [
  { windowId: 1, pid: 5, layer: 0, onScreen: true },
  { windowId: 2, pid: 5, layer: 0, onScreen: false },
  { windowId: 3, pid: 9, layer: 24, onScreen: true },
];
const OK_PERMS = { accessibility: true, screenCapture: true };

function makeDeps(over: Record<string, unknown> = {}): any {
  return {
    permissions: vi.fn(() => OK_PERMS),
    getFocus: vi.fn(async () => ({
      pid: 5, appTitle: "App", focusedWindowTitle: "W", focusedRole: "AXTextArea", source: "system_wide",
    })),
    listWindows: vi.fn(() => WINDOWS),
    displayAsleep: vi.fn(() => false),
    ...over,
  };
}

async function run(deps: any) {
  const result = await macDesktopStateHandler(deps);
  return { result, body: JSON.parse((result.content[0] as any).text) };
}

describe("macDesktopStateHandler", () => {
  it("fails with PermissionRequired without reading focus when accessibility is off", async () => {
    const perms = { accessibility: false, screenCapture: true };
    const deps = makeDeps({ permissions: vi.fn(() => perms) });
    const { body } = await run(deps);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("PermissionRequired");
    expect(body.suggest).toEqual(getSuggestsForCode("PermissionRequired"));
    expect(body.suggest.length).toBeGreaterThanOrEqual(1);
    expect(body.context.permissions).toEqual(perms);
    expect(deps.getFocus).not.toHaveBeenCalled();
  });

  it("reports a normal desktop state", async () => {
    const deps = makeDeps();
    const { body } = await run(deps);
    expect(body).toEqual({
      focusedWindow: { title: "W", appName: "App", pid: 5 },
      focusedElement: { role: "AXTextArea", title: null },
      visibleWindows: 1,
      displayAsleep: false,
      attention: "ok",
      permissions: { accessibility: true, screenCapture: true },
      hints: { focusSource: "system_wide", focusError: null },
    });
    expect(deps.listWindows).toHaveBeenCalledWith(true);
  });

  it("reports display_asleep while keeping the focused window", async () => {
    const { body } = await run(makeDeps({ displayAsleep: vi.fn(() => true) }));
    expect(body.attention).toBe("display_asleep");
    expect(body.focusedWindow).not.toBeNull();
  });

  it("reports no_frontmost_app when focus has no pid", async () => {
    const { body } = await run(makeDeps({ getFocus: vi.fn(async () => ({ error: "no_frontmost_app" })) }));
    expect(body.focusedWindow).toBeNull();
    expect(body.attention).toBe("no_frontmost_app");
    expect(body.hints.focusError).toBe("no_frontmost_app");
  });

  it("returns focusedElement null when there is no focused role", async () => {
    const { body } = await run(makeDeps({ getFocus: vi.fn(async () => ({ pid: 5, appTitle: "App" })) }));
    expect(body.focusedElement).toBeNull();
  });

  it("never returns the focused element's value", async () => {
    const focus: any = { pid: 5, appTitle: "App", focusedRole: "AXTextField", focusedTitle: "Password", value: "hunter2-secret" };
    const { result } = await run(makeDeps({ getFocus: vi.fn(async () => focus) }));
    const text = (result.content[0] as any).text as string;
    expect(text).not.toContain("hunter2-secret");
    expect(text).not.toContain('"value"');
  });
});
