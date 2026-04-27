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

  // Codex PR #40 P2: stub catalog must preserve action-specific fields for
  // discriminatedUnion dispatchers. Previous generator emitted only
  // {action: string, additionalProperties: true} which dropped fields like
  // expression/selector/maxLength, breaking cross-platform tool discovery.
  it("browser_eval inputSchema is a oneOf with all 3 actions (js/dom/appState)", () => {
    const entry = STUB_TOOL_CATALOG.find((e) => e.name === "browser_eval");
    expect(entry).toBeDefined();
    const schema = entry!.inputSchema as { oneOf?: Array<{ properties?: Record<string, { const?: string }> }> };
    expect(schema.oneOf).toBeDefined();
    expect(schema.oneOf!.length).toBe(3);
    const actions = schema.oneOf!.map((v) => v.properties?.action?.const).sort();
    expect(actions).toEqual(["appState", "dom", "js"]);
  });

  it("browser_eval js variant exposes the expression field", () => {
    const entry = STUB_TOOL_CATALOG.find((e) => e.name === "browser_eval");
    const schema = entry!.inputSchema as {
      oneOf: Array<{ properties: Record<string, unknown>; required?: string[] }>;
    };
    const jsVariant = schema.oneOf.find(
      (v) => (v.properties.action as { const?: string })?.const === "js",
    );
    expect(jsVariant).toBeDefined();
    expect(jsVariant!.properties.expression).toBeDefined();
    expect(jsVariant!.required).toContain("expression");
  });

  it("browser_eval dom variant exposes selector and maxLength fields", () => {
    const entry = STUB_TOOL_CATALOG.find((e) => e.name === "browser_eval");
    const schema = entry!.inputSchema as {
      oneOf: Array<{ properties: Record<string, unknown> }>;
    };
    const domVariant = schema.oneOf.find(
      (v) => (v.properties.action as { const?: string })?.const === "dom",
    );
    expect(domVariant).toBeDefined();
    expect(domVariant!.properties.selector).toBeDefined();
    expect(domVariant!.properties.maxLength).toBeDefined();
  });

  it("browser_eval appState variant exposes selectors and maxBytes fields", () => {
    const entry = STUB_TOOL_CATALOG.find((e) => e.name === "browser_eval");
    const schema = entry!.inputSchema as {
      oneOf: Array<{ properties: Record<string, unknown> }>;
    };
    const appStateVariant = schema.oneOf.find(
      (v) => (v.properties.action as { const?: string })?.const === "appState",
    );
    expect(appStateVariant).toBeDefined();
    expect(appStateVariant!.properties.selectors).toBeDefined();
    expect(appStateVariant!.properties.maxBytes).toBeDefined();
  });

  // Cover all six dispatchers (Phase 2 carry-over plus Phase 3 browser_eval).
  it.each([
    ["keyboard", ["press", "type"]],
    ["clipboard", ["read", "write"]],
    ["window_dock", ["dock", "pin", "unpin"]],
    ["scroll", ["capture", "raw", "smart", "to_element"]],
    ["terminal", ["read", "run", "send"]],
    ["browser_eval", ["appState", "dom", "js"]],
  ])(
    "%s dispatcher has oneOf with action const values: %p",
    (toolName, expectedActions) => {
      const entry = STUB_TOOL_CATALOG.find((e) => e.name === toolName);
      expect(entry, `${toolName} catalog entry`).toBeDefined();
      const schema = entry!.inputSchema as {
        oneOf?: Array<{ properties?: Record<string, { const?: string }> }>;
      };
      expect(schema.oneOf, `${toolName} should use oneOf, not opaque stub`).toBeDefined();
      const actions = schema
        .oneOf!.map((v) => v.properties?.action?.const)
        .filter((a): a is string => typeof a === "string")
        .sort();
      expect(actions).toEqual(expectedActions);
    },
  );
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

// ─── 6.5. classifyLaunchOutcome — Codex PR #40 review fix ─────────────────────
//
// browserOpenHandler must distinguish a launch SUCCESS payload from a launch
// FAILURE payload. Both can be valid JSON, so JSON.parse alone is insufficient
// — failWith returns `{ok:false, code, error}` JSON for caught exceptions like
// spawnDetached permission errors. The classifier inspects the parsed shape.

describe("Phase 3 — classifyLaunchOutcome (Codex PR #40 fix)", () => {
  it("treats success JSON (alreadyRunning) as 'ok'", async () => {
    const { classifyLaunchOutcome } = await import("../../src/tools/browser.js");
    const successText = JSON.stringify({
      port: 9222,
      alreadyRunning: true,
      launched: null,
      tabs: [{ id: "abc", title: "x", url: "about:blank" }],
    });
    expect(classifyLaunchOutcome(successText)).toBe("ok");
  });

  it("treats success JSON (spawned) as 'ok'", async () => {
    const { classifyLaunchOutcome } = await import("../../src/tools/browser.js");
    const successText = JSON.stringify({
      port: 9222,
      alreadyRunning: false,
      launched: { browser: "chrome", path: "...", userDataDir: "..." },
      tabs: [],
    });
    expect(classifyLaunchOutcome(successText)).toBe("ok");
  });

  it("treats failWith JSON ({ok:false, ...}) as 'fail' (Codex regression case)", async () => {
    const { classifyLaunchOutcome } = await import("../../src/tools/browser.js");
    const failureText = JSON.stringify({
      ok: false,
      code: "ToolError",
      error: "browser_open failed: spawnDetached EACCES",
      suggest: ["Try running with admin privileges"],
    });
    expect(classifyLaunchOutcome(failureText)).toBe("fail");
  });

  it("treats plain-text failure (url validation) as 'fail'", async () => {
    const { classifyLaunchOutcome } = await import("../../src/tools/browser.js");
    expect(
      classifyLaunchOutcome(`browser_open: url must not start with '-' (got: "-foo")`)
    ).toBe("fail");
  });

  it("treats plain-text failure (browser not found) as 'fail'", async () => {
    const { classifyLaunchOutcome } = await import("../../src/tools/browser.js");
    expect(
      classifyLaunchOutcome("No supported browser (Chrome/Edge/Brave) found in standard install locations.")
    ).toBe("fail");
  });

  it("treats empty string as 'fail'", async () => {
    const { classifyLaunchOutcome } = await import("../../src/tools/browser.js");
    expect(classifyLaunchOutcome("")).toBe("fail");
  });

  it("does NOT misclassify non-failWith JSON without ok field as 'fail'", async () => {
    const { classifyLaunchOutcome } = await import("../../src/tools/browser.js");
    // Success payload from browserLaunchHandler does not include an `ok` field.
    const text = JSON.stringify({ port: 9222, tabs: [] });
    expect(classifyLaunchOutcome(text)).toBe("ok");
  });

  it("treats {ok:true,...} (defensive) as 'ok'", async () => {
    const { classifyLaunchOutcome } = await import("../../src/tools/browser.js");
    // browserLaunchHandler does not currently return ok:true, but if it ever
    // adopts that convention, the classifier should still treat it as success.
    const text = JSON.stringify({ ok: true, port: 9222, tabs: [] });
    expect(classifyLaunchOutcome(text)).toBe("ok");
  });
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
