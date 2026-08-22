//! ADR-035 Phase C-0 — `GetConsoleWindow` binding.
//!
//! Phase C (self-target refusal) has to decide, for a window the user named,
//! whether it is the console this MCP server itself is talking through. ADR-035
//! §3b Round 7 measured circumstantial evidence that it is NOT — every observed
//! server node owned a `conhost.exe` CHILD, which a process that inherited its
//! parent's console would not have — but the decisive check is what
//! `GetConsoleWindow()` actually returns from inside the server process.
//!
//! There was no binding for it: `GetConsoleWindow` had zero references anywhere
//! in `src/` (measured on `d2c108a8`, ADR-035 plan Round 17 K-5). This module is
//! the measurement instrument, not a safety feature — the value it returns is
//! written to the diagnostic log by `src/tools/_resolve-log.ts` and read back as
//! the design input for OQ-P4.

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::Win32::System::Console::GetConsoleWindow;

use super::safety::napi_safe_call;

/// Return the HWND of the console window attached to THIS process, or `None`
/// when the process has no console (`GetConsoleWindow` returns NULL — the
/// documented "not attached" answer, and the case ADR-035 §3b calls out as
/// undefined in the earlier Round 6 design).
///
/// The handle is emitted as a positive `BigInt` through `usize → u64`, the same
/// convention `win32_get_foreground_window` uses, so JS-side comparison against
/// a window handle from any other binding is a plain `===`.
#[napi]
pub fn win32_get_console_window() -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_get_console_window", || {
        // Safety: zero-arg, returns by value. No pointers in, nothing to free —
        // the returned HWND is owned by the console subsystem.
        let h = unsafe { GetConsoleWindow() };
        if h.0.is_null() {
            Ok(None)
        } else {
            Ok(Some(BigInt::from(h.0 as usize as u64)))
        }
    })
}
