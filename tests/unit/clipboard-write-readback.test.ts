/**
 * clipboard-write-readback.test.ts — unit pin for issue #180.
 *
 * Validates the wiring between failWith() and the new
 * ClipboardWriteNotDelivered code without depending on a real Windows
 * clipboard. Run via `vitest --project=unit`.
 *
 * Goals (matrix doc §3.1, §5):
 *   1. failWith(new Error("ClipboardWriteNotDelivered"), ...) classifies to
 *      code === "ClipboardWriteNotDelivered" and pulls the SUGGESTS array
 *      from _errors.ts (SSOT — call sites must NOT pass an inline suggest).
 *   2. SUGGESTS payload includes the matrix doc §5.2 justify keywords
 *      (clipboard manager / DLP / RDP / format conversion) so an LLM
 *      caller has actionable next steps.
 *   3. The lower-cased message-substring match in classify() does not
 *      collide with neighbouring codes (BackgroundInputNotDelivered).
 */

import { describe, it, expect } from "vitest";
import { failWith, getSuggestsForCode } from "../../src/tools/_errors.js";

function parseFailure(r: { content: Array<{ type: string; text?: string }> }): {
  ok: boolean;
  code: string;
  suggest?: string[];
  context?: Record<string, unknown>;
} {
  const text = r.content[0]?.text;
  if (!text) throw new Error("missing failure body");
  return JSON.parse(text);
}

describe("ClipboardWriteNotDelivered (#180)", () => {
  it("classify() returns ClipboardWriteNotDelivered for a thrown Error of the same name", () => {
    const failure = parseFailure(
      failWith(new Error("ClipboardWriteNotDelivered"), "clipboard:write", {
        context: { hint: "post-write read-back mismatch" },
      })
    );
    expect(failure.ok).toBe(false);
    expect(failure.code).toBe("ClipboardWriteNotDelivered");
    expect(Array.isArray(failure.suggest)).toBe(true);
    expect(failure.suggest!.length).toBeGreaterThan(0);
  });

  it("SUGGESTS payload covers the matrix doc §5.2 failure modes", () => {
    const suggests = getSuggestsForCode("ClipboardWriteNotDelivered");
    expect(suggests.length).toBeGreaterThanOrEqual(4);
    // matrix doc §5.2 lists clipboard manager, DLP, RDP/Citrix, format
    // conversion — make sure the SUGGESTS dictionary surfaces each.
    const joined = suggests.join(" \n ").toLowerCase();
    expect(joined).toContain("clipboard manager");
    expect(joined).toContain("dlp");
    expect(joined).toContain("rdp");
    expect(joined).toContain("format conversion");
  });

  it("does not collide with BackgroundInputNotDelivered classification", () => {
    const bg = parseFailure(failWith(new Error("BackgroundInputNotDelivered"), "terminal:send"));
    const cb = parseFailure(failWith(new Error("ClipboardWriteNotDelivered"), "clipboard:write"));
    expect(bg.code).toBe("BackgroundInputNotDelivered");
    expect(cb.code).toBe("ClipboardWriteNotDelivered");
    // The two SUGGESTS arrays must be distinct objects (no accidental
    // shared reference / fall-through dictionary lookup).
    expect(bg.suggest).not.toEqual(cb.suggest);
  });

  it("supports the 'clipboard write not delivered' (spaced) message variant", () => {
    // classify() does a lower-case substring match on both the camel-case
    // identifier and the human-readable spaced variant. Pin both shapes
    // so a future refactor cannot drop one of them silently.
    const failure = parseFailure(
      failWith(new Error("clipboard write not delivered: race detected"), "clipboard:write")
    );
    expect(failure.code).toBe("ClipboardWriteNotDelivered");
  });
});
