import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { mouse } from "../engine/nutjs.js";
import {
  enumWindowsInZOrder,
  getWindowProcessId,
  getProcessIdentityByPid,
} from "../engine/win32.js";
import { getHistorySnapshot } from "./_post.js";
import { evaluateInTab } from "../engine/cdp-bridge.js";
import { getCdpPort } from "../utils/desktop-config.js";

const _defaultPort = getCdpPort();

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const getContextSchema = {};

export const getHistorySchema = {
  n: z.coerce.number().int().min(1).max(20).default(5).describe("Number of recent action records to return (max 20)."),
};

export const getDocumentStateSchema = {
  port: z.coerce.number().int().min(1).max(65535).default(_defaultPort).describe(`CDP port (default ${_defaultPort}).`),
  tabId: z.string().optional().describe("CDP tab id (omit for first page)."),
};

// ─────────────────────────────────────────────────────────────────────────────
// get_context — OS / app focused state, no UIA descendants.
// ─────────────────────────────────────────────────────────────────────────────

export const getContextHandler = async (): Promise<ToolResult> => {
  try {
    const wins = enumWindowsInZOrder();
    const fg = wins.find((w) => w.isActive) ?? null;
    const cursor = await mouse.getPosition().catch(() => ({ x: 0, y: 0 }));
    let focusedWindow: { title: string; processName: string; hwnd: string } | null = null;
    let cursorOverWindow: { title: string; hwnd: string } | null = null;

    if (fg) {
      const pid = getWindowProcessId(fg.hwnd);
      const ident = getProcessIdentityByPid(pid);
      focusedWindow = { title: fg.title, processName: ident.processName, hwnd: String(fg.hwnd) };
    }

    // Determine which window the cursor is over (front-most that contains the point)
    for (const w of wins) {
      const r = w.region;
      if (cursor.x >= r.x && cursor.x < r.x + r.width &&
          cursor.y >= r.y && cursor.y < r.y + r.height) {
        cursorOverWindow = { title: w.title, hwnd: String(w.hwnd) };
        break;
      }
    }

    // Detect dialog/modal: heuristic title-keyword match across English and Japanese.
    let hasModal = false;
    const MODAL_RE = /dialog|confirm|prompt|alert|error|警告|エラー|確認|通知|ダイアログ/i;
    for (const w of wins) {
      if (MODAL_RE.test(w.title)) { hasModal = true; break; }
    }

    return ok({
      focusedWindow,
      cursorPos: { x: cursor.x, y: cursor.y },
      cursorOverWindow,
      hasModal,
      pageState: hasModal ? "dialog" : "ready",
      visibleWindows: wins.length,
    });
  } catch (err) {
    return failWith(err, "get_context");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// get_history — recent action posts ring buffer.
// ─────────────────────────────────────────────────────────────────────────────

export const getHistoryHandler = async ({ n }: { n: number }): Promise<ToolResult> => {
  try {
    const items = getHistorySnapshot(n);
    return ok({ count: items.length, actions: items });
  } catch (err) {
    return failWith(err, "get_history");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// get_document_state — Chrome via CDP.
// ─────────────────────────────────────────────────────────────────────────────

export const getDocumentStateHandler = async ({ port, tabId }: { port: number; tabId?: string }): Promise<ToolResult> => {
  try {
    const expression = `
(function() {
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    selection: (window.getSelection && String(window.getSelection())) || "",
    scroll: { x: window.scrollX, y: window.scrollY, maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) },
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
})()
`;
    const r = await evaluateInTab(expression, tabId ?? null, port);
    return ok(r);
  } catch (err) {
    return failWith(err, "get_document_state");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerContextTools(server: McpServer): void {
  server.tool(
    "get_context",
    [
      "Lightweight orientation tool — returns focused window, cursor position, and dialog state.",
      "Cheaper than screenshot(detail='meta'); use as a first step when re-orienting after long pauses.",
    ].join("\n"),
    getContextSchema,
    getContextHandler
  );

  server.tool(
    "get_history",
    [
      "Recent action history (ring buffer, max 20 entries).",
      "Each entry includes tool name, argsDigest, post-state, and timestamp.",
      "Useful to reconstruct context after model interruption or to verify a step occurred.",
    ].join("\n"),
    getHistorySchema,
    getHistoryHandler
  );

  server.tool(
    "get_document_state",
    [
      "CDP — get current Chrome page state: url, title, readyState, selection, scroll position.",
      "Far cheaper than browser_get_dom for orientation.",
    ].join("\n"),
    getDocumentStateSchema,
    getDocumentStateHandler
  );
}
