import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { coercedBoolean } from "./_coerce.js";
import { getCdpPort } from "../utils/desktop-config.js";

// Internal handlers imported from existing files (retained as internal exports)
import { scrollHandler as rawScrollHandler } from "./mouse.js";
import { scrollToElementHandler } from "./scroll-to-element.js";
import { smartScrollHandler } from "./smart-scroll.js";
import { scrollCaptureHandler } from "./scroll-capture.js";

const _defaultPort = getCdpPort();

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher schema (discriminated union)
// ─────────────────────────────────────────────────────────────────────────────

export const scrollSchema = z.discriminatedUnion("action", [
  // action='raw' — raw mouse-wheel scroll (was: scroll)
  z.object({
    action: z.literal("raw"),
    direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
    amount: z.coerce.number().int().positive().default(3).describe("Number of scroll steps (default 3)"),
    x: z.coerce.number().optional().describe("X coordinate to scroll at (moves cursor there first)"),
    y: z.coerce.number().optional().describe("Y coordinate to scroll at"),
    speed: z.coerce.number().optional().describe("Cursor movement speed in px/sec (0=teleport, omit=default)"),
    homing: z.coerce.boolean().default(true).describe("Apply window-movement homing correction to (x,y) before scrolling. Default true."),
    windowTitle: z.string().optional().describe("Partial window title. When provided, the server focuses this window first."),
    hwnd: z.string().optional().describe("Direct window handle ID (takes precedence over windowTitle)."),
  }),
  // action='to_element' — scroll element into viewport (was: scroll_to_element)
  z.object({
    action: z.literal("to_element"),
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
  }),
  // action='smart' — smart scroll with multi-strategy fallback (was: smart_scroll)
  z.object({
    action: z.literal("smart"),
    target: z.string().describe(
      "CSS selector (Chrome/Edge) or partial UIA name (native apps). " +
      "For CDP path, must be a valid CSS selector (starts with #, ., tag, or [ ). " +
      "For UIA path, a partial name match against element Name property."
    ),
    windowTitle: z.string().optional().describe(
      "Partial window title. Required for UIA and image paths. For CDP path, optional."
    ),
    tabId: z.string().optional().describe("CDP tab ID (Chrome path only). Omit for first page tab."),
    port: z.coerce.number().int().min(1).max(65535).default(_defaultPort).describe(
      `CDP port (default ${_defaultPort})`
    ),
    strategy: z.enum(["auto", "cdp", "uia", "image"]).default("auto").describe(
      "auto (default): try CDP → UIA → image in order. cdp: Chrome/Edge only. uia: native Windows UIA. image: image + Win32 binary-search."
    ),
    direction: z.enum(["into-view", "up", "down", "left", "right"]).default("into-view").describe(
      "Scroll direction. into-view: scroll until target element is visible (default). Other values scroll unconditionally."
    ),
    inline: z.enum(["start", "center", "end", "nearest"]).default("center").describe(
      "Vertical alignment after scroll (CDP path). Default: center."
    ),
    maxDepth: z.number().int().min(1).max(10).default(3).describe(
      "Max number of ancestor scroll containers to walk. Default 3."
    ),
    retryCount: z.number().int().min(1).max(4).default(3).describe(
      "Max scroll attempts (image path binary-search). Default 3, cap 4."
    ),
    verifyWithHash: coercedBoolean().default(false).describe(
      "Verify scroll effectiveness via perceptual hash comparison. Automatically enabled for image path."
    ),
    virtualIndex: z.number().int().min(0).optional().describe(
      "Target row index in a virtualised list (0-based). Enables direct TanStack/data-index seeking."
    ),
    virtualTotal: z.number().int().min(1).optional().describe(
      "Total row count in a virtualised list. Required when virtualIndex is set."
    ),
    expandHidden: coercedBoolean().default(false).describe(
      "Temporarily set overflow:hidden ancestors to overflow:auto to unlock scroll. Mutates live CSS."
    ),
    hint: z.enum(["above", "below", "left", "right"]).optional().describe(
      "Scroll direction hint for binary-search (image path). Seeds lo/hi bounds to reduce attempts."
    ),
  }),
  // action='capture' — full-page stitched image (was: scroll_capture)
  z.object({
    action: z.literal("capture"),
    windowTitle: z
      .string()
      .describe("Partial title of the window to capture (case-insensitive match)"),
    direction: z
      .enum(["down", "right"])
      .default("down")
      .describe(
        "Scroll direction: 'down' (vertical, uses Page Down key) or 'right' (horizontal, uses mouse scroll). Default 'down'."
      ),
    maxScrolls: z
      .coerce.number()
      .int()
      .min(1)
      .max(30)
      .default(10)
      .describe("Maximum scroll iterations before stopping (default 10, max 30)"),
    scrollDelayMs: z
      .coerce.number()
      .int()
      .min(100)
      .max(3000)
      .default(400)
      .describe(
        "Milliseconds to wait after each scroll for rendering to settle (default 400). Increase for slow/animated pages."
      ),
    maxWidth: z
      .coerce.number()
      .int()
      .positive()
      .default(1280)
      .describe(
        "Max size of the short edge of the final image (default 1280). " +
        "For 'down': caps the image width; height is unconstrained. " +
        "For 'right': caps the image height; width is unconstrained."
      ),
  }),
]);

export type ScrollArgs = z.infer<typeof scrollSchema>;

export const scrollDispatchHandler = async (args: ScrollArgs): Promise<ToolResult> => {
  switch (args.action) {
    case "raw":
      return rawScrollHandler(args);
    case "to_element":
      return scrollToElementHandler(args);
    case "smart":
      return smartScrollHandler(args);
    case "capture":
      return scrollCaptureHandler(args);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerScrollTools(server: McpServer): void {
  server.registerTool(
    "scroll",
    {
      description: buildDesc({
        purpose: "Scroll a window or page. 4 strategies via action: 'raw' (wheel notches), 'to_element' (UIA name/automationId or CSS selector), 'smart' (auto-detect target with multi-strategy fallback), 'capture' (full-page stitched image).",
        details: "action='raw': send raw mouse-wheel notches at (x,y) or current cursor, optional window focus. action='to_element': scroll a named element into viewport (UIA or CDP). action='smart': handles nested scroll layers, virtualised lists, sticky-header occlusion. action='capture': stitches full-page images (caps at ~700KB raw); sizeReduced=true means downscaled.",
        prefer: "Use action='to_element' or action='smart' for click target out-of-viewport recovery (entity_outside_viewport). Use action='capture' for reading long pages. For simple scroll without target, use action='raw'.",
        caveats: "action='capture' returns stitched image — pixels do NOT match screen coords when sizeReduced=true, use for reading only, not mouse_click. action='smart' CDP path requires browser_open. action='to_element' native path requires element to implement UIA ScrollItemPattern.",
        examples: [
          "scroll({action:'raw', direction:'down', amount:5, windowTitle:'Chrome'})",
          "scroll({action:'to_element', name:'OK', windowTitle:'Dialog'})",
          "scroll({action:'smart', target:'#create-release-btn'})",
          "scroll({action:'capture', windowTitle:'Chrome', maxScrolls:10})",
        ],
      }),
      inputSchema: scrollSchema,
    },
    scrollDispatchHandler as (args: Record<string, unknown>) => Promise<ToolResult>
  );
}
