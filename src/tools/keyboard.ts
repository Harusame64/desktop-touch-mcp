import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { buildDesc } from "./_types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { keyboard, withKeyboardLock, rawKeyboard } from "../engine/nutjs.js";
import { parseKeys } from "../utils/key-map.js";
import { assertKeyComboSafe } from "../utils/key-safety.js";
import { enumWindowsInZOrder, getWindowClassName, restoreAndFocusWindow, getWindowRectByHwnd, getForegroundHwnd } from "../engine/win32.js";
import { nativeWin32, hasNativeTypeViaClipboard } from "../engine/native-engine.js";
import type { NativeTypeViaClipboardResult } from "../engine/native-types.js";
// ADR-033: the fallback's command-line ceiling, the shared give-up budget and
// the abort-on-timeout helper all belong to the clipboard tool, which reaches
// the same two backends. Imported rather than duplicated so the two paths
// cannot drift apart on a measured number.
import { FALLBACK_MAX_CHARS, WRITE_TIMEOUT_MS as CLIPBOARD_WRITE_TIMEOUT_MS, withTimeout } from "./clipboard.js";
// ADR-019 Stage 4 — SSIM `local_repaint` fallback when BG verify reaches
// terminal `unverifiable + read_back_unsupported`. See sub-plan §2.4.2.
import { captureFrame, type RawFrame } from "../engine/layer-buffer.js";
import { verifyLocalRepaint } from "../engine/local-repaint.js";
import { verifyAnyChange } from "../engine/any-change.js";
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
import { scanSinceMarkerNormEnd } from "./_since-marker.js";
import { evaluatePreToolGuards, buildEnvelopeFor } from "../engine/perception/registry.js";
import { runActionGuard, isAutoGuardEnabled, validateAndPrepareFix, consumeFix, assertKeyboardDestination, noteDestinationMissing, keyboardDestinationMiss } from "./_action-guard.js";
import { logResolve, logDispatchSink } from "./_resolve-log.js";
import type { ResolvedDestination } from "./_action-guard.js";

/**
 * ADR-038: package what the resolver settled on for the destination predicate.
 * `isForeground` is a closure so the syscall runs only for a titleless window.
 * `getForegroundHwnd` is used rather than `enumWindowsInZOrder().find(isActive)`
 * because that enumeration SKIPS untitled windows (`win32.ts:161`) — the exact
 * windows this predicate is about — so the enumeration form would report `false`
 * for every one of them.
 */
function toResolvedDestination(
  resolved: { hwnd: bigint; title: string } | null,
): ResolvedDestination | undefined {
  if (!resolved) return undefined;
  return {
    hwnd: resolved.hwnd,
    title: resolved.title,
    isForeground: () => getForegroundHwnd() === resolved.hwnd,
  };
}
import { resolveWindowTarget } from "./_resolve-window.js";
import {
  makeCommitWrapper,
  withEnvelopeIncludeForUnion,
  flattenUnionToObjectSchema,
  parseActionArgsOrFail,
} from "./_envelope.js";

const execFileAsync = promisify(execFile);

// Note: keyboard input serialization (issue #255) lives at the engine layer
// in `src/engine/nutjs.ts` so it applies to every caller — the keyboard
// tool here, scroll PageDown / PageUp keystrokes, terminal:send fallback,
// and any future tool that reaches into the same libnut backend. See the
// design rationale block at the top of nutjs.ts.

// ─────────────────────────────────────────────────────────────────────────────
// typeViaClipboard — put text on the clipboard, paste it, put the clipboard back
//
// ADR-033 PR-2. This used to spawn THREE `powershell.exe` processes per call
// (save / write+verify / restore), and the middle one carried a base64 blob
// decoded inline by PowerShell — the command-line shape Microsoft Defender
// scored as `Trojan:Win32/Commando.A!ml` before killing the server mid-session.
// It is also the hottest clipboard path here: every non-ASCII `keyboard:type`
// is promoted to it automatically, and `terminal(action='send')` defaults to it.
//
// The native path does the whole transaction in-process (`win32TypeViaClipboard`
// — see `src/win32/type_via_clipboard.rs`). The PowerShell path is RETAINED for
// builds without the compiled addon, because there is no other channel that can
// deliver non-ASCII text to a foreground window.
// ─────────────────────────────────────────────────────────────────────────────

/** How long to wait between the paste chord and restoring the clipboard.
 *
 *  Mirrors `type_via_clipboard.rs::PASTE_SETTLE_MS` — the two backends must not
 *  give the target application different amounts of time to READ the clipboard
 *  before it is taken away again. `tests/unit/type-via-clipboard-settle.test.ts`
 *  pins them equal, and pins both apart from `foreground_flash`'s 30ms, which
 *  answers a different question (when is it safe to send the NEXT keystroke). */
export const PASTE_SETTLE_MS = 120;

/**
 * How long the addon is allowed for everything it does AFTER the paste chord,
 * excluding the settle: the restore, and its share of clipboard lock
 * contention.
 *
 * 300ms, of which only the first ~100ms is arithmetic. The restore is ONE
 * clipboard transaction and `open_clipboard_with_retry` absorbs up to 10x10ms
 * per transaction (I-12), so ~100ms is the bounded worst case for getting the
 * lock.
 *
 * The remaining ~200ms is headroom for the write itself — the snapshot is
 * replayed format by format (`GlobalAlloc` + memcpy + `SetClipboardData`, once
 * per saved format), and **that has not been measured**. A clipboard populated
 * by Word or Excel can carry 10-20 formats, so the cost is not obviously
 * negligible; 200ms is a guess with room in it, not a derived number.
 *
 * Being wrong about it degrades rather than breaks: the chord has ALREADY been
 * sent by the time this budget is being spent, so the input is delivered either
 * way. Overrunning only means the JS timeout fires first and the caller is told
 * the clipboard state is indeterminate — which is true, and disclosed.
 *
 * @internal exported for the budget pin.
 */
export const POST_CHORD_BUDGET_MS = 300;

/**
 * The deadline handed to the addon: after this long, it must not send the paste
 * chord at all.
 *
 * This is the half of the timeout story `AbortSignal` cannot cover. Aborting
 * cancels a task that is still QUEUED; a task already inside `GetClipboardData`
 * against a hung clipboard owner runs to completion however long that takes. So
 * without this, a call that failed at 5s could reach its `SendInput` minutes
 * later and type into whatever window happens to have focus — in an application
 * the caller never named, at a moment nobody expects. The failure mode is
 * silent, arbitrary and destructive.
 *
 * The value answers "how late may the chord go out and still leave time for the
 * work that follows it to finish before the caller gives up":
 *
 *     timeout − settle − everything after the chord
 *
 * so a chord sent exactly at the deadline is still followed by a settle and a
 * restore that complete inside `CLIPBOARD_WRITE_TIMEOUT_MS`. Past it, nothing is
 * typed and the addon reports `paste_deadline_exceeded` — the restore still
 * runs, because the addon's 3-point race check is what makes a late restore
 * safe (if the user has copied anything since, the sequence number moved and it
 * skips itself).
 *
 * @internal exported for the budget pin, which is what keeps the three
 *           constants in step: change the timeout and the derived value moves
 *           with it.
 */
export const PASTE_DEADLINE_BUDGET_MS =
  CLIPBOARD_WRITE_TIMEOUT_MS - PASTE_SETTLE_MS - POST_CHORD_BUDGET_MS;

/** Which implementation served the call. Surfaced in the envelope so a
 *  Defender-related regression is diagnosable from the response. */
export type TypeViaClipboardBackend = "native" | "powershell";

/**
 * What `typeViaClipboard` has to tell its callers.
 *
 * It used to return `Promise<void>`, which left no way to say that the user's
 * clipboard was NOT put back — and that happens for reasons the caller cannot
 * infer: another process wrote to the clipboard first (`restoreSkippedRace`),
 * the saved content is too large for the fallback's command line
 * (`restoreSkippedTooLarge`), the save never succeeded (`restoreUnavailable`),
 * or the clipboard held formats a text-only snapshot cannot carry
 * (`skippedFormats`, e.g. an image). Silently keeping the user's clipboard is a
 * side effect they did not ask for, so every way it can happen is disclosed.
 *
 * The optional flags are present only when true, so `hints.clipboard` stays
 * empty of noise on the ordinary path.
 */
export interface TypeViaClipboardOutcome {
  backend: TypeViaClipboardBackend;
  /**
   * The call never changed the user's clipboard, so there was nothing to put
   * back. Present only when true.
   *
   * It failed before `EmptyClipboard` succeeded — the hidden owner window could
   * not be created, one of the clipboard opens lost its retries, or the payload
   * allocation failed. `clipboardRestored:false` alone reads as the alarming
   * half ("we replaced your clipboard and kept it"), which for these failures is
   * the opposite of what happened. Native only: the fallback's failure modes are
   * spawn-level and already disclosed through `restoreUnavailable`.
   */
  untouched?: boolean;
  /** Whether the user's clipboard was put back. Meaningless when `untouched`. */
  clipboardRestored: boolean;
  /** Restore was skipped because someone else wrote to the clipboard after we
   *  did. NOT a failure: overwriting their value would be worse. */
  restoreSkippedRace?: boolean;
  /** Fallback only: the saved content is past what a PowerShell command line
   *  can carry, so it was not written back. The input still went through — see
   *  the `powershellTypeViaClipboard` note on why the paste wins that tie. */
  restoreSkippedTooLarge?: boolean;
  /** The save itself failed, so there was never anything to put back. */
  restoreUnavailable?: boolean;
  /**
   * The restore was ATTEMPTED and failed.
   *
   * A separate fact from every flag above, and the one that needs acting on:
   * the others all leave the clipboard holding something valid (someone else's
   * value, or ours), whereas a restore that fails partway can leave it EMPTY —
   * `EmptyClipboard` has already run by the time an allocation can fail. Folded
   * into a bare `restored:false` it would be indistinguishable from the
   * deliberate skips, which are not problems at all.
   */
  restoreFailedReason?: string;
  /**
   * The paste went out backed only by the in-session read-back: the addon's
   * second, post-close read — the one that can catch a clipboard manager or DLP
   * agent replacing the payload after the lock is released — could not run,
   * because re-opening the clipboard lost a race.
   *
   * Not a failure and not a reason to retry: the first read-back already proved
   * the payload was stored, and refusing to paste here would make typing a
   * silent no-op whenever another application merely READS the clipboard, which
   * is normal and frequent. It is disclosed because the composite sends the
   * keystroke itself, so "we pasted something we could not fully verify" is a
   * fact the caller cannot otherwise observe.
   *
   * Native only. The fallback's single `Get-Clipboard -Raw` runs after
   * `Set-Clipboard` released the lock, so it IS the post-close read and is
   * always checked.
   */
  postCloseUnverified?: boolean;
  /** Formats the snapshot could not carry, so they are gone even though the
   *  restore ran (native only — the fallback is text-only throughout). */
  skippedFormats?: Array<{ formatId: number; reason: string }>;
}

/**
 * A `typeViaClipboard` failure that still has something to say about the user's
 * clipboard.
 *
 * When the paste fails, the clipboard has usually already been replaced with
 * the payload — and whether it was put back afterwards is a fact only this call
 * knows. Thrown as a bare `Error`, all of it was lost at the catch site, so a
 * caller was told "the paste failed" while their clipboard silently held our
 * text (or nothing at all, after a failed restore). The failure paths that
 * reach here — a missed paste deadline, a refused chord, a verification
 * mismatch — are exactly the ones where the transaction ran far enough to touch
 * the clipboard.
 *
 * **The message is the classification.** `_errors.ts::classify` routes on the
 * message text, so every string thrown below is the one that shipped:
 * `ClipboardWriteNotDelivered` stays a compact code, and the lower-case ones
 * stay generic. This class only adds a payload alongside it — changing a word
 * of any message would silently re-route the error.
 */
export class TypeViaClipboardDeliveryError extends Error {
  constructor(
    message: string,
    /** Same shape as the success path's `hints.clipboard`, so a caller reads
     *  the side effect the same way whether the call worked or not. */
    readonly clipboard: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TypeViaClipboardDeliveryError";
  }
}

/** The native composite: one in-process transaction, no child process. */
async function nativeTypeViaClipboard(
  text: string,
  pasteCombo: "ctrl+v" | "ctrl+shift+v",
): Promise<TypeViaClipboardOutcome> {
  // UTF-16LE bytes rather than a JS string: napi's String bridge transcodes
  // through UTF-8, which cannot represent an unpaired surrogate, so it would
  // replace one with U+FFFD *before* the addon's byte comparison ran — and the
  // verification would then pass on mutated text.
  const payload = Buffer.from(text, "utf16le");
  // This `withTimeout` runs INSIDE the engine's keyboard input lock — see the
  // nesting note in `typeViaClipboard` below. The budget starts when the addon
  // is called, not when the caller asked, so time spent queued behind another
  // keyboard operation does not eat into it and cannot expire before the work
  // begins.
  const r = await withTimeout(
    (signal) =>
      nativeWin32!.win32TypeViaClipboard!(
        payload,
        pasteCombo,
        PASTE_DEADLINE_BUDGET_MS,
        signal,
      ),
    CLIPBOARD_WRITE_TIMEOUT_MS,
    // "gave up" rather than "timed out": `_errors.ts::classify` has a generic
    // timeout arm that would answer this with "the app may be unresponsive,
    // wait and retry", which is the opposite of the truth here. The state note
    // is not decoration — giving up abandons the RESULT, not the work (see the
    // addon's module doc), so the paste may still land afterwards and the
    // clipboard may still be holding the payload.
    `native clipboard paste gave up after ${CLIPBOARD_WRITE_TIMEOUT_MS}ms waiting for the clipboard owner; the paste and the clipboard contents are indeterminate after this — the keystroke may still arrive and the clipboard may not have been restored`,
  );

  if (!r.ok) {
    // Every one of these ran far enough to replace the user's clipboard, so
    // they all carry what became of it — built from the SAME outcome a success
    // would have returned, so `context.clipboard` on a failure and
    // `hints.clipboard` on a success are the same shape, read the same way.
    const clipboard = clipboardPasteHints(nativeOutcome(r));

    // Lower-case messages on purpose, here and below: an Error whose whole
    // message is one PascalCase token is this repo's compact-code producer
    // shape and would need its own SUGGESTS entry (swept by
    // oq8-failwith-suggest-routing.test.ts). Neither of these failures has a
    // recovery distinct from the generic one. `classify` routes on the message
    // text, so these strings are a contract — the error CLASS carries the new
    // payload precisely so the messages did not have to change.
    if (r.reason === "paste_deadline_exceeded") {
      // The clipboard work outlasted the budget, so the addon refused to send
      // the chord. Stated as "nothing was typed" because that is the part a
      // caller acts on: this is the one failure here that is safe to retry
      // blind, and reporting it as a delivery failure would suggest the
      // opposite.
      throw new TypeViaClipboardDeliveryError(
        "clipboard paste ran past its deadline before the keystroke could be sent, so nothing was typed",
        clipboard,
      );
    }
    if (r.reason === "send_input_partial") {
      // The OS accepted a PREFIX of the chord and that prefix reached the V
      // key-down: the target may have pasted even though the batch failed
      // (the addon kept the settle before restoring for exactly this case).
      // The one thing this message must not say is "nothing happened" — a
      // blind retry here can double-paste, which is the mistake the addon's
      // maybe-fired tracking exists to prevent. Same reasoning as the
      // timeout's "indeterminate" wording above.
      throw new TypeViaClipboardDeliveryError(
        "clipboard paste keystroke batch was only partially accepted by the OS, and the accepted part may already have pasted (send_input_partial) — verify the target's content before retrying",
        clipboard,
      );
    }
    if (r.verify.ok) {
      // The payload IS on the clipboard; `SendInput` refused the chord
      // outright — the batch never reached the V key-down, so nothing pasted.
      // Calling that a delivery failure would send the caller after a
      // clipboard problem that does not exist.
      throw new TypeViaClipboardDeliveryError(
        `clipboard paste keystroke was not accepted by the OS (${r.reason ?? "unknown"})`,
        clipboard,
      );
    }
    // Same typed error the PowerShell path throws, and the same one
    // `clipboard(action='write')` returns — one verification contract, one code.
    // Do NOT put the read-back text in the message: on a mismatch it belongs to
    // another process and may be a password or an API key (I-2).
    throw new TypeViaClipboardDeliveryError("ClipboardWriteNotDelivered", clipboard);
  }

  return nativeOutcome(r);
}

/** What the addon reported, in the shape the callers publish. Shared by the
 *  success return and by every failure that has to disclose the same facts. */
function nativeOutcome(r: NativeTypeViaClipboardResult): TypeViaClipboardOutcome {
  return {
    backend: "native",
    // Said first because it changes how everything below it reads: with nothing
    // modified, `restored:false` means "there was nothing to put back".
    ...(r.clipboardModified ? {} : { untouched: true }),
    clipboardRestored: r.clipboardRestored,
    ...(r.restoreSkippedRace ? { restoreSkippedRace: true } : {}),
    // A restore that FAILED is not a restore that was skipped. The addon
    // reports the two separately because they end in different states — a
    // skip leaves another process's value in place, a failure can leave the
    // clipboard empty — so collapsing both into `restored:false` here would
    // throw away the only signal that says which one happened.
    ...(r.restoreFailedReason ? { restoreFailedReason: r.restoreFailedReason } : {}),
    // The chord went out on the strength of the in-session read alone: the
    // post-close re-read never ran, so a clipboard manager or DLP agent
    // swapping the payload in that window would not have been caught. Pasting
    // anyway is the deliberate choice (requiring the second read would make
    // typing a silent no-op whenever something else merely READS the clipboard
    // — normal, frequent behaviour), but it is weaker evidence than usual and
    // the caller is told so. Only when a chord actually went out: with nothing
    // typed there is no unverified paste to disclose.
    ...(r.pasted && !r.verify.postCloseChecked ? { postCloseUnverified: true } : {}),
    ...(r.skippedFormats && r.skippedFormats.length > 0
      ? { skippedFormats: r.skippedFormats }
      : {}),
  };
}

/**
 * The addon-less path: three `powershell.exe` spawns, kept working.
 *
 * Three fixes over what shipped before ADR-033 PR-2:
 *
 * 1. the save used `Get-Clipboard` without `-Raw` and read the child's raw
 *    stdout, so a multi-line clipboard came back as an array joined by the
 *    console's line endings and a trailing newline was invented. It now goes
 *    through the same base64 round trip `clipboard(action='read')` uses, which
 *    is byte-exact and codepage-proof;
 * 2. the restore was unconditional, so a clipboard manager (or the user) that
 *    copied something during the 120ms settle had it silently overwritten with
 *    the pre-call content. The restore now runs only if the clipboard still
 *    holds what we pasted. That check is a SHA-256 comparison inside the same
 *    invocation rather than a sequence number — PowerShell cannot see
 *    `GetClipboardSequenceNumber`, so this is an approximation of the native
 *    path's 3-point race check: it cannot notice a writer that put back
 *    byte-identical text, which is exactly the case where overwriting is
 *    harmless anyway;
 * 3. an over-long payload used to reach `spawn` and fail with a raw
 *    `ENAMETOOLONG` hundreds of milliseconds later. It is now rejected up front
 *    with the same named failure `clipboard(action='write')` uses.
 */
async function powershellTypeViaClipboard(
  text: string,
  pasteCombo: "ctrl+v" | "ctrl+shift+v",
): Promise<TypeViaClipboardOutcome> {
  // (3) The payload has to fit in a command line. Fail before doing anything
  // rather than after emptying the user's clipboard.
  if (text.length > FALLBACK_MAX_CHARS) {
    throw new Error("ClipboardWriteTooLargeForFallback");
  }

  // (1) Save. `null` = the save failed, so there is nothing to put back.
  // `""` is a REAL state (an empty or non-text clipboard), not a failure.
  let savedClipboard: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [...POWERSHELL_ARGS, CLIPBOARD_SAVE_SCRIPT],
      { timeout: 3000 },
    );
    const savedB64 = stdout.trim();
    savedClipboard = savedB64 ? Buffer.from(savedB64, "base64").toString("utf16le") : "";
  } catch {
    // The clipboard may be locked by another application — proceed without
    // saving rather than refusing to type. Disclosed as `restoreUnavailable`.
  }

  // Phase 5 E1 (epic #211): combine Set-Clipboard + Get-Clipboard -Raw inside
  // a single PowerShell invocation and compare base64-encoded UTF-16LE bytes
  // for byte-equality. Without this verification a DLP agent or clipboard
  // manager intercepting Set-Clipboard would leave stale contents on the
  // clipboard and the paste below would inject the WRONG TEXT into the target
  // window — a silent failure with no signal anywhere.
  const script = buildFallbackWriteScript(Buffer.from(text, "utf16le").toString("base64"));
  const { stdout } = await execFileAsync("powershell.exe", [...POWERSHELL_ARGS, script], {
    timeout: CLIPBOARD_WRITE_TIMEOUT_MS,
  });

  // Byte-equal compare (UTF-16LE, the native Windows clipboard format).
  // Buffer.equals avoids any normalization (NFC/NFD), BOM, or trailing-newline
  // coercion that a string comparison could introduce. Throwing a bare
  // PascalCase token routes it to code:'ClipboardWriteNotDelivered' via
  // `_errors.ts::classify`. Do NOT include the actual clipboard contents — a
  // racing app may have placed sensitive data there (I-2).
  const expectedBytes = Buffer.from(text, "utf16le");
  const readBackB64 = stdout.trim();
  const actualBytes = readBackB64 ? Buffer.from(readBackB64, "base64") : Buffer.alloc(0);
  if (!expectedBytes.equals(actualBytes)) {
    // `restored: false`, and that is the honest answer rather than a
    // placeholder: this throw happens BEFORE the restore below, so the user's
    // clipboard is left holding whatever the failed write put there. The native
    // path restores first and reports `restored: true` here — the backend
    // divergence documented on `typeViaClipboard`, now visible in the response
    // instead of only in a comment.
    throw new TypeViaClipboardDeliveryError("ClipboardWriteNotDelivered", {
      backend: "powershell",
      restored: false,
    });
  }

  const combo = parseKeys(pasteCombo);
  await keyboard.pressKey(...combo);
  await keyboard.releaseKey(...combo);

  // Let the target read the clipboard before it is taken away again.
  await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS));

  if (savedClipboard === null) {
    return { backend: "powershell", clipboardRestored: false, restoreUnavailable: true };
  }
  // The saved content has to travel back through a command line too. When it
  // does not fit, the INPUT still stands and only the restore is dropped:
  // `terminal(action='send')` defaults to this path, non-ASCII text is promoted
  // to it automatically, and with an IME open it is the only channel that
  // delivers the text at all — so failing the whole call to protect a courtesy
  // (putting the clipboard back) would strand the caller with no way through.
  // The user's clipboard content is normally re-obtainable from wherever it was
  // copied; a refused keystroke is not. Disclosed, never silent.
  if (savedClipboard.length > FALLBACK_MAX_CHARS) {
    return { backend: "powershell", clipboardRestored: false, restoreSkippedTooLarge: true };
  }

  // (2) Restore only if the clipboard still holds what we pasted.
  try {
    const restoreScript = buildFallbackRestoreScript(
      Buffer.from(savedClipboard, "utf16le").toString("base64"),
      createHash("sha256").update(expectedBytes).digest("hex"),
    );
    const { stdout: restoreOut } = await execFileAsync(
      "powershell.exe",
      [...POWERSHELL_ARGS, restoreScript],
      { timeout: 3000 },
    );
    const verdict = restoreOut.trim();
    if (verdict === "skipped_race") {
      return { backend: "powershell", clipboardRestored: false, restoreSkippedRace: true };
    }
    if (verdict === "restored") {
      return { backend: "powershell", clipboardRestored: true };
    }
    // Anything else is a restore that did NOT happen, and the script says so
    // rather than being inferred from an exit status that stays 0 either way.
    // The reachable case is a saved clipboard of "" — `Set-Clipboard -Value ''`
    // is rejected — which leaves the call ending with our payload still on the
    // clipboard. Reported the same way the native path reports a failed
    // restore, so the two backends are read the same way.
    return {
      backend: "powershell",
      clipboardRestored: false,
      restoreFailedReason: "set_clipboard_failed",
    };
  } catch {
    // The invocation itself failed (spawn error, timeout kill). Restore is
    // best-effort — this must not fail an input that has already been
    // delivered — but it is still a failure rather than a deliberate skip.
    return {
      backend: "powershell",
      clipboardRestored: false,
      restoreFailedReason: "restore_command_failed",
    };
  }
}

/** The save half of the fallback, identical to `clipboard(action='read')`'s
 *  script: `-Raw` keeps line breaks intact and base64 keeps the bytes exact
 *  across the console's codepage. */
const CLIPBOARD_SAVE_SCRIPT =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
  "$t=Get-Clipboard -Raw;" +
  "if($t -eq $null){Write-Output ''}else{" +
  "[Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($t))" +
  "}";

/** The fixed `powershell.exe` arguments every fallback invocation uses.
 *
 *  @internal Exported so the command-line budget test measures the real prefix
 *  rather than a copy of it — adding a flag here shrinks the payload budget,
 *  and that has to show up in the test that guards it.
 */
export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command"] as const;

/**
 * Write + verify, in one invocation: decode the payload, `Set-Clipboard`, then
 * read it straight back so a DLP agent or clipboard manager that intercepted
 * the write is caught before anything is pasted.
 *
 * @param payloadB64 base64 of the payload's UTF-16LE bytes.
 * @internal Pure and exported for the command-line budget test — this string
 *           becomes a Windows command line, which has a hard 32 767-character
 *           ceiling that `FALLBACK_MAX_CHARS` exists to stay under.
 */
export function buildFallbackWriteScript(payloadB64: string): string {
  return (
    `$b=[System.Convert]::FromBase64String('${payloadB64}');` +
    `$t=[System.Text.Encoding]::Unicode.GetString($b);` +
    `Set-Clipboard -Value $t;` +
    `$r=Get-Clipboard -Raw;` +
    `if($r -eq $null){Write-Output ''}else{` +
    `[Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($r))` +
    `}`
  );
}

/**
 * Restore, guarded by a race check in the same invocation: compare what is on
 * the clipboard now against the hash of what we pasted, and put the saved
 * content back only if they still match.
 *
 * The comparison travels as a 64-character hash rather than a second copy of
 * the payload because both blobs together would not fit in a command line.
 *
 * @param savedB64        base64 of the saved clipboard's UTF-16LE bytes.
 * @param pastedSha256Hex lower-case hex SHA-256 of the pasted payload's
 *                        UTF-16LE bytes.
 * @internal Pure and exported for the command-line budget test. This is the
 *           LONGER of the two scripts, so it is the one that decides how large
 *           `FALLBACK_MAX_CHARS` may be.
 */
export function buildFallbackRestoreScript(savedB64: string, pastedSha256Hex: string): string {
  return (
    `$c=Get-Clipboard -Raw;$h='';` +
    `if($c -ne $null){$h=[BitConverter]::ToString(` +
    `[Security.Cryptography.SHA256]::Create().ComputeHash(` +
    `[Text.Encoding]::Unicode.GetBytes($c))).Replace('-','').ToLower()}` +
    `if($h -ne '${pastedSha256Hex}'){Write-Output 'skipped_race'}else{` +
    // `try` + `-ErrorAction Stop` are load-bearing, not defensive habit. A
    // non-terminating `Set-Clipboard` error does not stop the enclosing block
    // and does not change the exit status, so without them the script walks
    // straight on to `Write-Output 'restored'` and reports a restore that never
    // happened. The reachable case is a saved clipboard of "": `Set-Clipboard
    // -Value ''` is rejected outright (an empty string fails the parameter's
    // validation), and that rejection used to surface as success.
    `try{Set-Clipboard -Value ([Text.Encoding]::Unicode.GetString(` +
    `[Convert]::FromBase64String('${savedB64}'))) -ErrorAction Stop;` +
    `Write-Output 'restored'}catch{Write-Output 'restore_failed'}}`
  );
}

/**
 * Put `text` on the clipboard, paste it with `pasteCombo`, and put the user's
 * clipboard back.
 *
 * Pasting rather than typing is what preserves the exact Unicode bytes: the
 * keystroke channel cannot deliver text outside the active keyboard layout, and
 * an open IME would compose ASCII keystrokes into something else.
 *
 * **Throws** `ClipboardWriteNotDelivered` when the read-back verification fails
 * — in that case no paste chord is sent, so the target window is untouched —
 * and `ClipboardWriteTooLargeForFallback` when an addon-less build is handed
 * more text than a PowerShell command line can carry.
 *
 * **Backend divergence on that failure (I-33).** The native path attempts the
 * restore before it reports the failure, so a verification failure with no
 * other writer involved still gives the user their clipboard back. The
 * PowerShell path throws first and never reaches its restore, so the user is
 * left holding whatever the failed write put there. That is not fixed here on
 * purpose: the fallback's restore is gated on "the clipboard still holds what
 * we pasted", which after a verification failure is false by definition, so
 * running it would either be a no-op or would overwrite whatever the
 * interceptor wrote — the outcome I-6 exists to prevent. Closing the gap needs
 * the sequence-number machinery PowerShell cannot reach, which is precisely
 * what the addon is for.
 *
 * **Returns** what happened to the user's clipboard (`TypeViaClipboardOutcome`).
 * This used to be `Promise<void>`; callers must forward the result into their
 * envelope, because a skipped restore is a side effect the caller cannot
 * otherwise observe.
 *
 * What a successful return does NOT claim: that the target application received
 * the text. The chord is delivered to whatever has focus, and a pending IME
 * composition swallows it — see the tool description's IME caveat.
 */
export async function typeViaClipboard(
  text: string,
  pasteCombo: "ctrl+v" | "ctrl+shift+v" = "ctrl+v",
): Promise<TypeViaClipboardOutcome> {
  // ── Why the native call takes the keyboard input lock ──────────────────────
  //
  // The chord this replaces went out through `keyboard.pressKey/releaseKey`,
  // which are wrapped in the engine's input queue (`nutjs.ts`), so it was
  // serialised against every other keyboard caller. The addon sends its chord
  // from a libuv worker, outside that queue — so without this, a Ctrl+V could
  // splice into the middle of a `keyboard(action='sequence')` that is holding
  // Alt or Shift down inside `withKeyboardLock`. The result is a phantom
  // shortcut (Ctrl+Alt+V where neither party asked for Alt) or a paste into
  // whatever window the sequence had just navigated to. Exactly the class of
  // bug the queue was introduced for (issue #255 / #257), reintroduced through
  // a side door.
  //
  // The whole transaction is wrapped, not just the chord: the composite is
  // indivisible inside the addon by design (the save / verify / paste / restore
  // sequence has to hold together), so there is nothing finer to take the lock
  // around. This is safe with `withKeyboardLock`'s deadlock contract because
  // the native path calls no nut.js primitive at all — the contract only
  // forbids the WRAPPED `keyboard.*` inside the lock.
  //
  // The cost: against a hung clipboard owner this holds the keyboard queue for
  // up to the give-up budget (~5s) instead of the milliseconds the old chord
  // took. Accepted, because in that state the clipboard is unusable
  // system-wide, so every other input path that would have wanted the queue is
  // already blocked on the same thing — and the alternative is keystrokes
  // landing in the wrong window.
  //
  // **The give-up timeout lives INSIDE the lock, and the order is not
  // interchangeable.** `nativeTypeViaClipboard` starts its `withTimeout` after
  // this lock has been acquired, so all three clocks — the JS timeout, the
  // abort, and the addon's own paste deadline (captured in the napi factory,
  // i.e. also after the lock) — start from the same instant: the moment the
  // addon is actually called. Putting `withTimeout` OUTSIDE the lock would let
  // the JS timeout expire while the call is still QUEUED; the caller would be
  // told it failed, and then the queue would hand the turn over and the chord
  // would go out anyway — reopening, one layer up, exactly the hole the paste
  // deadline was added to close.
  //
  // Queue wait is therefore unbounded, and a caller can wait queue-time + the
  // give-up budget. That is the same semantics the old chord had: it queued on
  // this lock through `keyboard.pressKey` too.
  //
  // Asymmetric on purpose: the fallback is NOT wrapped here. Its chord already
  // goes through the wrapped `keyboard.pressKey`, which takes this same lock
  // itself — wrapping the transaction as well would deadlock on the shared
  // `_inputQueueTail` chain, which is the deadlock the `rawKeyboard` CONTRACT
  // in `nutjs.ts` describes. So: native = the whole transaction, fallback = the
  // chord only.
  return hasNativeTypeViaClipboard()
    ? withKeyboardLock(() => nativeTypeViaClipboard(text, pasteCombo))
    : powershellTypeViaClipboard(text, pasteCombo);
}

/**
 * The `hints.clipboard` block for a call that pasted — and, on a failure, the
 * `context.clipboard` block, built from the same outcome so both read alike.
 *
 * Shared by `keyboard(action='type')` and `terminal(action='send')` so the two
 * tools describe the same side effect with the same words. `backend` is always
 * present (it is what makes a Defender-related regression diagnosable from a
 * response instead of by guesswork) and so is `restored`, because "we put your
 * clipboard back" is only reassuring if its absence is equally visible. The
 * rest appear only when they happened.
 *
 * **What `restored:false` means, in one place.** Exactly one of these accompanies
 * it, and they are not interchangeable:
 *
 * - `untouched` — the call never changed the clipboard. Nothing to put back;
 *   the user's content is exactly where it was.
 * - `restoreSkippedRace` — someone else wrote to the clipboard after we did, so
 *   the restore stood down rather than clobber them (I-6). The user's older
 *   content is gone, replaced by whatever that writer put there.
 * - `restoreSkippedTooLarge` — fallback only: the saved content is past what a
 *   PowerShell command line can carry, so the clipboard still holds our payload.
 * - `restoreUnavailable` — the save itself failed, so there was never a snapshot
 *   to put back; the clipboard holds our payload.
 * - `restoreFailedReason` — the restore ran and failed. The worst case, and the
 *   only one that can leave the clipboard EMPTY: it empties before it writes.
 * - none of the above — the restore simply has not been reported as done; treat
 *   the clipboard as holding our payload.
 */
export function clipboardPasteHints(outcome: TypeViaClipboardOutcome): Record<string, unknown> {
  return {
    backend: outcome.backend,
    ...(outcome.untouched ? { untouched: true } : {}),
    restored: outcome.clipboardRestored,
    ...(outcome.restoreSkippedRace ? { restoreSkippedRace: true } : {}),
    ...(outcome.restoreSkippedTooLarge ? { restoreSkippedTooLarge: true } : {}),
    ...(outcome.restoreUnavailable ? { restoreUnavailable: true } : {}),
    // The one that is a problem rather than a decision: a restore that ran and
    // failed can leave the clipboard EMPTY, so it must not read as one of the
    // deliberate skips above.
    ...(outcome.restoreFailedReason
      ? { restoreFailedReason: outcome.restoreFailedReason }
      : {}),
    ...(outcome.postCloseUnverified ? { postCloseUnverified: true } : {}),
    ...(outcome.skippedFormats && outcome.skippedFormats.length > 0
      ? { skippedFormats: outcome.skippedFormats }
      : {}),
  };
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
  const tailFromNormEnd = (normEnd: number): string =>
    norm.slice(normEnd).replace(/^\n/, "");

  // Shared with terminal's marker relocation (`_since-marker.ts`): same
  // window/prefix scan, memoised per (norm, marker). keyboard calls this once
  // or twice per type() rather than per poll tick, but a large editor control
  // still saturates the 32k scan cap, so the shared memo helps repeat verifies
  // against an unchanged control too.
  const end = scanSinceMarkerNormEnd(norm, marker);
  if (end !== null) return { text: tailFromNormEnd(end), matched: true };
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
  /**
   * ADR-019 Stage 4 — `local_repaint` primitive observation. Attached
   * when Stage 4 SSIM cascade ran on the BG verify terminal `unverifiable
   * + read_back_unsupported` sink (sub-plan §2.4.2). Existing callers
   * that don't read `observation` are unaffected.
   */
  observation?: import("./_input-pipeline.js").VisualMotionObservation;
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
  "Required unless you pass hwnd: a call with neither stops with DestinationRequired before " +
  "any key is sent, and an empty or whitespace-only value counts as neither. " +
  "The server focuses this window before typing and uses it as the expected " +
  "target for focusLost detection. Use '@active' to target the current foreground window on purpose."
);

const hwndFocusParam = z.string().optional().describe(
  "Direct window handle ID (takes precedence over windowTitle). " +
  "Either this or windowTitle is required. " +
  "Obtain from desktop_discover response (windows[].hwnd). " +
  "String type to avoid 64-bit precision issues. " +
  "A window that has no title can be addressed this way, but only while it is already the " +
  "foreground window — keyboard focus and guarding cannot target a titleless window yet."
);

/** Non-ASCII punctuation that can be hijacked as Chrome/Edge keyboard accelerators */
const NON_ASCII_SYMBOL_RE = /[\u2013\u2014\u2018\u2019\u201C\u201D\u2026\u00A0]/;

/**
 * Non-ASCII character detection (ADR-018 \u00A72.4 D4 \u2014 Phase 2b).
 *
 * Any code point outside U+0000..U+007F. Covers CJK (Japanese / Korean / Chinese),
 * emoji and supplementary-plane code points (matched via the high surrogate range
 * in the `u` flag form), Latin diacritics (r\u00E9sum\u00E9), Greek, Cyrillic, Arabic,
 * Hebrew, IPA, math symbols \u2014 i.e. any text the Win32 keystroke channel
 * (`SendInput` with virtual-key codes) cannot deliver reliably across keyboard
 * layouts.
 *
 * When matched, the auto-clipboard upgrade routes through `typeViaClipboard`,
 * which preserves the exact Unicode bytes regardless of keyboard layout, and
 * whose payload is not run through IME conversion because it is pasted rather
 * than typed. That is NOT the same as being immune to the IME: with a
 * composition already pending, the paste chord is consumed by the IME and
 * nothing is inserted at all (measured, ADR-033 P2-0 Q3b — and identical to
 * what the nut.js path this replaced did, so it is a limit of the channel
 * rather than of the native implementation).
 * The `keystroke` path is still selected for pure ASCII text (fastest path).
 *
 * Wired into the auto-clipboard upgrade in ADR-018 Phase 2b-2 below.
 * The `isNonAscii()` public helper pins the contract bit-equally and is
 * also used by `tests/unit/keyboard-cjk.test.ts`.
 */
const NON_ASCII_RE = /[\u0080-\u{10FFFF}]/u;

/**
 * Public predicate for callers that need ADR-018 \u00A72.4 non-ASCII detection
 * without depending on the private regex literal. Phase 2b-2 wires this
 * into the auto-clipboard upgrade in `keyboardTypeHandler`.
 *
 * @internal \u2014 also used by `tests/unit/keyboard-cjk.test.ts` to pin the
 *             contract bit-equally against the regex declaration above.
 */
export function isNonAscii(text: string): boolean {
  return NON_ASCII_RE.test(text);
}

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
      "pasted text is not run through IME conversion. Note this does not help while an IME " +
      "composition is already in progress: the paste keystroke is consumed by the IME and " +
      "nothing is inserted, so commit or cancel the composition first. Your clipboard is " +
      "replaced for the duration of the call and put back afterwards; hints.clipboard reports " +
      "which backend served the paste and whether the restore ran. On builds without the native " +
      "addon this path is capped at about 12000 characters and fails with " +
      "code:'ClipboardWriteTooLargeForFallback' above it. Default false."
    ),
  replaceAll: coercedBoolean().optional().default(false).describe(
    "When true, send Ctrl+A to select all existing text before typing. " +
    "Equivalent to Ctrl+A → keyboard(action='type') in one call (requires field already focused). Default false."
  ),
  forceKeystrokes: coercedBoolean().optional().default(false).describe(
    "When true, always use keystroke mode even if text contains non-ASCII content " +
    "(CJK, emoji, diacritics, em-dash, smart quotes, etc.) that would normally trigger auto-clipboard. " +
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
  /**
   * Issue #257 Codex P2: when the caller resolved a specific HWND
   * (e.g. via `resolveWindowTarget` from an explicit `hwnd` arg), pin
   * matching to that handle so a duplicate-title sibling cannot win.
   * When undefined, fall back to the legacy title-substring match
   * (existing keyboardTypeHandler / keyboardPressHandler behaviour).
   */
  explicitHwnd?: bigint,
): Promise<FocusForKeyboardResult> {
  const warnings: string[] = [];
  const homingNotes: string[] = [];
  let foregroundVerified = false;
  let forceRefused = false;
  let targetHwnd: bigint | null = null;
  const needle = windowTitle.toLowerCase();
  // Match by hwnd when supplied, else fall back to title-substring.
  const matches = (w: { title: string; hwnd: bigint }): boolean =>
    explicitHwnd !== undefined
      ? w.hwnd === explicitHwnd
      : w.title.toLowerCase().includes(needle);
  try {
    const windows = enumWindowsInZOrder();
    const active = windows.find((w) => w.isActive);
    // ADR-035 §2 #3 — observation only. This resolver's tie-break is
    // "the active window if it matches, else the frontmost match", which is
    // NOT the SSOT's pure Z-order rule; recording the full match list plus the
    // window actually chosen is what makes that divergence measurable.
    const titleMatches = windows.filter(matches);
    logResolve({
      resolver: "focusWindowForKeyboard",
      query: windowTitle,
      matches: titleMatches,
      chosen: active && matches(active) ? active : (titleMatches[0] ?? null),
      identity: "lookup",
    });
    if (active && matches(active)) {
      // Target is already in the foreground — nothing to do.
      foregroundVerified = true;
      targetHwnd = active.hwnd;
    } else {
      const target = windows.find(matches);
      if (target) {
        // Always verify foreground after focus so the auto-guard does not block
        // on a stale/foreground-steal-prevented SetForegroundWindow. If the first
        // attempt (honoring caller's `force` flag) fails to transfer the foreground,
        // auto-escalate to force=true so windowTitle+auto-guard remains a reliable
        // contract (the caller already expressed intent by passing windowTitle).
        restoreAndFocusWindow(target.hwnd, { force });
        await new Promise<void>((r) => setTimeout(r, 100));
        let after = enumWindowsInZOrder().find((w) => w.isActive);
        let reachedForeground = !!after && matches(after);

        if (!reachedForeground && !force) {
          // Auto-escalate to force focus (AttachThreadInput bypass) — the caller
          // asked us to type into this window, so bringing it to the foreground
          // is required for the keystrokes to reach the right target.
          restoreAndFocusWindow(target.hwnd, { force: true });
          await new Promise<void>((r) => setTimeout(r, 100));
          after = enumWindowsInZOrder().find((w) => w.isActive);
          reachedForeground = !!after && matches(after);
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
  // Declared OUTSIDE the try so the catch can still see it. Once the paste has
  // happened the text is IN the target, and a later throw — `detectFocusLoss`
  // reaching UIA, say — must not hide that: a caller told only
  // "keyboard:type failed" retries, and the text lands twice.
  let clipboardOutcome: TypeViaClipboardOutcome | undefined;
  try {
    // Phase G: fixId approval prologue
    let effectiveText = text;
    // ADR-038: validate the fix and adopt its args here, but do NOT burn it yet
    // — `consumeFix` moved below the destination check so a refused call does
    // not spend the one-shot approval it never got to use.
    let effectiveWindowTitle = windowTitle;
    if (fixId) {
      const vr = validateAndPrepareFix(fixId, "keyboard");
      if (!vr.ok || !vr.fix) return failWith(new Error(vr.errorCode!), "keyboard");
      if (typeof vr.fix.args.windowTitle === "string") effectiveWindowTitle = vr.fix.args.windowTitle;
      if (typeof vr.fix.args.text === "string") effectiveText = vr.fix.args.text;
    }

    // Resolve hwnd / @active → effective window title (only when not using a fixId)
    const resolvedWin = !fixId ? await resolveWindowTarget({ hwnd, windowTitle: effectiveWindowTitle }) : null;
    if (resolvedWin) effectiveWindowTitle = resolvedWin.title;

    const resolvedDestination = toResolvedDestination(resolvedWin);
    const warnings: string[] = [...(resolvedWin?.warnings ?? [])];
    const homingNotes: string[] = [];
    let foregroundVerified = false;

    // ADR-038: the one-shot fix is spent only once the call is actually going
    // ahead — never on a path that refuses, or the retry the error asks for
    // would come back FixAlreadyConsumed.
    const spendFix = (): void => { if (fixId) consumeFix(fixId); };

    // ── ADR-038: destination required ─────────────────────────────────────
    // Runs once, BEFORE the method split and before either guard branch, so a
    // destination-less write cannot slip through the lensId arm (which never
    // reaches runActionGuard). `foreground_flash` is exempt: it already
    // refuses with its own `ForegroundFlashRequiresTarget` a few lines below
    // and that public code must not change.
    if (inputMethod !== "foreground_flash") {
      const destCheck = assertKeyboardDestination({
        toolName: "keyboard:type",
        effectiveWindowTitle,
        hwnd,
        resolved: resolvedDestination,
        lensId,
        warnings,
      });
      if (!destCheck.ok) return destCheck.errorResult;
      // Non-flash path: the call is going ahead from here.
      spendFix();
    }

    // ── ADR-013 Option E: foreground_flash 明示 opt-in path ────────────────
    // method:'foreground_flash' は `background` 契約とは分離した妥協 BG path
    // (Clipboard + foreground flash + paste + restore)。WT 等 WM_CHAR 不対応
    // window 用、single-line + < 5KiB 制約、typing leak risk hints あり。
    if (inputMethod === "foreground_flash") {
      if (!effectiveWindowTitle) {
        // ADR-038 Phase 0: count this refusal, but ONLY when it really is
        // destination-less. `foreground_flash` needs a TITLE specifically, so
        // it also refuses calls that DO have a destination by this ADR's rule
        // (an hwnd resolving to a titleless foreground window). Counting those
        // would inflate the sample with calls the ADR does not consider
        // destination-less at all (Opus review R2). Same predicate, one place.
        const { miss } = keyboardDestinationMiss({ effectiveWindowTitle, resolved: resolvedDestination });
        if (miss !== null) {
          noteDestinationMissing("keyboard:type", {
            hasLens: lensId !== undefined,
            hadHwndParam: hwnd !== undefined,
            reason: miss,
            decision: "block",
          });
        }
        return failWith(
          new Error("ForegroundFlashRequiresTarget"),
          "keyboard:type"
        );
      }
      const wins = enumWindowsInZOrder();
      const ffMatches = wins.filter((w) =>
        w.title.toLowerCase().includes(effectiveWindowTitle!.toLowerCase())
      );
      const target = ffMatches[0];
      logResolve({
        resolver: "keyboardForegroundFlash",
        query: effectiveWindowTitle!,
        matches: ffMatches,
        identity: "lookup",
      });
      if (!target) {
        return failWith(
          new Error("WindowNotFound"),
          "keyboard:type",
          { windowTitle: effectiveWindowTitle }
        );
      }
      // Past both flash refusals — the call is going ahead (ADR-038 P3).
      spendFix();
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
            reason: channel.reason,
            windowTitle: effectiveWindowTitle,
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
        logDispatchSink({ sink: "wm_char", tool: "keyboard:type", targetHwnd: target.hwnd });
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
              sent: r.sent,
              total: effectiveText.length,
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
          { kind: channel.kind, windowTitle: effectiveWindowTitle }
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
      // ADR-035 Phase 1 — the foreground-flash channel is the route under
      // investigation: it steals the foreground to paste and puts it back, so
      // it is exactly where a mis-resolved destination becomes a write into the
      // operator's own window (Codex Round 1 P2). `fgHwnd` here is the window
      // that held focus BEFORE the steal.
      logDispatchSink({ sink: "foreground_flash", tool: "keyboard:type", targetHwnd: channel.hwnd });
      const flashResult = injectViaForegroundFlash(
        channel.hwnd,
        channel.pid,
        effectiveText,
        { pressEnter: false }, // keyboard:type は Enter 自動押下しない
      );
      if (!flashResult.ok) {
        // Flat context (`failWith` auto-wraps non-hoisted keys into
        // `context` — see `ROOT_HOISTED_KEYS` + the splitter at
        // `src/tools/_errors.ts:685-693`). LLM-facing shape is
        // `r.context.reason`, not `r.context.context.reason`. E2E tests
        // `tests/e2e/foreground-flash-verification.test.ts` pin
        // `r.context.reason` directly.
        //
        // OQ8 follow-up: prefix the code so classify() routes this to
        // `ForegroundFlashFailed` (root suggest from SUGGESTS) instead of the
        // adviceless generic `ToolError` a bare snake_case reason produced.
        // The reason stays in the message tail AND in context.reason, with the
        // same `?? "unknown"` fallback on both so an undefined key can never be
        // dropped from the JSON while the advice promises to name the step
        // (Round 3 P3-10). `injectViaForegroundFlash` does always set `reason`
        // on failure, so this is the optional-field belt rather than a live
        // branch — and when the native error is not a known reason, `reason`
        // carries its raw message, which is why the advice also points at
        // `context.rawError` (Round 4 P3-6).
        return failWith(
          new Error(`ForegroundFlashFailed: ${flashResult.reason ?? "unknown"}`),
          "keyboard:type",
          {
            reason: flashResult.reason ?? "unknown",
            rawError: flashResult.rawError,
            windowTitle: effectiveWindowTitle,
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
      const bgMatches = wins.filter(w => w.title.toLowerCase().includes(effectiveWindowTitle!.toLowerCase()));
      const target = bgMatches[0];
      logResolve({
        resolver: "keyboardBackgroundType",
        query: effectiveWindowTitle!,
        matches: bgMatches,
        identity: "lookup",
      });
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
          // ADR-019 Stage 4 — capture pre-action reference frame BEFORE the
          // WM_CHAR loop (sub-plan §2.4.2 + OQ #5 option (a)). Gated on
          // verification being needed AND env opt-in
          // (`DESKTOP_TOUCH_STAGE4_SSIM_KEYBOARD=0` disables) so the
          // capture cost only lands on callers asking for verification.
          // Resolved via `getWindowRectByHwnd(target.hwnd)`; null means
          // Stage 4 cannot fire (resolver still returns indeterminate later).
          const stage4KeyboardEnabled =
            verificationNeeded &&
            process.env.DESKTOP_TOUCH_STAGE4_SSIM_KEYBOARD !== "0";
          const stage4WindowRect =
            stage4KeyboardEnabled ? getWindowRectByHwnd(target.hwnd) : null;
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

          // Stage 4 pre-frame: capture AFTER the optional Ctrl+A replace-all
          // so the SSIM residual measures **only** the typed-text repaint, not
          // the selection-highlight transition that Ctrl+A introduces (Codex
          // Round 3 P1). When `replaceAll === false` this is equivalent to the
          // pre-WM_CHAR capture point. The capture is now serial with the
          // baseline reads above (loses ~30-50ms parallelism vs the prior
          // Promise.all design) — accepted as the correctness/speed tradeoff
          // for the load-bearing Stage 4 verifyDelivery contract.
          const stage4PreFrame: RawFrame | null =
            stage4KeyboardEnabled && stage4WindowRect !== null
              ? await captureFrame(target.hwnd, stage4WindowRect)
              : null;

          logDispatchSink({ sink: "wm_char", tool: "keyboard:type", targetHwnd: target.hwnd });
          const result = postCharsToHwnd(target.hwnd, effectiveText);
          if (!result.full) {
            // Partial fail: do NOT fall through to foreground (would cause double input).
            // Return error regardless of effectiveMethod.
            return failWith(
              new Error("BackgroundInputIncomplete"),
              "keyboard:type",
              {
                sent: result.sent,
                total: effectiveText.length,
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

          // ADR-019 Stage 4 — local_repaint SSIM fallback when BG verify reached
          // the terminal `unverifiable + read_back_unsupported` sink (sub-plan
          // §2.4.2 gate 1). Stage 4 only upgrades — on `motion: "local_repaint"`
          // we promote `verifiedDelivery` to `true`, on `no_change` /
          // `indeterminate` we keep `unverifiable` (§2.4.2 + §9 invariant
          // "Stage 4 never demotes heuristics that were honest about being silent").
          let stage4Observation:
            | import("./_input-pipeline.js").VisualMotionObservation
            | undefined;
          if (
            stage4KeyboardEnabled &&
            verifiedDelivery === "unverifiable" &&
            verifyReason === "read_back_unsupported" &&
            stage4WindowRect !== null
          ) {
            stage4Observation = await verifyLocalRepaint({
              hwnd: target.hwnd,
              hint: {
                // Keyboard has no click point — resolver falls through to
                // window_fallback (P16 decision lock default (b)).
                windowRect: stage4WindowRect,
              },
              preFrame: stage4PreFrame,
            });
            if (stage4Observation.motion === "local_repaint") {
              verifiedDelivery = true;
              verifyReason = undefined;
            } else if (
              // ADR-019 Stage 5 sub-plan §2.3.2 — optional DXGI safety-net.
              // Same activation profile as the mouse path: Stage 4 returned
              // `indeterminate` with no `residual` (R3 cap / R6 unstable)
              // AND operator opted in via `DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK=1`.
              // Replaces the empty Stage 4 observation with the Stage 5 one;
              // never upgrades `verifiedDelivery` (§2.3.2 forbids the safety
              // net from claiming `delivered`).
              //
              // Region: Opus PR #325 Round 1 P2-3 — unlike the mouse path
              // (`_mouse-verify.ts:301-308`, which pads a 192×192 region
              // around the click point), the keyboard path INTENTIONALLY
              // passes only `windowRect` (no `region` sub-rect). Keyboard
              // input has no equivalent screen-space "point" — the caret
              // position is a UIA query away and we do not always have an
              // input-field rect handy. The wider gate is acceptable here
              // because the Stage 5 observation is **observation-only**:
              // it cannot upgrade `verifiedDelivery` (still `false` /
              // `unverifiable`), only attach evidence. A small caret blink
              // alone will not satisfy the 0.5 % gate on a 1920×1080
              // window, but a full-line repaint will — exactly the signal
              // we want.
              stage4Observation.motion === "indeterminate" &&
              stage4Observation.source === "ssim_residual" &&
              stage4Observation.residual === undefined &&
              process.env["DESKTOP_TOUCH_STAGE5_DXGI_FALLBACK"] === "1"
            ) {
              try {
                stage4Observation = await verifyAnyChange({
                  hwnd: target.hwnd,
                  windowRect: stage4WindowRect,
                });
              } catch {
                // Stage 5 never throws by contract; defensive only.
              }
            }
          }

          if (verifiedDelivery === false) {
            // suggest[] is provided by classify() via SUGGESTS.BackgroundInputNotDelivered
            // — keep this call site free of duplicated copy so the dictionary stays SSOT.
            return failWith(
              new Error("BackgroundInputNotDelivered"),
              "keyboard:type",
              {
                hint: "post-send UIA read-back did not contain the input substring",
                targetClass,
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
              ? {
                  status: "delivered",
                  channel: "wm_char",
                  ...(stage4Observation && { observation: stage4Observation }),
                }
              : {
                  status: "unverifiable",
                  ...(verifyReason && { reason: verifyReason }),
                  channel: "wm_char",
                  fallback: "method:'foreground'",
                  ...(stage4Observation && { observation: stage4Observation }),
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
          //     `class_unknown`) → `BackgroundInputUnsupported`, whose
          //     SUGGESTS entry carries the recovery copy ("For Chrome/Edge:
          //     use browser_fill instead" — OQ8 moved it off this call
          //     site). Splitting by reason preserves each reason's
          //     existing recovery hint contract (PR #174 round 2 P1-1:
          //     same code → same suggest).
          if (check.reason === "wt_xaml_pipeline") {
            return failWith(
              new Error("BackgroundInputNotDelivered"),
              "keyboard:type",
              {
                // suggest[] from SUGGESTS dictionary (matrix §2.3 SSOT) —
                // keep this call site free of duplicated copy.
                hint: "target's WinUI/XAML pipeline silently swallows WM_CHAR — use method:'foreground'",
                reason: check.reason,
                ...(check.className !== undefined && { className: check.className }),
                ...(check.processName !== undefined && { processName: check.processName }),
              }
            );
          }
          return failWith(
            new Error("BackgroundInputUnsupported"),
            "keyboard:type",
            {
              className: check.className,
              processName: check.processName,
            }
          );
        }
        // auto + not supported → fall through to foreground path
      } else if (effectiveMethod === "background") {
        // OQ8 follow-up: this is the `if (target)` ELSE path — no window
        // matched the title, so the accurate code is WindowNotFound (its
        // SUGGESTS entry says "verify the title / run desktop_discover").
        // The old BackgroundInputUnsupported claimed the app rejects
        // background input, which was never the situation here.
        return failWith(
          new Error("WindowNotFound"),
          "keyboard:type",
          { windowTitle: effectiveWindowTitle }
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

    // Auto-clipboard: upgrade to clipboard mode when non-ASCII content is present
    // (unless the caller opted out via forceKeystrokes). Two detectors cover two
    // distinct motivations:
    //
    //   - NON_ASCII_SYMBOL_RE: 5 specific symbols that Chrome / Edge intercept as
    //     keyboard accelerators (em-dash / smart quotes / ellipsis / NBSP).
    //     Pre-dates ADR-018; retained for that targeted defense.
    //
    //   - isNonAscii (NON_ASCII_RE wrapper): ANY code point outside U+0000..U+007F
    //     (CJK, emoji, surrogate pairs, Latin diacritics, etc.) that the Win32
    //     keystroke channel cannot deliver reliably across keyboard layouts.
    //     Wired in ADR-018 Phase 2b-2 — see `docs/adr-018-input-pipeline-3tier.md` §2.4 D4.
    //
    // Callers needing keystroke semantics for non-ASCII text (e.g. Focus Leash
    // surrogate-pair chunked-keystroke regression coverage) opt out with
    // `forceKeystrokes: true`.
    let effectiveClipboard = use_clipboard;
    let autoClipboardReason: string | undefined;
    if (!use_clipboard && !forceKeystrokes) {
      if (NON_ASCII_SYMBOL_RE.test(effectiveText)) {
        effectiveClipboard = true;
        autoClipboardReason = "non-ASCII symbol detected";
      } else if (isNonAscii(effectiveText)) {
        effectiveClipboard = true;
        autoClipboardReason = "non-ASCII character detected (CJK / emoji / diacritic)";
      }
    }

    // ADR-035 Phase 1 — foreground path: there is no destination handle, the
    // keys go wherever focus is, and that is precisely the H2 question. One
    // event per dispatch, emitted once the channel is known (clipboard paste
    // vs. chunked keystrokes) and before either starts.
    logDispatchSink({
      sink: effectiveClipboard ? "clipboard_paste" : "sendinput",
      tool: "keyboard:type",
      targetHwnd: null,
    });
    if (effectiveClipboard) {
      clipboardOutcome = await typeViaClipboard(effectiveText);
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

    const hints = {
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(clipboardOutcome ? { clipboard: clipboardPasteHints(clipboardOutcome) } : {}),
    };

    return ok({
      ok: true,
      typed: effectiveText.length,
      method,
      ...(autoClipboardReason && { autoClipboardReason }),
      ...(focusLost && { focusLost }),
      ...(Object.keys(hints).length > 0 && { hints }),
      ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
    });
  } catch (err) {
    // A failed paste has already replaced the user's clipboard; whether it was
    // put back is a fact only the call knows, and it would otherwise die here.
    // `failWith`'s third argument is flat and auto-nests everything outside
    // ROOT_HOISTED_KEYS, so this lands as `context.clipboard` — the failure-side
    // mirror of `hints.clipboard` on success, same as `clipboard(action=…)`
    // reports its backend on both.
    //
    // An object literal with a conditional spread, not a ternary between two
    // objects: `scripts/extract-failwith-shape-fixtures.mjs` classifies the
    // third argument by whether it STARTS with `{`, so a ternary is recorded as
    // `dynamic` and the guard stops seeing the shape. Anything added inside it
    // later — `hints`, `_perceptionForPost` — would then escape the sweep. Same
    // form as `terminal:send`'s catch, so both tools read identically.
    return failWith(err, "keyboard:type", {
      // Exclusive: either the paste itself threw (the error carries the facts)
      // or it SUCCEEDED and a later step threw (the hoisted outcome does). The
      // second is why this is hoisted at all — the text is already delivered,
      // so a caller that retries on this failure double-types.
      ...(err instanceof TypeViaClipboardDeliveryError
        ? { clipboard: err.clipboard }
        : clipboardOutcome
          ? { clipboard: clipboardPasteHints(clipboardOutcome) }
          : {}),
    });
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
        { keys }
      );
    }

    // Resolve hwnd / @active → effective window title
    const resolvedWin = await resolveWindowTarget({ hwnd, windowTitle });
    const effectiveWindowTitle = resolvedWin?.title ?? windowTitle;

    const warnings: string[] = [...(resolvedWin?.warnings ?? [])];
    const homingNotes: string[] = [];
    let foregroundVerified = false;

    // ── ADR-038: destination required (before the method / guard split) ────
    const destCheck = assertKeyboardDestination({
      toolName: "keyboard:press",
      effectiveWindowTitle,
      hwnd,
      resolved: toResolvedDestination(resolvedWin),
      lensId,
      warnings,
    });
    if (!destCheck.ok) return destCheck.errorResult;

    // ── Background input path ──────────────────────────────────────────────
    const effectiveMethod = resolveEffectiveInputMethod(inputMethod, effectiveWindowTitle);
    if ((effectiveMethod === "background" || effectiveMethod === "background-auto") && effectiveWindowTitle) {
      const wins = enumWindowsInZOrder();
      const bgPressMatches = wins.filter(w => w.title.toLowerCase().includes(effectiveWindowTitle!.toLowerCase()));
      const target = bgPressMatches[0];
      logResolve({
        resolver: "keyboardBackgroundPress",
        query: effectiveWindowTitle!,
        matches: bgPressMatches,
        identity: "lookup",
      });
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

        logDispatchSink({ sink: "wm_char", tool: "keyboard:press", targetHwnd: target.hwnd });
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
              keys,
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
              hint: "post-send UIA read-back did not observe the expected buffer mutation",
              keys,
              targetClass,
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
        // OQ8 follow-up. Unlike the type handler, the guard above is the
        // COMPOUND `target && canInjectViaPostMessage(...)`, so this else
        // covers two distinct situations that need different codes:
        //   - no window matched the title → WindowNotFound (verify the
        //     title / run desktop_discover);
        //   - window found but its class rejects the WM_CHAR channel →
        //     BackgroundInputUnsupported (switch to method:'foreground').
        // Collapsing both into BackgroundInputUnsupported mis-advised the
        // not-found case, which the removed call-site suggest used to patch.
        if (!target) {
          return failWith(
            new Error("WindowNotFound"),
            "keyboard:press",
            { windowTitle: effectiveWindowTitle }
          );
        }
        return failWith(
          new Error("BackgroundInputUnsupported"),
          "keyboard:press",
          { windowTitle: effectiveWindowTitle }
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
    logDispatchSink({ sink: "sendinput", tool: "keyboard:press", targetHwnd: null });
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
      "keyboard:sequence"
    );
  }
  if (rawMethod === "foreground_flash") {
    return failWith(
      new Error("ForegroundFlashNotApplicableToSequence"),
      "keyboard:sequence"
    );
  }

  try {
    // Phase G: fixId approval prologue. Sequence only uses fixId for
    // GUARD-pre-loop rejection retry (e.g. unsafe.keyboardTarget) — the
    // mid-loop MenuFocusLostMidSequence path returns context.remaining
    // directly (FocusLostDuringType convention).
    // ADR-038: validate the fix and adopt its args here, but burn it only once
    // the destination check has let the call through (see keyboard:type).
    let effectiveWindowTitle = windowTitle;
    if (fixId) {
      const vr = validateAndPrepareFix(fixId, "keyboard");
      if (!vr.ok || !vr.fix) return failWith(new Error(vr.errorCode!), "keyboard:sequence");
      if (typeof vr.fix.args.windowTitle === "string") effectiveWindowTitle = vr.fix.args.windowTitle;
    }

    const resolvedWin = !fixId ? await resolveWindowTarget({ hwnd, windowTitle: effectiveWindowTitle }) : null;
    if (resolvedWin) effectiveWindowTitle = resolvedWin.title;

    const warnings: string[] = [...(resolvedWin?.warnings ?? [])];
    const homingNotes: string[] = [];
    let foregroundVerified = false;
    let targetHwnd: bigint | null = null;

    // ── ADR-038: destination required (before focus and the guard split) ───
    const destCheck = assertKeyboardDestination({
      toolName: "keyboard:sequence",
      effectiveWindowTitle,
      hwnd,
      resolved: toResolvedDestination(resolvedWin),
      lensId,
      warnings,
    });
    if (!destCheck.ok) return destCheck.errorResult;

    // The call is going ahead — now the one-shot fix is genuinely spent.
    if (fixId) consumeFix(fixId);

    if (effectiveWindowTitle) {
      // Codex PR #270 P2: when the caller passed an explicit hwnd,
      // resolveWindowTarget already pinned it. Pass that hwnd through so
      // focusWindowForKeyboard matches by handle instead of title substring
      // (duplicate-title siblings can no longer win the focus race).
      const explicitHwndForFocus = (hwnd !== undefined && resolvedWin)
        ? resolvedWin.hwnd
        : undefined;
      const fw = await focusWindowForKeyboard(effectiveWindowTitle, force, explicitHwndForFocus);
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
            // ADR-035 Phase 1 — one event per sequence call, emitted here and
            // not before the loop, so a sequence refused by `assertKeyComboSafe`
            // or `parseKeys` never records a dispatch that did not happen
            // (Codex Round 1 P2). `targetHwnd` is null because `rawKeyboard` is
            // SendInput: it is routed by focus, not addressed to a handle. The
            // window this sequence MEANT to reach is on the `focusWindowForKeyboard`
            // resolve event sharing this call's `callId`.
            if (i === 0) {
              logDispatchSink({ sink: "rawkeyboard", tool: "keyboard:sequence", targetHwnd: null });
            }
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
          //
          // IMPORTANT: this MUST stay as the last statement inside the
          // withKeyboardLock callback. Any logic added below it that throws
          // would set failedIndex=-1 just before, leaving the outer catch
          // with no step index to attach — the catch then rethrows past the
          // failWith branch and the LLM loses completedSteps/remaining.
          // (Opus PR #270 round 2 P3-6.)
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
        "pasted text is not run through IME conversion. Note this does not help while an IME " +
        "composition is already in progress: the paste keystroke is consumed by the IME and " +
        "nothing is inserted, so commit or cancel the composition first. Your clipboard is " +
        "replaced for the duration of the call and put back afterwards; hints.clipboard reports " +
        "which backend served the paste and whether the restore ran. On builds without the native " +
        "addon this path is capped at about 12000 characters and fails with " +
        "code:'ClipboardWriteTooLargeForFallback' above it. Default false."
      ),
    replaceAll: coercedBoolean().optional().default(false).describe(
      "When true, send Ctrl+A to select all existing text before typing. " +
      "Equivalent to Ctrl+A → keyboard(action='type') in one call (requires field already focused). Default false."
    ),
    forceKeystrokes: coercedBoolean().optional().default(false).describe(
      "When true, always use keystroke mode even if text contains non-ASCII content " +
      "(CJK, emoji, diacritics, em-dash, smart quotes, etc.) that would normally trigger auto-clipboard. " +
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
      .describe("Ordered list of key-press steps. Min 1, max 16. Total duration must not exceed 5000ms (excludes settleMs and focus acquisition). N=1 is allowed but inherits the sequence verification contract (hints.verifyDelivery.status='focus_only'); if you want the stricter keyboard:press contract, call keyboard({action:'press', keys}) directly (issue #278, matrix doc §3.1)."),
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
  // ADR-018 Phase 2a — strict per-action gate (§2.5.2). The registered wire
  // schema is the flat `flattenUnionToObjectSchema` output; re-parse against
  // the real (include-injected) union so per-action constraints — incl. the
  // `sequence` variant's `method: z.literal("foreground")` — still apply.
  const parsed = parseActionArgsOrFail<KeyboardArgs>(keyboardUnionWithInclude, args, "keyboard");
  if (!parsed.ok) return parsed.result;
  const a = parsed.value;
  if (a.action === "type") {
    return keyboardTypeHandler(a);
  }
  if (a.action === "sequence") {
    return keyboardSequenceHandler(a);
  }
  return keyboardPressHandler(a);
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
// ADR-018 Phase 2a — `keyboardUnionWithInclude` (include-injected union) feeds
// BOTH the flat wire schema AND the in-handler `parseActionArgsOrFail` gate.
const keyboardUnionWithInclude = withEnvelopeIncludeForUnion(keyboardSchema);
export const keyboardRegistrationSchema = flattenUnionToObjectSchema(keyboardUnionWithInclude);

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
        details: "action='type' inserts text (auto-clipboard for non-ASCII, bypassing IME conversion). action='press' sends key combos like 'ctrl+c'/'alt+tab'. action='sequence' runs ordered steps in one keyboard lock — use for Alt+letter, letter mnemonic chains where intermediate tool calls would close the menu. windowTitle or hwnd is REQUIRED (blank/whitespace counts as neither) — the server focuses and auto-guards that window (identity, foreground, modal) first, and a call with neither stops with DestinationRequired before any key is sent. Use windowTitle:'@active' to aim at the foreground window on purpose; an hwnd naming a titleless window works only while that window is already foreground. DESKTOP_TOUCH_REQUIRE_DESTINATION=0 downgrades the stop to a warning.",
        prefer: "Set lensId for perception guards. Use desktop_act({action:'setValue'}) for UIA ValuePattern text fields.",
        caveats: "win+r/win+x/win+s/win+l blocked. action='type' does not handle CJK IME composition — use use_clipboard=true or desktop_act({action:'setValue'}); neither lands while an IME composition is pending — commit or cancel it first. hints.clipboard reports the backend and whether the clipboard was restored. Non-ASCII text (CJK / emoji / diacritics / smart-quote-class punctuation) auto-clipboards to prevent silent-drop and Chrome accelerator hijack; pass forceKeystrokes:true to disable. Background (PostMessage/WM_CHAR) auto-engages for terminal-class windows (Windows Terminal / cmd / PowerShell); DTM_BG_AUTO=1 enables globally. Foreground non-terminal type runs a per-chunk leash; user focus-steal mid-stream aborts with FocusLostDuringType + context.typed/remaining; pass abortOnFocusLoss:false to disable. BG type verifies WM_CHAR via UIA TextPattern read-back; mismatch returns BackgroundInputNotDelivered (see SUGGESTS for false-positive notes). BG press read-back is scoped to terminal-class + enter/tab/arrow; other combos return verifyDelivery:'unverifiable', failure returns BackgroundKeyNotDelivered. action='sequence' is FG-only (BG/foreground_flash schema-rejected); emits verifyDelivery:'focus_only'; mid-loop focus theft returns MenuFocusLostMidSequence + context.remaining: Step[]. Win11 FG refusal returns ForegroundRestricted — terminal-class targets auto-engage BG; non-terminal switch to desktop_act / click_element.",
        examples: [
          "keyboard({action:'type', text:'hello', windowTitle:'Untitled - Notepad'}) → text injected (guarded)",
          "keyboard({action:'type', text:'hello', windowTitle:'@active'}) → typed into the foreground window",
          "keyboard({action:'press', keys:'ctrl+c', windowTitle:'Untitled - Notepad'}) → copy",
          "keyboard({action:'press', keys:'escape', windowTitle:'Dialog'}) → dismiss dialog",
          "keyboard({action:'sequence', steps:[{keys:'alt+i', gapMs:100},{keys:'m'}], windowTitle:'Microsoft Visual Basic'}) → Insert > Module (atomic)",
        ],
      }),
      inputSchema: keyboardRegistrationSchema,
    },
    keyboardRegistrationHandler as (args: Record<string, unknown>) => Promise<import("./_types.js").ToolResult>,
  );
}
