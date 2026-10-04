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
 * Encoding uses sharp directly (src/engine/image.ts loads nut-js on import), and loads it on
 * the first capture: a missing sharp binary must cost this tool only, not the whole server
 * (gate 2, #781).
 */

import { z } from "zod";

import type {
  NativeMacCaptureOptions,
  NativeMacCaptureResult,
  NativeMacFocus,
  NativeMacPermissions,
  NativeMacWindow,
} from "../../engine/native-types.js";
import { failCode } from "../_errors.js";
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
    "pointsPerPixel (screen_x = bounds.x + image_x * pointsPerPixel; same for y — for a window that is on screen; a minimised or " +
    "other-Space window's bounds are not where it shows). A covered window is captured as it is now. " +
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
  const sharp = (await import("sharp")).default;
  // The native capture forces alpha to 255, so the channel carries nothing.
  let pipeline = sharp(rgba, { raw: { width, height, channels: 4 } }).removeAlpha();
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
  windowGone: ["The window closed between choosing it and capturing it. Call screenshot again."],
  unsupportedOs: ["Window capture needs macOS 14 or later. desktop_discover reads the window's controls without a capture."],
  noTitles: [
    "No window title is readable. Omit windowTitle to capture the frontmost app's window, or call desktop_state to see what is there.",
  ],
  screenRecording: [
    "Open System Settings > Privacy & Security > Screen Recording (macOS 15: Screen & System Audio Recording) and turn on the app that runs this server (Terminal, iTerm, VS Code, the Claude app, ...), then restart the server.",
  ],
  encoderMissing: ["The image encoder (sharp) could not be loaded; reinstall the package so its macOS binary is present."],
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
          : "screenshot: no window title is readable, so no title can match.",
        { suggest: titled ? [...MAC_SUGGEST.noTitle] : [...MAC_SUGGEST.noTitles] }
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
      suggest: [...MAC_SUGGEST.screenRecording],
      context: { permissions },
    });
  }
  const chosen = await chooseWindow(deps, input.windowTitle);
  if ("content" in chosen) return chosen;
  const { window, warnings } = chosen;

  const maxDimension = input.maxDimension ?? 1280;
  // Capture no larger than needed: a full-screen window on a 5K display is ~59 MB of RGBA at the
  // display's own scale, only to be shrunk to maxDimension (gate 2, #781). Below 1 point per pixel
  // the native default (the display's scale) is kept.
  const longest = window.bounds ? Math.max(window.bounds.width, window.bounds.height) : 0;
  const scale = longest > maxDimension ? maxDimension / longest : undefined;
  const shot = await deps.capture({ windowId: window.windowId, ...(scale !== undefined && { scale }) });
  if (!shot.ok && shot.reason === "window_not_found") {
    return failCode("WindowNotFound", `screenshot: window ${window.windowId} closed before it could be captured.`, {
      suggest: [...MAC_SUGGEST.windowGone],
      context: { windowId: window.windowId },
    });
  }
  if (!shot.ok && shot.reason === "unsupported_os") {
    return failCode("CaptureBackendFailed", "screenshot: window capture needs macOS 14 or later.", {
      suggest: [...MAC_SUGGEST.unsupportedOs],
      context: { windowId: window.windowId, reason: shot.reason },
    });
  }
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

  let encoded: { png: Buffer; width: number; height: number };
  try {
    encoded = await deps.encodePng(shot.data, shot.width, shot.height, maxDimension);
  } catch (e) {
    return failCode("CaptureBackendFailed", `screenshot: the captured image could not be encoded: ${e instanceof Error ? e.message : String(e)}`, {
      suggest: [...MAC_SUGGEST.encoderMissing],
      context: { windowId: window.windowId },
    });
  }
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
