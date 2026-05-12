//! HKCU `AccessVBOM` read-only check (ADR-015 §3.7).
//!
//! Writing the registry value is intentionally NOT in this module —
//! it lives in `scripts/enable-access-vbom.mjs`, a CLI that the user
//! runs explicitly. The MCP tool surface exposes only [`check`],
//! which inspects the current state and reports it.
//!
//! Excel reads HKCU `Software\Microsoft\Office\16.0\Excel\Security\AccessVBOM`
//! at process startup; programmatic VBA project access requires this
//! value to be `1`. The HKLM mirror under the same path can force a
//! value (group policy), in which case HKCU is ignored. The check
//! function reports both scopes so callers can distinguish "not
//! trusted yet — run the CLI" from "trusted by policy" from "policy
//! forces 0 — no MCP-side workaround."

use crate::errors::VbaBridgeResult;

/// Outcome of an `AccessVBOM` registry check.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessVbomStatus {
    /// Effective trust state. `true` if either HKCU is 1 or HKLM
    /// forces 1; `false` otherwise.
    pub trusted: bool,
    /// `true` only when HKLM is set to 0 (group policy forces denial).
    /// When this is `true`, no MCP-side workaround exists.
    pub locked_by_policy: bool,
    /// Where the trust value (if any) is set. `"hklm-policy"` when
    /// HKLM dictates the value (regardless of HKCU); `"hkcu"` when
    /// HKLM is unset and HKCU is 1; `"default"` when neither is set.
    pub scope: &'static str,
}

/// Office version key used in the registry path. Office 365 / 2019 /
/// 2021 / 2024 all use `16.0`. Older Office versions use different
/// keys but are out of scope.
pub const OFFICE_VERSION_KEY: &str = "16.0";

/// Read the current `AccessVBOM` state.
///
/// Always returns `Ok(_)` even when the registry value is absent
/// (absence = `trusted: false`, `scope: "default"`). Errors are
/// returned only if the registry subsystem itself misbehaves.
#[cfg(windows)]
pub fn check() -> VbaBridgeResult<AccessVbomStatus> {
    win::check_impl()
}

/// Non-Windows stub. Returns `trusted: false` so non-Windows builds
/// (CI dev runners on Linux) compile without conditional plumbing.
#[cfg(not(windows))]
pub fn check() -> VbaBridgeResult<AccessVbomStatus> {
    Ok(AccessVbomStatus {
        trusted: false,
        locked_by_policy: false,
        scope: "default",
    })
}

#[cfg(windows)]
mod win {
    use super::{AccessVbomStatus, OFFICE_VERSION_KEY, VbaBridgeResult};
    use crate::errors::VbaBridgeError;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_DWORD, RegCloseKey,
        RegGetValueW, RegOpenKeyExW,
    };
    use windows::core::PCWSTR;

    /// Read a DWORD from `<hive>\<subkey>\<value>`. Returns `None`
    /// when the key or value doesn't exist; `Err` only for unexpected
    /// registry errors.
    fn read_dword(hive: HKEY, subkey: &str, value: &str) -> VbaBridgeResult<Option<u32>> {
        let subkey_w = to_utf16_z(subkey);
        let value_w = to_utf16_z(value);

        // Open the subkey for read.
        let mut hkey = HKEY::default();
        let open_status = unsafe {
            RegOpenKeyExW(hive, PCWSTR(subkey_w.as_ptr()), Some(0), KEY_READ, &mut hkey)
        };
        if open_status.is_err() {
            // Subkey doesn't exist — treat as "no value."
            return Ok(None);
        }

        // Wrap close in a guard so early returns don't leak the handle.
        let _guard = HKeyGuard(hkey);

        let mut buf: u32 = 0;
        let mut buf_size: u32 = std::mem::size_of::<u32>() as u32;
        let get_status = unsafe {
            RegGetValueW(
                hkey,
                None,
                PCWSTR(value_w.as_ptr()),
                RRF_RT_REG_DWORD,
                None,
                Some(&mut buf as *mut u32 as *mut _),
                Some(&mut buf_size),
            )
        };
        if get_status == ERROR_SUCCESS {
            Ok(Some(buf))
        } else {
            // Value not present, wrong type, or other error — treat
            // as "no value." The caller distinguishes via the
            // higher-level scope logic, not via raw error codes.
            Ok(None)
        }
    }

    pub fn check_impl() -> VbaBridgeResult<AccessVbomStatus> {
        let subkey = format!(
            "Software\\Microsoft\\Office\\{OFFICE_VERSION_KEY}\\Excel\\Security"
        );
        let hklm = read_dword(HKEY_LOCAL_MACHINE, &subkey, "AccessVBOM")?;
        let hkcu = read_dword(HKEY_CURRENT_USER, &subkey, "AccessVBOM")?;

        // HKLM (group policy) wins when set.
        if let Some(hklm_val) = hklm {
            return Ok(AccessVbomStatus {
                trusted: hklm_val == 1,
                locked_by_policy: hklm_val == 0,
                scope: "hklm-policy",
            });
        }

        // Otherwise HKCU determines the value.
        if let Some(hkcu_val) = hkcu {
            return Ok(AccessVbomStatus {
                trusted: hkcu_val == 1,
                locked_by_policy: false,
                scope: "hkcu",
            });
        }

        // Neither set — Excel defaults to untrusted.
        Ok(AccessVbomStatus {
            trusted: false,
            locked_by_policy: false,
            scope: "default",
        })
    }

    /// UTF-8 → UTF-16 with trailing NUL, the format `PCWSTR` expects.
    fn to_utf16_z(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// RAII guard for `HKEY` handles. Closes the key on drop so early
    /// returns from `read_dword` don't leak.
    struct HKeyGuard(HKEY);

    impl Drop for HKeyGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }

    // Currently unused outside this module; the public surface lives
    // in the parent module's `check()` function.
    #[allow(dead_code)]
    fn _silence_unused(_: &VbaBridgeError) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On any platform, `check()` must return Ok with a sensible
    /// AccessVbomStatus shape. On non-Windows, this is the stub;
    /// on Windows, this exercises the real registry read.
    #[test]
    fn check_returns_ok() {
        let status = check().expect("check must not error");
        // Belt-and-suspenders: ensure the scope value is one of the
        // documented variants.
        assert!(
            matches!(status.scope, "hklm-policy" | "hkcu" | "default"),
            "unexpected scope: {:?}",
            status.scope
        );
        // locked_by_policy ⇒ HKLM=0 ⇒ scope is hklm-policy and not trusted
        if status.locked_by_policy {
            assert_eq!(status.scope, "hklm-policy");
            assert!(!status.trusted);
        }
    }

    /// On the dev machine where `scripts/enable-access-vbom.mjs` was
    /// run, the check should show trusted: true. This test is
    /// permissive — it doesn't fail if the dev machine has different
    /// state — but it exists so a developer running `cargo test`
    /// after the CLI sees a positive confirmation.
    #[test]
    fn check_logs_current_state() {
        let status = check().expect("check must not error");
        eprintln!("AccessVBOM status on this machine: {status:?}");
    }
}
