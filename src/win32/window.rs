//! Hot-path window APIs (ADR-007 P1).
//!
//! Every `#[napi]` here calls `napi_safe_call` with a unique name. The
//! `EnumWindows` callback also runs `catch_unwind` internally — Rust panics
//! must never unwind across the Windows ABI callback boundary (UB).

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::Ordering;

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    IsZoomed, GA_ROOT, WINDOW_LONG_PTR_INDEX,
};

use super::safety::{napi_safe_call, PANIC_COUNTER};
use super::types::{NativeThreadProcessId, NativeWin32Rect};

// ─── HWND ↔ BigInt conversion helpers ────────────────────────────────────────

/// Reinterpret the low 64 bits of a JS `bigint` as an `HWND`. The sign-bit
/// from napi's `get_u64` (returns `(sign, value, lossless)`) is intentionally
/// dropped — `value` already holds the low 64 bits we want, and `as isize`
/// preserves the bit pattern on x64 Windows. (The output side
/// `hwnd_to_bigint` always emits a positive bigint, so JS round-trips of
/// HWNDs read from this addon never go negative; we accept negative input
/// only as a defensive concession to other callers.)
fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u64();
    HWND(val as isize as *mut std::ffi::c_void)
}

/// Emit an `HWND` as a positive `BigInt` (always non-negative) by routing
/// through `usize → u64`. JS-side `bigint` is therefore always >= 0n.
fn hwnd_to_bigint(h: HWND) -> BigInt {
    BigInt::from(h.0 as usize as u64)
}

// ─── EnumWindows callback (panic-safe across Windows ABI boundary) ──────────

/// Collect HWNDs into a `Vec<isize>` whose pointer was passed via `lparam`.
/// `Vec::push` may panic on alloc failure; that panic must NOT unwind back
/// into Win32 (UB). We catch it locally and stop enumeration with `BOOL(0)`.
unsafe extern "system" fn enum_windows_collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let result = catch_unwind(AssertUnwindSafe(|| {
        // Safety: lparam is a valid `*mut Vec<isize>` for the duration of the
        // EnumWindows call (allocated by the caller below, lifetime-pinned).
        let vec = unsafe { &mut *(lparam.0 as *mut Vec<isize>) };
        vec.push(hwnd.0 as isize);
    }));
    if result.is_err() {
        PANIC_COUNTER.fetch_add(1, Ordering::Relaxed);
        BOOL(0) // FALSE = stop enumeration
    } else {
        BOOL(1) // TRUE = continue
    }
}

// ─── 10 hot-path APIs ────────────────────────────────────────────────────────

/// Enumerate all top-level windows. Returns HWND values in EnumWindows order
/// (top-down z-order). The caller (TS `enumWindowsInZOrder`) decorates each
/// HWND with title, rect, etc. via the other native APIs in this module.
#[napi]
pub fn win32_enum_top_level_windows() -> napi::Result<Vec<BigInt>> {
    napi_safe_call("win32_enum_top_level_windows", || {
        let mut hwnds: Vec<isize> = Vec::with_capacity(256);
        let lparam = LPARAM(&mut hwnds as *mut Vec<isize> as isize);
        // Safety: enum_windows_collect's lparam expectation matches the
        // pointer we just passed. `hwnds` lives until EnumWindows returns.
        unsafe {
            EnumWindows(Some(enum_windows_collect), lparam)
                .map_err(|e| napi::Error::from_reason(format!("EnumWindows failed: {e}")))?;
        }
        Ok(hwnds
            .into_iter()
            .map(|h| BigInt::from(h as usize as u64))
            .collect())
    })
}

/// Get a window's title via `GetWindowTextW`. Returns `""` on failure or
/// when the window has no title — matching the existing koffi-backed
/// `getWindowTitleW` behavior in `src/engine/win32.ts`.
#[napi]
pub fn win32_get_window_text(hwnd: BigInt) -> napi::Result<String> {
    napi_safe_call("win32_get_window_text", || {
        Ok(get_window_text(hwnd_from_bigint(hwnd)))
    })
}

/// Read a window's bounding rectangle. Returns `None` when the window no
/// longer exists or the call fails (TS wrapper converts to `{ x, y, w, h }`).
#[napi]
pub fn win32_get_window_rect(hwnd: BigInt) -> napi::Result<Option<NativeWin32Rect>> {
    napi_safe_call("win32_get_window_rect", || {
        let h = hwnd_from_bigint(hwnd);
        let mut rect = RECT::default();
        let ok = unsafe { GetWindowRect(h, &mut rect) };
        if ok.is_err() {
            return Ok(None);
        }
        Ok(Some(NativeWin32Rect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }))
    })
}

/// Return the foreground window's HWND, or `None` when there is no
/// foreground window (e.g. lock screen, system process focus).
#[napi]
pub fn win32_get_foreground_window() -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_get_foreground_window", || {
        let h = unsafe { GetForegroundWindow() };
        if h.0.is_null() {
            Ok(None)
        } else {
            Ok(Some(hwnd_to_bigint(h)))
        }
    })
}

/// `IsWindowVisible(hwnd)`. Conservatively `false` on failure.
#[napi]
pub fn win32_is_window_visible(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_is_window_visible", || {
        Ok(unsafe { IsWindowVisible(hwnd_from_bigint(hwnd)).as_bool() })
    })
}

/// `IsIconic(hwnd)` — true iff the window is minimized.
#[napi]
pub fn win32_is_iconic(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_is_iconic", || {
        Ok(unsafe { IsIconic(hwnd_from_bigint(hwnd)).as_bool() })
    })
}

/// `IsZoomed(hwnd)` — true iff the window is maximized.
#[napi]
pub fn win32_is_zoomed(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_is_zoomed", || {
        Ok(unsafe { IsZoomed(hwnd_from_bigint(hwnd)).as_bool() })
    })
}

/// Get a window's registered class name (e.g. `"#32770"` for standard
/// Win32 dialogs). Returns `""` on failure.
#[napi]
pub fn win32_get_class_name(hwnd: BigInt) -> napi::Result<String> {
    napi_safe_call("win32_get_class_name", || {
        let h = hwnd_from_bigint(hwnd);
        let mut buf = [0u16; 256]; // matches existing TS buffer size
        let len = unsafe { GetClassNameW(h, &mut buf) };
        if len <= 0 {
            return Ok(String::new());
        }
        Ok(String::from_utf16_lossy(&buf[..len as usize]))
    })
}

/// Get the (thread, process) ids that own a window. Both fields are 0 on
/// failure (matching the existing `>>> 0` coercion in TS).
#[napi]
pub fn win32_get_window_thread_process_id(
    hwnd: BigInt,
) -> napi::Result<NativeThreadProcessId> {
    napi_safe_call("win32_get_window_thread_process_id", || {
        let h = hwnd_from_bigint(hwnd);
        let mut pid: u32 = 0;
        let tid = unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        Ok(NativeThreadProcessId {
            thread_id: tid,
            process_id: pid,
        })
    })
}

/// `GetWindowLongPtrW(hwnd, nIndex)`. Returns the value as `i32` to match
/// the existing koffi `long` declaration — the TS callers (`exStyle &
/// WS_EX_TOPMOST`, `GWL_EXSTYLE` reads) only consume the low 32 bits.
/// A future BigInt-typed sibling can be added if 64-bit indices like
/// `GWLP_USERDATA` ever become needed (see Opus review §10.7).
#[napi]
pub fn win32_get_window_long_ptr_w(hwnd: BigInt, n_index: i32) -> napi::Result<i32> {
    napi_safe_call("win32_get_window_long_ptr_w", || {
        let h = hwnd_from_bigint(hwnd);
        let v = unsafe { GetWindowLongPtrW(h, WINDOW_LONG_PTR_INDEX(n_index)) };
        // LONG_PTR is isize; truncate to i32 to match the koffi `long` shape.
        Ok(v as i32)
    })
}

// ─── Internal Rust helpers (ADR-007 P5c-1) ──────────────────────────────────
//
// These avoid the napi BigInt / napi::Result round-trip when called from
// other Rust modules (UIA event handlers in particular). The `#[napi]`
// wrappers above delegate to them so the externally observable behaviour is
// unchanged.

/// Get a window's title via `GetWindowTextW`. Returns `""` on failure or
/// when the window has no title.
///
/// Buffer is 512 wchars to match the existing TS behaviour (Windows itself
/// truncates very long titles at 256-512 chars in practice).
pub(crate) fn get_window_text(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if len <= 0 {
        String::new()
    } else {
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

/// Resolve a (possibly child) HWND to its top-level (root) window via
/// `GetAncestor(hwnd, GA_ROOT)`. Falls back to the input `hwnd` when
/// `GetAncestor` returns null (already root, invalid hwnd, or call failed).
///
/// Used by the P5c-1 UIA Focus Changed event handler:
/// `cached_element_to_focus_info` returns the focused element's own hwnd,
/// which is a child-control HWND for Edit/TextBox focus and would yield
/// empty text from `GetWindowTextW`. Normalising via GA_ROOT before
/// reading the title keeps `payload.window_title` stable across child /
/// top-level focus targets.
pub(crate) fn get_root_hwnd(hwnd: HWND) -> HWND {
    // Safety: GetAncestor accepts any HWND (including invalid) and returns
    // a null HWND on failure. No invariants we can violate from Rust.
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if root.0.is_null() {
        hwnd
    } else {
        root
    }
}
