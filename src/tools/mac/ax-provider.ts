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

/**
 * The candidate's identity (the resolver's key, the entityId and the lease's evidence digest):
 * the app, the path, and the root and element keys — not the label and rect the resolver falls
 * back to, which two distinct AX elements can share (same title, no frame), and would then be
 * merged into one entity carrying one element's verbs and the other's locator (codex gate 1, #780).
 * The value is left out, so typing into a field does not change its identity.
 */
export function axDigest(
  pid: number,
  e: Pick<NativeMacAxElement, "id" | "rootKey" | "elementKey" | "role" | "subrole" | "value">
): string {
  // A text is named by what it shows, so what it shows is part of what it is: when Calculator's
  // display changes, the post-act diff must see a different entity (codex, #780). Texts are only
  // read, never leased for an act, so a changing identity costs nothing there.
  const shown = roleOf(e) === "label" ? `|${e.value ?? ""}` : "";
  return createHash("sha1").update(`ax|${pid}|${e.id}|${e.rootKey}|${e.elementKey}${shown}`).digest("hex").slice(0, 16);
}

export function toCandidate(
  e: NativeMacAxElement,
  pid: number,
  targetId: string,
  observedAtMs: number
): UiEntityCandidate {
  const label = labelOf(e);
  const secure = e.subrole === SECURE;
  return {
    source: "ax",
    target: { kind: "window", id: targetId },
    role: roleOf(e),
    ...(label !== undefined && { label }),
    ...(!secure && roleOf(e) !== "label" && e.value !== undefined && { value: e.value }),
    ...(e.frame !== undefined && { rect: { x: e.frame.x, y: e.frame.y, width: e.frame.width, height: e.frame.height } }),
    actionability: actionabilityOf(e),
    controlType: e.role,
    patterns: e.actions,
    confidence: 0.9,
    observedAtMs,
    status: "observed",
    digest: axDigest(pid, e),
    locator: { ax: { pid, id: e.id, role: e.role, rootKey: e.rootKey, elementKey: e.elementKey } },
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
  for (const sheet of tree.elements.filter((e) => e.role === "AXSheet")) {
    const w = sheet.childCount <= 1 ? "sheet_open_in_other_process" : "sheet_open";
    if (!notes.warnings.includes(w)) notes.warnings.push(w);
  }

  const needle = title?.toLowerCase();
  const observedAtMs = deps.now();
  const targetId = title ?? tree.appTitle ?? String(pid);
  return tree.elements
    .filter((e) => needle === undefined || needle === "" || rootTitle(e.rootKey).toLowerCase().includes(needle))
    .filter(isCandidate)
    .map((e) => toCandidate(e, pid, targetId, observedAtMs));
}
