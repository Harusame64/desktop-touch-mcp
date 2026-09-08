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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  stripSessionLines,
  stripSessionLinesInFile,
  SESSION_LINE_RE,
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
    // Comment lines are dropped first. The hook explains itself by naming the
    // script in prose, so asserting on the whole file passed even when the
    // invocation was repointed at a path that does not exist — the pin matched
    // the explanation instead of the code (caught by mutation, not by reading).
    const hook = readFileSync(join(repoRoot, ".githooks", "commit-msg"), "utf8");
    const code = hook.replace(/^[ \t]*#.*$/gm, "");
    expect(code).toContain("scripts/strip-session-line.mjs");
  });

  it("pre-push carries the POSIX spelling of the same pattern", () => {
    // Two engines, one rule. `pre-push` cannot import this module (it must run
    // without node), so the ERE is duplicated there on purpose. This pins the
    // copy to the original STRING; the describe below is what checks the two
    // actually accept the same lines, which a matching string does not prove.
    const hook = readFileSync(join(repoRoot, ".githooks", "pre-push"), "utf8");
    expect(hook).toContain(`session_pattern='${SESSION_LINE_ERE}'`);
  });
});

describe("the two patterns accept the same lines, not merely the same string", () => {
  /**
   * The ERE cannot be executed as a JS regex, and asserting that `pre-push`
   * contains the same string only proves the two were edited together — drop
   * the URL alternative from BOTH and that assertion still passes. So the ERE
   * is translated here and run against the same corpus as the module's own
   * regex. The translation is the only thing taken on trust, and it is three
   * substitutions long.
   */
  function ereToRegExp(ere: string): RegExp {
    return new RegExp(
      ere
        // POSIX `[[:space:]]` inside a bracket expression, as ERE spells it.
        .replace(/\[\[:space:\]\]/g, "[ \t\v\f\r]")
        // ERE has no non-capturing groups; JS treats `(` the same way here.
        .replace(/\(/g, "(?:")
    );
  }

  const corpus = [
    TRAILER,
    `  ${TRAILER}`,
    `\t${TRAILER}`,
    `- ${TRAILER}`,
    `  * ${TRAILER}`,
    "https://claude.ai/code/session_x",
    "- https://claude.ai/code/session_x",
    COAUTHOR,
    "fix: a subject line",
    "prose mentioning Claude-Session: mid-sentence",
    "See https://claude.ai/code/session_x for context",
    "https://claude.ai/code/artifacts/abc",
    "https://claudeXai/code/session_x",
    "",
    "   ",
    "-not-a-list-marker Claude-Session: x",
  ];

  it("classifies every corpus line identically", () => {
    const ere = ereToRegExp(SESSION_LINE_ERE);
    for (const line of corpus) {
      expect(ere.test(line), `ERE vs JS disagree on: ${JSON.stringify(line)}`).toBe(
        SESSION_LINE_RE.test(line)
      );
    }
  });

  it("the corpus is not vacuous — it contains lines of both kinds", () => {
    const matched = corpus.filter((l) => SESSION_LINE_RE.test(l));
    expect(matched.length).toBeGreaterThan(3);
    expect(corpus.length - matched.length).toBeGreaterThan(3);
  });
});

describe("the file rewrite and the CLI — the part that can actually eat a message", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "strip-session-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, bytes: Buffer | string) => {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    return p;
  };

  it("rewrites the file and reports the count", () => {
    const p = write("msg", `fix: a\n\n${COAUTHOR}\n${TRAILER}\n`);
    expect(stripSessionLinesInFile(p)).toBe(1);
    expect(readFileSync(p, "utf8")).toBe(`fix: a\n\n${COAUTHOR}\n`);
  });

  it("does not touch the file at all when there is nothing to remove", () => {
    const p = write("msg", `feat: z\n\n${COAUTHOR}\n`);
    const before = statSync(p).mtimeMs;
    expect(stripSessionLinesInFile(p)).toBe(0);
    expect(statSync(p).mtimeMs).toBe(before);
  });

  it("preserves a message that is not UTF-8, byte for byte", () => {
    // A CP932 subject (テスト) — what an editor writes on a Japanese Windows
    // box, or `git config i18n.commitEncoding`. Read as utf8 this came back as
    // U+FFFD for every non-ASCII byte, and the hook reported success.
    const cp932Subject = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]);
    const p = write(
      "msg",
      Buffer.concat([
        Buffer.from("fix: "),
        cp932Subject,
        Buffer.from(`\n\n${TRAILER}\n`),
      ])
    );
    expect(stripSessionLinesInFile(p)).toBe(1);
    const after = readFileSync(p);
    expect(after.equals(Buffer.concat([Buffer.from("fix: "), cp932Subject, Buffer.from("\n")]))).toBe(true);
  });

  it("leaves no temp file behind", () => {
    const p = write("msg", `fix: a\n\n${TRAILER}\n`);
    stripSessionLinesInFile(p);
    expect(readdirSync(dir)).toEqual(["msg"]);
  });

  const cli = (args: string[]) => {
    const script = join(repoRoot, "scripts", "strip-session-line.mjs");
    const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    return { status: r.status, stderr: r.stderr };
  };

  it("announces what it removed — silence would hide half the design", () => {
    const p = write("msg", `fix: a\n\n${TRAILER}\n`);
    const { status, stderr } = cli([p]);
    expect(status).toBe(0);
    expect(stderr).toContain("removed 1 Claude-Session line");
    expect(readFileSync(p, "utf8")).toBe("fix: a\n");
  });

  it("says nothing when it removed nothing", () => {
    const p = write("msg", `feat: z\n\n${COAUTHOR}\n`);
    const { status, stderr } = cli([p]);
    expect(status).toBe(0);
    expect(stderr).toBe("");
  });

  it("pluralises the count", () => {
    const p = write("msg", `fix: a\n\n${TRAILER}\n${TRAILER}\n`);
    expect(cli([p]).stderr).toContain("removed 2 Claude-Session lines");
  });

  it("exits 2 with a usage line when given no file", () => {
    const { status, stderr } = cli([]);
    expect(status).toBe(2);
    expect(stderr).toContain("usage:");
  });

  it("exits 0 and says so when the file cannot be read — a commit must not become impossible", () => {
    const { status, stderr } = cli([join(dir, "does-not-exist")]);
    expect(status).toBe(0);
    expect(stderr).toContain("message left as written");
  });
});
