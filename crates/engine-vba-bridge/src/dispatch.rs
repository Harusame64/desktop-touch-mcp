//! `IDispatch` late-binding helpers (ADR-015 §3.3).
//!
//! Three thin helpers (`invoke_get`, `invoke_call`, `invoke_put`) that
//! wrap the Win32 `IDispatch::GetIDsOfNames` + `IDispatch::Invoke`
//! dance. Resolves a method / property name string into a DISPID at
//! call site (late binding), so the bridge does not require a compiled
//! type-library import.
//!
//! ## Phase 1 scope
//!
//! Phase 1 ships the module skeleton + signatures so the public API
//! surface is fixed. The actual `Invoke` implementation is deferred to
//! Phase 2 (where it lands alongside `excel.rs`'s Excel.Application
//! wrapper that exercises it end-to-end). Phase 1 acceptance is
//! `cargo build -p engine-vba-bridge` + `cargo test -p engine-vba-bridge`
//! green; the dispatch helpers compile as stubs that return a
//! `ComCallFailed` placeholder until Phase 2 lands the real call.

use windows::Win32::System::Com::IDispatch;
use windows::Win32::System::Variant::VARIANT;

use crate::errors::{VbaBridgeError, VbaBridgeResult};

/// Read a property by name from an `IDispatch`.
///
/// Wraps `GetIDsOfNames(name)` + `Invoke(DISPATCH_PROPERTYGET)`.
/// Phase 2 will use this for `Excel.Application.VBE`,
/// `Workbook.VBProject`, `VBComponent.CodeModule`, etc.
pub fn invoke_get(
    _disp: &IDispatch,
    name: &str,
    _args: &[VARIANT],
) -> VbaBridgeResult<VARIANT> {
    // Phase 1: stub — implementation lands in Phase 2 alongside excel.rs
    // so the call site is exercised end-to-end against a real
    // Excel.Application IDispatch.
    Err(VbaBridgeError::ComCallFailed {
        hresult: 0,
        context: format!("invoke_get({name}): Phase 1 stub — implementation lands in Phase 2"),
    })
}

/// Call a method by name on an `IDispatch`.
///
/// Wraps `GetIDsOfNames(name)` + `Invoke(DISPATCH_METHOD)`.
/// Phase 2 will use this for `Application.Run`, `VBComponents.Add`,
/// `CodeModule.AddFromString`, etc.
pub fn invoke_call(
    _disp: &IDispatch,
    name: &str,
    _args: &[VARIANT],
) -> VbaBridgeResult<VARIANT> {
    Err(VbaBridgeError::ComCallFailed {
        hresult: 0,
        context: format!("invoke_call({name}): Phase 1 stub — implementation lands in Phase 2"),
    })
}

/// Write a property by name on an `IDispatch`.
///
/// Wraps `GetIDsOfNames(name)` + `Invoke(DISPATCH_PROPERTYPUT)`.
/// Phase 2 will use this for `Application.Visible = true`, etc.
pub fn invoke_put(_disp: &IDispatch, name: &str, _value: VARIANT) -> VbaBridgeResult<()> {
    Err(VbaBridgeError::ComCallFailed {
        hresult: 0,
        context: format!("invoke_put({name}): Phase 1 stub — implementation lands in Phase 2"),
    })
}
