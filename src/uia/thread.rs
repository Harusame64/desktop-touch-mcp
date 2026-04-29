//! UIA COM thread singleton.
//!
//! A single dedicated thread owns the COM apartment (`CoInitializeEx` MTA) and
//! keeps an `IUIAutomation` instance alive for the entire process lifetime.
//! Callers on libuv worker threads send closures via `crossbeam-channel`;
//! each closure receives `&UiaContext` and posts its result back through a
//! one-shot reply channel.

use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use crossbeam_channel::{bounded, select, unbounded, Receiver, Sender};
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED, CoCreateInstance, CLSCTX_INPROC_SERVER,
};
use windows::Win32::UI::Accessibility::*;

// ─── Error conversion helper ─────────────────────────────────────────────────

/// Convert `windows::core::Error` to `napi::Error`.
pub(crate) fn win_err(e: windows::core::Error) -> napi::Error {
    napi::Error::from_reason(format!("UIA/COM error: {e}"))
}

// ─── Public context handed to every task closure ─────────────────────────────

pub(crate) struct UiaContext {
    pub automation: IUIAutomation,
    pub walker: IUIAutomationTreeWalker,
    pub cache_request: IUIAutomationCacheRequest,
    /// ControlView filter for `FindAllBuildCache(TreeScope_Children)`.
    /// Created once and reused — matches the ControlViewWalker scope.
    pub control_view_condition: IUIAutomationCondition,
}

// ─── Task type ───────────────────────────────────────────────────────────────

/// A boxed closure that borrows `UiaContext` on the COM thread.
pub(crate) type UiaTask = Box<dyn FnOnce(&UiaContext) + Send + 'static>;

// ─── Thread handle + slot (ADR-007 P5c-0b) ───────────────────────────────────
//
// Switched from a bare `OnceLock<Sender<UiaTask>>` to the same shape as the L1
// worker (`OnceLock<Mutex<Option<Arc<...>>>>`) so the thread can be cleanly
// shut down for tests and so future event-handler ownership (P5c-1) has a
// well-defined lifetime to attach to. `RemoveFocusChangedEventHandler` and
// friends require the COM apartment to still be alive, so shutdown must run
// *before* `CoUninitialize` — that ordering is enforced by the select-loop
// below.

pub(crate) struct UiaThreadHandle {
    sender: Sender<UiaTask>,
    shutdown_tx: Sender<()>,
    join_handle: Mutex<Option<thread::JoinHandle<()>>>,
}

impl UiaThreadHandle {
    /// Send a `UiaTask` to the COM thread. Returns `Err` if the channel is
    /// closed (thread is shutting down or already exited).
    pub(crate) fn send(&self, task: UiaTask) -> Result<(), crossbeam_channel::SendError<UiaTask>> {
        self.sender.send(task)
    }

    /// Signal shutdown and wait for the thread to join, with a timeout. Idempotent.
    pub(crate) fn shutdown_with_timeout(&self, timeout: Duration) -> Result<(), &'static str> {
        // bounded(1) shutdown channel — second send is harmless.
        let _ = self.shutdown_tx.try_send(());
        let handle_opt = {
            let mut guard = self.join_handle.lock().unwrap_or_else(|e| e.into_inner());
            guard.take()
        };
        let handle = match handle_opt {
            Some(h) => h,
            None => return Ok(()), // already joined
        };
        // No `JoinHandle::join_with_timeout` in std; mirror L1 worker pattern.
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        thread::spawn(move || {
            let _ = handle.join();
            let _ = tx.send(());
        });
        match rx.recv_timeout(timeout) {
            Ok(()) => Ok(()),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("uia thread join timed out"),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("join helper disconnected"),
        }
    }
}

impl Drop for UiaThreadHandle {
    fn drop(&mut self) {
        // Best-effort: signal shutdown but do not block. Explicit shutdown is
        // the caller's responsibility (via `shutdown_uia_for_test`).
        let _ = self.shutdown_tx.try_send(());
    }
}

static UIA_SLOT: OnceLock<Mutex<Option<Arc<UiaThreadHandle>>>> = OnceLock::new();

pub(crate) fn ensure_uia_thread() -> Arc<UiaThreadHandle> {
    let cell = UIA_SLOT.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(Arc::new(spawn_uia_thread()));
    }
    Arc::clone(guard.as_ref().unwrap())
}

/// Tear down the UIA thread so a subsequent `ensure_uia_thread()` re-spawns
/// it. Used for the 5-cycle shutdown/restart test (ADR-007 §3.4.3 acceptance,
/// applied to UIA thread in P5c-0b) and by P5c-1 to drop event handlers
/// before `CoUninitialize`.
#[allow(dead_code)] // first caller is the 5-cycle test below + P5c-1 handler dropper
pub(crate) fn shutdown_uia_for_test(timeout: Duration) -> Result<(), &'static str> {
    let cell = match UIA_SLOT.get() {
        Some(c) => c,
        None => return Ok(()),
    };
    let inner_opt = {
        let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
        guard.take()
    };
    match inner_opt {
        Some(inner) => inner.shutdown_with_timeout(timeout),
        None => Ok(()),
    }
}

fn spawn_uia_thread() -> UiaThreadHandle {
    let (tx, rx) = unbounded::<UiaTask>();
    let (shutdown_tx, shutdown_rx) = bounded::<()>(1);

    let join = thread::Builder::new()
        .name("uia-com".into())
        .spawn(move || com_thread_main(rx, shutdown_rx))
        .expect("Failed to spawn UIA COM thread");

    UiaThreadHandle {
        sender: tx,
        shutdown_tx,
        join_handle: Mutex::new(Some(join)),
    }
}

// ─── COM thread entry point ──────────────────────────────────────────────────

fn com_thread_main(rx: Receiver<UiaTask>, shutdown_rx: Receiver<()>) {
    // Safety: COM is initialised exactly once on this thread and never shared.
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            eprintln!("[uia-com] CoInitializeEx failed: HRESULT 0x{:08x}", hr.0);
            return;
        }
    }

    let ctx = match build_context() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[uia-com] Failed to initialise UIA context: {e}");
            unsafe { CoUninitialize(); }
            return;
        }
    };

    // Main loop — process tasks until shutdown signal or task channel closes.
    // `select!` lets us drain pending tasks and react to shutdown promptly;
    // staying in `recv()` would only exit when every Sender drops, which the
    // shutdown_uia_for_test() path can't guarantee (Arc<UiaThreadHandle> is
    // shared with other arenas).
    loop {
        select! {
            recv(rx) -> msg => match msg {
                Ok(task) => {
                    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        task(&ctx);
                    }));
                    if let Err(info) = res {
                        eprintln!("[uia-com] Task panicked: {info:?}");
                    }
                }
                Err(_) => break, // task channel disconnected
            },
            recv(shutdown_rx) -> _ => break,
        }
    }

    // CoUninitialize must happen on this same thread, after the apartment is
    // fully drained. P5c-1 will additionally drop UiaEventHandlerOwner here so
    // Remove*EventHandler executes before the apartment dies.
    unsafe { CoUninitialize(); }
}

/// Build persistent COM objects that live for the entire thread lifetime.
fn build_context() -> windows::core::Result<UiaContext> {
    unsafe {
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;

        let walker = automation.ControlViewWalker()?;

        // Per-element cache request (TreeScope_Element) — used by
        // FindAllBuildCache and BuildUpdatedCache across all modules.
        let cr = automation.CreateCacheRequest()?;
        configure_cache_properties(&cr)?;
        cr.SetTreeScope(TreeScope_Element)?;

        // ControlView condition — reused by BFS tree walks in tree.rs.
        // Equivalent to what ControlViewWalker uses internally.
        let cv_condition = automation.ControlViewCondition()?;

        Ok(UiaContext {
            automation,
            walker,
            cache_request: cr,
            control_view_condition: cv_condition,
        })
    }
}

/// Add the standard set of 8 properties + 6 patterns to a CacheRequest.
///
/// `UIA_NativeWindowHandlePropertyId` was added in ADR-007 P5c-0b so the
/// L1 Focus Changed event hook (P5c-1) can resolve `hwnd` via `Cached*`
/// methods only — without it, `cached_element_to_focus_info` would fall
/// back to a live UIA call on the delivery thread and miss the slow-path
/// budget.
unsafe fn configure_cache_properties(cr: &IUIAutomationCacheRequest) -> windows::core::Result<()> {
    unsafe {
        cr.AddProperty(UIA_NamePropertyId)?;
        cr.AddProperty(UIA_ControlTypePropertyId)?;
        cr.AddProperty(UIA_AutomationIdPropertyId)?;
        cr.AddProperty(UIA_BoundingRectanglePropertyId)?;
        cr.AddProperty(UIA_IsEnabledPropertyId)?;
        cr.AddProperty(UIA_IsOffscreenPropertyId)?;
        cr.AddProperty(UIA_ClassNamePropertyId)?;
        cr.AddProperty(UIA_NativeWindowHandlePropertyId)?;

        cr.AddPattern(UIA_InvokePatternId)?;
        cr.AddPattern(UIA_ValuePatternId)?;
        cr.AddPattern(UIA_ExpandCollapsePatternId)?;
        cr.AddPattern(UIA_SelectionItemPatternId)?;
        cr.AddPattern(UIA_TogglePatternId)?;
        cr.AddPattern(UIA_ScrollPatternId)?;
    }
    Ok(())
}

// ─── Public helper for callers ───────────────────────────────────────────────

/// Execute a closure on the COM thread with a caller-specified timeout.
pub(crate) fn execute_with_timeout<F, T>(f: F, timeout_ms: u32) -> napi::Result<T>
where
    F: FnOnce(&UiaContext) -> napi::Result<T> + Send + 'static,
    T: Send + 'static,
{
    let (reply_tx, reply_rx) = bounded(1);
    let task: UiaTask = Box::new(move |ctx| {
        let result = f(ctx);
        let _ = reply_tx.send(result);
    });
    ensure_uia_thread()
        .send(task)
        .map_err(|_| napi::Error::from_reason("UIA COM thread unavailable"))?;
    reply_rx
        .recv_timeout(Duration::from_millis(timeout_ms as u64))
        .map_err(|e| match e {
            crossbeam_channel::RecvTimeoutError::Timeout => {
                napi::Error::from_reason(format!(
                    "UIA operation timed out after {timeout_ms}ms"
                ))
            }
            crossbeam_channel::RecvTimeoutError::Disconnected => {
                napi::Error::from_reason("UIA COM thread disconnected")
            }
        })?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ADR-007 §3.4.3 acceptance, applied to the UIA thread in P5c-0b: the
    /// thread can be shut down and re-spawned through the `UIA_SLOT` and
    /// `shutdown_uia_for_test` API, mirroring the L1 worker's restart path.
    /// 5 cycles is the same multiplier the L1 test uses (matches the
    /// "graceful shutdown 3s" acceptance in P5a).
    #[test]
    fn shutdown_and_restart_5_cycles() {
        for _ in 0..5 {
            let _handle = ensure_uia_thread();
            shutdown_uia_for_test(Duration::from_secs(3))
                .expect("uia thread shutdown failed");
        }
    }

    /// `ensure_uia_thread()` is the moral equivalent of `ensure_l1()`:
    /// repeated calls return the same `Arc<UiaThreadHandle>` until shutdown.
    #[test]
    fn ensure_uia_thread_returns_same_instance() {
        let _ = shutdown_uia_for_test(Duration::from_secs(3));
        let a = ensure_uia_thread();
        let b = ensure_uia_thread();
        assert!(Arc::ptr_eq(&a, &b));
        let _ = shutdown_uia_for_test(Duration::from_secs(3));
    }
}
