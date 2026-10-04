/**
 * desktop_state on macOS (Mac port M2-1, internal docs/mac-port-design.md).
 *
 * Read-only: the frontmost app, its focused element and window, how many
 * windows are on screen, and whether the display is asleep. Built on the
 * `mac*` exports of the native addon (src/macos/).
 *
 * Reads fail open (RPG source, "Failure Behavior"): a sleeping display or a
 * read that throws does not make this an error. It is reported as
 * `attention: "needs_escalation"` with the reason and a suggestion, and what
 * was read is returned. (While the display sleeps AX answers windows with
 * the application element itself, so nothing read then describes the UI.)
 *
 * The focused element's value is never read here, so a password field cannot
 * hand its contents back through this tool.
 */

import type {
  NativeMacFocus,
  NativeMacPermissions,
  NativeMacWindow,
} from "../../engine/native-types.js";
import { failCode, getSuggestsForCode } from "../_errors.js";
import { buildDesc, ok, type ToolResult } from "../_types.js";

/** The native calls this tool uses; injected so it can be tested without a Mac. */
export interface MacStateDeps {
  permissions(): NativeMacPermissions;
  listWindows(onScreenOnly?: boolean): NativeMacWindow[];
  getFocus(): Promise<NativeMacFocus>;
  displayAsleep(): boolean;
}

/**
 * `attention` uses the RPG source's AttentionState words (docs/reactive-perception-graph.md):
 * `ok`, or `needs_escalation` — "cheap sensors cannot answer with enough confidence" — with the
 * reason in `hints.reason` and what to do in `suggest`, as the Windows desktop_state promises
 * ("other values require recovery (see suggest[])").
 */
export type MacStateReason = "display_asleep" | "no_frontmost_app" | "read_failed" | "frontmost_guessed";

export interface MacDesktopState {
  focusedWindow: { title: string | null; appName: string | null; pid: number } | null;
  focusedElement: { role: string; title: string | null } | null;
  /** On-screen app windows (layer 0, not fully transparent); null when the list could not be read. */
  visibleWindows: number | null;
  /**
   * Those windows, front to back (at most 30): title as macOS shows it — in the user's language, so
   * Calculator can be "計算機" — app name and pid. The dogfood (2026-10-04) had no way to learn a title
   * to pass to desktop_discover / screenshot.
   */
  windows: Array<{ title: string | null; app: string | null; pid: number }> | null;
  /** null when it could not be asked. */
  displayAsleep: boolean | null;
  attention: "ok" | "needs_escalation";
  suggest?: string[];
  permissions: NativeMacPermissions;
  hints: {
    reason: MacStateReason | null;
    focusSource: string | null;
    focusError: string | null;
    /** Reads that threw, by name, with the error text. */
    readErrors?: Record<string, string>;
  };
}

const SUGGEST: Record<MacStateReason, string[]> = {
  display_asleep: [
    "The display is asleep: macOS then answers windows with the app itself, so nothing read now describes the app's UI. Wake the display (move the mouse, or ask the user), then call desktop_state again.",
  ],
  no_frontmost_app: [
    "No app answered as frontmost. Call desktop_state again; if it persists, the app in front may not support Accessibility.",
  ],
  frontmost_guessed: [
    "No app said it is frontmost, so the owner of the frontmost window is shown — a guess. Pass a window title (windows[] lists them) to desktop_discover / screenshot rather than relying on 'frontmost'.",
  ],
  read_failed: [
    "Part of the desktop could not be read (see hints.readErrors); what is shown was read. Call desktop_state again.",
  ],
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function macDesktopStateHandler(deps: MacStateDeps): Promise<ToolResult> {
  const permissions = deps.permissions();
  if (!permissions.accessibility) {
    return failCode(
      "PermissionRequired",
      "desktop_state: this process is not allowed to use Accessibility, so nothing on the desktop can be read.",
      { suggest: getSuggestsForCode("PermissionRequired"), context: { permissions } }
    );
  }

  // Reads fail open (RPG source, "Failure Behavior"): each read that throws is
  // reported in hints.readErrors and the rest is still returned.
  const readErrors: Record<string, string> = {};
  let focus: NativeMacFocus = {};
  try {
    focus = await deps.getFocus();
  } catch (e) {
    readErrors.focus = errText(e);
  }
  let visibleWindows: number | null = null;
  let windows: MacDesktopState["windows"] = null;
  try {
    const shown = deps.listWindows(true).filter((w) => w.layer === 0 && w.onScreen && w.alpha !== 0);
    visibleWindows = shown.length;
    windows = shown.slice(0, 30).map((w) => ({ title: w.title || null, app: w.ownerName ?? null, pid: w.pid }));
  } catch (e) {
    readErrors.windows = errText(e);
  }
  let displayAsleep: boolean | null = null;
  try {
    displayAsleep = deps.displayAsleep();
  } catch (e) {
    readErrors.displayAsleep = errText(e);
  }

  const reason: MacStateReason | null =
    displayAsleep === true
      ? "display_asleep"
      : Object.keys(readErrors).length > 0
        ? "read_failed"
        : focus.pid == null
          ? "no_frontmost_app"
          : focus.source === "app_scan_topmost"
            ? "frontmost_guessed"
            : null;

  const state: MacDesktopState = {
    focusedWindow:
      focus.pid == null
        ? null
        : {
            title: focus.focusedWindowTitle ?? null,
            appName: focus.appTitle ?? null,
            pid: focus.pid,
          },
    focusedElement:
      focus.focusedRole == null ? null : { role: focus.focusedRole, title: focus.focusedTitle ?? null },
    visibleWindows,
    windows,
    displayAsleep,
    attention: reason === null ? "ok" : "needs_escalation",
    ...(reason === null ? {} : { suggest: SUGGEST[reason] }),
    permissions,
    hints: {
      reason,
      focusSource: focus.source ?? null,
      focusError: focus.error ?? null,
      ...(Object.keys(readErrors).length > 0 ? { readErrors } : {}),
    },
  };
  return ok(state);
}

export const macDesktopStateDescription = buildDesc({
  purpose:
    "Read-only observation of the macOS desktop: the frontmost app, its focused window and element, and how many windows are on screen.",
  details:
    "Returns focusedWindow {title, appName, pid}, focusedElement {role, title} (null when the app has none, e.g. its window is on another Space), " +
    "visibleWindows and windows[] (on-screen app windows front to back: title, app, pid — titles are in the user's language, e.g. Calculator " +
    "may be \"計算機\"; pass them to desktop_discover / screenshot), displayAsleep, attention, permissions {accessibility, screenCapture}. " +
    "attention: 'ok', or 'needs_escalation' with hints.reason and suggest[]: 'display_asleep' (macOS then answers windows with the app itself; wake it and read again), " +
    "'no_frontmost_app', 'read_failed' (hints.readErrors; what was read is still returned). The focused element's value is never returned. " +
    "hints.focusSource / focusError say how the frontmost app was found (diagnostics: system_wide, app_scan, system_wide_windowless, " +
    "app_scan_offscreen — e.g. focusError 'cannot_complete' or 'system_wide_no_window' with a found app is a normal answer; " +
    "app_scan_topmost is a guess and answers needs_escalation / frontmost_guessed). " +
    "windows[] can include an app's untitled helper windows (title null).",
  prefer: "Use first to orient, and after each action to confirm. Cheapest observation tool.",
  caveats:
    "Needs Accessibility permission for the app running this server; without it the call fails with PermissionRequired and says where to grant it.",
});
