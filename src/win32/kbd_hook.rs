//! ADR-013 Option E — LowLevel keyboard block hook (Phase 1d).
//!
//! `foreground_flash` channel が flash 期間中 (steal → paste → restore) に
//! user の keystroke が WT へ漏れる risk (§3.4) を mitigation するための
//! `WH_KEYBOARD_LL` hook。**default OFF**、明示 opt-in でのみ install:
//! - `ForegroundFlashOptions.block_keyboard_during_flash = true`
//! - env `DESKTOP_TOUCH_FOREGROUND_FLASH_BLOCK_KEYBOARD=1`
//!
//! 設計原則:
//! - `LLKHF_INJECTED` flag が立った event (= 我々の SendInput) は **pass-through**、
//!   user-typed event のみ非ゼロ LRESULT で swallow する
//! - hook 手続きは `WH_KEYBOARD_LL` を install した thread の **message pump
//!   が必須** (Microsoft docs)。napi worker thread は flash 中 sync block 中
//!   のため pump できないので、**専用 worker thread** を spawn して install +
//!   pump、`AtomicBool` stop signal + JoinHandle で leak-free に uninstall
//! - install 失敗時は **fail-soft** (None を返す)、flash 自体は続行する
//!   (block_keyboard は best-effort、acceptance §6.1 は leak-free のみ要求)
//!
//! Phase 1d scope: hook lifecycle のみ。Phase 1f で
//! `HookGuard` Drop の leak-free 性 (= UnhookWindowsHookEx の 100% 呼出し)
//! を unit test 化。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Foundation::{HMODULE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, PeekMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, PEEK_MESSAGE_REMOVE_TYPE,
    WH_KEYBOARD_LL,
};

const PM_REMOVE: PEEK_MESSAGE_REMOVE_TYPE = PEEK_MESSAGE_REMOVE_TYPE(0x0001);

// `recv_timeout` upper bound for the worker's "hook installed" signal.
// 500ms は余裕、現実には spawn 直後 ~1ms で signal される。
const READY_TIMEOUT_MS: u64 = 500;

/// Hook procedure 内 polling tick (message pump 間隔)。
const PUMP_INTERVAL_MS: u64 = 1;

#[derive(Debug)]
#[allow(dead_code)]
pub enum HookError {
    /// `SetWindowsHookExW` 失敗 (= UIPI / permission / module handle 取得失敗 等)。
    InstallFailed,
    /// Worker thread が `READY_TIMEOUT_MS` 以内に install signal を返せず。
    InstallTimeout,
}

/// Hook lifetime guard. Drop で worker thread に stop signal を送り、join し、
/// その過程で thread が `UnhookWindowsHookEx` を呼ぶ。
///
/// Drop が呼ばれない経路 (= Rust 側 process abort 等) は OS が hook table を
/// process 終了時に cleanup するため leak しない (Microsoft docs)。
pub struct HookGuard {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Drop for HookGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(h) = self.handle.take() {
            // panic propagation を吸収 (Drop 内で panic させない)
            let _ = h.join();
        }
    }
}

/// LowLevel keyboard hook を install し、worker thread で message pump を
/// 走らせる。返却 `HookGuard` の Drop で uninstall + thread join。
///
/// Best-effort: install fail (UIPI 等) なら `Err(HookError::InstallFailed)`
/// を返す、caller (foreground_flash.rs) は None で受けて flash 続行。
pub fn install_low_level_keyboard_block() -> Result<HookGuard, HookError> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = stop.clone();
    let (ready_tx, ready_rx) = mpsc::channel::<bool>();

    let handle = std::thread::spawn(move || {
        // 1. Install hook on this thread.
        let module: HMODULE = unsafe { GetModuleHandleW(None) }.unwrap_or_default();
        let hook = unsafe {
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(ll_keyboard_proc), Some(module.into()), 0)
        };
        let hook = match hook {
            Ok(h) => h,
            Err(_) => {
                let _ = ready_tx.send(false);
                return;
            }
        };

        // 2. Notify caller that hook is live.
        let _ = ready_tx.send(true);

        // 3. Pump messages until stop signaled.
        //    Microsoft docs: WH_KEYBOARD_LL は installing thread が message を
        //    pump しないと callback が走らない。PeekMessageW で non-block pump。
        while !stop_for_thread.load(Ordering::Acquire) {
            unsafe {
                let mut msg: MSG = std::mem::zeroed();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    let _ = DispatchMessageW(&msg);
                }
            }
            std::thread::sleep(Duration::from_millis(PUMP_INTERVAL_MS));
        }

        // 4. Uninstall on exit.
        unsafe {
            let _ = UnhookWindowsHookEx(hook);
        }
    });

    // Wait for ready signal (up to READY_TIMEOUT_MS).
    let installed = ready_rx
        .recv_timeout(Duration::from_millis(READY_TIMEOUT_MS))
        .unwrap_or(false);
    if !installed {
        // Worker thread either failed to install or didn't respond.
        // Stop it (in case it's still racing) and join.
        stop.store(true, Ordering::Release);
        let _ = handle.join();
        return Err(HookError::InstallFailed);
    }

    Ok(HookGuard {
        stop,
        handle: Some(handle),
    })
}

/// LowLevel keyboard hook 手続き。
///
/// - `n_code < 0`: docs 通り `CallNextHookEx` 必須、pass through
/// - `LLKHF_INJECTED`: SendInput 由来 (= 我々 or 他の app)、pass through
/// - それ以外: user keystroke、`LRESULT(1)` で swallow
unsafe extern "system" fn ll_keyboard_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    if n_code < 0 {
        return unsafe { CallNextHookEx(None, n_code, w_param, l_param) };
    }
    // SAFETY: docs 上 lParam は KBDLLHOOKSTRUCT*。raw read で flags を観測。
    let kbd: KBDLLHOOKSTRUCT = unsafe { *(l_param.0 as *const KBDLLHOOKSTRUCT) };
    if kbd.flags.0 & LLKHF_INJECTED.0 != 0 {
        // 我々 (or 他 process) の injected event は素通し
        return unsafe { CallNextHookEx(None, n_code, w_param, l_param) };
    }
    // Real user keystroke during flash → swallow
    LRESULT(1)
}
