/**
 * tests/unit/path-class-contract/to-tool-failure-payload.test.ts
 * — ADR-021 Phase 2 PR-P2-0 (Plan: desktop-touch-mcp-internal §3.3.2 PR-P2-0).
 *
 * Establishes the flat-failure PRESENTER FAMILY (design B′):
 *
 *   errorFromMessage(message, toolName, context) → ToolFailureError   (model / SSOT)
 *   toToolFailure(err)                           → ToolFailure        (flat presenter)
 *
 * `toFailureEnvelope` (the envelope-family presenter) is intentionally NOT
 * touched — the two failure shapes are different render targets of one error
 * model, so each presenter keeps a single narrow return type (one error model,
 * two presenters; cf. RFC 9457 problem-detail object + Effect Data.TaggedError +
 * Rust error-enum-vs-Display). PR-P2-2 routes `failWith` through this presenter;
 * `failWith` itself is unchanged in PR-P2-0.
 *
 * Three layers of pinning:
 *   1. MATRIX — the presenter's flat shape over the 4 payload axes
 *      (toolName / displayMessage / context / rootExtras presence) + suggest
 *      presence + key-order, with FROZEN literals built from explicit
 *      ToolFailureError construction (decoupled from classify()/SUGGESTS, so a
 *      dictionary edit cannot silently move both sides — PR #373 Codex P2).
 *   2. FACTORY — errorFromMessage's classify() code + context split
 *      (root-hoisted keys → rootExtras, rest → nested context).
 *   3. EQUIVALENCE (safety net for the PR-P2-2 flip) — the new path
 *      `fail(toToolFailure(errorFromMessage(m,t,c)))` is byte-for-byte identical
 *      to today's `failWith(new Error(m), t, c)`. This assertion is deliberately
 *      COUPLED to the two production paths (it proves they agree); it is the
 *      opposite role from the frozen-literal matrix above.
 *
 * @see src/errors/typed-errors.ts ToolFailureError / ToolFailurePayload
 * @see src/tools/_errors.ts errorFromMessage / toToolFailure / failWith / classify
 */

import { describe, it, expect } from "vitest";
import {
  errorFromMessage,
  toToolFailure,
  failWith,
} from "../../../src/tools/_errors.js";
import { ToolFailureError } from "../../../src/errors/typed-errors.js";

/** Parse the JSON text block a tool/wrapper returns. */
function parseContent(content: ReadonlyArray<{ type: string; text?: string }>): unknown {
  const block = content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected a text content block");
  }
  return JSON.parse(block.text);
}

// ── Layer 1: presenter shape matrix (frozen literals) ─────────────────────────
//
// `code` is fixed to a neutral "ToolError" and `suggest` is an explicit literal
// so nothing here depends on classify()/SUGGESTS — the matrix pins ONLY the
// presenter's field-presence + key-order behaviour.

describe("PR-P2-0 layer 1: toToolFailure shape matrix (4 payload axes)", () => {
  it("1. code only (no toolName / displayMessage) → error falls back to code", () => {
    expect(toToolFailure(new ToolFailureError("ToolError"))).toEqual({
      ok: false,
      code: "ToolError",
      error: "ToolError",
    });
  });

  it("2. toolName only → 'tool failed: <code>' (displayMessage falls back to code)", () => {
    expect(toToolFailure(new ToolFailureError("ToolError", { toolName: "keyboard" }))).toEqual({
      ok: false,
      code: "ToolError",
      error: "keyboard failed: ToolError",
    });
  });

  it("3. displayMessage only → bare message (no toolName prefix)", () => {
    expect(toToolFailure(new ToolFailureError("ToolError", { displayMessage: "boom" }))).toEqual({
      ok: false,
      code: "ToolError",
      error: "boom",
    });
  });

  it("4. toolName + displayMessage → canonical 'tool failed: message' string", () => {
    expect(
      toToolFailure(new ToolFailureError("ToolError", { toolName: "keyboard", displayMessage: "boom" })),
    ).toEqual({
      ok: false,
      code: "ToolError",
      error: "keyboard failed: boom",
    });
  });

  it("5. + non-empty suggest → suggest present", () => {
    expect(
      toToolFailure(
        new ToolFailureError("ToolError", {
          toolName: "keyboard",
          displayMessage: "boom",
          suggest: ["try A", "try B"],
        }),
      ),
    ).toEqual({
      ok: false,
      code: "ToolError",
      error: "keyboard failed: boom",
      suggest: ["try A", "try B"],
    });
  });

  it("6. + empty suggest → suggest OMITTED (matches failWith's `length > 0` guard)", () => {
    expect(
      toToolFailure(
        new ToolFailureError("ToolError", { toolName: "keyboard", displayMessage: "boom", suggest: [] }),
      ),
    ).toEqual({
      ok: false,
      code: "ToolError",
      error: "keyboard failed: boom",
    });
  });

  it("7. + nested context → context present", () => {
    expect(
      toToolFailure(
        new ToolFailureError("ToolError", {
          toolName: "keyboard",
          displayMessage: "boom",
          context: { selector: "#x", attempt: 2 },
        }),
      ),
    ).toEqual({
      ok: false,
      code: "ToolError",
      error: "keyboard failed: boom",
      context: { selector: "#x", attempt: 2 },
    });
  });

  it("8. full payload → rootExtras spread at root + key order pinned", () => {
    const full = new ToolFailureError("ToolError", {
      toolName: "keyboard",
      displayMessage: "boom",
      suggest: ["s1"],
      context: { k: "v" },
      rootExtras: { hints: { h: 1 } },
    });
    expect(toToolFailure(full)).toEqual({
      ok: false,
      code: "ToolError",
      error: "keyboard failed: boom",
      suggest: ["s1"],
      context: { k: "v" },
      hints: { h: 1 },
    });
    // Key ORDER is wire-significant (JSON.stringify is order-sensitive) — pin it
    // explicitly because toEqual ignores key order.
    expect(JSON.stringify(toToolFailure(full))).toBe(
      '{"ok":false,"code":"ToolError","error":"keyboard failed: boom","suggest":["s1"],"context":{"k":"v"},"hints":{"h":1}}',
    );
  });

  it("preserves an empty displayMessage ('') instead of coalescing to code", () => {
    expect(
      toToolFailure(new ToolFailureError("ToolError", { toolName: "scroll", displayMessage: "" })),
    ).toEqual({
      ok: false,
      code: "ToolError",
      error: "scroll failed: ",
    });
  });
});

// ── Layer 2: errorFromMessage factory (classify + context split) ──────────────

describe("PR-P2-0 layer 2: errorFromMessage factory", () => {
  it("classifies the message into the typed code (name)", () => {
    const err = errorFromMessage("window not found", "focus_window");
    expect(err).toBeInstanceOf(ToolFailureError);
    expect(err.name).toBe("WindowNotFound");
    expect(err.displayMessage).toBe("window not found");
    expect(err.toolName).toBe("focus_window");
    expect(err.suggest).toBeInstanceOf(Array);
    expect(err.suggest!.length).toBeGreaterThan(0); // WindowNotFound has SUGGESTS entries
  });

  it("falls back to ToolError + empty suggest for an unclassifiable message", () => {
    const err = errorFromMessage("unexpected internal state xyzzy", "keyboard");
    expect(err.name).toBe("ToolError");
    expect(err.suggest).toEqual([]);
  });

  it("splits context: ROOT_HOISTED_KEYS → rootExtras, rest → nested context", () => {
    const err = errorFromMessage("element not found", "click_element", {
      _richForPost: { a: 1 },
      _perceptionForPost: { p: 1 },
      hints: { verifyDelivery: true },
      selector: "#x",
      attempt: 2,
    });
    expect(err.rootExtras).toEqual({
      _richForPost: { a: 1 },
      _perceptionForPost: { p: 1 },
      hints: { verifyDelivery: true },
    });
    expect(err.context).toEqual({ selector: "#x", attempt: 2 });
  });

  it("leaves rootExtras / context undefined when no such keys are present", () => {
    const err = errorFromMessage("boom", "keyboard", { onlyNested: 1 });
    expect(err.rootExtras).toBeUndefined();
    expect(err.context).toEqual({ onlyNested: 1 });

    const err2 = errorFromMessage("boom", "keyboard");
    expect(err2.rootExtras).toBeUndefined();
    expect(err2.context).toBeUndefined();
  });
});

// ── Layer 3: failWith equivalence (safety net for the PR-P2-2 flip) ───────────
//
// Proves `fail(toToolFailure(errorFromMessage(m,t,c)))` is byte-for-byte equal
// to today's `failWith(new Error(m), t, c)`. Coupled to both production paths on
// purpose — this is the invariant PR-P2-2 must preserve when it rewrites
// failWith as a thin wrapper.

describe("PR-P2-0 layer 3: failWith ⇔ toToolFailure∘errorFromMessage equivalence", () => {
  const CASES: Array<{ name: string; message: string; tool: string; context?: Record<string, unknown> }> = [
    { name: "classified code, no context", message: "window not found", tool: "focus_window" },
    {
      name: "classified code, nested context only",
      message: "element not found",
      tool: "click_element",
      context: { selector: "#x", attempt: 2 },
    },
    {
      name: "unclassifiable (ToolError + empty suggest), root-hoisted + nested mix",
      message: "unexpected internal state xyzzy",
      tool: "keyboard",
      context: { _richForPost: { a: 1 }, detail: "d" },
    },
    {
      name: "classified code with suggest, all three root-hoisted keys + nested",
      message: "guard failed: zone",
      tool: "mouse_click",
      context: {
        hints: { verifyDelivery: true },
        _perceptionForPost: { p: 1 },
        _richForPost: { r: 1 },
        note: "n",
      },
    },
    { name: "empty thrown message", message: "", tool: "scroll" },
  ];

  for (const c of CASES) {
    it(`${c.name}`, () => {
      const legacy = failWith(new Error(c.message), c.tool, c.context);
      const viaModel = toToolFailure(errorFromMessage(c.message, c.tool, c.context));

      // Structural equality.
      expect(viaModel).toEqual(parseContent(legacy.content));

      // Byte-for-byte JSON equality (key order + omission) — `failWith` wraps via
      // `fail()` which is `JSON.stringify(failure)`, so compare the same way.
      const legacyText = (legacy.content[0] as { text: string }).text;
      expect(JSON.stringify(viaModel)).toBe(legacyText);
    });
  }
});
