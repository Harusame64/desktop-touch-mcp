#!/usr/bin/env node
// Full build pipeline: Rust native addon → TypeScript → stub-tool-catalog.
// Usage: node scripts/build-all.mjs [--debug] [--skip-check]

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const debug = args.includes("--debug");
const skipCheck = args.includes("--skip-check");

let failed = false;

function run(label, cmd, args, opts = {}) {
  console.log(`\n── ${label} ──`);
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: ROOT,
    shell: true,
    ...opts,
  });
  if (r.status !== 0) {
    console.error(`[FAIL] ${label} (exit ${r.status})`);
    failed = true;
  } else {
    console.log(`[PASS] ${label}`);
  }
  return r.status === 0;
}

// 1. Rust native addon
run(
  debug ? "Rust build (debug)" : "Rust build (release)",
  process.execPath,
  [join(ROOT, "scripts", "build-rs.mjs"), debug ? "--debug" : "--release"],
);

// 2. TypeScript
run("TypeScript build", "npx.cmd", ["tsc"]);

// 3. Stub-tool-catalog
run("Generate stub-tool-catalog", "node", [
  join(ROOT, "scripts", "generate-stub-tool-catalog.mjs"),
]);

if (!skipCheck) {
  run("Stub-catalog check (git diff)", "git", ["diff", "--exit-code", "src/stub-tool-catalog.ts"]);
}

console.log(failed ? "\n❌ Build pipeline FAILED" : "\n✅ Build pipeline PASSED");
process.exit(failed ? 1 : 0);
