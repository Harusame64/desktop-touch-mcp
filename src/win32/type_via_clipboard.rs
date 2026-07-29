//! ADR-033 PR-2 — native composite "put text on the clipboard and paste it".
//!
//! # Why this module exists
//!
//! `keyboard(action='type', use_clipboard=true)` and `terminal(action='send',
//! preferClipboard=true)` both reached the clipboard through
//! `typeViaClipboard()` in `src/tools/keyboard.ts`, which spawned
//! **three** `powershell.exe` processes per call: one `Get-Clipboard` to save,
//! one `[Convert]::FromBase64String(...) | Set-Clipboard` + `Get-Clipboard -Raw`
//! to write and verify, and one more `Set-Clipboard` to restore. The middle one
//! carries a base64 blob decoded inline by PowerShell — the exact command-line
//! shape Microsoft Defender scored as `Trojan:Win32/Commando.A!ml` before
//! killing the MCP server mid-session (ADR-033). That path is also the hottest
//! clipboard path in the server: every non-ASCII `keyboard:type` is promoted to
//! it automatically.
//!
//! Doing the whole transaction in-process removes all three spawns.
//!
//! # The sequence
//!
//! save → set + **in-session verify ①** → `CloseClipboard` → **post-close
//! re-verify ②** → decide → `SendInput` paste chord → settle 120 ms → restore
//! (3-point race).
//!
//! Both verification legs are kept, and they answer different questions. ① runs
//! while we still hold the clipboard open, so nothing can interleave and a
//! mismatch means the OS did not store what we handed it. ② re-opens after the
//! close, which is the only moment a clipboard manager, a DLP agent or an
//! RDP/Citrix redirector can have replaced the payload — they receive
//! `WM_CLIPBOARDUPDATE` only once the lock is released. The old PowerShell pair
//! (`Set-Clipboard` then `Get-Clipboard -Raw`, two separate transactions) had ②'s
//! semantics, so dropping it would have lost detection on the hottest path.
//!
//! **The verdict is not re-derived here.** `clipboard_text::map_write_outcome`
//! is reused and its `ok` IS the answer to "may we paste". That function already
//! implements the three-valued rule for ② — checked+match → paste,
//! checked+mismatch → do not paste, *not checked* (the re-open lost a race for
//! the lock) → paste anyway, because ① already proved the store and contention
//! on a verification read is not evidence that anything was lost — and its unit
//! tests already pin every branch. A second predicate here would be a second
//! place for that rule to drift.
//!
//! I-3 ("never press paste for a payload we could not prove is on the
//! clipboard") is therefore **structural** rather than a convention: the
//! `SendInput` is unreachable unless `chord_decision` returns `Send`, and that
//! requires the verdict.
//!
//! The third case deserves naming, because it is the one that looks like a gap:
//! **② not checked → we paste anyway, deliberately**. Requiring ② would turn a
//! benign event — a clipboard manager holding the clipboard open to READ what
//! was just copied is normal, frequent behaviour — into a silent no-op for
//! `keyboard(action='type')` and `terminal(action='send')`, i.e. the tool would
//! report success and nothing would be typed. ① has already proven the payload
//! is on the clipboard; contention on a *verification read* is not evidence
//! that anything was lost. What the composite owes the caller is not a
//! different decision but visibility, so `verify.post_close_checked` travels up
//! and the TS layer turns it into a `postCloseUnverified` hint whenever a chord
//! actually went out unverified by ②.
//!
//! # The paste deadline
//!
//! The clipboard steps have no bounded worst case (see "Why this is async"), so
//! the sequence can still be inside `GetClipboardData` long after the JS caller
//! has given up and been told the call failed. Aborting does not help: it
//! cancels a task that is still QUEUED, never one already running. Without a
//! second guard, such a task would eventually reach the chord and type into
//! whatever window has focus by *then* — minutes later, in an application the
//! caller never named.
//!
//! So the caller passes a budget, the factory turns it into an absolute
//! deadline at call time, and the chord is checked against it immediately
//! before `SendInput`. Past the deadline nothing is typed and the result says
//! `paste_deadline_exceeded`. The restore still runs: the 3-point race check is
//! what makes a late restore safe — if the user has copied anything since, the
//! sequence number has moved and the restore skips itself.
//!
//! # Why this does not call `foreground_flash::send_keys`
//!
//! `send_keys` fills `wVk` and leaves `wScan` at 0. Measured through a
//! `WH_KEYBOARD_LL` hook (ADR-033 P2-0), the path this composite replaces —
//! nut.js → libnut, whose USER32 imports are `SendInput` + `MapVirtualKeyA` +
//! `VkKeyScanA` — emits `vk=0xA2 scan=0x1D` / `vk=0x56 scan=0x2F`. Same API,
//! same virtual keys, different scan code.
//!
//! Most consumers read `wVk` and never notice. The ones that read `wScan` —
//! DirectInput / Raw Input games, scan-code-forwarding remote-session clients,
//! SDL/GLFW-style input abstractions — would see a dead key. Since this replaces
//! a path that always carried scan codes, filling them is behaviour **parity**,
//! and dropping them would have been a silent regression nobody would connect
//! back to "the clipboard went native". So this module owns `send_key_seq` and
//! `foreground_flash::send_keys` is left exactly as it shipped: changing what a
//! live channel emits belongs in its own change, not as a side effect of code
//! sharing.
//!
//! # Why the settle is 120 ms and not `foreground_flash`'s 30 ms
//!
//! See `PASTE_SETTLE_MS`.
//!
//! # Why this is async
//!
//! Same reason as `clipboard_text`: `GetClipboardData` has no bounded worst case
//! (the OS waits, inside our call, for a delayed-rendering owner to answer), and
//! on top of that this composite deliberately sleeps 120 ms. Both would run on
//! the V8 thread as a sync export. Measured on a spawned thread with **no
//! message pump** — the closest stand-in for a libuv worker — the whole
//! composite behaves identically to the V8 thread (ADR-033 P2-0 Q2), including
//! the hidden owner window's create/destroy and `SendInput`.
//!
//! **What the `AbortSignal` does NOT fix, and must not be read as fixing.**
//! Abort cancels a task that is still QUEUED for the pool; a task already
//! inside the sequence runs to completion. Its result is discarded, its side
//! effects are not — and here they are heavier than the clipboard tool's. A
//! call the caller has given up on can still send the chord, into whatever
//! window holds focus by then rather than the one the caller was aiming at, and
//! can still be holding the payload on the clipboard while it waits to restore.
//! So a timed-out `typeViaClipboard` leaves BOTH the paste and the clipboard
//! indeterminate, which is what `keyboard.ts` tells the caller. The hazard
//! exists only while a clipboard owner is hung, and in that state the clipboard
//! is already unusable system-wide; timing out keeps the server answering
//! instead of adding it to the casualties.
//!
//! # HGLOBAL ownership rules (I-9)
//!
//! Unchanged from `clipboard_text.rs` / `clipboard_snapshot.rs`, and this module
//! adds no allocation of its own: it composes those two. `SetClipboardData`
//! success transfers the handle to the OS; on failure the callee has already
//! freed it. `GetClipboardData` hands back an OS-owned handle that is only
//! locked and unlocked, never freed, and whose pointer dies at `CloseClipboard`.
//!
//! # What "ok" does and does not claim
//!
//! `ok:true` means the payload was proven on the clipboard and the chord was
//! accepted by `SendInput`. It does **not** claim the target application
//! consumed it — nothing observable from here can. The measured example is an
//! IME with a composition pending: the chord is swallowed by the IME, the
//! composition survives untouched, and the payload never reaches the control
//! (ADR-033 P2-0 Q3b). The emitted event sequence is byte-identical to the
//! nut.js path this replaces, so that is the pre-existing behaviour of the
//! channel rather than something the native path introduced.

use std::time::{Duration, Instant};

use napi::bindgen_prelude::{AbortSignal, AsyncTask, Buffer};
use napi::{Env, Task};
use napi_derive::napi;

use windows::Win32::Foundation::HWND;
use windows::Win32::System::DataExchange::CloseClipboard;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_KEYBOARD, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC,
    VIRTUAL_KEY, VK_CONTROL, VK_SHIFT, VK_V,
};

use super::clipboard_snapshot::{
    get_clipboard_sequence_number, open_clipboard_with_retry, restore_clipboard_supported_formats,
    save_clipboard_supported_formats, with_hidden_owner, ClipboardError, ClipboardSnapshot,
    RestoreOutcome,
};
use super::clipboard_text::{
    in_session_leg, map_write_outcome, post_close_leg, read_unicode_text_locked,
    set_unicode_text_locked, to_terminated_u16, ClipboardWriteVerifyResult,
};
use super::safety::napi_safe_call;

// ── Constants ───────────────────────────────────────────────────────────────

/// How long to wait between the paste chord and putting the user's clipboard
/// back.
///
/// **120 ms, deliberately NOT the 30 ms of
/// `foreground_flash::PASTE_REFLECT_DELAY_MS`.** The two numbers answer
/// different questions: 30 ms is how long Windows Terminal needs before it is
/// safe to send the *next* keystroke, whereas this one is the window in which
/// the target application must have finished *reading* the clipboard, because
/// the restore takes the content away again. 120 ms is what the TS
/// `typeViaClipboard` has shipped, and this is a port of that path, not a
/// re-tuning of it.
///
/// Measured (ADR-033 P2-0 Q5): pasting into a local `EDIT` control reflects in
/// p50 4.4 ms / p95 7.6 ms, 30/30 under 30 ms. That is **not** a reason to
/// lower this. An `EDIT` handles `WM_PASTE` synchronously and in-process — the
/// best case — while the population this delay exists for is the one it cannot
/// measure: another process, an application that reads the clipboard over
/// asynchronous IPC, a session over RDP. The measurement says 30 ms is enough
/// for an `EDIT`; it says nothing about the rest.
pub(crate) const PASTE_SETTLE_MS: u64 = 120;

// ── Paste chord ─────────────────────────────────────────────────────────────

/// Which paste chord to send — the two the TS layer picks between
/// (`keyboard.ts` / `terminal.ts` `pasteKey`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PasteCombo {
    CtrlV,
    /// Terminals where Ctrl+V is a literal-next / control character rather than
    /// paste (mintty, WSL, alacritty, wezterm) paste on Ctrl+Shift+V instead.
    CtrlShiftV,
}

impl PasteCombo {
    /// Parse the wire value. Deliberately exact-match and case-sensitive: the
    /// only callers are `keyboard.ts` and `terminal.ts`, whose own schemas are
    /// `z.enum(["ctrl+v", "ctrl+shift+v"])`, so anything else reaching here is a
    /// binding-level mistake that should surface loudly rather than be guessed
    /// at (a wrong guess sends the wrong chord to a live terminal).
    pub(crate) fn parse(s: &str) -> Option<Self> {
        match s {
            "ctrl+v" => Some(PasteCombo::CtrlV),
            "ctrl+shift+v" => Some(PasteCombo::CtrlShiftV),
            _ => None,
        }
    }

    /// The `(vk, is_keyup)` sequence: modifiers pressed outermost and released
    /// in reverse order.
    ///
    /// That shape is what makes "no modifier is left stuck down" structural
    /// rather than hopeful — every key that goes down comes back up in the same
    /// batch, so there is no interleaving point at which the sequence could be
    /// abandoned half-applied.
    pub(crate) fn keys(self) -> Vec<(VIRTUAL_KEY, bool)> {
        match self {
            PasteCombo::CtrlV => vec![
                (VK_CONTROL, false),
                (VK_V, false),
                (VK_V, true),
                (VK_CONTROL, true),
            ],
            PasteCombo::CtrlShiftV => vec![
                (VK_CONTROL, false),
                (VK_SHIFT, false),
                (VK_V, false),
                (VK_V, true),
                (VK_SHIFT, true),
                (VK_CONTROL, true),
            ],
        }
    }
}

// ── Chord gate ──────────────────────────────────────────────────────────────

/// Whether the paste chord may be sent, and if not, why.
///
/// Pulled out of the sequence so both refusals are decidable — and unit
/// testable — without a clipboard. Every `SendInput` in this module is behind
/// `Send`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChordDecision {
    Send,
    /// The payload could not be proven to be on the clipboard (I-3). The
    /// verdict's own reason is the one worth reporting, so this carries none.
    SkipUnverified,
    /// The transaction ran past the deadline the caller set. By now the caller
    /// has been told the call failed, and the window that had focus when they
    /// asked almost certainly no longer does.
    SkipDeadlineExceeded,
}

/// The gate. `verify_ok` first: a payload that was never on the clipboard must
/// not be pasted whether or not there is time left, and its reason is the more
/// fundamental one to report.
pub(crate) fn chord_decision(
    verify_ok: bool,
    deadline: Option<Instant>,
    now: Instant,
) -> ChordDecision {
    if !verify_ok {
        return ChordDecision::SkipUnverified;
    }
    match deadline {
        // No budget = no deadline. Kept expressible so a caller that has its
        // own lifecycle (a test, a future non-MCP embedder) is not forced to
        // invent one.
        Some(d) if now >= d => ChordDecision::SkipDeadlineExceeded,
        _ => ChordDecision::Send,
    }
}

/// Send the chord. See the module doc for why this does not reuse
/// `foreground_flash::send_keys`.
pub(crate) fn send_paste_combo(combo: PasteCombo) -> bool {
    send_key_seq(&combo.keys())
}

/// `SendInput` a `(vk, is_keyup)` sequence as **one batch**, filling `wScan`
/// from the active keyboard layout.
///
/// One batch rather than several calls so no other injected input can land
/// between the modifier down and the key it modifies.
///
/// `MAPVK_VK_TO_VSC` maps a key with no scan code on the current layout to 0,
/// i.e. to exactly what would have been sent without this lookup — so filling
/// the field can only add information, never lose any.
/// A partial send is worse than no send: `SendInput` can insert a strict
/// PREFIX of the batch (documented — it returns the number of events it
/// actually inserted, and a lower-level hook can block the rest), and a prefix
/// of `ctrl↓ shift↓ v↓ v↑ shift↑ ctrl↑` leaves Ctrl — and possibly Shift —
/// physically held down for the user. Every subsequent keystroke anywhere on
/// the desktop becomes a chord until they press and release the key themselves.
///
/// The compensation is a key-up for every key the batch would have pressed, in
/// reverse order. There is no way to learn where the insertion stopped, so all
/// of them are released rather than guessing: a key-up for a key that is not
/// down is a harmless no-op, while a missed one is a broken keyboard.
///
/// `up` events in the input need no counterpart — they are what this is
/// generating.
fn compensating_keyups(seq: &[(VIRTUAL_KEY, bool)]) -> Vec<(VIRTUAL_KEY, bool)> {
    seq.iter()
        .filter(|(_, is_up)| !*is_up)
        .rev()
        .map(|(vk, _)| (*vk, true))
        .collect()
}

pub(crate) fn send_key_seq(seq: &[(VIRTUAL_KEY, bool)]) -> bool {
    unsafe {
        let mut inputs: Vec<INPUT> = vec![std::mem::zeroed(); seq.len()];
        for (i, (vk, is_up)) in seq.iter().enumerate() {
            inputs[i].r#type = INPUT_KEYBOARD;
            inputs[i].Anonymous.ki.wVk = *vk;
            inputs[i].Anonymous.ki.wScan = MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) as u16;
            if *is_up {
                inputs[i].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
            }
        }
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        if sent as usize == seq.len() {
            return true;
        }

        // Best effort, and deliberately not part of the verdict: this call
        // failed either way, and the caller's decision does not change with
        // whether the cleanup got through. `send_key_seq` is not used
        // recursively here — the compensation is built and sent inline — so a
        // second partial insert cannot loop.
        let ups = compensating_keyups(seq);
        if !ups.is_empty() {
            let mut relief: Vec<INPUT> = vec![std::mem::zeroed(); ups.len()];
            for (i, (vk, _)) in ups.iter().enumerate() {
                relief[i].r#type = INPUT_KEYBOARD;
                relief[i].Anonymous.ki.wVk = *vk;
                relief[i].Anonymous.ki.wScan =
                    MapVirtualKeyW(vk.0 as u32, MAPVK_VK_TO_VSC) as u16;
                relief[i].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
            }
            let _ = SendInput(&relief, std::mem::size_of::<INPUT>() as i32);
        }
        false
    }
}

// NOTE: `foreground_flash::send_keys` has the same latent partial-send hole. It
// is a shipped channel and changing what it emits belongs in its own change,
// not as a side effect of this one — recorded as a follow-up rather than fixed
// here.

// ── Result types (napi objects) ─────────────────────────────────────────────

/// One clipboard format the snapshot could not carry (I-10).
///
/// Its own type rather than a shared one, matching `ConsolePasteSkippedFormat` /
/// `ForegroundFlashSkippedFormat`: each composite owns the shape it publishes,
/// so a change to one channel's diagnostics cannot silently alter another's.
#[napi(object)]
pub struct TypeViaClipboardSkippedFormat {
    pub format_id: u32,
    /// `"non_hglobal"` (bitmaps, metafiles) / `"deferred_render"` /
    /// `"get_data_failed"`.
    pub reason: String,
}

/// Outcome of the composite. Never throws on a Win32 failure — failures come
/// back as `ok=false` + `reason`, the `ConsolePasteResult` /
/// `ClipboardWriteVerifyResult` idiom.
#[napi(object)]
pub struct TypeViaClipboardResult {
    /// The payload was proven on the clipboard AND the chord was accepted by
    /// `SendInput`. See the module doc for what this does not claim.
    pub ok: bool,
    /// `None` on success. Otherwise the verification verdict's reason
    /// (`readback_mismatch` / `clipboard_replaced_after_write` /
    /// `clipboard_get_data_failed` / one of `ClipboardError::as_reason()`), or
    /// `send_input_failed` when the clipboard was proven and the chord was
    /// refused.
    pub reason: Option<String>,
    /// The full two-leg verification record, in the same shape the clipboard
    /// tool publishes, so the diagnostics are comparable across both paths.
    pub verify: ClipboardWriteVerifyResult,
    /// Whether the chord was actually sent. `false` with `verify.ok = true`
    /// means verification passed and `SendInput` refused the batch.
    pub pasted: bool,
    /// Whether the user's clipboard was changed AT ALL by this call.
    ///
    /// The dividing line is `EmptyClipboard` succeeding: before that point the
    /// user's content is still there, after it the clipboard is ours to put
    /// back. So the three pre-write failures — the hidden owner window could
    /// not be created, the snapshot could not open the clipboard, the write
    /// transaction could not open it — report `false`, and so do the two
    /// `set_unicode_text_locked` failures that happen while the payload is
    /// still being prepared.
    ///
    /// It exists because `clipboard_restored: false` alone is ambiguous, and
    /// reads as the alarming half: "we replaced your clipboard and did not put
    /// it back". For a call that never touched it, the honest reading is "there
    /// was nothing to put back", which no other field says.
    pub clipboard_modified: bool,
    /// Whether the user's clipboard was put back (I-13). Only meaningful when
    /// `clipboard_modified` is `true`.
    pub clipboard_restored: bool,
    /// Restore was skipped because someone else wrote to the clipboard after we
    /// did (I-6). **Not** a failure: overwriting their value would be worse than
    /// leaving the user's older content lost.
    pub restore_skipped_race: bool,
    /// Restore was attempted and failed at Win32 level.
    pub restore_failed_reason: Option<String>,
    /// Formats the snapshot could not carry, so they are not coming back even on
    /// a successful restore (I-10) — an image on the clipboard is the common
    /// case. Disclosed rather than silently dropped.
    pub skipped_formats: Vec<TypeViaClipboardSkippedFormat>,
    /// Echoed so a caller — and a pin test — can see which settle was applied
    /// without reading this file.
    pub settle_ms: u32,
}

fn build_skipped(snapshot: &ClipboardSnapshot) -> Vec<TypeViaClipboardSkippedFormat> {
    snapshot
        .skipped_summary()
        .into_iter()
        .map(|(format_id, reason)| TypeViaClipboardSkippedFormat {
            format_id,
            reason: reason.to_string(),
        })
        .collect()
}

/// Whether a `set_unicode_text_locked` failure left the user's clipboard
/// changed.
///
/// `set_unicode_text_locked` is prepare-first (see its doc in
/// `clipboard_text.rs`): the payload is allocated, locked, filled and unlocked
/// BEFORE `EmptyClipboard` runs, and `EmptyClipboard` sits immediately next to
/// the `SetClipboardData` it enables. So of its three failures, only the last
/// one happens with the clipboard already emptied:
///
/// - `AllocFailed` — the allocation never succeeded, nothing was emptied;
/// - `EmptyFailed` — `EmptyClipboard` itself failed, so by definition it did
///   not clear anything, and the handle is freed on the way out;
/// - `SetDataFailed` — `EmptyClipboard` succeeded and the store did not. This
///   is the destructive one: the user's clipboard is EMPTY right now.
///
/// Extracted so the mapping is pinned against the contract it depends on rather
/// than re-derived at the call site.
fn set_failure_modified_clipboard(e: &ClipboardError) -> bool {
    matches!(e, ClipboardError::SetDataFailed { .. })
}

/// Result for a failure that happened before the chord could be considered.
/// `verify` is filled through `map_write_outcome`'s write-failure branch so the
/// record's shape never depends on where the failure occurred.
///
/// `clipboard_modified` defaults to `false` here and is raised by the one caller
/// that needs it: every OTHER path into this function failed before anything was
/// written.
fn early_fail(
    reason: &str,
    expected_bytes: u32,
    expected: &[u8],
    sequence: u32,
    skipped_formats: Vec<TypeViaClipboardSkippedFormat>,
) -> TypeViaClipboardResult {
    TypeViaClipboardResult {
        ok: false,
        reason: Some(reason.to_string()),
        verify: map_write_outcome(
            Some(reason.to_string()),
            expected_bytes,
            None,
            Err("write_failed".to_string()),
            sequence,
            expected,
        ),
        pasted: false,
        clipboard_modified: false,
        clipboard_restored: false,
        restore_skipped_race: false,
        restore_failed_reason: None,
        skipped_formats,
        settle_ms: PASTE_SETTLE_MS as u32,
    }
}

/// Fold a `RestoreOutcome` into the result. One place, so every exit path
/// reports the restore the same way.
fn apply_restore(result: &mut TypeViaClipboardResult, outcome: RestoreOutcome) {
    match outcome {
        RestoreOutcome::Restored => result.clipboard_restored = true,
        RestoreOutcome::SkippedDueToRace { .. } => result.restore_skipped_race = true,
        RestoreOutcome::Failed(e) => {
            result.restore_failed_reason = Some(e.as_reason().to_string())
        }
    }
}

// ── Blocking core ───────────────────────────────────────────────────────────

/// Put `utf16le` on the clipboard, verify it twice, paste it into whatever has
/// focus, and put the user's clipboard back. Blocking; the export below runs it
/// on a libuv worker.
///
/// **Focus is the caller's job.** Unlike `foreground_flash`, this never steals
/// the foreground: `keyboard.ts` / `terminal.ts` have already done their own
/// focus work (and their own guard evaluation) by the time they get here, and a
/// second, unasked-for foreground steal inside a "type this text" primitive
/// would be a surprise with no way to opt out.
///
/// Contention budget: three `open_clipboard_with_retry` calls (write, post-close
/// verify, restore), each absorbing up to 10x10 ms independently (I-12), plus the
/// save's own open — the bounded part. The unbounded part is `GetClipboardData`
/// against a hung delayed-rendering owner, which is why the export is async.
///
/// `deadline` is the instant after which the chord must NOT be sent — see "The
/// paste deadline" in the module doc. `None` disables the guard.
pub(crate) fn type_via_clipboard_blocking(
    utf16le: &[u8],
    combo: PasteCombo,
    deadline: Option<Instant>,
) -> TypeViaClipboardResult {
    let units = to_terminated_u16(utf16le);
    // Same `expected` construction as the clipboard tool: the payload minus the
    // terminator we appended, deliberately NOT truncated at an embedded NUL. A
    // payload containing U+0000 is unrepresentable in `CF_UNICODETEXT` and every
    // reader would see a short string, so it must fail verification (and
    // therefore never reach the paste) rather than silently paste a prefix.
    let expected: Vec<u8> = units[..units.len() - 1]
        .iter()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let expected_bytes = expected.len() as u32;

    let inner = with_hidden_owner(|owner: HWND| -> TypeViaClipboardResult {
        // ── 1. Save the user's clipboard (3-point sequence, 1st point) ──────
        let snapshot = match save_clipboard_supported_formats(owner) {
            // Nothing has been touched yet, so there is nothing to restore and
            // nothing to paste.
            Err(e) => {
                return early_fail(
                    e.as_reason(),
                    expected_bytes,
                    &expected,
                    get_clipboard_sequence_number(),
                    Vec::new(),
                )
            }
            Ok(s) => s,
        };
        let skipped_formats = build_skipped(&snapshot);

        // ── 2. Transaction 1: set + in-session verify ① ─────────────────────
        if let Err(e) = open_clipboard_with_retry(owner) {
            return early_fail(
                e.as_reason(),
                expected_bytes,
                &expected,
                get_clipboard_sequence_number(),
                skipped_formats,
            );
        }
        let set_result = unsafe { set_unicode_text_locked(&units) };
        let in_session = match &set_result {
            Ok(()) => in_session_leg(unsafe { read_unicode_text_locked() }),
            // The set failed, so there is nothing of ours to read back.
            Err(_) => None,
        };
        unsafe {
            let _ = CloseClipboard();
        }
        // The 3-point race anchor, taken right after the set — the same position
        // as `console_paste.rs` and `set_clipboard_unicode_text`. It has to be
        // after `CloseClipboard`, because that is where the OS synthesises
        // CF_LOCALE / CF_TEXT / CF_OEMTEXT and bumps the sequence three more
        // times (measured, ADR-033 P0-2). Anchoring before the close would make
        // the restore below see its own synthesis as somebody else's write.
        let seq_after_set = get_clipboard_sequence_number();

        if let Err(e) = set_result {
            // `set_unicode_text_locked` prepares the payload before it empties
            // (its doc in `clipboard_text.rs` spells the ordering out), so only
            // a `SetClipboardData` failure can leave the clipboard emptied. The
            // restore is what puts the user's content back in that case — the
            // pre-native TS path threw before restoring and left them with
            // whatever state the failure produced (I-33).
            //
            // For the other two failures the clipboard is untouched, and the
            // restore is SKIPPED rather than run: writing the snapshot back
            // over content that is still there changes nothing except the
            // sequence number, and a bump would make the next writer's race
            // check see a stranger where there was none. It would also
            // contradict what this call is about to report — `modified: false`
            // and "restored" cannot both be true of the same clipboard.
            let modified = set_failure_modified_clipboard(&e);
            let mut r = early_fail(
                e.as_reason(),
                expected_bytes,
                &expected,
                seq_after_set,
                skipped_formats,
            );
            r.clipboard_modified = modified;
            if !modified {
                return r;
            }
            let restore = restore_clipboard_supported_formats(&snapshot, owner, seq_after_set);
            apply_restore(&mut r, restore);
            return r;
        }

        // ── 3. Transaction 2: post-close re-verify ② ────────────────────────
        // A read-only open does not bump the sequence number, so this cannot
        // disturb the race anchor taken above.
        let post_close = match open_clipboard_with_retry(owner) {
            Ok(()) => {
                let b = unsafe { read_unicode_text_locked() };
                unsafe {
                    let _ = CloseClipboard();
                }
                post_close_leg(b)
            }
            Err(e) => Err(e.as_reason().to_string()),
        };

        // ── 4. Verdict → paste decision ─────────────────────────────────────
        let verify = map_write_outcome(
            None,
            expected_bytes,
            in_session,
            post_close,
            seq_after_set,
            &expected,
        );

        let mut pasted = false;
        let mut reason = verify.reason.clone();
        // The gate. I-3 lives in `chord_decision`: the chord below is
        // unreachable unless the payload was proven to be on the clipboard —
        // and, now, unless there is still time for the caller to receive the
        // result. Checked HERE rather than earlier because the deadline can
        // pass during any of the three clipboard transactions above, and the
        // instant that matters is the one just before the keystroke goes out.
        match chord_decision(verify.ok, deadline, Instant::now()) {
            ChordDecision::Send => {
                if send_paste_combo(combo) {
                    pasted = true;
                    // ── 5. Settle ──────────────────────────────────────────
                    std::thread::sleep(Duration::from_millis(PASTE_SETTLE_MS));
                } else {
                    reason = Some("send_input_failed".to_string());
                }
            }
            ChordDecision::SkipDeadlineExceeded => {
                reason = Some("paste_deadline_exceeded".to_string());
            }
            // `reason` already carries the verdict's own, more specific
            // explanation (`readback_mismatch` and friends).
            ChordDecision::SkipUnverified => {}
        }

        // ── 6. Restore — always attempted, the 3-point race decides ─────────
        // Including on the failure paths: the point of saving was to be able to
        // give the clipboard back, and a verification failure is exactly when
        // the user is most likely to be left holding our payload otherwise. When
        // ② failed because somebody else wrote (`clipboard_replaced_after_write`)
        // the sequence has moved, and the race check skips the restore — which
        // is correct, not a miss: their value must not be clobbered (I-6).
        let restore = restore_clipboard_supported_formats(&snapshot, owner, seq_after_set);

        let mut result = TypeViaClipboardResult {
            ok: verify.ok && pasted,
            reason,
            verify,
            pasted,
            // The set succeeded to get here, so `EmptyClipboard` ran and the
            // user's content is gone until the restore below puts it back.
            clipboard_modified: true,
            clipboard_restored: false,
            restore_skipped_race: false,
            restore_failed_reason: None,
            skipped_formats,
            settle_ms: PASTE_SETTLE_MS as u32,
        };
        apply_restore(&mut result, restore);
        result
    });

    inner.unwrap_or_else(|e| {
        early_fail(
            e.as_reason(),
            expected_bytes,
            &expected,
            get_clipboard_sequence_number(),
            Vec::new(),
        )
    })
}

// ── napi entry point (async — see the module doc) ───────────────────────────

pub struct TypeViaClipboardTask {
    utf16le: Vec<u8>,
    combo: PasteCombo,
    /// Absolute instant after which the chord must not be sent. Computed in the
    /// factory below — i.e. when the CALL was made, not when the pool got round
    /// to it — so time spent queued counts against the budget exactly as it
    /// does against the caller's own timeout.
    deadline: Option<Instant>,
}

impl Task for TypeViaClipboardTask {
    type Output = TypeViaClipboardResult;
    type JsValue = TypeViaClipboardResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        napi_safe_call("win32_type_via_clipboard", || {
            Ok(type_via_clipboard_blocking(
                &self.utf16le,
                self.combo,
                self.deadline,
            ))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Put `utf16le` on the clipboard, verify it, paste it with `pasteCombo`, and
/// restore the user's clipboard.
///
/// UTF-16LE bytes rather than a string for the same reason as
/// `win32_clipboard_write_text_verified`: napi's String bridge transcodes
/// through UTF-8 and would replace an unpaired surrogate with U+FFFD *before*
/// the byte comparison ran, so the verification would pass on mutated text.
///
/// `paste_combo` is `"ctrl+v"` or `"ctrl+shift+v"`. Anything else rejects
/// immediately — see `PasteCombo::parse`. This is the only way this export
/// throws; every Win32 failure is reported in the resolved value instead.
///
/// The `AbortSignal` cancels a task that is still QUEUED on libuv's pool, which
/// matters when an earlier call against a hung clipboard owner has saturated it.
/// It does NOT stop a task that is already running, which is what
/// `paste_deadline_budget_ms` is for: the chord is refused once that many
/// milliseconds have passed since this call, so a task the caller has given up
/// on cannot surface as a keystroke in an unrelated window minutes later. Pass
/// `None` to disable the guard.
///
/// The clock starts HERE, on the JS thread, so queue time counts — it is the
/// same clock the caller's own timeout runs on, give or take the call itself.
#[napi]
pub fn win32_type_via_clipboard(
    utf16le: Buffer,
    paste_combo: String,
    paste_deadline_budget_ms: Option<u32>,
    signal: Option<AbortSignal>,
) -> napi::Result<AsyncTask<TypeViaClipboardTask>> {
    let combo = PasteCombo::parse(&paste_combo)
        .ok_or_else(|| napi::Error::from_reason("invalid_paste_combo".to_string()))?;
    // `checked_add` rather than `+`: an absurd budget would otherwise panic on
    // overflow. Falling back to `None` degrades to the pre-guard behaviour,
    // which is the right way round — a nonsense budget must not make the paste
    // impossible.
    let deadline = paste_deadline_budget_ms
        .and_then(|ms| Instant::now().checked_add(Duration::from_millis(ms as u64)));
    Ok(AsyncTask::with_optional_signal(
        TypeViaClipboardTask {
            utf16le: utf16le.to_vec(),
            combo,
            deadline,
        },
        signal,
    ))
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod harness;

#[cfg(test)]
mod tests {
    use super::harness::{key_recorder, EditWindow};
    use super::*;
    use crate::win32::clipboard_text::test_support::ClipboardGuard;
    use crate::win32::clipboard_text::{read_text_blocking, write_text_verified_blocking};
    use std::time::Duration;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LCONTROL, VK_LSHIFT};

    fn utf16le(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    /// CJK + astral emoji + ASCII. No newline: a multiline EDIT keeps CRLF
    /// verbatim, but mixing line-break handling into a byte-exactness claim
    /// would only blur what the test proves.
    const PAYLOAD: &str = "日本語テスト😀 mixed ABC";
    /// What the user's clipboard holds before each real-clipboard test, so
    /// "restored" is a byte comparison rather than a boolean we set ourselves.
    const SENTINEL: &str = "adr-033-sentinel-クリップボード";

    // ── Pure (no Win32) ────────────────────────────────────────────────────

    #[test]
    fn settle_is_120ms_and_not_the_foreground_flash_30ms() {
        // I-32. The failure this pins is a quiet one: someone factors the paste
        // chord together with `foreground_flash`'s and inherits its 30 ms
        // settle, and the only symptom is an occasional paste of the user's
        // OLD clipboard content on a slower target.
        assert_eq!(PASTE_SETTLE_MS, 120);
        // And the value the caller is told matches the one actually slept.
        assert_eq!(
            early_fail("x", 0, &[], 0, Vec::new()).settle_ms as u64,
            PASTE_SETTLE_MS
        );
    }

    #[test]
    fn combo_key_sequences_are_symmetric_and_modifier_outermost() {
        assert_eq!(
            PasteCombo::CtrlV.keys(),
            vec![
                (VK_CONTROL, false),
                (VK_V, false),
                (VK_V, true),
                (VK_CONTROL, true)
            ]
        );
        let sv = PasteCombo::CtrlShiftV.keys();
        assert_eq!(sv.len(), 6);
        // Every key that goes down comes back up, and the downs unwind in
        // reverse — the property that makes "no stuck modifier" structural.
        let downs: Vec<_> = sv.iter().filter(|(_, up)| !*up).map(|(k, _)| *k).collect();
        let ups: Vec<_> = sv.iter().filter(|(_, up)| *up).map(|(k, _)| *k).collect();
        assert_eq!(downs, vec![VK_CONTROL, VK_SHIFT, VK_V]);
        assert_eq!(ups, vec![VK_V, VK_SHIFT, VK_CONTROL]);
    }

    /// What gets released when `SendInput` only inserts part of the batch.
    ///
    /// The property that matters is "nothing the batch would have pressed is
    /// left down", so this is derived from the down events rather than
    /// hard-coded per combo — a chord that grew a fourth key would otherwise
    /// leave it held with every existing assertion still green.
    #[test]
    fn compensating_keyups_release_every_down_in_reverse() {
        for combo in [PasteCombo::CtrlV, PasteCombo::CtrlShiftV] {
            let seq = combo.keys();
            let ups = compensating_keyups(&seq);

            let downs: Vec<VIRTUAL_KEY> = seq
                .iter()
                .filter(|(_, up)| !*up)
                .map(|(k, _)| *k)
                .collect();
            let expected: Vec<(VIRTUAL_KEY, bool)> =
                downs.iter().rev().map(|k| (*k, true)).collect();
            assert_eq!(ups, expected, "{combo:?}");
            // Every generated event is a key-up — sending a key DOWN here would
            // make the cleanup the very thing it exists to prevent.
            assert!(ups.iter().all(|(_, up)| *up), "{combo:?}");
        }

        // Spelled out for the chord that actually has a modifier to strand.
        assert_eq!(
            compensating_keyups(&PasteCombo::CtrlShiftV.keys()),
            vec![(VK_V, true), (VK_SHIFT, true), (VK_CONTROL, true)]
        );
        // Nothing to release when the batch pressed nothing.
        assert!(compensating_keyups(&[]).is_empty());
        assert!(compensating_keyups(&[(VK_CONTROL, true)]).is_empty());
    }

    #[test]
    fn combo_parse_rejects_anything_but_the_two_wire_values() {
        assert_eq!(PasteCombo::parse("ctrl+v"), Some(PasteCombo::CtrlV));
        assert_eq!(
            PasteCombo::parse("ctrl+shift+v"),
            Some(PasteCombo::CtrlShiftV)
        );
        // No case folding, no whitespace tolerance, no aliases: a chord that
        // "nearly parsed" would be sent to a live terminal.
        assert_eq!(PasteCombo::parse("ctrl+shift+V"), None);
        assert_eq!(PasteCombo::parse("ctrl+V"), None);
        assert_eq!(PasteCombo::parse(" ctrl+v"), None);
        assert_eq!(PasteCombo::parse(""), None);
    }

    /// The composite's "may I paste" answer IS `map_write_outcome`'s verdict, so
    /// the three-valued rule is pinned against the function that decides it.
    #[test]
    fn paste_decision_follows_the_three_valued_post_close_rule() {
        let e = utf16le("hello");
        let verdict = |in_session: Option<Vec<u8>>, post: Result<Vec<u8>, String>| {
            map_write_outcome(None, e.len() as u32, in_session, post, 1, &e).ok
        };
        // (a) checked + match → paste
        assert!(verdict(Some(e.clone()), Ok(e.clone())));
        // (b) checked + mismatch → do NOT paste (a clipboard manager / DLP agent
        //     replaced the payload; pasting would type someone else's text)
        assert!(!verdict(Some(e.clone()), Ok(utf16le("other"))));
        // (c) not checked — the re-open lost a race for the lock → paste anyway.
        //     ① already proved the store, and contention on a VERIFICATION read
        //     is not evidence of loss. Suppressing the paste here would make
        //     type/send silently no-op under clipboard contention.
        assert!(verdict(
            Some(e.clone()),
            Err("clipboard_lock_contention".into())
        ));
        // ① readable but wrong → do NOT paste (I-3)
        assert!(!verdict(Some(utf16le("hell")), Ok(e.clone())));
        // Neither leg observed anything → nothing backs the write → do not paste
        assert!(!verdict(None, Err("clipboard_lock_contention".into())));
    }

    /// The gate, all four combinations. No clipboard involved — which is the
    /// point of the gate being a function.
    #[test]
    fn the_chord_gate_refuses_an_unverified_payload_and_a_missed_deadline() {
        let now = Instant::now();
        let future = now + Duration::from_secs(1);
        let past = now - Duration::from_millis(1);

        assert_eq!(chord_decision(true, Some(future), now), ChordDecision::Send);
        // No budget = no deadline. The guard is opt-in, not mandatory.
        assert_eq!(chord_decision(true, None, now), ChordDecision::Send);
        assert_eq!(
            chord_decision(true, Some(past), now),
            ChordDecision::SkipDeadlineExceeded
        );
        // Exactly at the deadline counts as past it: the budget is what is
        // still LEFT, and nothing is left at zero.
        assert_eq!(
            chord_decision(true, Some(now), now),
            ChordDecision::SkipDeadlineExceeded
        );
        // An unverified payload is refused whether or not there is time, and
        // the verdict's own reason is the one that gets reported (I-3 outranks
        // the deadline — pasting the wrong text is worse than pasting late).
        assert_eq!(
            chord_decision(false, Some(future), now),
            ChordDecision::SkipUnverified
        );
        assert_eq!(
            chord_decision(false, Some(past), now),
            ChordDecision::SkipUnverified
        );
        assert_eq!(chord_decision(false, None, now), ChordDecision::SkipUnverified);
    }

    /// Which `set_unicode_text_locked` failures leave the user's clipboard
    /// changed. All three variants, so adding a fourth forces a decision here
    /// rather than defaulting into "untouched" and telling the user their
    /// clipboard is fine when it is empty.
    #[test]
    fn only_a_failed_store_leaves_the_clipboard_modified() {
        // `EmptyClipboard` succeeded and `SetClipboardData` did not: the
        // clipboard is EMPTY right now. The one destructive failure, and the
        // one that must still be restored.
        assert!(set_failure_modified_clipboard(&ClipboardError::SetDataFailed {
            format_id: 13,
            win32_error: 5,
        }));

        // Prepare-first: neither of these got as far as clearing anything.
        assert!(!set_failure_modified_clipboard(&ClipboardError::AllocFailed));
        assert!(!set_failure_modified_clipboard(&ClipboardError::EmptyFailed {
            win32_error: 5
        }));

        // Not reachable from `set_unicode_text_locked`, but the predicate is
        // total and must not answer "modified" for a failure that never
        // reached the write at all.
        assert!(!set_failure_modified_clipboard(&ClipboardError::OpenContention));
        assert!(!set_failure_modified_clipboard(
            &ClipboardError::HiddenOwnerCreateFailed { win32_error: 5 }
        ));
    }

    #[test]
    fn early_failures_report_no_paste_and_no_restore() {
        // Everything that fails before the set is a state the user's clipboard
        // never left, so claiming a restore would be as wrong as claiming a
        // paste.
        let r = early_fail("clipboard_lock_contention", 10, &utf16le("hello"), 7, Vec::new());
        assert!(!r.ok);
        assert!(!r.pasted);
        // The distinction the caller needs: nothing was replaced, so
        // `restored:false` means "there was nothing to put back" rather than
        // "we kept your clipboard".
        assert!(!r.clipboard_modified);
        assert!(!r.clipboard_restored);
        assert!(!r.restore_skipped_race);
        assert!(r.restore_failed_reason.is_none());
        assert_eq!(r.reason.as_deref(), Some("clipboard_lock_contention"));
        // The verification record still has the write-failure shape rather than
        // a fabricated mismatch.
        assert!(!r.verify.ok);
        assert!(!r.verify.in_session_readable);
        assert_eq!(r.verify.post_close_skip_reason.as_deref(), Some("write_failed"));
        assert_eq!(r.verify.sequence_after_write, 7);
    }

    /// I-33's second branch, and I-6. `restore_clipboard_supported_formats`
    /// decides between these three; this pins how each one is published, since
    /// "we did not restore" and "we deliberately did not clobber another
    /// process" are opposite facts for a caller.
    #[test]
    fn restore_outcomes_are_published_as_three_distinct_facts() {
        let mut restored = early_fail("x", 0, &[], 0, Vec::new());
        apply_restore(&mut restored, RestoreOutcome::Restored);
        assert!(restored.clipboard_restored);
        assert!(!restored.restore_skipped_race);
        assert!(restored.restore_failed_reason.is_none());

        let mut raced = early_fail("x", 0, &[], 0, Vec::new());
        apply_restore(
            &mut raced,
            RestoreOutcome::SkippedDueToRace {
                observed_seq: 9,
                expected_seq: 4,
            },
        );
        // NOT restored, and the reason is that someone else owns the clipboard
        // now — overwriting them would be worse than the loss (I-6).
        assert!(!raced.clipboard_restored);
        assert!(raced.restore_skipped_race);
        assert!(raced.restore_failed_reason.is_none());

        let mut failed = early_fail("x", 0, &[], 0, Vec::new());
        apply_restore(
            &mut failed,
            RestoreOutcome::Failed(super::super::clipboard_snapshot::ClipboardError::OpenContention),
        );
        assert!(!failed.clipboard_restored);
        assert!(!failed.restore_skipped_race);
        assert_eq!(
            failed.restore_failed_reason.as_deref(),
            Some("clipboard_lock_contention")
        );
    }

    // ── Real desktop (`#[ignore]`) ─────────────────────────────────────────
    //
    // These take the foreground, replace the clipboard and inject keystrokes.
    // Every one of them targets a window THIS process created and destroys it
    // again, so nothing is ever pasted into the developer's applications, and
    // every one holds a `ClipboardGuard` that puts the clipboard back even when
    // an assertion unwinds.
    //
    // Run:  npm run test:native-clipboard
    //       (cargo test -p desktop-touch-engine --locked clipboard -- --ignored
    //        --test-threads=1 — the clipboard is one global resource, so a
    //        parallel sibling writing to it would fail these for a wrong reason.)

    struct Fixture {
        _guard: ClipboardGuard,
        win: EditWindow,
    }

    impl Fixture {
        /// Puts `SENTINEL` on the clipboard as the "user's content", so every
        /// restore claim below is a byte comparison against something specific.
        fn new() -> Self {
            let guard = ClipboardGuard::snapshot();
            let win = EditWindow::spawn();
            assert!(
                win.focus(),
                "could not bring the test EDIT window to the foreground"
            );
            assert!(
                write_text_verified_blocking(&utf16le(SENTINEL)).ok,
                "could not stage the sentinel clipboard content"
            );
            Self {
                _guard: guard,
                win,
            }
        }
    }

    fn assert_no_modifier_stuck(label: &str) {
        for (name, vk) in [
            ("VK_CONTROL", VK_CONTROL),
            ("VK_SHIFT", VK_SHIFT),
            ("VK_V", VK_V),
            ("VK_LCONTROL", VK_LCONTROL),
            ("VK_LSHIFT", VK_LSHIFT),
        ] {
            let state = unsafe { GetAsyncKeyState(vk.0 as i32) };
            assert_eq!(
                state as u16 & 0x8000,
                0,
                "{label}: {name} is still down after the chord (GetAsyncKeyState={state:#06x})"
            );
        }
    }

    /// The whole composite, end to end: the payload lands in the target
    /// byte-exactly, no modifier is left down, and the user's clipboard comes
    /// back (I-13).
    #[test]
    #[ignore = "副作用: foreground 奪取 + clipboard 書換 + SendInput"]
    fn real_clipboard_composite_pastes_byte_exactly_and_restores() {
        let f = Fixture::new();
        let payload = utf16le(PAYLOAD);

        let r = type_via_clipboard_blocking(&payload, PasteCombo::CtrlV, None);
        assert!(r.ok, "composite failed: {:?}", r.reason);
        assert!(r.pasted);
        assert!(r.verify.ok);
        assert_eq!(r.settle_ms as u64, PASTE_SETTLE_MS);

        let got = f.win.wait_for_text(&payload, Duration::from_millis(1000));
        assert_eq!(got, payload, "the paste was not byte-exact");

        assert_no_modifier_stuck("ctrl+v");

        assert!(r.clipboard_restored, "restore did not run: {:?}", r.restore_failed_reason);
        assert!(!r.restore_skipped_race);
        let after = read_text_blocking();
        assert!(after.ok, "post-restore read failed: {:?}", after.reason);
        assert_eq!(
            &*after.bytes,
            utf16le(SENTINEL).as_slice(),
            "the user's clipboard was not put back"
        );
    }

    /// The same composite on a thread that was never given a message pump —
    /// the closest stand-in for the libuv worker the napi export runs on.
    ///
    /// This is the claim that lets the export be async at all: the clipboard
    /// transactions, the hidden owner window's create/destroy and `SendInput`
    /// all have to work without a pump behind them.
    #[test]
    #[ignore = "副作用: foreground 奪取 + clipboard 書換 + SendInput"]
    fn real_clipboard_composite_works_on_a_thread_without_a_message_pump() {
        let f = Fixture::new();
        let payload = utf16le(PAYLOAD);

        let p = payload.clone();
        let r = std::thread::spawn(move || type_via_clipboard_blocking(&p, PasteCombo::CtrlV, None))
            .join()
            .expect("the worker thread panicked");

        assert!(r.ok, "composite failed on a pumpless thread: {:?}", r.reason);
        let got = f.win.wait_for_text(&payload, Duration::from_millis(1000));
        assert_eq!(got, payload, "the paste from a pumpless thread was not byte-exact");
        assert_no_modifier_stuck("ctrl+v (pumpless)");
        assert_eq!(
            &*read_text_blocking().bytes,
            utf16le(SENTINEL).as_slice(),
            "the user's clipboard was not put back"
        );
    }

    /// I-3 and I-33's first branch, forced deterministically.
    ///
    /// An embedded NUL cannot be represented in `CF_UNICODETEXT`: the format is
    /// NUL-terminated, so a reader sees a truncated string and the in-session
    /// read-back mismatches. That makes it the one verification failure that can
    /// be produced on demand, without a second process racing us — and it
    /// exercises exactly the two behaviours that matter:
    ///
    /// - **no chord is sent** (I-3) — the target window stays empty, which is
    ///   also why this test is safe to run: a regression here would be visible
    ///   as text in our own window rather than in someone's editor;
    /// - **the user's clipboard is restored anyway** (I-33) — the TS path this
    ///   replaces threw before its restore, leaving the user holding the
    ///   truncated payload.
    #[test]
    #[ignore = "副作用: foreground 奪取 + clipboard 書換"]
    fn real_clipboard_a_failed_verification_pastes_nothing_and_still_restores() {
        let f = Fixture::new();
        f.win.clear();

        let r = type_via_clipboard_blocking(&utf16le("before\u{0}after"), PasteCombo::CtrlV, None);

        assert!(!r.ok);
        assert!(!r.pasted, "a chord was sent for an unverified payload (I-3)");
        assert_eq!(r.verify.reason.as_deref(), Some("readback_mismatch"));
        assert!(r.verify.in_session_readable, "the leg read; it read the wrong thing");

        // Nothing reached the target.
        std::thread::sleep(Duration::from_millis(120));
        assert!(
            f.win.text().is_empty(),
            "text reached the target for a payload that failed verification"
        );

        // ...and the clipboard is the user's again. Nobody else wrote, so the
        // race check cannot be what skipped it.
        assert!(!r.restore_skipped_race);
        assert!(
            r.clipboard_restored,
            "restore did not run: {:?}",
            r.restore_failed_reason
        );
        assert_eq!(
            &*read_text_blocking().bytes,
            utf16le(SENTINEL).as_slice(),
            "the user's clipboard was not put back after a failed verification"
        );
    }

    /// The deadline guard, end to end.
    ///
    /// `chord_decision` is unit-tested above without Win32; what this adds is
    /// that the sequence HONOURS it — the whole transaction runs, the chord is
    /// refused, and the clipboard is still handed back. An already-expired
    /// deadline stands in for the real case (the save blocked for minutes on a
    /// hung clipboard owner) without needing one.
    ///
    /// `#[ignore]`d rather than pure because it exercises the real sequence:
    /// the failure it guards against is not "the gate returns the wrong
    /// answer", it is "the gate exists and the code walks past it".
    #[test]
    #[ignore = "副作用: foreground 奪取 + clipboard 書換"]
    fn real_clipboard_an_expired_deadline_refuses_the_chord_and_still_restores() {
        let f = Fixture::new();
        f.win.clear();

        let expired = Instant::now() - Duration::from_millis(1);
        let payload = utf16le(PAYLOAD);
        let r = type_via_clipboard_blocking(&payload, PasteCombo::CtrlV, Some(expired));

        // The payload WAS on the clipboard — this is not a verification
        // failure, which is what makes it a different branch.
        assert!(r.verify.ok, "verification should have passed: {:?}", r.verify.reason);
        assert!(!r.pasted, "a chord was sent after the deadline");
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("paste_deadline_exceeded"));

        // Nothing reached the target.
        std::thread::sleep(Duration::from_millis(120));
        assert!(
            f.win.text().is_empty(),
            "text reached the target after the deadline had passed"
        );

        // ...and the user's clipboard came back. A late restore is safe because
        // the race check is what decides it: nobody wrote here, so it ran.
        assert!(
            r.clipboard_restored,
            "restore did not run: {:?}",
            r.restore_failed_reason
        );
        assert_eq!(
            &*read_text_blocking().bytes,
            utf16le(SENTINEL).as_slice(),
            "the user's clipboard was not put back"
        );
    }

    /// What Ctrl+Shift+V actually emits.
    ///
    /// An `EDIT` control does not act on Ctrl+Shift+V, so what is provable here
    /// is the EMISSION — recorded through `WH_KEYBOARD_LL`, i.e. what the rest
    /// of the desktop sees rather than what we believe we sent. That it pastes
    /// in Windows Terminal is a claim about WT and belongs to the e2e coverage
    /// of the `terminal` `preferClipboard` path.
    ///
    /// The scan codes are asserted because they are the whole of R-d: the nut.js
    /// path this replaces carried them, and a consumer that reads `wScan`
    /// (DirectInput / Raw Input, scan-code-forwarding remote clients) would see
    /// a dead key without them.
    #[test]
    #[ignore = "副作用: SendInput + LowLevel keyboard hook install"]
    fn real_desktop_ctrl_shift_v_emits_the_expected_event_sequence() {
        let f = Fixture::new();
        let rec = match key_recorder::start() {
            Some(r) => r,
            None => {
                // Reported rather than silently passed: an unavailable hook
                // means this ran no claim at all.
                eprintln!("UNVERIFIED: SetWindowsHookEx(WH_KEYBOARD_LL) was refused");
                return;
            }
        };
        std::thread::sleep(Duration::from_millis(30));
        rec.clear();

        assert!(send_paste_combo(PasteCombo::CtrlShiftV));
        std::thread::sleep(Duration::from_millis(80));
        let events = rec.take();
        drop(rec);
        drop(f);

        let ours: Vec<(u32, u32, bool)> = events
            .iter()
            .filter(|(_, _, _, injected)| *injected)
            .map(|(vk, scan, up, _)| (*vk, *scan, *up))
            .collect();
        eprintln!("[ctrl+shift+v] injected (vk, scan, is_up) = {ours:?}");

        // The hook reports the OS's left-hand resolution of the generic
        // modifiers we send; both spellings are the same physical claim.
        let norm = |vk: u32| match vk {
            0xA2 | 0xA3 => 0x11u32, // L/R CONTROL -> CONTROL
            0xA0 | 0xA1 => 0x10u32, // L/R SHIFT   -> SHIFT
            other => other,
        };
        let seq: Vec<(u32, bool)> = ours.iter().map(|(vk, _, up)| (norm(*vk), *up)).collect();
        assert_eq!(
            seq,
            vec![
                (0x11, false), // ctrl down
                (0x10, false), // shift down
                (0x56, false), // v down
                (0x56, true),  // v up
                (0x10, true),  // shift up
                (0x11, true),  // ctrl up
            ],
            "ctrl+shift+v event sequence"
        );
        assert!(
            ours.iter().all(|(_, scan, _)| *scan != 0),
            "a scan code was left at 0 — the nut.js path this replaces filled them (R-d): {ours:?}"
        );

        assert_no_modifier_stuck("ctrl+shift+v");
    }
}
