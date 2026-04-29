#!/usr/bin/env node
// ADR-007 §6 P4 main acceptance: zero `koffi.X` call sites repository-wide.
//
// `koffi` was the FFI library every Win32 binding flowed through before
// ADR-007 — by the end of P4 every binding has migrated to `windows-rs`
// via the napi-rs native addon (`src/win32/*.rs`), and the `koffi` npm
// dependency itself is removed. This script guards against accidental
// reintroduction by failing CI on any `koffi.X` API call site or any
// `koffi` entry in `package.json`'s dependencies.
//
// The grep pattern targets API identifiers only (`load`, `func`,
// `struct`, `array`, `proto`, `pointer`, `register`, `unregister`,
// `sizeof`) so historical mentions of "koffi" in prose / commit
// messages / commented-out signatures do not trigger false positives.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// API identifier whitelist — keep in sync with the koffi public surface.
const PATTERN = String.raw`\bkoffi\.(load|func|struct|array|proto|pointer|register|unregister|sizeof)\b`;

let failed = false;

// 1. No koffi.X API call sites in tracked source files.
let grepOutput = "";
try {
  grepOutput = execSync(
    `git grep -nE "${PATTERN}" -- '*.ts' '*.mjs' '*.js' '*.json'`,
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  ).trim();
} catch (err) {
  // git grep exits 1 when there are no matches — that is the success case.
  if (/** @type {{ status?: number }} */ (err).status !== 1) {
    console.error("[check-no-koffi] git grep failed:", err);
    process.exit(2);
  }
  grepOutput = "";
}

if (grepOutput) {
  failed = true;
  console.error("\n[check-no-koffi] FAIL — koffi.X API call sites still present:\n");
  for (const line of grepOutput.split("\n")) console.error("  " + line);
  console.error(
    "\nADR-007 §6 P4 acceptance requires zero koffi.X call sites. Migrate the\n" +
    "remaining bindings to src/win32/*.rs (windows-rs) and route through nativeWin32.\n",
  );
}

// 2. `koffi` must not appear in package.json dependencies.
const pkgPath = join(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const present =
  (pkg.dependencies && Object.prototype.hasOwnProperty.call(pkg.dependencies, "koffi")) ||
  (pkg.devDependencies && Object.prototype.hasOwnProperty.call(pkg.devDependencies, "koffi"));
if (present) {
  failed = true;
  console.error("\n[check-no-koffi] FAIL — `koffi` is still listed in package.json.");
  console.error("  Run: npm uninstall koffi\n");
}

if (failed) {
  process.exit(1);
}

console.log("[check-no-koffi] OK — repository is koffi-free (ADR-007 §6 P4 acceptance met).");
