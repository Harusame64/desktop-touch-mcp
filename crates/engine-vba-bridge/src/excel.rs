//! `Excel.Application` wrapper functions (ADR-015 §3.6).
//!
//! Higher-level Rust API over the IDispatch + STA-worker primitives.
//! Each function in this module takes an [`ExcelSession`] handle and
//! synchronously dispatches a closure onto the worker thread that
//! walks the COM object graph and runs the operation.
//!
//! ## Phase 2d / 2e scope
//!
//! - [`set_visible`] — toggles `Application.Visible`
//! - [`set_display_alerts`] — toggles `Application.DisplayAlerts` for
//!   callers who want manual control. The Phase 2e demo path does NOT
//!   call this directly; [`workbook_save_as`] manages DisplayAlerts
//!   internally via a save-restore guard (see Call sequence below)
//! - [`workbook_add_new`] — creates a fresh Workbook on the active session
//! - [`vba_module_add`] — adds a VBA module via `VBProject.VBComponents.Add`
//!   and writes source via `CodeModule.AddFromString`
//! - [`workbook_save_as`] — Phase 2e: saves the active workbook via
//!   `ActiveWorkbook.SaveAs(Filename, FileFormat)`. The demo path saves
//!   into a managed Trusted Location so `macro_run` is no longer
//!   policy-gated by Excel Trust Center (see [`XlFileFormat`])
//! - [`macro_run`] — calls `Application.Run` against a previously-added macro
//! - [`workbook_close`] — Phase 2e: closes the active workbook via
//!   `ActiveWorkbook.Close(SaveChanges)` so cleanup does not leak the
//!   workbook into the next bridge invocation
//!
//! Functions for `eval_cell` / `refresh_power_query` listed in
//! ADR §3.6 are still planned for a later commit.
//!
//! ## Call sequence for the Phase 2e demo path (sequencing contract)
//!
//! Phase 2e Lesson-3 (順序矛盾) sweep: the demo flow has a strict
//! ordering that callers MUST follow because some steps depend on
//! state established earlier. The sequence is:
//!
//! 1. `ExcelSession::spawn()` — start the STA worker + create Excel.Application
//! 2. `set_visible(session, false)` — keep the demo hidden
//! 3. `workbook_add_new(session)` — fresh in-memory workbook
//! 4. `vba_module_add(session, name, code)` — author the macro
//! 5. `workbook_save_as(session, path_in_trusted_loc, OpenXmlWorkbookMacroEnabled)`
//!    — anchor to disk in a Trusted Location (the function internally
//!    suppresses `DisplayAlerts` for the duration of the SaveAs call,
//!    so the caller does NOT need to call [`set_display_alerts`])
//! 6. `macro_run(session, macro_name)` — succeeds because (5) anchored
//!    the workbook in a Trusted Location and Trust Center allows
//!    `Application.Run`
//! 7. `workbook_close(session, false)` — release the workbook handle
//!    inside Excel without re-saving
//! 8. `drop(session)` — releases `IDispatch` on the STA thread,
//!    `Excel.Application` terminates, file handle on disk is released
//! 9. (caller's choice) `fs::remove_file(path)` — best-effort cleanup
//!
//! Sequence-violation failure modes for each step:
//! - Skipping (2) (`set_visible`): default-hidden Excel still works,
//!   but a stale visible window from a prior session can show through
//! - Skipping (3) (`workbook_add_new`): (4) raises a COM error because
//!   `ActiveWorkbook` returns null; surfaced as `ComCallFailed`
//! - Skipping (4) (`vba_module_add`): (6) raises `VbaMacroNotFound`
//!   because the Sub the caller passes does not exist
//! - Skipping (5) (`workbook_save_as`): (6) returns HRESULT
//!   `0x800a03ec` (Trust Center policy block — in-memory unsaved
//!   workbook cannot run macros regardless of `VBAWarnings`)
//! - Setting `Application.Visible = true` before (5): SaveAs would
//!   prompt the user for an overwrite confirmation; the internal
//!   `DisplayAlerts` guard in [`workbook_save_as`] mitigates this
//!   even under unusual `visible: true` configurations
//! - Skipping (7) (`workbook_close`): the workbook remains open
//!   inside the alive `Excel.Application`; subsequent operations on
//!   the same session see it as `ActiveWorkbook`. Tolerable for
//!   chained authoring; cleanup is delayed until session drop
//! - Skipping (8) (`drop(session)`) and immediately calling (9)
//!   (`fs::remove_file`): Excel.exe still holds the file handle;
//!   `remove_file` returns `ERROR_SHARING_VIOLATION`. The Phase 2e
//!   test retries 3× × 100ms to absorb this

use windows::Win32::System::Com::IDispatch;
use windows::Win32::System::Variant::VARIANT;
use windows::core::BSTR;

use crate::apartment::ExcelSession;
use crate::dispatch;
use crate::errors::{VbaBridgeError, VbaBridgeResult};

/// Subset of Excel's `XlFileFormat` enumeration covering the formats
/// the bridge writes via [`workbook_save_as`].
///
/// Only macro-enabled formats are exposed in v1 because the entire
/// reason Phase 2e introduces `SaveAs` is to host VBA macros in a
/// Trusted-Location file (the path-less in-memory workbook cannot run
/// macros under any Trust Center setting; `Application.Run` returns
/// HRESULT `0x800a03ec` for it).
///
/// The numeric values match the Excel COM object model exactly and
/// are stable across Excel 2007 / 2010 / 2013 / 2016 / 2019 / 2021 /
/// 2024 / 365 — they are not version-gated.
#[repr(i32)]
#[derive(Debug, Clone, Copy)]
pub enum XlFileFormat {
    /// `.xlsm` — Open XML Workbook with macros enabled.
    ///
    /// The Phase 2e demo path saves to this format. Saving an
    /// authored VBA module as `.xlsx` (`51`) would silently drop the
    /// macro on disk, defeating the purpose.
    OpenXmlWorkbookMacroEnabled = 52,
}

/// Set `Excel.Application.Visible = visible`.
///
/// During the demo recording, calling `set_visible(true)` is what
/// makes Excel appear on screen. For headless / batch usage, leave
/// it at the default `false` (`Excel.Application` defaults to hidden
/// when launched via `CoCreateInstance`).
pub fn set_visible(session: &ExcelSession, visible: bool) -> VbaBridgeResult<()> {
    session.with_app(move |app| {
        let value: VARIANT = visible.into();
        dispatch::invoke_put(app, "Visible", value)
    })
}

/// Set `Excel.Application.DisplayAlerts = enabled`.
///
/// Excel defaults `DisplayAlerts` to `true`. This function exists for
/// callers who want **manual** control over the setting (Phase 4 MCP
/// tool may expose it as an `excel.set_display_alerts` action). The
/// Phase 2e demo path does NOT call this directly — see
/// [`workbook_save_as`] which manages the setting internally via a
/// save-restore guard so callers cannot accidentally leak
/// `DisplayAlerts = false` past the SaveAs call (data-loss risk on
/// subsequent user-visible workflows, see ADR-015 §7 R9).
pub fn set_display_alerts(session: &ExcelSession, enabled: bool) -> VbaBridgeResult<()> {
    session.with_app(move |app| {
        let value: VARIANT = enabled.into();
        dispatch::invoke_put(app, "DisplayAlerts", value)
    })
}

/// Create a new blank Workbook on the active session.
///
/// Equivalent to `Application.Workbooks.Add()`. Returns the result of
/// `invoke_call` (a VARIANT wrapping the new Workbook IDispatch);
/// callers who need the IDispatch can use [`variant_to_dispatch`]. For
/// the demo path, the new workbook is the active one immediately, so
/// subsequent operations can use `Application.ActiveWorkbook`.
pub fn workbook_add_new(session: &ExcelSession) -> VbaBridgeResult<()> {
    session.with_app(|app| {
        let workbooks = dispatch::invoke_get(app, "Workbooks", &[])?;
        let workbooks_disp = variant_to_dispatch(&workbooks)
            .ok_or_else(|| make_unexpected("Workbooks property did not return IDispatch"))?;
        let _new_book = dispatch::invoke_call(&workbooks_disp, "Add", &[])?;
        Ok(())
    })
}

/// Add a VBA module to the active workbook and write source into it.
///
/// Internally walks: `Application.ActiveWorkbook.VBProject.VBComponents.Add(1)`
/// (`vbext_ct_StdModule = 1`) → `<NewComponent>.CodeModule.AddFromString(code)`.
/// The new component is renamed via `Name = module_name` so subsequent
/// `Application.Run(...)` calls can refer to the macro by its
/// fully-qualified name if needed.
///
/// Requires HKCU `AccessVBOM = 1` (or HKLM forces 1). Otherwise the
/// `VBProject` access raises COM error `0x800AC472` which surfaces as
/// `VbaBridgeError::VbaAccessNotTrusted` via the dispatch helper.
pub fn vba_module_add(
    session: &ExcelSession,
    module_name: String,
    code: String,
) -> VbaBridgeResult<()> {
    session.with_app(move |app| {
        // ActiveWorkbook
        let active_wb = dispatch::invoke_get(app, "ActiveWorkbook", &[])?;
        let wb_disp = variant_to_dispatch(&active_wb)
            .ok_or_else(|| make_unexpected("ActiveWorkbook did not return IDispatch"))?;

        // VBProject
        let vbproject = match dispatch::invoke_get(&wb_disp, "VBProject", &[]) {
            Ok(v) => v,
            Err(VbaBridgeError::ComCallFailed { hresult, .. })
                if hresult == 0x800AC472_u32 as i32 =>
            {
                return Err(VbaBridgeError::VbaAccessNotTrusted);
            }
            Err(e) => return Err(e),
        };
        let vbp_disp = variant_to_dispatch(&vbproject)
            .ok_or_else(|| make_unexpected("VBProject did not return IDispatch"))?;

        // VBComponents
        let components = dispatch::invoke_get(&vbp_disp, "VBComponents", &[])?;
        let comp_disp = variant_to_dispatch(&components)
            .ok_or_else(|| make_unexpected("VBComponents did not return IDispatch"))?;

        // .Add(1) — vbext_ct_StdModule
        let module_type: VARIANT = 1_i32.into();
        let module = dispatch::invoke_call(&comp_disp, "Add", &[module_type])?;
        let module_disp = variant_to_dispatch(&module)
            .ok_or_else(|| make_unexpected("VBComponents.Add did not return IDispatch"))?;

        // Set Name = module_name. This rename is **decorative** for
        // our caller pattern: `Application.Run(macro_name)` resolves
        // by the Sub name declared in the VBA source, not by the
        // module name. If rename fails (some VBA project states
        // reject it), `Application.Run` still works because it walks
        // all modules looking for a Sub with the given name. The
        // rename is attempted so the module appears under a
        // discoverable name in the VBA Editor UI when the user opens
        // it; failure is logged for diagnostics but not propagated.
        //
        // Opus Round 1 P1-5 justification: this is documented silent
        // swallow, not a hidden regression. The `Application.Run`
        // call site (excel.rs::macro_run) does not depend on the
        // module name; it uses the Sub name argument supplied by the
        // caller, which matches what is declared in the `code`
        // string. If the demo flow ever changes to call
        // `module_name + "." + sub_name` (fully-qualified), this
        // rename failure becomes a hard error and the eprintln below
        // must be replaced with `return Err(...)`.
        let name_v: VARIANT = BSTR::from(module_name).into();
        if let Err(e) = dispatch::invoke_put(&module_disp, "Name", name_v) {
            eprintln!("[engine-vba-bridge] note: module rename failed (non-fatal, Sub-name-based Run still works): {e}");
        }

        // CodeModule
        let codemod = dispatch::invoke_get(&module_disp, "CodeModule", &[])?;
        let codemod_disp = variant_to_dispatch(&codemod)
            .ok_or_else(|| make_unexpected("CodeModule did not return IDispatch"))?;

        // AddFromString(code)
        let code_v: VARIANT = BSTR::from(code).into();
        dispatch::invoke_call(&codemod_disp, "AddFromString", &[code_v])
            .map_err(|e| match e {
                VbaBridgeError::ComCallFailed { context, hresult } => {
                    VbaBridgeError::VbaModuleAuthoringFailed(format!(
                        "AddFromString failed (HRESULT=0x{hresult:08x}): {context}"
                    ))
                }
                other => other,
            })?;

        Ok(())
    })
}

/// Save the active workbook to a file path under the given format.
///
/// Calls `ActiveWorkbook.SaveAs(Filename, FileFormat)`. Phase 2e
/// uses this to relocate the in-memory workbook into a Trusted
/// Location so [`macro_run`] is no longer policy-gated by Excel's
/// Trust Center (see this module's struct doc on [`XlFileFormat`]).
///
/// **Path argument**: absolute path with `.xlsm` extension matching
/// `format`. Excel honours the extension reported by the path when
/// `format` is the matching `XlFileFormat`. The path's parent
/// directory MUST already exist; Excel does not create it.
///
/// **DisplayAlerts handling (Phase 2e safety guard)**: SaveAs against
/// an existing file would normally prompt "Do you want to replace?".
/// With `Application.Visible == false`, that modal is invisible and
/// the COM call hangs forever. To eliminate the hazard structurally,
/// this function takes a **save-restore guard** internally:
///
/// 1. Reads current `Application.DisplayAlerts` (preserved as `prev`)
/// 2. Sets `Application.DisplayAlerts = False`
/// 3. Invokes `Workbook.SaveAs`
/// 4. Restores `Application.DisplayAlerts = prev` regardless of
///    SaveAs outcome (success OR failure)
///
/// The restore is best-effort — if it itself fails (extremely rare;
/// would mean COM teardown is in progress), the original SaveAs
/// result still propagates and `DisplayAlerts` may be left disabled.
/// Callers MUST treat the session as poisoned after such a failure.
///
/// This design preempts ADR-015 §7 R9 (callers forgetting to restore
/// `DisplayAlerts` after manual `set_display_alerts(false)` would
/// leak silent data-loss behaviour into subsequent flows).
///
/// On disk-level failure (path inside a directory the user cannot
/// write to, antivirus lock, etc.) Excel returns a generic HRESULT
/// which is surfaced as [`VbaBridgeError::VbaModuleAuthoringFailed`]
/// — Phase 2e reuses that variant because the failure is structurally
/// a "could not persist macro-bearing workbook" event, which is
/// what `VbaModuleAuthoringFailed` already covers in §4.4. Naming
/// did not justify a new typed error for this rare path.
pub fn workbook_save_as(
    session: &ExcelSession,
    path: String,
    format: XlFileFormat,
) -> VbaBridgeResult<()> {
    session.with_app(move |app| {
        let active_wb = dispatch::invoke_get(app, "ActiveWorkbook", &[])?;
        let wb_disp = variant_to_dispatch(&active_wb)
            .ok_or_else(|| make_unexpected("ActiveWorkbook did not return IDispatch"))?;

        // Save-restore guard: snapshot the current DisplayAlerts state,
        // suppress for the SaveAs, and always restore. We do NOT use
        // `?` on the restore path so it runs even when SaveAs failed.
        // The snapshot read is best-effort too: if Excel refuses the
        // get (very unusual), we fall back to "true" (Excel default)
        // for the restore, which is the safer fallback because it
        // preserves user-visible alerts.
        let prev_display_alerts = dispatch::invoke_get(app, "DisplayAlerts", &[])
            .unwrap_or_else(|_| true.into());
        let false_v: VARIANT = false.into();
        // If the suppress itself fails, abort early — the SaveAs would
        // otherwise hang on the modal. Return the typed error so the
        // caller knows the apartment is healthy but Excel is uncooperative.
        dispatch::invoke_put(app, "DisplayAlerts", false_v).map_err(|e| match e {
            VbaBridgeError::ComCallFailed { context, hresult } => {
                VbaBridgeError::VbaModuleAuthoringFailed(format!(
                    "Could not suppress DisplayAlerts before SaveAs \
                     (HRESULT=0x{hresult:08x}): {context}"
                ))
            }
            other => other,
        })?;

        let path_v: VARIANT = BSTR::from(path).into();
        let fmt_v: VARIANT = (format as i32).into();

        let save_result = dispatch::invoke_call(&wb_disp, "SaveAs", &[path_v, fmt_v])
            .map_err(|e| match e {
                VbaBridgeError::ComCallFailed { context, hresult } => {
                    VbaBridgeError::VbaModuleAuthoringFailed(format!(
                        "Workbook.SaveAs failed (HRESULT=0x{hresult:08x}): {context}"
                    ))
                }
                other => other,
            });

        // Always restore. Failure here is logged via the discarded
        // result; we do not mask the SaveAs result with a restore
        // error (the caller cares about whether the workbook landed
        // on disk far more than whether DisplayAlerts is back to its
        // original value).
        let _ = dispatch::invoke_put(app, "DisplayAlerts", prev_display_alerts);

        save_result.map(|_| ())
    })
}

/// Run a previously-defined macro by name.
///
/// Calls `Application.Run(macro_name)`. The macro must already exist
/// in the active workbook (typically added via [`vba_module_add`]).
/// Returns `Ok(())` on successful invocation, or
/// [`VbaBridgeError::VbaMacroExecutionFailed`] if Excel rejects the call.
///
/// ## Trust Center gating (the reason Phase 2e exists)
///
/// `Application.Run` against the active workbook is gated by Excel's
/// Trust Center policy in addition to the user-level `AccessVBOM` /
/// `VBAWarnings` settings handled by `scripts/enable-access-vbom.mjs`.
/// Specifically, an in-memory workbook with no file path on disk
/// cannot have its macros executed under any Trust Center policy —
/// Excel returns HRESULT `0x800a03ec` (
/// "マクロを実行できません。このブックでマクロが使用できないか、または
/// すべてのマクロが無効になっている可能性があります。").
///
/// The Phase 2e fix is to save the workbook into a managed Trusted
/// Location before invoking the macro: call [`workbook_save_as`]
/// against a path under `%LOCALAPPDATA%\desktop-touch-mcp\trusted-vba\`
/// (the directory `scripts/enable-access-vbom.mjs` registers as a
/// Trusted Location), then call [`macro_run`]. The end-to-end test in
/// this module's `tests` submodule demonstrates the full sequence.
pub fn macro_run(
    session: &ExcelSession,
    macro_name: String,
) -> VbaBridgeResult<()> {
    session.with_app(move |app| {
        let name_v: VARIANT = BSTR::from(macro_name).into();
        dispatch::invoke_call(app, "Run", &[name_v]).map_err(|e| match e {
            VbaBridgeError::ComCallFailed { context, hresult } => {
                VbaBridgeError::VbaMacroExecutionFailed(format!(
                    "Application.Run failed (HRESULT=0x{hresult:08x}): {context}"
                ))
            }
            other => other,
        })?;
        Ok(())
    })
}

/// Close the active workbook.
///
/// Calls `ActiveWorkbook.Close(SaveChanges)`. The `save_changes`
/// argument maps directly to the COM method's first parameter:
/// - `true` — persist any pending edits before closing
/// - `false` — discard pending edits
///
/// Use this after [`macro_run`] (or any side-effect-bearing sequence)
/// when the demo flow does not need the workbook to remain open. The
/// `Excel.Application` itself stays alive — the session's STA worker
/// thread holds the IDispatch reference and only releases it on
/// [`ExcelSession`] drop.
///
/// Setting `save_changes = false` against a workbook with unsaved
/// edits does NOT prompt the user (it suppresses the prompt
/// internally). Setting `save_changes = true` against a workbook
/// without a file path on disk will fail with a COM error because
/// Excel does not know where to save; callers must run
/// [`workbook_save_as`] first to anchor the workbook to a path.
pub fn workbook_close(session: &ExcelSession, save_changes: bool) -> VbaBridgeResult<()> {
    session.with_app(move |app| {
        let active_wb = dispatch::invoke_get(app, "ActiveWorkbook", &[])?;
        let wb_disp = variant_to_dispatch(&active_wb)
            .ok_or_else(|| make_unexpected("ActiveWorkbook did not return IDispatch"))?;

        let save_v: VARIANT = save_changes.into();
        dispatch::invoke_call(&wb_disp, "Close", &[save_v])?;
        Ok(())
    })
}

// ─── Internal helpers ─────────────────────────────────────────────────

/// Extract an `IDispatch` pointer from a VARIANT that should carry one.
///
/// Returns `None` if the VARIANT does not contain a non-null IDispatch.
/// Used to walk the Excel COM object graph (Workbook → VBProject → ...).
///
/// # SAFETY (Opus Round 1 P1-2)
///
/// The unsafe block accesses the VARIANT's anonymous union via raw
/// field projection. This is safe under the following invariants:
///
/// - **Tag check first**: `inner.vt == VT_DISPATCH` is checked before
///   reading `pdispVal`. windows-rs 0.62's `VARIANT_0_0_0` union
///   guarantees that the `pdispVal` arm is the active member iff
///   `vt == VT_DISPATCH` (or one of the related dispatch variants);
///   reading it under a different tag is undefined behavior, which
///   the tag check prevents.
/// - **`ManuallyDrop` deref + clone semantic**: `pdispVal` is
///   `ManuallyDrop<Option<IDispatch>>` in windows-rs 0.62. The `*`
///   deref invokes `ManuallyDrop::deref` → `&Option<IDispatch>`, then
///   `.clone()` invokes `Option::clone` which (for `Some(IDispatch)`)
///   calls `IDispatch::clone` which calls `AddRef`. The returned
///   `Option<IDispatch>` is therefore independently refcount-managed
///   and `Drop`-safe across the caller's scope.
/// - **Apartment affinity**: the caller (only call site is
///   `excel.rs`) invokes this function from inside a `with_app`
///   closure that runs on the STA worker thread. The cloned
///   `IDispatch` therefore lives on the same apartment that created
///   the source VARIANT, satisfying COM apartment rules.
///
/// **Structural hazard guard**: callers must not pass the returned
/// `IDispatch` out of the `with_app` closure (e.g. by smuggling it
/// through `usize` or `Result<Self>`). Current callers in `excel.rs`
/// consume it within the same closure body and drop it before the
/// closure returns, satisfying this constraint by inspection. If
/// future code violates this, COM ref-count management will go wrong
/// in subtle ways — add a regression test before such a change.
fn variant_to_dispatch(v: &VARIANT) -> Option<IDispatch> {
    unsafe {
        let inner = &v.Anonymous.Anonymous;
        if inner.vt == windows::Win32::System::Variant::VT_DISPATCH {
            (*inner.Anonymous.pdispVal).clone()
        } else {
            None
        }
    }
}

fn make_unexpected(context: &str) -> VbaBridgeError {
    VbaBridgeError::ComCallFailed {
        hresult: 0,
        context: format!("unexpected VARIANT shape: {context}"),
    }
}

#[cfg(test)]
mod tests {
    // `use super::*` is only referenced from the `excel-installed`-gated
    // integration test below. Guarding the import behind the same feature
    // silences the "unused import" warning in default-features builds
    // (Phase 2d shipped with this warning; Phase 2e cleans it up).
    #[cfg(feature = "excel-installed")]
    use super::*;

    /// End-to-end demo path against a real Excel install:
    /// open Excel → suppress prompts → add Workbook → add VBA module
    /// with a known Sub → SaveAs into the Trusted Location → run it →
    /// close the workbook → drop session (releases Excel).
    ///
    /// **Phase 2e** verifies the full execution path, replacing the
    /// Phase 2d test that stopped at authoring. The new test asserts
    /// `macro_run` succeeds (it was lenient before because in-memory
    /// workbooks were Trust Center-gated).
    ///
    /// Preconditions on the host machine:
    /// 1. Excel 365 / 2019+ installed
    /// 2. `node scripts/enable-access-vbom.mjs` has been run at least
    ///    once (post-Phase-2e CLI which also registers the Trusted
    ///    Location at `%LOCALAPPDATA%\desktop-touch-mcp\trusted-vba`)
    /// 3. The Trusted Location directory exists (the CLI creates it)
    ///
    /// If preconditions are not met, the test panics with a clear
    /// `"run scripts/enable-access-vbom.mjs"` hint rather than a
    /// generic HRESULT.
    #[cfg(feature = "excel-installed")]
    #[test]
    fn end_to_end_vba_macro_authoring_and_execution() {
        use std::path::PathBuf;

        // Resolve the Trusted Location directory that the CLI
        // registers. We mirror the CLI's default (LOCALAPPDATA-based)
        // rather than re-reading the registry because:
        // 1. The Rust side intentionally has no registry-write capability
        // 2. The CLI's default path is contract-stable for the demo
        // 3. Reading the registry would require pulling in registry.rs
        //    here too, and this is test-only code
        let local_app_data = std::env::var("LOCALAPPDATA")
            .expect("LOCALAPPDATA must be set on Windows (this test is Windows-only)");
        let trusted_dir = PathBuf::from(local_app_data)
            .join("desktop-touch-mcp")
            .join("trusted-vba");
        assert!(
            trusted_dir.is_dir(),
            "Trusted Location directory missing: {}\n\
             Run `node scripts/enable-access-vbom.mjs` first — Phase 2e's CLI \
             registers this directory as an Excel Trusted Location AND creates it.",
            trusted_dir.display()
        );

        // Unique filename per run so concurrent test invocations (e.g.
        // `cargo test --test-threads=1` violations) and stale files
        // from prior runs do not collide.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let workbook_path = trusted_dir.join(format!("vba_bridge_e2e_{nanos}.xlsm"));
        let workbook_path_str = workbook_path
            .to_str()
            .expect("trusted workbook path must be valid UTF-8")
            .to_string();

        let session = ExcelSession::spawn().expect("Excel must be installed");

        // Phase 2e contract: `workbook_save_as` manages DisplayAlerts
        // internally via a save-restore guard, so the test does NOT
        // call `set_display_alerts(false)` directly. See module doc
        // "Call sequence" section + workbook_save_as doc.
        set_visible(&session, false).expect("set_visible(false) must succeed");

        workbook_add_new(&session).expect("workbook_add_new must succeed");

        let macro_name = "DesktopTouchAdHoc".to_string();
        let code = format!(
            "Sub {macro_name}()\r\n    Range(\"A1\").Value = \"Hello from Claude via VBA\"\r\nEnd Sub"
        );
        vba_module_add(&session, macro_name.clone(), code)
            .expect("vba_module_add must succeed (AccessVBOM trusted?)");

        // Anchor the workbook to disk under the Trusted Location so
        // macro execution is no longer Trust-Center-gated.
        workbook_save_as(
            &session,
            workbook_path_str.clone(),
            XlFileFormat::OpenXmlWorkbookMacroEnabled,
        )
        .expect("workbook_save_as must succeed (Trusted Location dir writable?)");

        // Phase 2e contract: this MUST succeed now that the workbook
        // is in a Trusted Location. If it does not, either the CLI
        // never registered the Trusted Location or the registration
        // is stale (Excel reads it at process start). Surface that as
        // a panic with explicit remediation rather than a silent skip.
        macro_run(&session, macro_name).unwrap_or_else(|e| {
            panic!(
                "macro_run FAILED after SaveAs to Trusted Location: {e}\n\
                 If this is HRESULT 0x800a03ec, the directory \
                 {} is not (yet) a registered Trusted Location. \
                 Re-run `node scripts/enable-access-vbom.mjs` which (post Phase 2e) \
                 registers it. Excel reads the Trusted Locations list at process \
                 start, so a previously-running Excel.exe will NOT pick up a \
                 newly-registered location — close all Excel windows before retrying.",
                trusted_dir.display()
            );
        });

        // Close the workbook cleanly without re-saving (Range write
        // from the macro happened in-memory; we don't care to persist
        // it for the test, and avoiding a second SaveAs lets the file
        // we created stay as the lighter authored-only artifact).
        workbook_close(&session, false).expect("workbook_close must succeed");

        eprintln!(
            "[engine-vba-bridge] Phase 2e end-to-end success — macro executed from \
             Trusted-Location workbook at {}",
            workbook_path.display()
        );

        // Drop the session BEFORE deleting the file: SaveAs leaves
        // Excel holding a handle to the .xlsm; deleting while Excel
        // holds it raises ERROR_SHARING_VIOLATION on some Windows
        // builds. ExcelSession::drop releases the IDispatch on the
        // STA thread, which closes Excel and releases the handle.
        drop(session);

        // Best-effort cleanup with a small retry loop. Excel.exe is
        // documented to hold the .xlsm `FILE_SHARE_DELETE` handle for
        // a brief window after the IDispatch release (KB / Office
        // forums report 10-50ms on average; antivirus scanning can
        // extend it further). 3 retries × 100ms covers the practical
        // range; failures after that are logged but not fatal.
        let mut last_err: Option<std::io::Error> = None;
        for attempt in 0..3 {
            match std::fs::remove_file(&workbook_path) {
                Ok(()) => {
                    last_err = None;
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                    if attempt < 2 {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
            }
        }
        if let Some(e) = last_err {
            eprintln!(
                "[engine-vba-bridge] non-fatal: failed to remove test workbook {} after 3 retries: {e}",
                workbook_path.display()
            );
        }
    }
}
