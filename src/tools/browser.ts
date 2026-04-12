import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mouse, Button, Point, straightTo, DEFAULT_MOUSE_SPEED } from "../engine/nutjs.js";
import { enumWindowsInZOrder, restoreAndFocusWindow } from "../engine/win32.js";
import { updateWindowCache } from "../engine/window-cache.js";
import type { ToolResult } from "./_types.js";
import {
  listTabs,
  evaluateInTab,
  getElementScreenCoords,
  navigateTo,
  getDomHtml,
  disconnectAll,
  type CdpTab,
} from "../engine/cdp-bridge.js";
import { resolveWellKnownPath, spawnDetached } from "../utils/launch.js";
import { getCdpPort } from "../utils/desktop-config.js";

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
  tabId: tabIdParam,
  port: portParam,
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
    const summary = pageTabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
    }));
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Connected to Chrome/Edge CDP at port ${port}.`,
            `${pageTabs.length} page tab(s) found:`,
            JSON.stringify(summary, null, 2),
            "",
            "Pass a tab's id to other browser_* tools to target it, or omit to use the first tab.",
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `browser_connect failed: ${String(err)}` }],
    };
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
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `browser_find_element failed: ${String(err)}` }],
    };
  }
};

export const browserClickElementHandler = async ({
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
    if (!coords.inViewport) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `browser_click_element: element "${selector}" is outside the visible viewport. ` +
              `Scroll it into view first: browser_eval("document.querySelector(${JSON.stringify(selector)}).scrollIntoView()")`,
          },
        ],
      };
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
    return {
      content: [
        {
          type: "text" as const,
          text: `Clicked "${selector}" at screen (${coords.x}, ${coords.y})`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `browser_click_element failed: ${String(err)}` }],
    };
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
    const text =
      result === null || result === undefined
        ? "(null)"
        : typeof result === "string"
          ? result
          : JSON.stringify(result, null, 2);
    return {
      content: [{ type: "text" as const, text }],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `browser_eval failed: ${String(err)}` }],
    };
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
    return {
      content: [{ type: "text" as const, text: html }],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `browser_get_dom failed: ${String(err)}` }],
    };
  }
};

export const browserNavigateHandler = async ({
  url,
  tabId,
  port,
}: {
  url: string;
  tabId?: string;
  port: number;
}): Promise<ToolResult> => {
  try {
    await navigateTo(url, tabId ?? null, port);
    return {
      content: [
        {
          type: "text" as const,
          text: `Navigating to: ${url}\nWait a moment, then use browser_eval("document.readyState") to check if the page has loaded.`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `browser_navigate failed: ${String(err)}` }],
    };
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
    return {
      content: [{
        type: "text" as const,
        text: [
          `Found ${items.length} interactive element(s)${scope ? ` within "${scope}"` : ""}:`,
          JSON.stringify(items, null, 2),
        ].join("\n"),
      }],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `browser_get_interactive failed: ${String(err)}` }],
    };
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
    const deadline = Date.now() + waitMs;
    let tabs: CdpTab[] | null = null;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        tabs = await listTabs(port);
        break;
      } catch (e) {
        lastErr = e;
        await new Promise<void>((r) => setTimeout(r, 200));
      }
    }
    if (!tabs) {
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
    return {
      content: [{ type: "text" as const, text: `browser_launch failed: ${String(err)}` }],
    };
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
    return {
      content: [{ type: "text" as const, text: `browser_disconnect failed: ${String(err)}` }],
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerBrowserTools(server: McpServer): void {
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
    browserClickElementHandler
  );

  server.tool(
    "browser_eval",
    [
      "Evaluate a JavaScript expression in the browser tab and return the result.",
      "Use for: reading text content, checking state, scrolling, filling inputs via JS.",
      "Example: browser_eval(\"document.title\") → page title string.",
    ].join("\n"),
    browserEvalSchema,
    browserEvalHandler
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
    browserNavigateHandler
  );

  server.tool(
    "browser_disconnect",
    "Close cached CDP WebSocket sessions for a port. Call when done to release connections.",
    browserDisconnectSchema,
    browserDisconnectHandler
  );
}
