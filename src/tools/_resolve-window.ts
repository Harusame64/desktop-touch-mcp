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

import {
  getForegroundHwnd, getWindowTitleW, getWindowRectByHwnd,
  // H3: hierarchy-aware dialog resolution
  enumWindowsInZOrder, getWindowOwner, getWindowClassName, isWindowEnabled, getLastActivePopup,
} from "../engine/win32.js";

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
  opts: {
    excludeMinimized?: boolean;
    excludeDialogsAndOwned?: boolean;
  } = {},
): ReturnType<typeof enumWindowsInZOrder>[number] | null {
  if (!title) return null;
  const { excludeMinimized = false, excludeDialogsAndOwned = false } = opts;
  try {
    const q = title.toLowerCase();
    const wins = enumWindowsInZOrder();
    return (
      wins.find((w) => {
        if (excludeMinimized && w.isMinimized) return false;
        if (excludeDialogsAndOwned) {
          if (DIALOG_CLASSNAMES.has(w.className ?? "")) return false;
          if (w.ownerHwnd != null) return false;
        }
        return w.title.toLowerCase().includes(q);
      }) ?? null
    );
  } catch {
    // `enumWindowsInZOrder` unavailable → null (callers fall through to their
    // own fallback / unresolved path).
    return null;
  }
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
): DialogCandidate | null {
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
  return classed[0] ?? owned[0] ?? null;
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
export async function resolveWindowTarget(params: {
  hwnd?: string;
  windowTitle?: string;
}): Promise<ResolvedWindow | null> {
  const warnings: string[] = [];

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
    try {
      // Case 3: plain match exists — preserve existing pass-through behaviour.
      // ADR-018 Phase 5: delegated to the shared `findPlainTopLevelWindowByTitle`
      // helper (Phase 1b §2.2 / Phase 4 §2.2 carry-over). `excludeMinimized: false`
      // preserves the legacy Case 3 tolerance for minimized matches.
      const plainMatch = findPlainTopLevelWindowByTitle(params.windowTitle, {
        excludeMinimized: false,
        excludeDialogsAndOwned: true,
      });
      if (plainMatch) return null;

      // Case 4: no plain match — try common dialog fallback.
      const wins = enumWindowsInZOrder();
      const dialog = findCommonDialogByTitle(wins, params.windowTitle);
      if (dialog) {
        warnings.push("dialog_resolved_via_owner_chain");
        return {
          title: dialog.title,
          hwnd: dialog.hwnd,
          warnings,
          className: safeGetClassName(dialog.hwnd),
        };
      }
    } catch { /* enumWindowsInZOrder unavailable → fall through */ }
  }

  return null;
}
