/**
 * ADR-018 Phase 2a — integration CI gate for the MCP `tools/list` inputSchema.
 *
 * Registers every public tool on a real `McpServer` (mirroring
 * `server-windows.ts::createMcpServer`'s registration list) and dumps
 * `tools/list`, then asserts:
 *   1. NO registered tool has an empty `properties` — the empty-`properties`
 *      regression surface is a top-level `z.discriminatedUnion` slipping past
 *      `flattenUnionToObjectSchema`; this guard catches any future slip on ANY
 *      tool, not just the 7 known ones.
 *   2. NO registered tool's top-level `inputSchema` has `oneOf`/`anyOf`/`allOf`
 *      — the Anthropic API rejects those (HTTP 400).
 *   3. The 7 flattened tools each expose non-empty `properties` including the
 *      `action` discriminator enumerated as a flat `z.enum`.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const FLATTENED_TOOLS = [
  "scroll",
  "keyboard",
  "excel",
  "browser_eval",
  "window_dock",
  "terminal",
  "clipboard",
] as const;

interface ListedTool {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema?: any;
}

let tools: ListedTool[] = [];

beforeAll(async () => {
  const s = new McpServer({ name: "tools-list-schema-test", version: "0" });

  // Mirror server-windows.ts::createMcpServer registration list (the failsafe
  // wrapper + tray + transport are not needed for a tools/list dump).
  const regs: Array<[string, string]> = [
    ["../../src/tools/screenshot.js", "registerScreenshotTools"],
    ["../../src/tools/mouse.js", "registerMouseTools"],
    ["../../src/tools/keyboard.js", "registerKeyboardTools"],
    ["../../src/tools/window.js", "registerWindowTools"],
    ["../../src/tools/ui-elements.js", "registerUiElementTools"],
    ["../../src/tools/workspace.js", "registerWorkspaceTools"],
    ["../../src/tools/macro.js", "registerMacroTools"],
    ["../../src/tools/scroll.js", "registerScrollTools"],
    ["../../src/tools/browser.js", "registerBrowserTools"],
    ["../../src/tools/window-dock.js", "registerWindowDockTools"],
    ["../../src/tools/wait-until.js", "registerWaitUntilTool"],
    ["../../src/tools/desktop-state.js", "registerDesktopStateTools"],
    ["../../src/tools/terminal.js", "registerTerminalTools"],
    ["../../src/tools/events.js", "registerEventTools"],
    ["../../src/tools/clipboard.js", "registerClipboardTools"],
    ["../../src/tools/notification.js", "registerNotificationTools"],
    ["../../src/tools/excel.js", "registerExcelTools"],
    ["../../src/tools/perception.js", "registerPerceptionTools"],
    ["../../src/tools/server-status.js", "registerServerStatusTool"],
  ];
  for (const [path, fn] of regs) {
    const mod = await import(path);
    (mod as Record<string, (srv: McpServer) => void>)[fn](s);
  }
  // Anti-Fukuwarai v2 (desktop_discover / desktop_act) — default-on, optional.
  try {
    const v2 = await import("../../src/tools/desktop-register.js");
    (v2 as { registerDesktopTools: (srv: McpServer) => void }).registerDesktopTools(s);
  } catch {
    /* v2 module optional in some envs */
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (s.server as any)._requestHandlers.get("tools/list");
  const res = await handler(
    { method: "tools/list", params: {} },
    { signal: new AbortController().signal },
  );
  tools = res.tools as ListedTool[];
});

describe("ADR-018 Phase 2a — tools/list inputSchema CI gate", () => {
  it("registers the full public tool surface", () => {
    expect(tools.length).toBeGreaterThanOrEqual(20);
  });

  it("NO registered tool has empty `properties` (server-wide top-level-union regression guard)", () => {
    const empty = tools
      .filter((t) => Object.keys(t.inputSchema?.properties ?? {}).length === 0)
      .map((t) => t.name);
    expect(empty).toEqual([]);
  });

  it("NO registered tool has a top-level oneOf/anyOf/allOf (Anthropic API rejects those)", () => {
    const bad = tools
      .filter(
        (t) =>
          t.inputSchema?.oneOf !== undefined ||
          t.inputSchema?.anyOf !== undefined ||
          t.inputSchema?.allOf !== undefined,
      )
      .map((t) => t.name);
    expect(bad).toEqual([]);
  });

  it("each of the 7 flattened tools exposes non-empty `properties` with an `action` enum", () => {
    for (const name of FLATTENED_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, `tool "${name}" should be registered`).toBeDefined();
      const props = (tool!.inputSchema?.properties ?? {}) as Record<string, unknown>;
      expect(Object.keys(props).length, `${name}: non-empty properties`).toBeGreaterThan(0);
      const action = props.action as { enum?: unknown[] } | undefined;
      expect(action, `${name}.action present`).toBeDefined();
      expect(Array.isArray(action!.enum), `${name}.action is an enum`).toBe(true);
      expect(action!.enum!.length, `${name}.action enum non-empty`).toBeGreaterThan(0);
    }
  });
});
