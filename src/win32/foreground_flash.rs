//! ADR-013 Option E (`foreground_flash` channel) — Native Win32 layer.
//!
//! `background` 契約とは分離した「妥協 BG = 50ms 程度の foreground flash で
//! WT pane に Clipboard paste + Enter を inject」channel の Rust 本体。
//! `method: 'foreground_flash'` 明示 opt-in でのみ caller 側から到達される。
//!
//! 設計詳細: `docs/adr-013-option-e-impl.md` v3。
//! 関連 spike: `spike/wt-attachconsole-input` branch + `docs/wt-bg-spike-round2-findings.md`。
//!
//! Phase 進行:
//! - Phase 1a: skeleton (signature + types) ✅
//! - Phase 1b: clipboard_snapshot module (HGLOBAL save/restore + 3 point sequence) ✅
//! - **Phase 1c**: foreground_flash main impl (steal ladder + Alt unlock + SendInput + verify) ← 本 file
//! - Phase 1d: kbd_hook module (option, default OFF)
//! - Phase 1e: wt_dialog_scan module (option, default ON for paste warning fail-safe)
//! - Phase 1f: unit test

use std::time::{Duration, Instant};

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_CONTROL, VK_MENU, VK_RETURN, VK_V,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId,
    SetForegroundWindow, GUITHREADINFO,
};

use super::clipboard_snapshot::{
    restore_clipboard_supported_formats, save_clipboard_supported_formats,
    set_clipboard_unicode_text, with_hidden_owner, ClipboardSnapshot, RestoreOutcome,
};
use super::kbd_hook::{install_low_level_keyboard_block, HookGuard};
use super::safety::napi_safe_call;
use super::wt_dialog_scan::scan_and_dismiss_paste_warning;

// ── Constants ───────────────────────────────────────────────────────────────

/// 5KiB threshold for `largePasteWarning` 構造的回避 (UTF-16 byte count、
/// `>= 5120` で fail)。WT default 1KiB より余裕、user 設定で変動可なので 5KiB。
const MAX_TEXT_UTF16_BYTES: usize = 5120;
const DEFAULT_FOCUS_WAIT_MS: u32 = 30;
const DEFAULT_FOREGROUND_RESTORE_RETRIES: u32 = 2;
const FOREGROUND_RESTORE_VERIFY_TIMEOUT_MS: u32 = 10;
/// Ctrl+V 後 WT が paste reflect するのを待つ delay (Enter 送信 / restore より前)。
const PASTE_REFLECT_DELAY_MS: u64 = 30;
const POLL_INTERVAL_MS: u64 = 2;
/// WT paste warning ContentDialog scan timeout (Phase 1e、§3.3.3 保険)。
/// 構造的回避 (§3.3.1) で trigger 確率は ~0、保険として short window で polling。
const PASTE_WARNING_SCAN_TIMEOUT_MS: u32 = 100;

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
    /// **本 phase (1c) では未配線、Phase 1d で実装**。
    pub block_keyboard_during_flash: Option<bool>,
    /// WT paste warning ContentDialog を flash 後 scan + Esc 拒否する (default true)。
    /// env `DESKTOP_TOUCH_FOREGROUND_FLASH_DISABLE_DIALOG_SCAN=1` で OFF 切替可。
    /// **本 phase (1c) では未配線、Phase 1e で実装**。
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
    /// Clipboard 復元が実施されたか (false = race detected で skip、または restore 中 fail)。
    pub clipboard_restored: bool,
    /// Clipboard save 時に skip された format (非 HGLOBAL / deferred render)。
    /// JS 側に hints として渡す用、各 entry は `(format_id, reason)`。
    pub clipboard_skipped_formats: Vec<ForegroundFlashSkippedFormat>,
    /// Paste warning dialog が検出されたか (検出時は別途 fail で error path に乗る)。
    /// **本 phase (1c) では常に false、Phase 1e で実装**。
    pub paste_warning_detected: bool,
}

/// `clipboard_skipped_formats` の 1 entry。
#[napi(object)]
pub struct ForegroundFlashSkippedFormat {
    pub format_id: u32,
    /// Skip 理由: `"non_hglobal"` / `"deferred_render"` / `"get_data_failed"`。
    pub reason: String,
}

/// Typed error reason. JS 側は `error.message` で受け取り、Phase 3 TS engine
/// 層で parse して typed reason として扱う (Zod schema 拡張 §5.4)。
///
/// 各 variant の string 形は `as_str()` で取得 (snake_case)。
#[derive(Debug, Clone, Copy)]
pub enum ForegroundFlashErrorReason {
    /// Input が改行を含む or 5KiB 超 = WT paste warning trigger 範囲。
    InputExceedsPasteWarningThreshold,
    /// Foreground steal ladder 全段 fail (= caller 自身が foreground 権を持たない、
    /// AttachThreadInput でも Alt unlock でも盗めない)。
    ForegroundStealDenied,
    /// `wait_focus_ready` polling timeout (default 30ms 以内に WT が focus を取れず)。
    FocusWaitTimeout,
    /// `OpenClipboard` retry 上限 (100ms / 10 retry) を超えた race。
    /// (現状は ClipboardError::OpenContention から `clipboard_lock_contention`
    /// 文字列として伝播、本 enum variant は将来 typed 化のための placeholder)
    #[allow(dead_code)]
    ClipboardLockContention,
    /// Foreground 復帰 retry 上限超過。
    ForegroundRestoreFailed,
    /// Paste warning ContentDialog を検出 → Esc 送信 + fail (§3.3.3)。
    WtPasteWarningIntercepted,
    /// `SendInput` が想定より少ない数しか inject できなかった (Win11 input restriction 等)。
    SendInputFailed,
}

impl ForegroundFlashErrorReason {
    pub fn as_str(self) -> &'static str {
        use ForegroundFlashErrorReason::*;
        match self {
            InputExceedsPasteWarningThreshold => "input_exceeds_paste_warning_threshold",
            ForegroundStealDenied => "foreground_steal_denied",
            FocusWaitTimeout => "focus_wait_timeout",
            ClipboardLockContention => "clipboard_lock_contention",
            ForegroundRestoreFailed => "foreground_restore_failed",
            WtPasteWarningIntercepted => "wt_paste_warning_intercepted",
            SendInputFailed => "send_input_failed",
        }
    }
}

fn err(reason: ForegroundFlashErrorReason) -> napi::Error {
    napi::Error::from_reason(reason.as_str().to_string())
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u64();
    HWND(val as isize as *mut std::ffi::c_void)
}

/// Pre-flight input validation (§3.3.1: single-line + < 5KiB UTF-16).
/// 改行 (LF / CR) が混入すると WT `multiLinePasteWarning` の trigger になるため
/// 構造的に拒否、5KiB 超は `largePasteWarning` の閾値に余裕を見て拒否。
fn validate_input(text: &str) -> Result<(), ForegroundFlashErrorReason> {
    if text.contains('\n') || text.contains('\r') {
        return Err(ForegroundFlashErrorReason::InputExceedsPasteWarningThreshold);
    }
    let utf16_byte_count = text.encode_utf16().count() * 2;
    if utf16_byte_count >= MAX_TEXT_UTF16_BYTES {
        return Err(ForegroundFlashErrorReason::InputExceedsPasteWarningThreshold);
    }
    Ok(())
}

/// Foreground steal ladder 段 1: `AttachThreadInput` で foreground thread に
/// 自分の input queue を結合してから `SetForegroundWindow` を呼ぶ既存 trick。
///
/// 既存 `input.rs::win32_force_set_foreground_window` (PR #74 ADR-007 P3) と
/// 同じ logic を bool 戻り値版で inline。理由: 同 PR 内で input.rs の
/// 公開 napi 関数 signature を変更しないため (Tool surface 不変原則 §2 P7)。
fn force_set_foreground_inner(target: HWND) -> bool {
    unsafe {
        let fg_before = GetForegroundWindow();
        if fg_before.0 == target.0 {
            // 既に foreground、attach dance 不要
            return true;
        }
        let fg_thread = GetWindowThreadProcessId(fg_before, None);
        let my_thread = GetCurrentThreadId();
        let mut attached = false;
        if fg_thread != 0 && fg_thread != my_thread {
            attached = AttachThreadInput(my_thread, fg_thread, true).as_bool();
        }
        // BringWindowToTop は AttachThreadInput が fail しても効く secondary hint。
        let _ = SetForegroundWindow(target);
        let _ = BringWindowToTop(target);
        if attached {
            let _ = AttachThreadInput(my_thread, fg_thread, false);
        }
        let fg_after = GetForegroundWindow();
        fg_after.0 == target.0
    }
}

/// Foreground steal ladder 段 2: Alt key down/up で foreground lock を一時解除し、
/// 再度 `SetForegroundWindow(target)` を試行する well-known trick。
///
/// Microsoft docs 的には「user input 直後の foreground 取得は許可される」性質を利用する。
/// `SendInput` の Alt down/up が calling thread の last-input-time を更新することで
/// `LockSetForegroundWindow` の制約が一時的に解除される。
fn alt_unlock_then_set_foreground(target: HWND) -> bool {
    unsafe {
        let mut inputs: [INPUT; 2] = std::mem::zeroed();
        inputs[0].r#type = INPUT_KEYBOARD;
        inputs[0].Anonymous.ki.wVk = VK_MENU;
        inputs[0].Anonymous.ki.dwFlags = KEYBD_EVENT_FLAGS(0);
        inputs[1].r#type = INPUT_KEYBOARD;
        inputs[1].Anonymous.ki.wVk = VK_MENU;
        inputs[1].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        if sent < 2 {
            return false;
        }
        // last-input-time が反映されるのを 1 tick 待つ
        std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        force_set_foreground_inner(target)
    }
}

/// `GetForegroundWindow == wt_hwnd` + `GetGUIThreadInfo.hwndFocus != NULL` の
/// 両方が成立するまで polling (上限 `timeout_ms`、interval 2ms)。
///
/// `wt_hwnd` の thread が foreground かつ何らかの child element に focus を
/// 持っている状態を「paste 受け取り可」とみなす (§3.5)。
fn wait_focus_ready(wt_hwnd: HWND, timeout_ms: u32) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(timeout_ms as u64) {
        unsafe {
            if GetForegroundWindow().0 == wt_hwnd.0 {
                let mut info: GUITHREADINFO = std::mem::zeroed();
                info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
                let wt_tid = GetWindowThreadProcessId(wt_hwnd, None);
                if wt_tid != 0
                    && GetGUIThreadInfo(wt_tid, &mut info).is_ok()
                    && !info.hwndFocus.0.is_null()
                {
                    return true;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
    }
    false
}

/// Compose `[(VIRTUAL_KEY, is_keyup)]` → SendInput batch。
/// 全 event が accept された (= `SendInput` 戻り値 == seq.len()) なら true。
fn send_keys(seq: &[(VIRTUAL_KEY, bool)]) -> bool {
    unsafe {
        let mut inputs: Vec<INPUT> = vec![std::mem::zeroed(); seq.len()];
        for (i, (vk, is_up)) in seq.iter().enumerate() {
            inputs[i].r#type = INPUT_KEYBOARD;
            inputs[i].Anonymous.ki.wVk = *vk;
            if *is_up {
                inputs[i].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
            }
        }
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        sent as usize == seq.len()
    }
}

fn send_ctrl_v() -> bool {
    send_keys(&[
        (VK_CONTROL, false),
        (VK_V, false),
        (VK_V, true),
        (VK_CONTROL, true),
    ])
}

fn send_enter() -> bool {
    send_keys(&[
        (VK_RETURN, false),
        (VK_RETURN, true),
    ])
}

/// `GetForegroundWindow == original` を polling で確認 (上限 `timeout_ms`、
/// interval 2ms)。foreground 復帰が反映されるまで多少 lag するため short loop。
fn verify_foreground_returned(original: HWND, timeout_ms: u32) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(timeout_ms as u64) {
        unsafe {
            if GetForegroundWindow().0 == original.0 {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
    }
    false
}

fn build_skipped_formats(snapshot: &ClipboardSnapshot) -> Vec<ForegroundFlashSkippedFormat> {
    snapshot
        .skipped_summary()
        .into_iter()
        .map(|(format_id, reason)| ForegroundFlashSkippedFormat {
            format_id,
            reason: reason.to_string(),
        })
        .collect()
}

// ── Public napi binding (Phase 1c 本実装) ──────────────────────────────────

/// `method: 'foreground_flash'` channel の native entry point。
///
/// 詳細 sequence は `docs/adr-013-option-e-impl.md` §3.7 参照。本 fn は:
///
/// 1. Pre-flight validate (改行禁止 + 5KiB 未満)
/// 2. `with_hidden_owner` scope 内で hidden owner HWND を確保
/// 3. Clipboard snapshot 取得 (HGLOBAL 系のみ、3 point sequence の 1 つ目)
/// 4. Set our text via `set_clipboard_unicode_text` (3 point の 2 つ目)
/// 5. Foreground steal ladder (段 1 AttachThreadInput → 段 2 Alt unlock)
/// 6. `wait_focus_ready` で focus 確認
/// 7. SendInput(Ctrl+V)
/// 8. Sleep 30ms (paste reflect 待ち)
/// 9. (option) SendInput(VK_RETURN)
/// 10. Foreground restore ladder + verify (retry 込み)
/// 11. Clipboard restore (3 point sequence 3 つ目で race 検出 → skip)
/// 12. (Phase 1e) WT paste warning dialog scan
///
/// 各 fail は typed reason を `error.message` 経由で JS に渡す。
#[napi]
pub fn win32_foreground_flash_inject(
    target_hwnd: BigInt,
    target_pid: u32,
    text: String,
    options: ForegroundFlashOptions,
) -> napi::Result<ForegroundFlashResult> {
    napi_safe_call("win32_foreground_flash_inject", || {
        // `target_pid` は `AllowSetForegroundWindow(targetPid)` 呼び出しの将来予約。
        // 現状: §3.1 の通り caller 自身の SetForegroundWindow 制限は bypass しない
        // (target 側が pre-allowed になるだけで、caller が thief になる場面では
        //  AttachThreadInput / Alt unlock の方が本質)。よって本 phase では未使用。
        let _ = target_pid;
        let target = hwnd_from_bigint(target_hwnd);

        // 1. Pre-flight validate
        validate_input(&text).map_err(err)?;

        let max_focus_wait_ms = options
            .max_focus_wait_ms
            .unwrap_or(DEFAULT_FOCUS_WAIT_MS);
        let foreground_restore_retries = options
            .foreground_restore_retries
            .unwrap_or(DEFAULT_FOREGROUND_RESTORE_RETRIES);
        let press_enter = options.press_enter.unwrap_or(false);
        // block_keyboard_during_flash: option > env > default false
        let block_keyboard = options.block_keyboard_during_flash.unwrap_or(false)
            || std::env::var("DESKTOP_TOUCH_FOREGROUND_FLASH_BLOCK_KEYBOARD")
                .as_deref()
                == Ok("1");
        // scan_paste_warning_dialog: option > env (disable) > default true
        // env `DESKTOP_TOUCH_FOREGROUND_FLASH_DISABLE_DIALOG_SCAN=1` で OFF
        let scan_paste_warning = options.scan_paste_warning_dialog.unwrap_or(true)
            && std::env::var("DESKTOP_TOUCH_FOREGROUND_FLASH_DISABLE_DIALOG_SCAN")
                .as_deref()
                != Ok("1");

        // Hook is best-effort: install fail でも flash 続行。`HookGuard` は
        // closure 末尾まで保持され、Drop で worker thread join + uninstall。
        let _hook_guard: Option<HookGuard> = if block_keyboard {
            install_low_level_keyboard_block().ok()
        } else {
            None
        };

        let start = Instant::now();

        // `with_hidden_owner` 全体で hidden owner HWND を保持 → save / set / restore
        // 全 phase に渡って同じ owner を使う (per-call lifecycle)。
        let result: napi::Result<ForegroundFlashResult> = with_hidden_owner(|owner| -> napi::Result<ForegroundFlashResult> {
            let original_fg = unsafe { GetForegroundWindow() };
            let already_foreground = !target.0.is_null() && original_fg.0 == target.0;

            // 2. Save clipboard (3 point の 1 つ目)
            let snapshot = save_clipboard_supported_formats(owner)
                .map_err(|e| napi::Error::from_reason(e.as_reason().to_string()))?;

            // 3. Inject our text (3 point の 2 つ目 = seq_after_inject_clipboard)
            let seq_after_inject = set_clipboard_unicode_text(owner, &text)
                .map_err(|e| napi::Error::from_reason(e.as_reason().to_string()))?;

            // ここから先の inner 処理は **必ず clipboard restore を試みる**。
            // 4-10 を IIFE に閉じて Result を返し、後段で restore + propagate。
            //
            // `paste_warning_detected` は IIFE 内で set される、IIFE 完了後
            // (foreground restore 込み) に reason 化判定 (§3.7 step 17 を
            // step 12.5 へ前倒し: WT が foreground のうちに Esc が dismiss
            // 先と一致するため。Phase 5 docs で deviation 言及予定)。
            let mut paste_warning_detected = false;
            let inner: napi::Result<(&'static str, u32)> = (|| {
                // 4. Foreground steal ladder
                let steal_method = if already_foreground {
                    "already_foreground"
                } else if force_set_foreground_inner(target) {
                    "AttachThreadInput"
                } else if alt_unlock_then_set_foreground(target) {
                    "alt_unlock"
                } else {
                    return Err(err(ForegroundFlashErrorReason::ForegroundStealDenied));
                };

                // 5. Wait focus ready
                if !wait_focus_ready(target, max_focus_wait_ms) {
                    return Err(err(ForegroundFlashErrorReason::FocusWaitTimeout));
                }

                // 6. SendInput Ctrl+V
                if !send_ctrl_v() {
                    return Err(err(ForegroundFlashErrorReason::SendInputFailed));
                }

                // 7. Paste reflect delay
                std::thread::sleep(Duration::from_millis(PASTE_REFLECT_DELAY_MS));

                // 8. Optional Enter (text に \n を含めない構造的回避と paired)
                if press_enter && !send_enter() {
                    return Err(err(ForegroundFlashErrorReason::SendInputFailed));
                }

                // 8.5. WT paste warning ContentDialog scan (Phase 1e、§3.3.3
                //      保険)。WT が foreground のうちに UIA scan + Esc を実行、
                //      検出したら detected フラグだけ立てて foreground restore
                //      には進む (cleanup 整合)。
                if scan_paste_warning {
                    let target_raw = target.0 as isize;
                    if scan_and_dismiss_paste_warning(
                        target_raw,
                        PASTE_WARNING_SCAN_TIMEOUT_MS,
                    ) {
                        paste_warning_detected = true;
                    }
                }

                // 9-10. Foreground restore (ladder + verify) with retries
                // already_foreground なら restore 不要 (= original == target、現在も target)
                if already_foreground {
                    return Ok((steal_method, 0));
                }
                let mut restore_retries_used = 0u32;
                let mut foreground_restored = false;
                for attempt in 0..=foreground_restore_retries {
                    if force_set_foreground_inner(original_fg)
                        && verify_foreground_returned(
                            original_fg,
                            FOREGROUND_RESTORE_VERIFY_TIMEOUT_MS,
                        )
                    {
                        foreground_restored = true;
                        restore_retries_used = attempt;
                        break;
                    }
                    if alt_unlock_then_set_foreground(original_fg)
                        && verify_foreground_returned(
                            original_fg,
                            FOREGROUND_RESTORE_VERIFY_TIMEOUT_MS,
                        )
                    {
                        foreground_restored = true;
                        restore_retries_used = attempt;
                        break;
                    }
                }
                if !foreground_restored {
                    return Err(err(ForegroundFlashErrorReason::ForegroundRestoreFailed));
                }
                Ok((steal_method, restore_retries_used))
            })();

            // 11. Always attempt clipboard restore (3 point sequence inside checks
            //     `seq_before_restore == seq_after_inject_clipboard`)
            let restore_outcome =
                restore_clipboard_supported_formats(&snapshot, owner, seq_after_inject);
            let clipboard_restored = matches!(restore_outcome, RestoreOutcome::Restored);
            let clipboard_skipped_formats = build_skipped_formats(&snapshot);

            // Propagate inner error AFTER restore attempt
            let (steal_method, restore_retries_used) = inner?;

            // Paste warning が detected なら全 cleanup 後に typed reason で fail。
            // 構造的回避が破られた fail-safe path (§3.3.3)。
            if paste_warning_detected {
                return Err(err(ForegroundFlashErrorReason::WtPasteWarningIntercepted));
            }

            // u32 saturation: flash > ~49 day になるはずないが念のため
            let flash_duration_ms = start
                .elapsed()
                .as_millis()
                .min(u32::MAX as u128) as u32;

            Ok(ForegroundFlashResult {
                flash_duration_ms,
                foreground_steal_method: steal_method.to_string(),
                foreground_restored: true,
                foreground_restore_retries_used: restore_retries_used,
                clipboard_restored,
                clipboard_skipped_formats,
                paste_warning_detected: false,
            })
        })
        .map_err(|e| napi::Error::from_reason(e.as_reason().to_string()))?;

        result
    })
}

// ── Unit tests (Phase 1f) ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // validate_input (§3.3.1 single-line + 5KiB limit) は pure logic、
    // 副作用なしで CI default 実行可能。

    #[test]
    fn validate_input_accepts_short_single_line() {
        assert!(validate_input("hello world").is_ok());
        assert!(validate_input("echo HELLO").is_ok());
        assert!(validate_input("").is_ok());
        assert!(validate_input("a").is_ok());
    }

    #[test]
    fn validate_input_rejects_lf() {
        let r = validate_input("hello\nworld");
        assert!(matches!(
            r,
            Err(ForegroundFlashErrorReason::InputExceedsPasteWarningThreshold)
        ));
    }

    #[test]
    fn validate_input_rejects_cr() {
        let r = validate_input("hello\rworld");
        assert!(matches!(
            r,
            Err(ForegroundFlashErrorReason::InputExceedsPasteWarningThreshold)
        ));
    }

    #[test]
    fn validate_input_rejects_crlf() {
        let r = validate_input("hello\r\nworld");
        assert!(matches!(
            r,
            Err(ForegroundFlashErrorReason::InputExceedsPasteWarningThreshold)
        ));
    }

    #[test]
    fn validate_input_accepts_just_under_5kib_threshold() {
        // 2559 ASCII chars = 5118 bytes UTF-16, < 5120
        let s = "a".repeat(2559);
        assert!(validate_input(&s).is_ok());
    }

    #[test]
    fn validate_input_rejects_at_5kib_threshold() {
        // 2560 ASCII chars = 5120 bytes UTF-16, >= 5120
        let s = "a".repeat(2560);
        let r = validate_input(&s);
        assert!(matches!(
            r,
            Err(ForegroundFlashErrorReason::InputExceedsPasteWarningThreshold)
        ));
    }

    #[test]
    fn validate_input_rejects_above_5kib_threshold() {
        let s = "a".repeat(10_000);
        let r = validate_input(&s);
        assert!(matches!(
            r,
            Err(ForegroundFlashErrorReason::InputExceedsPasteWarningThreshold)
        ));
    }

    #[test]
    fn validate_input_counts_utf16_not_utf8() {
        // 日本語 1 char = UTF-16 2 bytes (BMP) but UTF-8 3 bytes.
        // 2559 文字 = 5118 UTF-16 bytes, < 5120 → OK
        let s = "あ".repeat(2559);
        assert!(validate_input(&s).is_ok());
        // 2560 文字 = 5120 UTF-16 bytes → reject
        let s = "あ".repeat(2560);
        let r = validate_input(&s);
        assert!(matches!(
            r,
            Err(ForegroundFlashErrorReason::InputExceedsPasteWarningThreshold)
        ));
    }

    #[test]
    fn error_reason_strings_are_snake_case() {
        use ForegroundFlashErrorReason::*;
        assert_eq!(
            InputExceedsPasteWarningThreshold.as_str(),
            "input_exceeds_paste_warning_threshold"
        );
        assert_eq!(ForegroundStealDenied.as_str(), "foreground_steal_denied");
        assert_eq!(FocusWaitTimeout.as_str(), "focus_wait_timeout");
        assert_eq!(ClipboardLockContention.as_str(), "clipboard_lock_contention");
        assert_eq!(ForegroundRestoreFailed.as_str(), "foreground_restore_failed");
        assert_eq!(
            WtPasteWarningIntercepted.as_str(),
            "wt_paste_warning_intercepted"
        );
        assert_eq!(SendInputFailed.as_str(), "send_input_failed");
    }

    #[test]
    fn err_helper_wraps_reason_into_napi_error_message() {
        let e = err(ForegroundFlashErrorReason::FocusWaitTimeout);
        assert_eq!(e.reason, "focus_wait_timeout");
    }
}

