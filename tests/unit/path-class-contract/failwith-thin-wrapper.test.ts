/**
 * tests/unit/path-class-contract/failwith-thin-wrapper.test.ts
 * — ADR-021 Phase 2 PR-P2-2 (Plan: desktop-touch-mcp-internal §3.3.2 PR-P2-2).
 *
 * PR-P2-2 rewrites `failWith` as a thin wrapper over the B′ presenter family:
 *
 *   failWith(err, toolName, context)
 *     ≡ fail(toToolFailure(errorFromMessage(err, toolName, context)))
 *
 * The risk this file guards is the TAUTOLOGY TRAP: after the flip, the PR-P2-0
 * equivalence test (`failWith(...)` vs `toToolFailure(errorFromMessage(...))`)
 * compares two expressions that are now the SAME code path, so it can no longer
 * catch a regression (cf. memory feedback_opus_contract_truth_sweep). The pins
 * below are therefore built INDEPENDENTLY of the production composition:
 *
 *   Layer A — FROZEN GOLDEN: the exact wire bytes `failWith` emits for a matrix
 *     of inputs covering every context-shape the real callsites use. Expected
 *     values are hand-built object/string literals (NOT routed through
 *     toToolFailure / errorFromMessage), so reverting the thin-wrapper flip — or
 *     breaking the presenter / factory underneath it — makes these fail. Suggest
 *     content is sourced via `getSuggestsForCode` (the SSOT accessor), not frozen
 *     literally, so a SUGGESTS dictionary edit moves the dict and this test
 *     together rather than silently (PR #373 Codex P2 discipline).
 *   Layer B — SHAPE COVERAGE: asserts the context-shape space discovered across
 *     all 176 real callsites by the codemod-fixture extractor
 *     (tests/fixtures/failwith-callsite-shapes.json) is a subset of the shapes
 *     Layer A pins, so the representative matrix genuinely covers production and
 *     a future callsite introducing a NEW shape fails until a golden is added.
 *
 * @see scripts/extract-failwith-shape-fixtures.mjs   fixture extractor + CI gate
 * @see tests/unit/path-class-contract/to-tool-failure-payload.test.ts  PR-P2-0 layers
 * @see src/tools/_errors.ts  failWith / toToolFailure / errorFromMessage
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  failWith,
  errorFromMessage,
  toToolFailure,
  getSuggestsForCode,
} from "../../../src/tools/_errors.js";
import { fail } from "../../../src/tools/_types.js";

/** Extract the single JSON text block `failWith` (via `fail`) emits. */
function wireText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected a text content block");
  }
  return block.text;
}

// ── Layer A: frozen golden over the real-callsite context-shape space ──────────
//
// Each case: a (thrown, tool, context) input + the EXACT wire bytes `failWith`
// must emit. `expected` is constructed by hand (literal string or hand-built
// object → JSON.stringify), never via the production composition, so it survives
// — and detects — a revert of the thin-wrapper flip.

describe("PR-P2-2 layer A: failWith frozen golden (revert-proof, non-tautological)", () => {
  it("S1 newError(unclassified) + no context → ToolError, no suggest, no context", () => {
    expect(wireText(failWith(new Error("internal state xyzzy"), "keyboard"))).toBe(
      '{"ok":false,"code":"ToolError","error":"keyboard failed: internal state xyzzy"}',
    );
  });

  it("S2 bare-string thrown (non-Error) + no context → String() normalization", () => {
    expect(wireText(failWith("internal state xyzzy", "browser_form"))).toBe(
      '{"ok":false,"code":"ToolError","error":"browser_form failed: internal state xyzzy"}',
    );
  });

  it("S3 newError(classified) → code + suggest flows through (suggest via SSOT accessor)", () => {
    const expected = JSON.stringify({
      ok: false,
      code: "WindowNotFound",
      error: "focus_window failed: window not found",
      suggest: getSuggestsForCode("WindowNotFound"),
    });
    expect(getSuggestsForCode("WindowNotFound").length).toBeGreaterThan(0); // guard: real classified case
    expect(wireText(failWith(new Error("window not found"), "focus_window"))).toBe(expected);
  });

  it("S4 object-literal context, plain (non-hoisted) keys → nested under context", () => {
    expect(
      wireText(failWith(new Error("internal state xyzzy"), "click_element", { selector: "#x", attempt: 2 })),
    ).toBe(
      '{"ok":false,"code":"ToolError","error":"click_element failed: internal state xyzzy","context":{"selector":"#x","attempt":2}}',
    );
  });

  it("S5 object-literal context, all 3 root-hoisted keys + nested → split + root spread + key order", () => {
    // Iteration order (Object.entries): hints → _perceptionForPost → _richForPost (all hoisted to root)
    // then note (nested). Pins the wire key order: ok, code, error, context, ...rootExtras.
    expect(
      wireText(
        failWith(new Error("internal state xyzzy"), "mouse_click", {
          hints: { v: 1 },
          _perceptionForPost: { p: 1 },
          _richForPost: { r: 1 },
          note: "n",
        }),
      ),
    ).toBe(
      '{"ok":false,"code":"ToolError","error":"mouse_click failed: internal state xyzzy",' +
        '"context":{"note":"n"},"hints":{"v":1},"_perceptionForPost":{"p":1},"_richForPost":{"r":1}}',
    );
  });

  it("S6 empty thrown message → 'tool failed: ' preserved (not coalesced)", () => {
    expect(wireText(failWith(new Error(""), "scroll"))).toBe(
      '{"ok":false,"code":"ToolError","error":"scroll failed: "}',
    );
  });

  it("S7 context whose own keys are literally named 'suggest'/'context' → stay nested, not promoted", () => {
    // keyboard.ts:812-style callsite: the caller's `suggest`/`context` keys are
    // NOT ROOT_HOISTED_KEYS, so they nest under `context` and never become the
    // top-level `suggest`/`context` envelope fields.
    expect(
      wireText(failWith(new Error("internal state xyzzy"), "keyboard:type", { suggest: ["x"], context: {} })),
    ).toBe(
      '{"ok":false,"code":"ToolError","error":"keyboard:type failed: internal state xyzzy",' +
        '"context":{"suggest":["x"],"context":{}}}',
    );
  });

  it("S8 non-Error object thrown → String() coercion to '[object Object]'", () => {
    expect(wireText(failWith({ weird: true }, "desktop_act"))).toBe(
      '{"ok":false,"code":"ToolError","error":"desktop_act failed: [object Object]"}',
    );
  });
});

// ── Layer B: the frozen matrix covers every real-callsite context shape ────────
//
// The extractor classifies each of the 176 callsites' context argument into one
// of a small set of shapes. Layer A pins one golden per shape; this asserts the
// extractor found nothing OUTSIDE that set, so the sampling is exhaustive over
// shapes (a new callsite with a novel shape fails here until a golden is added).

const KNOWN_CONTEXT_SHAPES = new Set([
  "none", // failWith(err, tool)                      → S1/S2/S3/S6/S8
  "object-plain", // failWith(err, tool, { ...nonHoisted })   → S4/S7
  "object-hoisted", // failWith(err, tool, { _perceptionForPost|_richForPost|hints, ... }) → S5
  "dynamic", // failWith(err, tool, someVariable) — runtime value; normalization covered by S1/S8
]);

describe("PR-P2-2 layer B: codemod-fixture shape coverage", () => {
  it("every context shape across all 176 callsites is one Layer A pins", () => {
    const fixturePath = fileURLToPath(
      new URL("../../fixtures/failwith-callsite-shapes.json", import.meta.url),
    );
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      totalCallsites: number;
      contextShapes: string[];
    };
    expect(fixture.totalCallsites).toBeGreaterThan(0);
    for (const shape of fixture.contextShapes) {
      expect(KNOWN_CONTEXT_SHAPES.has(shape), `unknown context shape: ${shape}`).toBe(true);
    }
  });
});

// ── Layer C: documents the flip (intentionally tautological after PR-P2-2) ─────
//
// Kept as living documentation that `failWith` IS the composition. It cannot
// catch a regression on its own post-flip (both sides share code) — that job is
// Layer A's. Pre-flip it proved the equivalence; post-flip it proves the wrapper
// delegates rather than re-implements.

describe("PR-P2-2 layer C: failWith delegates to the presenter family", () => {
  it("failWith(v,t,c) === fail(toToolFailure(errorFromMessage(v,t,c)))", () => {
    const v = new Error("window not found");
    expect(wireText(failWith(v, "focus_window", { detail: "d" }))).toBe(
      wireText(fail(toToolFailure(errorFromMessage(v, "focus_window", { detail: "d" })))),
    );
  });
});
