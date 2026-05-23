/**
 * Background input engine — WM_CHAR/WM_KEYDOWN injection via PostMessageW.
 *
 * Delivers text and key presses to a target HWND without changing the foreground
 * window. Works for standard Win32 controls, Windows Terminal, and conhost.
 * Does NOT work for Chromium-based apps (Chrome, Edge, Electron) or UWP sandboxed
 * apps — use `canInjectViaPostMessage` to check before calling.
 *
 * All functions are synchronous (PostMessageW is non-blocking by design).
 *
 * **ADR-013 Option E (`foreground_flash` channel)**: WT を含む WM_CHAR 不対応
 * window に対する妥協 BG path として `injectViaForegroundFlash` を提供。
 * `method: 'foreground_flash'` 明示 opt-in でのみ使用、`background` 契約とは
 * 分離。Channel 判定は `background-channel-resolver.ts::resolveBackgroundInputChannel`
 * 経由。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  getWindowClassName,
  getWindowProcessId,
  getProcessIdentityByPid,
  getFocusedChildHwnd,
  postMessageToHwnd,
  vkToScanCode,
  WM_CHAR, WM_KEYDOWN, WM_KEYUP, VK_RETURN, VK_CONTROL, VK_SHIFT, VK_MENU,
} from "./win32.js";
import { nativeWin32 } from "./native-engine.js";
import type {
  NativeForegroundFlashOptions,
  NativeForegroundFlashResult,
} from "./native-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Known-compatible terminal window classes (fast-path supported:true)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Terminal window classes that reliably accept WM_CHAR injection.
 *
 * NOTE: `CASCADIA_HOSTING_WINDOW_CLASS` (Windows Terminal, wt.exe) is **NOT**
 * in this set. WT is built on WinUI/XAML/TerminalControl; input is consumed
 * via XAML `KeyEventArgs`, not the legacy WM_CHAR pipeline. PostMessage to a
 * WT HWND succeeds at the OS message-queue layer but TerminalControl never
 * reads the message, so the keystroke is silently dropped. See issue #173.
 */
export const TERMINAL_WINDOW_CLASSES = new Set([
  "ConsoleWindowClass",             // conhost.exe (cmd, PowerShell, pwsh)
]);

// ─────────────────────────────────────────────────────────────────────────────
// Known-incompatible window class prefixes
// ─────────────────────────────────────────────────────────────────────────────

const CHROMIUM_CLASSES = new Set([
  "Chrome_WidgetWin_0",
  "Chrome_WidgetWin_1",
  "Chrome_RenderWidgetHostHWND",
  "CefBrowserWindow",
  "MozillaWindowClass",
]);

const UWP_CLASSES = new Set([
  "ApplicationFrameWindow",
  "Windows.UI.Core.CoreWindow",
  "Windows.UI.Input.InputSite.WindowClass",
]);

/**
 * Windows Terminal classes / processes — WinUI/XAML pipeline silently swallows
 * WM_CHAR. Marked non-supported so the BG path falls through to foreground
 * instead of returning a false ok:true. See issue #173.
 */
const WT_CLASSES = new Set([
  "CASCADIA_HOSTING_WINDOW_CLASS",
]);
const WT_PROCESS_RE = /^WindowsTerminal(\.exe)?$/i;

const CHROMIUM_PROCESS_RE = /^(chrome|msedge|brave|opera|firefox|vivaldi|electron)$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Injection support check — cached per HWND for 3 seconds
// ─────────────────────────────────────────────────────────────────────────────

export interface InjectCheckResult {
  supported: boolean;
  reason?: "chromium" | "uwp_sandboxed" | "wt_xaml_pipeline" | "class_unknown";
  className?: string;
  processName?: string;
}

const _injectCache = new Map<string, { result: InjectCheckResult; expiresMs: number }>();

/**
 * Check whether PostMessage-based input injection is supported for this HWND.
 * Result is cached for 3 seconds.
 */
export function canInjectViaPostMessage(hwnd: unknown): InjectCheckResult {
  const key = String(hwnd);
  const cached = _injectCache.get(key);
  if (cached && Date.now() < cached.expiresMs) return cached.result;

  const result = _check(hwnd);
  _injectCache.set(key, { result, expiresMs: Date.now() + 3000 });
  return result;
}

function _check(hwnd: unknown): InjectCheckResult {
  try {
    const cls = getWindowClassName(hwnd);

    // Fast-path: known terminal classes are always supported
    if (TERMINAL_WINDOW_CLASSES.has(cls)) {
      return { supported: true, className: cls };
    }

    if (CHROMIUM_CLASSES.has(cls) || cls.startsWith("Chrome_")) {
      return { supported: false, reason: "chromium", className: cls };
    }
    if (UWP_CLASSES.has(cls)) {
      return { supported: false, reason: "uwp_sandboxed", className: cls };
    }
    if (WT_CLASSES.has(cls)) {
      return { supported: false, reason: "wt_xaml_pipeline", className: cls };
    }

    const pid = getWindowProcessId(hwnd);
    const identity = getProcessIdentityByPid(pid);
    const procName = identity.processName;

    if (CHROMIUM_PROCESS_RE.test(procName)) {
      return { supported: false, reason: "chromium", className: cls, processName: procName };
    }
    if (WT_PROCESS_RE.test(procName)) {
      return { supported: false, reason: "wt_xaml_pipeline", className: cls, processName: procName };
    }

    return { supported: true, className: cls, processName: procName };
  } catch {
    return { supported: false, reason: "class_unknown" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve the actual input-receiving child HWND
// ─────────────────────────────────────────────────────────────────────────────

function resolveTarget(hwnd: unknown): unknown {
  try {
    const child = getFocusedChildHwnd(hwnd);
    return child !== null ? child : hwnd;
  } catch {
    return hwnd;
  }
}

/**
 * Resolve the actual key-receiving HWND (focused child if any) and check
 * BG-injection support against that handle. Use this in callers that gate
 * the BG path — checking the parent alone can mis-classify a supported
 * parent that hosts a Chromium / WebView2 child, where PostMessage to the
 * resolved target would silently no-op even though the parent class is OK.
 */
export function canInjectAtTarget(hwnd: unknown): InjectCheckResult {
  return canInjectViaPostMessage(resolveTarget(hwnd));
}

// ─────────────────────────────────────────────────────────────────────────────
// Character injection
// ─────────────────────────────────────────────────────────────────────────────

/** Result of postCharsToHwnd. */
export interface PostCharsResult {
  /** Number of code units (UTF-16) successfully sent. */
  sent: number;
  /** true when all code units were sent. */
  full: boolean;
}

/**
 * Send `text` to `hwnd` via WM_CHAR messages, one UTF-16 code unit at a time.
 * Surrogate pairs are sent as two consecutive WM_CHAR messages (standard Win32).
 * '\n' is normalised to '\r' (0x0D) for terminal compatibility.
 *
 * Does NOT change the foreground window.
 */
export function postCharsToHwnd(hwnd: unknown, text: string): PostCharsResult {
  const target = resolveTarget(hwnd);
  let sent = 0;
  const total = text.length; // UTF-16 code unit count

  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);

    // Normalise LF → CR for terminals
    const wParam = ch === 0x0A ? 0x0D : ch;

    if (!postMessageToHwnd(target, WM_CHAR, wParam, 0)) {
      return { sent, full: false };
    }
    sent++;
  }

  return { sent, full: sent === total };
}

// ─────────────────────────────────────────────────────────────────────────────
// Key injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a single virtual key press (KEYDOWN + KEYUP) to `hwnd`.
 * Uses WM_KEYDOWN/WM_KEYUP — no foreground required.
 */
export function postKeyToHwnd(hwnd: unknown, vk: number): boolean {
  const target = resolveTarget(hwnd);
  const scan = vkToScanCode(vk);
  const lParamDown = (scan & 0xFF) << 16;
  const lParamUp   = lParamDown | (1 << 30) | (1 << 31); // prev-down + transition bits
  return (
    postMessageToHwnd(target, WM_KEYDOWN, vk, lParamDown) &&
    postMessageToHwnd(target, WM_KEYUP,   vk, lParamUp)
  );
}

/**
 * Send Enter to `hwnd` via WM_CHAR '\r'.
 * Preferred over postKeyToHwnd(VK_RETURN) for terminals (WT/conhost normalise '\r').
 */
export function postEnterToHwnd(hwnd: unknown): boolean {
  const target = resolveTarget(hwnd);
  return postMessageToHwnd(target, WM_CHAR, VK_RETURN, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic no-focus-steal console paste (issue #386 Q3)
// ─────────────────────────────────────────────────────────────────────────────
//
// The per-char WM_CHAR path (postCharsToHwnd) is unreliable for MULTILINE input
// on conhost: an embedded newline makes conhost execute that line immediately,
// and the chars posted while conhost is busy executing saturate its input queue
// and DROP (observed: a `__DTMCP` token came back as `_DTMCP`). until:{mode:'exit'}
// needs the completion sentinel to render byte-exact, so a dropped char breaks
// completion detection entirely.
//
// conhost (ConsoleWindowClass) exposes the legacy console "Paste" command
// (WM_COMMAND wParam=0xFFF1), which injects the ENTIRE clipboard into the input
// buffer atomically — all chars land before any line executes, so nothing drops,
// and it needs NO foreground change (PostMessage to the specific HWND).
//
// Spike finding (2026-05-23): conhost paste STRIPS lone LF (0x0A) and treats CR
// (0x0D) as a line break, so the command must use CRLF separators; with `\n`
// alone the lines concatenate and the shell sees one mangled line.

const WM_COMMAND = 0x0111;
/** Legacy console context-menu "Paste" command id (conhost). */
const ID_CONSOLE_PASTE = 0xfff1;

const execFileAsync = promisify(execFile);

/** Read the current clipboard as a UTF-16LE base64 blob (empty string if none). */
async function getClipboardB64(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        "$t=Get-Clipboard -Raw;if($t -eq $null){''}else{" +
          "[Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($t))}",
      ],
      { timeout: 4000 },
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Set the clipboard to `text` (UTF-16LE) and verify the read-back byte-equals. */
async function setClipboardVerified(text: string): Promise<boolean> {
  const b64 = Buffer.from(text, "utf16le").toString("base64");
  const script =
    `$b=[System.Convert]::FromBase64String('${b64}');` +
    `$t=[System.Text.Encoding]::Unicode.GetString($b);` +
    `Set-Clipboard -Value $t;` +
    `$r=Get-Clipboard -Raw;` +
    `if($r -eq $null){''}else{[Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($r))}`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 5000 },
    );
    const readBack = stdout.trim();
    const actual = readBack ? Buffer.from(readBack, "base64") : Buffer.alloc(0);
    // Get-Clipboard -Raw can append a trailing newline; accept an exact match OR
    // the text followed by a single CRLF/CR/LF so multiline payloads still pass.
    const want = Buffer.from(text, "utf16le");
    if (want.equals(actual)) return true;
    for (const suffix of ["\r\n", "\r", "\n"]) {
      if (Buffer.from(text + suffix, "utf16le").equals(actual)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface ConsolePasteOutcome {
  ok: boolean;
  reason?: "clipboard_set_failed" | "console_paste_post_failed";
}

/**
 * Paste `text` into a conhost (ConsoleWindowClass) window atomically WITHOUT
 * stealing foreground, via clipboard + the console Paste command. Multiline-safe.
 *
 * Caller MUST have verified the target is conhost (ConsoleWindowClass) — the
 * 0xFFF1 command is a no-op on Windows Terminal (XAML) and non-console windows.
 *
 * Flow: save clipboard → set clipboard to the CRLF-normalised text (verified) →
 * post the console Paste command → settle so conhost drains the clipboard into
 * its input buffer → send a trailing Enter to run the final line → restore the
 * previous clipboard (best-effort).
 *
 * The trailing Enter is posted AFTER a settle delay (not appended to the
 * clipboard) so it cannot race ahead of the still-draining paste.
 */
export async function pasteIntoConsoleNoFocus(
  hwnd: unknown,
  text: string,
): Promise<ConsolePasteOutcome> {
  const target = resolveTarget(hwnd);
  // conhost strips lone LF and treats CR as a line break — use CRLF so each
  // statement runs after the atomic paste.
  const crlf = text.replace(/\r?\n/g, "\r\n");

  const saved = await getClipboardB64(); // null = read failed; "" = empty clipboard
  if (!(await setClipboardVerified(crlf))) {
    // Set-Clipboard may have landed before the read-back mismatch (another app
    // raced, or newline tolerance missed) — restore so we never leave the user's
    // clipboard clobbered on a failed paste (Opus #389 round 1 P2-1).
    await restoreClipboard(saved);
    return { ok: false, reason: "clipboard_set_failed" };
  }

  const posted = postMessageToHwnd(target, WM_COMMAND, ID_CONSOLE_PASTE, 0);
  if (!posted) {
    await restoreClipboard(saved);
    return { ok: false, reason: "console_paste_post_failed" };
  }

  // Let conhost drain the clipboard into its input buffer before the Enter and
  // before we overwrite the clipboard on restore.
  await new Promise<void>((r) => setTimeout(r, 200));
  postEnterToHwnd(target);
  await new Promise<void>((r) => setTimeout(r, 60));
  await restoreClipboard(saved);
  return { ok: true };
}

/**
 * Best-effort restore of a clipboard snapshot captured by getClipboardB64().
 *
 * Codex #389 P2: when the original clipboard was EMPTY (`""`) or could not be
 * read (`null`), we must still CLEAR it rather than skip — otherwise the command
 * we just pasted (possibly sensitive input) lingers in the user's clipboard
 * after the run. Set-Clipboard rejects an empty value, so clearing uses the
 * Forms clipboard API.
 */
async function restoreClipboard(savedB64: string | null): Promise<void> {
  try {
    if (savedB64 && savedB64.length > 0) {
      const script =
        `$b=[System.Convert]::FromBase64String('${savedB64}');` +
        `$t=[System.Text.Encoding]::Unicode.GetString($b);` +
        `Set-Clipboard -Value $t`;
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        timeout: 3000,
      });
    } else {
      // Originally empty / unreadable — clear so the injected command does not
      // linger. Clearing an unreadable clipboard is harmless (best-effort).
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile", "-NonInteractive", "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()",
        ],
        { timeout: 3000 },
      );
    }
  } catch {
    /* best-effort */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Key combo injection (ctrl+a, ctrl+s, escape, etc.)
// ─────────────────────────────────────────────────────────────────────────────

const COMBO_VK: Record<string, number> = {
  ctrl: VK_CONTROL, shift: VK_SHIFT, alt: VK_MENU,
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48,
  i: 0x49, j: 0x4A, k: 0x4B, l: 0x4C, m: 0x4D, n: 0x4E, o: 0x4F, p: 0x50,
  q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58,
  y: 0x59, z: 0x5A,
  "0": 0x30, "1": 0x31, "2": 0x32, "3": 0x33, "4": 0x34,
  "5": 0x35, "6": 0x36, "7": 0x37, "8": 0x38, "9": 0x39,
  enter: 0x0D, escape: 0x1B, tab: 0x09, space: 0x20,
  backspace: 0x08, delete: 0x2E, insert: 0x2D, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B,
};

const MODIFIER_VKS = new Set([VK_CONTROL, VK_SHIFT, VK_MENU]);

/**
 * Send a key combination such as 'ctrl+a', 'escape', 'ctrl+shift+s' to `hwnd`.
 * Returns false if any key in the combo fails or the combo is unknown.
 *
 * Note: ctrl+v paste does NOT work in background mode (clipboard paste requires
 * the window to be foreground). This function is for structural key combos only.
 */
export function postKeyComboToHwnd(hwnd: unknown, combo: string): boolean {
  const target = resolveTarget(hwnd);
  const parts = combo.toLowerCase().split("+").map(p => p.trim());
  const vks = parts.map(p => COMBO_VK[p]).filter((v): v is number => v !== undefined);
  if (vks.length !== parts.length) return false; // unknown key

  const modifiers = vks.filter(v => MODIFIER_VKS.has(v));
  const mainKeys  = vks.filter(v => !MODIFIER_VKS.has(v));

  // Press modifiers
  for (const m of modifiers) {
    const scan = vkToScanCode(m);
    if (!postMessageToHwnd(target, WM_KEYDOWN, m, (scan & 0xFF) << 16)) return false;
  }
  // Press + release main keys
  for (const k of mainKeys) {
    if (!postKeyToHwnd(target, k)) return false;
  }
  // Release modifiers (reverse order)
  for (const m of [...modifiers].reverse()) {
    const scan = vkToScanCode(m);
    const lParam = ((scan & 0xFF) << 16) | (1 << 30) | (1 << 31);
    if (!postMessageToHwnd(target, WM_KEYUP, m, lParam)) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When DTM_BG_AUTO=1, method:"auto" selects the BG channel automatically.
 * Default (DTM_BG_AUTO=0) keeps "auto" equivalent to "foreground" for safety.
 */
export function isBgAutoEnabled(): boolean {
  return process.env["DTM_BG_AUTO"] === "1";
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-013 Option E — `foreground_flash` channel
// ─────────────────────────────────────────────────────────────────────────────

/** Typed reason returned by native `win32_foreground_flash_inject` failure. */
export type ForegroundFlashFailureReason =
  /** Input が改行 (LF / CR) を含む (Opus Round 1 P1-3 で size と分離)。 */
  | "input_contains_newline"
  /** Input が UTF-16 で 5KiB 超 (size threshold)。 */
  | "input_exceeds_paste_warning_threshold"
  | "foreground_steal_denied"
  | "focus_wait_timeout"
  | "clipboard_lock_contention"
  | "foreground_restore_failed"
  | "wt_paste_warning_intercepted"
  | "send_input_failed";

const KNOWN_FLASH_REASONS: ReadonlySet<string> = new Set<ForegroundFlashFailureReason>([
  "input_contains_newline",
  "input_exceeds_paste_warning_threshold",
  "foreground_steal_denied",
  "focus_wait_timeout",
  "clipboard_lock_contention",
  "foreground_restore_failed",
  "wt_paste_warning_intercepted",
  "send_input_failed",
]);

/** Result envelope for `injectViaForegroundFlash`. ok=false 時は reason 必須。 */
export interface ForegroundFlashOutcome {
  ok: boolean;
  /** snake_case typed reason、ok=false 時のみ存在。
   *  unknown reason は undefined にせず raw string でそのまま透過 (caller 側で
   *  `error.message` 確認可能、observability)。 */
  reason?: ForegroundFlashFailureReason | string;
  /** 成功時のみ存在。flash duration / steal method / clipboard 状態 hints。 */
  result?: NativeForegroundFlashResult;
  /** unknown 型 native error の raw `error.message` (observability)。 */
  rawError?: string;
}

/**
 * `foreground_flash` channel 経由で text を inject。
 *
 * Native `win32_foreground_flash_inject` を呼び出す薄い wrapper:
 * - 成功時は `{ ok: true, result }` を返す (typed reason / hints は result 内)
 * - 失敗時は `Error` を try/catch して `{ ok: false, reason }` に variant 化
 *
 * **本 fn は `method: 'foreground_flash'` 明示 opt-in path 専用** — `background`
 * 契約 caller (`canInjectViaPostMessage` 経由) からは到達しない (silent contract
 * violation 防止)。
 *
 * @param hwnd target HWND (`bigint`)
 * @param pid target process ID
 * @param text inject 対象 text (single-line + UTF-16 < 5KiB、native 側 validate)
 * @param options native options (default で `scan_paste_warning_dialog: true`、
 *                `block_keyboard_during_flash: false` 等)
 */
export function injectViaForegroundFlash(
  hwnd: bigint,
  pid: number,
  text: string,
  options: NativeForegroundFlashOptions = {},
): ForegroundFlashOutcome {
  if (!nativeWin32 || typeof nativeWin32.win32ForegroundFlashInject !== "function") {
    return {
      ok: false,
      reason: "send_input_failed",
      rawError:
        "[bg-input] desktop-touch-engine native addon missing win32_foreground_flash_inject (rebuild with `npm run build:rs`)",
    };
  }
  try {
    const result = nativeWin32.win32ForegroundFlashInject(hwnd, pid, text, options);
    return { ok: true, result };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // napi::Error::from_reason は message にそのまま typed reason (snake_case) を入れる。
    // 現在の panic guard (`src/win32/safety.rs::napi_safe_call`) は失敗時に
    // `panic in <fn>: <detail>` 形式で wrap (= line 53 の format!)。本 regex は
    // **その固定 format に依存**、将来 `napi_safe_call` の prefix 名が変わったら
    // 同期して update が必要 (Round 2 P2-2 narrative integrity 反映)。`[^:]+` で
    // fn 名 segment のみを greedy 一致、最初の `:` 以前を削除する shape。
    const cleaned = msg
      .replace(/^panic in [^:]+:\s*/, "")
      .trim();
    if (KNOWN_FLASH_REASONS.has(cleaned)) {
      return { ok: false, reason: cleaned as ForegroundFlashFailureReason, rawError: msg };
    }
    return { ok: false, reason: cleaned, rawError: msg };
  }
}
