import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { ok, fail, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import {
  enumWindowsInZOrder,
  restoreAndFocusWindow,
  getProcessIdentityByPid,
  getWindowProcessId,
  type WindowZInfo,
} from "../engine/win32.js";
import {
  canInjectViaPostMessage,
  postCharsToHwnd,
  postEnterToHwnd,
  isBgAutoEnabled,
} from "../engine/bg-input.js";
import { detectFocusLoss } from "./_focus.js";
import { getTextViaTextPattern } from "../engine/uia-bridge.js";
import { recognizeWindow, ocrWordsToLines } from "../engine/ocr-bridge.js";
import { stripAnsi, tailLines } from "../engine/ansi.js";
import {
  observeTarget,
  buildCacheStateHints,
  toTargetHints,
  type InvalidationReason,
} from "../engine/identity-tracker.js";
import { keyboard } from "../engine/nutjs.js";
import { parseKeys } from "../utils/key-map.js";
import { typeViaClipboard } from "./keyboard.js";
import { setTerminalReadHook } from "./wait-until.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const terminalReadSchema = {
  windowTitle: z.string().max(200).describe("Partial title of the terminal window (e.g. 'PowerShell', 'pwsh', 'WindowsTerminal')."),
  lines: z.coerce.number().int().min(1).max(2000).default(50).describe("Tail N lines (default 50)."),
  sinceMarker: z.string().max(64).optional().describe("Marker returned from a previous call. If found in current text, only the diff is returned."),
  stripAnsi: z.boolean().default(true).describe("Strip ANSI escape sequences (default true)."),
  source: z.enum(["auto", "uia", "ocr"]).default("auto").describe("'auto' = UIA TextPattern then OCR fallback; 'uia' = TextPattern only (fail on miss); 'ocr' = OCR only."),
  ocrLanguage: z.string().max(20).default("ja").describe("BCP-47 language tag for OCR fallback (default 'ja')."),
};

export const terminalSendSchema = {
  windowTitle: z.string().max(200).describe("Partial title of the terminal window."),
  input: z.string().max(10000).describe("Text to send (max 10,000 chars)."),
  method: z.enum(["auto", "background", "foreground"]).default("auto").describe(
    "Input routing channel. " +
    "'auto' uses background (WM_CHAR) for known terminal processes when DTM_BG_AUTO=1, else foreground. " +
    "'background' forces WM_CHAR injection (no focus change, works for WT/conhost/cmd/PowerShell). " +
    "'foreground' forces the current behavior (SetForegroundWindow + clipboard paste). " +
    "Default 'auto' (equivalent to 'foreground' unless DTM_BG_AUTO=1 is set)."
  ),
  chunkSize: z.number().int().min(1).max(10000).default(100).describe(
    "Split long input into chunks of this many characters in background mode to prevent " +
    "terminal input queue saturation. Default 100. Only applies when method results in background."
  ),
  pressEnter: z.boolean().default(true).describe("Press Enter after typing (default true)."),
  focusFirst: z.boolean().default(true).describe("Focus the terminal before sending (default true)."),
  restoreFocus: z.boolean().default(true).describe("Restore the previously-focused window after sending (default true)."),
  preferClipboard: z.boolean().default(true).describe("Use clipboard paste (typeViaClipboard) — IME/long-text safe (default true)."),
  pasteKey: z.enum(["auto", "ctrl+v", "ctrl+shift+v"]).default("auto").describe("Paste key combo. 'auto' picks ctrl+shift+v for WSL/bash/mintty/wezterm/alacritty, ctrl+v elsewhere. Only used when preferClipboard=true."),
  forceFocus: z.boolean().optional().describe(
    "When true, bypass Windows foreground-stealing protection via AttachThreadInput " +
    "before focusing the terminal window. Default: follows env DESKTOP_TOUCH_FORCE_FOCUS (default false)."
  ),
  trackFocus: z.boolean().default(true).describe(
    "When true (default), detect if focus was stolen after sending. Reports focusLost in the response."
  ),
  settleMs: z.coerce.number().int().min(0).max(2000).default(300).describe(
    "Milliseconds to wait after sending before checking foreground window (default 300)."
  ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TERMINAL_PROCESS_RE = /^(WindowsTerminal|conhost|pwsh|powershell|cmd|bash|wsl|alacritty|wezterm|mintty)(\.exe)?$/i;

function findTerminalWindow(partialTitle: string): WindowZInfo | null {
  const wins = enumWindowsInZOrder();
  const q = partialTitle.toLowerCase();
  // First try exact partial match on title.
  let candidate = wins.find((w) => w.title.toLowerCase().includes(q));
  if (candidate) return candidate;
  // Fallback: process-name match (LLM might pass 'pwsh' even if title is "Windows PowerShell - …")
  for (const w of wins) {
    const pid = getWindowProcessId(w.hwnd);
    const ident = getProcessIdentityByPid(pid);
    if (ident.processName.toLowerCase().includes(q.replace(/\.exe$/i, ""))) {
      return w;
    }
  }
  return null;
}

/**
 * Normalise terminal text before hashing for marker computation.
 *
 * Windows Terminal's UIA TextPattern introduces three sources of churn that
 * would otherwise cause sinceMarker to miss on every new line:
 *   1. CRLF vs LF — TextPattern can return either depending on terminal state.
 *   2. Trailing-space padding — each row is padded to terminal column width;
 *      the current cursor row may gain or lose that padding between reads.
 *   3. Trailing blank lines — the last row(s) after the prompt may or may not
 *      carry a trailing newline depending on whether output followed.
 *
 * Normalising these away before hashing makes the marker stable across reads
 * that differ only in rendering artefacts.
 */
function normalizeForMarker(text: string): string {
  return text
    .replace(/\r\n/g, "\n")     // CRLF → LF
    .replace(/[ \t]+$/gm, "")   // strip trailing whitespace from every line
    .replace(/\n+$/, "");       // strip trailing blank lines
}

function makeMarker(text: string): string {
  // Take the last 256 chars (or full text if shorter) and hash.
  const norm = normalizeForMarker(text);
  const slice = norm.slice(-256);
  return createHash("sha256").update(slice).digest("hex").slice(0, 16);
}

function applySinceMarker(text: string, marker: string): { text: string; matched: boolean } {
  // Search for any tail window whose hash matches `marker`. Walk from the tail
  // backward — a recent terminal will hit within a few chars. Capped at 32k
  // candidate window endings to bound cost.
  // NOTE: both makeMarker and this function normalise text before hashing so
  // that Windows Terminal padding/CRLF churn does not cause spurious misses.
  const norm = normalizeForMarker(text);
  const WINDOW = 256;

  /** Return the normalised tail starting just after normEnd.
   *  Stripping a leading newline avoids returning a blank first line when
   *  the match ends exactly at a line boundary. */
  function tailFromNormEnd(normEnd: number): string {
    return norm.slice(normEnd).replace(/^\n/, "");
  }

  // ── Sliding-window path (norm ≥ 256 chars) ────────────────────────────────
  // makeMarker hashed norm.slice(-256), so look for any 256-char window match.
  // Note: maxScan caps the lookback at 32k bytes. If the terminal has scrolled
  // more than ~32k chars since the marker was taken, this will miss silently
  // (returning matched:false and falling through to full-text return).
  if (norm.length >= WINDOW) {
    const maxScan = Math.min(norm.length, WINDOW + 32_000);
    for (let end = norm.length; end >= norm.length - maxScan && end >= WINDOW; end--) {
      const slice = norm.slice(end - WINDOW, end);
      if (createHash("sha256").update(slice).digest("hex").slice(0, 16) === marker) {
        return { text: tailFromNormEnd(end), matched: true };
      }
    }
    // Marker not found within the 32k scan range — fall through to return full text.
    return { text, matched: false };
  }

  // ── Prefix-scan path (norm < 256 chars, so previous norm was also < 256) ──
  // makeMarker hashed the entire previous normalised text. Find the prefix
  // of the current norm whose hash matches, i.e. where the old snapshot ends.
  // Scan from longest (current full text = unchanged) down to empty string.
  // At most WINDOW=256 iterations, so O(N) total hashing work.
  for (let end = norm.length; end >= 0; end--) {
    if (createHash("sha256").update(norm.slice(0, end)).digest("hex").slice(0, 16) === marker) {
      return { text: tailFromNormEnd(end), matched: true };
    }
  }

  return { text, matched: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// terminal_read
// ─────────────────────────────────────────────────────────────────────────────

export const terminalReadHandler = async ({
  windowTitle, lines, sinceMarker, stripAnsi: doStripAnsi, source, ocrLanguage,
}: {
  windowTitle: string;
  lines: number;
  sinceMarker?: string;
  stripAnsi: boolean;
  source: "auto" | "uia" | "ocr";
  ocrLanguage: string;
}): Promise<ToolResult> => {
  try {
    const win = findTerminalWindow(windowTitle);
    if (!win) {
      return failWith("Terminal window not found: " + windowTitle, "terminal:read", { windowTitle });
    }

    const obs = observeTarget(windowTitle, win.hwnd, win.title);
    const identityHints = toTargetHints(obs.identity);

    let raw: string | null = null;
    let usedSource: "uia" | "ocr" = "uia";

    if (source === "uia" || source === "auto") {
      raw = await getTextViaTextPattern(win.title);
    }
    if ((raw === null || raw === "") && source !== "uia") {
      try {
        const { words } = await recognizeWindow(win.title, ocrLanguage);
        // Preserve 2D layout: cluster by y, sort by x, join with \n.
        // Critical for sinceMarker compatibility with the UIA path.
        raw = ocrWordsToLines(words);
        usedSource = "ocr";
      } catch (err) {
        if (source === "ocr") {
          return failWith(err, "terminal:read", { windowTitle });
        }
        // auto: both failed
      }
    }
    if (raw === null) {
      return fail({
        ok: false,
        code: "TerminalTextPatternUnavailable",
        error: "TextPattern not available and no OCR fallback usable",
        suggest: [
          "Retry with source:'ocr' to force OCR",
          "Verify the window is actually a terminal (Windows Terminal, conhost, PowerShell)",
        ],
        context: { windowTitle: win.title },
      });
    }

    const cleaned = doStripAnsi ? stripAnsi(raw) : raw;
    let returnText = tailLines(cleaned, lines);

    let invalidatedBy: InvalidationReason | undefined;
    let previousMatched = false;

    // Apply sinceMarker against the FULL cleaned text (not the tailed slice — markers
    // are computed from the tail end, so test against the same data we saw last time).
    if (sinceMarker) {
      // Identity invalidation overrides marker matching.
      if (obs.invalidatedBy) {
        invalidatedBy = obs.invalidatedBy === "hwnd_reused" || obs.invalidatedBy === "process_restarted"
          ? "process_restarted"
          : undefined;
      }
      if (invalidatedBy) {
        // Don't try to match — stale.
      } else {
        const sliced = applySinceMarker(cleaned, sinceMarker);
        previousMatched = sliced.matched;
        if (sliced.matched) {
          returnText = sliced.text;
        }
      }
    }

    const marker = makeMarker(cleaned);

    const cacheStateHints = buildCacheStateHints(win.hwnd, obs.invalidatedBy ? { reason: obs.invalidatedBy, previousTarget: obs.previousTarget } : null);

    const payload = {
      ok: true,
      text: returnText,
      lineCount: returnText.length === 0 ? 0 : returnText.split(/\r?\n/).length,
      source: usedSource,
      marker,
      truncated: returnText.length < cleaned.length,
      hints: {
        target: identityHints,
        terminalMarker: {
          current: marker,
          previousMatched,
          ...(invalidatedBy ? { invalidatedBy } : {}),
        },
        ...(Object.keys(cacheStateHints).length > 0 ? { caches: cacheStateHints } : {}),
        ...(usedSource === "ocr" ? { ocrFallbackFired: true } : {}),
      },
    };

    return ok(payload);
  } catch (err) {
    return failWith(err, "terminal:read", { windowTitle });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// terminal_send
// ─────────────────────────────────────────────────────────────────────────────

export const terminalSendHandler = async ({
  windowTitle, input, method: inputMethod = "auto", chunkSize = 100,
  pressEnter, focusFirst, restoreFocus, preferClipboard, pasteKey,
  forceFocus: forceFocusArg, trackFocus, settleMs,
}: {
  windowTitle: string;
  input: string;
  method?: "auto" | "background" | "foreground";
  chunkSize?: number;
  pressEnter: boolean;
  focusFirst: boolean;
  restoreFocus: boolean;
  preferClipboard: boolean;
  pasteKey: "auto" | "ctrl+v" | "ctrl+shift+v";
  forceFocus?: boolean;
  trackFocus: boolean;
  settleMs: number;
}): Promise<ToolResult> => {
  const force = forceFocusArg ?? (process.env.DESKTOP_TOUCH_FORCE_FOCUS === "1");
  const startedAt = Date.now();
  try {
    const win = findTerminalWindow(windowTitle);
    if (!win) {
      return failWith("Terminal window not found: " + windowTitle, "terminal:send", { windowTitle });
    }

    // ── Background input path (WM_CHAR) ────────────────────────────────────
    const useBg = inputMethod === "background" ||
      (inputMethod === "auto" && isBgAutoEnabled() && canInjectViaPostMessage(win.hwnd).supported);

    if (useBg) {
      const bgWarnings: string[] = [];
      if (preferClipboard) bgWarnings.push("BackgroundClipboardDowngraded");
      if (focusFirst) bgWarnings.push("BackgroundIgnoresFocusFirst");

      // Avoid duplicate Enter if input already ends with CR/LF
      const inputEndsWithNewline = /[\r\n]$/.test(input);
      const effectivePressEnter = pressEnter && !inputEndsWithNewline;

      // Send in chunks to avoid saturating the terminal input queue
      let totalSent = 0;
      for (let i = 0; i < input.length; i += chunkSize) {
        const chunk = input.slice(i, i + chunkSize);
        const result = postCharsToHwnd(win.hwnd, chunk);
        totalSent += result.sent;
        if (!result.full) {
          if (inputMethod === "background") {
            return failWith(
              new Error("BackgroundInputIncomplete"),
              "terminal:send",
              {
                suggest: [
                  "Input sent partially - retry with method:'foreground' for full input",
                  "Check context.sent vs context.total",
                ],
                context: { sent: totalSent, total: input.length },
              }
            );
          }
          // auto: partial fail — do NOT send Enter (would execute partial command)
          // Report partial send in hints and return without Enter.
          return ok({
            ok: true,
            sent: input.slice(0, totalSent),
            pressedEnter: false,
            focusRestored: false,
            method: "background",
            channel: "wm_char",
            foregroundChanged: false,
            post: { focusedWindow: null, focusedElement: null, windowChanged: false, elapsedMs: Date.now() - startedAt },
            hints: {
              target: {},
              warnings: [...bgWarnings, "BackgroundInputPartial"],
            },
          });
        }
      }

      if (effectivePressEnter) postEnterToHwnd(win.hwnd);

      return ok({
        ok: true,
        sent: input.slice(0, totalSent),
        pressedEnter: effectivePressEnter,
        focusRestored: false,
        method: "background",
        channel: "wm_char",
        foregroundChanged: false,
        post: {
          focusedWindow: null,
          focusedElement: null,
          windowChanged: false,
          elapsedMs: Date.now() - startedAt,
        },
        hints: {
          target: {},
          ...(bgWarnings.length > 0 && { warnings: bgWarnings }),
        },
      });
    }

    // Capture current foreground for restore.
    const allBefore = enumWindowsInZOrder();
    const prevFg = allBefore.find((w) => w.isActive);
    const prevFgHwnd = prevFg?.hwnd ?? null;

    const warnings: string[] = [];
    const homingNotes: string[] = [];

    let foregrounded = !focusFirst; // when not requested, treat as success
    if (focusFirst) {
      // Windows SetForegroundWindow is racy under load — retry until the target
      // really is in the foreground (or give up after 5 tries).
      const targetHwnd = String(win.hwnd);
      if (force) {
        // AttachThreadInput path: single attempt is usually sufficient.
        // `foregrounded` is not read on this branch — the warning/homing note
        // below is the only observable effect.
        restoreAndFocusWindow(win.hwnd, { force: true });
        await new Promise<void>((r) => setTimeout(r, 100));
        const fg = enumWindowsInZOrder().find((w) => w.isActive);
        if (fg && String(fg.hwnd) === targetHwnd) {
          homingNotes.push(`brought "${win.title}" to front`);
        } else {
          warnings.push("ForceFocusRefused");
        }
      } else {
        for (let attempt = 0; attempt < 5; attempt++) {
          restoreAndFocusWindow(win.hwnd);
          await new Promise<void>((r) => setTimeout(r, 100));
          const fg = enumWindowsInZOrder().find((w) => w.isActive);
          if (fg && String(fg.hwnd) === targetHwnd) { foregrounded = true; break; }
        }
        if (!foregrounded) {
          // Windows foreground-stealing protection refused the focus shift.
          // Surface this as a warning so callers (LLM / tests) can detect that
          // subsequent keystrokes may have landed on the wrong window.
          warnings.push("ForegroundNotTransferred: Windows refused SetForegroundWindow; keystrokes may have missed the target. Retry after focus_window or click on the terminal.");
        } else {
          homingNotes.push(`brought "${win.title}" to front`);
        }
      }
    }

    if (preferClipboard) {
      let chosenKey: "ctrl+v" | "ctrl+shift+v" = pasteKey === "auto" ? "ctrl+v" : pasteKey;
      if (pasteKey === "auto") {
        const procName = getProcessIdentityByPid(getWindowProcessId(win.hwnd)).processName.toLowerCase();
        if (/^(bash|wsl|mintty|alacritty|wezterm)$/.test(procName)) {
          chosenKey = "ctrl+shift+v";
        }
      }
      await typeViaClipboard(input, chosenKey);
    } else {
      await keyboard.type(input);
    }

    if (pressEnter) {
      const enter = parseKeys("enter");
      await keyboard.pressKey(...enter);
      await keyboard.releaseKey(...enter);
    }

    let focusRestored = false;
    if (restoreFocus && prevFgHwnd && prevFgHwnd !== win.hwnd) {
      try {
        restoreAndFocusWindow(prevFgHwnd);
        focusRestored = true;
      } catch { /* best-effort */ }
    }

    // Detect focus loss after sending (separate from ForegroundNotTransferred)
    let focusLost = undefined;
    if (trackFocus && !focusRestored) {
      const fl = await detectFocusLoss({
        target: windowTitle,
        homingNotes,
        settleMs,
      });
      if (fl) focusLost = fl;
    }

    const ident = observeTarget(windowTitle, win.hwnd, win.title);

    return ok({
      ok: true,
      sent: input,
      pressedEnter: pressEnter,
      focusRestored,
      ...(focusLost && { focusLost }),
      post: {
        focusedWindow: focusRestored ? prevFg?.title ?? null : win.title,
        focusedElement: null,
        windowChanged: !!prevFgHwnd && prevFgHwnd !== win.hwnd,
        elapsedMs: Date.now() - startedAt,
      },
      hints: {
        target: toTargetHints(ident.identity),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    });
  } catch (err) {
    return failWith(err, "terminal:send", { windowTitle });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// terminal run handler — send → wait → read in one call
// ─────────────────────────────────────────────────────────────────────────────

type CompletionReason = "quiet" | "pattern_matched" | "timeout" | "window_closed" | "window_not_found";

interface TerminalRunResponse {
  ok: boolean;
  output: string;
  completion: {
    reason: CompletionReason;
    elapsedMs: number;
    matchedPattern?: string;
  };
  marker?: string;
  warnings?: string[];
  hwnd?: string;
}

/**
 * Read raw text from a terminal window (for run polling — avoids full ToolResult overhead).
 * Returns null if window not found.
 */
async function readTerminalRaw(windowTitle: string): Promise<{ text: string; marker: string } | null> {
  const win = findTerminalWindow(windowTitle);
  if (!win) return null;
  const raw = (await getTextViaTextPattern(win.title)) ?? "";
  const cleaned = stripAnsi(raw);
  return { text: cleaned, marker: makeMarker(cleaned) };
}

/** Check if a window with the given hwnd still exists in the z-order list. */
function isWindowStillAlive(hwnd: unknown): boolean {
  try {
    const wins = enumWindowsInZOrder();
    return wins.some((w) => String(w.hwnd) === String(hwnd));
  } catch {
    return false;
  }
}

export const terminalRunHandler = async ({
  windowTitle, input, until, timeoutMs, sendOptions, readOptions,
}: {
  windowTitle: string;
  input: string;
  until: { mode: "quiet"; quietMs: number } | { mode: "pattern"; pattern: string; regex: boolean };
  timeoutMs: number;
  sendOptions?: Record<string, unknown>;
  readOptions?: Record<string, unknown>;
}): Promise<ToolResult> => {
  const startedAt = Date.now();
  const warnings: string[] = [];

  // ── Phase 1: Send ──────────────────────────────────────────────────────────
  const win = findTerminalWindow(windowTitle);
  if (!win) {
    const res: TerminalRunResponse = {
      ok: false,
      output: "",
      completion: { reason: "window_not_found", elapsedMs: Date.now() - startedAt },
      warnings: [`Terminal window not found: "${windowTitle}"`],
    };
    return ok(res);
  }

  const hwnd = win.hwnd;

  const sendArgs = {
    windowTitle,
    input,
    method: "auto" as const,
    chunkSize: 100,
    pressEnter: true,
    focusFirst: true,
    restoreFocus: false,   // keep focus on terminal for polling
    preferClipboard: true,
    pasteKey: "auto" as const,
    trackFocus: false,
    settleMs: 100,
    ...(sendOptions as object ?? {}),
  };

  const sendResult = await terminalSendHandler(sendArgs);
  // Check send result — if send failed, detect window state
  const sendPayload = (() => {
    try {
      const block = sendResult.content[0];
      if (block?.type === "text") return JSON.parse(block.text) as { ok?: boolean };
    } catch { /* fall through */ }
    return null;
  })();

  if (sendPayload && sendPayload.ok === false) {
    // Window disappeared after we found it (race)
    const alive = isWindowStillAlive(hwnd);
    const res: TerminalRunResponse = {
      ok: false,
      output: "",
      completion: {
        reason: alive ? "window_not_found" : "window_closed",
        elapsedMs: Date.now() - startedAt,
      },
      hwnd: String(hwnd),
      warnings: [`terminal(action='send') failed`],
    };
    return ok(res);
  }

  // Take a marker snapshot just after sending (for sinceMarker diff)
  const initialRead = await readTerminalRaw(windowTitle);
  const sinceMarker = initialRead?.marker;

  // ── Phase 2: Wait ──────────────────────────────────────────────────────────
  const POLL_INTERVAL_MS = 200;
  let completionReason: CompletionReason | null = null;
  let matchedPattern: string | undefined;
  let lastText = initialRead?.text ?? "";
  let lastTextTime = Date.now();
  const quietMs = until.mode === "quiet" ? until.quietMs : 800;

  // Compile pattern if pattern mode
  let patternRe: RegExp | null = null;
  if (until.mode === "pattern") {
    try {
      patternRe = until.regex
        ? new RegExp(until.pattern)
        : new RegExp(until.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    } catch {
      patternRe = null;
      warnings.push(`Invalid regex pattern: "${until.pattern}" — falling back to quiet mode`);
    }
  }

  // Check if initial output already matches pattern
  if (patternRe && lastText && patternRe.test(lastText)) {
    completionReason = "pattern_matched";
    matchedPattern = until.mode === "pattern" ? until.pattern : undefined;
  }

  while (completionReason === null) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));

    const elapsed = Date.now() - startedAt;

    // Timeout check
    if (elapsed >= timeoutMs) {
      completionReason = "timeout";
      break;
    }

    // Window alive check
    if (!isWindowStillAlive(hwnd)) {
      completionReason = "window_closed";
      break;
    }

    // Read current output
    const current = await readTerminalRaw(windowTitle);
    if (!current) {
      // Window disappeared between our alive check and read
      completionReason = "window_closed";
      break;
    }

    const currentText = current.text;

    if (until.mode === "pattern" && patternRe) {
      if (patternRe.test(currentText)) {
        completionReason = "pattern_matched";
        matchedPattern = until.mode === "pattern" ? until.pattern : undefined;
        break;
      }
    } else {
      // quiet mode: check if text has changed
      if (currentText !== lastText) {
        lastText = currentText;
        lastTextTime = Date.now();
      } else if (Date.now() - lastTextTime >= quietMs) {
        completionReason = "quiet";
        break;
      }
    }
  }

  // ── Phase 3: Read final output ─────────────────────────────────────────────
  const readArgs = {
    windowTitle,
    lines: 50,
    sinceMarker,
    stripAnsi: true,
    source: "auto" as const,
    ocrLanguage: "ja",
    ...(readOptions as object ?? {}),
  };

  const readResult = await terminalReadHandler(readArgs);
  let output = "";
  let finalMarker: string | undefined;
  try {
    const block = readResult.content[0];
    if (block?.type === "text") {
      const parsed = JSON.parse(block.text) as { text?: string; marker?: string; hints?: unknown };
      output = parsed.text ?? "";
      finalMarker = parsed.marker;
    }
  } catch { /* output stays empty */ }

  const response: TerminalRunResponse = {
    ok: true,
    output,
    completion: {
      // Loop only exits via the four break paths (each assigns completionReason)
      // or when the while-condition becomes false (also non-null). Non-null assertion
      // keeps the type clean without a CodeQL "always-false" defensive guard.
      reason: completionReason!,
      elapsedMs: Date.now() - startedAt,
      ...(matchedPattern !== undefined ? { matchedPattern } : {}),
    },
    ...(finalMarker ? { marker: finalMarker } : {}),
    hwnd: String(hwnd),
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  return ok(response);
};

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher schema (discriminated union)
// ─────────────────────────────────────────────────────────────────────────────

export const terminalSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read"),
    ...terminalReadSchema,
  }),
  z.object({
    action: z.literal("send"),
    ...terminalSendSchema,
  }),
  z.object({
    action: z.literal("run"),
    windowTitle: z.string().max(200).describe("Partial title of the terminal window (e.g. 'PowerShell', 'pwsh', 'WindowsTerminal')."),
    input: z.string().max(10000).describe("Command to send (Enter is appended automatically)"),
    until: z.discriminatedUnion("mode", [
      z.object({
        mode: z.literal("quiet"),
        quietMs: z.coerce.number().int().min(50).max(30000).default(800).describe("Stop when output is silent for this many ms"),
      }),
      z.object({
        mode: z.literal("pattern"),
        pattern: z.string().describe("Stop when output matches this string (or regex if regex:true)"),
        regex: z.boolean().default(false).describe("If true, treat pattern as a regex"),
      }),
    ]).default({ mode: "quiet", quietMs: 800 }),
    timeoutMs: z.coerce.number().int().min(500).max(600_000).default(30_000).describe("Hard timeout in ms (default 30s)"),
    sendOptions: z.record(z.string(), z.unknown()).optional().describe("Extra options forwarded to terminal send (method, chunkSize, etc.)"),
    readOptions: z.record(z.string(), z.unknown()).optional().describe("Extra options forwarded to terminal read (lines, source, ocrLanguage, etc.)"),
  }),
]);

export type TerminalArgs = z.infer<typeof terminalSchema>;

export const terminalDispatchHandler = async (args: TerminalArgs): Promise<ToolResult> => {
  switch (args.action) {
    case "read": return terminalReadHandler(args);
    case "send": return terminalSendHandler(args);
    case "run": return terminalRunHandler(args);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Hook for wait_until(terminal_output_contains)
// ─────────────────────────────────────────────────────────────────────────────

async function readForHook(windowTitle: string): Promise<{ text: string; marker: string } | null> {
  return readTerminalRaw(windowTitle);
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export { TERMINAL_PROCESS_RE };

export function registerTerminalTools(server: McpServer): void {
  setTerminalReadHook(readForHook);

  server.registerTool(
    "terminal",
    {
      description: buildDesc({
        purpose: "Interact with a terminal window: read output, send input, or run+wait+read in one call.",
        details: "action='run' is the recommended high-level workflow: send command → wait until quiet/pattern/timeout → read output. Returns completion={reason, elapsedMs} first-class. action='read' reads current text via UIA TextPattern (falls back to OCR); use sinceMarker for incremental diff. action='send' sends a command with focus management.",
        prefer: "action='run' for command execution + result. Use action='read'/'send' for fine-grained control or when you need to interleave other actions.",
        caveats: "Do not screenshot the terminal — terminal(action='read') is cheaper and structured. action='run' supports completion reasons: quiet | pattern_matched | timeout | window_closed | window_not_found. preferClipboard=true (send default) overwrites user clipboard.",
        examples: [
          "terminal({action:'run', windowTitle:'PowerShell', input:'npm test', until:{mode:'pattern', pattern:'npm test:'}}) → {output, completion:{reason:'pattern_matched'}}",
          "terminal({action:'run', windowTitle:'pwsh', input:'ls'}) → quiet 800ms wait, returns output",
          "terminal({action:'read', windowTitle:'PowerShell', sinceMarker:'...'}) → incremental diff",
          "terminal({action:'send', windowTitle:'PowerShell', input:'echo hello'}) → sends text + Enter",
        ],
      }),
      inputSchema: terminalSchema,
    },
    terminalDispatchHandler as (args: Record<string, unknown>) => Promise<ToolResult>
  );
}
