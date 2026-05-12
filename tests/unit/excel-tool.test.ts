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

import { describe, it, expect, beforeEach, vi } from "vitest";

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
    excelMacroRun: vi.fn(),
    excelCheckAccessVbom: vi.fn(() => ({
      trusted: true,
      lockedByPolicy: false,
      scope: "hkcu",
    })),
  };
  return { ...actual, nativeExcel: stub };
});

import { excelHandler, excelSchema, codeDeclaresMacro } from "../../src/tools/excel.js";
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
    expect(nativeExcel!.excelVbaModuleAdd).toHaveBeenCalledWith(
      42,
      "DesktopTouchAdHoc",
      SAMPLE_MACRO
    );
    expect(nativeExcel!.excelWorkbookSaveAs).toHaveBeenCalledWith(
      42,
      expect.stringContaining(".xlsm"),
      52
    );
    expect(nativeExcel!.excelMacroRun).toHaveBeenCalledWith(42, "DesktopTouchAdHoc");
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
    // The cleanup must still run.
    expect(nativeExcel!.excelSessionClose).toHaveBeenCalledWith(42);
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
    expect(nativeExcel!.excelSessionClose).toHaveBeenCalledWith(42);
  });
});
