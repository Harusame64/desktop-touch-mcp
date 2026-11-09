/**
 * excel-tool.test.ts — Unit pins for the `excel` MCP tool (ADR-015 Phase 4).
 *
 * Mock-driven coverage of the schema + handler dispatch + typed-error path,
 * with the nativeExcel surface stubbed so the tests are hermetic and do not
 * actually spawn Excel.exe. Real end-to-end execution is verified in the
 * Rust integration test (`cargo test --features excel-installed`).
 *
 * Pins:
 * - Schema rejects unknown actions (Zod discriminator)
 * - `check_access_vbom` returns the napi shim's status verbatim
 * - `run_vba` rejects code that doesn't declare the target Sub (VbaMacroNotFound)
 * - `run_vba` propagates the napi shim's VbaAccessNotTrusted via preflight
 * - `run_vba` success path returns {ok:true, workbookPath, hints.verifyDelivery}
 * - `run_vba` failure inside macro_run maps to VbaMacroExecutionFailed
 * - `codeDeclaresMacro` handles whitespace, modifiers, and special-char names
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { join } from "node:path";

// Mock the native-engine surface BEFORE importing the handler so the
// in-memory binding picks up the stub. Use `importOriginal` to preserve
// all other native-engine exports (nativeUia / nativeWin32 / etc) so
// modules that transitively load native-engine (uia-bridge, _post,
// makeCommitWrapper) still get their real surfaces.
vi.mock("../../src/engine/native-engine.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const stub = {
    excelSessionSpawn: vi.fn(() => 42),
    excelSessionClose: vi.fn(),
    excelSessionIsAlive: vi.fn(() => true),
    excelSetVisible: vi.fn(),
    excelSetDisplayAlerts: vi.fn(),
    excelWorkbookAddNew: vi.fn(),
    excelWorkbookSaveAs: vi.fn(),
    excelWorkbookClose: vi.fn(),
    excelVbaModuleAdd: vi.fn(),
    excelMacroRun: vi.fn(() => "OK"),
    excelCheckAccessVbom: vi.fn(() => ({
      trusted: true,
      lockedByPolicy: false,
      scope: "hkcu",
    })),
  };
  return { ...actual, nativeExcel: stub };
});

import { excelHandler, excelSchema, codeDeclaresMacro, withRunGuard, requiredParamsOf } from "../../src/tools/excel.js";
import { nativeExcel } from "../../src/engine/native-engine.js";

function parseResult(r: { content: { type: string; text: string }[] }) {
  return JSON.parse(r.content[0]!.text);
}

const SAMPLE_MACRO = `Sub DesktopTouchAdHoc()
    Range("A1").Value = "Hello from Claude"
End Sub`;

beforeEach(() => {
  // Reset all mock call history but keep the default implementations.
  for (const fn of Object.values(nativeExcel!)) {
    if (typeof fn === "function") vi.mocked(fn as never).mockClear();
  }
  // Restore the default "trusted: true" status before each test so individual
  // tests can override via mockReturnValueOnce.
  vi.mocked(nativeExcel!.excelCheckAccessVbom!).mockReturnValue({
    trusted: true,
    lockedByPolicy: false,
    scope: "hkcu",
  });
});

describe("codeDeclaresMacro (regex pre-flight)", () => {
  it("matches a basic Sub declaration", () => {
    expect(codeDeclaresMacro("Sub Foo()\nEnd Sub", "Foo")).toBe(true);
  });

  it("matches with leading whitespace", () => {
    expect(codeDeclaresMacro("    Sub Foo()\n", "Foo")).toBe(true);
  });

  it("matches with Public modifier", () => {
    expect(codeDeclaresMacro("Public Sub Bar(x As Integer)", "Bar")).toBe(true);
  });

  it("matches with Private modifier", () => {
    expect(codeDeclaresMacro("Private Sub Baz()", "Baz")).toBe(true);
  });

  it("rejects when the Sub name differs", () => {
    expect(codeDeclaresMacro("Sub Foo()\nEnd Sub", "Bar")).toBe(false);
  });

  it("rejects when Sub keyword is missing (Function fallback)", () => {
    expect(codeDeclaresMacro("Function Foo() As Integer\nEnd Function", "Foo")).toBe(false);
  });

  it("escapes special regex chars in the macro name (defensive)", () => {
    // Underscores are fine, dots would break a naive regex but the helper
    // escapes them.
    expect(codeDeclaresMacro("Sub Foo_Bar()\n", "Foo_Bar")).toBe(true);
  });
});

describe("excelSchema (discriminated union)", () => {
  it("accepts the run_vba variant with required fields", () => {
    const parsed = excelSchema.safeParse({
      action: "run_vba",
      code: SAMPLE_MACRO,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Default macroName + visible defaults applied.
      expect(parsed.data.action).toBe("run_vba");
      if (parsed.data.action === "run_vba") {
        expect(parsed.data.macroName).toBe("DesktopTouchAdHoc");
        expect(parsed.data.visible).toBe(false);
      }
    }
  });

  it("accepts the check_access_vbom variant", () => {
    const parsed = excelSchema.safeParse({ action: "check_access_vbom" });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown action", () => {
    const parsed = excelSchema.safeParse({ action: "unknown_action" });
    expect(parsed.success).toBe(false);
  });

  it("rejects run_vba without code", () => {
    const parsed = excelSchema.safeParse({ action: "run_vba" });
    expect(parsed.success).toBe(false);
  });
});

describe("excelHandler — check_access_vbom", () => {
  it("returns the napi status verbatim when trusted", async () => {
    const result = await excelHandler({ action: "check_access_vbom" });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("check_access_vbom");
    expect(body.trusted).toBe(true);
    expect(body.scope).toBe("hkcu");
    // No suggest when trusted.
    expect(body.suggest).toBeUndefined();
  });

  it("includes CLI suggest when AccessVBOM is not trusted", async () => {
    vi.mocked(nativeExcel!.excelCheckAccessVbom!).mockReturnValueOnce({
      trusted: false,
      lockedByPolicy: false,
      scope: "default",
    });
    const result = await excelHandler({ action: "check_access_vbom" });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(body.trusted).toBe(false);
    expect(body.suggest).toEqual(
      expect.arrayContaining([
        expect.stringContaining("scripts/enable-access-vbom.mjs"),
      ])
    );
  });

  it("returns IT-department suggest when group policy locks it", async () => {
    vi.mocked(nativeExcel!.excelCheckAccessVbom!).mockReturnValueOnce({
      trusted: false,
      lockedByPolicy: true,
      scope: "hklm-policy",
    });
    const result = await excelHandler({ action: "check_access_vbom" });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(body.lockedByPolicy).toBe(true);
    expect(body.suggest).toEqual(
      expect.arrayContaining([
        expect.stringContaining("IT department"),
      ])
    );
  });
});

describe("excelHandler — run_vba", () => {
  // run_vba now sweeps and removes workbooks in %LOCALAPPDATA%\desktop-touch-mcp\trusted-vba (internal #336):
  // never the developer's real folder.
  let appData = "";
  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    appData = mkdtempSync(join(tmpdir(), "dt-lad-run-"));
    vi.stubEnv("LOCALAPPDATA", appData);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    const { rmSync } = await import("node:fs");
    rmSync(appData, { recursive: true, force: true });
  });

  it("fails fast with VbaMacroNotFound when code lacks the Sub", async () => {
    const result = await excelHandler({
      action: "run_vba",
      code: "Sub OtherSub()\nEnd Sub",
      macroName: "DesktopTouchAdHoc",
      visible: false,
    });
    const body = parseResult(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("VbaMacroNotFound");
    expect(body.suggest).toEqual(
      expect.arrayContaining([
        expect.stringContaining("does not declare a Sub matching"),
      ])
    );
    // Should NOT have spawned Excel.exe.
    expect(nativeExcel!.excelSessionSpawn).not.toHaveBeenCalled();
  });

  it("preflights AccessVBOM and short-circuits with VbaAccessNotTrusted", async () => {
    vi.mocked(nativeExcel!.excelCheckAccessVbom!).mockReturnValueOnce({
      trusted: false,
      lockedByPolicy: false,
      scope: "default",
    });
    const result = await excelHandler({
      action: "run_vba",
      code: SAMPLE_MACRO,
      macroName: "DesktopTouchAdHoc",
      visible: false,
    });
    const body = parseResult(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("VbaAccessNotTrusted");
    expect(nativeExcel!.excelSessionSpawn).not.toHaveBeenCalled();
  });

  it("preflights and reports VbaAccessLockedByPolicy when HKLM forces 0", async () => {
    vi.mocked(nativeExcel!.excelCheckAccessVbom!).mockReturnValueOnce({
      trusted: false,
      lockedByPolicy: true,
      scope: "hklm-policy",
    });
    const result = await excelHandler({
      action: "run_vba",
      code: SAMPLE_MACRO,
      macroName: "DesktopTouchAdHoc",
      visible: false,
    });
    const body = parseResult(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("VbaAccessLockedByPolicy");
  });

  it("executes the full demo path and returns verifyDelivery on success", async () => {
    const result = await excelHandler({
      action: "run_vba",
      code: SAMPLE_MACRO,
      macroName: "DesktopTouchAdHoc",
      visible: false,
    });
    const body = parseResult(result);
    expect(body.ok).toBe(true);
    expect(body.action).toBe("run_vba");
    expect(body.macroName).toBe("DesktopTouchAdHoc");
    expect(body.workbookPath).toContain("dt_vba_");
    expect(body.workbookPath).toContain(".xlsm");
    expect(body.hints.verifyDelivery.status).toBe("delivered");
    expect(body.hints.verifyDelivery.channel).toBe("excel_com_application_run");

    // Verify the call order.
    expect(nativeExcel!.excelSessionSpawn).toHaveBeenCalledTimes(1);
    expect(nativeExcel!.excelSetVisible).toHaveBeenCalledWith(42, false);
    expect(nativeExcel!.excelWorkbookAddNew).toHaveBeenCalledWith(42);
    // The module is never named after the macro (Application.Run would name the module: win2, #895).
    expect(nativeExcel!.excelVbaModuleAdd).toHaveBeenCalledWith(
      42,
      "DesktopTouchModule",
      withRunGuard(SAMPLE_MACRO, "DesktopTouchAdHoc")
    );
    expect(nativeExcel!.excelWorkbookSaveAs).toHaveBeenCalledWith(
      42,
      expect.stringContaining(".xlsm"),
      52
    );
    expect(nativeExcel!.excelMacroRun).toHaveBeenCalledWith(42, "DesktopTouchRunGuard", 30_000);
    expect(nativeExcel!.excelWorkbookClose).toHaveBeenCalledWith(42, false);
    expect(nativeExcel!.excelSessionClose).toHaveBeenCalledWith(42);
  });

  it("maps native VbaMacroExecutionFailed to the typed envelope", async () => {
    vi.mocked(nativeExcel!.excelMacroRun!).mockImplementationOnce(() => {
      throw new Error(
        "VbaMacroExecutionFailed: Application.Run failed (HRESULT=0x800a03ec): ..."
      );
    });
    const result = await excelHandler({
      action: "run_vba",
      code: SAMPLE_MACRO,
      macroName: "DesktopTouchAdHoc",
      visible: false,
    });
    const body = parseResult(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("VbaMacroExecutionFailed");
    // The cleanup must still run: the workbook is closed first, so the session close can quit Excel (#345).
    expect(nativeExcel!.excelWorkbookClose).toHaveBeenCalledWith(42, false);
    expect(nativeExcel!.excelSessionClose).toHaveBeenCalledWith(42);
    expect(vi.mocked(nativeExcel!.excelWorkbookClose!).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(nativeExcel!.excelSessionClose!).mock.invocationCallOrder[0]
    );
  });

  it("a workbook close that throws after a failed run keeps the run's error and still closes the session (#345)", async () => {
    vi.mocked(nativeExcel!.excelMacroRun!).mockImplementationOnce(() => {
      throw new Error("VbaMacroExecutionFailed: Application.Run failed (HRESULT=0x800a03ec): ...");
    });
    vi.mocked(nativeExcel!.excelWorkbookClose!).mockImplementationOnce(() => {
      throw new Error("ComCallFailed: unexpected VARIANT shape: no workbook was added in this session");
    });
    const result = await excelHandler({
      action: "run_vba",
      code: SAMPLE_MACRO,
      macroName: "DesktopTouchAdHoc",
      visible: false,
    });
    const body = parseResult(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("VbaMacroExecutionFailed");
    expect(nativeExcel!.excelSessionClose).toHaveBeenCalledWith(42);
  });

  it("a visible run that failed keeps its workbook on screen; a visible run that ran closes it (#345)", async () => {
    vi.mocked(nativeExcel!.excelMacroRun!).mockImplementationOnce(() => {
      throw new Error("VbaMacroExecutionFailed: Application.Run failed (HRESULT=0x800a03ec): ...");
    });
    const failed = parseResult(
      await excelHandler({ action: "run_vba", code: SAMPLE_MACRO, macroName: "DesktopTouchAdHoc", visible: true })
    );
    expect(failed.code).toBe("VbaMacroExecutionFailed");
    expect(nativeExcel!.excelWorkbookClose).not.toHaveBeenCalled();
    expect(nativeExcel!.excelSessionClose).toHaveBeenCalledWith(42);

    const ran = parseResult(
      await excelHandler({ action: "run_vba", code: SAMPLE_MACRO, macroName: "DesktopTouchAdHoc", visible: true })
    );
    expect(ran.ok).toBe(true);
    expect(nativeExcel!.excelWorkbookClose).toHaveBeenCalledWith(42, false);
  });

  it("cleans up the session even when SaveAs throws", async () => {
    vi.mocked(nativeExcel!.excelWorkbookSaveAs!).mockImplementationOnce(() => {
      throw new Error(
        "VbaModuleAuthoringFailed: Workbook.SaveAs failed (HRESULT=0x80004005): ..."
      );
    });
    const result = await excelHandler({
      action: "run_vba",
      code: SAMPLE_MACRO,
      macroName: "DesktopTouchAdHoc",
      visible: false,
    });
    const body = parseResult(result);
    expect(body.ok).toBe(false);
    expect(body.code).toBe("VbaModuleAuthoringFailed");
    expect(nativeExcel!.excelWorkbookClose).toHaveBeenCalledWith(42, false);
    expect(nativeExcel!.excelSessionClose).toHaveBeenCalledWith(42);
  });
});

// internal #336: run_vba's workbooks do not stay in the trusted folder.
describe("run_vba workbook cleanup (internal #336)", () => {
  it("sweeps only dt_vba_*.xlsm files (and their ~$ owner files) older than six hours", async () => {
    const { mkdtempSync, writeFileSync, utimesSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { sweepLeftoverWorkbooks } = await import("../../src/tools/excel.js");
    const dir = mkdtempSync(join(tmpdir(), "dt-vba-"));
    try {
      const now = Date.now();
      const old = join(dir, "dt_vba_1.xlsm");
      const lock = join(dir, "~$dt_vba_1.xlsm");
      const fresh = join(dir, "dt_vba_2.xlsm");
      const other = join(dir, "mine.xlsm");
      for (const p of [old, lock, fresh, other]) writeFileSync(p, "");
      const sevenHours = new Date(now - 7 * 60 * 60_000);
      for (const p of [old, lock, other]) utimesSync(p, sevenHours, sevenHours);
      utimesSync(fresh, new Date(now - 60 * 60_000), new Date(now - 60 * 60_000)); // an hour: a long run elsewhere
      sweepLeftoverWorkbooks(dir, now);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(fresh)).toBe(true); // a run in progress
      expect(existsSync(other)).toBe(true); // not ours
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a run_vba leaves no workbook in the trusted folder", async () => {
    const { mkdtempSync, writeFileSync, readdirSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const appData = mkdtempSync(join(tmpdir(), "dt-lad-"));
    vi.stubEnv("LOCALAPPDATA", appData);
    const trusted = join(appData, "desktop-touch-mcp", "trusted-vba");
    mkdirSync(trusted, { recursive: true });
    // Earlier cases that return before the native calls (no LOCALAPPDATA off Windows) leave their
    // mock*Once implementations queued: start this one clean.
    vi.mocked(nativeExcel!.excelWorkbookSaveAs!).mockReset();
    vi.mocked(nativeExcel!.excelMacroRun!).mockReset();
    vi.mocked(nativeExcel!.excelMacroRun!).mockImplementation(() => "OK");
    // The native SaveAs writes the file; the mock does the same.
    vi.mocked(nativeExcel!.excelWorkbookSaveAs!).mockImplementationOnce((_s: unknown, path: unknown) => {
      writeFileSync(path as string, "");
      return undefined as never;
    });
    try {
      const body = parseResult(await excelHandler({ action: "run_vba", code: SAMPLE_MACRO, macroName: "DesktopTouchAdHoc", visible: false }));
      expect(body.ok).toBe(true);
      expect(readdirSync(trusted)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(appData, { recursive: true, force: true });
    }
  });

  it("removes the run's workbook, and a missing one is fine", async () => {
    const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { removeWorkbookSoon } = await import("../../src/tools/excel.js");
    const dir = mkdtempSync(join(tmpdir(), "dt-vba-"));
    try {
      const p = join(dir, "dt_vba_3.xlsm");
      writeFileSync(p, "");
      removeWorkbookSoon(p, [0]);
      expect(existsSync(p)).toBe(false);
      expect(() => removeWorkbookSoon(p, [0])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("vbaModuleNameFor (#895)", () => {
  it("is never the macro's own name", async () => {
    const { vbaModuleNameFor } = await import("../../src/tools/excel.js");
    expect(vbaModuleNameFor("DesktopTouchAdHoc")).toBe("DesktopTouchModule");
    expect(vbaModuleNameFor("DesktopTouchModule")).toBe("DesktopTouchModule2");
    expect(vbaModuleNameFor("desktoptouchmodule")).toBe("DesktopTouchModule2");
  });
});

// internal #350: a runtime error in the macro showed a VBA dialog over a hidden Excel and run_vba never
// returned. The macro now runs inside a guard that answers "OK" or "ERR <n>: <text>", and the native run
// ends this run's Excel after timeoutSeconds.
describe("run_vba guard and timeout (internal #350)", () => {
  const run = (extra: Record<string, unknown> = {}) =>
    excelHandler({ action: "run_vba", code: SAMPLE_MACRO, ...extra } as never).then(parseResult);
  const inTrustedDir = () => {
    const appData = mkdtempSync(join(tmpdir(), "dt-350-"));
    vi.stubEnv("LOCALAPPDATA", appData);
    mkdirSync(join(appData, "desktop-touch-mcp", "trusted-vba"), { recursive: true });
  };
  beforeEach(() => {
    inTrustedDir();
    vi.mocked(nativeExcel!.excelMacroRun!).mockReset();
  });

  it("the guard calls the macro under On Error and answers OK or ERR", () => {
    const g = withRunGuard("Private Sub Foo()\r\nEnd Sub", "Foo");
    expect(g.startsWith("Private Sub Foo()\r\nEnd Sub\r\n")).toBe(true);
    expect(g).toContain("Public Function DesktopTouchRunGuard() As String");
    expect(g).toContain("On Error GoTo DesktopTouchRunGuardFailed");
    expect(g).toMatch(/\r\n {4}Foo\r\n/);
    expect(g).toContain('DesktopTouchRunGuard = "OK"');
    expect(g).toContain('DesktopTouchRunGuard = "ERR " & Err.Number & ": " & Err.Description');
  });

  it("passes timeoutSeconds to the native run in milliseconds", async () => {
    vi.mocked(nativeExcel!.excelMacroRun!).mockImplementation(() => "OK");
    const r = await run({ timeoutSeconds: 5 });
    expect(r.ok).toBe(true);
    expect(nativeExcel!.excelMacroRun).toHaveBeenCalledWith(42, "DesktopTouchRunGuard", 5_000);
  });

  it("a runtime error comes back as VbaMacroExecutionFailed with its number and text, and a hidden run closes its workbook", async () => {
    vi.mocked(nativeExcel!.excelMacroRun!).mockImplementation(() => "ERR 1000: boom");
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.code).toBe("VbaMacroExecutionFailed");
    expect(r.error).toContain("runtime error 1000: boom");
    expect(r.context).toMatchObject({ vbaErrorNumber: 1000, vbaErrorDescription: "boom" });
    expect(nativeExcel!.excelWorkbookClose).toHaveBeenCalledWith(42, false);
    expect(nativeExcel!.excelSessionClose).toHaveBeenCalledWith(42);
  });

  it("a visible run whose macro raised keeps its workbook on screen", async () => {
    vi.mocked(nativeExcel!.excelMacroRun!).mockImplementation(() => "ERR 11: 0 で除算しました。");
    const r = await run({ visible: true });
    expect(r.code).toBe("VbaMacroExecutionFailed");
    expect(nativeExcel!.excelWorkbookClose).not.toHaveBeenCalled();
    expect(nativeExcel!.excelSessionClose).toHaveBeenCalledWith(42);
  });

  it("a run that returns without the guard's word is not counted as done", async () => {
    vi.mocked(nativeExcel!.excelMacroRun!).mockImplementation(() => null);
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.code).toBe("VbaMacroExecutionFailed");
  });

  it("a native timeout is VbaMacroExecutionFailed and the session is still closed", async () => {
    vi.mocked(nativeExcel!.excelMacroRun!).mockImplementation(() => {
      throw new Error("VbaMacroExecutionFailed: the macro did not return within 60 s, so this run's Excel (pid 9) was ended.");
    });
    const r = await run();
    expect(r.code).toBe("VbaMacroExecutionFailed");
    expect(r.error).toContain("did not return within 60 s");
    expect(nativeExcel!.excelSessionClose).toHaveBeenCalledWith(42);
  });

  it("refuses code that declares the guard's name, and the guard's name as macroName, before Excel starts", async () => {
    const own = await excelHandler({
      action: "run_vba",
      code: "Sub DesktopTouchRunGuard()\r\nEnd Sub",
      macroName: "DesktopTouchRunGuard",
    } as never).then(parseResult);
    expect(own.code).toBe("VbaModuleAuthoringFailed");
    const declared = await excelHandler({
      action: "run_vba",
      code: SAMPLE_MACRO + "\r\nFunction DesktopTouchRunGuard()\r\nEnd Function",
    } as never).then(parseResult);
    expect(declared.code).toBe("VbaModuleAuthoringFailed");
    expect(nativeExcel!.excelSessionSpawn).not.toHaveBeenCalled();
  });
});

// Gate 2 on #910.
describe("run_vba guard and timeout: gate 2 on #910", () => {
  const run = (extra: Record<string, unknown> = {}) =>
    excelHandler({ action: "run_vba", code: SAMPLE_MACRO, ...extra } as never).then(parseResult);
  beforeEach(() => {
    const appData = mkdtempSync(join(tmpdir(), "dt-910-"));
    vi.stubEnv("LOCALAPPDATA", appData);
    mkdirSync(join(appData, "desktop-touch-mcp", "trusted-vba"), { recursive: true });
    vi.mocked(nativeExcel!.excelMacroRun!).mockReset();
    vi.mocked(nativeExcel!.excelMacroRun!).mockImplementation(() => "OK");
  });

  it("a hidden run is timed at 30 s by default, under the MCP SDK's 60 s request timeout", async () => {
    await run();
    expect(nativeExcel!.excelMacroRun).toHaveBeenCalledWith(42, "DesktopTouchRunGuard", 30_000);
  });

  it("a visible run is not timed unless timeoutSeconds is given", async () => {
    await run({ visible: true });
    expect(nativeExcel!.excelMacroRun).toHaveBeenLastCalledWith(42, "DesktopTouchRunGuard", undefined);
    await run({ visible: true, timeoutSeconds: 90 });
    expect(nativeExcel!.excelMacroRun).toHaveBeenLastCalledWith(42, "DesktopTouchRunGuard", 90_000);
  });

  it("a native build that returns nothing (before the guard) still counts a run as done", async () => {
    vi.mocked(nativeExcel!.excelMacroRun!).mockImplementation(() => undefined as never);
    const r = await run();
    expect(r.ok).toBe(true);
  });

  it("refuses a Sub with required parameters before Excel starts; Optional and ParamArray pass", async () => {
    expect(requiredParamsOf("Sub Foo(ByVal n As Long, Optional s As String)", "Foo")).toEqual(["ByVal n As Long"]);
    expect(requiredParamsOf("Private Sub Foo(Optional s As String, ParamArray rest())", "Foo")).toEqual([]);
    expect(requiredParamsOf("Sub Foo()", "Foo")).toEqual([]);
    // codex on #910: a comma or a parenthesis inside a default value, and a continued line.
    expect(requiredParamsOf('Sub Foo(Optional s As String = "a,b")', "Foo")).toEqual([]);
    expect(requiredParamsOf('Sub Foo(Optional s As String = "a)", Optional t = "say ""x,y""")', "Foo")).toEqual([]);
    expect(requiredParamsOf("Sub Foo( _\r\n    Optional n As Long = 1, _\r\n    Optional m As Long)", "Foo")).toEqual([]);
    expect(requiredParamsOf('Sub Foo(Optional s = "a,b", n As Long)', "Foo")).toEqual(["n As Long"]);
    expect(requiredParamsOf("Sub Foo(arr() As Long)", "Foo")).toEqual(["arr() As Long"]);
    const r = await excelHandler({
      action: "run_vba",
      code: "Sub Foo(ByVal n As Long)\r\nEnd Sub",
      macroName: "Foo",
    } as never).then(parseResult);
    expect(r.code).toBe("VbaModuleAuthoringFailed");
    expect(r.error).toContain("takes arguments (ByVal n As Long)");
    expect(nativeExcel!.excelSessionSpawn).not.toHaveBeenCalled();
  });

  it("refuses the guard's name in any declaration", async () => {
    for (const decl of [
      "Private Static Function DesktopTouchRunGuard()\r\nEnd Function",
      "Public DesktopTouchRunGuard As Long",
      "Property Get desktoptouchrunguard()\r\nEnd Property",
    ]) {
      const r = await run({ code: `${SAMPLE_MACRO}\r\n${decl}` });
      expect(r.code, decl).toBe("VbaModuleAuthoringFailed");
    }
    expect(nativeExcel!.excelSessionSpawn).not.toHaveBeenCalled();
  });

  it("removes Excel's owner file beside the workbook, which an ended Excel leaves", async () => {
    const { writeFileSync, existsSync } = await import("node:fs");
    let owner = "";
    vi.mocked(nativeExcel!.excelWorkbookSaveAs!).mockImplementationOnce((_s: unknown, path: unknown) => {
      writeFileSync(path as string, "");
      owner = join(dirname(path as string), "~$" + basename(path as string));
      writeFileSync(owner, "");
      return undefined as never;
    });
    vi.mocked(nativeExcel!.excelMacroRun!).mockImplementation(() => {
      throw new Error("VbaMacroExecutionFailed: the macro did not return within 30 s, so this run's Excel (pid 9) was ended.");
    });
    await run();
    expect(owner).not.toBe("");
    expect(existsSync(owner)).toBe(false);
  });

  it("leaves the owner file to Excel when the run was not ended: removing it under a closing Excel held that Excel 60 s", async () => {
    const { writeFileSync, existsSync, rmSync } = await import("node:fs");
    for (const outcome of ["OK", "ERR 11: x"]) {
      let owner = "";
      vi.mocked(nativeExcel!.excelWorkbookSaveAs!).mockImplementationOnce((_s: unknown, path: unknown) => {
        writeFileSync(path as string, "");
        owner = join(dirname(path as string), "~$" + basename(path as string));
        writeFileSync(owner, "");
        return undefined as never;
      });
      vi.mocked(nativeExcel!.excelMacroRun!).mockImplementation(() => outcome);
      await run();
      expect(existsSync(owner), outcome).toBe(true);
      rmSync(owner);
    }
  });
});
