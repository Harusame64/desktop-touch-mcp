import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureScreen, captureDisplay, captureWindowBackground, captureWindowWithFallback } from "../engine/image.js";
import type { CaptureSource, CaptureFallbackReason } from "../engine/image.js";
import { captureAndDiff, captureAllLayers, hasBuffer } from "../engine/layer-buffer.js";
import type { WindowInfo } from "../engine/layer-buffer.js";
import { getWindows } from "../engine/nutjs.js";
import { enumMonitors, getVirtualScreen, getWindowTitleW, enumWindowsInZOrder } from "../engine/win32.js";
import { getUiElements, extractActionableElements, WINUI3_CLASS_RE, detectUiaBlind } from "../engine/uia-bridge.js";
import type { UiElementsResult } from "../engine/uia-bridge.js";
import { recognizeWindow, ocrWordsToActionable, runOcr, mergeNearbyWords, runSomPipeline, snapToDictionary, detectOcrLanguage } from "../engine/ocr-bridge.js";
import type { OcrDictionaryEntry } from "../engine/ocr-bridge.js";
import { updateWindowCache, saveSnapshot } from "../engine/window-cache.js";
import { CHROMIUM_TITLE_RE } from "./workspace.js";
import { computeViewportPosition } from "../utils/viewport-position.js";
import { ok, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { buildImageResponse } from "./screenshot-response.js";
import { failWith, failArgs } from "./_errors.js";
import { coercedBoolean } from "./_coerce.js";
import {
  makeQueryWrapper,
  withEnvelopeIncludeSchema,
  genericQueryCausedByProjector,
  defaultQuerySessionId,
} from "./_envelope.js";
import {
  observeTarget,
  buildCacheStateHints,
  toTargetHints,
  takeLastInvalidation,
} from "../engine/identity-tracker.js";
import { getTextViaTextPattern } from "../engine/uia-bridge.js";
import { stripAnsi, tailLines } from "../engine/ansi.js";
import { getProcessIdentityByPid, getWindowProcessId } from "../engine/win32.js";
import { resolveWindowTarget } from "./_resolve-window.js";

const TERMINAL_PROCESS_RE = /^(WindowsTerminal|conhost|pwsh|powershell|cmd|bash|wsl|alacritty|wezterm|mintty)(\.exe)?$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Schemas (plain objects — used by server.tool() and the macro registry)
// ─────────────────────────────────────────────────────────────────────────────

export const screenshotSchema = {
  windowTitle: z
    .string()
    .optional()
    .describe("Capture only the window whose title contains this string. Use '@active' for the current foreground window. Prefer over full-screen when target window is known."),
  hwnd: z
    .string()
    .optional()
    .describe("Direct window handle ID (takes precedence over windowTitle). Obtain from desktop_discover (windows[].hwnd). String type to avoid 64-bit precision issues."),
  displayId: z
    .coerce.number()
    .int()
    .min(0)
    .optional()
    .describe("Capture a specific monitor (0 = primary). Use desktop_state({includeScreen:true}) to list displays."),
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
  dotByDot: coercedBoolean()
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
  grayscale: coercedBoolean()
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
  diffMode: coercedBoolean()
    .default(false)
    .describe(
      "Layer diff mode — compares each window against the buffered previous frame. " +
      "First call = full I-frame (all windows). Subsequent calls = only changed windows (P-frame). " +
      "Implicitly enables dotByDot. Best used with windowTitle=undefined to snapshot all windows."
    ),
  detail: z
    .enum(["meta", "text", "image", "som", "ocr"])
    .optional()
    .describe(
      "Response detail level (omit to let the server pick a smart default):\n" +
      "  omitted — auto: 'image' when dotByDot/region/displayId is specified, else 'meta'\n" +
      "  'meta'  — window title + screen region only (~20 tok/window, cheapest)\n" +
      "  'text'  — UIA element tree as JSON with text values (~100-300 tok/window, no image)\n" +
      "  'image' — actual screenshot pixels. Returns a cheap by-ref resource_link by default (no inline base64); pass confirmImage=true to ALSO embed the inline image.\n" +
      "  'som'   — Set-of-Marks image + OCR elements (bypasses UIA entirely). BLOCKED unless confirmImage=true is also passed.\n" +
      "  'ocr'   — Windows OCR words with screen-pixel clickAt coords (Phase 4: absorbs former screenshot_ocr). " +
      "Use when UIA returns no actionable elements (WinUI3 custom-drawn UIs, game overlays, PDF viewers). " +
      "Note: detail='text' auto-falls back to OCR via ocrFallback='auto'; choose detail='ocr' only when forcing OCR unconditionally."
    ),
  mode: z
    .enum(["normal", "background"])
    .default("normal")
    .optional()
    .describe(
      "Capture mode.\n" +
      "  'normal'     — default. Window-targeted captures (windowTitle / hwnd) use Win32 PrintWindow with automatic BitBlt fallback when PrintWindow returns no data or an all-black frame; the route used is reported in hints.captureSource. Fullscreen / displayId captures use BitBlt.\n" +
      "  'background' — explicit Win32 PrintWindow capture, retained for back-compat and explicit selection. Requires windowTitle (or hwnd). Pair with fullContent for GPU-rendered apps."
    ),
  fullContent: coercedBoolean()
    .default(true)
    .optional()
    .describe(
      "When mode='background', use PW_RENDERFULLCONTENT to capture GPU-rendered windows (Chrome, Electron, WinUI3). Default true. " +
      "Set false for legacy mode (faster but GPU windows may appear black). Ignored unless mode='background'."
    ),
  confirmImage: coercedBoolean()
    .default(false)
    .describe(
      "Embed inline image pixels in the response. " +
      "detail='image' now returns a cheap by-ref resource_link WITHOUT this flag (it is no longer blocked); " +
      "confirmImage=true ADDITIONALLY embeds the inline image for immediate vision. " +
      "detail='som' still requires confirmImage=true to return its annotated bitmap. " +
      "Prefer detail='text' / diffMode=true / dotByDot=true first — " +
      "set confirmImage=true only when inline visual inspection is genuinely required."
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
    .optional()
    .describe("BCP-47 language tag for the OCR engine (e.g. 'ja', 'en-US'). Auto-detects from system locale when omitted. Used when detail='text' (OCR fallback) or detail='ocr' (direct OCR)."),
  preprocessPolicy: z
    .enum(["auto", "aggressive", "minimal"])
    .default("auto")
    .describe(
      "OCR preprocessing scale policy for detail='som' and OCR fallback paths. " +
      "'auto' (default): clamp scale to 1 on OOM (>8MP) or high-DPI (≥150%). " +
      "'aggressive': relaxes DPI clamp to 175%, preserving upscale on 150%-DPI monitors (e.g. Outlook PWA). Also auto-enables adaptive binarization. " +
      "'minimal': always scale=1 regardless of DPI/resolution."
    ),
  preprocessAdaptive: coercedBoolean()
    .default(false)
    .describe(
      "When true, apply Sauvola adaptive binarization after contrast stretch. " +
      "Improves recognition of thin text on low-contrast or gradient backgrounds. " +
      "Automatically enabled when preprocessPolicy='aggressive'. " +
      "Requires Rust native engine; silently skipped otherwise."
    ),
};

export const screenshotOcrSchema = {
  windowTitle: z.string().describe("Title (partial match) of the window to OCR. Use '@active' for the current foreground window."),
  hwnd: z.string().optional().describe("Direct window handle ID (takes precedence over windowTitle). String to avoid 64-bit precision issues."),
  language: z.string().optional().describe("BCP-47 language tag (e.g. 'ja', 'en-US'). Auto-detects from system locale when omitted."),
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
    .describe("Title (partial match) of the window to capture. Use '@active' for the current foreground window."),
  hwnd: z
    .string()
    .optional()
    .describe("Direct window handle ID (takes precedence over windowTitle). String to avoid 64-bit precision issues."),
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
  dotByDot: coercedBoolean()
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
  grayscale: coercedBoolean()
    .default(false)
    .describe("Convert to grayscale. Reduces file size ~50% for text-heavy content."),
  webpQuality: z
    .coerce.number()
    .int()
    .min(1)
    .max(100)
    .default(60)
    .describe("WebP quality when dotByDot=true."),
  fullContent: coercedBoolean()
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
async function buildUiaData(title: string, hwnd?: bigint, cached?: boolean): Promise<{
  result: ReturnType<typeof extractActionableElements>;
  raw: UiElementsResult | null;
  cacheHit: boolean;
}> {
  try {
    const raw = await getUiElements(title, 6, 120, 8000, { hwnd, cached });
    const cacheHit = !!(raw as { _cacheHit?: boolean })._cacheHit;
    return { result: extractActionableElements(raw), raw, cacheHit };
  } catch {
    return {
      result: { window: title, actionable: [], texts: [] },
      raw: null,
      cacheHit: false,
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

export const screenshotHandler = async (args: {
  windowTitle?: string;
  hwnd?: string;
  displayId?: number;
  region?: { x: number; y: number; width: number; height: number };
  maxDimension: number;
  dotByDot: boolean;
  dotByDotMaxDimension?: number;
  grayscale: boolean;
  webpQuality: number;
  diffMode: boolean;
  detail: "meta" | "text" | "image" | "som" | "ocr" | undefined;
  mode?: "normal" | "background";
  fullContent?: boolean;
  confirmImage: boolean;
  ocrFallback: "auto" | "always" | "never";
  ocrLanguage?: string;
  preprocessPolicy: "auto" | "aggressive" | "minimal";
  preprocessAdaptive: boolean;
}): Promise<ToolResult> => {
  // Phase 4: Dispatch detail='ocr' / mode='background' to the absorbed
  // internal handlers (former screenshot_ocr / screenshot_background).
  //
  // detail and mode are NOT freely composable today:
  //   - detail='ocr' returns OCR words and ignores mode (uses foreground capture
  //     internally; not adapted to PrintWindow).
  //   - mode='background' returns image pixels via PrintWindow and does NOT run
  //     the UIA / SoM / OCR pipelines — so detail in {'text','som','ocr'} cannot
  //     coexist with it.
  // Reject incompatible combinations early instead of silently dropping one
  // dimension. Compatible: mode='background' + detail in {undefined,'image','meta'}.
  // (Codex PR #41 P2.)
  if (args.mode === "background" && args.detail && args.detail !== "image" && args.detail !== "meta") {
    return failArgs(
      `screenshot(mode='background') only supports detail in {'image','meta'}; got detail='${args.detail}'. Use detail='ocr'/'text'/'som' with the default foreground mode, or drop mode='background' to combine.`,
      "screenshot",
    );
  }
  if (args.detail === "ocr") {
    if (!args.windowTitle && !args.hwnd) {
      return failArgs(
        "screenshot(detail='ocr') requires windowTitle or hwnd",
        "screenshot",
      );
    }
    return screenshotOcrHandler({
      windowTitle: args.windowTitle ?? "@active",
      hwnd: args.hwnd,
      language: args.ocrLanguage ?? detectOcrLanguage(),
      region: args.region,
    });
  }
  // mode='background' + detail='meta' is metadata-only — bypass the bg
  // capture and let the default handler emit the meta payload (no image
  // bytes, no PrintWindow). For all other detail values, run the bg image
  // capture; legacy `screenshot_background` returned image bytes without an
  // extra acknowledgement, and the Phase 4 absorption preserves that
  // contract — passing `mode:'background'` is itself the explicit
  // acknowledgement that image pixels are wanted. confirmImage stays the
  // gate ONLY for foreground `detail='image'` (handled inside the default
  // handler below). (Codex PR #41 round 5 P2 — restore migration parity.)
  if (args.mode === "background" && args.detail !== "meta") {
    if (!args.windowTitle && !args.hwnd) {
      return failArgs(
        "screenshot(mode='background') requires windowTitle or hwnd",
        "screenshot",
      );
    }
    return screenshotBgHandler({
      windowTitle: args.windowTitle ?? "@active",
      hwnd: args.hwnd,
      region: args.region,
      maxDimension: args.maxDimension,
      dotByDot: args.dotByDot,
      dotByDotMaxDimension: args.dotByDotMaxDimension,
      grayscale: args.grayscale,
      webpQuality: args.webpQuality,
      fullContent: args.fullContent ?? true,
    });
  }

  const {
    windowTitle,
    hwnd: hwndParam,
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
    ocrLanguage = detectOcrLanguage(),
    preprocessPolicy = "auto",
    preprocessAdaptive = false,
  } = args;
  // Compute effective detail: explicit value wins; otherwise infer from context.
  // dotByDot / region / displayId imply the caller wants pixels, so default to 'image'.
  // detail='ocr' was already short-circuited above, so the narrow type excludes it here.
  const effectiveDetail: "meta" | "text" | "image" | "som" = detail ?? (
    dotByDot || region !== undefined || displayId !== undefined ? "image" : "meta"
  );

  try {
    // Resolve hwnd / @active → effective window title
    const resolvedWin = await resolveWindowTarget({ hwnd: hwndParam, windowTitle });
    const effectiveTitle = resolvedWin?.title ?? windowTitle;
    const screenshotWarnings: string[] = [...(resolvedWin?.warnings ?? [])];

    // ── Guard: block bare detail='som' unless explicitly confirmed ──
    // ADR-026 Phase 1: detail='image' is NO LONGER blocked here — it now flows
    // to the by-ref path below (a cheap resource_link by default, inline pixels
    // only with confirmImage). detail='som' still carries its annotated SoM
    // bitmap inline and is migrated to the ref model in Phase 2, so it keeps the
    // confirmImage gate for now. Only fires when 'som' was explicitly requested,
    // not when image is inferred from dotByDot/region context.
    const guardDisabled = process.env.DESKTOP_TOUCH_DISABLE_IMAGE_GUARD === "1";
    const isExplicitSom = detail === "som";
    if (isExplicitSom && !diffMode && !dotByDot && !confirmImage && !guardDisabled) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: [
            `[screenshot-guard] detail='som' was blocked to prevent accidental heavy image payloads.`,
            "",
            "Prefer these lighter alternatives (in order):",
            "  1. screenshot(detail='text', windowTitle=X)  — UIA actionable[] with clickAt coords",
            "  2. screenshot(detail='image', windowTitle=X)  — by-ref resource_link, no inline base64",
            "  3. screenshot(dotByDot=true, windowTitle=X)  — 1:1 WebP for pixel-perfect coords",
            "",
            "If a Set-of-Marks image truly is required, re-call with confirmImage=true.",
            "To disable this guard globally, set DESKTOP_TOUCH_DISABLE_IMAGE_GUARD=1 in the environment.",
          ].join("\n"),
        }],
      };
    }

    // ── detail=som: Set-of-Marks image + OCR elements ────────────────────────
    if (effectiveDetail === "som") {
      if (!effectiveTitle) {
        return failWith(
          "detail='som' requires windowTitle or hwnd to target a specific window.",
          "screenshot"
        );
      }

      // Pass hwnd when resolveWindowTarget found one; otherwise pass null and
      // let runSomPipeline do its own title-based window search (avoiding a
      // redundant enumWindowsInZOrder call).
      const resolvedTitle = resolvedWin?.title ?? effectiveTitle;
      const targetHwnd = resolvedWin?.hwnd ?? null;

      const somResult = await runSomPipeline(resolvedTitle, targetHwnd, ocrLanguage, 2, preprocessPolicy, preprocessAdaptive);
      const content: ToolResult["content"] = [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              window: somResult.resolvedWindowTitle,
              detail: "som",
              elements: somResult.elements,
              preprocessScale: somResult.preprocessScale,
              ...(screenshotWarnings.length > 0 ? { hints: { warnings: screenshotWarnings } } : {}),
            },
            null,
            2
          ),
        },
      ];

      if (somResult.somImage) {
        content.push({
          type: "image" as const,
          data: somResult.somImage.base64,
          mimeType: somResult.somImage.mimeType,
        });
      }

      return { content };
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

      if (screenshotWarnings.length > 0) {
        content.push({ type: "text" as const, text: JSON.stringify({ hints: { warnings: screenshotWarnings } }) });
      }
      return { content };
    }
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
      const filtered = effectiveTitle
        ? metaList.filter((w) => w.title.toLowerCase().includes(effectiveTitle.toLowerCase()))
        : metaList;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(
            {
              detail: "meta",
              windows: filtered,
              ...(screenshotWarnings.length > 0 ? { hints: { warnings: screenshotWarnings } } : {}),
            },
            null,
            2
          ),
        }],
      };
    }

    // ── detail=text: UIA element tree as JSON ────────────────────────────────
    if (effectiveDetail === "text") {
      if (effectiveTitle) {
        const wins = enumWindowsInZOrder();
        updateWindowCache(wins);

        // Save screenshot-time snapshot for homing — survives external cache
        // mutations from focus_window / window_dock between screenshot and click.
        const snapWin = wins.find((w) => w.title.toLowerCase().includes(effectiveTitle.toLowerCase()));
        if (snapWin) saveSnapshot(effectiveTitle, snapWin.region);

        // Resolve the full window title from the partial match, then test the
        // Chromium regex against the resolved title — not the user-supplied
        // substring (which typically won't contain the "- Google Chrome" suffix).
        const resolvedWin2 = resolvedWin
          ? wins.find((w) => w.title === resolvedWin.title) ?? wins.find((w) => w.title.toLowerCase().includes(effectiveTitle.toLowerCase()))
          : wins.find((w) => w.title.toLowerCase().includes(effectiveTitle.toLowerCase()));
        const resolvedTitle = resolvedWin2?.title ?? effectiveTitle;
        const targetHwnd = resolvedWin2?.hwnd ?? null;
        const isChromium = CHROMIUM_TITLE_RE.test(resolvedTitle);

        // terminalGuard — for terminal hosts, UIA actionable is meaningless; use TextPattern.
        let isTerminal = false;
        if (targetHwnd !== null) {
          try {
            const pid = getWindowProcessId(targetHwnd);
            const procName = getProcessIdentityByPid(pid).processName;
            isTerminal = TERMINAL_PROCESS_RE.test(procName);
          } catch { /* ignore */ }
        }
        if (isTerminal) {
          const obs = observeTarget(effectiveTitle, targetHwnd!, resolvedTitle);
          const identityHints = toTargetHints(obs.identity);
          const invalidation = obs.invalidatedBy
            ? { reason: obs.invalidatedBy, previousTarget: obs.previousTarget }
            : takeLastInvalidation();
          const raw = (await getTextViaTextPattern(resolvedTitle).catch(() => null)) ?? "";
          const cleaned = stripAnsi(raw);
          const text = tailLines(cleaned, 80);
          const cacheStateHints = buildCacheStateHints(targetHwnd, invalidation);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                window: resolvedTitle,
                actionable: [],
                textContent: text,
                hints: {
                  terminalGuard: true,
                  target: identityHints,
                  ...(Object.keys(cacheStateHints).length > 0 ? { caches: cacheStateHints } : {}),
                  ...(screenshotWarnings.length > 0 ? { warnings: screenshotWarnings } : {}),
                },
              }, null, 2),
            }],
          };
        }

        // Identity tracking — fires invalidation if pid/startTime changed.
        let identityHints: ReturnType<typeof toTargetHints> | null = null;
        let invalidation: ReturnType<typeof takeLastInvalidation> = null;
        if (targetHwnd !== null) {
          const obs = observeTarget(effectiveTitle, targetHwnd, resolvedTitle);
          identityHints = toTargetHints(obs.identity);
          if (obs.invalidatedBy) {
            invalidation = { reason: obs.invalidatedBy, previousTarget: obs.previousTarget };
          } else {
            invalidation = takeLastInvalidation();
          }
        }

        let result: ReturnType<typeof extractActionableElements>;
        let raw: UiElementsResult | null;
        let cacheHit = false;

        if (isChromium) {
          // Skip UIA entirely for Chromium — it's slow and returns almost nothing useful.
          // Go directly to OCR fallback below.
          result = { window: effectiveTitle, actionable: [], texts: [] };
          raw = null;
        } else {
          // Try cache first — large UI trees benefit from skipping PowerShell startup
          ({ result, raw, cacheHit } = await buildUiaData(effectiveTitle, targetHwnd ?? undefined, true));
        }

        // Compute hints from raw UIA output
        const winui3 = WINUI3_CLASS_RE.test(raw?.windowClassName ?? "");
        const uiaSparse = raw !== null && raw.elementCount < 5;
        const cacheStateHints = buildCacheStateHints(targetHwnd, invalidation);
        const hints: {
          winui3: boolean;
          uiaSparse: boolean;
          uiaError?: boolean;
          chromiumGuard?: boolean;
          ocrFallbackFired?: boolean;
          uiaCached?: boolean;
          target?: ReturnType<typeof toTargetHints>;
          caches?: ReturnType<typeof buildCacheStateHints>;
          warnings?: string[];
        } = {
          winui3,
          uiaSparse,
          ...(raw === null ? { uiaError: true } : {}),
          ...(isChromium ? { chromiumGuard: true } : {}),
          ...(cacheHit ? { uiaCached: true } : {}),
          ...(identityHints ? { target: identityHints } : {}),
          ...(Object.keys(cacheStateHints).length > 0 ? { caches: cacheStateHints } : {}),
          ...(screenshotWarnings.length > 0 ? { warnings: screenshotWarnings } : {}),
        };

        // OCR fallback — fires when:
        //   - always requested, OR
        //   - auto + UIA has no actionable elements, OR
        //   - auto + UIA is sparse (< 5 elements, typical for Chrome)
        const shouldOcr =
          ocrFallback === "always" ||
          (ocrFallback === "auto" && (result.actionable.length === 0 || uiaSparse || isChromium));

        // UIA dictionary for snap-correction (commit 2-4).
        // Built from enabled elements with screen-absolute boundingRect.
        // Used by both SoM and plain OCR paths to correct glyph-confusion errors.
        const uiaDict: OcrDictionaryEntry[] = (raw?.elements ?? [])
          .filter((e) => e.isEnabled && e.boundingRect !== null && e.name.length >= 2)
          .map((e) => ({ label: e.name, rect: e.boundingRect! }));

        // SoM mode — when UIA-Blind is detected AND OCR would fire, run the full
        // Set-of-Mark pipeline (preprocess → OCR → cluster → draw) instead of the
        // plain word-list fallback. Falls through to normal OCR on any error.
        const uiaBlind = raw !== null ? detectUiaBlind(raw) : { blind: false as const };
        if (shouldOcr && uiaBlind.blind) {
          try {
            const somResult = await runSomPipeline(effectiveTitle, targetHwnd, ocrLanguage, 2, preprocessPolicy, preprocessAdaptive, uiaDict);
            hints.ocrFallbackFired = true;
            (hints as Record<string, unknown>).somMode = true;
            (hints as Record<string, unknown>).uiaBlindReason = uiaBlind.reason;

            const textContent = {
              type: "text" as const,
              text: JSON.stringify(
                {
                  window: somResult.resolvedWindowTitle,
                  hints,
                  // Step 5: structured element list with ID-to-coordinate mapping
                  elements: somResult.elements,
                },
                null,
                2,
              ),
            };

            const contentItems: Array<
              { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
            > = [textContent];

            // Attach the annotated SoM image when Rust rendering succeeded
            if (somResult.somImage) {
              contentItems.push({
                type: "image" as const,
                data: somResult.somImage.base64,
                mimeType: somResult.somImage.mimeType,
              });
            }

            return { content: contentItems };
          } catch (somErr) {
            // SoM pipeline failed (win-ocr not installed, Rust unavailable, etc.)
            // Fall through to the regular OCR word-list path below.
            console.error("[SoM] pipeline failed, falling back to regular OCR:", somErr);
          }
        }

        if (shouldOcr) {
          try {
            const { words, origin } = await recognizeWindow(effectiveTitle, ocrLanguage);
            // Convert words to screen-absolute coords so snapToDictionary locality
            // filter aligns with UIA boundingRect (also screen-absolute).
            const screenAbsWords = words.map((w) => ({
              ...w,
              bbox: { x: origin.x + w.bbox.x, y: origin.y + w.bbox.y,
                      width: w.bbox.width, height: w.bbox.height },
            }));
            const snappedWords = uiaDict.length > 0
              ? snapToDictionary(screenAbsWords, uiaDict)
              : screenAbsWords;
            // Pass origin={x:0,y:0} because words are already screen-absolute.
            const ocrItems = ocrWordsToActionable(snappedWords, { x: 0, y: 0 });
            // Add viewportPosition to OCR items using the window region
            if (result.windowRegion) {
              for (const item of ocrItems) {
                item.viewportPosition = computeViewportPosition(item.region, result.windowRegion);
              }
            }
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

    if (effectiveTitle) {
      // hwnd-first resolution: prefer resolvedWin.hwnd (from resolveWindowTarget,
      // case 1 hwnd / case 2 @active / case 4 dialog-via-owner), else find the
      // window by title via enumWindowsInZOrder so we get a real bigint hwnd
      // (nutjs getWindows returns an opaque `windowHandle` that we cannot
      // reliably pass to PrintWindow). Same-name windows are an inherent
      // ambiguity here — resolvedWin already disambiguates when caller passed
      // an explicit hwnd.
      let targetHwnd: bigint | null = resolvedWin?.hwnd ?? null;
      let windowRegion: { x: number; y: number; width: number; height: number } | undefined;
      if (targetHwnd !== null && resolvedWin) {
        const wins = enumWindowsInZOrder();
        const match = wins.find((w) => w.hwnd === targetHwnd);
        if (match) {
          windowRegion = { x: match.region.x, y: match.region.y, width: match.region.width, height: match.region.height };
        }
      }
      if (!windowRegion) {
        const wins = enumWindowsInZOrder();
        const q = effectiveTitle.toLowerCase();
        const match = wins.find((w) => w.title.toLowerCase().includes(q));
        if (match) {
          targetHwnd = match.hwnd;
          windowRegion = { x: match.region.x, y: match.region.y, width: match.region.width, height: match.region.height };
        }
      }
      if (!windowRegion || targetHwnd === null) {
        return failWith(`Window not found: "${effectiveTitle}"`, "screenshot", { windowTitle: effectiveTitle });
      }

      // Populate caches for homing. This is the primary coordinate-copy path
      // (dotByDot=true / detail='image' single-window capture), so it must seed
      // homing just like detail='text'/'ocr' do:
      //   - updateWindowCache gives applyHoming a live HWND to resolve at click
      //     time (getCachedWindowByTitle), and
      //   - saveSnapshot preserves this screenshot-time window position so the
      //     delta survives focus_window / window_dock mutating the main cache
      //     between this capture and the follow-up mouse_click.
      updateWindowCache(enumWindowsInZOrder());
      saveSnapshot(effectiveTitle, windowRegion);

      let originX = windowRegion.x;
      let originY = windowRegion.y;

      // Sub-crop: treat region as window-local screen coordinates.
      // Clamp to window bounds and compute absolute capture region.
      let captureRegion: { x: number; y: number; width: number; height: number };
      let cropForCapture: { x: number; y: number; width: number; height: number } | undefined;
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
        // For PrintWindow we capture the full window then crop in encode; for
        // BitBlt fallback we capture the absolute screen region. The encode
        // path handles both via opts.crop in window-local coords.
        cropForCapture = { x: clampedX, y: clampedY, width: clampedW, height: clampedH };
      } else {
        captureRegion = windowRegion;
      }

      // PrintWindow primary + BitBlt fallback. Pass the FULL window rect to
      // both branches — sub-region crops are applied uniformly at encode time
      // via opts.crop (window-local coords). Passing the sub-region rect to
      // the helper would break the BitBlt branch: it would grab a sub-region
      // sized buffer and then opts.crop would either crash or pick the wrong
      // pixels. See captureWindowRawWithFallback docstring.
      const result = await captureWindowWithFallback(
        targetHwnd,
        windowRegion,
        cropForCapture ? { ...captureOpts, crop: cropForCapture } : captureOpts,
      );

      // hints: surface capture source + fallback reason for downstream
      // diagnostics. Only emit warnings[] when a fallback actually fired.
      const captureHints: {
        captureSource: CaptureSource;
        captureFallbackReason?: CaptureFallbackReason;
        warnings?: string[];
      } = { captureSource: result.source };
      const localWarnings: string[] = [...screenshotWarnings];
      if (result.fallbackReason !== null) {
        captureHints.captureFallbackReason = result.fallbackReason;
        // Fixed strings only (no variable interpolation — CWE-94 guidance).
        if (result.fallbackReason === "printwindow-failed") {
          localWarnings.push(
            "PrintWindow returned no data; capture fell back to a BitBlt of the on-screen region. The image may show overlapping windows if any sit on top of the target."
          );
        } else if (result.fallbackReason === "printwindow-all-black") {
          localWarnings.push(
            "PrintWindow returned an all-black frame; capture fell back to a BitBlt of the on-screen region. If the target window is legitimately black (terminal, dark editor, video), pass mode='background' to force the PrintWindow result."
          );
        }
      }
      if (localWarnings.length > 0) captureHints.warnings = localWarnings;

      let dimensionText: string;
      if (dotByDot) {
        dimensionText = formatOriginText(originX, originY, result.width, result.height, result.scale);
      } else {
        const scaleNote = (region && (region.width !== captureRegion.width || region.height !== captureRegion.height))
          ? ` [region clamped to window bounds]`
          : "";
        dimensionText = `Screenshot captured: ${result.width}x${result.height}px${scaleNote}`;
      }

      // ADR-026 §2.1/§3: persist + by-ref. Default returns a resource_link only;
      // confirmImage (explicit pixels) and dotByDot (pixel-coordinate use) also
      // embed the inline image. The dimension/coords text is always kept.
      return buildImageResponse({
        base64: result.base64,
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
        wantInline: confirmImage || dotByDot,
        textBlocks: [dimensionText, JSON.stringify({ hints: captureHints })],
        meta: { tag: effectiveTitle },
      });
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
      return buildImageResponse({
        base64: result.base64,
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
        wantInline: confirmImage || dotByDot,
        textBlocks: [dimensionText],
        meta: { tag: `display-${displayId}` },
      });
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
      return buildImageResponse({
        base64: result.base64,
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
        wantInline: confirmImage || dotByDot,
        textBlocks: [dimensionText],
        meta: { tag: "fullscreen" },
      });
    }
  } catch (err) {
    return failWith(err, "screenshot");
  }
};

export const screenshotBgHandler = async ({
  windowTitle,
  hwnd: hwndParam,
  region,
  maxDimension,
  dotByDot,
  dotByDotMaxDimension,
  grayscale,
  webpQuality,
  fullContent,
}: {
  windowTitle: string;
  hwnd?: string;
  region?: { x: number; y: number; width: number; height: number };
  maxDimension: number;
  dotByDot: boolean;
  dotByDotMaxDimension?: number;
  grayscale: boolean;
  webpQuality: number;
  fullContent: boolean;
}): Promise<ToolResult> => {
  try {
    const resolvedWin = await resolveWindowTarget({ hwnd: hwndParam, windowTitle });
    const effectiveTitle = resolvedWin?.title ?? windowTitle;
    const bgWarnings: string[] = [...(resolvedWin?.warnings ?? [])];

    const windows = await getWindows();
    let hwnd: unknown = null;
    let foundTitle = "";
    let windowScreenRegion: { x: number; y: number; width: number; height: number } | null = null;

    for (const win of windows) {
      const h = (win as unknown as { windowHandle: unknown }).windowHandle;
      const title = h ? getWindowTitleW(h) : await win.title;
      if (title.toLowerCase().includes(effectiveTitle.toLowerCase())) {
        hwnd = h;
        foundTitle = title;
        const reg = await win.region;
        windowScreenRegion = { x: reg.left, y: reg.top, width: reg.width, height: reg.height };
        break;
      }
    }

    if (!hwnd) {
      // Phase 4: surfaced to LLM via screenshot(mode='background') dispatcher.
      return failWith(`Window not found: "${effectiveTitle}"`, "screenshot", { windowTitle: effectiveTitle });
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
        ...(bgWarnings.length > 0 ? [{ type: "text" as const, text: JSON.stringify({ hints: { warnings: bgWarnings } }) }] : []),
      ],
    };
  } catch (err) {
    // Phase 4: surfaced to LLM via screenshot(mode='background') dispatcher.
    return failWith(err, "screenshot");
  }
};

export const screenshotOcrHandler = async ({
  windowTitle,
  hwnd: hwndParam,
  language,
  region: subRegion,
}: {
  windowTitle: string;
  hwnd?: string;
  language: string;
  region?: { x: number; y: number; width: number; height: number };
}): Promise<ToolResult> => {
  try {
    const resolvedWin = await resolveWindowTarget({ hwnd: hwndParam, windowTitle });
    const effectiveTitle = resolvedWin?.title ?? windowTitle;
    const ocrWarnings: string[] = [...(resolvedWin?.warnings ?? [])];
    const wins = enumWindowsInZOrder();
    const win = wins.find((w) => w.title.toLowerCase().includes(effectiveTitle.toLowerCase()));
    if (win) {
      updateWindowCache(wins);
      saveSnapshot(effectiveTitle, win.region);
    }
    if (!win) {
      // Phase 4: surfaced to LLM via screenshot(detail='ocr') dispatcher.
      return failWith(`Window not found: "${effectiveTitle}"`, "screenshot", { windowTitle: effectiveTitle });
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
          {
            windowTitle: win.title,
            origin,
            words,
            wordCount: words.length,
            ...(ocrWarnings.length > 0 ? { hints: { warnings: ocrWarnings } } : {}),
          },
          null,
          2
        ),
      }],
    };
  } catch (err) {
    // Phase 4: surfaced to LLM via screenshot(detail='ocr') dispatcher.
    return failWith(err, "screenshot");
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
    return ok(info, true);
  } catch (err) {
    return failWith(err, "get_screen_info");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Envelope-aware registration (walking skeleton expansion swimlane 2 / L5 query)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `screenshot` registration schema with `include?: string[]` injected
 * (PR #112 pattern). Tool source files don't declare `include` themselves
 * (ADR-010 §1.5 spirit) — the L5 wrapper helper owns both schema injection
 * and runtime peek+strip. Used by both `registerScreenshotTools` and
 * `./macro.ts` `TOOL_REGISTRY.screenshot` so `run_macro` dispatcher reuses
 * the SAME wrapped instance (Opus P1-1 同型 strip risk for macro path).
 */
export const screenshotRegistrationSchema = withEnvelopeIncludeSchema(screenshotSchema);

/**
 * Envelope-aware `screenshot` handler. Wraps `screenshotHandler` with
 * `makeQueryWrapper` (S4 query-axis wrapper). screenshot is a read-only
 * observation (screen / window / region capture, no side effects), so the
 * query axis is correct — L1 ToolCallStarted / ToolCallCompleted events
 * are commit-axis only and are NOT emitted here.
 *
 * S5 caused_by linkage is intentionally NOT wired in this expansion PR:
 *   - `causedByProjector` omitted → makeQueryWrapper takes the S4 fast path
 *     (`makeEnvelopeAware`-only branch, sub-plan §4.5 既存 caller 破壊なし)
 *   - per-call `include=["envelope"]` opt-in + env `DESKTOP_TOUCH_ENVELOPE=1`
 *     server default still take effect (G3-1 〜 G3-8 contracts)
 *   - `include=["causal"]` callers see the envelope shape WITHOUT
 *     `caused_by` / `based_on` projection — this matches the S4-default
 *     behaviour for tools that have not opted into S5 wiring yet
 *
 * Used by both `server.tool("screenshot", …)` (this file) and
 * `./macro.ts` `TOOL_REGISTRY.screenshot` (PR #112 shared registration
 * handler pattern, prevents `args.include` strip on the macro path).
 */
export const screenshotRegistrationHandler = makeQueryWrapper(
  screenshotHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
  "screenshot",
  {
    causedByProjector: genericQueryCausedByProjector,
    getSessionId: defaultQuerySessionId,
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerScreenshotTools(server: McpServer): void {
  server.tool(
    "screenshot",
    buildDesc({
      purpose: "Capture desktop, window, or region across detail levels (meta / text / image / som / ocr) and capture modes (normal / background).",
      details:
        "detail='meta' (default) returns window titles+positions only (~20 tok/window, no image). " +
        "detail='text' returns UIA actionable elements with clickAt coords, no image (~100-300 tok). " +
        "detail='som' returns a Set-of-Marks annotated image plus OCR-detected elements with IDs (bypasses UIA entirely). " +
        "detail='ocr' returns Windows OCR words with screen-pixel clickAt coords (Phase 4: absorbs former screenshot_ocr — use when UIA is sparse and you want to force OCR unconditionally). " +
        "detail='image' returns a cheap by-ref resource_link by default (no inline base64); pass confirmImage=true to also embed the inline image. detail='som' is server-blocked unless confirmImage=true is passed. " +
        "mode='background' captures hidden/minimised/occluded windows via PrintWindow (Phase 4: absorbs former screenshot_background) — pair with windowTitle/hwnd. " +
        "dotByDot=true returns 1:1 pixel WebP; compute screen coords: screen_x = origin_x + image_x (or screen_x = origin_x + image_x / scale when dotByDotMaxDimension is set — scale printed in response). " +
        "diffMode=true returns only changed windows after the first call (~160 tok). " +
        "region={x,y,width,height} captures a sub-rectangle (Phase 4: absorbs former scope_element when paired with windowTitle/hwnd — discover element bounds via desktop_discover, then pass region here). " +
        "Data reduction: grayscale=true (−50%), dotByDotMaxDimension=1280 (caps longest edge), windowTitle+region (sub-crop to exclude browser chrome — e.g. region={x:0, y:120, width:1920, height:900}).",
      prefer:
        "Use meta to orient, text before clicking, dotByDot only when precise pixel coords are needed. " +
        "Use detail='som' for native apps or games that do not expose UIA elements (UIA-Blind). " +
        "Use detail='ocr' for OCR-only (skip UIA entirely). " +
        "Use mode='background' when the target window must stay hidden or cannot be brought to foreground. " +
        "Prefer browser_* tools for Chrome. Use diffMode after actions to confirm state changed. " +
        "Only use image+confirmImage when text returned 0 actionable elements and visual inspection is genuinely required.",
      caveats:
        "Default mode scales to maxDimension=768 — image pixels ≠ screen pixels; apply the scale formula before passing to mouse_click. " +
        "Foreground detail='image' returns a by-ref resource_link by default; pass confirmImage=true to also receive inline pixels. " +
        "diffMode requires a prior full-capture baseline (non-diff call or workspace_snapshot) — calling diffMode cold returns a full frame, not a diff. " +
        "mode='background' requires windowTitle or hwnd, and only composes with detail in {'image','meta'} — detail='text'/'som'/'ocr' run only against foreground capture (the dispatcher rejects the conflicting combination). Passing mode='background' is itself the acknowledgement that image pixels are wanted, so confirmImage is NOT required for it (matches the former screenshot_background contract). fullContent=false enables legacy mode (faster but GPU windows may be black). " +
        "detail='ocr' requires windowTitle or hwnd; first call may take ~1s (WinRT cold-start) and the matching OCR language pack must be installed.",
      examples: [
        "screenshot() → meta orientation of all windows",
        "screenshot({detail:'text', windowTitle:'Notepad'}) → clickable elements with coords",
        "screenshot({detail:'ocr', windowTitle:'PDF', ocrLanguage:'ja'}) → OCR words with screen-pixel coords",
        "screenshot({mode:'background', windowTitle:'Chrome', dotByDot:true, dotByDotMaxDimension:1280, grayscale:true}) → background-capture pixel-accurate Chrome",
        "screenshot({windowTitle:'Notepad', region:{x:0,y:120,width:600,height:400}}) → cropped sub-region (zoom into element after desktop_discover)",
      ],
    }),
    screenshotRegistrationSchema,
    screenshotRegistrationHandler as typeof screenshotHandler
  );

  // Phase 4: screenshot_background / screenshot_ocr / scope_element privatized
  // — entry-points removed, handlers retained as internal exports (the
  // dispatcher above routes via mode='background' / detail='ocr' / region).
  // get_screen_info is privatized in batch 4d; use desktop_state({includeScreen:true}).
  // (memory: feedback_disable_via_entry_block.md)
}
