//! Shared Win32 native types exposed across the napi boundary.
//!
//! `NativeWin32Rect` mirrors Win32 `RECT` (left/top/right/bottom). The TS
//! wrapper in `src/engine/win32.ts` converts it to `{ x, y, width, height }`
//! to keep the existing public TS shape.
//!
//! `NativeThreadProcessId` collapses the Win32 `GetWindowThreadProcessId`
//! out-pointer + return value into a single struct.

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
