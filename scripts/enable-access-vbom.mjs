#!/usr/bin/env node
// ADR-015 §3.7 — one-shot CLI that sets HKCU
// Software\Microsoft\Office\16.0\Excel\Security\AccessVBOM = 1
// so the `excel` MCP tool can access Excel.Application.VBE.VBProjects
// via COM late binding. **Phase 2e** also registers a desktop-touch-managed
// Trusted Location so Application.Run is no longer Trust-Center-gated for
// dynamically-authored workbooks.
//
// Why a CLI (not an MCP tool action)?
//
// Round 1 of ADR-015 proposed an MCP tool action `excel.enable_access_vbom`.
// Opus Round 1 P2-1 + R8 concluded that any MCP client should not be able
// to silently lower Office trust for the user. The CLI runs in an explicit
// user context where execution intent is unambiguous (the user typed the
// command on a terminal); MCP tool calls do not carry that guarantee. The
// same reasoning applies to the Trusted Location addition (Phase 2e).
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
//  - Sets HKCU VBAWarnings=1 unless `--skip-macros` is passed.
//  - Registers `%LOCALAPPDATA%\desktop-touch-mcp\trusted-vba\` as a
//    Trusted Location under HKCU unless `--skip-trusted-location` is
//    passed. Idempotent: a re-run does not duplicate the entry.
//  - Reports whether Excel is currently running (so the caller knows
//    that the setting takes effect only after Excel restart).

import { execSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { argv, env, platform, exit } from "node:process";

const OFFICE_VERSION_KEY = "16.0"; // Office 365 / 2019 / 2021 / 2024
const KEY_HKCU = `HKCU\\Software\\Microsoft\\Office\\${OFFICE_VERSION_KEY}\\Excel\\Security`;
const KEY_HKLM = `HKLM\\Software\\Microsoft\\Office\\${OFFICE_VERSION_KEY}\\Excel\\Security`;
const KEY_HKCU_TRUSTED_LOCATIONS = `${KEY_HKCU}\\Trusted Locations`;
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

// ── Trusted Location helpers (Phase 2e) ──────────────────────────────
//
// Excel keeps user-managed trusted directories under HKCU at
// `Software\Microsoft\Office\<ver>\Excel\Security\Trusted Locations\
// LocationN`. Each LocationN subkey has:
//   - Path              REG_SZ / REG_EXPAND_SZ  — directory path
//   - Description       REG_SZ                  — free text (optional)
//   - AllowSubFolders   REG_DWORD               — 0 or 1
//   - Date              REG_SZ                  — free text date (optional)
//
// HKLM-side `Trusted Locations` keys exist too but require admin to write
// and are governed by group policy; the CLI only touches HKCU (matching
// the §3.7 / R8 design constraint that the bridge cannot escalate trust
// beyond the user's own scope).
//
// The "managed" directory the bridge writes to is
// `%LOCALAPPDATA%\desktop-touch-mcp\trusted-vba`. The Rust integration
// test mirrors this exact path; if you change it here, change it there
// (excel.rs::end_to_end_vba_macro_authoring_and_execution).
const TRUSTED_LOCATION_LEAF = "desktop-touch-mcp\\trusted-vba";

function getDefaultTrustedDir() {
  const root = env.LOCALAPPDATA;
  if (!root) {
    // LOCALAPPDATA should always be set on Windows in normal shells.
    // If it isn't, fall back to USERPROFILE\AppData\Local — this is the
    // canonical layout the OS itself uses.
    if (!env.USERPROFILE) {
      throw new Error(
        "Neither LOCALAPPDATA nor USERPROFILE is set; cannot resolve the Trusted Location root",
      );
    }
    return join(env.USERPROFILE, "AppData", "Local", TRUSTED_LOCATION_LEAF);
  }
  return join(root, TRUSTED_LOCATION_LEAF);
}

// Expand `%VAR%` tokens in a Windows-style path string. Excel's Trust
// Center UI writes Path values as REG_EXPAND_SZ containing literal
// `%LOCALAPPDATA%\desktop-touch-mcp\...` rather than the expanded
// absolute form — `reg query` returns the unexpanded raw bytes for
// REG_EXPAND_SZ values, so direct string comparison against our own
// `getDefaultTrustedDir()` (which returns the expanded absolute path)
// would miss the match and falsely produce a duplicate Location<N>.
// This helper expands the tokens before comparison so the idempotency
// check matches both UI-written and CLI-written entries.
function expandEnvVars(s) {
  return s.replace(/%([^%]+)%/g, (whole, name) => env[name] ?? whole);
}

// Normalise a Windows directory path for the registry value. We want
// backslashes (Excel matches with `\` separators) and a trailing slash
// (Excel's "match this exact directory" semantics depend on the
// `AllowSubFolders` flag; with `AllowSubFolders=1` trailing-slash and
// no-trailing are functionally equivalent in Trust Center matching,
// with `AllowSubFolders=0` only the exact directory matches and Excel
// is strict about the slash. Since the CLI always writes
// `AllowSubFolders=1` for our managed location, trailing-slash
// tolerance is safe; we still canonicalise to trailing-slash to keep
// the registry diff tidy).
function normaliseTrustedPath(p) {
  // Expand env vars first so REG_EXPAND_SZ values match the expanded
  // absolute path we compute via getDefaultTrustedDir().
  let out = expandEnvVars(p).replace(/\//g, sep);
  if (!out.endsWith(sep)) out += sep;
  return out;
}

// Read all current Location<N> subkey names under HKCU Trusted Locations.
// Returns an array like ["Location0", "Location1", ...] (order not
// guaranteed). Returns [] when the parent key does not exist (fresh
// Excel install never opened, etc.).
function listTrustedLocationSubkeys() {
  // `reg query <key>` lists immediate subkeys on stdout when no /v is given.
  const result = spawnSync("reg", ["query", KEY_HKCU_TRUSTED_LOCATIONS], {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  const out = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    // Subkey lines look like:
    //   "HKEY_CURRENT_USER\Software\...\Trusted Locations\Location0"
    const m = trimmed.match(/\\(Location\d+)$/);
    if (m) out.push(m[1]);
  }
  return out;
}

// Read the `Path` value of a single Location<N> subkey. Returns null when
// the value is missing or unreadable. We accept BOTH `REG_SZ` and
// `REG_EXPAND_SZ` — Excel writes either depending on whether the path
// contains environment variables.
function readTrustedLocationPath(locationName) {
  const keyPath = `${KEY_HKCU_TRUSTED_LOCATIONS}\\${locationName}`;
  const result = spawnSync("reg", ["query", keyPath, "/v", "Path"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("Path")) continue;
    const m = trimmed.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/);
    if (m) return m[1];
  }
  return null;
}

// Find the lowest unused Location<N> index. Excel itself assigns slot
// numbers as users add trusted locations through the Trust Center UI; we
// pick the smallest non-conflicting index so the registry stays compact.
function nextAvailableLocationIndex() {
  const taken = new Set(
    listTrustedLocationSubkeys().map((name) => {
      const m = name.match(/Location(\d+)/);
      return m ? parseInt(m[1], 10) : -1;
    }),
  );
  let idx = 0;
  while (taken.has(idx)) idx += 1;
  return idx;
}

// Best-effort rollback: delete an entire Location<N> subkey. Used when
// `ensureTrustedLocation` writes some-but-not-all values and needs to
// undo a partial registration so the next run's idempotency check
// sees the slot as missing rather than half-populated (which would
// cause AllowSubFolders=0 / Date-missing silent-correctness drift).
function deleteTrustedLocationSlot(slotKey) {
  const result = spawnSync("reg", ["delete", slotKey, "/f"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    logWarn(
      `Rollback failed: could not delete ${slotKey} (stderr: ${
        result.stderr || "(empty)"
      }). Manual cleanup required via regedit or 'reg delete'.`,
    );
    return false;
  }
  return true;
}

// Register the desktop-touch-managed Trusted Location. Idempotent — if a
// Location<N> already points at our directory (case-insensitive match,
// trailing-slash tolerant, REG_EXPAND_SZ-aware), the function reports
// success without writing. Returns true on success, false on any write
// failure (with rollback to avoid half-registered slots).
function ensureTrustedLocation(targetDir) {
  const target = normaliseTrustedPath(targetDir).toLowerCase();
  // Idempotency check: does any existing LocationN already match?
  for (const name of listTrustedLocationSubkeys()) {
    const existing = readTrustedLocationPath(name);
    if (!existing) continue;
    const normalised = normaliseTrustedPath(existing).toLowerCase();
    if (normalised === target) {
      logInfo(
        `Trusted Location already registered as ${name}: ${existing}`,
      );
      return true;
    }
  }

  // Not yet registered. Allocate a fresh slot.
  const idx = nextAvailableLocationIndex();
  const slotKey = `${KEY_HKCU_TRUSTED_LOCATIONS}\\Location${idx}`;

  // **Write Path LAST** so partial-failure rollback works without an
  // explicit rollback step: if a non-Path write fails, the next run's
  // idempotency check (which keys off Path) sees the slot as missing
  // and retries cleanly. We ALSO add explicit rollback (delete the
  // partial subkey) for belt-and-suspenders.
  //
  // Reordering rationale (Opus Round 1 P1-3): the original order
  // (Path → Description → AllowSubFolders → Date) left a half-
  // registered slot with Path-only on partial failure; idempotency
  // would then `return true` because Path matched, masking the
  // AllowSubFolders=0 / Date-missing drift.
  const writes = [
    {
      valueName: "AllowSubFolders",
      type: "REG_DWORD",
      data: "1",
    },
    {
      valueName: "Description",
      type: "REG_SZ",
      data: "desktop-touch-mcp managed trusted location (Phase 2e)",
    },
    {
      valueName: "Date",
      type: "REG_SZ",
      data: new Date().toISOString().slice(0, 10),
    },
    // Path MUST be last — see comment above.
    {
      valueName: "Path",
      type: "REG_SZ",
      data: normaliseTrustedPath(targetDir),
    },
  ];
  for (const w of writes) {
    const result = spawnSync(
      "reg",
      [
        "add",
        slotKey,
        "/v",
        w.valueName,
        "/t",
        w.type,
        "/d",
        w.data,
        "/f",
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      logErr(
        "VbaAccessNotTrusted",
        `Failed to register Trusted Location at ${slotKey}\\${w.valueName}. \n` +
          `  stderr: ${result.stderr || "(empty)"}\n` +
          `  Rolling back the partial slot to keep registry idempotency intact.\n` +
          `  Re-run the CLI after fixing the underlying issue.`,
      );
      // Rollback the partial registration.
      deleteTrustedLocationSlot(slotKey);
      return false;
    }
  }

  // Readback verification (Opus Round 1 P2-3): confirm the Path we
  // just wrote matches what we expected, catching concurrent-write
  // races (e.g. Excel Trust Center UI claiming the same Location<N>
  // index between our list+choose+write window).
  const readback = readTrustedLocationPath(`Location${idx}`);
  if (!readback) {
    logErr(
      "VbaAccessNotTrusted",
      `Post-write readback failed for ${slotKey}: Path value missing.\n` +
        `  Likely a concurrent write claimed Location${idx}. Rolling back.`,
    );
    deleteTrustedLocationSlot(slotKey);
    return false;
  }
  const readbackNorm = normaliseTrustedPath(readback).toLowerCase();
  if (readbackNorm !== target) {
    logErr(
      "VbaAccessNotTrusted",
      `Post-write readback mismatch for ${slotKey}: \n` +
        `  expected ${target} \n` +
        `  got      ${readbackNorm}\n` +
        `  Likely a concurrent write claimed Location${idx}. Re-running this CLI \n` +
        `  is safe (it will allocate the next free slot).`,
    );
    return false;
  }

  logInfo(`Trusted Location registered as Location${idx}: ${targetDir}`);
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
      `enable-access-vbom — set HKCU AccessVBOM=1 (and optionally VBAWarnings=1 \n` +
        `+ Trusted Location) for Excel ${OFFICE_VERSION_KEY}\n` +
        `\n` +
        `Usage: node scripts/enable-access-vbom.mjs [flags]\n` +
        `\n` +
        `  --check-only             print the current HKCU + HKLM state and exit 0\n` +
        `  --skip-macros            set ONLY AccessVBOM=1; leave VBAWarnings at the\n` +
        `                           Excel default (macros disabled-with-notification).\n` +
        `                           Use this if you do not want the bridge to RUN macros\n` +
        `                           automatically; the bridge will still AUTHOR them.\n` +
        `  --skip-trusted-location  do NOT register the desktop-touch managed\n` +
        `                           Trusted Location. Application.Run against\n` +
        `                           dynamically-authored workbooks will fail with\n` +
        `                           HRESULT 0x800a03ec (Trust Center policy block) —\n` +
        `                           only use this flag if you intend to point Excel\n` +
        `                           at workbooks in a different Trusted Location you\n` +
        `                           manage yourself.\n` +
        `  -h / --help              show this help\n` +
        `\n` +
        `By default all three are configured (AccessVBOM=1, VBAWarnings=1, and the\n` +
        `Trusted Location at %LOCALAPPDATA%\\desktop-touch-mcp\\trusted-vba) so the\n` +
        `\`excel\` MCP tool can author AND run VBA macros end-to-end.`,
    );
    exit(0);
  }

  const checkOnly = argv.includes("--check-only");
  const skipMacros = argv.includes("--skip-macros");
  const skipTrustedLocation = argv.includes("--skip-trusted-location");

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

  // Trusted Location status check (Phase 2e). Read-only; ensureTrustedLocation
  // is what writes.
  let trustedLocationStatus = "unknown";
  let trustedLocationDir = null;
  try {
    trustedLocationDir = getDefaultTrustedDir();
    const target = normaliseTrustedPath(trustedLocationDir).toLowerCase();
    const found = listTrustedLocationSubkeys().some((name) => {
      const existing = readTrustedLocationPath(name);
      return (
        existing &&
        normaliseTrustedPath(existing).toLowerCase() === target
      );
    });
    trustedLocationStatus = found ? "registered" : "missing";
  } catch (e) {
    trustedLocationStatus = `error: ${e.message}`;
  }
  logInfo(
    `Trusted Location ${trustedLocationDir ?? "(unknown)"}: ${trustedLocationStatus}`,
  );

  if (checkOnly) {
    const accessOk = hkcuBefore === 1 || hklm === 1;
    const macrosOk = vbaWarningsHkcu === 1 || vbaWarningsHklm === 1;
    const trustedOk = trustedLocationStatus === "registered";
    if (accessOk && macrosOk && trustedOk) {
      logInfo(
        "All three trust axes configured (AccessVBOM, VBAWarnings, Trusted Location). The `excel` MCP tool can author AND run macros.",
      );
      exit(0);
    } else {
      const missing = [];
      if (!accessOk) missing.push("AccessVBOM=1");
      if (!macrosOk) missing.push("VBAWarnings=1");
      if (!trustedOk) missing.push("Trusted Location");
      logInfo(
        `Missing trust axes: ${missing.join(", ")}. Re-run without --check-only to configure.`,
      );
      // Exit code 1 so CI / scripted callers can distinguish "trust
      // fully configured" from "trust incomplete" without parsing
      // log lines (Opus Round 1 P2-4).
      exit(1);
    }
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

  // ── Trusted Location (skipped under --skip-trusted-location) ─────
  //
  // Application.Run against a dynamically-authored workbook fails with
  // HRESULT 0x800a03ec under any Trust Center policy when the workbook
  // is in-memory only. The bridge resolves this by SaveAs'ing into a
  // registered Trusted Location before invoking the macro; that
  // Trusted Location is the directory this CLI registers here.
  if (skipTrustedLocation) {
    logInfo(
      "--skip-trusted-location given: NOT registering the managed Trusted Location. " +
        "Application.Run against dynamically-authored workbooks will fail with " +
        "HRESULT 0x800a03ec unless you save them into your own Trusted Location first.",
    );
  } else {
    const targetDir = getDefaultTrustedDir();
    // Create the directory unconditionally. Excel's Trust Center check
    // requires the path to exist; pointing at a non-existent directory
    // silently fails (no error from Excel) when SaveAs writes to it.
    try {
      mkdirSync(targetDir, { recursive: true });
    } catch (e) {
      logErr(
        "VbaAccessNotTrusted",
        `Failed to create Trusted Location directory ${targetDir}: ${e.message}. \n` +
          `  Without the directory present, the bridge cannot save workbooks for macro execution.`,
      );
      exit(1);
    }
    const ok = ensureTrustedLocation(targetDir);
    if (!ok) exit(1);
  }

  if (isExcelRunning()) {
    logWarn(
      "Excel is currently running. The new AccessVBOM / Trusted Location values take effect \n" +
        "  only AFTER Excel restarts. Close all Excel windows before running the `excel` MCP tool, \n" +
        "  or it will continue to use the cached (old) trust state and return VbaAccessNotTrusted \n" +
        "  / VbaMacroExecutionFailed.",
    );
  }

  logInfo(
    "Done. The `excel` MCP tool can now access Excel.Application.VBE.VBProjects " +
      "AND run VBA macros from Trusted-Location workbooks.",
  );
  exit(0);
}

main();
