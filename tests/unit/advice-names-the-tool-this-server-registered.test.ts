/**
 * ADR-036 stage 2 B2c — the conversion. Every advice line that recommended a tool now
 * names a CAPABILITY, and the presenter resolves it against the surface this server
 * published.
 *
 * WHAT THIS ROUND CLAIMS, and how each claim can fail:
 *
 *   1. Every code that had advice still has advice, at every corner — the user's
 *      decision of 2026-09-13. A conversion that drops a code's only line trades a
 *      wrong tool name for no answer at all, which is worse.
 *   2. The floor never fires. The floor exists to make a violation of (1) visible; a
 *      round that leans on it has not done the work. So FLOOR is a failure here, not a
 *      pass — win2's wording, and it is the reason (1) and (2) are separate cells.
 *   3. No `{tool:…}` reaches a caller. The seam covers `suggest` and `try_next`; the
 *      guard's own sentences travel in fields no presenter renders, so those call
 *      sites resolve the NAME at construction instead. A placeholder shipping raw is
 *      the failure this pair of mechanisms exists to prevent.
 *   4. Only the lines that had to move, moved. At the v2 corner every mechanical
 *      conversion renders back to the bytes it replaced, so the codes that differ
 *      there are exactly the ones split by hand.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { getSuggestsForCode } from "../../src/tools/_errors.js";
import { paneIdMissSuggest } from "../../src/tools/terminal.js";
import * as advice from "../../src/tools/_advice-capability.js";
import {
  renderAdviceWith,
  adviceConfigurationFromEnv,
  ADVICE_WITHHELD_FLOOR,
  type AdviceConfiguration,
} from "../../src/tools/_advice-capability.js";

const CORNERS: Record<string, Record<string, string | undefined>> = {
  v2_default: {},
  v2_noLocker: { DESKTOP_TOUCH_DISABLE_KEY_LOCKER: "1" },
  killSwitch: { DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2: "1" },
  killSwitch_noLocker: {
    DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2: "1",
    DESKTOP_TOUCH_DISABLE_KEY_LOCKER: "1",
  },
};
const cfgFor = (corner: string): AdviceConfiguration =>
  adviceConfigurationFromEnv({ ...CORNERS[corner] });

/** The code list comes from the shipped dictionary, not from a list typed here. */
function codesFromSource(): string[] {
  const file = fileURLToPath(new URL("../../src/tools/_errors.ts", import.meta.url));
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let dict: ts.ObjectLiteralExpression | null = null;
  const find = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      n.name.getText() === "SUGGESTS" &&
      n.initializer !== undefined &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      dict = n.initializer;
    }
    ts.forEachChild(n, find);
  };
  find(src);
  const found = dict as ts.ObjectLiteralExpression | null;
  if (found === null) throw new Error("SUGGESTS not found — the walk, not the dictionary");
  return found.properties
    .filter(ts.isPropertyAssignment)
    .map((p) => p.name.getText().replace(/^["']|["']$/g, ""));
}

describe("ADR-036 B2c — advice names the tool this server registered", () => {
  it("keeps at least one line for every code, at every corner, WITHOUT the floor", () => {
    const codes = codesFromSource();
    // CONTROLS FIRST, because a walk that reads nothing reports no violation.
    expect(codes.length, "the dictionary must have been read").toBeGreaterThan(80);
    expect(
      renderAdviceWith(["Save it with {tool:credential_store}"], cfgFor("killSwitch_noLocker")),
      "the instrument must be able to see a line drop",
    ).toEqual([]);

    const empty: string[] = [];
    const floored: string[] = [];
    for (const corner of Object.keys(CORNERS)) {
      const cfg = cfgFor(corner);
      for (const code of codes) {
        const lines = getSuggestsForCode(code);
        if (lines.length === 0) continue; // no advice to begin with is not this rule's business
        const out = renderAdviceWith(lines, cfg);
        if (out.length === 0) empty.push(`${corner}/${code}`);
        if (out.includes(ADVICE_WITHHELD_FLOOR)) floored.push(`${corner}/${code}`);
      }
    }
    expect(empty, "a code with advice must never render to nothing").toEqual([]);
    // The floor is the net that makes a design defect visible, not a condition to
    // satisfy: if it catches something here, the hand-written work was not done.
    expect(floored, "the floor must not have to catch anything").toEqual([]);
  });

  it("leaves a RECOVERY where lines drop, not whatever happened to survive", () => {
    // GATE: win2, 2026-09-13, measuring the ORDER after a drop. The capability audit
    // asked "does this code go empty?" and `KeyLockerConsentRequired` answered
    // `2 → 1  ok`. The number was right and the `ok` was wrong: the surviving line was
    // a RIDER on the dropped one — it described what the enable dialog is like, for a
    // dialog that cannot be opened at that corner. One line, no recovery in it.
    // Decision (1) was satisfied in letter and broken in substance.
    //
    // "Is this sentence a recovery" is not a property a cell can compute, so the cell
    // does the next thing: it PINS what survives wherever anything drops, and a human
    // has judged each of these. Change what a dropping code ships and this reddens —
    // which is the point: the judgement has to be made again, by someone reading it.
    const SURVIVORS: Record<string, string> = {
      // …the locker's own codes, at the two corners where it has no tool. Each
      // survivor is something the caller can act on WITHOUT the locker.
      "v2_noLocker/KeyLockerConsentRequired": "If this server was started with DESKTOP_TOUCH_DISABLE_KEY_LOCKER=1",
      "v2_noLocker/KeyLockerConsoleLimit": "Too many anchored consoles are already open. Close a console window",
      "v2_noLocker/KeyLockerWtUnavailable": "The Windows Terminal pane could not be opened — wt.exe may not be installed",
      "v2_noLocker/KeyLockerNoSuchBinding": "No saved binding matches that URI — the display URI must match exactly",
      "killSwitch_noLocker/KeyLockerConsentRequired": "If this server was started with DESKTOP_TOUCH_DISABLE_KEY_LOCKER=1",
      "killSwitch_noLocker/KeyLockerConsoleLimit": "Too many anchored consoles are already open. Close a console window",
      "killSwitch_noLocker/KeyLockerWtUnavailable": "The Windows Terminal pane could not be opened — wt.exe may not be installed",
      "killSwitch_noLocker/KeyLockerNoSuchBinding": "No saved binding matches that URI — the display URI must match exactly",
      // …and the guard, where the hwnd clause goes and six recoveries stay.
      "killSwitch/AutoGuardBlocked": "Read the error message — its tail preserves",
      "killSwitch_noLocker/AutoGuardBlocked": "Read the error message — its tail preserves",
    };
    const codes = codesFromSource();
    const seen: string[] = [];
    for (const corner of Object.keys(CORNERS)) {
      const cfg = cfgFor(corner);
      for (const code of codes) {
        const raw = getSuggestsForCode(code);
        if (raw.length === 0) continue;
        const out = renderAdviceWith(raw, cfg);
        if (out.length === raw.length) continue; // nothing dropped here
        const key = `${corner}/${code}`;
        seen.push(key);
        expect(out.length, `${key} must keep something`).toBeGreaterThan(0);
        expect(SURVIVORS[key], `${key} drops lines and is not registered — read what survives`).toBeDefined();
        expect(out[0], `${key}: what survives changed`).toContain(SURVIVORS[key]);
      }
    }
    // CONTROL both ways: the registered set is exactly the set that drops. A pair that
    // stops dropping is as much a change as one that starts.
    expect(seen.sort()).toEqual(Object.keys(SURVIVORS).sort());
  });

  it("ships no placeholder to a caller, on any road, at any corner", () => {
    const codes = codesFromSource();
    const leaked: string[] = [];
    let carried = 0;
    for (const corner of Object.keys(CORNERS)) {
      const cfg = cfgFor(corner);
      for (const code of codes) {
        const lines = getSuggestsForCode(code);
        if (lines.some((l) => l.includes("{tool:"))) carried += 1;
        for (const line of renderAdviceWith(lines, cfg)) {
          if (line.includes("{tool:")) leaked.push(`${corner}/${code}: ${line.slice(0, 50)}`);
        }
      }
    }
    // CONTROL: some line must actually carry a placeholder, or "none leaked" is the
    // answer an unconverted dictionary gives too.
    expect(carried, "the dictionary must carry placeholders for this to mean anything").toBeGreaterThan(0);
    expect(leaked, "no caller may receive a raw placeholder").toEqual([]);
  });

  it("keeps the paneId format specification when the locker is gone", () => {
    // THE MOTIVATING CASE, named in this module's own checklist before it was fixed:
    // `paneIdMissSuggest`'s malformed branch returned two lines and BOTH named the
    // locker, so converting them without splitting would have shipped a
    // `TerminalWindowNotFound` refusal with no advice at all. The format specification
    // is the caller's actual answer and is true whether or not the locker exists.
    const malformed = paneIdMissSuggest("not-a-pane-id");
    const off = renderAdviceWith(malformed, cfgFor("v2_noLocker"));
    const on = renderAdviceWith(malformed, cfgFor("v2_default"));
    expect(on.length).toBeGreaterThan(off.length); // the locker lines really do drop
    expect(off.length).toBeGreaterThanOrEqual(1);
    expect(off.join(" ")).toContain("wt:<pid>:<startMs>"); // and what survives is the answer
    // All three shapes keep something, not just this one.
    for (const paneId of ["dtm-locker-console-x", "not-a-pane-id", "12345678"]) {
      expect(
        renderAdviceWith(paneIdMissSuggest(paneId), cfgFor("killSwitch_noLocker")).length,
        `shape for ${paneId}`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("narrows the claim where a substitution alone would be false", () => {
    // THE FOURTH TREATMENT (win2, measured 2026-09-13). "each open window's hwnd" is
    // true of `desktop_discover` and false of the kill switch's provider —
    // `get_ui_elements` returns ONE hwnd, the window the caller named. Substituting
    // the name alone would have shipped a false promise; dropping the line would have
    // taken a recovery that IS available there. So the sentence was narrowed to a
    // claim both providers satisfy.
    const file = fileURLToPath(new URL("../../src/tools/ui-elements.ts", import.meta.url));
    const text = readFileSync(file, "utf8");
    expect(text).toContain("{tool:reidentify_element} returns this window's hwnd");
    expect(text).not.toContain("desktop_discover returns each open window's hwnd");
  });

  it("resolves the guard's own sentences at CONSTRUCTION, because no presenter renders them", () => {
    // The seam covers `suggest` and `try_next`. `nextStepFor()` and its siblings write
    // prose into the refusal's `error` string and into the perception summary — fields
    // no presenter touches, measured on the wire as 8 un-callable names at the two
    // kill-switch corners. A `{tool:…}` written there would ship as literal text, so
    // those sites ask `providerForCaller` for the NAME instead.
    const source = readFileSync(
      fileURLToPath(new URL("../../src/tools/_action-guard.ts", import.meta.url)),
      "utf8",
    );
    // A placeholder is legal in this file ONLY inside a `suggest` array, which the
    // presenter renders. Anywhere else on this road it ships as literal text. Both
    // mechanisms live in this one module, so the cell has to tell them apart by
    // POSITION rather than by presence — which is why it walks the tree instead of
    // counting matches.
    const guardSrc = ts.createSourceFile(
      "_action-guard.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const insideSuggest = (n: ts.Node): boolean => {
      for (let p: ts.Node | undefined = n.parent; p !== undefined; p = p.parent) {
        if (ts.isPropertyAssignment(p) && p.name.getText().replace(/["']/g, "") === "suggest") {
          return true;
        }
      }
      return false;
    };
    const stray: string[] = [];
    let inSuggest = 0;
    const walk = (n: ts.Node): void => {
      if (
        (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
        n.text.includes("{tool:")
      ) {
        if (insideSuggest(n)) inSuggest += 1;
        else stray.push(n.text.slice(0, 60));
      }
      ts.forEachChild(n, walk);
    };
    walk(guardSrc);
    // CONTROL: the walk must have found the legal one, or "no stray" is what an empty
    // walk answers too.
    expect(inSuggest, "the seam-covered placeholder must be visible to this walk").toBeGreaterThan(0);
    expect(stray, "a placeholder outside `suggest` ships as literal text on this road").toEqual([]);

    // And the name it builds comes from the capture, at both corners.
    const { providerForCaller, captureAdviceConfiguration, resetAdviceConfiguration } = advice;
    try {
      captureAdviceConfiguration({ v2: true, credentialStore: true });
      expect(providerForCaller("list_window_titles")).toBe("desktop_discover");
      expect(providerForCaller("disambiguate_window_by_handle")).toBe("desktop_discover");
      captureAdviceConfiguration({ v2: false, credentialStore: true });
      expect(providerForCaller("list_window_titles")).toBe("get_windows");
      // THE ONE WITH NO PROVIDER — the reason `ambiguous_target` is hand-written: the
      // call site must drop its hwnd clause rather than interpolate this.
      expect(providerForCaller("disambiguate_window_by_handle")).toBeNull();
    } finally {
      resetAdviceConfiguration();
    }
  });
});
