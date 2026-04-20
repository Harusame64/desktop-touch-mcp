/**
 * tests/unit/browser-eval-iife.test.ts
 *
 * Unit tests for prepareBrowserEvalExpression, isAlreadyWrappedIife, and
 * canParseAsExpression. No browser or CDP connection required.
 */

import { describe, it, expect } from "vitest";
import {
  canParseAsExpression,
  isAlreadyWrappedIife,
  prepareBrowserEvalExpression,
} from "../../src/tools/browser-eval-helpers.js";

// ── canParseAsExpression ──────────────────────────────────────────────────────

describe("canParseAsExpression", () => {
  it("returns true for a simple expression", () => {
    expect(canParseAsExpression("document.title")).toBe(true);
  });

  it("returns true for a numeric literal", () => {
    expect(canParseAsExpression("42")).toBe(true);
  });

  it("returns true for an IIFE expression", () => {
    expect(canParseAsExpression("(() => 1)()")).toBe(true);
  });

  it("returns false for a statement with const declaration", () => {
    expect(canParseAsExpression("const x = 1; x")).toBe(false);
  });

  it("returns false for a statement with return", () => {
    expect(canParseAsExpression("const x = 1; return x;")).toBe(false);
  });

  it("returns false for a multi-statement block", () => {
    expect(canParseAsExpression("let a = 1; let b = 2; a + b")).toBe(false);
  });
});

// ── isAlreadyWrappedIife ──────────────────────────────────────────────────────

describe("isAlreadyWrappedIife", () => {
  it("returns true for a standalone arrow IIFE", () => {
    expect(isAlreadyWrappedIife("(() => 1)()")).toBe(true);
  });

  it("returns true for a standalone async arrow IIFE", () => {
    expect(isAlreadyWrappedIife("(async () => 1)()")).toBe(true);
  });

  it("returns true for a standalone async function IIFE", () => {
    expect(isAlreadyWrappedIife("(async function() { return 1; })()")).toBe(true);
  });

  it("returns true for a standalone function IIFE", () => {
    expect(isAlreadyWrappedIife("(function() { return 1; })()")).toBe(true);
  });

  it("returns true for an IIFE with leading semicolon", () => {
    expect(isAlreadyWrappedIife(";(() => 1)()")).toBe(true);
  });

  it("returns true for an IIFE with trailing semicolon", () => {
    expect(isAlreadyWrappedIife("(() => 1)();")).toBe(true);
  });

  it("returns false for a plain expression", () => {
    expect(isAlreadyWrappedIife("document.title")).toBe(false);
  });

  it("returns false for an IIFE followed by top-level const (not standalone)", () => {
    expect(isAlreadyWrappedIife("(() => 1)(); const x = 2; x")).toBe(false);
  });

  it("returns false for a statement-shaped snippet", () => {
    expect(isAlreadyWrappedIife("const x = 1; x")).toBe(false);
  });
});

// ── prepareBrowserEvalExpression ──────────────────────────────────────────────

describe("prepareBrowserEvalExpression", () => {
  it("passes through a standalone IIFE unchanged", () => {
    const expr = "(() => 42)()";
    expect(prepareBrowserEvalExpression(expr)).toBe(expr);
  });

  it("wraps a simple expression in expression-form IIFE", () => {
    const result = prepareBrowserEvalExpression("document.title");
    expect(result).toBe(`;(async () => (\ndocument.title\n))()`);
  });

  it("wraps a numeric literal in expression-form IIFE", () => {
    const result = prepareBrowserEvalExpression("42");
    expect(result).toBe(`;(async () => (\n42\n))()`);
  });

  it("wraps a statement-shaped snippet with eval-based wrapper", () => {
    const result = prepareBrowserEvalExpression("const x = 1; x");
    expect(result).toContain("eval(");
    expect(result).toContain(JSON.stringify("const x = 1; x"));
  });

  it("eval-based wrapper includes EvalError in catch condition", () => {
    const result = prepareBrowserEvalExpression("const x = 1; x");
    expect(result).toContain('__mcpEvalError.name === "EvalError"');
  });

  it("eval-based wrapper includes SyntaxError in catch condition", () => {
    const result = prepareBrowserEvalExpression("const x = 1; x");
    expect(result).toContain("__mcpEvalError instanceof SyntaxError");
  });

  it("wraps a snippet with explicit return in eval-based wrapper", () => {
    const result = prepareBrowserEvalExpression("const x = 42; return x;");
    expect(result).toContain("eval(");
  });

  it("does not double-wrap an IIFE followed by top-level declarations", () => {
    const snippet = "(() => 1)(); const v = 42; v";
    const result = prepareBrowserEvalExpression(snippet);
    // Must be wrapped (not passed through), so eval or IIFE block path
    expect(result).not.toBe(snippet);
    expect(result).toContain("async");
  });

  it("eval-based wrapper contains the fallback IIFE block for CSP environments", () => {
    const expr = "const x = 1; x";
    const result = prepareBrowserEvalExpression(expr);
    // The fallback IIFE block should embed the original expression
    expect(result).toContain(expr);
    // The outer wrapper should be there
    expect(result).toMatch(/\(async \(\) => \{/);
  });
});
