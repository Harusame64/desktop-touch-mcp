/**
 * tests/unit/tool-naming-phase1.test.ts
 *
 * Contract tests for Phase 1 Tool Surface Reduction — Naming Redesign.
 * Verifies that:
 *   - New tool names are registered correctly
 *   - Old tool names are absent from all registration points
 *   - stub-tool-catalog contains only new names
 *
 * Design reference: docs/tool-surface-phase1-naming-design.md §6
 */

import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerDesktopStateTools } from "../../src/tools/desktop-state.js";
import { registerServerStatusTool } from "../../src/tools/server-status.js";
import {
  registerDesktopTools,
  _resetFacadeForTest,
} from "../../src/tools/desktop-register.js";
import { STUB_TOOL_CATALOG } from "../../src/stub-tool-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" });
}

/** Extract registered tool names from McpServer internals (same pattern as existing tests). */
function getRegisteredNames(s: McpServer): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = (s as any)._registeredTools as Record<string, unknown> | undefined;
  if (!registry) return [];
  return Object.keys(registry);
}

afterEach(() => {
  _resetFacadeForTest();
});

// ─── Phase 1a: 主軸 3 family ──────────────────────────────────────────────────

describe("Phase 1a — core 3 family rename", () => {
  it("desktop_state is registered (replaces get_context)", () => {
    const s = makeServer();
    registerDesktopStateTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("desktop_state");
    expect(names).not.toContain("get_context");
  });

  it("desktop_discover is registered (replaces desktop_see)", () => {
    const s = makeServer();
    registerDesktopTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("desktop_discover");
    expect(names).not.toContain("desktop_see");
  });

  it("desktop_act is registered (replaces desktop_touch)", () => {
    const s = makeServer();
    registerDesktopTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("desktop_act");
    expect(names).not.toContain("desktop_touch");
  });

  it("get_history and get_document_state are still registered (not renamed in Phase 1)", () => {
    const s = makeServer();
    registerDesktopStateTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("get_history");
    expect(names).toContain("get_document_state");
  });
});

// ─── Phase 1b: server_status + browser 6 ─────────────────────────────────────

describe("Phase 1b — server_status + browser 6 rename", () => {
  it("server_status is registered (replaces engine_status)", () => {
    const s = makeServer();
    registerServerStatusTool(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("server_status");
    expect(names).not.toContain("engine_status");
  });

  it("browser_open is registered (replaces browser_connect)", async () => {
    const { registerBrowserTools } = await import("../../src/tools/browser.js");
    const s = makeServer();
    registerBrowserTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("browser_open");
    expect(names).not.toContain("browser_connect");
  });

  it("browser_click is registered (replaces browser_click_element)", async () => {
    const { registerBrowserTools } = await import("../../src/tools/browser.js");
    const s = makeServer();
    registerBrowserTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("browser_click");
    expect(names).not.toContain("browser_click_element");
  });

  it("browser_fill is registered (replaces browser_fill_input)", async () => {
    const { registerBrowserTools } = await import("../../src/tools/browser.js");
    const s = makeServer();
    registerBrowserTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("browser_fill");
    expect(names).not.toContain("browser_fill_input");
  });

  it("browser_form is registered (replaces browser_get_form)", async () => {
    const { registerBrowserTools } = await import("../../src/tools/browser.js");
    const s = makeServer();
    registerBrowserTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("browser_form");
    expect(names).not.toContain("browser_get_form");
  });

  it("browser_overview is registered (replaces browser_get_interactive)", async () => {
    const { registerBrowserTools } = await import("../../src/tools/browser.js");
    const s = makeServer();
    registerBrowserTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("browser_overview");
    expect(names).not.toContain("browser_get_interactive");
  });

  it("browser_locate is registered (replaces browser_find_element)", async () => {
    const { registerBrowserTools } = await import("../../src/tools/browser.js");
    const s = makeServer();
    registerBrowserTools(s);
    const names = getRegisteredNames(s);
    expect(names).toContain("browser_locate");
    expect(names).not.toContain("browser_find_element");
  });
});

// ─── stub-tool-catalog 整合 ────────────────────────────────────────────────────

describe("stub-tool-catalog — Phase 1 name alignment", () => {
  const catalogNames = new Set(STUB_TOOL_CATALOG.map((e) => e.name));

  it("catalog contains desktop_state (not get_context)", () => {
    expect(catalogNames.has("desktop_state")).toBe(true);
    expect(catalogNames.has("get_context")).toBe(false);
  });

  it("catalog contains server_status (not engine_status)", () => {
    expect(catalogNames.has("server_status")).toBe(true);
    expect(catalogNames.has("engine_status")).toBe(false);
  });

  it("catalog contains browser_open (not browser_connect)", () => {
    expect(catalogNames.has("browser_open")).toBe(true);
    expect(catalogNames.has("browser_connect")).toBe(false);
  });

  it("catalog contains browser_click (not browser_click_element)", () => {
    expect(catalogNames.has("browser_click")).toBe(true);
    expect(catalogNames.has("browser_click_element")).toBe(false);
  });

  it("catalog contains browser_fill (not browser_fill_input)", () => {
    expect(catalogNames.has("browser_fill")).toBe(true);
    expect(catalogNames.has("browser_fill_input")).toBe(false);
  });

  it("catalog contains browser_form (not browser_get_form)", () => {
    expect(catalogNames.has("browser_form")).toBe(true);
    expect(catalogNames.has("browser_get_form")).toBe(false);
  });

  it("catalog contains browser_overview (not browser_get_interactive)", () => {
    expect(catalogNames.has("browser_overview")).toBe(true);
    expect(catalogNames.has("browser_get_interactive")).toBe(false);
  });

  it("catalog contains browser_locate (not browser_find_element)", () => {
    expect(catalogNames.has("browser_locate")).toBe(true);
    expect(catalogNames.has("browser_find_element")).toBe(false);
  });
});

// ─── server.tool() source code grep ───────────────────────────────────────────

describe("source code — no old server.tool() registrations remain", () => {
  const OLD_TOOL_NAMES = [
    "get_context",
    "engine_status",
    "desktop_see",
    "desktop_touch",
    "browser_connect",
    "browser_click_element",
    "browser_fill_input",
    "browser_get_form",
    "browser_get_interactive",
    "browser_find_element",
  ];

  const SOURCE_FILES = [
    "src/tools/desktop-state.ts",
    "src/tools/server-status.ts",
    "src/tools/desktop-register.ts",
    "src/tools/browser.ts",
    "src/server-windows.ts",
  ];

  for (const oldName of OLD_TOOL_NAMES) {
    it(`server.tool("${oldName}", ...) does not appear in any source file`, () => {
      for (const file of SOURCE_FILES) {
        const src = readFileSync(join(ROOT, file), "utf-8");
        const pattern = `server.tool("${oldName}"`;
        expect(src).not.toContain(pattern);
      }
    });
  }
});
