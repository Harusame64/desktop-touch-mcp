//! Shared Win32 native types exposed across the napi boundary.
//!
//! `NativeWin32Rect` mirrors Win32 `RECT` (left/top/right/bottom). The TS
//! wrapper in `src/engine/win32.ts` converts it to `{ x, y, width, height }`
//! to keep the existing public TS shape.
//!
//! `NativeThreadProcessId` collapses the Win32 `GetWindowThreadProcessId`
//! out-pointer + return value into a single struct.

use napi::bindgen_prelude::{BigInt, Buffer};
use napi_derive::napi;

#[napi(object)]
pub struct NativeWin32Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[napi(object)]
pub struct NativeThreadProcessId {
    pub thread_id: u32,
    pub process_id: u32,
}

/// Result of `win32_print_window_to_buffer`. `data` is RGBA8 top-down, length
/// equals `width * height * 4`. The TS wrapper hands this through unchanged
/// (the legacy koffi-based `printWindowToBuffer` returned the same shape).
#[napi(object)]
pub struct NativePrintWindowResult {
    pub data: Buffer,
    pub width: u32,
    pub height: u32,
}

/// One monitor's geometry + DPI as captured by `EnumDisplayMonitors`. Kept
/// flat (not nested) to match the existing `NativeWin32Rect` shape and keep
/// the napi marshal layer simple. The TS wrapper rebuilds the
/// `{ bounds, workArea }` nested object expected by `MonitorInfo`.
#[napi(object)]
pub struct NativeMonitorInfo {
    pub handle: BigInt,
    pub primary: bool,
    pub bounds_left: i32,
    pub bounds_top: i32,
    pub bounds_right: i32,
    pub bounds_bottom: i32,
    pub work_left: i32,
    pub work_top: i32,
    pub work_right: i32,
    pub work_bottom: i32,
    pub dpi: u32,
}
