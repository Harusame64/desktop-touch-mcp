#!/usr/bin/env node
// Remove Claude session ids from a commit message.
//
// Repo policy (user decision, 2026-09-08): no Claude session IDs in the public
// repo. The Claude Code harness appends a `Claude-Session:` trailer on its own,
// so the line is removed rather than refused — see `.githooks/commit-msg`, the
// shim that calls this.
//
// The removal lives here, in JavaScript, rather than in the hook's shell,
// because a rewrite that can silently empty a commit message has to be
// testable. It was not, once: the first hook used `sed -E "/$pattern/d"`, whose
// address ended at the `/` in `https:/`. `sed` died mid-pipeline where `||`
// could not see it, `awk` read the empty stream, and a zero-byte file was moved
// over the message. `tests/unit/strip-session-line.test.ts` calls the functions
// below directly, so that version fails on the second case instead of shipping.

import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Lines that carry a session id: the trailer the harness writes, and a bare
 * session URL on its own line (the shape used in PR descriptions), optionally
 * behind a list marker — `- https://claude.ai/code/session_x` is not prose and
 * used to survive both nets.
 *
 * All three of Markdown's unordered markers, not two: `+` was missing while `-`
 * and `*` were blocked, so the identical link written `+ https://…/session_x`
 * went through untouched. A list of accepted markers is only as good as its
 * shortest member.
 *
 * Anchored at line start so prose that MENTIONS the trailer mid-sentence
 * survives — this repo's own commit messages discuss it.
 *
 * The whitespace class is `[ \t\v\f\r]`, matching what POSIX `[[:space:]]`
 * means to `grep` and to `awk` on a single line under `LC_ALL=C` — `awk` is what
 * actually scans in `.githooks/pre-push`, and the tests exercise both. It is spelled out rather
 * than written `\s` because `\s` would also take Unicode spaces, which `grep`
 * would not, and the two engines have to agree — `.githooks/pre-push` carries
 * the ERE spelling of this same rule, since it must run without node.
 */
export const SESSION_LINE_RE =
  /^[ \t\v\f\r]*(?:[-*+][ \t\v\f\r]+)?(?:Claude-Session:|https:\/\/claude\.ai\/code\/session_)/;

/** The POSIX ERE that `.githooks/pre-push` must be using for the same job. */
export const SESSION_LINE_ERE =
  "^[[:space:]]*([-*+][[:space:]]+)?(Claude-Session:|https://claude[.]ai/code/session_)";

/** A line with nothing on it. Deliberately the same class as the pattern. */
const BLANK_LINE_RE = /^[ \t\v\f\r]*$/;

/**
 * Every line ending git can hand us. A message written with lone CR — old-Mac
 * endings, or `git commit-tree` fed one — was a SINGLE line to a `\n` split, so
 * the anchored pattern never saw the trailer and the whole hook was a no-op on
 * it. Splitting on all three, with the separators captured so the bytes can be
 * put back exactly as they came, is what closes that.
 */
const LINE_SPLIT_RE = /(\r\n|\n|\r)/;

/**
 * @param {string} message the message as a string of BYTES (latin1) when it
 *   comes from a file — see `stripSessionLinesInFile`. The pattern is pure
 *   ASCII, so byte-wise matching gives the same answer as character-wise
 *   matching for every encoding, and nothing has to be decoded to be preserved.
 * @returns {{ text: string, removed: number }} the message without its session
 *   lines, and how many were taken out. Every surviving byte is kept as it was,
 *   line endings included; only the blank lines the removal strands at the end
 *   go with it.
 */
export function stripSessionLines(message) {
  // [text, sep, text, sep, …, text] — the separators are kept so a CRLF message
  // comes back CRLF and a CR-only one comes back CR-only.
  const parts = message.split(LINE_SPLIT_RE);
  const kept = [];
  let removed = 0;

  // Where the removal happened, and where the surviving content ends — both as
  // positions in the ORIGINAL message. The trailing-blank rule below needs to
  // tell "these blanks are what the removal left behind" from "these blanks are
  // the author's, and the removal happened somewhere above them".
  let lastRemovedLine = -1;
  let lastKeptContentLine = -1;

  for (let i = 0; i < parts.length; i += 2) {
    const line = i / 2;
    const text = parts[i];
    const sep = parts[i + 1] ?? "";
    if (SESSION_LINE_RE.test(text)) {
      removed++;
      lastRemovedLine = line;
      continue;
    }
    if (!BLANK_LINE_RE.test(text)) lastKeptContentLine = line;
    kept.push({ text, sep });
  }

  // Nothing to do means nothing done. Returning the original is what makes "a
  // clean message comes back byte-identical" true for every message rather than
  // only the ones ending in a newline.
  if (removed === 0) return { text: message, removed: 0 };

  // Blank lines stranded at the end by the removal — and ONLY those. The
  // comment and the test beside it always said "stranded", but the loop popped
  // every trailing blank line whatever put it there, so
  // `subject / Claude-Session / body / <blank>` came back without the author's
  // final blank line: content the removal did not strand, in a function whose
  // whole promise is to return the message in the bytes it arrived in. With
  // `commit.cleanup=verbatim` that edit reaches the stored commit.
  //
  // The question is whether the removal is what left these at the end, and the
  // original line numbers answer it: if any content OUTLIVED the last removed
  // line, the blanks after it are the author's and are kept.
  //
  // Tested against the pattern rather than `String.trim()`, which is
  // Unicode-aware: on a latin1 byte string a trailing line holding the single
  // byte 0xA0 counted as blank and was deleted, which is a byte this function
  // promises to keep.
  if (lastRemovedLine > lastKeptContentLine) {
    while (kept.length > 0 && BLANK_LINE_RE.test(kept[kept.length - 1].text)) kept.pop();
  }

  if (kept.length === 0) return { text: "", removed };

  // Nothing is lent an ending here any more.
  //
  // There used to be a rule that gave the last surviving chunk the message's
  // last-seen separator when it had none of its own, written for a CRLF message
  // whose only ending belonged to the line just removed. It fabricated bytes in
  // two shapes instead: the empty chunk that merely says "the message ended with
  // a separator" was lent one, and so was a genuinely unterminated final line —
  // `Claude-Session: x` + newline + `body` came back as `body` + newline, in a
  // function whose whole promise is to return what it was given. With
  // `commit.cleanup=verbatim` those bytes reach the stored commit.
  //
  // Removed rather than narrowed, because no test pinned it: with the rule taken
  // out entirely the suite was still green, and the CRLF case it was written for
  // holds on its own — the chunk carrying `\r\n` survives and keeps its own
  // ending. Both shapes are pinned by cases now.
  return { text: kept.map((k) => k.text + k.sep).join(""), removed };
}

/**
 * Rewrite the message file in place. Returns how many lines were removed; 0
 * means the file was not touched at all.
 *
 * Reads and writes as `latin1`, which maps every byte to one code unit and
 * back: a message written in the OS codepage (`i18n.commitEncoding`, or an
 * editor on a Japanese Windows box) survives byte for byte. Reading it as
 * `utf8` replaced every non-ASCII byte with U+FFFD and reported success.
 *
 * Writes to a sibling and renames, so a failure part-way through leaves the
 * original message intact rather than a truncated one.
 *
 * @param {string} file
 * @returns {number}
 */
export function stripSessionLinesInFile(file) {
  const original = readFileSync(file, "latin1");
  const { text, removed } = stripSessionLines(original);
  if (removed === 0) return 0;

  const tmp = `${file}.strip.${process.pid}`;
  try {
    writeFileSync(tmp, text, "latin1");
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created; its absence is the goal.
    }
    throw err;
  }
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
  // A commit must not be lost because this could not run. The failure is
  // reported, the commit proceeds, and `.githooks/pre-push` still refuses the
  // push if a session id survived into a commit.
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
