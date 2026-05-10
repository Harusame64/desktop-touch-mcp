//! ADR-013 Option E — Clipboard rigorous handling (Phase 1b).
//!
//! `foreground_flash` channel が clipboard 経由で text を WT に渡す際、user の
//! clipboard を非破壊的に取り扱うための save/restore + race detection 機構。
//!
//! 設計原則 (`docs/adr-013-option-e-impl.md` v3 §3.2):
//! - **MVP は HGLOBAL 系限定**: `CF_UNICODETEXT` / `CF_TEXT` / `CF_HDROP` /
//!   private HGLOBAL 等。非 HGLOBAL (`CF_BITMAP` / `CF_ENHMETAFILE` /
//!   `CF_OWNERDISPLAY` 等) は save 時 skip + warn (= restore 不可、hints で明示)
//! - **3 point sequence**: `seq_before_snapshot` / `seq_after_inject_clipboard`
//!   / `seq_before_restore`、自分の inject 以降に他者が触った場合のみ restore skip
//! - **Hidden owner window** (per-call lifecycle): `OpenClipboard(NULL)` で
//!   owner NULL になる罠を回避。MVP は per-call create/destroy (lazy init は
//!   performance 顕在化したら別 PR / Phase 1.5 で refactor)
//! - **OLE `IDataObject` snapshot** は MVP scope 外、別 PR (Phase 1.5、option) で評価
//!
//! 注意: 全 `unsafe` ブロック内で Win32 ownership rule を厳守:
//! - `SetClipboardData(fmt, hglobal)` 成功時 HGLOBAL の所有権は OS に移る (caller `GlobalFree` 禁止)
//! - 失敗時は caller が `GlobalFree` する責任
//! - `GetClipboardData(fmt)` 戻り値 HGLOBAL は OS owner (`GlobalLock`/`Unlock` のみ、`GlobalFree` 禁止)

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{GetLastError, HANDLE, HGLOBAL, HMODULE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardSequenceNumber, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};

// `GlobalFree` is not re-exported by windows-rs 0.62 in `Win32::System::Memory`.
// Declare it directly via FFI to kernel32 — stable Win32 API, signature unchanged.
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GlobalFree(hmem: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
}

/// Free an HGLOBAL (caller-owned, e.g. on `SetClipboardData` failure).
unsafe fn global_free(hglobal: HGLOBAL) {
    unsafe {
        let _ = GlobalFree(hglobal.0);
    }
}
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassExW, HCURSOR, HICON,
    HMENU, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSEXW, WNDCLASS_STYLES,
};

// ── Constants ───────────────────────────────────────────────────────────────

const CLIPBOARD_OPEN_RETRIES: u32 = 10;
const CLIPBOARD_OPEN_RETRY_DELAY_MS: u64 = 10;

// Win32 clipboard formats (subset; full list in winuser.h).
const CF_TEXT: u32 = 1;
const CF_BITMAP: u32 = 2;
const CF_METAFILEPICT: u32 = 3;
const CF_OEMTEXT: u32 = 7;
const CF_PALETTE: u32 = 9;
const CF_RIFF: u32 = 11;
const CF_WAVE: u32 = 12;
pub const CF_UNICODETEXT: u32 = 13;
const CF_ENHMETAFILE: u32 = 14;
const CF_HDROP: u32 = 15;
const CF_LOCALE: u32 = 16;
const CF_DIBV5: u32 = 17;
const CF_OWNERDISPLAY: u32 = 0x0080;
const CF_DSPTEXT: u32 = 0x0081;
const CF_DSPBITMAP: u32 = 0x0082;
const CF_DSPMETAFILEPICT: u32 = 0x0083;
const CF_DSPENHMETAFILE: u32 = 0x008E;

// ── Public types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
pub enum SkippedFormatReason {
    /// 既知の非 HGLOBAL format (CF_BITMAP / CF_ENHMETAFILE / CF_OWNERDISPLAY 等)。
    NonHglobal,
    /// `GetClipboardData` 戻り値の `GlobalSize == 0` (遅延 rendering / NULL handle)。
    DeferredRender,
    /// `GetClipboardData` 自体が fail (race / permission 等)。
    GetDataFailed,
}

impl SkippedFormatReason {
    pub fn as_str(self) -> &'static str {
        match self {
            SkippedFormatReason::NonHglobal => "non_hglobal",
            SkippedFormatReason::DeferredRender => "deferred_render",
            SkippedFormatReason::GetDataFailed => "get_data_failed",
        }
    }
}

#[derive(Debug, Clone)]
pub enum FormatEntry {
    Saved { format_id: u32, bytes: Vec<u8> },
    Skipped { format_id: u32, reason: SkippedFormatReason },
}

#[derive(Debug, Clone)]
pub struct ClipboardSnapshot {
    /// `GetClipboardSequenceNumber` 値 (3 point の 1 つ目 = save 直前)。
    pub sequence_number: u32,
    pub entries: Vec<FormatEntry>,
}

impl ClipboardSnapshot {
    /// Skip された format の (format_id, reason) を列挙 (caller hints 用)。
    pub fn skipped_summary(&self) -> Vec<(u32, &'static str)> {
        self.entries
            .iter()
            .filter_map(|e| match e {
                FormatEntry::Skipped { format_id, reason } => Some((*format_id, reason.as_str())),
                FormatEntry::Saved { .. } => None,
            })
            .collect()
    }
}

#[derive(Debug)]
pub enum RestoreOutcome {
    /// 復元成功 (= sequence 一致 + 全 saved format 書込完了)。
    Restored,
    /// Race 検出 (= seq_before_restore != seq_after_inject_clipboard) で restore skip。
    SkippedDueToRace { observed_seq: u32, expected_seq: u32 },
    /// Restore 中に Win32 fail (= clipboard contention / SetClipboardData fail 等)。
    Failed(ClipboardError),
}

#[derive(Debug)]
pub enum ClipboardError {
    /// `OpenClipboard` retry 上限超過。
    OpenContention,
    /// `EmptyClipboard` fail。
    EmptyFailed { win32_error: u32 },
    /// `GlobalAlloc` fail (= 通常 OOM)。
    AllocFailed,
    /// `SetClipboardData` fail (caller は HGLOBAL を free 済)。
    SetDataFailed { format_id: u32, win32_error: u32 },
    /// `CreateWindowExW` for hidden owner fail。
    HiddenOwnerCreateFailed { win32_error: u32 },
}

impl ClipboardError {
    pub fn as_reason(&self) -> &'static str {
        match self {
            ClipboardError::OpenContention => "clipboard_lock_contention",
            ClipboardError::EmptyFailed { .. } => "clipboard_empty_failed",
            ClipboardError::AllocFailed => "clipboard_alloc_failed",
            ClipboardError::SetDataFailed { .. } => "clipboard_set_data_failed",
            ClipboardError::HiddenOwnerCreateFailed { .. } => "hidden_owner_create_failed",
        }
    }
}

// ── Hidden owner window (per-call lifecycle) ────────────────────────────────

const HIDDEN_OWNER_CLASS_NAME: PCWSTR = w!("DTM_ClipboardOwner");

/// Window class が登録されたか (per-process、idempotent guard)。
static CLASS_REGISTERED: AtomicBool = AtomicBool::new(false);

/// True extern "system" WNDPROC wrapper around DefWindowProcW.
/// windows-rs の `DefWindowProcW` は Rust ABI wrapper のため、`WNDPROC =
/// Option<unsafe extern "system" fn(...)>` 型に直接 assign できない。
unsafe extern "system" fn dtm_owner_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Hidden owner window class を 1 度だけ登録 (per-process)。
/// 既に登録済の場合は no-op (CAS で idempotent)。
fn ensure_class_registered() {
    if CLASS_REGISTERED.swap(true, Ordering::AcqRel) {
        return; // 既に他の thread が登録済
    }
    unsafe {
        let hinstance = match GetModuleHandleW(None) {
            Ok(h) => h,
            Err(_) => HMODULE::default(),
        };
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: WNDCLASS_STYLES(0),
            // 我々は遅延 rendering / WM_RENDERFORMAT に応答しないので DefWindowProc で safe。
            lpfnWndProc: Some(dtm_owner_wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance.into(),
            hIcon: HICON::default(),
            hCursor: HCURSOR::default(),
            hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH::default(),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: HIDDEN_OWNER_CLASS_NAME,
            hIconSm: HICON::default(),
        };
        // 同 class 名の再登録は ERROR_CLASS_ALREADY_EXISTS で 0 を返す、無害。
        let _atom = RegisterClassExW(&wc);
    }
}

/// Hidden owner window を作成 (calling thread で、per-call lifecycle)。
/// 注意: HWND は thread-affinity (= 同 thread でしか destroy / message handle 不可)、
/// caller が同 thread で `DestroyWindow` するまで保持する責任。
fn create_hidden_owner() -> Result<HWND, ClipboardError> {
    ensure_class_registered();
    unsafe {
        let hinstance = match GetModuleHandleW(None) {
            Ok(h) => h,
            Err(_) => HMODULE::default(),
        };
        let result = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            HIDDEN_OWNER_CLASS_NAME,
            w!("DTM Clipboard Owner"),
            WINDOW_STYLE(0),
            0, 0, 0, 0,
            None,                                 // parent (None = top-level、message-only ではない)
            Some(HMENU::default()),
            Some(hinstance.into()),
            None,
        );
        match result {
            Ok(hwnd) if !hwnd.0.is_null() => Ok(hwnd),
            _ => {
                let err = GetLastError();
                Err(ClipboardError::HiddenOwnerCreateFailed { win32_error: err.0 })
            }
        }
    }
}

/// `f` を hidden owner HWND と共に呼び、終了時に `DestroyWindow` する scope guard。
pub fn with_hidden_owner<R>(f: impl FnOnce(HWND) -> R) -> Result<R, ClipboardError> {
    let owner = create_hidden_owner()?;
    let result = f(owner);
    unsafe {
        let _ = DestroyWindow(owner);
    }
    Ok(result)
}

// ── 3 point sequence helper ─────────────────────────────────────────────────

/// `GetClipboardSequenceNumber` 単純 wrapper (3 point 観測用)。
pub fn get_clipboard_sequence_number() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

// ── OpenClipboard retry ─────────────────────────────────────────────────────

fn open_clipboard_with_retry(owner: HWND) -> Result<(), ClipboardError> {
    for _ in 0..CLIPBOARD_OPEN_RETRIES {
        unsafe {
            if OpenClipboard(Some(owner)).is_ok() {
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(CLIPBOARD_OPEN_RETRY_DELAY_MS));
    }
    Err(ClipboardError::OpenContention)
}

// ── Save ────────────────────────────────────────────────────────────────────

/// 全 supported format を save。HGLOBAL 系のみ実 bytes、非 HGLOBAL は skip 記録。
pub fn save_clipboard_supported_formats(owner: HWND) -> Result<ClipboardSnapshot, ClipboardError> {
    open_clipboard_with_retry(owner)?;

    // EnumClipboardFormats / GetClipboardData は OpenClipboard 後でないと fail する。
    let result = (|| -> Result<ClipboardSnapshot, ClipboardError> {
        let sequence_number = get_clipboard_sequence_number();
        let mut entries = Vec::new();
        let mut format = 0u32;
        loop {
            unsafe {
                format = EnumClipboardFormats(format);
            }
            if format == 0 {
                break;
            }
            entries.push(save_one_format(format));
        }
        Ok(ClipboardSnapshot { sequence_number, entries })
    })();

    unsafe {
        let _ = CloseClipboard();
    }
    result
}

fn save_one_format(format_id: u32) -> FormatEntry {
    // 既知の非 HGLOBAL format を early skip (handle ベース)。
    if matches!(
        format_id,
        CF_BITMAP
            | CF_METAFILEPICT
            | CF_PALETTE
            | CF_ENHMETAFILE
            | CF_OWNERDISPLAY
            | CF_DSPTEXT
            | CF_DSPBITMAP
            | CF_DSPMETAFILEPICT
            | CF_DSPENHMETAFILE
    ) {
        return FormatEntry::Skipped {
            format_id,
            reason: SkippedFormatReason::NonHglobal,
        };
    }

    unsafe {
        let handle = match GetClipboardData(format_id) {
            Ok(h) => h,
            Err(_) => {
                return FormatEntry::Skipped {
                    format_id,
                    reason: SkippedFormatReason::GetDataFailed,
                };
            }
        };
        let hglobal = HGLOBAL(handle.0);
        let size = GlobalSize(hglobal);
        if size == 0 {
            return FormatEntry::Skipped {
                format_id,
                reason: SkippedFormatReason::DeferredRender,
            };
        }
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            return FormatEntry::Skipped {
                format_id,
                reason: SkippedFormatReason::GetDataFailed,
            };
        }
        let bytes = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
        // GlobalUnlock は ref count を 1 減、=0 で false return も "正常終了" の意味なので
        // GetLastError が NO_ERROR なら成功扱い。本 fn では結果 ignore。
        let _ = GlobalUnlock(hglobal);
        FormatEntry::Saved { format_id, bytes }
    }
}

// ── Restore ─────────────────────────────────────────────────────────────────

/// Snapshot を clipboard に書き戻す。
/// `seq_after_inject_clipboard`: 我々の SetClipboardData 直後の sequence number。
/// `seq_before_restore != seq_after_inject_clipboard` なら restore skip (= 我々以降に
/// 他者が触った)。
pub fn restore_clipboard_supported_formats(
    snapshot: &ClipboardSnapshot,
    owner: HWND,
    seq_after_inject_clipboard: u32,
) -> RestoreOutcome {
    let seq_before_restore = get_clipboard_sequence_number();
    if seq_before_restore != seq_after_inject_clipboard {
        return RestoreOutcome::SkippedDueToRace {
            observed_seq: seq_before_restore,
            expected_seq: seq_after_inject_clipboard,
        };
    }

    if let Err(e) = open_clipboard_with_retry(owner) {
        return RestoreOutcome::Failed(e);
    }

    let result = (|| -> Result<(), ClipboardError> {
        unsafe {
            EmptyClipboard().map_err(|e| ClipboardError::EmptyFailed {
                win32_error: e.code().0 as u32,
            })?;
        }
        for entry in &snapshot.entries {
            if let FormatEntry::Saved { format_id, bytes } = entry {
                set_one_format(*format_id, bytes)?;
            }
        }
        Ok(())
    })();

    unsafe {
        let _ = CloseClipboard();
    }

    match result {
        Ok(()) => RestoreOutcome::Restored,
        Err(e) => RestoreOutcome::Failed(e),
    }
}

fn set_one_format(format_id: u32, bytes: &[u8]) -> Result<(), ClipboardError> {
    unsafe {
        let hglobal = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|_| ClipboardError::AllocFailed)?;
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            // GlobalAlloc 後に Lock 失敗 = 即 free して error を返す。
            global_free(hglobal);
            return Err(ClipboardError::AllocFailed);
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
        let _ = GlobalUnlock(hglobal);

        // SetClipboardData transfers HGLOBAL ownership to OS on success.
        // On failure, caller (us) must GlobalFree to avoid leak.
        match SetClipboardData(format_id, Some(HANDLE(hglobal.0))) {
            Ok(_) => Ok(()),
            Err(e) => {
                global_free(hglobal);
                Err(ClipboardError::SetDataFailed {
                    format_id,
                    win32_error: e.code().0 as u32,
                })
            }
        }
    }
}

// ── Convenience: SetClipboard(CF_UNICODETEXT, text) for foreground_flash inject ──

/// `text` を `CF_UNICODETEXT` として clipboard に書き、書込直後の sequence number を返す。
/// 既存内容は `EmptyClipboard` でクリア (caller は事前に snapshot を取る責任)。
pub fn set_clipboard_unicode_text(owner: HWND, text: &str) -> Result<u32, ClipboardError> {
    open_clipboard_with_retry(owner)?;

    let result = (|| -> Result<(), ClipboardError> {
        unsafe {
            EmptyClipboard().map_err(|e| ClipboardError::EmptyFailed {
                win32_error: e.code().0 as u32,
            })?;
        }
        // UTF-16 + null terminator
        let utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes_len = utf16.len() * std::mem::size_of::<u16>();
        unsafe {
            let hglobal = GlobalAlloc(GMEM_MOVEABLE, bytes_len).map_err(|_| ClipboardError::AllocFailed)?;
            let ptr = GlobalLock(hglobal);
            if ptr.is_null() {
                global_free(hglobal);
                return Err(ClipboardError::AllocFailed);
            }
            std::ptr::copy_nonoverlapping(utf16.as_ptr(), ptr as *mut u16, utf16.len());
            let _ = GlobalUnlock(hglobal);
            SetClipboardData(CF_UNICODETEXT, Some(HANDLE(hglobal.0))).map_err(|e| {
                global_free(hglobal);
                ClipboardError::SetDataFailed {
                    format_id: CF_UNICODETEXT,
                    win32_error: e.code().0 as u32,
                }
            })?;
        }
        Ok(())
    })();

    unsafe {
        let _ = CloseClipboard();
    }
    let seq = get_clipboard_sequence_number();
    result.map(|_| seq)
}

// Suppress unused warnings for constants that callers may want later.
#[allow(dead_code)]
const _UNUSED_FORMATS: &[u32] = &[
    CF_TEXT, CF_OEMTEXT, CF_RIFF, CF_WAVE, CF_HDROP, CF_LOCALE, CF_DIBV5,
];

// LPARAM/WPARAM/LRESULT are imported for future WndProc use.
#[allow(dead_code)]
fn _suppress_unused_imports(_w: WPARAM, _l: LPARAM) -> LRESULT {
    LRESULT(0)
}

// ── Unit tests (Phase 1f) ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // Pure-logic tests: SkippedFormatReason / ClipboardError reason 文字列、
    // ClipboardSnapshot::skipped_summary 抽出ロジック。clipboard / hidden owner
    // を実際に触る test は副作用ありで `#[ignore]`、CI 既定では skip。

    #[test]
    fn skipped_format_reason_as_str() {
        assert_eq!(SkippedFormatReason::NonHglobal.as_str(), "non_hglobal");
        assert_eq!(SkippedFormatReason::DeferredRender.as_str(), "deferred_render");
        assert_eq!(SkippedFormatReason::GetDataFailed.as_str(), "get_data_failed");
    }

    #[test]
    fn clipboard_error_reason_strings_are_snake_case() {
        assert_eq!(ClipboardError::OpenContention.as_reason(), "clipboard_lock_contention");
        assert_eq!(
            ClipboardError::EmptyFailed { win32_error: 0 }.as_reason(),
            "clipboard_empty_failed"
        );
        assert_eq!(ClipboardError::AllocFailed.as_reason(), "clipboard_alloc_failed");
        assert_eq!(
            ClipboardError::SetDataFailed {
                format_id: 13,
                win32_error: 5
            }
            .as_reason(),
            "clipboard_set_data_failed"
        );
        assert_eq!(
            ClipboardError::HiddenOwnerCreateFailed { win32_error: 1 }.as_reason(),
            "hidden_owner_create_failed"
        );
    }

    #[test]
    fn snapshot_skipped_summary_filters_only_skipped_entries() {
        let snapshot = ClipboardSnapshot {
            sequence_number: 42,
            entries: vec![
                FormatEntry::Saved {
                    format_id: 13,
                    bytes: vec![0u8; 4],
                },
                FormatEntry::Skipped {
                    format_id: 2,
                    reason: SkippedFormatReason::NonHglobal,
                },
                FormatEntry::Saved {
                    format_id: 1,
                    bytes: vec![0u8; 8],
                },
                FormatEntry::Skipped {
                    format_id: 8,
                    reason: SkippedFormatReason::GetDataFailed,
                },
                FormatEntry::Skipped {
                    format_id: 14,
                    reason: SkippedFormatReason::DeferredRender,
                },
            ],
        };
        let summary = snapshot.skipped_summary();
        assert_eq!(summary.len(), 3);
        assert_eq!(summary[0], (2, "non_hglobal"));
        assert_eq!(summary[1], (8, "get_data_failed"));
        assert_eq!(summary[2], (14, "deferred_render"));
    }

    #[test]
    fn snapshot_with_no_skipped_entries_returns_empty_summary() {
        let snapshot = ClipboardSnapshot {
            sequence_number: 0,
            entries: vec![
                FormatEntry::Saved {
                    format_id: 13,
                    bytes: vec![0u8; 4],
                },
            ],
        };
        assert!(snapshot.skipped_summary().is_empty());
    }

    // ── Win32 副作用 tests (default `#[ignore]`、manual run only) ───────────

    /// Hidden owner window class 登録 + create + destroy が leak-free。
    /// 副作用なし (window class が process 単位で残るが idempotent)、ただし
    /// 短期間 message-only window が見えるため CI 環境次第で flaky。
    /// CI default では skip、manual で `cargo test -- --ignored hidden_owner` 実行。
    #[test]
    #[ignore = "Win32 副作用 (hidden owner window create/destroy)"]
    fn hidden_owner_create_and_destroy_no_leak() {
        let result = with_hidden_owner(|hwnd| {
            assert!(!hwnd.0.is_null(), "hidden owner HWND should not be null");
        });
        assert!(result.is_ok(), "with_hidden_owner failed: {:?}", result);
    }

    /// Clipboard HGLOBAL CF_UNICODETEXT round-trip。
    /// **副作用**: user clipboard を書き換える。CI default では skip、
    /// manual で `cargo test -- --ignored clipboard_unicode_round_trip` 実行。
    /// (実機で復元される事実は §6.1 acceptance 確認、Phase 4 E2E で再検証)
    #[test]
    #[ignore = "副作用: user clipboard 書き換え"]
    fn clipboard_unicode_round_trip_via_hidden_owner() {
        let result = with_hidden_owner(|owner| -> Result<(), String> {
            // 1. Set initial sentinel text
            let initial = "phase1f_initial_sentinel";
            set_clipboard_unicode_text(owner, initial)
                .map_err(|e| format!("initial set failed: {:?}", e))?;

            // 2. Save snapshot (should capture initial)
            let snapshot = save_clipboard_supported_formats(owner)
                .map_err(|e| format!("save failed: {:?}", e))?;

            // 3. Inject our text
            let new_text = "phase1f_injected_payload";
            let seq_after = set_clipboard_unicode_text(owner, new_text)
                .map_err(|e| format!("inject failed: {:?}", e))?;

            // 4. Restore (no race) → should succeed
            let restore_outcome =
                restore_clipboard_supported_formats(&snapshot, owner, seq_after);
            match restore_outcome {
                RestoreOutcome::Restored => Ok(()),
                other => Err(format!("expected Restored, got {:?}", other)),
            }
        });
        assert!(result.is_ok(), "{:?}", result);
        assert!(result.unwrap().is_ok(), "round-trip failed");
    }

    /// 3 point sequence race detection: inject 後に他者が clipboard を変更すると
    /// restore は SkippedDueToRace を返す。
    /// **副作用**: user clipboard 書き換え。
    #[test]
    #[ignore = "副作用: user clipboard 書き換え"]
    fn race_detection_skips_restore() {
        let result = with_hidden_owner(|owner| -> Result<(), String> {
            set_clipboard_unicode_text(owner, "phase1f_race_initial")
                .map_err(|e| format!("initial: {:?}", e))?;
            let snapshot = save_clipboard_supported_formats(owner)
                .map_err(|e| format!("save: {:?}", e))?;
            let seq_after = set_clipboard_unicode_text(owner, "phase1f_race_ours")
                .map_err(|e| format!("ours: {:?}", e))?;
            // Simulate race: another writer mutates clipboard between inject and restore.
            set_clipboard_unicode_text(owner, "phase1f_race_intruder")
                .map_err(|e| format!("intruder: {:?}", e))?;

            let outcome = restore_clipboard_supported_formats(&snapshot, owner, seq_after);
            match outcome {
                RestoreOutcome::SkippedDueToRace { .. } => Ok(()),
                other => Err(format!("expected SkippedDueToRace, got {:?}", other)),
            }
        });
        assert!(result.is_ok(), "{:?}", result);
        assert!(result.unwrap().is_ok(), "race detection failed");
    }
}
