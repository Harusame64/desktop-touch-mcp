import { describe, it, expect } from "vitest";
import { paneSetupCommand } from "../../src/engine/key-locker/key-locker-manager.js";

// internal #344: a classic launch_console pane ignored Ctrl+C (win2, 2026-11-09: the real key
// interrupted 0 of 3, ConsoleFlags 3 in powershell), inherited from the detached spawn's new process
// group. The pane's own shell clears the flag after setting its title.
describe("the pane's setup command (internal #344)", () => {
  const cmd = paneSetupCommand("dtm-pane-0123abcd");

  it("still sets UTF-8 output and the title the claim polls for, title before anything slower", () => {
    expect(cmd.startsWith("try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}; ")).toBe(true);
    const title = cmd.indexOf("$Host.UI.RawUI.WindowTitle = 'dtm-pane-0123abcd';");
    expect(title).toBeGreaterThan(0);
    expect(title).toBeLessThan(cmd.indexOf("Add-Type"));
  });

  it("restores Ctrl+C with SetConsoleCtrlHandler(NULL, FALSE), inside try/catch so a failure cannot fail the launch", () => {
    const tail = cmd.slice(cmd.indexOf("Add-Type") - "try { ".length);
    expect(tail.startsWith("try { Add-Type")).toBe(true);
    expect(tail).toContain('[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);');
    expect(tail).toContain("::SetConsoleCtrlHandler([System.IntPtr]::Zero, $false)");
    expect(tail.trimEnd().endsWith("} catch {}")).toBe(true);
  });
});
