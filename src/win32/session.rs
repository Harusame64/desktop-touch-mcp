//! ADR-017: read-only Terminal Services session observability.
//!
//! Three `#[napi]` bindings wrap the Win32 session APIs (`ProcessIdToSessionId`,
//! `WTSGetActiveConsoleSessionId`, `WTSEnumerateSessionsW`) so the TS-side
//! `desktop_state` handler can derive `sessionLabel` (`'console'|'rdp'|'other'`)
//! and `sessionState` (`'active'|'connected'|'disconnected'|'locked'|'unknown'`)
//! without crossing the napi boundary multiple times.
//!
//! Cross-session control surface (`CreateProcessAsUser`, impersonation, etc.)
//! is explicitly out of scope here per ADR-017 §2.2. These bindings are
//! observability-only and use `napi_safe_call` to contain panics so that an
//! adversarial pid (or a Windows release that adds a new
//! `WTS_CONNECTSTATE_CLASS` value) never crashes the Node process.

use std::slice;

use napi_derive::napi;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTSEnumerateSessionsW, WTSFreeMemory, WTSGetActiveConsoleSessionId,
    WTS_CONNECTSTATE_CLASS, WTS_SESSION_INFOW,
};

use super::safety::napi_safe_call;
use super::types::NativeWtsSessionInfo;

/// Map a Win32 process id to its Terminal Services session id via
/// `ProcessIdToSessionId`. Returns `None` when the pid is invalid, the
/// process is gone, or the call fails — the TS wrapper surfaces that
/// as `null` so the higher-level classifier can fall back to
/// `'unknown'` rather than guess.
#[napi]
pub fn win32_get_process_session_id(pid: u32) -> napi::Result<Option<u32>> {
    napi_safe_call("win32_get_process_session_id", || {
        let mut session_id: u32 = 0;
        // Safety: ProcessIdToSessionId writes one u32 to the supplied
        // pointer. We own the stack slot. The pid value itself is not
        // dereferenced — even all-ones / 0 / stale pids are safe inputs.
        let ok = unsafe { ProcessIdToSessionId(pid, &mut session_id) };
        if ok.is_ok() {
            Ok(Some(session_id))
        } else {
            Ok(None)
        }
    })
}

/// Wrap `WTSGetActiveConsoleSessionId`. Returns the physical console
/// session id, or `0xFFFFFFFF` (`u32::MAX`) — Win32's documented sentinel
/// — when no user is logged in at the console. The TS classifier
/// translates `u32::MAX` to `null` so it never flows into a numeric
/// equality test against `ownSessionId`.
#[napi]
pub fn win32_get_active_console_session_id() -> napi::Result<u32> {
    napi_safe_call("win32_get_active_console_session_id", || {
        // Safety: zero-arg, returns by value. No pointers, no allocations,
        // no failure surface that we can recover from at this layer.
        Ok(unsafe { WTSGetActiveConsoleSessionId() })
    })
}

/// Wrap `WTSEnumerateSessionsW`. Returns one entry per Terminal
/// Services session on the local host, or an empty `Vec` when the call
/// fails (locked-down corporate token, low-resource state, etc.). The
/// API is best-effort diagnostic for ADR-017 — it never gates input,
/// so a failure mode of "empty list → `sessionState='unknown'` in the
/// TS classifier" is acceptable.
///
/// Internally calls `WTSFreeMemory` before returning so the napi-owned
/// `Vec` does not hold any `wtsapi32`-allocated memory across the
/// boundary.
#[napi]
pub fn wts_enumerate_sessions() -> napi::Result<Vec<NativeWtsSessionInfo>> {
    napi_safe_call("wts_enumerate_sessions", || {
        let mut session_info_ptr: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
        let mut count: u32 = 0;

        // Safety: WTSEnumerateSessionsW writes a count + a heap-allocated
        // array pointer that we free via WTSFreeMemory below. The
        // null HANDLE is the documented `WTS_CURRENT_SERVER_HANDLE`
        // sentinel — targets the local host. `Reserved` MUST be 0
        // (documented requirement). Version 1 is the documented
        // version for `WTS_SESSION_INFOW`.
        let call_result = unsafe {
            WTSEnumerateSessionsW(
                Some(HANDLE(std::ptr::null_mut())),
                0,
                1,
                &mut session_info_ptr,
                &mut count,
            )
        };

        // Failure path: return empty Vec without touching the pointer.
        // `call_result` is windows::core::Result<()>; if Err we never
        // got a populated pointer.
        if call_result.is_err() || session_info_ptr.is_null() || count == 0 {
            return Ok(Vec::new());
        }

        // Build the result Vec by copying out fields. We do NOT keep
        // references to the WTS-allocated memory past the WTSFreeMemory
        // call below.
        // Safety: WTSEnumerateSessionsW promises `count` valid
        // `WTS_SESSION_INFOW` entries at `session_info_ptr`.
        let entries = unsafe { slice::from_raw_parts(session_info_ptr, count as usize) };
        let mut result: Vec<NativeWtsSessionInfo> = Vec::with_capacity(count as usize);

        for entry in entries {
            let win_station = decode_pwstr_to_string(entry.pWinStationName.0);
            let state_numeric: u32 = entry.State.0 as u32;
            let state_label = wts_state_to_label(entry.State);
            result.push(NativeWtsSessionInfo {
                session_id: entry.SessionId,
                win_station,
                state: state_numeric,
                state_label,
            });
        }

        // Free the WTS-allocated memory. Must happen even on partial
        // population — `result` already owns its own String allocations.
        // Safety: pointer was produced by WTSEnumerateSessionsW above
        // and we have not freed it yet.
        unsafe { WTSFreeMemory(session_info_ptr as *mut _) };

        Ok(result)
    })
}

/// Decode a null-terminated UTF-16 string pointer (LPWSTR) into a Rust
/// String. Returns `""` when the pointer is null or the string is empty.
/// Used to materialise `WTS_SESSION_INFOW::pWinStationName` (which the
/// WTS API owns; we copy out before `WTSFreeMemory` reclaims it).
fn decode_pwstr_to_string(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    // Walk the buffer to find the null terminator. Cap at a generous
    // upper bound so a missing terminator (provider bug / corrupted
    // memory) cannot drive an infinite read.
    const MAX_LEN: usize = 1024;
    let mut len = 0usize;
    // Safety: we read u16 at a time and stop on 0 or MAX_LEN. The
    // caller guarantees `ptr` came from WTSEnumerateSessionsW which
    // null-terminates the string.
    while len < MAX_LEN {
        let ch = unsafe { *ptr.add(len) };
        if ch == 0 {
            break;
        }
        len += 1;
    }
    if len == 0 {
        return String::new();
    }
    // Safety: we read up to `len` valid u16 values from the same buffer.
    let slice = unsafe { slice::from_raw_parts(ptr, len) };
    String::from_utf16_lossy(slice)
}

/// Map `WTS_CONNECTSTATE_CLASS` values to the lowercase snake-ish labels
/// the TS classifier expects (`'active'` / `'connected'` /
/// `'disconnected'` / etc.). Unknown values surface as
/// `"state_<numeric>"` so the TS layer can still log a meaningful
/// breadcrumb if Microsoft adds a new enum variant in a future Windows
/// release rather than silently collapsing to a misleading label.
///
/// Match-on-numeric (`state.0`) rather than the named `WTS*` constants:
/// the latter are `pub const` (not `enum` variants), and using them in
/// match arms triggers a "constant in pattern" lint that is non-trivial
/// to silence cleanly. The numeric mapping is fixed in the Win32 SDK
/// and unlikely to be renumbered.
fn wts_state_to_label(state: WTS_CONNECTSTATE_CLASS) -> String {
    match state.0 {
        0 => "active".to_string(),
        1 => "connected".to_string(),
        2 => "connect_query".to_string(),
        3 => "shadow".to_string(),
        4 => "disconnected".to_string(),
        5 => "idle".to_string(),
        6 => "listen".to_string(),
        7 => "reset".to_string(),
        8 => "down".to_string(),
        9 => "init".to_string(),
        other => format!("state_{}", other),
    }
}
