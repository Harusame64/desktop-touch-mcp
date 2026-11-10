/**
 * Mac port M2-2: desktop_discover candidates from macOS Accessibility.
 *
 * Reads one app's AX tree (`macAxTree`) and turns the elements a caller can
 * name or act on into `UiEntityCandidate`s with `source: "ax"`. Each carries
 * `locator.ax` — the child-index path plus the root and element keys read
 * here — which the executor hands back so the native act refuses when the
 * path now names another window or another element (src/macos/ax.rs).
 *
 * The target is a window title (substring, as on Windows) or, without one,
 * the frontmost app. A password field's value is never put on a candidate.
 */

import type { NativeMacAxElement, NativeMacAxTree, NativeMacFocus, NativeMacWindow } from "../../engine/native-types.js";
import { createHash } from "node:crypto";

import type { UiEntityCandidate } from "../../engine/vision-gpu/types.js";

export interface MacAxProviderDeps {
  listWindows(onScreenOnly?: boolean): NativeMacWindow[];
  getFocus(): Promise<NativeMacFocus>;
  axTree(opts: { pid: number; maxElements?: number; includeMenuBar?: boolean; windowId?: number }): Promise<NativeMacAxTree>;
  now(): number;
}

/** What the read could not do, for the tool to say beside the entities. */
export interface MacAxReadNotes {
  warnings: string[];
  /**
   * The current value of each text field read, by entity id (`ent_` + digest). The shared entity
   * view carries no value, and `type` replaces the whole value, so without it a caller could not
   * add to a field without guessing its text (dogfood 2026-10-04: it read the text off a screenshot).
   * Never a password field's (the candidate has no value then). Also a checkbox's, radio button's,
   * disclosure triangle's or pop-up's state (`stateText`; internal #262): read-only, not text to edit.
   */
  values?: Record<string, string>;
  /** Entity ids of text fields (or state controls) whose value is longer than the read cap (no value is given for them). */
  truncated?: string[];
  pid?: number;
  appTitle?: string;
  /** Entity ids of the menu bar items offered (`menuBar`): an act on one reads the menu bar again. */
  menuEntityIds?: string[];
  /** A read by window id: the title that window carries now (internal #265). */
  windowTitle?: string;
}

/**
 * The window a target names by id (internal #265). The Mac tool hands a `windowId` to the facade as
 * `macWindowId` (the facade keys its sessions by target, and an hwnd would be read as a Win32
 * handle), and it comes back here as the CGWindowID it is.
 */
export function windowIdOf(target: { macWindowId?: string } | undefined): number | undefined {
  const raw = target?.macWindowId;
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return undefined;
  const id = Number(raw);
  // A CGWindowID is a u32 (agy on #928).
  return Number.isSafeInteger(id) && id <= 0xffff_ffff ? id : undefined;
}

/**
 * The roles the resolver understands (`button`, `textbox`, `link`, `menuitem`, `listitem`, `label`).
 *
 * A `listitem` is a Finder sidebar entry marked by `nameOpenableCells` (`opensAsItem`; internal
 * #259). Any other cell reads as before.
 *
 * A text field that stands for a file (a Finder name cell: it carries `AXFilename`) is a label.
 * Its value is settable, but a write changes only what the window shows — the file keeps its
 * name until the window is reopened — so offering `type` there let an agent report a rename
 * that never happened (internal #256). Finder's own rename editor, opened with Return, carries
 * no `AXFilename` and stays a textbox.
 */
export function roleOf(e: Pick<MacReadElement, "role" | "subrole" | "namesFile" | "opensItem">): string {
  if (e.namesFile === true) return "label";
  if (opensAsItem(e)) return "listitem";
  switch (e.role) {
    case "AXButton":
    case "AXPopUpButton":
    case "AXMenuButton":
    case "AXCheckBox":
    case "AXRadioButton":
    case "AXDisclosureTriangle":
      return "button";
    case "AXTextField":
    case "AXTextArea":
    case "AXComboBox":
    case "AXSearchField":
      return "textbox";
    case "AXLink":
      return "link";
    case "AXMenuItem":
    case "AXMenuBarItem":
      return "menuitem";
    case "AXStaticText":
      return "label";
    default:
      return "unknown";
  }
}

const SECURE = "AXSecureTextField";

/**
 * internal #259 — an element `nameOpenableCells` marked as a list item that opens: a Finder sidebar
 * entry. Only marked ones: any other cell reads as it did before (gate 2 on #927).
 */
export type MacReadElement = NativeMacAxElement & { opensItem?: true };
export function opensAsItem(e: { opensItem?: true }): boolean {
  return e.opensItem === true;
}

/**
 * Controls read as a button whose AXValue is their state (internal #262: Safari's web checkbox and
 * select came back with none — AX carried "1" and "緑", measured 2026-11-10). A toggle — checkbox,
 * radio button (an AppKit tab too: 1 is the selected tab), disclosure triangle (1 expanded) — says
 * "1"/"0"/"2" (on/off/mixed); a pop-up says the text it shows (the chosen option; a pull-down shows
 * its title). The one place that decides which roles carry state.
 */
const TOGGLE_CONTROLS = new Set(["AXCheckBox", "AXRadioButton", "AXDisclosureTriangle"]);
export function carriesState(axRole: string): boolean {
  return TOGGLE_CONTROLS.has(axRole) || axRole === "AXPopUpButton";
}

/**
 * The state as a caller reads it. The native read prints a CFBoolean value as "true"/"false" (an
 * app may answer a toggle with a boolean rather than a number: gate 2 on #926), which a caller told
 * "1 on" would read as off — a toggle says 1/0 whichever way the app answered.
 */
export function stateText(axRole: string, value: string): string {
  if (!TOGGLE_CONTROLS.has(axRole)) return value;
  return value === "true" ? "1" : value === "false" ? "0" : value;
}

/** The verbs the element itself offers: press only when it advertises AXPress. */
export function actionabilityOf(e: MacReadElement): UiEntityCandidate["actionability"] {
  const verbs: UiEntityCandidate["actionability"] = [];
  // A cell that opens (internal #259): `invoke` alone, as a Windows list item's Invoke opens it.
  // Never `click` — that would read as a press, and the cell has none.
  if (opensAsItem(e)) return ["invoke"];
  if (e.actions.includes("AXPress")) verbs.push("click", "invoke");
  if (e.valueSettable && e.subrole !== SECURE && roleOf(e) === "textbox") verbs.push("type");
  if (roleOf(e) === "label") verbs.push("read");
  return verbs;
}

/**
 * The name a caller sees. A static text's visible text is its AXValue (its
 * description is a spoken hint, e.g. Calculator's display says "最後の式"),
 * so a label is named by its value first — as a Windows static text is named
 * by the text it shows.
 */
/**
 * The title bar's buttons carry no title or description, only a subrole, so they came out as
 * nameless "button"s — and a caller pressing a nameless button closed a document (2026-10-04, the
 * sheet measurement). Name them by what they do.
 */
/** What AppKit calls these buttons in English: the same thing as WINDOW_BUTTONS, not a second name. */
const ENGLISH_ROLE_DESCRIPTIONS = new Set(["close button", "minimize button", "zoom button", "full screen button"]);

/** The subroles here are the ones src/macos/ax.rs reads `roleDescription` for: change both together. */
const WINDOW_BUTTONS: Record<string, string> = {
  AXCloseButton: "Close window",
  AXMinimizeButton: "Minimize window",
  AXFullScreenButton: "Full screen",
  AXZoomButton: "Zoom window",
};

function labelOf(e: MacReadElement): string | undefined {
  // A list item carries the text it holds as its value (`nameOpenableCells`).
  if ((roleOf(e) === "label" || roleOf(e) === "listitem") && e.value) return e.value;
  if (e.title) return e.title;
  if (e.description) return e.description;
  if (e.subrole !== undefined && WINDOW_BUTTONS[e.subrole] !== undefined) {
    // In the app's language first, as every other control is named, so a query such as "閉じる"
    // finds it; the English name stays beside it for callers that look for that (internal #264).
    // An app running in English names it "close button": that adds nothing (gate 2 on #911).
    const english = WINDOW_BUTTONS[e.subrole];
    const own = e.roleDescription?.trim();
    return own && !ENGLISH_ROLE_DESCRIPTIONS.has(own.toLowerCase()) ? `${own} (${english})` : english;
  }
  return undefined;
}

/** Elements worth handing to a caller: something to act on, or a named label. */
export function isCandidate(e: MacReadElement): boolean {
  if (e.enabled === false) return false;
  const verbs = actionabilityOf(e);
  if (verbs.some((v) => v !== "read")) return true;
  return verbs.includes("read") && labelOf(e) !== undefined;
}

/**
 * internal #259 — Finder's sidebar entries, as list items that open. A sidebar entry is an
 * AXOutline > AXRow > AXCell; the row has no AXPress, and the cell advertises AXOpen (alone), which
 * moves the window to that place (measured 2026-11-10, macOS 27.2: デスクトップ / ダウンロード / 書類,
 * 5 of 5 with a folder row). The cell has no title, so it is named by its first child static text —
 * the rule `item_name` (src/macos/ax.rs) checks at the act: change both together — and the name
 * is part of its identity (`kindOf`).
 *
 * Only these (gate 2 on #927, three rounds, narrowed rather than patched):
 *   - **Finder only.** Its answer to AXOpen (`attribute_unsupported` though it opened) was measured
 *     there; another app's cell is not offered.
 *   - **A static text name only**, which is what a sidebar entry holds. A list row is named by a
 *     file-name field and opens a file in its app; two rows can show the same name (README.md in two
 *     folders), so a shown name does not tell them apart. Rows are left for a read that carries the
 *     item's URL.
 *   - **A name no other entry in the window shows.** Two volumes named "Untitled" are not offered:
 *     the name could not tell them apart at the act.
 *   - **A read not cut short.** One cut short may have missed a twin. One with a part unread is
 *     usual for Finder (`ax_read_incomplete` on every read, 2026-11-10), so the act itself counts the
 *     name in the list (`only_item_named`, src/macos/ax.rs) and refuses unless it names one entry.
 * The name is the cell's **first** static text child: when its value is missing, empty or cut, the
 * entry has no name — never the next text, which the act's read would not agree on.
 * The text an entry is named by is not offered beside it (`namedBy`: child id -> cell id). One pass.
 *
 * Measured 2026-11-10 (macOS 27.2) in Finder's list, column, icon and gallery views: the only AXCells
 * with AXOpen and a static text child are the sidebar's (20 per window); the content's items are a
 * cell holding a file-name field (list), an AXGroup (column) or an AXImage (icon, gallery).
 */
export function nameOpenableCells(
  elements: readonly NativeMacAxElement[],
  appTitle: string | undefined,
  readWhole = true
): { elements: MacReadElement[]; namedBy: Map<string, string> } {
  if (appTitle !== "Finder" || !readWhole) return { elements: [...elements], namedBy: new Map() };
  const parentOf = (id: string) => id.slice(0, id.lastIndexOf("."));
  const cells = new Map(
    elements
      .filter((e) => e.role === "AXCell" && e.actions.includes("AXOpen") && !e.actions.includes("AXPress"))
      .map((e) => [e.id, e])
  );
  const names = new Map<string, { value: string; child: string }>();
  const firstTextSeen = new Set<string>();
  for (const e of elements) {
    const parent = parentOf(e.id);
    if (!cells.has(parent) || e.role !== "AXStaticText" || firstTextSeen.has(parent)) continue;
    firstTextSeen.add(parent);
    if (e.value === undefined || e.value === "" || e.valueTruncated) continue;
    names.set(parent, { value: e.value, child: e.id });
  }
  // Within a window, a name shown by two entries names neither.
  const seen = new Map<string, number>();
  for (const [cell, n] of names) {
    const k = `${cells.get(cell)!.rootKey}\u001f${n.value}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [cell, n] of [...names]) {
    if ((seen.get(`${cells.get(cell)!.rootKey}\u001f${n.value}`) ?? 0) > 1) names.delete(cell);
  }
  const namedBy = new Map([...names.entries()].map(([cell, n]) => [n.child, cell]));
  return {
    elements: elements.map((e) => {
      const n = names.get(e.id);
      return n === undefined ? e : { ...e, value: n.value, opensItem: true as const };
    }),
    namedBy,
  };
}

/** What an element is under its window: role, element key, and a text's shown value. */
function kindOf(e: Pick<MacReadElement, "rootKey" | "elementKey" | "role" | "subrole" | "value" | "namesFile" | "opensItem">): string {
  // A text is named by what it shows, so what it shows is part of what it is: when Calculator's
  // display changes, the post-act diff must see a different entity (codex, #780). Texts are only
  // read, never leased for an act, so a changing identity costs nothing there. A list item is
  // named by the item it holds: a row that now holds another item is another entity, and the lease
  // for the old one is refused rather than opening the new one (gate 2 on #927).
  const r = roleOf(e);
  const shown = r === "label" || r === "listitem" ? `|${e.value ?? ""}` : "";
  return `${e.rootKey}|${e.role}|${e.elementKey}${shown}`;
}

/**
 * The candidate's identity (the resolver's key, the entityId and the lease's evidence digest):
 * the app and what the element is under its window — not the label and rect the resolver falls
 * back to, which two distinct AX elements can share (same title, no frame), and would then be
 * merged into one entity carrying one element's verbs and the other's locator (codex gate 1, #780).
 * The value is left out, so typing into a field does not change its identity.
 *
 * Not the path, for an element that is the only one of its kind under its window (internal #260):
 * a sibling coming or going before it shifts its path while it stays what it was (Calculator's All
 * Clear drops every button's index by one), and the native act finds it again by its keys
 * (`relocate`, src/macos/ax.rs). Elements alike but for their position keep the path as before
 * (`unique: false`, `sortOf`): told apart by order instead, one would take the other's identity
 * when an earlier one went (gate 2 on #802); by frame, one could take the other's place (#270).
 */
export function axDigest(
  pid: number,
  e: Pick<MacReadElement, "id" | "rootKey" | "elementKey" | "role" | "subrole" | "value" | "namesFile" | "opensItem">,
  unique = true
): string {
  const where = unique ? "" : `|${e.id}`;
  return createHash("sha1").update(`ax|${pid}|${kindOf(e)}${where}`).digest("hex").slice(0, 16);
}

/**
 * Whether each element (by its path in this read) is the only one of its kind under its window.
 * A read cut short (`truncated`), or one where some element's children or identity could not be
 * read (`readIncomplete`), cannot say: a twin may lie past the cut, under that element, or read as
 * different through a failed attribute, and the act would then find it as the only one left and
 * press it for the other's lease (codex on #802).
 * None is.
 */
/**
 * internal #271 — the elements that have an alike one in this read (by `sortOf`): the ones another
 * element can come to stand in for. Not "not unique": a read that is not whole marks nothing unique
 * (Finder's always is), and a sibling check on every element of such a read would refuse acts that
 * main made, whenever a read near them failed or changed (gate 2 on #930).
 */
function withTwinSeen(elements: readonly NativeMacAxElement[]): Set<string> {
  const sorts = elements.map(sortOf);
  const count = new Map<string, number>();
  for (const k of sorts) count.set(k, (count.get(k) ?? 0) + 1);
  return new Set(elements.filter((_, i) => count.get(sorts[i]!)! > 1).map((e) => e.id));
}

function uniquenessOf(elements: readonly NativeMacAxElement[], truncated: boolean): Map<string, boolean> {
  const sorts = elements.map(sortOf);
  const count = new Map<string, number>();
  for (const k of sorts) count.set(k, (count.get(k) ?? 0) + 1);
  return new Map(elements.map((e, i) => [e.id, !truncated && count.get(sorts[i]!) === 1]));
}

/**
 * What an element is apart from where it is: its window, role, and the element key's fields but
 * the frame — subrole, identifier, title, description, read from the element rather than cut out
 * of the joined key. Controls alike but for their position — a "Delete" button in each row of a
 * list — are then not unique, though their keys differ: counted by the frame, the leased row's
 * button could go and another row's reflow into its place, and the act would find that one as the
 * only match and press it (internal #270, codex on #802). The native act counts the same way
 * (`without_frame`, src/macos/ax.rs). The cost: unnamed controls that differ only by position
 * (two unlabelled text fields) are not looked for where they moved, and keep the path in their
 * identity.
 */
function sortOf(e: NativeMacAxElement): string {
  const shown = roleOf(e) === "label" ? `|${e.value ?? ""}` : "";
  const fields = [e.subrole, e.identifier, e.title, e.description].map((f) => f ?? "").join("\u001f");
  return `${e.rootKey}|${e.role}|${fields}${shown}`;
}

/** How many siblings on each side `siblingSignature` holds (`SIBLINGS_EACH_SIDE`, src/macos/ax.rs). */
export const SIBLINGS_EACH_SIDE = 3;

/**
 * internal #271 — an element's siblings around it (`SIBLINGS_EACH_SIDE` on each side of it, itself
 * among them, in order) as the native act reads them now (`sibling_entry` / `siblings_now`,
 * src/macos/ax.rs; the two must agree character for character): role, title, description, and a
 * static text's value. Safari flattens a list's rows into one parent, so a row's name sits next to
 * its Delete button; when the rows are groups, each row's children differ by its name. `undefined`
 * when the read does not hold every sibling in that span (by index, against the parent's
 * `childCount`), or for a root: then nothing is compared.
 */
export function siblingSignature(e: NativeMacAxElement, byId: Map<string, NativeMacAxElement>): string | undefined {
  const cut = e.id.lastIndexOf(".");
  if (e.depth === 0 || cut < 0) return undefined;
  const parentId = e.id.slice(0, cut);
  const parent = byId.get(parentId);
  const at = Number(e.id.slice(cut + 1));
  if (parent === undefined || !Number.isInteger(at) || at >= parent.childCount) return undefined;
  const from = Math.max(0, at - SIBLINGS_EACH_SIDE);
  const to = Math.min(parent.childCount, at + SIBLINGS_EACH_SIDE + 1);
  const span: NativeMacAxElement[] = [];
  for (let i = from; i < to; i++) {
    const k = byId.get(`${parentId}.${i}`);
    if (k === undefined) return undefined;
    span.push(k);
  }
  return span
    .map((k) => {
      const value = k.role === "AXStaticText" ? (k.value ?? "") : "";
      return `${k.role}\u001f${k.title ?? ""}\u001f${k.description ?? ""}\u001f${value}`;
    })
    .join("\u001e");
}

export function toCandidate(
  e: MacReadElement,
  pid: number,
  targetId: string,
  observedAtMs: number,
  unique = true,
  /** A menu item's path ("表示 > 科学計算"), named in place of its own title. */
  labelOverride?: string,
  /** internal #271 — for an element that is not unique: its siblings as read (`siblingSignature`). */
  siblings?: string
): UiEntityCandidate {
  const label = labelOverride ?? labelOf(e);
  const secure = e.subrole === SECURE;
  return {
    source: "ax",
    target: { kind: "window", id: targetId },
    role: roleOf(e),
    ...(label !== undefined && { label }),
    // A cut value is not the field's text; it is left out rather than offered as if it were (codex, #782).
    ...(!secure && roleOf(e) !== "label" && roleOf(e) !== "listitem" && e.value !== undefined && !e.valueTruncated && { value: e.value }),
    ...(e.frame !== undefined && { rect: { x: e.frame.x, y: e.frame.y, width: e.frame.width, height: e.frame.height } }),
    actionability: actionabilityOf(e),
    controlType: e.role,
    patterns: e.actions,
    confidence: 0.9,
    observedAtMs,
    status: "observed",
    digest: axDigest(pid, e, unique),
    locator: {
      ax: { pid, id: e.id, role: e.role, rootKey: e.rootKey, elementKey: e.elementKey, unique, ...(!unique && siblings !== undefined && { siblings }) },
    },
  };
}

/**
 * The app's menu bar items a caller can press, each named by its path ("表示 > 科学計算"), by id.
 *
 * A control that opens a menu inside a window may answer AXPress without opening it (Calculator's
 * モード button, a SwiftUI menu: `ok` and nothing on screen, internal #258), and a menu opened on
 * screen lives outside the window. The same choices sit in the menu bar, whose items take AXPress
 * with the app in the background (measured 2026-11-09: 表示 > 科学計算 switched Calculator's mode
 * while Finder stayed in front). Only enabled leaves: a menu bar title or a submenu opens a menu on
 * screen and does nothing a caller can read. The Apple menu is the system's, not the app's — Shut
 * Down and Log Out live there — so it is left out. Returns the bar's id with them.
 */
export function menuBarItems(elements: readonly NativeMacAxElement[]): { barId?: string; items: Map<string, string> } {
  const items = new Map<string, string>();
  const bar = elements.find((e) => e.role === "AXMenuBar" && e.depth === 0);
  if (bar === undefined) return { items };
  const byId = new Map(elements.map((e) => [e.id, e]));
  // The Apple menu is the bar's first item and is titled "Apple"; either is enough to leave it out,
  // so a bar that does not start with it does not hand it over by position.
  const apples = elements
    .filter((e) => e.role === "AXMenuBarItem" && (e.id === `${bar.id}.0` || e.title === "Apple"))
    .map((e) => e.id);
  for (const e of elements) {
    if (e.role !== "AXMenuItem" || !e.id.startsWith(`${bar.id}.`)) continue;
    if (apples.some((a) => e.id.startsWith(`${a}.`))) continue;
    if (e.childCount > 0 || !e.actions.includes("AXPress") || !e.title || e.enabled === false) continue;
    const names: string[] = [];
    for (let id = e.id; id !== bar.id && id.includes("."); id = id.slice(0, id.lastIndexOf("."))) {
      const a = byId.get(id);
      if (a !== undefined && (a.role === "AXMenuItem" || a.role === "AXMenuBarItem") && a.title) names.unshift(a.title);
    }
    items.set(e.id, names.join(" > "));
  }
  return { barId: bar.id, items };
}

/** The read's element cap with the menu bar (the native default, 3000, is the window's). */
const MAX_ELEMENTS_WITH_MENU_BAR = 6000;

/** The window's title as the root key carries it (title, then U+001F). */
function rootTitle(rootKey: string): string {
  return rootKey.split("\u001f")[0] ?? "";
}

/**
 * Read candidates for a target. `notes` collects what the read could not do
 * (no such window, display asleep, an AX error) so the tool can say it;
 * reads fail open, so these never throw for an unreadable app.
 */
export async function readMacAxCandidates(
  deps: MacAxProviderDeps,
  target: { windowTitle?: string; macWindowId?: string } | undefined,
  notes: MacAxReadNotes,
  /** Without a title: read this app instead of asking which is frontmost (a post-act read). */
  pinnedPid?: number,
  /** Also offer the app's menu bar items (`menuBarItems`). */
  menuBar = false
): Promise<UiEntityCandidate[]> {
  const windowId = windowIdOf(target);
  // An id this cannot read names no window: never the frontmost app in its place (gate 2 on #928).
  if (windowId === undefined && target?.macWindowId !== undefined) {
    notes.warnings.push("no_window_with_id");
    return [];
  }
  if (windowId !== undefined) {
    // A window id names one window, whatever it is titled now: the window list says whose it is,
    // and the read keeps to the root that is that window.
    const listed = deps.listWindows(false).find((w) => w.layer === 0 && w.windowId === windowId);
    if (listed === undefined) {
      notes.warnings.push("no_window_with_id");
      return [];
    }
    const read = await readPidUnderTitle(deps, undefined, listed.pid, notes, menuBar, windowId);
    // Off screen and not in the tree: an app keeps a closed sheet's window listed (TextEdit's save
    // sheet after キャンセル, measured 2026-11-10), and discovering again would answer the same.
    const missing = notes.warnings.indexOf("window_id_not_in_tree");
    if (missing >= 0 && !listed.onScreen) notes.warnings[missing] = "window_not_shown";
    return [...read.own, ...read.menu];
  }
  const title = target?.windowTitle;
  let pid: number | undefined;
  if (title !== undefined && title !== "") {
    const needle = title.toLowerCase();
    const pids = [
      ...new Set(
        deps
          .listWindows(false)
          .filter((w) => w.layer === 0 && (w.title ?? "").toLowerCase().includes(needle))
          .map((w) => w.pid)
      ),
    ];
    if (pids.length === 0) {
      // Window titles from CGWindowList need Screen Recording; without it every title is empty,
      // and "no window matches" would be a false answer (gate 2, #780).
      const titled = deps.listWindows(false).some((w) => w.layer === 0 && (w.title ?? "") !== "");
      notes.warnings.push(titled ? "no_window_matches_title" : "window_titles_unavailable");
      return [];
    }
    // Several apps can show a window with the title: the open/save panel's "保存" is listed for
    // its service process as well as for the app whose tree holds its controls, and the service
    // came first (measured 2026-10-08). Each is read in turn until one has something under the
    // title; the last one's read is answered if none has (internal #257).
    // An earlier app whose read was incomplete is not known to hold nothing: if none has anything,
    // its warnings are answered and "nothing readable" is not (codex on #804).
    for (const [i, p] of pids.entries()) {
      const tried: MacAxReadNotes = { warnings: [] };
      const read = await readPidUnderTitle(deps, title, p, tried, menuBar);
      // Whether this app holds the title is judged by the window's controls alone: every app has a
      // menu bar, so its items would stop the search at the first app listed (gate 2 on #904).
      const found = read.own;
      // Several sheets carry the title in this app: it refused to pick one, and a later app must
      // not answer in its place (codex on #804).
      const ambiguous = tried.warnings.includes("title_matches_several_sheets");
      // An empty read that did not see its app whole may have missed that app's own controls (a
      // save sheet's 削除): a later app must not answer in its place either (internal #273).
      const unsureEmpty = found.length === 0 && tried.warnings.some((w) => UNSURE_READ.test(w));
      // The cost: when the open/save panel's service process is listed first and its read is
      // incomplete, the panel is not reached by its title (measured complete, gate 2 on #805).
      if (found.length > 0 || ambiguous || unsureEmpty || i === pids.length - 1) {
        Object.assign(notes, { ...tried, warnings: [...notes.warnings, ...tried.warnings] });
        return [...read.own, ...read.menu];
      }
    }
    return [];
  } else if (pinnedPid !== undefined) {
    pid = pinnedPid;
  } else {
    const focus = await deps.getFocus();
    pid = focus.pid;
    if (pid === undefined) {
      notes.warnings.push("no_frontmost_app");
      return [];
    }
  }
  const read = await readPidUnderTitle(deps, title, pid, notes, menuBar);
  return [...read.own, ...read.menu];
}

/**
 * Warnings that say a read did not see its app whole. The post-act qualifier counts these and the
 * title's own (`INCOMPLETE_READ`, desktop-discover-act.ts) — one list, so the two cannot drift.
 */
export const UNSURE_READ = /^(ax_error:|ax_read_incomplete$|display_asleep$|ax_self_reference$|truncated:|window_id_not_in_tree$|window_not_shown$)/;

/** Read one app's tree and the candidates under the title (all of them without one). */
async function readPidUnderTitle(
  deps: MacAxProviderDeps,
  title: string | undefined,
  pid: number,
  notes: MacAxReadNotes,
  menuBar = false,
  /** Read only the root that is this window (internal #265); `title` is not given with it. */
  windowId?: number
): Promise<{ own: UiEntityCandidate[]; menu: UiEntityCandidate[] }> {
  notes.pid = pid;

  // A menu bar is hundreds of elements (Safari's 848): its own room above the window's cap, so it
  // does not cut the window's read short and turn its controls' relocation off (gate 2 on #904).
  const tree = await deps.axTree({
    pid,
    ...(menuBar && { includeMenuBar: true, maxElements: MAX_ELEMENTS_WITH_MENU_BAR }),
    ...(windowId !== undefined && { windowId }),
  });
  if (tree.appTitle !== undefined) notes.appTitle = tree.appTitle;
  if (tree.error !== undefined) notes.warnings.push(`ax_error:${tree.error}`);
  if (tree.displayAsleep) notes.warnings.push("display_asleep");
  if (tree.selfReference) notes.warnings.push("ax_self_reference");
  if (tree.truncated) notes.warnings.push(`truncated:${tree.stoppedBy ?? "unknown"}`);
  // Some element's children or identity could not be read: what is missing is not known to be
  // absent (codex on #804).
  if (tree.readIncomplete === true) notes.warnings.push("ax_read_incomplete");
  // A sheet blocks its window (acts behind it are refused natively). Its controls may live in
  // another process — the open/save panel's do, and then nothing of it is in this tree.
  // The same sheet can be reached from two roots (its window and the focused window): say it once.
  // In this process when anything under it can be acted on; the open/save panel's sheet holds
  // nothing here (gate 2, #782: a child count misreads an in-process sheet wrapped in one group).
  // With a title, only the target window's sheets: another document's sheet does not block this one.
  // By id: the element that is the window — a root, or a sheet, which has a window id of its own
  // (TextEdit's save sheet, measured 2026-11-10) and sits under its window's root. The native read
  // started there and marked that one element with the id (`window_roots`, src/macos/ax.rs): which
  // element is the window is decided once, there (gate 2 on #928).
  const matched = windowId === undefined ? undefined : tree.elements.filter((e) => e.windowId === windowId);
  const windowRoots = matched?.map((e) => e.id);
  const inWindow = (e: NativeMacAxElement) =>
    windowRoots === undefined || windowRoots.some((r) => e.id === r || e.id.startsWith(`${r}.`));
  if (matched !== undefined) {
    const found = matched[0];
    if (found === undefined) {
      // The window is listed but nothing read says it is that window: a sleeping display or a read
      // cut short, or an app whose window AX does not reach. Not "the window holds nothing" — and
      // nothing is offered, not even the menu bar: a read that has entities would let a query that
      // matches none of them say the window was read (agy on #928). A read that failed outright
      // says so already (ax_error:*, e.g. window_id_unsupported): "discover again" would not help.
      if (tree.error === undefined) notes.warnings.push("window_id_not_in_tree");
      return { own: [], menu: [] };
    }
    notes.windowTitle = found.depth === 0 ? rootTitle(found.rootKey) : (found.title ?? found.description ?? "");
  }
  const sheetNeedle = title?.toLowerCase();
  // A sheet read by its own id is what is read, not something open over it (gate 2 on #928).
  for (const sheet of tree.elements.filter(
    (e) =>
      e.role === "AXSheet" &&
      inWindow(e) &&
      !(windowRoots ?? []).includes(e.id) &&
      (!sheetNeedle || rootTitle(e.rootKey).toLowerCase().includes(sheetNeedle))
  )) {
    const inside = tree.elements.some((e) => e.id.startsWith(`${sheet.id}.`) && (e.actions.length > 0 || e.valueSettable));
    const w = inside ? "sheet_open" : "sheet_open_in_other_process";
    if (!notes.warnings.includes(w)) notes.warnings.push(w);
  }

  const needle = sheetNeedle;
  const observedAtMs = deps.now();
  const targetId = windowId !== undefined ? `window:${windowId}` : (title ?? tree.appTitle ?? String(pid));
  // Cells that open carry their name from here on (internal #259): offered, digested and compared by it.
  // A read cut short may have missed a twin by name; a read with a part unread — Finder's usually
  // is — is left to the act, which counts the name in the list itself (`only_item_named`).
  const named = nameOpenableCells(tree.elements, tree.appTitle, !tree.truncated);
  const unique = uniquenessOf(named.elements, tree.truncated || tree.readIncomplete === true);
  const titled = needle !== undefined && needle !== "";
  const windowsTitled = titled && tree.elements.some((e) => rootTitle(e.rootKey).toLowerCase().includes(needle));
  // A sheet is not a window in the AX tree: its controls sit under its window's root, though the
  // window list names it on its own ("保存"). So a title no AX window carries is matched against
  // sheets, and a sheet's title reads what is in it — the route a refused act's advice gives
  // (internal #257). Only one: two documents' "保存" sheets read together would mix their
  // 削除 buttons, and one pressed for the wrong document loses its work (gate 2 on #804). Not when
  // an AX window carries the title: that window is what was named (its own sheet comes with it).
  // A focused sheet under a listed window is not read again as the focused-window root (`roots`,
  // src/macos/ax.rs), so each sheet here is one sheet: two that carry the title are two documents'.
  const sheetsTitled =
    !titled || windowsTitled
      ? []
      : tree.elements.filter((e) => e.role === "AXSheet" && (e.title ?? e.description ?? "").toLowerCase().includes(needle));
  const sheet = sheetsTitled.length === 1 ? sheetsTitled[0] : undefined;
  const underTitle = (e: NativeMacAxElement) =>
    inWindow(e) &&
    (!titled || rootTitle(e.rootKey).toLowerCase().includes(needle) || (sheet !== undefined && e.id.startsWith(`${sheet.id}.`)));
  const { barId, items } = menuBar ? menuBarItems(tree.elements) : { barId: undefined, items: new Map<string, string>() };
  // Without a title every root is read, the menu bar too: its items come once, by their paths.
  const inBar = (e: NativeMacAxElement) => barId !== undefined && (e.id === barId || e.id.startsWith(`${barId}.`));
  const offered = named.elements.filter((e) => !inBar(e) && underTitle(e) && isCandidate(e));
  // An item's text is left out only when the item itself is offered: a disabled sidebar entry (an
  // ejected volume) still reads by its text (gate 2 on #927).
  const offeredIds = new Set(offered.map((e) => e.id));
  // An element not unique under its root is told from an alike one that comes to sit at its path by
  // its siblings, as the native read saw them (internal #271): from the tree as read, not as named.
  const byId = new Map(tree.elements.map((e) => [e.id, e]));
  const twins = withTwinSeen(tree.elements);
  const siblingsOf = (e: NativeMacAxElement, isUnique: boolean) =>
    isUnique || !twins.has(e.id) ? undefined : siblingSignature(e, byId);
  const candidates = offered
    .filter((e) => !offeredIds.has(named.namedBy.get(e.id) ?? ""))
    .map((e) => {
      const isUnique = unique.get(e.id) === true;
      return toCandidate(e, pid, targetId, observedAtMs, isUnique, undefined, siblingsOf(byId.get(e.id) ?? e, isUnique));
    });
  // The menu bar is the app's, not the window's: offered beside the titled window's controls.
  const menu = tree.elements
    .filter((e) => items.has(e.id))
    .map((e) => {
      const isUnique = unique.get(e.id) === true;
      return toCandidate(e, pid, targetId, observedAtMs, isUnique, items.get(e.id), siblingsOf(e, isUnique));
    });
  if (menu.length > 0) notes.menuEntityIds = menu.map((c) => `ent_${c.digest}`);
  // Say why a titled read came back empty rather than answer it as if the window held nothing
  // (internal #257) — unless a warning above already says why (a sleeping display, a cut-off or
  // failed read: the window may simply not have been walked).
  const explained =
    tree.error !== undefined || tree.displayAsleep || tree.truncated || tree.selfReference || tree.readIncomplete === true;
  // Several sheets is a refusal of its own, whatever else the read says.
  if (titled && sheetsTitled.length > 1) notes.warnings.push("title_matches_several_sheets");
  else if (titled && candidates.length === 0 && !explained) notes.warnings.push("title_matches_nothing_readable");
  for (const c of candidates) {
    if (c.value === undefined || c.digest === undefined) continue;
    if (c.role === "textbox") (notes.values ??= {})[`ent_${c.digest}`] = c.value;
    else if (carriesState(c.controlType ?? "")) (notes.values ??= {})[`ent_${c.digest}`] = stateText(c.controlType!, c.value);
  }
  for (const e of tree.elements) {
    if (e.valueTruncated && (roleOf(e) === "textbox" || carriesState(e.role)) && e.subrole !== SECURE) {
      (notes.truncated ??= []).push(`ent_${axDigest(pid, e, unique.get(e.id) === true)}`);
    }
  }
  return { own: candidates, menu };
}
