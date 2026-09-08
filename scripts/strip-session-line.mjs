#!/usr/bin/env node
// Remove Claude session ids from a commit message.
//
// Repo policy (user decision, 2026-09-08): no Claude session IDs in the public
// repo. The Claude Code harness appends a `Claude-Session:` trailer on its own,
// so the line is removed rather than refused — see `.githooks/commit-msg`, the
// two-line shim that calls this.
//
// The removal lives here, in JavaScript, rather than in the hook's shell,
// because a rewrite that can silently empty a commit message has to be
// testable. It was not, once: the first hook used `sed -E "/$pattern/d"`, whose
// address ended at the `/` in `https:/`. `sed` died mid-pipeline where `||`
// could not see it, `awk` read the empty stream, and a zero-byte file was moved
// over the message. `tests/unit/strip-session-line.test.ts` calls the function
// below directly, so that version fails on the first case instead of shipping.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Lines that carry a session id: the trailer the harness writes, and a bare
 * session URL on its own line (the shape used in PR descriptions).
 *
 * Anchored at line start, with leading whitespace allowed, so prose that
 * MENTIONS the trailer mid-sentence survives — this repo's own commit messages
 * discuss it. `.githooks/pre-push` carries the POSIX ERE spelling of this same
 * pattern; `patternsAgree` below is what keeps the two from drifting.
 */
export const SESSION_LINE_RE = /^[ \t]*(?:Claude-Session:|https:\/\/claude\.ai\/code\/session_)/;

/** The POSIX ERE that `.githooks/pre-push` must be using for the same job. */
export const SESSION_LINE_ERE = "^[[:space:]]*(Claude-Session:|https://claude[.]ai/code/session_)";

/**
 * @param {string} message
 * @returns {{ text: string, removed: number }} the message without its session
 *   lines, and how many were taken out. Trailing blank lines the removal leaves
 *   behind go too — git's own cleanup has already run by the time the hook is
 *   called, so nothing else will tidy them.
 */
export function stripSessionLines(message) {
  const lines = message.split("\n").map((line) => line.replace(/\r$/, ""));
  const kept = [];
  let removed = 0;

  for (const line of lines) {
    if (SESSION_LINE_RE.test(line)) {
      removed++;
      continue;
    }
    kept.push(line);
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();

  return { text: kept.length === 0 ? "" : `${kept.join("\n")}\n`, removed };
}

/**
 * Rewrite the message file in place. Returns how many lines were removed; 0
 * means the file was not touched at all.
 *
 * @param {string} file
 * @returns {number}
 */
export function stripSessionLinesInFile(file) {
  const original = readFileSync(file, "utf8");
  const { text, removed } = stripSessionLines(original);
  if (removed === 0) return 0;
  writeFileSync(file, text, "utf8");
  return removed;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const file = process.argv[2];
  if (file === undefined) {
    process.stderr.write("usage: strip-session-line.mjs <commit-msg-file>\n");
    process.exit(2);
  }
  // A commit must not be lost because this could not run. The message is
  // reported, the commit proceeds, and `.githooks/pre-push` still refuses the
  // push if a session id survived to a commit.
  let removed = 0;
  try {
    removed = stripSessionLinesInFile(file);
  } catch (err) {
    process.stderr.write(
      `[commit-msg] could not strip session lines (${err.message}) — message left as written\n`
    );
    process.exit(0);
  }
  if (removed > 0) {
    process.stderr.write(
      `[commit-msg] removed ${removed} Claude-Session line${removed === 1 ? "" : "s"} ` +
        "(repo policy: no session IDs in the public repo)\n"
    );
  }
}
