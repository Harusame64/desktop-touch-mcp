//! Process metadata (ADR-007 P3): Toolhelp32 walk + per-process identity.
//!
//! Both helpers run under RAII guards so OS handles never leak even on a
//! panic-induced unwind: `SnapshotHandleGuard` wraps the Toolhelp32 snapshot
//! and `ProcessHandleGuard` wraps `OpenProcess` results.
//!
//! `get_process_identity` matches the legacy `getProcessIdentityByPid`
//! contract — partial success returns whatever was retrievable (the process
//! name OR the creation time, never throws on a half-failure). Opus
//! pre-impl review §12.2 codifies this expectation.

use std::sync::atomic::Ordering;

use napi_derive::napi;
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::safety::{napi_safe_call, PANIC_COUNTER};
use super::types::{NativeProcessIdentity, NativeProcessParentEntry};

// ── RAII handle guards ───────────────────────────────────────────────────────

struct SnapshotHandleGuard(HANDLE);
impl Drop for SnapshotHandleGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct ProcessHandleGuard(HANDLE);
impl Drop for ProcessHandleGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

// ── pid → parent_pid map via Toolhelp32 ─────────────────────────────────────

#[napi]
pub fn win32_build_process_parent_map() -> napi::Result<Vec<NativeProcessParentEntry>> {
    napi_safe_call("win32_build_process_parent_map", || {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        let snapshot = match snapshot {
            Ok(h) if !h.is_invalid() => h,
            // Either the call returned Err or it returned INVALID_HANDLE_VALUE.
            // Either way we cannot enumerate; surface an empty map (legacy
            // koffi path returned an empty Map<> in this case as well).
            _ => return Ok(Vec::new()),
        };
        let _snapshot_guard = SnapshotHandleGuard(snapshot);

        let mut entries: Vec<NativeProcessParentEntry> = Vec::with_capacity(256);
        let mut entry = PROCESSENTRY32W {
            // windows-rs `repr(C)` ensures the size matches the OS struct.
            // Setting dwSize is still required by the API contract.
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..unsafe { std::mem::zeroed() }
        };
        if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
            loop {
                // Per-iteration catch_unwind wraps the body; an OOM or other
                // panic during push() must never escape into the Win32 call
                // chain (rare but possible under extreme memory pressure).
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    entries.push(NativeProcessParentEntry {
                        pid: entry.th32ProcessID,
                        parent_pid: entry.th32ParentProcessID,
                    });
                }));
                if result.is_err() {
                    PANIC_COUNTER.fetch_add(1, Ordering::Relaxed);
                    break;
                }
                if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                    break;
                }
            }
        }

        Ok(entries)
    })
}

// ── pid → identity (image name + creation time) ─────────────────────────────

/// Convert a Win32 `FILETIME` (100ns intervals since 1601) to an `f64` of
/// milliseconds. Returns 0.0 when both halves are zero so the caller can
/// treat `0.0` as "creation time unavailable" (legacy contract).
fn filetime_to_ms(ft: FILETIME) -> f64 {
    if ft.dwLowDateTime == 0 && ft.dwHighDateTime == 0 {
        return 0.0;
    }
    let ticks =
        ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64);
    // 1 ms = 10000 ticks. 53 mantissa bits hold ~285,616 years of ms — Win
    // 1601-epoch values from this century stay well inside that.
    (ticks / 10_000) as f64
}

/// Strip the directory + ".exe" suffix from a full process image path.
fn basename_without_exe(path: &str) -> String {
    let last = path
        .rfind(|c: char| c == '\\' || c == '/')
        .map(|i| &path[i + 1..])
        .unwrap_or(path);
    if last.to_ascii_lowercase().ends_with(".exe") {
        last[..last.len() - 4].to_string()
    } else {
        last.to_string()
    }
}

#[napi]
pub fn win32_get_process_identity(pid: u32) -> napi::Result<NativeProcessIdentity> {
    napi_safe_call("win32_get_process_identity", || {
        let mut out = NativeProcessIdentity {
            pid,
            process_name: String::new(),
            process_start_time_ms: 0.0,
        };
        if pid == 0 {
            return Ok(out);
        }

        let handle = match unsafe {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
        } {
            Ok(h) if !h.is_invalid() => h,
            _ => return Ok(out), // complete failure path
        };
        let _handle_guard = ProcessHandleGuard(handle);

        // Step A — image name. Failure here keeps process_name = "" but
        // does NOT short-circuit step B (Opus pre-impl review §12.2).
        {
            let mut buf = [0u16; 260]; // MAX_PATH wchars
            let mut size: u32 = buf.len() as u32;
            let ok = unsafe {
                QueryFullProcessImageNameW(
                    handle,
                    PROCESS_NAME_FORMAT(0),
                    windows::core::PWSTR(buf.as_mut_ptr()),
                    &mut size,
                )
            };
            if ok.is_ok() && size > 0 {
                let path = String::from_utf16_lossy(&buf[..size as usize]);
                out.process_name = basename_without_exe(&path);
            }
        }

        // Step B — creation time. Independent of step A's outcome.
        {
            let mut creation = FILETIME::default();
            let mut exit = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            let ok = unsafe {
                GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user)
            };
            if ok.is_ok() {
                out.process_start_time_ms = filetime_to_ms(creation);
            }
        }

        Ok(out)
    })
}
