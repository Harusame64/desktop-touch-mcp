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
  SESSION_ID_CLASS,
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

  it("keeps a line that BEGINS with a session link and carries prose after it", () => {
    // THE DEFECT THIS CASE EXISTS FOR (found by running the hook, 2026-09-15,
    // reproduced on Windows): anchoring at line start was written so removal would
    // not "eat the sentence around the link", and it did exactly that whenever the
    // link happened to open the line — one editor wrapping a sentence reaches that
    // shape. The whole line went, and the author's sentence came back truncated
    // with only "removed 1 Claude-Session line" to say why.
    //
    // Such a line is `.githooks/pre-push`'s business now: it scans mid-line for an
    // id of at least 16 characters and refuses the push. A reword costs less than a
    // lost sentence, and it is the author's reword rather than the hook's edit.
    const input =
      "docs: explain\n\nThe trailer is spelled Claude-Session: and a link like\n" +
      "https://claude.ai/code/session_x is what the hook removes when it starts a line.\n";
    const { text, removed } = stripSessionLines(input);
    expect(removed).toBe(0);
    expect(text).toBe(input);
  });

  it("keeps a list item whose link is followed by prose, and still removes the bare one", () => {
    // The two shapes differ by what comes after the id, and nothing else.
    expect(
      stripSessionLines(`fix: a\n\n- https://claude.ai/code/session_x — the run this came from\n`)
        .removed,
    ).toBe(0);
    expect(stripSessionLines(`fix: a\n\n- https://claude.ai/code/session_x\n`).removed).toBe(1);
    // Trailing whitespace after the id is still a bare link — an editor's stray
    // space must not be what decides whether the id is removed.
    expect(stripSessionLines(`fix: a\n\n- https://claude.ai/code/session_x   \n`).removed).toBe(1);
  });

  it("still takes a whole line that OPENS with the trailer — pinned as behaviour, not endorsed", () => {
    // TWO CASES IN THIS FILE USED TO GIVE OPPOSITE READINGS OF THIS (gate 2, 2026-09-15).
    // This one said the trailer branch is right to take the whole line because "a
    // trailer's value is the id, there is no sentence to protect"; the scope case below
    // said the same behaviour is "the same failure mode this change fixes for URLs,
    // filed rather than fixed here". Both cannot be the reason.
    //
    // The filed one is correct: `Claude-Session: lines are removed at commit time, so the
    // gate never sees them.` is a SENTENCE, and it is deleted whole with only "removed 1
    // Claude-Session line" said about it. It is not fixed here because narrowing this
    // branch moves both nets again, which is a subject of its own.
    //
    // So this case pins the behaviour WITHOUT calling it right, and says so, because the
    // next person to touch it will see this go red and must read that as the filed change
    // arriving rather than as a regression.
    expect(stripSessionLines(`fix: a\n\n${TRAILER} and then some words\n`).removed).toBe(1);
  });

  it("removes a trailer a BOM was written in front of", () => {
    // The pattern is ANCHORED and a BOM is not whitespace, so `\uFEFFClaude-Session: <id>`
    // stayed in the message while the push side missed it too — there is no URL there for
    // the mid-line scan to find (gate 1, 2026-09-15). An editor writes a BOM; nobody
    // chooses one, which is why this is in scope where an obfuscated URL is not.
    const { text, removed } = stripSessionLines(`fix: a\n\n\uFEFF${TRAILER}\n`);
    expect(removed).toBe(1);
    expect(text).toBe("fix: a\n");
  });

  it("leaves a BOM alone when the line under it is not a trailer", () => {
    // Only the TEST sees the stripped copy. What comes back is the original bytes, which
    // is what this function promises — a BOM on an ordinary line survives.
    const input = "\uFEFFfix: a\n\nbody\n";
    const { text, removed } = stripSessionLines(input);
    expect(removed).toBe(0);
    expect(text).toBe(input);
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

  it("pre-push counts an id with the same characters this module allows in one", () => {
    // ONE ALPHABET, AND THE PIN THE MODULE CLAIMS. `embeds()` counted `[A-Za-z0-9]` while
    // this module and `redact_session` allowed `_` and `-`, so an id containing
    // punctuation stopped counting early, came in under the floor, and was published on
    // the mid-line road (gate 2, 2026-09-15). The module's comment then claimed this cell
    // existed for a round in which it did not (gate 2 again, the same day) — a documented
    // cross-check that was not there is worse than none, so here it is.
    const hook = readFileSync(join(repoRoot, ".githooks", "pre-push"), "utf8");
    expect(hook).toContain(`session_id_class='${SESSION_ID_CLASS}'`);
    expect(hook).toContain("if (c ~ idclass) n++; else break");
    // The redactor takes the same class, so a refusal cannot print an id the scan counted.
    expect(hook).toContain('${session_id_class}*|\\1<redacted>|g"');
    // AND THE CHARACTER TEST NEVER USES A LITERAL CLASS. Asserted at the USE SITE rather
    // than by scanning the file for a spelling: a scan for `[A-Za-z0-9…` can only find a
    // class already written that way, so a narrower third site spelled `[[:alnum:]]`,
    // `[A-Za-z]` or `[0-9A-Za-z_-]` would vanish from the result instead of showing up as
    // a second spelling (gate 2, 2026-09-15) — the same "enumerate what you thought of"
    // defect the hook itself had. What matters is not how a class is written but whether
    // the id test is decided by one that is not the shared variable.
    expect(hook, "a character is classified against a literal class instead of idclass").not.toMatch(
      /\bc ~ \//
    );
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

/** 24 characters, the length every real id in this repository's history has. */
const REAL_ID = "01ABCDEFGHIJKLMNOPQRSTUV";

/**
 * The same length, with the two characters the id class allows besides letters and
 * digits. `embeds()` used to count `[A-Za-z0-9]` only, so an id like this stopped
 * counting at the punctuation, came in under the floor, and was published — and the
 * corpus could not see it, because every id in it was alphanumeric.
 */
const REAL_ID_HYPHEN = "01ABCDEF-GHIJKLMNOPQRSTU";
const REAL_ID_UNDER = "01ABCDEF_GHIJKLMNOPQRSTU";

describe("the two sides, and the two properties between them", () => {
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
    // THE LINES THE TWO PATTERNS ARE MEANT TO DISAGREE ON. Before they were added,
    // narrowing the removal pattern left all 63 cases green — the corpus this block
    // exists to be thorough about had no case that could tell the two apart, which
    // is the same defect as a pin whose mutation nobody fires.
    "https://claude.ai/code/session_x is what the hook removes when it starts a line.",
    "- https://claude.ai/code/session_x — the run this came from",
    "  + https://claude.ai/code/session_x, for the record",
    "https://claude.ai/code/session_x   ",
    // REAL-LENGTH ids, both shapes. The corpus was entirely `session_x` before, so
    // nothing in it could tell the id floor from a pattern that ignores length.
    `https://claude.ai/code/session_${REAL_ID}`,
    `- https://claude.ai/code/session_${REAL_ID}`,
    `https://claude.ai/code/session_${REAL_ID} is the run this came from.`,
    `see [the session](https://claude.ai/code/session_${REAL_ID}) for context`,
    `https://claude.ai/code/session_${REAL_ID_HYPHEN} is the run this came from.`,
    `https://claude.ai/code/session_${REAL_ID_UNDER} is the run this came from.`,
    `https://claude.ai/code/session_${REAL_ID_HYPHEN}`,
    `see [the session](https://claude.ai/code/session_${REAL_ID_HYPHEN}) for context`,
    "https://claude.ai/code/artifacts/abc",
    "https://claudeXai/code/session_x",
    "",
    "   ",
    "-not-a-list-marker Claude-Session: x",
    "+not-a-list-marker Claude-Session: x",
  ];

  /**
   * THE PREDICATE THE HOOK ACTUALLY RUNS, lifted out of `.githooks/pre-push` rather
   * than re-implemented here. A copy would drift, and the copy is what would be
   * tested. Feeds one synthetic commit record per line and returns which lines the
   * program flagged.
   */
  function flaggedByTheHook(lines: readonly string[]): boolean[] {
    const hook = readFileSync(join(repoRoot, ".githooks", "pre-push"), "utf8");
    // EVERY `-v` IS READ OFF THE CALL AND RESOLVED FROM THE HOOK'S OWN ASSIGNMENTS,
    // rather than being a list this file keeps. win2 proved why on 2026-09-15: with a
    // hardcoded list, a variable the hook had started passing would be left UNSET
    // here, and `c ~ idstop` against an empty pattern matches every character — the
    // floor moves and nothing says so. A missing assignment now fails the case.
    const call = hook.match(/awk((?: -v \w+="\$\w+")+) '/);
    expect(call, "pre-push no longer calls awk the way this probe reads it").toBeTruthy();
    const from = hook.indexOf(call![0]);
    const to = hook.indexOf("\n        '", from);
    expect(to, "the awk program in pre-push is not terminated the way this probe reads it").toBeGreaterThan(from);
    const program = hook.slice(from + call![0].length, to);

    const vars = [...call![1].matchAll(/-v (\w+)="\$(\w+)"/g)].map(([, name, shellVar]) => {
      const assigned = hook.match(new RegExp(`^${shellVar}=(?:'(.*)'|(\\S+))$`, "m"));
      expect(assigned, `pre-push passes ${name} but never assigns ${shellVar}`).toBeTruthy();
      const raw = assigned![1] ?? assigned![2];
      // `'...'"'"'...'` is how sh writes a single quote inside a single-quoted string.
      return ["-v", `${name}=${raw.split(`'"'"'`).join("'")}`];
    });
    expect(vars.length, "the awk call passes no variables at all").toBeGreaterThan(2);

    // THE LOCALE COMES FROM THE HOOK, NOT FROM HERE. This probe used to pass
    // `LC_ALL: "C"` — the one configuration difference that decides whether the scan
    // survives a multi-byte character — so it supplied the precondition the hook was
    // missing and could not see the crash (gate 2, 2026-09-15). If the hook stops
    // setting it, this fails instead of passing.
    const locale = hook.match(/^LC_ALL=(\S+)$/m);
    expect(locale, "pre-push sets no LC_ALL — a byte-wise character test needs one").toBeTruthy();

    // AND THROUGH THE SAME PIPELINE. `leaking_commits` pipes `git log` through
    // `tr '\r' '\n'` before awk sees it, so a message written with lone CR endings is
    // several lines to the hook and one record to a probe that skips the stage.
    const records = lines
      .map((line, i) => `\u0001${i.toString(16).padStart(40, "0")}\n${line.replace(/\r/g, "\n")}`)
      .join("\n");
    const probe = spawnSync("awk", [...vars.flat(), program], {
      input: `${records}\n`,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: locale![1] },
    });
    expect(probe.status, `awk unusable: ${probe.error?.message ?? ""} ${probe.stderr}`).toBe(0);

    // The program prints the scanned count as well; without checking it, an awk that
    // read nothing would look like a clean corpus.
    const out = probe.stdout.trim().split("\n");
    const scanned = out.find((l) => l.startsWith("@@SCANNED@@"));
    expect(scanned, "the program did not report how many records it walked").toBeDefined();
    expect(Number(scanned?.slice("@@SCANNED@@".length))).toBe(lines.length);

    const hit = new Set(out.filter((l) => /^[0-9a-f]{40}$/.test(l)));
    return lines.map((_, i) => hit.has(i.toString(16).padStart(40, "0")));
  }

  /**
   * A session id of at least the floor's length, anywhere in the line — built from
   * the SHARED id class and from the floor READ OUT OF THE HOOK, not from a second
   * copy of `embeds()`'s rule. The previous version of this helper re-stated that
   * rule with awk's old narrow alphabet, so both properties below were tautologies
   * for exactly the leak that was live: no corpus line could separate the two
   * alphabets, because this function agreed with the scanner it was checking
   * (gate 2, 2026-09-15).
   */
  function carriesARealId(line: string): boolean {
    return new RegExp(`claude\\.ai/code/session_${SESSION_ID_CLASS}{${hookFloor()},}`).test(line);
  }

  /** The floor the hook itself declares, so the probe cannot test a different one. */
  function hookFloor(): number {
    const hook = readFileSync(join(repoRoot, ".githooks", "pre-push"), "utf8");
    const m = hook.match(/^session_min_id=(\d+)$/m);
    expect(m, "pre-push no longer declares session_min_id the way this probe reads it").toBeTruthy();
    return Number(m?.[1]);
  }

  /**
   * CLASSIFIED BY HAND, and scoped on purpose.
   *
   * WHAT THIS GATE IS FOR: the harness writes `Claude-Session:` on its own, and a person
   * sometimes pastes a session link. Those are accidents, they always carry the real host
   * spelled the obvious way, and they are the whole of what actually happens.
   *
   * WHAT IT IS NOT FOR: evasion. A round of this branch chased spellings a deliberately
   * obfuscated URL could use — an upper-case host, a port, a subdomain, percent-encoding,
   * the marker itself percent-encoded — and closed several while breaking two things people
   * really do: an ordinary path containing `/code/session_` became a refusal, and the
   * byte-wise character test reached prose it never used to and killed the scan. There is
   * no actor who smuggles their own session id into a public repository. The rows below
   * are the accident, and the two rows that must PASS at the end are what the widening
   * broke.
   *
   * Classified before either engine was asked, because every other case in this block
   * derives its expectation from one of the rules it checks — which is how the last leak
   * survived: the expected-id helper re-stated `embeds()`'s own alphabet.
   */
  const CLASSIFIED: ReadonlyArray<readonly [line: string, mustRefuse: boolean, why: string]> = [
    [TRAILER, true, "the trailer the harness writes — the one case that actually happens"],
    [`Claude-Session: ${REAL_ID}`, true, "the same trailer with a bare id and no URL"],
    [`https://claude.ai/code/session_${REAL_ID}`, true, "a pasted link, alone on the line"],
    [`https://claude.ai/code/session_${REAL_ID} is the run this came from.`, true, "prose after it"],
    [`see [the session](https://claude.ai/code/session_${REAL_ID}) for context`, true, "mid-sentence"],
    [`https://claude.ai/code/session_${REAL_ID_HYPHEN} is the run.`, true, "a `-` inside the id"],
    [`https://claude.ai/code/session_${REAL_ID_UNDER} is the run.`, true, "a `_` inside the id"],
    [`\uFEFFClaude-Session: ${REAL_ID}`, true, "a BOM in front of the trailer — an editor writes it, nobody chooses it"],
    [`fix: see http://claude.ai/code/session_${REAL_ID} for context`, true, "the other scheme — the scan never needed one"],
    [`fix: see claude.ai/code/session_${REAL_ID}`, true, "no scheme at all, which is how people write links in prose"],
    [`fix: see https://Claude.ai/code/session_${REAL_ID}`, true, "a capital where a sentence starts — a typo, not evasion"],
    ["https://claude.ai/code/session_x is what the hook removes when it starts a line.", false, "a short example id, prose after it"],
    ["See https://claude.ai/code/session_x for context", false, "a short example id, mid-sentence"],
    ["- https://claude.ai/code/session_x", false, "a short example id, bare"],
    ["the marker is claude.ai/code/session_—that is what it counts from", false, "a multi-byte character right after the marker — the scan must not DIE on it"],
    ["refactor scripts/code/session_store_persistence.ts today", false, "an ordinary path that happens to contain the words"],
    ["prose mentioning Claude-Session: mid-sentence", false, "the trailer named in a sentence"],
    [COAUTHOR, false, "attribution, which stays"],
    ["fix: a subject line", false, "an ordinary subject"],
    ["\uFEFFfix: a subject line", false, "a BOM in front of an ordinary subject — stripping it must not start refusing things"],
  ];

  it("gives the answer a person gave, on every line a person classified", () => {
    const flagged = flaggedByTheHook(CLASSIFIED.map(([line]) => line));
    const wrong = CLASSIFIED.map(([line, mustRefuse, why], i) => ({ line, mustRefuse, why, got: flagged[i] }))
      .filter((row) => row.got !== row.mustRefuse)
      .map((row) => `${row.mustRefuse ? "must refuse" : "must pass"} (${row.why}): ${row.line}`);
    expect(wrong, "the hook disagrees with the hand-classified table").toEqual([]);
    // Not vacuous: both answers are present, and more than one of each.
    expect(CLASSIFIED.filter(([, m]) => m).length).toBeGreaterThan(5);
    expect(CLASSIFIED.filter(([, m]) => !m).length).toBeGreaterThan(3);
  });

  it("redacts every id it is willing to refuse, so a refusal cannot print one", () => {
    // WIDENING A DETECTOR AND LEAVING ITS PRINTER BEHIND is how one defect becomes two.
    // The refusal prints each offending commit's SUBJECT, through `redact_session`, and
    // that function used to match `https://claude.ai/code/session_` with an
    // `[A-Za-z0-9_-]` id — every spelling the refusal newly catches would have gone to
    // stderr and into CI logs with the id intact.
    const hook = readFileSync(join(repoRoot, ".githooks", "pre-push"), "utf8");
    const fn = hook.slice(hook.indexOf("redact_session() {"), hook.indexOf("\n}", hook.indexOf("redact_session() {")) + 2);
    expect(fn.length, "redact_session is not where this probe reads it").toBeGreaterThan(100);
    // THE FUNCTION NEEDS WHAT THE HOOK GIVES IT. It interpolates `$session_id_class`, and
    // a snippet run without that assignment is a DIFFERENT function: the variable expands
    // to nothing and the URL pattern changes shape. That is why this case stayed green
    // through a mutation of the trailer branch — the probe was not running the hook's
    // redactor at all. Every assignment the snippet references is carried in with it.
    const needed = [...new Set([...fn.matchAll(/\$\{?(\w+)\}?/g)].map(([, name]) => name))].filter(
      (name) => name !== "1"
    );
    const prelude = needed
      .map((name) => {
        const assigned = hook.match(new RegExp(`^${name}=(?:'.*'|\\S+)$`, "m"));
        expect(assigned, `redact_session uses $${name} and pre-push never assigns it`).toBeTruthy();
        return assigned![0];
      })
      .join("\n");
    expect(prelude.length, "redact_session references no hook variable — has it stopped sharing one?").toBeGreaterThan(0);
    for (const [line, mustRefuse] of CLASSIFIED) {
      if (!mustRefuse) continue;
      const probe = spawnSync("sh", ["-c", `${prelude}\n${fn}\nredact_session "$1"`, "sh", line], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      });
      expect(probe.status, `sh unusable: ${probe.error?.message ?? ""} ${probe.stderr}`).toBe(0);
      expect(probe.stdout, `redact_session left an id in: ${line}`).toContain("<redacted>");
      // AND EVERY ID-SHAPED TOKEN IS GONE, not merely joined by the marker. Pulling the id
      // out by `session_(…)` only worked for the URL form, so the bare-id trailer
      // `Claude-Session: <id>` was checked for the WORD `<redacted>` and nothing else —
      // and the trailer branch's `[^ ]*` matches zero characters, because a space follows
      // the colon, so the marker was inserted and the id printed beside it (gate 2,
      // 2026-09-15). Any run of id characters at least as long as the floor counts as an id
      // here, whatever shape the line has.
      const tokens = (line.match(new RegExp(`${SESSION_ID_CLASS}{${hookFloor()},}`, "g")) ?? []).filter(
        (t) => !/^[A-Za-z-]+$/.test(t)
      );
      expect(tokens.length, `no id-shaped token to check in: ${line}`).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(probe.stdout, `redact_session printed ${token} from: ${line}`).not.toContain(token);
      }
    }
  });

  it("refuses every line in the corpus that carries a real session id", () => {
    // THE SAFETY PROPERTY, bounded to what the corpus reaches. It was named "wherever it
    // sits", and the PR body said "anchored or mid-sentence" — broader than what was
    // held: the marker search was case-sensitive then, so an upper-case host walked past
    // both engines and no corpus line could show it, because this helper was
    // case-sensitive in the same way (gate 2, 2026-09-15). The search is case-folded now
    // and the host is not looked at at all, but the honest statement is still about the
    // lines that were tried, and the hand-classified table above is where the equivalent
    // spellings are actually enumerated.
    //
    // What remains outside: a spelling of `/code/session_` ITSELF that nobody listed — a
    // percent-encoded slash, say. The marker is the one literal the scan still depends on.
    const flagged = flaggedByTheHook(corpus);
    const missed = corpus.filter((line, i) => carriesARealId(line) && !flagged[i]);
    expect(missed, "a line carrying a real session id was not refused").toEqual([]);
    expect(corpus.filter(carriesARealId).length, "the corpus has no real id in it to miss").toBeGreaterThan(2);
  });

  it("refuses nothing that carries neither a trailer nor a real id", () => {
    // THE USABILITY PROPERTY, and the defect this change closes on the push side.
    // The URL used to sit in the anchored pattern with no length floor, so a line
    // merely BEGINNING with `https://…/session_x` was refused however short the id
    // and whatever followed it — invisible while removal deleted those lines, and an
    // unpushable commit the moment removal stopped.
    const ere = ereToRegExp(SESSION_LINE_ERE);
    const flagged = flaggedByTheHook(corpus);
    const wrong = corpus.filter((line, i) => flagged[i] && !ere.test(line) && !carriesARealId(line));
    expect(wrong, "a line with no trailer and no real id was refused").toEqual([]);
  });

  it("only ever deletes a line whose text is a trailer or is nothing but a link", () => {
    // THE NAME IS NARROWER THAN THE ONE THIS CASE USED TO CARRY, because the old name
    // ("none of the author's own text") claimed more than the pattern holds: the
    // TRAILER branch is still unanchored at line end, so a line opening with
    // `Claude-Session:` and continuing in prose is deleted whole — the same failure
    // mode this change fixes for URLs, and this very commit message contains that
    // token mid-sentence (gate 2, 2026-09-15). Closing it needs both nets moved again,
    // which is a separate subject; it is filed rather than fixed here, and the name
    // says what is actually asserted in the meantime.
    // THE REMOVAL PROPERTY. Removal edits the message, so its licence is narrow: a
    // git trailer, or a link with nothing after it. Everything else is the push
    // side's business — a reword costs less than a lost sentence.
    // BUILT FROM THE SHARED CLASS, not a fourth hand-written copy of it — widening
    // `SESSION_ID_CLASS` used to widen the removal pattern while this stayed put, so
    // this case would report overreach that was not overreach (gate 2, 2026-09-15), in
    // the very PR whose second commit is called "Name the id alphabet once".
    const BARE = new RegExp(
      `^[ \\t\\v\\f\\r]*(?:[-*+][ \\t\\v\\f\\r]+)?(?:Claude-Session:.*|https://claude\\.ai/code/session_${SESSION_ID_CLASS}*[ \\t\\v\\f\\r]*)$`
    );
    const overreach = corpus.filter((line) => SESSION_LINE_RE.test(line) && !BARE.test(line));
    expect(overreach, "removal would take a line carrying the author's text").toEqual([]);
    expect(corpus.filter((l) => SESSION_LINE_RE.test(l)).length).toBeGreaterThan(5);
  });

  it("the corpus contains lines the two sides treat differently — otherwise the pair above is vacuous", () => {
    const flagged = flaggedByTheHook(corpus);
    const removedNotRefused = corpus.filter((l, i) => SESSION_LINE_RE.test(l) && !flagged[i]);
    const refusedNotRemoved = corpus.filter((l, i) => flagged[i] && !SESSION_LINE_RE.test(l));
    // A bare short-id link is removed and not refused; a real id in prose is refused
    // and not removed. Both directions have to be present or the properties above are
    // being checked against a corpus that cannot separate them.
    expect(removedNotRefused.length, "no line is removed-but-not-refused").toBeGreaterThan(0);
    expect(refusedNotRemoved.length, "no line is refused-but-not-removed").toBeGreaterThan(0);
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

    // COMPARED AGAINST THE ERE AS WE READ IT, not against the removal pattern. This
    // case used to check awk's answers against `SESSION_LINE_RE`, which was the same
    // rule then and is not now — removal is narrower on purpose. What awk has to
    // agree with is the ERE it is actually given; the direction that matters for
    // safety is asserted separately below.
    const ere = ereToRegExp(SESSION_LINE_ERE);
    const fromAwk = probe.stdout.trim().split("\n");
    const fromEre = corpus.map((line) => (ere.test(line) ? "1" : "0"));
    expect(fromAwk.length).toBe(corpus.length);
    for (let i = 0; i < corpus.length; i++) {
      expect(fromAwk[i], `awk vs the ERE on ${JSON.stringify(corpus[i])}`).toBe(fromEre[i]);
    }

    // What the two sides owe each other is NOT that awk stops everything removal
    // deletes — a bare link with a short id is removed and deliberately not refused.
    // The properties that do hold are the three cases above, and they run the hook's
    // own awk program rather than this pattern.
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

  it.skipIf(!hasSh)("refuses a session URL written inside prose", () => {
    // The pattern is anchored so a message DISCUSSING the rule survives, and that
    // let a real link through in the shape people actually write:
    // "see [the session](https://.../session_<id>)". Removal has to stay anchored —
    // rewriting mid-line would eat the sentence around it — but refusing only costs
    // a reword, so the push side may look anywhere.
    const NL = String.fromCharCode(10);
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    // Branch from the CLEAN commit: the harness also builds a leaking one, and a
    // tip descended from it is refused for that ancestor no matter what this case
    // writes — which is how the first draft of these three passed without ever
    // testing their own message.
    world.git(["checkout", "-q", world.clean]);
    writeFileSync(join(world.work, "a.txt"), "prose");
    world.git(["add", "-A"]);
    world.git([
      "commit", "-q", "--no-verify",
      "-m", "chore: mention",
      "-m", "see [the session](https://claude.ai/code/session_012A8NB4QjLTAPaKtNcNxaBe) for context",
    ]);
    const tip = world.git(["rev-parse", "HEAD"]).stdout.trim();
    const r = world.push(`refs/heads/x ${tip} refs/heads/x ${world.clean}${NL}`, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("would publish commit(s)");
  });

  it.skipIf(!hasSh)("does not refuse a clean push because of the user's log output encoding", () => {
    // `i18n.logOutputEncoding` is a USER setting, and git encodes the record markers along
    // with the message: set to UTF-16LE, the scan walked a one-commit range, reported
    // `@@SCANNED@@0`, and the count check — which exists so a scan that could not run is
    // not read as a clean one — refused the push (gate 1, 2026-09-15). The scan reads bytes
    // under `LC_ALL=C`, so the encoding it reads has to be pinned rather than inherited.
    const dest = world.bare("origin.git");
    world.git(["config", "i18n.logOutputEncoding", "UTF-16LE"]);
    const r = world.push(`refs/heads/x ${world.clean} refs/heads/x ${"0".repeat(40)}\n`, dest);
    expect(r.stderr, "a clean push was refused because of a log encoding").not.toContain("could not verify");
    expect(r.status, `refused a clean push: ${r.stderr}`).toBe(0);
  });

  it.skipIf(!hasSh)("lets the repo write about session_x without refusing itself", () => {
    // This repo talks about the rule using session_x — in prose, in the cases
    // above, and in a commit message already on main. Refusing every embedded URL
    // would make that commit unpushable for good: the guard would have locked the
    // door on the history it lives in. The id-length floor is what separates a
    // leaked id from a sentence about ids.
    const NL = String.fromCharCode(10);
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    // Branch from the CLEAN commit: the harness also builds a leaking one, and a
    // tip descended from it is refused for that ancestor no matter what this case
    // writes — which is how the first draft of these three passed without ever
    // testing their own message.
    world.git(["checkout", "-q", world.clean]);
    writeFileSync(join(world.work, "a.txt"), "about");
    world.git(["add", "-A"]);
    world.git([
      "commit", "-q", "--no-verify",
      "-m", "docs: explain",
      "-m", "written + https://claude.ai/code/session_x went through both nets",
    ]);
    const tip = world.git(["rev-parse", "HEAD"]).stdout.trim();
    const r = world.push(`refs/heads/x ${tip} refs/heads/x ${world.clean}${NL}`, dest);
    expect(r.status, r.stderr).toBe(0);
  });

  it.skipIf(!hasSh)("does not print the session id it is refusing", () => {
    // The refusal lists each offending commit's subject so a person can find it,
    // and when the session line IS the subject, %s handed the whole secret to
    // stderr and to CI logs — the same shape this file already fixed once for
    // push URLs, one printf over.
    const NL = String.fromCharCode(10);
    const dest = world.bare("origin.git");
    world.git(["remote", "add", "origin", dest]);
    // Branch from the CLEAN commit: the harness also builds a leaking one, and a
    // tip descended from it is refused for that ancestor no matter what this case
    // writes — which is how the first draft of these three passed without ever
    // testing their own message.
    world.git(["checkout", "-q", world.clean]);
    writeFileSync(join(world.work, "a.txt"), "subject");
    world.git(["add", "-A"]);
    world.git(["commit", "-q", "--no-verify", "-m", TRAILER]);
    const tip = world.git(["rev-parse", "HEAD"]).stdout.trim();
    const r = world.push(`refs/heads/x ${tip} refs/heads/x ${world.clean}${NL}`, dest);
    expect(r.status).toBe(1);
    expect(r.stderr, "the id reached stderr").not.toContain("012A8NB4QjLTAPaKtNcNxaBe");
    // Redacted, not swallowed: the line still has to name the commit.
    expect(r.stderr).toContain(tip.slice(0, 7));
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
