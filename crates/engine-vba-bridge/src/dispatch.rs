//! `IDispatch` late-binding helpers (ADR-015 §3.3).
//!
//! Three thin helpers (`invoke_get`, `invoke_call`, `invoke_put`) that
//! wrap the Win32 `IDispatch::GetIDsOfNames` + `IDispatch::Invoke`
//! dance. Resolves a method / property name string into a DISPID at
//! call site (late binding), so the bridge does not require a compiled
//! type-library import.
//!
//! ## COM gotchas baked into this module
//!
//! 1. **`DISPPARAMS::rgvarg` is in REVERSE order** (last positional
//!    argument first). Callers pass args in natural order; the helpers
//!    reverse internally before handing to `Invoke`.
//! 2. **`DISPATCH_PROPERTYPUT` requires the named-arg DISPID
//!    `DISPID_PROPERTYPUT` (= -3)** to mark the single VARIANT as the
//!    property value. `invoke_put` handles this.
//! 3. **`EXCEPINFO`** is populated by `Invoke` when the COM call
//!    raises a VBA-side exception; we capture `scode` (the actual
//!    HRESULT of the error) and `bstrDescription` for the error
//!    context. `bstrSource` / `bstrDescription` are auto-freed via
//!    `BSTR`'s `Drop` since the windows-rs type owns the allocation.
//! 4. **`VARIANT` lifetimes**: callers own their VARIANTs and pass
//!    `&[VARIANT]`; we copy into a reversed `Vec<VARIANT>` for the
//!    DISPPARAMS pointer, which lives for the duration of the call.

use windows::Win32::System::Com::{
    DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT, DISPPARAMS, EXCEPINFO, IDispatch,
};
use windows::Win32::System::Variant::VARIANT;
use windows::core::{GUID, PCWSTR};

use crate::errors::{VbaBridgeError, VbaBridgeResult};

/// `LOCALE_USER_DEFAULT` per Win32 headers. windows-rs does not
/// re-export this from its `Win32::System::Com` modules; the value
/// is contract-stable since Windows 95.
const LOCALE_USER_DEFAULT: u32 = 0x0400;

/// `DISPID_PROPERTYPUT` per Win32 headers. Signals the named-arg
/// VARIANT in a `DISPATCH_PROPERTYPUT` call.
const DISPID_PROPERTYPUT: i32 = -3;

/// Resolves a method / property name to its DISPID via
/// `IDispatch::GetIDsOfNames`.
///
/// This is a single-name resolution (the IDispatch interface supports
/// resolving multiple names at once for named-arg calls, but our
/// callers only ever use one). The returned DISPID is stable for the
/// life of the IDispatch pointer.
fn get_disp_id(disp: &IDispatch, name: &str) -> VbaBridgeResult<i32> {
    let name_w: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let names: [PCWSTR; 1] = [PCWSTR(name_w.as_ptr())];
    let mut dispid: i32 = 0;
    let riid_null = GUID::zeroed();

    let result = unsafe {
        disp.GetIDsOfNames(
            &riid_null,
            names.as_ptr(),
            1,
            LOCALE_USER_DEFAULT,
            &mut dispid,
        )
    };

    match result {
        Ok(()) => Ok(dispid),
        Err(e) => Err(VbaBridgeError::ComCallFailed {
            hresult: e.code().0,
            context: format!("GetIDsOfNames({name}): {}", e.message()),
        }),
    }
}

/// Build a reversed argument buffer for `DISPPARAMS::rgvarg`. Returns
/// the storage so the caller's pointer stays valid for the duration
/// of the Invoke call (the storage is dropped after Invoke returns).
fn reversed_args(args: &[VARIANT]) -> Vec<VARIANT> {
    let mut rev: Vec<VARIANT> = args.iter().rev().cloned().collect();
    // No-op if empty; touch the Vec so its capacity matches len, so
    // the rgvarg pointer is well-defined.
    rev.shrink_to_fit();
    rev
}

/// Extract a contextual error message from an EXCEPINFO populated by
/// `Invoke`. Falls back to the raw HRESULT when no EXCEPINFO content
/// is available.
fn excepinfo_to_message(excepinfo: &EXCEPINFO, raw_hresult: i32) -> String {
    let desc = unsafe { bstr_to_string(&excepinfo.bstrDescription) };
    let src = unsafe { bstr_to_string(&excepinfo.bstrSource) };
    let scode = excepinfo.scode;
    let effective_hresult = if scode != 0 { scode } else { raw_hresult };
    match (src.as_deref(), desc.as_deref()) {
        (Some(s), Some(d)) if !s.is_empty() && !d.is_empty() => {
            format!("[{s}] {d} (HRESULT=0x{effective_hresult:08x})")
        }
        (_, Some(d)) if !d.is_empty() => format!("{d} (HRESULT=0x{effective_hresult:08x})"),
        _ => format!("Invoke failed (HRESULT=0x{effective_hresult:08x})"),
    }
}

/// Convert a windows-rs BSTR to a UTF-8 String. Returns None when the
/// BSTR is null/empty so the message formatter can fall back gracefully.
unsafe fn bstr_to_string(b: &windows::core::BSTR) -> Option<String> {
    if b.is_empty() {
        return None;
    }
    Some(b.to_string())
}

/// Read a property by name from an `IDispatch`.
///
/// Wraps `GetIDsOfNames(name)` + `Invoke(DISPATCH_PROPERTYGET)`.
/// Phase 2 callers will use this for `Excel.Application.VBE`,
/// `Workbook.VBProject`, `VBComponent.CodeModule`, etc.
pub fn invoke_get(disp: &IDispatch, name: &str, args: &[VARIANT]) -> VbaBridgeResult<VARIANT> {
    invoke_with_flags(disp, name, args, DISPATCH_PROPERTYGET, false)
}

/// Call a method by name on an `IDispatch`.
///
/// Wraps `GetIDsOfNames(name)` + `Invoke(DISPATCH_METHOD)`.
/// Phase 2 callers will use this for `Application.Run`,
/// `VBComponents.Add`, `CodeModule.AddFromString`, etc.
pub fn invoke_call(disp: &IDispatch, name: &str, args: &[VARIANT]) -> VbaBridgeResult<VARIANT> {
    invoke_with_flags(disp, name, args, DISPATCH_METHOD, false)
}

/// Write a property by name on an `IDispatch`.
///
/// Wraps `GetIDsOfNames(name)` + `Invoke(DISPATCH_PROPERTYPUT)` with
/// the special-cased `DISPID_PROPERTYPUT` named-arg DISPID that
/// signals the single VARIANT as the property value.
pub fn invoke_put(disp: &IDispatch, name: &str, value: VARIANT) -> VbaBridgeResult<()> {
    let args = [value];
    invoke_with_flags(disp, name, &args, DISPATCH_PROPERTYPUT, true).map(|_| ())
}

/// Shared invocation body. `propertyput` toggles the special-cased
/// DISPID_PROPERTYPUT named-arg DISPID required by Win32 for
/// property-write semantics.
fn invoke_with_flags(
    disp: &IDispatch,
    name: &str,
    args: &[VARIANT],
    flags: windows::Win32::System::Com::DISPATCH_FLAGS,
    propertyput: bool,
) -> VbaBridgeResult<VARIANT> {
    let dispid = get_disp_id(disp, name)?;
    let mut rev_args = reversed_args(args);

    // For property-put, the single VARIANT in rgvarg must be tagged
    // with DISPID_PROPERTYPUT as a named arg.
    let mut named_arg_dispids: [i32; 1] = [DISPID_PROPERTYPUT];

    let dispparams = DISPPARAMS {
        rgvarg: if rev_args.is_empty() {
            std::ptr::null_mut()
        } else {
            rev_args.as_mut_ptr()
        },
        rgdispidNamedArgs: if propertyput {
            named_arg_dispids.as_mut_ptr()
        } else {
            std::ptr::null_mut()
        },
        cArgs: args.len() as u32,
        cNamedArgs: if propertyput { 1 } else { 0 },
    };

    let mut result = VARIANT::default();
    let mut excepinfo = EXCEPINFO::default();
    let mut arg_err: u32 = 0;
    let riid_null = GUID::zeroed();

    let invoke_result = unsafe {
        disp.Invoke(
            dispid,
            &riid_null,
            LOCALE_USER_DEFAULT,
            flags,
            &dispparams,
            Some(&mut result),
            Some(&mut excepinfo),
            Some(&mut arg_err),
        )
    };

    // Ensure rev_args lives until after the Invoke call returns
    // (paranoia: the optimizer is allowed to drop Vec storage early
    // if it proves the pointer is dead, but DISPPARAMS borrows it
    // via raw pointer which the compiler cannot see).
    drop(rev_args);

    match invoke_result {
        Ok(()) => Ok(result),
        Err(e) => {
            let raw = e.code().0;
            Err(VbaBridgeError::ComCallFailed {
                hresult: raw,
                context: format!(
                    "Invoke({name}, flags={:?}): {}",
                    flags,
                    excepinfo_to_message(&excepinfo, raw)
                ),
            })
        }
    }
}
