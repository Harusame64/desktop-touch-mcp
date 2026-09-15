#!/usr/bin/env node
/**
 * Runs the wire-schema pins, and FAILS IF EITHER FILE IS MISSING.
 *
 * `vitest run <paths>` treats the paths as FILTERS, not as a required set: a filter matching
 * nothing is ignored. Measured — `vitest run … does-not-exist.test.ts flatten-union-schema.test.ts`
 * runs one file, 14 tests, and exits 0. So renaming or deleting one pin file halved the CI gate
 * silently and `wire-schema-pins` stayed green (gate 2 round 7, internal#106/#662). That is the
 * "a pin nobody executes is not a pin" failure this gate exists to close, one level up.
 *
 * The existence check is the whole point of this wrapper; everything else is a passthrough.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PINS = [
  "tests/unit/the-wire-spelling-of-a-widened-field.test.ts",
  "tests/unit/flatten-union-schema.test.ts",
];

const missing = PINS.filter((p) => !existsSync(p));
if (missing.length > 0) {
  console.error(
    `check:wire-pins: these pin files are named by the gate and are not on disk:\n` +
      missing.map((p) => `  - ${p}`).join("\n") +
      `\n\nvitest would treat the missing path as a filter that matches nothing, run whatever is` +
      `\nleft, and exit 0. If a pin was deliberately renamed or removed, update the list in` +
      `\nscripts/check-wire-pins.mjs in the same commit — and say why in the message.`,
  );
  process.exit(1);
}

const res = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vitest", "run", "--project=unit", "--no-file-parallelism", ...PINS],
  { stdio: "inherit", shell: process.platform === "win32" },
);
process.exit(res.status ?? 1);
