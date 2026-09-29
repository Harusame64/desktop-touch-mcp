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
import { getUiElements, type UiElement } from "../engine/uia-bridge.js";
import {
  UIA_DISCOVER_FALLBACK_DEPTH,
  UIA_DISCOVER_FALLBACK_ELEMENTS,
  UIA_DISCOVER_MAX_DEPTH,
  UIA_DISCOVER_MAX_ELEMENTS,
} from "./desktop-providers/uia-provider.js";
import { enumWindowsInZOrder, windowIsShown } from "../engine/win32.js";
import { forgetUiaCache } from "../engine/layer-buffer.js";
import { parseWindowHandle } from "../engine/aim.js";
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
    'Narration level. "rich": include UIA diff in post.rich (appeared/disappeared/valueDeltas, and ' +
    "nameDeltas when an element's name changed, such as a calculator display) — " +
    "usually removes the need for a verification screenshot. It is withheld, with " +
    "post.rich.diffDegraded saying why, when the diff cannot be shown to describe the " +
    "window that was acted on. On click_element and keyboard (and set_element_value " +
    "where the server registers it), which resolve the target " +
    "window before acting: another open window's title contains the " +
    "text this call resolved to, whether you named the hwnd or the server did — " +
    "\"@active\" and the dialog rescue both resolve one (\"ambiguous_title\"); or the " +
    "target moved between the snapshot and the action (\"target_changed\"). On those " +
    "and on mouse_click, retrying with a fixId also withholds it, because the " +
    "stored fix names a window this cannot see (\"fix_target_unknown\") — browser tools " +
    "keep their diff on a fixId retry, because theirs is a tab diff and does not depend " +
    "on a window title. mouse_click and mouse_drag accept an hwnd and still take their " +
    "snapshots by windowTitle, so nothing else is withheld for them: verify those with " +
    "a screenshot. A window too large to read whole is withheld too (\"tree_truncated\"). " +
    "The action itself is unaffected in every case; only the diff is. " +
    "Default: \"minimal\"."
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

/**
 * A read's elements with the road that read them and the window it read (internal #211 B2: the
 * after-read reads that window again, by handle), or why there is nothing to diff.
 */
type Snapshot = { elements: UiElement[]; via: "native" | "powershell" | undefined; hwnd: bigint | undefined };

/** A read that came back but cannot be diffed, with the window it read (so its cache can be dropped). */
type Unusable = { unusable: "cut" | "slow"; hwnd: bigint | undefined };

async function snapElements(windowTitle: string, useCache: boolean, hwnd?: bigint): Promise<Snapshot | Unusable | null> {
  try {
    // internal #211 (B) — the discover read's caps, by element count: Calculator's display sits at
    // depth 4–5 and Explorer's status bar at depth 5 (win2 S3/S10), below the old depth 3 / 80.
    const result = await getUiElements(windowTitle, UIA_DISCOVER_MAX_DEPTH, UIA_DISCOVER_MAX_ELEMENTS, 4000, {
      cached: useCache,
      fetchValues: true,
      fallbackLimits: { maxDepth: UIA_DISCOVER_FALLBACK_DEPTH, maxElements: UIA_DISCOVER_FALLBACK_ELEMENTS },
      ...(hwnd !== undefined && { pinnedHwnd: hwnd }),
    });
    // ADR-036 — a tree cut short is a prefix, and this function's caller DIFFS two of them. Two
    // prefixes that end in different places read as elements appearing and disappearing that never
    // moved, so the narration would describe a change the user never made. A walk that ran out of
    // time says so (`truncated`: "slow"); one that stopped at its element cap does not, and is a
    // prefix all the same ("cut", internal #211 B) — two different reasons, said apart (gate 2).
    const read = parseWindowHandle(result.windowHwnd) ?? hwnd;
    if (result.truncated) return { unusable: "slow", hwnd: read };
    const cap = result.via === "powershell" ? UIA_DISCOVER_FALLBACK_ELEMENTS : UIA_DISCOVER_MAX_ELEMENTS;
    if (result.elementCount >= cap) return { unusable: "cut", hwnd: read };
    return { elements: result.elements, via: result.via, hwnd: read };
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
   * the tool takes one. The snapshots below read the resolved window by its
   * handle (internal #211 B2), but `keyboard` still delivers by title, so a call
   * that named a handle is narrated only while that title is unique; see the
   * checks in the rich path.
   */
  hwndKey?: string;

  /**
   * ADR-036 — does a `fixId` on THIS call retarget the handler?
   *
   * The wrapper withholds the diff for a fix retry, because the handler acts on
   * the stored fix's `windowTitle` and these snapshots follow the argument. That
   * is true of every handler that adopts a fix — until a tool is a dispatcher.
   * `keyboard` registers a FLATTENED union, so the wire schema accepts `fixId`
   * for `action:"press"`, which declares none; the handler re-parses against the
   * real union and Zod strips it. Measured: the press retry lost a correct diff
   * under `fix_target_unknown`, and the one-shot fix was never consumed because
   * the handler never saw it.
   *
   * So the question is answered per CALL, at the registration that knows which
   * variants adopt — not inferred from a key. Default: a tool that snapshots by
   * title and receives a `fixId` is assumed to retarget, because withholding a
   * diff is recoverable and a confident wrong one is not.
   */
  fixRetargets?: (args: Record<string, unknown>) => boolean;

  /**
   * ADR-036 — args that decide the target INSTEAD of `windowTitleKey` / `hwndKey`, so the window
   * arguments on such a call are not a naming of anything. `terminal` declares `["paneId"]`: its
   * schema says the pane takes precedence, and the handler branches on it before reading the
   * title. Read by the post layer, which must not attribute an untouched window's field to a call
   * whose title argument the handler ignored.
   */
  supersedingKeys?: string[];

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
/** Of these visible top-level windows, those whose title contains this one, case folded. */
function matchingTitle<W extends { title: string }>(wins: W[], windowTitle: string): W[] {
  const q = windowTitle.toLowerCase();
  return wins.filter((w) => w.title.toLowerCase().includes(q));
}

/** The visible top-level windows whose title contains this one; throws as the enumeration does. */
function windowsMatchingTitle(windowTitle: string) {
  return matchingTitle(enumWindowsInZOrder(), windowTitle);
}

function titleIsSharedByMoreThanOneWindow(windowTitle: string): boolean {
  try {
    return windowsMatchingTitle(windowTitle).length > 1;
  } catch {
    return true;
  }
}

export function withRichNarration<T extends Record<string, unknown>>(
  toolName: string,
  handler: (args: T) => Promise<ToolResult>,
  options: RichNarrationOptions = {}
): (args: T) => Promise<ToolResult> {
  // The keys this tool declared, handed down so the post layer asks the same question this
  // wrapper does — "did the call name a window?" — of the same arguments. `focus_window` names
  // its destination `title`, and a post layer reading a fixed `windowTitle` could not see it.
  const wrappedWithPost = withPostState(toolName, handler, {
    windowTitleKey: options.windowTitleKey,
    hwndKey: options.hwndKey,
    supersedingKeys: options.supersedingKeys,
    fixRetargets: options.fixRetargets,
  });

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
    // `fixId` is the one shape this cannot follow, and "the argument is the
    // closest thing available" was not good enough. The handler skips resolution
    // and acts on the stored fix's own `windowTitle`, which is not visible from
    // here — and a fix EXISTS because the guard found a narrower window than the
    // argument named, so the two normally DIFFER. Measured: argument "Notepad"
    // unique, fix naming "Report - Google Chrome", and the snapshots came back
    // describing Notepad twice with no degrade marker while the click went to
    // Report. A confident diff of a window nobody touched, on this ADR's own
    // recovery path.
    //
    // Withheld rather than guessed, and scoped by the property that makes it
    // wrong: the handler adopts the fix's `windowTitle` while these snapshots
    // follow the argument. `hwndKey` was the wrong scope — it is about who owns
    // the targeting, not about who retargets — and it let `mouse_click` back to
    // a confident diff for the same reason `click_element` is refused one
    // (`mouse.ts`: "Apply fix args (override user-supplied x/y/windowTitle)").
    //
    // `windowTitleKey` is the safe side of that question rather than a second
    // guess at it. Counted, not assumed: four handlers adopt a fix's title —
    // `click_element`, `keyboard`'s `type` and `sequence`, and `mouse_click` —
    // and every narrated tool that can receive a `fixId` AND snapshots by title
    // is one of them. `mouse_drag` is NOT: `fixId` is declared on
    // `mouseClickSchema` alone, so the registered schema strips it and this
    // condition can never fire there. `scroll`, `terminal`, `window_dock` and
    // `focus_window` declare no `fixId` either — and cannot receive `narrate` at
    // all, each file's own header says so. The browser set declares one and
    // narrates with no title key, so it never snapshots by title and returns
    // above. A tool that adds `fixId` later gets the withhold by default and has
    // to prove it does not retarget to lose it, which is the direction this PR
    // keeps wishing it had gone.
    // Truthy, not `!== undefined`: both schemas accept `fixId: ""` and the
    // handlers test `if (fixId)`, so an empty one is an ORDINARY call to them.
    // Testing for presence here withheld a diff that was correct and named a
    // reason that was not true — a wrapper and its handler disagreeing about
    // what the same argument means, which is the shape this ADR is about.
    if (options.windowTitleKey && Boolean(args["fixId"]) &&
        (options.fixRetargets ?? (() => true))(args)) {
      const result = await wrappedWithPost(args);
      spliceRich(result, degradedRichBlock("fix_target_unknown"));
      return result;
    }

    //
    // `options.hwndKey` is the OTHER limit, and leaving it out was this PR's own
    // defect one file over. `withRichNarration` wraps nineteen tools; only the
    // three this ADR is about declare a handle key. Resolving on `argTitle`
    // alone let the other sixteen in, and it hurt them two ways:
    //
    //   • all of them — the snapshots moved off the caller's argument onto a
    //     server-resolved title, the ambiguity gate armed, and the pin went to
    //     handlers that never asked for it (`scroll_read`, `scroll_capture`), so
    //     `narrate: "rich"` alone changed which window a title-only handler
    //     resolved `@active` to;
    //   • three of them — `mouse_click`, `mouse_drag`, `scroll`, and ONLY those
    //     three, whose schemas take `hwnd` while this wrapper reads it through
    //     `hwndKey` and so cannot see it. There the wrapper narrated the window
    //     the TITLE found while the handler acted on the caller's handle: a
    //     confident diff of a window the action never touched, which is the
    //     exact thing this ADR exists to remove, newly created on tools it never
    //     claimed. (Counted, not assumed: `focus_window`, `window_dock`,
    //     `terminal` and the six browser tools declare no `hwnd` at all.)
    //
    // Cost of putting the limit back, named because it is a real one: `@active`
    // on those sixteen returned a diff for one commit and now degrades again,
    // which is what it did before this PR. Making it work there means giving
    // them the handle rules deliberately — three more tools' worth of behaviour
    // with no real-machine acceptance behind it, and a follow-up. What is fixed
    // here is that this PR made those tools worse than it found them.
    if (options.hwndKey && (hwndArg !== undefined || argTitle)) {
      let resolved;
      try {
        // `logAs: "off"`: this resolution exists to choose what to snapshot, not
        // to dispatch anything. The re-check below defers its event to whoever
        // takes the pin, so a rich call writes the same number of ADR-035
        // `resolve` events as a minimal one on every path — including the two
        // where the re-check's answer is thrown away.
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
    // `snapElements` found its window BY TITLE, so with two same-titled windows
    // the action went to the handle while the diff described the sibling: a
    // report about a window nobody touched, with nothing in it to say so. This
    // wrapper sits on the three tools whose `ambiguous_target` refusal this ADR
    // lifts, so the case only became reachable when that refusal did. The reads
    // take the handle now (internal #211 B2), and that did NOT retire this check:
    // delivery is still title-based for `keyboard` (below), so a shared title
    // still lets the keys land on a sibling while the diff describes the window
    // read (gate 2 on B2).
    //
    // This used to say "same treatment as the background delivery check", and
    // that was false — measured, not argued. That check counts same-titled
    // windows at GUARD time and reads back by title afterwards, so a sibling the
    // action itself opens is not counted and IS read: 8 of 8 such calls returned
    // `BackgroundInputNotDelivered` for a write that landed
    // (`desktop-touch-mcp-internal@064fde7`). The sentence below is the reason
    // that check is not enough, written here before anyone had measured it —
    // which is the whole argument for not believing a comment that says two
    // mechanisms agree.
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
    //
    // One condition, not two. Keying anything here on the caller's handle was
    // reachable only as `fixId` + `hwnd`, and `fixId` no longer reaches this
    // line at all — it returned above, because a shared title was never what
    // was wrong with it.
    if (pinnedHwnd !== undefined && titleIsSharedByMoreThanOneWindow(windowTitle)) {
      const result = await wrappedWithPost(args);
      spliceRich(result, degradedRichBlock("ambiguous_title"));
      return result;
    }

    // Cost, named rather than hidden — and the last two attempts to state it
    // were both wrong, so this one is per path and was measured with
    // `enumWindowsInZOrder` counted:
    //
    //   hwnd or `@active`   3   resolver 0 (Cases 1 and 2 enumerate nothing)
    //                           + this gate + the gate after the re-check
    //                           + the check before the after-read
    //   plain title, hit    2   resolver (it returns `null`, so `pinnedHwnd`
    //                           stays unset and the gates before the action are
    //                           skipped) + the check before the after-read,
    //                           when the before-read reported its window
    //   Case 4 dialog       7   resolver 2, twice (probe and re-check), + 3
    //
    // `minimal` pays none of it. Not folded into one, because the alternative is
    // reimplementing the resolver here, which is the defect this replaced.
    const snapBefore = await snapElements(windowTitle, true, pinnedHwnd);  // try cache first

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
      // Held back rather than written: this resolution earns an ADR-035 event
      // only if it is the one the handler acts on, which is decided below.
      let againLog: (() => void) | undefined;
      try {
        again = await resolveWindowTarget(resolveArgs, {
          deferLog: (emit) => { againLog = emit; },
        });
      } catch {
        again = null;
      }
      // On the handle, not the title, and the two are NOT equivalent — the
      // earlier note claiming they were was wrong, and a mutation to the title
      // survived the suite until this was measured. The ambiguity check one
      // screen up counted windows BEFORE the UIA snapshot; the flip this line
      // catches happens after it. So a second window can take the title in
      // between, and comparing titles then sees nothing, hands the STALE
      // resolution forward and forces the action onto the window that moved —
      // worse than the missing marker. The handle is what the window is.
      if (!again || again.hwnd !== pinnedHwnd) {
        // `againLog` is dropped with it: nothing was dispatched on this
        // resolution, and the handler is about to make its own.
        const moved = await wrappedWithPost(args);
        spliceRich(moved, degradedRichBlock("target_changed"));
        return moved;
      }
      // Same window — and that is not the whole question. The ambiguity gate
      // above counted same-titled windows BEFORE `snapElements`, which is an
      // await long enough for a sibling to open. The handle comparison cannot
      // see that: the resolution did not move, the TITLE became shared. And a
      // shared title is what breaks `keyboard`, whose `explicitHwnd` comes from
      // the public argument, so its focus leash and delivery stay title-based
      // while these snapshots read whichever window the title matched. Counted
      // again on the far side of the snapshot, which is the side the action is
      // on.
      if (titleIsSharedByMoreThanOneWindow(windowTitle)) {
        const shared = await wrappedWithPost(args);
        spliceRich(shared, degradedRichBlock("ambiguous_title"));
        return shared;
      }

      // Still the same window, still the only one wearing that title. Hand that
      // answer forward so the handler acts on the window these snapshots
      // describe, instead of resolving a third time across the focus
      // enumeration the post-state wrapper takes in between.
      // Scoped to this invocation: a handler that never resolves — the IME
      // fast-fail, a refused key combo — must not leave an answer lying around
      // for a concurrent call to pick up.
      handoff = (fn) => withPinnedResolution(resolveArgs, again, fn, againLog);
    }

    const result = await handoff(() => wrappedWithPost(args));

    // The action has run: a tree cached under this window before it — by the before-read, or by
    // an earlier read — is not the window any more, whichever way this call leaves from here
    // (PR codex P2: the early returns below skipped this when it sat before the after-read).
    const actedOn = pinnedHwnd ?? snapBefore?.hwnd;
    if (actedOn !== undefined) forgetUiaCache(actedOn);

    if (!snapBefore || ("unusable" in snapBefore && snapBefore.unusable === "slow")) {
      spliceRich(result, degradedRichBlock("timeout"));
      return result;
    }
    if ("unusable" in snapBefore) {
      spliceRich(result, degradedRichBlock("tree_truncated"));
      return result;
    }

    // Settle delay (only when we have a before-snapshot to diff against)
    await new Promise<void>((r) => setTimeout(r, UI_SETTLE_MS));

    try {
      // internal #211 B2 — the after-read reads the window the before-read read, by its handle: an
      // action that renames its window ("*ab - メモ帳" after typing, a folder's name after opening
      // it) made the title search find nothing, or another window (win2: Explorer's folder change
      // came back `timeout`, S10 and #750). What the window may be is asked first, of one
      // enumeration of the VISIBLE windows, and before the read: a closed window is not read twice
      // over two roads to find that out, and a hidden one (a dialog that hides on OK) must not be
      // read by its handle and described as though it were on the screen (gate 2).
      const afterHwnd = pinnedHwnd ?? snapBefore.hwnd;
      if (afterHwnd !== undefined) {
        let wins;
        try {
          wins = enumWindowsInZOrder();
        } catch {
          // Withhold rather than guess, as the checks before the action do.
          spliceRich(result, degradedRichBlock("ambiguous_title"));
          return result;
        }
        const matches = matchingTitle(wins, windowTitle);
        // Still here, and still the only window wearing the title the handler delivers by:
        // `keyboard` takes its handle from the public argument, so its focus leash follows the
        // title, and a same-titled window the action opened (Ctrl+N) takes the rest of the keys
        // — a diff of the window read would describe one that got none (gate 2). Scoped to the
        // pinned population, as the checks before the action are.
        if (pinnedHwnd !== undefined && matches.length > 1) {
          spliceRich(result, degradedRichBlock("ambiguous_title"));
          return result;
        }
        // Gone is asked of the handle first: the enumeration drops untitled and tiny windows, which
        // are on the screen (win2 on #752), and keeps a cloaked one, which is not (PR codex P2: a
        // window moved to another virtual desktop). The list answers only when the handle cannot.
        const shown = windowIsShown(afterHwnd) ?? wins.some((w) => w.hwnd === afterHwnd);
        if (!shown) {
          // Gone from the screen — closed, hidden, or destroyed and replaced by the next one (a
          // dialog that advances that way). One other window wearing the title is where to look
          // (`target_changed`, not `window_closed`, which a caller would read as "give up"); more
          // than one cannot be told apart.
          const others = matches.filter((w) => w.hwnd !== afterHwnd).length;
          spliceRich(result, degradedRichBlock(others > 1 ? "ambiguous_title" : others === 1 ? "target_changed" : "window_closed"));
          return result;
        }
      }
      const snapAfterElements = await snapElements(windowTitle, false, afterHwnd);
      if (!snapAfterElements || ("unusable" in snapAfterElements && snapAfterElements.unusable === "slow")) {
        spliceRich(result, degradedRichBlock("timeout"));
        return result;
      }
      if ("unusable" in snapAfterElements) {
        spliceRich(result, degradedRichBlock("tree_truncated"));
        return result;
      }
      // The two roads read to different caps (native 64 / 500, PowerShell 4 / 80) and through
      // different providers, so a diff across them would report everything the shallower one did
      // not reach as gone. The after-read falls back when the native one fails, which is itself
      // most often a timeout (gate 2).
      if (snapBefore.via !== snapAfterElements.via) {
        spliceRich(result, degradedRichBlock("timeout"));
        return result;
      }

      const diff = computeUiaDiff(snapBefore.elements, snapAfterElements.elements);
      const richBlock: RichBlock = { ...diff, diffSource: "uia" };
      spliceRich(result, richBlock);
    } catch {
      spliceRich(result, degradedRichBlock("timeout"));
    }

    return result;
  };
}
