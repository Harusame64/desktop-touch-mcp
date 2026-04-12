import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureScreen, captureDisplay, captureWindowBackground } from "../engine/image.js";
import { captureAndDiff, captureAllLayers, hasBuffer, clearLayers } from "../engine/layer-buffer.js";
import type { WindowInfo } from "../engine/layer-buffer.js";
import { getWindows } from "../engine/nutjs.js";
import { enumMonitors, getVirtualScreen, getWindowTitleW, enumWindowsInZOrder } from "../engine/win32.js";
import { getUiElements, extractActionableElements } from "../engine/uia-bridge.js";
import { updateWindowCache } from "../engine/window-cache.js";
import type { ToolResult } from "./_types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas (plain objects — used by server.tool() and the macro registry)
// ─────────────────────────────────────────────────────────────────────────────

export const screenshotSchema = {
  windowTitle: z
    .string()
    .optional()
    .describe("Capture only the window whose title contains this string. Prefer over full-screen when target window is known."),
  displayId: z
    .coerce.number()
    .int()
    .min(0)
    .optional()
    .describe("Capture a specific monitor (0 = primary). Use get_screen_info to list displays."),
  region: z
    .object({
      x: z.coerce.number().describe("Left edge in virtual screen coordinates"),
      y: z.coerce.number().describe("Top edge in virtual screen coordinates"),
      width: z.coerce.number().positive(),
      height: z.coerce.number().positive(),
    })
    .optional()
    .describe("Capture only this region (virtual screen coordinates)."),
  maxDimension: z
    .coerce.number()
    .int()
    .positive()
    .default(768)
    .describe("Max width or height in pixels (default 768). Use 1280 to read small text, code, or fine UI details. Ignored when dotByDot=true."),
  dotByDot: z
    .boolean()
    .default(false)
    .describe(
      "1:1 pixel mode — no scaling, WebP compression. Image pixel coords = screen coords. " +
      "Use for precise mouse clicking. Window captures include 'origin: (x,y)' so you can compute " +
      "screen position: screen_x = origin_x + image_x."
    ),
  webpQuality: z
    .coerce.number()
    .int()
    .min(1)
    .max(100)
    .default(60)
    .describe("WebP quality when dotByDot=true or diffMode=true. 40=layout only, 60=general (default), 80=fine text."),
  diffMode: z
    .boolean()
    .default(false)
    .describe(
      "Layer diff mode — compares each window against the buffered previous frame. " +
      "First call = full I-frame (all windows). Subsequent calls = only changed windows (P-frame). " +
      "Implicitly enables dotByDot. Best used with windowTitle=undefined to snapshot all windows."
    ),
  detail: z
    .enum(["meta", "text", "image"])
    .optional()
    .describe(
      "Response detail level (omit to let the server pick a smart default):\n" +
      "  omitted — auto: 'image' when dotByDot/region/displayId is specified, else 'meta'\n" +
      "  'meta'  — window title + screen region only (~20 tok/window, cheapest)\n" +
      "  'text'  — UIA element tree as JSON with text values (~100-300 tok/window, no image)\n" +
      "  'image' — actual screenshot pixels. BLOCKED unless confirmImage=true is also passed."
    ),
  confirmImage: z
    .boolean()
    .default(false)
    .describe(
      "Must be true to receive image pixels when detail='image'. " +
      "Without this flag, detail='image' is blocked and a guidance message is returned instead. " +
      "Prefer detail='text' / diffMode=true / dotByDot=true first — " +
      "only set confirmImage=true when visual inspection is genuinely required."
    ),
};

export const screenshotBgSchema = {
  windowTitle: z
    .string()
    .describe("Title (partial match) of the window to capture"),
  maxDimension: z
    .coerce.number()
    .int()
    .positive()
    .default(768)
    .describe("Max width or height in pixels (default 768). Use 1280 to read small text or fine UI details."),
  dotByDot: z
    .boolean()
    .default(false)
    .describe("1:1 pixel mode — no scaling, WebP compression. Image pixel coords = screen coords."),
  webpQuality: z
    .coerce.number()
    .int()
    .min(1)
    .max(100)
    .default(60)
    .describe("WebP quality when dotByDot=true."),
  fullContent: z
    .boolean()
    .default(true)
    .describe(
      "Use PW_RENDERFULLCONTENT flag (default true) to capture GPU-rendered windows (Chrome, Electron, WinUI3). " +
      "Set false for legacy mode (faster, but GPU windows may appear black). " +
      "If this call hangs on a game/video window, retry with fullContent=false."
    ),
};

export const getScreenInfoSchema = {};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build action-oriented UIA representation for a window.
 * Returns actionable elements (buttons, inputs, menus) with pre-computed
 * clickAt coordinates — the LLM can use these directly for mouse_click
 * without any coordinate math.
 */
async function buildUiaText(title: string): Promise<string> {
  try {
    const raw = await getUiElements(title, 4, 100, 5000);
    const result = extractActionableElements(raw);
    return JSON.stringify(result, null, 2);
  } catch {
    return JSON.stringify({ window: title, actionable: [], texts: [], error: "UIA unavailable" });
  }
}

/** Convert enumWindowsInZOrder result to WindowInfo array for layer-buffer. */
async function buildWindowInfoList(): Promise<WindowInfo[]> {
  const wins = enumWindowsInZOrder();
  return wins
    .filter((w) => w.region.width >= 100 && w.region.height >= 50)
    .slice(0, 20)
    .map((w) => ({
      hwnd: BigInt(w.hwnd as unknown as number),
      title: w.title,
      region: w.region,
      zOrder: w.zOrder,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const screenshotHandler = async ({
  windowTitle,
  displayId,
  region,
  maxDimension,
  dotByDot,
  webpQuality,
  diffMode,
  detail,
  confirmImage,
}: {
  windowTitle?: string;
  displayId?: number;
  region?: { x: number; y: number; width: number; height: number };
  maxDimension: number;
  dotByDot: boolean;
  webpQuality: number;
  diffMode: boolean;
  detail: "meta" | "text" | "image" | undefined;
  confirmImage: boolean;
}): Promise<ToolResult> => {
  // Compute effective detail: explicit value wins; otherwise infer from context.
  // dotByDot / region / displayId imply the caller wants pixels, so default to 'image'.
  const effectiveDetail: "meta" | "text" | "image" = detail ?? (
    dotByDot || region !== undefined || displayId !== undefined ? "image" : "meta"
  );

  try {
    // ── Guard: block bare detail='image' unless explicitly confirmed ─────────
    // Only fires when 'image' was explicitly requested (detail==='image'), not when inferred
    // from dotByDot/region/displayId context — those are intentional spatial captures.
    const guardDisabled = process.env.DESKTOP_TOUCH_DISABLE_IMAGE_GUARD === "1";
    if (detail === "image" && !diffMode && !dotByDot && !confirmImage && !guardDisabled) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: [
            "[screenshot-guard] detail='image' was blocked to prevent accidental heavy image payloads.",
            "",
            "Prefer these lighter alternatives (in order):",
            "  1. screenshot(detail='text', windowTitle=X)  — UIA actionable[] with clickAt coords",
            "  2. screenshot(diffMode=true)                 — only changed windows as image",
            "  3. screenshot(dotByDot=true, windowTitle=X)  — 1:1 WebP for pixel-perfect coords",
            "",
            "If an image truly is required, re-call with confirmImage=true (and prefer windowTitle).",
            "To disable this guard globally, set DESKTOP_TOUCH_DISABLE_IMAGE_GUARD=1 in the environment.",
          ].join("\n"),
        }],
      };
    }

    // ── diffMode: layer-based differential capture ───────────────────────────
    if (diffMode) {
      const windowInfos = await buildWindowInfoList();
      updateWindowCache(enumWindowsInZOrder());
      const isFirstFrame = !hasBuffer();
      const diffs = isFirstFrame
        ? await captureAllLayers(windowInfos, webpQuality)
        : await captureAndDiff(windowInfos, webpQuality);

      const newCount = diffs.filter((d) => d.type === "new").length;
      const changedCount = diffs.filter((d) => d.type === "content_changed").length;
      const movedCount = diffs.filter((d) => d.type === "moved").length;
      const unchangedCount = diffs.filter((d) => d.type === "unchanged").length;
      const closedCount = diffs.filter((d) => d.type === "closed").length;

      const frameType = isFirstFrame ? "I-frame (full)" : "P-frame (diff)";
      const summary =
        `Layer diff [${frameType}]: ${windowInfos.length} windows — ` +
        `${newCount} new, ${changedCount} changed, ${movedCount} moved, ${unchangedCount} unchanged, ${closedCount} closed`;

      const content: ToolResult["content"] = [{ type: "text" as const, text: summary }];

      for (const diff of diffs) {
        if (diff.type === "closed") {
          content.push({ type: "text" as const, text: `[CLOSED] "${diff.title}"` });
          continue;
        }
        if (diff.type === "unchanged") continue;

        const regionStr = `(${diff.region.x},${diff.region.y}) ${diff.region.width}x${diff.region.height}`;
        if (diff.type === "moved") {
          const prev = diff.previousRegion;
          const prevStr = prev ? `(${prev.x},${prev.y})→` : "";
          content.push({ type: "text" as const, text: `[MOVED]   "${diff.title}" ${prevStr}${regionStr} (content same, no image)` });
        } else if (diff.image) {
          content.push({ type: "text" as const, text: `[${diff.type === "new" ? "NEW" : "CHANGED"}] "${diff.title}" at ${regionStr}` });
          content.push({ type: "image" as const, data: diff.image.base64, mimeType: diff.image.mimeType });
        }
      }

      return { content };
    }

    // ── detail=meta: window positions only, no image ─────────────────────────
    if (effectiveDetail === "meta") {
      const wins = enumWindowsInZOrder();
      updateWindowCache(wins);
      const metaList = wins
        .filter((w) => w.region.width >= 50 && w.region.height >= 50)
        .map((w) => ({
          title: w.title,
          region: w.region,
          zOrder: w.zOrder,
          isActive: w.isActive,
        }));

      // If windowTitle filter specified, narrow down
      const filtered = windowTitle
        ? metaList.filter((w) => w.title.toLowerCase().includes(windowTitle.toLowerCase()))
        : metaList;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ detail: "meta", windows: filtered }, null, 2),
        }],
      };
    }

    // ── detail=text: UIA element tree as JSON ────────────────────────────────
    if (effectiveDetail === "text") {
      if (windowTitle) {
        updateWindowCache(enumWindowsInZOrder());
        const uiaText = await buildUiaText(windowTitle);
        return { content: [{ type: "text" as const, text: uiaText }] };
      }
      // All visible windows
      const wins = enumWindowsInZOrder();
      updateWindowCache(wins);
      const filteredWins = wins
        .filter((w) => w.region.width >= 100 && w.region.height >= 50)
        .slice(0, 10);
      const results = await Promise.all(
        filteredWins.map(async (w) => {
          try { return JSON.parse(await buildUiaText(w.title)); } catch { return { window: w.title, elements: [] }; }
        })
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ detail: "text", windows: results }, null, 2) }],
      };
    }

    // ── detail=image (default): actual screenshot pixels ─────────────────────
    const captureOpts = dotByDot
      ? { format: "webp" as const, webpQuality }
      : { maxDimension };

    if (windowTitle) {
      const windows = await getWindows();
      let targetRegion: { x: number; y: number; width: number; height: number } | undefined;
      let originX = 0, originY = 0;

      for (const win of windows) {
        const hwnd = (win as unknown as { windowHandle: unknown }).windowHandle;
        const title = hwnd ? getWindowTitleW(hwnd) : await win.title;
        if (title.toLowerCase().includes(windowTitle.toLowerCase())) {
          const reg = await win.region;
          targetRegion = { x: reg.left, y: reg.top, width: reg.width, height: reg.height };
          originX = reg.left;
          originY = reg.top;
          break;
        }
      }

      if (!targetRegion) {
        return { content: [{ type: "text" as const, text: `Window not found: "${windowTitle}"` }] };
      }
      const result = await captureScreen(targetRegion, captureOpts);

      const dimensionText = dotByDot
        ? `Screenshot (dot-by-dot): ${result.width}x${result.height}px | origin: (${originX}, ${originY}) | screen_x = ${originX} + image_x`
        : `Screenshot captured: ${result.width}x${result.height}px`;

      return {
        content: [
          { type: "image" as const, data: result.base64, mimeType: result.mimeType },
          { type: "text" as const, text: dimensionText },
        ],
      };
    } else if (displayId !== undefined) {
      const monitors = enumMonitors();
      const mon = monitors.find((m) => m.id === displayId);
      if (!mon) {
        return {
          content: [{
            type: "text" as const,
            text: `Display ${displayId} not found. Available: ${monitors.map((m) => m.id).join(", ")}`,
          }],
        };
      }
      const result = await captureDisplay(mon.bounds, captureOpts);
      const dimensionText = dotByDot
        ? `Screenshot (dot-by-dot): ${result.width}x${result.height}px | origin: (${mon.bounds.x}, ${mon.bounds.y})`
        : `Screenshot captured: ${result.width}x${result.height}px`;
      return {
        content: [
          { type: "image" as const, data: result.base64, mimeType: result.mimeType },
          { type: "text" as const, text: dimensionText },
        ],
      };
    } else {
      const result = await captureScreen(region, captureOpts);
      const originText = dotByDot && region
        ? ` | origin: (${region.x}, ${region.y})`
        : "";
      const dimensionText = dotByDot
        ? `Screenshot (dot-by-dot): ${result.width}x${result.height}px${originText}`
        : `Screenshot captured: ${result.width}x${result.height}px`;
      return {
        content: [
          { type: "image" as const, data: result.base64, mimeType: result.mimeType },
          { type: "text" as const, text: dimensionText },
        ],
      };
    }
  } catch (err) {
    return { content: [{ type: "text" as const, text: `Screenshot failed: ${String(err)}` }] };
  }
};

export const screenshotBgHandler = async ({
  windowTitle,
  maxDimension,
  dotByDot,
  webpQuality,
  fullContent,
}: {
  windowTitle: string;
  maxDimension: number;
  dotByDot: boolean;
  webpQuality: number;
  fullContent: boolean;
}): Promise<ToolResult> => {
  try {
    const windows = await getWindows();
    let hwnd: unknown = null;
    let foundTitle = "";

    for (const win of windows) {
      const h = (win as unknown as { windowHandle: unknown }).windowHandle;
      const title = h ? getWindowTitleW(h) : await win.title;
      if (title.toLowerCase().includes(windowTitle.toLowerCase())) {
        hwnd = h;
        foundTitle = title;
        break;
      }
    }

    if (!hwnd) {
      return { content: [{ type: "text" as const, text: `Window not found: "${windowTitle}"` }] };
    }

    const captureOpts = dotByDot
      ? { format: "webp" as const, webpQuality }
      : { maxDimension };
    // PW_RENDERFULLCONTENT=2 for GPU windows; legacy flag=0 when fullContent=false
    const pwFlags = fullContent ? 2 : 0;

    const result = await captureWindowBackground(hwnd, captureOpts, pwFlags);
    const dimensionText = dotByDot
      ? `Background capture (dot-by-dot) of "${foundTitle}": ${result.width}x${result.height}px`
      : `Background capture of "${foundTitle}": ${result.width}x${result.height}px`;

    return {
      content: [
        { type: "image" as const, data: result.base64, mimeType: result.mimeType },
        { type: "text" as const, text: dimensionText },
      ],
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `Background screenshot failed: ${String(err)}` }] };
  }
};

export const getScreenInfoHandler = async (): Promise<ToolResult> => {
  try {
    const monitors = enumMonitors();
    const virtualScreen = getVirtualScreen();
    const info = {
      virtualScreen,
      displays: monitors.map((m) => ({
        id: m.id,
        primary: m.primary,
        bounds: m.bounds,
        workArea: m.workArea,
        dpi: m.dpi,
        scale: `${m.scale}%`,
      })),
      displayCount: monitors.length,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `get_screen_info failed: ${String(err)}` }] };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerScreenshotTools(server: McpServer): void {
  server.tool(
    "screenshot",
    [
      "Take a screenshot of the desktop, a specific window, display, or region.",
      "",
      "MODES (set detail or dotByDot):",
      "  detail='meta'  — window titles + positions only. Cheapest (~20 tok/window). [DEFAULT]",
      "  detail='text'  — UIA element tree as JSON with screen coords. No image. ~100-300 tokens.",
      "  detail='image' — PNG/WebP pixels. BLOCKED unless confirmImage=true is also passed.",
      "  dotByDot=true  — 1:1 pixel WebP. Image pixel = screen coord (+ origin offset for windows).",
      "  diffMode=true  — Layer diff: only changed windows sent. First call = full, subsequent = diff.",
      "",
      "COORDINATE TIPS:",
      "  Default (scaled): screen_x = window.x + image_x * (window.width / image.width)",
      "  dotByDot/diffMode: screen_x = origin_x + image_x (no scale math needed)",
      "",
      "To minimize data, prefer in order: windowTitle > region > displayId > (no args).",
      "maxDimension defaults to 768. Increase to 1280 for fine text (ignored when dotByDot=true).",
    ].join("\n"),
    screenshotSchema,
    screenshotHandler
  );

  server.tool(
    "screenshot_background",
    [
      "Capture a window even if it is hidden behind other windows, minimized, or off-screen.",
      "Uses Win32 PrintWindow API with PW_RENDERFULLCONTENT (fullContent=true by default),",
      "which captures GPU-rendered content in Chrome, Electron, and WinUI3 apps.",
      "Set fullContent=false for legacy mode (faster, but GPU windows may appear black).",
      "Note: some game/DX12 windows may cause a 1-3s delay with fullContent=true — use fullContent=false in that case.",
      "Add dotByDot=true for 1:1 pixel WebP output.",
    ].join(" "),
    screenshotBgSchema,
    screenshotBgHandler
  );

  server.tool(
    "get_screen_info",
    "Get information about all connected displays: resolution, position, DPI scaling, and current cursor position.",
    getScreenInfoSchema,
    getScreenInfoHandler
  );
}
