import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { evaluateInTab } from "../engine/cdp-bridge.js";
import { scrollElementIntoView } from "../engine/uia-bridge.js";
import { getCdpPort } from "../utils/desktop-config.js";
import { ok, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith, failArgs } from "./_errors.js";

const _defaultPort = getCdpPort();

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const scrollToElementSchema = {
  name: z.string().optional().describe(
    "Partial name/label of the element (UIA name match). Use for native app elements. " +
    "At least one of name or selector must be provided."
  ),
  selector: z.string().optional().describe(
    "CSS selector for the element (Chrome/Edge only). " +
    "At least one of name or selector must be provided."
  ),
  windowTitle: z.string().optional().describe(
    "Partial window title (required for native path when name is used)"
  ),
  block: z.enum(["start", "center", "end", "nearest"]).default("center").describe(
    "Vertical alignment after scroll — start/center/end/nearest (Chrome path only, default: center)"
  ),
  tabId: z.string().optional().describe("Tab ID (Chrome path only). Omit for first page tab."),
  port: z.coerce.number().int().min(1).max(65535).default(_defaultPort).describe(
    `CDP port for Chrome path (default ${_defaultPort})`
  ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export const scrollToElementHandler = async ({
  name,
  selector,
  windowTitle,
  block,
  tabId,
  port,
}: {
  name?: string;
  selector?: string;
  windowTitle?: string;
  block: "start" | "center" | "end" | "nearest";
  tabId?: string;
  port: number;
}): Promise<ToolResult> => {
  if (!name && !selector) {
    return failArgs("Provide at least one of: name, selector", "scroll_to_element", {});
  }

  // ── Chrome / CDP path ────────────────────────────────────────────────────
  if (selector) {
    try {
      const expr = `
(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
  // Use 'instant' for automation — 'smooth' takes 300-500ms before coords stabilize
  el.scrollIntoView({ block: ${JSON.stringify(block)}, inline: 'nearest', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return { ok: true, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 80), viewportTop: Math.round(r.top), viewportBottom: Math.round(r.bottom) };
})()`;
      const result = await evaluateInTab(expr, tabId ?? null, port);
      const res = result as { ok: boolean; error?: string; tag?: string; text?: string; viewportTop?: number; viewportBottom?: number };
      if (!res.ok) {
        return failWith(res.error ?? "scroll_to_element failed", "scroll_to_element", { selector });
      }
      const { ok: _ok, error: _err, ...rest } = res;
      return ok({ ok: true, path: "cdp", selector, block, ...rest });
    } catch (err) {
      return failWith(err, "scroll_to_element", { selector });
    }
  }

  // ── Native / UIA path ────────────────────────────────────────────────────
  if (name && windowTitle) {
    try {
      const result = await scrollElementIntoView(windowTitle, name);
      if (!result.ok) {
        return failWith(result.error ?? "scroll_to_element failed", "scroll_to_element", { windowTitle, name });
      }
      return ok({ ok: true, path: "uia", name, windowTitle, scrolled: result.scrolled, ...(result.error && { note: result.error }) });
    } catch (err) {
      return failWith(err, "scroll_to_element", { windowTitle, name });
    }
  }

  return failArgs(
    "For the native path, both name and windowTitle are required. For the Chrome path, provide selector.",
    "scroll_to_element",
    { name, selector, windowTitle }
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerScrollToElementTools(server: McpServer): void {
  server.tool(
    "scroll_to_element",
    buildDesc({
      purpose: "Scroll a named element into the visible viewport without manually computing scroll amounts.",
      details: "Two paths: (1) Chrome/Edge (CDP): provide selector — calls el.scrollIntoView({block, behavior:'instant'}) via CDP. Uses instant (not smooth) scroll so coords stabilize immediately. block controls vertical alignment (start/center/end/nearest, default: center). (2) Native apps (UIA): provide name + windowTitle — calls ScrollItemPattern.ScrollIntoView(). Returns scrolled:true on success, scrolled:false if the element doesn't expose ScrollItemPattern (fall back to scroll + screenshot).",
      prefer: "Use over scroll + screenshot loops when you know the element name or selector. Pairs well with screenshot(detail='text') to confirm the element is now in-view (viewportPosition:'in-view'). For Chrome, browser_get_interactive shows viewportPosition for all elements — use that to decide whether scrolling is needed before calling this tool.",
      caveats: "Chrome path requires browser_connect (CDP active). Native path requires the element to implement UIA ScrollItemPattern — some custom/third-party controls do not; in that case scrolled:false is returned. SPA virtual-scroll lists (React Virtualized, TanStack) may not respond to scrollIntoView.",
      examples: [
        "scroll_to_element({selector: '#create-release-btn'}) — Chrome, scroll to button",
        "scroll_to_element({name: 'Create Release', windowTitle: 'Glama'}) — native UIA",
        "scroll_to_element({selector: '.submit', block: 'start'}) — align to top of viewport",
      ],
    }),
    scrollToElementSchema,
    scrollToElementHandler
  );
}
