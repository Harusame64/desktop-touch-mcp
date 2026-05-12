/**
 * tests/unit/launch-resolution.test.ts
 *
 * Issue #258 — `workspace_launch` should resolve bare executable names
 * like `excel.exe`, `winword.exe`, `outlook.exe` from the Windows
 * App Paths registry (the same mechanism Win+R and Explorer's address
 * bar use). `CreateProcess` does not consult App Paths, which is why
 * `workspace_launch(command='excel.exe')` previously returned ENOENT
 * for users with Office installed normally.
 *
 * These tests cover:
 *   1. resolveAppPathsRegistry — happy path REG_SZ
 *   2. resolveAppPathsRegistry — REG_EXPAND_SZ with %VAR% expansion
 *   3. resolveAppPathsRegistry — quoted value strip
 *   4. resolveAppPathsRegistry — fall-through across hives
 *   5. resolveAppPathsRegistry — no match returns null
 *   6. resolveLaunchExecutable — chain order (well-known beats app-paths)
 *   7. resolveLaunchExecutable — identity for path-separator inputs
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process so we can drive `reg query` output deterministically.
const spawnSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

// fs.existsSync — used by resolveWellKnownPath. Default to "not found" so the
// chain falls through to App Paths.
const existsSyncMock = vi.fn(() => false);
vi.mock("node:fs", () => ({
  default: {
    existsSync: (p: string) => existsSyncMock(p),
  },
  existsSync: (p: string) => existsSyncMock(p),
}));

import {
  resolveAppPathsRegistry,
  resolveLaunchExecutable,
} from "../../src/utils/launch.js";

function regHit(value: string, type: "REG_SZ" | "REG_EXPAND_SZ" = "REG_SZ") {
  return {
    status: 0,
    stdout:
      "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\EXCEL.EXE\r\n" +
      `    (Default)    ${type}    ${value}\r\n`,
    stderr: "",
  };
}

function regMiss() {
  return { status: 1, stdout: "", stderr: "ERROR: ..." };
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  existsSyncMock.mockClear();
  // Default: every path "exists" so the new App Paths existsSync gate
  // (post-resolve verification) doesn't reject hits in tests that don't
  // care about that axis. Tests that exercise the stale-entry path
  // override this with a tailored implementation.
  existsSyncMock.mockReturnValue(true);
});

describe("resolveAppPathsRegistry (issue #258)", () => {
  it("returns the registered absolute path for a known executable (REG_SZ)", () => {
    spawnSyncMock.mockReturnValueOnce(
      regHit("C:\\Program Files\\Microsoft Office\\Root\\Office16\\EXCEL.EXE"),
    );
    const r = resolveAppPathsRegistry("excel.exe");
    expect(r).toBe(
      "C:\\Program Files\\Microsoft Office\\Root\\Office16\\EXCEL.EXE",
    );
    // First lookup hits HKCU; we should have stopped after the first hit.
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("expands %VAR% tokens for REG_EXPAND_SZ values", () => {
    process.env["__APP_PATHS_TEST_ROOT"] = "C:\\TestRoot";
    spawnSyncMock.mockReturnValueOnce(
      regHit("%__APP_PATHS_TEST_ROOT%\\bin\\test.exe", "REG_EXPAND_SZ"),
    );
    const r = resolveAppPathsRegistry("test.exe");
    expect(r).toBe("C:\\TestRoot\\bin\\test.exe");
    delete process.env["__APP_PATHS_TEST_ROOT"];
  });

  it("strips surrounding double quotes (some installers add them)", () => {
    spawnSyncMock.mockReturnValueOnce(
      regHit('"C:\\Program Files\\Quoted App\\app.exe"'),
    );
    const r = resolveAppPathsRegistry("app.exe");
    expect(r).toBe("C:\\Program Files\\Quoted App\\app.exe");
  });

  it("falls through HKCU → HKLM → HKLM\\WOW6432Node and returns the first hit", () => {
    spawnSyncMock
      .mockReturnValueOnce(regMiss()) // HKCU miss
      .mockReturnValueOnce(regHit("C:\\Hkml\\App.exe")); // HKLM hit
    const r = resolveAppPathsRegistry("app.exe");
    expect(r).toBe("C:\\Hkml\\App.exe");
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when no hive holds the key", () => {
    spawnSyncMock.mockReturnValue(regMiss());
    const r = resolveAppPathsRegistry("nonexistent.exe");
    expect(r).toBeNull();
    expect(spawnSyncMock).toHaveBeenCalledTimes(3); // all three hives tried
  });

  it("returns null for path-separator inputs (caller already specified a path)", () => {
    expect(resolveAppPathsRegistry("C:\\full\\path.exe")).toBeNull();
    expect(resolveAppPathsRegistry("./relative.exe")).toBeNull();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("falls through to the next hive when the registry entry is stale (path no longer exists)", () => {
    // HKCU returns a registered path that's no longer on disk (Office
    // uninstalled, App Paths key not cleaned up); HKLM returns the live
    // install. The function must skip the stale entry, not surface it.
    spawnSyncMock
      .mockReturnValueOnce(regHit("C:\\stale\\old.exe"))
      .mockReturnValueOnce(regHit("C:\\live\\app.exe"));
    existsSyncMock.mockImplementation((p: string) =>
      typeof p === "string" && p === "C:\\live\\app.exe",
    );
    const r = resolveAppPathsRegistry("app.exe");
    expect(r).toBe("C:\\live\\app.exe");
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it("uses the absolute System32 reg.exe path (PATH-hijack defense)", () => {
    // Don't care about the result — only that we invoked the absolute path.
    spawnSyncMock.mockReturnValue(regMiss());
    resolveAppPathsRegistry("anything.exe");
    const firstCallCmd = spawnSyncMock.mock.calls[0]?.[0];
    expect(firstCallCmd).toMatch(/[\\/]System32[\\/]reg\.exe$/i);
    expect(firstCallCmd).not.toBe("reg");
  });

  it("adds .exe suffix if the caller omits it", () => {
    spawnSyncMock.mockReturnValue(regMiss());
    resolveAppPathsRegistry("notepad");
    // The first call's keyPath argument should end with NOTEPAD.EXE (case-
    // preserved as passed, but with .exe appended).
    const firstCallArgs = spawnSyncMock.mock.calls[0]?.[1] as
      | string[]
      | undefined;
    expect(firstCallArgs?.[1]).toMatch(/\\notepad\.exe$/);
  });
});

describe("resolveLaunchExecutable chain (issue #258)", () => {
  it("returns identity for path-separator inputs without consulting the registry", () => {
    const r = resolveLaunchExecutable("C:\\full\\path.exe");
    expect(r).toEqual({ resolved: "C:\\full\\path.exe", source: "identity" });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("falls back to App Paths when WELL_KNOWN_PATHS yields nothing", () => {
    // No fs hits → WELL_KNOWN_PATHS resolution fails → App Paths consulted.
    spawnSyncMock.mockReturnValueOnce(
      regHit("C:\\Program Files\\Office\\EXCEL.EXE"),
    );
    const r = resolveLaunchExecutable("excel.exe");
    expect(r).toEqual({
      resolved: "C:\\Program Files\\Office\\EXCEL.EXE",
      source: "app-paths",
    });
  });

  it("returns identity when neither well-known nor App Paths matches", () => {
    spawnSyncMock.mockReturnValue(regMiss());
    const r = resolveLaunchExecutable("unknown-tool.exe");
    expect(r).toEqual({ resolved: "unknown-tool.exe", source: "identity" });
  });

  it("uses WELL_KNOWN_PATHS when a candidate exists (no registry call)", () => {
    // Make fs.existsSync return true for the first chrome.exe candidate so
    // resolveWellKnownPath wins.
    existsSyncMock.mockImplementation((p: string) =>
      typeof p === "string" && p.toLowerCase().endsWith("\\chrome.exe"),
    );
    const r = resolveLaunchExecutable("chrome.exe");
    expect(r.source).toBe("well-known");
    expect(r.resolved.toLowerCase()).toContain("chrome.exe");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
