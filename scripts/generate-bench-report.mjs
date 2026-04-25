#!/usr/bin/env node
/**
 * generate-bench-report.mjs — Phase 4b-8 vendor matrix report generator.
 *
 * Usage:
 *   node scripts/generate-bench-report.mjs \
 *     --input bench-rx9070xt.json bench-cpu.json [...] \
 *     --output BENCH.md
 *
 * Without --output, prints to stdout.
 */

import { writeFileSync } from "node:fs";

import {
  aggregate,
  formatBenchMarkdown,
  readBenchFile,
} from "../dist/engine/vision-gpu/bench-aggregator.js";

const args = process.argv.slice(2);
const inputs = [];
let output;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--input") {
    while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      inputs.push(args[++i]);
    }
  } else if (args[i] === "--output") {
    output = args[++i];
  }
}

if (inputs.length === 0) {
  console.error("ERROR: at least one --input <bench.json> required");
  console.error("Usage: node scripts/generate-bench-report.mjs --input bench-a.json bench-b.json [--output BENCH.md]");
  process.exit(1);
}

const parsed = inputs.map((source) => {
  try {
    return { result: readBenchFile(source), source };
  } catch (err) {
    console.error(`ERROR: failed to read ${source}: ${err}`);
    process.exit(1);
  }
});

const rows = aggregate(parsed);
const md = formatBenchMarkdown(rows);

if (output) {
  writeFileSync(output, md, "utf8");
  console.log(`[bench-report] wrote ${output} (${rows.length} rows)`);
} else {
  process.stdout.write(md);
}
