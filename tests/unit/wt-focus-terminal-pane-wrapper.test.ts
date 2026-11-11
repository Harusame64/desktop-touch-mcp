/**
 * internal #370 — `focusTerminalPane` fails closed: anything but a pane that took the focus, the tab
 * changed, or another window in front is "not_focused", and the caller does not paste (gate 2 on #936).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function withNative(wtFocusTerminalPane: unknown) {
  vi.resetModules();
  vi.doMock("../../src/engine/native-engine.js", async (orig) => {
    const actual = await orig<typeof import("../../src/engine/native-engine.js")>();
    return {
      ...actual,
      nativeUia: wtFocusTerminalPane === undefined ? { ...(actual.nativeUia ?? {}), wtFocusTerminalPane: undefined } : { ...(actual.nativeUia ?? {}), wtFocusTerminalPane },
    };
  });
  return import("../../src/engine/uia-bridge.js");
}

afterEach(() => {
  vi.doUnmock("../../src/engine/native-engine.js");
  vi.resetModules();
});

describe("focusTerminalPane", () => {
  it.each(["focused", "tab_changed", "foreground_moved", "not_focused"])("passes %s through", async (answer) => {
    const call = vi.fn(async () => answer);
    const { focusTerminalPane, terminalPaneFocusable } = await withNative(call);
    expect(terminalPaneFocusable()).toBe(true);
    expect(await focusTerminalPane(5n, "rt-1")).toBe(answer);
    expect(call).toHaveBeenCalledWith("5", 1000, "rt-1");
  });

  it("is not_focused for an answer it does not know", async () => {
    const { focusTerminalPane } = await withNative(async () => "weird");
    expect(await focusTerminalPane(5n, "rt-1")).toBe("not_focused");
  });

  it("is not_focused when the native call throws", async () => {
    const { focusTerminalPane } = await withNative(async () => { throw new Error("uia thread gone"); });
    expect(await focusTerminalPane(5n, "rt-1")).toBe("not_focused");
  });

  it("is not_focused, and the build says it cannot focus, without the export (an older addon)", async () => {
    const { focusTerminalPane, terminalPaneFocusable } = await withNative(undefined);
    expect(terminalPaneFocusable()).toBe(false);
    expect(await focusTerminalPane(5n, "rt-1")).toBe("not_focused");
  });
});
