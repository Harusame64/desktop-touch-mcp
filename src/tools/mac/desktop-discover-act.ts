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
    .describe("Target window by title (case-insensitive substring; titles are in the user's language — desktop_state lists them). Omit for the frontmost app."),
  view: z.enum(["action", "explore", "debug"]).optional().describe("action (default, ≤20 entities), explore (≤50), debug (includes raw rect)"),
  query: z.string().optional().describe("Filter entities by label substring (case-insensitive). Labels only: a text field without a label never matches, so look for role 'textbox' instead."),
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
    .describe("'click'/'invoke'/'auto' press the element (only one that offers it). 'type' and 'setValue' REPLACE the field's whole value with text — to add text, use append: true instead of resending the old text (a long field's value from desktop_discover is cut: valueTruncated)."),
  text: z.string().optional().describe("Text to set (required when action='type' or action='setValue')."),
  append: z
    .boolean()
    .optional()
    .describe("With type/setValue: insert text at the end of the field instead of replacing it; the existing text is not touched."),
};

export const macDiscoverDescription = buildDesc({
  purpose: "Find the controls of a macOS window you can act on, each with a lease for desktop_act.",
  details:
    "Reads the app's Accessibility tree (no screenshot, no foreground change). Entities carry label (a text's visible text), role " +
    "(button/textbox/link/menuitem/label), primaryAction, and — for a text field — its current value (never a password field's; " +
    "longer than 2000 characters: no value, valueTruncated: true); " +
    "buttons offer click, settable text fields offer type, texts only read. Each lease carries expiresAtMs (its life adapts to the view and to how long you take between calls); after it, desktop_act answers lease_expired. " +
    "'warnings' says what the read could not do: display_asleep (macOS then answers windows with the app itself — wake the display and " +
    "discover again), no_window_matches_title, title_matches_nothing_readable (a window has the title but nothing under it can be acted on " +
    "or read: a panel drawn by another process, or the app names the window otherwise in Accessibility — omit target to read the frontmost " +
    "app, or use the title of the window that holds it), title_matches_several_sheets (sheets of several documents carry the title: " +
    "discover each document by its own title), window_titles_unavailable (Screen Recording is not granted, so titles cannot be matched; " +
    "omit target to read the frontmost app), no_frontmost_app, truncated:*, ax_error:*, sheet_open (answer the sheet first; acts behind it " +
    "are refused), sheet_open_in_other_process (the sheet's controls belong to another process, e.g. the open/save panel: discover its " +
    "own title, such as \"Save\" / \"保存\").",
  prefer:
    "Discover right before each act: a lease names the element as read, and an act on an element that moved is refused. " +
    "next:'refresh_view' after an act is advice (the view changed): other leases from the same discover still work while their elements are unchanged.",
  caveats: "Needs Accessibility permission (PermissionRequired otherwise). Window titles need Screen Recording.",
});

export const macActDescription = buildDesc({
  purpose: "Act on an entity from desktop_discover: press it, replace a text field's value, or append to it (append: true).",
  details:
    "Acts through Accessibility on the background app — the foreground is not taken. An element whose place among its siblings changed " +
    "(one before it came or went) is found again. Refused with entity_not_found when the element's window changed since the discover, or " +
    "the element is gone or no longer what was read (nothing was done; discover again), and action_not_offered when the entity does not " +
    "offer the action (type on a button, click on a text), and modal_blocking when a sheet or an app-modal window is open over it " +
    "(answer that first). value_not_applied: the app took the write but the field does not hold the text " +
    "(it may reformat it, e.g. 1.50 shown as 1.5). A sheet or app-modal window is checked at the act itself, so one that opened after " +
    "the discover still refuses.",
  prefer:
    "Send acts one at a time: each act can change the view, so acts sent together can refuse each other (entity_not_found; nothing was done). " +
    "Call desktop_state or desktop_discover afterwards to confirm. A write changes the field, not the file: saving is not done or reported.",
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
  /** desktop_act `append: true` for the act in progress (acts run one at a time). */
  append?: boolean;
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
      insertText: (t, text, at) => mac.macAxInsertText(t, text, at),
      appendMode: () => state.append === true,
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
  // The schema promises raw rects for view:"debug"; the facade adds them only for `debug`.
  const output = await facade.see(input.view === "debug" ? { ...input, debug: true } : input);
  const notes = state.last as MacAxReadNotes | undefined;
  const warnings = [...((output as { warnings?: string[] }).warnings ?? []), ...(notes?.warnings ?? [])];
  const values = notes?.values ?? {};
  const truncated = new Set(notes?.truncated ?? []);
  const entities = output.entities.map((e) =>
    values[e.entityId] !== undefined
      ? { ...e, value: values[e.entityId] }
      : truncated.has(e.entityId)
        ? { ...e, valueTruncated: true }
        : e
  );
  return ok({
    ...output,
    entities,
    ...(warnings.length > 0 && { warnings }),
    ...(notes?.appTitle !== undefined && { app: { title: notes.appTitle, pid: notes.pid } }),
  });
}

export function macActHandler(
  mac: NativeMac,
  facade: DesktopFacade,
  state: MacFacadeState,
  input: { lease: unknown; action?: string; text?: string; append?: boolean }
): Promise<ToolResult> {
  return serialise(() => macActOnce(mac, facade, state, input));
}

async function macActOnce(
  mac: NativeMac,
  facade: DesktopFacade,
  state: MacFacadeState,
  input: { lease: unknown; action?: string; text?: string; append?: boolean }
): Promise<ToolResult> {
  const denied = permissionGate(mac, "desktop_act");
  if (denied) return denied;
  if ((input.action === "type" || input.action === "setValue") && input.text === undefined) {
    return failCode("InvalidArgs", `desktop_act: action='${input.action}' requires text`, {
      suggest: getSuggestsForCode("InvalidArgs"),
    });
  }
  state.phase = "act";
  state.last = undefined;
  state.append = input.append === true;
  const { append: _append, ...touchInput } = input;
  let result;
  try {
    result = await facade.touch(touchInput as Parameters<DesktopFacade["touch"]>[0]);
  } finally {
    state.append = false;
  }
  return ok(qualifyPostRead(result, state.last));
}

/** Warnings that mean the read after the act did not see the app whole. */
const INCOMPLETE_READ = /^(ax_error:|display_asleep$|ax_self_reference$|truncated:|no_window_matches_title$|window_titles_unavailable$|no_frontmost_app$)/;

/**
 * The touch loop diffs the read after the act against the discover. When that read was
 * incomplete (an AX error, a sleeping display, a cut-off walk), what it did not see is not
 * gone: drop `entity_disappeared` and say why (codex, #780). Reads fail open; the act's own
 * result stands.
 */
export function qualifyPostRead<T extends { diff?: string[] }>(result: T, post: MacAxReadNotes | undefined): T {
  const warnings = (post?.warnings ?? []).filter((w) => INCOMPLETE_READ.test(w));
  if (warnings.length === 0) return result;
  return {
    ...result,
    ...(result.diff !== undefined && { diff: result.diff.filter((d) => d !== "entity_disappeared") }),
    postReadWarnings: warnings,
  };
}
