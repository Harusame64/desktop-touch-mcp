#!/usr/bin/env node
// ADR-015 §3.7 — one-shot CLI that sets HKCU
// Software\Microsoft\Office\16.0\Excel\Security\AccessVBOM = 1
// so the `excel` MCP tool can access Excel.Application.VBE.VBProjects
// via COM late binding.
//
// Why a CLI (not an MCP tool action)?
//
// Round 1 of ADR-015 proposed an MCP tool action `excel.enable_access_vbom`.
// Opus Round 1 P2-1 + R8 concluded that any MCP client should not be able
// to silently lower Office trust for the user. The CLI runs in an explicit
// user context where execution intent is unambiguous (the user typed the
// command on a terminal); MCP tool calls do not carry that guarantee.
//
// The matching MCP tool action `excel({action: "check_access_vbom"})` is
// read-only and exposes a `suggest` field pointing at THIS script when
// AccessVBOM is 0.
//
// Behaviour:
//
//  - Reads HKCU AccessVBOM. If it's already 1, exit 0 with a confirmation.
//  - Reads HKLM (the group-policy override). If HKLM forces 0, exit 1
//    with a typed error message and a "contact your IT department" hint.
//  - Otherwise, writes HKCU AccessVBOM=1 (DWORD) using `reg add`.
//    The script does NOT touch HKLM under any circumstance.
//  - Reports whether Excel is currently running (so the caller knows
//    that the setting takes effect only after Excel restart).

import { execSync, spawnSync } from "node:child_process";
import { argv, platform, exit } from "node:process";

const OFFICE_VERSION_KEY = "16.0"; // Office 365 / 2019 / 2021 / 2024
const KEY_HKCU = `HKCU\\Software\\Microsoft\\Office\\${OFFICE_VERSION_KEY}\\Excel\\Security`;
const KEY_HKLM = `HKLM\\Software\\Microsoft\\Office\\${OFFICE_VERSION_KEY}\\Excel\\Security`;
const VALUE_NAME = "AccessVBOM";

// VBAWarnings (Trust Center > Macro Settings):
//   1 = Enable all VBA macros (least restrictive)
//   2 = Disable VBA macros with notification (Excel default)
//   3 = Disable except digitally signed
//   4 = Disable all without notification
//
// AccessVBOM alone allows our COM bridge to AUTHOR a VBA module
// (Excel.Application.VBE.VBProjects.Add). RUNNING the module via
// Application.Run requires VBAWarnings = 1 — otherwise Excel returns
// HRESULT 0x800a03ec ("マクロを実行できません. このブックでマクロが
// 使用できないか、またはすべてのマクロが無効になっている可能性があります。").
//
// The CLI sets both together by default (--enable-macros). The user
// can keep VBAWarnings at the Excel default and skip macro execution
// by passing --skip-macros, in which case only AccessVBOM is touched.
const VALUE_NAME_VBA_WARNINGS = "VBAWarnings";

function logInfo(msg) {
  console.log(`[enable-access-vbom] ${msg}`);
}

function logWarn(msg) {
  console.warn(`[enable-access-vbom] WARN: ${msg}`);
}

function logErr(code, msg) {
  console.error(`[enable-access-vbom] ${code}: ${msg}`);
}

// Read a REG_DWORD value via `reg query`. Returns null if the key/value
// does not exist or the value is non-numeric. Returns the integer
// otherwise. Uses spawnSync (no shell) for safe argument passing.
function readDword(keyPath, valueName) {
  const result = spawnSync("reg", ["query", keyPath, "/v", valueName], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  // Sample output line:
  //   "    AccessVBOM    REG_DWORD    0x1"
  const lines = result.stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(valueName)) continue;
    const m = trimmed.match(/REG_DWORD\s+0x([0-9a-fA-F]+)/);
    if (m) return parseInt(m[1], 16);
  }
  return null;
}

// Write HKCU `<valueName>` = `value` (DWORD) via `reg add`. Returns
// true on success. Used for both AccessVBOM and VBAWarnings.
function writeHkcuDword(valueName, value) {
  const result = spawnSync(
    "reg",
    [
      "add",
      KEY_HKCU,
      "/v",
      valueName,
      "/t",
      "REG_DWORD",
      "/d",
      String(value),
      "/f",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    logErr(
      "VbaAccessNotTrusted",
      `Failed to write ${KEY_HKCU}\\${valueName} = ${value}. \n` +
        `  stderr: ${result.stderr || "(empty)"}\n` +
        `  Try running this script from an elevated terminal if the failure mentions access denied.`,
    );
    return false;
  }
  return true;
}

// Is Excel running right now? The setting only takes effect after Excel
// restarts (Excel reads the value at process startup and caches it).
function isExcelRunning() {
  try {
    const out = execSync("tasklist /FI \"IMAGENAME eq EXCEL.EXE\" /FO CSV /NH", {
      encoding: "utf8",
    });
    return out.toLowerCase().includes("excel.exe");
  } catch {
    return false; // tasklist failure is non-fatal
  }
}

function main() {
  if (platform !== "win32") {
    logErr(
      "VbaAccessNotTrusted",
      "This script is Windows-only. Run it on the machine where Excel + the MCP server are installed.",
    );
    exit(1);
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      `enable-access-vbom — set HKCU AccessVBOM=1 (and optionally VBAWarnings=1) for Excel ${OFFICE_VERSION_KEY}\n` +
        `\n` +
        `Usage: node scripts/enable-access-vbom.mjs [flags]\n` +
        `\n` +
        `  --check-only    print the current HKCU + HKLM state and exit 0\n` +
        `  --skip-macros   set ONLY AccessVBOM=1; leave VBAWarnings at the\n` +
        `                  Excel default (macros disabled-with-notification).\n` +
        `                  Use this if you do not want the bridge to RUN macros\n` +
        `                  automatically; the bridge will still AUTHOR them.\n` +
        `  -h / --help     show this help\n` +
        `\n` +
        `By default both AccessVBOM=1 AND VBAWarnings=1 are set so the\n` +
        `\`excel\` MCP tool can author AND run VBA macros end-to-end.`,
    );
    exit(0);
  }

  const checkOnly = argv.includes("--check-only");
  const skipMacros = argv.includes("--skip-macros");

  const hklm = readDword(KEY_HKLM, VALUE_NAME);
  if (hklm === 0) {
    logErr(
      "VbaAccessLockedByPolicy",
      `Group policy forces HKLM\\...\\AccessVBOM = 0. No MCP-side workaround exists; \n` +
        `  contact your IT department to allow programmatic access to the VBA project object model.`,
    );
    exit(1);
  }

  const hkcuBefore = readDword(KEY_HKCU, VALUE_NAME);
  logInfo(
    `Current HKCU AccessVBOM: ${
      hkcuBefore === null ? "(not set)" : hkcuBefore
    }${hklm === 1 ? " (HKLM also forces 1)" : ""}`,
  );

  // Also inspect VBAWarnings (macro-execution Trust Center setting).
  const vbaWarningsHkcu = readDword(KEY_HKCU, VALUE_NAME_VBA_WARNINGS);
  const vbaWarningsHklm = readDword(KEY_HKLM, VALUE_NAME_VBA_WARNINGS);
  logInfo(
    `Current HKCU VBAWarnings: ${
      vbaWarningsHkcu === null ? "(not set, Excel default = 2 = disable with notification)" : vbaWarningsHkcu
    }${vbaWarningsHklm !== null ? ` (HKLM also sets ${vbaWarningsHklm})` : ""}`,
  );

  if (checkOnly) {
    const accessOk = hkcuBefore === 1 || hklm === 1;
    const macrosOk = vbaWarningsHkcu === 1 || vbaWarningsHklm === 1;
    if (accessOk && macrosOk) {
      logInfo(
        "AccessVBOM AND VBAWarnings are both trusted. The `excel` MCP tool can author AND run macros.",
      );
    } else if (accessOk) {
      logInfo(
        "AccessVBOM is trusted but VBAWarnings is NOT 1. The `excel` MCP tool can AUTHOR macros but will fail to RUN them.\n" +
          "  Re-run without --check-only (default sets both).",
      );
    } else {
      logInfo(
        "Neither AccessVBOM nor VBAWarnings is trusted. Re-run without --check-only to enable both (or with --skip-macros to only enable authoring).",
      );
    }
    exit(0);
  }

  // ── AccessVBOM ─────────────────────────────────────────────────────
  if (hkcuBefore === 1) {
    logInfo("HKCU AccessVBOM is already 1. No change needed.");
  } else {
    const ok = writeHkcuDword(VALUE_NAME, 1);
    if (!ok) exit(1);

    const hkcuAfter = readDword(KEY_HKCU, VALUE_NAME);
    if (hkcuAfter !== 1) {
      logErr(
        "VbaAccessNotTrusted",
        `Post-write read returned ${
          hkcuAfter === null ? "(not set)" : hkcuAfter
        }, expected 1.`,
      );
      exit(1);
    }
    logInfo(`HKCU AccessVBOM set to 1.`);
  }

  // ── VBAWarnings (skipped under --skip-macros) ─────────────────────
  if (skipMacros) {
    logInfo(
      "--skip-macros given: leaving HKCU VBAWarnings at the current value. " +
        "Macro authoring will work; Application.Run will FAIL with HRESULT 0x800a03ec.",
    );
  } else {
    if (vbaWarningsHkcu === 1) {
      logInfo("HKCU VBAWarnings is already 1. No change needed.");
    } else {
      const ok = writeHkcuDword(VALUE_NAME_VBA_WARNINGS, 1);
      if (!ok) exit(1);
      const after = readDword(KEY_HKCU, VALUE_NAME_VBA_WARNINGS);
      if (after !== 1) {
        logErr(
          "VbaAccessNotTrusted",
          `Post-write read of VBAWarnings returned ${
            after === null ? "(not set)" : after
          }, expected 1.`,
        );
        exit(1);
      }
      logInfo(
        `HKCU VBAWarnings set to 1 (Enable all macros). ` +
          `The bridge can now run macros it authors via Application.Run.`,
      );
    }
  }

  if (isExcelRunning()) {
    logWarn(
      "Excel is currently running. The new AccessVBOM value takes effect only AFTER Excel restarts. \n" +
        "  Close all Excel windows before running the `excel` MCP tool, or it will continue to use the cached \n" +
        "  (old) trust state and return VbaAccessNotTrusted.",
    );
  }

  logInfo("Done. The `excel` MCP tool can now access Excel.Application.VBE.VBProjects.");
  exit(0);
}

main();
