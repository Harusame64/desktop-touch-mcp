/**
 * strip-session-line.test.ts — the commit-msg hook's removal, exercised.
 *
 * Repo policy is that no Claude session id lands in the public repo, and
 * `.githooks/commit-msg` enforces it by REWRITING the commit message. A rewrite
 * that can empty a message is not something to verify by reading it: the first
 * version of that hook did the removal in `sed -E "/$pattern/d"`, whose address
 * ended at the `/` inside `https:/`. `sed` died inside a pipeline where `||`
 * could not see it, `awk` read the empty stream, and a zero-byte file was moved
 * over the message — a hook that destroyed the thing it was added to protect.
 *
 * The removal now lives in `scripts/strip-session-line.mjs` so these cases can
 * call it directly. The first case below is the one that version fails.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  stripSessionLines,
  SESSION_LINE_ERE,
} from "../../scripts/strip-session-line.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const TRAILER = "Claude-Session: https://claude.ai/code/session_012A8NB4QjLTAPaKtNcNxaBe";
const COAUTHOR = "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>";

describe("stripSessionLines — what comes out", () => {
  it("removes the trailer and keeps everything else, including Co-Authored-By", () => {
    const { text, removed } = stripSessionLines(
      `fix(x): something\n\nBody line.\n\n${COAUTHOR}\n${TRAILER}\n`
    );
    expect(removed).toBe(1);
    expect(text).toBe(`fix(x): something\n\nBody line.\n\n${COAUTHOR}\n`);
  });

  it("does not empty a message that has other content — the sed bug", () => {
    // The shipped-and-reverted `sed` version returned "" here while still
    // reporting a successful removal. Anything that empties this input is the
    // same defect wearing different clothes.
    const { text, removed } = stripSessionLines(`feat: keep me\n\n${TRAILER}\n`);
    expect(removed).toBe(1);
    expect(text).toBe("feat: keep me\n");
    expect(text.length).toBeGreaterThan(0);
  });

  it("removes a bare session URL on its own line", () => {
    const { text, removed } = stripSessionLines(
      "chore: y\n\nhttps://claude.ai/code/session_012A8NB4QjLTAPaKtNcNxaBe\n"
    );
    expect(removed).toBe(1);
    expect(text).toBe("chore: y\n");
  });

  it("leaves a clean message byte-identical and reports nothing removed", () => {
    const input = `feat: z\n\n${COAUTHOR}\n`;
    const { text, removed } = stripSessionLines(input);
    expect(removed).toBe(0);
    expect(text).toBe(input);
  });

  it("removes every occurrence, not just the first", () => {
    const { text, removed } = stripSessionLines(
      `fix: w\n\nClaude-Session: https://claude.ai/code/session_AAA\n${COAUTHOR}\nClaude-Session: https://claude.ai/code/session_BBB\n`
    );
    expect(removed).toBe(2);
    expect(text).toBe(`fix: w\n\n${COAUTHOR}\n`);
  });

  it("removes an indented trailer", () => {
    const { removed } = stripSessionLines(`fix: v\n\n   ${TRAILER}\n`);
    expect(removed).toBe(1);
  });

  it("handles CRLF input and returns LF", () => {
    const { text, removed } = stripSessionLines(
      `fix: crlf\r\n\r\n${COAUTHOR}\r\n${TRAILER}\r\n`
    );
    expect(removed).toBe(1);
    expect(text).toBe(`fix: crlf\n\n${COAUTHOR}\n`);
    expect(text).not.toContain("\r");
  });

  it("empties a message that was ONLY a trailer — git then refuses the commit", () => {
    const { text, removed } = stripSessionLines(`${TRAILER}\n`);
    expect(removed).toBe(1);
    expect(text).toBe("");
  });

  it("keeps a mid-sentence mention of the trailer", () => {
    // This repo's own commit messages discuss the trailer in prose. The pattern
    // is anchored for this reason; an unanchored one would eat the sentence.
    const input = "docs: explain\n\nThe harness appends a Claude-Session: trailer to every commit.\n";
    const { text, removed } = stripSessionLines(input);
    expect(removed).toBe(0);
    expect(text).toBe(input);
  });

  it("keeps a claude.ai URL that is not a session link", () => {
    const input = "docs: link\n\nhttps://claude.ai/code/artifacts/abc\n";
    expect(stripSessionLines(input).removed).toBe(0);
  });

  it("drops only the blank lines the removal stranded at the end", () => {
    const { text } = stripSessionLines(`fix: b\n\nbody\n\n${TRAILER}\n\n\n`);
    expect(text).toBe("fix: b\n\nbody\n");
  });
});

describe("the hook and the pre-push net stay in step", () => {
  it("commit-msg still calls the script — a shim that stops calling it is silent otherwise", () => {
    const hook = readFileSync(join(repoRoot, ".githooks", "commit-msg"), "utf8");
    expect(hook).toContain("scripts/strip-session-line.mjs");
  });

  it("pre-push carries the POSIX spelling of the same pattern", () => {
    // Two engines, one rule. `pre-push` cannot import this module (it must run
    // without node), so the ERE is duplicated there on purpose — this is the
    // check that keeps the copy from drifting away from the original.
    const hook = readFileSync(join(repoRoot, ".githooks", "pre-push"), "utf8");
    expect(hook).toContain(`session_pattern='${SESSION_LINE_ERE}'`);
  });

  it("the two patterns agree on every line these tests care about", () => {
    // The ERE is a string here, so it cannot be executed as one. What can be
    // checked is that its JS translation — the module's own regex — classifies
    // the corpus the way the ERE reads. A change to either that breaks the
    // correspondence has to break one of these expectations.
    const eatenByBoth = [TRAILER, `  ${TRAILER}`, "https://claude.ai/code/session_x"];
    const keptByBoth = [
      COAUTHOR,
      "fix: a subject line",
      "prose mentioning Claude-Session: mid-sentence",
      "https://claude.ai/code/artifacts/abc",
      "",
      "   ",
    ];
    for (const line of eatenByBoth) {
      expect(stripSessionLines(`subject\n\n${line}\n`).removed, line).toBe(1);
    }
    for (const line of keptByBoth) {
      expect(stripSessionLines(`subject\n\n${line}\n`).removed, line).toBe(0);
    }
  });
});
