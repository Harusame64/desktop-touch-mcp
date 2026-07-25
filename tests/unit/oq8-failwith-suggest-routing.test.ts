/**
 * ADR-029 OQ8 — recovery advice must reach the root `suggest`.
 *
 * `failWith`'s third argument is a context record, so a `suggest` key in it
 * lands at `context.suggest` while the root stays whatever `classify` produced.
 * Fourteen call sites had drifted into that shape and five of them classified
 * to the generic `ToolError`, which has no SUGGESTS entry — so those failures
 * shipped with no advice at all in the place the server instructions tell the
 * model to read.
 *
 * The fix was to classify the code each producer already names in its message
 * and let SUGGESTS carry the advice (the same move SpawnFailed made earlier).
 * These tests pin that, plus the production message wordings whose prose must
 * never grow a phrase an earlier generic arm would poach ("no window" /
 * "window not found" / "timeout"), plus `ForegroundFlashFailed` — the sixth
 * hole of the same class, whose message tail is a snake_case step reason that
 * the generic timeout arm WOULD poach in the shapes that reach the substring
 * cascade. Since Codex round 8 the production leading `<Code>:` form resolves
 * at the declared-code arm at the TOP of classify(), so the cascade-ordering
 * pins below feed wrapper-prefixed variants — the shape that still falls
 * through to the substring arms (no src producer emits it today;
 * defense-in-depth).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { failWith } from "../../src/tools/_errors.js";

const render = (message: string, context?: Record<string, unknown>) =>
  JSON.parse(failWith(new Error(message), "t", context).content[0]!.text);

describe("OQ8 — codes that used to fall through to ToolError", () => {
  const cases: [string, string][] = [
    ["ForegroundFlashRequiresTarget", "ForegroundFlashRequiresTarget"],
    ["ForegroundFlashUnsupported", "ForegroundFlashUnsupported"],
    // The two mouse_drag messages are the EXACT production strings. As
    // leading `<Code>:` forms they resolve at the declared-code arm — this
    // it.each pins the end-to-end production behavior; the wording-caution
    // tripwire for the substring cascade lives in the wrapper-prefixed
    // variants below.
    ["TabDragBlocked", "TabDragBlocked: drag starts in the tab-strip area of a tabbed application"],
    [
      "CrossWindowDragBlocked",
      "CrossWindowDragBlocked: start hwnd=131074 → end hwnd=desktop. " +
        "Pass allowCrossWindowDrag:true to confirm intent (e.g. for desktop range selection).",
    ],
    // OQ8 follow-up (sixth hole): flash paste sequence failure. The producers
    // append the snake_case step reason to the message.
    ["ForegroundFlashFailed", "ForegroundFlashFailed: foreground_steal_denied"],
  ];

  it.each(cases)("%s classifies to its own code with root advice", (code, message) => {
    const body = render(message);
    expect(body.code).toBe(code);
    expect(Array.isArray(body.suggest)).toBe(true);
    expect(body.suggest.length).toBeGreaterThan(0);
  });

  // The wording-caution tripwire (classify arm comment, "keep the messages
  // title-free"): the shapes that REACH the substring cascade are the ones a
  // generic "window not found" / "timeout" arm could poach, and a leading
  // `<Code>:` form never reaches it (declared-code arm). `CDP:` is the one
  // real prefix-composing producer shape in src (cdp-bridge.ts) and is not a
  // SUGGESTS key, so it falls through the declared-code arm — these variants
  // fail if the family arms move below the generic arms OR if the production
  // prose ever grows a phrase a generic arm matches. No src producer
  // composes a wrapper around these codes today (defense-in-depth).
  it.each(cases)("%s still classifies through the substring cascade under a wrapper prefix", (code, message) => {
    const body = render(`CDP: ${message}`);
    expect(body.code).toBe(code);
    expect(body.suggest.length).toBeGreaterThan(0);
  });

  // The producers write `ForegroundFlash…` messages for five different codes.
  // None of the matched substrings is contained in another (e.g.
  // `foregroundflashunsupported` is NOT a substring of
  // `foregroundflashnotapplicableto*`), so the arms are order-independent
  // within the family — this pins that every member still resolves to itself
  // if the wordings or arm order ever change.
  it("each foreground-flash code classifies to itself (no substring containment in the family)", () => {
    expect(render("ForegroundFlashNotApplicableToKeyPress").code).toBe(
      "ForegroundFlashNotApplicableToKeyPress",
    );
    expect(render("ForegroundFlashNotApplicableToSequence").code).toBe(
      "ForegroundFlashNotApplicableToSequence",
    );
    expect(render("ForegroundFlashRequiresTarget").code).toBe("ForegroundFlashRequiresTarget");
    expect(render("ForegroundFlashUnsupported").code).toBe("ForegroundFlashUnsupported");
    expect(render("ForegroundFlashFailed: unknown").code).toBe("ForegroundFlashFailed");
  });

  // The `ForegroundFlashFailed` arm sits BEFORE the generic arms because its
  // message tail is an arbitrary snake_case reason: `focus_wait_timeout`
  // contains "timeout", which the UiaTimeout arm would otherwise capture in
  // the shapes that reach the substring cascade. The production leading form
  // resolves at the declared-code arm, so both shapes are pinned here — the
  // wrapper-prefixed one is the one that exercises the cascade ordering.
  it("keeps the timeout-bearing flash reason out of the generic UiaTimeout arm", () => {
    for (const message of [
      "ForegroundFlashFailed: focus_wait_timeout",
      "CDP: ForegroundFlashFailed: focus_wait_timeout",
    ]) {
      const body = render(message);
      expect(body.code, message).toBe("ForegroundFlashFailed");
      expect(body.suggest.length).toBeGreaterThan(0);
    }
  });
});

// Codex round 6 found the hole this closes: the arms match PROSE ("window not
// found"), so a producer that writes only the code as its message fell through
// to the adviceless `ToolError` — and this PR introduced one such producer
// (`new Error("WindowNotFound")` for keyboard method:'background'). The
// leading-code arm at the end of classify covers the whole shape; this test is
// the structural guard, derived from the source rather than a hand-kept list, so
// a future compact producer cannot reopen it.
describe("OQ8 — a message that is only the code still gets that code's advice", () => {
  const SRC_DIR = join(import.meta.dirname, "..", "..", "src");

  /** Every `new Error("<PascalCase>")` a src file hands to a fail* helper. */
  const compactCodeMessages = (): string[] => {
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts")) {
          for (const m of readFileSync(p, "utf8").matchAll(/new Error\("([A-Z][A-Za-z0-9]*)"\)/g)) {
            found.add(m[1]!);
          }
        }
      }
    };
    walk(SRC_DIR);
    return [...found].sort();
  };

  // I/O-bound: walks and reads every .ts under src/. Under parallel worker
  // load the unit project's default 10s testTimeout is not a safe ceiling
  // (same flake profile as issue-211-classify-branch-producer-pin.test.ts,
  // which carries the same explicit budget), so it is raised here too
  // (Round 7 P3-6).
  it("classifies every compact code message in src to itself, with advice", () => {
    const codes = compactCodeMessages();
    // Sanity: the sweep must actually find producers, or the test passes vacuously.
    expect(codes.length).toBeGreaterThan(10);

    const adviceless = codes
      .map((code) => ({ code, body: render(code) }))
      .filter(({ code, body }) => body.code !== code || (body.suggest ?? []).length === 0)
      .map(({ code, body }) => `${code} → code:${body.code} suggest:${(body.suggest ?? []).length}`);

    expect(
      adviceless,
      "these producers write only their code as the message, so classify must route it " +
        "to that code and SUGGESTS must have an entry for it",
    ).toEqual([]);
  }, 60_000);
});

// Round 7 P2-2 — the dictionary-side complement of the producer sweep above.
// That sweep walks the PRODUCERS; this one walks the DICTIONARY: every
// SUGGESTS key must survive the round trip through classify in both message
// shapes a producer can emit — the bare code and the `<Code>: detail` form.
// Without it, a key whose name embeds a generic keyword silently classifies
// to another code the moment its producer switches from failCode to
// failWith/errorFromMessage. On first run this invariant found exactly two
// such keys out of 81: BrowserSearchTimeout (⊃ "timeout", poached by
// UiaTimeout) and KeyLockerSpawnFailed (⊃ "spawnfailed", poached by
// SpawnFailed) — both now have their own arms ahead of the generic ones.
/** SUGGESTS keys, derived from the source (a hand-kept list would rot). */
const suggestsKeys = (): string[] => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "tools", "_errors.ts"),
    "utf8",
  );
  const start = src.indexOf("const SUGGESTS");
  expect(start).toBeGreaterThan(-1);
  let i = src.indexOf("{", start);
  expect(i).toBeGreaterThan(-1);
  let depth = 1;
  i++;
  const bodyStart = i;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  const body = src.slice(bodyStart, i - 1);
  // Top-level keys sit at exactly two spaces of indentation; nested advice
  // strings never match the `<ident>:` shape at that indent.
  return [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]!);
};

describe("OQ8 — every SUGGESTS key round-trips through classify to itself", () => {
  it("bare and `<Code>: tail` messages both classify to the key itself", () => {
    const keys = suggestsKeys();
    // Sanity floor: 81 keys when this was written; a drastic drop means the
    // extraction regex stopped matching the dictionary shape.
    expect(keys.length).toBeGreaterThanOrEqual(75);

    const misrouted = keys.flatMap((key) =>
      [key, `${key}: detail tail`].flatMap((message) => {
        const body = render(message);
        return body.code !== key || (body.suggest ?? []).length === 0
          ? [`${JSON.stringify(message)} → code:${body.code} suggest:${(body.suggest ?? []).length}`]
          : [];
      }),
    );

    expect(
      misrouted,
      "a SUGGESTS key must classify to itself in both producer message shapes — " +
        "a key whose name embeds a generic keyword needs its own arm ahead of the generic one",
    ).toEqual([]);
  });
});

// Codex round 8 — the round-trip invariant above only fed a harmless tail
// ("detail tail"), which is exactly why it missed this: a detail that carries a
// GENERIC classifier keyword used to let an earlier substring arm poach an
// explicitly prefixed message. Production reproduction: `_resolve-window.ts`
// interpolates the caller-supplied `hwnd` string into
// `WindowNotFound: hwnd "${params.hwnd}" is not a valid integer`, so
// `hwnd: "timeout"` (an LLM-typed argument) classified as UiaTimeout and
// shipped "wait and retry" advice for a malformed argument. The declared-code
// arm at the TOP of classify now resolves any `<Code>:` prefix before the
// detail is scanned.
describe("OQ8 — an explicit `<Code>:` prefix beats generic keywords in the detail", () => {
  // The two production strings whose detail is caller-controlled (worst case:
  // the caller literally passes a classifier keyword as the argument).
  it.each([
    ['WindowNotFound: hwnd "timeout" is not a valid integer'],
    ['WindowNotFound: no visible window with hwnd "timeout"'],
  ])("resolve-window message %s keeps WindowNotFound", (message) => {
    const body = render(message);
    expect(body.code).toBe("WindowNotFound");
    expect(body.suggest.length).toBeGreaterThan(0);
  });

  // Structural invariant over the whole dictionary. Scope note: the full
  // matrix (81 keys × every generic keyword) would add nothing — the
  // declared-code arm returns before the detail is scanned at all, so ONE
  // worst-case tail that concatenates every generic-arm phrase covers the
  // same ground as the matrix while keeping the pin readable. Reachability
  // rationale: only WindowNotFound interpolates caller text today, but any
  // future producer that does gets the same protection, and this loop covers
  // future SUGGESTS keys automatically.
  it("every SUGGESTS key keeps its code when the detail is nothing but generic keywords", () => {
    const keys = suggestsKeys();
    expect(keys.length).toBeGreaterThanOrEqual(75);

    const adversarialTail =
      "timeout timed out window not found no window element not found " +
      "no element is disabled guard failed no scrollbar spawn failed";
    const misrouted = keys.flatMap((key) => {
      const body = render(`${key}: ${adversarialTail}`);
      return body.code !== key || (body.suggest ?? []).length === 0
        ? [`${key} → code:${body.code} suggest:${(body.suggest ?? []).length}`]
        : [];
    });

    expect(
      misrouted,
      "an explicit `<Code>:` prefix is a producer declaration — no generic substring arm may poach it",
    ).toEqual([]);
  });

  // The declared-code arm is deliberately strict (PascalCase token + immediate
  // colon). The production bracket variant `AutoGuardBlocked[endpoint]: …`
  // (mouse.ts) must NOT match it — it falls through to the substring cascade,
  // whose AutoGuardBlocked arm still resolves it.
  it("the bracket variant still routes through the substring cascade", () => {
    const body = render("AutoGuardBlocked[endpoint]: press Escape to dismiss the menu");
    expect(body.code).toBe("AutoGuardBlocked");
    expect(body.suggest.length).toBeGreaterThan(0);
  });

  // Prose that happens to START with a capitalized word must not be promoted:
  // no colon after the first token, so the strict arm cannot fire and the
  // prose arms keep deciding ("Terminal window not found" must stay
  // TerminalWindowNotFound, not be re-routed by any leading-token logic).
  it("prose without a colon is untouched by the declared-code arm", () => {
    expect(render("Terminal window not found for pane").code).toBe("TerminalWindowNotFound");
  });
});

describe("OQ8 — the context record stays one level deep", () => {
  it("renders caller keys directly under context", () => {
    const body = render("ForegroundFlashUnsupported", { reason: "chromium", windowTitle: "Chrome" });
    expect(body.context).toEqual({ reason: "chromium", windowTitle: "Chrome" });
  });

  // What the 21 flattened call sites used to do. Kept as a characterisation of
  // the trap rather than as an endorsement: the lint rule now rejects it at the
  // call site, and this shows what the wire looked like when it slipped through.
  it("nests a `context` key one level further, which is why the rule bans it", () => {
    const body = render("ForegroundFlashUnsupported", { context: { reason: "chromium" } });
    expect(body.context).toEqual({ context: { reason: "chromium" } });
  });

  it("keeps hoisted keys at the root", () => {
    const body = render("ForegroundFlashUnsupported", { hints: { a: 1 }, reason: "x" });
    expect(body.hints).toEqual({ a: 1 });
    expect(body.context).toEqual({ reason: "x" });
  });
});
