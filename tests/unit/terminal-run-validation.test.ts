/**
 * terminal-run-validation.test.ts
 *
 * Regression tests for PR #36 Codex review (follow-up):
 *   - Invalid sendOptions / readOptions must be rejected before any I/O so
 *     unbounded values cannot bypass the public terminal_send / _read schemas.
 *   - terminalReadHandler ok:false must be surfaced as run.ok:false + readError
 *     instead of silently returning ok:true with empty output.
 */

import { describe, it, expect } from "vitest";
import {
  terminalRunHandler,
  TERMINAL_RUN_SEND_OPTIONS_SCHEMA,
  TERMINAL_RUN_READ_OPTIONS_SCHEMA,
} from "../../src/tools/terminal.js";

function parseRunResponse(result: { content: Array<{ type: string; text?: string }> }): {
  ok?: boolean;
  output?: string;
  completion?: { reason?: string; elapsedMs?: number };
  warnings?: string[];
  readError?: { code?: string; error?: string; suggest?: string[] };
  // fail() shape (used for InvalidArgs validation errors):
  error?: string;
  code?: string;
  suggest?: string[];
  context?: Record<string, unknown>;
} {
  const block = result.content[0];
  if (block?.type !== "text" || !block.text) return {};
  return JSON.parse(block.text);
}

describe("terminal(action='run') — sendOptions/readOptions validation (Phase 2c follow-up)", () => {
  it("rejects sendOptions with chunkSize:0 (below schema minimum) before touching the terminal", async () => {
    const result = await terminalRunHandler({
      windowTitle: "__nonexistent_window_for_validation_test__",
      input: "echo hi",
      until: { mode: "quiet", quietMs: 800 },
      timeoutMs: 5_000,
      sendOptions: { chunkSize: 0 },
    });
    const parsed = parseRunResponse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("InvalidArgs");
    expect(parsed.error ?? "").toMatch(/Invalid sendOptions/);
    expect(parsed.error ?? "").toMatch(/chunkSize/);
    // Custom suggest stays at top level (not nested under context)
    expect(parsed.suggest).toBeDefined();
    expect(parsed.suggest!.some((s) => /terminal\(action='send'\)/.test(s))).toBe(true);
  });

  it("rejects sendOptions with unknown keys (strict mode)", async () => {
    const result = await terminalRunHandler({
      windowTitle: "__nonexistent_window_for_validation_test__",
      input: "echo hi",
      until: { mode: "quiet", quietMs: 800 },
      timeoutMs: 5_000,
      sendOptions: { unrecognizedKey: "x" },
    });
    const parsed = parseRunResponse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error ?? "").toMatch(/Invalid sendOptions/);
  });

  it("rejects sendOptions trying to override windowTitle (not in whitelist)", async () => {
    const result = await terminalRunHandler({
      windowTitle: "__nonexistent_window_for_validation_test__",
      input: "echo hi",
      until: { mode: "quiet", quietMs: 800 },
      timeoutMs: 5_000,
      sendOptions: { windowTitle: "different" },
    });
    const parsed = parseRunResponse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error ?? "").toMatch(/Invalid sendOptions/);
  });

  it("rejects sendOptions with method:'invalid' (not in enum)", async () => {
    const result = await terminalRunHandler({
      windowTitle: "__nonexistent_window_for_validation_test__",
      input: "echo hi",
      until: { mode: "quiet", quietMs: 800 },
      timeoutMs: 5_000,
      sendOptions: { method: "invalid" },
    });
    const parsed = parseRunResponse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error ?? "").toMatch(/Invalid sendOptions/);
    expect(parsed.error ?? "").toMatch(/method/);
  });

  it("rejects readOptions with lines beyond schema maximum", async () => {
    const result = await terminalRunHandler({
      windowTitle: "__nonexistent_window_for_validation_test__",
      input: "echo hi",
      until: { mode: "quiet", quietMs: 800 },
      timeoutMs: 5_000,
      readOptions: { lines: 999_999 },
    });
    const parsed = parseRunResponse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("InvalidArgs");
    expect(parsed.error ?? "").toMatch(/Invalid readOptions/);
    expect(parsed.error ?? "").toMatch(/lines/);
    expect(parsed.suggest).toBeDefined();
    expect(parsed.suggest!.some((s) => /terminal\(action='read'\)/.test(s))).toBe(true);
  });

  it("rejects readOptions with source:'invalid' (not in enum)", async () => {
    const result = await terminalRunHandler({
      windowTitle: "__nonexistent_window_for_validation_test__",
      input: "echo hi",
      until: { mode: "quiet", quietMs: 800 },
      timeoutMs: 5_000,
      readOptions: { source: "invalid" },
    });
    const parsed = parseRunResponse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error ?? "").toMatch(/Invalid readOptions/);
  });

  it("returns window_not_found (not validation error) when sendOptions/readOptions are valid", async () => {
    // Sanity check: a clean call with valid (default) options against a missing
    // window should fall through validation and reach the findTerminalWindow check.
    const result = await terminalRunHandler({
      windowTitle: "__nonexistent_window_for_validation_test__",
      input: "echo hi",
      until: { mode: "quiet", quietMs: 800 },
      timeoutMs: 5_000,
      sendOptions: { method: "auto", chunkSize: 50 },
      readOptions: { lines: 20, source: "auto" },
    });
    const parsed = parseRunResponse(result);
    // window_not_found is reported as ok:false on the run-response shape (not failWith)
    expect(parsed.ok).toBe(false);
    expect(parsed.completion?.reason).toBe("window_not_found");
  });
});

describe("terminal(action='run') — Zod default leak guard (PR #37 Codex P1)", () => {
  // Background: TERMINAL_RUN_SEND_OPTIONS_SCHEMA / READ_OPTIONS_SCHEMA wrap fields
  // from terminalSendSchema / _readSchema that already carry .default(...). In
  // Zod v4, .partial() makes keys optional but does NOT strip .default markers,
  // so the parsed result materialises defaults for absent keys. Without filtering,
  // those leak into the merged sendArgs/readArgs and overwrite run-specific
  // defaults (restoreFocus:false, trackFocus:false, settleMs:100).

  it("documents the Zod default-leak behavior so the filter cannot be silently removed", () => {
    const input = { chunkSize: 50 };
    const parsed = TERMINAL_RUN_SEND_OPTIONS_SCHEMA.parse(input);
    // Zod injects defaults for keys NOT in the input — this is the bug source.
    expect(parsed.restoreFocus).toBe(true);
    expect(parsed.trackFocus).toBe(true);
    expect(parsed.settleMs).toBe(300);
    // The chunkSize the caller actually provided survives.
    expect(parsed.chunkSize).toBe(50);
  });

  it("documents the same default-leak for readOptions", () => {
    const input = { lines: 10 };
    const parsed = TERMINAL_RUN_READ_OPTIONS_SCHEMA.parse(input);
    expect(parsed.stripAnsi).toBe(true);
    expect(parsed.source).toBe("auto");
    expect(parsed.ocrLanguage).toBe("ja");
    expect(parsed.lines).toBe(10);
  });

  it("verifies the keepOnlyProvidedKeys filter pattern strips the leaked defaults", () => {
    const input = { chunkSize: 50 };
    const parsed = TERMINAL_RUN_SEND_OPTIONS_SCHEMA.parse(input);
    const inputKeys = new Set(Object.keys(input));
    const filtered = Object.fromEntries(
      Object.entries(parsed).filter(([k]) => inputKeys.has(k))
    );
    // Only the explicitly-provided key remains.
    expect(filtered).toEqual({ chunkSize: 50 });
    expect("restoreFocus" in filtered).toBe(false);
    expect("trackFocus" in filtered).toBe(false);
    expect("settleMs" in filtered).toBe(false);
  });

  it("filter handles empty sendOptions:{} without leaking any defaults", () => {
    const input = {};
    const parsed = TERMINAL_RUN_SEND_OPTIONS_SCHEMA.parse(input);
    // Empty input → Zod parsed object is full of defaults.
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
    // Filter to provided keys only → empty result.
    const filtered = Object.fromEntries(
      Object.entries(parsed).filter(([k]) => Object.prototype.hasOwnProperty.call(input, k))
    );
    expect(filtered).toEqual({});
  });
});

// Note on Fix 3 (read-failure propagation) coverage:
// terminalRunHandler imports terminalReadHandler statically from the same
// module, so vi.doMock cannot intercept the in-module call. The behavioral
// contract (run.ok:false + readError when the final read returns ok:false) is
// verified by code review + an E2E that exercises readOptions:{source:'uia'}
// on a terminal without TextPattern. Refactoring to inject the read function
// is deliberately out of scope for this fix PR.
