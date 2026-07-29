//! ADR-033 — native `CF_UNICODETEXT` clipboard read / write-with-read-back.
//!
//! # Why this module exists
//!
//! `src/tools/clipboard.ts` reached the clipboard by spawning
//! `powershell.exe -Command "<inline script>"` carrying a base64 blob plus
//! `[Convert]::FromBase64String(...)` and `Set-Clipboard`. That command line is
//! the shape of a well-known malware TTP (base64 payload decoded inline by
//! PowerShell), and Microsoft Defender scored the MCP server process as
//! `Trojan:Win32/Commando.A!ml` and killed it mid-session. Doing the clipboard
//! transaction in-process removes the spawn, so there is no command line left
//! for a heuristic to score. It is also far faster — measured on this branch,
//! n=20: write+verify p50 4.15 ms against 349 ms (~84x), read p50 2.48 ms
//! against 296 ms (~119x) — and it lifts the ~12 150-character command-line
//! ceiling that silently capped a tool whose schema advertises 100 000.
//!
//! # The issue #180 contract, kept and strengthened (I-1)
//!
//! `clipboard(action='write')` must prove delivery by reading the clipboard
//! back and comparing bytes (UTF-16LE — the `CF_UNICODETEXT` encoding). This
//! module verifies **twice**, and the two legs answer different questions:
//!
//! 1. **in-session read-back** — `GetClipboardData(CF_UNICODETEXT)` while we
//!    still hold the clipboard open. No other process can interleave, so a
//!    mismatch here means the OS (or a filter driver) did not store the bytes
//!    we handed it. Reported as `readback_mismatch`.
//! 2. **post-close read-back** — re-open after `CloseClipboard` and compare
//!    again. Clipboard managers, DLP agents and RDP/Citrix redirectors only
//!    receive `WM_CLIPBOARDUPDATE` once the lock is released, so an interceptor
//!    that swaps the payload is visible *only* here. This is the leg with the
//!    same semantics as the old `Set-Clipboard; Get-Clipboard -Raw` pair.
//!    Reported as `clipboard_replaced_after_write`.
//!
//! Losing the race to re-open for leg 2 is **not** a failed write: leg 1
//! already proved the store, and contention on a verification read is not
//! evidence that anything was lost. That case reports `post_close_checked=false`
//! and leaves `ok=true` (plan D-2/D-5).
//!
//! The same reasoning runs in the other direction, and the verdict honours it:
//! if leg 1 could not be read at all (`in_session_readable=false`) but leg 2 ran
//! and matched, the write stands. Leg 2 is the leg with the old PowerShell
//! pair's semantics, so its agreement is the same evidence of delivery that
//! shipped for years — refusing it because a *different* verification read
//! failed would report a delivered write as lost. The caller is told which leg
//! answered, so this is disclosed rather than hidden.
//!
//! **The verdict is the byte comparison, never the sequence number** (plan
//! D-5). `sequence_after_write` is diagnostic only. Measured on Windows 11
//! (ADR-033 P0-2): one `EmptyClipboard`+`SetClipboardData(CF_UNICODETEXT)`
//! transaction bumps `GetClipboardSequenceNumber` **5** times — 1 for the empty,
//! 1 for the set, and **3 more inside `CloseClipboard`** as the OS synthesises
//! `CF_LOCALE` / `CF_TEXT` / `CF_OEMTEXT`. Reading those synthesised formats
//! afterwards bumps nothing. So a sequence-based verdict would have to know the
//! magic number 5; a content comparison does not.
//!
//! # Encoding: why `Buffer` and not `String`
//!
//! napi's `String` bridge transcodes through UTF-8. A JS string is UTF-16 and
//! may legally contain an unpaired surrogate (`"\uD800"`), which UTF-8 cannot
//! represent — napi substitutes U+FFFD. A `String` parameter would therefore
//! mutate the payload *before* the byte comparison ran and the comparison would
//! then pass on the mutated text, i.e. the verification would be lying. Taking
//! UTF-16LE bytes is lossless, matches `CF_UNICODETEXT` exactly, and skips a
//! UTF-8 transcode of the payload in both directions.
//!
//! # HGLOBAL ownership rules (I-9 — identical to `clipboard_snapshot.rs`)
//!
//! - `GlobalAlloc(GMEM_MOVEABLE, n)` → `GlobalLock` → copy → `GlobalUnlock`.
//! - `SetClipboardData` **success** ⇒ the handle belongs to the OS and must NOT
//!   be freed by us.
//! - `SetClipboardData` **failure** ⇒ ownership never transferred and we MUST
//!   `GlobalFree` it. A `GlobalLock` failure right after the alloc frees too.
//!   Both branches are explicit: a leak here is `byte_len` per failed write and
//!   the schema ceiling makes that 200 KB at a time.
//! - `GetClipboardData` returns an **OS-owned** handle: `GlobalLock` /
//!   `GlobalUnlock` only, never `GlobalFree`, and the pointer dies at
//!   `CloseClipboard`.
//! - `EmptyClipboard` must precede every `SetClipboardData` (the caller has to
//!   own the clipboard to set data).

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};

use super::clipboard_snapshot::{
    get_clipboard_sequence_number, global_free, open_clipboard_with_retry, with_hidden_owner,
    ClipboardError, CF_UNICODETEXT,
};
use super::safety::napi_safe_call;

// ── Result types (napi objects) ─────────────────────────────────────────────

/// Outcome of `win32_clipboard_read_text`.
///
/// Never throws on a Win32 failure — failures come back as `ok=false` +
/// `reason` (one of `ClipboardError::as_reason()` or
/// `clipboard_get_data_failed`), the `ConsolePasteResult` idiom.
#[napi(object)]
pub struct ClipboardReadResult {
    pub ok: bool,
    pub reason: Option<String>,
    /// `true` when `CF_UNICODETEXT` was available (directly, or synthesised by
    /// the OS from `CF_TEXT` / `CF_OEMTEXT`). `false` for an empty clipboard or
    /// a non-text payload (image, files); `bytes` is then empty, which the TS
    /// layer maps to `""` per the tool's documented contract.
    pub has_text: bool,
    /// Clipboard text as UTF-16LE bytes, NUL terminator stripped. Named `bytes`
    /// rather than `utf16le` because napi-rs' snake→camel conversion
    /// capitalises the letter after a digit run and would surface the field to
    /// JS as the typo-looking `utf16Le`.
    pub bytes: Buffer,
}

/// Outcome of `win32_clipboard_write_text_verified`.
///
/// `ok` is the issue #180 delivery verdict: the write succeeded AND the
/// read-backs that ran matched byte-for-byte. Byte *counts* are reported
/// instead of the read-back text itself — on a mismatch that text belongs to
/// another process, and a racing app may have just put a password or an API key
/// on the clipboard (I-2).
#[napi(object)]
pub struct ClipboardWriteVerifyResult {
    pub ok: bool,
    pub reason: Option<String>,
    /// UTF-16LE byte length of the payload we asked the OS to store
    /// (NUL terminator excluded).
    pub expected_bytes: u32,
    /// Whether the in-session read-back could be read at all. `false` means
    /// `GetClipboardData` failed or the handle could not be locked, so
    /// `in_session_bytes` / `in_session_match` carry no information — without
    /// this flag a caller cannot tell "read back 0 bytes" from "did not read".
    pub in_session_readable: bool,
    /// Bytes read back while still holding the clipboard open.
    pub in_session_bytes: u32,
    pub in_session_match: bool,
    /// Whether the post-`CloseClipboard` re-read ran at all. `false` means the
    /// clipboard could not be re-opened — see `post_close_skip_reason`. It does
    /// NOT make the write a failure.
    pub post_close_checked: bool,
    pub post_close_bytes: u32,
    pub post_close_match: bool,
    pub post_close_skip_reason: Option<String>,
    /// `GetClipboardSequenceNumber` taken after our write closed the clipboard,
    /// i.e. after the OS finished synthesising `CF_TEXT` / `CF_OEMTEXT` /
    /// `CF_LOCALE`. **Diagnostic only** — the verdict is the byte comparison
    /// (plan D-5). Exposed because it is the anchor a save/paste/restore
    /// composite needs for 3-point race detection.
    pub sequence_after_write: u32,
}

// ── Pure helpers (unit-tested without Win32) ────────────────────────────────

/// Interpret a raw `CF_UNICODETEXT` HGLOBAL payload as clipboard text bytes:
/// truncate at the first NUL `u16`, and drop a trailing odd byte.
///
/// `GlobalSize` reports the *allocation*, which may be rounded up past the
/// requested size, so the terminator — not the reported size — is what defines
/// where the text ends. It is also what every real consumer of the clipboard
/// (`Get-Clipboard`, Ctrl+V into any control) sees, which is what makes the
/// comparison meaningful rather than an artefact of our own allocator.
fn text_bytes_from_raw(raw: &[u8]) -> &[u8] {
    let usable = raw.len() - (raw.len() % 2);
    let mut i = 0;
    while i + 1 < usable {
        if raw[i] == 0 && raw[i + 1] == 0 {
            return &raw[..i];
        }
        i += 2;
    }
    &raw[..usable]
}

/// Encode UTF-16LE bytes into the NUL-terminated `u16` buffer that
/// `CF_UNICODETEXT` requires. The input is already UTF-16LE (it comes straight
/// from `Buffer.from(text, "utf16le")` on the TS side); a trailing odd byte is
/// dropped rather than mis-paired into a bogus code unit.
fn to_terminated_u16(utf16le: &[u8]) -> Vec<u16> {
    let usable = utf16le.len() - (utf16le.len() % 2);
    let mut out: Vec<u16> = Vec::with_capacity(usable / 2 + 1);
    let mut i = 0;
    while i < usable {
        out.push(u16::from_le_bytes([utf16le[i], utf16le[i + 1]]));
        i += 2;
    }
    out.push(0);
    out
}

/// Map the executed step outcomes to the final verdict. Extracted so every
/// branch is unit-testable without touching Win32 — same rationale as
/// `console_paste::map_paste_outcome`.
fn map_write_outcome(
    write_reason: Option<String>,
    expected_bytes: u32,
    in_session: Option<Vec<u8>>,
    post_close: Result<Vec<u8>, String>,
    sequence_after_write: u32,
    expected: &[u8],
) -> ClipboardWriteVerifyResult {
    // The write itself failed: no read-back ran, and reporting a "mismatch"
    // would misattribute the cause.
    if let Some(reason) = write_reason {
        return ClipboardWriteVerifyResult {
            ok: false,
            reason: Some(reason),
            expected_bytes,
            in_session_readable: false,
            in_session_bytes: 0,
            in_session_match: false,
            post_close_checked: false,
            post_close_bytes: 0,
            post_close_match: false,
            post_close_skip_reason: Some("write_failed".to_string()),
            sequence_after_write,
        };
    }

    let (in_session_bytes, in_session_match, in_session_readable) = match &in_session {
        Some(b) => (b.len() as u32, b.as_slice() == expected, true),
        None => (0, false, false),
    };

    let (post_close_checked, post_close_bytes, post_close_match, post_close_skip_reason) =
        match &post_close {
            Ok(b) => (true, b.len() as u32, b.as_slice() == expected, None),
            Err(reason) => (false, 0, false, Some(reason.clone())),
        };

    let reason = if !in_session_readable {
        // The in-session leg could not be READ. That is a failed verification,
        // not evidence of a failed store — and the post-close leg answers the
        // same question the old `Set-Clipboard; Get-Clipboard -Raw` pair did.
        // If it ran and matched, delivery is proven and the write stands
        // (`in_session_readable=false` discloses which leg answered). Only when
        // that leg is also silent — mismatched or never run — is there nothing
        // left backing the write.
        if post_close_checked && post_close_match {
            None
        } else {
            Some("clipboard_get_data_failed".to_string())
        }
    } else if !in_session_match {
        // Readable but WRONG is a different fact: nothing could interleave
        // while we held the lock, so the OS (or a filter driver) stored
        // something other than what we handed it. A matching post-close read
        // does not excuse that, and this branch is deliberately not relaxed.
        Some("readback_mismatch".to_string())
    } else if post_close_checked && !post_close_match {
        // Someone consumed WM_CLIPBOARDUPDATE and replaced our payload: a
        // clipboard manager, a DLP agent, or an RDP/Citrix redirector.
        Some("clipboard_replaced_after_write".to_string())
    } else {
        // Includes `post_close_checked == false`: see the module doc.
        None
    };

    ClipboardWriteVerifyResult {
        ok: reason.is_none(),
        reason,
        expected_bytes,
        in_session_readable,
        in_session_bytes,
        in_session_match,
        post_close_checked,
        post_close_bytes,
        post_close_match,
        post_close_skip_reason,
        sequence_after_write,
    }
}

// ── Win32 primitives ────────────────────────────────────────────────────────

/// Read `CF_UNICODETEXT` from an ALREADY-OPEN clipboard. `None` when the format
/// is unavailable or the handle cannot be locked.
///
/// # Safety
/// The caller must hold the clipboard open (`OpenClipboard`) for the whole
/// call; the locked pointer is invalidated by `CloseClipboard`. The returned
/// handle is OS-owned and is never freed here (I-9).
unsafe fn read_unicode_text_locked() -> Option<Vec<u8>> {
    unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT).is_err() {
            return None;
        }
        let handle = GetClipboardData(CF_UNICODETEXT).ok()?;
        let hglobal = HGLOBAL(handle.0);
        let size = GlobalSize(hglobal);
        if size == 0 {
            // A delayed-rendering owner that produced nothing, or a NULL handle.
            return None;
        }
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            return None;
        }
        let raw = std::slice::from_raw_parts(ptr as *const u8, size);
        let bytes = text_bytes_from_raw(raw).to_vec();
        // GlobalUnlock returning FALSE with NO_ERROR just means the lock count
        // reached zero, which is the normal case here.
        let _ = GlobalUnlock(hglobal);
        Some(bytes)
    }
}

/// `EmptyClipboard` + `SetClipboardData(CF_UNICODETEXT, ...)` on an
/// ALREADY-OPEN clipboard.
///
/// # Safety
/// The caller must hold the clipboard open. On success the HGLOBAL is owned by
/// the OS; on every failure branch this function has already freed it (I-9).
unsafe fn set_unicode_text_locked(units: &[u16]) -> Result<(), ClipboardError> {
    unsafe {
        EmptyClipboard().map_err(|e| ClipboardError::EmptyFailed {
            win32_error: e.code().0 as u32,
        })?;
        let byte_len = std::mem::size_of_val(units);
        let hglobal =
            GlobalAlloc(GMEM_MOVEABLE, byte_len).map_err(|_| ClipboardError::AllocFailed)?;
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            global_free(hglobal);
            return Err(ClipboardError::AllocFailed);
        }
        std::ptr::copy_nonoverlapping(units.as_ptr(), ptr as *mut u16, units.len());
        let _ = GlobalUnlock(hglobal);
        match SetClipboardData(CF_UNICODETEXT, Some(HANDLE(hglobal.0))) {
            Ok(_) => Ok(()),
            Err(e) => {
                // Ownership never transferred — freeing here is required, not
                // optional, or we leak `byte_len` bytes per failed write.
                global_free(hglobal);
                Err(ClipboardError::SetDataFailed {
                    format_id: CF_UNICODETEXT,
                    win32_error: e.code().0 as u32,
                })
            }
        }
    }
}

// ── napi entry points ───────────────────────────────────────────────────────

/// Read the clipboard's text content as UTF-16LE bytes.
///
/// Sync (runs on the V8 thread). The only blocking is the shared
/// `open_clipboard_with_retry` (≤100 ms, I-12) when another process holds the
/// clipboard lock; the happy path is a few milliseconds.
#[napi]
pub fn win32_clipboard_read_text() -> napi::Result<ClipboardReadResult> {
    napi_safe_call("win32_clipboard_read_text", || {
        fn failed(reason: &str) -> ClipboardReadResult {
            ClipboardReadResult {
                ok: false,
                reason: Some(reason.to_string()),
                has_text: false,
                bytes: Buffer::from(Vec::new()),
            }
        }

        // A per-call hidden owner window rather than `OpenClipboard(NULL)`,
        // which leaves the clipboard with a NULL owner and breaks delayed
        // rendering / confuses clipboard managers (I-11).
        let inner = with_hidden_owner(|owner: HWND| -> ClipboardReadResult {
            if let Err(e) = open_clipboard_with_retry(owner) {
                return failed(e.as_reason());
            }
            let bytes = unsafe { read_unicode_text_locked() };
            unsafe {
                let _ = CloseClipboard();
            }
            match bytes {
                Some(b) => ClipboardReadResult {
                    ok: true,
                    reason: None,
                    has_text: true,
                    bytes: Buffer::from(b),
                },
                // An empty clipboard or a non-text payload is NOT an error:
                // the tool contract says "empty string if non-text".
                None => ClipboardReadResult {
                    ok: true,
                    reason: None,
                    has_text: false,
                    bytes: Buffer::from(Vec::new()),
                },
            }
        });
        Ok(inner.unwrap_or_else(|e| failed(e.as_reason())))
    })
}

/// Replace the clipboard with `utf16le` (UTF-16LE bytes) and verify delivery by
/// reading it back twice — in-session and after `CloseClipboard` — with
/// byte-for-byte comparison (issue #180 / I-1).
///
/// Sync (runs on the V8 thread); never throws on a Win32 failure — the failure
/// is reported through `ok=false` + `reason`.
///
/// Blocking budget: **~200 ms worst case**, not the read path's ~100 ms. There
/// are two `open_clipboard_with_retry` calls here — one for the write
/// transaction and one for the post-close verification read — and each absorbs
/// up to 10x10 ms of contention independently (I-12). The happy path is a few
/// milliseconds.
#[napi]
pub fn win32_clipboard_write_text_verified(
    utf16le: Buffer,
) -> napi::Result<ClipboardWriteVerifyResult> {
    napi_safe_call("win32_clipboard_write_text_verified", || {
        let units = to_terminated_u16(&utf16le);
        // What a reader must see: the payload minus the terminator we appended
        // — deliberately NOT truncated at an embedded NUL. `CF_UNICODETEXT` is
        // NUL-terminated, so a payload containing U+0000 is genuinely
        // unrepresentable and every reader will see a short string; comparing
        // against the untruncated payload surfaces that as a delivery failure
        // instead of a silently-passing round trip. The PowerShell path failed
        // the same case (via `Get-Clipboard` returning the short string), so
        // this is behaviour parity, not a new restriction.
        let expected: Vec<u8> = units[..units.len() - 1]
            .iter()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let expected_bytes = expected.len() as u32;

        let inner = with_hidden_owner(|owner: HWND| -> ClipboardWriteVerifyResult {
            // ── Transaction 1: empty + set + in-session read-back ───────────
            if let Err(e) = open_clipboard_with_retry(owner) {
                // Nothing was written: `EmptyClipboard` was never reached, so
                // the user's clipboard is untouched.
                return map_write_outcome(
                    Some(e.as_reason().to_string()),
                    expected_bytes,
                    None,
                    Err("write_failed".to_string()),
                    get_clipboard_sequence_number(),
                    &expected,
                );
            }
            let set_result = unsafe { set_unicode_text_locked(&units) };
            let in_session = match &set_result {
                Ok(()) => unsafe { read_unicode_text_locked() },
                Err(_) => None,
            };
            unsafe {
                let _ = CloseClipboard();
            }
            // Taken after the close, so the format-synthesis bumps that happen
            // inside `CloseClipboard` are already included (P0-2).
            let sequence_after_write = get_clipboard_sequence_number();

            if let Err(e) = set_result {
                return map_write_outcome(
                    Some(e.as_reason().to_string()),
                    expected_bytes,
                    None,
                    Err("write_failed".to_string()),
                    sequence_after_write,
                    &expected,
                );
            }

            // ── Transaction 2: post-close read-back ────────────────────────
            // Only after `CloseClipboard` do clipboard managers / DLP agents
            // receive `WM_CLIPBOARDUPDATE`, so this is the only transaction
            // that can observe an interceptor replacing our payload.
            let post_close = match open_clipboard_with_retry(owner) {
                Ok(()) => {
                    let b = unsafe { read_unicode_text_locked() };
                    unsafe {
                        let _ = CloseClipboard();
                    }
                    // `None` here means the text vanished entirely — a real
                    // mismatch against a non-empty payload, so it is compared
                    // as empty rather than treated as "not checked".
                    Ok(b.unwrap_or_default())
                }
                Err(e) => Err(e.as_reason().to_string()),
            };

            map_write_outcome(
                None,
                expected_bytes,
                in_session,
                post_close,
                sequence_after_write,
                &expected,
            )
        });

        Ok(inner.unwrap_or_else(|e| {
            map_write_outcome(
                Some(e.as_reason().to_string()),
                expected_bytes,
                None,
                Err("write_failed".to_string()),
                0,
                &expected,
            )
        }))
    })
}

// ── Unit tests (pure, no Win32) ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    #[test]
    fn text_bytes_stops_at_nul_terminator() {
        let mut raw = utf16le("hi");
        raw.extend_from_slice(&[0, 0]);
        raw.extend_from_slice(&[0xAA, 0xBB]); // allocation slack past the terminator
        assert_eq!(text_bytes_from_raw(&raw), utf16le("hi").as_slice());
    }

    #[test]
    fn text_bytes_without_terminator_returns_whole_buffer() {
        let raw = utf16le("hi");
        assert_eq!(text_bytes_from_raw(&raw), raw.as_slice());
    }

    #[test]
    fn text_bytes_drops_trailing_odd_byte() {
        let mut raw = utf16le("hi");
        raw.push(0x41);
        assert_eq!(text_bytes_from_raw(&raw), utf16le("hi").as_slice());
    }

    #[test]
    fn text_bytes_empty_input() {
        assert!(text_bytes_from_raw(&[]).is_empty());
        assert!(text_bytes_from_raw(&[0, 0]).is_empty());
    }

    #[test]
    fn text_bytes_keeps_astral_and_lone_surrogates_intact() {
        // A lone surrogate is not valid UTF-8 and could not survive a String
        // bridge; the byte path must return it unchanged.
        let raw: Vec<u8> = vec![0x00, 0xD8, 0x37, 0xDC, 0x00, 0xD8];
        assert_eq!(text_bytes_from_raw(&raw), raw.as_slice());
    }

    #[test]
    fn to_terminated_u16_appends_nul_and_preserves_surrogate_pairs() {
        // U+1F600 GRINNING FACE → surrogate pair D83D DE00.
        let units = to_terminated_u16(&utf16le("\u{1F600}"));
        assert_eq!(units, vec![0xD83D, 0xDE00, 0x0000]);
    }

    #[test]
    fn to_terminated_u16_on_empty_is_just_the_terminator() {
        assert_eq!(to_terminated_u16(&[]), vec![0u16]);
    }

    #[test]
    fn to_terminated_u16_drops_trailing_odd_byte() {
        let mut b = utf16le("a");
        b.push(0x42);
        assert_eq!(to_terminated_u16(&b), vec![0x0061, 0x0000]);
    }

    #[test]
    fn embedded_nul_expectation_is_the_untruncated_payload() {
        // The write's `expected` is built from the terminated units minus the
        // terminator, so a payload containing U+0000 expects MORE bytes than
        // any reader can ever see — which is what makes the write fail rather
        // than silently round-trip a truncated string.
        let payload = utf16le("a\u{0}b");
        let units = to_terminated_u16(&payload);
        let expected: Vec<u8> = units[..units.len() - 1]
            .iter()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        assert_eq!(expected, payload);
        // What a reader actually sees, given the same bytes on the clipboard:
        let mut on_clipboard = payload.clone();
        on_clipboard.extend_from_slice(&[0, 0]);
        assert_ne!(text_bytes_from_raw(&on_clipboard), expected.as_slice());
        assert_eq!(text_bytes_from_raw(&on_clipboard), utf16le("a").as_slice());
    }

    #[test]
    fn outcome_write_failure_short_circuits_every_verification_field() {
        let r = map_write_outcome(
            Some("clipboard_lock_contention".into()),
            8,
            None,
            Err("write_failed".into()),
            7,
            &utf16le("abcd"),
        );
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("clipboard_lock_contention"));
        assert!(!r.in_session_readable);
        assert!(!r.in_session_match);
        assert!(!r.post_close_checked);
        assert_eq!(r.post_close_skip_reason.as_deref(), Some("write_failed"));
        assert_eq!(r.sequence_after_write, 7);
    }

    #[test]
    fn outcome_all_matching_is_ok() {
        let e = utf16le("hello");
        let r = map_write_outcome(None, e.len() as u32, Some(e.clone()), Ok(e.clone()), 9, &e);
        assert!(r.ok);
        assert!(r.reason.is_none());
        assert!(r.in_session_match && r.post_close_match && r.post_close_checked);
        assert_eq!(r.expected_bytes, e.len() as u32);
    }

    #[test]
    fn outcome_in_session_mismatch_is_readback_mismatch() {
        let e = utf16le("hello");
        let r = map_write_outcome(
            None,
            e.len() as u32,
            Some(utf16le("hell")),
            Ok(e.clone()),
            9,
            &e,
        );
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("readback_mismatch"));
    }

    #[test]
    fn outcome_in_session_unreadable_but_post_close_matching_is_ok() {
        // The in-session read is an extra leg this module added; the post-close
        // read is the one whose semantics shipped for years as
        // `Set-Clipboard; Get-Clipboard -Raw`. Failing a write that the shipped
        // check agrees was delivered would report a delivered write as lost.
        let e = utf16le("hello");
        let r = map_write_outcome(None, e.len() as u32, None, Ok(e.clone()), 9, &e);
        assert!(r.ok);
        assert!(r.reason.is_none());
        // ...but the caller is told the in-session leg never answered, so the
        // weaker evidence is disclosed rather than hidden.
        assert!(!r.in_session_readable);
        assert!(r.post_close_checked && r.post_close_match);
    }

    #[test]
    fn outcome_in_session_unreadable_and_post_close_mismatched_is_get_data_failed() {
        let e = utf16le("hello");
        let r = map_write_outcome(None, e.len() as u32, None, Ok(utf16le("other")), 9, &e);
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("clipboard_get_data_failed"));
    }

    #[test]
    fn outcome_in_session_unreadable_and_post_close_skipped_is_get_data_failed() {
        // Nothing read either leg, so nothing backs the write.
        let e = utf16le("hello");
        let r = map_write_outcome(
            None,
            e.len() as u32,
            None,
            Err("clipboard_lock_contention".into()),
            9,
            &e,
        );
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("clipboard_get_data_failed"));
    }

    #[test]
    fn outcome_in_session_readable_mismatch_is_not_rescued_by_a_matching_post_close() {
        // The contrapositive of the relaxation above: READABLE-but-wrong is a
        // store failure (nothing could interleave under the lock), and a later
        // matching read must not launder it into a success.
        let e = utf16le("hello");
        let r = map_write_outcome(
            None,
            e.len() as u32,
            Some(utf16le("hell")),
            Ok(e.clone()),
            9,
            &e,
        );
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("readback_mismatch"));
        assert!(r.in_session_readable);
    }

    #[test]
    fn outcome_post_close_mismatch_is_replaced_after_write() {
        let e = utf16le("hello");
        let r = map_write_outcome(
            None,
            e.len() as u32,
            Some(e.clone()),
            Ok(utf16le("intercepted")),
            9,
            &e,
        );
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("clipboard_replaced_after_write"));
        assert!(r.post_close_checked);
    }

    #[test]
    fn outcome_post_close_emptied_is_replaced_after_write() {
        // The clipboard being cleared between our close and the re-read is the
        // "0 vs N" diagnosis, and it must not pass as a delivered write.
        let e = utf16le("hello");
        let r = map_write_outcome(None, e.len() as u32, Some(e.clone()), Ok(Vec::new()), 9, &e);
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("clipboard_replaced_after_write"));
        assert_eq!(r.post_close_bytes, 0);
    }

    #[test]
    fn outcome_post_close_unopenable_does_not_fail_the_write() {
        // Contention on the *verification* re-open is not evidence that the
        // write was lost — the in-session read-back already proved the store.
        let e = utf16le("hello");
        let r = map_write_outcome(
            None,
            e.len() as u32,
            Some(e.clone()),
            Err("clipboard_lock_contention".into()),
            9,
            &e,
        );
        assert!(r.ok);
        assert!(!r.post_close_checked);
        assert_eq!(
            r.post_close_skip_reason.as_deref(),
            Some("clipboard_lock_contention")
        );
    }

    #[test]
    fn outcome_empty_payload_round_trips_as_ok() {
        let e: Vec<u8> = Vec::new();
        let r = map_write_outcome(None, 0, Some(Vec::new()), Ok(Vec::new()), 3, &e);
        assert!(r.ok);
        assert_eq!(r.expected_bytes, 0);
    }
}
