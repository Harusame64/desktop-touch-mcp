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
import { readMacAxCandidates, UNSURE_READ, windowIdOf, type MacAxReadNotes } from "./ax-provider.js";
import { createMacAxExecutor } from "./ax-executor.js";

export const macDiscoverSchema = {
  target: z
    .object({
      windowTitle: z.string().optional(),
      windowId: z.number().int().positive().max(0xffff_ffff).optional(),
    })
    .optional()
    .describe(
      "Target window by title (case-insensitive substring; titles are in the user's language — desktop_state lists them) or by windowId (from desktop_state windows[] or screenshot), not both. " +
        "A windowId (a sheet has its own) keeps naming the same window when the app retitles it (TextEdit naming a new document after its first line, a Finder window moved to another folder). Omit for the frontmost app."
    ),
  view: z.enum(["action", "explore", "debug"]).optional().describe("action (default, ≤20 entities), explore (≤50), debug (includes raw rect)"),
  query: z.string().optional().describe("Filter entities by label substring (case-insensitive). Labels only: a text field without a label never matches, so look for role 'textbox' instead."),
  maxEntities: z.number().int().min(1).max(200).optional().describe("Override entity count limit"),
  debug: coercedBoolean().optional().describe("Include raw screen coordinates in response"),
  menuBar: coercedBoolean()
    .optional()
    .describe(
      "Also list the app's menu bar items (not the Apple menu), each labelled by its path such as '表示 > 科学計算', role menuitem, pressed with desktop_act click without bringing the app forward. Use it when a button that opens a menu answers ok but no menu appears, or for a command only the menu bar has. Combine with query (e.g. '表示 >') and view:'explore': a menu bar has hundreds of items listed after the window's controls, so without a query the default view may show none of them, and reading it adds up to about 2 s in a large app (Safari). Refused with modal_blocking while the app's front window has a sheet open."
    ),
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
    .describe("'click'/'invoke'/'auto' press the element (only one that offers it); 'invoke' on a listitem (a Finder sidebar entry) opens it, and 'auto' never does. 'type' and 'setValue' REPLACE the field's whole value with text — to add text, use append: true instead of resending the old text (a long field's value from desktop_discover is cut: valueTruncated)."),
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
    "(button/textbox/link/menuitem/listitem/label), primaryAction, and — for a text field — its current value (never a password field's; " +
    "longer than 2000 characters: no value, valueTruncated: true), and the state of a control read as a button: a checkbox or " +
    "radio button gives value '1' on, '0' off, '2' mixed (a tab: '1' is the selected tab), a disclosure triangle '1' expanded, " +
    "'0' collapsed, and a pop-up the text it shows (the chosen option; a pull-down menu shows its title); " +
    "buttons offer click, settable text fields offer type, texts only read. A file name shown as a field (a Finder list) is a label: writing it would rename nothing. " +
    "A Finder sidebar entry is a listitem named by its text, offering invoke only: invoke moves the window to that place (an entry whose name another entry shows is not offered). Each lease carries expiresAtMs (its life adapts to the view and to how long you take between calls); after it, desktop_act answers lease_expired. " +
    "'warnings' says what the read could not do: display_asleep (macOS then answers windows with the app itself — wake the display and " +
    "discover again), no_window_matches_title, title_matches_nothing_readable (a window has the title but nothing under it can be acted on " +
    "or read: a panel drawn by another process, or the app names the window otherwise in Accessibility — omit target to read the frontmost " +
    "app, or use the title of the window that holds it), title_matches_several_sheets (sheets of several documents carry the title: " +
    "discover each document by its own title), window_titles_unavailable (Screen Recording is not granted, so titles cannot be matched; " +
    "omit target to read the frontmost app), no_window_with_id (no app window has that id: it was closed, or the id is not an app window's — desktop_state lists the windows on screen), " +
    "window_id_not_in_tree (the window is on screen but the app's Accessibility tree did not show it: discover again, or target it by title), " +
    "window_not_shown (the window is off screen and Accessibility does not show it: it was closed — an app can keep a closed sheet's window — or it is on another Space), " +
    "ax_error:window_id_unsupported (this macOS cannot look windows up by id: target by title). The open/save panel's own window belongs to another process: target it by title (\"保存\" / \"Save\"). no_frontmost_app, truncated:*, ax_error:*, ax_read_incomplete (part of the tree did not answer: discover again), sheet_open (answer the sheet first; acts behind it " +
    "are refused), sheet_open_in_other_process (the sheet's controls belong to another process, e.g. the open/save panel: discover its " +
    "own title, such as \"Save\" / \"保存\").",
  prefer:
    "Discover right before each act: a lease names the element as read, and an act on an element that moved is refused. " +
    "next:'refresh_view' after an act is advice (the view changed): other leases from the same discover still work while their elements are unchanged.",
  caveats: "Needs Accessibility permission (PermissionRequired otherwise). Window titles need Screen Recording.",
});

export const macActDescription = buildDesc({
  purpose: "Act on an entity from desktop_discover: press it, open a list item (invoke), replace a text field's value, or append to it (append: true).",
  details:
    "Acts through Accessibility on the background app — the foreground is not taken. An element whose place among its siblings changed " +
    "(one before it came or went) is found again. Refused with entity_not_found when the element's window changed since the discover, or " +
    "the element is gone or no longer what was read (nothing was done; discover again) — a window the app retitled counts as changed, " +
    "so after an act that retitles it (TextEdit autosave naming a document) discover again, by windowId to keep the same window — and action_not_offered when the entity does not " +
    "offer the action (type on a button, click on a text), and modal_blocking when a sheet or an app-modal window is open over it " +
    "(answer that first). value_not_applied: the app took the write but the field does not hold the text " +
    "(it may reformat it, e.g. 1.50 shown as 1.5). A web page's text field without the focus that ignored the write is pressed once " +
    "(focusing it, without bringing the app forward) and written again. A sheet or app-modal window is checked at the act itself, so one that opened after " +
    "the discover still refuses. invoke on a listitem (a Finder sidebar entry) opens it; auto and click never do — ask for invoke. " +
    "Just before opening, the entry is checked to be the one named; another is refused (entity_not_found, nothing was done). An open answers " +
    "open: { confirmed } and next: refresh_view, and diff does not show it — the window is retitled, so discover again by its windowId (desktop_state windows[]), without a target or " +
    "by the new title. Finder answers an error even when it opened: the act then answers ok with open.confirmed: false. Any other error after the open was sent says it may have opened.",
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
  /** The discover in progress asked for the menu bar (`menuBar: true`). */
  discoverMenuBar?: boolean;
  /**
   * The menu bar items each view read with the menu bar offered (view id -> entity ids), newest
   * last. The touch loop reads the target again for an act and passes only the target, so an act
   * on one of these leases reads the menu bar again: its element is not in a read without it.
   * Only these: an act on the window's own controls from such a view pays nothing for the bar.
   */
  menuBarViews?: [string, string[]][];
  /** The act in progress is on a menu bar item's lease. */
  actMenuBar?: boolean;
  /** The act in progress carried out an open (internal #259): confirmed by the app or not, for `open`. */
  openNote?: { confirmed: boolean; why?: string };
}

/** How many views read with the menu bar are remembered for their acts. */
const MENU_BAR_VIEWS_KEPT = 32;

export function createMacFacade(mac: NativeMac, state: MacFacadeState): DesktopFacade {
  const provider = async (input: DesktopSeeInput) => {
    const notes: MacAxReadNotes = { warnings: [] };
    state.last = notes;
    const target = input.target as { windowTitle?: string; macWindowId?: string } | undefined;
    const untargeted = (target?.windowTitle === undefined || target.windowTitle === "") && windowIdOf(target) === undefined;
    const candidates = await readMacAxCandidates(
      {
        listWindows: (onScreenOnly) => mac.macListWindows(onScreenOnly),
        getFocus: () => mac.macGetFocus(),
        axTree: (opts) => mac.macAxTree(opts),
        now: () => Date.now(),
      },
      target,
      notes,
      untargeted && state.phase === "act" ? state.noTargetPid : undefined,
      state.phase === "act" ? state.actMenuBar === true : state.discoverMenuBar === true
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
      noteOpen: (note) => {
        state.openNote = note;
      },
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
  input: DesktopSeeInput & { menuBar?: boolean }
): Promise<ToolResult> {
  return serialise(() => macDiscoverOnce(mac, facade, state, input));
}

async function macDiscoverOnce(
  mac: NativeMac,
  facade: DesktopFacade,
  state: MacFacadeState,
  input: DesktopSeeInput & { menuBar?: boolean }
): Promise<ToolResult> {
  const denied = permissionGate(mac, "desktop_discover");
  if (denied) return denied;
  const asked = input.target as { windowTitle?: string; windowId?: number } | undefined;
  const windowId = asked?.windowId;
  if (windowId !== undefined && asked?.windowTitle !== undefined && asked.windowTitle !== "") {
    return failCode("InvalidArgs", "desktop_discover: pass target.windowTitle or target.windowId, not both.", {
      suggest: ["Pass target.windowId alone: it names the window whatever it is titled now."],
    });
  }
  state.last = undefined;
  state.phase = "discover";
  const { menuBar, ...rest } = input;
  // The facade keys its sessions by target: a window id goes in as `macWindowId`, so the session, and
  // the read after an act, stay on the window by its id (`windowIdOf`, ax-provider.ts). Not as an
  // hwnd: the facade reads an hwnd as a Win32 handle (its identity, its UIA cache; gate 2 on #928).
  const seeInput = windowId !== undefined ? { ...rest, target: { macWindowId: String(windowId) } } : rest;
  state.discoverMenuBar = menuBar === true;
  // The schema promises raw rects for view:"debug"; the facade adds them only for `debug`.
  let output;
  try {
    output = await facade.see(seeInput.view === "debug" ? { ...seeInput, debug: true } : seeInput);
  } finally {
    state.discoverMenuBar = false;
  }
  const notes = state.last as MacAxReadNotes | undefined;
  const menuIds = notes?.menuEntityIds ?? [];
  if (menuIds.length > 0) {
    state.menuBarViews = [
      ...(state.menuBarViews ?? []).filter(([v]) => v !== output.viewId),
      [output.viewId, menuIds] as [string, string[]],
    ].slice(-MENU_BAR_VIEWS_KEPT);
  }
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
    // By id, the facade has only the number to call the window by: the title is the one read now,
    // and empty when no window was read (the number is not a title; internal #211 item 5).
    ...(windowId !== undefined && {
      target: { ...output.target, title: notes?.windowTitle ?? "", windowId },
    }),
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
  state.openNote = undefined;
  const lease = input.lease as { viewId?: unknown; entityId?: unknown } | null | undefined;
  state.actMenuBar = (state.menuBarViews ?? []).some(
    ([v, ids]) => v === lease?.viewId && typeof lease?.entityId === "string" && ids.includes(lease.entityId)
  );
  const { append: _append, ...touchInput } = input;
  let result;
  try {
    result = await facade.touch(touchInput as Parameters<DesktopFacade["touch"]>[0]);
  } finally {
    state.append = false;
    state.actMenuBar = false;
  }
  const note = state.openNote;
  state.openNote = undefined;
  const qualified = qualifyPostRead(result, state.last);
  // After an open, discover again whatever the diff says, confirmed or not: the window is retitled,
  // so the read after the act may not have seen it at all (gate 2 on #927).
  return ok(note !== undefined && qualified.ok === true ? { ...qualified, next: "refresh_view", open: note } : qualified);
}

/**
 * Warnings that mean the read after the act did not see the app whole. Not `no_window_with_id`: a
 * title can be gone because the window was retitled, but a window id that is gone is a window the act
 * closed, so its entities did disappear (gate 2 on #928). `window_not_shown` stays unsure (it is in
 * `UNSURE_READ`): a sheet closed by キャンセル looks like that, but so does a window the act moved to
 * another Space (full screen), which is still open (gate 2 on #928, round 3).
 */
const INCOMPLETE_READ = {
  test: (w: string) => UNSURE_READ.test(w) || /^(no_window_matches_title|window_titles_unavailable|no_frontmost_app)$/.test(w),
};

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
