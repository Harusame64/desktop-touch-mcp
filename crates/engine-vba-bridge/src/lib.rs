//! VBA Extensibility COM bridge (ADR-015).
//!
//! Late-binding `IDispatch` wrapper around `Excel.Application` that
//! lets Rust callers author and run VBA macros without touching the
//! VBA Editor UI. Implements ADR-015 Phase 1 primitives:
//!
//! - [`variant`]: `serde_json::Value` ↔ `VARIANT` round-trip with the
//!   `null → VT_NULL` semantic (NOT `VT_EMPTY`; see ADR-015 §3.5)
//! - [`dispatch`]: three thin helpers on `IDispatch`
//!   (`invoke_get` / `invoke_call` / `invoke_put`) that resolve names
//!   via `GetIDsOfNames` then call `Invoke` with the appropriate
//!   `DISPATCH_FLAGS`
//! - [`apartment`]: STA worker-thread management
//!   (`CoInitializeEx(COINIT_APARTMENTTHREADED)` + crossbeam-channel
//!   command pump). Mirrors the existing `src/uia/thread.rs` MTA worker
//!   pattern at the structural level; uses STA because Excel.Application
//!   strictly requires it
//! - [`errors`]: typed errors mapped from HRESULT, named per the
//!   `Vba*` PascalCase convention (Codex Round 1 P2 — must round-trip
//!   through `src/tools/_envelope.ts::pascalToSnake` cleanly)
//!
//! Phase 2 adds [`excel`] (Excel-specific wrapper) and [`registry`]
//! (read-only HKCU `AccessVBOM` check). Phase 3 adds the napi binding
//! in the root crate.

#![cfg_attr(not(windows), allow(unused))]

// ## windows-rs 0.62 VARIANT construction SSOT
//
// The Excel wrapper relies on these `From` impls from windows-rs 0.62:
//
//   impl From<bool> for VARIANT       — VT_BOOL (true → VARIANT_TRUE)
//   impl From<i32>  for VARIANT       — VT_I4
//   impl From<f64>  for VARIANT       — VT_R8
//   impl From<BSTR> for VARIANT       — VT_BSTR (BSTR ownership transferred,
//                                       freed via VariantClear on VARIANT::drop)
//
// `BSTR::from(String)` allocates via `SysAllocStringLen`. `BSTR: Drop`
// frees via `SysFreeString`. When a BSTR is moved into a VARIANT, the
// VARIANT becomes the owner; dropping the VARIANT calls VariantClear
// which frees the BSTR. Phase 2d code at `excel.rs:107,121` relies on
// this transfer-of-ownership semantic.
//
// VARIANT itself implements `Clone` via `VariantCopy` (deep copy with
// new BSTR allocation for VT_BSTR). Phase 2 `dispatch::reversed_args`
// calls `.cloned()` on `&[VARIANT]` which produces independently-owned
// VARIANT copies; the caller's VARIANTs are not mutated.
//
// Phase 2 end-to-end tests on Excel 365 confirm all of the above
// behave as documented (18/18 PASS including round-trip BSTR through
// AddFromString + Range.Value).

pub mod errors;
pub mod registry;
pub mod variant;

#[cfg(windows)]
pub mod dispatch;

#[cfg(windows)]
pub mod apartment;

#[cfg(windows)]
pub mod excel;

pub use errors::{VbaBridgeError, VbaBridgeResult};
