/**
 * internal #322 — keyboard(action:'type') and a keyboard focus on a control that takes no text.
 *
 * win2 (2026-10-28, Chrome): with the focus on a page's "Close panel" button, a paste answered
 * ok:true, typed:180 and nothing landed; by keystroke a space pressed the button (2026-10-30). Calculator
 * takes "12+3=" with the focus on the digit it last clicked (win2, #873). So a keystroke text with a
 * space or a line break is refused, and anything else goes with the reply saying where the focus was.
 * Harness from `a-keyboard-does-not-switch-the-desktop.test.ts` (same foreground ladder).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock(import("../../src/engine/win32.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    enumWindowsInZOrder: vi.fn(),
    restoreAndFocusWindow: vi.fn(),
    getWindowClassName: vi.fn(() => ""),
  };
});

vi.mock("../../src/tools/_action-guard.js", () => ({
  runActionGuard: vi.fn(),
  isAutoGuardEnabled: vi.fn(() => false),
  validateAndPrepareFix: vi.fn(() => null),
  consumeFix: vi.fn(),
  assertKeyboardDestination: vi.fn(() => ({ ok: true })),
}));

vi.mock("../../src/engine/perception/registry.js", () => ({
  evaluatePreToolGuards: vi.fn(),
  buildEnvelopeFor: vi.fn(),
}));

const { focused } = vi.hoisted(() => ({
  focused: { info: null as null | { controlType: string; name: string; value?: string | null } | "throw" },
}));
vi.mock("../../src/engine/uia-bridge.js", () => ({
  getTextViaTextPattern: vi.fn(() => Promise.resolve("")),
  getVirtualDesktopStatus: vi.fn(async (hs: string[]) => Object.fromEntries(hs.map((h) => [h, true]))),
  getFocusedAndPointInfo: vi.fn(async () => {
    if (focused.info === "throw") throw new Error("UIA timeout");
    return { focused: focused.info, atPoint: null };
  }),
}));

vi.mock("../../src/engine/nutjs.js", () => ({
  keyboard: { pressKey: vi.fn(), releaseKey: vi.fn(), type: vi.fn() },
}));

vi.mock("../../src/tools/_focus.js", () => ({
  detectFocusLoss: vi.fn(() => Promise.resolve(undefined)),
  checkForegroundOnce: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../../src/tools/_resolve-window.js", () => ({
  resolveWindowTarget: vi.fn(async ({ windowTitle }) => ({ title: windowTitle, warnings: [] })),
}));

import { keyboardTypeHandler } from "../../src/tools/keyboard.js";
import * as typeFocus from "../../src/tools/_type-focus.js";
import * as win32 from "../../src/engine/win32.js";
import { keyboard } from "../../src/engine/nutjs.js";

// The suite-wide stub (`setup-diagnostic-log.ts`) answers null; these cells use the real read over the
// UIA mock above.
const { focusedControlThatTakesNoText: realRead } =
  await vi.importActual<typeof import("../../src/tools/_type-focus.js")>("../../src/tools/_type-focus.js");

const mockEnum = vi.mocked(win32.enumWindowsInZOrder);
const mockRestore = vi.mocked(win32.restoreAndFocusWindow);

function parseResult(r: { content: { type: string; text: string }[] }) {
  return JSON.parse(r.content[0]!.text);
}

const args = { text: "a b", windowTitle: "Q322", method: "foreground" as const, trackFocus: false, settleMs: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  focused.info = null;
  vi.mocked(typeFocus.focusedControlThatTakesNoText).mockImplementation(realRead);
  mockEnum.mockReturnValue([{
    hwnd: 100n, title: "Q322", isActive: true, zOrder: 0, isMinimized: false, isMaximized: false,
    region: { x: 0, y: 0, width: 800, height: 600 }, processName: "chrome.exe", isCloaked: false,
  }]);
  mockRestore.mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
});

describe("internal #322 — keyboard type and a focus that takes no text", () => {
  it("refuses a keystroke text with a space, before Ctrl+A or any character", async () => {
    focused.info = { controlType: "Button", name: "Close panel", value: null };
    const r = parseResult(await keyboardTypeHandler({ ...args, text: "a b", replaceAll: true }));
    expect(r.ok).toBe(false);
    expect(r.code).toBe("FocusedControlTakesNoText");
    expect(r.context.focusedType).toBe("Button");
    // The name stays out, as the post keeps it out without the value switch.
    expect(JSON.stringify(r)).not.toContain("Close panel");
    expect(r.suggest.join(" ")).toMatch(/action='press'/);
    expect(keyboard.type).not.toHaveBeenCalled();
    expect(keyboard.pressKey).not.toHaveBeenCalled();
  });

  it.each(["x\n", "x\r"])("refuses a keystroke text with a line break (%j)", async (text) => {
    focused.info = { controlType: "Button", name: "b", value: null };
    const r = parseResult(await keyboardTypeHandler({ ...args, text }));
    expect(r.code).toBe("FocusedControlTakesNoText");
    expect(keyboard.type).not.toHaveBeenCalled();
  });

  it("types a text with no space or break, and says the focus takes no text (Calculator)", async () => {
    focused.info = { controlType: "Button", name: "7", value: null };
    const r = parseResult(await keyboardTypeHandler({ ...args, text: "12+3=" }));
    expect(r.ok).toBe(true);
    expect(keyboard.type).toHaveBeenCalled();
    expect(r.hints.focusTakesNoText).toBe("Button");
    expect(r.hints.warnings.join(" ")).toMatch(/takes no text/);
  });

  // The paste itself and its reply are in `type-via-clipboard-envelope.test.ts`, which mocks the clipboard.
  it("does not refuse a paste with a space (a paste presses nothing)", async () => {
    focused.info = { controlType: "Button", name: "Close panel", value: null };
    const r = parseResult(await keyboardTypeHandler({ ...args, text: "a b", use_clipboard: true }));
    expect(r.code).not.toBe("FocusedControlTakesNoText");
  });

  it("types into a focused Edit and says nothing about it (the control)", async () => {
    focused.info = { controlType: "Edit", name: "", value: "" };
    const r = parseResult(await keyboardTypeHandler({ ...args, text: "a b" }));
    expect(r.ok).toBe(true);
    expect(keyboard.type).toHaveBeenCalled();
    expect(r.hints?.focusTakesNoText).toBeUndefined();
  });

  it.each([
    ["no focused element", null],
    ["a failed read", "throw" as const],
    ["a ComboBox (Chromium's web text input)", { controlType: "ComboBox", name: "Search", value: null }],
    ["a ListItem (type-ahead)", { controlType: "ListItem", name: "row", value: null }],
    ["a Button that exposes a value", { controlType: "Button", name: "b", value: "" }],
  ])("types a text with a space on %s", async (_label, info) => {
    focused.info = info;
    const r = parseResult(await keyboardTypeHandler({ ...args, text: "a b" }));
    expect(r.ok).toBe(true);
    expect(keyboard.type).toHaveBeenCalled();
    expect(r.hints?.focusTakesNoText).toBeUndefined();
  });

  it.each(["SplitButton", "CheckBox", "RadioButton", "Hyperlink", "MenuItem", "TabItem"])(
    "refuses a text with a space on a focused %s",
    async (controlType) => {
      focused.info = { controlType, name: "x", value: null };
      const r = parseResult(await keyboardTypeHandler({ ...args, text: "a b" }));
      expect(r.code).toBe("FocusedControlTakesNoText");
      expect(r.context.focusedType).toBe(controlType);
      expect(keyboard.type).not.toHaveBeenCalled();
    },
  );
});
