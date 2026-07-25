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
 * the generic timeout arm WOULD poach if its arm were not placed early.
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
    // The two mouse_drag messages are the EXACT production strings — a
    // tripwire for the wording caution in the classify arm comment: these
    // arms sit after the generic "window not found" / "timeout" arms, so the
    // prose must stay free of any phrase those arms match (hwnd numbers are
    // fine; interpolated window titles would not be).
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
  // contains "timeout", which the UiaTimeout arm would otherwise capture.
  it("keeps the timeout-bearing flash reason out of the generic UiaTimeout arm", () => {
    const body = render("ForegroundFlashFailed: focus_wait_timeout");
    expect(body.code).toBe("ForegroundFlashFailed");
    expect(body.suggest.length).toBeGreaterThan(0);
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
