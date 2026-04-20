import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mouse, Button, Point, straightTo, DEFAULT_MOUSE_SPEED } from "../engine/nutjs.js";
import { enumWindowsInZOrder, restoreAndFocusWindow } from "../engine/win32.js";
import { updateWindowCache } from "../engine/window-cache.js";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { coercedBoolean } from "./_coerce.js";
import { pollUntil } from "../engine/poll.js";
import {
  listTabs,
  evaluateInTab,
  getElementScreenCoords,
  navigateTo,
  getDomHtml,
  disconnectAll,
  getTabContext,
  type CdpTab,
  type TabContext,
} from "../engine/cdp-bridge.js";
import { resolveWellKnownPath, spawnDetached } from "../utils/launch.js";
import { getCdpPort } from "../utils/desktop-config.js";
import { fail } from "./_types.js";
import { setBrowserSearchHook } from "./wait-until.js";
import { withPostState } from "./_post.js";
import { narrateParam } from "./_narration.js";
import type { RichBlock } from "../engine/uia-diff.js";
import { evaluatePreToolGuards, buildEnvelopeFor } from "../engine/perception/registry.js";
import { runActionGuard, isAutoGuardEnabled, validateAndPrepareFix, consumeFix } from "./_action-guard.js";
import { canParseAsExpression, isAlreadyWrappedIife, prepareBrowserEvalExpression } from "./browser-eval-helpers.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

// Read once at startup — respects desktop-touch-config.json { "cdpPort": N }
const _defaultPort = getCdpPort();

const portParam = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .default(_defaultPort)
  .describe(`Chrome/Edge CDP remote debugging port (default ${_defaultPort}; configurable via desktop-touch-config.json)`);

const tabIdParam = z
  .string()
  .optional()
  .describe("Tab ID from browser_connect. Omit to use the first page tab.");

const selectorParam = z
  .string()
  .describe("CSS selector for the target element (e.g. '#submit', '.btn', 'button[type=submit]')");

export const browserConnectSchema = {
  port: portParam,
};

const includeContextParam = coercedBoolean()
  .default(true)
  .describe(
    "When true (default), append `activeTab` + `readyState` lines to the response. " +
    "Set false to skip — saves ~150 tokens per call when chaining several browser_* calls in the same tab."
  );

export const browserFindElementSchema = {
  selector: selectorParam,
  tabId: tabIdParam,
  port: portParam,
  includeContext: includeContextParam,
};

export const browserClickElementSchema = {
  selector: selectorParam,
  narrate: narrateParam,
  tabId: tabIdParam,
  port: portParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards (target.identityStable) are evaluated before clicking, " +
    "and a perception envelope is attached to post.perception on success."
  ),
  fixId: z.string().optional().describe("Approve a pending suggestedFix (one-shot, 15s TTL)."),
};

export const browserEvalSchema = {
  expression: z.string().describe(
    "JavaScript expression to evaluate in the browser tab. " +
    "The server automatically wraps snippets in an async IIFE to avoid repeated const/let name collisions. " +
    "For multi-statement snippets, use an explicit final return value. " +
    "Declarations (const/let/var) are scoped to each snippet and will not persist across repeated browser_eval calls; " +
    "use window.* or globalThis.* for persistence."
  ),
  tabId: tabIdParam,
  port: portParam,
  includeContext: includeContextParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards (target.identityStable) are evaluated before eval. " +
    "Note: browser_eval returns raw text, so no perception envelope is attached (guards only)."
  ),
  withPerception: z.boolean().optional().default(false).describe(
    "When true, return structured JSON { ok, result, post } instead of raw text. " +
    "Enables post.perception attachment so the LLM can see guard status. " +
    "Default false preserves the raw-text return for backwards compatibility. " +
    "Example: browser_eval({expression:'document.title', withPerception:true})"
  ),
};

export const browserGetDomSchema = {
  selector: z
    .string()
    .optional()
    .describe("CSS selector for root element. Omit for document.body."),
  tabId: tabIdParam,
  port: portParam,
  maxLength: z.coerce
    .number()
    .int()
    .min(100)
    .max(100_000)
    .default(10_000)
    .describe("Maximum characters to return (default 10000)"),
  includeContext: includeContextParam,
};

export const browserNavigateSchema = {
  url: z.string().describe("URL to navigate to"),
  narrate: narrateParam,
  tabId: tabIdParam,
  port: portParam,
  waitForLoad: coercedBoolean().default(true).describe(
    "When true (default), wait for document.readyState === 'complete' before returning. " +
    "Use waitForLoad:false for the legacy behavior (return immediately after Page.navigate). " +
    "Accepts the strings \"true\"/\"false\"."
  ),
  loadTimeoutMs: z.coerce.number().int().min(500).max(30000).default(15000).describe(
    "Max milliseconds to wait for page load when waitForLoad=true (default 15000). " +
    "On timeout, returns ok:true with readyState set to current state and hints.warnings=['NavigateTimeout']."
  ),
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards (target.identityStable) are evaluated before navigating, " +
    "and a perception envelope is attached to post.perception on success."
  ),
};

export const browserDisconnectSchema = {
  port: portParam,
};

export const browserLaunchSchema = {
  browser: z
    .enum(["auto", "chrome", "edge", "brave"])
    .default("auto")
    .describe(
      "Which browser to launch. 'auto' tries chrome → edge → brave and picks the first installed. " +
      "Ignored if a CDP endpoint is already live on the target port."
    ),
  port: portParam,
  userDataDir: z
    .string()
    .default("C:\\tmp\\cdp")
    .describe(
      "Path for --user-data-dir. Using a dedicated profile avoids conflicts with your normal browser session. " +
      "Default C:\\tmp\\cdp is safe to reuse across sessions."
    ),
  url: z
    .string()
    .optional()
    .describe("Optional URL to navigate to immediately after launch."),
  waitMs: z.coerce
    .number()
    .int()
    .min(1000)
    .max(30_000)
    .default(10_000)
    .describe("Max milliseconds to wait for the CDP endpoint to become ready (default 10000)."),
};

export const browserSearchSchema = {
  by: z.enum(["text", "regex", "role", "ariaLabel", "selector"])
    .describe("Search axis: text/regex/role/ariaLabel/selector"),
  pattern: z.string().min(1).describe("Pattern to match against the chosen axis."),
  scope: z.string().optional().describe("CSS selector to limit the search scope."),
  maxResults: z.coerce.number().int().min(1).max(200).default(50).describe("Max results returned (default 50)."),
  offset: z.coerce.number().int().min(0).default(0).describe("Offset into the result set (default 0)."),
  visibleOnly: coercedBoolean().default(true).describe("Only visible elements (default true). Set false to include hidden ones with confidence penalty."),
  inViewportOnly: coercedBoolean().default(false).describe("Only currently-in-viewport elements (default false)."),
  caseSensitive: coercedBoolean().default(false).describe("Case-sensitive matching for text/regex (default false)."),
  tabId: tabIdParam,
  port: portParam,
};

export const browserFillInputSchema = {
  selector: selectorParam,
  value: z.string().max(10_000).describe("Text to fill into the input element"),
  tabId: tabIdParam,
  port: portParam,
  includeContext: includeContextParam,
};

export const browserGetFormSchema = {
  selector: z
    .string()
    .describe(
      "CSS selector for the form or container element to inspect (e.g. '#login-form', '.search-bar'). " +
      "All input, select, textarea, and button descendants are returned."
    ),
  includeHidden: coercedBoolean()
    .default(false)
    .describe(
      "When true, include hidden inputs (type=hidden). Default false to avoid CSRF-token / serialized-state clutter."
    ),
  maxResults: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe("Maximum number of form fields to return (default 100)."),
  tabId: tabIdParam,
  port: portParam,
  includeContext: includeContextParam,
};

export const browserGetInteractiveSchema = {
  scope: z
    .string()
    .optional()
    .describe(
      "CSS selector to limit the search scope (e.g. '.s-main-slot', '#nav-search-form'). " +
      "Omit to scan the full page."
    ),
  types: z
    .array(z.enum(["link", "button", "input", "all"]))
    .default(["all"])
    .describe("Element types to include. Default 'all' returns links, buttons, and inputs."),
  inViewportOnly: coercedBoolean()
    .default(false)
    .describe("When true, only return elements currently visible in the viewport."),
  maxResults: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("Maximum number of elements to return (default 50)."),
  tabId: tabIdParam,
  port: portParam,
  includeContext: includeContextParam,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tab context cache (500ms TTL keyed by port:tabId)
//   - Eliminates duplicate `Runtime.evaluate` calls when the LLM chains several
//     browser_* calls in the same tab. Cache is short enough that "the page
//     just navigated" caller intent is still respected (next call refetches).
// ─────────────────────────────────────────────────────────────────────────────

const tabContextCache = new Map<string, { value: TabContext; expiresAt: number }>();
const TAB_CONTEXT_TTL_MS = 500;

async function getCachedTabContext(tabId: string | null, port: number): Promise<TabContext> {
  const key = `${port}:${tabId ?? ""}`;
  const cached = tabContextCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const fresh = await getTabContext(tabId, port);
  tabContextCache.set(key, { value: fresh, expiresAt: now + TAB_CONTEXT_TTL_MS });
  // Bound the map size — entries naturally expire, but a parade of unique
  // (port,tabId) pairs would otherwise leak.
  if (tabContextCache.size > 64) {
    for (const [k, v] of tabContextCache) {
      if (v.expiresAt <= now) tabContextCache.delete(k);
    }
  }
  return fresh;
}

/** Test-only — not exported via index, but accessible to e2e tests. */
export function _resetTabContextCache(): void {
  tabContextCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure a specific window is focused before sending mouse events.
 * If the active window already matches titleHint, this is a no-op.
 * Otherwise finds the window by title and brings it to the front.
 * Updates the window cache after enumeration.
 */
async function ensureWindowFocused(titleHint: string): Promise<void> {
  const windows = enumWindowsInZOrder();
  updateWindowCache(windows);
  const active = windows.find((w) => w.isActive);
  if (active && active.title.toLowerCase().includes(titleHint.toLowerCase())) {
    return; // already focused
  }
  const target = windows.find((w) =>
    w.title.toLowerCase().includes(titleHint.toLowerCase())
  );
  if (target) {
    restoreAndFocusWindow(target.hwnd);
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}

/**
 * Ensure a browser window is focused before sending mouse events.
 * Falls back to generic Chrome/Edge title search when tab title cannot be resolved.
 */
async function ensureBrowserFocused(port: number): Promise<void> {
  // Try to match by current tab title from CDP
  let tabTitle: string | undefined;
  try {
    const tabs = await listTabs(port);
    const pageTab = tabs.find((t) => t.type === "page");
    tabTitle = pageTab?.title;
  } catch {
    // ignore — fall back to browser name search
  }

  if (tabTitle) {
    await ensureWindowFocused(tabTitle);
    return;
  }

  // Fall back to browser process name
  const windows = enumWindowsInZOrder();
  updateWindowCache(windows);
  const active = windows.find((w) => w.isActive);
  if (
    active &&
    (active.title.includes("Google Chrome") || active.title.includes("Microsoft Edge"))
  ) {
    return;
  }
  const browserWindow = windows.find((w) =>
    w.title.includes("Google Chrome") || w.title.includes("Microsoft Edge")
  );
  if (browserWindow) {
    restoreAndFocusWindow(browserWindow.hwnd);
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const browserFillInputHandler = async ({
  selector,
  value,
  tabId,
  port,
  includeContext,
}: {
  selector: string;
  value: string;
  tabId?: string;
  port: number;
  includeContext: boolean;
}): Promise<ToolResult> => {
  try {
    // Fill sequence: focus the element first, then update its value from page context
    // using the native prototype setter and dispatch InputEvent/change so frameworks
    // such as React/Vue observe the same DOM updates they listen for in normal input flows.
    const focusExpr = `
(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
  el.focus();
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type') || '';
  return { ok: true, tag, type };
})()`;
    const focusResult = await evaluateInTab(focusExpr, tabId ?? null, port) as { ok: boolean; error?: string; tag?: string; type?: string };
    if (!focusResult.ok) {
      return failWith(focusResult.error ?? "browser_fill_input: focus failed", "browser_fill_input");
    }

    // Fill the input using the React-compatible path:
    //   focus → select all → use native prototype setter (bypasses React's proxy) +
    //   dispatch InputEvent so React fiber intercepts the synthetic event.
    // This is more reliable than execCommand('insertText') which is deprecated.
    const fillExpr = `
(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: 'Element not found after focus' };
  el.focus();
  // Select all existing content before replacing
  if (typeof el.select === 'function') {
    el.select();
  }
  // Pick the correct native prototype setter by element type to avoid
  // "Illegal invocation" when calling HTMLInputElement.prototype.set on a textarea.
  const tag = el.tagName;
  let proto = null;
  if (tag === 'INPUT') proto = HTMLInputElement.prototype;
  else if (tag === 'TEXTAREA') proto = HTMLTextAreaElement.prototype;
  const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
  if (descriptor && descriptor.set) {
    descriptor.set.call(el, ${JSON.stringify(value)});
  } else {
    el.value = ${JSON.stringify(value)};
  }
  // Dispatch native InputEvent — React 16+ intercepts 'input' for onChange
  el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const actual = el.value !== undefined ? el.value : el.textContent;
  return { ok: true, actual: (actual || '').slice(0, 100) };
})()`;
    const fillResult = await evaluateInTab(fillExpr, tabId ?? null, port) as { ok: boolean; error?: string; actual?: string };
    if (!fillResult.ok) {
      return failWith(fillResult.error ?? "browser_fill_input: fill failed", "browser_fill_input");
    }

    const lines = [
      JSON.stringify({ ok: true, selector, value, actual: fillResult.actual }),
    ];
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      lines.push(
        "",
        `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
        `readyState: "${tabCtx.readyState}"`,
      );
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  } catch (err) {
    return failWith(err, "browser_fill_input");
  }
};

export const browserGetFormHandler = async ({
  selector,
  includeHidden,
  maxResults,
  tabId,
  port,
  includeContext,
}: {
  selector: string;
  includeHidden: boolean;
  maxResults: number;
  tabId?: string;
  port: number;
  includeContext: boolean;
}): Promise<ToolResult> => {
  try {
    const expr = `
(function() {
  const scope = document.querySelector(${JSON.stringify(selector)});
  if (!scope) return { ok: false, error: 'element not found' };
  const FIELD_SEL = 'input, select, textarea, button';
  const isSelf = scope.matches(FIELD_SEL);
  const children = Array.from(scope.querySelectorAll(FIELD_SEL));
  const elements = isSelf ? [scope, ...children] : children;
  const includeHidden = ${includeHidden};
  const maxResults = ${maxResults};
  const MAX_VALUE_LEN = 200;
  const fields = [];
  for (const el of elements) {
    if (fields.length >= maxResults) break;
    const tagName = el.tagName.toLowerCase();
    const attrType = el.getAttribute('type') || '';
    const type = attrType ||
      (tagName === 'select' ? 'select' :
       tagName === 'textarea' ? 'textarea' :
       tagName === 'button' ? 'button' : 'text');
    if (!includeHidden && type === 'hidden') continue;
    const name = el.name || null;
    const id = el.id || null;
    let value = null;
    let checked = null;
    if (tagName === 'button') {
      value = el.textContent.trim() || null;
    } else if (tagName === 'input' && (type === 'checkbox' || type === 'radio')) {
      checked = el.checked;
      value = el.getAttribute('value');
    } else if (tagName === 'input' || tagName === 'textarea') {
      const raw = el.value || '';
      value = raw ? (raw.length > MAX_VALUE_LEN ? raw.slice(0, MAX_VALUE_LEN) + '\u2026' : raw) : null;
    } else if (tagName === 'select') {
      value = el.value || null;
    }
    // Resolve label: for[id] > ancestor LABEL (strip child inputs) > aria-labelledby > aria-label
    let label = null;
    if (id) {
      const labelEl = document.querySelector('label[for=' + JSON.stringify(id) + ']');
      if (labelEl) label = labelEl.textContent.trim() || null;
    }
    if (!label) {
      let p = el.parentElement;
      while (p) {
        if (p.tagName === 'LABEL') {
          const clone = p.cloneNode(true);
          clone.querySelectorAll(FIELD_SEL).forEach(function(n) { n.remove(); });
          label = clone.textContent.trim() || null;
          break;
        }
        p = p.parentElement;
      }
    }
    if (!label) {
      const lbAttr = el.getAttribute('aria-labelledby');
      if (lbAttr) {
        label = lbAttr.trim().split(/\s+/).map(function(i) {
          var e = document.getElementById(i); return e ? e.textContent.trim() : '';
        }).filter(Boolean).join(' ') || null;
      }
    }
    if (!label) {
      label = el.getAttribute('aria-label') || null;
    }
    fields.push({
      tagName,
      type,
      name,
      id,
      value,
      checked,
      placeholder: el.placeholder || null,
      disabled: el.disabled,
      readOnly: !!el.readOnly,
      label,
    });
  }
  return { ok: true, selector: ${JSON.stringify(selector)}, count: fields.length, fields };
})()`;

    const result = await evaluateInTab(expr, tabId ?? null, port) as
      | { ok: true; selector: string; count: number; fields: unknown[] }
      | { ok: false; error: string };

    if (!result.ok) {
      return failWith("Element not found", "browser_get_form", { selector });
    }

    const lines = [JSON.stringify(result)];
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      lines.push(
        "",
        `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
        `readyState: "${tabCtx.readyState}"`,
      );
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  } catch (err) {
    return failWith(err, "browser_get_form");
  }
};

export const browserConnectHandler = async ({
  port,
}: {
  port: number;
}): Promise<ToolResult> => {
  try {
    const tabs = await listTabs(port);
    const pageTabs = tabs.filter((t) => t.type === "page");

    // Parallel hasFocus() evaluation to find the active tab
    const focusResults = await Promise.allSettled(
      pageTabs.map((t) =>
        evaluateInTab("document.hasFocus()", t.id, port)
          .then((v) => ({ id: t.id, active: !!v }))
          .catch(() => ({ id: t.id, active: false }))
      )
    );
    const focusMap = new Map<string, boolean>();
    for (const r of focusResults) {
      if (r.status === "fulfilled") {
        focusMap.set(r.value.id, r.value.active);
      }
    }

    const summary = pageTabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: focusMap.get(t.id) ?? false,
    }));

    const activeTab = summary.find((t) => t.active)?.id ?? null;

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Connected to Chrome/Edge CDP at port ${port}.`,
            `${pageTabs.length} page tab(s) found:`,
            JSON.stringify({ port, active: activeTab, tabs: summary }, null, 2),
            "",
            "Pass a tab's id to other browser_* tools to target it, or omit to use the first tab.",
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return failWith(err, "browser_connect");
  }
};

export const browserFindElementHandler = async ({
  selector,
  tabId,
  port,
  includeContext,
}: {
  selector: string;
  tabId?: string;
  port: number;
  includeContext: boolean;
}): Promise<ToolResult> => {
  try {
    const coords = await getElementScreenCoords(
      selector,
      tabId ?? null,
      port
    );
    const lines = [
      `Element found: ${selector}`,
      JSON.stringify({
        center: { x: coords.x, y: coords.y },
        topLeft: { x: coords.left, y: coords.top },
        size: { width: coords.width, height: coords.height },
        inViewport: coords.inViewport,
        clickAt: { x: coords.x, y: coords.y },
      }, null, 2),
      "",
      !coords.inViewport
        ? "Warning: element is outside the visible viewport. Scroll into view before clicking."
        : "Element is visible. Pass clickAt coords to mouse_click.",
    ];
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      lines.push(
        "",
        `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
        `readyState: "${tabCtx.readyState}"`,
      );
    }
    return {
      content: [
        {
          type: "text" as const,
          text: lines.join("\n"),
        },
      ],
    };
  } catch (err) {
    return failWith(err, "browser_find_element");
  }
};

export const browserClickElementHandler = async ({
  selector,
  narrate,
  tabId,
  port,
  lensId,
  fixId,
}: {
  selector: string;
  narrate?: string;
  tabId?: string;
  port: number;
  lensId?: string;
  fixId?: string;
}): Promise<ToolResult> => {
  try {
    // Phase G: fixId approval prologue
    let effectiveSelector = selector;
    let effectiveTabId = tabId;
    if (fixId) {
      const vr = validateAndPrepareFix(fixId, "browser_click_element");
      if (!vr.ok || !vr.fix) return failWith(new Error(vr.errorCode!), "browser_click_element");
      if (typeof vr.fix.args.selector === "string") effectiveSelector = vr.fix.args.selector;
      if (typeof vr.fix.args.tabId === "string") effectiveTabId = vr.fix.args.tabId;
      consumeFix(fixId);
    }

    let perceptionEnvBrowser: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "browser_click_element", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        const env = buildEnvelopeFor(lensId, { toolName: "browser_click_element" });
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "browser_click_element",
          { lensId, guard: guardResult.failedGuard, _perceptionForPost: env }
        );
      }
      perceptionEnvBrowser = buildEnvelopeFor(lensId, { toolName: "browser_click_element" }) ?? undefined;
    } else if (isAutoGuardEnabled() && (tabId || port)) {
      // Phase F: get coords first so we know inViewport for selectorInViewport policy
      const coordsForGuard = await getElementScreenCoords(effectiveSelector, effectiveTabId ?? null, port);
      if (!coordsForGuard.inViewport) {
        // Element not in viewport — fail before running guard
        return fail({
          ok: false,
          code: "ElementNotInViewport",
          error: `browser_click_element: element "${effectiveSelector}" is outside the visible viewport.`,
          suggest: ["Element is outside the visible viewport. Scroll it into view first using browser_eval with element.scrollIntoView(), then retry browser_click_element."],
          context: { selector: effectiveSelector },
        });
      }
      const descriptor: import("./_action-guard.js").ActionTargetDescriptor = {
        kind: "browserTab", port, tabId: effectiveTabId, urlIncludes: undefined,
      };
      // Phase F/G: pass inViewport + selectorInViewport policy; carry selector for fixId
      const ag = await runActionGuard({
        toolName: "browser_click_element", actionKind: "browserCdp", descriptor,
        browserReadinessPolicy: "selectorInViewport",
        browserSelectorInViewport: coordsForGuard.inViewport,
        fixCarryingArgs: { selector: effectiveSelector, tabId: effectiveTabId, port },
      });
      if (ag.block) {
        return failWith(new Error(`AutoGuardBlocked: ${ag.summary.next}`), "browser_click_element", { _perceptionForPost: ag.summary });
      }
      perceptionEnvBrowser = ag.summary;
    }
    // CDP snapshot before click (for narrate:"rich")
    let beforeUrl: string | null = null;
    if (narrate === "rich") {
      try {
        const ctx = await getTabContext(effectiveTabId ?? null, port);
        beforeUrl = ctx.url ?? null;
      } catch { /* ignore */ }
    }

    const coords = await getElementScreenCoords(
      effectiveSelector,
      effectiveTabId ?? null,
      port
    );
    if (!coords.inViewport) {
      return fail({
        ok: false,
        code: "ElementNotInViewport",
        error: `browser_click_element: element "${effectiveSelector}" is outside the visible viewport.`,
        suggest: ["Element is outside the visible viewport. Scroll it into view first using browser_eval with element.scrollIntoView(), then retry browser_click_element."],
        context: { selector: effectiveSelector },
      });
    }
    // Ensure browser window is focused so click events reach the page
    await ensureBrowserFocused(port);
    // Perform the actual mouse click using nut-js
    const speed = DEFAULT_MOUSE_SPEED;
    if (speed === 0) {
      await mouse.setPosition(new Point(coords.x, coords.y));
    } else {
      const prev = mouse.config.mouseSpeed;
      mouse.config.mouseSpeed = speed;
      try {
        await mouse.move(straightTo(new Point(coords.x, coords.y)));
      } finally {
        mouse.config.mouseSpeed = prev;
      }
    }
    await mouse.click(Button.LEFT);
    const tabCtx = await getTabContext(effectiveTabId ?? null, port);

    // Build rich block for CDP diff
    let richBlock: RichBlock | undefined;
    if (narrate === "rich" && beforeUrl !== null) {
      await new Promise<void>((r) => setTimeout(r, 150));
      try {
        const afterCtx = await getTabContext(effectiveTabId ?? null, port);
        const afterUrl = afterCtx.url ?? null;
        richBlock = {
          appeared: [],
          disappeared: [],
          valueDeltas: [],
          diffSource: "cdp",
          ...(beforeUrl !== afterUrl && afterUrl
            ? { navigation: { fromUrl: beforeUrl, toUrl: afterUrl } }
            : {}),
        };
      } catch {
        richBlock = { appeared: [], disappeared: [], valueDeltas: [], diffSource: "none", diffDegraded: "timeout" };
      }
    }

    return ok({
      ok: true,
      clicked: selector,
      at: { x: coords.x, y: coords.y },
      activeTab: { id: tabCtx.id, title: tabCtx.title, url: tabCtx.url },
      readyState: tabCtx.readyState,
      ...(richBlock ? { _richForPost: richBlock } : {}),
      ...(perceptionEnvBrowser && { _perceptionForPost: perceptionEnvBrowser }),
    });
  } catch (err) {
    return failWith(err, "browser_click_element");
  }
};

/** Phase J: safe JSON serialization for eval results — handles circular refs, functions, etc. */
function safeStringifyEval(value: unknown): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, val: unknown): unknown => {
    if (typeof val === "function") return "[Function]";
    if (typeof val === "symbol")   return "[Symbol]";
    if (typeof val === "bigint")   return String(val) + "n";
    if (val === undefined)         return "[Undefined]";
    if (val !== null && typeof val === "object") {
      if (seen.has(val as object)) return "[Circular]";
      seen.add(val as object);
    }
    return val;
  };
  try { return JSON.stringify(value, replacer, 2) ?? "[Unserializable]"; }
  catch {
    try { return String(value); }
    catch { return "[Unserializable]"; }
  }
}

/** Phase J: Deep-clone via JSON round-trip to break circular refs before passing to ok() transport. */
function safeCloneForTransport(value: unknown): unknown {
  try { return JSON.parse(safeStringifyEval(value)); }
  catch { return "[Unserializable]"; }
}

export const browserEvalHandler = async ({
  expression,
  tabId,
  port,
  includeContext,
  lensId,
  withPerception,
}: {
  expression: string;
  tabId?: string;
  port: number;
  includeContext: boolean;
  lensId?: string;
  withPerception?: boolean;
}): Promise<ToolResult> => {
  try {
    let perceptionEnv: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "browser_eval", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "browser_eval",
          { lensId, guard: guardResult.failedGuard }
        );
      }
    } else if (isAutoGuardEnabled() && (tabId || port)) {
      const descriptor: import("./_action-guard.js").ActionTargetDescriptor = {
        kind: "browserTab", port, tabId, urlIncludes: undefined,
      };
      // Phase F: strict policy for browser_eval (v3 §5.4)
      const ag = await runActionGuard({
        toolName: "browser_eval", actionKind: "browserCdp", descriptor,
        browserReadinessPolicy: "strict",
      });
      if (ag.block) {
        return failWith(new Error(`AutoGuardBlocked: ${ag.summary.next}`), "browser_eval", {
          context: { guardStatus: ag.summary.status },
          ...(withPerception && { _perceptionForPost: ag.summary }),
        });
      }
      perceptionEnv = ag.summary;
    }

    const preparedExpression = prepareBrowserEvalExpression(expression);
    const rawResult = await evaluateInTab(preparedExpression, tabId ?? null, port);

    if (withPerception) {
      // Phase J: structured response mode — safeClone to avoid circular ref in transport
      const safeResult = rawResult === null || rawResult === undefined ? null : safeCloneForTransport(rawResult);
      const tabCtx = includeContext ? await getCachedTabContext(tabId ?? null, port) : undefined;
      return ok({
        ok: true,
        result: safeResult,
        ...(tabCtx && { activeTab: { id: tabCtx.id, title: tabCtx.title, url: tabCtx.url }, readyState: tabCtx.readyState }),
        ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
      });
    }

    // Default raw text path (backwards compatible)
    const text = rawResult === null || rawResult === undefined
      ? "(null)"
      : typeof rawResult === "string"
        ? rawResult
        : safeStringifyEval(rawResult);
    const lines = [text];
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      lines.push(
        "",
        `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
        `readyState: "${tabCtx.readyState}"`,
      );
    }
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  } catch (err) {
    return failWith(err, "browser_eval");
  }
};

export const browserGetDomHandler = async ({
  selector,
  tabId,
  port,
  maxLength,
  includeContext,
}: {
  selector?: string;
  tabId?: string;
  port: number;
  maxLength: number;
  includeContext: boolean;
}): Promise<ToolResult> => {
  try {
    const html = await getDomHtml(
      selector ?? null,
      tabId ?? null,
      port,
      maxLength
    );
    const lines = [html];
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      lines.push(
        "",
        `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
        `readyState: "${tabCtx.readyState}"`,
      );
    }
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  } catch (err) {
    return failWith(err, "browser_get_dom");
  }
};

export const browserNavigateHandler = async ({
  url,
  narrate,
  tabId,
  port,
  waitForLoad,
  loadTimeoutMs,
  lensId,
}: {
  url: string;
  narrate?: string;
  tabId?: string;
  port: number;
  waitForLoad: boolean;
  loadTimeoutMs: number;
  lensId?: string;
}): Promise<ToolResult> => {
  try {
    let perceptionEnvNav: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "browser_navigate", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        const env = buildEnvelopeFor(lensId, { toolName: "browser_navigate" });
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "browser_navigate",
          { lensId, guard: guardResult.failedGuard, _perceptionForPost: env }
        );
      }
      perceptionEnvNav = buildEnvelopeFor(lensId, { toolName: "browser_navigate" }) ?? undefined;
    } else if (isAutoGuardEnabled() && (tabId || port)) {
      const descriptor: import("./_action-guard.js").ActionTargetDescriptor = {
        kind: "browserTab", port, tabId, urlIncludes: undefined,
      };
      // Phase F: navigationGate policy — interactive is acceptable for pre-navigation guard
      const ag = await runActionGuard({
        toolName: "browser_navigate", actionKind: "browserCdp", descriptor,
        browserReadinessPolicy: "navigationGate",
      });
      if (ag.block) {
        return failWith(new Error(`AutoGuardBlocked: ${ag.summary.next}`), "browser_navigate", { _perceptionForPost: ag.summary });
      }
      perceptionEnvNav = ag.summary;
    }
    const startedAt = Date.now();
    // Capture beforeUrl for rich narration
    let beforeUrl: string | null = null;
    if (narrate === "rich") {
      try {
        const ctx = await getTabContext(tabId ?? null, port);
        beforeUrl = ctx.url ?? null;
      } catch { /* ignore */ }
    }
    const navResult = await navigateTo(url, tabId ?? null, port);

    // Surface CDP navigation errors (DNS failure etc.)
    if (navResult.errorText) {
      return fail({
        ok: false,
        code: "NavigateFailed",
        error: `browser_navigate failed: ${navResult.errorText}`,
        suggest: [
          "Check the URL is correct and reachable",
          "Verify network connectivity",
        ],
        context: { url, errorText: navResult.errorText },
      });
    }

    if (!waitForLoad) {
      return ok({
        ok: true,
        url,
        waited: false,
        hint: `Wait a moment, then use browser_eval("document.readyState") to check if the page has loaded.`,
      });
    }

    // Wait for document.readyState === "complete"
    await new Promise<void>((r) => setTimeout(r, 200));
    const poll = await pollUntil(
      async () => {
        try {
          const state = await evaluateInTab("document.readyState", tabId ?? null, port);
          return state === "complete" ? true : null;
        } catch {
          return null;
        }
      },
      { intervalMs: 150, timeoutMs: loadTimeoutMs }
    );

    const tabCtx = await getTabContext(tabId ?? null, port);
    const elapsedMs = Date.now() - startedAt;

    if (!poll.ok) {
      // Timeout — not a failure, LLM can continue
      return ok({
        ok: true,
        url: tabCtx.url || url,
        title: tabCtx.title,
        readyState: tabCtx.readyState,
        elapsedMs,
        waited: true,
        hints: { warnings: ["NavigateTimeout"] },
      });
    }

    // Build rich navigation block
    const richBlock: RichBlock | undefined = narrate === "rich" ? {
      appeared: [],
      disappeared: [],
      valueDeltas: [],
      diffSource: "cdp",
      ...(beforeUrl && beforeUrl !== (tabCtx.url || url)
        ? { navigation: { fromUrl: beforeUrl, toUrl: tabCtx.url || url } }
        : {}),
    } : undefined;

    return ok({
      ok: true,
      url: tabCtx.url || url,
      title: tabCtx.title,
      readyState: tabCtx.readyState,
      elapsedMs,
      waited: true,
      ...(richBlock ? { _richForPost: richBlock } : {}),
      ...(perceptionEnvNav && { _perceptionForPost: perceptionEnvNav }),
    });
  } catch (err) {
    return failWith(err, "browser_navigate");
  }
};

export const browserGetInteractiveHandler = async ({
  scope,
  types,
  inViewportOnly,
  maxResults,
  tabId,
  port,
  includeContext,
}: {
  scope?: string;
  types: Array<"link" | "button" | "input" | "all">;
  inViewportOnly: boolean;
  maxResults: number;
  tabId?: string;
  port: number;
  includeContext: boolean;
}): Promise<ToolResult> => {
  try {
    const includeAll = types.includes("all");
    const includeLinks   = includeAll || types.includes("link");
    const includeButtons = includeAll || types.includes("button");
    const includeInputs  = includeAll || types.includes("input");

    // Build the CSS selector for targeted element types
    const parts: string[] = [];
    if (includeLinks)   parts.push("a[href]");
    if (includeButtons) parts.push("button:not([disabled])", "[role='button']");
    if (includeInputs)  parts.push(
      "input:not([type='hidden']):not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])"
    );
    // ARIA-roled custom controls (Radix / shadcn / MUI / Headless UI / GitHub all use these).
    // Always included when any type was requested — they are interactive by definition.
    if (includeAll || includeButtons || includeInputs || includeLinks) {
      parts.push(
        "[role='switch']:not([aria-disabled='true'])",
        "[role='checkbox']:not([aria-disabled='true'])",
        "[role='radio']:not([aria-disabled='true'])",
        "[role='tab']:not([aria-disabled='true'])",
        "[role='menuitem']:not([aria-disabled='true'])",
        "[role='option']:not([aria-disabled='true'])",
      );
    }
    const cssQuery = parts.join(", ");

    // Fix #1: guard against empty query (types:[]) which causes querySelectorAll("") to throw
    if (!cssQuery) {
      return {
        content: [{ type: "text" as const, text: "browser_get_interactive: no element types selected. Pass at least one of 'link', 'button', 'input', or 'all'." }],
      };
    }

    const expression = `
(function() {
  const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : "document"} || document;
  const viewportOnly = ${JSON.stringify(inViewportOnly)};
  const maxN = ${JSON.stringify(maxResults)};
  const cssQ = ${JSON.stringify(cssQuery)};

  // Fix #2: use getBoundingClientRect for visibility — handles position:fixed correctly.
  // offsetParent is null for fixed elements even when visible, so we cannot use it.
  function isVisible(el) {
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function inViewportRect(rect) {
    return rect.top < window.innerHeight && rect.bottom > 0 &&
           rect.left < window.innerWidth && rect.right > 0;
  }

  // Fix #3: use CSS.escape for IDs; improve nth-child fallback to include parent path
  function bestSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.length < 80)
      return el.tagName.toLowerCase() + '[aria-label=' + JSON.stringify(ariaLabel) + ']';
    if (el.tagName === 'A' && el.href) {
      try {
        const u = new URL(el.href);
        const dp = u.pathname.match(/\\/dp\\/([A-Z0-9]{10})/);
        if (dp) return 'a[href*="/dp/' + dp[1] + '"]';
        if (u.pathname.length > 1 && u.pathname.length < 60)
          return 'a[href*=' + JSON.stringify(u.pathname.slice(0, 40)) + ']';
      } catch(e) {}
    }
    // Stable data attributes
    for (const attr of ['data-testid', 'data-asin']) {
      const v = el.getAttribute(attr);
      if (v && v.length < 60) return el.tagName.toLowerCase() + '[' + attr + '=' + JSON.stringify(v) + ']';
    }
    // nth-child with up to 2 ancestor levels for specificity
    let node = el;
    let path = '';
    for (let depth = 0; depth < 2 && node.parentElement; depth++) {
      const p = node.parentElement;
      const idx = Array.from(p.children).indexOf(node) + 1;
      const seg = node.tagName.toLowerCase() + ':nth-child(' + idx + ')';
      path = path ? seg + ' > ' + path : seg;
      if (p.id) { path = '#' + CSS.escape(p.id) + ' > ' + path; break; }
      node = p;
    }
    return path || el.tagName.toLowerCase();
  }

  function elType(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (role === 'switch' || role === 'checkbox' || role === 'radio') return 'toggle[' + role + ']';
    if (role === 'tab') return 'tab';
    if (role === 'menuitem' || role === 'option') return role;
    if (tag === 'a') return 'link';
    if (tag === 'button' || role === 'button') return 'button';
    if (tag === 'input') return 'input[' + (el.type || 'text') + ']';
    return tag;
  }

  // Surface ARIA toggle/expanded/selected state. Returns undefined when the
  // element exposes none of the four — keeps the response shape stable for
  // simple links and unstateful buttons.
  function elState(el) {
    const out = {};
    const ac = el.getAttribute('aria-checked');
    if (ac !== null) out.checked = (ac === 'true' || ac === 'mixed');
    const ap = el.getAttribute('aria-pressed');
    if (ap !== null) out.pressed = (ap === 'true');
    const as = el.getAttribute('aria-selected');
    if (as !== null) out.selected = (as === 'true');
    const ae = el.getAttribute('aria-expanded');
    if (ae !== null) out.expanded = (ae === 'true');
    return Object.keys(out).length ? out : undefined;
  }

  function elText(el) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    if (!t && el.tagName === 'INPUT')
      return (el.placeholder || el.value || el.getAttribute('aria-label') || '').slice(0, 80);
    return t;
  }

  // Use element center-point for consistency with the UIA/OCR viewport-position helper.
  function viewportPos(rect) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cy < 0) return 'above';
    if (cy >= window.innerHeight) return 'below';
    if (cx < 0) return 'left';
    if (cx >= window.innerWidth) return 'right';
    return 'in-view';
  }

  const _docHeight = document.documentElement.scrollHeight || 1;
  function pageRatio(rect) {
    const cy = rect.top + rect.height / 2 + window.scrollY;
    return Math.max(0, Math.min(1, cy / _docHeight));
  }

  const out = [];
  for (const el of root.querySelectorAll(cssQ)) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    const vp = inViewportRect(rect);
    if (viewportOnly && !vp) continue;
    const item = { type: elType(el), text: elText(el), selector: bestSelector(el), inViewport: vp, viewportPosition: viewportPos(rect), pageRatio: pageRatio(rect) };
    if (el.tagName === 'A') item.href = el.href;
    const st = elState(el);
    if (st) item.state = st;
    out.push(item);
    if (out.length >= maxN) break;
  }
  return out;
})()
`;

    const result = await evaluateInTab(expression, tabId ?? null, port);
    const items = Array.isArray(result) ? result : [];
    const lines = [
      `Found ${items.length} interactive element(s)${scope ? ` within "${scope}"` : ""}:`,
      JSON.stringify(items, null, 2),
    ];
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      lines.push(
        "",
        `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
        `readyState: "${tabCtx.readyState}"`,
      );
    }
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  } catch (err) {
    return failWith(err, "browser_get_interactive");
  }
};

export const browserLaunchHandler = async ({
  browser,
  port,
  userDataDir,
  url,
  waitMs,
}: {
  browser: "auto" | "chrome" | "edge" | "brave";
  port: number;
  userDataDir: string;
  url?: string;
  waitMs: number;
}): Promise<ToolResult> => {
  try {
    // ── 1. Already running? ──────────────────────────────────────────────────
    // listTabs() hits http://127.0.0.1:PORT/json/list.
    // If it succeeds, a CDP endpoint is already live — skip spawn.
    // IMPORTANT: navigateTo errors must NOT escape this block, or control would
    // fall into the spawn path while the CDP endpoint is already live.
    try {
      const existingTabs = await listTabs(port);
      if (url) {
        try { await navigateTo(url, null, port); }
        catch { /* navigation failure doesn't affect the already-running result */ }
      }
      const pageTabs = existingTabs.filter((t) => t.type === "page");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            port,
            alreadyRunning: true,
            launched: null,
            tabs: pageTabs.map((t) => ({ id: t.id, title: t.title, url: t.url })),
          }, null, 2),
        }],
      };
    } catch { /* not running — proceed to spawn */ }

    // ── 2. Validate url early ─────────────────────────────────────────────────
    // Reject values that look like flags — Chrome would interpret them as CLI args.
    if (url !== undefined && url.startsWith("-")) {
      return {
        content: [{
          type: "text" as const,
          text: `browser_launch: url must not start with '-' (got: ${JSON.stringify(url)})`,
        }],
      };
    }

    // ── 3. Resolve browser executable ────────────────────────────────────────
    type BrowserKey = "chrome" | "edge" | "brave";
    const candidates: Array<{ key: BrowserKey; exe: string }> =
      browser === "auto"
        ? [
            { key: "chrome", exe: "chrome.exe" },
            { key: "edge",   exe: "msedge.exe" },
            { key: "brave",  exe: "brave.exe"  },
          ]
        : [{ key: browser, exe: browser === "edge" ? "msedge.exe" : `${browser}.exe` }];

    let chosenKey: BrowserKey | null = null;
    let chosenPath: string | null = null;
    for (const c of candidates) {
      const { resolved, wasResolved } = resolveWellKnownPath(c.exe);
      if (wasResolved) { chosenKey = c.key; chosenPath = resolved; break; }
    }
    if (!chosenPath || !chosenKey) {
      return {
        content: [{
          type: "text" as const,
          text: browser === "auto"
            ? "No supported browser (Chrome/Edge/Brave) found in standard install locations. Install one or launch manually with --remote-debugging-port."
            : `${browser} not found in standard install locations. Install it or launch manually: ${browser === "edge" ? "msedge" : browser}.exe --remote-debugging-port=${port} --user-data-dir=${userDataDir}`,
        }],
      };
    }

    // ── 4. Spawn with CDP flags ───────────────────────────────────────────────
    const spawnArgs = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
    ];
    // Chrome/Edge/Brave accept an initial URL as a positional argument.
    // Passing it here avoids a post-launch navigateTo race.
    if (url) spawnArgs.push(url);
    await spawnDetached(chosenPath, spawnArgs);

    // ── 5. Poll listTabs until CDP is ready or deadline ───────────────────────
    // Give the browser a moment before the first probe — the spawn event fires as
    // soon as the OS hands off the process, long before Chrome initializes CDP.
    await new Promise<void>((r) => setTimeout(r, 200));
    let lastErr: unknown = null;
    const pollResult = await pollUntil(
      async () => {
        try {
          return await listTabs(port);
        } catch (e) {
          lastErr = e;
          return null;
        }
      },
      { intervalMs: 200, timeoutMs: waitMs }
    );
    if (!pollResult.ok) {
      return {
        content: [{
          type: "text" as const,
          text: [
            `${chosenKey} launched but CDP endpoint on port ${port} did not respond within ${waitMs}ms.`,
            `Last error: ${String(lastErr)}`,
            `Try increasing waitMs, or check that no stray process holds the port (close existing ${chosenKey} with the same --user-data-dir).`,
          ].join("\n"),
        }],
      };
    }
    const tabs = pollResult.value;

    const pageTabs = tabs.filter((t) => t.type === "page");
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          port,
          alreadyRunning: false,
          launched: { browser: chosenKey, path: chosenPath, userDataDir },
          tabs: pageTabs.map((t) => ({ id: t.id, title: t.title, url: t.url })),
        }, null, 2),
      }],
    };
  } catch (err) {
    return failWith(err, "browser_launch");
  }
};

export const browserSearchHandler = async ({
  by, pattern, scope, maxResults, offset, visibleOnly, inViewportOnly, caseSensitive, tabId, port,
}: {
  by: "text" | "regex" | "role" | "ariaLabel" | "selector";
  pattern: string;
  scope?: string;
  maxResults: number;
  offset: number;
  visibleOnly: boolean;
  inViewportOnly: boolean;
  caseSensitive: boolean;
  tabId?: string;
  port: number;
}): Promise<ToolResult> => {
  try {
    const expression = `
(function() {
  const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : "document"};
  if (!root) return { __error: "ScopeNotFound" };

  const by = ${JSON.stringify(by)};
  const pat = ${JSON.stringify(pattern)};
  const cs  = ${JSON.stringify(caseSensitive)};
  const visibleOnly = ${JSON.stringify(visibleOnly)};
  const viewportOnly = ${JSON.stringify(inViewportOnly)};
  const maxN = ${JSON.stringify(maxResults + offset)};
  const offN = ${JSON.stringify(offset)};

  function isVisible(el) {
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function inViewportRect(rect) {
    return rect.top < window.innerHeight && rect.bottom > 0 &&
           rect.left < window.innerWidth && rect.right > 0;
  }
  function bestSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 80)
      return el.tagName.toLowerCase() + '[aria-label=' + JSON.stringify(aria) + ']';
    for (const attr of ['data-testid', 'data-asin']) {
      const v = el.getAttribute(attr);
      if (v && v.length < 60) return el.tagName.toLowerCase() + '[' + attr + '=' + JSON.stringify(v) + ']';
    }
    let node = el; let path = '';
    for (let depth = 0; depth < 2 && node.parentElement; depth++) {
      const p = node.parentElement;
      const idx = Array.from(p.children).indexOf(node) + 1;
      const seg = node.tagName.toLowerCase() + ':nth-child(' + idx + ')';
      path = path ? seg + ' > ' + path : seg;
      if (p.id) { path = '#' + CSS.escape(p.id) + ' > ' + path; break; }
      node = p;
    }
    return path || el.tagName.toLowerCase();
  }
  function classify(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || el.getAttribute('role') === 'button') return 'button';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'input';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'p' || tag === 'span' || tag === 'div') return 'text';
    return 'other';
  }
  function elText(el) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    if (!t && el.tagName === 'INPUT')
      return (el.placeholder || el.value || el.getAttribute('aria-label') || '').slice(0, 80);
    return t;
  }
  function score(matched, visible) {
    let s = matched;
    if (!visible) s = Math.max(0, s - 0.3);
    return Math.round(s * 100) / 100;
  }

  // Bound the scan — pages can have 10k+ nodes and CDP timeout is 15s.
  const SCAN_BUDGET_MS = 3000;
  const nowFn = (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
  const startTs = nowFn();
  const deadline = startTs + SCAN_BUDGET_MS;
  let aborted = false;
  // Sample the clock every 1024 iterations — cheap but keeps latency bounded.
  function overBudget(i) { return (i & 0x3FF) === 0 && nowFn() > deadline; }

  // IIFE-local match-state stores. WeakMap is essential: DOM elements persist
  // across Runtime.evaluate calls, so any expando we set (e.g. el.__matchScore)
  // would leak into the next search and contaminate scores / matchedBy / dedupe.
  // WeakMap is GC'd at IIFE end so each call starts clean.
  const matchScore = new WeakMap();
  const matchedByMap = new WeakMap();
  const pushed = new Set();
  function record(el, score, by) {
    const prev = matchScore.get(el) || 0;
    if (score > prev) { matchScore.set(el, score); matchedByMap.set(el, by); }
    if (!pushed.has(el)) { candidates.push(el); pushed.add(el); }
  }

  const all = root.querySelectorAll('*');
  let candidates = [];

  if (by === 'selector') {
    const selectorMatches = Array.from(root.querySelectorAll(pat));
    for (let i = 0; i < selectorMatches.length; i++) {
      if (overBudget(i)) { aborted = true; break; }
      record(selectorMatches[i], 1.0, 'selector');
    }
  } else if (by === 'text') {
    const needle = cs ? pat : pat.toLowerCase();
    let i = 0;
    for (const el of all) {
      if (overBudget(i++)) { aborted = true; break; }
      // Direct child text only (avoid double-counting parent matches via descendants)
      const direct = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent || '')
        .join('').trim();
      if (!direct) continue;
      const hay = cs ? direct : direct.toLowerCase();
      if (hay === needle) record(el, 1.0, 'text');
      else if (hay.includes(needle)) record(el, 0.8, 'text');
    }
  } else if (by === 'regex') {
    let re;
    try { re = new RegExp(pat, (cs ? '' : 'i') + 'u'); }
    catch (e) { return { __error: "InvalidRegex", message: String(e) }; }
    let i = 0;
    for (const el of all) {
      if (overBudget(i++)) { aborted = true; break; }
      const direct = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent || '').join('').trim();
      if (!direct) continue;
      if (re.test(direct)) record(el, 0.9, 'regex');
    }
  } else if (by === 'role') {
    const needle = cs ? pat : pat.toLowerCase();
    let i = 0;
    for (const el of all) {
      if (overBudget(i++)) { aborted = true; break; }
      const role = el.getAttribute('role') || '';
      const cmp = cs ? role : role.toLowerCase();
      if (cmp === needle) record(el, 0.75, 'role');
    }
    // Implicit roles — score slightly higher because they're guaranteed by tag.
    if (!aborted && needle === 'button')  for (const el of root.querySelectorAll('button')) record(el, 0.85, 'roleImplicit');
    if (!aborted && needle === 'link')    for (const el of root.querySelectorAll('a[href]')) record(el, 0.85, 'roleImplicit');
    if (!aborted && needle === 'heading') for (const el of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) record(el, 0.85, 'roleImplicit');
  } else if (by === 'ariaLabel') {
    const needle = cs ? pat : pat.toLowerCase();
    let i = 0;
    for (const el of all) {
      if (overBudget(i++)) { aborted = true; break; }
      const aria = el.getAttribute('aria-label') || '';
      if (!aria) continue;
      const cmp = cs ? aria : aria.toLowerCase();
      if (cmp === needle) record(el, 0.95, 'ariaLabel');
      else if (cmp.includes(needle)) record(el, 0.7, 'ariaLabel');
    }
  }

  // candidates already de-duplicated via the pushed Set in record()

  if (aborted && candidates.length === 0) {
    return { __error: "Timeout", message: "Scan budget exceeded with no matches; narrow scope or maxResults." };
  }

  const filtered = [];
  for (const el of candidates) {
    const visible = isVisible(el);
    if (visibleOnly && !visible) continue;
    const rect = el.getBoundingClientRect();
    const inVp = inViewportRect(rect);
    if (viewportOnly && !inVp) continue;
    filtered.push({ el, visible, rect, inVp });
  }

  // Score and sort by confidence desc
  filtered.sort((a, b) => {
    const sa = score(matchScore.get(a.el) || 0, a.visible);
    const sb = score(matchScore.get(b.el) || 0, b.visible);
    return sb - sa;
  });

  const total = filtered.length;
  const sliced = filtered.slice(offN, offN + (maxN - offN));

  const results = sliced.map(({ el, visible, rect, inVp }) => ({
    type: classify(el),
    text: elText(el),
    selector: bestSelector(el),
    role: el.getAttribute('role') || undefined,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    matchedBy: matchedByMap.get(el),
    confidence: score(matchScore.get(el) || 0, visible),
    inViewport: inVp,
    rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
  }));

  return { total, returned: results.length, truncated: total > offN + results.length, results };
})()
`;
    const result = await evaluateInTab(expression, tabId ?? null, port);
    if (result && typeof result === "object" && "__error" in (result as object)) {
      const r = result as { __error: string; message?: string };
      const code = r.__error === "ScopeNotFound" ? "ScopeNotFound"
                : r.__error === "InvalidRegex" ? "BrowserSearchNoResults"
                : r.__error === "Timeout" ? "BrowserSearchTimeout"
                : "ToolError";
      const suggest = code === "ScopeNotFound"
        ? ["Verify the scope CSS selector matches at least one element", "Omit scope to search the full document"]
        : code === "BrowserSearchTimeout"
        ? ["Reduce maxResults", "Narrow scope via CSS selector", "Try by:'selector' if you know the element"]
        : ["Verify your regex syntax", "Try a literal pattern with by:'text'"];
      return fail({
        ok: false, code,
        error: `browser_search: ${r.__error}${r.message ? " — " + r.message : ""}`,
        suggest,
        context: { by, pattern, scope },
      });
    }
    const payload = result as {
      total: number; returned: number; truncated: boolean;
      results: Array<{ confidence: number; selector: string; text: string }>;
    };
    if (payload.total === 0) {
      return fail({
        ok: false,
        code: "BrowserSearchNoResults",
        error: `browser_search(${by}, ${JSON.stringify(pattern)}) returned 0 results`,
        suggest: [
          "Try a different 'by' axis",
          "Remove scope or set visibleOnly:false",
          "Toggle caseSensitive:false",
        ],
        context: { by, pattern, scope, visibleOnly, inViewportOnly },
      });
    }
    const tabCtx = await getTabContext(tabId ?? null, port);
    return ok({ ...payload, activeTab: { id: tabCtx.id, title: tabCtx.title, url: tabCtx.url }, readyState: tabCtx.readyState });
  } catch (err) {
    return failWith(err, "browser_search", { by, pattern, scope });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// browser_get_app_state — extract embedded JSON / SPA hydration payloads
//
// Many SPAs render almost no useful HTML but ship the actual state in one of
// a handful of well-known script tags or window globals. Probing them blindly
// from the LLM costs 3-5 round-trips. This tool runs one CDP eval that scans
// the standard locations and returns whatever it finds, parsed.
// ─────────────────────────────────────────────────────────────────────────────

export const browserGetAppStateSchema = {
  selectors: z
    .array(z.string())
    .optional()
    .describe(
      "Optional override list of CSS selectors / window globals to probe. " +
      "Window globals must be prefixed with 'window:' (e.g. 'window:__INITIAL_STATE__'). " +
      "When omitted, scans the standard list (Next.js, GitHub react-app, Nuxt, Apollo, Remix, Redux SSR, JSON-LD)."
    ),
  maxBytes: z.coerce
    .number()
    .int()
    .min(256)
    .max(64_000)
    .default(4_000)
    .describe("Maximum bytes per individual payload (default 4000). Larger payloads are stringified and truncated."),
  tabId: tabIdParam,
  port: portParam,
  includeContext: includeContextParam,
};

interface AppStateHit {
  selector: string;
  framework: string;
  sizeBytes: number;
  truncated: boolean;
  payload: unknown;
}

export const browserGetAppStateHandler = async ({
  selectors,
  maxBytes,
  tabId,
  port,
  includeContext,
}: {
  selectors?: string[];
  maxBytes: number;
  tabId?: string;
  port: number;
  includeContext: boolean;
}): Promise<ToolResult> => {
  try {
    const probes: Array<{ selector: string; framework: string }> = selectors
      ? selectors.map((s) => ({ selector: s, framework: "custom" }))
      : [
          { selector: 'script#__NEXT_DATA__',                                                 framework: "next" },
          { selector: 'script#__NUXT_DATA__',                                                 framework: "nuxt" },
          { selector: 'script#__NUXT__',                                                      framework: "nuxt" },
          { selector: 'script#__REMIX_CONTEXT__',                                             framework: "remix" },
          { selector: 'script[type="application/json"][data-target$=".embeddedData"]',         framework: "react-app" },
          { selector: 'script[type="application/json"][data-target$="embeddedData"]',          framework: "react-app" },
          { selector: 'script[type="application/json"][id*="__APOLLO_STATE__"]',               framework: "apollo" },
          { selector: 'script[type="application/json"][id*="server-data"]',                    framework: "vue-ssr" },
          { selector: 'script[type="application/ld+json"]',                                   framework: "ld+json" },
          { selector: 'window:__INITIAL_STATE__',                                             framework: "redux-ssr" },
          { selector: 'window:__APOLLO_STATE__',                                              framework: "apollo" },
          { selector: 'window:__NUXT__',                                                      framework: "nuxt" },
        ];

    const expression = `
(function() {
  const probes = ${JSON.stringify(probes)};
  const maxBytes = ${JSON.stringify(maxBytes)};
  const found = [];
  const notFound = [];
  for (const p of probes) {
    try {
      let raw;
      if (p.selector.startsWith('window:')) {
        const key = p.selector.slice('window:'.length);
        const v = window[key];
        if (v === undefined || v === null) { notFound.push(p.selector); continue; }
        raw = (typeof v === 'string') ? v : JSON.stringify(v);
      } else {
        const els = document.querySelectorAll(p.selector);
        if (els.length === 0) { notFound.push(p.selector); continue; }
        // For multi-match selectors (ld+json), join entries; otherwise take first.
        if (els.length > 1 && p.framework === 'ld+json') {
          const parts = [];
          for (const el of els) parts.push(el.textContent || '');
          raw = '[' + parts.filter(s => s.trim()).join(',') + ']';
        } else {
          raw = els[0].textContent || '';
        }
      }
      const sizeBytes = raw.length;
      const truncated = sizeBytes > maxBytes;
      const slice = truncated ? raw.slice(0, maxBytes) : raw;
      let payload;
      try { payload = JSON.parse(slice); }
      catch (e) { payload = { __parseError: String(e && e.message || e), preview: slice.slice(0, 240) }; }
      found.push({ selector: p.selector, framework: p.framework, sizeBytes, truncated, payload });
    } catch (e) {
      notFound.push(p.selector);
    }
  }
  return JSON.stringify({ found, notFound });
})()
`;
    const raw = (await evaluateInTab(expression, tabId ?? null, port)) as string;
    const parsed = JSON.parse(raw) as { found: AppStateHit[]; notFound: string[] };
    const payload: Record<string, unknown> = {
      ok: true,
      found: parsed.found,
      notFound: parsed.notFound,
    };
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      payload.activeTab = { id: tabCtx.id, title: tabCtx.title, url: tabCtx.url };
      payload.readyState = tabCtx.readyState;
    }
    return ok(payload);
  } catch (err) {
    return failWith(err, "browser_get_app_state");
  }
};

export const browserDisconnectHandler = async ({
  port,
}: {
  port: number;
}): Promise<ToolResult> => {
  try {
    disconnectAll(port);
    return {
      content: [
        {
          type: "text" as const,
          text: `Closed all cached CDP sessions for port ${port}.`,
        },
      ],
    };
  } catch (err) {
    return failWith(err, "browser_disconnect");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerBrowserTools(server: McpServer): void {
  // Wire wait_until(element_matches) — resolve top result for callers that just need selector + text.
  setBrowserSearchHook(async ({ port, tabId, by, pattern, scope }) => {
    try {
      const result = await browserSearchHandler({
        by, pattern, scope, maxResults: 5, offset: 0,
        visibleOnly: true, inViewportOnly: false, caseSensitive: false,
        tabId, port: port ?? _defaultPort,
      });
      const text = result.content[0]?.type === "text" ? result.content[0].text : "{}";
      const parsed = JSON.parse(text) as { results?: Array<{ selector: string; text: string }> };
      return parsed.results ?? [];
    } catch {
      return [];
    }
  });

  server.tool(
    "browser_search",
    "Grep-like element search across the current page. by: 'text' (literal substring), 'regex', 'role', 'ariaLabel', 'selector' (CSS). Returns results[] sorted by confidence descending — pass results[0].selector to browser_click_element. Pagination via offset/maxResults. Caveats: Use browser_get_interactive for broad discovery; use browser_search when you know specific text or role to target.",
    browserSearchSchema,
    browserSearchHandler
  );

  server.tool(
    "browser_get_interactive",
    "List all interactive elements (links, buttons, inputs, ARIA controls) on the current page with CSS selectors, visible text or value for inputs, and viewport status — use before browser_click_element to discover stable selectors, and prefer this over screenshot when verifying button/toggle state after submission (no image tokens, structured output). scope limits to a CSS subsection (e.g. '.sidebar'). Returns state (checked/pressed/selected/expanded) for ARIA custom controls. Caveats: Selectors are CDP-generated snapshots — re-call after page navigates or re-renders. Input text reflects the empty-field hint text when defined (takes priority over typed value) — use browser_eval('document.querySelector(sel).value') to read actual typed content.",
    browserGetInteractiveSchema,
    browserGetInteractiveHandler
  );

  server.tool(
    "browser_get_app_state",
    "Extract embedded SPA framework state (Next.js, Nuxt, Remix, GitHub, Apollo, Redux SSR) in one CDP call. Returns parsed payloads with framework labels. Use BEFORE browser_eval or browser_get_dom on SPAs where rendered HTML is sparse. Pass selectors to target specific window globals (e.g. 'window:__MY_STATE__'). Caveats: Only extracts SSR-injected state — client-only runtime state requires browser_eval.",
    browserGetAppStateSchema,
    browserGetAppStateHandler
  );

  server.tool(
    "browser_launch",
    "Launch Chrome/Edge/Brave in CDP debug mode and wait until the DevTools endpoint is ready. Idempotent — if a CDP endpoint is already live on the target port, returns immediately without spawning. Default: tries chrome → edge → brave (first installed wins), port 9222, userDataDir C:\\tmp\\cdp. Pass url to open a specific page on launch; follow with browser_connect to get tab IDs. Caveats: A Chrome session started without --remote-debugging-port cannot be taken over — close it first or use a separate profile.",
    browserLaunchSchema,
    browserLaunchHandler
  );

  server.tool(
    "browser_connect",
    "Connect to Chrome/Edge running with --remote-debugging-port and return open tab IDs — required before all other browser_* tools. Launch with browser_launch() or manually: chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\tmp\\cdp. Returns tabs[] with id, url, title — pass tabId to browser_* tools to target a specific tab. Caveats: CDP connection is per-process; if Chrome restarts, call browser_connect again to get fresh tab IDs.",
    browserConnectSchema,
    browserConnectHandler
  );

  server.tool(
    "browser_find_element",
    "Find a DOM element by CSS selector and return its physical screen coordinates — compatible directly with mouse_click. Prefer browser_click_element to find+click in one step. Prefer browser_get_interactive to discover selectors. Caveats: Coordinates are captured at call time; if the page reflows before mouse_click, coords may be stale.",
    browserFindElementSchema,
    browserFindElementHandler
  );

  server.tool(
    "browser_click_element",
    "Find a DOM element by CSS selector and click it (combines browser_find_element + mouse_click in one step). Prefer over mouse_click for Chrome — selector-based clicking is stable across repaints. Pass tabId+port so the server auto-guards (verifies tab readyState and identity) and returns post.perception.status. lensId is optional for advanced pinned-tab workflows. Caveats: Fails if the element is outside the visible viewport — scroll it into view with browser_eval(\"document.querySelector('sel').scrollIntoView()\") first.",
    browserClickElementSchema,
    withPostState("browser_click_element", browserClickElementHandler)
  );

  server.tool(
    "browser_eval",
    "Evaluate a JavaScript expression in a browser tab and return raw text. Pass withPerception:true to receive structured JSON {ok, result, post} with post.perception attached. lensId is optional for advanced pinned-lens use. Caveats: DOM nodes cannot be returned directly (circular refs are serialized safely). React/Vue/Svelte controlled inputs cannot be set via element.value — use keyboard_type instead. readyState is strictly checked; guard blocks if page is still loading.",
    browserEvalSchema,
    withPostState("browser_eval", browserEvalHandler)
  );

  server.tool(
    "browser_get_dom",
    "Return the HTML of a DOM element (or document.body when no selector is given), truncated to maxLength characters. Use when browser_get_interactive is insufficient for inspecting page structure.",
    browserGetDomSchema,
    browserGetDomHandler
  );

  server.tool(
    "browser_navigate",
    "Navigate a browser tab to a URL via CDP Page.navigate — more reliable than clicking the address bar. Pass tabId+port so the server auto-guards (verifies tab readyState) and returns post.perception.status. lensId is optional for advanced pinned-tab workflows. Caveats: Does not block until page load completes — follow with wait_until(element_matches) or repeated browser_eval polling for slow pages.",
    browserNavigateSchema,
    withPostState("browser_navigate", browserNavigateHandler)
  );

  server.tool(
    "browser_disconnect",
    "Close cached CDP WebSocket sessions for a port. Call when browser interaction is complete to release connections.",
    browserDisconnectSchema,
    browserDisconnectHandler
  );

  server.tool(
    "browser_fill_input",
    "Fill a form input with a value via CDP — works on React/Vue/Svelte controlled inputs that reject browser_eval value assignment. Use browser_get_interactive or browser_find_element first to obtain a stable selector. Use this over browser_eval when setting a controlled input's value via JS does not update the framework state. Caveats: Requires browser_connect (CDP active). Does not work on contenteditable rich-text editors — use keyboard_type for those. actual in response shows what the element's value property reads after fill; verify it matches the intended value.",
    browserFillInputSchema,
    browserFillInputHandler
  );

  server.tool(
    "browser_get_form",
    "Inspect all form fields (input, select, textarea, button) within a CSS-selector-specified container and return their name, type, id, current value, hint text, disabled/readOnly state, and associated label text (resolved via for[id], ancestor LABEL, aria-labelledby, aria-label in that order). Use this before browser_fill_input to discover exact field selectors and avoid accidentally targeting the wrong input (e.g. a global search bar). Caveats: Requires browser_connect (CDP active). Hidden inputs (type=hidden) are excluded by default — set includeHidden:true if needed. Value text is truncated at 200 chars.",
    browserGetFormSchema,
    browserGetFormHandler
  );
}
