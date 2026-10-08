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
  axTree(opts: { pid: number; maxElements?: number }): Promise<NativeMacAxTree>;
  now(): number;
}

/** What the read could not do, for the tool to say beside the entities. */
export interface MacAxReadNotes {
  warnings: string[];
  /**
   * The current value of each text field read, by entity id (`ent_` + digest). The shared entity
   * view carries no value, and `type` replaces the whole value, so without it a caller could not
   * add to a field without guessing its text (dogfood 2026-10-04: it read the text off a screenshot).
   * Never a password field's (the candidate has no value then).
   */
  values?: Record<string, string>;
  /** Entity ids of text fields whose value is longer than the read cap (no value is given for them). */
  truncated?: string[];
  pid?: number;
  appTitle?: string;
}

/** The roles the resolver understands (`button`, `textbox`, `link`, `menuitem`, `label`). */
export function roleOf(e: Pick<NativeMacAxElement, "role" | "subrole">): string {
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

/** The verbs the element itself offers: press only when it advertises AXPress. */
export function actionabilityOf(e: NativeMacAxElement): UiEntityCandidate["actionability"] {
  const verbs: UiEntityCandidate["actionability"] = [];
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
const WINDOW_BUTTONS: Record<string, string> = {
  AXCloseButton: "Close window",
  AXMinimizeButton: "Minimize window",
  AXFullScreenButton: "Full screen",
  AXZoomButton: "Zoom window",
};

function labelOf(e: NativeMacAxElement): string | undefined {
  if (roleOf(e) === "label" && e.value) return e.value;
  if (e.title) return e.title;
  if (e.description) return e.description;
  if (e.subrole !== undefined && WINDOW_BUTTONS[e.subrole] !== undefined) return WINDOW_BUTTONS[e.subrole];
  return undefined;
}

/** Elements worth handing to a caller: something to act on, or a named label. */
export function isCandidate(e: NativeMacAxElement): boolean {
  if (e.enabled === false) return false;
  const verbs = actionabilityOf(e);
  if (verbs.some((v) => v !== "read")) return true;
  return verbs.includes("read") && labelOf(e) !== undefined;
}

/** What an element is under its window: role, element key, and a text's shown value. */
function kindOf(e: Pick<NativeMacAxElement, "rootKey" | "elementKey" | "role" | "subrole" | "value">): string {
  // A text is named by what it shows, so what it shows is part of what it is: when Calculator's
  // display changes, the post-act diff must see a different entity (codex, #780). Texts are only
  // read, never leased for an act, so a changing identity costs nothing there.
  const shown = roleOf(e) === "label" ? `|${e.value ?? ""}` : "";
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
  e: Pick<NativeMacAxElement, "id" | "rootKey" | "elementKey" | "role" | "subrole" | "value">,
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

export function toCandidate(
  e: NativeMacAxElement,
  pid: number,
  targetId: string,
  observedAtMs: number,
  unique = true
): UiEntityCandidate {
  const label = labelOf(e);
  const secure = e.subrole === SECURE;
  return {
    source: "ax",
    target: { kind: "window", id: targetId },
    role: roleOf(e),
    ...(label !== undefined && { label }),
    // A cut value is not the field's text; it is left out rather than offered as if it were (codex, #782).
    ...(!secure && roleOf(e) !== "label" && e.value !== undefined && !e.valueTruncated && { value: e.value }),
    ...(e.frame !== undefined && { rect: { x: e.frame.x, y: e.frame.y, width: e.frame.width, height: e.frame.height } }),
    actionability: actionabilityOf(e),
    controlType: e.role,
    patterns: e.actions,
    confidence: 0.9,
    observedAtMs,
    status: "observed",
    digest: axDigest(pid, e, unique),
    locator: { ax: { pid, id: e.id, role: e.role, rootKey: e.rootKey, elementKey: e.elementKey, unique } },
  };
}

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
  target: { windowTitle?: string } | undefined,
  notes: MacAxReadNotes,
  /** Without a title: read this app instead of asking which is frontmost (a post-act read). */
  pinnedPid?: number
): Promise<UiEntityCandidate[]> {
  const title = target?.windowTitle;
  let pid: number | undefined;
  if (title !== undefined && title !== "") {
    const needle = title.toLowerCase();
    const win = deps
      .listWindows(false)
      .find((w) => w.layer === 0 && (w.title ?? "").toLowerCase().includes(needle));
    if (win === undefined) {
      // Window titles from CGWindowList need Screen Recording; without it every title is empty,
      // and "no window matches" would be a false answer (gate 2, #780).
      const titled = deps.listWindows(false).some((w) => w.layer === 0 && (w.title ?? "") !== "");
      notes.warnings.push(titled ? "no_window_matches_title" : "window_titles_unavailable");
      return [];
    }
    pid = win.pid;
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
  notes.pid = pid;

  const tree = await deps.axTree({ pid });
  if (tree.appTitle !== undefined) notes.appTitle = tree.appTitle;
  if (tree.error !== undefined) notes.warnings.push(`ax_error:${tree.error}`);
  if (tree.displayAsleep) notes.warnings.push("display_asleep");
  if (tree.selfReference) notes.warnings.push("ax_self_reference");
  if (tree.truncated) notes.warnings.push(`truncated:${tree.stoppedBy ?? "unknown"}`);
  // A sheet blocks its window (acts behind it are refused natively). Its controls may live in
  // another process — the open/save panel's do, and then nothing of it is in this tree.
  // The same sheet can be reached from two roots (its window and the focused window): say it once.
  // In this process when anything under it can be acted on; the open/save panel's sheet holds
  // nothing here (gate 2, #782: a child count misreads an in-process sheet wrapped in one group).
  // With a title, only the target window's sheets: another document's sheet does not block this one.
  const sheetNeedle = title?.toLowerCase();
  for (const sheet of tree.elements.filter(
    (e) => e.role === "AXSheet" && (!sheetNeedle || rootTitle(e.rootKey).toLowerCase().includes(sheetNeedle))
  )) {
    const inside = tree.elements.some((e) => e.id.startsWith(`${sheet.id}.`) && (e.actions.length > 0 || e.valueSettable));
    const w = inside ? "sheet_open" : "sheet_open_in_other_process";
    if (!notes.warnings.includes(w)) notes.warnings.push(w);
  }

  const needle = title?.toLowerCase();
  const observedAtMs = deps.now();
  const targetId = title ?? tree.appTitle ?? String(pid);
  const unique = uniquenessOf(tree.elements, tree.truncated || tree.readIncomplete === true);
  const candidates = tree.elements
    .filter((e) => needle === undefined || needle === "" || rootTitle(e.rootKey).toLowerCase().includes(needle))
    .filter(isCandidate)
    .map((e) => toCandidate(e, pid, targetId, observedAtMs, unique.get(e.id) === true));
  for (const c of candidates) {
    if (c.role === "textbox" && c.value !== undefined && c.digest !== undefined) {
      (notes.values ??= {})[`ent_${c.digest}`] = c.value;
    }
  }
  for (const e of tree.elements) {
    if (e.valueTruncated && roleOf(e) === "textbox" && e.subrole !== SECURE) {
      (notes.truncated ??= []).push(`ent_${axDigest(pid, e, unique.get(e.id) === true)}`);
    }
  }
  return candidates;
}
