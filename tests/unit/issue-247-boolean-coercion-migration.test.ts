/**
 * issue-247-boolean-coercion-migration.test.ts
 *
 * Migration pin for issue #247: every boolean field on the public tool
 * surface now accepts the LLM-friendly string "true" / "false" spellings
 * via `coercedBoolean()`. `tests/unit/coerce.test.ts` already covers the
 * helper in isolation; this file pins the *tool-schema* surface so a
 * future regression that swaps a field back to `z.boolean()` fails here.
 *
 * We sample a few representative fields per schema rather than testing
 * every one — the migration was mechanical (s/z.boolean()/coercedBoolean()/g)
 * and the pre-existing `coerce.test.ts` already proves the helper itself
 * is sound, so the structural risk is "did the migration miss a site?".
 * A handful of spot checks across the major schemas catches that.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { keyboardSchema } from "../../src/tools/keyboard.js";
import { terminalSchema } from "../../src/tools/terminal.js";
import { mouseClickSchema } from "../../src/tools/mouse.js";
import { workspaceSnapshotSchema } from "../../src/tools/workspace.js";

// mouseClick / workspaceSnapshot are exported as raw `Record<string, ZodType>`
// shapes (used at registration via `server.registerTool({inputSchema: shape})`);
// wrap them once here so `.safeParse` is available.
const mouseClickFullSchema = z.object(mouseClickSchema);
const workspaceSnapshotFullSchema = z.object(workspaceSnapshotSchema);

describe("issue #247: tool schemas accept LLM-stringified boolean inputs", () => {
  describe("keyboard(action='type')", () => {
    it("use_clipboard: 'true' is accepted (most common silent reject)", () => {
      const r = keyboardSchema.safeParse({
        action: "type",
        text: "echo hi",
        use_clipboard: "true",
      });
      expect(r.success).toBe(true);
      if (r.success && r.data.action === "type") {
        expect(r.data.use_clipboard).toBe(true);
      }
    });

    it("forceImeOff: 'true' is accepted (issue #245 系統②b)", () => {
      const r = keyboardSchema.safeParse({
        action: "type",
        text: "echo hi",
        forceImeOff: "true",
      });
      expect(r.success).toBe(true);
      if (r.success && r.data.action === "type") {
        expect(r.data.forceImeOff).toBe(true);
      }
    });

    it("multiple boolean fields in one call (forceKeystrokes + replaceAll + forceImeOff)", () => {
      const r = keyboardSchema.safeParse({
        action: "type",
        text: "x",
        forceKeystrokes: "true",
        replaceAll: "false",
        forceImeOff: "true",
      });
      expect(r.success).toBe(true);
    });

    it("ambiguous string is still rejected (typo guard)", () => {
      const r = keyboardSchema.safeParse({
        action: "type",
        text: "x",
        forceImeOff: "maybe",
      });
      expect(r.success).toBe(false);
    });
  });

  describe("terminal", () => {
    it("send variant forceFocus: 'true' is accepted", () => {
      const r = terminalSchema.safeParse({
        action: "send",
        windowTitle: "PowerShell",
        input: "echo x",
        forceFocus: "true",
      });
      expect(r.success).toBe(true);
    });

    it("run variant until.regex: 'false' (nested boolean) is accepted", () => {
      const r = terminalSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo x",
        until: { mode: "pattern", pattern: "$", regex: "false" },
      });
      expect(r.success).toBe(true);
    });
  });

  describe("mouse_click", () => {
    it("doubleClick: 'true' is accepted", () => {
      const r = mouseClickFullSchema.safeParse({
        x: 100,
        y: 100,
        doubleClick: "true",
      });
      expect(r.success).toBe(true);
    });
  });

  describe("workspace_snapshot", () => {
    it("includeUiSummary: 'false' is accepted", () => {
      const r = workspaceSnapshotFullSchema.safeParse({
        includeUiSummary: "false",
      });
      expect(r.success).toBe(true);
    });
  });
});
