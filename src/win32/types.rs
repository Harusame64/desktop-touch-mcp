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

// ── Win32 Process / Input (ADR-007 P3) ───────────────────────────────────────

/// Outcome of `win32_force_set_foreground_window`. `fgBefore` / `fgAfter`
/// (camelCase via napi-rs) are repacked into snake_case (`fg_before` /
/// `fg_after`) by the TS wrapper to preserve the legacy public shape
/// (Opus pre-impl review §12.3).
#[napi(object)]
pub struct NativeForceFocusResult {
    pub ok: bool,
    pub attached: bool,
    pub fg_before: BigInt,
    pub fg_after: BigInt,
}

/// One row of the (pid, parent_pid) map produced by Toolhelp32Snapshot. The
/// TS wrapper rebuilds the `Map<number, number>` shape that callers expect.
#[napi(object)]
pub struct NativeProcessParentEntry {
    pub pid: u32,
    pub parent_pid: u32,
}

/// Process identity result. Field semantics match the legacy
/// `getProcessIdentityByPid` contract: complete failure yields all-empty
/// fields, partial success returns whatever was retrievable (e.g. the
/// process name without the creation timestamp). `process_start_time_ms`
/// is f64 — Windows ms-since-1601 fits comfortably in 53 mantissa bits
/// for ~285,616 years (Opus pre-impl review §12.4).
#[napi(object)]
pub struct NativeProcessIdentity {
    pub pid: u32,
    pub process_name: String,
    pub process_start_time_ms: f64,
}

/// Scrollbar position snapshot. `page_ratio` (0..1) is precomputed so
/// the TS wrapper does not have to redo the same `(nPos - nMin) / range`
/// math the legacy `readScrollInfo` used.
#[napi(object)]
pub struct NativeScrollInfo {
    pub n_min: i32,
    pub n_max: i32,
    pub n_page: u32,
    pub n_pos: i32,
    pub page_ratio: f64,
}
