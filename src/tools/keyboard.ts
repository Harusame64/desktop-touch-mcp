import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { buildDesc } from "./_types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { keyboard } from "../engine/nutjs.js";
import { parseKeys } from "../utils/key-map.js";
import { assertKeyComboSafe } from "../utils/key-safety.js";
import { enumWindowsInZOrder, getWindowClassName, restoreAndFocusWindow } from "../engine/win32.js";
import {
  canInjectViaPostMessage,
  postCharsToHwnd,
  postKeyComboToHwnd,
  postEnterToHwnd,
  isBgAutoEnabled,
  TERMINAL_WINDOW_CLASSES,
} from "../engine/bg-input.js";
import { getTextViaTextPattern } from "../engine/uia-bridge.js";
import { stripAnsi } from "../engine/ansi.js";
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { coercedBoolean } from "./_coerce.js";
import { withRichNarration, narrateParam } from "./_narration.js";
import { detectFocusLoss, checkForegroundOnce } from "./_focus.js";
import { evaluatePreToolGuards, buildEnvelopeFor } from "../engine/perception/registry.js";
import { runActionGuard, isAutoGuardEnabled, validateAndPrepareFix, consumeFix } from "./_action-guard.js";
import { resolveWindowTarget } from "./_resolve-window.js";
import { makeCommitWrapper, withEnvelopeIncludeForUnion } from "./_envelope.js";

const execFileAsync = promisify(execFile);

/**
 * Set the Windows clipboard via PowerShell, using Base64 to handle any Unicode text.
 * Then paste with Ctrl+V to bypass IME conversion.
 */
export async function typeViaClipboard(text: string, pasteCombo: "ctrl+v" | "ctrl+shift+v" = "ctrl+v"): Promise<void> {
  // Save current clipboard (best-effort — non-text content will be lost)
  let savedClipboard: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"],
      { timeout: 3000 }
    );
    savedClipboard = stdout;
  } catch {
    // Clipboard may be empty or locked — proceed without saving
  }

  // Encode as UTF-16LE (PowerShell's native string encoding)
  const b64 = Buffer.from(text, "utf16le").toString("base64");
  const script =
    `$b=[System.Convert]::FromBase64String('${b64}');` +
    `$t=[System.Text.Encoding]::Unicode.GetString($b);` +
    `Set-Clipboard -Value $t`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 5000,
  });

  const combo = parseKeys(pasteCombo);
  await keyboard.pressKey(...combo);
  await keyboard.releaseKey(...combo);

  // Brief delay to let the paste complete before restoring clipboard
  await new Promise((resolve) => setTimeout(resolve, 120));

  // Restore previous clipboard (best-effort)
  if (savedClipboard !== null) {
    try {
      const restoreB64 = Buffer.from(savedClipboard, "utf16le").toString("base64");
      const restoreScript =
        `$b=[System.Convert]::FromBase64String('${restoreB64}');` +
        `$t=[System.Text.Encoding]::Unicode.GetString($b);` +
        `Set-Clipboard -Value $t`;
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", restoreScript], {
        timeout: 3000,
      });
    } catch {
      // Restore is best-effort — don't fail the overall operation
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #177 — BG path post-send delivery verification helpers
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors `src/tools/terminal.ts` (PR #174 v1.3.2 規範): pre-send UIA
// TextPattern baseline → WM_CHAR / WM_KEYDOWN send → 150ms settle → post-send
// read-back. Embedded-newline gate (conhost prompt interleaving) and
// SHA-256 marker boundary are kept identical. The only divergence from
// terminal.ts is keyboard.ts targets a wider class of windows (not just
// terminals), so the verification gate adds:
//   - TextPattern unavailability → "unverifiable" (status hint), not fail
//   - press(non-arrow / non-enter / non-tab) → "unverifiable" by design,
//     because semantic effects (selection change, menu open) need
//     target-specific observation channels we can't generalise
// See docs/operation-verification-matrix.md §3.1 (keyboard rows) and §4.

/**
 * Normalise text the same way terminal.ts marker logic does.
 *
 * Removed the per-line `[ \t]+$/gm` strip after Codex P1 v2: stripping
 * trailing whitespace from every line in the read-back snapshot caused
 * legitimate inputs that end in spaces (`"cd "`, indentation tokens) to
 * silently lose those spaces in the diff and false-fail exact matching as
 * BackgroundInputNotDelivered. Trailing-newline collapse and CRLF→LF
 * normalisation are kept because the input side already strips
 * `[\r\n]+$` and we don't want to compare a shell prompt's terminator
 * against an input boundary.
 */
function normalizeForMarker(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "");
}

/** SHA-256 (hex, 16 chars) of the last 256 normalised chars. */
function makeKeyboardBaselineMarker(text: string): string {
  const norm = normalizeForMarker(text);
  const slice = norm.slice(-256);
  return createHash("sha256").update(slice).digest("hex").slice(0, 16);
}

/**
 * Slice `text` after a previously-recorded marker. Returns matched:false when
 * the baseline boundary cannot be relocated (caller treats that as
 * "verification undetermined", not "delivery failed").
 */
function applyKeyboardSinceMarker(
  text: string,
  marker: string,
): { text: string; matched: boolean } {
  const norm = normalizeForMarker(text);
  const WINDOW = 256;
  const tailFromNormEnd = (normEnd: number): string =>
    norm.slice(normEnd).replace(/^\n/, "");

  if (norm.length >= WINDOW) {
    const maxScan = Math.min(norm.length, WINDOW + 32_000);
    for (let end = norm.length; end >= norm.length - maxScan && end >= WINDOW; end--) {
      const slice = norm.slice(end - WINDOW, end);
      if (createHash("sha256").update(slice).digest("hex").slice(0, 16) === marker) {
        return { text: tailFromNormEnd(end), matched: true };
      }
    }
    return { text, matched: false };
  }

  for (let end = norm.length; end >= 0; end--) {
    if (createHash("sha256").update(norm.slice(0, end)).digest("hex").slice(0, 16) === marker) {
      return { text: tailFromNormEnd(end), matched: true };
    }
  }
  return { text, matched: false };
}

/**
 * Issue #177: shape for `hints.verifyDelivery` per matrix doc §4.2.
 *
 * - `delivered`: Strict / Indirect verification passed.
 * - `unverifiable`: no observation channel available — caller should not
 *   assume delivery from `ok:true` alone. `reason` is a typed enum from
 *   matrix doc §4.3.
 *
 * `focus_only` is reserved for the FG path (mouse_click / keyboard FG) and
 * is not used here — BG is HWND-targeted, focus is irrelevant.
 */
type VerifyDeliveryStatus = "delivered" | "unverifiable";
interface VerifyDeliveryHint {
  status: VerifyDeliveryStatus;
  /**
   * Typed reason from matrix doc §4.3. Intentionally typed loose (string)
   * because the enum is documented in the matrix doc, not in code — adding
   * new reasons is a doc-only PR (matrix §4.3 last paragraph).
   */
  reason?: string;
  /** Send channel (matrix doc §4.2). */
  channel?: "wm_char" | "wm_keydown";
  /** Suggested next path the caller can try. */
  fallback?: string;
}

/**
 * Keys that produce a buffer mutation visible to UIA TextPattern read-back
 * on terminal-class targets:
 *   - enter / "\r": appends a new line → cursor advance + new prompt.
 *   - tab: inserts whitespace at cursor → trailing-content diff visible
 *     when the prompt does not consume it as completion.
 *   - arrows: move cursor → may alter the rendered cursor row in the
 *     TextPattern snapshot (best-effort; some hosts repaint without diff).
 *
 * The check is intentionally narrow — broader combos (ctrl+c interrupting a
 * running command, ctrl+l clearing the screen) DO mutate the buffer but the
 * *direction* of the change differs per target, so a generic "post.length >
 * pre.length" check would false-positive on ctrl+l (clears) and false-negative
 * on ctrl+c at a clean prompt.
 */
function isReadBackVerifiableCombo(keys: string): boolean {
  const trimmed = keys.toLowerCase().trim();
  // No modifiers (the read-back signal is only reliable for plain navigation /
  // line-commit keys; modified combos take semantic actions we can't generalise).
  if (trimmed.includes("+")) return false;
  return (
    trimmed === "enter" ||
    trimmed === "tab" ||
    trimmed === "left" ||
    trimmed === "right" ||
    trimmed === "up" ||
    trimmed === "down"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const forceFocusParam = coercedBoolean().optional().describe(
  "When true, bypass Windows foreground-stealing protection via AttachThreadInput " +
  "before focusing the target window. Default: follows env DESKTOP_TOUCH_FORCE_FOCUS (default false)."
);

const trackFocusParam = coercedBoolean().default(true).describe(
  "When true (default), detect if focus was stolen from the target window after the action. " +
  "Reports focusLost in the response. Set false to skip."
);

const settleMsParam = z.coerce.number().int().min(0).max(2000).default(300).describe(
  "Milliseconds to wait after the action before checking foreground window (default 300)."
);

const windowTitleFocusParam = z.string().optional().describe(
  "Partial title of the window that should receive the keystrokes. " +
  "When provided, the server focuses this window before typing and uses it as the expected " +
  "target for focusLost detection. Use '@active' for the current foreground window."
);

const hwndFocusParam = z.string().optional().describe(
  "Direct window handle ID (takes precedence over windowTitle). " +
  "Obtain from desktop_discover response (windows[].hwnd). " +
  "String type to avoid 64-bit precision issues."
);

/** Non-ASCII punctuation that can be hijacked as Chrome/Edge keyboard accelerators */
const NON_ASCII_SYMBOL_RE = /[\u2013\u2014\u2018\u2019\u201C\u201D\u2026\u00A0]/;

const methodParam = z.enum(["auto", "background", "foreground"]).default("auto").describe(
  "Input routing channel. " +
  "'auto' uses background (PostMessage) when the target window is a known terminal class " +
  "(Windows Terminal / cmd / PowerShell) OR DTM_BG_AUTO=1 is set; else foreground. Terminal " +
  "auto-detect is HWND-targeted so user-side focus changes mid-stream cannot divert keystrokes. " +
  "'background' forces PostMessage-only (no focus change, fails on Chromium/IME). " +
  "'foreground' forces the current behavior (SetForegroundWindow + keystrokes). " +
  "Default 'auto'."
);

export const keyboardTypeSchema = {
  text: z.string().max(10000).describe("The text to type (max 10,000 characters)"),
  method: methodParam,
  narrate: narrateParam,
  use_clipboard: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, copy text to clipboard and paste with Ctrl+V instead of simulating keystrokes. " +
      "Use this when typing URLs, paths, or ASCII text into apps with Japanese IME active — " +
      "prevents IME from converting characters. Default false."
    ),
  replaceAll: z.boolean().optional().default(false).describe(
    "When true, send Ctrl+A to select all existing text before typing. " +
    "Equivalent to Ctrl+A → keyboard(action='type') in one call (requires field already focused). Default false."
  ),
  forceKeystrokes: z.boolean().optional().default(false).describe(
    "When true, always use keystroke mode even if text contains non-ASCII symbols " +
    "(em-dash, en-dash, smart quotes, etc.) that would normally trigger auto-clipboard. " +
    "Default false — auto-clipboard is enabled."
  ),
  windowTitle: windowTitleFocusParam,
  hwnd: hwndFocusParam,
  forceFocus: forceFocusParam,
  trackFocus: trackFocusParam,
  settleMs: settleMsParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards (safe.keyboardTarget) are evaluated before typing, " +
    "and a perception envelope is attached to post.perception on success."
  ),
  fixId: z.string().optional().describe(
    "Approve a pending suggestedFix (one-shot, 15s TTL). Pass the fixId returned by a previous " +
    "failed keyboard(action='type') to re-attempt with guard-validated args."
  ),
  abortOnFocusLoss: z.boolean().optional().describe(
    "Focus Leash Phase B: when true, the foreground keystroke send is split into " +
    "chunks (default 8 chars; override via DTM_LEASH_CHUNK_SIZE env) and the target " +
    "window's foreground state is verified between chunks. If the user grabs focus " +
    "mid-stream, the call aborts and returns FocusLostDuringType with " +
    "context.typed (chars delivered to target) and context.remaining (unsent tail) " +
    "so the caller can re-focus and retry the unsent portion. " +
    "Default: true when windowTitle is provided, false otherwise. " +
    "Has no effect on the clipboard path (atomic Ctrl+V) or the BG (WM_CHAR) path " +
    "(HWND-targeted, foreground-independent)."
  ),
};

export const keyboardPressSchema = {
  keys: z
    .string()
    .max(100)
    .describe("Key combo string, e.g. 'ctrl+c', 'alt+tab', 'enter', 'ctrl+shift+s'. Note: win+r, win+x, win+s, win+l are blocked for security."),
  method: methodParam,
  narrate: narrateParam,
  windowTitle: windowTitleFocusParam,
  hwnd: hwndFocusParam,
  forceFocus: forceFocusParam,
  trackFocus: trackFocusParam,
  settleMs: settleMsParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards (safe.keyboardTarget) are evaluated before the key press."
  ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

interface FocusForKeyboardResult {
  warnings: string[];
  homingNotes: string[];
  /**
   * true when the target window is confirmed to be in the foreground after
   * focusWindowForKeyboard returns. Covers two cases:
   *   1. Target was already the active window at entry (no focus work needed).
   *   2. Focus attempt (with or without force-escalation) verified via EnumWindows.
   * Callers pass this into the auto-guard so safe.keyboardTarget's foreground
   * fluent check is bypassed (the caller's verification is more authoritative than
   * a second EnumWindows racing with foreground-stealing protection).
   */
  foregroundVerified: boolean;
  /** true when SetForegroundWindow was refused even after force-escalation. */
  forceRefused: boolean;
}

async function focusWindowForKeyboard(
  windowTitle: string,
  force: boolean,
): Promise<FocusForKeyboardResult> {
  const warnings: string[] = [];
  const homingNotes: string[] = [];
  let foregroundVerified = false;
  let forceRefused = false;
  const needle = windowTitle.toLowerCase();
  try {
    const windows = enumWindowsInZOrder();
    const active = windows.find((w) => w.isActive);
    if (active && active.title.toLowerCase().includes(needle)) {
      // Target is already in the foreground — nothing to do.
      foregroundVerified = true;
    } else {
      const target = windows.find((w) => w.title.toLowerCase().includes(needle));
      if (target) {
        // Always verify foreground after focus so the auto-guard does not block
        // on a stale/foreground-steal-prevented SetForegroundWindow. If the first
        // attempt (honoring caller's `force` flag) fails to transfer the foreground,
        // auto-escalate to force=true so windowTitle+auto-guard remains a reliable
        // contract (the caller already expressed intent by passing windowTitle).
        restoreAndFocusWindow(target.hwnd, { force });
        await new Promise<void>((r) => setTimeout(r, 100));
        let after = enumWindowsInZOrder().find((w) => w.isActive);
        let reachedForeground = !!after && after.title.toLowerCase().includes(needle);

        if (!reachedForeground && !force) {
          // Auto-escalate to force focus (AttachThreadInput bypass) — the caller
          // asked us to type into this window, so bringing it to the foreground
          // is required for the keystrokes to reach the right target.
          restoreAndFocusWindow(target.hwnd, { force: true });
          await new Promise<void>((r) => setTimeout(r, 100));
          after = enumWindowsInZOrder().find((w) => w.isActive);
          reachedForeground = !!after && after.title.toLowerCase().includes(needle);
        }

        if (reachedForeground) {
          homingNotes.push(`brought "${target.title}" to front`);
          foregroundVerified = true;
        } else {
          warnings.push("ForceFocusRefused");
          forceRefused = true;
        }
      }
    }
  } catch {
    // best-effort
  }
  return { warnings, homingNotes, foregroundVerified, forceRefused };
}

/**
 * Defensive safety valve: emit KeyUp for the common modifier keys so they
 * cannot remain stuck-down after an interrupted keystroke sequence.
 *
 * Why this exists (Phase B follow-up — Gemini PR #65 review):
 * Although the chunked send aborts at character boundaries (each
 * `await keyboard.type(chunk)` resolves only after every character's
 * modifier KeyDown/KeyUp pair completes inside nut-js), this is a
 * defense-in-depth measure for paths where the OS-level modifier state
 * could plausibly leak:
 *   - Future iterations using raw SendInput with explicit modifier framing
 *     (mid-character interrupt becomes possible).
 *   - An exception thrown inside nutjs.keyboard.type leaving a paired
 *     KeyUp un-emitted.
 *   - Catastrophic exceptions during replaceAll Ctrl+A.
 *
 * KeyUp on a key that is not currently down is a safe no-op at the OS
 * level (Windows tracks modifier state per-key and ignores redundant
 * KEYEVENTF_KEYUP). Total cost: ~6 keyboard events per call, sub-ms
 * latency. Without this, a user grabbing focus while we held Shift would
 * see "modifier stuck-down" symptoms (Ctrl: ghost zoom on scroll; Shift:
 * unwanted multi-select; Alt: spurious menu opens) — a notorious UX hazard
 * in UI automation.
 */
async function releaseDanglingModifiers(): Promise<void> {
  // Cover both L and R variants; Windows tracks them as distinct VKs.
  for (const combo of ["lctrl", "rctrl", "lalt", "ralt", "lshift", "rshift"]) {
    try {
      const keys = parseKeys(combo);
      await keyboard.releaseKey(...keys);
    } catch {
      // Best-effort: a single releaseKey failure must not skip the others.
    }
  }
}

/**
 * Read the chunk size for the Phase B leash (foreground SendInput chunked send).
 * Env override `DTM_LEASH_CHUNK_SIZE` accepts integer 1-1024; invalid or unset
 * values fall back to the default of 8 chars/chunk (~80ms granularity at typical
 * keystroke speeds — sub-perceptible to the user but tight enough to abort
 * within ~1 chunk of focus theft).
 */
export function getLeashChunkSize(): number {
  const raw = process.env.DTM_LEASH_CHUNK_SIZE;
  if (!raw) return 8;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > 1024) return 8;
  return n;
}

/**
 * Resolve the effective input routing channel when caller passes `method: 'auto'`.
 *
 * Precedence:
 *   1. inputMethod !== 'auto' → returned as-is.
 *   2. DTM_BG_AUTO=1 env flag → 'background-auto' (existing global toggle).
 *   3. Target window class is a known terminal class (TERMINAL_WINDOW_CLASSES)
 *      → 'background-auto'. Focus Leash Phase A: HWND-targeted WM_CHAR delivery
 *      survives user-side foreground changes mid-stream, so keystrokes intended
 *      for a terminal can no longer be diverted to a window the user clicks into.
 *   4. Otherwise → 'auto' (downstream check fails, falls through to foreground).
 *
 * The downstream BG path retains its `canInjectViaPostMessage` gate, so a class
 * misclassification simply falls through to foreground (line 354).
 */
/**
 * Evaluate lensId guards and auto-guard before sending keyboard input.
 *
 * Used by both the foreground path (after focus, with foregroundVerified=true)
 * and the BG path (Focus Leash Phase A, with foregroundVerified=true since
 * HWND-targeted WM_CHAR delivery is foreground-independent — see
 * _action-guard.ts:51-53: foregroundVerified=true only skips the foreground
 * gate, while identity/modal/dirty/focusedElement gates still run).
 *
 * Returns either a perception envelope (caller attaches to response) or a
 * pre-built failure ToolResult (caller returns directly).
 *
 * NOTE: Phase A wires the BG path to call this. The foreground path still
 * inlines an equivalent block; a follow-up patch may DRY them.
 */
export async function evaluateKeyboardGuards(opts: {
  toolName: "keyboard:type" | "keyboard:press";
  lensId: string | undefined;
  skipAutoGuard: boolean;
  effectiveWindowTitle: string | undefined;
  foregroundVerified: boolean;
  warnings: string[];
}): Promise<
  | { ok: true; perceptionEnv?: import("../engine/perception/types.js").PostPerception }
  | { ok: false; errorResult: ToolResult }
> {
  const {
    toolName, lensId, skipAutoGuard, effectiveWindowTitle, foregroundVerified, warnings,
  } = opts;

  if (lensId) {
    const guardResult = await evaluatePreToolGuards(lensId, toolName, {});
    if (!guardResult.ok && guardResult.policy === "block") {
      const env = buildEnvelopeFor(lensId, { toolName });
      return {
        ok: false,
        errorResult: failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          toolName,
          {
            lensId,
            guard: guardResult.failedGuard,
            _perceptionForPost: env,
            ...(warnings.length > 0 && { hints: { warnings } }),
          }
        ),
      };
    }
    return {
      ok: true,
      perceptionEnv: buildEnvelopeFor(lensId, { toolName }) ?? undefined,
    };
  }

  if (!skipAutoGuard && isAutoGuardEnabled()) {
    const descriptor = effectiveWindowTitle
      ? { kind: "window" as const, titleIncludes: effectiveWindowTitle }
      : null;
    const ag = await runActionGuard({
      toolName, actionKind: "keyboard", descriptor,
      ...(foregroundVerified && { foregroundVerified: true }),
    });
    if (ag.block) {
      return {
        ok: false,
        errorResult: failWith(
          new Error(`AutoGuardBlocked: ${ag.summary.next}`),
          toolName,
          {
            _perceptionForPost: ag.summary,
            ...(warnings.length > 0 && { hints: { warnings } }),
          }
        ),
      };
    }
    return { ok: true, perceptionEnv: ag.summary };
  }

  return { ok: true };
}

export function resolveEffectiveInputMethod(
  inputMethod: "auto" | "background" | "foreground",
  effectiveWindowTitle: string | undefined,
): "auto" | "background" | "foreground" | "background-auto" {
  if (inputMethod !== "auto") return inputMethod;
  if (isBgAutoEnabled()) return "background-auto";
  if (effectiveWindowTitle) {
    try {
      const wins = enumWindowsInZOrder();
      const needle = effectiveWindowTitle.toLowerCase();
      const target = wins.find((w) => w.title.toLowerCase().includes(needle));
      if (target) {
        const cls = getWindowClassName(target.hwnd);
        if (cls && TERMINAL_WINDOW_CLASSES.has(cls)) {
          return "background-auto";
        }
      }
    } catch {
      // best-effort — fall through to "auto" so downstream still works
    }
  }
  return inputMethod;
}

export const keyboardTypeHandler = async ({
  text,
  method: inputMethod = "auto",
  use_clipboard,
  replaceAll,
  forceKeystrokes,
  windowTitle,
  hwnd,
  forceFocus: forceFocusArg,
  trackFocus,
  settleMs,
  lensId,
  fixId,
  abortOnFocusLoss,
  _skipAutoGuard = false,
}: {
  text: string;
  method?: "auto" | "background" | "foreground";
  /** Internal flag: skip auto-guard evaluation (used by set_element_value keyboard fallback). */
  _skipAutoGuard?: boolean;
  use_clipboard: boolean;
  replaceAll: boolean;
  forceKeystrokes: boolean;
  windowTitle?: string;
  hwnd?: string;
  forceFocus?: boolean;
  trackFocus: boolean;
  settleMs: number;
  lensId?: string;
  fixId?: string;
  abortOnFocusLoss?: boolean;
}): Promise<ToolResult> => {
  const force = forceFocusArg ?? (process.env.DESKTOP_TOUCH_FORCE_FOCUS === "1");
  try {
    // Phase G: fixId approval prologue
    let effectiveText = text;
    let effectiveWindowTitle = windowTitle;
    if (fixId) {
      const vr = validateAndPrepareFix(fixId, "keyboard");
      if (!vr.ok || !vr.fix) return failWith(new Error(vr.errorCode!), "keyboard");
      if (typeof vr.fix.args.windowTitle === "string") effectiveWindowTitle = vr.fix.args.windowTitle;
      if (typeof vr.fix.args.text === "string") effectiveText = vr.fix.args.text;
      consumeFix(fixId);
    }

    // Resolve hwnd / @active → effective window title (only when not using a fixId)
    const resolvedWin = !fixId ? await resolveWindowTarget({ hwnd, windowTitle: effectiveWindowTitle }) : null;
    if (resolvedWin) effectiveWindowTitle = resolvedWin.title;

    const warnings: string[] = [...(resolvedWin?.warnings ?? [])];
    const homingNotes: string[] = [];
    let foregroundVerified = false;

    // ── Background input path ──────────────────────────────────────────────
    // Resolve effective method: "auto" + (DTM_BG_AUTO=1 OR target is a known
    // terminal class) → try BG first. See resolveEffectiveInputMethod.
    const effectiveMethod = resolveEffectiveInputMethod(inputMethod, effectiveWindowTitle);

    if ((effectiveMethod === "background" || effectiveMethod === "background-auto") && effectiveWindowTitle) {
      const wins = enumWindowsInZOrder();
      const target = wins.find(w => w.title.toLowerCase().includes(effectiveWindowTitle!.toLowerCase()));
      if (target) {
        const check = canInjectViaPostMessage(target.hwnd);
        if (check.supported) {
          // Phase A safety: evaluate lensId / auto-guard BEFORE WM_CHAR send so
          // the BG path doesn't silently bypass guards that the foreground path
          // would have run (PR #64 Codex P1). foregroundVerified=true is the
          // semantically correct value for BG mode — HWND-targeted delivery is
          // foreground-independent, and that flag only skips the foreground
          // gate while modal/identity/dirty/focusedElement gates still run.
          const bgGuard = await evaluateKeyboardGuards({
            toolName: "keyboard:type",
            lensId,
            skipAutoGuard: _skipAutoGuard,
            effectiveWindowTitle,
            foregroundVerified: true,
            warnings,
          });
          if (!bgGuard.ok) return bgGuard.errorResult;
          const bgPerception = bgGuard.perceptionEnv;

          const bgWarnings: string[] = [];
          if (use_clipboard && !forceKeystrokes) {
            bgWarnings.push("BackgroundClipboardDowngraded");
          }

          // Issue #177 — post-send delivery verification (matrix doc §3.1
          // "keyboard (action:type BG)": Strict). Mirrors terminal.ts:299-496:
          //   Phase 1: pre-send TextPattern baseline + SHA-256 marker.
          //   Phase 2: side-effect injection (postCharsToHwnd).
          //   Phase 3: 150ms settle.
          //   Phase 4: post-send TextPattern read-back, exact substring +
          //            tail-N (>=4 non-whitespace chars) fallback.
          //   Phase 5: judge → BackgroundInputNotDelivered (shared with
          //            terminal — same WM_CHAR channel, same silent-drop
          //            symptom, matrix doc §3.1 row "code shared").
          //
          // Verification gate (matches terminal.ts verificationNeeded scope):
          //   - method:'background' explicit → always verify (covers WT and
          //     other auto-rejected handles the caller forced through).
          //   - DTM_BG_AUTO=1 + non-terminal class → verify (env override can
          //     route input to unknown apps).
          //   - terminal-class auto-route → skip (well-tested conhost case,
          //     150ms read-back wouldn't catch anything).
          const targetClass = (() => {
            try { return getWindowClassName(target.hwnd); } catch { return ""; }
          })();
          const isTerminalTarget = !!targetClass && TERMINAL_WINDOW_CLASSES.has(targetClass);
          const verificationNeeded =
            inputMethod === "background" || (isBgAutoEnabled() && !isTerminalTarget);

          // Skip the baseline read for unverifiable inputs to save the
          // ~PowerShell-UIA round-trip cost (no TextPattern call when we
          // already know we can't compare).
          const checkText = effectiveText.replace(/[\r\n]+$/, "");
          const hasEmbeddedNewline = /[\r\n]/.test(checkText);
          const baselineRaw =
            verificationNeeded && checkText.length > 0 && !hasEmbeddedNewline
              ? await getTextViaTextPattern(target.title)
              : null;
          const baselineMarker =
            baselineRaw !== null ? makeKeyboardBaselineMarker(stripAnsi(baselineRaw)) : null;

          if (replaceAll) postKeyComboToHwnd(target.hwnd, "ctrl+a");
          const result = postCharsToHwnd(target.hwnd, effectiveText);
          if (!result.full) {
            // Partial fail: do NOT fall through to foreground (would cause double input).
            // Return error regardless of effectiveMethod.
            return failWith(
              new Error("BackgroundInputIncomplete"),
              "keyboard:type",
              {
                suggest: [
                  "Input sent partially - retry with method:'foreground' for full input",
                  "Check context.sent vs context.total",
                ],
                context: { sent: result.sent, total: effectiveText.length },
                ...(bgPerception && { _perceptionForPost: bgPerception }),
              }
            );
          }

          // ── Issue #177: post-send UIA read-back delivery verification ──
          //
          // PostMessage(WM_CHAR) returns true when the message is queued, even
          // if the target never consumes it. Without this check, ok:true would
          // silently lie about delivery on Windows Terminal (XAML pipeline
          // swallow) and other WinUI hosts. See terminal.ts:406-460 for the
          // canonical comment thread that motivated this design.
          //
          // The check is gated by `verificationNeeded` above; here we
          // additionally skip when:
          //   - baseline could not be read (no TextPattern provider) → produce
          //     a `verifyDelivery: unverifiable` hint instead of failing,
          //   - input has no echo-able content (only trailing newlines), or
          //   - input contains embedded newlines. conhost commits each line at
          //     the CR and inserts a fresh prompt before the next line, so the
          //     buffer interleaves prompts between input lines and a plain
          //     substring includes() would false-fail.
          let verifiedDelivery: boolean | "unverifiable" = "unverifiable";
          let verifyReason: string | undefined;
          const verifiable =
            verificationNeeded &&
            baselineMarker !== null &&
            checkText.length > 0 &&
            !hasEmbeddedNewline;
          if (verifiable) {
            await new Promise<void>((r) => setTimeout(r, 150));
            const postRaw = await getTextViaTextPattern(target.title);
            if (postRaw !== null) {
              const postCleaned = stripAnsi(postRaw);
              const sliced = applyKeyboardSinceMarker(postCleaned, baselineMarker!);
              if (sliced.matched) {
                // normalizeForMarker no longer strips trailing whitespace
                // per line (Codex P1), so sliced.text preserves the input's
                // trailing spaces — compare raw checkText directly.
                const exact = sliced.text.includes(checkText);
                const tail = checkText.replace(/\s+/g, "").slice(-8);
                const slicedNoWs = sliced.text.replace(/\s+/g, "");
                const tailMatch = tail.length >= 4 && slicedNoWs.includes(tail);
                verifiedDelivery = exact || tailMatch;
              }
              // Marker miss (matched:false): undetermined — keep "unverifiable"
              // and fall through to ok with verifyDelivery hint.
              if (verifiedDelivery === "unverifiable") {
                verifyReason = "read_back_unsupported";
              }
            } else {
              verifyReason = "read_back_unsupported";
            }
          } else if (verificationNeeded) {
            // verifiable=false reasons (matrix §4.3 enum): TextPattern
            // baseline missing → read_back_unsupported; embedded newline →
            // embedded_newline. Empty checkText falls through silently.
            if (baselineMarker === null && checkText.length > 0) {
              verifyReason = "read_back_unsupported";
            } else if (hasEmbeddedNewline) {
              verifyReason = "embedded_newline";
            }
          }

          if (verifiedDelivery === false) {
            // suggest[] is provided by classify() via SUGGESTS.BackgroundInputNotDelivered
            // — keep this call site free of duplicated copy so the dictionary stays SSOT.
            return failWith(
              new Error("BackgroundInputNotDelivered"),
              "keyboard:type",
              {
                context: {
                  hint: "post-send UIA read-back did not contain the input substring",
                  targetClass,
                },
                ...(bgPerception && { _perceptionForPost: bgPerception }),
              }
            );
          }

          // Build hints.verifyDelivery (matrix doc §4.2). Always include the
          // hint when verification was attempted so callers can tell apart
          // "delivered (passed Strict check)" from "ok:true (no observation
          // path)" — the latter is the silent-success category we're hardening
          // against in issue #173.
          const verifyDelivery: VerifyDeliveryHint | null = verificationNeeded
            ? verifiedDelivery === true
              ? { status: "delivered", channel: "wm_char" }
              : {
                  status: "unverifiable",
                  ...(verifyReason && { reason: verifyReason }),
                  channel: "wm_char",
                  fallback: "method:'foreground'",
                }
            : null;

          return ok({
            ok: true,
            typed: result.sent,
            method: "background",
            channel: "wm_char",
            foregroundChanged: false,
            ...((bgWarnings.length > 0 || verifyDelivery) && {
              hints: {
                ...(bgWarnings.length > 0 && { warnings: bgWarnings }),
                ...(verifyDelivery && { verifyDelivery }),
              },
            }),
            ...(bgPerception && { _perceptionForPost: bgPerception }),
          });
        } else if (effectiveMethod === "background") {
          // Issue #195 / matrix doc §3.1 + §4.3 alignment:
          //   - `wt_xaml_pipeline` reason → `BackgroundInputNotDelivered`
          //     (Strict fail per matrix §4.3; the BG-path post-send
          //     read-back at line 770-783 returns the same code for
          //     supported channels that fail to land — so explicit BG to
          //     a target the engine knows it cannot deliver to should
          //     return the same code, mirroring terminal.ts:439-470).
          //   - other reasons (`chromium` / `uwp_sandboxed` /
          //     `class_unknown`) → `BackgroundInputUnsupported` with the
          //     existing call-site suggest ("For Chrome/Edge: use
          //     browser_fill instead"). Splitting by reason preserves
          //     each reason's existing recovery hint contract (PR #174
          //     round 2 P1-1: same code → same suggest).
          if (check.reason === "wt_xaml_pipeline") {
            return failWith(
              new Error("BackgroundInputNotDelivered"),
              "keyboard:type",
              {
                // suggest[] from SUGGESTS dictionary (matrix §2.3 SSOT) —
                // keep this call site free of duplicated copy.
                context: {
                  hint: "target's WinUI/XAML pipeline silently swallows WM_CHAR — use method:'foreground'",
                  reason: check.reason,
                  ...(check.className !== undefined && { className: check.className }),
                  ...(check.processName !== undefined && { processName: check.processName }),
                },
              }
            );
          }
          return failWith(
            new Error("BackgroundInputUnsupported"),
            "keyboard:type",
            {
              suggest: [
                "Target app does not accept background input - use method:'foreground' or omit",
                "For Chrome/Edge: use browser_fill instead",
              ],
              context: { className: check.className, processName: check.processName },
            }
          );
        }
        // auto + not supported → fall through to foreground path
      } else if (effectiveMethod === "background") {
        return failWith(
          new Error("BackgroundInputUnsupported"),
          "keyboard:type",
          { suggest: ["Window not found - verify windowTitle"], context: { windowTitle: effectiveWindowTitle } }
        );
      }
    }

    // Step 1: Focus first (guard needs foreground state to be correct).
    if (effectiveWindowTitle) {
      const fw = await focusWindowForKeyboard(effectiveWindowTitle, force);
      warnings.push(...fw.warnings);
      homingNotes.push(...fw.homingNotes);
      foregroundVerified = fw.foregroundVerified;
    }

    // Step 2: Guard evaluation (on already-focused window).
    let perceptionEnv: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "keyboard:type", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        const env = buildEnvelopeFor(lensId, { toolName: "keyboard:type" });
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "keyboard:type",
          {
            lensId,
            guard: guardResult.failedGuard,
            _perceptionForPost: env,
            ...(warnings.length > 0 && { hints: { warnings } }),
          }
        );
      }
      perceptionEnv = buildEnvelopeFor(lensId, { toolName: "keyboard:type" }) ?? undefined;
    } else if (!_skipAutoGuard && isAutoGuardEnabled()) {
      const descriptor = effectiveWindowTitle
        ? { kind: "window" as const, titleIncludes: effectiveWindowTitle }
        : null;
      const ag = await runActionGuard({
        toolName: "keyboard:type", actionKind: "keyboard", descriptor,
        ...(foregroundVerified && { foregroundVerified: true }),
        ...(fixId && { fixCarryingArgs: { text: effectiveText, windowTitle: effectiveWindowTitle } }),
      });
      if (ag.block) {
        return failWith(
          new Error(`AutoGuardBlocked: ${ag.summary.next}`),
          "keyboard:type",
          {
            _perceptionForPost: ag.summary,
            ...(warnings.length > 0 && { hints: { warnings } }),
          }
        );
      }
      perceptionEnv = ag.summary;
    }

    // Ctrl+A to replace existing content before typing
    if (replaceAll) {
      const selectAll = parseKeys("ctrl+a");
      await keyboard.pressKey(...selectAll);
      await keyboard.releaseKey(...selectAll);
    }

    // Auto-clipboard: upgrade to clipboard mode when non-ASCII symbols are present
    // (unless the caller opted out via forceKeystrokes)
    let effectiveClipboard = use_clipboard;
    let autoClipboardReason: string | undefined;
    if (!use_clipboard && !forceKeystrokes && NON_ASCII_SYMBOL_RE.test(effectiveText)) {
      effectiveClipboard = true;
      autoClipboardReason = "non-ASCII symbol detected";
    }

    if (effectiveClipboard) {
      await typeViaClipboard(effectiveText);
    } else {
      // Focus Leash Phase B: when the caller named a target window and didn't
      // opt out, split the keystroke send into chunks and verify foreground
      // between chunks. If the user grabs focus mid-stream, abort and return
      // FocusLostDuringType with typed/remaining so the caller can re-focus
      // and retry the unsent portion. Default abortOnFocusLoss=true when
      // windowTitle is provided (caller stated a target = caller cares which
      // window receives input); false otherwise.
      const leashEnabled =
        !!effectiveWindowTitle &&
        (abortOnFocusLoss !== undefined ? abortOnFocusLoss : true);
      if (leashEnabled) {
        const chunkSize = getLeashChunkSize();
        // Iterate over code points (not UTF-16 code units) so chunk
        // boundaries never bisect a surrogate pair. Without this, emoji or
        // other non-BMP characters could be split mid-surrogate by
        // String.slice and `keyboard.type` would receive unpaired surrogate
        // halves (PR #65 Codex P2). `typed` counts UTF-16 code units to
        // stay consistent with `effectiveText.length` and the slice index
        // used to compute `remaining`, so callers can resume by passing
        // `text: context.remaining` directly.
        const codePoints = Array.from(effectiveText);
        let typed = 0;
        try {
          for (let i = 0; i < codePoints.length; i += chunkSize) {
            const fl = await checkForegroundOnce({
              target: effectiveWindowTitle,
              homingNotes,
            });
            if (fl) {
              // Defensive: release any modifier that might have leaked from
              // an interrupted keystroke sequence so the user's session
              // doesn't get a stuck Shift/Ctrl/Alt (Gemini PR #65 review —
              // 'release safety valve'). KeyUp is idempotent at the OS level.
              await releaseDanglingModifiers();
              return failWith(
                new Error("FocusLostDuringType"),
                "keyboard:type",
                {
                  suggest: [
                    "User stole foreground mid-type — re-focus the target window then call keyboard(action:'type') again with context.remaining as text",
                    "For terminals, prefer method:'auto' so input routes through HWND-targeted WM_CHAR (Phase A — foreground-independent)",
                    "Pass abortOnFocusLoss:false to disable the leash and fall back to single-shot send (post-action focusLost detection still runs)",
                  ],
                  context: {
                    typed,
                    remaining: effectiveText.slice(typed),
                    total: effectiveText.length,
                    chunkSize,
                    focusLost: fl,
                  },
                  ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
                  ...(warnings.length > 0 && { hints: { warnings } }),
                }
              );
            }
            const chunk = codePoints.slice(i, i + chunkSize).join("");
            await keyboard.type(chunk);
            typed += chunk.length; // UTF-16 code units delivered
          }
        } catch (err) {
          // Unexpected throw inside the chunked send — release modifiers
          // before bubbling so the outer catch can format the error response.
          await releaseDanglingModifiers();
          throw err;
        }
      } else {
        await keyboard.type(effectiveText);
      }
    }

    let focusLost = undefined;
    if (trackFocus) {
      const fl = await detectFocusLoss({
        target: effectiveWindowTitle,
        homingNotes,
        settleMs,
      });
      if (fl) focusLost = fl;
    }

    const method = effectiveClipboard
      ? autoClipboardReason
        ? "clipboard-auto"
        : "clipboard"
      : "keystroke";

    return ok({
      ok: true,
      typed: effectiveText.length,
      method,
      ...(autoClipboardReason && { autoClipboardReason }),
      ...(focusLost && { focusLost }),
      ...(warnings.length > 0 && { hints: { warnings } }),
      ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
    });
  } catch (err) {
    return failWith(err, "keyboard:type");
  }
};

export const keyboardPressHandler = async ({
  keys,
  method: inputMethod = "auto",
  windowTitle,
  hwnd,
  forceFocus: forceFocusArg,
  trackFocus,
  settleMs,
  lensId,
}: {
  keys: string;
  method?: "auto" | "background" | "foreground";
  windowTitle?: string;
  hwnd?: string;
  forceFocus?: boolean;
  trackFocus: boolean;
  settleMs: number;
  lensId?: string;
}): Promise<ToolResult> => {
  const force = forceFocusArg ?? (process.env.DESKTOP_TOUCH_FORCE_FOCUS === "1");
  try {
    // assertKeyComboSafe before focus — invalid keys fail immediately.
    assertKeyComboSafe(keys);

    // Resolve hwnd / @active → effective window title
    const resolvedWin = await resolveWindowTarget({ hwnd, windowTitle });
    const effectiveWindowTitle = resolvedWin?.title ?? windowTitle;

    const warnings: string[] = [...(resolvedWin?.warnings ?? [])];
    const homingNotes: string[] = [];
    let foregroundVerified = false;

    // ── Background input path ──────────────────────────────────────────────
    const effectiveMethod = resolveEffectiveInputMethod(inputMethod, effectiveWindowTitle);
    if ((effectiveMethod === "background" || effectiveMethod === "background-auto") && effectiveWindowTitle) {
      const wins = enumWindowsInZOrder();
      const target = wins.find(w => w.title.toLowerCase().includes(effectiveWindowTitle!.toLowerCase()));
      if (target && canInjectViaPostMessage(target.hwnd).supported) {
        // Phase A safety: evaluate lensId / auto-guard before WM_CHAR send so
        // BG path doesn't silently bypass guards (PR #64 Codex P1). See type
        // handler comment above for foregroundVerified=true rationale.
        const bgGuard = await evaluateKeyboardGuards({
          toolName: "keyboard:press",
          lensId,
          skipAutoGuard: false,
          effectiveWindowTitle,
          foregroundVerified: true,
          warnings,
        });
        if (!bgGuard.ok) return bgGuard.errorResult;
        const bgPerception = bgGuard.perceptionEnv;

          // Issue #177 — post-send delivery verification (matrix doc §3.1
          // "keyboard (action:press BG)": Indirect). Most key combos take
          // semantic actions (selection change, menu open, app shortcut) that
          // need target-specific observation channels, so the default outcome
          // is `verifyDelivery: { status: "unverifiable" }` to be honest about
          // not having checked.
          //
          // **Exception**: enter / tab / arrow on terminal-class targets
          // produce a buffer mutation that UIA TextPattern read-back can
          // detect (cursor advance, new line). See `isReadBackVerifiableCombo`
          // for the explicit allow-list and matrix doc §3.1 row "press BG"
          // for the rationale.
          const targetClass = (() => {
            try { return getWindowClassName(target.hwnd); } catch { return ""; }
          })();
          const isTerminalTarget = !!targetClass && TERMINAL_WINDOW_CLASSES.has(targetClass);
          const verificationNeeded =
            inputMethod === "background" || (isBgAutoEnabled() && !isTerminalTarget);
          const readBackVerifiable =
            verificationNeeded && isTerminalTarget && isReadBackVerifiableCombo(keys);

        const isEnter = keys.toLowerCase() === "enter";

        // Pre-send baseline (only when read-back will be attempted).
        const baselineRaw = readBackVerifiable
          ? await getTextViaTextPattern(target.title)
          : null;
        const baselineMarker =
          baselineRaw !== null ? makeKeyboardBaselineMarker(stripAnsi(baselineRaw)) : null;

        const ok2 = isEnter
          ? postEnterToHwnd(target.hwnd)
          : postKeyComboToHwnd(target.hwnd, keys);
        if (!ok2) {
          // postKeyComboToHwnd may fail after partially sending a combo (e.g.,
          // modifier WM_KEYDOWN succeeded but the next message failed), leaving
          // modifier state inconsistent in the target. Falling through to the
          // foreground path would replay the combo and double-input or leave
          // dangling modifiers — fail regardless of method (PR #64 Codex P1).
          return failWith(
            new Error("BackgroundInputIncomplete"),
            "keyboard:press",
            {
              suggest: [
                "Key press failed in background mode - retry with method:'foreground'",
                "If terminal runs elevated (admin) and caller does not, foreground delivery may be required (UIPI blocks WM_CHAR)",
              ],
              context: { keys },
              ...(bgPerception && { _perceptionForPost: bgPerception }),
            }
          );
        }

        // ── Post-send read-back (terminal-class enter/tab/arrow only) ──
        let verifiedDelivery: boolean | "unverifiable" = "unverifiable";
        let verifyReason: string | undefined;
        if (readBackVerifiable && baselineMarker !== null) {
          await new Promise<void>((r) => setTimeout(r, 150));
          const postRaw = await getTextViaTextPattern(target.title);
          if (postRaw !== null) {
            const postCleaned = stripAnsi(postRaw);
            const sliced = applyKeyboardSinceMarker(postCleaned, baselineMarker);
            // Detection rule per key:
            //   - enter: a new line appeared in the diff (the prompt printed
            //     after the line commit), so sliced.text contains '\n' OR
            //     non-empty new content.
            //   - tab: cursor moved → diff is non-empty (whitespace insertion
            //     OR completion suggestion rendered into the buffer).
            //   - arrows: cursor row may shift; we accept any non-whitespace
            //     diff as evidence of repaint. False-negatives are possible
            //     when the host repaints in place — that's why this is gated
            //     to terminal-class targets where the prompt + cursor model
            //     is well-defined.
            if (sliced.matched) {
              const trimmed = keys.toLowerCase().trim();
              const diffNoWs = sliced.text.replace(/\s+/g, "");
              if (trimmed === "enter") {
                verifiedDelivery = sliced.text.includes("\n") || diffNoWs.length > 0;
              } else if (trimmed === "tab") {
                // Tab inserts whitespace (or completion text) at the cursor;
                // any non-empty diff in the slice = delivered.
                verifiedDelivery = sliced.text.length > 0;
              } else {
                // Arrow keys (left/right/up/down): cursor moves but UIA
                // TextPattern frequently does NOT expose cursor-position
                // changes in the diff slice. An empty diff is therefore
                // undetermined, NOT a failure: report `unverifiable` so a
                // legitimate arrow press is not classified as
                // BackgroundKeyNotDelivered (Codex P1). Non-empty diff (e.g.
                // a host that does repaint cursor row into the buffer) is
                // still accepted as `delivered`.
                verifiedDelivery = sliced.text.length > 0 ? true : "unverifiable";
              }
            }
            if (verifiedDelivery === "unverifiable") {
              verifyReason = "read_back_unsupported";
            }
          } else {
            verifyReason = "read_back_unsupported";
          }
        } else if (verificationNeeded) {
          // Most combos: no observation channel → unverifiable by design.
          // matrix doc §3.1 explicitly lists this as the regular outcome.
          verifyReason = "read_back_unsupported";
        }

        if (verifiedDelivery === false) {
          return failWith(
            new Error("BackgroundKeyNotDelivered"),
            "keyboard:press",
            {
              context: {
                hint: "post-send UIA read-back did not observe the expected buffer mutation",
                keys,
                targetClass,
              },
              ...(bgPerception && { _perceptionForPost: bgPerception }),
            }
          );
        }

        // Channel for hints (matrix §4.2): enter uses postEnterToHwnd which
        // sends WM_CHAR '\r' (terminals normalise it as a line commit), all
        // other combos use postKeyComboToHwnd / WM_KEYDOWN+WM_KEYUP.
        const pressChannel: "wm_char" | "wm_keydown" = isEnter ? "wm_char" : "wm_keydown";
        const verifyDelivery: VerifyDeliveryHint | null = verificationNeeded
          ? verifiedDelivery === true
            ? { status: "delivered", channel: pressChannel }
            : {
                status: "unverifiable",
                ...(verifyReason && { reason: verifyReason }),
                channel: pressChannel,
                fallback: "method:'foreground'",
              }
          : null;

        return ok({
          ok: true,
          pressed: keys,
          method: "background",
          channel: "wm_char",
          foregroundChanged: false,
          ...(verifyDelivery && { hints: { verifyDelivery } }),
          ...(bgPerception && { _perceptionForPost: bgPerception }),
        });
      } else if (effectiveMethod === "background") {
        return failWith(
          new Error("BackgroundInputUnsupported"),
          "keyboard:press",
          { suggest: ["Target app does not accept background input - use method:'foreground' or omit"], context: { windowTitle: effectiveWindowTitle } }
        );
      }
    }

    // Step 1: Focus first (guard needs foreground state to be correct).
    if (effectiveWindowTitle) {
      const fw = await focusWindowForKeyboard(effectiveWindowTitle, force);
      warnings.push(...fw.warnings);
      homingNotes.push(...fw.homingNotes);
      foregroundVerified = fw.foregroundVerified;
    }

    // Step 2: Guard evaluation (on already-focused window).
    let perceptionEnv: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "keyboard:press", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        const env = buildEnvelopeFor(lensId, { toolName: "keyboard:press" });
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "keyboard:press",
          {
            lensId,
            guard: guardResult.failedGuard,
            _perceptionForPost: env,
            ...(warnings.length > 0 && { hints: { warnings } }),
          }
        );
      }
      perceptionEnv = buildEnvelopeFor(lensId, { toolName: "keyboard:press" }) ?? undefined;
    } else if (isAutoGuardEnabled()) {
      const descriptor = effectiveWindowTitle
        ? { kind: "window" as const, titleIncludes: effectiveWindowTitle }
        : null;
      const ag = await runActionGuard({
        toolName: "keyboard:press", actionKind: "keyboard", descriptor,
        ...(foregroundVerified && { foregroundVerified: true }),
      });
      if (ag.block) {
        return failWith(
          new Error(`AutoGuardBlocked: ${ag.summary.next}`),
          "keyboard:press",
          {
            _perceptionForPost: ag.summary,
            ...(warnings.length > 0 && { hints: { warnings } }),
          }
        );
      }
      perceptionEnv = ag.summary;
    }

    const keyList = parseKeys(keys);
    await keyboard.pressKey(...keyList);
    await keyboard.releaseKey(...keyList);

    let focusLost = undefined;
    if (trackFocus) {
      const fl = await detectFocusLoss({
        target: effectiveWindowTitle,
        homingNotes,
        settleMs,
      });
      if (fl) focusLost = fl;
    }

    return ok({
      ok: true,
      pressed: keys,
      ...(focusLost && { focusLost }),
      ...(warnings.length > 0 && { hints: { warnings } }),
      ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
    });
  } catch (err) {
    return failWith(err, "keyboard:press");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher schema (discriminated union)
// ─────────────────────────────────────────────────────────────────────────────

// Discriminated union for the public `keyboard` tool — this is the schema
// the registered tool validates against (NOT keyboardTypeSchema /
// keyboardPressSchema above, which are kept only as exports for any external
// consumer). Field lists are inlined here because the stub-catalog generator
// (scripts/generate-stub-tool-catalog.mjs) statically parses the variants
// and cannot follow Zod object spread. Keep the field set in sync with
// keyboardTypeSchema / keyboardPressSchema; tests in
// keyboard-leash-guard.test.ts pin abortOnFocusLoss reachability so future
// drift trips a regression test instead of slipping through silently
// (PR #65 Codex P1).
export const keyboardSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("type"),
    text: z.string().max(10000).describe("The text to type (max 10,000 characters)"),
    method: methodParam,
    narrate: narrateParam,
    use_clipboard: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "If true, copy text to clipboard and paste with Ctrl+V instead of simulating keystrokes. " +
        "Use this when typing URLs, paths, or ASCII text into apps with Japanese IME active — " +
        "prevents IME from converting characters. Default false."
      ),
    replaceAll: z.boolean().optional().default(false).describe(
      "When true, send Ctrl+A to select all existing text before typing. " +
      "Equivalent to Ctrl+A → keyboard(action='type') in one call (requires field already focused). Default false."
    ),
    forceKeystrokes: z.boolean().optional().default(false).describe(
      "When true, always use keystroke mode even if text contains non-ASCII symbols " +
      "(em-dash, en-dash, smart quotes, etc.) that would normally trigger auto-clipboard. " +
      "Default false — auto-clipboard is enabled."
    ),
    windowTitle: windowTitleFocusParam,
    hwnd: hwndFocusParam,
    forceFocus: forceFocusParam,
    trackFocus: trackFocusParam,
    settleMs: settleMsParam,
    lensId: z.string().optional().describe(
      "Optional perception lens ID. Guards (safe.keyboardTarget) are evaluated before typing, " +
      "and a perception envelope is attached to post.perception on success."
    ),
    fixId: z.string().optional().describe(
      "Approve a pending suggestedFix (one-shot, 15s TTL). Pass the fixId returned by a previous " +
      "failed keyboard(action='type') to re-attempt with guard-validated args."
    ),
    abortOnFocusLoss: z.boolean().optional().describe(
      "Focus Leash Phase B: when true, the foreground keystroke send is split into " +
      "chunks (default 8 chars; override via DTM_LEASH_CHUNK_SIZE env) and the target " +
      "window's foreground state is verified between chunks. If the user grabs focus " +
      "mid-stream, the call aborts and returns FocusLostDuringType with " +
      "context.typed (chars delivered to target) and context.remaining (unsent tail) " +
      "so the caller can re-focus and retry the unsent portion. " +
      "Default: true when windowTitle is provided, false otherwise. " +
      "Has no effect on the clipboard path (atomic Ctrl+V) or the BG (WM_CHAR) path " +
      "(HWND-targeted, foreground-independent)."
    ),
  }),
  z.object({
    action: z.literal("press"),
    keys: z
      .string()
      .max(100)
      .describe("Key combo string, e.g. 'ctrl+c', 'alt+tab', 'enter', 'ctrl+shift+s'. Note: win+r, win+x, win+s, win+l are blocked for security."),
    method: methodParam,
    narrate: narrateParam,
    windowTitle: windowTitleFocusParam,
    hwnd: hwndFocusParam,
    forceFocus: forceFocusParam,
    trackFocus: trackFocusParam,
    settleMs: settleMsParam,
    lensId: z.string().optional().describe(
      "Optional perception lens ID. Guards (safe.keyboardTarget) are evaluated before the key press."
    ),
  }),
]);

export type KeyboardArgs = z.infer<typeof keyboardSchema>;

export const keyboardHandler = async (args: KeyboardArgs): Promise<import("./_types.js").ToolResult> => {
  if (args.action === "type") {
    return keyboardTypeHandler(args);
  }
  return keyboardPressHandler(args);
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `keyboard` is wrapped via `makeCommitWrapper` (lease 不在 commit variant —
 * `leaseValidator` omitted since the public `keyboard` tool is name/keys
 * driven without a lease 4-tuple, mirroring the S6 `click_element` PoC).
 * `withRichNarration` (inner) → `makeCommitWrapper` (outer) composition
 * matches `clickElementRegistrationHandler` (`ui-elements.ts:372`):
 *   - withRichNarration enriches the handler's ToolResult (`hints.diff` 等)
 *   - makeCommitWrapper handles L1 ToolCallStarted/Completed push +
 *     envelope assembly + compat hoist + tool_call_id seq
 * Module-scope export so `run_macro` (`TOOL_REGISTRY.keyboard` in
 * `macro.ts`) shares the same wrapped instance (PR #112 shared
 * registration handler pattern, strip risk prevention).
 *
 * Trunk pattern conformance: engine-perception layer 改変ゼロ
 * (expansion-pr-guard.yml + check-expansion-disjoint.mjs)、
 * handler internal logic + Zod schema + 戻り値 shape 不変
 * (ADR-010 §1.5)。
 */
/**
 * Registration-time schema with `include?: string[]` injected into each
 * variant of the `z.discriminatedUnion("action", [...])` so per-call
 * envelope opt-in (`include:["envelope"]` / `include:["causal"]` /
 * `include:["raw"]`) survives the MCP SDK's `z.parse()` step on both
 * `server.registerTool` and `run_macro` paths.
 *
 * `withEnvelopeIncludeSchema` (raw shape only) is unusable for
 * discriminatedUnion families (keyboard / clipboard / window_dock /
 * scroll / terminal / browser_eval). `withEnvelopeIncludeForUnion`
 * extends every variant object with the `include` field and rebuilds
 * the discriminator while preserving dispatch semantics.
 *
 * Without injection, Zod's default object parse strips unknown keys and
 * `include` is removed before `makeCommitWrapper` can peek it
 * (Codex PR #123 P2 + PR #112 P1-1 同型 risk pattern, discriminatedUnion
 * 系の延長線).
 */
export const keyboardRegistrationSchema = withEnvelopeIncludeForUnion(keyboardSchema);

export const keyboardRegistrationHandler = makeCommitWrapper(
  withRichNarration(
    "keyboard",
    keyboardHandler as (args: Record<string, unknown>) => Promise<import("./_types.js").ToolResult>,
    { windowTitleKey: "windowTitle" },
  ) as (args: Record<string, unknown>) => Promise<import("./_types.js").ToolResult>,
  "keyboard",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

export function registerKeyboardTools(server: McpServer): void {
  server.registerTool(
    "keyboard",
    {
      description: buildDesc({
        purpose: "Send keyboard input to a window: 'type' for text, 'press' for key combos.",
        details: "action='type' inserts text (auto-clipboard for non-ASCII / IME-safe). action='press' sends key combos like 'ctrl+c'/'alt+tab'. Pass windowTitle to auto-focus and auto-guard (verifies identity, foreground, modal) before input. Omitting windowTitle acts on the active window (unguarded).",
        prefer: "Use windowTitle to auto-focus before injection. Set lensId to enable perception guards. Use desktop_act({action:'setValue'}) for form fields backed by UIA ValuePattern.",
        caveats: "win+r/win+x/win+s/win+l blocked for security. action='type' does not handle IME composition for CJK — use use_clipboard=true or desktop_act({action:'setValue'}) instead. Non-ASCII punctuation (em-dash etc.) auto-routes via clipboard to prevent Chrome address-bar hijack; pass forceKeystrokes:true to disable. Background mode (PostMessage/WM_CHAR) auto-engages for known terminal windows (Windows Terminal / cmd / PowerShell) so keystrokes survive user-side foreground changes; DTM_BG_AUTO=1 enables it globally. Foreground-path keystrokes for non-terminal apps run with a per-chunk foreground guard (Phase B) — when the user grabs focus mid-stream, the call aborts with FocusLostDuringType and returns context.typed/context.remaining so the caller can re-focus and resume; pass abortOnFocusLoss:false to disable.",
        examples: [
          "keyboard({action:'type', text:'hello', windowTitle:'Notepad'}) → text injected (guarded)",
          "keyboard({action:'type', text:'hello'}) → text injected (unguarded)",
          "keyboard({action:'press', keys:'ctrl+c'}) → copy",
          "keyboard({action:'press', keys:'escape', windowTitle:'Dialog'}) → dismiss dialog",
        ],
      }),
      inputSchema: keyboardRegistrationSchema,
    },
    keyboardRegistrationHandler as typeof keyboardHandler,
  );
}
