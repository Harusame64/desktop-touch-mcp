import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
import { ok } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { coercedBoolean } from "./_coerce.js";
import { withRichNarration, narrateParam } from "./_narration.js";
import { detectFocusLoss, checkForegroundOnce } from "./_focus.js";
import { evaluatePreToolGuards, buildEnvelopeFor } from "../engine/perception/registry.js";
import { runActionGuard, isAutoGuardEnabled, validateAndPrepareFix, consumeFix } from "./_action-guard.js";
import { resolveWindowTarget } from "./_resolve-window.js";

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
          } else {
            return ok({
              ok: true,
              typed: result.sent,
              method: "background",
              channel: "wm_char",
              foregroundChanged: false,
              ...(bgWarnings.length > 0 && { hints: { warnings: bgWarnings } }),
              ...(bgPerception && { _perceptionForPost: bgPerception }),
            });
          }
        } else if (effectiveMethod === "background") {
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
        let typed = 0;
        for (let i = 0; i < effectiveText.length; i += chunkSize) {
          const fl = await checkForegroundOnce({
            target: effectiveWindowTitle,
            homingNotes,
          });
          if (fl) {
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
          const chunk = effectiveText.slice(i, i + chunkSize);
          await keyboard.type(chunk);
          typed += chunk.length;
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

        const isEnter = keys.toLowerCase() === "enter";
        const ok2 = isEnter
          ? postEnterToHwnd(target.hwnd)
          : postKeyComboToHwnd(target.hwnd, keys);
        if (ok2) {
          return ok({
            ok: true,
            pressed: keys,
            method: "background",
            channel: "wm_char",
            foregroundChanged: false,
            ...(bgPerception && { _perceptionForPost: bgPerception }),
          });
        }
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
      inputSchema: keyboardSchema,
    },
    withRichNarration("keyboard", keyboardHandler as (args: Record<string, unknown>) => Promise<import("./_types.js").ToolResult>, { windowTitleKey: "windowTitle" })
  );
}
