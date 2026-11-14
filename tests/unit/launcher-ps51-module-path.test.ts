/**
 * The 2.4.2 npx smoke on win2: with a PowerShell 7 `PSModulePath` in the environment (a client started from a pwsh 7
 * prompt), Windows PowerShell 5.1 loaded PowerShell 7.7's Microsoft.PowerShell.Archive, its Expand-Archive called a
 * .NET overload .NET Framework lacks ("Cannot find an overload for "ExtractToDirectory" and the argument count: "3""),
 * 0 of 6,690 files were left, and the install failed. Without the variable it installed. The launcher now runs
 * powershell.exe without it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ command: string; args: string[]; env?: Record<string, string> }>);
const enoent = vi.hoisted(() => ({ powershell: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      command: string,
      args: string[],
      options: { env?: Record<string, string> },
      callback: (error: (Error & { code?: string }) | null, stdout: string, stderr: string) => void,
    ) => {
      calls.push({ command, args, env: options?.env });
      if (enoent.powershell && command === "powershell.exe") {
        callback(Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" }), "", "");
        return;
      }
      callback(null, "", "");
    },
  };
});

import { expandZip, windowsPowerShellEnv } from "../../bin/launcher.js";

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

describe("expandZip on Windows (gate 2 on #991: the helper must be what the extractor gets)", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const saved = process.env.PSModulePath;
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    if (saved === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = saved;
    calls.length = 0;
    enoent.powershell = false;
  });

  it("runs powershell.exe without PSModulePath, and loads the archive module from its own $PSHOME", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.PSModulePath = "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.7.0.0\\Modules";
    await expandZip("C:\\t\\a.zip", "C:\\t\\out");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.command).toBe("powershell.exe");
    expect(call!.env).toBeDefined();
    expect(Object.keys(call!.env!).some((k) => k.toUpperCase() === "PSMODULEPATH")).toBe(false);
    expect(call!.env!.PATH ?? call!.env!.Path).toBe(process.env.PATH ?? process.env.Path);
    const script = call!.args[call!.args.indexOf("-Command") + 1]!;
    expect(script).toContain("Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Archive') -Force;");
    expect(script.indexOf("Import-Module")).toBeLessThan(script.indexOf("Expand-Archive"));
    expect(call!.args.slice(-2)).toEqual(["C:\\t\\a.zip", "C:\\t\\out"]);
  });

  it("falls back to pwsh.exe with the same script when powershell.exe is missing", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    enoent.powershell = true;
    await expandZip("a.zip", "out");
    expect(calls.map((c) => c.command)).toEqual(["powershell.exe", "pwsh.exe"]);
    expect(calls[1]!.args).toContain("-NoLogo");
    expect(calls[1]!.args.join(" ")).toContain("$PSHOME");
  });
});
