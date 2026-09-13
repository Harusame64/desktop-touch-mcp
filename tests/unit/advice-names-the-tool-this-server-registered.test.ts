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
import { describe, it, expect, vi } from "vitest";
import { readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { getSuggestsForCode, toToolFailure } from "../../src/tools/_errors.js";
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

/**
 * The one place the floor may fire, with the reason it is not a gap.
 *
 * `KeyLockerConsentRequired` needs the locker enabled to be produced at all —
 * `withHost` checks `isDisabled()` first and throws `KeyLockerDisabledError`, and
 * `registerKeyLockerTools` returns before registering anything when the switch is on.
 * So the two locker-off corners cannot raise it, and a floor there is not advice the
 * caller is missing. Registered rather than excused: change what floors and the cells
 * redden, and whoever changes it owes the same producer analysis.
 */
const FLOOR_IS_HONEST_HERE = [
  "v2_noLocker/KeyLockerConsentRequired",
  "killSwitch_noLocker/KeyLockerConsentRequired",
];

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
    // `finally`, because the capture is a MODULE GLOBAL: a failing assertion below used
    // to leave it pinned at the last corner for every cell that ran after, turning one
    // red into a cascade whose cause is not in any of their messages (gate 2,
    // 2026-09-13). The last cell in this file already did it this way.
    try {
    for (const corner of Object.keys(CORNERS)) {
      const cfg = cfgFor(corner);
      advice.captureAdviceConfiguration(cfg);
      for (const code of codes) {
        const lines = getSuggestsForCode(code);
        if (lines.length === 0) continue; // no advice to begin with is not this rule's business
        // ON THE ROAD, not one layer below it. `renderAdviceWith` sits UNDER the
        // floor — `renderAdviceWithFloor` is where it lives — so a cell that calls
        // the renderer directly reports EMPTY where a caller receives the floor
        // sentence. Third time this layer has been confused in this branch, twice by
        // me and once by the Windows side, which is why the comment is here and not
        // in a commit message.
        const out =
          toToolFailure({ name: code, displayMessage: "m", suggest: lines }).suggest ?? [];
        if (out.length === 0) empty.push(`${corner}/${code}`);
        if (out.includes(ADVICE_WITHHELD_FLOOR)) floored.push(`${corner}/${code}`);
      }
    }
    } finally {
      advice.resetAdviceConfiguration();
    }
    expect(empty, "a code with advice must never render to nothing").toEqual([]);
    // The floor is the net that makes a design defect visible, not a condition to
    // satisfy: if it catches something here, the hand-written work was not done —
    // EXCEPT where the code cannot be produced at that corner at all.
    //
    // One such pair, registered with its proof rather than papered over.
    // `KeyLockerConsentRequired` needs the locker enabled: `withHost` checks
    // `isDisabled()` first and throws `KeyLockerDisabledError`, and
    // `registerKeyLockerTools` returns before registering anything when the switch is
    // on, so no producer survives the locker-off corners. A line WAS added here to
    // keep the floor at zero, and it shipped to real callers at the corners where the
    // locker works, telling them to check a variable that is provably not the cause —
    // noise everywhere it could be read, to satisfy a gate where it could not be
    // (gate 2, 2026-09-13, twice; the first answer to it was a wrong reachability
    // claim of mine).
    //
    // Registered, not excused: change what floors and this reddens, and whoever
    // changes it has to show the same kind of producer analysis. The analysis itself
    // is MEASURED by the cell below, not left as prose.
    expect(floored.sort(), "the floor must not have to catch anything else").toEqual(
      FLOOR_IS_HONEST_HERE.sort(),
    );
  });

  it("proves the floor exception by walking the two roads that make the code unproducible", async () => {
    // A REGISTRATION IS A CLAIM, and `FLOOR_IS_HONEST_HERE` was carrying one no cell
    // tested: that `KeyLockerConsentRequired` cannot be produced while the locker
    // switch is on. Gate 1 put the hole exactly — delete the early return and a
    // disabled caller could reach `list` without consent, receive the consent refusal
    // AND the floor, and `floored` would still hold these same two entries with every
    // assertion above green (2026-09-13). The claim has two roads and each is measured
    // here, with the control that makes a negative answer mean something.
    const { registerKeyLockerTools } = await import("../../src/tools/key-locker-tool.js");
    const { KeyLockerManager, KeyLockerDisabledError, KeyLockerConsentRequiredError } =
      await import("../../src/engine/key-locker/key-locker-manager.js");

    const namesRegisteredWithSwitch = (value: string): string[] => {
      const names: string[] = [];
      const stub = { registerTool: (name: string): void => { names.push(name); } };
      vi.stubEnv("DESKTOP_TOUCH_DISABLE_KEY_LOCKER", value);
      try {
        registerKeyLockerTools(stub as unknown as Parameters<typeof registerKeyLockerTools>[0]);
      } finally {
        vi.unstubAllEnvs();
      }
      return names;
    };
    // ROAD 1 — REGISTRATION. Control first, or "registered nothing" is also what a stub
    // that records nothing answers.
    expect(namesRegisteredWithSwitch(""), "control: the locker IS offered when enabled")
      .toContain("key_locker");
    expect(namesRegisteredWithSwitch("1"), "no tool is offered while the switch is on")
      .toEqual([]);

    // ROAD 2 — THE HANDLER, for the case where something calls the manager anyway.
    // A fresh store means consent is unaccepted, which is the state that PRODUCES
    // `KeyLockerConsentRequired`; the switch has to win over it, in that order.
    const storeDir = mkdtempSync(join(tmpdir(), "dtm-floor-proof-"));
    const mgr = new KeyLockerManager({ storeDir });
    const thrownWithSwitch = async (value: string): Promise<unknown> => {
      vi.stubEnv("DESKTOP_TOUCH_DISABLE_KEY_LOCKER", value);
      try {
        await mgr.withHost(async () => undefined);
        return null;
      } catch (e) {
        return e;
      } finally {
        vi.unstubAllEnvs();
      }
    };
    // Control: with the switch off, this store DOES produce the consent refusal — so
    // the code is genuinely producible, and the assertion below is about the switch.
    expect(await thrownWithSwitch(""), "control: consent is what an enabled locker refuses on")
      .toBeInstanceOf(KeyLockerConsentRequiredError);
    expect(
      await thrownWithSwitch("1"),
      "the switch answers before consent does — this is why the floor at the locker-off corners is honest",
    ).toBeInstanceOf(KeyLockerDisabledError);
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
    // FULL TEXT, from a fixture, because the reader is the point. The first version
    // registered a ~70-character PREFIX and compared only the FIRST survivor — and
    // win2's cell made the identical mistake at 150 characters, which is how they
    // reported `paneIdMissSuggest` (c) as having no action left: the clause naming
    // `focus_window` was past the cut. **Truncate only what a machine compares — a
    // name, an id, a path, a hash. The field a reader weighs goes in whole.** Their
    // §23, and it applied here first.
    const FIXTURE = fileURLToPath(
      new URL("../fixtures/advice-survivors-when-lines-drop.json", import.meta.url),
    );
    const registered = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<
      string,
      { dropped: number; survivors: string[] }
    >;
    // THE BUILDER IS A PRODUCER TOO, and it is where the subtlest survivors are — the
    // registration covered only the dictionary at first, so a mutation that changed
    // `paneIdMissSuggest`'s surviving text left the cell green. That is the shape this
    // cell exists to catch, missed by the cell itself (mutation, 2026-09-13).
    const BUILDER: Record<string, string> = {
      "paneIdMissSuggest(windowTitle-for-paneId)": "dtm-locker-console-x",
      "paneIdMissSuggest(malformed)": "not-a-pane",
      "paneIdMissSuggest(no-live-pane)": "12345678",
    };
    const codes = codesFromSource();
    const seen: string[] = [];
    const producers: Array<[string, () => string[]]> = [];
    for (const code of codes) producers.push([code, () => getSuggestsForCode(code)]);
    for (const [name, paneId] of Object.entries(BUILDER)) {
      producers.push([name, () => paneIdMissSuggest(paneId)]);
    }
    for (const corner of Object.keys(CORNERS)) {
      const cfg = cfgFor(corner);
      for (const [code, produce] of producers) {
        const raw = produce();
        if (raw.length === 0) continue;
        const out = renderAdviceWith(raw, cfg);
        if (out.length === raw.length) continue; // nothing dropped here
        const key = `${corner}/${code}`;
        seen.push(key);
        if (!FLOOR_IS_HONEST_HERE.includes(key)) {
          expect(out.length, `${key} must keep something`).toBeGreaterThan(0);
        }
        expect(
          registered[key],
          `${key} drops lines and is not registered — read what survives and decide whether it is a recovery`,
        ).toBeDefined();
        expect(registered[key], `${key}: what survives changed — read it again`).toEqual({
          dropped: raw.length - out.length,
          survivors: out,
        });
      }
    }
    // CONTROL both ways: the registered set is exactly the set that drops. A pair that
    // stops dropping is as much a change as one that starts.
    expect(seen.sort()).toEqual(Object.keys(registered).sort());
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

  it("names a capability at EVERY placeholder site in src, not only the ones this file calls", () => {
    // THE TITLE OF THE CELL ABOVE SAID "any road" AND IT SWEPT ONE. It walks
    // `getSuggestsForCode`, so it covers `_errors.ts` and nothing else — and the sites
    // it does not reach are exactly where a misspelling survives, because the resolver
    // returns an UNKNOWN capability VERBATIM on purpose ("visibly broken beats a
    // sentence that reads as advice", `_advice-capability.ts`). So `{tool:reidentify_elemnt}`
    // ships as those literal bytes, and until this cell nothing outside the dictionary
    // would have said so. Found by asking win2 for the residual of their own sweep, not
    // by the sweep's answer: the three non-capability names they reported are this
    // module's deliberate doc examples, and the question "where else could a real one
    // hide" is what had no cell (2026-09-13).
    //
    // FROM THE AST, so comments are excluded by the parser rather than by a regex that
    // has to know what a comment looks like — the doc examples above sit in `/** */`
    // blocks and a line-oriented filter reads them as code.
    //
    // `{tool:` IS NOT A UNIQUE MARKER in this tree: `run_macro`'s step syntax is
    // literally `{tool: "sleep", params: {…}}`, and `macro.ts` and the stub catalogue
    // carry several. They do not match because the pattern requires the closing brace
    // immediately after a bare identifier, and every macro example quotes the name. A
    // future unquoted one (`{tool:sleep}`) would be flagged here as an unknown
    // capability — a false positive, and the safe direction: the resolver would leave
    // those same bytes in place, so a loud cell beats a silent shipment.
    const SRC = fileURLToPath(new URL("../../src", import.meta.url));
    const files: string[] = [];
    const walkDir = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walkDir(p);
        else if (e.name.endsWith(".ts")) files.push(p);
      }
    };
    walkDir(SRC);

    const sites: Array<{ file: string; name: string }> = [];
    for (const file of files) {
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node): void => {
        if (
          ts.isStringLiteral(n) ||
          ts.isNoSubstitutionTemplateLiteral(n) ||
          ts.isTemplateHead(n) ||
          ts.isTemplateMiddle(n) ||
          ts.isTemplateTail(n)
        ) {
          for (const m of n.text.matchAll(/\{tool:([a-z_]+)\}/g)) {
            sites.push({ file: file.slice(SRC.length + 1), name: m[1]! });
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }

    // RESIDUAL, printed rather than implied: "everything resolved" and "the walk found
    // nothing" are the same silence otherwise. win2's §26 — the instrument states what
    // it read.
    const byFile = new Map<string, number>();
    for (const s of sites) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);
    const residual =
      `read ${files.length} src files, ${sites.length} placeholder occurrences in ` +
      `${byFile.size} of them: ` +
      [...byFile.entries()].sort().map(([f, n]) => `${f}×${n}`).join(", ");
    expect(files.length, `control — the walk must have read the tree (${residual})`).toBeGreaterThan(50);
    expect(sites.length, `control — the walk must have found the sites (${residual})`).toBeGreaterThan(30);
    // More than one file, or a walk that only ever reaches `_errors.ts` passes this too
    // while leaving the hole it was written for.
    expect(byFile.size, `control — more than the dictionary must be in view (${residual})`).toBeGreaterThan(3);

    // THE CLAIM. A name the module knows resolves (to a tool) or drops (provider null);
    // a name it does not know comes back verbatim. So a surviving placeholder at ANY
    // corner is a name that is not a capability — which is the only way this can fail.
    const unknown: string[] = [];
    for (const corner of Object.keys(CORNERS)) {
      const cfg = cfgFor(corner);
      for (const site of sites) {
        const [rendered] = renderAdviceWith([`x {tool:${site.name}} y`], cfg);
        if (rendered !== null && rendered !== undefined && rendered.includes("{tool:")) {
          unknown.push(`${site.file}: {tool:${site.name}} (at ${corner})`);
        }
      }
    }
    expect(
      [...new Set(unknown)].sort(),
      `a placeholder naming no capability ships as literal text — ${residual}`,
    ).toEqual([]);
    // CONTROL for the instrument itself: a name that is NOT a capability must be seen
    // to survive, or "none unknown" is also what a broken detector answers.
    expect(
      renderAdviceWith(["x {tool:reidentify_elemnt} y"], cfgFor("v2_default"))[0],
      "control: the detector must see a misspelling survive",
    ).toContain("{tool:reidentify_elemnt}");
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
    // The capability, not a narrowed claim: obtaining a handle that names ONE window
    // out of several is `disambiguate_window_by_handle`, whose kill-switch arm is
    // null, so the line drops there and the handle-free route survives. Two earlier
    // wordings are pinned as absent because each was measured false — "each open
    // window's hwnd" of `get_windows`, and "this window's hwnd" of `get_ui_elements`
    // on an `ambiguous_target` refusal, where the hwnd is the first z-order match.
    expect(text).toContain("{tool:disambiguate_window_by_handle} returns each open window's hwnd");
    expect(text).not.toContain("desktop_discover returns each open window's hwnd");
    expect(text).not.toContain("{tool:reidentify_element} returns this window's hwnd");
    // AND THE LINE THAT SURVIVES THE DROP IS SCOPED, which is a separate claim from the
    // one above and was wrong while that one was right. Flat, "Or narrow windowTitle
    // until exactly one window matches" reached three readers this branch has and was
    // false for two of them — the titleless caller (no title to narrow) and the caller
    // who passed `hwnd` (whose `windowTitle` the guard had already ignored) — and it
    // was the ONLY line left at the kill-switch corners, where the handle line drops.
    // Both gates found it independently on the same commit (2026-09-13). The flat form
    // is pinned as absent because it is the shape that comes back.
    expect(text).not.toContain("Or narrow windowTitle until exactly one window matches");
    expect(text).toContain("There is no title here to narrow");
    expect(text).toContain("Narrowing windowTitle will not help on this call");
    expect(text).toContain("It works while this window's normalized title is not contained in another open window's");
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
