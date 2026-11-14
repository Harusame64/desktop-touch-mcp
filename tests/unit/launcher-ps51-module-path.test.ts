/**
 * The 2.4.2 npx smoke on win2: with a PowerShell 7 `PSModulePath` in the environment (a client started from a pwsh 7
 * prompt), Windows PowerShell 5.1 loaded PowerShell 7.7's Microsoft.PowerShell.Archive, its Expand-Archive called a
 * .NET overload .NET Framework lacks ("Cannot find an overload for "ExtractToDirectory" and the argument count: "3""),
 * 0 of 6,690 files were left, and the install failed. Without the variable it installed. The launcher now runs
 * powershell.exe without it.
 */
import { describe, expect, it } from "vitest";
import { windowsPowerShellEnv } from "../../bin/launcher.js";

describe("windowsPowerShellEnv", () => {
  it("drops PSModulePath in any spelling, and keeps everything else as it was", () => {
    const env = {
      PSModulePath: "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules",
      PSMODULEPATH: "x",
      psmodulepath: "y",
      Path: "C:\\Windows\\system32",
      DESKTOP_TOUCH_MCP_HOME: "C:\\t",
      PSModulePathExtra: "kept: only the exact name is dropped",
    };
    expect(windowsPowerShellEnv(env)).toEqual({
      Path: "C:\\Windows\\system32",
      DESKTOP_TOUCH_MCP_HOME: "C:\\t",
      PSModulePathExtra: "kept: only the exact name is dropped",
    });
  });
  it("leaves an environment without it unchanged, and does not touch the one it was given", () => {
    const env = { Path: "p", TEMP: "t" };
    expect(windowsPowerShellEnv(env)).toEqual(env);
    const withIt = { PSModulePath: "m", Path: "p" };
    windowsPowerShellEnv(withIt);
    expect(withIt).toEqual({ PSModulePath: "m", Path: "p" });
  });
});
