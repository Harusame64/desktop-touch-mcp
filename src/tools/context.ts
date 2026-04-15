import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, buildDesc } from "./_types.js";
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
import { getFocusedAndPointInfo } from "../engine/uia-bridge.js";
import { CHROMIUM_TITLE_RE } from "./workspace.js";

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
// get_context v2 — OS + App level (lightweight)
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

    // Cursor-over-window: Z-order hit test (cheap, always available)
    for (const w of wins) {
      const r = w.region;
      if (
        cursor.x >= r.x && cursor.x < r.x + r.width &&
        cursor.y >= r.y && cursor.y < r.y + r.height
      ) {
        cursorOverWindow = { title: w.title, hwnd: String(w.hwnd) };
        break;
      }
    }

    // Modal heuristic
    let hasModal = false;
    const MODAL_RE = /dialog|confirm|prompt|alert|error|警告|エラー|確認|通知|ダイアログ/i;
    for (const w of wins) {
      if (MODAL_RE.test(w.title)) { hasModal = true; break; }
    }

    // ── Semantic level: focusedElement + cursorOverElement ─────────────────
    const fgTitle = fg?.title ?? "";
    const isChromium = CHROMIUM_TITLE_RE.test(fgTitle);

    interface ElementInfo {
      name: string;
      type: string;
      value?: string;
      automationId?: string;
    }

    let focusedElement: ElementInfo | null = null;
    let cursorOverElement: ElementInfo | null = null;
    const hints: Record<string, unknown> = {};

    if (isChromium) {
      hints.chromiumGuard = true;
      // cursorOverElement is always null for Chromium (no cheap UIA hit-test).
      // focusedElement: try UIA first, fall back to CDP document.activeElement.
      let uiaFocusOk = false;
      try {
        const { focused } = await getFocusedAndPointInfo(cursor.x, cursor.y, false, 1500);
        if (focused?.name && focused.controlType !== "Pane") {
          focusedElement = {
            name: focused.name,
            type: focused.controlType,
            ...(focused.automationId ? { automationId: focused.automationId } : {}),
            ...(focused.value != null ? { value: focused.value } : {}),
          };
          hints.focusedElementSource = "uia";
          uiaFocusOk = true;
        }
      } catch {
        // UIA unavailable — proceed to CDP fallback below
      }
      if (!uiaFocusOk) {
        // CDP fallback
        try {
          const cdpInfo = await evaluateInTab(
            `(function(){
              var el=document.activeElement;
              if(!el||el===document.body)return null;
              return {tag:el.tagName,id:el.id,name:el.name||el.getAttribute('name')||'',
                      value:(el.value!==undefined?String(el.value).slice(0,60):''),
                      text:(el.innerText||el.textContent||'').slice(0,60)};
            })()`,
            null,
            _defaultPort
          ) as { tag?: string; id?: string; name?: string; value?: string; text?: string } | null;
          if (cdpInfo) {
            focusedElement = {
              name: cdpInfo.name || cdpInfo.id || cdpInfo.text || cdpInfo.tag || "",
              type: cdpInfo.tag ?? "Element",
              ...(cdpInfo.value ? { value: cdpInfo.value } : {}),
            };
            hints.focusedElementSource = "cdp";
          }
        } catch {
          hints.cdpUnavailable = true;
        }
      }
    } else {
      // Non-Chromium: full UIA path for both fields
      try {
        const { focused, atPoint } = await getFocusedAndPointInfo(cursor.x, cursor.y, true, 2000);
        if (focused?.name) {
          focusedElement = {
            name: focused.name,
            type: focused.controlType,
            ...(focused.automationId ? { automationId: focused.automationId } : {}),
            ...(focused.value != null ? { value: focused.value } : {}),
          };
          hints.focusedElementSource = "uia";
        }
        if (atPoint?.name) {
          cursorOverElement = {
            name: atPoint.name,
            type: atPoint.controlType,
            ...(atPoint.automationId ? { automationId: atPoint.automationId } : {}),
          };
        }
      } catch {
        hints.uiaStale = true;
      }
    }

    // pageState
    let pageState: "ready" | "loading" | "dialog" = hasModal ? "dialog" : "ready";
    if (isChromium && !hasModal) {
      try {
        const state = await evaluateInTab("document.readyState", null, _defaultPort);
        if (state !== "complete") pageState = "loading";
      } catch {
        // CDP not connected — leave as "ready"
      }
    }

    return ok({
      focusedWindow,
      cursorPos: { x: cursor.x, y: cursor.y },
      cursorOverWindow,
      focusedElement,
      cursorOverElement,
      hasModal,
      pageState,
      visibleWindows: wins.length,
      ...(Object.keys(hints).length > 0 ? { hints } : {}),
    });
  } catch (err) {
    return failWith(err, "get_context");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// get_history — recent action posts ring buffer
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
// get_document_state — Chrome via CDP
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
    buildDesc({
      purpose: "Query focused window, focused element, cursor position, and page state in one call — far cheaper than any screenshot for confirming current state after an action.",
      details: "Returns focusedWindow (title, hwnd), focusedElement (name, type, value), cursorPos {x,y}, cursorOverElement (name, type), hasModal (boolean), pageState ('ready'|'loading'|'dialog'|'error'). Does NOT enumerate descendants — use screenshot(detail='text') or get_ui_elements for the full clickable element list. Chromium: cursorOverElement is null (UIA sparse); focusedElement may fall back to CDP document.activeElement; hints.focusedElementSource reports which was used ('uia' or 'cdp').",
      prefer: "Use after keyboard_type or set_element_value to confirm the value landed in the expected field — cheaper than a verification screenshot. Use instead of screenshot(detail='meta') when the question is only \"which window/control has focus.\"",
      caveats: "Cannot detect non-UIA elements (custom-drawn UIs, game overlays). hasModal only detects modal dialogs exposed via UIA — browser alert/confirm dialogs may not appear here.",
    }),
    getContextSchema,
    getContextHandler
  );

  server.tool(
    "get_history",
    "Return recent action history (ring buffer, last 20 entries) with tool name, argsDigest, post-state, and timestamp. Use to reconstruct context after model interruption or verify a step occurred.",
    getHistorySchema,
    getHistoryHandler
  );

  server.tool(
    "get_document_state",
    "Return current Chrome page state via CDP: url, title, readyState, selection, and scroll position. Far cheaper than browser_get_dom for page orientation.",
    getDocumentStateSchema,
    getDocumentStateHandler
  );
}
