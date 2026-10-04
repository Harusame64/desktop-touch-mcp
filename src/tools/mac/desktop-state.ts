/**
 * desktop_state on macOS (Mac port M2-1, internal docs/mac-port-design.md).
 *
 * Read-only: the frontmost app, its focused element and window, how many
 * windows are on screen, and whether the display is asleep. Built on the
 * `mac*` exports of the native addon (src/macos/).
 *
 * Reads fail open (RPG source, "Failure Behavior"): a sleeping display does
 * not make this an error, it is reported with `attention: "display_asleep"`
 * because AX answers windows with the application element itself while the
 * display sleeps, so nothing read then describes the app's UI.
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

export interface MacDesktopState {
  focusedWindow: { title: string | null; appName: string | null; pid: number } | null;
  focusedElement: { role: string; title: string | null } | null;
  visibleWindows: number;
  displayAsleep: boolean;
  attention: "ok" | "display_asleep" | "no_frontmost_app";
  permissions: NativeMacPermissions;
  hints: { focusSource: string | null; focusError: string | null };
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

  const focus = await deps.getFocus();
  const visibleWindows = deps
    .listWindows(true)
    .filter((w) => w.layer === 0 && w.onScreen).length;
  const displayAsleep = deps.displayAsleep();

  const attention: MacDesktopState["attention"] = displayAsleep
    ? "display_asleep"
    : focus.pid === undefined
      ? "no_frontmost_app"
      : "ok";

  const state: MacDesktopState = {
    focusedWindow:
      focus.pid === undefined
        ? null
        : {
            title: focus.focusedWindowTitle ?? null,
            appName: focus.appTitle ?? null,
            pid: focus.pid,
          },
    focusedElement:
      focus.focusedRole === undefined
        ? null
        : { role: focus.focusedRole, title: focus.focusedTitle ?? null },
    visibleWindows,
    displayAsleep,
    attention,
    permissions,
    hints: { focusSource: focus.source ?? null, focusError: focus.error ?? null },
  };
  return ok(state);
}

export const macDesktopStateDescription = buildDesc({
  purpose:
    "Read-only observation of the macOS desktop: the frontmost app, its focused window and element, and how many windows are on screen.",
  details:
    "Returns focusedWindow {title, appName, pid}, focusedElement {role, title} (null when the app has none, e.g. its window is on another Space), " +
    "visibleWindows (on-screen app windows), displayAsleep, attention, permissions {accessibility, screenCapture}. " +
    "attention: 'ok'; 'display_asleep' (the display sleeps: macOS then answers windows with the app itself, so wake it and read again); " +
    "'no_frontmost_app'. The focused element's value is never returned.",
  prefer: "Use first to orient, and after each action to confirm. Cheapest observation tool.",
  caveats:
    "Needs Accessibility permission for the app running this server; without it the call fails with PermissionRequired and says where to grant it.",
});
