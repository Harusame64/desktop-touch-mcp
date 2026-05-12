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

pub mod errors;
pub mod registry;
pub mod variant;

#[cfg(windows)]
pub mod dispatch;

#[cfg(windows)]
pub mod apartment;

pub use errors::{VbaBridgeError, VbaBridgeResult};
