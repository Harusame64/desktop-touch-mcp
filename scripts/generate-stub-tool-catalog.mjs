#!/usr/bin/env node
/**
 * Writes `src/stub-tool-catalog.ts` from the Windows server's own `tools/list`.
 *
 * The work is in `tests/unit/stub-catalog-is-the-live-tools-list.test.ts`, which registers the
 * real tools on a real McpServer and reads `tools/list` through the SDK client; this script runs
 * that one file with `DESKTOP_TOUCH_WRITE_STUB_CATALOG=1`, so it writes instead of comparing; with
 * `--check` it runs the same file without that flag, so it compares and writes nothing. It
 * runs under vitest because the tool modules are TypeScript importing `.js` specifiers, which
 * vitest resolves and plain node does not. `check:stub-catalog` is `--check`: it used to be this
 * script followed by `git diff`, which a generator that wrote nothing passed (gate 2 on #792).
 *
 * internal #252: this file used to be an 1,100-line parser of the tool modules' source text, which
 * lost or substituted what it could not read and committed the result green (gate 2 on #792).
 *
 * Spawned the way `check-wire-pins.mjs` spawns vitest, for the reasons written there: by its JS
 * entry point with no shell (a shell splits a spaced temp path into stray filters), and the run's
 * own report is checked for having collected exactly this file — a path vitest does not match is
 * ignored, and the run would exit 0 having written nothing.
 */
import { readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stubCatalogEnv } from "./lib/stub-catalog-env.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE = "tests/unit/stub-catalog-is-the-live-tools-list.test.ts";
const CHECK = process.argv.includes("--check");
const report = join(tmpdir(), `stub-catalog-${process.pid}.json`);

const res = spawnSync(
  process.execPath,
  [
    join(ROOT, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--project=unit",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${report}`,
    FILE,
  ],
  {
    stdio: "inherit",
    cwd: ROOT,
    env: stubCatalogEnv(process.env, CHECK),
  },
);

if (res.error) {
  console.error(`generate-stub-tool-catalog: could not run vitest: ${res.error.message} (did \`npm ci\` run?)`);
  process.exit(1);
}

let collected = [];
let passed = 0;
try {
  const json = JSON.parse(await readFile(report, "utf8"));
  collected = (json.testResults ?? []).map((r) => {
    const n = String(r.name ?? "").replaceAll("\\", "/");
    return n.includes("/tests/") ? n.slice(n.indexOf("tests/")) : n;
  });
  passed = json.numPassedTests ?? 0;
} catch (e) {
  console.error(`generate-stub-tool-catalog: could not read vitest's JSON report at ${report}: ${e.message}`);
  process.exit(1);
} finally {
  await rm(report, { force: true });
}

if (collected.length !== 1 || collected[0] !== FILE) {
  console.error(
    `generate-stub-tool-catalog: vitest did not collect ${FILE} (collected: ${collected.join(", ") || "(none)"}), ` +
      "so the catalog was not written.",
  );
  process.exit(1);
}
if (res.status !== 0 || passed === 0) {
  console.error(
    CHECK
      ? "check:stub-catalog: src/stub-tool-catalog.ts is not the server's tools/list — run `npm run generate:stub-catalog`."
      : "generate-stub-tool-catalog: the generating test did not pass, so the catalog may not have been written.",
  );
  process.exit(res.status || 1);
}
console.log(CHECK
  ? "check:stub-catalog: src/stub-tool-catalog.ts is the server's tools/list"
  : "generate-stub-tool-catalog: wrote src/stub-tool-catalog.ts from tools/list");
