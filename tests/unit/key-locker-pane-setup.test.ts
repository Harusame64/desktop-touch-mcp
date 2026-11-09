import { describe, it, expect } from "vitest";
import { paneSetupCommand } from "../../src/engine/key-locker/key-locker-manager.js";

// internal #344: a classic launch_console pane ignored Ctrl+C (win2, 2026-11-09: the real key
// interrupted 0 of 3, ConsoleFlags 3 in powershell), inherited from the detached spawn's new process
// group. The pane's own shell clears the flag right after it sets its title.
describe("the pane's setup command (internal #344)", () => {
  const title = "dtm-locker-console-0123456789abcdef";
  const cmd = paneSetupCommand(title);

  it("still sets UTF-8 output and the title the claim polls for, title before anything slower", () => {
    expect(cmd.startsWith("try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}; ")).toBe(true);
    const at = cmd.indexOf(`$Host.UI.RawUI.WindowTitle = '${title}';`);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(cmd.indexOf("Add-Type"));
  });

  it("restores Ctrl+C with SetConsoleCtrlHandler(NULL, FALSE) and treats a false return as a failure", () => {
    expect(cmd).toContain('[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr handler, bool add);');
    expect(cmd).toContain("if (-not [DesktopTouch.ConsoleCtrl]::SetConsoleCtrlHandler([System.IntPtr]::Zero, $false)) { throw ");
  });

  it("says so in the pane when it could not, instead of failing the launch or staying silent", () => {
    const reset = cmd.slice(cmd.indexOf("try { Add-Type"));
    expect(reset).toMatch(/\} catch \{ Write-Host "desktop-touch: Ctrl\+C could not be turned back on in this window \(\$\(\$_\.Exception\.Message\)\); [^"]*" \}$/);
  });

  it("takes only titles that cannot break out of the single-quoted string", () => {
    for (const bad of ["x'; Remove-Item C:\\ -Recurse; '", "a b", "", "dtm\u3000x", "x\"y", "x$(y)"]) {
      expect(() => paneSetupCommand(bad), bad).toThrow(/unexpected title/);
    }
  });
});
