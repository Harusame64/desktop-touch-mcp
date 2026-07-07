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
use windows::core::{PCWSTR, PWSTR};
use windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
use windows::Win32::Foundation::{
    CloseHandle, LocalFree, FILETIME, HANDLE, HLOCAL, STATUS_BUFFER_OVERFLOW,
    STATUS_BUFFER_TOO_SMALL, STATUS_INFO_LENGTH_MISMATCH, STATUS_SUCCESS, UNICODE_STRING,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::CommandLineToArgvW;

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

// ── pid → command-line argv (ADR-014 v2 R3 L3-4 W-0) ────────────────────────

/// Read a process's command line as argv via `NtQueryInformationProcess(
/// ProcessCommandLineInformation)` (Windows 8.1+). This needs only
/// `PROCESS_QUERY_LIMITED_INFORMATION` — the SAME right the identity query uses
/// — and does NO cross-process memory read (the OS copies the string into OUR
/// buffer). Split with `CommandLineToArgvW` for byte-exact parity with how the
/// process was actually launched (quote/backslash rules), so the L3-4 caller can
/// reuse `interactiveSshTarget` to tell an interactive in-bound `ssh host` from a
/// tunnel (`-N`/`-f`/`-L`) or one-shot (`ssh host cmd`).
///
/// Returns `None` on ANY failure — a dead pid, ACCESS_DENIED on an elevated /
/// cross-user target, a non-success NTSTATUS, an empty line, or a split failure —
/// so the W-2b fail-safe treats "unreadable" as "possibly interactive" (decline,
/// never disclose). Never throws (RAII handle guard + panic guard mirror the
/// identity path). `LocalFree` releases the `CommandLineToArgvW` allocation.
#[napi]
pub fn win32_get_process_command_line(pid: u32) -> napi::Result<Option<Vec<String>>> {
    napi_safe_call("win32_get_process_command_line", || {
        if pid == 0 {
            return Ok(None);
        }

        let handle = match unsafe {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
        } {
            Ok(h) if !h.is_invalid() => h,
            _ => return Ok(None),
        };
        let _handle_guard = ProcessHandleGuard(handle);

        // Query ProcessCommandLineInformation. Start with a 4 KiB buffer and grow
        // once to the reported length if the OS signals a mismatch. Command lines
        // are bounded; cap the grow so a bogus length can't drive a huge alloc.
        let mut buf = vec![0u8; 4096];
        let mut ret_len: u32 = 0;
        let mut status = unsafe {
            NtQueryInformationProcess(
                handle,
                ProcessCommandLineInformation,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                buf.len() as u32,
                &mut ret_len,
            )
        };
        // A command line that overflows the initial 4 KiB buffer is reported for
        // this info class as STATUS_INFO_LENGTH_MISMATCH, but defensively treat the
        // generic short-buffer codes the same way (an OS/version could report
        // STATUS_BUFFER_OVERFLOW / STATUS_BUFFER_TOO_SMALL): grow once to the
        // reported length (capped) and retry, so a long-but-readable ssh command
        // line isn't misread as "unreadable" and force-declined. A still-short or
        // otherwise non-success second status falls through to the fail-safe None
        // below. (Codex PR#510 R6 P2.)
        let short_buffer = status == STATUS_INFO_LENGTH_MISMATCH
            || status == STATUS_BUFFER_OVERFLOW
            || status == STATUS_BUFFER_TOO_SMALL;
        if short_buffer && (ret_len as usize) > buf.len() {
            let cap = (ret_len as usize).min(128 * 1024);
            buf = vec![0u8; cap];
            status = unsafe {
                NtQueryInformationProcess(
                    handle,
                    ProcessCommandLineInformation,
                    buf.as_mut_ptr() as *mut core::ffi::c_void,
                    buf.len() as u32,
                    &mut ret_len,
                )
            };
        }
        if status != STATUS_SUCCESS {
            return Ok(None);
        }

        // The buffer begins with a UNICODE_STRING whose `Buffer` points just past
        // the header, INSIDE `buf` (a local query — not the target's memory).
        if (ret_len as usize) < std::mem::size_of::<UNICODE_STRING>() {
            return Ok(None);
        }
        // Read the UNICODE_STRING header via read_unaligned: `buf` is a Vec<u8>
        // (Rust guarantees only byte alignment), so forming `&UNICODE_STRING`
        // directly would be UB regardless of the later checks. Copy the header
        // fields into a properly aligned local — UNICODE_STRING is Copy — before
        // inspecting them (Codex PR#510 P2).
        let header = std::mem::size_of::<UNICODE_STRING>();
        let us: UNICODE_STRING =
            unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const UNICODE_STRING) };

        // Fail-safe bounds validation (Codex PR#510 P2): before forming the wide
        // slice, prove the whole [Buffer, Buffer+Length) span lies within the
        // bytes the kernel ACTUALLY returned. `Buffer` must sit past the header
        // and inside `buf`, be 2-byte aligned, and `Length` (a BYTE count) must be
        // even for UTF-16. Any inconsistency (e.g. an OS behavior change or a
        // capped retry) fails safe to None rather than reading outside the local
        // query buffer.
        let len_bytes = us.Length as usize;
        let returned = (ret_len as usize).min(buf.len());
        let buf_start = buf.as_ptr() as usize;
        let buf_body = buf_start + header;
        let buf_limit = buf_start + returned;
        let str_start = us.Buffer.0 as usize;
        if us.Buffer.is_null()
            || (len_bytes & 1) != 0
            // `from_raw_parts::<u16>` below requires 2-byte alignment; `buf` is a
            // Vec<u8> (byte-aligned only), so an odd `Buffer` would be UB — the same
            // rationale that made the header use read_unaligned (Opus PR#510 R4 P3).
            || (str_start & 1) != 0
            || str_start < buf_body
            || str_start > buf_limit
            || len_bytes > buf_limit - str_start
        {
            return Ok(None);
        }
        let wlen = len_bytes / 2;
        if wlen == 0 {
            return Ok(None);
        }

        // Copy the wide string + NUL-terminate for CommandLineToArgvW.
        let wide = unsafe { std::slice::from_raw_parts(us.Buffer.0 as *const u16, wlen) };
        let mut wz: Vec<u16> = Vec::with_capacity(wlen + 1);
        wz.extend_from_slice(wide);
        wz.push(0);

        let mut argc: i32 = 0;
        let argv = unsafe { CommandLineToArgvW(PCWSTR(wz.as_ptr()), &mut argc) };
        if argv.is_null() || argc <= 0 {
            // CommandLineToArgvW success always yields argc >= 1, so a non-null argv
            // with argc <= 0 is unreachable — but free it if it ever occurs (Opus
            // PR#510 P3: no leak on the edge) rather than dropping the LocalAlloc block.
            if !argv.is_null() {
                unsafe { let _ = LocalFree(Some(HLOCAL(argv as *mut core::ffi::c_void))); }
            }
            return Ok(None);
        }
        let mut out: Vec<String> = Vec::with_capacity(argc as usize);
        for i in 0..argc as isize {
            let p: PWSTR = unsafe { *argv.offset(i) };
            match unsafe { p.to_string() } {
                Ok(s) => out.push(s),
                Err(_) => {
                    // Fail-safe (Codex PR#510 P2): an argv element with invalid
                    // UTF-16 must NOT be silently coerced to "" — that could let a
                    // malformed ssh line be misclassified as a safe one-shot and
                    // disclose. Free the CommandLineToArgvW allocation and decline
                    // per the fail-safe-to-None contract.
                    unsafe {
                        let _ = LocalFree(Some(HLOCAL(argv as *mut core::ffi::c_void)));
                    }
                    return Ok(None);
                }
            }
        }
        // Release the single allocation CommandLineToArgvW returned.
        unsafe {
            let _ = LocalFree(Some(HLOCAL(argv as *mut core::ffi::c_void)));
        }

        Ok(Some(out))
    })
}

#[cfg(test)]
mod cmdline_tests {
    use super::*;

    #[test]
    fn reads_current_process_command_line() {
        // The test-runner process always has a readable command line with argv[0].
        let pid = std::process::id();
        let argv = win32_get_process_command_line(pid)
            .expect("must not throw")
            .expect("the current process command line should be readable");
        assert!(!argv.is_empty(), "argv must contain at least argv[0]");
        assert!(!argv[0].is_empty(), "argv[0] (image path) must be non-empty");
    }

    #[test]
    fn zero_pid_returns_none() {
        assert!(win32_get_process_command_line(0).expect("no throw").is_none());
    }

    #[test]
    fn nonexistent_pid_fails_safe_to_none() {
        // A pid extremely unlikely to exist must fail SAFE to None, never panic —
        // the W-2b caller treats None as "possibly interactive" (decline).
        let r = win32_get_process_command_line(0xFFFF_FFF0).expect("no throw");
        assert!(r.is_none());
    }
}
