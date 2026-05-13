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

/// RAII guard that calls `WTSFreeMemory` on `Drop`. Required because the
/// `for entry in entries` loop allocates `String`s (via
/// `decode_pwstr_to_string`) and pushes them into a `Vec` — either
/// allocation can panic on OOM, and a panic inside `napi_safe_call` is
/// converted into a napi error by `catch_unwind` without running the
/// (manual) deferred WTSFreeMemory call. Using `Drop` instead ensures the
/// wtsapi32-allocated memory is reclaimed even on the panic path.
/// (PR #281 Opus review P2-1.)
struct WtsMemoryGuard(*mut WTS_SESSION_INFOW);
impl Drop for WtsMemoryGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // Safety: pointer was produced by WTSEnumerateSessionsW and
            // has not been freed by anyone else (we are the only owner).
            unsafe { WTSFreeMemory(self.0 as *mut _) };
        }
    }
}

/// Defensive upper bound for `WTSEnumerateSessionsW`'s `count` out-param.
/// `slice::from_raw_parts` requires `len * size_of::<T>() <= isize::MAX`;
/// `count: u32` (max 4G) × `WTS_SESSION_INFOW` size (~24 B) is comfortably
/// below that on x64, but a corrupted call could in principle return a
/// huge count. 4096 is ~50× the worst-case realistic session count and
/// keeps the slice firmly inside `isize::MAX` regardless of host arch.
/// (PR #281 Opus review P2-2.)
const MAX_WTS_SESSION_ROWS: u32 = 4096;

/// Wrap `WTSEnumerateSessionsW`. Returns one entry per Terminal
/// Services session on the local host, or an empty `Vec` when the call
/// fails (locked-down corporate token, low-resource state, etc.). The
/// API is best-effort diagnostic for ADR-017 — it never gates input,
/// so a failure mode of "empty list → `sessionState='unknown'` in the
/// TS classifier" is acceptable.
///
/// `WTSFreeMemory` is invoked via `WtsMemoryGuard::drop` so it runs on
/// every exit path (including OOM panic inside the row-copy loop).
#[napi]
pub fn wts_enumerate_sessions() -> napi::Result<Vec<NativeWtsSessionInfo>> {
    napi_safe_call("wts_enumerate_sessions", || {
        let mut session_info_ptr: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
        let mut count: u32 = 0;

        // Safety: WTSEnumerateSessionsW writes a count + a heap-allocated
        // array pointer that we free via the RAII guard below. The
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
        // got a populated pointer (no guard needed).
        if call_result.is_err() || session_info_ptr.is_null() || count == 0 {
            return Ok(Vec::new());
        }

        // Take ownership of the WTS-allocated memory NOW so that any
        // panic in the row-copy loop below still frees it via `Drop`.
        let _guard = WtsMemoryGuard(session_info_ptr);

        // Defensive cap (P2-2). On a sane host this is unreachable; on a
        // pathological one we'd rather report nothing than feed a
        // gargantuan `count` into `slice::from_raw_parts`.
        let safe_count = count.min(MAX_WTS_SESSION_ROWS) as usize;

        // Safety: WTSEnumerateSessionsW promises `count` valid
        // `WTS_SESSION_INFOW` entries at `session_info_ptr`, and
        // `safe_count <= count` so reading `safe_count` entries is in-bounds.
        // `safe_count * size_of::<WTS_SESSION_INFOW>()` fits in `isize::MAX`
        // by construction (MAX_WTS_SESSION_ROWS is small).
        let entries = unsafe { slice::from_raw_parts(session_info_ptr, safe_count) };
        let mut result: Vec<NativeWtsSessionInfo> = Vec::with_capacity(safe_count);

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

        // `_guard` is dropped here, calling WTSFreeMemory.
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
