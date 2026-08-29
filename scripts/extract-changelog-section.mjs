#!/usr/bin/env node
/**
 * extract-changelog-section.mjs — print one release's CHANGELOG entry.
 *
 * The GitHub release body used to be a fixed stub pointing at CHANGELOG.md,
 * so every "release notes" link landed on a page that said nothing about the
 * release. This lifts the matching section out of CHANGELOG.md so the release
 * page carries its own notes.
 *
 * Usage:
 *   node scripts/extract-changelog-section.mjs 1.16.0
 *   node scripts/extract-changelog-section.mjs v1.16.0    # leading v is fine
 *
 * Prints the section body (without its own heading) to stdout.
 * Exit codes:
 *   0 — section found and printed
 *   1 — bad usage, missing CHANGELOG, or no section for that version
 *
 * A missing section is an error rather than a silent empty body: shipping a
 * release page with no notes is the thing this script exists to prevent.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const raw = process.argv[2];
if (!raw) {
  console.error("usage: node scripts/extract-changelog-section.mjs <version>");
  process.exit(1);
}

const version = raw.replace(/^v/, "").trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`not a version: ${raw}`);
  process.exit(1);
}

let text;
try {
  text = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
} catch (err) {
  console.error(`cannot read CHANGELOG.md: ${err.message}`);
  process.exit(1);
}

const lines = text.split(/\r?\n/);

// Section heading looks like: ## [1.16.0] - 2026-08-29 — title
// Deliberately lenient on the boundary: a malformed heading BELOW the match
// would otherwise be skipped, silently swallowing every entry down to the next
// well-formed one into this release body.
const isHeading = (line) => /^\s{0,3}#{2}\s*\[/.test(line);
const startsThisVersion = (line) =>
  line.startsWith(`## [${version}]`);

const start = lines.findIndex(startsThisVersion);
if (start === -1) {
  console.error(`no CHANGELOG section for ${version}`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (isHeading(lines[i])) {
    end = i;
    break;
  }
}

// Drop the heading itself, then trim blank lines at both ends. The heading is
// omitted because the release page already shows the tag as its title.
const body = lines.slice(start + 1, end).join("\n").replace(/^\s+|\s+$/g, "");

if (!body) {
  console.error(`CHANGELOG section for ${version} is empty`);
  process.exit(1);
}

process.stdout.write(body + "\n");
