/**
 * internal #229 — screenshot(detail:"text") decided "terminal" by the owning process's image name, so a
 * WinForms form a PowerShell script showed (or `Out-GridView`) came back as a terminal with no
 * actionables (win2, 2026-09-30). The window's class decides now, one set with desktop_discover's
 * terminal lane.
 */
import { describe, expect, it } from "vitest";
import { isTerminalWindow, TERMINAL_WINDOW_CLASSES } from "../../src/utils/terminal-process.js";

describe("isTerminalWindow (internal #229)", () => {
  it("is a terminal by its window class", () => {
    expect(isTerminalWindow("ConsoleWindowClass")).toBe(true);
    expect(isTerminalWindow("CASCADIA_HOSTING_WINDOW_CLASS")).toBe(true);
  });

  it("is not a terminal for a GUI window, whoever owns it", () => {
    expect(isTerminalWindow("WindowsForms10.Window.8.app.0.2bf8098_r6_ad1")).toBe(false);
    expect(isTerminalWindow("HwndWrapper[pwsh;;abc]")).toBe(false); // Out-GridView is WPF
    expect(isTerminalWindow("mintty")).toBe(false); // no text to read (win2: 0 characters)
    expect(isTerminalWindow("")).toBe(false); // getWindowClassName's answer for an unreadable window
  });

  it("is exactly the two measured classes", () => {
    expect([...TERMINAL_WINDOW_CLASSES].sort()).toEqual(["CASCADIA_HOSTING_WINDOW_CLASS", "ConsoleWindowClass"]);
  });
});
