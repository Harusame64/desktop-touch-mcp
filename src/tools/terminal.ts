import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { ok, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith, failCode } from "./_errors.js";
import { coercedBoolean } from "./_coerce.js";
import {
  enumWindowsInZOrder,
  restoreAndFocusWindow,
  getProcessIdentityByPid,
  getWindowProcessId,
  getWindowClassName,
  type WindowZInfo,
} from "../engine/win32.js";
import {
  canInjectViaPostMessage,
  postCharsToHwnd,
  postEnterToHwnd,
  isBgAutoEnabled,
  injectViaForegroundFlash,
  TERMINAL_WINDOW_CLASSES,
} from "../engine/bg-input.js";
import { resolveBackgroundInputChannel } from "../engine/background-channel-resolver.js";
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
import { withRichNarration } from "./_narration.js";
import {
  makeCommitWrapper,
  withEnvelopeIncludeForUnion,
  flattenUnionToObjectSchema,
  parseActionArgsOrFail,
} from "./_envelope.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const terminalReadSchema = {
  windowTitle: z.string().max(200).describe("Partial title of the terminal window (e.g. 'PowerShell', 'pwsh', 'WindowsTerminal')."),
  lines: z.coerce.number().int().min(1).max(2000).default(50).describe("Tail N lines (default 50)."),
  sinceMarker: z.string().max(64).optional().describe("Marker returned from a previous call. If found in current text, only the diff is returned."),
  stripAnsi: coercedBoolean().default(true).describe("Strip ANSI escape sequences (default true)."),
  source: z.enum(["auto", "uia", "ocr"]).default("auto").describe("'auto' = UIA TextPattern then OCR fallback; 'uia' = TextPattern only (fail on miss); 'ocr' = OCR only."),
  ocrLanguage: z.string().max(20).default("ja").describe("BCP-47 language tag for OCR fallback (default 'ja')."),
};

export const terminalSendSchema = {
  windowTitle: z.string().max(200).describe("Partial title of the terminal window."),
  input: z.string().max(10000).describe("Text to send (max 10,000 chars)."),
  method: z.enum(["auto", "background", "foreground", "foreground_flash"]).default("auto").describe(
    "Input routing channel. " +
    "'auto' defaults to background (WM_CHAR) when the target is a known terminal class " +
    "(Windows Terminal / cmd / PowerShell / conhost) so user-side focus changes mid-stream " +
    "cannot divert keystrokes. DTM_BG_AUTO=1 enables BG globally; 'auto' falls back to " +
    "foreground for non-terminal targets. " +
    "'background' forces WM_CHAR injection (no focus change). " +
    "'foreground' forces the current behavior (SetForegroundWindow + clipboard paste). " +
    "'foreground_flash' (ADR-013 Option E) is an explicit opt-in 妥協 BG path for Windows " +
    "Terminal: temporarily steals foreground (~50-80ms), pastes via clipboard, sends Ctrl+V " +
    "+ Enter (when pressEnter=true), restores foreground + clipboard. Single-line + < 5KiB " +
    "only. `typingLeakRisk: true` in hints. " +
    "Default 'auto'."
  ),
  chunkSize: z.number().int().min(1).max(10000).default(100).describe(
    "Split long input into chunks of this many characters in background mode to prevent " +
    "terminal input queue saturation. Default 100. Only applies when method results in background."
  ),
  pressEnter: coercedBoolean().default(true).describe("Press Enter after typing (default true)."),
  focusFirst: coercedBoolean().default(true).describe("Focus the terminal before sending (default true)."),
  restoreFocus: coercedBoolean().default(true).describe("Restore the previously-focused window after sending (default true)."),
  preferClipboard: coercedBoolean().default(true).describe("Use clipboard paste (typeViaClipboard) — IME/long-text safe (default true)."),
  pasteKey: z.enum(["auto", "ctrl+v", "ctrl+shift+v"]).default("auto").describe("Paste key combo. 'auto' picks ctrl+shift+v for WSL/bash/mintty/wezterm/alacritty, ctrl+v elsewhere. Only used when preferClipboard=true."),
  forceFocus: coercedBoolean().optional().describe(
    "When true, bypass Windows foreground-stealing protection via AttachThreadInput " +
    "before focusing the terminal window. Default: follows env DESKTOP_TOUCH_FORCE_FOCUS (default false)."
  ),
  trackFocus: coercedBoolean().default(true).describe(
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
  const candidate = wins.find((w) => w.title.toLowerCase().includes(q));
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

// ─────────────────────────────────────────────────────────────────────────────
// Hidden-input prompt detection (issue #183)
// ─────────────────────────────────────────────────────────────────────────────
//
// When the terminal is sitting at a prompt that suppresses echo (sudo password,
// PowerShell `Read-Host -AsSecureString`, ssh passphrase, …), the post-send
// UIA read-back will see an empty diff regardless of whether WM_CHAR was
// delivered, and the verifier would mis-fire `BackgroundInputNotDelivered`.
// docs/operation-verification-matrix.md §3.1 (terminal action:send BG row)
// designates this as a known false-positive source and §4.3 reserves the
// `hidden_input_prompt` reason in the verifyDelivery hint enum for it.
//
// Detection runs against the LAST non-empty line of the pre-send UIA snapshot
// (`baselineRaw`). The line is the cursor row, i.e. where the next character
// would echo (or NOT echo, for hidden-input prompts). Earlier scrollback lines
// are ignored because they describe completed work, not the current prompt.
//
// Initial regex set is intentionally STRICT to avoid false positives on
// scrollback that happens to mention "password" mid-sentence:
//   1. `/(password|passphrase|secret|sudo)[\s:]*$/i` — common credential
//      prompts that end the line with the keyword + optional `:` / whitespace
//      (e.g. `Password:` / `[sudo] password for user:` / `Enter passphrase:`).
//   2. `/Password for /` — sudo-on-Linux/macOS exact phrasing
//      (`Password for jdoe:`); kept separate from #1 so the english "for"
//      noise does not slip through #1's anchor.
//   3. `/^>\s*$/` — PowerShell `Read-Host` continuation prompt that draws
//      `>>` / `>` on its own row when reading hidden input. Anchored both
//      ends so a stray `>` in command output cannot match.
//
// All three patterns require an end-of-line anchor (or the literal phrase
// match for sudo) so partial mentions in earlier output do not trigger.
// Future expansion (e.g. ssh-keygen "Enter passphrase (empty for no
// passphrase):") should follow the same anchored-strict rule.
// UNAMBIGUOUS secret prompts: the input is genuinely NOT echoed back.
const SECRET_INPUT_PROMPT_PATTERNS: readonly RegExp[] = [
  /(password|passphrase|secret|sudo)[\s:]*$/i,
  // Codex P1+P2: original `/Password for /` was case-sensitive AND unanchored.
  // - Case-sensitive: missed `[sudo] password for alice:` (lowercase "password")
  //   so legitimate hidden-input sends still mis-fired BackgroundInputNotDelivered.
  // - Unanchored: matched any cursor-row text containing "Password for ", which
  //   could bypass verification on non-prompt lines (e.g. an executed command
  //   string mentioning the phrase).
  // Fix: case-insensitive (`/i`) + require trailing username + colon, which is
  //   the canonical sudo prompt shape. Strict-first: configurations that omit
  //   the trailing colon (rare) are not detected here and fall through to the
  //   normal verification path. Future expansion should keep the trailing-anchor
  //   discipline.
  /password for \S+:\s*$/i,
];

// HIDDEN = SECRET + the bare-`>` PowerShell `Read-Host` continuation prompt.
// CAUTION (Codex #385 P2): a bare `>` is ALSO Bash's default PS2 continuation
// prompt, where input IS echoed. This broader set is only safe for the
// terminal_send verification skip (a false-positive there merely skips
// read-back — conservative). The terminal_run echo-anchor MUST instead use
// isSecretInputPrompt (excludes `>`): treating a Bash PS2 baseline as
// hidden-input would bypass the anchor, full-scan, and re-introduce #383.
const HIDDEN_INPUT_PROMPT_PATTERNS: readonly RegExp[] = [
  ...SECRET_INPUT_PROMPT_PATTERNS,
  /^>\s*$/,
];

/**
 * Return the last non-empty (trailing-whitespace-stripped) line of a UIA
 * TextPattern snapshot — the cursor row. ANSI is stripped here so callers can
 * pass either ANSI-laden or pre-cleaned text. Returns null for null/blank input.
 */
function lastNonEmptyPromptLine(baselineRaw: string | null): string | null {
  if (!baselineRaw) return null;
  const cleaned = stripAnsi(baselineRaw).replace(/\r\n/g, "\n");
  const lines = cleaned.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.replace(/[ \t]+$/, "");
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/**
 * Return true when the baseline cursor row matches a known hidden-input prompt
 * (credential prompts OR the bare-`>` Read-Host continuation). Used by
 * terminal_send to skip post-send read-back verification (a false-positive is
 * conservative there). Returns false on null / empty input.
 */
export function isHiddenInputPrompt(baselineRaw: string | null): boolean {
  const line = lastNonEmptyPromptLine(baselineRaw);
  if (line === null) return false;
  return HIDDEN_INPUT_PROMPT_PATTERNS.some((re) => re.test(line));
}

/**
 * Stricter sibling of isHiddenInputPrompt for the terminal_run echo-anchor:
 * matches ONLY unambiguous secret prompts (password / passphrase / secret /
 * sudo), excluding the bare-`>` pattern that doubles as Bash's PS2 continuation
 * prompt (where input IS echoed). Deciding `inputEchoes` from this avoids
 * full-scanning a Bash PS2 baseline and re-introducing #383 (Codex #385 P2).
 */
export function isSecretInputPrompt(baselineRaw: string | null): boolean {
  const line = lastNonEmptyPromptLine(baselineRaw);
  if (line === null) return false;
  return SECRET_INPUT_PROMPT_PATTERNS.some((re) => re.test(line));
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

/**
 * Issue #383: anchor pattern scanning PAST the echoed command line.
 *
 * `terminal(action='run')` captures the baseline marker BEFORE sending, so the
 * post-baseline slice from `applySinceMarker` begins at (or just after) the
 * echoed command — the terminal echoes the sent `input` before running it.
 * Matching a pattern against that echo self-matches any sentinel embedded in
 * the command (e.g. `…; echo "DONE"` + pattern "DONE"), firing before the
 * command produces any output. This locates the (normalised) `input` inside the
 * already-normalised `postBaseline` slice and returns only what FOLLOWS it, so
 * matching considers the command's real output rather than its echo.
 *
 * Returns:
 *   - string: the scan region after the echoed input (may be "" when the echo
 *     has rendered but no output has followed yet — "" is a valid target for
 *     patterns like /^$/).
 *   - undefined: the echo is not yet located → DEFER. Because the shell renders
 *     the full command echo before the command emits output, the real output
 *     cannot exist before the full echo is present; any match at this point
 *     would be inside the still-rendering echo. Callers MUST skip matching and
 *     retry. Returning the full slice instead would re-introduce #383 (e.g. an
 *     SSH-chunked echo where the sentinel arrived but the closing quote had
 *     not). On terminals where the echo never renders verbatim this defers
 *     until timeout — a loud failure preferable to a silent echo self-match.
 *
 * Single-line input is located with `indexOf` (not `startsWith`), tolerating a
 * prompt-prefix remnant before the echo (when the prompt line is shorter than
 * makeMarker's 256-char hash window). Anchoring is applied to SINGLE-LINE input
 * only: multiline input is echoed shell/terminal-dependently (continuation
 * prompts AND interleaved line-by-line output) with no reliable echo-boundary
 * discriminator in the buffer, so it is NOT anchored and falls back to the
 * pre-#383 full scan (residual multiline echo self-match tracked in #386). Both
 * `postBaseline` (via applySinceMarker) and `input` are run through
 * `normalizeForMarker` so CRLF/LF and trailing-whitespace rendering differences
 * do not break the single-line match.
 *
 * `inputEchoes=false` — for hidden-input prompts (password / passphrase /
 * secret / sudo, detected via isHiddenInputPrompt on the pre-send baseline) the
 * input is never echoed into the buffer, so there is no echo to skip and no
 * echoed command for a sentinel to self-match. The anchor is bypassed and the
 * full slice is returned, otherwise the indexOf below would never find the
 * needle and we would defer forever → until:{mode:'pattern'} would time out on
 * a perfectly valid hidden-input flow (Codex P1 on #383).
 */
export function scanRegionAfterEcho(
  postBaseline: string,
  input: string,
  inputEchoes = true,
): string | undefined {
  // Hidden-input prompt: nothing was echoed → scan the whole slice so the real
  // post-prompt output can still match.
  if (!inputEchoes) return postBaseline;
  const needle = normalizeForMarker(input);
  // Empty/blank input has no echo to skip — scan the whole slice.
  if (needle.length === 0) return postBaseline;
  // Multiline input: do NOT anchor — fall back to the pre-#383 full scan. A
  // multiline command is echoed shell/terminal-dependently: continuation
  // prompts (Bash PS2 `> `, PowerShell `>>`) AND interleaved line-by-line output
  // (conhost/pwsh run embedded newlines line-by-line, inserting each line's
  // output before the next line's echo) mean the buffer carries no reliable
  // discriminator for the echo boundary — locating it either matches prematurely
  // or defers forever (the #385 review history proved this is structural, not a
  // tunable parameter). Anchoring is therefore scoped to single-line input — the
  // case the #383 idiom (`cmd; echo "SENTINEL"`) and the issue cover. Multiline
  // keeps the prior behaviour (no regression); residual multiline echo
  // self-match is a pre-existing niche tracked in #386.
  if (needle.includes("\n")) return postBaseline;
  // Single-line: locate the echoed command and scan past it. indexOf (not
  // startsWith) tolerates a prompt-prefix remnant before the echo.
  const idx = postBaseline.indexOf(needle);
  if (idx < 0) return undefined; // defer: echo not yet located
  return postBaseline.slice(idx + needle.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// issue #386: echo-immune completion sentinel (until:{mode:'exit'})
// ─────────────────────────────────────────────────────────────────────────────
//
// #383 anchored single-line `until:{mode:'pattern'}` past the echoed command;
// multiline echo boundaries are undeterminable from the buffer alone (#386), so
// they were left to a best-effort full scan. The structural fix is to stop
// trying to locate the echo and instead match a token the DRIVER controls whose
// ECHO form differs from its OUTPUT form — echo-immune by construction for both
// single-line AND multiline.
//
// The assembled token is `__DTMCP_EXIT_<nonce>`. The shell epilogue prints it
// via a SPLIT expression (`'__DTMCP' "_EXIT_<nonce>"` / `('__DTMCP'+"_EXIT_…")`)
// so the echoed command line never contains the CONTIGUOUS token — only the
// command's runtime OUTPUT does. Matching `<token>|<exitcode>` therefore never
// self-matches the echo, with no echo-boundary detection at all.
//
// These are pure helpers (testable without a real terminal); the run handler
// wires them in P2. cmd.exe is deferred (it needs delayed expansion via
// `cmd /v:on`/`!ERRORLEVEL!`, a separate invocation path) — only bash and
// PowerShell are first-class here.

/** Shells with a first-class echo-immune exit-mode epilogue. cmd is deferred. */
export type ExitShell = "bash" | "powershell";

const EXIT_TOKEN_HEAD = "__DTMCP";
const EXIT_TOKEN_TAIL_PREFIX = "_EXIT_";

/** Assembled contiguous token that appears ONLY in real output, never the echo. */
function exitToken(nonce: string): string {
  return EXIT_TOKEN_HEAD + EXIT_TOKEN_TAIL_PREFIX + nonce;
}

/** Per-invocation random nonce (24 hex chars). Never appears literally in the
 *  echoed command, so a crypto-random value makes accidental output collision
 *  effectively impossible. */
export function generateExitNonce(): string {
  return randomBytes(12).toString("hex");
}

/**
 * Build the full command string to SEND for exit mode: optional prologue +
 * the user `input` + an echo-immune completion epilogue.
 *
 * Echo-immunity: the epilogue emits the token via a split expression, so the
 * sent (and therefore echoed) text contains `'__DTMCP' "_EXIT_<nonce>"` (bash)
 * or `('__DTMCP'+"_EXIT_<nonce>")` (PowerShell) — never the contiguous
 * `__DTMCP_EXIT_<nonce>`. Only the runtime OUTPUT assembles the contiguous token.
 *
 * Exit code (captured BEFORE the print to avoid masking, §4):
 *   - bash: `$?` → `<token>|<rc>`.
 *   - PowerShell: a `$global:LASTEXITCODE = $null` PROLOGUE clears any stale
 *     value from a previous native command, then the epilogue emits BOTH
 *     `$LASTEXITCODE` (native exe; empty when no native ran) and `$?` (cmdlet
 *     boolean) → `<token>|<code-or-empty>|<True|False>`. parseExitSentinel
 *     trusts the numeric code only when present, else maps `$?` (OQ-7).
 *
 * Callers MUST reject unsafe input first (see isUnsafeForExitMode): appending an
 * epilogue after an unterminated quote / here-doc / line continuation would be
 * swallowed by the open construct instead of executing.
 */
export function buildExitCommand(input: string, shell: ExitShell, nonce: string): string {
  const head = EXIT_TOKEN_HEAD;
  const tail = EXIT_TOKEN_TAIL_PREFIX + nonce;
  if (shell === "bash") {
    // printf args: '%s%s|%d\n' then '__DTMCP', "_EXIT_<nonce>", "$rc" (three).
    return `${input}\n__dtmcp_rc=$?; printf '%s%s|%d\\n' '${head}' "${tail}" "$__dtmcp_rc"`;
  }
  // powershell
  return (
    `$global:LASTEXITCODE = $null\n${input}\n` +
    `$dtmcp_ok=$?; $dtmcp_c=$LASTEXITCODE; ('${head}'+"${tail}")+'|'+([string]$dtmcp_c)+'|'+$dtmcp_ok`
  );
}

/**
 * Parse the echo-immune sentinel out of the post-baseline slice. Returns
 * matched=false (DEFER) until the COMPLETE sentinel line (token + separator +
 * exit-code field) has rendered — partial renders never match, and the echo
 * never contains the contiguous `<token>|<code>` form, so this is echo-immune.
 *
 * Exit-code normalisation:
 *   - bash: `<token>|<digits>` → that integer.
 *   - PowerShell: `<token>|<code-or-empty>|<True|False>` → the numeric code when
 *     a native exe ran (non-empty), else `$?` mapped True→0 / False→1 (OQ-7).
 */
export function parseExitSentinel(
  slice: string,
  nonce: string,
  shell: ExitShell,
): { matched: boolean; exitCode?: number } {
  const tk = exitToken(nonce).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (shell === "bash") {
    const m = new RegExp(tk + "\\|(\\d+)").exec(slice);
    if (!m) return { matched: false };
    return { matched: true, exitCode: parseInt(m[1], 10) };
  }
  // powershell
  const m = new RegExp(tk + "\\|(\\d*)\\|(True|False)").exec(slice);
  if (!m) return { matched: false };
  if (m[1].length > 0) return { matched: true, exitCode: parseInt(m[1], 10) };
  return { matched: true, exitCode: m[2] === "True" ? 0 : 1 };
}

/**
 * Map a window process name to an exit-mode shell with a CONFIDENCE level.
 *
 * high  — the process IS the shell (`pwsh`/`powershell`/`bash`/`wsl`, or `cmd`).
 * low   — a host that can run ANY shell and hides the real one: WindowsTerminal,
 *         conhost (classic PowerShell often surfaces as conhost too — auto is
 *         frequently low even for a local PowerShell), OpenSSH/ssh (the remote
 *         shell is invisible from the local process — the SSH/WSL-nesting wall).
 *
 * The run handler treats low confidence as a loud failure (ExitModeShellAmbiguous)
 * and asks the caller to pass `shell` explicitly, rather than guessing wrong and
 * sending a broken epilogue. `shell` here may be `cmd` (high) — the handler still
 * rejects it (ExitModeShellUnsupported) because cmd is deferred; detection and
 * support are separate concerns.
 */
export function detectShell(
  processName: string | null | undefined,
): { shell: ExitShell | "cmd" | "unknown"; confidence: "high" | "low" } {
  const p = (processName ?? "").toLowerCase().replace(/\.exe$/, "");
  if (p === "pwsh" || p === "powershell") return { shell: "powershell", confidence: "high" };
  if (p === "bash" || p === "wsl") return { shell: "bash", confidence: "high" };
  if (p === "cmd") return { shell: "cmd", confidence: "high" };
  return { shell: "unknown", confidence: "low" };
}

/**
 * Detect input that an appended epilogue would NOT safely follow. Exit mode
 * rejects these LOUDLY (ExitModeUnsafeInput) rather than sending an epilogue
 * that an open construct would swallow → silent forever-timeout.
 *
 * Conservative (bash-leaning) by design: a false positive only pushes the caller
 * to pattern/quiet mode, while a false negative would be a silent hang. Returns
 * a short reason slug or null when the input is safe to wrap.
 */
export function isUnsafeForExitMode(input: string): string | null {
  // Trailing line continuation (`\` at end) — the epilogue would be read as a
  // continuation of the user command.
  if (/\\[ \t]*$/.test(input)) return "trailing_line_continuation";
  // Bash here-doc (`<<EOF` / `<<-EOF` / `<<~EOF` / `<<'EOF'`), excluding `<<<`
  // (here-string, single-line and safe).
  if (/<<[-~]?[ \t]*(['"]?)[A-Za-z_]/.test(input) && !/<<</.test(input)) return "heredoc";
  if (/<<[-~]?[ \t]*(['"])[A-Za-z_]/.test(input)) return "heredoc";
  // PowerShell here-string openers `@"` / `@'` (multi-line literal).
  if (/@["']/.test(input)) return "powershell_herestring";
  // Unbalanced quotes — track context so an apostrophe inside "double quotes"
  // (e.g. `echo "it's fine"`) does NOT false-trip.
  if (hasUnbalancedQuotes(input)) return "unbalanced_quotes";
  return null;
}

/** Bash-semantics quote-balance scanner: backslash escapes the next char only
 *  outside single quotes; single quotes are literal (no escaping inside). */
function hasUnbalancedQuotes(input: string): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "\\" && !inSingle) { i++; continue; } // escape next char (not in '…')
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
  }
  return inSingle || inDouble;
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
      return failCode(
        "TerminalTextPatternUnavailable",
        "TextPattern not available and no OCR fallback usable",
        {
          suggest: [
            "Retry with source:'ocr' to force OCR",
            "Verify the window is actually a terminal (Windows Terminal, conhost, PowerShell)",
          ],
          context: { windowTitle: win.title },
        },
      );
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
  method?: "auto" | "background" | "foreground" | "foreground_flash";
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

    // ── ADR-013 Option E: foreground_flash 明示 opt-in path ─────────────────
    // method:'foreground_flash' は WT 等 WM_CHAR 不対応 terminal 用、Clipboard
    // + foreground steal + paste + restore の 50-80ms 妥協 BG path。caller が
    // typing leak risk + foreground 一時占有を許容した上での opt-in。
    if (inputMethod === "foreground_flash") {
      const channel = resolveBackgroundInputChannel(win.hwnd, {
        allowedChannels: ["wm_char", "clipboard_flash"],
      });

      if (channel.kind === "unsupported") {
        return failWith(
          new Error("ForegroundFlashUnsupported"),
          "terminal:send",
          {
            context: { reason: channel.reason, windowTitle: win.title },
            suggest: [
              "method:'foreground_flash' resolved to unsupported channel",
              "Try method:'foreground' for non-terminal targets",
            ],
          }
        );
      }

      if (channel.kind === "wm_char") {
        // Resolver picked wm_char (= ConsoleWindowClass)。foreground_flash semantics
        // を「foreground を奪わずに paste したい」と解釈し、wm_char で済ませる。
        // 簡易 BG path、Phase 3 MVP scope (UIA verify は省略)。
        const r = postCharsToHwnd(win.hwnd, input);
        if (!r.full) {
          return failWith(
            new Error("BackgroundInputIncomplete"),
            "terminal:send",
            { context: { sent: r.sent, total: input.length } }
          );
        }
        // Codex Round 1 P2-B 反映: input が CR/LF 終端なら Enter 重複送信を回避
        // (= 既存 BG path の newline guard と同 contract、conhost で blank command
        //  実行を防ぐ)。
        if (pressEnter && !/[\r\n]$/.test(input)) {
          postEnterToHwnd(win.hwnd);
        }
        return ok({
          ok: true,
          method: "foreground_flash",
          hints: { backgroundChannel: "wm_char" },
        });
      }

      // channel.kind === "clipboard_flash" — WT XAML、ADR-013 Option E 本流
      // (cooperative_bridge は Option F、Phase 3 MVP scope 外、narrow reject)
      if (channel.kind !== "clipboard_flash") {
        return failWith(
          new Error("ForegroundFlashChannelNotImplemented"),
          "terminal:send",
          { context: { kind: channel.kind, windowTitle: win.title } }
        );
      }
      // Codex Round 1 P2-B 同型対応: input 末尾改行で Enter 重複送信を回避。
      // text には改行を入れない構造的回避なので native validate_input が
      // input_contains_newline で reject、ここに到達した時点で input は改行ゼロ。
      // ただし caller が pressEnter 明示し、かつ将来 native side で改行許容に
      // 変わる可能性に備えて防御的に guard も書いておく。
      const flashPressEnter = pressEnter && !/[\r\n]$/.test(input);
      const flashResult = injectViaForegroundFlash(
        channel.hwnd,
        channel.pid,
        input,
        { pressEnter: flashPressEnter }, // terminal:send default true、改行終端なら抑止
      );
      if (!flashResult.ok) {
        return failWith(
          new Error(flashResult.reason ?? "ForegroundFlashFailed"),
          "terminal:send",
          {
            context: {
              reason: flashResult.reason,
              rawError: flashResult.rawError,
              windowTitle: win.title,
            },
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
        },
      });
    }

    // ── Background input path (WM_CHAR) ────────────────────────────────────
    // Focus Leash Phase A: when target is a known terminal class, default to BG
    // even without DTM_BG_AUTO=1 — terminal_send by definition operates on
    // terminals, and HWND-targeted delivery prevents user-side foreground
    // changes from diverting keystrokes mid-stream.
    //
    // Issue #173: Windows Terminal (CASCADIA_HOSTING_WINDOW_CLASS) was removed
    // from TERMINAL_WINDOW_CLASSES because its WinUI/XAML pipeline silently
    // swallows WM_CHAR. canInjectViaPostMessage now also rejects WT by class
    // and process name, so the BG path no longer auto-fires for WT and any
    // explicit `method:'background'` on WT will be additionally caught by the
    // post-send UIA read-back verification below.
    const targetClass = (() => {
      try { return getWindowClassName(win.hwnd); } catch { return ""; }
    })();
    const isTerminalTarget = !!targetClass && TERMINAL_WINDOW_CLASSES.has(targetClass);
    const useBg = inputMethod === "background" ||
      (inputMethod === "auto"
        && (isBgAutoEnabled() || isTerminalTarget)
        && canInjectViaPostMessage(win.hwnd).supported);

    if (useBg) {
      // ── Issue #195: WT explicit BG early reject ─────────────────────────
      // The `useBg` gate above only consults `canInjectViaPostMessage` for
      // the `auto` branch; explicit `method:'background'` reaches BG path
      // even when the platform check would have rejected. We split the
      // rejection by reason so the resulting code preserves each reason's
      // existing contract:
      //
      //   - `wt_xaml_pipeline` → `BackgroundInputNotDelivered` (matrix §4.3
      //     SSOT). WT's WinUI/XAML pipeline silently swallows WM_CHAR; the
      //     post-send UIA read-back at line ~528 can land on a noisy buffer
      //     where the 256-char baseline hash fails to match
      //     (`sliced.matched === false`), leaving `verifiedDelivery ===
      //     "unverifiable"` and falling through to a silent `ok:true`.
      //     Pre-empting here gives us the same code the post-send path
      //     would have returned with a clean buffer.
      //
      //   - `chromium` / `uwp_sandboxed` / `class_unknown` →
      //     `BackgroundInputUnsupported` (matches keyboard.ts:815-826
      //     existing contract). These reasons are decided by call-site
      //     class/process introspection (not by post-send read-back), so
      //     the suggest dictionary registered for `BackgroundInputUnsupported`
      //     in `_errors.ts` (e.g. "For Chrome/Edge: use browser_fill
      //     instead") is the right caller-recovery hint. Returning
      //     `BackgroundInputNotDelivered` here would replace that hint with
      //     the WT-silent-drop suggest list, breaking the existing chromium
      //     recovery path (PR #174 round 2 P1-1: "same code → same suggest").
      if (inputMethod === "background") {
        const injectCheck = canInjectViaPostMessage(win.hwnd);
        if (!injectCheck.supported) {
          const errorCode = injectCheck.reason === "wt_xaml_pipeline"
            ? "BackgroundInputNotDelivered"
            : "BackgroundInputUnsupported";
          return failWith(
            new Error(errorCode),
            "terminal:send",
            {
              context: {
                hint: "target rejects PostMessage (WM_CHAR) channel — explicit method:'background' cannot proceed",
                reason: injectCheck.reason,
                ...(injectCheck.className !== undefined && { className: injectCheck.className }),
                ...(injectCheck.processName !== undefined && { processName: injectCheck.processName }),
              },
            }
          );
        }
      }

      const bgWarnings: string[] = [];
      if (preferClipboard) bgWarnings.push("BackgroundClipboardDowngraded");
      if (focusFirst) bgWarnings.push("BackgroundIgnoresFocusFirst");

      // Avoid duplicate Enter if input already ends with CR/LF
      const inputEndsWithNewline = /[\r\n]$/.test(input);
      const effectivePressEnter = pressEnter && !inputEndsWithNewline;

      // Verification scope (issue #173 P2-4 review feedback):
      // The post-send UIA read-back is meant to catch silent BG failures on
      // unknown / WinUI hosts. When the auto-router picked BG because the
      // target is in `TERMINAL_WINDOW_CLASSES` (currently only
      // `ConsoleWindowClass`, the conhost case), the channel is well-tested
      // and the read-back would just add ~150ms with no realistic catch.
      // Verify only when:
      //   - the caller explicitly forced `method:'background'` (covers WT
      //     and any other handle the auto path would have rejected), or
      //   - we entered BG via `DTM_BG_AUTO=1` on a non-terminal class (the
      //     global env override can route input to unknown apps).
      const verificationNeeded =
        inputMethod === "background" || (isBgAutoEnabled() && !isTerminalTarget);

      // Capture pre-send UIA snapshot for post-send delivery verification.
      // If TextPattern is unavailable on this terminal, baselineMarker stays
      // null and the verification step is skipped (we can't tell if the input
      // landed without a way to read the buffer back).
      const baselineRaw = verificationNeeded ? await getTextViaTextPattern(win.title) : null;
      const baselineMarker =
        baselineRaw !== null ? makeMarker(stripAnsi(baselineRaw)) : null;

      // Send in chunks to avoid saturating the terminal input queue
      let totalSent = 0;
      for (let i = 0; i < input.length; i += chunkSize) {
        const chunk = input.slice(i, i + chunkSize);
        const result = postCharsToHwnd(win.hwnd, chunk);
        totalSent += result.sent;
        if (!result.full) {
          // Partial WM_CHAR delivery — fail regardless of method (PR #64 Codex P1):
          //   - sent > 0: a foreground fallback would re-deliver chars and double-input.
          //   - sent === 0: ok:true would silently mask command loss (e.g. when the
          //     terminal is elevated and PostMessage is blocked by UIPI).
          // Pre-Phase A this branch was opt-in via DTM_BG_AUTO=1; now it is the default
          // for terminal-class targets, so silent ok:true on partial is no longer safe.
          // Caller can retry with method:'foreground' or fix the integrity mismatch.
          return failWith(
            new Error("BackgroundInputIncomplete"),
            "terminal:send",
            {
              suggest: [
                "Input sent partially - retry with method:'foreground' for full input",
                "Check context.sent vs context.total",
                "If terminal runs elevated (admin) and caller does not, foreground delivery may be required (UIPI blocks WM_CHAR)",
              ],
              context: { sent: totalSent, total: input.length },
            }
          );
        }
      }

      // ── Issue #173 P2: post-send UIA read-back delivery verification ────
      // PostMessage(WM_CHAR) returns true when the message is queued, even if
      // the target never consumes it (e.g. Windows Terminal's XAML pipeline,
      // see issue #173). Without this check, ok:true would silently lie about
      // delivery. The check is gated by `verificationNeeded` above; here we
      // additionally skip when:
      //   - baseline could not be read (no way to verify),
      //   - input has no echo-able content (only trailing newlines), or
      //   - input contains embedded newlines. conhost commits each line at
      //     the CR and inserts a fresh prompt before the next line, so the
      //     buffer interleaves prompts between the input lines and a plain
      //     substring includes() check would false-positive as "missing".
      //     Multi-line silent fail is uncommon and out of scope for this
      //     patch; single-line substring detection is sufficient to catch
      //     the WT regression that motivated this change.
      const checkText = input.replace(/[\r\n]+$/, "");
      const hasEmbeddedNewline = /[\r\n]/.test(checkText);
      let verifiable =
        verificationNeeded &&
        baselineMarker !== null &&
        checkText.length > 0 &&
        !hasEmbeddedNewline;
      // Issue #183: hidden-input prompt detection.
      //
      // When the cursor row of `baselineRaw` is a known echo-suppressing prompt
      // (password / passphrase / sudo / PowerShell Read-Host …), the post-send
      // UIA read-back can NOT see the input regardless of whether it was
      // delivered. Continuing into Phase 4 would mis-fire
      // BackgroundInputNotDelivered on a perfectly good password keystroke.
      //
      // Instead: skip Phase 4, return ok:true with hints.verifyDelivery in the
      // §4.2 regular shape so the caller (LLM) can decide whether to retry on
      // foreground or continue. The reason `hidden_input_prompt` is reserved
      // in matrix doc §4.3.
      //
      // Detection runs only when verification would have run (verifiable=true);
      // for non-verified BG sends (e.g. conhost auto-route) the cost of an
      // extra regex check is meaningful but the upside is nil — the caller
      // would see a normal ok with no verifyDelivery hint either way.
      let verifyReason: "hidden_input_prompt" | null = null;
      if (verifiable && isHiddenInputPrompt(baselineRaw)) {
        verifyReason = "hidden_input_prompt";
        verifiable = false;
      }
      let verifiedDelivery: boolean | "unverifiable" = "unverifiable";
      if (verifiable && baselineMarker !== null) {
        // `baselineMarker !== null` repeats the gate above so TypeScript narrows
        // `baselineMarker` to `string` inside the block. (The construction of
        // `verifiable` already required it non-null, but #183 made `verifiable`
        // a `let` and the dataflow narrowing no longer survives the let.)
        // Let the terminal render before reading back. ~150ms is enough for
        // conhost; if the input was silently dropped the diff stays empty.
        await new Promise<void>((r) => setTimeout(r, 150));
        const postRaw = await getTextViaTextPattern(win.title);
        if (postRaw !== null) {
          const postCleaned = stripAnsi(postRaw);
          const sliced = applySinceMarker(postCleaned, baselineMarker);
          // Only judge "not delivered" when we located the baseline boundary;
          // a lost baseline (matched:false) is undetermined, not a failure.
          if (sliced.matched) {
            // Two-tier match (Codex P1 review feedback, refined in round 2):
            //   1. Exact substring — fast path, works for short / unwrapped
            //      single-line input echoed by the prompt as-is.
            //   2. Tail signature — the last 8 non-whitespace chars of the
            //      input must appear in the diff after both sides are stripped
            //      of whitespace. The strip is symmetric (Codex round 2 P2):
            //      stripping only the needle but not the haystack misses the
            //      soft-wrap case it was meant to catch (a console-width line
            //      break inserts whitespace into the haystack the input never
            //      had). The WT silent-fail target still fails this check
            //      because the buffer is empty of input characters when
            //      WM_CHAR is swallowed.
            const exact = sliced.text.includes(checkText);
            const tail = checkText.replace(/\s+/g, "").slice(-8);
            const slicedNoWs = sliced.text.replace(/\s+/g, "");
            const tailMatch = tail.length >= 4 && slicedNoWs.includes(tail);
            verifiedDelivery = exact || tailMatch;
          }
        }
      }
      if (verifiedDelivery === false) {
        // suggest[] is provided by classify() via SUGGESTS.BackgroundInputNotDelivered
        // — keep this call site free of duplicated copy so the dictionary stays SSOT.
        return failWith(
          new Error("BackgroundInputNotDelivered"),
          "terminal:send",
          {
            context: {
              hint: "post-send UIA read-back did not contain the input substring",
              targetClass,
            },
          }
        );
      }

      if (effectivePressEnter) postEnterToHwnd(win.hwnd);

      // Issue #183: surface hidden-input detection via the §4.2 verifyDelivery
      // hint shape so callers can react (skip retry, switch to foreground).
      // Caveat: even when verification was passed normally we don't currently
      // emit a `delivered` hint — keeping that as opt-out is consistent with
      // the rest of the BG path which only attaches hints on degradation.
      const verifyDeliveryHint =
        verifyReason === "hidden_input_prompt"
          ? {
              status: "unverifiable" as const,
              reason: "hidden_input_prompt" as const,
              channel: "wm_char" as const,
              fallback: "method:'foreground'",
            }
          : null;

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
          ...(verifyDeliveryHint ? { verifyDelivery: verifyDeliveryHint } : {}),
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
        restoreAndFocusWindow(win.hwnd, { force: true });
        await new Promise<void>((r) => setTimeout(r, 100));
        const fg = enumWindowsInZOrder().find((w) => w.isActive);
        if (fg && String(fg.hwnd) === targetHwnd) {
          homingNotes.push(`brought "${win.title}" to front`);
          foregrounded = true;
        }
      } else {
        for (let attempt = 0; attempt < 5; attempt++) {
          restoreAndFocusWindow(win.hwnd);
          await new Promise<void>((r) => setTimeout(r, 100));
          const fg = enumWindowsInZOrder().find((w) => w.isActive);
          if (fg && String(fg.hwnd) === targetHwnd) { foregrounded = true; break; }
        }
        if (!foregrounded) {
          // Issue #202 P1-2 (Opus Round 1): auto-escalate to force=true
          // (AttachThreadInput bypass) when the 5-retry default loop
          // exhausts. Mirrors window.ts:162-168 / keyboard.ts:372-380 —
          // caller expressed intent by passing windowTitle/focusFirst, so
          // we must try the strongest path before giving up. Without this
          // ladder terminal_send was the only tool in the family that
          // skipped the recovery escalation.
          restoreAndFocusWindow(win.hwnd, { force: true });
          await new Promise<void>((r) => setTimeout(r, 100));
          const fg = enumWindowsInZOrder().find((w) => w.isActive);
          if (fg && String(fg.hwnd) === targetHwnd) {
            foregrounded = true;
          }
        }
        if (foregrounded) {
          homingNotes.push(`brought "${win.title}" to front`);
        }
      }
      // Issue #202: pre-fix paths emitted `warnings:["ForceFocusRefused"]` /
      // `warnings:["ForegroundNotTransferred: ..."]` and continued with
      // `ok:true`, which let `terminal_send` write keystrokes to whichever
      // window happened to be foreground at the time. Returning a typed
      // ForegroundRestricted ok:false aligns with focus_window / keyboard
      // (mirror window.ts:170-185 / keyboard.ts:874-887). Callers can
      // branch mechanically on `code === "ForegroundRestricted"` and
      // recover via focus_window's auto-escalate ladder before retrying.
      if (!foregrounded) {
        return failWith(
          new Error("ForegroundRestricted"),
          "terminal:send",
          {
            windowTitle,
            hint: force
              ? "Win11 refused AttachThreadInput escalation; subsequent keystrokes would have missed the terminal"
              : "Win11 refused 5 SetForegroundWindow retries AND the AttachThreadInput auto-escalation; subsequent keystrokes would have missed the terminal",
            attemptedForce: force,
            // P3-1 (Opus PR #206 Round 2): success path で true、refusal path
            // は ladder を踏んだか否かで決まる。force=false 経路では 5-retry
            // 後に escalate を試行 (autoEscalated 既に false→true 遷移)、
            // force=true 経路では caller が初手 force 指定済みで ladder skip
            // (autoEscalated false 維持)。focus_window の semantic と整合。
            autoEscalated: force ? false : true,
          }
        );
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

    // Detect focus loss after sending (separate from the
    // ForegroundRestricted early-return: that fires before the keystrokes
    // are committed, this fires when focus drifts AFTER a successful send
    // — issue #202 dropped the ForegroundNotTransferred warning shape).
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

type CompletionReason =
  | "quiet"
  | "pattern_matched"
  | "exited"           // issue #386: until:{mode:'exit'} — the echo-immune
                       // completion sentinel rendered (command finished). Only
                       // exit mode sets this; carries completion.exitCode.
  | "timeout"
  | "window_closed"
  | "window_not_found"
  | "send_failed"; // issue #173 P2-2: BG path delivery verification (or any
                   // other terminal_send failure) on a still-alive window.
                   // The window is fine; the send itself was rejected.

interface ReadFailurePayload {
  code?: string;
  error?: string;
  suggest?: string[];
}

interface TerminalRunResponse {
  ok: boolean;
  output: string;
  completion: {
    reason: CompletionReason;
    elapsedMs: number;
    matchedPattern?: string;
    // issue #386: process exit code, populated ONLY by until:{mode:'exit'} (the
    // echo-immune completion sentinel carries it). Other modes omit it.
    exitCode?: number;
  };
  marker?: string;
  readError?: ReadFailurePayload;
  warnings?: string[];
  hwnd?: string;
  // Issue #196: machine-readable integrity signal so callers can branch on
  // `output` validity without parsing readError. "baseline_lost" indicates
  // the final read could not match the pre-send marker, so `output` was
  // forced to "" rather than returning scrollback that may include
  // pre-baseline (previous-session) text.
  outputIntegrity?: "ok" | "baseline_lost";
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — quiet state + read integrity (issue #196)
// ─────────────────────────────────────────────────────────────────────────────
//
// These helpers exist so the run-handler's polling decisions and final-read
// integrity check are testable without driving a real terminal. The handler
// otherwise calls `readTerminalRaw` / `terminalReadHandler` in-module, which
// makes fixture injection difficult. By isolating the *decision* into pure
// functions, unit tests can pin behaviour by passing payload-shaped inputs
// directly.

/**
 * Quiet polling state machine for `terminal({action:'run'})` (issue #196 (a)).
 *
 * The pre-fix code fired `completion.reason:"quiet"` whenever `quietMs`
 * elapsed since the last text change — including when output had **never**
 * changed at all (echo not yet rendered to UIA TextPattern). That race
 * caused short-elapsedMs returns where the buffer still held only
 * pre-send scrollback.
 *
 * The fix: do not even start the quiet timer until we have observed at
 * least one text change. A `null` `firstChangeAt` keeps the state in
 * `"still"`, which is treated as "do not break out of the loop" by the
 * caller. The hard timeout (`timeoutMs`) remains the upper bound, so
 * silent scripts cannot hang forever.
 *
 * Returned states:
 *   - "still":  no text change observed yet; quiet timer not started.
 *   - "active": change observed but quietMs has not elapsed since the
 *     last change.
 *   - "quiet":  change observed AND quietMs has elapsed since the last
 *     change → the caller should mark `completion.reason:"quiet"`.
 */
export type QuietState = "still" | "active" | "quiet";
export interface QuietGateInput {
  now: number;
  /** Last time we saw the buffer change (= lastTextTime in the loop). */
  lastTextChangedAt: number;
  /** First time we saw any change; null means no change yet. */
  firstChangeAt: number | null;
  quietMs: number;
}
export function evaluateQuietState(input: QuietGateInput): QuietState {
  if (input.firstChangeAt === null) return "still";
  if (input.now - input.lastTextChangedAt >= input.quietMs) return "quiet";
  return "active";
}

/**
 * Final-read integrity gate for `terminal({action:'run'})` (issue #196 (c)).
 *
 * When the run handler's final call to `terminal_read` could not match
 * the pre-send baseline marker, the read returns the **entire** UIA
 * buffer — which can include scrollback from previous sessions
 * (e.g. last test run's output). Bubbling that text up as `output`
 * silently lies about what the current command produced.
 *
 * This gate decides whether the run handler should suppress `output`.
 * 3-condition AND ensures we only fire when:
 *   1. We actually had a baseline marker to start with (`sinceMarker`
 *      defined). Without one, `previousMatched:false` is the read
 *      handler's default and means nothing.
 *   2. The read handler explicitly reported `previousMatched:false`
 *      (marker present in the request but not located in the buffer).
 *   3. The read handler did NOT report `invalidatedBy` (process restart,
 *      hwnd reuse) — those are separate failure modes with their own
 *      reporting paths and should not be conflated with marker drift.
 *
 * Defensive defaults (Codex review on PR #203, P2 follow-up):
 *   - `previousMatched: undefined` falls through to "ok". A future read
 *     handler that omits the field should not silently fire baseline_lost
 *     on the absence of evidence — only an explicit `false` triggers
 *     suppression.
 *   - `previousMatched: true` is also "ok" (marker located normally).
 *
 * Test contract: callers pass payload-shaped input directly so unit
 * tests do not need to drive a real `terminal_read` to exercise the
 * 4 main cases (sinceMarker undefined / hints undefined / invalidatedBy
 * present / true marker lost) plus the 2 defensive cases above.
 */
export type RunOutputIntegrity = "ok" | "baseline_lost";
export interface ReadPayloadIntegrityInput {
  sinceMarker: string | undefined;
  hints?: {
    terminalMarker?: {
      previousMatched?: boolean;
      invalidatedBy?: string;
    };
  };
}
export function evaluateRunReadIntegrity(
  input: ReadPayloadIntegrityInput,
): RunOutputIntegrity {
  if (input.sinceMarker === undefined) return "ok";
  const tm = input.hints?.terminalMarker;
  if (!tm) return "ok";
  if (tm.invalidatedBy !== undefined) return "ok";
  if (tm.previousMatched === false) return "baseline_lost";
  return "ok";
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #236: file-lock collision detector for action='run' output
// ─────────────────────────────────────────────────────────────────────────────
//
// Common pitfall the helper guards against: shell `>` redirect collides with
// the script's own `createWriteStream` on the same path. Concrete trigger
// observed 2026-05-10: `node scripts/test-capture.mjs --force > .vitest-out.txt
// 2>&1` — `>` had already opened `.vitest-out.txt` for write, then the
// script internally `createWriteStream(.vitest-out.txt)` and Node threw
// `EBUSY: resource busy or locked, open '...\\.vitest-out.txt'`. Without
// surfacing this as a warning, the run wraps to `ok:true,
// completion:{reason:"pattern_matched"}` (the marker echo stays intact) and
// the calling agent treats it as success when the actual command died at
// the file-system layer — a textbook silent-success contract drift.
//
// The helper lives next to evaluateRunReadIntegrity above so the run handler
// can call it after the final read populates `output`. Returns null on no
// signal so the caller's `if (...)` is cheap; returns a single ready-to-push
// warning string (with `FileLockCollision:` prefix matching the existing
// `BaselineMarkerLost:` warning style) when a signal IS detected. The
// helper is pure (string in, string-or-null out) for unit testability.

const NODE_EBUSY_PATTERN = /EBUSY:\s*resource busy or locked,\s*\w+\s+'([^']+)'/;
const WINDOWS_FILE_LOCK_PATTERN =
  /cannot access the file because it is being used by another process/i;
const POSIX_ADVISORY_LOCK_PATTERN =
  /\b(?:EAGAIN|EDEADLK)\b[^]*?Resource temporarily unavailable/i;

export function detectFileLockCollision(output: string): string | null {
  if (!output) return null;

  // Node.js EBUSY: most common in script + redirect collision (the trigger
  // case). Path extraction lets the caller see WHICH file collided so the
  // fix is actionable (drop the redirect, or pipe to a different target).
  const nodeMatch = output.match(NODE_EBUSY_PATTERN);
  if (nodeMatch) {
    return (
      `FileLockCollision: Node EBUSY on '${nodeMatch[1]}' — common cause: ` +
      `shell '>' redirect collided with the script's own write of the same ` +
      `file. Run without redirect, or pipe to a different target.`
    );
  }

  // Windows native: "The process cannot access the file because it is being
  // used by another process." emitted by tools that use Win32 CreateFile
  // without FILE_SHARE_* flags (e.g. `type`, `move`, some PowerShell cmdlets).
  if (WINDOWS_FILE_LOCK_PATTERN.test(output)) {
    return (
      "FileLockCollision: Windows file-lock detected in output — another " +
      "process holds the target file open. Check for orphan handles or " +
      "redirect conflicts."
    );
  }

  // POSIX advisory locks: flock / lockf / fcntl can return EAGAIN /
  // EDEADLK paired with "Resource temporarily unavailable". Less common
  // on Win32 hosts but the tool runs cross-platform and shells like git-bash
  // / WSL surface POSIX-shape errors.
  if (POSIX_ADVISORY_LOCK_PATTERN.test(output)) {
    return (
      "FileLockCollision: POSIX advisory lock collision (EAGAIN/EDEADLK) " +
      "detected in output. Another process holds an advisory lock on a " +
      "resource the command needs."
    );
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defensive JSON-string preprocessor (issue #196 symptom 1)
// ─────────────────────────────────────────────────────────────────────────────
//
// Some MCP clients / LLM tool-call serialisers send nested object arguments
// as JSON-encoded strings (observed: `until: '{"mode":"pattern",...}'` on
// `terminal({action:'run'})`). The reported error "expected object,
// received string" was rooted there, not in the server-side zod —
// `terminalRegistrationSchema.safeParse(...)` accepts the object literal
// fine (see `tests/unit/issue-196-terminal-run-until-schema.test.ts`).
//
// This wrapper accepts both shapes by trying `JSON.parse` first when the
// value comes in as a string. Non-object parse results (e.g. `"42"` →
// 42, `"null"` → null) and parse failures fall through unchanged so
// downstream zod still surfaces a typed error rather than a coerced
// nonsense object.

/** Parse a possible JSON-encoded object string into an object. Pass through otherwise.
 *
 * Heuristic: only attempt parse when the trimmed string looks like a JSON
 * object/array (`{...}` / `[...]`). Bare strings like `"x"`, the empty
 * string `""`, and primitive literals `"42"` / `"null"` do not start with
 * `{` or `[`, so we leave them untouched and let the inner zod surface a
 * typed error rather than coerce nonsense into the schema (Codex review on
 * PR #203, P2 follow-up).
 *
 * Arrays parse successfully (`typeof [...] === "object"`) and are returned
 * as-is. The inner zod for `until` / `sendOptions` / `readOptions` rejects
 * arrays with a typed error, but bubbling up the parsed array gives the
 * caller a more accurate "expected object, received array" message than
 * the legacy "expected object, received string" — which had obscured the
 * actual shape sent by the caller.
 */
function tryParseJsonObject(val: unknown): unknown {
  if (typeof val !== "string") return val;
  const trimmed = val.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return val;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) return parsed;
    return val;
  } catch {
    return val;
  }
}

// Forwarded-option whitelists derived from the public terminal_send / _read schemas.
// `windowTitle` and `input` are excluded because run() owns those, and `sinceMarker`
// is excluded because run() computes the baseline marker itself.
//
// IMPORTANT: every wrapped field still carries its `.default(...)` from the public
// schema. Zod v4's `.partial()` makes the key optional but does NOT strip defaults;
// the parsed object will materialise default values for any missing key. We rely
// on `keepOnlyProvidedKeys()` below to filter the parsed result back down to the
// keys the caller actually supplied — otherwise an empty `sendOptions:{}` would
// silently overwrite run-specific defaults (`restoreFocus:false`, `trackFocus:false`,
// `settleMs:100`) with terminal_send's defaults (true / true / 300).
export const TERMINAL_RUN_SEND_OPTIONS_SCHEMA = z.object({
  method: terminalSendSchema.method,
  chunkSize: terminalSendSchema.chunkSize,
  pressEnter: terminalSendSchema.pressEnter,
  focusFirst: terminalSendSchema.focusFirst,
  restoreFocus: terminalSendSchema.restoreFocus,
  preferClipboard: terminalSendSchema.preferClipboard,
  pasteKey: terminalSendSchema.pasteKey,
  forceFocus: terminalSendSchema.forceFocus,
  trackFocus: terminalSendSchema.trackFocus,
  settleMs: terminalSendSchema.settleMs,
}).partial().strict();

export const TERMINAL_RUN_READ_OPTIONS_SCHEMA = z.object({
  lines: terminalReadSchema.lines,
  stripAnsi: terminalReadSchema.stripAnsi,
  source: terminalReadSchema.source,
  ocrLanguage: terminalReadSchema.ocrLanguage,
}).partial().strict();

function describeZodIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") + ": " : ""}${i.message}`)
    .join("; ");
}

/**
 * Filter a Zod-parsed object to only the keys actually present in the original
 * caller input. Required because `z.partial()` does not strip `.default(...)`
 * markers from inner field types — without this, defaults injected by Zod for
 * absent keys would leak into the merged sendArgs/readArgs and overwrite run's
 * intentional non-default values.
 */
function keepOnlyProvidedKeys<T extends Record<string, unknown>>(
  parsed: T,
  input: Record<string, unknown>
): Partial<T> {
  const inputKeys = new Set(Object.keys(input));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (inputKeys.has(k)) out[k] = v;
  }
  return out as Partial<T>;
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

  // ── Phase 0: Validate forwarded options ────────────────────────────────────
  // Reject invalid sendOptions/readOptions BEFORE doing any I/O so unbounded
  // values (e.g. chunkSize:0 hanging the background loop, source:'uia' on a
  // non-TextPattern terminal) cannot bypass the public schema bounds.
  // Use failCode("InvalidArgs", ...) (the explicit-code presenter) so we get
  // code:"InvalidArgs" and the suggest[] array stays at the top level. failWith
  // would classify "Invalid sendOptions" as the generic "ToolError" code and
  // bury our custom suggest strings under context.suggest, which mis-classifies
  // argument errors as internal errors and hides actionable remediation guidance.
  let validatedSendOptions: Partial<z.infer<typeof TERMINAL_RUN_SEND_OPTIONS_SCHEMA>> = {};
  if (sendOptions !== undefined) {
    const parsed = TERMINAL_RUN_SEND_OPTIONS_SCHEMA.safeParse(sendOptions);
    if (!parsed.success) {
      return failCode(
        "InvalidArgs",
        `terminal:run: Invalid sendOptions: ${describeZodIssues(parsed.error)}`,
        {
          suggest: [
            "Refer to terminal(action='send') schema for valid keys/types",
            "windowTitle, input, and sinceMarker cannot be overridden via sendOptions",
          ],
          context: { windowTitle },
        },
      );
    }
    validatedSendOptions = keepOnlyProvidedKeys(parsed.data, sendOptions);
  }
  let validatedReadOptions: Partial<z.infer<typeof TERMINAL_RUN_READ_OPTIONS_SCHEMA>> = {};
  if (readOptions !== undefined) {
    const parsed = TERMINAL_RUN_READ_OPTIONS_SCHEMA.safeParse(readOptions);
    if (!parsed.success) {
      return failCode(
        "InvalidArgs",
        `terminal:run: Invalid readOptions: ${describeZodIssues(parsed.error)}`,
        {
          suggest: [
            "Refer to terminal(action='read') schema for valid keys/types",
            "windowTitle and sinceMarker cannot be overridden via readOptions",
          ],
          context: { windowTitle },
        },
      );
    }
    validatedReadOptions = keepOnlyProvidedKeys(parsed.data, readOptions);
  }

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

  // Capture the baseline marker BEFORE sending. If we wait until after the send
  // returns, fast-completing commands (e.g. `echo`) may already have written
  // their output, and using a post-send marker would slice that output off in
  // the final sinceMarker diff.
  const baselineRead = await readTerminalRaw(windowTitle);
  const sinceMarker = baselineRead?.marker;
  // Codex P1 (#383): if the pre-send prompt suppresses echo (password /
  // passphrase / secret / sudo), the sent `input` is not echoed into the
  // buffer, so the echo-anchor (scanRegionAfterEcho) could never locate it and
  // would defer forever → until:{mode:'pattern'} would time out on a valid
  // hidden-input flow. Detect that from the pre-send baseline and bypass the
  // anchor in that case.
  // Use isSecretInputPrompt (NOT isHiddenInputPrompt): the latter also matches a
  // bare `>`, which is Bash's PS2 continuation prompt where input IS echoed —
  // bypassing the anchor there would full-scan and re-introduce #383 (Codex
  // #385 P2). A false-positive here harms in the #383 direction (vs send, where
  // it merely skips read-back), so the stricter end-anchored secret-only set is
  // required. The narrow PowerShell Read-Host (`>`) hidden-input case is not
  // bypassed and degrades to a loud timeout — safer than a silent echo match.
  const inputEchoes = !isSecretInputPrompt(baselineRead?.text ?? null);

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
    ...validatedSendOptions,
  };

  const sendResult = await terminalSendHandler(sendArgs);
  // Check send result — if send failed, classify by code + window state.
  const sendPayload = (() => {
    try {
      const block = sendResult.content[0];
      if (block?.type === "text") {
        return JSON.parse(block.text) as { ok?: boolean; code?: string };
      }
    } catch { /* fall through */ }
    return null;
  })();

  if (sendPayload && sendPayload.ok === false) {
    // Issue #173 P2-2: when the window is still alive but send failed, the
    // most accurate completion reason is "send_failed" — the window IS found,
    // the SEND was rejected. Older code split alive into "window_not_found",
    // but `findTerminalWindow` above already early-returns "window_not_found"
    // when the window is missing, so any send failure that reaches here on a
    // live HWND is a send-side failure (BackgroundInputNotDelivered, focus
    // retry exhausted, etc.). Surface the code in warnings so callers can
    // branch on the underlying cause without parsing the message.
    const alive = isWindowStillAlive(hwnd);
    const sendCode = sendPayload.code;
    const res: TerminalRunResponse = {
      ok: false,
      output: "",
      completion: {
        reason: alive ? "send_failed" : "window_closed",
        elapsedMs: Date.now() - startedAt,
      },
      hwnd: String(hwnd),
      warnings: [
        sendCode
          ? `terminal(action='send') failed: ${sendCode}`
          : `terminal(action='send') failed`,
      ],
    };
    return ok(res);
  }

  // ── Phase 2: Wait ──────────────────────────────────────────────────────────
  // Quiet detection: do NOT start the quietMs timer until we have observed at
  // least one buffer change (issue #196 (a)). Pre-fix code fired
  // `completion.reason:"quiet"` whenever quietMs elapsed since `lastTextTime`,
  // which on a buffer that never changed (e.g. echo not yet rendered to UIA
  // TextPattern) collapsed to "fire after quietMs from send" and returned
  // pre-send scrollback. The `firstChangeTime` gate is consulted via
  // `evaluateQuietState`; while it is null, the loop waits for either the
  // hard timeout, a window-closed event, or a real change.
  const POLL_INTERVAL_MS = 200;
  let completionReason: CompletionReason | null = null;
  let matchedPattern: string | undefined;
  let lastText = baselineRead?.text ?? "";
  let lastTextTime = Date.now();
  let firstChangeTime: number | null = null;
  // Pattern-mode fallback (when patternRe compile fails — see warnings) uses
  // the same updated default. Issue #196 (b) raised 800 → 1500 on the schema
  // side; this immediate value must stay in sync so the fallback path is not
  // a hidden short-default outlier.
  const quietMs = until.mode === "quiet" ? until.quietMs : 1500;

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

  // Pattern matching must only consider content that appeared AFTER the echoed
  // command line. The baseline marker is captured before sending, so the slice
  // from applySinceMarker begins at the echoed `input`; matching there would
  // self-match a sentinel embedded in the command (issue #383). We therefore
  // (1) slice to content after the baseline marker (applySinceMarker), then
  // (2) anchor PAST the echoed input (scanRegionAfterEcho).
  // Returns:
  //   - string: content after the echoed input (may be "" — a valid target for
  //     patterns like /^$/).
  //   - undefined: skip matching this tick. Two distinct causes, both honoured
  //     by the same caller guard (newContent !== undefined):
  //       (a) baseline boundary lost (no marker, or applySinceMarker scanned
  //           past its 32k window) — falling back to the full buffer would
  //           re-introduce prior-history false positives.
  //       (b) echo not yet located (#383 defer) — the real output cannot exist
  //           before the full echo renders, so any match would be inside the
  //           still-rendering echo; defer and retry on the next tick. Hidden-input
  //           prompts (password/secret) suppress the echo entirely, so the anchor
  //           is bypassed there (inputEchoes=false) rather than deferring forever.
  const newContentSinceBaseline = (text: string): string | undefined => {
    if (!sinceMarker) return undefined;
    const sliced = applySinceMarker(text, sinceMarker);
    if (!sliced.matched) return undefined;
    return scanRegionAfterEcho(sliced.text, input, inputEchoes);
  };

  // Immediate post-send pattern check — runs once before the first POLL_INTERVAL_MS
  // sleep so transient lines (e.g. CR-updated progress indicators that overwrite
  // themselves rapidly) are not missed by waiting for the first poll tick. The
  // truthiness gate on newContent is intentionally absent: empty content is a
  // valid input for patterns like "" or /^$/ that match emptiness.
  if (patternRe) {
    const initialPostSend = await readTerminalRaw(windowTitle);
    if (initialPostSend) {
      const newContent = newContentSinceBaseline(initialPostSend.text);
      // newContent === undefined → baseline lost, skip to avoid prior-history match.
      // newContent === "" is still a valid input for patterns like /^$/.
      if (newContent !== undefined && patternRe.test(newContent)) {
        completionReason = "pattern_matched";
        matchedPattern = until.mode === "pattern" ? until.pattern : undefined;
      }
    }
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
      const newContent = newContentSinceBaseline(currentText);
      // newContent === undefined → baseline lost, skip to avoid prior-history match.
      // newContent === "" is still valid input for patterns like /^$/.
      if (newContent !== undefined && patternRe.test(newContent)) {
        completionReason = "pattern_matched";
        matchedPattern = until.mode === "pattern" ? until.pattern : undefined;
        break;
      }
    } else {
      // quiet mode: track changes and consult the pure helper. The helper
      // returns "still" until the first change is observed; this prevents
      // quiet from firing on a buffer that has not moved since send (issue
      // #196 (a)). After the first change, "active" / "quiet" decisions
      // follow the usual lastTextTime-based countdown.
      if (currentText !== lastText) {
        lastText = currentText;
        lastTextTime = Date.now();
        firstChangeTime ??= lastTextTime;
      } else {
        const state = evaluateQuietState({
          now: Date.now(),
          lastTextChangedAt: lastTextTime,
          firstChangeAt: firstChangeTime,
          quietMs,
        });
        if (state === "quiet") {
          completionReason = "quiet";
          break;
        }
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
    ...validatedReadOptions,
  };

  const readResult = await terminalReadHandler(readArgs);
  let output = "";
  let finalMarker: string | undefined;
  let readError: ReadFailurePayload | undefined;
  // Issue #196 (c): emit `outputIntegrity` ONLY when the integrity gate has
  // actually been evaluated (i.e. final read succeeded). Read-handler
  // failures (parsed.ok === false) and JSON-parse exceptions reach the
  // bottom of this block with `outputIntegrity === undefined`, and the
  // response object below omits the field in those cases — emitting
  // `outputIntegrity:"ok"` on a failed read would be misleading because
  // the gate never ran (Codex review on PR #203, P2 follow-up).
  let outputIntegrity: RunOutputIntegrity | undefined;
  try {
    const block = readResult.content[0];
    if (block?.type === "text") {
      const parsed = JSON.parse(block.text) as {
        ok?: boolean;
        text?: string;
        marker?: string;
        code?: string;
        error?: string;
        suggest?: string[];
        hints?: {
          terminalMarker?: {
            previousMatched?: boolean;
            invalidatedBy?: string;
          };
        };
      };
      if (parsed.ok === false) {
        // Surface read-handler failures (e.g. source:'uia' on a terminal
        // without TextPattern) instead of silently returning ok:true with
        // empty output. `outputIntegrity` stays undefined here because the
        // gate cannot run without a successful read payload.
        readError = {
          ...(parsed.code ? { code: parsed.code } : {}),
          ...(parsed.error ? { error: parsed.error } : {}),
          ...(parsed.suggest && parsed.suggest.length > 0 ? { suggest: parsed.suggest } : {}),
        };
        warnings.push("Final read failed — output may be unavailable. See readError for details.");
      } else {
        // Issue #196 (c): when baselineRead succeeded (sinceMarker present)
        // but the read handler could not match the marker in the post-run
        // buffer, we are looking at scrollback that may include text from
        // before the run. Suppress `output` and surface `BaselineMarkerLost`
        // instead of returning a misleading "ok:true with stale text" mix.
        const integrity = evaluateRunReadIntegrity({
          sinceMarker,
          hints: parsed.hints,
        });
        outputIntegrity = integrity;
        if (integrity === "baseline_lost") {
          output = "";
          readError = {
            code: "BaselineMarkerLost",
            error:
              "baseline marker lost beyond 32k scan window — scrollback may contain pre-baseline output (previous-session residue)",
            suggest: [
              "Use until:{mode:'pattern', pattern:'<expected output>'} for long-running commands so the run can match without falling back to a marker scan",
              "Increase timeoutMs and ensure the command produces output before quiet detection elapses",
              "If the command genuinely produces no diff, call terminal({action:'send'}) followed by terminal({action:'read', sinceMarker:...}) for explicit incremental fetches",
            ],
          };
          warnings.push(
            "BaselineMarkerLost: scrollback may contain pre-baseline output — output suppressed. Use pattern mode for long-running commands.",
          );
          // finalMarker stays undefined; the buffer we read is not a trusted
          // anchor for a follow-up sinceMarker call.
        } else {
          output = parsed.text ?? "";
          finalMarker = parsed.marker;
        }
      }
    }
  } catch { /* output stays empty; outputIntegrity stays undefined */ }

  // Issue #236: post-process EBUSY-family file-lock collision detection.
  // Surfaces a `FileLockCollision:` warning when the captured output
  // contains the Node EBUSY / Windows / POSIX lock signatures. Runs only
  // when output is non-empty (skips baseline_lost path which forces output
  // to "" on purpose). The check is pure-string match, microsecond cost.
  if (output) {
    const lockHint = detectFileLockCollision(output);
    if (lockHint !== null) {
      warnings.push(lockHint);
    }
  }

  const response: TerminalRunResponse = {
    ok: readError === undefined,
    output,
    completion: {
      // Loop only exits via the four break paths (each assigns completionReason)
      // or when the while-condition becomes false (also non-null). Non-null assertion
      // keeps the type clean without a CodeQL "always-false" defensive guard.
      reason: completionReason!,
      elapsedMs: Date.now() - startedAt,
      ...(matchedPattern !== undefined ? { matchedPattern } : {}),
    },
    ...(outputIntegrity !== undefined ? { outputIntegrity } : {}),
    ...(finalMarker ? { marker: finalMarker } : {}),
    ...(readError ? { readError } : {}),
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
    input: z.string().max(10000).optional().describe("Command to send (Enter is appended automatically). Either `input` or its deprecated alias `command` is required."),
    command: z.string().max(10000).optional().describe("[Deprecated alias of `input`] Accepted for callers that mis-remember the parameter name; new code should use `input`. If both are set, `input` wins."),
    // Issue #196: `until` / `sendOptions` / `readOptions` are wrapped with
    // `z.preprocess(tryParseJsonObject, ...)` so callers that send these as
    // JSON-encoded strings (some LLM tool-call serialisers do — see helper
    // docstring above) are handled the same as object literals. Object
    // literals pass through unchanged.
    //
    // Default `quietMs` raised 800 → 1500: short-interactive command timing
    // is unchanged in practice (most prompts return well within the new
    // ceiling) but the most common 800ms-silent-gap-then-quiet false-fire
    // (e.g. test runner startup) is materially reduced. Long-running
    // commands should still use `until:{mode:"pattern",...}` (see tool
    // description caveats).
    until: z.preprocess(tryParseJsonObject, z.discriminatedUnion("mode", [
      z.object({
        mode: z.literal("quiet"),
        quietMs: z.coerce.number().int().min(50).max(30000).default(1500).describe("Stop when output is silent for this many ms (default 1500)."),
      }),
      z.object({
        mode: z.literal("pattern"),
        pattern: z.string().describe("Stop when output matches this string (or regex if regex:true)"),
        regex: coercedBoolean().default(false).describe("If true, treat pattern as a regex"),
      }),
    ])).default({ mode: "quiet", quietMs: 1500 }),
    timeoutMs: z.coerce.number().int().min(500).max(600_000).default(30_000).describe("Hard timeout in ms (default 30s)"),
    sendOptions: z.preprocess(tryParseJsonObject, z.record(z.string(), z.unknown())).optional().describe("Extra options forwarded to terminal send (method, chunkSize, etc.)"),
    readOptions: z.preprocess(tryParseJsonObject, z.record(z.string(), z.unknown())).optional().describe("Extra options forwarded to terminal read (lines, source, ocrLanguage, etc.)"),
  }).refine(
    (obj) => typeof obj.input === "string" || typeof obj.command === "string",
    { message: "terminal(action='run') requires `input` (or its deprecated alias `command`)", path: ["input"] },
  ),
]);

export type TerminalArgs = z.infer<typeof terminalSchema>;

export const terminalDispatchHandler = async (args: TerminalArgs): Promise<ToolResult> => {
  // ADR-018 Phase 2a — strict per-action gate (§2.5.2). The registered wire
  // schema is the flat `flattenUnionToObjectSchema` output; re-parse against
  // the real (include-injected) union so the `run` variant's
  // `.refine(input || command)` and the nested `until` union still apply.
  const parsed = parseActionArgsOrFail<TerminalArgs>(terminalUnionWithInclude, args, "terminal");
  if (!parsed.ok) return parsed.result;
  const a = parsed.value;
  switch (a.action) {
    case "read": return terminalReadHandler(a);
    case "send": return terminalSendHandler(a);
    case "run": {
      // Issue #245 系統③: `command` is a deprecated alias of `input` for LLMs
      // that mis-remember the parameter name. Resolve to `input` here so the
      // handler signature stays `input: string`.
      const resolvedInput = typeof a.input === "string" ? a.input : a.command;
      if (typeof resolvedInput !== "string") {
        // Unreachable: `parseActionArgsOrFail` above re-parsed `terminalSchema`,
        // whose `run` variant `.refine(input || command)` already rejected this
        // case as a typed InvalidArgs error. Kept so TS narrows `resolvedInput`.
        throw new Error("terminal(action='run'): neither `input` nor `command` provided");
      }
      return terminalRunHandler({ ...a, input: resolvedInput });
    }
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

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `terminal` is wrapped via `makeCommitWrapper` (lease-less commit variant —
 * `leaseValidator` omitted; terminal dispatches to read/send/run actions
 * without a lease 4-tuple, mirroring PR #123 keyboard / PR #126 clipboard /
 * PR #127 scroll / PR #131 window_dock discriminatedUnion (3b) family pattern).
 *
 * `withRichNarration` (inner, windowTitleKey: "windowTitle" — all 3 variants
 * share the `windowTitle` field) → `makeCommitWrapper` (outer):
 *   - withRichNarration enriches the handler's ToolResult with post.* state
 *     (rich-narrate UIA-diff path is unreachable since `narrate` isn't in
 *     the schema — falls through to withPostState only)
 *   - makeCommitWrapper handles L1 ToolCallStarted/Completed push +
 *     envelope assembly + compat hoist + tool_call_id seq
 *
 * Module-scope export so `run_macro` (`TOOL_REGISTRY.terminal` in
 * `macro.ts`) shares the same wrapped instance (PR #112 shared
 * registration handler pattern, strip risk prevention).
 */
// ADR-018 Phase 2a — `terminalUnionWithInclude` (include-injected union) feeds
// BOTH the flat wire schema AND the in-handler `parseActionArgsOrFail` gate.
// The flatten reads each variant's `.shape` directly — terminal's `run` variant
// is `.refine()`-wrapped but in zod 4.3.6 that is still a `ZodObject`, so no
// unwrap is needed; the nested `until` discriminatedUnion is left intact and
// renders as a property-level `anyOf` (accepted by the Anthropic API).
const terminalUnionWithInclude = withEnvelopeIncludeForUnion(terminalSchema);
export const terminalRegistrationSchema = flattenUnionToObjectSchema(terminalUnionWithInclude);

export const terminalRegistrationHandler = makeCommitWrapper(
  withRichNarration(
    "terminal",
    terminalDispatchHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
    { windowTitleKey: "windowTitle" },
  ) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "terminal",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

export function registerTerminalTools(server: McpServer): void {
  setTerminalReadHook(readForHook);

  server.registerTool(
    "terminal",
    {
      description: buildDesc({
        purpose: "Interact with a terminal window: read output, send input, or run+wait+read in one call. action='read' / action='send' absorb the formerly-standalone read/send tools (Phase 4).",
        details: "action='run' is the recommended high-level workflow: send command → wait until quiet/pattern/timeout → read output. The command text is passed as `input` (the legacy parameter name `command` is also accepted as a deprecated alias — see issue #245). Returns completion={reason, elapsedMs} first-class plus outputIntegrity:'ok'|'baseline_lost' so callers can detect when scrollback could not be anchored to the pre-send buffer. action='read' reads current text via UIA TextPattern (falls back to OCR); use sinceMarker for incremental diff. action='send' sends a command with focus management.",
        prefer: "action='run' for command execution + result. For long-running commands (test runners, builds, deploys) use until:{mode:'pattern', pattern:'<final marker>'} — the default quiet mode is tuned for short interactive commands and may complete prematurely on multi-second silent gaps mid-run. Use action='read'/'send' for fine-grained control or when you need to interleave other actions.",
        caveats: "Do not screenshot the terminal — action='read' is cheaper and structured. action='run' supports completion reasons: quiet | pattern_matched | timeout | window_closed | window_not_found | send_failed (send rejected on a live window — see warnings for the underlying error code). When outputIntegrity:'baseline_lost' is returned, output is forced to '' and readError.code='BaselineMarkerLost' is set: rerun with until:{mode:'pattern',...} or longer timeoutMs. action='run' may also emit warnings prefixed FileLockCollision: when output reveals an EBUSY/Windows-lock/EAGAIN-EDEADLK file collision (e.g. shell '>' redirect colliding with the script's own writer — issue #236). Default quietMs=1500 (issue #196); long silences require pattern mode. preferClipboard=true (send default) overwrites clipboard. Hidden-input prompts emit verifyDelivery.unverifiable (reason:'hidden_input_prompt') — use method:'foreground'. action='read' typed errors: TerminalWindowNotFound, TerminalTextPatternUnavailable (force source:'ocr'); stale sinceMarker → hints.terminalMarker.previousMatched:false on ok:true (omit sinceMarker). FG-path Win11 foreground refusal returns code:'ForegroundRestricted' — switch to method:'background' or DTM_BG_AUTO=1. BG path auto-engages only when (a) the target window class is `ConsoleWindowClass` (conhost: cmd / PowerShell / pwsh classic hosts) OR (b) env DTM_BG_AUTO=1 is set globally. Windows Terminal (`CASCADIA_HOSTING_WINDOW_CLASS`) is intentionally EXCLUDED from auto-engage (issue #173): WT runs on WinUI/XAML and silently drops WM_CHAR posted to its HWND, so the FG path is used by default — pass sendOptions:{method:'background'} only if you have verified your WT build accepts BG input.",
        examples: [
          "terminal({action:'run', windowTitle:'PowerShell', input:'npm test', until:{mode:'pattern', pattern:'Test Files'}}) → recommended for test runners; matches when vitest summary appears",
          "terminal({action:'run', windowTitle:'pwsh', input:'ls'}) → quiet 1500ms wait, returns output (short interactive)",
          "terminal({action:'run', windowTitle:'pwsh', command:'ls'}) → identical to the above; `command` is a deprecated alias of `input` (issue #245)",
          "terminal({action:'read', windowTitle:'PowerShell', sinceMarker:'...'}) → incremental diff using the read action",
          "terminal({action:'send', windowTitle:'PowerShell', input:'echo hello'}) → sends text + Enter using the send action",
        ],
      }),
      inputSchema: terminalRegistrationSchema,
    },
    terminalRegistrationHandler as (args: Record<string, unknown>) => Promise<ToolResult>
  );
}
