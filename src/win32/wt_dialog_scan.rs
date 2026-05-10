//! ADR-013 Option E — WT paste warning dialog scan + Esc (Phase 1e).
//!
//! `foreground_flash` channel の **保険** layer (§3.3.3)。本命は §3.3.1
//! (single-line + 5KiB 未満) + §3.3.2 (Enter 別送信) の構造的回避だが、WT 設定
//! 変更や future update で `largePasteWarning` / `multiLinePasteWarning` が
//! trigger された場合の fail-safe として、Ctrl+V 直後 (foreground restore より前)
//! に UIA で `Microsoft.UI.Xaml.Controls.ContentDialog` を polling scan、
//! 検出時は `VK_ESCAPE` で dismiss + caller に
//! `wt_paste_warning_intercepted` reason を返す。
//!
//! 設計選択:
//! - 既存 UIA singleton COM thread (`crate::uia::thread::execute_with_timeout`)
//!   を再利用 (CoInitialize MTA は singleton 側が一度だけ実施)、別 COM thread
//!   を spawn しない (singleton + apartment-affinity 不変原則 = ADR-007 P5c-0b)
//! - Scan は WT が foreground のうち (= Ctrl+V + Enter 直後、foreground restore
//!   前) に実行する。restore 後だと dialog 検出しても Esc が dismiss 先と一致
//!   せず無効になるため (§3.7 step 17 の plan v3 記述に対する小修正、§5 docs
//!   で言及予定)
//! - **Best-effort**: UIA 失敗 / timeout / engine 未初期化 は false 扱い
//!   (= "not detected") → flash 続行。`scan_paste_warning_dialog` が disabled
//!   の場合は scan 自体スキップ
//!
//! Phase 1e scope: scan + Esc + bool 返却。`paste_warning_detected` 後の
//! reason wiring は foreground_flash.rs 側で実施。

use std::time::{Duration, Instant};

use windows::core::BSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    IUIAutomation, IUIAutomationElement, TreeScope_Descendants, UIA_ClassNamePropertyId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_KEYBOARD, KEYEVENTF_KEYUP, VK_ESCAPE,
};

use crate::uia::thread::{self, UiaContext};

const PASTE_WARNING_CLASS_NAME: &str = "Microsoft.UI.Xaml.Controls.ContentDialog";
const SCAN_INTERVAL_MS: u64 = 10;
const UIA_THREAD_BUFFER_MS: u32 = 200;

/// `scan_and_dismiss_paste_warning` の outcome。
/// **Opus Round 1 P2-3 反映**: 旧 bool 戻りでは「dialog detected but escape send
/// failed」が caller 側 silent drift する盲点を解消、escape 送信成否を separate field
/// として propagate。
#[derive(Debug, Clone, Copy)]
pub struct PasteWarningScanOutcome {
    /// ContentDialog が UIA scan で検出されたか。
    pub detected: bool,
    /// 検出時 `SendInput(VK_ESCAPE)` が想定通り 2 events inject に成功したか。
    /// `detected = false` のとき意味なし (`escape_sent` も false)。
    pub escape_sent: bool,
}

/// Scan for a paste-warning ContentDialog under `target_hwnd_raw` (BigInt
/// から変換済の `isize`)。検出時は `VK_ESCAPE` を SendInput で送信、outcome に
/// detected + escape_sent を返す。検出されないまま `timeout_ms` 経過なら
/// `detected = false`。
///
/// **Best-effort**: UIA singleton COM thread が unavailable / timeout の場合は
/// `detected = false` で返す (= scan 機能なしで flash 続行)。
pub fn scan_and_dismiss_paste_warning(
    target_hwnd_raw: isize,
    timeout_ms: u32,
) -> PasteWarningScanOutcome {
    let detected = thread::execute_with_timeout(
        move |ctx: &UiaContext| -> napi::Result<bool> {
            Ok(scan_inner(ctx, target_hwnd_raw, timeout_ms))
        },
        timeout_ms + UIA_THREAD_BUFFER_MS,
    )
    .unwrap_or(false);

    let mut escape_sent = false;
    if detected {
        escape_sent = send_escape();
    }
    PasteWarningScanOutcome { detected, escape_sent }
}

fn scan_inner(ctx: &UiaContext, target_hwnd_raw: isize, timeout_ms: u32) -> bool {
    let target = HWND(target_hwnd_raw as *mut std::ffi::c_void);
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(timeout_ms as u64) {
        if check_dialog_present(&ctx.automation, target) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(SCAN_INTERVAL_MS));
    }
    false
}

/// `automation.ElementFromHandle(target).FindFirst(class_name=ContentDialog)`
/// を 1 回試行。COM call 失敗 / not found は false で返す (best-effort)。
fn check_dialog_present(automation: &IUIAutomation, target: HWND) -> bool {
    unsafe {
        let root: IUIAutomationElement = match automation.ElementFromHandle(target) {
            Ok(r) => r,
            Err(_) => return false,
        };
        let bstr = BSTR::from(PASTE_WARNING_CLASS_NAME);
        let variant: VARIANT = bstr.into();
        let condition =
            match automation.CreatePropertyCondition(UIA_ClassNamePropertyId, &variant) {
                Ok(c) => c,
                Err(_) => return false,
            };
        // FindFirst は match-not-found で Err (or null wrapper)。本 fn では
        // Ok のみ "detected" と扱う。
        root.FindFirst(TreeScope_Descendants, &condition).is_ok()
    }
}

/// `VK_ESCAPE` down + up を SendInput で 1 batch 送信。返却 = 2 events 全 inject
/// 成功なら true、Win11 input restriction / UIPI 等で 0-1 件 inject なら false。
/// **Opus Round 1 P2-3 反映**: 戻り値で送信成否を caller (foreground_flash.rs) に
/// 伝播、`paste_warning_detected = true` を実際の dismiss 成否と整合化。
fn send_escape() -> bool {
    unsafe {
        let mut inputs: [INPUT; 2] = std::mem::zeroed();
        inputs[0].r#type = INPUT_KEYBOARD;
        inputs[0].Anonymous.ki.wVk = VK_ESCAPE;
        inputs[1].r#type = INPUT_KEYBOARD;
        inputs[1].Anonymous.ki.wVk = VK_ESCAPE;
        inputs[1].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        sent == 2
    }
}
