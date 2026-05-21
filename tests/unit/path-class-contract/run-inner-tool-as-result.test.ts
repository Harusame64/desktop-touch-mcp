/**
 * tests/unit/path-class-contract/run-inner-tool-as-result.test.ts
 * — ADR-021 Phase 3a (Plan: desktop-touch-mcp-internal §3.4).
 *
 * Pins the typed adapter `runInnerToolAsResult` directly via the Result API —
 * the boundary that turns an inner step's `ToolResult` into a
 * `Result<InnerToolOutcome, InnerToolOutcome>` for `run_macro`. The
 * silent-success drift (§1.3 row B: an inner ok:false envelope must be a step
 * failure even without a throw) is now a property of THIS adapter's discriminant;
 * reverting the parse / Ok-Err selection fails these assertions. The end-to-end
 * `run_macro` behaviour stays pinned by run-macro-stop-on-error-inner-envelope.
 *
 * @see src/tools/macro.ts runInnerToolAsResult / InnerToolOutcome
 */

import { describe, it, expect } from "vitest";
import { runInnerToolAsResult } from "../../../src/tools/macro.js";

/** A fake TOOL_REGISTRY entry whose handler returns a single text content block. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textEntry(text: string): any {
  return { schema: { parse: (x: unknown) => x }, handler: async () => ({ content: [{ type: "text", text }] }) };
}

describe("runInnerToolAsResult (ADR-021 Phase 3a adapter)", () => {
  it("ok:true envelope → Result.ok=true, carries the text", async () => {
    const r = await runInnerToolAsResult(textEntry(JSON.stringify({ ok: true, data: 1 })), {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.textLines[0]).toContain('"ok":true');
      expect(r.value.code).toBeUndefined();
      expect(r.value.error).toBeUndefined();
    }
  });

  it("ok:false envelope → Result.ok=false, carries code + error (silent-success → typed failure)", async () => {
    const r = await runInnerToolAsResult(
      textEntry(JSON.stringify({ ok: false, code: "WindowNotFound", error: "Window not found: x" })),
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("WindowNotFound");
      expect(r.error.error).toContain("Window not found");
      expect(r.error.textLines).toHaveLength(1);
    }
  });

  it("ok:false without code/error fields → Result.ok=false, fields undefined", async () => {
    const r = await runInnerToolAsResult(textEntry(JSON.stringify({ ok: false })), {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBeUndefined();
      expect(r.error.error).toBeUndefined();
    }
  });

  it("non-JSON first text block → treated as success (Result.ok=true)", async () => {
    const r = await runInnerToolAsResult(textEntry("raw screenshot text, not json"), {});
    expect(r.ok).toBe(true);
  });

  it("image blocks are carried in the outcome", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry: any = {
      schema: { parse: (x: unknown) => x },
      handler: async () => ({ content: [{ type: "image", data: "abc", mimeType: "image/png" }] }),
    };
    const r = await runInnerToolAsResult(entry, {});
    expect(r.ok).toBe(true); // no text block → not a failure
    if (r.ok) expect(r.value.images[0]).toEqual({ data: "abc", mimeType: "image/png" });
  });

  it("ok:true with a trailing image block → success + both carried", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry: any = {
      schema: { parse: (x: unknown) => x },
      handler: async () => ({
        content: [
          { type: "text", text: JSON.stringify({ ok: true }) },
          { type: "image", data: "z", mimeType: "image/png" },
        ],
      }),
    };
    const r = await runInnerToolAsResult(entry, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.textLines).toHaveLength(1);
      expect(r.value.images).toHaveLength(1);
    }
  });
});
