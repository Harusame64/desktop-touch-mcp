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
 *   2. NO registered tool's *top-level* `inputSchema` has `oneOf`/`anyOf`/
 *      `allOf` — the Anthropic API rejects those (HTTP 400). (Property-level
 *      `oneOf`/`anyOf` — e.g. `terminal.until` — is fine and expected.)
 *   3. The 7 flattened tools each expose non-empty `properties` including the
 *      `action` discriminator enumerated as a flat `z.enum`.
 *   4. `terminal.until` (a nested `z.discriminatedUnion`) renders as a
 *      *property-level* `oneOf` — intact, not stripped (ADR-018 §3 G2a #6).
 *
 * **Gating**: `describe.skipIf(process.platform !== "win32")`. This is a
 * default-running regression gate on Windows (the dev + MCP-server platform);
 * it is platform-gated rather than env-gated (`RUN_OCR_GOLDEN`-style) precisely
 * BECAUSE it must run by default to function as a gate. The `beforeAll` below
 * dynamically imports the full Windows tool surface (native input bindings via
 * `nutjs`, etc.) — those imports only run inside the (Windows-only) describe,
 * so a Linux / minimal CI environment skips cleanly instead of failing at
 * module load (Codex PR #290 Round 1 P1).
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

describe.skipIf(process.platform !== "win32")(
  "ADR-018 Phase 2a — tools/list inputSchema CI gate",
  () => {
    let tools: ListedTool[] = [];

    beforeAll(async () => {
      const s = new McpServer({ name: "tools-list-schema-test", version: "0" });

      // Mirror server-windows.ts::createMcpServer registration list (the
      // failsafe wrapper + tray + transport are not needed for a tools/list dump).
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
        ["../../src/tools/screenshot-query.js", "registerScreenshotQueryTool"],
        ["../../src/tools/screenshot-gc.js", "registerScreenshotGcTool"],
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

    it("registers the full public tool surface", () => {
      // The server registers ~32 tools (30 stub catalog incl. ADR-026 Phase 3
      // screenshot_query/screenshot_gc + ADR-014 key_locker, + 2 v2; V1 fallbacks
      // vary by env). 30 is a tight lower bound that still catches a registration
      // regression dropping a tool family.
      expect(tools.length).toBeGreaterThanOrEqual(30);
    });

    it("registers the ADR-026 Phase 3 disk-cache tools by name (catches a registration drop a >= bound would miss)", () => {
      // A loose `>=` count can't tell which tool went missing; assert the two new
      // maintenance tools explicitly (ADR-026 AC6).
      const names = new Set(tools.map((t) => t.name));
      expect(names.has("screenshot_query"), "screenshot_query registered").toBe(true);
      expect(names.has("screenshot_gc"), "screenshot_gc registered").toBe(true);
    });

    it("NO registered tool has empty `properties` (server-wide top-level-union regression guard)", () => {
      const empty = tools
        .filter((t) => Object.keys(t.inputSchema?.properties ?? {}).length === 0)
        .map((t) => t.name);
      expect(empty).toEqual([]);
    });

    it("NO registered tool has a TOP-LEVEL oneOf/anyOf/allOf (Anthropic API rejects those)", () => {
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

    it("terminal.until — a nested z.discriminatedUnion — renders as a PROPERTY-LEVEL oneOf, intact (ADR-018 §3 G2a #6)", () => {
      const terminal = tools.find((t) => t.name === "terminal");
      expect(terminal).toBeDefined();
      const until = terminal!.inputSchema?.properties?.until;
      expect(until, "terminal.until is present, not stripped").toBeDefined();
      // The nested `z.discriminatedUnion("mode", ...)` renders as a
      // property-level `oneOf` (each branch carries its `mode` discriminator
      // const). Property-level oneOf is accepted by the Anthropic API — only
      // *top-level* oneOf is rejected (asserted separately above).
      expect(Array.isArray(until.oneOf), "terminal.until.oneOf is an array").toBe(true);
      expect(until.oneOf.length, "terminal.until.oneOf has the mode branches").toBeGreaterThanOrEqual(2);
    });
  },
);
