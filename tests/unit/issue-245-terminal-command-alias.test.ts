/**
 * issue-245-terminal-command-alias.test.ts
 *
 * Issue #245 系統③: `terminal(action='run')` accepts the legacy parameter
 * name `command` as a deprecated alias of `input`. The schema accepts either
 * field; the dispatcher normalises `command` → `input` before invoking the
 * run handler so downstream code only sees `input: string`.
 *
 * Schema-level contract:
 *   - both fields are optional
 *   - `.refine()` rejects the run variant when both are absent
 *   - either field on its own parses successfully
 */

import { describe, it, expect } from "vitest";
import { terminalSchema, terminalRegistrationSchema } from "../../src/tools/terminal.js";

describe("issue #245 系統③: terminal(action='run') accepts `command` as alias of `input`", () => {
  const base = {
    action: "run" as const,
    windowTitle: "PowerShell",
    until: { mode: "quiet" as const, quietMs: 1500 },
    timeoutMs: 30_000,
  };

  it("accepts `input` (the canonical field)", () => {
    const r = terminalSchema.safeParse({ ...base, input: "echo hi" });
    expect(r.success).toBe(true);
    if (r.success && r.data.action === "run") {
      expect(r.data.input).toBe("echo hi");
    }
  });

  it("accepts `command` alone (the deprecated alias)", () => {
    const r = terminalSchema.safeParse({ ...base, command: "echo hi" });
    expect(r.success).toBe(true);
    if (r.success && r.data.action === "run") {
      // The schema preserves `command` as-is; the dispatcher (covered by
      // a separate test) is responsible for normalising it to `input`.
      expect(r.data.command).toBe("echo hi");
      expect(r.data.input).toBeUndefined();
    }
  });

  it("accepts both `input` and `command` (input wins downstream)", () => {
    const r = terminalSchema.safeParse({
      ...base,
      input: "echo from-input",
      command: "echo from-command",
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.action === "run") {
      expect(r.data.input).toBe("echo from-input");
      expect(r.data.command).toBe("echo from-command");
    }
  });

  it("rejects when neither `input` nor `command` is provided", () => {
    const r = terminalSchema.safeParse(base);
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = JSON.stringify(r.error.issues);
      expect(msg).toMatch(/`input`|command/);
    }
  });

  it("does not affect action='read' (alias is run-variant only)", () => {
    const r = terminalSchema.safeParse({
      action: "read",
      windowTitle: "PowerShell",
    });
    expect(r.success).toBe(true);
  });

  it("does not affect action='send' (still requires `input`)", () => {
    const r = terminalSchema.safeParse({
      action: "send",
      windowTitle: "PowerShell",
      input: "echo send",
    });
    expect(r.success).toBe(true);
  });

  it("survives the withEnvelopeIncludeForUnion wrap (registration schema)", () => {
    // PR #172 wraps the dispatcher schema with `include?` injection on every
    // variant. The alias path must still work after that wrap.
    const r = terminalRegistrationSchema.safeParse({
      ...base,
      command: "echo via-registration",
    });
    expect(r.success).toBe(true);
  });
});
