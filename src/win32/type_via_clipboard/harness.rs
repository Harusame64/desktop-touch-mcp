//! Test-only Win32 harness for `type_via_clipboard`'s `#[ignore]`d tests.
//! `#[cfg(test)]` at the `mod` declaration, so none of this is compiled into the
//! shipped addon.
//!
//! Two pieces:
//!
//! - [`EditWindow`] — a real top-level `EDIT` control on its own thread with a
//!   real `GetMessage` pump. It is the paste target for every real-desktop test
//!   in the parent module. Owning the target is what keeps those tests from
//!   typing into the developer's actual applications, and the pump is what makes
//!   Ctrl+V do anything at all: the EDIT proc reacts to the `WM_CHAR` that
//!   `TranslateMessage` produces.
//! - [`key_recorder`] — a `WH_KEYBOARD_LL` recorder, so what `SendInput`
//!   emitted is measured rather than assumed.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DestroyWindow, DispatchMessageW, GetMessageW, PeekMessageW,
    PostThreadMessageW, SendMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    HMENU, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, PEEK_MESSAGE_REMOVE_TYPE, WH_KEYBOARD_LL,
    WINDOW_STYLE, WM_GETTEXT, WM_GETTEXTLENGTH, WM_KEYUP, WM_QUIT, WM_SETTEXT, WM_SYSKEYUP,
    WS_BORDER, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};

use crate::win32::foreground_flash::{
    alt_unlock_then_set_foreground, force_set_foreground_inner, wait_focus_ready,
};

// EDIT control styles (winuser.h `#define`s; windows-rs does not surface them as
// `WINDOW_STYLE` values).
const ES_MULTILINE: u32 = 0x0004;
const ES_AUTOVSCROLL: u32 = 0x0040;
const ES_WANTRETURN: u32 = 0x1000;

const PM_REMOVE: PEEK_MESSAGE_REMOVE_TYPE = PEEK_MESSAGE_REMOVE_TYPE(0x0001);

// ── EDIT window ─────────────────────────────────────────────────────────────

pub(crate) struct EditWindow {
    hwnd: isize,
    tid: u32,
    join: Option<JoinHandle<()>>,
}

impl EditWindow {
    /// Create the window on a dedicated thread and block until it exists.
    ///
    /// The window MUST live on a thread that pumps: HWNDs are thread-affine, and
    /// an EDIT control only reacts to Ctrl+V once `TranslateMessage` has turned
    /// the key event into `WM_CHAR`.
    pub(crate) fn spawn() -> Self {
        let (tx, rx) = mpsc::channel::<(isize, u32)>();
        let join = std::thread::spawn(move || unsafe {
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                w!("EDIT"),
                // MUST be empty: for a control `lpWindowName` is the initial
                // CONTENT, not a caption. A title here would sit in front of
                // every paste and fail every byte-exactness claim.
                w!(""),
                WS_POPUP
                    | WS_VISIBLE
                    | WS_BORDER
                    | WINDOW_STYLE(ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN),
                // Screen corner, small: visible enough to debug by eye, out of
                // the way of whatever the developer is doing.
                0,
                0,
                300,
                120,
                None,
                Some(HMENU::default()),
                None,
                None,
            )
            .expect("CreateWindowExW(EDIT) failed");
            let _ = tx.send((hwnd.0 as isize, GetCurrentThreadId()));

            let mut msg = MSG::default();
            loop {
                let r = GetMessageW(&mut msg, None, 0, 0);
                // 0 = WM_QUIT, -1 = error. Either way we are done.
                if r.0 <= 0 {
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = DestroyWindow(hwnd);
        });

        let (hwnd, tid) = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the EDIT window thread never reported its HWND");
        Self {
            hwnd,
            tid,
            join: Some(join),
        }
    }

    fn hwnd(&self) -> HWND {
        HWND(self.hwnd as *mut c_void)
    }

    /// Bring the window to the foreground with the same ladder production uses,
    /// then wait for the focus to be real rather than merely requested.
    pub(crate) fn focus(&self) -> bool {
        let h = self.hwnd();
        if !force_set_foreground_inner(h) && !alt_unlock_then_set_foreground(h) {
            return false;
        }
        wait_focus_ready(h, 500)
    }

    /// The control's text as UTF-16LE bytes.
    pub(crate) fn text(&self) -> Vec<u8> {
        unsafe {
            let len = SendMessageW(self.hwnd(), WM_GETTEXTLENGTH, None, None).0;
            if len <= 0 {
                return Vec::new();
            }
            let mut buf: Vec<u16> = vec![0; len as usize + 1];
            // WM_GETTEXTLENGTH may over-report; the returned copy count is the
            // authority on where the text ends.
            let copied = SendMessageW(
                self.hwnd(),
                WM_GETTEXT,
                Some(WPARAM(buf.len())),
                Some(LPARAM(buf.as_mut_ptr() as isize)),
            )
            .0;
            if copied <= 0 {
                return Vec::new();
            }
            buf.truncate(copied as usize);
            buf.iter().flat_map(|u| u.to_le_bytes()).collect()
        }
    }

    pub(crate) fn clear(&self) {
        unsafe {
            let empty: [u16; 1] = [0];
            SendMessageW(
                self.hwnd(),
                WM_SETTEXT,
                None,
                Some(LPARAM(empty.as_ptr() as isize)),
            );
        }
    }

    /// Poll until the control's text equals `expected`, or `timeout` elapses.
    /// Returns whatever the last read saw, so a failing assertion can show it.
    pub(crate) fn wait_for_text(&self, expected: &[u8], timeout: Duration) -> Vec<u8> {
        let start = Instant::now();
        let mut last = self.text();
        while start.elapsed() < timeout {
            if last == expected {
                return last;
            }
            std::thread::sleep(Duration::from_millis(5));
            last = self.text();
        }
        last
    }
}

impl Drop for EditWindow {
    fn drop(&mut self) {
        // Post WM_QUIT to the owning thread rather than calling DestroyWindow
        // from here: HWNDs are thread-affine. This also runs while unwinding
        // from a failed assertion, where leaving a topmost window on the
        // developer's screen would be the worst possible parting gift.
        unsafe {
            let _ = PostThreadMessageW(self.tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

// ── WH_KEYBOARD_LL recorder ─────────────────────────────────────────────────

pub(crate) mod key_recorder {
    use super::*;

    /// `(vkCode, scanCode, is_keyup, was_injected)` in arrival order.
    ///
    /// The scan code is recorded because it is the whole point (R-d): the field
    /// the rest of the desktop reads is the one a caller cannot see from inside
    /// this process.
    static RECORDED: Mutex<Vec<(u32, u32, bool, bool)>> = Mutex::new(Vec::new());

    pub(crate) struct Recorder {
        stop: Arc<AtomicBool>,
        join: Option<JoinHandle<()>>,
    }

    impl Recorder {
        pub(crate) fn clear(&self) {
            RECORDED.lock().unwrap().clear();
        }
        pub(crate) fn take(&self) -> Vec<(u32, u32, bool, bool)> {
            std::mem::take(&mut *RECORDED.lock().unwrap())
        }
    }

    impl Drop for Recorder {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(j) = self.join.take() {
                let _ = j.join();
            }
        }
    }

    /// Install the hook on a dedicated pumping thread — a `WH_KEYBOARD_LL`
    /// callback only fires on a thread that pumps, the same constraint
    /// `kbd_hook.rs` documents. `None` when the install was refused.
    pub(crate) fn start() -> Option<Recorder> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let (tx, rx) = mpsc::channel::<bool>();
        let join = std::thread::spawn(move || unsafe {
            let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(rec_proc), None, 0) {
                Ok(h) => h,
                Err(_) => {
                    let _ = tx.send(false);
                    return;
                }
            };
            let _ = tx.send(true);
            while !stop_thread.load(Ordering::Acquire) {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            let _ = UnhookWindowsHookEx(hook);
        });

        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(true) => Some(Recorder {
                stop,
                join: Some(join),
            }),
            _ => {
                stop.store(true, Ordering::Release);
                let _ = join.join();
                None
            }
        }
    }

    /// Records and passes everything through. Unlike `kbd_hook.rs`'s procedure
    /// this one must never swallow an event: doing so would change the input it
    /// exists to observe.
    unsafe extern "system" fn rec_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
        if n_code >= 0 {
            // SAFETY: documented as KBDLLHOOKSTRUCT* for n_code >= 0.
            let kbd: KBDLLHOOKSTRUCT = unsafe { *(l_param.0 as *const KBDLLHOOKSTRUCT) };
            let msg = w_param.0 as u32;
            let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            let injected = kbd.flags.0 & LLKHF_INJECTED.0 != 0;
            if let Ok(mut v) = RECORDED.lock() {
                v.push((kbd.vkCode, kbd.scanCode, is_up, injected));
            }
        }
        unsafe { CallNextHookEx(None, n_code, w_param, l_param) }
    }
}
