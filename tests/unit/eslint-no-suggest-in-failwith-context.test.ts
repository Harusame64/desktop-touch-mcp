/**
 * ADR-029 OQ8 — the lint rule that keeps the fix from regressing.
 *
 * `no-suggest-in-failwith-context` bans `suggest` / `context` keys in the third
 * argument of `failWith` / `errorFromMessage` / `failArgs`, where they nest at
 * `context.suggest` / `context.context` instead of the root the model reads.
 *
 * Codex R1 P2: matching the callee's textual name alone let an aliased import
 * (`import { failWith as f }`) recreate the malformed envelope. The rule now
 * also resolves the callee back to a binding imported from `_errors`, so the
 * alias — and a local re-alias of one, at any scope depth — is caught. These
 * cases pin both directions, including that the alias chain terminates.
 */
import { describe, it, expect } from "vitest";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import rule from "../../eslint-rules/no-suggest-in-failwith-context.mjs";

const linter = new Linter();
const RULE_ID = "adr029/no-suggest-in-failwith-context";
const config = {
  plugins: { adr029: { rules: { "no-suggest-in-failwith-context": rule } } },
  languageOptions: { ecmaVersion: 2023 as const, sourceType: "module" as const },
  rules: { [RULE_ID]: "error" },
} as unknown as Parameters<Linter["verify"]>[1];

/** Violations of THIS rule only — a stray message would mean a broken fixture. */
const violations = (code: string) => {
  // A `.js` filename so the flat config matches without the TS parser; the
  // fixtures are plain JS syntax, and the rule reads no type information.
  const messages = linter.verify(code, config, "src/tools/fixture.js");
  const stray = messages.filter((m) => m.ruleId !== RULE_ID);
  expect(stray, `unexpected non-rule messages: ${JSON.stringify(stray)}`).toHaveLength(0);
  return messages;
};

const IMPORT = 'import { failWith } from "./_errors.js";\n';

describe("no-suggest-in-failwith-context — flagged shapes", () => {
  const flagged: [string, string][] = [
    ["suggest at the call site", `${IMPORT}failWith(e, "t", { suggest: ["x"] });`],
    ["nested context record", `${IMPORT}failWith(e, "t", { context: { windowTitle: "w" } });`],
    ["computed literal key", `${IMPORT}failWith(e, "t", { ["suggest"]: [] });`],
    ["namespace member call", 'import * as errors from "./_errors.js";\nerrors.failArgs("m", "t", { suggest: [] });'],
    // The Codex R1 P2 hole and its two variants.
    ["aliased import", 'import { failWith as f } from "./_errors.js";\nf(e, "t", { suggest: ["x"] });'],
    [
      "re-alias of an aliased import",
      'import { failWith as f } from "./_errors.js";\nconst g = f;\ng(e, "t", { context: { a: 1 } });',
    ],
    [
      "alias resolved from an inner scope",
      'import { errorFromMessage as em } from "../tools/_errors.js";\n' +
        'function h() { const q = em; return q("m", "t", { suggest: [] }); }',
    ],
  ];

  it.each(flagged)("flags %s", (_name, code) => {
    expect(violations(code)).toHaveLength(1);
  });
});

describe("no-suggest-in-failwith-context — shapes that must stay clean", () => {
  const clean: [string, string][] = [
    // failCode's third argument really is an options bag.
    ["failCode's options bag", 'import { failCode } from "./_errors.js";\nfailCode("C", e, { suggest: ["x"] });'],
    ["a flat context record", `${IMPORT}failWith(e, "t", { windowTitle: "w", hwnd: 1 });`],
    ["a computed identifier key", `${IMPORT}const k = "suggest";\nfailWith(e, "t", { [k]: [] });`],
    // Termination guard: resolving `f` must not recurse forever.
    ["a self-referential alias", 'const f = f;\nf(e, "t", { suggest: [] });'],
    ["an unrelated aliased helper", 'import { emit as f } from "./other.js";\nf(e, "t", { suggest: [] });'],
  ];

  it.each(clean)("leaves %s alone", (_name, code) => {
    expect(violations(code)).toHaveLength(0);
  });

  // Documented over-approximation: a same-named helper from another module is
  // still flagged, because a missed alias is the costlier error. Pinned so the
  // trade-off is a decision, not a surprise.
  it("still flags a same-named import from an unrelated module (deliberate)", () => {
    expect(violations('import { failWith } from "./other.js";\nfailWith(e, "t", { suggest: [] });')).toHaveLength(1);
  });
});

// The cases above run through the default parser, which cannot express a TS
// cast — and a cast around the third argument was a real escape (Round 3 P2-6).
// These run the same rule the way production does: typescript-eslint's parser
// on a `.ts` filename.
describe("no-suggest-in-failwith-context — under the TypeScript parser", () => {
  const tsConfig = {
    // A `.ts` filename only matches when the config says so — the default
    // glob covers `.js` alone, and a mismatch surfaces as a config warning
    // rather than a rule report (which the stray-message guard catches).
    files: ["**/*.ts"],
    plugins: { adr029: { rules: { "no-suggest-in-failwith-context": rule } } },
    languageOptions: { parser: tseslint.parser, sourceType: "module" as const },
    rules: { [RULE_ID]: "error" },
  } as unknown as Parameters<Linter["verify"]>[1];

  const tsViolations = (code: string) => {
    const messages = linter.verify(code, tsConfig, "src/tools/fixture.ts");
    const stray = messages.filter((m) => m.ruleId !== RULE_ID);
    expect(stray, `unexpected non-rule messages: ${JSON.stringify(stray)}`).toHaveLength(0);
    return messages;
  };

  const TS_IMPORT = 'import { failWith } from "./_errors.js";\ndeclare const e: Error;\n';

  it.each([
    ["an `as` cast", `${TS_IMPORT}failWith(e, "t", { suggest: [] } as Record<string, unknown>);`],
    ["a `satisfies` expression", `${TS_IMPORT}failWith(e, "t", { context: { a: 1 } } satisfies object);`],
    ["a non-null assertion", `${TS_IMPORT}failWith(e, "t", { suggest: [] }!);`],
    ["an alias, under this parser too", 'import { failWith as f } from "./_errors.js";\ndeclare const e: Error;\nf(e, "t", { suggest: [] });'],
  ])("flags %s", (_name, code) => {
    expect(tsViolations(code)).toHaveLength(1);
  });

  it("leaves a flat context record alone", () => {
    expect(tsViolations(`${TS_IMPORT}failWith(e, "t", { windowTitle: "w" } as Record<string, unknown>);`)).toHaveLength(0);
  });
});
