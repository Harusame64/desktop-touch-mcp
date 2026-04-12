import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureScreen, captureDisplay, captureWindowBackground } from "../engine/image.js";
import { captureAndDiff, captureAllLayers, hasBuffer, clearLayers } from "../engine/layer-buffer.js";
import type { WindowInfo } from "../engine/layer-buffer.js";
import { getWindows } from "../engine/nutjs.js";
import { enumMonitors, getVirtualScreen, getWindowTitleW, enumWindowsInZOrder } from "../engine/win32.js";
import { getUiElements, extractActionableElements, WINUI3_CLASS_RE } from "../engine/uia-bridge.js";
import type { UiElementsResult } from "../engine/uia-bridge.js";
import { recognizeWindow, ocrWordsToActionable, runOcr, mergeNearbyWords } from "../engine/ocr-bridge.js";
import { updateWindowCache } from "../engine/window-cache.js";
import { CHROMIUM_TITLE_RE } from "./workspace.js";
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
      x: z.coerce.number().describe("Left edge. Without windowTitle: virtual screen coordinates. With windowTitle: window-local coordinates (0 = window left edge)."),
      y: z.coerce.number().describe("Top edge. Without windowTitle: virtual screen coordinates. With windowTitle: window-local coordinates (0 = window top edge)."),
      width: z.coerce.number().positive(),
      height: z.coerce.number().positive(),
    })
    .optional()
    .describe(
      "Capture only this sub-region. " +
      "Without windowTitle: virtual screen coordinates. " +
      "With windowTitle: window-local coordinates — useful to exclude browser chrome (tabs/address bar). " +
      "Example: windowTitle='Chrome', region={x:0, y:120, width:1920, height:900} skips the 120px browser chrome."
    ),
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
      "1:1 pixel mode — no scaling, WebP compression. " +
      "Window captures include 'origin: (x,y)' so you can compute screen position: screen_x = origin_x + image_x. " +
      "When dotByDotMaxDimension is also set, scale factor is included: screen_x = origin_x + image_x / scale."
    ),
  dotByDotMaxDimension: z
    .coerce.number()
    .int()
    .positive()
    .optional()
    .describe(
      "Cap the longest edge (pixels) when dotByDot=true. Reduces payload while preserving coordinate math. " +
      "Example: 1280 on a 1920×1080 screen → scale≈0.667. " +
      "Response includes scale factor: screen_x = origin_x + image_x / scale. " +
      "Recommended for Chrome: dotByDot=true, dotByDotMaxDimension=1280, grayscale=true."
    ),
  grayscale: z
    .boolean()
    .default(false)
    .describe(
      "Convert to grayscale before encoding. Reduces file size ~50% for text-heavy content (e.g. AWS console, code editors). " +
      "Avoid when color is meaningful (charts, status indicators)."
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
  ocrFallback: z
    .enum(["auto", "always", "never"])
    .default("auto")
    .describe(
      "OCR fallback behaviour when detail='text'. " +
      "'auto' (default): fire Windows OCR if UIA returns 0 actionable elements OR hints.uiaSparse=true (UIA returned <5 elements, typical for Chrome). " +
      "'always': always augment actionable[] with OCR words. " +
      "'never': disable OCR entirely."
    ),
  ocrLanguage: z
    .string()
    .default("ja")
    .describe("BCP-47 language tag for the OCR engine (e.g. 'ja', 'en-US'). Only used when detail='text'."),
};

export const screenshotOcrSchema = {
  windowTitle: z.string().describe("Title (partial match) of the window to OCR"),
  language: z.string().default("ja").describe("BCP-47 language tag (e.g. 'ja', 'en-US')"),
  region: z
    .object({
      x: z.coerce.number(),
      y: z.coerce.number(),
      width: z.coerce.number().positive(),
      height: z.coerce.number().positive(),
    })
    .optional()
    .describe("Optional sub-region in window-local coordinates"),
};

export const screenshotBgSchema = {
  windowTitle: z
    .string()
    .describe("Title (partial match) of the window to capture"),
  region: z
    .object({
      x: z.coerce.number().describe("Left edge in window-local coordinates (0 = window left)"),
      y: z.coerce.number().describe("Top edge in window-local coordinates (0 = window top)"),
      width: z.coerce.number().positive(),
      height: z.coerce.number().positive(),
    })
    .optional()
    .describe(
      "Capture only this sub-region of the window (window-local image coordinates). " +
      "Coordinates are in image pixels, not screen pixels (may differ on high-DPI). " +
      "Useful to exclude browser chrome (tabs/address bar): e.g. {x:0, y:120, width:1920, height:900}."
    ),
  maxDimension: z
    .coerce.number()
    .int()
    .positive()
    .default(768)
    .describe("Max width or height in pixels (default 768). Use 1280 to read small text or fine UI details."),
  dotByDot: z
    .boolean()
    .default(false)
    .describe(
      "1:1 pixel mode — no scaling, WebP compression. " +
      "When region is also specified, origin reflects the window + region offset for coordinate math."
    ),
  dotByDotMaxDimension: z
    .coerce.number()
    .int()
    .positive()
    .optional()
    .describe(
      "Cap the longest edge (pixels) when dotByDot=true. " +
      "Response includes scale factor: screen_x = origin_x + image_x / scale."
    ),
  grayscale: z
    .boolean()
    .default(false)
    .describe("Convert to grayscale. Reduces file size ~50% for text-heavy content."),
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
 * Build action-oriented UIA data for a window.
 * Returns the structured result and the raw UIA output (needed for hints).
 */
async function buildUiaData(title: string): Promise<{
  result: ReturnType<typeof extractActionableElements>;
  raw: UiElementsResult | null;
}> {
  try {
    const raw = await getUiElements(title, 6, 120, 8000);
    return { result: extractActionableElements(raw), raw };
  } catch {
    return {
      result: { window: title, actionable: [], texts: [] },
      raw: null,
    };
  }
}

/** @deprecated Use buildUiaData for full detail=text handling */
async function buildUiaText(title: string): Promise<string> {
  const { result } = await buildUiaData(title);
  return JSON.stringify(result, null, 2);
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

/** Format origin text for dotByDot captures including optional scale factor. */
function formatOriginText(
  originX: number,
  originY: number,
  imgWidth: number,
  imgHeight: number,
  scale: number | undefined
): string {
  if (scale !== undefined) {
    const s = scale.toFixed(4);
    return (
      `Screenshot (dot-by-dot, scaled): ${imgWidth}x${imgHeight}px | ` +
      `origin: (${originX}, ${originY}) | scale: ${s}\n` +
      `  To click image pixel (ix, iy): mouse_click(x=ix, y=iy, origin={x:${originX}, y:${originY}}, scale=${s}) — server converts.\n` +
      `  Manual math: screen_x = ${originX} + image_x / ${s}, screen_y = ${originY} + image_y / ${s}`
    );
  }
  return (
    `Screenshot (dot-by-dot): ${imgWidth}x${imgHeight}px | origin: (${originX}, ${originY})\n` +
    `  To click image pixel (ix, iy): mouse_click(x=ix, y=iy, origin={x:${originX}, y:${originY}}) — server converts.\n` +
    `  Manual math: screen_x = ${originX} + image_x, screen_y = ${originY} + image_y`
  );
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
  dotByDotMaxDimension,
  grayscale,
  webpQuality,
  diffMode,
  detail,
  confirmImage,
  ocrFallback,
  ocrLanguage,
}: {
  windowTitle?: string;
  displayId?: number;
  region?: { x: number; y: number; width: number; height: number };
  maxDimension: number;
  dotByDot: boolean;
  dotByDotMaxDimension?: number;
  grayscale: boolean;
  webpQuality: number;
  diffMode: boolean;
  detail: "meta" | "text" | "image" | undefined;
  confirmImage: boolean;
  ocrFallback: "auto" | "always" | "never";
  ocrLanguage: string;
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
        const isChromium = CHROMIUM_TITLE_RE.test(windowTitle);

        let result: ReturnType<typeof extractActionableElements>;
        let raw: UiElementsResult | null;

        if (isChromium) {
          // Skip UIA entirely for Chromium — it's slow and returns almost nothing useful.
          // Go directly to OCR fallback below.
          result = { window: windowTitle, actionable: [], texts: [] };
          raw = null;
        } else {
          ({ result, raw } = await buildUiaData(windowTitle));
        }

        // Compute hints from raw UIA output
        const winui3 = WINUI3_CLASS_RE.test(raw?.windowClassName ?? "");
        const uiaSparse = raw !== null && raw.elementCount < 5;
        const hints: {
          winui3: boolean;
          uiaSparse: boolean;
          uiaError?: boolean;
          chromiumGuard?: boolean;
          ocrFallbackFired?: boolean;
        } = {
          winui3,
          uiaSparse,
          ...(raw === null ? { uiaError: true } : {}),
          ...(isChromium ? { chromiumGuard: true } : {}),
        };

        // OCR fallback — fires when:
        //   - always requested, OR
        //   - auto + UIA has no actionable elements, OR
        //   - auto + UIA is sparse (< 5 elements, typical for Chrome)
        const shouldOcr =
          ocrFallback === "always" ||
          (ocrFallback === "auto" && (result.actionable.length === 0 || uiaSparse || isChromium));
        if (shouldOcr) {
          try {
            const { words, origin } = await recognizeWindow(windowTitle, ocrLanguage);
            const ocrItems = ocrWordsToActionable(words, origin);
            result.actionable.push(...ocrItems);
            // Re-sort after merge to maintain top→bottom, left→right ordering
            result.actionable.sort((a, b) =>
              a.region.y !== b.region.y ? a.region.y - b.region.y : a.region.x - b.region.x
            );
            hints.ocrFallbackFired = true;
          } catch {
            // OCR unavailable (language pack missing, WinRT error) — silently skip
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ...result, hints }, null, 2) }],
        };
      }
      // All visible windows — OCR skipped to avoid N-window explosion
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
      ? { format: "webp" as const, webpQuality, grayscale, dotByDotMaxDimension }
      : { maxDimension, grayscale };

    if (windowTitle) {
      const windows = await getWindows();
      let windowRegion: { x: number; y: number; width: number; height: number } | undefined;
      let originX = 0, originY = 0;

      for (const win of windows) {
        const hwnd = (win as unknown as { windowHandle: unknown }).windowHandle;
        const title = hwnd ? getWindowTitleW(hwnd) : await win.title;
        if (title.toLowerCase().includes(windowTitle.toLowerCase())) {
          const reg = await win.region;
          windowRegion = { x: reg.left, y: reg.top, width: reg.width, height: reg.height };
          originX = reg.left;
          originY = reg.top;
          break;
        }
      }

      if (!windowRegion) {
        return { content: [{ type: "text" as const, text: `Window not found: "${windowTitle}"` }] };
      }

      // Sub-crop: treat region as window-local screen coordinates.
      // Clamp to window bounds and compute absolute capture region.
      let captureRegion: { x: number; y: number; width: number; height: number };
      if (region) {
        const clampedX = Math.max(0, Math.min(region.x, windowRegion.width - 1));
        const clampedY = Math.max(0, Math.min(region.y, windowRegion.height - 1));
        const clampedW = Math.min(region.width, windowRegion.width - clampedX);
        const clampedH = Math.min(region.height, windowRegion.height - clampedY);
        captureRegion = {
          x: windowRegion.x + clampedX,
          y: windowRegion.y + clampedY,
          width: clampedW,
          height: clampedH,
        };
        originX = captureRegion.x;
        originY = captureRegion.y;
        if (clampedW !== region.width || clampedH !== region.height) {
          // Region was clamped — note this in the response below
        }
      } else {
        captureRegion = windowRegion;
      }

      const result = await captureScreen(captureRegion, captureOpts);

      let dimensionText: string;
      if (dotByDot) {
        dimensionText = formatOriginText(originX, originY, result.width, result.height, result.scale);
      } else {
        const scaleNote = (region && (region.width !== captureRegion.width || region.height !== captureRegion.height))
          ? ` [region clamped to window bounds]`
          : "";
        dimensionText = `Screenshot captured: ${result.width}x${result.height}px${scaleNote}`;
      }

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
        ? formatOriginText(mon.bounds.x, mon.bounds.y, result.width, result.height, result.scale)
        : `Screenshot captured: ${result.width}x${result.height}px`;
      return {
        content: [
          { type: "image" as const, data: result.base64, mimeType: result.mimeType },
          { type: "text" as const, text: dimensionText },
        ],
      };
    } else {
      const result = await captureScreen(region, captureOpts);
      let dimensionText: string;
      if (dotByDot && region) {
        dimensionText = formatOriginText(region.x, region.y, result.width, result.height, result.scale);
      } else if (dotByDot) {
        dimensionText = `Screenshot (dot-by-dot): ${result.width}x${result.height}px`;
        if (result.scale !== undefined) {
          dimensionText += ` | scale: ${result.scale.toFixed(4)} (full screen, no origin offset)`;
        }
      } else {
        dimensionText = `Screenshot captured: ${result.width}x${result.height}px`;
      }
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
  region,
  maxDimension,
  dotByDot,
  dotByDotMaxDimension,
  grayscale,
  webpQuality,
  fullContent,
}: {
  windowTitle: string;
  region?: { x: number; y: number; width: number; height: number };
  maxDimension: number;
  dotByDot: boolean;
  dotByDotMaxDimension?: number;
  grayscale: boolean;
  webpQuality: number;
  fullContent: boolean;
}): Promise<ToolResult> => {
  try {
    const windows = await getWindows();
    let hwnd: unknown = null;
    let foundTitle = "";
    let windowScreenRegion: { x: number; y: number; width: number; height: number } | null = null;

    for (const win of windows) {
      const h = (win as unknown as { windowHandle: unknown }).windowHandle;
      const title = h ? getWindowTitleW(h) : await win.title;
      if (title.toLowerCase().includes(windowTitle.toLowerCase())) {
        hwnd = h;
        foundTitle = title;
        const reg = await win.region;
        windowScreenRegion = { x: reg.left, y: reg.top, width: reg.width, height: reg.height };
        break;
      }
    }

    if (!hwnd) {
      return { content: [{ type: "text" as const, text: `Window not found: "${windowTitle}"` }] };
    }

    // Build capture options with optional sub-crop (image-local coordinates).
    // For screenshot_background, region is in image pixel space (PrintWindow output).
    let crop: { x: number; y: number; width: number; height: number } | undefined;
    if (region) {
      crop = {
        x: Math.max(0, region.x),
        y: Math.max(0, region.y),
        width: region.width,
        height: region.height,
      };
    }

    const captureOpts = dotByDot
      ? { format: "webp" as const, webpQuality, grayscale, dotByDotMaxDimension, crop }
      : { maxDimension, grayscale, crop };

    // PW_RENDERFULLCONTENT=2 for GPU windows; legacy flag=0 when fullContent=false
    const pwFlags = fullContent ? 2 : 0;

    const result = await captureWindowBackground(hwnd, captureOpts, pwFlags);

    let dimensionText: string;
    if (dotByDot && windowScreenRegion) {
      // Compute screen-space origin: window position + region offset (approximate, ignores DPI scale)
      const regionOffsetX = region ? region.x : 0;
      const regionOffsetY = region ? region.y : 0;
      const originX = windowScreenRegion.x + regionOffsetX;
      const originY = windowScreenRegion.y + regionOffsetY;
      dimensionText = formatOriginText(originX, originY, result.width, result.height, result.scale);
      if (region) {
        dimensionText += ` [sub-crop applied: (${region.x},${region.y}) ${region.width}x${region.height} image-local]`;
      }
    } else if (dotByDot) {
      dimensionText = `Background capture (dot-by-dot) of "${foundTitle}": ${result.width}x${result.height}px`;
      if (result.scale !== undefined) {
        dimensionText += ` | scale: ${result.scale.toFixed(4)} | screen_x = window.x + image_x / ${result.scale.toFixed(4)}`;
      }
    } else {
      dimensionText = `Background capture of "${foundTitle}": ${result.width}x${result.height}px`;
    }

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

export const screenshotOcrHandler = async ({
  windowTitle,
  language,
  region: subRegion,
}: {
  windowTitle: string;
  language: string;
  region?: { x: number; y: number; width: number; height: number };
}): Promise<ToolResult> => {
  try {
    const wins = enumWindowsInZOrder();
    const win = wins.find((w) => w.title.toLowerCase().includes(windowTitle.toLowerCase()));
    if (!win) {
      return { content: [{ type: "text" as const, text: `Window not found: "${windowTitle}"` }] };
    }

    const origin = { x: win.region.x, y: win.region.y };
    const maxDim = 1280;

    // Use PrintWindow (PW_RENDERFULLCONTENT) so the window is captured correctly
    // even when covered by other windows (e.g. Claude Code on top of Paint).
    // For sub-region: still use PrintWindow for the full window, then crop in
    // scale math by adjusting the origin and using only the sub-region slice.
    const captured = await captureWindowBackground(win.hwnd, maxDim);
    const scaleX = win.region.width / captured.width;
    const scaleY = win.region.height / captured.height;

    // If a sub-region was requested, restrict which words survive later
    const subRegionFilter = subRegion
      ? {
          x: win.region.x + subRegion.x,
          y: win.region.y + subRegion.y,
          right: win.region.x + subRegion.x + subRegion.width,
          bottom: win.region.y + subRegion.y + subRegion.height,
        }
      : null;

    const rawWords = await runOcr(captured.base64, language);

    // Scale image-local bboxes → screen coords, then merge adjacent characters
    const scaledWords = rawWords.map((w) => ({
      text: w.text,
      bbox: {
        x: Math.round(origin.x + w.bbox.x * scaleX),
        y: Math.round(origin.y + w.bbox.y * scaleY),
        width: Math.max(1, Math.round(w.bbox.width * scaleX)),
        height: Math.max(1, Math.round(w.bbox.height * scaleY)),
      },
    }));
    const merged = mergeNearbyWords(scaledWords);

    // Apply sub-region filter if requested
    const filtered = subRegionFilter
      ? merged.filter((w) => {
          const cx = w.bbox.x + w.bbox.width / 2;
          const cy = w.bbox.y + w.bbox.height / 2;
          return cx >= subRegionFilter.x && cx <= subRegionFilter.right
              && cy >= subRegionFilter.y && cy <= subRegionFilter.bottom;
        })
      : merged;

    const words = filtered.map((w) => ({
      text: w.text,
      clickAt: {
        x: Math.round(w.bbox.x + w.bbox.width / 2),
        y: Math.round(w.bbox.y + w.bbox.height / 2),
      },
    }));

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(
          { windowTitle: win.title, origin, words, wordCount: words.length },
          null,
          2
        ),
      }],
    };
  } catch (err) {
    return { content: [{ type: "text" as const, text: `screenshot_ocr failed: ${String(err)}` }] };
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
      "DATA REDUCTION (Chrome/AWS console):",
      "  grayscale=true              — ~50% smaller. Use for text-heavy UIs, avoid for charts/colors.",
      "  dotByDotMaxDimension=1280   — cap longest edge; response includes scale for coord math.",
      "  windowTitle + region        — sub-crop to exclude browser chrome (tabs/address bar).",
      "  Recommended Chrome combo: dotByDot=true, dotByDotMaxDimension=1280, grayscale=true,",
      "    windowTitle='Chrome', region={x:0, y:120, width:1920, height:900}",
      "",
      "COORDINATE TIPS:",
      "  Default (scaled): screen_x = window.x + image_x * (window.width / image.width)",
      "  dotByDot (1:1):   screen_x = origin_x + image_x",
      "  dotByDot + scale: screen_x = origin_x + image_x / scale  (scale printed in response)",
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
      "Add grayscale=true to reduce size ~50% for text-heavy content.",
      "Add dotByDotMaxDimension=1280 to cap resolution; response includes scale for coord math.",
      "Add region to sub-crop (window-local image coordinates) — useful to exclude browser chrome.",
    ].join(" "),
    screenshotBgSchema,
    screenshotBgHandler
  );

  server.tool(
    "screenshot_ocr",
    [
      "Run Windows OCR (Windows.Media.Ocr) on a window and return word-level text with screen coordinates.",
      "Use when UIA returns no actionable elements (e.g. WinUI3 apps like Paint, custom-drawn UIs).",
      "Returns words[] with clickAt coords — pass directly to mouse_click.",
      "language: BCP-47 tag (default 'ja'). First call may be ~1s due to WinRT cold-start.",
      "Requires the matching Windows OCR language pack to be installed.",
    ].join("\n"),
    screenshotOcrSchema,
    screenshotOcrHandler
  );

  server.tool(
    "get_screen_info",
    "Get information about all connected displays: resolution, position, DPI scaling, and current cursor position.",
    getScreenInfoSchema,
    getScreenInfoHandler
  );
}
