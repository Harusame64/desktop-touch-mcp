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
    "Reads the app's Accessibility tree (no screenshot, no foreground change). Entities carry label (a text's visible text), role " +
    "(button/textbox/link/menuitem/label) and primaryAction; buttons offer click, settable text fields offer type, texts only read. " +
    "'warnings' says what the read could not do: display_asleep (macOS then answers windows with the app itself — wake the display and " +
    "discover again), no_window_matches_title, window_titles_unavailable (Screen Recording is not granted, so titles cannot be matched; " +
    "omit target to read the frontmost app), no_frontmost_app, truncated:*, ax_error:*.",
  prefer: "Discover right before each act: a lease names the element as read, and an act on an element that moved is refused.",
  caveats: "Needs Accessibility permission (PermissionRequired otherwise). Window titles need Screen Recording.",
});

export const macActDescription = buildDesc({
  purpose: "Act on an entity from desktop_discover: press it, or replace a text field's value.",
  details:
    "Acts through Accessibility on the background app — the foreground is not taken. Refused with entity_not_found when the element's window " +
    "or the element at that place changed since the discover (nothing was done; discover again), and action_not_offered when the entity does not " +
    "offer the action (type on a button, click on a text). value_not_applied: the app took the write but the field does not hold the text " +
    "(it may reformat it, e.g. 1.50 shown as 1.5). Not checked: a sheet or dialog that opened over the window after the discover.",
  prefer: "Call desktop_state or desktop_discover afterwards to confirm.",
});

/**
 * What the Mac tools keep beside the facade. `phase` says whether the provider is reading for a
 * discover or for the read after an act; `noTargetPid` is the app a discover without a target
 * resolved as frontmost, so the read after an act compares the same app even when the press
 * brought another one forward (codex gate 1, #780). Discover and act run one at a time
 * (`serialise`), so these fields are never shared by two calls.
 */
export interface MacFacadeState {
  last?: MacAxReadNotes;
  phase: "discover" | "act";
  noTargetPid?: number;
}

export function createMacFacade(mac: NativeMac, state: MacFacadeState): DesktopFacade {
  const provider = async (input: DesktopSeeInput) => {
    const notes: MacAxReadNotes = { warnings: [] };
    state.last = notes;
    const target = input.target as { windowTitle?: string } | undefined;
    const untargeted = target?.windowTitle === undefined || target.windowTitle === "";
    const candidates = await readMacAxCandidates(
      {
        listWindows: (onScreenOnly) => mac.macListWindows(onScreenOnly),
        getFocus: () => mac.macGetFocus(),
        axTree: (opts) => mac.macAxTree(opts),
        now: () => Date.now(),
      },
      target,
      notes,
      untargeted && state.phase === "act" ? state.noTargetPid : undefined
    );
    if (untargeted && state.phase === "discover") state.noTargetPid = notes.pid;
    return candidates;
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

// The state travels beside the facade, so discovers and acts run one at a time. A call that
// throws does not stop the ones queued after it.
let chain: Promise<unknown> = Promise.resolve();
function serialise<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run);
  chain = next.catch(() => undefined);
  return next;
}

export function macDiscoverHandler(
  mac: NativeMac,
  facade: DesktopFacade,
  state: MacFacadeState,
  input: DesktopSeeInput
): Promise<ToolResult> {
  return serialise(() => macDiscoverOnce(mac, facade, state, input));
}

async function macDiscoverOnce(
  mac: NativeMac,
  facade: DesktopFacade,
  state: MacFacadeState,
  input: DesktopSeeInput
): Promise<ToolResult> {
  const denied = permissionGate(mac, "desktop_discover");
  if (denied) return denied;
  state.last = undefined;
  state.phase = "discover";
  const output = await facade.see(input);
  const notes = state.last as MacAxReadNotes | undefined;
  const warnings = [...((output as { warnings?: string[] }).warnings ?? []), ...(notes?.warnings ?? [])];
  return ok({
    ...output,
    ...(warnings.length > 0 && { warnings }),
    ...(notes?.appTitle !== undefined && { app: { title: notes.appTitle, pid: notes.pid } }),
  });
}

export function macActHandler(
  mac: NativeMac,
  facade: DesktopFacade,
  state: MacFacadeState,
  input: { lease: unknown; action?: string; text?: string }
): Promise<ToolResult> {
  return serialise(() => macActOnce(mac, facade, state, input));
}

async function macActOnce(
  mac: NativeMac,
  facade: DesktopFacade,
  state: MacFacadeState,
  input: { lease: unknown; action?: string; text?: string }
): Promise<ToolResult> {
  const denied = permissionGate(mac, "desktop_act");
  if (denied) return denied;
  if ((input.action === "type" || input.action === "setValue") && input.text === undefined) {
    return failCode("InvalidArgs", `desktop_act: action='${input.action}' requires text`, {
      suggest: getSuggestsForCode("InvalidArgs"),
    });
  }
  state.phase = "act";
  const result = await facade.touch(input as Parameters<DesktopFacade["touch"]>[0]);
  return ok(result);
}
