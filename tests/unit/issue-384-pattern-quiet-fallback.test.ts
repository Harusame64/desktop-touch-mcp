/**
 * issue-384-pattern-quiet-fallback.test.ts
 *
 * #384: terminal(action='run', until:{mode:'pattern'}) hard-times-out when the
 * command's final output line has no trailing newline (an end-anchored pattern
 * like `\s*\n` / `$` can't bind — the marker is glued to the next prompt with no
 * boundary). The fix adds an OPT-IN `quietMs` to the pattern variant: when set,
 * the run also completes with reason:'quiet' (matchedPattern absent) once output
 * settles WITHOUT a match, instead of hanging until the hard timeout. Default
 * (quietMs unset) keeps the pre-#384 pattern contract (wait through silent gaps —
 * issue #196), so this pins the schema surface + the no-regression default.
 *
 * The settle BEHAVIOUR itself drives a real terminal and is covered by the e2e
 * suite; here we pin the schema (the public surface).
 */

import { describe, it, expect } from "vitest";
import { terminalSchema, terminalRegistrationSchema } from "../../src/tools/terminal.js";

describe("issue #384: pattern variant opt-in quietMs settle fallback (schema)", () => {
  it("accepts until={mode:'pattern', pattern, quietMs} and coerces quietMs", () => {
    const r = terminalSchema.safeParse({
      action: "run",
      windowTitle: "pwsh",
      input: "printf NLMARK",
      until: { mode: "pattern", pattern: "NLMARK", quietMs: 1000 },
    });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    if (r.success && r.data.action === "run" && r.data.until.mode === "pattern") {
      expect(r.data.until.quietMs).toBe(1000);
      expect(r.data.until.regex).toBe(false);
    }
  });

  it("leaves quietMs undefined when omitted (default contract — no fallback)", () => {
    const r = terminalSchema.safeParse({
      action: "run",
      windowTitle: "pwsh",
      input: "npm test",
      until: { mode: "pattern", pattern: "Test Files" },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.action === "run" && r.data.until.mode === "pattern") {
      expect(r.data.until.quietMs).toBeUndefined();
    }
  });

  it("rejects an out-of-range quietMs (bounds shared with quiet mode)", () => {
    expect(
      terminalSchema.safeParse({
        action: "run",
        windowTitle: "pwsh",
        input: "x",
        until: { mode: "pattern", pattern: "x", quietMs: 49 }, // min is 50
      }).success,
    ).toBe(false);
    expect(
      terminalSchema.safeParse({
        action: "run",
        windowTitle: "pwsh",
        input: "x",
        until: { mode: "pattern", pattern: "x", quietMs: 30001 }, // max is 30000
      }).success,
    ).toBe(false);
  });

  it("registration schema (post include-wrap) + JSON-string until both accept quietMs", () => {
    const wrapped = terminalRegistrationSchema.safeParse({
      action: "run",
      windowTitle: "pwsh",
      input: "printf X",
      until: { mode: "pattern", pattern: "X", quietMs: 800 },
    });
    expect(wrapped.success, wrapped.success ? "" : JSON.stringify(wrapped.error.issues)).toBe(true);

    const asString = terminalRegistrationSchema.safeParse({
      action: "run",
      windowTitle: "pwsh",
      input: "printf X",
      until: JSON.stringify({ mode: "pattern", pattern: "X", quietMs: 800 }),
    });
    expect(asString.success, asString.success ? "" : JSON.stringify(asString.error.issues)).toBe(true);
  });

  it("quiet mode is unaffected (quietMs still required-with-default there)", () => {
    const r = terminalSchema.safeParse({
      action: "run",
      windowTitle: "pwsh",
      input: "ls",
      until: { mode: "quiet" },
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.action === "run" && r.data.until.mode === "quiet") {
      expect(r.data.until.quietMs).toBe(1500);
    }
  });
});
