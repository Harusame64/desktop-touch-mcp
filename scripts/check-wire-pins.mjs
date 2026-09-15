#!/usr/bin/env node
/**
 * Runs the wire-schema pins, and fails unless VITEST COLLECTED EXACTLY THOSE FILES.
 *
 * Two holes were measured in the two earlier versions of this gate, and the second is why the
 * check is on the run's own report rather than on the filesystem:
 *
 *   1. `vitest run <paths>` treats the paths as FILTERS — a filter matching nothing is ignored. A
 *      run naming a non-existent file plus one real one executed 14 tests and exited 0, so
 *      deleting a pin halved the gate silently (gate 2 round 7).
 *   2. Checking `existsSync` alone does not fix it. A pin moved out of `tests/unit/` — or renamed
 *      to `*.spec.ts`, with `PINS` updated in the same commit, which is the natural accompanying
 *      edit — still exists, but the `unit` project's `include` no longer matches it: vitest runs
 *      the other pin and exits 0 (measured with an integration-project path, gate 2 round 8).
 *
 * So the gate asks the run what it collected and compares that to the list. "The file is on disk"
 * and "the runner ran it" are two claims, and only the second one is the gate.
 */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PINS = [
  "tests/unit/the-wire-spelling-of-a-widened-field.test.ts",
  "tests/unit/flatten-union-schema.test.ts",
];

// Named first, because "not on disk" deserves its own sentence rather than arriving as "collected
// 1 of 2". Resolved against ROOT, not the cwd: every sibling gate does that, and a cwd-relative
// check run from `scripts/` accused both pins of being deleted (gate 2 round 8).
const missing = PINS.filter((p) => !existsSync(join(ROOT, p)));
if (missing.length > 0) {
  console.error(
    "check:wire-pins: these pin files are named by the gate and are not on disk:\n" +
      missing.map((p) => `  - ${p}`).join("\n") +
      "\n\nIf a pin was deliberately renamed or removed, update the list in" +
      "\nscripts/check-wire-pins.mjs in the same commit — and say why in the message.",
  );
  process.exit(1);
}

const report = join(tmpdir(), `wire-pins-${process.pid}.json`);
// NO SHELL, and vitest by its JS entry point rather than through `npx`. With `shell: true` on
// Windows, `cmd.exe` splits an unquoted `--outputFile=<path>` at the first space — and a Windows
// temp directory routinely contains one (`C:\Users\Jane Doe\AppData\Local\Temp`). vitest would
// then write its report somewhere else and this gate would fail READING THE JSON while both pin
// files passed, on the platform this project ships (gate 1, 2026-09-15). None of the local gates
// could see that: they all run on macOS.
const res = spawnSync(
  process.execPath,
  [
    join(ROOT, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--project=unit",
    "--no-file-parallelism",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${report}`,
    ...PINS,
  ],
  { stdio: "inherit", cwd: ROOT },
);

if (res.error) {
  // Without this the job exits 1 with no output at all, under a step named after wire pins.
  console.error(
    `check:wire-pins: could not run vitest: ${res.error.message}\n` +
      "(vitest is spawned by its JS entry point, so this means node could not start it —\n" +
      "check that `npm ci` ran.)",
  );
  process.exit(1);
}

let collected = [];
try {
  const json = JSON.parse(await readFile(report, "utf8"));
  collected = (json.testResults ?? [])
    .map((r) => String(r.name ?? "").replaceAll("\\", "/"))
    .map((n) => (n.includes("/tests/") ? n.slice(n.indexOf("tests/")) : n))
    .sort();
} catch (e) {
  console.error(`check:wire-pins: could not read vitest's JSON report at ${report}: ${e.message}`);
  process.exit(1);
} finally {
  await rm(report, { force: true });
}

const expected = [...PINS].sort();
if (collected.join("\n") !== expected.join("\n")) {
  console.error(
    "check:wire-pins: vitest did not collect the files this gate names.\n" +
      `  expected: ${expected.join(", ")}\n` +
      `  collected: ${collected.join(", ") || "(none)"}\n\n` +
      "A path that exists but is not matched by the `unit` project's `include` is silently\n" +
      "dropped by vitest, which then exits 0 with part of the gate never executed.",
  );
  process.exit(1);
}

process.exit(res.status ?? 1);
