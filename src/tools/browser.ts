import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mouse, Button, Point, straightTo, DEFAULT_MOUSE_SPEED } from "../engine/nutjs.js";
import { enumWindowsInZOrder, restoreAndFocusWindow } from "../engine/win32.js";
import { updateWindowCache } from "../engine/window-cache.js";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
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
} from "../engine/cdp-bridge.js";
import { resolveWellKnownPath, spawnDetached } from "../utils/launch.js";
import { getCdpPort } from "../utils/desktop-config.js";
import { fail } from "./_types.js";
import { setBrowserSearchHook } from "./wait-until.js";
import { withPostState } from "./_post.js";
import { narrateParam } from "./_narration.js";
import type { RichBlock } from "../engine/uia-diff.js";

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

export const browserFindElementSchema = {
  selector: selectorParam,
  tabId: tabIdParam,
  port: portParam,
};

export const browserClickElementSchema = {
  selector: selectorParam,
  narrate: narrateParam,
  tabId: tabIdParam,
  port: portParam,
};

export const browserEvalSchema = {
  expression: z.string().describe("JavaScript expression to evaluate in the browser tab"),
  tabId: tabIdParam,
  port: portParam,
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
};

export const browserNavigateSchema = {
  url: z.string().describe("URL to navigate to"),
  narrate: narrateParam,
  tabId: tabIdParam,
  port: portParam,
  waitForLoad: z.boolean().default(true).describe(
    "When true (default), wait for document.readyState === 'complete' before returning. " +
    "Use waitForLoad:false for the legacy behavior (return immediately after Page.navigate)."
  ),
  loadTimeoutMs: z.coerce.number().int().min(500).max(30000).default(15000).describe(
    "Max milliseconds to wait for page load when waitForLoad=true (default 15000). " +
    "On timeout, returns ok:true with readyState set to current state and hints.warnings=['NavigateTimeout']."
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
  visibleOnly: z.boolean().default(true).describe("Only visible elements (default true). Set false to include hidden ones with confidence penalty."),
  inViewportOnly: z.boolean().default(false).describe("Only currently-in-viewport elements (default false)."),
  caseSensitive: z.boolean().default(false).describe("Case-sensitive matching for text/regex (default false)."),
  tabId: tabIdParam,
  port: portParam,
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
  inViewportOnly: z
    .boolean()
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
};

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
}: {
  selector: string;
  tabId?: string;
  port: number;
}): Promise<ToolResult> => {
  try {
    const coords = await getElementScreenCoords(
      selector,
      tabId ?? null,
      port
    );
    const tabCtx = await getTabContext(tabId ?? null, port);
    return {
      content: [
        {
          type: "text" as const,
          text: [
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
            "",
            `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
            `readyState: "${tabCtx.readyState}"`,
          ].join("\n"),
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
}: {
  selector: string;
  narrate?: string;
  tabId?: string;
  port: number;
}): Promise<ToolResult> => {
  try {
    // CDP snapshot before click (for narrate:"rich")
    let beforeUrl: string | null = null;
    if (narrate === "rich") {
      try {
        const ctx = await getTabContext(tabId ?? null, port);
        beforeUrl = ctx.url ?? null;
      } catch { /* ignore */ }
    }

    const coords = await getElementScreenCoords(
      selector,
      tabId ?? null,
      port
    );
    if (!coords.inViewport) {
      return fail({
        ok: false,
        code: "ElementNotInViewport",
        error: `browser_click_element: element "${selector}" is outside the visible viewport.`,
        suggest: [`Scroll it into view first: browser_eval("document.querySelector(${JSON.stringify(selector)}).scrollIntoView()")`],
        context: { selector },
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
    const tabCtx = await getTabContext(tabId ?? null, port);

    // Build rich block for CDP diff
    let richBlock: RichBlock | undefined;
    if (narrate === "rich" && beforeUrl !== null) {
      await new Promise<void>((r) => setTimeout(r, 150));
      try {
        const afterCtx = await getTabContext(tabId ?? null, port);
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
    });
  } catch (err) {
    return failWith(err, "browser_click_element");
  }
};

export const browserEvalHandler = async ({
  expression,
  tabId,
  port,
}: {
  expression: string;
  tabId?: string;
  port: number;
}): Promise<ToolResult> => {
  try {
    const result = await evaluateInTab(expression, tabId ?? null, port);
    const tabCtx = await getTabContext(tabId ?? null, port);
    const text =
      result === null || result === undefined
        ? "(null)"
        : typeof result === "string"
          ? result
          : JSON.stringify(result, null, 2);
    return {
      content: [{
        type: "text" as const,
        text: [
          text,
          "",
          `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
          `readyState: "${tabCtx.readyState}"`,
        ].join("\n"),
      }],
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
}: {
  selector?: string;
  tabId?: string;
  port: number;
  maxLength: number;
}): Promise<ToolResult> => {
  try {
    const html = await getDomHtml(
      selector ?? null,
      tabId ?? null,
      port,
      maxLength
    );
    const tabCtx = await getTabContext(tabId ?? null, port);
    return {
      content: [{
        type: "text" as const,
        text: [
          html,
          "",
          `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
          `readyState: "${tabCtx.readyState}"`,
        ].join("\n"),
      }],
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
}: {
  url: string;
  narrate?: string;
  tabId?: string;
  port: number;
  waitForLoad: boolean;
  loadTimeoutMs: number;
}): Promise<ToolResult> => {
  try {
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
}: {
  scope?: string;
  types: Array<"link" | "button" | "input" | "all">;
  inViewportOnly: boolean;
  maxResults: number;
  tabId?: string;
  port: number;
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
    if (tag === 'a') return 'link';
    if (tag === 'button' || el.getAttribute('role') === 'button') return 'button';
    if (tag === 'input') return 'input[' + (el.type || 'text') + ']';
    return tag;
  }

  function elText(el) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    if (!t && el.tagName === 'INPUT')
      return (el.placeholder || el.value || el.getAttribute('aria-label') || '').slice(0, 80);
    return t;
  }

  const out = [];
  for (const el of root.querySelectorAll(cssQ)) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    const vp = inViewportRect(rect);
    if (viewportOnly && !vp) continue;
    const item = { type: elType(el), text: elText(el), selector: bestSelector(el), inViewport: vp };
    if (el.tagName === 'A') item.href = el.href;
    out.push(item);
    if (out.length >= maxN) break;
  }
  return out;
})()
`;

    const result = await evaluateInTab(expression, tabId ?? null, port);
    const items = Array.isArray(result) ? result : [];
    const tabCtx = await getTabContext(tabId ?? null, port);
    return {
      content: [{
        type: "text" as const,
        text: [
          `Found ${items.length} interactive element(s)${scope ? ` within "${scope}"` : ""}:`,
          JSON.stringify(items, null, 2),
          "",
          `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
          `readyState: "${tabCtx.readyState}"`,
        ].join("\n"),
      }],
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
    [
      "Grep-like element search. Pick the best match by confidence rank.",
      "by: 'text' (literal substring), 'regex', 'role', 'ariaLabel', 'selector' (CSS).",
      "Returns results[] sorted by confidence desc — pass results[0].selector to browser_click_element.",
      "Pagination: offset/maxResults. Visibility: visibleOnly/inViewportOnly. Case: caseSensitive.",
    ].join("\n"),
    browserSearchSchema,
    browserSearchHandler
  );

  server.tool(
    "browser_get_interactive",
    [
      "List all interactive elements (links, buttons, inputs) on the current page with their text, CSS selector, and viewport status.",
      "Use this before browser_click_element to discover stable selectors without trial-and-error.",
      "scope: limit to a section (e.g. '.s-main-slot'). inViewportOnly: skip off-screen elements.",
      "Each result includes 'selector' ready to pass to browser_click_element or browser_find_element.",
    ].join("\n"),
    browserGetInteractiveSchema,
    browserGetInteractiveHandler
  );

  server.tool(
    "browser_launch",
    [
      "Launch Chrome/Edge/Brave in CDP debug mode and wait until the DevTools endpoint is ready.",
      "If a CDP endpoint is already live on the target port, returns immediately without spawning (idempotent).",
      "Default: tries chrome → edge → brave (first installed wins), port 9222, userDataDir C:\\tmp\\cdp.",
      "Pass url to open a page on launch. After this returns, call browser_connect / browser_* tools normally.",
    ].join("\n"),
    browserLaunchSchema,
    browserLaunchHandler
  );

  server.tool(
    "browser_connect",
    [
      "Connect to Chrome or Edge running with --remote-debugging-port and list open tabs.",
      "Launch with: browser_launch() or chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\tmp\\cdp",
      "Returns tab IDs needed for other browser_* tools.",
    ].join("\n"),
    browserConnectSchema,
    browserConnectHandler
  );

  server.tool(
    "browser_find_element",
    [
      "Find a DOM element by CSS selector and return its exact screen coordinates (physical pixels).",
      "Coordinates are directly compatible with mouse_click — no manual scaling needed.",
      "More accurate than screenshot-based coordinate estimation.",
    ].join("\n"),
    browserFindElementSchema,
    browserFindElementHandler
  );

  server.tool(
    "browser_click_element",
    [
      "Find a DOM element by CSS selector and click it. Combines browser_find_element + mouse_click in one step.",
      "Fails if the element is outside the visible viewport — scroll into view first.",
    ].join("\n"),
    browserClickElementSchema,
    withPostState("browser_click_element", browserClickElementHandler)
  );

  server.tool(
    "browser_eval",
    [
      "Evaluate a JavaScript expression in the browser tab and return the result.",
      "Use for: reading text content, checking state, scrolling, filling inputs via JS.",
      "Example: browser_eval(\"document.title\") → page title string.",
    ].join("\n"),
    browserEvalSchema,
    withPostState("browser_eval", browserEvalHandler)
  );

  server.tool(
    "browser_get_dom",
    [
      "Get the HTML of a DOM element (or document.body if no selector). Truncated to maxLength chars.",
      "Useful for inspecting the page structure before deciding which selector to use.",
    ].join("\n"),
    browserGetDomSchema,
    browserGetDomHandler
  );

  server.tool(
    "browser_navigate",
    [
      "Navigate the browser tab to a URL using CDP Page.navigate.",
      "More reliable than clicking the address bar — no need to find UI elements.",
      "After calling, wait and check document.readyState via browser_eval.",
    ].join("\n"),
    browserNavigateSchema,
    withPostState("browser_navigate", browserNavigateHandler)
  );

  server.tool(
    "browser_disconnect",
    "Close cached CDP WebSocket sessions for a port. Call when done to release connections.",
    browserDisconnectSchema,
    browserDisconnectHandler
  );
}
