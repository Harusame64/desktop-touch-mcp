import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureScreen, captureDisplay, captureWindowBackground } from "../engine/image.js";
import { captureAndDiff, captureAllLayers, hasBuffer } from "../engine/layer-buffer.js";
import type { WindowInfo } from "../engine/layer-buffer.js";
import { getWindows } from "../engine/nutjs.js";
import { enumMonitors, getVirtualScreen, getWindowTitleW, enumWindowsInZOrder } from "../engine/win32.js";
import { getUiElements, extractActionableElements, WINUI3_CLASS_RE, detectUiaBlind } from "../engine/uia-bridge.js";
import type { UiElementsResult } from "../engine/uia-bridge.js";
import { recognizeWindow, ocrWordsToActionable, runOcr, mergeNearbyWords, runSomPipeline } from "../engine/ocr-bridge.js";
import { updateWindowCache } from "../engine/window-cache.js";
import { CHROMIUM_TITLE_RE } from "./workspace.js";
import { computeViewportPosition } from "../utils/viewport-position.js";
import { ok, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
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
    .describe("Direct window handle ID (takes precedence over windowTitle). Obtain from get_windows (hwnd field). String type to avoid 64-bit precision issues."),
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
    .enum(["meta", "text", "image", "som"])
    .optional()
    .describe(
      "Response detail level (omit to let the server pick a smart default):\n" +
      "  omitted — auto: 'image' when dotByDot/region/displayId is specified, else 'meta'\n" +
      "  'meta'  — window title + screen region only (~20 tok/window, cheapest)\n" +
      "  'text'  — UIA element tree as JSON with text values (~100-300 tok/window, no image)\n" +
      "  'image' — actual screenshot pixels. BLOCKED unless confirmImage=true is also passed.\n" +
      "  'som'   — Set-of-Marks image + OCR elements (bypasses UIA entirely). BLOCKED unless confirmImage=true is also passed."
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
  preprocessPolicy: z
    .enum(["auto", "aggressive", "minimal"])
    .default("auto")
    .describe(
      "OCR preprocessing scale policy for detail='som' and OCR fallback paths. " +
      "'auto' (default): clamp scale to 1 on OOM (>8MP) or high-DPI (≥150%). " +
      "'aggressive': relaxes DPI clamp to 175%, preserving upscale on 150%-DPI monitors (e.g. Outlook PWA). Also auto-enables adaptive binarization. " +
      "'minimal': always scale=1 regardless of DPI/resolution."
    ),
  preprocessAdaptive: z
    .boolean()
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

export const screenshotHandler = async ({
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
  ocrLanguage,
  preprocessPolicy = "auto",
  preprocessAdaptive = false,
}: {
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
  detail: "meta" | "text" | "image" | "som" | undefined;
  confirmImage: boolean;
  ocrFallback: "auto" | "always" | "never";
  ocrLanguage: string;
  preprocessPolicy: "auto" | "aggressive" | "minimal";
  preprocessAdaptive: boolean;
}): Promise<ToolResult> => {
  // Compute effective detail: explicit value wins; otherwise infer from context.
  // dotByDot / region / displayId imply the caller wants pixels, so default to 'image'.
  const effectiveDetail: "meta" | "text" | "image" | "som" = detail ?? (
    dotByDot || region !== undefined || displayId !== undefined ? "image" : "meta"
  );

  try {
    // Resolve hwnd / @active → effective window title
    const resolvedWin = await resolveWindowTarget({ hwnd: hwndParam, windowTitle });
    const effectiveTitle = resolvedWin?.title ?? windowTitle;
    const screenshotWarnings: string[] = [...(resolvedWin?.warnings ?? [])];

    // ── Guard: block bare detail='image'/'som' unless explicitly confirmed ──
    // Only fires when 'image' or 'som' was explicitly requested, not when
    // inferred from dotByDot/region context.
    const guardDisabled = process.env.DESKTOP_TOUCH_DISABLE_IMAGE_GUARD === "1";
    const isExplicitImage = detail === "image" || detail === "som";
    if (isExplicitImage && !diffMode && !dotByDot && !confirmImage && !guardDisabled) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: [
            `[screenshot-guard] detail='${detail}' was blocked to prevent accidental heavy image payloads.`,
            "",
            "Prefer these lighter alternatives (in order):",
            "  1. screenshot(detail='text', windowTitle=X)  — UIA actionable[] with clickAt coords",
            "  2. screenshot(diffMode=true)                 — only changed windows as image",
            "  3. screenshot(dotByDot=true, windowTitle=X)  — 1:1 WebP for pixel-perfect coords",
            "",
            `If a ${detail === "som" ? "Set-of-Marks" : "full"} image truly is required, re-call with confirmImage=true.`,
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

        // SoM mode — when UIA-Blind is detected AND OCR would fire, run the full
        // Set-of-Mark pipeline (preprocess → OCR → cluster → draw) instead of the
        // plain word-list fallback. Falls through to normal OCR on any error.
        const uiaBlind = raw !== null ? detectUiaBlind(raw) : { blind: false as const };
        if (shouldOcr && uiaBlind.blind) {
          try {
            const somResult = await runSomPipeline(effectiveTitle, targetHwnd, ocrLanguage, 2, preprocessPolicy, preprocessAdaptive);
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
            const ocrItems = ocrWordsToActionable(words, origin);
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
      const windows = await getWindows();
      let windowRegion: { x: number; y: number; width: number; height: number } | undefined;
      let originX = 0, originY = 0;

      for (const win of windows) {
        const h = (win as unknown as { windowHandle: unknown }).windowHandle;
        const title = h ? getWindowTitleW(h) : await win.title;
        if (title.toLowerCase().includes(effectiveTitle.toLowerCase())) {
          const reg = await win.region;
          windowRegion = { x: reg.left, y: reg.top, width: reg.width, height: reg.height };
          originX = reg.left;
          originY = reg.top;
          break;
        }
      }

      if (!windowRegion) {
        return failWith(`Window not found: "${effectiveTitle}"`, "screenshot", { windowTitle: effectiveTitle });
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
          ...(screenshotWarnings.length > 0 ? [{ type: "text" as const, text: JSON.stringify({ hints: { warnings: screenshotWarnings } }) }] : []),
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
      return failWith(`Window not found: "${effectiveTitle}"`, "screenshot_background", { windowTitle: effectiveTitle });
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
    return failWith(err, "screenshot_background");
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
    if (!win) {
      return failWith(`Window not found: "${effectiveTitle}"`, "screenshot_ocr", { windowTitle: effectiveTitle });
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
    return failWith(err, "screenshot_ocr");
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
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerScreenshotTools(server: McpServer): void {
  server.tool(
    "screenshot",
    buildDesc({
      purpose: "Capture desktop, window, or region state across four output modes — from cheap orientation metadata to pixel-accurate images.",
      details: "detail='meta' (default) returns window titles+positions only (~20 tok/window, no image). detail='text' returns UIA actionable elements with clickAt coords, no image (~100-300 tok). detail='som' returns a Set-of-Marks annotated image plus OCR-detected elements with IDs (bypasses UIA entirely). detail='image' and detail='som' are server-blocked unless confirmImage=true is also passed. dotByDot=true returns 1:1 pixel WebP; compute screen coords: screen_x = origin_x + image_x (or screen_x = origin_x + image_x / scale when dotByDotMaxDimension is set — scale printed in response). diffMode=true returns only changed windows after the first call (~160 tok). Data reduction: grayscale=true (−50%), dotByDotMaxDimension=1280 (caps longest edge), windowTitle+region (sub-crop to exclude browser chrome — e.g. region={x:0, y:120, width:1920, height:900}).",
      prefer: "Use meta to orient, text before clicking, dotByDot only when precise pixel coords are needed. Use detail='som' for native apps or games that do not expose UIA elements (UIA-Blind). Prefer browser_* tools for Chrome. Use diffMode after actions to confirm state changed. Only use image+confirmImage when text returned 0 actionable elements and visual inspection is genuinely required.",
      caveats: "Default mode scales to maxDimension=768 — image pixels ≠ screen pixels; apply the scale formula before passing to mouse_click. detail='image' is always blocked without confirmImage=true. diffMode requires a prior full-capture baseline (non-diff call or workspace_snapshot) — calling diffMode cold returns a full frame, not a diff.",
      examples: [
        "screenshot() → meta orientation of all windows",
        "screenshot({detail:'text', windowTitle:'Notepad'}) → clickable elements with coords",
        "screenshot({dotByDot:true, dotByDotMaxDimension:1280, grayscale:true, windowTitle:'Chrome', region:{x:0,y:120,width:1920,height:900}}) → pixel-accurate Chrome content",
      ],
    }),
    screenshotSchema,
    screenshotHandler
  );

  server.tool(
    "screenshot_background",
    buildDesc({
      purpose: "Capture a window that is hidden, minimized, or behind other windows using Win32 PrintWindow API.",
      details: "Uses PW_RENDERFULLCONTENT (fullContent=true, default) for GPU-rendered content in Chrome, Electron, and WinUI3 apps. Supports same detail and dotByDot modes as screenshot. Default mode scales to maxDimension=768; dotByDot=true gives 1:1 WebP with origin in response — compute screen coords: screen_x = origin_x + image_x. grayscale=true reduces size ~50%. dotByDotMaxDimension caps resolution; response includes scale (screen_x = origin_x + image_x / scale).",
      prefer: "Prefer screenshot(windowTitle=X) for visible windows (faster, no API overhead). Use screenshot_background when the window must stay hidden or cannot be brought to foreground.",
      caveats: "Default (scaled) mode: image pixels ≠ screen pixels — always use dotByDot=true + origin for mouse_click coords. Set fullContent=false for legacy or game windows where GPU rendering causes 1-3s delay or black capture. Some DX12 games may not capture correctly even with fullContent=true.",
    }),
    screenshotBgSchema,
    screenshotBgHandler
  );

  server.tool(
    "screenshot_ocr",
    "Run Windows OCR on a window and return word-level text with screen-pixel clickAt coordinates — use when UIA returns no actionable elements (WinUI3 custom-drawn UIs, game overlays, PDF viewers). Note: screenshot(detail='text') auto-falls back to OCR when UIA is sparse (ocrFallback='auto' default) — call screenshot_ocr directly only when forcing OCR unconditionally. language: BCP-47 tag (default 'ja'). Caveats: First call may take ~1s (WinRT cold-start). Requires the matching Windows OCR language pack installed.",
    screenshotOcrSchema,
    screenshotOcrHandler
  );

  server.tool(
    "get_screen_info",
    "Return all connected display info: resolution, position, DPI scaling, and current cursor position. Use monitorId from this response to target a specific display in dock_window.",
    getScreenInfoSchema,
    getScreenInfoHandler
  );
}
