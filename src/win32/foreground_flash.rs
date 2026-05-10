//! ADR-013 Option E (`foreground_flash` channel) — Native Win32 layer.
//!
//! `background` 契約とは分離した「妥協 BG = 50ms 程度の foreground flash で
//! WT pane に Clipboard paste + Enter を inject」channel の Rust 本体。
//! `method: 'foreground_flash'` 明示 opt-in でのみ caller 側から到達される。
//!
//! 設計詳細: `docs/adr-013-option-e-impl.md` v3。
//! 関連 spike: `spike/wt-attachconsole-input` branch + `docs/wt-bg-spike-round2-findings.md`。
//!
//! 本 file は Phase 1a skeleton。後続 sub-phase で本実装:
//! - Phase 1b: clipboard_snapshot module 追加 (HGLOBAL save/restore + 3 point sequence)
//! - Phase 1c: foreground_flash main impl (steal ladder + Alt unlock + SendInput + verify)
//! - Phase 1d: kbd_hook module (option, default OFF)
//! - Phase 1e: wt_dialog_scan module (option, default ON for paste warning fail-safe)
//! - Phase 1f: unit test

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::Win32::Foundation::HWND;

use super::safety::napi_safe_call;

// ── Type definitions ────────────────────────────────────────────────────────

/// Caller-supplied options for `win32_foreground_flash_inject`.
/// すべて optional、未指定なら下記 default。
#[napi(object)]
pub struct ForegroundFlashOptions {
    /// Focus-ready 判定 polling 上限 (default 30ms)。
    pub max_focus_wait_ms: Option<u32>,
    /// Foreground 復帰 retry 回数 (default 2)。
    pub foreground_restore_retries: Option<u32>,
    /// LowLevel keyboard hook で flash 期間中の keystroke を block する (default false)。
    /// env `DESKTOP_TOUCH_FOREGROUND_FLASH_BLOCK_KEYBOARD=1` で global ON 切替可。
    pub block_keyboard_during_flash: Option<bool>,
    /// WT paste warning ContentDialog を flash 後 scan + Esc 拒否する (default true)。
    /// env `DESKTOP_TOUCH_FOREGROUND_FLASH_DISABLE_DIALOG_SCAN=1` で OFF 切替可。
    pub scan_paste_warning_dialog: Option<bool>,
    /// Paste 完了後に SendInput(VK_RETURN) を別送信する (default false)。
    /// caller が明示的に Enter を送りたい場合に true。
    pub press_enter: Option<bool>,
}

/// `win32_foreground_flash_inject` の成功結果。
#[napi(object)]
pub struct ForegroundFlashResult {
    /// Flash 全体の所要時間 (ms、Stopwatch 計測)。
    pub flash_duration_ms: u32,
    /// Foreground steal ladder のどの段で成功したか。
    /// `"AttachThreadInput"` (段 1) / `"alt_unlock"` (段 2) / `"already_foreground"` (skip)。
    pub foreground_steal_method: String,
    /// Foreground 復帰が確認できたか (`GetForegroundWindow == originalForegroundHwnd`)。
    pub foreground_restored: bool,
    /// Foreground 復帰までに要した retry 回数 (0 = 1 回目で成功)。
    pub foreground_restore_retries_used: u32,
    /// Clipboard 復元が実施されたか (false = race detected で skip)。
    pub clipboard_restored: bool,
    /// Clipboard save 時に skip された format (非 HGLOBAL / deferred render)。
    /// JS 側に hints として渡す用、各 entry は `(format_id, reason)`。
    pub clipboard_skipped_formats: Vec<ForegroundFlashSkippedFormat>,
    /// Paste warning dialog が検出されたか (検出時は別途 fail で error path に乗る)。
    pub paste_warning_detected: bool,
}

/// `clipboard_skipped_formats` の 1 entry。
#[napi(object)]
pub struct ForegroundFlashSkippedFormat {
    pub format_id: u32,
    /// Skip 理由: `"non_hglobal"` / `"deferred_render"` / `"unknown_private"`。
    pub reason: String,
}

/// Typed error reason. JS 側は `error.code` で受け取り、`reason` enum として扱う。
/// (本 skeleton では String で表現、Phase 1c 本実装で typed error 化検討)
#[derive(Debug)]
#[allow(dead_code)]
pub enum ForegroundFlashErrorReason {
    /// Input が改行を含む or 5KiB 超 = WT paste warning trigger 範囲。
    InputExceedsPasteWarningThreshold,
    /// Foreground steal ladder 全段 fail (= caller 自身が foreground 権を持たない、
    /// AttachThreadInput でも Alt unlock でも盗めない)。
    ForegroundStealDenied,
    /// `wait_focus_ready` polling timeout (default 30ms 以内に WT が focus を取れず)。
    FocusWaitTimeout,
    /// `OpenClipboard` retry 上限 (100ms / 10 retry) を超えた race。
    ClipboardLockContention,
    /// Foreground 復帰 retry 上限超過。
    ForegroundRestoreFailed,
    /// Paste warning ContentDialog を検出 → Esc 送信 + fail。
    WtPasteWarningIntercepted,
    /// `SendInput` 0 件 inject (Win11 input restriction 等)。
    SendInputFailed,
}

// ── Public napi binding (Phase 1a skeleton、本実装は Phase 1c) ──────────────

fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u64();
    HWND(val as isize as *mut std::ffi::c_void)
}

/// `method: 'foreground_flash'` channel の native entry point。
///
/// 詳細 sequence は `docs/adr-013-option-e-impl.md` §3.7 参照。
///
/// **本 fn は Phase 1a skeleton**: signature と Result/Options shape のみ確定、
/// body は Phase 1c で本実装。現状は `unimplemented!()` を返さず、
/// 「未実装」typed error で fail する形に留める (skeleton 段階で caller 側に
/// schema mismatch を起こさないため)。
#[napi]
pub fn win32_foreground_flash_inject(
    target_hwnd: BigInt,
    target_pid: u32,
    text: String,
    options: ForegroundFlashOptions,
) -> napi::Result<ForegroundFlashResult> {
    napi_safe_call("win32_foreground_flash_inject", || {
        // Phase 1a skeleton: 引数を一応 touch しておく (unused warning 回避)
        let _ = hwnd_from_bigint(target_hwnd);
        let _ = target_pid;
        let _ = text;
        let _ = options;

        // 本実装は Phase 1c。現状は明示的に "not yet implemented" を返す。
        Err(napi::Error::from_reason(
            "win32_foreground_flash_inject: not yet implemented (Phase 1a skeleton)".to_string(),
        ))
    })
}

// ── Internal helpers (Phase 1c で実装、Phase 1a では skeleton のみ) ────────

/// Foreground steal ladder 段 2: Alt key down/up で foreground lock を一時解除し、
/// 再度 `SetForegroundWindow(target)` を試行する。
///
/// 段 1 (`win32_force_set_foreground_window` = 既存 `input.rs::win32_force_set_foreground_window`)
/// が fail したときの fallback。Microsoft docs 的には「user input 直後の
/// foreground 取得は許可される」性質を利用する well-known trick。
///
/// **Phase 1a skeleton**: signature のみ。本実装 Phase 1c。
#[allow(dead_code)]
fn alt_unlock_then_set_foreground(_target: HWND) -> bool {
    // Phase 1c で実装。skeleton では false を返す = ladder 段 2 fail とみなされる。
    false
}
