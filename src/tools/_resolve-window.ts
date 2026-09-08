/**
 * Shared window resolution utility for hwnd-based and @active targeting.
 *
 * Resolution priority (highest to lowest):
 *   1. `hwnd` string  → look up window directly; if owner is disabled, prefer active popup
 *   2. `windowTitle === "@active"` → resolve current foreground window
 *   3. Plain `windowTitle` with a top-level match → return null (caller handles as before)
 *   4. (H3) Plain `windowTitle` with no top-level match → search common dialog (#32770 / owned popup)
 *
 * Returns null for cases 3 so existing title-based logic is unchanged.
 *
 * New warnings (H3):
 *   dialog_resolved_via_owner_chain — dialog found via owner chain (case 4)
 *   parent_disabled_prefer_popup    — parent window blocked by modal; popup preferred (case 1)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  getForegroundHwnd, getWindowTitleW, getWindowRectByHwnd, isExcludedWindowHandle, isExcludedTitle,
  // H3: hierarchy-aware dialog resolution
  enumWindowsInZOrder, getWindowOwner, getWindowClassName, isWindowEnabled, getLastActivePopup,
} from "../engine/win32.js";
import { WindowExcludedError } from "../engine/tool-exclusion.js";
import { logResolve } from "./_resolve-log.js";
import type { ResolveResolver } from "../engine/diagnostic-log.js";

/**
 * (R3 tool-exclusion) Cases 1/2 resolve an HWND directly (explicit `hwnd`, `@active`), bypassing
 * `enumWindowsInZOrder`'s PID filter. Consult the exclusion registry here so a Key Locker window
 * cannot be targeted by hwnd or by happening to be the foreground window. `isExcludedWindowHandle`
 * short-circuits on an empty registry → zero syscalls when no locker is alive, and fails CLOSED on
 * an unreadable PID. Throws the typed `WindowExcludedError` (L0-local; L4 wires it into `_errors.ts`)
 * rather than masquerading as WindowNotFound — the window exists, it is protected — so callers that
 * tolerate resolution misses (e.g. `normalizeTarget`) can single it out and propagate the refusal.
 */
function refuseIfExcludedTarget(hwnd: bigint): void {
  if (isExcludedWindowHandle(hwnd)) {
    throw new WindowExcludedError(
      "WindowExcluded: target window belongs to the desktop-touch key locker and is not " +
      "addressable by automation tools (the secure credential dialog is excluded by design)",
    );
  }
}

// Standard Win32 dialog class. Used as primary signal for common dialog detection.
// ownerHwnd is the secondary signal for non-#32770 common dialogs (IFileDialog, etc.)
// Exported so `_input-pipeline.ts` can mirror Case 3's "plain top-level" predicate
// (non-dialog class + no owner) when recovering the HWND Case 3 deliberately
// discards — one dialog-class SSOT, no drift (CLAUDE.md §3.1).
export const DIALOG_CLASSNAMES = new Set(["#32770"]);

interface DialogCandidate { hwnd: bigint; title: string; }

/**
 * `getWindowClassName` wrapped in a try/catch so a momentary race
 * (window destroyed between resolution and class read) degrades to `null`
 * rather than throwing out of `resolveWindowTarget`.
 */
function safeGetClassName(hwnd: bigint): string | null {
  try {
    const cls = getWindowClassName(hwnd);
    return cls === "" ? null : cls;
  } catch {
    return null;
  }
}

/**
 * ADR-018 Phase 5 — single SSOT for "find a top-level window whose title
 * substring-matches `title`". Phase 1b sub-plan §2.2 carry-over (re-routed
 * Phase 4 → Phase 5). Replaces 3 copies of the same predicate that drifted
 * across `_resolve-window.ts` Case 3 / `_input-pipeline.ts::resolveInputDestination`
 * Case 3 recovery / `mouse.ts:scrollHandler` observation ladder.
 *
 * Per-call-site flag preservation (CLAUDE.md §3.2 carry-over scope shrink):
 *
 * | Call site | excludeMinimized | excludeDialogsAndOwned |
 * |---|---|---|
 * | `_resolve-window.ts` Case 3 | `false` (tolerant — legacy) | `true` (predicate ALWAYS filtered #32770 + owned) |
 * | `_input-pipeline.ts` Case 3 recovery | `true` (minimized → unusable dispatch target) | `true` (same) |
 * | `mouse.ts` observation ladder | `true` (minimized → unobservable) | `false` (observation tolerates dialog matches) |
 *
 * The minimized-window distinction is load-bearing: `_resolve-window.ts` Case 3
 * historically tolerated minimized matches (returning null pass-through), and
 * adopting `excludeMinimized: true` there would change `resolveWindowTarget`'s
 * behaviour for legacy title-based callers. Default `false` preserves it.
 *
 * @param title — Title substring to match (case-insensitive). Empty string returns null.
 * @param opts.excludeMinimized — When `true`, minimized windows are skipped.
 * @param opts.excludeDialogsAndOwned — When `true`, `#32770` dialogs AND any
 *   window with a non-null `ownerHwnd` are skipped (predicate matches a true
 *   top-level window only).
 * @returns The first matching `WindowZInfo` in Z-order, or null.
 */
export function findPlainTopLevelWindowByTitle(
  title: string,
  opts: PlainTopLevelMatchOptions = {},
): ReturnType<typeof enumWindowsInZOrder>[number] | null {
  return findPlainTopLevelWindowsByTitle(title, opts)[0] ?? null;
}

/**
 * Options shared by the plain-top-level matcher and its two entry points.
 *
 * `logAs` is ADR-035 Phase 1 observation only and never affects which window is
 * returned. It exists because the invariant is **one resolution = one `resolve`
 * event**: a caller that wraps this helper (`_input-pipeline.ts` Case 3) names
 * itself so the event is attributed to the wrapper rather than to the SSOT, and
 * a caller that has already logged the same resolution passes `"off"`.
 */
export interface PlainTopLevelMatchOptions {
  excludeMinimized?: boolean;
  excludeDialogsAndOwned?: boolean;
  logAs?: ResolveResolver | "off";
}

/**
 * Every plain top-level window matching `title`, in Z-order, and the ADR-035
 * Phase 1 `resolve` event that records how many there were.
 *
 * The array-returning shape is what makes the observation possible at all:
 * `matchCount` and the runners-up are exactly the information the historic
 * `.find()` threw away, and `_input-pipeline.ts` Case 3 needs the count a
 * second time to decide whether to warn.
 *
 * @returns All matches (possibly empty). `[0]` is the window the legacy
 *   `.find()` would have returned.
 */
export function findPlainTopLevelWindowsByTitle(
  title: string,
  opts: PlainTopLevelMatchOptions = {},
): ReturnType<typeof enumWindowsInZOrder> {
  // Checked before enumerating: an empty title must cost nothing (pinned by
  // find-plain-top-level-window.test.ts).
  if (!title) return [];
  try {
    const matches = matchPlainTopLevelWindowsByTitle(enumWindowsInZOrder(), title, opts);
    logPlainTopLevelResolve(title, matches, opts);
    return matches;
  } catch {
    // `enumWindowsInZOrder` unavailable → no matches (callers fall through to
    // their own fallback / unresolved path).
    return [];
  }
}

/** Shared emitter for the two plain-top-level entry points (honours `logAs`). */
function logPlainTopLevelResolve(
  title: string,
  matches: ReturnType<typeof enumWindowsInZOrder>,
  opts: PlainTopLevelMatchOptions,
): void {
  const resolver = opts.logAs ?? "pickPlainTopLevelWindowByTitle";
  if (resolver === "off") return;
  logResolve({ resolver, query: title, matches });
}

/**
 * The predicate half of {@link findPlainTopLevelWindowByTitle}, applied to a
 * window list the caller already has.
 *
 * ADR-029 Phase 1: the viewport gate resolves a title-based origin against the
 * enumeration snapshot it took for its other lookups, and it must resolve the
 * SAME window the discovery path would — matching by any other rule (equality,
 * "first visible match", ignoring the dialog/owned filter) silently retargets
 * the gate to a different window and can pass a click onto it. Sharing the
 * predicate is what keeps the two from drifting apart.
 */
export function pickPlainTopLevelWindowByTitle(
  windows: ReturnType<typeof enumWindowsInZOrder>,
  title: string,
  opts: PlainTopLevelMatchOptions = {},
): ReturnType<typeof enumWindowsInZOrder>[number] | null {
  if (!title) return null;
  const matches = matchPlainTopLevelWindowsByTitle(windows, title, opts);
  logPlainTopLevelResolve(title, matches, opts);
  return matches[0] ?? null;
}

/**
 * The pure matcher underneath {@link pickPlainTopLevelWindowByTitle} — all
 * matches instead of the first one, and no logging.
 *
 * Kept separate so the ADR-035 Phase 1 instrumentation can count matches
 * without any call site paying for a second pass, and so a caller that logs the
 * resolution itself is not forced through the emitter.
 */
export function matchPlainTopLevelWindowsByTitle(
  windows: ReturnType<typeof enumWindowsInZOrder>,
  title: string,
  opts: PlainTopLevelMatchOptions = {},
): ReturnType<typeof enumWindowsInZOrder> {
  if (!title) return [];
  const { excludeMinimized = false, excludeDialogsAndOwned = false } = opts;
  const q = title.toLowerCase();
  return windows.filter((w) => {
    if (excludeMinimized && w.isMinimized) return false;
    if (excludeDialogsAndOwned) {
      if (DIALOG_CLASSNAMES.has(w.className ?? "")) return false;
      if (w.ownerHwnd != null) return false;
    }
    return w.title.toLowerCase().includes(q);
  });
}

/**
 * (H3 case 4) Search for a common dialog window whose title partially matches `query`.
 * Prioritises #32770-classed windows, then owned popups.
 * Only considers non-minimised windows (minimised dialogs can't be interacted with).
 * Returns null if no match found.
 */
function findCommonDialogByTitle(
  wins: ReturnType<typeof enumWindowsInZOrder>,
  query: string,
): { chosen: DialogCandidate | null; candidates: DialogCandidate[] } {
  const q = query.toLowerCase();
  const classed: DialogCandidate[] = [];
  const owned: DialogCandidate[] = [];
  for (const w of wins) {
    if (w.isMinimized) continue;                              // skip minimised dialogs
    if (!w.title.toLowerCase().includes(q)) continue;
    if (DIALOG_CLASSNAMES.has(w.className ?? "")) {
      classed.push({ hwnd: w.hwnd, title: w.title });
    } else if (w.ownerHwnd != null) {
      owned.push({ hwnd: w.hwnd, title: w.title });
    }
  }
  // `candidates` is the priority order the tie-break walks, so index 0 is the
  // chosen one and the rest are what it passed over — the shape the ADR-035
  // Phase 1 `resolve` event records. The chosen value is unchanged.
  const candidates = [...classed, ...owned];
  return { chosen: candidates[0] ?? null, candidates };
}

/**
 * (H3 case 5) When `hwndb` is disabled (blocked by a modal), return the
 * last-active popup that it owns, if that popup looks like a common dialog.
 * Returns null when hwndb is enabled or has no qualifying popup.
 *
 * Adoption condition: popup owner === hwndb  OR  popup className is #32770.
 * (positive form; double negation avoided for clarity)
 */
function preferActivePopupIfBlocked(hwndb: bigint): DialogCandidate | null {
  if (isWindowEnabled(hwndb)) return null;
  const popup = getLastActivePopup(hwndb);
  if (popup == null || popup === hwndb) return null;
  const owner = getWindowOwner(popup);
  const cls   = getWindowClassName(popup);
  // Only adopt popup when it is clearly owned by hwndb or is a standard Win32 dialog.
  if (owner !== hwndb && !DIALOG_CLASSNAMES.has(cls)) return null;
  const title = getWindowTitleW(popup);
  // Skip if popup has no title yet (e.g. WinUI dialog still initialising).
  if (!title) return null;
  return { hwnd: popup, title };
}

export interface ResolvedWindow {
  title: string;
  hwnd: bigint;
  warnings: string[];
  /**
   * Win32 window class name. `null` when `GetClassNameW` fails on the
   * resolved HWND (rare — typically race with window destruction); `undefined`
   * tolerated for back-compat with the pre-Phase-3 shape (existing test mocks
   * omit this field — production code always populates it). Carried through
   * so callers that need to gate on class (ADR-018 Phase 3 CDP promotion:
   * `Chrome_WidgetWin_1` only) do not have to re-call `enumWindowsInZOrder`
   * / `getWindowClassName` themselves. Cheap to populate — one
   * `GetClassNameW` syscall per resolution.
   */
  className?: string | null;
}

/** Value of DESKTOP_TOUCH_DOCK_TITLE env (resolved literal, not "@parent"). */
function getDockTitleLiteral(): string | undefined {
  const raw = process.env.DESKTOP_TOUCH_DOCK_TITLE;
  if (!raw || raw === "@parent") return undefined;
  return raw;
}

/**
 * Resolve `hwnd` or `@active` shorthand to a concrete `{ title, hwnd }`.
 * Returns `null` when neither special case applies (plain windowTitle → no-op).
 * Throws `WindowNotFound` when explicit hwnd is invalid or foreground cannot be determined.
 */
/**
 * ADR-036 — a resolution handed forward, once, to the next caller that asks the
 * same question.
 *
 * `withRichNarration` has to resolve the target before the action, to know which
 * window to snapshot. The handler then resolves again, and between the two the
 * desktop can move — a modal closing, the foreground changing — which puts the
 * snapshots on one window and the write on another. That gap is not a hair: the
 * post-state wrapper takes a full focus enumeration in between (`_post.ts`).
 *
 * The obvious fix — put the resolved handle into the handler's `args` — is not
 * available, because a handler that sees `hwnd` believes the CALLER named one,
 * and that belief decides the guard descriptor, the pinning rules and the
 * wording of the refusal. So the resolution travels beside the args instead,
 * inside the invocation that resolved it: see `withPinnedResolution` below for
 * why the scope is the invocation and not the process.
 *
 * Single use and key-matched, which narrows what a NESTED call inside the same
 * invocation can take — `macro` dispatches wrapped handlers, so scopes nest.
 * The key alone was never enough on its own, for the reason `withPinnedResolution`
 * gives: the same question has different answers at different times.
 */
const pinnedResolution = new AsyncLocalStorage<{
  key: string;
  value: ResolvedWindow | null;
  emitLog?: () => void;
}>();

function resolutionKey(p: { hwnd?: string; windowTitle?: string }): string {
  return `${p.hwnd ?? ""}\u0000${p.windowTitle ?? ""}`;
}

/**
 * Run `fn` with this answer available to the first matching `resolveWindowTarget`
 * inside it.
 *
 * Scoped to the invocation, not to the process. A module-global pin looked
 * enough while it was key-matched and single-use, and it was not: a rich call
 * that exits before its resolver — `keyboard:type` taking the IME fast-fail,
 * `keyboard:press` refusing an unsafe combo — leaves the pin armed while the
 * post-state wrapper awaits its focused-element snapshot, and a CONCURRENT call
 * asking the same question eats it. The key does not save that, because the
 * same question has different answers at different times: `@active` is the
 * whole point.
 */
export function withPinnedResolution<T>(
  p: { hwnd?: string; windowTitle?: string },
  value: ResolvedWindow,
  fn: () => Promise<T>,
  emitLog?: () => void
): Promise<T> {
  return pinnedResolution.run({ key: resolutionKey(p), value, emitLog }, fn);
}

/**
 * ADR-035: an event is worth writing when a dispatch happened on the resolution
 * it records. `logAs` and `deferLog` are how a caller that resolves WITHOUT
 * dispatching says so.
 *
 * Same rule as the intermediate probe inside Case 3, and `withRichNarration`
 * resolves twice under it. The first is a probe — it exists to choose what to
 * snapshot — and passes `logAs: "off"`. The second is a re-check, and whether it
 * is worth an event is not known when it runs: it becomes the resolution the
 * action uses only if it AGREES with the first and is handed to the handler. So
 * it passes `deferLog`, which hands the event back instead of writing it, and
 * `withPinnedResolution` carries it to the moment the handler takes the pin. If
 * the handler never resolves — the IME fast-fail, a refused combo — or the
 * re-check disagreed and the diff was withheld as `target_changed`, the event is
 * dropped and the handler's own resolution is the only one counted.
 *
 * Silencing the probe alone was not enough, and the first version of this shipped
 * with the gap: `narrate: "rich"` still wrote one more event than `minimal` on
 * the Case 4 dialog rescue whenever the desktop moved or the handler bailed —
 * rarer than the double count it replaced, and correlated with the same
 * parameter, in the histogram Phase C is still using to choose a predicate.
 */
export async function resolveWindowTarget(params: {
  hwnd?: string;
  windowTitle?: string;
}, options: {
  logAs?: "off";
  deferLog?: (emit: () => void) => void;
} = {}): Promise<ResolvedWindow | null> {
  const store = pinnedResolution.getStore();
  if (store && store.value && store.key === resolutionKey(params)) {
    const pinned = store.value;
    store.value = null;   // single use, within this invocation only
    // The ADR-035 event for the resolution being handed over, written HERE
    // because this is the moment it acquired a dispatch. `deferLog` held it
    // back at the wrapper precisely so a resolution nothing acted on would not
    // be counted.
    const emit = store.emitLog;
    store.emitLog = undefined;
    emit?.();
    return pinned;
  }
  const warnings: string[] = [];
  /** `logAs`/`deferLog` in one place, so the three outcomes cannot drift apart. */
  const emitResolve = (record: Parameters<typeof logResolve>[0]): void => {
    if (options.logAs === "off") return;
    if (options.deferLog) { options.deferLog(() => logResolve(record)); return; }
    logResolve(record);
  };

  // ── Case 1: explicit hwnd ─────────────────────────────────────────────────
  if (params.hwnd !== undefined) {
    let hwndb: bigint;
    try {
      hwndb = BigInt(params.hwnd);
    } catch {
      throw new Error(`WindowNotFound: hwnd "${params.hwnd}" is not a valid integer`);
    }
    let title = getWindowTitleW(hwndb);
    if (!title) {
      // Verify window still exists via rect (getWindowTitleW returns "" for invalid/invisible)
      const rect = getWindowRectByHwnd(hwndb);
      if (!rect) {
        throw new Error(`WindowNotFound: no visible window with hwnd "${params.hwnd}"`);
      }
    }

    // H3 case 5: if the owner is blocked by a modal, prefer the active popup (common dialog).
    // This handles the pattern: click_element(hwnd="<Notepad>") while Save As is open.
    try {
      const popup = preferActivePopupIfBlocked(hwndb);
      if (popup) {
        warnings.push("parent_disabled_prefer_popup");
        hwndb = popup.hwnd;
        title = popup.title;
      }
    } catch { /* conservative: keep original hwnd on error */ }

    // R3: refuse an explicit hwnd that resolves to the key locker (after any popup preferral).
    refuseIfExcludedTarget(hwndb);

    const dockLiteral = getDockTitleLiteral();
    if (dockLiteral && title.toLowerCase().includes(dockLiteral.toLowerCase())) {
      warnings.push("HwndMatchesDockWindow: targeting the CLI host window — intended?");
    }
    return { title, hwnd: hwndb, warnings, className: safeGetClassName(hwndb) };
  }

  // ── Case 2: @active shorthand ─────────────────────────────────────────────
  if (params.windowTitle === "@active") {
    const hwndb = getForegroundHwnd();
    if (hwndb === null) {
      throw new Error("WindowNotFound: @active — no foreground window could be determined");
    }
    // R3: refuse when the foreground window is the key locker (e.g. its secure dialog is up).
    refuseIfExcludedTarget(hwndb);
    const title = getWindowTitleW(hwndb);
    const dockLiteral = getDockTitleLiteral();
    if (dockLiteral && title.toLowerCase().includes(dockLiteral.toLowerCase())) {
      warnings.push(
        "@active resolved to the CLI host window. " +
        "This may capture Claude itself rather than the target app. " +
        "Specify windowTitle explicitly if this is unintentional."
      );
    }
    return { title, hwnd: hwndb, warnings, className: safeGetClassName(hwndb) };
  }

  // ── Case 3 / 4: plain windowTitle ────────────────────────────────────────
  // Case 3: a plain top-level window matches → return null so caller handles it (existing behaviour).
  // Case 4: (H3) no top-level match → search for a common dialog via owner chain.
  if (params.windowTitle) {
    // R3: a plain windowTitle that names the key locker must be refused up front — the filtered
    // searches below would return null (the locker is hidden from the enumerator), letting the
    // caller fall back to the raw title and reach the dialog through a non-win32 reader. Uses the
    // UNFILTERED title check so the (hidden) locker is visible to the refusal. (Fail-fast front
    // door; the uia-bridge + runSomPipeline guards are the downstream backstops.)
    if (isExcludedTitle(params.windowTitle)) {
      throw new WindowExcludedError(
        `WindowExcluded: windowTitle "${params.windowTitle}" names the desktop-touch key locker, ` +
        `which is not addressable by automation tools`,
      );
    }
    try {
      // Case 3: plain match exists — preserve existing pass-through behaviour.
      // ADR-018 Phase 5: delegated to the shared `findPlainTopLevelWindowByTitle`
      // helper (Phase 1b §2.2 / Phase 4 §2.2 carry-over). `excludeMinimized: false`
      // preserves the legacy Case 3 tolerance for minimized matches.
      // ADR-035 Phase 1 (Codex Round 1 P2): the plain-window lookup here is an
      // INTERMEDIATE PROBE, not the outcome — when it misses, Case 4 below may
      // still resolve a dialog. Logging the probe would put a `matchCount: 0`,
      // `chosen: null` record in front of a dispatch that did have a target,
      // which is precisely the join this phase exists to make trustworthy. So
      // the probe is silenced and each of the three real outcomes logs once.
      const plainMatches = findPlainTopLevelWindowsByTitle(params.windowTitle, {
        excludeMinimized: false,
        excludeDialogsAndOwned: true,
        logAs: "off",
      });
      if (plainMatches.length > 0) {
        emitResolve({
          resolver: "pickPlainTopLevelWindowByTitle",
          query: params.windowTitle,
          matches: plainMatches,
        });
        return null;
      }

      // Case 4: no plain match — try common dialog fallback.
      const wins = enumWindowsInZOrder();
      const { chosen: dialog, candidates } = findCommonDialogByTitle(wins, params.windowTitle);
      const runnersUp = candidates.slice(1);
      if (dialog) {
        // `matchCount` counts the DIALOG candidates (they did match by title,
        // just not as plain top-level windows); `fallback:"owner-chain"` is
        // what says the window came from the dialog rescue rather than the
        // primary rule, so the two events are not confused for one another.
        emitResolve({
          resolver: "resolveWindowTargetDialog",
          query: params.windowTitle,
          matches: [dialog, ...runnersUp],
          chosen: dialog,
          fallback: "owner-chain",
        });
        warnings.push("dialog_resolved_via_owner_chain");
        return {
          title: dialog.title,
          hwnd: dialog.hwnd,
          warnings,
          className: safeGetClassName(dialog.hwnd),
        };
      }
      // Neither route matched — a true miss, and the H2 case worth counting.
      emitResolve({
        resolver: "pickPlainTopLevelWindowByTitle",
        query: params.windowTitle,
        matches: [],
      });
    } catch { /* enumWindowsInZOrder unavailable → fall through */ }
  }

  return null;
}
