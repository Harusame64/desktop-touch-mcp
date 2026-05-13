import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { buildDesc } from "./_types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { keyboard, withKeyboardLock, rawKeyboard } from "../engine/nutjs.js";
import { parseKeys } from "../utils/key-map.js";
import { assertKeyComboSafe } from "../utils/key-safety.js";
import { enumWindowsInZOrder, getWindowClassName, restoreAndFocusWindow } from "../engine/win32.js";
import { nativeWin32 } from "../engine/native-engine.js";
import {
  canInjectViaPostMessage,
  postCharsToHwnd,
  postKeyComboToHwnd,
  postEnterToHwnd,
  isBgAutoEnabled,
  injectViaForegroundFlash,
  TERMINAL_WINDOW_CLASSES,
} from "../engine/bg-input.js";
import { resolveBackgroundInputChannel } from "../engine/background-channel-resolver.js";
import { getTextViaTextPattern, getTextViaValuePattern } from "../engine/uia-bridge.js";
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

// Note: keyboard input serialization (issue #255) lives at the engine layer
// in `src/engine/nutjs.ts` so it applies to every caller — the keyboard
// tool here, scroll PageDown / PageUp keystrokes, terminal:send fallback,
// and any future tool that reaches into the same libnut backend. See the
// design rationale block at the top of nutjs.ts.

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

  // Phase 5 E1 (epic #211): combine Set-Clipboard + Get-Clipboard -Raw inside
  // a single PowerShell invocation and compare base64-encoded UTF-16LE bytes
  // for byte-equality. Mirrors the clipboard:write contract at
  // src/tools/clipboard.ts:60-118 — the audit's E1 finding caught that
  // typeViaClipboard (used by terminal:send FG / keyboard:type FG clipboard
  // paths) was missing the read-back verification that clipboard:write
  // landed in PR #180. Without verification, DLP / clipboard manager
  // intercepts on Set-Clipboard would silently leave stale clipboard
  // contents and the paste would inject wrong text into the target window
  // (silent-fail violating Phase 5 north-star).
  const b64 = Buffer.from(text, "utf16le").toString("base64");
  const script =
    `$b=[System.Convert]::FromBase64String('${b64}');` +
    `$t=[System.Text.Encoding]::Unicode.GetString($b);` +
    `Set-Clipboard -Value $t;` +
    `$r=Get-Clipboard -Raw;` +
    `if($r -eq $null){Write-Output ''}else{` +
    `[Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($r))` +
    `}`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 5000,
  });

  // Byte-equal compare (UTF-16LE, the native Windows clipboard format).
  // Buffer.equals avoids any normalization (NFC/NFD), BOM, or trailing-
  // newline coercion that string comparison could introduce. Mirror the
  // clipboard.ts:96-118 mismatch path: throw a typed Error so classify()
  // routes it to code:'ClipboardWriteNotDelivered' (auto-classify via
  // _errors.ts:397-398). Do NOT include actual clipboard contents in
  // the message — a racing app may have placed sensitive data on the
  // clipboard.
  const expectedBytes = Buffer.from(text, "utf16le");
  const readBackB64 = stdout.trim();
  const actualBytes = readBackB64 ? Buffer.from(readBackB64, "base64") : Buffer.alloc(0);
  if (!expectedBytes.equals(actualBytes)) {
    throw new Error("ClipboardWriteNotDelivered");
  }

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
 * Issue #257: widened to include `focus_only` so the keyboard(action:'sequence')
 * FG path can report "all steps issued via SendInput, foreground held, but the
 * menu state itself cannot be directly observed". This mirrors the
 * `_mouse-verify.ts` canonical `VerifyDeliveryStatus` enum (matrix doc §4.4)
 * while keeping the keyboard-specific `channel` / `fallback` fields that
 * canonical does not carry.
 */
type VerifyDeliveryStatus = "delivered" | "focus_only" | "unverifiable";
interface VerifyDeliveryHint {
  status: VerifyDeliveryStatus;
  /**
   * Typed reason from matrix doc §4.3. Intentionally typed loose (string)
   * because the enum is documented in the matrix doc, not in code — adding
   * new reasons is a doc-only PR (matrix §4.3 last paragraph).
   */
  reason?: string;
  /** Send channel (matrix doc §4.2). `sendinput` is the FG sequence channel. */
  channel?: "wm_char" | "wm_keydown" | "sendinput";
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

const methodParam = z.enum(["auto", "background", "foreground", "foreground_flash"]).default("auto").describe(
  "Input routing channel. " +
  "'auto' uses background (PostMessage) when the target window is a known terminal class " +
  "(Windows Terminal / cmd / PowerShell) OR DTM_BG_AUTO=1 is set; else foreground. Terminal " +
  "auto-detect is HWND-targeted so user-side focus changes mid-stream cannot divert keystrokes. " +
  "'background' forces PostMessage-only (no focus change, fails on Chromium/IME). " +
  "'foreground' forces the current behavior (SetForegroundWindow + keystrokes). " +
  "'foreground_flash' (ADR-013 Option E) is an explicit opt-in 妥協 BG path for Windows " +
  "Terminal: temporarily steals foreground (~50-80ms), pastes via clipboard, sends Ctrl+V, " +
  "restores foreground + clipboard. Single-line + < 5KiB only. Carries `typingLeakRisk: true` " +
  "in hints because user keystrokes during the flash window can leak to WT. " +
  "Default 'auto'."
);

export const keyboardTypeSchema = {
  text: z.string().max(10000).describe("The text to type (max 10,000 characters)"),
  method: methodParam,
  narrate: narrateParam,
  use_clipboard: coercedBoolean()
    .optional()
    .default(false)
    .describe(
      "If true, copy text to clipboard and paste with Ctrl+V instead of simulating keystrokes. " +
      "Use this when typing URLs, paths, or ASCII text into apps with Japanese IME active — " +
      "prevents IME from converting characters. Default false."
    ),
  replaceAll: coercedBoolean().optional().default(false).describe(
    "When true, send Ctrl+A to select all existing text before typing. " +
    "Equivalent to Ctrl+A → keyboard(action='type') in one call (requires field already focused). Default false."
  ),
  forceKeystrokes: coercedBoolean().optional().default(false).describe(
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
  abortOnFocusLoss: coercedBoolean().optional().describe(
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
  forceImeOff: coercedBoolean().optional().default(false).describe(
    "Issue #245 系統②: when true, query the target window's IME open-status via " +
    "Imm32 before typing; if ON, switch OFF for the duration of this call and " +
    "restore the prior state in `finally`. Prevents silent romaji conversion when " +
    "the user's Japanese IME is active but the LLM is typing ASCII commands. " +
    "Requires `windowTitle` or `hwnd` (otherwise no target to query). Default false " +
    "— existing use_clipboard auto-promotion still handles non-ASCII symbols " +
    "transparently. No-op when the addon predates the IMM bridge (call proceeds " +
    "with whatever IME state is in effect)."
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
  /**
   * Final foreground HWND after focusWindowForKeyboard returns.
   *
   * Populated when the target window was found AND foreground was verified
   * (case 1 or 2 above). null when the target could not be found at all
   * (enumWindowsInZOrder did not return a matching window) or when an
   * exception was swallowed.
   *
   * Issue #257 sequence handler uses this for hwnd-based mid-sequence focus
   * verification so a title rename mid-flight (e.g. Excel appending an
   * unsaved marker) is not misclassified as focus loss.
   */
  targetHwnd: bigint | null;
}

async function focusWindowForKeyboard(
  windowTitle: string,
  force: boolean,
): Promise<FocusForKeyboardResult> {
  const warnings: string[] = [];
  const homingNotes: string[] = [];
  let foregroundVerified = false;
  let forceRefused = false;
  let targetHwnd: bigint | null = null;
  const needle = windowTitle.toLowerCase();
  try {
    const windows = enumWindowsInZOrder();
    const active = windows.find((w) => w.isActive);
    if (active && active.title.toLowerCase().includes(needle)) {
      // Target is already in the foreground — nothing to do.
      foregroundVerified = true;
      targetHwnd = active.hwnd;
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
          targetHwnd = after?.hwnd ?? target.hwnd;
        } else {
          warnings.push("ForceFocusRefused");
          forceRefused = true;
        }
      }
    }
  } catch {
    // best-effort
  }
  return { warnings, homingNotes, foregroundVerified, forceRefused, targetHwnd };
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
  inputMethod: "auto" | "background" | "foreground" | "foreground_flash",
  effectiveWindowTitle: string | undefined,
): "auto" | "background" | "foreground" | "foreground_flash" | "background-auto" {
  // 'foreground_flash' は明示 opt-in、auto-resolve せずそのまま返す。
  if (inputMethod === "foreground_flash") return inputMethod;
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
  forceImeOff = false,
  _skipAutoGuard = false,
}: {
  text: string;
  method?: "auto" | "background" | "foreground" | "foreground_flash";
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
  forceImeOff?: boolean;
}): Promise<ToolResult> => {
  // Issue #245 系統②: IME state inspection. We need the IME open-status when
  // either (a) forceImeOff is requested or (b) the caller intends to use the
  // keystroke pipeline without clipboard escape (forceKeystrokes && !use_clipboard).
  // The IMM query is best-effort: skipped silently when the addon predates the
  // bridge or the target HWND has no associated IME.
  let imeOpenOnEntry = false;
  let imeRestoreHwnd: bigint | null = null;
  if ((forceImeOff || (forceKeystrokes && !use_clipboard)) && (windowTitle || hwnd)) {
    let resolvedHwndForIme: bigint | null = null;
    try {
      if (hwnd) {
        resolvedHwndForIme = BigInt(hwnd);
      } else if (windowTitle) {
        const needle = windowTitle.toLowerCase();
        const w = enumWindowsInZOrder().find((x) => x.title.toLowerCase().includes(needle));
        if (w) resolvedHwndForIme = BigInt(w.hwnd);
      }
      if (resolvedHwndForIme != null && typeof nativeWin32?.win32GetImeOpenStatus === "function") {
        imeOpenOnEntry = nativeWin32.win32GetImeOpenStatus(resolvedHwndForIme) === true;
      }
    } catch {
      // IMM bridge unavailable — proceed as if IME were off.
    }

    if (imeOpenOnEntry) {
      if (forceImeOff && resolvedHwndForIme != null) {
        // Flip OFF for the duration of this call; restore in the outer finally.
        try {
          nativeWin32?.win32SetImeOpenStatus?.(resolvedHwndForIme, false);
          imeRestoreHwnd = resolvedHwndForIme;
        } catch {
          // best-effort
        }
      } else if (forceKeystrokes && !use_clipboard) {
        // Fast-fail before the silent romaji-conversion failure: the caller
        // explicitly opted out of clipboard auto-promotion, the target has IME
        // ON, and they did not pass forceImeOff. There is no safe path — the
        // keystrokes would be IME-composed and the resulting text would not
        // match `text`. Surface a typed error with actionable suggestions.
        // `failWith` itself nests non-hoisted keys under `context`; pass them
        // flat so the LLM-facing shape is `context.imeOpen` (not `context.context.imeOpen`).
        return failWith(new Error("ImeOnDuringType"), "keyboard:type", {
          windowTitle, imeOpen: true, forceKeystrokes: true, useClipboard: false,
        });
      }
    }
  }

  try {
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

    // ── ADR-013 Option E: foreground_flash 明示 opt-in path ────────────────
    // method:'foreground_flash' は `background` 契約とは分離した妥協 BG path
    // (Clipboard + foreground flash + paste + restore)。WT 等 WM_CHAR 不対応
    // window 用、single-line + < 5KiB 制約、typing leak risk hints あり。
    if (inputMethod === "foreground_flash") {
      if (!effectiveWindowTitle) {
        return failWith(
          new Error("ForegroundFlashRequiresTarget"),
          "keyboard:type",
          {
            suggest: ["method:'foreground_flash' requires windowTitle or hwnd"],
            context: {},
          }
        );
      }
      const wins = enumWindowsInZOrder();
      const target = wins.find((w) =>
        w.title.toLowerCase().includes(effectiveWindowTitle!.toLowerCase())
      );
      if (!target) {
        return failWith(
          new Error("WindowNotFound"),
          "keyboard:type",
          { context: { windowTitle: effectiveWindowTitle } }
        );
      }
      // Lens / auto-guard: foregroundVerified=false because flash will steal
      // foreground, but it returns to original within ~80ms; downstream guards
      // (modal/identity/dirty/focusedElement) still run.
      const ffGuard = await evaluateKeyboardGuards({
        toolName: "keyboard:type",
        lensId,
        skipAutoGuard: _skipAutoGuard,
        effectiveWindowTitle,
        foregroundVerified: false,
        warnings,
      });
      if (!ffGuard.ok) return ffGuard.errorResult;
      const ffPerception = ffGuard.perceptionEnv;

      const channel = resolveBackgroundInputChannel(target.hwnd, {
        allowedChannels: ["wm_char", "clipboard_flash"],
      });

      if (channel.kind === "unsupported") {
        return failWith(
          new Error("ForegroundFlashUnsupported"),
          "keyboard:type",
          {
            context: { reason: channel.reason, windowTitle: effectiveWindowTitle },
            suggest: [
              "method:'foreground_flash' resolved to unsupported channel",
              "Try method:'foreground' for Chromium / UWP / unknown classes",
            ],
            ...(ffPerception && { _perceptionForPost: ffPerception }),
          }
        );
      }

      if (channel.kind === "wm_char") {
        // Terminal-class target — wm_char path is preferable (no foreground steal).
        // Resolver picked wm_char via allowedChannels; honour it without UIA
        // post-send verification (= simplified BG path、Phase 3 MVP scope)。
        // Opus Round 1 P2-6 反映: replaceAll 失敗 → warning 集約。
        const ffWarnings = [...warnings];
        if (replaceAll) {
          const okSelectAll = postKeyComboToHwnd(target.hwnd, "ctrl+a");
          if (!okSelectAll) ffWarnings.push("ReplaceAllFailed");
        }
        const r = postCharsToHwnd(target.hwnd, effectiveText);
        if (!r.full) {
          return failWith(
            new Error("BackgroundInputIncomplete"),
            "keyboard:type",
            {
              context: { sent: r.sent, total: effectiveText.length },
              ...(ffPerception && { _perceptionForPost: ffPerception }),
            }
          );
        }
        return ok({
          ok: true,
          method: "foreground_flash",
          hints: {
            backgroundChannel: "wm_char",
            warnings: ffWarnings,
          },
          ...(ffPerception && { perception: ffPerception }),
        });
      }

      // channel.kind === "clipboard_flash" — WT XAML、ADR-013 Option E 本流
      // (cooperative_bridge は Option F、Phase 3 MVP scope 外で resolver も
      //  返さない、ここで narrow に reject)
      if (channel.kind !== "clipboard_flash") {
        return failWith(
          new Error("ForegroundFlashChannelNotImplemented"),
          "keyboard:type",
          { context: { kind: channel.kind, windowTitle: effectiveWindowTitle } }
        );
      }
      // Opus Round 2 P1-3 反映: Codex Round 1 P2-A の clipboard_flash 経路
      // replaceAll honor 案 (`postKeyComboToHwnd(channel.hwnd, "ctrl+a")`) は
      // **WT XAML pipeline で silent drop される dead path**。WT が WM_CHAR を
      // sink する根拠 (issue #173) は WM_KEYDOWN/UP (= postKeyComboToHwnd の
      // 出力) にも同様に適用、PostMessage 経路の Ctrl+A は届かない。
      // 正しくは native `win32_foreground_flash_inject` に `select_all_first`
      // option を追加し、foreground steal 後に `SendInput(Ctrl+A)` → 30ms 待 →
      // `SendInput(Ctrl+V)` で送るべき (native scope の改修、別 follow-up PR)。
      // 当面 (本 PR scope): clipboard_flash 経路では replaceAll を **silent
      // ignore せず warning で caller に明示** (`ReplaceAllNotSupportedOnClipboardFlash`)。
      const ffWarnings = [...warnings];
      if (replaceAll) {
        ffWarnings.push("ReplaceAllNotSupportedOnClipboardFlash");
      }
      const flashResult = injectViaForegroundFlash(
        channel.hwnd,
        channel.pid,
        effectiveText,
        { pressEnter: false }, // keyboard:type は Enter 自動押下しない
      );
      if (!flashResult.ok) {
        return failWith(
          new Error(flashResult.reason ?? "ForegroundFlashFailed"),
          "keyboard:type",
          {
            context: {
              reason: flashResult.reason,
              rawError: flashResult.rawError,
              windowTitle: effectiveWindowTitle,
            },
            ...(ffPerception && { _perceptionForPost: ffPerception }),
          }
        );
      }
      return ok({
        ok: true,
        method: "foreground_flash",
        hints: {
          backgroundChannel: "clipboard_flash",
          typingLeakRisk: true,
          typingLeakMitigation: "userTypingDuringFlashMayLeakToWT",
          flashDurationMs: flashResult.result?.flashDurationMs,
          foregroundStealMethod: flashResult.result?.foregroundStealMethod,
          foregroundRestored: flashResult.result?.foregroundRestored,
          foregroundRestoreMethod: flashResult.result?.foregroundRestoreMethod,
          clipboardRestored: flashResult.result?.clipboardRestored,
          clipboardSkippedFormats: flashResult.result?.clipboardSkippedFormats ?? [],
          warnings: ffWarnings,
        },
        ...(ffPerception && { perception: ffPerception }),
      });
    }

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
          // Phase 7 F4 P2-1 (Round 1 review): run TextPattern + ValuePattern
          // baseline reads in parallel via Promise.all, so the causal window
          // between baseline capture and injection stays close to
          // max(textPattern, valuePattern) ms instead of summing both PowerShell
          // round-trips on the cold path. Win11 New Notepad RichEditD2DPT
          // (the F4 target) only has ValuePattern, so the cold path is where
          // users actually live.
          //
          // Wall-clock trade-off (Round 2 P3-1):
          //   * Both legs PS (no nativeUia)  → max ≈ either ≈ baseline cost
          //   * nativeUia loaded for TextPattern only (current state, line 1118
          //     of uia-bridge.ts) → max = ValuePattern PS spawn ≈ +PS wall-clock
          //     on the hot path. The cold-path improvement (Win11 Notepad) and
          //     reduced false-negative rate on the F4 target outweigh the hot-
          //     path PS cost. Future work: native ValuePattern binding to
          //     close the gap.
          const shouldReadBaselines =
            verificationNeeded && checkText.length > 0 && !hasEmbeddedNewline;
          const [baselineRaw, valueBaselineRaw] = shouldReadBaselines
            ? await Promise.all([
                getTextViaTextPattern(target.title),
                getTextViaValuePattern(target.title),
              ])
            : [null, null];
          const baselineMarker =
            baselineRaw !== null ? makeKeyboardBaselineMarker(stripAnsi(baselineRaw)) : null;
          // F4-bis fix (PR #234 follow-up): always retain `valueBaselineRaw`,
          // independent of whether `baselineMarker` was successfully built
          // from the TextPattern path. Originally this was discarded when
          // baselineMarker !== null on the assumption that "TP non-null →
          // TP path is reliable" — but PR #234 §F4-bis showed that
          // getTextViaTextPattern can return non-null junk text from
          // unrelated descendants (Notepad menu / title bar) even when the
          // focused control does not implement TextPattern. Retaining
          // valueBaseline lets the verifiable branch run a 2nd-defense VP
          // delta comparison when TP slicing yields "unverifiable".
          const valueBaseline = valueBaselineRaw;

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
              // Marker miss (matched:false): undetermined — keep "unverifiable".
            }
            // F4-bis 2nd-defense VP delta layer: TP path was inconclusive
            // (postRaw=null OR sliced.matched=false). Re-uses the parallel-
            // fetched valueBaseline (always-retained per F4-bis fix above).
            // Only consulted when TP did not authoritatively decide
            // delivered/false — TP-confirmed outcomes stay authoritative
            // for WT/conhost where TP is the canonical channel. Mirrors the
            // VP delta logic in the `else if (verificationNeeded)` branch
            // below; keep the two sites in sync if either is touched.
            if (verifiedDelivery === "unverifiable" && valueBaseline !== null) {
              const postValue = await getTextViaValuePattern(target.title);
              if (postValue !== null) {
                const containsText = postValue.includes(checkText);
                const delta = postValue.length - valueBaseline.length;
                if (containsText) {
                  if (delta > 0 || !valueBaseline.includes(checkText)) {
                    verifiedDelivery = true;
                  }
                  // else: re-type with no length growth → keep unverifiable
                  // (false-positive guard, e.g. user re-typed identical text).
                } else {
                  // VP shows checkText not landed in focused element →
                  // not delivered. Caller surfaces BackgroundInputNotDelivered.
                  verifiedDelivery = false;
                }
              }
              // postValue === null (focus race / VP unavailable) → keep
              // unverifiable, verifyReason set below.
            }
            if (verifiedDelivery === "unverifiable") {
              verifyReason = "read_back_unsupported";
            }
          } else if (verificationNeeded) {
            // Phase 7 F4 fallback: TextPattern baseline missing → try
            // ValuePattern delta comparison on the focused element. This
            // catches Win11 New Notepad / RichEdit / other ValuePattern-only
            // controls that the TextPattern path cannot read.
            if (
              baselineMarker === null &&
              checkText.length > 0 &&
              !hasEmbeddedNewline &&
              valueBaseline !== null
            ) {
              await new Promise<void>((r) => setTimeout(r, 150));
              const postValue = await getTextViaValuePattern(target.title);
              if (postValue !== null) {
                const containsText = postValue.includes(checkText);
                const delta = postValue.length - valueBaseline.length;
                if (containsText) {
                  // Delivered if length grew (text appended) OR baseline did
                  // not previously contain checkText (replaceAll / focus-fresh
                  // shape; e.g. ctrl+a then type replaces the buffer so post
                  // length can shrink yet the typed text is what landed).
                  // Otherwise both sides contain checkText with no length
                  // change — undetermined (could be a re-type of identical
                  // content), fall back to unverifiable rather than
                  // false-positive delivered.
                  if (delta > 0 || !valueBaseline.includes(checkText)) {
                    verifiedDelivery = true;
                  } else {
                    verifyReason = "read_back_unsupported";
                  }
                } else {
                  // postValue does not contain checkText → injection did not
                  // land in the focused ValuePattern element. Treat as
                  // not-delivered so caller surfaces BackgroundInputNotDelivered.
                  verifiedDelivery = false;
                }
              } else {
                verifyReason = "read_back_unsupported";
              }
            } else if (baselineMarker === null && checkText.length > 0) {
              // Both TextPattern and ValuePattern paths unavailable, OR fallback
              // disabled by guard above (empty checkText / embedded newline).
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
      // Issue #202: when both default and force escalation refused, surface
      // ForegroundRestricted typed code + ok:false (mirror window.ts:170-185
      // contract from PR #201). Returning ok:true with just a warning was
      // a silent regression — keystrokes would land on the wrong window
      // and callers had no machine-readable signal to abort.
      if (fw.forceRefused) {
        // P2-1 (Opus PR #206 Round 1): when lensId was supplied, inject the
        // perception envelope into the failure payload so run_macro chains
        // can read post.perception.status the same way Step 2 guard failures
        // do (line 894-906). Pre-fix this early-return dropped the envelope.
        const earlyEnv = lensId ? buildEnvelopeFor(lensId, { toolName: "keyboard:type" }) : null;
        // P2-1 (Opus PR #206 Round 2): hint文言は force=true / force=false
        // で正確に分岐。focusWindowForKeyboard は force=true caller には
        // initial AttachThreadInput のみ試行 (default ladder skip)、
        // force=false caller には default → escalate force ladder。
        const hint = force
          ? "Win11 refused the AttachThreadInput escalation"
          : "Win11 refused both default SetForegroundWindow and the AttachThreadInput escalation";
        return failWith(
          new Error("ForegroundRestricted"),
          "keyboard:type",
          {
            windowTitle: effectiveWindowTitle,
            hint,
            attemptedForce: force,
            // P3-1 (Opus PR #206 Round 2): autoEscalated は force=false
            // 経路で focusWindowForKeyboard が ladder を踏んだか否か。
            // focus_window の semantic と整合。
            autoEscalated: !force,
            ...(earlyEnv && { _perceptionForPost: earlyEnv }),
          }
        );
      }
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
              // Phase 5 I1 (Phase 2a F4): pass typed/remaining/etc. as flat
              // context fields so failWith's classify() resolves the code to
              // "FocusLostDuringType" (SSOT registered in _errors.ts), suggest
              // is hoisted to top-level from SUGGESTS dictionary (no handler
              // hard-code), and inner fields land at single-nest
              // `context.{typed,remaining,total,chunkSize,focusLost}` (not the
              // pre-fix double-nested `context.context.{typed,...}` shape).
              return failWith(
                new Error("FocusLostDuringType"),
                "keyboard:type",
                {
                  typed,
                  remaining: effectiveText.slice(typed),
                  total: effectiveText.length,
                  chunkSize,
                  focusLost: fl,
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
  } finally {
    // Issue #245 系統②b: restore the prior IME state. Wrap in try/catch so a
    // late failure (e.g. window destroyed mid-call) does not mask the
    // handler's actual return value.
    if (imeRestoreHwnd !== null) {
      try {
        nativeWin32?.win32SetImeOpenStatus?.(imeRestoreHwnd, true);
      } catch {
        // best-effort restore; ignore
      }
    }
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
  method?: "auto" | "background" | "foreground" | "foreground_flash";
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

    // ADR-013 Option E: foreground_flash は keyboard:press の semantics に合わない
    // (= clipboard 経由 paste は単一 key combo に意味なし)。明示拒否。
    if (inputMethod === "foreground_flash") {
      return failWith(
        new Error("ForegroundFlashNotApplicableToKeyPress"),
        "keyboard:press",
        {
          suggest: [
            "method:'foreground_flash' is for keyboard:type / terminal:send only",
            "Use method:'foreground' or method:'background' for keyboard:press",
          ],
          context: { keys },
        }
      );
    }

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
      // Issue #202: same contract as keyboard:type above — typed
      // ForegroundRestricted on dual refusal (mirror window.ts:170-185).
      if (fw.forceRefused) {
        // P2-2 (Opus PR #206 Round 1): inject perception envelope on
        // lensId-tagged calls so run_macro chains can branch on
        // post.perception.status here too — mirrors keyboard:type fix above.
        const earlyEnv = lensId ? buildEnvelopeFor(lensId, { toolName: "keyboard:press" }) : null;
        // P2-1 (Opus PR #206 Round 2): hint / autoEscalated を force 分岐
        // (keyboard:type と同型、focus_window と整合)。
        const hint = force
          ? "Win11 refused the AttachThreadInput escalation"
          : "Win11 refused both default SetForegroundWindow and the AttachThreadInput escalation";
        return failWith(
          new Error("ForegroundRestricted"),
          "keyboard:press",
          {
            windowTitle: effectiveWindowTitle,
            hint,
            attemptedForce: force,
            autoEscalated: !force,
            ...(earlyEnv && { _perceptionForPost: earlyEnv }),
          }
        );
      }
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
// keyboard(action='sequence') — atomic menu-navigation handler (issue #257)
// ─────────────────────────────────────────────────────────────────────────────

export interface KeyboardSequenceStep {
  keys: string;
  holdMs?: number;
  gapMs?: number;
}

export const keyboardSequenceHandler = async ({
  steps,
  method: inputMethod,
  windowTitle,
  hwnd,
  forceFocus: forceFocusArg,
  trackFocus,
  settleMs,
  lensId,
  fixId,
  forceImeOff = false,
}: {
  steps: KeyboardSequenceStep[];
  method?: "foreground";
  windowTitle?: string;
  hwnd?: string;
  forceFocus?: boolean;
  trackFocus: boolean;
  settleMs: number;
  lensId?: string;
  fixId?: string;
  forceImeOff?: boolean;
}): Promise<ToolResult> => {
  const force = forceFocusArg ?? (process.env.DESKTOP_TOUCH_FORCE_FOCUS === "1");

  // Defensive arms: the schema only admits `method:"foreground"|undefined`,
  // so these can only fire when the handler is invoked outside the
  // registered tool path (e.g. direct unit test). Keep them anyway as
  // defense-in-depth — the SUGGESTS entries for these typed codes are
  // the LLM-facing reference for "why your method choice was rejected".
  // (NB: we never receive these values from Zod parse, but the type
  // signature is widened to string at runtime by the dispatcher.)
  const rawMethod = inputMethod as string | undefined;
  if (rawMethod === "background" || rawMethod === "background-auto") {
    return failWith(
      new Error("BackgroundNotApplicableToSequence"),
      "keyboard:sequence",
      { suggest: ["sequence is foreground-only; omit method or pass 'foreground'"] }
    );
  }
  if (rawMethod === "foreground_flash") {
    return failWith(
      new Error("ForegroundFlashNotApplicableToSequence"),
      "keyboard:sequence",
      { suggest: ["sequence is foreground-only; omit method or pass 'foreground'"] }
    );
  }

  try {
    // Phase G: fixId approval prologue. Sequence only uses fixId for
    // GUARD-pre-loop rejection retry (e.g. unsafe.keyboardTarget) — the
    // mid-loop MenuFocusLostMidSequence path returns context.remaining
    // directly (FocusLostDuringType convention).
    let effectiveWindowTitle = windowTitle;
    if (fixId) {
      const vr = validateAndPrepareFix(fixId, "keyboard");
      if (!vr.ok || !vr.fix) return failWith(new Error(vr.errorCode!), "keyboard:sequence");
      if (typeof vr.fix.args.windowTitle === "string") effectiveWindowTitle = vr.fix.args.windowTitle;
      consumeFix(fixId);
    }

    const resolvedWin = !fixId ? await resolveWindowTarget({ hwnd, windowTitle: effectiveWindowTitle }) : null;
    if (resolvedWin) effectiveWindowTitle = resolvedWin.title;

    const warnings: string[] = [...(resolvedWin?.warnings ?? [])];
    const homingNotes: string[] = [];
    let foregroundVerified = false;
    let targetHwnd: bigint | null = null;

    if (effectiveWindowTitle) {
      const fw = await focusWindowForKeyboard(effectiveWindowTitle, force);
      warnings.push(...fw.warnings);
      homingNotes.push(...fw.homingNotes);
      foregroundVerified = fw.foregroundVerified;
      targetHwnd = fw.targetHwnd;
      if (fw.forceRefused) {
        const earlyEnv = lensId ? buildEnvelopeFor(lensId, { toolName: "keyboard:sequence" }) : null;
        const hint = force
          ? "Win11 refused the AttachThreadInput escalation"
          : "Win11 refused both default SetForegroundWindow and the AttachThreadInput escalation";
        return failWith(
          new Error("ForegroundRestricted"),
          "keyboard:sequence",
          {
            windowTitle: effectiveWindowTitle,
            hint,
            attemptedForce: force,
            autoEscalated: !force,
            ...(earlyEnv && { _perceptionForPost: earlyEnv }),
          }
        );
      }
    }

    // IME OFF before the lock; restore in finally. Only meaningful when we
    // have a target HWND — the IMM bridge needs one to query/flip.
    let imeRestoreHwnd: bigint | null = null;
    if (forceImeOff && targetHwnd != null && typeof nativeWin32?.win32GetImeOpenStatus === "function") {
      try {
        const wasOpen = nativeWin32.win32GetImeOpenStatus(targetHwnd) === true;
        if (wasOpen) {
          nativeWin32.win32SetImeOpenStatus?.(targetHwnd, false);
          imeRestoreHwnd = targetHwnd;
        }
      } catch {
        // best-effort
      }
    } else if (forceImeOff && targetHwnd == null) {
      // Opus PR #270 round 1 P3-1: forceImeOff:true with neither windowTitle
      // nor hwnd was a silent no-op — the Alt-mnemonic hijack the option was
      // added to prevent could still fire. Surface a warning so the LLM
      // notices its IME mitigation did nothing.
      warnings.push("ImeOffIgnoredNoTarget");
    }

    try {
      // Guard evaluation (lensId perception OR auto-guard).
      let perceptionEnv: import("../engine/perception/types.js").PostPerception | undefined;
      if (lensId) {
        const guardResult = await evaluatePreToolGuards(lensId, "keyboard:sequence", {});
        if (!guardResult.ok && guardResult.policy === "block") {
          const env = buildEnvelopeFor(lensId, { toolName: "keyboard:sequence" });
          return failWith(
            new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
            "keyboard:sequence",
            {
              lensId,
              guard: guardResult.failedGuard,
              _perceptionForPost: env,
              ...(warnings.length > 0 && { hints: { warnings } }),
            }
          );
        }
        perceptionEnv = buildEnvelopeFor(lensId, { toolName: "keyboard:sequence" }) ?? undefined;
      } else if (isAutoGuardEnabled()) {
        const descriptor = effectiveWindowTitle
          ? { kind: "window" as const, titleIncludes: effectiveWindowTitle }
          : null;
        const ag = await runActionGuard({
          toolName: "keyboard:sequence", actionKind: "keyboard", descriptor,
          ...(foregroundVerified && { foregroundVerified: true }),
        });
        if (ag.block) {
          return failWith(
            new Error(`AutoGuardBlocked: ${ag.summary.next}`),
            "keyboard:sequence",
            {
              _perceptionForPost: ag.summary,
              ...(warnings.length > 0 && { hints: { warnings } }),
            }
          );
        }
        perceptionEnv = ag.summary;
      }

      // Atomic sequence loop — single outer lock so concurrent keyboard
      // callers cannot splice between this sequence's steps. rawKeyboard
      // primitives bypass the wrapped per-call lock (which would deadlock).
      //
      // `failedIndex` carries the index of the step that *was being attempted*
      // when the loop threw. Set at the top of each iteration so any throw
      // below (focus check, assertKeyComboSafe, raw libnut press/release)
      // carries the index for context.completedSteps / context.remaining.
      // (Opus PR #270 round 1 P3-2: previously only MenuFocusLost attached
      // this context — BlockedKeyCombo and libnut throws lost it and the LLM
      // could not tell which steps had already fired.)
      let failedIndex = -1;
      try {
        await withKeyboardLock(async () => {
          for (let i = 0; i < steps.length; i++) {
            failedIndex = i;
            // Mid-sequence hwnd-based focus check (skip step 0 — focus
            // just verified). Issue #257 P2-2: hwnd is title-rename-immune.
            if (i > 0 && targetHwnd !== null) {
              const fl = await checkForegroundOnce({ hwnd: targetHwnd });
              if (fl !== null) {
                const stolen = fl.stolenByProcessName || fl.stolenBy || "unknown";
                throw new Error(
                  `MenuFocusLostMidSequence: focus left target before step ${i} (stolen by ${stolen})`
                );
              }
            }

            const step = steps[i]!;
            // Defense-in-depth: macro.ts pre-validates, but direct keyboard
            // tool path also passes through here.
            assertKeyComboSafe(step.keys);
            const downKeys = parseKeys(step.keys);
            await rawKeyboard.pressKeyDown(...downKeys);
            const hold = step.holdMs ?? 0;
            if (hold > 0) {
              await new Promise<void>((r) => setTimeout(r, hold));
            }
            // Release in reverse order, explicit slice() to avoid mutating
            // parseKeys's return value (would surprise other call sites).
            await rawKeyboard.pressKeyUp(...downKeys.slice().reverse());

            // Inter-step gap (skip after last step).
            if (i < steps.length - 1) {
              const gap = step.gapMs ?? 80;
              if (gap > 0) {
                await new Promise<void>((r) => setTimeout(r, gap));
              }
            }
          }
          // Sentinel: full sequence completed without throwing.
          failedIndex = -1;
        });
      } catch (loopErr) {
        // Outside the lock — releaseDanglingModifiers uses the wrapped
        // variant which would deadlock if called inside withKeyboardLock.
        await releaseDanglingModifiers();

        // Any in-loop throw carries an index ≥ 0 (set at the top of every
        // iteration). Attach completedSteps / remaining so the LLM can
        // recover regardless of the typed code — classify() still derives
        // the code from the message (MenuFocusLostMidSequence, BlockedKeyCombo,
        // or generic ToolError for an unknown libnut throw).
        if (failedIndex >= 0) {
          return failWith(
            loopErr instanceof Error ? loopErr : new Error(String(loopErr)),
            "keyboard:sequence",
            {
              ...(effectiveWindowTitle && { windowTitle: effectiveWindowTitle }),
              completedSteps: steps.slice(0, failedIndex),
              remaining: steps.slice(failedIndex),
              ...(warnings.length > 0 && { hints: { warnings } }),
            }
          );
        }
        // Outside-loop throw (no failedIndex set) — bubble to outer catch.
        throw loopErr;
      }

      // Post-action focus check (matches keyboard:press).
      let focusLost = undefined;
      if (trackFocus) {
        const fl = await detectFocusLoss({
          target: effectiveWindowTitle,
          ...(targetHwnd !== null ? { hwnd: targetHwnd } : {}),
          homingNotes,
          settleMs,
        });
        if (fl) focusLost = fl;
      }

      const verifyDelivery: VerifyDeliveryHint = {
        status: "focus_only",
        reason: "menu_state_not_observable",
        channel: "sendinput",
      };

      return ok({
        ok: true,
        executed: steps.length,
        ...(focusLost && { focusLost }),
        hints: {
          verifyDelivery,
          ...(warnings.length > 0 && { warnings }),
        },
        ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
      });
    } finally {
      if (imeRestoreHwnd !== null) {
        try {
          nativeWin32?.win32SetImeOpenStatus?.(imeRestoreHwnd, true);
        } catch {
          // best-effort
        }
      }
    }
  } catch (err) {
    return failWith(err, "keyboard:sequence");
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
    use_clipboard: coercedBoolean()
      .optional()
      .default(false)
      .describe(
        "If true, copy text to clipboard and paste with Ctrl+V instead of simulating keystrokes. " +
        "Use this when typing URLs, paths, or ASCII text into apps with Japanese IME active — " +
        "prevents IME from converting characters. Default false."
      ),
    replaceAll: coercedBoolean().optional().default(false).describe(
      "When true, send Ctrl+A to select all existing text before typing. " +
      "Equivalent to Ctrl+A → keyboard(action='type') in one call (requires field already focused). Default false."
    ),
    forceKeystrokes: coercedBoolean().optional().default(false).describe(
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
    abortOnFocusLoss: coercedBoolean().optional().describe(
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
    forceImeOff: coercedBoolean().optional().default(false).describe(
      "Issue #245 系統②: when true, query the target window's IME open-status via " +
      "Imm32 before typing; if ON, switch OFF for the duration of this call and " +
      "restore the prior state in `finally`. Prevents silent romaji conversion when " +
      "the user's Japanese IME is active but the LLM is typing ASCII commands. " +
      "Requires `windowTitle` or `hwnd` (otherwise no target to query). Default false " +
      "— existing use_clipboard auto-promotion still handles non-ASCII symbols " +
      "transparently. No-op when the addon predates the IMM bridge (call proceeds " +
      "with whatever IME state is in effect)."
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
  // Issue #257: atomic multi-step key sequence for menu-navigation chords
  // (Alt+<letter>, <letter>) and similar patterns where intermediate
  // observation tool calls would close the menu. Foreground-only by
  // construction (Alt-menu mnemonics require real SendInput). All steps
  // execute inside ONE withKeyboardLock so concurrent keyboard / scroll /
  // terminal callers cannot splice between them.
  //
  // KEEP STEP-ITEM SHAPE INLINE: scripts/generate-stub-tool-catalog.mjs
  // statically parses each variant. The inner `z.object({keys,holdMs,gapMs}).strict()`
  // expression must remain literal here so the regen can emit
  // `items.properties` + `additionalProperties:false` for the Linux stub
  // catalog (v5 P2-1).
  z.object({
    action: z.literal("sequence"),
    steps: z.array(
      z.object({
        keys: z.string().max(100).describe(
          "Key combo for this step (e.g. 'alt+i' then 'm'). Same syntax as keyboard(action='press'). " +
          "Blocked combos (win+r, win+x, win+s, win+l) are rejected per-step."
        ),
        holdMs: z.number().int().min(0).max(500).optional().describe(
          "Hold time within this step (key-down → wait holdMs → key-up). " +
          "Default 0 = tap. Use a positive value when the target requires a long press " +
          "(rare for menu nav; useful for some games / accessibility apps)."
        ),
        gapMs: z.number().int().min(0).max(2000).optional().describe(
          "Wait between this step's release and the next step's press. " +
          "Default 80ms — chosen to give Windows menu pump time to register the " +
          "previous mnemonic before the next letter. The last step's gapMs is ignored."
        ),
      }).strict()
    )
      .min(1)
      .max(16)
      .refine(
        (xs) => xs.slice(0, -1).reduce((s, x) => s + (x.holdMs ?? 0) + (x.gapMs ?? 80), 0)
                + (xs[xs.length - 1]!.holdMs ?? 0) <= 5000,
        { message: "total step duration (sum of holdMs + gapMs, last step's gap ignored) must be ≤ 5000ms" }
      )
      .describe("Ordered list of key-press steps. Min 1, max 16. Total duration must not exceed 5000ms (excludes settleMs and focus acquisition)."),
    method: z.literal("foreground").optional().describe(
      "Sequence is foreground-only by design — Alt-menu mnemonics need real SendInput. " +
      "Omit, or pass 'foreground'. method:'background' / 'foreground_flash' are " +
      "rejected at schema parse time (typed codes BackgroundNotApplicableToSequence / " +
      "ForegroundFlashNotApplicableToSequence document the rationale for LLMs)."
    ),
    narrate: narrateParam,
    windowTitle: windowTitleFocusParam,
    hwnd: hwndFocusParam,
    forceFocus: forceFocusParam,
    trackFocus: trackFocusParam,
    settleMs: settleMsParam,
    lensId: z.string().optional().describe(
      "Optional perception lens ID. Guards (safe.keyboardTarget) are evaluated once before the first step."
    ),
    fixId: z.string().optional().describe(
      "Approve a pending suggestedFix (one-shot, 15s TTL). Only meaningful for GUARD-pre-loop " +
      "rejections (e.g. unsafe.keyboardTarget). Mid-loop MenuFocusLostMidSequence does NOT " +
      "issue fixIds — recover by re-calling with context.remaining."
    ),
    forceImeOff: coercedBoolean().optional().default(false).describe(
      "Issue #245 系統②: query the target's IME open-status before the first step; " +
      "if ON, switch OFF for the whole sequence and restore in finally. Prevents Alt-mnemonic " +
      "hijack when 日本語 IME is active (the OS routes Alt+letter to IME composition instead " +
      "of the menu). Requires windowTitle or hwnd. Default false."
    ),
  }),
]);

export type KeyboardArgs = z.infer<typeof keyboardSchema>;

export const keyboardHandler = async (args: KeyboardArgs): Promise<import("./_types.js").ToolResult> => {
  if (args.action === "type") {
    return keyboardTypeHandler(args);
  }
  if (args.action === "sequence") {
    return keyboardSequenceHandler(args);
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
        purpose: "Send keyboard input to a window: 'type' for text, 'press' for key combos, 'sequence' for atomic multi-step chords.",
        details: "action='type' inserts text (auto-clipboard for non-ASCII / IME-safe). action='press' sends key combos like 'ctrl+c'/'alt+tab'. action='sequence' runs ordered steps in one keyboard lock — use for Alt+letter, letter mnemonic chains where intermediate tool calls would close the menu. Pass windowTitle to auto-focus and auto-guard (identity, foreground, modal) before input. Omitting windowTitle acts on the active window (unguarded).",
        prefer: "Use windowTitle to auto-focus before injection. Set lensId for perception guards. Use desktop_act({action:'setValue'}) for UIA ValuePattern text fields.",
        caveats: "win+r/win+x/win+s/win+l blocked. action='type' does not handle CJK IME composition — use use_clipboard=true or desktop_act({action:'setValue'}). Non-ASCII punctuation auto-clipboards to prevent Chrome accelerator hijack; pass forceKeystrokes:true to disable. Background (PostMessage/WM_CHAR) auto-engages for terminal-class windows (Windows Terminal / cmd / PowerShell); DTM_BG_AUTO=1 enables globally. Foreground non-terminal type runs a per-chunk leash; user focus-steal mid-stream aborts with FocusLostDuringType + context.typed/remaining; pass abortOnFocusLoss:false to disable. BG type verifies WM_CHAR via UIA TextPattern read-back; mismatch returns BackgroundInputNotDelivered (see SUGGESTS for false-positive notes). BG press read-back is scoped to terminal-class + enter/tab/arrow; other combos return verifyDelivery:'unverifiable', failure returns BackgroundKeyNotDelivered. action='sequence' is FG-only (BG/foreground_flash schema-rejected); emits verifyDelivery:'focus_only'; mid-loop focus theft returns MenuFocusLostMidSequence + context.remaining: Step[]. Win11 FG refusal returns ForegroundRestricted — terminal-class targets auto-engage BG; non-terminal switch to desktop_act / click_element.",
        examples: [
          "keyboard({action:'type', text:'hello', windowTitle:'Notepad'}) → text injected (guarded)",
          "keyboard({action:'type', text:'hello'}) → text injected (unguarded)",
          "keyboard({action:'press', keys:'ctrl+c'}) → copy",
          "keyboard({action:'press', keys:'escape', windowTitle:'Dialog'}) → dismiss dialog",
          "keyboard({action:'sequence', steps:[{keys:'alt+i', gapMs:100},{keys:'m'}], windowTitle:'Microsoft Visual Basic'}) → Insert > Module (atomic)",
        ],
      }),
      inputSchema: keyboardRegistrationSchema,
    },
    keyboardRegistrationHandler as typeof keyboardHandler,
  );
}
