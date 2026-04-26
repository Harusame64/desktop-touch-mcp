/**
 * tests/unit/tool-naming-phase3.test.ts
 *
 * Contract tests for Phase 3 Tool Surface Reduction — Browser Rearrangement.
 * Verifies that:
 *   - browser_open absorbs former browser_launch via optional launch param
 *   - browser_eval becomes a discriminatedUnion (action='js'|'dom'|'appState')
 *   - 4 absorbed/privatized tools (browser_launch, browser_get_dom,
 *     browser_get_app_state, browser_disconnect) have no public registration
 *   - stub-tool-catalog drops the 4 absorbed/privatized tools
 *   - No LLM-exposed old tool names in description / suggest / error strings
 *
 * Design reference: docs/tool-surface-phase3-browser-rearrangement-design.md §6
 */

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { registerBrowserTools } from "../../src/tools/browser.js";
import { STUB_TOOL_CATALOG } from "../../src/stub-tool-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" });
}

function getRegisteredNames(s: McpServer): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = (s as any)._registeredTools as Record<string, unknown> | undefined;
  if (!registry) return [];
  return Object.keys(registry);
}

// ─── 1. Public surface — 9 browser_* tools, 4 absorbed/privatized absent ──────

describe("Phase 3 — public registration", () => {
  it("registers exactly 9 browser_* tools", () => {
    const s = makeServer();
    registerBrowserTools(s);
    const names = getRegisteredNames(s).filter((n) => n.startsWith("browser_"));
    expect(names.sort()).toEqual([
      "browser_click",
      "browser_eval",
      "browser_fill",
      "browser_form",
      "browser_locate",
      "browser_navigate",
      "browser_open",
      "browser_overview",
      "browser_search",
    ]);
  });

  it("does NOT register browser_launch (absorbed into browser_open.launch)", () => {
    const s = makeServer();
    registerBrowserTools(s);
    expect(getRegisteredNames(s)).not.toContain("browser_launch");
  });

  it("does NOT register browser_get_dom (absorbed into browser_eval action='dom')", () => {
    const s = makeServer();
    registerBrowserTools(s);
    expect(getRegisteredNames(s)).not.toContain("browser_get_dom");
  });

  it("does NOT register browser_get_app_state (absorbed into browser_eval action='appState')", () => {
    const s = makeServer();
    registerBrowserTools(s);
    expect(getRegisteredNames(s)).not.toContain("browser_get_app_state");
  });

  it("does NOT register browser_disconnect (privatized — process exit auto-cleanup)", () => {
    const s = makeServer();
    registerBrowserTools(s);
    expect(getRegisteredNames(s)).not.toContain("browser_disconnect");
  });
});

// ─── 2. browser_eval discriminatedUnion schema ────────────────────────────────

describe("Phase 3 — browser_eval discriminatedUnion(js/dom/appState)", () => {
  it("action='js' with expression validates", async () => {
    const { browserEvalSchema } = await import("../../src/tools/browser.js");
    const r = browserEvalSchema.safeParse({ action: "js", expression: "document.title" });
    expect(r.success).toBe(true);
  });

  it("action='dom' with optional selector validates", async () => {
    const { browserEvalSchema } = await import("../../src/tools/browser.js");
    const r1 = browserEvalSchema.safeParse({ action: "dom" });
    expect(r1.success).toBe(true);
    const r2 = browserEvalSchema.safeParse({ action: "dom", selector: "#main", maxLength: 5000 });
    expect(r2.success).toBe(true);
  });

  it("action='appState' with optional selectors validates", async () => {
    const { browserEvalSchema } = await import("../../src/tools/browser.js");
    const r1 = browserEvalSchema.safeParse({ action: "appState" });
    expect(r1.success).toBe(true);
    const r2 = browserEvalSchema.safeParse({
      action: "appState",
      selectors: ["window:__INITIAL_STATE__"],
      maxBytes: 8000,
    });
    expect(r2.success).toBe(true);
  });

  it("rejects payload without action discriminator", async () => {
    const { browserEvalSchema } = await import("../../src/tools/browser.js");
    const r = browserEvalSchema.safeParse({ expression: "document.title" });
    expect(r.success).toBe(false);
  });

  it("rejects unknown action", async () => {
    const { browserEvalSchema } = await import("../../src/tools/browser.js");
    const r = browserEvalSchema.safeParse({ action: "exec", expression: "x" });
    expect(r.success).toBe(false);
  });

  it("action='js' rejected without expression", async () => {
    const { browserEvalSchema } = await import("../../src/tools/browser.js");
    const r = browserEvalSchema.safeParse({ action: "js" });
    expect(r.success).toBe(false);
  });
});

// ─── 3. browser_open schema with optional launch ──────────────────────────────

describe("Phase 3 — browser_open schema with optional launch param", () => {
  it("validates pure connect (launch omitted)", async () => {
    const { browserOpenSchema } = await import("../../src/tools/browser.js");
    // browserOpenSchema is a ZodRawShape — wrap with z.object for validation
    const { z } = await import("zod");
    const schema = z.object(browserOpenSchema);
    const r = schema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("validates launch with empty defaults ({})", async () => {
    const { browserOpenSchema } = await import("../../src/tools/browser.js");
    const { z } = await import("zod");
    const schema = z.object(browserOpenSchema);
    const r = schema.safeParse({ launch: {} });
    expect(r.success).toBe(true);
    if (r.success) {
      // Defaults applied
      expect(r.data.launch?.browser).toBe("auto");
      expect(r.data.launch?.userDataDir).toBe("C:\\tmp\\cdp");
      expect(r.data.launch?.waitMs).toBe(10_000);
    }
  });

  it("validates launch with explicit browser/url overrides", async () => {
    const { browserOpenSchema } = await import("../../src/tools/browser.js");
    const { z } = await import("zod");
    const schema = z.object(browserOpenSchema);
    const r = schema.safeParse({
      port: 9222,
      launch: { browser: "edge", url: "https://example.com" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects launch.browser with invalid value", async () => {
    const { browserOpenSchema } = await import("../../src/tools/browser.js");
    const { z } = await import("zod");
    const schema = z.object(browserOpenSchema);
    const r = schema.safeParse({ launch: { browser: "firefox" } });
    expect(r.success).toBe(false);
  });
});

// ─── 4. Old 4 tool names absent from server.tool / server.registerTool calls ──

describe("Phase 3 — old 4 tool names have no server registration", () => {
  const OLD_TOOL_NAMES = [
    "browser_launch",
    "browser_get_dom",
    "browser_get_app_state",
    "browser_disconnect",
  ];

  const SOURCE_FILES = [
    "src/tools/browser.ts",
    "src/server-windows.ts",
  ];

  for (const oldName of OLD_TOOL_NAMES) {
    it(`server.tool("${oldName}", ...) does not appear in any source file`, () => {
      for (const file of SOURCE_FILES) {
        const src = readFileSync(join(ROOT, file), "utf-8");
        const toolCallPattern = `server.tool("${oldName}"`;
        const registerCallPattern = `server.registerTool("${oldName}"`;
        expect(src, `${file} should not register ${oldName} via server.tool`).not.toContain(toolCallPattern);
        expect(src, `${file} should not register ${oldName} via server.registerTool`).not.toContain(registerCallPattern);
      }
    });
  }
});

// ─── 5. stub-tool-catalog integrity ───────────────────────────────────────────

describe("Phase 3 — stub-tool-catalog drops absorbed/privatized 4 names", () => {
  const catalogNames = new Set(STUB_TOOL_CATALOG.map((e) => e.name));

  it("catalog contains browser_open and browser_eval", () => {
    expect(catalogNames.has("browser_open")).toBe(true);
    expect(catalogNames.has("browser_eval")).toBe(true);
  });

  it("catalog does NOT contain browser_launch", () => {
    expect(catalogNames.has("browser_launch")).toBe(false);
  });

  it("catalog does NOT contain browser_get_dom", () => {
    expect(catalogNames.has("browser_get_dom")).toBe(false);
  });

  it("catalog does NOT contain browser_get_app_state", () => {
    expect(catalogNames.has("browser_get_app_state")).toBe(false);
  });

  it("catalog does NOT contain browser_disconnect", () => {
    expect(catalogNames.has("browser_disconnect")).toBe(false);
  });

  it("browser_eval description mentions all 3 actions (js/dom/appState)", () => {
    const entry = STUB_TOOL_CATALOG.find((e) => e.name === "browser_eval");
    expect(entry).toBeDefined();
    expect(entry!.description).toMatch(/js/);
    expect(entry!.description).toMatch(/dom/);
    expect(entry!.description).toMatch(/appState/i);
  });

  it("browser_open description mentions launch parameter", () => {
    const entry = STUB_TOOL_CATALOG.find((e) => e.name === "browser_open");
    expect(entry).toBeDefined();
    expect(entry!.description).toMatch(/launch/);
  });
});

// ─── 6. LLM-exposed string audit ──────────────────────────────────────────────

describe("Phase 3 — no LLM-exposed old browser tool names in descriptions / suggests / errors", () => {
  const AUDIT_FILES = [
    "src/tools/browser.ts",
    "src/tools/_errors.ts",
    "src/tools/desktop-state.ts",
    "src/server-windows.ts",
  ];

  const OLD_NAMES_IN_STRINGS = [
    "browser_launch",
    "browser_get_dom",
    "browser_get_app_state",
    // browser_disconnect handler is internal-only, label may stay in failWith
    // but should not appear in any LLM-exposed description / suggest string
  ];

  for (const oldName of OLD_NAMES_IN_STRINGS) {
    it(`"${oldName}" does not appear in non-comment code of AUDIT_FILES`, () => {
      for (const file of AUDIT_FILES) {
        const src = readFileSync(join(ROOT, file), "utf-8");
        // Strip single-line comments
        const withoutLineComments = src
          .split("\n")
          .map((line) => {
            const commentIdx = line.indexOf("//");
            return commentIdx >= 0 ? line.slice(0, commentIdx) : line;
          })
          .join("\n");
        // Strip block comments
        const stripped = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, "");
        expect(stripped, `${file} non-comment code should not contain ${oldName}`).not.toContain(oldName);
      }
    });
  }
});

// ─── 7. Internal handlers retained (handler 残置方針) ──────────────────────────

describe("Phase 3 — internal handlers retained for tests / future facade", () => {
  it("browserConnectHandler exported (internal helper for browser_open)", async () => {
    const mod = await import("../../src/tools/browser.js");
    expect(typeof mod.browserConnectHandler).toBe("function");
  });

  it("browserLaunchHandler exported (internal helper for browser_open.launch)", async () => {
    const mod = await import("../../src/tools/browser.js");
    expect(typeof mod.browserLaunchHandler).toBe("function");
  });

  it("browserGetDomHandler exported (internal helper for browser_eval.dom)", async () => {
    const mod = await import("../../src/tools/browser.js");
    expect(typeof mod.browserGetDomHandler).toBe("function");
  });

  it("browserGetAppStateHandler exported (internal helper for browser_eval.appState)", async () => {
    const mod = await import("../../src/tools/browser.js");
    expect(typeof mod.browserGetAppStateHandler).toBe("function");
  });

  it("browserDisconnectHandler exported (internal helper, no public registration)", async () => {
    const mod = await import("../../src/tools/browser.js");
    expect(typeof mod.browserDisconnectHandler).toBe("function");
  });

  it("browserEvalJsHandler exported (renamed from browserEvalHandler — js action implementation)", async () => {
    const mod = await import("../../src/tools/browser.js");
    expect(typeof mod.browserEvalJsHandler).toBe("function");
  });

  it("browserEvalHandler exported as the new dispatcher", async () => {
    const mod = await import("../../src/tools/browser.js");
    expect(typeof mod.browserEvalHandler).toBe("function");
  });

  it("browserOpenHandler exported as the new dispatcher", async () => {
    const mod = await import("../../src/tools/browser.js");
    expect(typeof mod.browserOpenHandler).toBe("function");
  });
});
