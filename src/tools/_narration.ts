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
import { resolveWindowTarget, withPinnedResolution } from "./_resolve-window.js";
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
    "window that was acted on: another open window's title contains the text this call " +
    "resolved to, whether you named the handle or the server did — \"@active\" and the " +
    "dialog rescue both resolve one (\"ambiguous_title\"); or the target moved between the " +
    "snapshot and the action (\"target_changed\"). The action itself is unaffected either " +
    "way — only the diff is withheld. Default: \"minimal\"."
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
 * The `catch` withholds rather than guesses, because a rich diff built from a
 * title that may name two windows is worse than no diff at all. What can make
 * `enumWindowsInZOrder` throw is NOT settled here: a missing native module is
 * the certain case, and a build without it has neither `desktop_state` nor
 * `screenshot`, so that one cannot reach this line — but the two native calls
 * it makes before its own per-window `try` are outside any catch of ours, and
 * nothing in this file establishes that they cannot fail. The safe branch is
 * kept for what is not known, not as decoration for a case that cannot happen.
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
    // ADR-036 — narrate the window the HANDLER will act on, which is not always
    // the one this argument names. Two ways they part:
    //
    //   a handle takes precedence over `windowTitle` (the schemas say so), so a
    //   handle on one window plus a title naming a different, unambiguous one
    //   used to pass the shared-title check, snapshot the unrelated window, and
    //   return a diff of a window nobody touched;
    //
    //   `resolveWindowTarget` PREFERS THE ACTIVE POPUP when the named window is
    //   blocked by its own modal, so `click_element(hwnd=<Notepad>)` with Save
    //   As open acts on the dialog. Resolving the handle by itself narrated the
    //   disabled parent and emitted an empty diff for a click that changed
    //   something.
    //
    // So this goes through the handler's own resolver rather than reimplementing
    // half of it. A resolver that throws (an excluded window, an unusable
    // handle) withholds the diff instead of falling back to a string that names
    // something else; a `null` result is the plain-title path, where the
    // argument IS what the handler uses.
    const argTitle = options.windowTitleKey
      ? String(args[options.windowTitleKey] ?? "")
      : "";
    const hwndArg = options.hwndKey ? args[options.hwndKey] : undefined;
    let windowTitle = argTitle;
    // The window this wrapper resolved, so the resolution can be re-checked
    // after the slow part and before the handler runs its own.
    let pinnedHwnd: bigint | undefined;
    // How the handler gets called: bare, or inside the resolution handed to it.
    let handoff: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn();
    const resolveArgs = {
      ...(hwndArg !== undefined ? { hwnd: String(hwndArg) } : {}),
      ...(argTitle ? { windowTitle: argTitle } : {}),
    };
    // `fixId` is the one shape this cannot follow: the handler skips resolution
    // entirely and acts on the stored fix's own title, which is not visible from
    // here. The argument is the closest thing available, and a handle-passing
    // caller is never offered a fixId in the first place (`suppressSuggestedFix`).
    //
    // `options.hwndKey` is the OTHER limit, and leaving it out was this PR's own
    // defect one file over. `withRichNarration` wraps nineteen tools; only the
    // three this ADR is about declare a handle key. Resolving on `argTitle`
    // alone therefore reached `mouse_click`, `mouse_drag`, `scroll`,
    // `focus_window` and the browser set — tools whose schemas DO take `hwnd`
    // ("takes precedence over windowTitle", `mouse.ts`) while this wrapper is
    // structurally blind to it, because `hwndArg` is read through `hwndKey`. So
    // the wrapper resolved the TITLE, narrated that window with no degrade
    // marker, and the handler acted on the caller's handle: a confident diff of
    // a window the action never touched, which is the exact thing this ADR
    // exists to remove, newly created on tools it never claimed. It also armed
    // the ambiguity gate and handed the pin to `scroll_read` / `scroll_capture`,
    // so `narrate: "rich"` alone changed which window a title-only handler
    // resolved `@active` to.
    //
    // Those tools narrating by title while accepting a handle is OLDER than this
    // PR and stays for a follow-up: extending the handle rules to them is three
    // more tools' worth of behaviour with no real-machine acceptance behind it.
    // What is fixed here is that this PR made it worse.
    if (options.hwndKey && args["fixId"] === undefined && (hwndArg !== undefined || argTitle)) {
      let resolved;
      try {
        // `logAs: "off"`: this resolution exists to choose what to snapshot, not
        // to dispatch anything. The re-check below is the one handed to the
        // handler, and that one logs — so a rich call writes the same number of
        // ADR-035 `resolve` events as a minimal one.
        resolved = await resolveWindowTarget(resolveArgs, { logAs: "off" });
      } catch {
        const result = await wrappedWithPost(args);
        spliceRich(result, degradedRichBlock("no_target"));
        return result;
      }
      if (resolved) {
        windowTitle = resolved.title;
        pinnedHwnd = resolved.hwnd;
      } else if (hwndArg !== undefined) {
        // A handle that resolves to nothing: there is no window to describe, and
        // the caller's title names a different one. Case 1 of the resolver
        // returns or throws today, never `null`, so this is the fail-safe for a
        // Case 1 that can — withholding rather than silently falling back to the
        // argument. Pinned by a test that makes the resolver do it.
        const result = await wrappedWithPost(args);
        spliceRich(result, degradedRichBlock("no_target"));
        return result;
      }
    }

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
    // Also when the handle is one WE resolved rather than one the caller named:
    // `@active`, or a dialog rescue. Consuming the pin fixes the handler's
    // `resolveWindowTarget`, and that is not the whole of targeting —
    // `keyboard` derives its `explicitHwnd` from the PUBLIC argument only, so
    // its focus, guard and delivery stay title-based. With the title shared, the
    // keys can land on a sibling while these snapshots describe the window that
    // was in front a moment ago, and the `target_changed` check below does not
    // see it: that compares resolutions, not deliveries.
    if ((args[options.hwndKey ?? ""] !== undefined || pinnedHwnd !== undefined) &&
        titleIsSharedByMoreThanOneWindow(windowTitle)) {
      const result = await wrappedWithPost(args);
      spliceRich(result, degradedRichBlock("ambiguous_title"));
      return result;
    }

    // Cost, named rather than hidden, and named at its real size: a plain-title
    // miss enumerates TWICE inside `resolveWindowTarget` alone
    // (`findPlainTopLevelWindowsByTitle`, then the Case 4 dialog sweep) before
    // `titleIsSharedByMoreThanOneWindow` takes a third, and the re-check below
    // repeats the first pair. Not folded into one, because the alternative is
    // reimplementing the resolver here — which is the defect this replaced. Only
    // the `narrate: "rich"` path pays it, and only on the three tools that
    // declare a handle key.
    const snapBefore = await snapElements(windowTitle, true);  // try cache first

    // The handler resolves again, and the desktop can move in between — a modal
    // closing, the foreground changing. Then the snapshots describe one window
    // and the action lands on another, which is the defect this whole block
    // exists to remove, arriving through the back door.
    //
    // Pinning the handler to THIS resolution is not available: injecting the
    // resolved handle into `args` would make the handler believe the caller
    // named one, and that belief decides the guard descriptor, the pinning
    // rules and the text of the refusal. So the resolution is re-checked
    // instead — after the UIA snapshot, which is the slow part — and the diff is
    // withheld when it moved. The remaining gap is NOT small (`_post.ts` takes a
    // full focus enumeration before the handler runs), so the checked resolution
    // is handed forward to the handler rather than left to be redone: see
    // `withPinnedResolution`.
    if (pinnedHwnd !== undefined) {
      let again;
      try {
        again = await resolveWindowTarget(resolveArgs);
      } catch {
        again = null;
      }
      // On the handle, not the title. Comparing titles is EQUIVALENT today —
      // a flip between two windows sharing a title never reaches here, because
      // the ambiguity check above has already withheld it, so any flip that
      // does reach here changes the title as well. Equivalent by way of a check
      // one screen up is not the same as equivalent: the handle is what the
      // window is, and this line should not depend on that one staying put.
      if (!again || again.hwnd !== pinnedHwnd) {
        const moved = await wrappedWithPost(args);
        spliceRich(moved, degradedRichBlock("target_changed"));
        return moved;
      }
      // Still the same window. Hand that answer forward so the handler acts on
      // the window these snapshots describe, instead of resolving a third time
      // across the focus enumeration the post-state wrapper takes in between.
      // Scoped to this invocation: a handler that never resolves — the IME
      // fast-fail, a refused key combo — must not leave an answer lying around
      // for a concurrent call to pick up.
      handoff = (fn) => withPinnedResolution(resolveArgs, again, fn);
    }

    const result = await handoff(() => wrappedWithPost(args));

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
