/**
 * strip-session-line.test.ts — the two hooks that keep session ids out of this
 * repo, exercised rather than read.
 *
 * `.githooks/commit-msg` enforces the policy by REWRITING the commit message. A
 * rewrite that can empty a message is not something to verify by reading it:
 * the first version of that hook did the removal in `sed -E "/$pattern/d"`,
 * whose address ended at the `/` inside `https:/`. `sed` died inside a pipeline
 * where `||` could not see it, `awk` read the empty stream, and a zero-byte
 * file was moved over the message — a hook that destroyed the thing it was
 * added to protect. The second case below is that exact input.
 *
 * `.githooks/pre-push` is the enforcing half and cannot be imported, so it is
 * driven as a subprocess against a throwaway repository built here.
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

  it("removes a session URL behind a list marker — that is not prose", () => {
    expect(stripSessionLines(`fix: a\n\n- https://claude.ai/code/session_x\n`).removed).toBe(1);
    expect(stripSessionLines(`fix: a\n\n  * ${TRAILER}\n`).removed).toBe(1);
  });

  it("leaves a clean message byte-identical and reports nothing removed", () => {
    const input = `feat: z\n\n${COAUTHOR}\n`;
    const { text, removed } = stripSessionLines(input);
    expect(removed).toBe(0);
    expect(text).toBe(input);
  });

  it("returns odd line endings and a missing final newline exactly as they came", () => {
    // "byte-identical" has to mean every message, not the ones that happen to
    // end in a newline. Rebuilding the text appended one to both of these.
    for (const input of ["a\rb\r", "no trailing newline", "", "\n\n"]) {
      const { text, removed } = stripSessionLines(input);
      expect(removed, JSON.stringify(input)).toBe(0);
      expect(text, JSON.stringify(input)).toBe(input);
    }
  });

  it("removes every occurrence, not just the first", () => {
    const { text, removed } = stripSessionLines(
      `fix: w\n\nClaude-Session: https://claude.ai/code/session_AAA\n${COAUTHOR}\nClaude-Session: https://claude.ai/code/session_BBB\n`
    );
    expect(removed).toBe(2);
    expect(text).toBe(`fix: w\n\n${COAUTHOR}\n`);
  });

  it("removes an indented trailer", () => {
    expect(stripSessionLines(`fix: v\n\n   ${TRAILER}\n`).removed).toBe(1);
  });

  it("keeps CRLF as CRLF — the message is returned in the bytes it arrived in", () => {
    // An earlier version stripped every CR, silently converting a CRLF-authored
    // message to LF whenever anything was removed. That contradicted the
    // byte-for-byte promise the file-level function makes.
    const { text, removed } = stripSessionLines(
      `fix: crlf\r\n\r\n${COAUTHOR}\r\n${TRAILER}\r\n`
    );
    expect(removed).toBe(1);
    expect(text).toBe(`fix: crlf\r\n\r\n${COAUTHOR}\r\n`);
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
    expect(stripSessionLines("docs: link\n\nhttps://claude.ai/code/artifacts/abc\n").removed).toBe(0);
  });

  it("drops only the blank lines the removal stranded at the end", () => {
    const { text } = stripSessionLines(`fix: b\n\nbody\n\n${TRAILER}\n\n\n`);
    expect(text).toBe("fix: b\n\nbody\n");
  });

  it("keeps a trailing 0xA0 line — 'blank' is the pattern's idea of blank, not Unicode's", () => {
    // On a latin1 byte string 0xA0 is NBSP to `String.trim()` and an ordinary
    // byte to the hook. Trimming deleted it, which is a byte this function
    // promises to keep.
    const { text } = stripSessionLines(`fix: c\n\n \n${TRAILER}\n`);
    expect(text).toBe("fix: c\n\n \n");
  });
});

describe("the hook and the pre-push net stay in step", () => {
  it("commit-msg invokes the script by its real path", () => {
    // Comment lines are dropped first: the hook explains itself by naming the
    // script in prose, so asserting on the whole file passed even when the
    // invocation was repointed elsewhere. The path is then matched to its end,
    // because `…strip-session-line.mjs.bak` contains the same substring.
    const hook = readFileSync(join(repoRoot, ".githooks", "commit-msg"), "utf8");
    const code = hook.replace(/^[ \t]*#.*$/gm, "");
    expect(code).toMatch(/scripts\/strip-session-line\.mjs"/);
  });

  it("pre-push carries the POSIX spelling of the same pattern", () => {
    // `pre-push` cannot import the module — it must run without node — so the
    // ERE is duplicated there on purpose. This pins the copy to the original
    // STRING; the describe below is what checks the two accept the same lines,
    // which a matching string does not prove.
    const hook = readFileSync(join(repoRoot, ".githooks", "pre-push"), "utf8");
    expect(hook).toContain(`session_pattern='${SESSION_LINE_ERE}'`);
  });
});

describe("the two patterns accept the same lines, not merely the same string", () => {
  /**
   * Translate the POSIX ERE into a JS RegExp so it can actually be run against
   * the same corpus as the module's own pattern.
   *
   * It THROWS on anything it does not know how to translate. A translator that
   * quietly produced a regex matching nothing would make this whole block pass
   * vacuously the moment someone put `[[:alnum:]]` in the ERE — the failure
   * mode is silent and looks like success, which is the shape this file exists
   * to catch.
   */
  function ereToRegExp(ere: string): RegExp {
    // `[[:space:]]` is line-oriented here, so `\n` is deliberately absent: grep
    // never sees one inside a line.
    let js = ere.replace(/\[\[:space:\]\]/g, "[ \\t\\v\\f\\r]");
    const unknownClass = js.match(/\[\[:[a-z]+:\]\]/);
    if (unknownClass) {
      throw new Error(`ereToRegExp cannot translate ${unknownClass[0]}`);
    }
    if (/\\[(){}|]/.test(js)) {
      throw new Error("ereToRegExp cannot translate an escaped ERE metacharacter");
    }
    // ERE has no non-capturing groups; every `(` here is a plain group.
    js = js.replace(/\(/g, "(?:");
    return new RegExp(js);
  }

  const corpus = [
    TRAILER,
    `  ${TRAILER}`,
    `\t${TRAILER}`,
    `\r${TRAILER}`,
    `\v${TRAILER}`,
    `\f${TRAILER}`,
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
    expect(matched.length).toBeGreaterThan(5);
    expect(corpus.length - matched.length).toBeGreaterThan(5);
  });

  it("the translator refuses what it cannot translate, rather than matching nothing", () => {
    expect(() => ereToRegExp("^[[:alnum:]]+$")).toThrow(/cannot translate/);
    expect(() => ereToRegExp("^a\\(b\\)$")).toThrow(/cannot translate/);
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
    const cp932 = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]);
    const p = write(
      "msg",
      Buffer.concat([Buffer.from("fix: "), cp932, Buffer.from(`\n\n${TRAILER}\n`)])
    );
    expect(stripSessionLinesInFile(p)).toBe(1);
    const want = Buffer.concat([Buffer.from("fix: "), cp932, Buffer.from("\n")]);
    expect(readFileSync(p).equals(want)).toBe(true);
  });

  it("preserves a trailing high byte that String.trim() would have eaten", () => {
    const p = write(
      "msg",
      Buffer.concat([Buffer.from("fix: c\n\n"), Buffer.from([0xa0]), Buffer.from(`\n${TRAILER}\n`)])
    );
    expect(stripSessionLinesInFile(p)).toBe(1);
    const want = Buffer.concat([Buffer.from("fix: c\n\n"), Buffer.from([0xa0]), Buffer.from("\n")]);
    expect(readFileSync(p).equals(want)).toBe(true);
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
    // Reachable by running the script directly. `.githooks/commit-msg` always
    // passes the file and swallows a non-zero exit on purpose, so this code is
    // the CLI's contract rather than the hook's.
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

/**
 * `.githooks/pre-push` is the half that refuses, and it was pinned only by a
 * `toContain` on its text: deleting its entire leak block, or flipping the
 * comparison, left every other test in this file green. It is `sh`, so it is
 * driven as a subprocess — against a repository built here, not this one, so
 * the cases do not depend on what happens to be in our history.
 */
describe("pre-push refuses what it should", () => {
  const sh = spawnSync("sh", ["-c", "exit 0"]);
  const hasSh = sh.status === 0;

  it("sh is available, so the cases below actually ran", () => {
    // Every case here is `skipIf(!hasSh)`, so without this one the whole
    // enforcing half could vanish into a green run and no one would be told —
    // "the check did not run" read as "the check passed", which is the same
    // defect the hook itself was fixed for twice. A missing `sh` reports ENOENT
    // through `error` with `status: null`, not an exception, so the reason is
    // included here rather than left as `false !== true`.
    //
    // CI does not execute this suite at all — `.github/workflows/ci.yml` leaves
    // TypeScript tests to the local pre-merge run — so this is the only place
    // these cases happen.
    expect(hasSh, `sh unusable: error=${sh.error?.message ?? "none"} status=${sh.status}`).toBe(
      true
    );
  });

  let repo: string;
  let clean = "";
  let leaking = "";

  const git = (args: string[], cwd = repo) =>
    spawnSync("git", args, { cwd, encoding: "utf8" });

  beforeEach(() => {
    if (!hasSh) return;
    repo = mkdtempSync(join(tmpdir(), "pre-push-"));
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "T"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "a.txt"), "a");
    git(["add", "-A"]);
    git(["commit", "-q", "--no-verify", "-m", "chore: clean commit"]);
    clean = git(["rev-parse", "HEAD"]).stdout.trim();
    writeFileSync(join(repo, "a.txt"), "b");
    git(["add", "-A"]);
    git(["commit", "-q", "--no-verify", "-m", `chore: leaking commit\n\n${TRAILER}`]);
    leaking = git(["rev-parse", "HEAD"]).stdout.trim();
  });

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  const push = (stdin: string, env: NodeJS.ProcessEnv = {}) =>
    spawnSync("sh", [join(repoRoot, ".githooks", "pre-push"), "origin", "https://example/x.git"], {
      cwd: repo,
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

  it.skipIf(!hasSh)("refuses a range containing a session id", () => {
    const r = push(`refs/heads/x ${leaking} refs/heads/x ${clean}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("carry a Claude session id");
  });

  it.skipIf(!hasSh)("allows a range that carries none", () => {
    const r = push(`refs/heads/x ${clean} refs/heads/x ${clean}\n`);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it.skipIf(!hasSh)("refuses a direct push to main", () => {
    const r = push(`refs/heads/main ${clean} refs/heads/main ${clean}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("direct push to main is forbidden");
  });

  it.skipIf(!hasSh)("lets the release flow through with the documented bypass", () => {
    const r = push(`refs/heads/main ${clean} refs/heads/main ${clean}\n`, {
      DESKTOP_TOUCH_ALLOW_MAIN_PUSH: "1",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("bypassing main protection");
  });

  it.skipIf(!hasSh)("allows a branch deletion", () => {
    const zero = "0".repeat(40);
    expect(push(`refs/heads/main ${zero} refs/heads/main ${clean}\n`).status).toBe(0);
  });

  it.skipIf(!hasSh)("refuses rather than passing when the range cannot be read", () => {
    // A remote_oid this clone does not have. In one pipeline with `grep -c`
    // this returned 0 and the push went through unchecked.
    const r = push(`refs/heads/x ${clean} refs/heads/x ${"d".repeat(40)}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not inspect");
  });

  it.skipIf(!hasSh)("refuses when grep produces no count at all", () => {
    // `grep -c` exits 1 both when it finds nothing (fine) and when its input
    // redirect failed (not fine) — the temp file vanishing under a tmp reaper,
    // say. The count is what separates them: a successful `grep -c` always
    // prints a number. Simulated with a grep that prints nothing and exits 1,
    // which is exactly what the shell reports in that case.
    const bin = mkdtempSync(join(tmpdir(), "pre-push-bin-"));
    try {
      writeFileSync(join(bin, "grep"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const r = push(`refs/heads/x ${clean} refs/heads/x ${clean}\n`, {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("could not read back");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasSh)("lets a new branch through when its commits are already on THIS remote", () => {
    // The other half of the same rule, and the half three rounds of edits kept
    // breaking: what is already published on the remote being pushed to must be
    // excluded, or every new branch is refused over history the remote already
    // has. The case above pins the false-pass direction; without this one, a
    // hook that excludes nothing at all passes the whole suite.
    const origin = mkdtempSync(join(tmpdir(), "pre-push-origin-"));
    try {
      spawnSync("git", ["init", "-q", "--bare", origin], { encoding: "utf8" });
      git(["remote", "add", "origin", origin]);
      git(["push", "-q", "origin", "main"]);
      git(["fetch", "-q", "origin"]);
      expect(git(["rev-parse", "--verify", "-q", "refs/remotes/origin/main"]).status).toBe(0);

      // A new branch whose tip is the leaking commit — but that commit is on
      // origin/main already, so this push adds nothing and must be allowed.
      const r = push(`refs/heads/topic ${leaking} refs/heads/topic ${"0".repeat(40)}\n`);
      expect(r.stderr).not.toContain("carry a Claude session id");
      expect(r.status).toBe(0);
    } finally {
      rmSync(origin, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasSh)("does not trust tracking refs when pushes go somewhere else than fetches", () => {
    // `remote.<name>.pushurl` sends pushes to one repository while
    // `refs/remotes/<name>/*` follows the fetch url. Counting those refs as
    // published then reads a PRIVATE repository's history as already public —
    // measured: a new branch carrying a session id went through.
    const priv = mkdtempSync(join(tmpdir(), "pre-push-priv-"));
    const pub = mkdtempSync(join(tmpdir(), "pre-push-pub-"));
    try {
      spawnSync("git", ["init", "-q", "--bare", priv], { encoding: "utf8" });
      spawnSync("git", ["init", "-q", "--bare", pub], { encoding: "utf8" });
      git(["remote", "add", "origin", priv]);
      git(["push", "-q", "origin", "main"]);
      git(["fetch", "-q", "origin"]);
      // Only now does the remote start pushing elsewhere.
      git(["config", "remote.origin.pushurl", pub]);
      expect(git(["merge-base", "--is-ancestor", leaking, "refs/remotes/origin/main"]).status).toBe(0);

      const r = push(`refs/heads/topic ${leaking} refs/heads/topic ${"0".repeat(40)}\n`);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("carry a Claude session id");
    } finally {
      rmSync(priv, { recursive: true, force: true });
      rmSync(pub, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasSh)("does not treat another remote's history as published on this one", () => {
    // A new branch has no counterpart on the remote, so the hook excludes what
    // is already published — and it must mean published ON THIS REMOTE. With a
    // bare `--remotes`, a commit that exists only on a fork you have fetched is
    // excluded from the range and its trailer lands on the public repo.
    const fork = mkdtempSync(join(tmpdir(), "pre-push-fork-"));
    try {
      spawnSync("git", ["init", "-q", "--bare", fork], { encoding: "utf8" });
      git(["remote", "add", "origin", "https://example/x.git"]);
      git(["remote", "add", "fork", fork]);
      git(["push", "-q", "fork", "main"]);
      git(["fetch", "-q", "fork"]);
      // The leaking commit is now reachable from refs/remotes/fork/main and
      // from nothing under refs/remotes/origin/.
      expect(git(["rev-parse", "--verify", "-q", "refs/remotes/fork/main"]).status).toBe(0);

      const r = push(`refs/heads/x ${leaking} refs/heads/x ${"0".repeat(40)}\n`);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("carry a Claude session id");
    } finally {
      rmSync(fork, { recursive: true, force: true });
    }
  });
});
