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

// Write HKCU AccessVBOM=1 via `reg add`. Returns true on success.
function writeHkcuDword(value) {
  const result = spawnSync(
    "reg",
    [
      "add",
      KEY_HKCU,
      "/v",
      VALUE_NAME,
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
      `Failed to write ${KEY_HKCU}\\${VALUE_NAME} = ${value}. \n` +
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
      `enable-access-vbom — set HKCU AccessVBOM=1 for Excel ${OFFICE_VERSION_KEY}\n` +
        `\n` +
        `Usage: node scripts/enable-access-vbom.mjs [--check-only]\n` +
        `\n` +
        `  --check-only   print the current HKCU + HKLM state and exit 0\n` +
        `  -h / --help    show this help`,
    );
    exit(0);
  }

  const checkOnly = argv.includes("--check-only");

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

  if (checkOnly) {
    if (hkcuBefore === 1 || hklm === 1) {
      logInfo("AccessVBOM is trusted. The `excel` MCP tool will work.");
      exit(0);
    }
    logInfo(
      "AccessVBOM is NOT trusted. Re-run without --check-only to enable HKCU=1.",
    );
    exit(0);
  }

  if (hkcuBefore === 1) {
    logInfo("HKCU AccessVBOM is already 1. No change needed.");
    exit(0);
  }

  const ok = writeHkcuDword(1);
  if (!ok) exit(1);

  const hkcuAfter = readDword(KEY_HKCU, VALUE_NAME);
  if (hkcuAfter !== 1) {
    logErr(
      "VbaAccessNotTrusted",
      `Post-write read returned ${
        hkcuAfter === null ? "(not set)" : hkcuAfter
      }, expected 1. \n` +
        `  Check whether group policy is reverting the value, or run this script as Administrator.`,
    );
    exit(1);
  }

  logInfo(`HKCU AccessVBOM set to 1.`);

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
