/**
 * tests/unit/path-class-contract/eslint-no-tool-failure-shape.test.ts
 * — ADR-021 Phase 4 PR-P4-1.
 *
 * Pins the custom ESLint rule `no-tool-failure-shape-direct-construct` (the
 * Option B structural enforcement): hand-built failure wire literals
 * (`{ ok:false, ... }` at a `fail()` / `JSON.stringify()` argument) are rejected,
 * while the sanctioned presenter family (failWith / failCode / failArgs /
 * fail(toToolFailure(...))) and non-failure shapes are allowed.
 *
 * Uses ESLint's RuleTester (wired into vitest) under the @typescript-eslint
 * parser so TS-only wrappers like `{ ... } as ToolFailure` are exercised — that
 * wrapper was the Codex PR #381 P1 bypass.
 */

import { afterAll, describe, it } from "vitest";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "../../../eslint-rules/no-tool-failure-shape-direct-construct.mjs";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: "module" },
});

ruleTester.run("no-tool-failure-shape-direct-construct", rule, {
  valid: [
    // Sanctioned presenter family.
    'failWith(new Error("boom"), "keyboard");',
    'failCode("ElementNotInViewport", "msg", { suggest: ["a"], context: { selector: "#x" } });',
    'failArgs("bad arg", "desktop_act");',
    'fail(toToolFailure(errorFromMessage(e, "tool", ctx)));',
    // `fail(variable)` — not a literal at the emission point.
    "fail(failureObject);",
    // Success payloads.
    "JSON.stringify({ ok: true, data: 1 });",
    'fail({ ok: true, value: "x" });',
    // Internal discriminated-union return spread into JSON.stringify with no
    // `error` key → not the wire shape (JSON.stringify requires ok:false + error).
    "JSON.stringify({ ok: false, errorResult: r });",
    "JSON.stringify({ ok: false, reason: 'x' });",
    // Scope boundary (Opus Round 1 P2-2 / Codex P2): laundering shapes the simple
    // AST rule intentionally does NOT catch — pinned valid so a future strictening
    // is a deliberate test change. (a) pure variable spread (no literal markers),
    // (b) computed key (not statically `ok: false`).
    "fail({ ...failureBase });",
    'fail({ ["ok"]: false, error: "y" });',
  ],
  invalid: [
    // Direct fail() literal — ok:false alone is the signature (fail() only ever
    // receives presenter output, never a literal).
    {
      code: 'fail({ ok: false, code: "X", error: "y" });',
      errors: [{ messageId: "directConstruct" }],
    },
    {
      code: 'fail({ ok: false, error: "y", suggest: ["a"] });',
      errors: [{ messageId: "directConstruct" }],
    },
    {
      // No error key, but still a hand-built failure literal at fail() — flagged.
      code: 'fail({ ok: false, reason: "x" });',
      errors: [{ messageId: "directConstruct" }],
    },
    {
      // Codex P1: TS assertion wrapper must be unwrapped.
      code: 'fail({ ok: false, error: "y" } as ToolFailure);',
      errors: [{ messageId: "directConstruct" }],
    },
    {
      // Codex P2: literal ok:false + spread for the rest still hand-builds at fail().
      code: "fail({ ok: false, ...errExtra });",
      errors: [{ messageId: "directConstruct" }],
    },
    {
      // Spread of a literal object is inspected (recursion).
      code: 'fail({ ...{ ok: false, error: "y" } });',
      errors: [{ messageId: "directConstruct" }],
    },
    // JSON.stringify hand-built content-block body (requires ok:false + error).
    {
      code: 'JSON.stringify({ ok: false, error: "Window not found" });',
      errors: [{ messageId: "directConstruct" }],
    },
    {
      code: 'JSON.stringify({ ok: false, error: "v2 disabled" }, null, 2);',
      errors: [{ messageId: "directConstruct" }],
    },
    {
      // TS assertion under JSON.stringify too.
      code: 'JSON.stringify({ ok: false, error: "x" } as ToolFailure);',
      errors: [{ messageId: "directConstruct" }],
    },
  ],
});
