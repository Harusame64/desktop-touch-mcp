/**
 * internal #229 — screenshot(detail:"text") decided "terminal" by the owning process's image name, so a
 * WinForms form a PowerShell script showed (or `Out-GridView`) came back as a terminal with no
 * actionables (win2, 2026-09-30). The window's class decides now.
 */
import { describe, expect, it } from "vitest";
import { isTerminalWindow } from "../../src/utils/terminal-process.js";

describe("isTerminalWindow (internal #229)", () => {
  it("is a terminal by its window class, whatever process owns it", () => {
    expect(isTerminalWindow("ConsoleWindowClass", "conhost.exe")).toBe(true);
    expect(isTerminalWindow("ConsoleWindowClass", "powershell.exe")).toBe(true);
    expect(isTerminalWindow("CASCADIA_HOSTING_WINDOW_CLASS", "WindowsTerminal.exe")).toBe(true);
    expect(isTerminalWindow("CASCADIA_HOSTING_WINDOW_CLASS", undefined)).toBe(true);
  });

  it("is not a terminal when a shell owns a GUI window", () => {
    for (const proc of ["powershell.exe", "pwsh.exe", "pwsh", "cmd.exe", "bash.exe", "wsl.exe"]) {
      expect(isTerminalWindow("WindowsForms10.Window.8.app.0.2bf8098_r6_ad1", proc)).toBe(false);
    }
    expect(isTerminalWindow("HwndWrapper[pwsh;;abc]", "pwsh.exe")).toBe(false); // Out-GridView is WPF
  });

  it("keeps the terminal emulators whose class is not measured, by their process", () => {
    for (const proc of ["mintty.exe", "alacritty.exe", "wezterm.exe", "WindowsTerminal.exe"]) {
      expect(isTerminalWindow("SomeUnmeasuredClass", proc)).toBe(true);
    }
  });

  it("is not a terminal when neither the class nor the process could be read", () => {
    expect(isTerminalWindow(undefined, undefined)).toBe(false);
  });
});
