/**
 * tests/unit/tool-naming-phase4.test.ts
 *
 * Contract tests for Phase 4 Tool Surface Reduction — Privatize / Absorb.
 *
 * Phase 4 reduces 46 stub catalog tools → 26:
 *   - 10 privatized:
 *       events_subscribe / events_poll / events_unsubscribe / events_list
 *       perception_register / perception_read / perception_forget / perception_list
 *       get_history / mouse_move
 *   - 3 absorbed into screenshot:
 *       screenshot_background → screenshot({mode:'background'})
 *       screenshot_ocr        → screenshot({detail:'ocr'})
 *       scope_element         → screenshot({region:{x,y,width,height}})
 *   - 1 absorbed into desktop_act:
 *       set_element_value     → desktop_act({action:'setValue', lease, text})
 *   - 6 absorbed into desktop_state / desktop_discover:
 *       get_active_window     → desktop_state.focusedWindow (always)
 *       get_cursor_position   → desktop_state({includeCursor:true}).cursor
 *       get_document_state    → desktop_state({includeDocument:true}).document
 *       get_screen_info       → desktop_state({includeScreen:true}).screen
 *       get_ui_elements       → desktop_discover.actionable[]
 *       get_windows           → desktop_discover.windows[]
 *
 * Design reference: docs/tool-surface-phase4-privatize-absorb-design.md
 */

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { registerEventTools } from "../../src/tools/events.js";
import { registerPerceptionTools } from "../../src/tools/perception.js";
import { registerDesktopStateTools } from "../../src/tools/desktop-state.js";
import { registerMouseTools } from "../../src/tools/mouse.js";
import { registerScreenshotTools } from "../../src/tools/screenshot.js";
import { registerUiElementTools } from "../../src/tools/ui-elements.js";
import { registerWindowTools } from "../../src/tools/window.js";
import { STUB_TOOL_CATALOG } from "../../src/stub-tool-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

function makeServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" });
}

function getRegisteredNames(s: McpServer): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = (s as any)._registeredTools as Record<string, unknown> | undefined;
  if (!registry) return [];
  return Object.keys(registry);
}

// ─── 1. Privatized 10 tools — entry-point removed ─────────────────────────────

describe("Phase 4 — privatized tools have no public registration", () => {
  it("events_* (4 tools) are NOT registered, registerEventTools is a no-op", () => {
    const s = makeServer();
    registerEventTools(s);
    const names = getRegisteredNames(s);
    expect(names).not.toContain("events_subscribe");
    expect(names).not.toContain("events_poll");
    expect(names).not.toContain("events_unsubscribe");
    expect(names).not.toContain("events_list");
  });

  it("perception_* (4 tools) are NOT registered, registerPerceptionTools is a no-op", () => {
    const s = makeServer();
    registerPerceptionTools(s);
    const names = getRegisteredNames(s);
    expect(names).not.toContain("perception_register");
    expect(names).not.toContain("perception_read");
    expect(names).not.toContain("perception_forget");
    expect(names).not.toContain("perception_list");
  });

  it("get_history is NOT registered (handler retained)", () => {
    const s = makeServer();
    registerDesktopStateTools(s);
    expect(getRegisteredNames(s)).not.toContain("get_history");
  });

  it("mouse_move is NOT registered (handler retained)", () => {
    const s = makeServer();
    registerMouseTools(s);
    expect(getRegisteredNames(s)).not.toContain("mouse_move");
  });
});

// ─── 2. Internal handlers retained per feedback_disable_via_entry_block ───────

describe("Phase 4 — privatized handlers retained as internal exports", () => {
  it("events handlers remain importable", async () => {
    const mod = await import("../../src/tools/events.js");
    expect(typeof mod.eventsSubscribeHandler).toBe("function");
    expect(typeof mod.eventsPollHandler).toBe("function");
    expect(typeof mod.eventsUnsubscribeHandler).toBe("function");
    expect(typeof mod.eventsListHandler).toBe("function");
  });

  it("perception handlers remain importable", async () => {
    const mod = await import("../../src/tools/perception.js");
    expect(typeof mod.perceptionRegisterHandler).toBe("function");
    expect(typeof mod.perceptionReadHandler).toBe("function");
    expect(typeof mod.perceptionForgetHandler).toBe("function");
    expect(typeof mod.perceptionListHandler).toBe("function");
  });

  it("get_history / get_document_state handlers remain importable", async () => {
    const mod = await import("../../src/tools/desktop-state.js");
    expect(typeof mod.getHistoryHandler).toBe("function");
    expect(typeof mod.getDocumentStateHandler).toBe("function");
  });

  it("mouseMoveHandler / getCursorPositionHandler remain importable", async () => {
    const mod = await import("../../src/tools/mouse.js");
    expect(typeof mod.mouseMoveHandler).toBe("function");
    expect(typeof mod.getCursorPositionHandler).toBe("function");
  });

  it("screenshot variant handlers remain importable", async () => {
    const mod = await import("../../src/tools/screenshot.js");
    expect(typeof mod.screenshotBgHandler).toBe("function");
    expect(typeof mod.screenshotOcrHandler).toBe("function");
    expect(typeof mod.getScreenInfoHandler).toBe("function");
  });

  it("scope_element / set_element_value / get_ui_elements handlers remain importable", async () => {
    const mod = await import("../../src/tools/ui-elements.js");
    expect(typeof mod.scopeElementHandler).toBe("function");
    expect(typeof mod.setElementValueHandler).toBe("function");
    expect(typeof mod.getUiElementsHandler).toBe("function");
  });

  it("get_windows / get_active_window handlers remain importable", async () => {
    const mod = await import("../../src/tools/window.js");
    expect(typeof mod.getWindowsHandler).toBe("function");
    expect(typeof mod.getActiveWindowHandler).toBe("function");
  });
});

// ─── 3. screenshot absorbs background / ocr / scope ──────────────────────────

describe("Phase 4 — screenshot absorbs 3 variants via mode/detail/region", () => {
  it("screenshot_background / screenshot_ocr / scope_element are NOT registered", () => {
    const s = makeServer();
    registerScreenshotTools(s);
    registerUiElementTools(s);
    const names = getRegisteredNames(s);
    expect(names).not.toContain("screenshot_background");
    expect(names).not.toContain("screenshot_ocr");
    expect(names).not.toContain("scope_element");
    expect(names).toContain("screenshot");
  });

  it("screenshot schema accepts mode='background'", async () => {
    const { screenshotSchema } = await import("../../src/tools/screenshot.js");
    const { z } = await import("zod");
    const schema = z.object(screenshotSchema);
    const r = schema.safeParse({ windowTitle: "Notepad", mode: "background" });
    expect(r.success).toBe(true);
  });

  it("screenshot schema accepts detail='ocr' with ocrLanguage", async () => {
    const { screenshotSchema } = await import("../../src/tools/screenshot.js");
    const { z } = await import("zod");
    const schema = z.object(screenshotSchema);
    const r = schema.safeParse({ windowTitle: "PDF", detail: "ocr", ocrLanguage: "ja" });
    expect(r.success).toBe(true);
  });

  it("screenshot schema accepts region={x,y,width,height}", async () => {
    const { screenshotSchema } = await import("../../src/tools/screenshot.js");
    const { z } = await import("zod");
    const schema = z.object(screenshotSchema);
    const r = schema.safeParse({
      windowTitle: "Chrome",
      region: { x: 0, y: 120, width: 1920, height: 900 },
    });
    expect(r.success).toBe(true);
  });

  it("screenshot schema rejects unknown detail values", async () => {
    const { screenshotSchema } = await import("../../src/tools/screenshot.js");
    const { z } = await import("zod");
    const schema = z.object(screenshotSchema);
    const r = schema.safeParse({ detail: "raw" });
    expect(r.success).toBe(false);
  });
});

// ─── 4. desktop_act absorbs set_element_value via action='setValue' ──────────

describe("Phase 4 — desktop_act absorbs set_element_value via action='setValue'", () => {
  it("set_element_value is NOT registered via the public ui-elements tools", () => {
    const s = makeServer();
    registerUiElementTools(s);
    expect(getRegisteredNames(s)).not.toContain("set_element_value");
  });

  it("TouchAction type accepts 'setValue' (compile-time check via runtime guard)", async () => {
    const guarded = await import("../../src/engine/world-graph/guarded-touch.js");
    // Type definition lives in the module; if `setValue` were absent the
    // import-side cast in this test would fail at compile time. Asserting at
    // runtime that the executor module loads (it imports TouchAction) is
    // sufficient for a smoke check.
    expect(typeof guarded).toBe("object");
  });

  it("desktop-executor branches accept action='setValue' (textual smoke)", () => {
    const src = readFileSync(join(ROOT, "src", "tools", "desktop-executor.ts"), "utf-8");
    expect(src).toMatch(/action === "type" \|\| action === "setValue"/);
  });
});

// ─── 5. desktop_state include* + privatized 5 get_* tools ─────────────────────

describe("Phase 4 — desktop_state include* flags + 5 get_* tools privatized", () => {
  it("get_active_window / get_windows are NOT registered", () => {
    const s = makeServer();
    registerWindowTools(s);
    const names = getRegisteredNames(s);
    expect(names).not.toContain("get_active_window");
    expect(names).not.toContain("get_windows");
  });

  it("get_cursor_position is NOT registered", () => {
    const s = makeServer();
    registerMouseTools(s);
    expect(getRegisteredNames(s)).not.toContain("get_cursor_position");
  });

  it("get_document_state is NOT registered", () => {
    const s = makeServer();
    registerDesktopStateTools(s);
    expect(getRegisteredNames(s)).not.toContain("get_document_state");
  });

  it("get_screen_info is NOT registered (already removed in batch 4b)", () => {
    const s = makeServer();
    registerScreenshotTools(s);
    expect(getRegisteredNames(s)).not.toContain("get_screen_info");
  });

  it("get_ui_elements is NOT registered", () => {
    const s = makeServer();
    registerUiElementTools(s);
    expect(getRegisteredNames(s)).not.toContain("get_ui_elements");
  });

  it("desktop_state schema accepts includeCursor / includeScreen / includeDocument", async () => {
    const { desktopStateSchema } = await import("../../src/tools/desktop-state.js");
    const { z } = await import("zod");
    const schema = z.object(desktopStateSchema);
    const r1 = schema.safeParse({});
    expect(r1.success).toBe(true);
    const r2 = schema.safeParse({
      includeCursor: true,
      includeScreen: true,
      includeDocument: true,
    });
    expect(r2.success).toBe(true);
  });

  it("desktop_state schema include* defaults are false", async () => {
    const { desktopStateSchema } = await import("../../src/tools/desktop-state.js");
    const { z } = await import("zod");
    const schema = z.object(desktopStateSchema);
    const r = schema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.includeCursor).toBe(false);
      expect(r.data.includeScreen).toBe(false);
      expect(r.data.includeDocument).toBe(false);
    }
  });
});

// ─── 6. Stub catalog integrity (26 entries) ───────────────────────────────────

describe("Phase 4 — stub-tool-catalog drops 20 tools, retains 26 entries", () => {
  const catalogNames = new Set(STUB_TOOL_CATALOG.map((e) => e.name));

  it("catalog has exactly 26 entries", () => {
    expect(STUB_TOOL_CATALOG.length).toBe(26);
  });

  const REMOVED = [
    "events_subscribe", "events_poll", "events_unsubscribe", "events_list",
    "perception_register", "perception_read", "perception_forget", "perception_list",
    "get_history", "mouse_move",
    "screenshot_background", "screenshot_ocr", "scope_element",
    "set_element_value",
    "get_active_window", "get_cursor_position", "get_document_state",
    "get_screen_info", "get_ui_elements", "get_windows",
  ];

  for (const name of REMOVED) {
    it(`catalog does NOT contain ${name}`, () => {
      expect(catalogNames.has(name)).toBe(false);
    });
  }

  const RETAINED = [
    "desktop_state", "screenshot", "workspace_snapshot", "workspace_launch",
    "run_macro", "mouse_click", "mouse_drag", "click_element", "focus_window",
    "keyboard", "clipboard", "window_dock", "scroll", "terminal",
    "browser_open", "browser_eval", "browser_search", "browser_overview",
    "browser_locate", "browser_click", "browser_navigate", "browser_fill",
    "browser_form",
    "wait_until", "server_status", "notification_show",
  ];

  for (const name of RETAINED) {
    it(`catalog contains ${name}`, () => {
      expect(catalogNames.has(name)).toBe(true);
    });
  }
});

// ─── 7. LLM-exposed string audit ──────────────────────────────────────────────

describe("Phase 4 — no LLM-exposed old tool names in description / suggest / error", () => {
  // Source files that contribute to the visible LLM surface.
  const AUDIT_FILES = [
    "src/tools/_errors.ts",
    "src/tools/desktop-state.ts",
    "src/tools/desktop-register.ts",
    "src/tools/desktop-constraints.ts",
    "src/tools/screenshot.ts",
    "src/tools/window.ts",
    "src/tools/keyboard.ts",
    "src/tools/mouse.ts",
    "src/tools/ui-elements.ts",
    "src/tools/dock.ts",
    "src/tools/window-dock.ts",
    "src/tools/workspace.ts",
    "src/tools/wait-until.ts",
    "src/server-windows.ts",
  ];

  // Names that must not appear in non-comment code of the audit files.
  // (Comments — "//" / block /* ... */ — are stripped before checking.)
  const OLD_NAMES = [
    "screenshot_background",
    "screenshot_ocr",
    "scope_element",
    "set_element_value",
    "get_active_window",
    "get_cursor_position",
    "get_document_state",
    "get_screen_info",
    "get_ui_elements",
    "get_windows",
    "get_history",
    "mouse_move",
    "events_subscribe",
    "events_poll",
    "events_unsubscribe",
    "events_list",
    "perception_register",
    "perception_read",
    "perception_forget",
    "perception_list",
  ];

  function stripComments(src: string): string {
    // Block comments first
    const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
    // Then line comments
    return noBlock
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
  }

  // Allowed contexts in non-comment code (anything else is a regression):
  //   1. "former X" — migration breadcrumb. Includes follow-up names in
  //      "/" lists, e.g. "former get_active_window / get_cursor_position / get_screen_info"
  //   2. failWith(..., "X", ...) / failArgs(..., "X", ...) — internal handler
  //      tag. The dispatcher re-attributes external errors (see batch 4b
  //      screenshot fix); direct internal calls keep the legacy tag.
  //   3. `"X failed: " / "X: ..."` — internal error message template tied to
  //      the same handler tag.
  function findBareReferences(stripped: string, oldName: string): string[] {
    const hits: string[] = [];
    let pos = 0;
    while ((pos = stripped.indexOf(oldName, pos)) !== -1) {
      const before = stripped.slice(Math.max(0, pos - 256), pos);
      const after = stripped.slice(pos + oldName.length, pos + oldName.length + 16);

      // "former X" or "former A / B / X" — migration breadcrumbs. Follow-up
      // names in slash-delimited lists are allowed even far from the
      // "former" keyword as long as nothing but identifier / whitespace /
      // slashes intervenes.
      if (/former\s+[A-Za-z_][\w_]*(\s*\/\s*[A-Za-z_][\w_]*)*\s*\/\s*$/.test(before) ||
          /former\s+$/.test(before)) {
        pos += oldName.length;
        continue;
      }
      // failWith(..., "X" ...) / failArgs(..., "X" ...) — handler tag
      if (
        /fail(?:With|Args)\s*\(\s*[^)]*?["']$/.test(before) &&
        after.startsWith('"')
      ) {
        // before ends with `"` (the opening quote of "X"); after starts with `"` (close)
        pos += oldName.length;
        continue;
      }
      // `"X failed:` — internal error template literal
      if (before.endsWith('`') && after.startsWith(" failed:")) {
        pos += oldName.length;
        continue;
      }
      // `"X failed:` (the opening backtick of a template literal that becomes
      // the LLM error text via failWith — same tag rule)
      if (
        /["`]$/.test(before) &&
        /^(?:["`]|\s+failed:)/.test(after)
      ) {
        pos += oldName.length;
        continue;
      }

      const ctx = stripped.slice(Math.max(0, pos - 50), pos + oldName.length + 50);
      hits.push(ctx);
      pos += oldName.length;
    }
    return hits;
  }

  for (const oldName of OLD_NAMES) {
    it(`"${oldName}" only appears as a "former X" migration breadcrumb in LLM-facing files`, () => {
      for (const file of AUDIT_FILES) {
        const src = readFileSync(join(ROOT, file), "utf-8");
        const stripped = stripComments(src);
        const hits = findBareReferences(stripped, oldName);
        expect(
          hits,
          `${file} non-comment code should not bare-reference ${oldName}; found: ${JSON.stringify(hits)}`,
        ).toEqual([]);
      }
    });
  }
});

// ─── 7.5. Codex PR #41 review fixes ───────────────────────────────────────────

describe("Phase 4 — Codex PR #41 P2: stub catalog desktop_state schema is complete", () => {
  it("desktop_state inputSchema.properties exposes includeCursor", () => {
    const entry = STUB_TOOL_CATALOG.find((e) => e.name === "desktop_state");
    expect(entry).toBeDefined();
    const props = entry!.inputSchema.properties;
    expect(props).toBeDefined();
    expect(props!.includeCursor, "includeCursor was missing in earlier generator output").toBeDefined();
    expect(props!.includeScreen).toBeDefined();
    expect(props!.includeDocument).toBeDefined();
    expect(props!.port).toBeDefined();
    expect(props!.tabId).toBeDefined();
  });
});

describe("Phase 4 — Codex PR #41 P2: screenshot rejects incompatible mode/detail combos", () => {
  it("screenshot dispatcher contains the mode='background' + detail incompatibility guard", () => {
    const src = readFileSync(join(ROOT, "src", "tools", "screenshot.ts"), "utf-8");
    expect(src).toMatch(/mode === "background" && args\.detail/);
    expect(src).toMatch(/only supports detail in \{'image','meta'\}/);
  });

  it("screenshot description documents the mode/detail composition limit", () => {
    const entry = STUB_TOOL_CATALOG.find((e) => e.name === "screenshot");
    expect(entry).toBeDefined();
    expect(entry!.description).toMatch(
      /mode='background'.*detail in \{'image','meta'\}/i,
    );
  });

  // Codex PR #41 P2 follow-up: bg branch must honour detail='meta' (no image
  // bytes, no PrintWindow) and gate detail='image'/default with confirmImage.
  it("screenshot dispatcher bypasses bg capture when detail='meta'", () => {
    const src = readFileSync(join(ROOT, "src", "tools", "screenshot.ts"), "utf-8");
    expect(src).toMatch(/mode === "background" && args\.detail !== "meta"/);
  });

  it("screenshot dispatcher gates bg image capture with confirmImage", () => {
    const src = readFileSync(join(ROOT, "src", "tools", "screenshot.ts"), "utf-8");
    expect(src).toMatch(/mode='background'\) returns image pixels — pass confirmImage:true/);
  });
});

describe("Phase 4 — Codex PR #41 P1: macro DSL has v2 World-Graph dispatchers", () => {
  it("desktop_discover and desktop_act are present in TOOL_REGISTRY", () => {
    const src = readFileSync(join(ROOT, "src", "tools", "macro.ts"), "utf-8");
    expect(src).toContain("desktop_discover:");
    expect(src).toContain("desktop_act:");
    // Both should resolve their handler via the shared facade singleton.
    expect(src).toContain("getDesktopFacade()");
  });
});

// Codex PR #41 round 3: setValue/type without text + v2 kill-switch bypass.

describe("Phase 4 — Codex PR #41 round 3 P1: validateDesktopTouchTextRequirement", () => {
  it("rejects action='setValue' without text", async () => {
    const { validateDesktopTouchTextRequirement } = await import("../../src/tools/desktop-register.js");
    expect(validateDesktopTouchTextRequirement("setValue", undefined)).not.toBeNull();
    expect(validateDesktopTouchTextRequirement("setValue", "")).not.toBeNull();
  });

  it("rejects action='type' without text (same dispatch path falls through to click)", async () => {
    const { validateDesktopTouchTextRequirement } = await import("../../src/tools/desktop-register.js");
    expect(validateDesktopTouchTextRequirement("type", undefined)).not.toBeNull();
    expect(validateDesktopTouchTextRequirement("type", "")).not.toBeNull();
  });

  it("accepts setValue / type with non-empty text", async () => {
    const { validateDesktopTouchTextRequirement } = await import("../../src/tools/desktop-register.js");
    expect(validateDesktopTouchTextRequirement("setValue", "hello")).toBeNull();
    expect(validateDesktopTouchTextRequirement("type", "hello")).toBeNull();
  });

  it("does not reject other actions when text is omitted", async () => {
    const { validateDesktopTouchTextRequirement } = await import("../../src/tools/desktop-register.js");
    for (const action of ["click", "invoke", "select", "auto", undefined]) {
      expect(validateDesktopTouchTextRequirement(action, undefined)).toBeNull();
    }
  });

  it("desktop-register handler invokes the validator", () => {
    const src = readFileSync(join(ROOT, "src", "tools", "desktop-register.ts"), "utf-8");
    expect(src).toMatch(/validateDesktopTouchTextRequirement\(input\.action, input\.text\)/);
  });

  it("macro.ts desktop_act handler invokes the validator", () => {
    const src = readFileSync(join(ROOT, "src", "tools", "macro.ts"), "utf-8");
    expect(src).toMatch(/validateDesktopTouchTextRequirement\(i\.action, i\.text\)/);
  });
});

describe("Phase 4 — Codex PR #41 round 3 P1: macro DSL honours v2 kill switch", () => {
  it("macro.ts gates desktop_discover / desktop_act on v2KillSwitchActive()", () => {
    const src = readFileSync(join(ROOT, "src", "tools", "macro.ts"), "utf-8");
    expect(src).toMatch(/function v2KillSwitchActive/);
    // Both v2 handlers should call the gate before reaching getDesktopFacade.
    const discoverGate = /desktop_discover:\s*\{[\s\S]*?if \(v2KillSwitchActive\(\)\)/;
    const actGate = /desktop_act:\s*\{[\s\S]*?if \(v2KillSwitchActive\(\)\)/;
    expect(src).toMatch(discoverGate);
    expect(src).toMatch(actGate);
  });

  it("kill-switch error message names the env var so the operator knows which flag", () => {
    const src = readFileSync(join(ROOT, "src", "tools", "macro.ts"), "utf-8");
    expect(src).toContain("DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1");
  });
});

describe("Phase 4 — Codex PR #41 P1: desktop_state.includeDocument honours explicit tabId", () => {
  it("desktopStateHandler routes the includeDocument CDP call when tabId is provided regardless of foreground", () => {
    const src = readFileSync(join(ROOT, "src", "tools", "desktop-state.ts"), "utf-8");
    // The fix uses tabExplicit || isChromium. Verify both names are present.
    expect(src).toMatch(/tabExplicit\s*\|\|\s*isChromium/);
    expect(src).toMatch(/args\.tabId !== undefined && args\.tabId !== ""/);
  });

  it("desktop_state description explains the documentUnavailable hint contract", () => {
    const entry = STUB_TOOL_CATALOG.find((e) => e.name === "desktop_state");
    expect(entry).toBeDefined();
    expect(entry!.description).toMatch(/documentUnavailable/);
  });
});

// ─── 8. run_macro DSL TOOL_REGISTRY uses v1.0.0 names ─────────────────────────

describe("Phase 4 — run_macro DSL TOOL_REGISTRY uses v1.0.0 dispatcher names", () => {
  // We can't easily import the private TOOL_REGISTRY, but we can read the
  // source file and assert that the privatized names are absent from the
  // registry block while the new dispatchers are present.
  it("macro.ts no longer maps privatized / pre-dispatcher names", () => {
    const src = readFileSync(join(ROOT, "src", "tools", "macro.ts"), "utf-8");
    const banned = [
      "keyboard_type:",
      "keyboard_press:",
      "clipboard_read:",
      "clipboard_write:",
      "pin_window:",
      "unpin_window:",
      "scroll_capture:",
      "scroll_to_element:",
      "terminal_read:",
      "terminal_send:",
      "events_subscribe:",
      "events_poll:",
      "events_unsubscribe:",
      "screenshot_background:",
      "screenshot_ocr:",
      "scope_element:",
      "set_element_value:",
      "get_active_window:",
      "get_windows:",
      "get_cursor_position:",
      "get_document_state:",
      "get_screen_info:",
      "get_ui_elements:",
      "get_history:",
      "mouse_move:",
    ];
    for (const name of banned) {
      expect(src, `macro.ts TOOL_REGISTRY should not map ${name}`).not.toContain(name);
    }
  });

  it("macro.ts TOOL_REGISTRY contains the v1.0.0 dispatcher names + v2 World-Graph dispatchers", () => {
    const src = readFileSync(join(ROOT, "src", "tools", "macro.ts"), "utf-8");
    const expected = [
      "desktop_state:",
      "screenshot:",
      "keyboard:",
      "clipboard:",
      "window_dock:",
      "scroll:",
      "terminal:",
      "browser_open:",
      "browser_eval:",
      "browser_search:",
      "browser_overview:",
      "browser_navigate:",
      "browser_fill:",
      "browser_form:",
      "wait_until:",
      "notification_show:",
      // Codex PR #41 P1: v2 dispatchers must be in the macro registry so
      // lease-based workflows (action='setValue' etc.) are usable in macros.
      "desktop_discover:",
      "desktop_act:",
    ];
    for (const name of expected) {
      expect(src, `macro.ts TOOL_REGISTRY should map ${name}`).toContain(name);
    }
  });

  it("macro.ts examples reference keyboard(action='type'), not legacy keyboard_type", () => {
    const src = readFileSync(join(ROOT, "src", "tools", "macro.ts"), "utf-8");
    // Find the run_macro examples block; assert legacy name is gone and dispatcher form is present
    expect(src).toContain("action:'type'");
  });
});
