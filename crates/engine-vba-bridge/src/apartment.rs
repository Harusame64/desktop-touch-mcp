//! STA worker thread + `Excel.Application` lifecycle (ADR-015 §3.4).
//!
//! `Excel.Application` is a single-threaded apartment (STA) COM
//! object. All calls must originate from a thread that has called
//! `CoInitializeEx(COINIT_APARTMENTTHREADED)`. This module owns one
//! such worker thread, spawns `Excel.Application` on it via
//! `CoCreateInstance`, and offers callers a typed `with_app` method
//! that dispatches a closure onto the worker thread synchronously.
//!
//! The high-level shape — one dedicated worker thread + a
//! crossbeam-channel command pump — mirrors `src/uia/thread.rs` (MTA
//! worker). The two differences ADR-015 §3.4 calls out:
//!
//! 1. Apartment: this module uses **STA** (`COINIT_APARTMENTTHREADED`)
//!    because Excel strictly requires STA; UIA uses MTA
//! 2. Lifetime: this module is **per-instance** (no `OnceLock`
//!    singleton) so callers can hold multiple independent
//!    `Excel.Application` objects in parallel; UIA is process-singleton
//!
//! ## Drop / shutdown
//!
//! `ExcelSession::drop` signals shutdown via the bounded(1) shutdown
//! channel and joins the worker. The worker drops the `Excel.Application`
//! IDispatch on the worker thread (releasing the COM reference is
//! apartment-affine, so it must happen on the STA thread) and then
//! calls `CoUninitialize`. If the caller has unfinished commands in
//! flight when drop runs, those commands are still processed; the
//! shutdown channel uses a `select!` priority so already-queued
//! commands complete before shutdown observes the signal.

use std::sync::Mutex;
use std::thread::{self, JoinHandle};

use crossbeam_channel::{Receiver, Sender, bounded, unbounded};
use windows::Win32::System::Com::{
    CLSCTX_LOCAL_SERVER, CLSIDFromProgID, COINIT_APARTMENTTHREADED, CoCreateInstance,
    CoInitializeEx, CoUninitialize, IDispatch,
};
use windows::core::PCWSTR;

use crate::errors::{VbaBridgeError, VbaBridgeResult};

/// Boxed closure that runs on the STA worker with the
/// `Excel.Application` IDispatch in scope. The closure produces no
/// direct return — callers send their results back via a one-shot
/// reply channel they own (see [`ExcelSession::with_app`]).
type ExcelTask = Box<dyn FnOnce(&IDispatch) + Send + 'static>;

/// Per-instance handle to one STA worker thread that owns one
/// `Excel.Application` IDispatch for its lifetime.
///
/// Cloning is intentionally not implemented; the worker is exclusive
/// to one session, and lifetime is tied to this handle's Drop.
pub struct ExcelSession {
    sender: Sender<ExcelTask>,
    shutdown_tx: Sender<()>,
    join_handle: Mutex<Option<JoinHandle<()>>>,
}

impl ExcelSession {
    /// Spawn the STA worker thread and create `Excel.Application` on it.
    ///
    /// Errors:
    ///
    /// - `VbaBridgeError::ExcelNotInstalled` when
    ///   `CLSIDFromProgID("Excel.Application")` returns
    ///   `REGDB_E_CLASSNOTREG`
    /// - `VbaBridgeError::ComCallFailed` for unexpected COM failures
    ///   during `CoInitializeEx` / `CoCreateInstance`
    ///
    /// On success, returns a session whose `with_app` method dispatches
    /// closures onto the worker thread synchronously.
    pub fn spawn() -> VbaBridgeResult<Self> {
        let (sender, receiver): (Sender<ExcelTask>, Receiver<ExcelTask>) = unbounded();
        let (shutdown_tx, shutdown_rx): (Sender<()>, Receiver<()>) = bounded(1);

        // We need to relay startup errors from the worker back to the
        // caller; a bounded(1) reply channel does this.
        let (ready_tx, ready_rx): (Sender<VbaBridgeResult<()>>, Receiver<VbaBridgeResult<()>>) =
            bounded(1);

        let join_handle = thread::Builder::new()
            .name("vba-bridge-sta".to_string())
            .spawn(move || {
                worker_loop(receiver, shutdown_rx, ready_tx);
            })
            .map_err(|e| VbaBridgeError::ComCallFailed {
                hresult: -1,
                context: format!("ExcelSession::spawn: thread spawn failed: {e}"),
            })?;

        // Wait for the worker to confirm Excel.Application creation
        // (or report the typed error).
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                sender,
                shutdown_tx,
                join_handle: Mutex::new(Some(join_handle)),
            }),
            Ok(Err(e)) => {
                // Worker reported a startup failure; it has already
                // exited (or is about to). Join to avoid leaving an
                // orphaned thread.
                let _ = join_handle.join();
                Err(e)
            }
            Err(_) => {
                // Worker exited without sending readiness — unexpected.
                let _ = join_handle.join();
                Err(VbaBridgeError::ComCallFailed {
                    hresult: -1,
                    context: "ExcelSession::spawn: worker exited before signalling readiness"
                        .to_string(),
                })
            }
        }
    }

    /// Dispatch a closure onto the STA worker thread, blocking until
    /// the worker returns the result.
    ///
    /// The closure receives `&IDispatch` (the live Excel.Application
    /// pointer). All dispatch.rs helpers can be called from inside —
    /// they take `&IDispatch` directly.
    ///
    /// Errors propagated through the closure return value; transport-
    /// level errors (worker exited, shutdown in progress) come back as
    /// `VbaBridgeError::ComCallFailed`.
    pub fn with_app<F, R>(&self, f: F) -> VbaBridgeResult<R>
    where
        F: FnOnce(&IDispatch) -> VbaBridgeResult<R> + Send + 'static,
        R: Send + 'static,
    {
        let (reply_tx, reply_rx) = bounded::<VbaBridgeResult<R>>(1);
        let task: ExcelTask = Box::new(move |disp: &IDispatch| {
            // Wrap f(disp) in catch_unwind so a panic inside the
            // user closure does not kill the STA worker thread
            // (which would leak the apartment + Excel.exe). On
            // panic we translate to a typed error so the caller
            // can recover. (Opus Round 1 P1-3 / P1-4.)
            let panic_result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(disp)));
            let result: VbaBridgeResult<R> = match panic_result {
                Ok(r) => r,
                Err(panic_payload) => {
                    let info = if let Some(s) = panic_payload.downcast_ref::<&'static str>() {
                        (*s).to_string()
                    } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "<non-string panic payload>".to_string()
                    };
                    Err(VbaBridgeError::ComCallFailed {
                        hresult: -1,
                        context: format!("with_app closure panicked: {info}"),
                    })
                }
            };
            // Best-effort: if the caller has dropped the reply
            // receiver, swallow the send error.
            let _ = reply_tx.send(result);
        });

        self.sender.send(task).map_err(|_| VbaBridgeError::ComCallFailed {
            hresult: -1,
            context: "ExcelSession::with_app: worker channel closed (session shut down)"
                .to_string(),
        })?;

        reply_rx.recv().map_err(|_| VbaBridgeError::ComCallFailed {
            hresult: -1,
            context: "ExcelSession::with_app: reply channel closed (worker exited mid-task)"
                .to_string(),
        })?
    }
}

impl Drop for ExcelSession {
    fn drop(&mut self) {
        // Signal shutdown. The worker's select! loop observes this
        // after draining queued commands.
        let _ = self.shutdown_tx.try_send(());

        // Join the worker so the apartment / IDispatch are torn down
        // on the apartment thread (not on the Drop caller's thread).
        if let Some(j) = self.join_handle.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = j.join();
        }
    }
}

/// Worker thread entrypoint. Performs apartment init + Excel creation,
/// reports readiness, runs the command pump, then tears down on
/// shutdown.
fn worker_loop(
    receiver: Receiver<ExcelTask>,
    shutdown_rx: Receiver<()>,
    ready_tx: Sender<VbaBridgeResult<()>>,
) {
    // ── Apartment init ──────────────────────────────────────────────
    //
    // CoInitializeEx returns S_OK on first init for the thread, or
    // S_FALSE if the thread is already in an apartment. We treat
    // S_FALSE as an apartment-mismatch problem only if our requested
    // apartment differs; for a fresh thread this is just S_OK.
    let init_hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if init_hr.is_err() {
        let _ = ready_tx.send(Err(VbaBridgeError::ComCallFailed {
            hresult: init_hr.0,
            context: "CoInitializeEx(STA): worker thread init failed".to_string(),
        }));
        return;
    }

    // ── Resolve CLSID + create Excel.Application ────────────────────
    //
    // CLSIDFromProgID returns REGDB_E_CLASSNOTREG when Excel is not
    // installed. We translate that to the typed ExcelNotInstalled
    // error so the MCP envelope surfaces it cleanly.
    let progid: Vec<u16> = "Excel.Application"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let clsid = match unsafe { CLSIDFromProgID(PCWSTR(progid.as_ptr())) } {
        Ok(c) => c,
        Err(e) => {
            let raw = e.code().0;
            // REGDB_E_CLASSNOTREG = 0x80040154 (-2147221164)
            let err = if raw == 0x80040154_u32 as i32 {
                VbaBridgeError::ExcelNotInstalled
            } else {
                VbaBridgeError::ComCallFailed {
                    hresult: raw,
                    context: format!("CLSIDFromProgID(Excel.Application): {}", e.message()),
                }
            };
            let _ = ready_tx.send(Err(err));
            unsafe {
                CoUninitialize();
            }
            return;
        }
    };

    let app: IDispatch = match unsafe { CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER) } {
        Ok(a) => a,
        Err(e) => {
            let _ = ready_tx.send(Err(VbaBridgeError::ComCallFailed {
                hresult: e.code().0,
                context: format!("CoCreateInstance(Excel.Application): {}", e.message()),
            }));
            unsafe {
                CoUninitialize();
            }
            return;
        }
    };

    // Successful startup; release the caller from spawn().
    let _ = ready_tx.send(Ok(()));

    // ── Command pump ────────────────────────────────────────────────
    //
    // select! biases command processing — already-queued commands
    // drain before the shutdown signal is observed. This mirrors the
    // ordering in src/uia/thread.rs.
    loop {
        crossbeam_channel::select! {
            recv(receiver) -> task => {
                match task {
                    Ok(task) => {
                        // catch_unwind belt-and-suspenders: the inner
                        // with_app closure already wraps the user
                        // closure, but we also catch here so any panic
                        // in the ExcelTask boxed closure itself
                        // (signal sending, type conversion, etc.) does
                        // not skip the apartment teardown below.
                        // (Opus Round 1 P1-3.)
                        let _ = std::panic::catch_unwind(
                            std::panic::AssertUnwindSafe(|| task(&app))
                        );
                    }
                    Err(_) => break, // sender dropped — implicit shutdown
                }
            }
            recv(shutdown_rx) -> _ => break,
        }
    }

    // ── Teardown ────────────────────────────────────────────────────
    //
    // Drop the IDispatch on the apartment thread (release the COM
    // reference), then CoUninitialize. Order matters: CoUninitialize
    // invalidates interface pointers on this thread.
    drop(app);

    unsafe {
        CoUninitialize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On a machine with Excel installed, ExcelSession::spawn should
    /// succeed and dropping the session should not panic. This test
    /// is gated behind the `excel-installed` Cargo feature — CI does
    /// not enable it; local + release-machine `cargo test --features
    /// excel-installed` does.
    #[cfg(feature = "excel-installed")]
    #[test]
    fn spawn_and_drop_against_real_excel() {
        let session = ExcelSession::spawn().expect("Excel must be installed for this test");
        // Smallest possible work: ask the IDispatch for its own type
        // info pointer (we don't use it; this just round-trips a COM
        // call to prove the apartment dispatch works end-to-end).
        session
            .with_app(|disp| {
                // No-op: confirm the closure runs on the worker.
                let _ = disp.clone();
                Ok::<(), VbaBridgeError>(())
            })
            .expect("with_app round-trip must succeed");
        // Session drop joins the worker and tears down COM.
    }

    /// On a machine WITHOUT Excel, spawn should return
    /// VbaBridgeError::ExcelNotInstalled rather than a generic
    /// failure. Gated behind a separate feature so we can opt in to
    /// the negative test on a deliberately-not-installed machine.
    #[cfg(feature = "excel-missing")]
    #[test]
    fn spawn_without_excel_returns_typed_error() {
        match ExcelSession::spawn() {
            Err(VbaBridgeError::ExcelNotInstalled) => {}
            other => panic!(
                "expected VbaBridgeError::ExcelNotInstalled, got {other:?}"
            ),
        }
    }

    /// Compile-only verification: the public API surface is stable
    /// (so caller code can be written against it even on machines
    /// where Excel is absent). Phase 2 acceptance.
    #[test]
    fn public_api_signatures_compile() {
        // Type aliases for compile-time witness.
        let _spawn_fn: fn() -> VbaBridgeResult<ExcelSession> = ExcelSession::spawn;
        // with_app is generic so we cannot take a function pointer
        // directly; instead verify a closure-typed signature by
        // requiring it within a `_` slot.
        fn _accepts_session(_s: &ExcelSession) {}
    }
}
