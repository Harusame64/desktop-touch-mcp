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
  DEFAULT_CDP_PORT,
} from "../engine/cdp-bridge.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const portParam = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .default(DEFAULT_CDP_PORT)
  .describe("Chrome/Edge CDP remote debugging port (default 9222)");

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
    "browser_connect",
    [
      "Connect to Chrome or Edge running with --remote-debugging-port and list open tabs.",
      "Launch with: chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\tmp\\cdp",
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
