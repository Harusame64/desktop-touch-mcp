/**
 * tests/unit/path-class-contract/failcode-sweep.test.ts
 * — ADR-021 Phase 2 PR-P2-3 (Plan: desktop-touch-mcp-internal#7 §3.3.2 step 4).
 *
 * PR-P2-3 routes the hand-built `fail({ ok:false, code, ... })` literals (the
 * §1.3 row C drift surface — failures that bypassed the sanctioned converter)
 * through the B′ presenter family via the new `failCode` helper. `failCode` is
 * the explicit-code sibling of `failWith` (classify-derived) and `failArgs`
 * (fixed InvalidArgs): the handler already knows the typed code, so no message
 * classification is needed, and the bespoke `error` string is emitted verbatim.
 *
 * Layer A pins `failCode`'s rendering contract with FROZEN literals (independent
 * of production composition). Layer B pins that `failCode(<the same code / error
 * / suggest / context the literal carried>)` reproduces the pre-migration wire
 * bytes for representative (C) sites byte-for-byte, so the literal → failCode
 * refactor is bit-equal (snapshot-first discipline).
 *
 * @see src/tools/_errors.ts  failCode / toToolFailure
 */

import { describe, it, expect } from "vitest";
import { failCode } from "../../../src/tools/_errors.js";

/** Extract the single JSON text block `failCode` (via `fail`) emits. */
function wireText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected a text content block");
  }
  return block.text;
}

// ── Layer A: failCode rendering contract (frozen) ─────────────────────────────

describe("PR-P2-3 layer A: failCode shape contract (frozen, key-order + omission)", () => {
  it("code + error only → no suggest, no context", () => {
    expect(wireText(failCode("ToolError", "boom"))).toBe(
      '{"ok":false,"code":"ToolError","error":"boom"}',
    );
  });

  it("emits `error` VERBATIM (no '<tool> failed:' prefix — unlike failWith)", () => {
    expect(wireText(failCode("NavigateFailed", "browser_navigate failed: net::ERR"))).toBe(
      '{"ok":false,"code":"NavigateFailed","error":"browser_navigate failed: net::ERR"}',
    );
  });

  it("+ suggest → present; + context → present; key order ok,code,error,suggest,context", () => {
    expect(
      wireText(failCode("X", "msg", { suggest: ["a", "b"], context: { sel: "#x", n: 2 } })),
    ).toBe(
      '{"ok":false,"code":"X","error":"msg","suggest":["a","b"],"context":{"sel":"#x","n":2}}',
    );
  });

  it("empty suggest → OMITTED (same guard as failWith)", () => {
    expect(wireText(failCode("X", "msg", { suggest: [], context: { a: 1 } }))).toBe(
      '{"ok":false,"code":"X","error":"msg","context":{"a":1}}',
    );
  });

  it("rootExtras spread at root, after context", () => {
    expect(
      wireText(
        failCode("X", "msg", { suggest: ["s"], context: { a: 1 }, rootExtras: { _perceptionForPost: { p: 1 } } }),
      ),
    ).toBe(
      '{"ok":false,"code":"X","error":"msg","suggest":["s"],"context":{"a":1},"_perceptionForPost":{"p":1}}',
    );
  });
});

// ── Layer B: bit-equal with the pre-migration (C) literals ────────────────────
//
// Each expected string is the EXACT wire bytes the hand-built `fail({...})`
// literal produced before PR-P2-3 (read from the pre-migration source). Proves
// the literal → failCode refactor preserves the shape byte-for-byte.

describe("PR-P2-3 layer B: failCode reproduces the (C) literals byte-for-byte", () => {
  it("browser_click ElementNotInViewport (with context) — browser.ts:1010/1048", () => {
    const sel = "#submit";
    expect(
      wireText(
        failCode(
          "ElementNotInViewport",
          `browser_click: element "${sel}" is outside the visible viewport.`,
          {
            suggest: [
              "Element is outside the visible viewport. Scroll it into view first using browser_eval with element.scrollIntoView(), then retry browser_click.",
            ],
            context: { selector: sel },
          },
        ),
      ),
    ).toBe(
      '{"ok":false,"code":"ElementNotInViewport",' +
        '"error":"browser_click: element \\"#submit\\" is outside the visible viewport.",' +
        '"suggest":["Element is outside the visible viewport. Scroll it into view first using browser_eval with element.scrollIntoView(), then retry browser_click."],' +
        '"context":{"selector":"#submit"}}',
    );
  });

  it("TerminalTextPatternUnavailable shape (no-context variant of the contract) — cf. terminal.ts:318", () => {
    expect(
      wireText(
        failCode("TerminalTextPatternUnavailable", "TextPattern not available and no OCR fallback usable", {
          suggest: [
            "Retry with source:'ocr' to force OCR",
            "Verify the window is actually a terminal (Windows Terminal, conhost, PowerShell)",
          ],
        }),
      ),
    ).toBe(
      '{"ok":false,"code":"TerminalTextPatternUnavailable",' +
        '"error":"TextPattern not available and no OCR fallback usable",' +
        '"suggest":["Retry with source:\'ocr\' to force OCR",' +
        '"Verify the window is actually a terminal (Windows Terminal, conhost, PowerShell)"]}',
    );
  });

  it("browser_search runtime-computed code (variable code + suggest) — browser.ts:2159", () => {
    // The handler computes `code` and `suggest` at runtime; failCode takes them as
    // values, which failWith's classify(message) path could not do.
    const code = "ScopeNotFound";
    const suggest = ["Verify the scope CSS selector matches at least one element", "Omit scope to search the full document"];
    expect(
      wireText(failCode(code, "browser_search: ScopeNotFound", { suggest, context: { by: "text", pattern: "x", scope: "#s" } })),
    ).toBe(
      '{"ok":false,"code":"ScopeNotFound","error":"browser_search: ScopeNotFound",' +
        '"suggest":["Verify the scope CSS selector matches at least one element","Omit scope to search the full document"],' +
        '"context":{"by":"text","pattern":"x","scope":"#s"}}',
    );
  });
});
