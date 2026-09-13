/**
 * ADR-036 stage 2 B2b — the presenter resolves advice against ONE captured
 * configuration, and no advice line is converted yet.
 *
 * WHAT THIS ROUND CLAIMS, and what it deliberately does not: the wire is live and the
 * bytes do not move. Those are two statements and they need two instruments — "nothing
 * changed" is exactly what a DEAD wire also produces, so a byte comparison alone
 * cannot tell a working seam from an absent one. Every cell here is one of the two:
 * a line with a placeholder proves the wire, a line without one proves the bytes.
 *
 * WHY A CAPTURE AT ALL (gate 2, 2026-09-13, on the mechanism PR): the server reads the
 * two switches at different moments — the v2 flag once at module init, the locker per
 * `createMcpServer()` — while the resolver used to read ambient env at call time. The
 * cell that splits those two answers is the one that MOVES `process.env` after the
 * capture; a cell that leaves the environment still cannot tell them apart, which is
 * why win2's four-corner harness (one env per server, fixed before start) structurally
 * cannot judge this and says so in its own header.
 */
import { describe, it, expect } from "vitest";
import {
  captureAdviceConfiguration,
  adviceConfigurationFromEnv,
  adviceConfigurationWasCaptured,
  resetAdviceConfiguration,
  renderAdviceForCaller,
  renderAdviceEachForCaller,
  ADVICE_WITHHELD_FLOOR,
} from "../../src/tools/_advice-capability.js";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { toToolFailure } from "../../src/tools/_errors.js";
import { ToolFailureError } from "../../src/errors/typed-errors.js";
import { buildFailureEnvelope, type TryNextAction } from "../../src/tools/_envelope.js";

const KEY = "DESKTOP_TOUCH_DISABLE_KEY_LOCKER";
const V2 = "DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2";

/** Run `body` with `process.env` set as given, and put the environment back. */
function withEnv(patch: Record<string, string | undefined>, body: () => void): void {
  const had = new Map<string, string | undefined>();
  for (const k of Object.keys(patch)) had.set(k, process.env[k]);
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    body();
  } finally {
    for (const [k, v] of had) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetAdviceConfiguration();
  }
}

describe("ADR-036 B2b — the presenter reads one captured configuration", () => {
  it("follows the CAPTURE, not the environment as it stands when the advice is built", () => {
    // The whole point of the round, and the only shape that separates the two answers.
    withEnv({ [KEY]: undefined }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env)); // locker ON at registration
      process.env[KEY] = "1"; // …and someone turns it off afterwards
      expect(renderAdviceForCaller(["use {tool:credential_store}"])).toEqual(["use key_locker"]);
    });
    // And the other direction, so this is not one-sided: captured OFF stays off even
    // when the ambient environment says the locker is back.
    withEnv({ [KEY]: "1" }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      delete process.env[KEY];
      expect(renderAdviceForCaller(["use {tool:credential_store}"])).toEqual([]);
    });
  });

  it("falls back to the live environment when nothing captured — and says which it is", () => {
    // The fallback keeps every non-server caller working, and it is also how a
    // forgotten capture would hide. So it is pinned, and the state is readable.
    withEnv({ [KEY]: undefined }, () => {
      resetAdviceConfiguration();
      expect(adviceConfigurationWasCaptured()).toBe(false);
      expect(renderAdviceForCaller(["use {tool:credential_store}"])).toEqual(["use key_locker"]);
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      expect(adviceConfigurationWasCaptured()).toBe(true);
    });
  });

  it("resolves through the FLAT road — the wire is live, not merely quiet", () => {
    withEnv({ [V2]: undefined }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      const flat = toToolFailure(
        new ToolFailureError("WindowNotFound", {
          displayMessage: "no window",
          suggest: ["Run {tool:list_window_titles} to see the titles"],
        }),
      );
      expect(flat.suggest).toEqual(["Run desktop_discover to see the titles"]);
    });
    withEnv({ [V2]: "1" }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      const flat = toToolFailure(
        new ToolFailureError("WindowNotFound", {
          displayMessage: "no window",
          suggest: ["Run {tool:list_window_titles} to see the titles"],
        }),
      );
      expect(flat.suggest).toEqual(["Run get_windows to see the titles"]);
    });
  });

  it("resolves through the ENVELOPE road, and drops a row whose capability is absent", () => {
    withEnv({ [V2]: "1", [KEY]: "1" }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      const env = buildFailureEnvelope("WindowNotFound", [
        { action: "Run {tool:list_window_titles} to see the titles" },
        { action: "Then {tool:credential_store} for the secret" },
        { action: "Plain advice, no placeholder" },
      ]);
      expect(env.if_unexpected.try_next).toEqual([
        { action: "Run get_windows to see the titles" },
        { action: "Plain advice, no placeholder" },
      ]);
    });
  });

  it("is CALLED by the shipped server, which no other cell here can see", () => {
    // GATE 2, 2026-09-13. The module's own comment claimed this cell existed before it
    // did. Delete the call in `server-windows.ts` and everything stays green, because
    // the `process.env` fallback takes over silently - the very "forgotten capture"
    // the fallback's note says is covered. Importing the server to check would start
    // one, so the source is parsed instead: the claim is about the shipped code, and
    // this is the cheapest instrument that reads the shipped code rather than a copy
    // of the belief about it.
    const file = fileURLToPath(new URL("../../src/server-windows.ts", import.meta.url));
    const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
    let found = 0;
    // UNCONDITIONAL, not merely CONTAINED. Counting any call anywhere under the
    // function stays green when the call is wrapped in an `if`, buried in a closure
    // that runs at first tool call, or put behind an early return — and a capture that
    // does not happen is a FORGOTTEN capture, which is the one thing this cell exists
    // to catch (gate 2, 2026-09-13, eleventh round). So the search is over the
    // function's OWN statement list: a direct `ExpressionStatement` always runs when
    // the function does. Depth is the property, not presence.
    let directStatements = 0;
    let unconditional = 0;
    let returnsBeforeCapture = 0;
    const visit = (node: ts.Node): void => {
      const isTarget =
        (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
        node.name?.text === "createMcpServer";
      if (isTarget) {
        found += 1;
        const body = (node as ts.FunctionLikeDeclaration).body;
        if (body !== undefined && ts.isBlock(body)) {
          directStatements = body.statements.length;
          let captureAt = -1;
          body.statements.forEach((st, i) => {
            if (
              ts.isExpressionStatement(st) &&
              ts.isCallExpression(st.expression) &&
              ts.isIdentifier(st.expression.expression) &&
              st.expression.expression.text === "captureAdviceConfiguration"
            ) {
              unconditional += 1;
              if (captureAt === -1) captureAt = i;
            }
          });
          // …AND CONTROL MUST REACH IT. "A direct statement always runs" is true only
          // while nothing above it can return: `if (cond) return s;` inserted before
          // the capture leaves the statement exactly where it is and the function
          // returning without it (gate 1, 2026-09-13, P3 on this cell's own head).
          // The commit that wrote the cell CLAIMED the early-return case and did not
          // check it — the claim was in the prose, not in the code. Returns inside a
          // nested function do not return from here, so the walk stops at one.
          if (captureAt > 0) {
            const hasReturn = (n: ts.Node): boolean => {
              if (ts.isFunctionLike(n)) return false;
              if (ts.isReturnStatement(n)) return true;
              return ts.forEachChild(n, hasReturn) === true;
            };
            for (const st of body.statements.slice(0, captureAt)) {
              if (hasReturn(st)) returnsBeforeCapture += 1;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
    // THE CONTROL FIRST, and it counts what the WALK matched rather than what the TEXT
    // contains. `getText().toContain("function createMcpServer")` was satisfied by the
    // phrase appearing anywhere, a comment included, and said nothing about whether
    // `isTarget` ever fired — so converting the declaration to
    // `const createMcpServer = () => {…}` would have reported "no call" when the truth
    // is "the walk cannot see this shape" (gate 2, 2026-09-13, tenth round). Those are
    // different failures and the control exists to tell them apart.
    expect(found, "the walk must recognise createMcpServer's declaration shape").toBe(1);
    // …and that the body was readable at all, so "no statement matched" cannot mean
    // "there were no statements to look at".
    expect(directStatements, "the walk must see createMcpServer's statement list").toBeGreaterThan(5);
    expect(
      unconditional,
      "createMcpServer must capture unconditionally — a guarded capture is a forgotten one",
    ).toBe(1);
    expect(
      returnsBeforeCapture,
      "nothing above the capture may return — an unreached capture is a forgotten one",
    ).toBe(0);
  });

  it("keeps production off the renderers that read ambient env", () => {
    // GATE 2, 2026-09-13: `renderAdvice` and `providerFor` are still exported and
    // still read `process.env` at call time - they are what the cells and the
    // four-corner sweeps drive. Nothing stopped the next tool from importing the
    // obvious name and quietly reintroducing the defect this round removes. The AST
    // cell above says the capture HAPPENS; this one says nothing bypasses it.
    const root = fileURLToPath(new URL("../../src/", import.meta.url));
    // `adviceConfigurationFromEnv` is here because `renderAdviceWith(lines,
    // adviceConfigurationFromEnv())` is the same "read ambient env at call time"
    // behaviour spelled with the new names — banning the old two only would have left
    // the defect one rename away (gate 2, 2026-09-13).
    // `providerForName` joined them in the eighth round: it is exported and defaults
    // its `env` to `process.env` too, so `providerForName(cap)` in a production module
    // is the same call-time ambient resolution under a fourth spelling. The comment
    // above said adding `adviceConfigurationFromEnv` closed the "one rename away"
    // hole; it closed one rename, and there was another.
    const BANNED_EXPORTS = new Set([
      "renderAdvice",
      "providerFor",
      "providerForName",
      "adviceConfigurationFromEnv",
      // THE WRITE SIDE, added in the ninth round. The read side was banned four ways
      // and the write side not at all, though it reaches the same place from the
      // other end: `resetAdviceConfiguration()` in production returns the whole
      // process to `captured ?? adviceConfigurationFromEnv()`, which IS call-time
      // ambient resolution, and a stray `captureAdviceConfiguration({…})` silently
      // redirects every presenter — the disagreement warning fires at most once per
      // process, and nothing checks `adviceConfigurationWasCaptured()` at runtime.
      "resetAdviceConfiguration",
      "captureAdviceConfiguration",
      // AND THE CONFIG-TAKERS, which are a fifth spelling of the same thing (gate 2,
      // eleventh round). `renderAdviceWith(lines, { v2: resolveV2Activation(
      // process.env).enabled, credentialStore: !keyLockerDisabled() })` is call-time
      // ambient resolution built by hand, and it passed tsc, eslint and this gate.
      // Production hands the presenter no configuration at all: it calls the
      // `*ForCaller` doors, which read the capture. Anything that TAKES an
      // `AdviceConfiguration` is a cell's tool or a sweep's.
      "renderAdviceWith",
      "renderAdviceEach",
      "providerForConfig",
    ]);
    // …with the ONE site that must call it. The cell above asserts that this call
    // exists inside `createMcpServer`; this one asserts nothing else makes it.
    const CAPTURE_SITE = "server-windows.ts";
    const offenders: string[] = [];
    const spellings: string[] = [];
    let scanned = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!p.endsWith(".ts")) continue;
        // POSIX-SPELLED, because `relative()` answers backslashes on Windows and the
        // comparison below is against a `/`-spelled literal — so on the machine this
        // server ships on, the exclusion was silently inert and the module would have
        // scanned itself (gate 2, 2026-09-13, ninth round). The sibling gate in this
        // directory carries a control for exactly this hazard and this one did not;
        // it does now, below. Harmless today only because the module has no
        // self-import, which is a property of today's code, not of the gate.
        const rel = relative(root, p).split(sep).join("/");
        spellings.push(rel);
        if (rel === "tools/_advice-capability.ts") continue; // the module's own definitions
        scanned += 1;
        const file = ts.createSourceFile(p, readFileSync(p, "utf8"), ts.ScriptTarget.ESNext, true);
        // Resolve the LOCAL names, not the spelling: `import { renderAdvice as x }` and
        // `import * as advice from "…"` both bypass a match on the callee's text, and
        // both reintroduce live-environment resolution (gate 1, 2026-09-13 — the same
        // species as the aliased `createRequire` on the sibling branch).
        const banned = new Set<string>();
        const namespaces = new Set<string>();
        const collect = (node: ts.Node): void => {
          if (
            ts.isImportDeclaration(node) &&
            ts.isStringLiteralLike(node.moduleSpecifier) &&
            node.moduleSpecifier.text.includes("_advice-capability")
          ) {
            const bindings = node.importClause?.namedBindings;
            if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
              namespaces.add(bindings.name.text);
            }
            if (bindings !== undefined && ts.isNamedImports(bindings)) {
              for (const el of bindings.elements) {
                if (BANNED_EXPORTS.has((el.propertyName ?? el.name).text)) banned.add(el.name.text);
              }
            }
          }
          ts.forEachChild(node, collect);
        };
        collect(file);
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node)) {
            const e = node.expression;
            if (ts.isIdentifier(e) && banned.has(e.text)) {
              // `===`, not `endsWith`: the latter also exempts a future
              // `src/legacy/server-windows.ts` or `src/http-server-windows.ts`, and a
              // SECOND capture site is the "one slot, two servers" hazard this gate is
              // the only thing standing against (gate 2, tenth round).
              if (!(e.text === "captureAdviceConfiguration" && rel === CAPTURE_SITE)) {
                offenders.push(`${rel}: ${e.text}`);
              }
            } else if (
              ts.isPropertyAccessExpression(e) &&
              ts.isIdentifier(e.expression) &&
              namespaces.has(e.expression.text) &&
              BANNED_EXPORTS.has(e.name.text)
            ) {
              offenders.push(`${rel}: ${e.expression.text}.${e.name.text}`);
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(file);
      }
    };
    walk(root);
    // The control first: a walk that scans nothing reports no offender and reads
    // exactly like a clean tree.
    expect(scanned, "the walk must have read the source tree").toBeGreaterThan(100);
    // CONTROL, the one the sibling gate carries and this one did not: on Windows
    // `relative()` answers backslashes, and the self-exclusion above compares against
    // a `/`-spelled literal. Without this the exclusion is inert on the platform the
    // server ships on, and no assertion here would notice (gate 2, ninth round).
    // Asserted rather than trusted, because this machine cannot produce the spelling.
    for (const rel of spellings) {
      expect(rel, `paths must be posix-spelled: ${rel}`).not.toMatch(/\\/);
    }
    // …and that the exclusion actually excluded something, so it cannot pass by
    // matching nothing on either platform.
    expect(spellings, "the module itself must be among the files walked").toContain(
      "tools/_advice-capability.ts",
    );
    expect(offenders, "production must call renderAdviceForCaller, not the env readers").toEqual([]);
  });

  it("never renders try_next to an empty list — the floor the envelope already promised", () => {
    // `toFailureEnvelope` substitutes a generic hint rather than ship an empty
    // `try_next`. Dropping rows here would have taken that away by construction: the
    // fallback computed, then dropped (gate 2, 2026-09-13). The user's decision of the
    // same day is the rule - every code keeps a line at every corner.
    withEnv({ [KEY]: "1" }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      const env = buildFailureEnvelope("KeyLockerConsentRequired", [
        { action: "Run {tool:credential_store} to save it" },
      ]);
      expect(env.if_unexpected.try_next).toHaveLength(1);
      expect(env.if_unexpected.try_next[0]!.action).toMatch(/No recovery is available/);
    });
    // …and an input that was empty to begin with stays empty: the floor is about
    // advice that was DROPPED, not about inventing advice nobody wrote.
    withEnv({ [KEY]: "1" }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      expect(buildFailureEnvelope("X", []).if_unexpected.try_next).toEqual([]);
    });
  });

  it("gives the FLAT road the same floor as the envelope", () => {
    // Gate 2 found the asymmetry: the envelope substituted a line and the flat road
    // omitted `suggest` entirely, so one code answered two ways depending on which
    // presenter it went through.
    withEnv({ [KEY]: "1" }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      const flat = toToolFailure(
        new ToolFailureError("KeyLockerConsentRequired", {
          displayMessage: "consent",
          suggest: ["Run {tool:credential_store} to save it"],
        }),
      );
      expect(flat.suggest).toHaveLength(1);
      expect(flat.suggest?.[0]).toMatch(/No recovery is available/);
    });
    // …and a failure that never had advice still has none: `undefined` and "withheld"
    // stay different answers.
    withEnv({ [KEY]: "1" }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      const flat = toToolFailure(new ToolFailureError("X", { displayMessage: "no advice" }));
      expect(flat.suggest).toBeUndefined();
    });
  });

  it("DROPS a non-string advice entry instead of throwing", () => {
    // The module's own rule: never throw on the failure road, because the caller is
    // already building a refusal. Wiring the seam in made `.replace` reachable with a
    // value the compiler cannot vouch for - both roads are exported and `tests/**` is
    // outside the include (gate 2: `buildFailureEnvelope("X", [{}])` threw).
    // Inside `withEnv` so the capture is released in its `finally`: outside it, this
    // cell left the module global set for everything after it and made the file
    // order-dependent (gate 2, 2026-09-13).
    withEnv({}, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      expect(() => buildFailureEnvelope("X", [{} as unknown as TryNextAction])).not.toThrow();
      expect(() =>
        toToolFailure(
          new ToolFailureError("X", { displayMessage: "x", suggest: [null as unknown as string] }),
        ),
      ).not.toThrow();
    });
  });

  it("keeps each row's OWN fields when a row between them drops", () => {
    // GATE 2, 2026-09-13, A HIGH — and the cells that were here did not see it: the
    // drop case used rows with only `action` (so a mispairing is invisible) and the
    // fields case used one row with no drop. Rendering the list in one call and
    // re-pairing by counting survivors gave every row after a drop the NEXT
    // survivor's text while keeping its own `args`, and threw the last survivor away.
    withEnv({ [KEY]: "1" }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      const rows: TryNextAction[] = [
        { action: "Save it with {tool:credential_store}", args: { secret: true }, confidence: "high" },
        { action: "Otherwise retry the click", args: { retry: 1 }, confidence: "low" },
      ];
      expect(buildFailureEnvelope("X", rows).if_unexpected.try_next).toEqual([
        { action: "Otherwise retry the click", args: { retry: 1 }, confidence: "low" },
      ]);
    });
    // A drop in the MIDDLE, which is where an index walk slides furthest.
    withEnv({ [KEY]: "1" }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      const rows: TryNextAction[] = [
        { action: "plain first", args: { p: 1 } },
        { action: "drop me {tool:credential_store}", args: { q: 2 } },
        { action: "plain third", args: { r: 3 } },
      ];
      expect(buildFailureEnvelope("X", rows).if_unexpected.try_next).toEqual([
        { action: "plain first", args: { p: 1 } },
        { action: "plain third", args: { r: 3 } },
      ]);
    });
  });

  it("does not let a non-string row swallow the rows after it", () => {
    // Same root cause as the mispairing: `undefined` had meant both "end of the list"
    // and "this entry was not a string", so one bad row read as "everything after me
    // dropped" and the floor replaced real advice (gate 2, 2026-09-13). Measured then:
    // `buildFailureEnvelope("X", [{}, {action:"real advice"}])` returned only the
    // floor line.
    withEnv({}, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      const out = buildFailureEnvelope("X", [
        {} as unknown as TryNextAction,
        { action: "real advice" },
      ]).if_unexpected.try_next;
      expect(out).toEqual([{ action: "real advice" }]);
    });
    // And a non-string never reaches the wire, where the type says `string[]`.
    withEnv({}, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      const flat = toToolFailure(
        new ToolFailureError("X", {
          displayMessage: "x",
          suggest: [null as unknown as string, "real advice"],
        }),
      );
      expect(flat.suggest).toEqual(["real advice"]);
    });
  });

  it("survives a row that is not an object at all, and does not take a good row with it", () => {
    // GATE 2, 2026-09-13. The non-string guard is INSIDE the renderer, and
    // `renderTryNext` reached the row before it: `tryNext.map((row) => row.action)`
    // dereferenced first. `[{}]` was handled and `[null]` threw
    // `Cannot read properties of null` — the identical species, through a door the
    // guard never saw. Measured on the built code, `[{action:"keep me"}, null]` threw
    // too, so a GOOD line went down with the bad one: the refusal, its code and its
    // siblings, which is the exact cost this module's no-throw rule exists to avoid.
    withEnv({}, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      for (const bad of [null, undefined]) {
        expect(() =>
          buildFailureEnvelope("X", [bad as unknown as TryNextAction]),
        ).not.toThrow();
      }
      const out = buildFailureEnvelope("X", [
        { action: "keep me", args: { k: 1 } },
        null as unknown as TryNextAction,
      ]).if_unexpected.try_next;
      expect(out).toEqual([{ action: "keep me", args: { k: 1 } }]);
    });
    // AND THE CONTAINER, which is where this species stops. Three gate rounds each
    // moved the same guard one expression up this road - `[{}]` reached `.replace`,
    // `[null]` reached `.action`, `undefined` reached `.map`. Guarding the instance a
    // third time invites a fourth round; the cell is written against the CONTAINER so
    // that it covers the shape rather than the example.
    withEnv({}, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      for (const notAList of [undefined, null, "rows", 7, {}]) {
        expect(() =>
          buildFailureEnvelope("X", notAList as unknown as TryNextAction[]),
        ).not.toThrow();
        expect(
          buildFailureEnvelope("X", notAList as unknown as TryNextAction[]).if_unexpected
            .try_next,
        ).toEqual([]);
      }
    });
    // ON BOTH ROADS. The envelope road was guarded and its twin was not, in the same
    // commit whose comment said "guarding the container ends it" (gate 2, 2026-09-13,
    // seventh round). `toToolFailure` takes a plain object and is exported, so the
    // door is the same one. The string case is the one that needed a cell most: it
    // neither threw nor stayed silent — `for...of` walked the sentence and shipped it
    // to the caller one character per line, which no red would have shown.
    withEnv({}, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      for (const notAList of [null, "some advice", 7, {}]) {
        expect(() =>
          toToolFailure({
            name: "X",
            displayMessage: "m",
            suggest: notAList,
          } as unknown as ToolFailureError),
        ).not.toThrow();
        expect(
          toToolFailure({
            name: "X",
            displayMessage: "m",
            suggest: notAList,
          } as unknown as ToolFailureError).suggest,
        ).toBeUndefined();
      }
    });
    // AND AT THE MODULE, which is where the guard finally sits. The two callers each
    // held their own copy, so the exported doors were still open: a string is
    // iterable, and `renderAdviceForCaller("some advice")` walked it (gate 2,
    // 2026-09-13, eighth round). The doc names three `ok:true` roads as future
    // callers of this seam; each would have had to re-derive the same guard.
    withEnv({}, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      expect(renderAdviceForCaller("some advice" as unknown as string[])).toEqual([]);
      expect(renderAdviceEachForCaller(7 as unknown as string[])).toEqual([]);
      // The control: a real list still renders, so an over-eager guard is not what
      // makes the two assertions above pass.
      expect(renderAdviceForCaller(["a real line"])).toEqual(["a real line"]);
    });
    // A PLAIN STRING ROW, which is the shape the container guard did not cover and the
    // one most likely to arrive: the flat road's sibling field IS `string[]`, so a
    // caller moving a `suggest` array into `options.tryNext` writes exactly this.
    // Measured before the fix: `["do this"]` answered `[]` — every line gone, and no
    // floor, because a mapped `undefined` is correctly not a withheld sentence. `main`
    // shipped the strings, so this branch was WORSE there (gate 2, tenth round).
    withEnv({}, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      expect(
        buildFailureEnvelope("X", ["do this"] as unknown as TryNextAction[]).if_unexpected
          .try_next,
      ).toEqual(["do this"]);
      expect(
        buildFailureEnvelope("X", [
          "do this",
          { action: "and this" },
        ] as unknown as TryNextAction[]).if_unexpected.try_next,
      ).toEqual(["do this", { action: "and this" }]);
    });
    // …and it goes through the seam like any other line, rather than being waved past.
    withEnv({ [KEY]: "1" }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      expect(
        buildFailureEnvelope("X", [
          "Save it with {tool:credential_store}",
        ] as unknown as TryNextAction[]).if_unexpected.try_next,
      ).toEqual([{ action: ADVICE_WITHHELD_FLOOR }]);
    });
  });

  it("does not blame the configuration for a caller's mistake", () => {
    // The floor's sentence NAMES A CAUSE - "No recovery is available in this
    // configuration". That is true when real advice was dropped for want of a
    // provider, and false when the caller passed entries that never carried a
    // sentence. Measured before the fix (gate 2, 2026-09-13):
    // `buildFailureEnvelope("X", [{}])` answered the floor line, so a programming
    // error was reported to the caller as a fact about their environment - and the
    // real cause was hidden behind a plausible one.
    withEnv({}, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      const envelope = buildFailureEnvelope("X", [{} as unknown as TryNextAction]);
      expect(envelope.if_unexpected.try_next).toEqual([]);
      const flat = toToolFailure(
        new ToolFailureError("X", {
          displayMessage: "x",
          suggest: [null as unknown as string],
        }),
      );
      expect(flat.suggest).toBeUndefined();
    });
    // THE CONTROL, and it is the half that makes the cell mean anything: a REAL line
    // dropped by the configuration still buys the floor. Without this, deleting the
    // floor entirely would pass the assertions above.
    withEnv({ [KEY]: "1" }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      expect(
        buildFailureEnvelope("X", [{ action: "Save it with {tool:credential_store}" }])
          .if_unexpected.try_next,
      ).toEqual([{ action: ADVICE_WITHHELD_FLOOR }]);
      const flat = toToolFailure(
        new ToolFailureError("X", {
          displayMessage: "x",
          suggest: ["Save it with {tool:credential_store}"],
        }),
      );
      expect(flat.suggest).toEqual([ADVICE_WITHHELD_FLOOR]);
    });
  });

  it("says the SAME floor sentence on both roads, from one constant", () => {
    // The floor exists because the two roads answered differently. Writing the
    // sentence twice would have left that fixed by hand and re-breakable by a
    // one-sided reword, with every cell green (gate 2, 2026-09-13).
    withEnv({ [KEY]: "1" }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      const dropped = ["Run {tool:credential_store} to save it"];
      const flat = toToolFailure(
        new ToolFailureError("KeyLockerConsentRequired", { displayMessage: "c", suggest: dropped }),
      );
      const env = buildFailureEnvelope("KeyLockerConsentRequired", dropped.map((action) => ({ action })));
      expect(flat.suggest).toEqual([ADVICE_WITHHELD_FLOOR]);
      expect(env.if_unexpected.try_next).toEqual([{ action: ADVICE_WITHHELD_FLOOR }]);
    });
  });

  it("moves NO byte of a line that carries no placeholder, on either road", () => {
    // The other half. Today every shipped advice line is this case, which is why the
    // Windows measurement expects byte identity for the whole corpus.
    const lines = [
      "Re-run desktop_discover and act on the fresh entity",
      "Call key_locker({action:'launch_console'}) to get the paneId back",
      "run_macro({tool:\"screenshot\", args:{}}) is the product's own syntax",
    ];
    for (const corner of [{ [V2]: undefined }, { [V2]: "1" }]) {
      withEnv(corner, () => {
        captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
        expect(renderAdviceForCaller(lines)).toEqual(lines);
        const flat = toToolFailure(
          new ToolFailureError("ToolError", { displayMessage: "x", suggest: lines }),
        );
        expect(flat.suggest).toEqual(lines);
        const env = buildFailureEnvelope("ToolError", lines.map((action) => ({ action })));
        expect(env.if_unexpected.try_next).toEqual(lines.map((action) => ({ action })));
      });
    }
  });

  it("keeps the other fields of a try_next row when only its text resolves", () => {
    withEnv({ [V2]: "1" }, () => {
      captureAdviceConfiguration(adviceConfigurationFromEnv(process.env));
      // Typed, not cast: `as never` silenced the checker on this call, so a change to
      // `TryNextAction` or to the signature would not have reddened the cell that
      // exists to pin the row's other fields (gate 2, 2026-09-13).
      const row: TryNextAction = {
        action: "Run {tool:list_window_titles}",
        args: { a: 1 },
        confidence: "high",
      };
      const env = buildFailureEnvelope("WindowNotFound", [row]);
      expect(env.if_unexpected.try_next).toEqual([
        { action: "Run get_windows", args: { a: 1 }, confidence: "high" },
      ]);
    });
  });
});
