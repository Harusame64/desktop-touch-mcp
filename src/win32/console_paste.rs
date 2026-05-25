//! issue #386 — native no-steal console-paste for the conhost exit-mode path.
//!
//! Replaces the powershell-spawning TS clipboard handling in
//! `src/engine/bg-input.ts::pasteIntoConsoleNoFocus` with a single sync `#[napi]`
//! call that runs the whole save → set → console-Paste → Enter → restore
//! transaction natively, reusing `clipboard_snapshot.rs` (HGLOBAL save/restore +
//! 3-point sequence race detection + `OpenClipboard` 10×10 ms retry).
//!
//! Why sync (not AsyncTask): `win32_foreground_flash_inject` already runs the
//! same clipboard transaction synchronously on the V8 thread and works — that is
//! the thread clipboard ownership is known-good on. A libuv worker thread is a
//! risky home for a top-level clipboard-owner window (the UIA backend stands up a
//! *dedicated* thread for COM affinity precisely because worker threads are not).
//! The body sleeps ~260 ms and may block ≤100 ms on OpenClipboard retry; the MCP
//! server is a single stdio client and exit-mode already waits seconds-to-minutes
//! for completion, so the event-loop block is immaterial. Sync also gets the
//! ADR-007 §3.4 panic boundary for free via `napi_safe_call`.
//!
//! Design: `desktop-touch-mcp-internal/docs/issue-386-native-clipboard-plan.md`.

use std::time::Duration;

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::Win32::Foundation::{LPARAM, WPARAM};

use super::clipboard_snapshot::{
    get_clipboard_sequence_number, restore_clipboard_supported_formats,
    save_clipboard_supported_formats, set_clipboard_unicode_text, with_hidden_owner,
    ClipboardSnapshot, RestoreOutcome,
};
use super::input::{hwnd_from_bigint, post_message};
use super::safety::napi_safe_call;

// ── Constants ───────────────────────────────────────────────────────────────

const WM_COMMAND: u32 = 0x0111;
/// Legacy console context-menu "Paste" command id (conhost). Mirrors
/// `ID_CONSOLE_PASTE` in `bg-input.ts`.
const ID_CONSOLE_PASTE: usize = 0xFFF1;
const WM_KEYDOWN: u32 = 0x0100;
const WM_KEYUP: u32 = 0x0101;
/// VK_RETURN. Enter is sent as a real KEY EVENT (WM_KEYDOWN + WM_KEYUP), NOT
/// WM_CHAR 0x0D — the lParam is built to be BIT-IDENTICAL to the TS
/// `postEnterToHwnd`/`postKeyToHwnd` path (keyup sign-extended; see the send
/// site). conhost
/// PowerShell's PSReadLine treats WM_CHAR 0x0D (= Ctrl+M) as a LITERAL 'm' and
/// never accepts the line (the command is typed but not run); a VK_RETURN key
/// event IS recognized as accept-line. bash / cmd accept the key-event Enter as
/// CR just as they did the WM_CHAR form, so the original conhost-bash fix is
/// preserved (verified by the SSH-WSL load gate + cross-shell dogfood).
const VK_RETURN: usize = 0x0D;
/// Enter key scan code (scan-code set 1). Carried in the WM_KEYDOWN/UP lParam so
/// conhost builds a faithful key record (matches a physically pressed Enter).
const ENTER_SCANCODE: isize = 0x1C;
/// Let conhost drain the pasted clipboard into its input buffer before Enter.
const PASTE_DRAIN_DELAY_MS: u64 = 200;
/// Gap after Enter before restoring the clipboard.
const ENTER_GAP_DELAY_MS: u64 = 60;

// ── Result types (napi objects) ─────────────────────────────────────────────

/// One clipboard format that was NOT preserved across the paste, with the
/// reason (`non_hglobal` / `deferred_render` / `get_data_failed`). Surfaced as
/// caller hints so a user who had e.g. an image on the clipboard learns it was
/// not restored.
#[napi(object)]
pub struct ConsolePasteSkippedFormat {
    pub format_id: u32,
    pub reason: String,
}

/// Outcome of `win32_console_paste_no_focus`. `reason` is `None` on success;
/// otherwise one of `ClipboardError::as_reason()` (`clipboard_lock_contention` /
/// `clipboard_empty_failed` / `clipboard_alloc_failed` / `clipboard_set_data_failed`
/// / `hidden_owner_create_failed`) or the console-paste-specific `post_paste_failed`.
#[napi(object)]
pub struct ConsolePasteResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub skipped_formats: Vec<ConsolePasteSkippedFormat>,
    /// Restore was intentionally skipped because another writer changed the
    /// clipboard after our inject (race detection). Still a success — the paste
    /// worked; we just did not clobber the other writer.
    pub restore_skipped_race: bool,
}

/// Normalise every newline to CRLF (collapse CRLF→LF then LF→CRLF, so isolated
/// `\r` is handled and existing CRLF is not doubled). conhost strips lone LF and
/// treats CR as a line break, so each statement must be CRLF-terminated to run
/// after the atomic paste. Equivalent to the previous TS `/\r?\n/g → \r\n`.
/// Pure — shared by the paste body and its unit test (PR #393 R2 P3-new).
fn normalise_crlf(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\n', "\r\n")
}

fn build_skipped(snapshot: &ClipboardSnapshot) -> Vec<ConsolePasteSkippedFormat> {
    snapshot
        .skipped_summary()
        .into_iter()
        .map(|(format_id, reason)| ConsolePasteSkippedFormat {
            format_id,
            reason: reason.to_string(),
        })
        .collect()
}

fn fail(reason: &str, skipped: Vec<ConsolePasteSkippedFormat>, restore_skipped_race: bool) -> ConsolePasteResult {
    ConsolePasteResult {
        ok: false,
        reason: Some(reason.to_string()),
        skipped_formats: skipped,
        restore_skipped_race,
    }
}

/// Pure mapping from the executed step outcomes (after restore has already run)
/// to the final result. Extracted so every reason branch — set failure, post
/// failure, success — plus the `skipped_formats` / `restore_skipped_race`
/// carry-through is unit-tested without touching Win32 (PR #393 R1 P3-2). The
/// surrounding imperative flow (save → set → paste → restore-exactly-once) is
/// verified by review + the `clipboard_snapshot` round-trip/race tests + dogfood.
fn map_paste_outcome(
    set_ok: bool,
    set_reason: Option<&str>,
    post_paste_failed: bool,
    skipped: Vec<ConsolePasteSkippedFormat>,
    restore_skipped_race: bool,
) -> ConsolePasteResult {
    if !set_ok {
        return fail(
            set_reason.unwrap_or("clipboard_set_data_failed"),
            skipped,
            restore_skipped_race,
        );
    }
    if post_paste_failed {
        return fail("post_paste_failed", skipped, restore_skipped_race);
    }
    ConsolePasteResult {
        ok: true,
        reason: None,
        skipped_formats: skipped,
        restore_skipped_race,
    }
}

// ── napi entry point ─────────────────────────────────────────────────────────

/// Paste `text` into a conhost (ConsoleWindowClass) window atomically WITHOUT
/// stealing foreground, via the native clipboard + the console Paste command +
/// Enter, restoring the user's clipboard afterwards. Caller MUST have verified
/// the target is conhost. Sync (runs on the V8 thread); never throws on a Win32
/// failure — the failure is reported via `ok=false` + `reason`.
#[napi]
pub fn win32_console_paste_no_focus(
    hwnd: BigInt,
    text: String,
) -> napi::Result<ConsolePasteResult> {
    napi_safe_call("win32_console_paste_no_focus", || {
        let target = hwnd_from_bigint(hwnd);
        let crlf = normalise_crlf(&text);

        // The whole clipboard transaction runs under one hidden owner window
        // (per-call lifecycle) on this (V8) thread.
        let inner = with_hidden_owner(|owner| -> ConsolePasteResult {
            // 1. Save the user's clipboard (3-point sequence: 1st point).
            let snapshot = match save_clipboard_supported_formats(owner) {
                Ok(s) => s,
                // Nothing was changed yet → nothing to restore.
                Err(e) => return fail(e.as_reason(), Vec::new(), false),
            };
            let skipped = build_skipped(&snapshot);

            // 2. Set our text. `set_clipboard_unicode_text` empties the clipboard
            //    BEFORE it can fail at GlobalAlloc/SetClipboardData, so on that
            //    failure the clipboard is empty and MUST be restored. Capture the
            //    post-set sequence on BOTH paths (it is callable with the clipboard
            //    closed) so `restore` is always race-aware. If `set` instead failed
            //    at OpenClipboard retry, EmptyClipboard was never reached → the
            //    user's clipboard is untouched and restore is a harmless no-op /
            //    will likewise fail on contention.
            let (set_ok, seq_after, set_reason) = match set_clipboard_unicode_text(owner, &crlf) {
                Ok(seq) => (true, seq, None),
                Err(e) => (false, get_clipboard_sequence_number(), Some(e.as_reason())),
            };

            // 3. Post console Paste + Enter ONLY if the set succeeded.
            let mut post_paste_failed = false;
            if set_ok {
                if !post_message(target, WM_COMMAND, WPARAM(ID_CONSOLE_PASTE), LPARAM(0)) {
                    post_paste_failed = true;
                } else {
                    std::thread::sleep(Duration::from_millis(PASTE_DRAIN_DELAY_MS));
                    // Enter — real KEY EVENT (WM_KEYDOWN + WM_KEYUP VK_RETURN),
                    // NOT WM_CHAR 0x0D. PSReadLine (conhost PowerShell) renders a
                    // WM_CHAR 0x0D (Ctrl+M) as a literal 'm' and never accepts the
                    // line; a VK_RETURN key event is accept-line in PowerShell and
                    // CR in bash/cmd. lParam carries the Enter scan code; keyup sets
                    // the previous-state (bit 30) + transition (bit 31) bits.
                    //
                    // Build the lParam as i32 then widen to isize so it is
                    // BIT-IDENTICAL to the TS postKeyToHwnd path: the keyup flags
                    // set bit 31, making the low-32 value negative, which the TS
                    // path sign-extends (JS 32-bit bitwise -> i64 in
                    // win32_post_message). Win32 reads only the low 32 bits, but
                    // matching keeps TS/native parity exact (Codex P2).
                    let scan = (ENTER_SCANCODE & 0xFF) as u32;
                    let down = ((scan << 16) as i32) as isize;
                    let up = (((scan << 16) | (1u32 << 30) | (1u32 << 31)) as i32) as isize;
                    let _ = post_message(target, WM_KEYDOWN, WPARAM(VK_RETURN), LPARAM(down));
                    let _ = post_message(target, WM_KEYUP, WPARAM(VK_RETURN), LPARAM(up));
                    std::thread::sleep(Duration::from_millis(ENTER_GAP_DELAY_MS));
                }
            }

            // 4. ALWAYS attempt restore (race-aware) — the restore-once contract.
            let restore = restore_clipboard_supported_formats(&snapshot, owner, seq_after);
            let restore_skipped_race = matches!(restore, RestoreOutcome::SkippedDueToRace { .. });

            // 5. Map outcome (pure — see map_paste_outcome).
            map_paste_outcome(set_ok, set_reason, post_paste_failed, skipped, restore_skipped_race)
        });

        // `with_hidden_owner` only errors when the hidden owner window could not
        // be created — surface it the same typed way (not a panic / throw).
        Ok(match inner {
            Ok(result) => result,
            Err(e) => fail(e.as_reason(), Vec::new(), false),
        })
    })
}

// ── Unit tests (pure mapping; Win32 path is exercised by dogfood) ────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fail_maps_reason_and_carries_hints() {
        let skipped = vec![ConsolePasteSkippedFormat {
            format_id: 2,
            reason: "non_hglobal".to_string(),
        }];
        let r = fail("post_paste_failed", skipped, true);
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("post_paste_failed"));
        assert_eq!(r.skipped_formats.len(), 1);
        assert_eq!(r.skipped_formats[0].format_id, 2);
        assert_eq!(r.skipped_formats[0].reason, "non_hglobal");
        assert!(r.restore_skipped_race);
    }

    #[test]
    fn crlf_normalisation_collapses_then_expands() {
        // invoke the production helper (not a copy) so the test tracks the body
        assert_eq!(normalise_crlf("a\nb"), "a\r\nb");
        assert_eq!(normalise_crlf("a\r\nb"), "a\r\nb"); // already CRLF stays CRLF (no doubling)
        assert_eq!(normalise_crlf("a\nb\nc"), "a\r\nb\r\nc");
        assert_eq!(normalise_crlf("plain"), "plain");
    }

    fn one_skip() -> Vec<ConsolePasteSkippedFormat> {
        vec![ConsolePasteSkippedFormat { format_id: 2, reason: "non_hglobal".to_string() }]
    }

    #[test]
    fn map_outcome_success_carries_hints() {
        let r = map_paste_outcome(true, None, false, one_skip(), true);
        assert!(r.ok);
        assert!(r.reason.is_none());
        assert_eq!(r.skipped_formats.len(), 1); // skipped formats ride along on success
        assert!(r.restore_skipped_race);
    }

    #[test]
    fn map_outcome_set_failure_uses_set_reason() {
        // each ClipboardError::as_reason value flows through unchanged
        for reason in [
            "clipboard_lock_contention",
            "clipboard_empty_failed",
            "clipboard_alloc_failed",
            "clipboard_set_data_failed",
        ] {
            let r = map_paste_outcome(false, Some(reason), false, Vec::new(), false);
            assert!(!r.ok);
            assert_eq!(r.reason.as_deref(), Some(reason));
        }
    }

    #[test]
    fn map_outcome_set_failure_falls_back_when_reason_absent() {
        let r = map_paste_outcome(false, None, false, Vec::new(), false);
        assert_eq!(r.reason.as_deref(), Some("clipboard_set_data_failed"));
    }

    #[test]
    fn map_outcome_post_paste_failure() {
        // post failure only reachable when set succeeded; reason is console-paste-specific
        let r = map_paste_outcome(true, None, true, one_skip(), false);
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("post_paste_failed"));
        assert_eq!(r.skipped_formats.len(), 1);
    }
}
