/**
 * Mac port M2-2: desktop_discover / desktop_act on macOS.
 *
 * The same DesktopFacade as Windows (leases, digests, sessions, post-touch
 * diff), with the AX candidate provider and the AX executor plugged in. The
 * Windows guards that ask Win32 (viewport, blocking window, foreground) are
 * not wired: the native AX act refuses on its own when the window or the
 * element at the path changed, and acts reach a background app.
 */

import { z } from "zod";

import type { NativeMac } from "../../engine/native-engine.js";
import { DesktopFacade, type DesktopSeeInput } from "../desktop.js";
import { buildDesc, ok, type ToolResult } from "../_types.js";
import { failCode, getSuggestsForCode } from "../_errors.js";
import { coercedBoolean } from "../_coerce.js";
import { readMacAxCandidates, type MacAxReadNotes } from "./ax-provider.js";
import { createMacAxExecutor } from "./ax-executor.js";

export const macDiscoverSchema = {
  target: z
    .object({ windowTitle: z.string().optional() })
    .optional()
    .describe("Target window by title (case-insensitive substring). Omit for the frontmost app."),
  view: z.enum(["action", "explore", "debug"]).optional().describe("action (default, ≤20 entities), explore (≤50), debug (includes raw rect)"),
  query: z.string().optional().describe("Filter entities by label substring (case-insensitive)"),
  maxEntities: z.number().int().min(1).max(200).optional().describe("Override entity count limit"),
  debug: coercedBoolean().optional().describe("Include raw screen coordinates in response"),
};

export const macActSchema = {
  lease: z
    .object({
      entityId: z.string(),
      viewId: z.string(),
      targetGeneration: z.string(),
      expiresAtMs: z.number(),
      evidenceDigest: z.string(),
    })
    .describe("Lease returned by desktop_discover. Re-call desktop_discover when desktop_act fails with lease_expired or entity_not_found."),
  action: z
    .enum(["auto", "invoke", "click", "type", "setValue"])
    .optional()
    .describe("'click'/'invoke'/'auto' press the element (only one that offers it). 'type' and 'setValue' REPLACE the field's whole value with text."),
  text: z.string().optional().describe("Text to set (required when action='type' or action='setValue')."),
};

export const macDiscoverDescription = buildDesc({
  purpose: "Find the controls of a macOS window you can act on, each with a lease for desktop_act.",
  details:
    "Reads the app's Accessibility tree (no screenshot, no foreground change). Entities carry label, role (button/textbox/link/menuitem/label), " +
    "value (never for a password field), and the actions the element itself offers. 'warnings' says what the read could not do: " +
    "display_asleep (macOS then answers windows with the app itself — wake the display and discover again), no_window_matches_title, " +
    "no_frontmost_app, truncated:*, ax_error:*.",
  prefer: "Discover right before each act: a lease names the element as read, and an act on an element that moved is refused.",
  caveats: "Needs Accessibility permission (PermissionRequired otherwise). Window titles need Screen Recording.",
});

export const macActDescription = buildDesc({
  purpose: "Act on an entity from desktop_discover: press it, or replace a text field's value.",
  details:
    "Acts through Accessibility on the background app — the foreground is not taken. Refused with entity_not_found when the element's window " +
    "or the element at that place changed since the discover (nothing was done; discover again), action_not_offered when the element does not offer it, " +
    "value_not_applied when the app did not take the text.",
  prefer: "Call desktop_state or desktop_discover afterwards to confirm.",
});

export function createMacFacade(mac: NativeMac, notesSink: { last?: MacAxReadNotes }): DesktopFacade {
  const provider = async (input: DesktopSeeInput) => {
    const notes: MacAxReadNotes = { warnings: [] };
    notesSink.last = notes;
    return readMacAxCandidates(
      {
        listWindows: (onScreenOnly) => mac.macListWindows(onScreenOnly),
        getFocus: () => mac.macGetFocus(),
        axTree: (opts) => mac.macAxTree(opts),
        now: () => Date.now(),
      },
      input.target as { windowTitle?: string } | undefined,
      notes
    );
  };
  return new DesktopFacade(provider, {
    sessionEvictionIntervalMs: 30_000,
    executorFn: createMacAxExecutor({
      perform: (t, a) => mac.macAxPerform(t, a),
      setValue: (t, v) => mac.macAxSetValue(t, v),
    }),
  });
}

function permissionGate(mac: NativeMac, tool: string): ToolResult | null {
  const permissions = mac.macPermissions();
  if (permissions.accessibility) return null;
  return failCode(
    "PermissionRequired",
    `${tool}: this process is not allowed to use Accessibility, so nothing on the desktop can be read or done.`,
    { suggest: getSuggestsForCode("PermissionRequired"), context: { permissions } }
  );
}

// The read notes travel beside the facade, so two discovers must not overlap.
let discoverChain: Promise<unknown> = Promise.resolve();

export function macDiscoverHandler(
  mac: NativeMac,
  facade: DesktopFacade,
  notesSink: { last?: MacAxReadNotes },
  input: DesktopSeeInput
): Promise<ToolResult> {
  const run = discoverChain.then(() => macDiscoverOnce(mac, facade, notesSink, input));
  discoverChain = run.catch(() => undefined);
  return run;
}

async function macDiscoverOnce(
  mac: NativeMac,
  facade: DesktopFacade,
  notesSink: { last?: MacAxReadNotes },
  input: DesktopSeeInput
): Promise<ToolResult> {
  const denied = permissionGate(mac, "desktop_discover");
  if (denied) return denied;
  notesSink.last = undefined;
  const output = await facade.see(input);
  const notes = notesSink.last as MacAxReadNotes | undefined;
  const warnings = [...((output as { warnings?: string[] }).warnings ?? []), ...(notes?.warnings ?? [])];
  return ok({
    ...output,
    ...(warnings.length > 0 && { warnings }),
    ...(notes?.appTitle !== undefined && { app: { title: notes.appTitle, pid: notes.pid } }),
  });
}

export async function macActHandler(
  mac: NativeMac,
  facade: DesktopFacade,
  input: { lease: unknown; action?: string; text?: string }
): Promise<ToolResult> {
  const denied = permissionGate(mac, "desktop_act");
  if (denied) return denied;
  if ((input.action === "type" || input.action === "setValue") && input.text === undefined) {
    return failCode("InvalidArgs", `desktop_act: action='${input.action}' requires text`, {
      suggest: getSuggestsForCode("InvalidArgs"),
    });
  }
  const result = await facade.touch(input as Parameters<DesktopFacade["touch"]>[0]);
  return ok(result);
}
