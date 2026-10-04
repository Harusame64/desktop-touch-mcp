/**
 * Mac port M2-3: screenshot of one window on macOS, through ScreenCaptureKit
 * (`macCaptureWindow`, src/macos/capture.rs).
 *
 * The window is chosen from CGWindowList: by title (case-insensitive
 * substring), or — without one — the frontmost app's focused window. When
 * several windows match, the frontmost is taken and `warnings` says so.
 * Nothing here takes the foreground; a covered window is captured as it is
 * now. What SCK refuses comes back as a failure, never an older image.
 *
 * Encoding uses sharp directly (src/engine/image.ts loads nut-js on import).
 */

import sharp from "sharp";
import { z } from "zod";

import type {
  NativeMacCaptureOptions,
  NativeMacCaptureResult,
  NativeMacFocus,
  NativeMacPermissions,
  NativeMacWindow,
} from "../../engine/native-types.js";
import { failCode, getSuggestsForCode } from "../_errors.js";
import { buildDesc, type ToolResult } from "../_types.js";

export interface MacScreenshotDeps {
  permissions(): NativeMacPermissions;
  listWindows(onScreenOnly?: boolean): NativeMacWindow[];
  getFocus(): Promise<NativeMacFocus>;
  capture(opts: NativeMacCaptureOptions): Promise<NativeMacCaptureResult>;
  encodePng(rgba: Buffer, width: number, height: number, maxDimension: number): Promise<{ png: Buffer; width: number; height: number }>;
}

export const macScreenshotSchema = {
  windowTitle: z.string().optional().describe("Window to capture (case-insensitive substring of its title). Omit for the frontmost app's window."),
  maxDimension: z.number().int().min(64).max(4096).optional().describe("Scale the longest edge down to this many pixels (default 1280)."),
};

export const macScreenshotDescription = buildDesc({
  purpose: "Capture one macOS window as a PNG image, without bringing it forward.",
  details:
    "Returns the image plus JSON: windowId, title, pid, bounds (screen points, top-left origin), imageWidth/imageHeight, and " +
    "pointsPerPixel (screen_x = bounds.x + image_x * pointsPerPixel; same for y). A covered window is captured as it is now. " +
    "warnings: several_windows_match (the frontmost of them was taken), window_off_screen (minimised or on another Space; " +
    "the capture may fail or show it as it is).",
  prefer: "Prefer desktop_discover / desktop_state for reading UI: they are cheaper and give leases. Use this when you need pixels.",
  caveats: "Needs Screen Recording permission (PermissionRequired otherwise). Needs macOS 14 or later.",
});

/** Defaults to sharp: scale the longest edge down to `maxDimension`, PNG. */
export async function sharpEncodePng(
  rgba: Buffer,
  width: number,
  height: number,
  maxDimension: number
): Promise<{ png: Buffer; width: number; height: number }> {
  let pipeline = sharp(rgba, { raw: { width, height, channels: 4 } });
  if (Math.max(width, height) > maxDimension) {
    pipeline = pipeline.resize({
      width: width >= height ? maxDimension : undefined,
      height: width < height ? maxDimension : undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  const { data, info } = await pipeline.png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height };
}

/**
 * Mac-specific recovery lines. The shared dictionary's lines for these codes name Windows paths and
 * tools this server does not register (PrintWindow, list_window_titles, focus_window).
 */
const MAC_SUGGEST = {
  noTitle: [
    "Call desktop_state to see the frontmost app and its window title, or omit windowTitle to capture the frontmost app's window.",
    "Titles match as a case-insensitive substring; try a shorter part of the title.",
  ],
  noFront: ["Pass windowTitle; desktop_state shows which app is frontmost."],
  captureFailed: [
    "A minimised window or one on another Space may not be capturable: bring it back (or ask the user), then capture again.",
    "If the display is asleep, wake it and retry.",
    "desktop_discover reads the window's controls without a capture.",
  ],
} as const;

interface Chosen {
  window: NativeMacWindow;
  warnings: string[];
}

/** Pick the window, front to back. Returns a failure result when there is none. */
async function chooseWindow(deps: MacScreenshotDeps, title: string | undefined): Promise<Chosen | ToolResult> {
  // Front to back: on-screen windows in z-order first, then the rest (minimised, other Spaces).
  const onScreen = deps.listWindows(true).filter((w) => w.layer === 0);
  const seen = new Set(onScreen.map((w) => w.windowId));
  const all = [...onScreen, ...deps.listWindows(false).filter((w) => w.layer === 0 && !seen.has(w.windowId))];

  let matches: NativeMacWindow[];
  if (title !== undefined && title !== "") {
    const needle = title.toLowerCase();
    matches = all.filter((w) => (w.title ?? "").toLowerCase().includes(needle));
    if (matches.length === 0) {
      const titled = all.some((w) => (w.title ?? "") !== "");
      return failCode(
        "WindowNotFound",
        titled
          ? `screenshot: no window title contains "${title}".`
          : "screenshot: window titles are not readable (Screen Recording is not granted), so no title can match.",
        { suggest: titled ? [...MAC_SUGGEST.noTitle] : getSuggestsForCode("PermissionRequired") }
      );
    }
  } else {
    const focus = await deps.getFocus();
    if (focus.pid === undefined) {
      return failCode("WindowNotFound", "screenshot: no app answered as frontmost; pass windowTitle.", {
        suggest: [...MAC_SUGGEST.noFront],
      });
    }
    const own = all.filter((w) => w.pid === focus.pid);
    const byTitle = focus.focusedWindowTitle ? own.filter((w) => w.title === focus.focusedWindowTitle) : [];
    matches = byTitle.length > 0 ? byTitle : own;
    if (matches.length === 0) {
      return failCode("WindowNotFound", "screenshot: the frontmost app has no window to capture; pass windowTitle.", {
        suggest: [...MAC_SUGGEST.noFront],
      });
    }
  }
  const warnings: string[] = [];
  if (matches.length > 1) warnings.push("several_windows_match");
  const window = matches[0]!;
  if (!window.onScreen) warnings.push("window_off_screen");
  return { window, warnings };
}

export async function macScreenshotHandler(
  deps: MacScreenshotDeps,
  input: { windowTitle?: string; maxDimension?: number }
): Promise<ToolResult> {
  const permissions = deps.permissions();
  if (!permissions.screenCapture) {
    return failCode("PermissionRequired", "screenshot: this process is not allowed to record the screen, so no window can be captured.", {
      suggest: getSuggestsForCode("PermissionRequired"),
      context: { permissions },
    });
  }
  const chosen = await chooseWindow(deps, input.windowTitle);
  if ("content" in chosen) return chosen;
  const { window, warnings } = chosen;

  const shot = await deps.capture({ windowId: window.windowId });
  if (!shot.ok || shot.data === undefined) {
    return failCode(
      "CaptureBackendFailed",
      `screenshot: ScreenCaptureKit did not capture window ${window.windowId}: ${shot.reason ?? "no image"}. Nothing older is returned instead.`,
      {
        suggest: [...MAC_SUGGEST.captureFailed],
        context: { windowId: window.windowId, onScreen: window.onScreen, reason: shot.reason ?? null, warnings },
      }
    );
  }

  const encoded = await deps.encodePng(shot.data, shot.width, shot.height, input.maxDimension ?? 1280);
  const bounds = shot.frame ?? window.bounds;
  const meta = {
    windowId: window.windowId,
    title: window.title ?? null,
    pid: window.pid,
    bounds: bounds ?? null,
    imageWidth: encoded.width,
    imageHeight: encoded.height,
    pointsPerPixel: bounds && encoded.width > 0 ? bounds.width / encoded.width : null,
    onScreen: shot.onScreen ?? window.onScreen,
    ...(warnings.length > 0 && { warnings }),
  };
  return {
    content: [
      { type: "image", data: encoded.png.toString("base64"), mimeType: "image/png" },
      { type: "text", text: JSON.stringify(meta) },
    ],
  };
}
