/**
 * _narration.ts — withRichNarration wrapper (Phase 3.2).
 *
 * Composes on top of withPostState: takes a UIA snapshot before and after
 * an action, diffs them, and splices the result into post.rich — eliminating
 * the need for a confirmation screenshot.
 *
 * Opt-in per call via narrate:"rich". Default is "minimal" (no diff, no cost).
 *
 * Chromium handling:
 *   - UIA trees are sparse on Chromium → diff will be empty.
 *   - When the target window title matches CHROMIUM_TITLE_RE, the diff is
 *     marked diffDegraded:"chromium_sparse".
 *   - browser_* tools use a dedicated CDP diff path (see browser.ts).
 *
 * keyboard_press gate:
 *   - Only state-transitioning keys (Enter/Tab/Esc/F5 etc.) activate rich
 *     narration.  Single characters silently downgrade to "minimal".
 */

import { withPostState } from "./_post.js";
import { getUiElements } from "../engine/uia-bridge.js";
import { enumWindowsInZOrder } from "../engine/win32.js";
import { computeUiaDiff, degradedRichBlock } from "../engine/uia-diff.js";
import type { RichBlock } from "../engine/uia-diff.js";
import { CHROMIUM_TITLE_RE } from "./workspace.js";
import type { ToolResult } from "./_types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared narrate Zod schema fragment (imported by tool schemas)
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const narrateParam = z
  .enum(["minimal", "rich"])
  .default("minimal")
  .describe(
    'Narration level. "rich": include UIA diff in post.rich (appeared/disappeared/valueDeltas) — ' +
    "usually removes the need for a verification screenshot. It is withheld, with " +
    "post.rich.diffDegraded saying why, when the diff cannot be shown to describe the " +
    "window that was acted on — including any call that names an hwnd while another open " +
    "window's title contains the same text. Default: \"minimal\"."
  );

// ─────────────────────────────────────────────────────────────────────────────
// State-transitioning key detection (for keyboard_press gate)
// ─────────────────────────────────────────────────────────────────────────────

const STATE_KEYS = new Set([
  "enter", "tab", "escape", "esc",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  "delete", "backspace",
  "space", "up", "down", "left", "right", "pageup", "pagedown", "home", "end",
]);

/**
 * Returns true if the key combo is likely to trigger a UI state change.
 *
 * Rules:
 *   - ctrl / alt / meta / win / super / cmd + any key → true
 *     (ctrl+s, ctrl+f, alt+tab, alt+f4 etc. all cause UI state changes)
 *   - shift is NOT treated as a state modifier on its own:
 *     shift+a = uppercase A (text input), not a state transition.
 *     shift+tab / shift+enter / shift+f10 still return true via STATE_KEYS.
 *   - Bare single-character keys (a, b, 1, …) → false
 *   - Bare special keys in STATE_KEYS (enter, f5, delete, …) → true
 */
export function isStateTransitioningKey(keys: string): boolean {
  const tokens = keys.toLowerCase().split("+").map(t => t.trim()).filter(Boolean);
  if (tokens.length === 0) return false;
  const base = tokens[tokens.length - 1];
  const mods = new Set(tokens.slice(0, -1));

  // Any ctrl/alt/meta/win combo → state-transitioning regardless of base key.
  // "control" is an alias for "ctrl" (mirrors key-map.ts normalisation).
  if (
    mods.has("ctrl") || mods.has("control") ||
    mods.has("alt") || mods.has("meta") ||
    mods.has("win") || mods.has("super") || mods.has("cmd")
  ) {
    return true;
  }

  if (base.length === 1) return false;   // bare single character (a, b, 1, …)
  return STATE_KEYS.has(base);
}

/** Milliseconds to wait after an action before taking the after-snapshot. */
const UI_SETTLE_MS = 120;

// ─────────────────────────────────────────────────────────────────────────────
// UIA snapshot helpers
// ─────────────────────────────────────────────────────────────────────────────

async function snapElements(windowTitle: string, useCache: boolean) {
  try {
    const result = await getUiElements(windowTitle, 3, 80, 4000, {
      cached: useCache,
      fetchValues: true,
    });
    return result.elements;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Splice helper
// ─────────────────────────────────────────────────────────────────────────────

/** Merge richBlock into post.rich of an already-serialised ToolResult.
 *  No-ops when post.rich is already set (e.g. set via _richForPost by a browser handler). */
function spliceRich(result: ToolResult, richBlock: RichBlock): void {
  const block = result.content[0];
  if (!block || block.type !== "text") return;
  try {
    const parsed = JSON.parse(block.text) as Record<string, unknown>;
    if (parsed.ok === false) return;                        // don't touch error shapes
    if (parsed.post && typeof parsed.post === "object") {
      const post = parsed.post as Record<string, unknown>;
      if (post.rich !== undefined) return;                  // already set — don't overwrite
      post.rich = richBlock;
      block.text = JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Non-JSON result — skip silently.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// withRichNarration
// ─────────────────────────────────────────────────────────────────────────────

export interface RichNarrationOptions {
  /**
   * Key in the args object that holds the target window title.
   * Used to obtain the UIA snapshot before/after the action.
   * If omitted, no UIA diff is attempted.
   */
  windowTitleKey?: string;

  /**
   * ADR-036 — key in the args object that holds the target window HANDLE, when
   * the tool takes one. The snapshots below resolve their window by title, so a
   * call that named a handle is narrated only while that title is unique; see
   * the check in the rich path.
   */
  hwndKey?: string;

  /**
   * When true, `narrate:"rich"` is silently ignored for non-state-transitioning
   * keyboard combos (see isStateTransitioningKey).  Set on keyboard_press.
   */
  keyboardPressGate?: boolean;

  /**
   * Key in the args object that holds the key combo string.
   * Required when keyboardPressGate:true.
   */
  keysKey?: string;
}

/**
 * Drop-in replacement for withPostState that also supports narrate:"rich".
 *
 * When narrate:"rich":
 *   1. Snapshot the UIA tree before the action (uses cache if fresh).
 *   2. Run the action (via withPostState for always-on post narration).
 *   3. Sleep 120 ms to let the UI settle.
 *   4. Snapshot the UIA tree after.
 *   5. Compute diff, splice into post.rich.
 *
 * The narrate param is consumed here. It remains in args but inner handlers
 * are expected to ignore it (they don't declare it in their param types).
 */
/**
 * ADR-036 — narration options for the three UIA/keyboard write tools whose
 * `ambiguous_target` refusal this ADR lifts (`click_element`,
 * `set_element_value`, `keyboard`).
 *
 * One constant rather than three inline objects: the defect this ADR is about
 * is four layers losing the same handle independently, and a per-site option
 * object is a fourth place to forget it. All three tools name the argument
 * `hwnd` and the title `windowTitle`.
 */
export const UIA_WRITE_NARRATION: RichNarrationOptions = {
  windowTitleKey: "windowTitle",
  hwndKey: "hwnd",
};

/**
 * ADR-036 — does more than one open window carry this title?
 *
 * Counted the way `keyboard`'s delivery check counts it (Win32 enumeration,
 * case-insensitive substring) so the two skips agree on what "shared" means.
 *
 * The `catch` is not a trade-off with a case behind it: `enumWindowsInZOrder`
 * throws only when the native Win32 module is missing, and a build without it
 * has no `desktop_state` and no `screenshot` either — so nothing that reaches
 * here can be running. It withholds rather than guesses because that is the
 * cheaper way to be wrong, not because the branch has ever been taken.
 */
function titleIsSharedByMoreThanOneWindow(windowTitle: string): boolean {
  try {
    const q = windowTitle.toLowerCase();
    return enumWindowsInZOrder().filter((w) => w.title.toLowerCase().includes(q)).length > 1;
  } catch {
    return true;
  }
}

export function withRichNarration<T extends Record<string, unknown>>(
  toolName: string,
  handler: (args: T) => Promise<ToolResult>,
  options: RichNarrationOptions = {}
): (args: T) => Promise<ToolResult> {
  const wrappedWithPost = withPostState(toolName, handler);

  return async (args: T) => {
    const narrate = (args.narrate as string | undefined) ?? "minimal";

    // Keyboard-press gate: downgrade trivial keys to minimal.
    const isRich = narrate === "rich" &&
      !(options.keyboardPressGate &&
        options.keysKey &&
        !isStateTransitioningKey(String(args[options.keysKey] ?? "")));

    if (!isRich) {
      return wrappedWithPost(args);
    }

    // ── Rich path ────────────────────────────────────────────────────────────
    const windowTitle = options.windowTitleKey
      ? String(args[options.windowTitleKey] ?? "")
      : "";

    // No window target: run action normally.
    // Only splice no_target when the tool supports windowTitle but none was provided.
    if (!windowTitle) {
      const result = await wrappedWithPost(args);
      if (options.windowTitleKey) {
        spliceRich(result, degradedRichBlock("no_target"));
      }
      return result;
    }

    // Chromium guard: UIA trees are sparse → skip before-snapshot entirely.
    if (CHROMIUM_TITLE_RE.test(windowTitle)) {
      const result = await wrappedWithPost(args);
      spliceRich(result, degradedRichBlock("chromium_sparse"));
      return result;
    }

    // ADR-036 — a handle-named call whose title is shared is not narrated.
    // `snapElements` finds its window BY TITLE, so with two same-titled windows
    // the action goes to the handle while the diff describes the sibling: a
    // report about a window nobody touched, with nothing in it to say so. This
    // wrapper sits on the three tools whose `ambiguous_target` refusal this ADR
    // lifts, so the case only became reachable when that refusal did. Same
    // treatment as the background delivery check — withhold the verdict rather
    // than compute it from the wrong window. It narrows again when the reads
    // take a handle (ADR-036 I-6), which is also what retires this check.
    //
    // NOT narrowed to "the title happens to pick the named window right now",
    // even though `getUiElements` does report which window it read. Two reasons,
    // and the second is the one that decides it: the reported rect cannot prove
    // identity (two maximised windows of the same app share one), and the write
    // itself can raise its target between the two snapshots — `keyboard`
    // `method:"foreground"` and `set_element_value`'s channel 3 both do — so a
    // check made before the action would license a diff computed across two
    // DIFFERENT windows, which is worse than either window's own.
    if (options.hwndKey && args[options.hwndKey] !== undefined &&
        titleIsSharedByMoreThanOneWindow(windowTitle)) {
      const result = await wrappedWithPost(args);
      spliceRich(result, degradedRichBlock("ambiguous_title"));
      return result;
    }

    const snapBefore = await snapElements(windowTitle, true);  // try cache first

    const result = await wrappedWithPost(args);

    if (!snapBefore) {
      spliceRich(result, degradedRichBlock("timeout"));
      return result;
    }

    // Settle delay (only when we have a before-snapshot to diff against)
    await new Promise<void>((r) => setTimeout(r, UI_SETTLE_MS));

    try {
      const snapAfterElements = await snapElements(windowTitle, false);
      if (!snapAfterElements) {
        spliceRich(result, degradedRichBlock("timeout"));
        return result;
      }
      const diff = computeUiaDiff(snapBefore, snapAfterElements);
      const richBlock: RichBlock = { ...diff, diffSource: "uia" };
      spliceRich(result, richBlock);
    } catch {
      spliceRich(result, degradedRichBlock("timeout"));
    }

    return result;
  };
}
