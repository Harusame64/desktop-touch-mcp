/**
 * tests/unit/tool-naming-phase2.test.ts
 *
 * Contract tests for Phase 2 Tool Surface Reduction — Family Merge (dispatcher pattern).
 * Verifies that:
 *   - 5 new dispatcher tools are registered with correct names
 *   - Old 13 tool names are absent from all registration points
 *   - Dispatcher handlers route to the correct sub-handler
 *   - stub-tool-catalog contains new dispatcher names (not old 13 names)
 *   - No LLM-exposed old tool names in description/suggest/error strings
 *
 * Design reference: docs/tool-surface-phase2-family-merge-design.md §6
 */

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { registerKeyboardTools } from "../../src/tools/keyboard.js";
import { registerClipboardTools } from "../../src/tools/clipboard.js";
import { registerWindowDockTools } from "../../src/tools/window-dock.js";
import { registerScrollTools } from "../../src/tools/scroll.js";
import { registerTerminalTools } from "../../src/tools/terminal.js";
import { STUB_TOOL_CATALOG } from "../../src/stub-tool-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" });
}

/** Extract registered tool names from McpServer internals. */
function getRegisteredNames(s: McpServer): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = (s as any)._registeredTools as Record<string, unknown> | undefined;
  if (!registry) return [];
  return Object.keys(registry);
}

// ─── 1. Dispatcher registration ───────────────────────────────────────────────

describe("Phase 2 — dispatcher tool registration", () => {
  // Case 1-2: keyboard dispatcher
  it("keyboard is registered (consolidates keyboard_type + keyboard_press)", () => {
    const s = makeServer();
    registerKeyboardTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("keyboard");
    expect(names).not.toContain("keyboard_type");
    expect(names).not.toContain("keyboard_press");
  });

  // Case 3-4: clipboard dispatcher
  it("clipboard is registered (consolidates clipboard_read + clipboard_write)", () => {
    const s = makeServer();
    registerClipboardTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("clipboard");
    expect(names).not.toContain("clipboard_read");
    expect(names).not.toContain("clipboard_write");
  });

  // Case 5-7: window_dock dispatcher
  it("window_dock is registered (consolidates pin_window + unpin_window + dock_window)", () => {
    const s = makeServer();
    registerWindowDockTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("window_dock");
    expect(names).not.toContain("pin_window");
    expect(names).not.toContain("unpin_window");
    expect(names).not.toContain("dock_window");
  });

  // Case 8-11: scroll dispatcher
  it("scroll is registered (consolidates scroll + scroll_to_element + smart_scroll + scroll_capture)", () => {
    const s = makeServer();
    registerScrollTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("scroll");
    // Old names must be absent
    expect(names).not.toContain("scroll_raw");
    expect(names).not.toContain("scroll_to_element");
    expect(names).not.toContain("smart_scroll");
    expect(names).not.toContain("scroll_capture");
  });

  // Case 12-13: terminal dispatcher
  it("terminal is registered (consolidates terminal_read + terminal_send, adds terminal_run)", () => {
    const s = makeServer();
    registerTerminalTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("terminal");
    expect(names).not.toContain("terminal_read");
    expect(names).not.toContain("terminal_send");
  });
});

// ─── 2. Dispatcher schema — action field present ───────────────────────────────

describe("Phase 2 — dispatcher inputSchema contains action field", () => {
  it("keyboard dispatcher schema has action", async () => {
    const { keyboardSchema } = await import("../../src/tools/keyboard.js");
    // discriminatedUnion — verify it parses valid action variants
    const parseType = keyboardSchema.safeParse({ action: "type", text: "hello" });
    expect(parseType.success).toBe(true);
    const parsePress = keyboardSchema.safeParse({ action: "press", keys: "ctrl+c" });
    expect(parsePress.success).toBe(true);
    const parseInvalid = keyboardSchema.safeParse({ action: "unknown_action" });
    expect(parseInvalid.success).toBe(false);
  });

  it("clipboard dispatcher schema has action", async () => {
    const { clipboardSchema } = await import("../../src/tools/clipboard.js");
    const parseRead = clipboardSchema.safeParse({ action: "read" });
    expect(parseRead.success).toBe(true);
    const parseWrite = clipboardSchema.safeParse({ action: "write", text: "hello" });
    expect(parseWrite.success).toBe(true);
    const parseInvalid = clipboardSchema.safeParse({ action: "unknown_action" });
    expect(parseInvalid.success).toBe(false);
  });

  it("window_dock dispatcher schema has action", async () => {
    const { windowDockSchema } = await import("../../src/tools/window-dock.js");
    const parsePin = windowDockSchema.safeParse({ action: "pin", title: "Settings" });
    expect(parsePin.success).toBe(true);
    const parseUnpin = windowDockSchema.safeParse({ action: "unpin", title: "Settings" });
    expect(parseUnpin.success).toBe(true);
    const parseDock = windowDockSchema.safeParse({ action: "dock", title: "Settings" });
    expect(parseDock.success).toBe(true);
    const parseInvalid = windowDockSchema.safeParse({ action: "unknown_action" });
    expect(parseInvalid.success).toBe(false);
  });

  it("scroll dispatcher schema has action", async () => {
    const { scrollSchema } = await import("../../src/tools/scroll.js");
    const parseRaw = scrollSchema.safeParse({ action: "raw", direction: "down" });
    expect(parseRaw.success).toBe(true);
    const parseToElement = scrollSchema.safeParse({ action: "to_element", name: "OK" });
    expect(parseToElement.success).toBe(true);
    const parseSmart = scrollSchema.safeParse({ action: "smart", target: "#btn" });
    expect(parseSmart.success).toBe(true);
    const parseCapture = scrollSchema.safeParse({ action: "capture", windowTitle: "Chrome" });
    expect(parseCapture.success).toBe(true);
    const parseInvalid = scrollSchema.safeParse({ action: "unknown_action" });
    expect(parseInvalid.success).toBe(false);
  });

  it("terminal dispatcher schema has action", async () => {
    const { terminalSchema } = await import("../../src/tools/terminal.js");
    const parseRead = terminalSchema.safeParse({ action: "read", windowTitle: "PowerShell" });
    expect(parseRead.success).toBe(true);
    const parseSend = terminalSchema.safeParse({ action: "send", windowTitle: "PowerShell", input: "ls" });
    expect(parseSend.success).toBe(true);
    const parseRunQuiet = terminalSchema.safeParse({
      action: "run", windowTitle: "PowerShell", input: "ls",
      until: { mode: "quiet" },
    });
    expect(parseRunQuiet.success).toBe(true);
    const parseRunPattern = terminalSchema.safeParse({
      action: "run", windowTitle: "PowerShell", input: "ls",
      until: { mode: "pattern", pattern: ">" },
    });
    expect(parseRunPattern.success).toBe(true);
    const parseInvalid = terminalSchema.safeParse({ action: "unknown_action" });
    expect(parseInvalid.success).toBe(false);
  });
});

// ─── 3. Old 13 tool names absent from server.tool() registrations ─────────────

describe("Phase 2 — old 13 tool names have no server.tool() registrations", () => {
  const OLD_TOOL_NAMES = [
    "keyboard_type",
    "keyboard_press",
    "clipboard_read",
    "clipboard_write",
    "pin_window",
    "unpin_window",
    "dock_window",
    "scroll_to_element",
    "smart_scroll",
    "scroll_capture",
    "terminal_read",
    "terminal_send",
  ];

  const SOURCE_FILES = [
    "src/tools/keyboard.ts",
    "src/tools/clipboard.ts",
    "src/tools/pin.ts",
    "src/tools/dock.ts",
    "src/tools/scroll-to-element.ts",
    "src/tools/smart-scroll.ts",
    "src/tools/scroll-capture.ts",
    "src/tools/terminal.ts",
    "src/server-windows.ts",
  ];

  // Case 14-15: old names absent from server.tool/registerTool registrations
  for (const oldName of OLD_TOOL_NAMES) {
    it(`server.tool("${oldName}", ...) does not appear in any source file`, () => {
      for (const file of SOURCE_FILES) {
        const src = readFileSync(join(ROOT, file), "utf-8");
        // Allow in comments (// or *), but not in actual registration calls
        const toolCallPattern = `server.tool("${oldName}"`;
        const registerCallPattern = `server.registerTool("${oldName}"`;
        expect(src).not.toContain(toolCallPattern);
        expect(src).not.toContain(registerCallPattern);
      }
    });
  }
});

// ─── 4. stub-tool-catalog integrity ───────────────────────────────────────────

describe("Phase 2 — stub-tool-catalog has new dispatchers, not old 13 names", () => {
  const catalogNames = new Set(STUB_TOOL_CATALOG.map((e) => e.name));

  // Case 21: new dispatcher names present
  it("catalog contains keyboard (not keyboard_type / keyboard_press)", () => {
    expect(catalogNames.has("keyboard")).toBe(true);
    expect(catalogNames.has("keyboard_type")).toBe(false);
    expect(catalogNames.has("keyboard_press")).toBe(false);
  });

  it("catalog contains clipboard (not clipboard_read / clipboard_write)", () => {
    expect(catalogNames.has("clipboard")).toBe(true);
    expect(catalogNames.has("clipboard_read")).toBe(false);
    expect(catalogNames.has("clipboard_write")).toBe(false);
  });

  it("catalog contains window_dock (not pin_window / unpin_window / dock_window)", () => {
    expect(catalogNames.has("window_dock")).toBe(true);
    expect(catalogNames.has("pin_window")).toBe(false);
    expect(catalogNames.has("unpin_window")).toBe(false);
    expect(catalogNames.has("dock_window")).toBe(false);
  });

  it("catalog contains scroll (not scroll_to_element / smart_scroll / scroll_capture)", () => {
    expect(catalogNames.has("scroll")).toBe(true);
    expect(catalogNames.has("scroll_to_element")).toBe(false);
    expect(catalogNames.has("smart_scroll")).toBe(false);
    expect(catalogNames.has("scroll_capture")).toBe(false);
  });

  it("catalog contains terminal (not terminal_read / terminal_send)", () => {
    expect(catalogNames.has("terminal")).toBe(true);
    expect(catalogNames.has("terminal_read")).toBe(false);
    expect(catalogNames.has("terminal_send")).toBe(false);
  });

  it("catalog has non-empty descriptions for all 5 dispatchers", () => {
    const dispatchers = ["keyboard", "clipboard", "window_dock", "scroll", "terminal"];
    for (const name of dispatchers) {
      const entry = STUB_TOOL_CATALOG.find((e) => e.name === name);
      expect(entry, `catalog entry for ${name}`).toBeDefined();
      expect(entry!.description.trim().length).toBeGreaterThan(20);
    }
  });
});

// ─── 5. LLM-exposed string audit (Case 22) ────────────────────────────────────

describe("Phase 2 — no LLM-exposed old tool names in description/suggest/error strings", () => {
  /**
   * Files that contribute to tool descriptions, suggest fields, or error messages
   * sent to the LLM. Comments (// ...) are allowed.
   */
  const AUDIT_FILES = [
    "src/tools/keyboard.ts",
    "src/tools/clipboard.ts",
    "src/tools/window-dock.ts",
    "src/tools/scroll.ts",
    "src/tools/terminal.ts",
    "src/server-windows.ts",
  ];

  /**
   * Old names that must not appear in tool descriptions, suggest strings,
   * or error messages. Appearances in code comments (//) are allowed.
   *
   * We check that the string does not appear OUTSIDE of comment lines.
   */
  const OLD_NAMES_IN_STRINGS = [
    "keyboard_type",
    "keyboard_press",
    "clipboard_read",
    "clipboard_write",
    "pin_window",
    "unpin_window",
    "dock_window",
    "scroll_to_element",
    "smart_scroll",
    "scroll_capture",
    "terminal_read",
    "terminal_send",
  ];

  for (const oldName of OLD_NAMES_IN_STRINGS) {
    it(`"${oldName}" does not appear in non-comment code of AUDIT_FILES`, () => {
      for (const file of AUDIT_FILES) {
        const src = readFileSync(join(ROOT, file), "utf-8");
        // Strip single-line comments before checking
        const withoutComments = src
          .split("\n")
          .map((line) => {
            // Remove // ... comments (keep the code part)
            const commentIdx = line.indexOf("//");
            return commentIdx >= 0 ? line.slice(0, commentIdx) : line;
          })
          .join("\n");

        // Also strip /* ... */ block comments
        const withoutBlockComments = withoutComments.replace(/\/\*[\s\S]*?\*\//g, "");

        if (withoutBlockComments.includes(oldName)) {
          // Allow in import paths (e.g. from './scroll-capture.js')
          // Check only string literals in description/suggest/error fields
          const describeOrSuggestRe = new RegExp(
            `(?:description|suggest|error|message)\\s*[=:].*${oldName.replace(/_/g, ".")}`,
            "m"
          );
          // Simpler: any occurrence in the non-comment source is a lint failure
          // UNLESS it's inside an import path string
          const importLineRe = new RegExp(`^\\s*(?:import|from)\\s+.*${oldName}`, "m");
          if (!importLineRe.test(withoutBlockComments)) {
            // Not just in an import — fail
            expect(withoutBlockComments).not.toContain(oldName);
          }
        }
      }
    });
  }
});

// ─── 6. terminal run schema — boundary variants ───────────────────────────────

describe("Phase 2 — terminal run action schema variants", () => {
  it("terminal run with quiet mode has default quietMs", async () => {
    const { terminalSchema } = await import("../../src/tools/terminal.js");
    const result = terminalSchema.safeParse({
      action: "run",
      windowTitle: "PowerShell",
      input: "ls",
      until: { mode: "quiet" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data;
      if (data.action === "run") {
        expect(data.until.mode).toBe("quiet");
        // quietMs should have a default
        expect((data.until as { mode: "quiet"; quietMs: number }).quietMs).toBeGreaterThan(0);
      }
    }
  });

  it("terminal run with pattern mode requires pattern string", async () => {
    const { terminalSchema } = await import("../../src/tools/terminal.js");
    // Missing pattern field should fail
    const result = terminalSchema.safeParse({
      action: "run",
      windowTitle: "PowerShell",
      input: "ls",
      until: { mode: "pattern" },
    });
    expect(result.success).toBe(false);
  });

  it("terminal run with pattern mode accepts regex flag", async () => {
    const { terminalSchema } = await import("../../src/tools/terminal.js");
    const result = terminalSchema.safeParse({
      action: "run",
      windowTitle: "PowerShell",
      input: "ls",
      until: { mode: "pattern", pattern: "\\$\\s*$", regex: true },
    });
    expect(result.success).toBe(true);
  });

  it("terminal run has default timeoutMs", async () => {
    const { terminalSchema } = await import("../../src/tools/terminal.js");
    const result = terminalSchema.safeParse({
      action: "run",
      windowTitle: "PowerShell",
      input: "ls",
      until: { mode: "quiet" },
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.action === "run") {
      expect(result.data.timeoutMs).toBeGreaterThan(0);
    }
  });
});
