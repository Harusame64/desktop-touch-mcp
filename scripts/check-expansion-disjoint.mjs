#!/usr/bin/env node
// scripts/check-expansion-disjoint.mjs
//
// Walking skeleton trunk completion enforcement (CLAUDE.md §7 仕組みで対応).
// Local equivalent of `.github/workflows/expansion-pr-guard.yml` — invoked
// via `npm run check:expansion-disjoint` or pre-push hook (opt-in via
// `scripts/install-hooks.mjs`, expansion 着手時 user 判断で 6-guard 編入).
//
// Sub-plan SSOT: docs/adr-010-p1-s6-plan.md §1.1 B + §2.1 + §2.2 (4 path
// bit-equal sync, Round 2 P1-1 fix).

import { execFileSync, execSync } from "node:child_process";

// Round 2 P1 fix (Opus Round 1 P1-1): bit-equal sync with §1.1 B + §2.1
// yaml. Path list 4 件は実 repo 構造と整合 (`Glob` で存在確認済、PR #99 同型
// fact divergence 防止)。
const TRUNK_LOCK_PATHS = [
  "crates/engine-perception/",
  "src/l1_capture/",
  "src/l3_bridge/",
  "src/engine/perception/",
];

function isExpansionPr() {
  // GitHub Actions 経由 (PR title/label) or local commit message から expansion 検出。
  // ローカル運用では HEAD branch 名 or commit message に "expansion" 含有で trigger。
  const headRef = process.env.HEAD_REF || "";
  let commitMsg = "";
  try {
    commitMsg = execSync("git log -1 --pretty=%s", { encoding: "utf8" });
  } catch {
    // ignore — no commits yet
  }
  let branchName = "";
  try {
    branchName = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" });
  } catch {
    // ignore
  }
  return /\bexpansion\b/i.test(headRef) ||
    /\bexpansion\b/i.test(commitMsg) ||
    /\bexpansion\b/i.test(branchName);
}

if (!isExpansionPr()) {
  console.log("[check-expansion-disjoint] Not an expansion branch — skip.");
  process.exit(0);
}

const baseRef = process.env.BASE_REF || "origin/main";
// CodeQL alert #110 (`js/indirect-command-line-injection`) fix:
// validate the env-supplied ref against a strict pattern + use
// `execFileSync` (no shell) for defense in depth. Prior code passed
// `BASE_REF` into a `${...}` template literal handed to `execSync`,
// allowing a hostile env var (e.g. `; rm -rf / ;`) to inject extra
// shell commands. The validation alone is sufficient against the
// known injection vector; combining with `execFileSync` removes the
// shell layer entirely so future template-literal additions in this
// command can't reintroduce the same class of bug.
const REF_PATTERN = /^[A-Za-z0-9/_.\-^~@{}]+$/;
if (!REF_PATTERN.test(baseRef)) {
  console.error(
    `[check-expansion-disjoint] invalid BASE_REF (must match ${REF_PATTERN}): ${JSON.stringify(baseRef)}`,
  );
  process.exit(2);
}
let diff = [];
try {
  diff = execFileSync("git", ["diff", "--name-only", `${baseRef}...HEAD`], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
} catch (err) {
  console.error(`[check-expansion-disjoint] git diff failed: ${err.message}`);
  process.exit(2);
}

const violations = diff.filter((path) =>
  TRUNK_LOCK_PATHS.some((p) => path.startsWith(p)),
);

if (violations.length > 0) {
  console.error("[check-expansion-disjoint] Expansion PR modified trunk lock layer:");
  for (const v of violations) console.error(`  ${v}`);
  console.error("");
  console.error("Walking skeleton trunk-completion contract requires expansion to touch only L5 wrapper / TS interface / tests / docs.");
  console.error("Either narrow scope to L5 wrapper layer, or remove the 'expansion' marker if this PR is properly an engine-perception change.");
  process.exit(1);
}

console.log(`[check-expansion-disjoint] OK — expansion PR untouched ${TRUNK_LOCK_PATHS.length} trunk lock paths.`);
