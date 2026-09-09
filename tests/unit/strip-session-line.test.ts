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
    // All three markers, asserted as BEHAVIOUR. The corpus block below only
    // checks that the two engines agree with each other, so dropping a marker
    // from both patterns at once would keep it green — which is exactly how `+`
    // stayed missing while `-` and `*` were blocked.
    expect(stripSessionLines(`fix: a\n\n+ https://claude.ai/code/session_x\n`).removed).toBe(1);
    expect(stripSessionLines(`fix: a\n\n  + ${TRAILER}\n`).removed).toBe(1);
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

  it("finds the trailer in a message written with lone CR endings", () => {
    // Splitting on "\n" alone made this ONE line, so the anchored pattern never
    // saw the trailer and the hook was a no-op on it — a session id published
    // by writing the message with old-Mac endings. `git commit-tree` produces
    // exactly this, and the pre-push net missed it too for the same reason.
    const { text, removed } = stripSessionLines(
      "feat: x\rClaude-Session: https://claude.ai/code/session_X\r"
    );
    expect(removed).toBe(1);
    expect(text).toBe("feat: x\r");
  });

  it("keeps each line's own ending when they are mixed", () => {
    const { text, removed } = stripSessionLines(
      `a\r\nb\nClaude-Session: https://claude.ai/code/session_X\n`
    );
    expect(removed).toBe(1);
    expect(text).toBe("a\r\nb\n");
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

  it("keeps a trailing blank the removal did not strand — content outlived the trailer", () => {
    // The trailer is in the MIDDLE, so the blank line at the end is the
    // author's and not something the removal left behind. Popping it edits
    // bytes outside the targeted line, and with `commit.cleanup=verbatim` that
    // reaches the stored commit.
    const { text, removed } = stripSessionLines(`subject\n${TRAILER}\nbody\n\n`);
    expect(removed).toBe(1);
    expect(text).toBe("subject\nbody\n\n");
  });

  it("leaves an unterminated last line unterminated", () => {
    // The surviving line never had an ending, so giving it one is a byte this
    // function invented. With `commit.cleanup=verbatim` that byte reaches the
    // stored commit.
    const { text, removed } = stripSessionLines(`${TRAILER}\nbody`);
    expect(removed).toBe(1);
    expect(text).toBe("body");
  });

  it("keeps CRLF endings when the removed line was the one carrying them", () => {
    // The case the borrowed-separator rule was written for. It has to keep
    // holding without the borrow.
    const { text } = stripSessionLines(`${TRAILER}\r\nbody\r\n`);
    expect(text).toBe("body\r\n");
  });

  it("does not add a newline the author never wrote when the removal is mid-message", () => {
    // No trailing blank here, so this isolates the other half: the empty chunk
    // that says "the message ended with a separator" must not be lent one. It
    // was unreachable while the blank-trim always fired, because the trim took
    // that chunk away first.
    const { text } = stripSessionLines(`subject\n${TRAILER}\nbody\n`);
    expect(text).toBe("subject\nbody\n");
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

  it("the shell hooks are pinned to LF, whatever the checkout's autocrlf says", () => {
    // With `core.autocrlf=true` and no attribute, a Windows checkout writes
    // these with CRLF and the shebang becomes `#!/bin/sh\r`. Some `sh` cannot
    // run that, and `scripts/install-hooks.mjs` points `core.hooksPath` here on
    // every `npm install` — so the hooks would fail before either net ran.
    //
    // NOT reproduced on the machine this was written on: Git Bash executes a
    // CRLF shebang there, and the CRLF hook refused correctly. The attribute is
    // here because the answer is per-machine, not because a break was seen.
    for (const hook of ["pre-push", "commit-msg"]) {
      const r = spawnSync("git", ["check-attr", "eol", "--", `.githooks/${hook}`], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(r.status, `git check-attr unusable: ${r.error?.message ?? r.stderr}`).toBe(0);
      expect(r.stdout.trim(), `.githooks/${hook} is not pinned to LF`).toContain("eol: lf");
    }
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
    `+ ${TRAILER}`,
    "https://claude.ai/code/session_x",
    "- https://claude.ai/code/session_x",
    // `+` is a list marker too. It was the one missing from the class while the
    // other two were blocked, so this exact line went through both nets.
    "+ https://claude.ai/code/session_x",
    COAUTHOR,
    "fix: a subject line",
    "prose mentioning Claude-Session: mid-sentence",
    "See https://claude.ai/code/session_x for context",
    "https://claude.ai/code/artifacts/abc",
    "https://claudeXai/code/session_x",
    "",
    "   ",
    "-not-a-list-marker Claude-Session: x",
    "+not-a-list-marker Claude-Session: x",
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

  it("awk — the engine that actually scans — classifies the corpus the same way", () => {
    // `grep` stopped scanning anything when `pre-push` moved to awk, so the
    // engine deciding in production was the one nothing tested. awk's dynamic
    // regex is not the same implementation as `grep -E`, and mawk has no POSIX
    // bracket classes at all — this is what would say so.
    const probe = spawnSync(
      "awk",
      ["-v", `pat=${SESSION_LINE_ERE}`, "{ print ($0 ~ pat) ? 1 : 0 }"],
      { input: corpus.join("\n"), encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }
    );
    expect(
      probe.status,
      `awk unusable: error=${probe.error?.message ?? "none"} stderr=${probe.stderr}`
    ).toBe(0);

    const fromAwk = probe.stdout.trim().split("\n");
    const fromJs = corpus.map((line) => (SESSION_LINE_RE.test(line) ? "1" : "0"));
    expect(fromAwk.length).toBe(corpus.length);
    for (let i = 0; i < corpus.length; i++) {
      expect(fromAwk[i], `awk vs JS on ${JSON.stringify(corpus[i])}`).toBe(fromJs[i]);
    }
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
 * `.githooks/pre-push` is the half that refuses, and it was once pinned only by
 * a `toContain` on its text: deleting its entire leak block, or flipping the
 * comparison, left every other test in this file green. It is `sh`, so it is
 * driven as a subprocess — against repositories built here, not this one, so
 * the cases do not depend on what happens to be in our history.
 *
 * The rule under test, which four separate leaks came from getting wrong:
 * `refs/remotes/*` is not evidence that a commit is on the push target. Only
 * the destination's own live refs are.
 */
describe("pre-push refuses what it should", () => {
  const sh = spawnSync("sh", ["-c", "exit 0"]);
  const hasSh = sh.status === 0;
  const HOOK = join(repoRoot, ".githooks", "pre-push");
  const ZERO = "0".repeat(40);

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

  /** A working tree plus whatever bare repositories a case needs. */
  function makeWorld() {
    const root = mkdtempSync(join(tmpdir(), "pre-push-"));
    const work = join(root, "work");
    const git = (args: string[], cwd = work) => spawnSync("git", args, { cwd, encoding: "utf8" });

    const bare = (name: string) => {
      const p = join(root, name);
      spawnSync("git", ["init", "-q", "--bare", "-b", "main", p], { encoding: "utf8" });
      return p;
    };

    spawnSync("git", ["init", "-q", "-b", "main", work], { encoding: "utf8" });
    git(["config", "user.email", "t@example.com"]);
    git(["config", "user.name", "T"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(work, "a.txt"), "a");
    git(["add", "-A"]);
    git(["commit", "-q", "--no-verify", "-m", "chore: clean commit"]);
    const clean = git(["rev-parse", "HEAD"]).stdout.trim();
    writeFileSync(join(work, "a.txt"), "b");
    git(["add", "-A"]);
    git(["commit", "-q", "--no-verify", "-m", `chore: leaking commit\n\n${TRAILER}`]);
    const leaking = git(["rev-parse", "HEAD"]).stdout.trim();

    const push = (
      stdin: string,
      destination: string,
      env: NodeJS.ProcessEnv = {},
      remoteName = "origin"
    ) =>
      spawnSync("sh", [HOOK, remoteName, destination], {
        cwd: work,
        input: stdin,
        encoding: "utf8",
        env: { ...process.env, ...env },
      });

    return { root, work, git, bare, clean, leaking, push };
  }

  let world: ReturnType<typeof makeWorld>;
  beforeEach(() => {
    if (hasSh) world = makeWorld();
  });
  afterEach(() => {
    if (world?.root) rmSync(world.root, { recursive: true, force: true });
  });

  it.skipIf(!hasSh)("refuses a push that would add a session id", () => {
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    const r = world.push(`refs/heads/x ${world.leaking} refs/heads/x ${world.clean}\n`, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("would publish commit(s)");
  });

  it.skipIf(!hasSh)("names an unreachable destination without naming its credentials", () => {
    // The hook is the thing that keeps secrets out of the public record, and it
    // was putting one into stderr itself: git hands it the destination URL
    // verbatim, `https://user:token@host/repo` is a form CI hands out, and an
    // unreachable destination interpolated the whole thing into the refusal —
    // terminal and CI log alike. Reaching step 3 needs a hit first, so this
    // pushes the leaking commit at a destination that cannot answer.
    const dest = "https://user:TOPSECRET@example.invalid/repo.git";
    world.git(["remote", "add", "origin", dest]);
    const r = world.push(`refs/heads/x ${world.leaking} refs/heads/x ${world.clean}\n`, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not verify");
    expect(r.stderr, "the push token reached stderr").not.toContain("TOPSECRET");
    // Named, not merely redacted to nothing: the message still has to say WHERE
    // it could not reach, or it stops being actionable.
    expect(r.stderr).toContain("https://example.invalid/repo.git");
  });

  it.skipIf(!hasSh)("keeps looking after a destination ref it cannot read", () => {
    // An unreadable tip used to end the search. With a ref the clone has never
    // fetched listed ahead of a branch that plainly contains the commit, the
    // push was refused although the answer sat two refs down. `ls-remote` sorts
    // by ref name, so `aaa-unknown` is read before `pub`.
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    world.git(["push", "-q", "--no-verify", dest, `${world.leaking}:refs/heads/pub`]);
    // An object the destination has and this clone does not: built inside the
    // bare repo, never fetched back.
    const bg = (args: string[]) => spawnSync("git", args, { cwd: dest, encoding: "utf8" });
    const emptyTree = bg(["hash-object", "-w", "-t", "tree", "--stdin"]);
    const tree = emptyTree.stdout.trim();
    const orphan = spawnSync("git", ["commit-tree", tree, "-m", "unreachable here"], {
      cwd: dest,
      encoding: "utf8",
      input: "",
    }).stdout.trim();
    expect(orphan, "could not build an object the clone lacks").toMatch(/^[0-9a-f]{40}$/);
    bg(["update-ref", "refs/heads/aaa-unknown", orphan]);
    // The clone must genuinely not have it, or the case proves nothing.
    expect(world.git(["cat-file", "-e", orphan]).status, "the clone already has it").not.toBe(0);

    const r = world.push(`refs/heads/x ${world.leaking} refs/heads/x ${world.clean}\n`, dest);
    expect(r.stderr).not.toContain("could not verify");
    expect(r.status, "refused although a later ref proves it published").toBe(0);
  });

  it.skipIf(!hasSh)("reads the objects that will be pushed, not their replacements", () => {
    // `refs/replace/<oid>` makes every object-reading command show a stand-in,
    // while `git push` sends the original. Point one at a commit with a clean
    // message and the scan finds nothing, so the trailer reaches the
    // destination on a push the hook approved: a check that ran, on the wrong
    // objects.
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    const tree = world.git(["rev-parse", `${world.leaking}^{tree}`]).stdout.trim();
    const clean = world
      .git(["commit-tree", tree, "-p", world.clean, "-m", "chore: nothing to see here"])
      .stdout.trim();
    expect(clean).toMatch(/^[0-9a-f]{40}$/);
    world.git(["update-ref", `refs/replace/${world.leaking}`, clean]);
    // The replacement is in effect for ordinary reads — without this the case
    // would pass whether or not the hook disables it.
    expect(
      world.git(["log", "-1", "--format=%B", world.leaking]).stdout,
      "the replacement is not in effect, so this proves nothing"
    ).not.toContain("Claude-Session");

    const r = world.push(`refs/heads/x ${world.leaking} refs/heads/x ${world.clean}\n`, dest);
    expect(r.status, "the push was approved while the original still carries the trailer").toBe(1);
    expect(r.stderr).toContain("would publish commit(s)");
  });

  it.skipIf(!hasSh)("keeps credentials out of the fetch suggestion too", () => {
    // Git's pre-push docs: with no named remote, BOTH parameters are the
    // location. So `$1` is as sensitive as `$2`, and the refusal that suggests
    // `git fetch <remote>` was handing the token back by the other hand while
    // `$2` was being redacted — the guard reproducing its own defect one
    // message over. Reached by naming a remote_oid this clone does not have,
    // which is what makes `rev-list` fail.
    const dest = "https://user:TOPSECRET@example.invalid/repo.git";
    const unknown = "1".repeat(40);
    const r = world.push(
      `refs/heads/x ${world.leaking} refs/heads/x ${unknown}\n`,
      dest,
      {},
      dest // no named remote: git passes the URL as BOTH arguments
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not verify");
    expect(r.stderr, "the push token reached stderr via the fetch suggestion").not.toContain(
      "TOPSECRET"
    );
    expect(r.stderr).toContain("https://example.invalid/repo.git");
  });

  it.skipIf(!hasSh)("keeps a query-string credential out of the refusal too", () => {
    // A credential does not have to be userinfo, and the redactor's first
    // version only cut userinfo — so this reached stderr from the same refusal
    // the cut was added for. Driven through the hook rather than through
    // `redact_url` alone, because the unit case cannot see a message that
    // interpolates something other than `$remote_display`.
    const dest = "https://example.invalid/repo.git?access_token=TOPSECRET";
    const r = world.push(`refs/heads/x ${world.leaking} refs/heads/x ${world.clean}\n`, dest, {}, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not verify");
    expect(r.stderr, "the query-string token reached stderr").not.toContain("TOPSECRET");
    expect(r.stderr).toContain("https://example.invalid/repo.git");
  });

  it.skipIf(!hasSh)("redacts the userinfo and only the userinfo", () => {
    // Runs the function as it is written in the hook, rather than a copy of it
    // here — a copy would keep passing after the shipped one changed.
    const text = readFileSync(HOOK, "utf8");
    const start = text.indexOf("redact_url() {");
    expect(start, "redact_url is gone from the hook").toBeGreaterThan(-1);
    const end = text.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const fn = text.slice(start, end + 3);

    const redact = (url: string) =>
      spawnSync("sh", ["-c", `${fn}\nredact_url "$1"`, "sh", url], { encoding: "utf8" })
        .stdout.trim();

    expect(redact("https://user:TOPSECRET@example.invalid/repo.git")).toBe(
      "https://example.invalid/repo.git"
    );
    // A password containing `@` — cut at the LAST one in the authority, not the
    // first, or half the secret survives.
    expect(redact("https://user:to@ken@example.invalid/repo.git")).toBe(
      "https://example.invalid/repo.git"
    );
    // No userinfo: nothing to cut, and nothing may be lost either.
    expect(redact("https://example.invalid/repo.git")).toBe("https://example.invalid/repo.git");
    // An `@` in the PATH is not userinfo.
    expect(redact("https://example.invalid/a@b.git")).toBe("https://example.invalid/a@b.git");
    // scp-like: no `://`, so no userinfo field. Left alone rather than mangled.
    expect(redact("git@example.invalid:owner/repo.git")).toBe("git@example.invalid:owner/repo.git");
    // Authority with no path at all.
    expect(redact("https://user:TOPSECRET@example.invalid")).toBe("https://example.invalid");
    // A credential does not have to be userinfo. The first version of this cut
    // only the userinfo, and a token in the query reached stderr from the same
    // refusal the cut was added for — the same defect through a second carrier.
    expect(redact("https://example.invalid/repo.git?access_token=TOPSECRET")).toBe(
      "https://example.invalid/repo.git"
    );
    expect(redact("https://example.invalid/repo.git#TOPSECRET")).toBe(
      "https://example.invalid/repo.git"
    );
    // Both carriers at once, and the query stripped before the authority is
    // read so an `@` inside it cannot be mistaken for userinfo.
    expect(redact("https://user:P@SS@example.invalid/r.git?tok=A@B#f")).toBe(
      "https://example.invalid/r.git"
    );
    // scp-like: `?` and `#` are ordinary path bytes there, and mangling a name
    // makes the message less actionable rather than safer.
    expect(redact("git@example.invalid:owner/repo?x.git")).toBe("git@example.invalid:owner/repo?x.git");
  });

  it.skipIf(!hasSh)("allows a push that adds none", () => {
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    const r = world.push(`refs/heads/x ${world.clean} refs/heads/x ${world.clean}\n`, dest);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it.skipIf(!hasSh)("refuses a direct push to main", () => {
    const dest = world.bare("origin.git");
    const r = world.push(`refs/heads/main ${world.clean} refs/heads/main ${world.clean}\n`, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("direct push to main is forbidden");
  });

  it.skipIf(!hasSh)("lets the release flow through with the documented bypass", () => {
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    const r = world.push(`refs/heads/main ${world.clean} refs/heads/main ${world.clean}\n`, dest, {
      DESKTOP_TOUCH_ALLOW_MAIN_PUSH: "1",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("bypassing main protection");
  });

  it.skipIf(!hasSh)("allows a branch deletion", () => {
    const dest = world.bare("origin.git");
    expect(world.push(`refs/heads/main ${ZERO} refs/heads/main ${world.clean}\n`, dest).status).toBe(
      0
    );
  });

  it.skipIf(!hasSh)("refuses rather than passing when the range cannot be read", () => {
    // A remote_oid this clone does not have — what a force-push to an unfetched
    // remote looks like. In one pipeline with `grep -c` this returned 0 and the
    // push went through unchecked.
    const dest = world.bare("origin.git");
    const r = world.push(`refs/heads/x ${world.clean} refs/heads/x ${"d".repeat(40)}\n`, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not verify");
  });

  it.skipIf(!hasSh)("refuses when the scan itself could not run", () => {
    // A scan that produced nothing because its tools were missing looks exactly
    // like a clean push. The hook counts the commits it walked and compares.
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    for (const tool of ["awk", "tr"]) {
      const bin = mkdtempSync(join(tmpdir(), `pre-push-${tool}-`));
      try {
        writeFileSync(join(bin, tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        const r = world.push(`refs/heads/x ${world.leaking} refs/heads/x ${world.clean}\n`, dest, {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        });
        expect(r.status, tool).toBe(1);
        expect(r.stderr, tool).toContain("could not verify");
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    }
  });

  it.skipIf(!hasSh)("finds a trailer written with lone CR endings", () => {
    // `grep` and `awk` both treat only LF as a record separator, so such a
    // commit was one long line and the anchored pattern never matched. It went
    // through both hooks.
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    const tree = world.git(["write-tree"]).stdout.trim();
    const cr = spawnSync("git", ["commit-tree", tree, "-p", world.clean], {
      cwd: world.work,
      encoding: "utf8",
      input: `feat: x\rClaude-Session: https://claude.ai/code/session_X\r`,
    }).stdout.trim();
    const r = world.push(`refs/heads/x ${cr} refs/heads/x ${ZERO}\n`, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("would publish commit(s)");
  });

  it.skipIf(!hasSh)("lets through a commit the destination already has", () => {
    // The repo's own historical trailers are exactly this case, and they must
    // not block every push. Decided per commit against the destination's live
    // refs, so no special case is needed for them.
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    world.git(["push", "-q", "origin", "main"]);
    world.git(["fetch", "-q", "origin"]);
    const r = world.push(`refs/heads/topic ${world.leaking} refs/heads/topic ${ZERO}\n`, dest);
    expect(r.stderr).not.toContain("would publish");
    expect(r.status).toBe(0);
  });

  it.skipIf(!hasSh)("does not count another remote's history as published here", () => {
    // Fetch a fork, branch off a commit that exists only there, push here.
    const dest = world.bare("origin.git");
    const fork = world.bare("fork.git");
    world.git(["remote", "add", "origin", dest]);
    world.git(["remote", "add", "fork", fork]);
    // The destination is NOT empty — it has the clean commit but not the
    // leaking one. Without this the refusal would come from "the destination
    // advertises no refs at all" and the ancestry check would never run: a
    // mutant that answers "already published" to every question passed the
    // whole suite, because every refusal case had an empty destination.
    world.git(["push", "-q", "origin", `${world.clean}:refs/heads/base`]);
    world.git(["push", "-q", "fork", "main"]);
    world.git(["fetch", "-q", "fork"]);
    const r = world.push(`refs/heads/topic ${world.leaking} refs/heads/topic ${ZERO}\n`, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("would publish commit(s)");
  });

  it.skipIf(!hasSh)("asks whether the hit itself is on the destination, not whether anything is", () => {
    // The destination has history, and the leaking commit is not part of it.
    // "Something is there" must not be read as "this is there".
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    world.git(["push", "-q", "origin", `${world.clean}:refs/heads/main`]);
    world.git(["fetch", "-q", "origin"]);
    const r = world.push(`refs/heads/topic ${world.leaking} refs/heads/topic ${ZERO}\n`, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("would publish commit(s)");
  });

  it.skipIf(!hasSh)("does not trust tracking refs after the remote's url is changed", () => {
    // `git remote set-url` leaves `refs/remotes/<name>/*` describing the OLD
    // repository, with nothing in the config or the hook's arguments to say so.
    // Trusting them published a private repo's history to a public one.
    const priv = world.bare("priv.git");
    const pub = world.bare("pub.git");
    world.git(["remote", "add", "origin", priv]);
    world.git(["push", "-q", "origin", "main"]);
    world.git(["fetch", "-q", "origin"]);
    world.git(["remote", "set-url", "origin", pub]);
    const r = world.push(`refs/heads/topic ${world.leaking} refs/heads/topic ${ZERO}\n`, pub);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("would publish commit(s)");
  });

  it.skipIf(!hasSh)("does not trust tracking refs when pushes go elsewhere than fetches", () => {
    // `remote.<name>.pushurl` sends pushes to one repository while the tracking
    // refs keep following the fetch url.
    const priv = world.bare("priv.git");
    const pub = world.bare("pub.git");
    world.git(["remote", "add", "origin", priv]);
    world.git(["push", "-q", "origin", "main"]);
    world.git(["fetch", "-q", "origin"]);
    world.git(["config", "remote.origin.pushurl", pub]);
    const r = world.push(`refs/heads/topic ${world.leaking} refs/heads/topic ${ZERO}\n`, pub);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("would publish commit(s)");
  });

  it.skipIf(!hasSh)("does not choke on a commit message containing the record marker", () => {
    // The scan frames records with \001 in-band. A message line starting with
    // \001 was counted as a commit header, the walked total overshot the real
    // count, and the branch became permanently unpushable with what read as an
    // internal fault — no route forward except the one thing this hook backstops.
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    world.git(["push", "-q", "origin", "main"]);
    world.git(["fetch", "-q", "origin"]);
    const tree = world.git(["write-tree"]).stdout.trim();
    const odd = spawnSync("git", ["commit-tree", tree, "-p", world.leaking], {
      cwd: world.work,
      encoding: "utf8",
      input: "chore: subject\n\ndeadbeef looks like a record header\n",
    }).stdout.trim();
    const r = world.push(`refs/heads/x ${odd} refs/heads/x ${world.leaking}\n`, dest);
    expect(r.stderr).not.toContain("could not verify");
    expect(r.status).toBe(0);
  });

  it.skipIf(!hasSh)("refuses when it cannot tell whether the hit is published", () => {
    // The destination advertises an object this clone does not have — it moved
    // on since the last fetch. `--is-ancestor` exits 128 there, and folding that
    // into "not an ancestor" announced "this push would publish a session id"
    // about a commit nothing had examined: a check that could not run, reported
    // as a check that failed.
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    // A commit made by somebody else and pushed to the destination. Our clone
    // has never fetched it, so `ls-remote` names an object we do not have.
    const other = join(world.root, "other");
    spawnSync("git", ["init", "-q", "-b", "main", other], { encoding: "utf8" });
    const og = (args: string[]) => spawnSync("git", args, { cwd: other, encoding: "utf8" });
    og(["config", "user.email", "t@example.com"]);
    og(["config", "user.name", "T"]);
    og(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(other, "b.txt"), "b");
    og(["add", "-A"]);
    og(["commit", "-q", "--no-verify", "-m", "elsewhere"]);
    og(["push", "-q", dest, "main:refs/heads/other"]);
    const stranger = og(["rev-parse", "HEAD"]).stdout.trim();
    expect(world.git(["cat-file", "-e", stranger]).status).not.toBe(0);

    const r = world.push(`refs/heads/x ${world.leaking} refs/heads/x ${world.clean}\n`, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not verify");
    expect(r.stderr).not.toContain("would publish commit(s)");
  });

  it.skipIf(!hasSh)("refuses when the destination cannot be asked", () => {
    // A hit was found and the live refs are the only thing that could clear it.
    // Not reachable means not cleared.
    world.git(["remote", "add", "origin", "https://example.invalid/x.git"]);
    const r = world.push(
      `refs/heads/x ${world.leaking} refs/heads/x ${world.clean}\n`,
      "https://example.invalid/x.git"
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not verify");
  });
});
