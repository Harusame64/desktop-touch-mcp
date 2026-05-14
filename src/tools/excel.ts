import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { join } from "node:path";

import { ok, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { withRichNarration } from "./_narration.js";
import {
  makeCommitWrapper,
  withEnvelopeIncludeForUnion,
  flattenUnionToObjectSchema,
  parseActionArgsOrFail,
} from "./_envelope.js";
import { nativeExcel } from "../engine/native-engine.js";
import type { NativeExcelAccessVbomStatus } from "../engine/native-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// ADR-015 Phase 4: `excel` MCP tool surface
// ─────────────────────────────────────────────────────────────────────────────
//
// Single `excel` tool with action-discriminated union per ADR §4.4. v1.5.0
// ships TWO action variants:
//
//   - run_vba              — author + run a VBA macro end-to-end (the headline
//                            demo path against `Claude for Excel`)
//   - check_access_vbom    — read-only HKCU/HKLM AccessVBOM preflight
//
// ADR §4.4 lists `eval_cell` and `refresh_query` as further variants; those are
// deferred to a v1.5.x follow-up because Phase 2 did not ship Rust support for
// them (`engine_vba_bridge::excel::eval_cell` / `excel::refresh_power_query`
// are tagged "Future phases" in §3.6). The discriminated union grows
// non-breakingly when those land.
//
// Typed errors flow from the napi shim's `"<PascalCaseCode>:"` prefix
// convention (see `src/vba_bridge.rs` module doc-block). The handler parses
// the prefix to populate `_errors.ts` SUGGESTS via `failWith`.

// ─────────────────────────────────────────────────────────────────────────────
// Trusted Location resolution (mirrors scripts/enable-access-vbom.mjs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the desktop-touch-managed Trusted Location path the CLI registers.
 * Mirrors the constant in `scripts/enable-access-vbom.mjs::TRUSTED_LOCATION_LEAF`
 * — if you change this, change it there (CLAUDE.md §3.1 fact整合).
 *
 * The bridge writes `.xlsm` workbooks into this directory before invoking
 * `Application.Run`, so Excel's Trust Center allows macro execution
 * (otherwise HRESULT 0x800a03ec, see Phase 2e ADR-015 §3.6 / §7).
 */
function getTrustedDir(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) return join(localAppData, "desktop-touch-mcp", "trusted-vba");
  const userProfile = process.env.USERPROFILE;
  if (userProfile) {
    return join(userProfile, "AppData", "Local", "desktop-touch-mcp", "trusted-vba");
  }
  // Single-line message so the envelope `error` field stays render-clean
  // for LLM agents that don't unwrap `\n`-separated prose (Opus Round 1
  // P2-4 — `failWith` template literal preserves embedded newlines).
  throw new Error(
    "VbaBridgeUnavailable: cannot resolve Trusted Location — neither LOCALAPPDATA nor USERPROFILE is set. Run on Windows where Excel and the desktop-touch-mcp CLI are installed."
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const runVbaSchema = z.object({
  action: z.literal("run_vba").describe(
    "Author a VBA module in a fresh workbook, save into the managed Trusted " +
      "Location, and invoke the macro via Application.Run."
  ),
  code: z
    .string()
    .min(1)
    .describe(
      "VBA source. MUST declare at least one Sub matching `macroName` " +
        "(default `DesktopTouchAdHoc`). Example: \n" +
        '"Sub DesktopTouchAdHoc()\\r\\n    Range(\\"A1\\").Value = \\"Hello\\"\\r\\nEnd Sub"'
    ),
  macroName: z
    .string()
    .min(1)
    .default("DesktopTouchAdHoc")
    .describe(
      "Sub name to invoke. MUST appear in `code` as `Sub <name>(...)`. " +
        "Default `DesktopTouchAdHoc`."
    ),
  visible: z
    .boolean()
    .default(false)
    .describe(
      "If true, show the Excel window during execution. Default false (headless). " +
        "Setting visible:true is useful for demo recording but may surface MsgBox/InputBox " +
        "calls in the macro that block the COM thread."
    ),
});

const checkAccessVbomSchema = z.object({
  action: z.literal("check_access_vbom").describe(
    "Read-only inspection of HKCU/HKLM AccessVBOM registry state. Returns " +
      "{trusted, lockedByPolicy, scope}. Use as a preflight before run_vba " +
      "to give the user a clear remediation hint when the bridge cannot work."
  ),
});

export const excelSchema = z.discriminatedUnion("action", [
  runVbaSchema,
  checkAccessVbomSchema,
]);

export type ExcelArgs = z.infer<typeof excelSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lightweight pre-flight: scan `code` for a `Sub <macroName>(...)` declaration.
 * Returns true if found, false otherwise. Performed BEFORE the COM call so
 * users get a fast, deterministic `VbaMacroNotFound` diagnostic without
 * waiting for the STA spawn round-trip.
 */
export function codeDeclaresMacro(code: string, macroName: string): boolean {
  const escaped = macroName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^\\s*(?:Public\\s+|Private\\s+)?Sub\\s+${escaped}\\s*\\(`,
    "im"
  );
  return re.test(code);
}

function mapNapiError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  return new Error(String(err));
}

async function handleRunVba(args: z.infer<typeof runVbaSchema>): Promise<ToolResult> {
  if (!codeDeclaresMacro(args.code, args.macroName)) {
    return failWith(
      `VbaMacroNotFound: code does not declare Sub ${args.macroName}(...)`,
      "excel",
      { macroName: args.macroName }
    );
  }

  if (!nativeExcel) {
    return failWith(
      "VbaBridgeUnavailable: the native VBA bridge is not loaded. " +
        "This MCP tool is Windows-only and requires the addon's vba_bridge module " +
        "(present in v1.5.0+ builds).",
      "excel"
    );
  }

  // AccessVBOM preflight: cheap registry read; surfaces a clean remediation
  // hint before we spawn Excel.exe for the common "user has not run the CLI" case.
  //
  // Why not redundant with the crate's COM-level 0x800AC472 detection
  // (Opus Round 1 P2-5): the bridge crate maps the HRESULT inside
  // `excel::vba_module_add`, but ONLY after a successful session spawn
  // (Excel.exe starts + STA worker init, ~200-500ms). Pre-spawning the
  // preflight avoids that cost AND the R3 zombie-process risk (an STA
  // worker that started but never released its IDispatch cleanly).
  // The preflight is therefore a structural defense layer, not duplicate
  // work — ADR-015 §7 R3 + §3.5 confirm this is the intended layering.
  const status = nativeExcel.excelCheckAccessVbom?.();
  if (status && !status.trusted) {
    const code = status.lockedByPolicy ? "VbaAccessLockedByPolicy" : "VbaAccessNotTrusted";
    return failWith(
      `${code}: HKCU AccessVBOM not trusted (scope=${status.scope}, lockedByPolicy=${status.lockedByPolicy})`,
      "excel",
      { scope: status.scope }
    );
  }

  let trustedDir: string;
  try {
    trustedDir = getTrustedDir();
  } catch (err) {
    return failWith(err, "excel");
  }

  // Unique filename per call so concurrent invocations + stale files don't collide.
  const stampNs = process.hrtime.bigint().toString();
  const workbookPath = join(trustedDir, `dt_vba_${stampNs}.xlsm`);

  let sessionId: number | undefined;
  try {
    sessionId = nativeExcel.excelSessionSpawn?.();
    if (sessionId === undefined) {
      return failWith(
        "VbaBridgeUnavailable: excelSessionSpawn is not exported by the loaded native addon",
        "excel"
      );
    }

    nativeExcel.excelSetVisible?.(sessionId, args.visible);
    nativeExcel.excelWorkbookAddNew?.(sessionId);
    nativeExcel.excelVbaModuleAdd?.(sessionId, args.macroName, args.code);

    // 52 = xlOpenXMLWorkbookMacroEnabled (.xlsm). The napi shim rejects any
    // other value with `VbaUnsupportedFileFormat` per Phase 3 contract.
    nativeExcel.excelWorkbookSaveAs?.(sessionId, workbookPath, 52);

    nativeExcel.excelMacroRun?.(sessionId, args.macroName);

    try {
      nativeExcel.excelWorkbookClose?.(sessionId, false);
    } catch {
      // Non-fatal: session drop releases everything.
    }

    return ok({
      ok: true,
      action: "run_vba",
      macroName: args.macroName,
      workbookPath,
      visible: args.visible,
      hints: {
        verifyDelivery: {
          status: "delivered",
          reason: "application_run_returned_ok",
          channel: "excel_com_application_run",
        },
      },
    });
  } catch (err) {
    return failWith(mapNapiError(err), "excel", { macroName: args.macroName });
  } finally {
    if (sessionId !== undefined && nativeExcel.excelSessionClose) {
      try {
        nativeExcel.excelSessionClose(sessionId);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}

async function handleCheckAccessVbom(): Promise<ToolResult> {
  if (!nativeExcel || !nativeExcel.excelCheckAccessVbom) {
    return failWith(
      "VbaBridgeUnavailable: the native VBA bridge is not loaded (Windows-only, v1.5.0+ build required)",
      "excel"
    );
  }

  try {
    const status: NativeExcelAccessVbomStatus = nativeExcel.excelCheckAccessVbom();
    const suggest = !status.trusted
      ? status.lockedByPolicy
        ? [
            "HKLM group policy forces AccessVBOM=0. Contact your IT department.",
          ]
        : [
            "Run `node scripts/enable-access-vbom.mjs` to set HKCU AccessVBOM=1, VBAWarnings=1, and register the managed Trusted Location.",
            "Close any running Excel.exe before retrying — Excel reads these values at process start.",
          ]
      : undefined;

    return ok({
      ok: true,
      action: "check_access_vbom",
      trusted: status.trusted,
      lockedByPolicy: status.lockedByPolicy,
      scope: status.scope,
      suggest,
    });
  } catch (err) {
    return failWith(mapNapiError(err), "excel");
  }
}

export const excelHandler = async (args: ExcelArgs): Promise<ToolResult> => {
  // ADR-018 Phase 2a — strict per-action gate (see §2.5.2). The registered wire
  // schema is the flat `flattenUnionToObjectSchema` output; re-parse against the
  // real (include-injected) union here.
  const parsed = parseActionArgsOrFail<ExcelArgs>(excelUnionWithInclude, args, "excel");
  if (!parsed.ok) return parsed.result;
  const a = parsed.value;
  switch (a.action) {
    case "run_vba":
      return handleRunVba(a);
    case "check_access_vbom":
      return handleCheckAccessVbom();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `excel` is wrapped via `makeCommitWrapper` (lease-less commit variant —
 * `leaseValidator` omitted; the tool addresses Excel.Application via COM,
 * not via a UI lease 4-tuple). `windowTitleKey` is also omitted because
 * the headless Excel session has no user-visible window title (it could
 * be `"Microsoft Excel"` if `visible:true`, but the tool semantically
 * targets the COM object, not a UIA window — `withRichNarration` falls
 * through to `withPostState` only).
 *
 * Module-scope export so `run_macro` (`TOOL_REGISTRY.excel` in `macro.ts`)
 * shares the same wrapped instance (PR #112 shared registration handler
 * pattern, strip risk prevention).
 */
// ADR-018 Phase 2a — `excelUnionWithInclude` (include-injected union) feeds BOTH
// the flat wire schema AND the in-handler `parseActionArgsOrFail` strict gate.
const excelUnionWithInclude = withEnvelopeIncludeForUnion(excelSchema);
export const excelRegistrationSchema = flattenUnionToObjectSchema(excelUnionWithInclude);

export const excelRegistrationHandler = makeCommitWrapper(
  withRichNarration(
    "excel",
    excelHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
    {},
  ) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "excel",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用
  },
);

export function registerExcelTools(server: McpServer): void {
  server.registerTool(
    "excel",
    {
      description: buildDesc({
        purpose:
          "Author and run VBA macros against Excel via COM late binding (ADR-015). " +
          "Headline differentiator against Claude for Excel which writes formulas but cannot run VBA.",
        details:
          "action='run_vba' authors a Sub in a fresh workbook, saves into the managed " +
          "Trusted Location (%LOCALAPPDATA%\\desktop-touch-mcp\\trusted-vba), and " +
          "Application.Run the macro. Requires HKCU AccessVBOM=1 + VBAWarnings=1 + a " +
          "registered Trusted Location (all configured by `node scripts/enable-access-vbom.mjs`). " +
          "Trust setup: Excel must restart after the CLI runs (values cached at process start). " +
          "action='check_access_vbom' is a read-only preflight returning " +
          "{trusted, lockedByPolicy, scope}.",
        prefer:
          "Run check_access_vbom first when a workflow depends on macro execution; the " +
          "remediation hint pre-empts an opaque HRESULT 0x800a03ec failure inside run_vba.",
        caveats:
          "macroName MUST appear as `Sub <name>(...)` in `code` (else VbaMacroNotFound). " +
          "VBA Editor UI is structurally bypassed — no UIA tree walk needed. " +
          "Excel COM is STA: each call serialises through the bridge's worker thread, " +
          "so long-running macros block subsequent excel() calls on the same MCP server.",
        examples: [
          "excel({action:'check_access_vbom'}) → {trusted:true, scope:'hkcu'}",
          "excel({action:'run_vba', code:'Sub DesktopTouchAdHoc()\\n  Range(\"A1\").Value = \"Hello\"\\nEnd Sub'}) → {ok:true, workbookPath:'...\\\\trusted-vba\\\\dt_vba_<ts>.xlsm'}",
          "excel({action:'run_vba', code:'Sub Demo()\\n  MsgBox \"hi\"\\nEnd Sub', macroName:'Demo', visible:true}) → demo recording path",
        ],
      }),
      inputSchema: excelRegistrationSchema,
    },
    excelRegistrationHandler as (args: Record<string, unknown>) => Promise<ToolResult>
  );
}
