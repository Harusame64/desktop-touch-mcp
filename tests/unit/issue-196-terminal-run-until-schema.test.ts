/**
 * issue-196-terminal-run-until-schema.test.ts
 *
 * Repro tests for issue #196 symptom 1:
 *   `terminal({action:'run', until:{mode:'pattern', pattern:'X', timeoutMs:N}})`
 *   was reported to be rejected with
 *     "expected object, received string" at path ["until"]
 *   even though the caller passed a JSON object literal.
 *
 * The terminal registration schema combines two discriminatedUnions:
 *   outer:  z.discriminatedUnion("action", [...])
 *   inner:  variant 'run' embeds z.discriminatedUnion("mode", [...]).default(...)
 *
 * `withEnvelopeIncludeForUnion` rebuilds the OUTER union (PR #172) by
 * extending each variant z.object with an `include?` field. We need to
 * verify that the INNER discriminatedUnion + .default(...) combination
 * still parses correctly through the wrapped schema.
 *
 * If safeParse({...until:{mode:'pattern',pattern:'X'}}) succeeds at the
 * server boundary, the reported bug must be rooted in the MCP transport /
 * agent-side serialization path, not in this server-side schema.
 */

import { describe, it, expect } from "vitest";
import {
  terminalRegistrationSchema,
  terminalSchema,
} from "../../src/tools/terminal.js";

describe("issue #196 symptom 1: terminal action='run' until field accepts object", () => {
  describe("via raw terminalSchema (without withEnvelopeIncludeForUnion wrap)", () => {
    it("accepts until={mode:'pattern', pattern:'X'} as object literal", () => {
      const result = terminalSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
        until: { mode: "pattern", pattern: "Test Files" },
      });
      expect(
        result.success,
        result.success ? "" : JSON.stringify(result.error.issues),
      ).toBe(true);
    });

    it("accepts until={mode:'quiet', quietMs:1500} as object literal", () => {
      const result = terminalSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
        until: { mode: "quiet", quietMs: 1500 },
      });
      expect(result.success).toBe(true);
    });

    it("accepts run variant with omitted until (default kicks in)", () => {
      const result = terminalSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
      });
      expect(result.success).toBe(true);
      if (result.success && result.data.action === "run") {
        // Issue #196 (b): default quietMs raised 800 → 1500.
        expect(result.data.until).toEqual({ mode: "quiet", quietMs: 1500 });
      }
    });

    it("rejects until passed as a string literal (the reported error shape)", () => {
      const result = terminalSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
        until: "pattern",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const untilIssue = result.error.issues.find(
          (i) => i.path.length > 0 && i.path[0] === "until",
        );
        expect(untilIssue).toBeDefined();
      }
    });
  });

  describe("via terminalRegistrationSchema (post-withEnvelopeIncludeForUnion)", () => {
    it("accepts until={mode:'pattern', pattern:'X'} after include-injection wrap", () => {
      const result = terminalRegistrationSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
        until: { mode: "pattern", pattern: "Test Files" },
      });
      expect(
        result.success,
        result.success ? "" : JSON.stringify(result.error.issues),
      ).toBe(true);
    });

    it("accepts until={mode:'quiet', quietMs:1500} after wrap", () => {
      const result = terminalRegistrationSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
        until: { mode: "quiet", quietMs: 1500 },
      });
      expect(result.success).toBe(true);
    });

    it("accepts include=['envelope'] alongside object until (issue body's exact shape)", () => {
      const result = terminalRegistrationSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "npm run test:e2e",
        until: { mode: "pattern", pattern: "Test Files", timeoutMs: 120000 },
        include: ["envelope"],
      });
      // Note: timeoutMs lives at the run-variant level, not nested in until.
      // The issue body conflated the two — this test pins the schema-correct shape.
      // If this fails, the inner discriminatedUnion + .default() interaction is
      // broken under the outer wrap and we need a server-side fix.
      expect(
        result.success,
        result.success ? "" : JSON.stringify(result.error.issues),
      ).toBe(true);
    });

    it("schema-correct shape: timeoutMs at run-variant level, until is the polling spec", () => {
      const result = terminalRegistrationSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "npm run test:e2e",
        until: { mode: "pattern", pattern: "Test Files" },
        timeoutMs: 120000,
      });
      expect(
        result.success,
        result.success ? "" : JSON.stringify(result.error.issues),
      ).toBe(true);
      if (result.success) {
        const data = result.data as {
          action: string;
          until?: { mode: string; pattern?: string };
          timeoutMs?: number;
        };
        expect(data.action).toBe("run");
        expect(data.until).toEqual({ mode: "pattern", pattern: "Test Files", regex: false });
        expect(data.timeoutMs).toBe(120000);
      }
    });
  });

  describe("issue #196 fix: defensive JSON-string preprocessor accepts stringified objects", () => {
    it("until passed as JSON string is parsed into the discriminated union", () => {
      const result = terminalRegistrationSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "npm run test:e2e",
        until: JSON.stringify({ mode: "pattern", pattern: "Test Files" }),
      });
      expect(
        result.success,
        result.success ? "" : JSON.stringify(result.error.issues),
      ).toBe(true);
      if (result.success) {
        const data = result.data as {
          until: { mode: string; pattern?: string; regex?: boolean };
        };
        expect(data.until.mode).toBe("pattern");
        expect(data.until.pattern).toBe("Test Files");
      }
    });

    it("until passed as a quoted quiet object string is parsed", () => {
      const result = terminalRegistrationSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
        until: '{"mode":"quiet","quietMs":2000}',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { until: { mode: string; quietMs?: number } };
        expect(data.until).toEqual({ mode: "quiet", quietMs: 2000 });
      }
    });

    it("sendOptions passed as JSON string is parsed", () => {
      const result = terminalRegistrationSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
        sendOptions: '{"chunkSize":50}',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { sendOptions?: { chunkSize?: number } };
        expect(data.sendOptions).toEqual({ chunkSize: 50 });
      }
    });

    it("readOptions passed as JSON string is parsed", () => {
      const result = terminalRegistrationSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
        readOptions: '{"lines":100}',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as { readOptions?: { lines?: number } };
        expect(data.readOptions).toEqual({ lines: 100 });
      }
    });

    it("malformed JSON string passes through to zod and surfaces a typed error", () => {
      const result = terminalRegistrationSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
        until: "not-json-{",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find(
          (i) => i.path.length > 0 && i.path[0] === "until",
        );
        expect(issue).toBeDefined();
      }
    });

    it("non-object JSON values (number, null) pass through to typed error", () => {
      // The preprocessor only adopts parsed objects; "42" and "null" remain strings
      // and zod rejects them with the original "expected object" issue. This guards
      // against silent coercion of primitives into the discriminated union.
      const r1 = terminalRegistrationSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
        until: "42",
      });
      expect(r1.success).toBe(false);
      const r2 = terminalRegistrationSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
        until: "null",
      });
      expect(r2.success).toBe(false);
    });

    it("empty string until passes through to typed error (Codex P2-1)", () => {
      // `""` does not start with `{` or `[` so the preprocess heuristic
      // bypasses JSON.parse; the inner zod then rejects the string.
      const result = terminalRegistrationSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
        until: "",
      });
      expect(result.success).toBe(false);
    });

    it("array JSON value parses through and zod surfaces 'expected object, received array'", () => {
      // Arrays satisfy `typeof === "object"` so the preprocessor returns the
      // parsed array; the inner discriminatedUnion then rejects with a
      // typed error that *names the array shape* — more useful than the
      // legacy 'received string' message. (Codex P2-4 docstring follow-up.)
      const result = terminalRegistrationSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
        until: "[1,2,3]",
      });
      expect(result.success).toBe(false);
    });

    it("default quietMs is now 1500 (issue #196 raised from 800)", () => {
      const result = terminalSchema.safeParse({
        action: "run",
        windowTitle: "PowerShell",
        input: "echo hi",
      });
      expect(result.success).toBe(true);
      if (result.success && result.data.action === "run") {
        expect(result.data.until).toEqual({ mode: "quiet", quietMs: 1500 });
      }
    });
  });
});
