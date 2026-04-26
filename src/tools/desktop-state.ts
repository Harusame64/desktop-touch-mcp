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
import { listRecentTargetKeys } from "../engine/perception/target-timeline.js";
import { evaluateInTab } from "../engine/cdp-bridge.js";
import { getCdpPort } from "../utils/desktop-config.js";
import { getFocusedAndPointInfo } from "../engine/uia-bridge.js";
import { CHROMIUM_TITLE_RE } from "./workspace.js";
import { getSlotSnapshot } from "../engine/perception/hot-target-cache.js";
import type { AttentionState } from "../engine/perception/types.js";

const _defaultPort = getCdpPort();

/**
 * Heuristic regex used by desktop_state.hasModal to flag windows whose titles
 * look like modal dialogs.
 *
 * English keywords use \b word boundaries so that substring noise does not
 * trigger false positives — e.g. "errors" must NOT match /error/, "Prompt
 * Engineering" must NOT match /prompt/, "Confirmation" must NOT match
 * /confirm/, "Alerting" must NOT match /alert/, "Dialogue" must NOT match
 * /dialog/. The bare "prompt" keyword is intentionally absent because it is
 * almost always a non-modal noun in real-world window titles.
 *
 * Japanese keywords are matched as bare substrings since \b does not recognise
 * Japanese word boundaries; substring false positives for these terms are rare
 * in practice (window titles like "通知センター" exist but are infrequent).
 *
 * Exported so unit tests can pin both the true-positive and false-positive
 * contracts down — see tests/unit/modal-detection.test.ts.
 */
export const MODAL_RE = /\b(?:dialog|confirm|alert|error|warning|save as)\b|警告|エラー|確認|通知|ダイアログ|名前を付けて/i;

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const desktopStateSchema = {};

export const getHistorySchema = {
  n: z.coerce.number().int().min(1).max(20).default(5).describe("Number of recent action records to return (max 20)."),
};

export const getDocumentStateSchema = {
  port: z.coerce.number().int().min(1).max(65535).default(_defaultPort).describe(`CDP port (default ${_defaultPort}).`),
  tabId: z.string().optional().describe("CDP tab id (omit for first page)."),
};

// ─────────────────────────────────────────────────────────────────────────────
// desktop_state — OS + App level (lightweight)
// ─────────────────────────────────────────────────────────────────────────────

export const desktopStateHandler = async (): Promise<ToolResult> => {
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

    // ── Attention signal from Hot Target Cache ─────────────────────────────
    // Look up the focused window in the hot-target-cache. If a slot exists,
    // surface its attention value. Fallback to "ok" when no slot is found
    // (lens not registered / Auto Perception OFF) — this is the safe baseline
    // per design §3.1.
    let attention: AttentionState = "ok";
    if (fg) {
      const fgHwnd = String(fg.hwnd);
      const slots = getSlotSnapshot();
      const matchingSlot = slots.find(
        (s) => s.kind === "window" && s.identity && "hwnd" in s.identity && s.identity.hwnd === fgHwnd
      );
      if (matchingSlot) {
        // Map SlotAttention → AttentionState (7 enum values in design §3.1)
        const sa = matchingSlot.attention;
        if (sa === "ok" || sa === "changed" || sa === "dirty" || sa === "stale" || sa === "identity_changed") {
          attention = sa;
        } else if (sa === "not_found") {
          attention = "guard_failed";
        } else {
          // "ambiguous" → ok (conservative safe baseline)
          attention = "ok";
        }
      }
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

    // Modal heuristic — title-substring detection.
    let hasModal = false;
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
      attention,
      visibleWindows: wins.length,
      ...(Object.keys(hints).length > 0 ? { hints } : {}),
    });
  } catch (err) {
    return failWith(err, "desktop_state");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// get_history — recent action posts ring buffer
// ─────────────────────────────────────────────────────────────────────────────

export const getHistoryHandler = async ({ n }: { n: number }): Promise<ToolResult> => {
  try {
    const items = getHistorySnapshot(n);
    // D-5a: include 3 most recent target keys (not bloating with full events — v3 §10.6)
    const recentTargetKeys = listRecentTargetKeys(3);
    return ok({ count: items.length, actions: items, ...(recentTargetKeys.length > 0 && { recentTargetKeys }) });
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

export function registerDesktopStateTools(server: McpServer): void {
  server.tool(
    "desktop_state",
    buildDesc({
      purpose: "Read-only observation of the current desktop state. Returns focused window/element, modal flag, and attention signal from Auto Perception.",
      details: "Returns focusedWindow (title, hwnd, processName), focusedElement (name, type, value, automationId), cursorPos {x,y}, cursorOverElement (name, type), hasModal (boolean), pageState ('ready'|'loading'|'dialog'). Does NOT enumerate descendants — use desktop_discover for actionable entity list. Chromium: cursorOverElement is null (UIA sparse); focusedElement may fall back to CDP document.activeElement; hints.focusedElementSource reports which was used ('uia' or 'cdp').",
      prefer: "Use after each action to confirm state. Cheapest observation tool — cheaper than any screenshot. attention='ok' means safe to proceed; other values require recovery (see suggest[]).",
      caveats: "Cannot detect non-UIA elements (custom-drawn UIs, game overlays). hasModal only detects modal dialogs exposed via UIA — browser alert/confirm dialogs may not appear here.",
    }),
    desktopStateSchema,
    desktopStateHandler
  );

  // Phase 4: get_history privatized — debug/diagnostic tool, not part of the
  // LLM action workflow. Handler retained as internal export for tests.
  // (memory: feedback_disable_via_entry_block.md)

  server.tool(
    "get_document_state",
    "Return current Chrome page state via CDP: url, title, readyState, selection, and scroll position. Far cheaper than browser_eval({action:'dom'}) for page orientation.",
    getDocumentStateSchema,
    getDocumentStateHandler
  );
}
