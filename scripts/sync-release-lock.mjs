#!/usr/bin/env node
// internal #348 — regenerate release/package-lock.json from the root lock, so the release zips ship the
// exact versions the root lock runs (every package, not only the five direct ones). Run it after any
// change to the root lock or to release/package.json; tests/unit/release-lock-matches-the-root.test.ts
// fails until it has been run.
//
// How: start from a copy of the root lock, renamed to release/package.json's root, and let
// `npm install --package-lock-only` prune it to what release/package.json needs. npm keeps a locked
// version wherever it satisfies the ranges, so nothing is resolved anew; nothing is installed.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REL = join(ROOT, "release");
const pkg = JSON.parse(readFileSync(join(REL, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
lock.name = pkg.name;
delete lock.version;
lock.packages[""] = { name: pkg.name, dependencies: pkg.dependencies };
// Pruned in a scratch directory, and copied over release/ only once npm succeeded: a failed run must not
// leave the unpruned root lock in release/ (PR codex on #940).
const work = mkdtempSync(join(tmpdir(), "dtmcp-sync-release-lock-"));
try {
  copyFileSync(join(REL, "package.json"), join(work, "package.json"));
  writeFileSync(join(work, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  // Windows' npm is npm.cmd, which execFileSync runs only through a shell (PR codex on #940).
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: work,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  copyFileSync(join(work, "package-lock.json"), join(REL, "package-lock.json"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log("[sync-release-lock] release/package-lock.json regenerated from the root lock");
