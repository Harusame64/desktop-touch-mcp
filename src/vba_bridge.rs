//! napi-rs binding for the VBA Extensibility bridge (ADR-015 Phase 3).
//!
//! Exposes the `engine-vba-bridge` crate's IDispatch-based `Excel.Application`
//! wrapper to TypeScript via napi-rs. Each public function is a thin
//! `#[napi]` shim that:
//!
//! 1. Wraps the body in `napi_safe_call` (panic → typed napi::Error so the
//!    libuv main thread does not crash).
//! 2. Looks up the `ExcelSession` by an integer handle ID (held in
//!    [`SESSIONS`] — a `Mutex<HashMap>` keyed by u32 IDs).
//! 3. Calls the corresponding `engine_vba_bridge::excel::*` function.
//! 4. Maps `VbaBridgeError` to `napi::Error::from_reason` with the error
//!    code as a prefix (e.g. `"VbaAccessNotTrusted: HKCU AccessVBOM is 0; run scripts/enable-access-vbom.mjs"`),
//!    which the TS layer parses to produce typed `_errors.ts` envelopes.
//!
//! ## Session handle management
//!
//! `ExcelSession` cannot cross the napi-rs FFI boundary by value because
//! it owns COM-affine resources (the STA worker thread + IDispatch
//! pointer must be released on the apartment thread, not on V8's main).
//! Instead, the binding stores sessions in a process-global `Mutex<HashMap<u32, Arc<ExcelSession>>>`
//! and returns the u32 ID to JS. The TS wrapper (Phase 4) treats the ID
//! as an opaque token that flows back into subsequent calls.
//!
//! On `excel_session_close`, the binding removes the entry from the map,
//! which drops the last `Arc<ExcelSession>` strong reference, which
//! invokes `ExcelSession::drop`, which joins the STA worker thread (the
//! worker handles `drop(app) + CoUninitialize` on the apartment thread).
//! See `crates/engine-vba-bridge/src/apartment.rs` for the teardown
//! invariants.
//!
//! ## Threading semantics
//!
//! All `#[napi]` functions in this module run **synchronously on the
//! libuv main thread**. They are NOT wrapped in `AsyncTask` because:
//!
//! 1. `ExcelSession::with_app` already dispatches the actual COM work
//!    onto the STA worker thread internally via a `crossbeam-channel`.
//!    The main-thread call only blocks on `recv()` waiting for the
//!    worker's reply.
//! 2. Excel COM operations in the demo path are short (< 100ms typical)
//!    and the MCP server processes one request at a time. Blocking
//!    libuv briefly is acceptable; the next request is only enqueued
//!    after the current one completes.
//!
//! If Phase 4 / future profiling shows blocking issues (e.g. long-running
//! macros), individual functions can be migrated to `AsyncTask` without
//! breaking the public napi API.

#![cfg(windows)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use engine_vba_bridge::errors::{VbaBridgeError, VbaBridgeResult};
use engine_vba_bridge::{apartment, excel, registry};

use crate::win32::safety::napi_safe_call;

/// Process-global session registry. Sessions are inserted by
/// [`excel_session_spawn`] and removed by [`excel_session_close`].
/// Operations look up the session by ID, clone the `Arc`, drop the
/// lock, then call the wrapped method — so multiple sessions can
/// proceed in parallel.
///
/// `Arc<ExcelSession>` (not just `ExcelSession`) so we can drop the
/// outer `Mutex` lock before doing the actual COM call. The Arc count
/// is always 1 (only the HashMap owns it) until a call clones for the
/// duration of its work; after the clone goes out of scope, the count
/// returns to 1.
static SESSIONS: OnceLock<Mutex<HashMap<u32, Arc<apartment::ExcelSession>>>> = OnceLock::new();

/// Monotonic ID allocator. Never reuses an ID even after `close` so a
/// caller holding a stale ID gets a clean "session not found" error
/// rather than silently hitting a different session.
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

fn sessions() -> &'static Mutex<HashMap<u32, Arc<apartment::ExcelSession>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a session ID to its `Arc<ExcelSession>`, cloning the Arc so
/// the caller can drop the registry lock before the COM call.
fn get_session(id: u32) -> Result<Arc<apartment::ExcelSession>> {
    let map = sessions().lock().map_err(|_| {
        Error::from_reason("vba_bridge: session registry mutex poisoned")
    })?;
    map.get(&id).cloned().ok_or_else(|| {
        Error::from_reason(format!(
            "VbaBridgeError::SessionNotFound: no Excel session with id={id} \
             (already closed or never opened)"
        ))
    })
}

/// Convert an `engine_vba_bridge::VbaBridgeError` into a `napi::Error`.
/// The message prefix is the PascalCase error code so the TS layer
/// can pattern-match on it to populate `_errors.ts` envelopes.
fn to_napi_err(e: VbaBridgeError) -> Error {
    // The Display impl already prefixes with the code (`Self::VbaAccessNotTrusted => write!(f, "VbaAccessNotTrusted: ...")`)
    // so we just stringify.
    Error::from_reason(e.to_string())
}

/// Helper: turn a `VbaBridgeResult<T>` into a `napi::Result<T>`.
fn map_bridge<T>(r: VbaBridgeResult<T>) -> Result<T> {
    r.map_err(to_napi_err)
}

// ─── Session lifecycle ───────────────────────────────────────────────

/// Spawn a new Excel STA worker + create `Excel.Application` on it.
/// Returns an integer session ID that subsequent `excel_*` calls use
/// to address the session. The caller MUST call [`excel_session_close`]
/// when done to release the COM resources; relying on GC will
/// eventually clean up but leaves Excel.exe running in the meantime.
#[napi]
pub fn excel_session_spawn() -> Result<u32> {
    napi_safe_call("excel_session_spawn", || {
        let session = map_bridge(apartment::ExcelSession::spawn())?;
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        let mut map = sessions().lock().map_err(|_| {
            Error::from_reason("vba_bridge: session registry mutex poisoned")
        })?;
        map.insert(id, Arc::new(session));
        Ok(id)
    })
}

/// Close an Excel session, releasing the STA worker thread + IDispatch
/// + Excel.Application. Idempotent: closing an unknown / already-closed
/// ID returns Ok with no effect (matches the `try_take_session` semantic
/// the TS layer expects).
#[napi]
pub fn excel_session_close(session_id: u32) -> Result<()> {
    napi_safe_call("excel_session_close", || {
        let removed = {
            let mut map = sessions().lock().map_err(|_| {
                Error::from_reason("vba_bridge: session registry mutex poisoned")
            })?;
            map.remove(&session_id)
        };
        // Drop the Arc outside the lock so the `ExcelSession::drop`
        // (which joins the STA worker thread, briefly blocking) does
        // not hold the registry lock while waiting for COM teardown.
        drop(removed);
        Ok(())
    })
}

/// Returns true if the given session ID exists in the registry. Useful
/// for the TS layer to verify a session hasn't been collected before
/// issuing further operations.
#[napi]
pub fn excel_session_is_alive(session_id: u32) -> Result<bool> {
    napi_safe_call("excel_session_is_alive", || {
        let map = sessions().lock().map_err(|_| {
            Error::from_reason("vba_bridge: session registry mutex poisoned")
        })?;
        Ok(map.contains_key(&session_id))
    })
}

// ─── Application property setters ────────────────────────────────────

/// Set `Application.Visible`.
#[napi]
pub fn excel_set_visible(session_id: u32, visible: bool) -> Result<()> {
    napi_safe_call("excel_set_visible", || {
        let session = get_session(session_id)?;
        map_bridge(excel::set_visible(&session, visible))
    })
}

/// Set `Application.DisplayAlerts`.
///
/// The Phase 2e demo path does NOT need to call this directly because
/// [`excel_workbook_save_as`] manages it internally via a save-restore
/// guard (see ADR-015 §7 R9). Exposed here for callers who want
/// manual control (Phase 4 may or may not surface this as an MCP
/// action — see ADR-015 §8 OQ #7).
#[napi]
pub fn excel_set_display_alerts(session_id: u32, enabled: bool) -> Result<()> {
    napi_safe_call("excel_set_display_alerts", || {
        let session = get_session(session_id)?;
        map_bridge(excel::set_display_alerts(&session, enabled))
    })
}

// ─── Workbook lifecycle ──────────────────────────────────────────────

/// Add a new blank workbook on the active session. Equivalent to
/// `Application.Workbooks.Add()`. The new workbook becomes
/// `ActiveWorkbook` immediately.
#[napi]
pub fn excel_workbook_add_new(session_id: u32) -> Result<()> {
    napi_safe_call("excel_workbook_add_new", || {
        let session = get_session(session_id)?;
        map_bridge(excel::workbook_add_new(&session))
    })
}

/// Save the active workbook to a file path using the given XlFileFormat
/// numeric value. The only format supported in v1 is
/// `OpenXmlWorkbookMacroEnabled = 52` (`.xlsm`); passing any other
/// numeric value is accepted by Excel COM but silently drops VBA on
/// disk for non-macro formats — Phase 4 will validate at the TS layer.
///
/// Internally manages `DisplayAlerts` via a save-restore guard (ADR-015
/// §7 R9), so callers do not need to suppress alerts manually.
#[napi]
pub fn excel_workbook_save_as(
    session_id: u32,
    path: String,
    file_format: i32,
) -> Result<()> {
    napi_safe_call("excel_workbook_save_as", || {
        let session = get_session(session_id)?;
        // The Rust enum is `#[repr(i32)]` so a runtime numeric match
        // is straightforward. We deliberately do NOT add a "default"
        // arm — unknown formats return a typed error so the TS layer
        // can map to `VbaUnsupportedArgumentType` cleanly.
        let format = match file_format {
            52 => excel::XlFileFormat::OpenXmlWorkbookMacroEnabled,
            other => {
                return Err(Error::from_reason(format!(
                    "VbaUnsupportedArgumentType: file_format={other} not supported in v1. \
                     The only supported value is 52 (xlOpenXMLWorkbookMacroEnabled, .xlsm)."
                )));
            }
        };
        map_bridge(excel::workbook_save_as(&session, path, format))
    })
}

/// Close the active workbook. `save_changes` maps directly to the
/// `SaveChanges` argument of `Workbook.Close`. Does not close the
/// Excel application — use [`excel_session_close`] for that.
#[napi]
pub fn excel_workbook_close(session_id: u32, save_changes: bool) -> Result<()> {
    napi_safe_call("excel_workbook_close", || {
        let session = get_session(session_id)?;
        map_bridge(excel::workbook_close(&session, save_changes))
    })
}

// ─── VBA authoring + execution ───────────────────────────────────────

/// Add a VBA module to the active workbook and write source into it.
/// Internally walks `Application.ActiveWorkbook.VBProject.VBComponents.Add(1)`
/// (`vbext_ct_StdModule`) → `<NewComponent>.CodeModule.AddFromString(code)`.
///
/// Requires `AccessVBOM = 1` (HKCU or HKLM). Otherwise the VBProject
/// access raises COM error `0x800AC472` which is surfaced as
/// `VbaAccessNotTrusted`.
#[napi]
pub fn excel_vba_module_add(
    session_id: u32,
    module_name: String,
    code: String,
) -> Result<()> {
    napi_safe_call("excel_vba_module_add", || {
        let session = get_session(session_id)?;
        map_bridge(excel::vba_module_add(&session, module_name, code))
    })
}

/// Run a previously-added macro by name. Calls `Application.Run(macro_name)`.
///
/// **Trust Center note (ADR-015 §3.6)**: macros on an in-memory unsaved
/// workbook cannot be run regardless of `VBAWarnings` — Excel returns
/// HRESULT `0x800a03ec`. Phase 2e adds [`excel_workbook_save_as`] +
/// the managed Trusted Location so callers can anchor the workbook
/// before invoking `macro_run`.
#[napi]
pub fn excel_macro_run(session_id: u32, macro_name: String) -> Result<()> {
    napi_safe_call("excel_macro_run", || {
        let session = get_session(session_id)?;
        map_bridge(excel::macro_run(&session, macro_name))
    })
}

// ─── AccessVBOM registry inspection ──────────────────────────────────

/// Mirror of `engine_vba_bridge::registry::AccessVbomStatus` for the
/// napi-rs serialiser. `scope` is mapped to a String so napi-rs can
/// marshal it; the Rust source uses a `&'static str` for zero-alloc.
#[napi(object)]
pub struct ExcelAccessVbomStatus {
    pub trusted: bool,
    pub locked_by_policy: bool,
    pub scope: String,
}

/// Read the current HKCU / HKLM `AccessVBOM` state without modifying
/// the registry. Used by the Phase 4 MCP tool's `check_access_vbom`
/// action and by any caller that wants to provide a remediation
/// suggestion (run `scripts/enable-access-vbom.mjs`) without first
/// trying a real COM call.
#[napi]
pub fn excel_check_access_vbom() -> Result<ExcelAccessVbomStatus> {
    napi_safe_call("excel_check_access_vbom", || {
        let status = map_bridge(registry::check())?;
        Ok(ExcelAccessVbomStatus {
            trusted: status.trusted,
            locked_by_policy: status.locked_by_policy,
            scope: status.scope.to_string(),
        })
    })
}
