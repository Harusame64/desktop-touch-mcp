/**
 * tests/unit/path-class-contract/eslint-no-tool-failure-shape.test.ts
 * — ADR-021 Phase 4 PR-P4-1.
 *
 * Pins the custom ESLint rule `no-tool-failure-shape-direct-construct` (the
 * Option B structural enforcement): hand-built failure wire literals
 * (`{ ok:false, ..., error }` as a `fail()` / `JSON.stringify()` argument) are
 * rejected, while the sanctioned presenter family (failWith / failCode /
 * failArgs / fail(toToolFailure(...))) and non-failure shapes are allowed.
 *
 * Uses ESLint's RuleTester wired into vitest so the rule's accept/reject
 * contract is verified directly (espree default parser — the rule only touches
 * plain-ESTree nodes shared by JS and TS).
 */

import { afterAll, describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../../../eslint-rules/no-tool-failure-shape-direct-construct.mjs";

// Wire RuleTester's lifecycle hooks into vitest.
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run("no-tool-failure-shape-direct-construct", rule, {
  valid: [
    // Sanctioned presenter family.
    'failWith(new Error("boom"), "keyboard");',
    'failCode("ElementNotInViewport", "msg", { suggest: ["a"], context: { selector: "#x" } });',
    'failArgs("bad arg", "desktop_act");',
    'fail(toToolFailure(errorFromMessage(e, "tool", ctx)));',
    // `fail(variable)` — not a literal at the emission point.
    "fail(failureObject);",
    // Internal discriminated-union returns have no `error` key → not the wire shape.
    'const r = { ok: false, reason: "entity_not_found" };',
    'fail({ ok: false, reason: "x" });',
    "JSON.stringify({ ok: false, errorResult: r });",
    // Success payloads.
    "JSON.stringify({ ok: true, data: 1 });",
    'fail({ ok: true, value: "x" });',
  ],
  invalid: [
    {
      code: 'fail({ ok: false, code: "X", error: "y" });',
      errors: [{ messageId: "directConstruct" }],
    },
    {
      code: 'fail({ ok: false, error: "y", suggest: ["a"] });',
      errors: [{ messageId: "directConstruct" }],
    },
    {
      code: 'JSON.stringify({ ok: false, error: "Window not found" });',
      errors: [{ messageId: "directConstruct" }],
    },
    {
      // The macro / (D) content-block pattern (pretty-printed).
      code: 'JSON.stringify({ ok: false, error: "v2 disabled" }, null, 2);',
      errors: [{ messageId: "directConstruct" }],
    },
  ],
});
