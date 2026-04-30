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

use super::event_handlers;
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

    /// Signal shutdown and wait for the thread to join, with a timeout.
    ///
    /// Uses `JoinHandle::is_finished()` polling so the handle stays in
    /// `self.join_handle` until we know the thread has actually exited.
    /// On timeout the handle is still recoverable: a later
    /// `shutdown_with_timeout(longer)` (or even a fresh
    /// `shutdown_uia_for_test`) can re-poll and join the thread once
    /// the long-running task finally drains.
    ///
    /// Codex review v5 (P1+P2) and v6 (P1) on PR #84 walked the design
    /// from "take handle eagerly + helper join thread" to this polling
    /// shape. The eager take leaked the handle on timeout and made the
    /// COM thread permanently unrecoverable; polling keeps the slot
    /// usable for retry.
    pub(crate) fn shutdown_with_timeout(&self, timeout: Duration) -> Result<(), &'static str> {
        // bounded(1) shutdown channel — repeated sends are harmless.
        let _ = self.shutdown_tx.try_send(());

        let deadline = std::time::Instant::now() + timeout;
        let poll_interval = Duration::from_millis(10);

        loop {
            // Peek `is_finished()` without removing the handle. If the
            // thread is already done we promote to take + join in one
            // critical section so we don't race a concurrent caller.
            let finished_or_done = {
                let mut guard = self.join_handle.lock().unwrap_or_else(|e| e.into_inner());
                match guard.as_ref() {
                    Some(h) if h.is_finished() => {
                        // Take and join now (won't block — thread has exited).
                        let h = guard.take().expect("just observed Some");
                        let _ = h.join();
                        Some(Ok(()))
                    }
                    Some(_) => None, // still running
                    // Some other caller already observed the thread as
                    // finished and joined it; that's a successful shutdown.
                    None => Some(Ok(())),
                }
            };
            if let Some(result) = finished_or_done {
                return result;
            }

            if std::time::Instant::now() >= deadline {
                // Handle stays in `self.join_handle` so a subsequent
                // call (or `shutdown_uia_for_test` retry) can poll
                // again and join when the thread finally exits.
                return Err("uia thread join timed out");
            }
            thread::sleep(poll_interval);
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
///
/// **Slot is cleared only on success.** If `shutdown_with_timeout`
/// returns `Err` (typically a long-running UIA task exceeded the
/// timeout), the slot retains the original `Arc<UiaThreadHandle>` so
/// the next `ensure_uia_thread()` returns the still-running instance
/// rather than spawning a second COM thread (which would violate the
/// UIA singleton + apartment-affinity invariant).
///
/// Codex review v5 P1 on PR #84 prompted moving `guard.take()` from
/// before to after the shutdown confirmation.
#[allow(dead_code)] // first caller is the 5-cycle test below + P5c-1 handler dropper
pub(crate) fn shutdown_uia_for_test(timeout: Duration) -> Result<(), &'static str> {
    let cell = match UIA_SLOT.get() {
        Some(c) => c,
        None => return Ok(()),
    };
    // Borrow the Arc out of the slot without removing it yet — we need
    // confirmation that the thread actually stopped before we let
    // `ensure_uia_thread()` spawn a fresh one.
    let inner_arc = {
        let guard = cell.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(arc) => Arc::clone(arc),
            None => return Ok(()),
        }
    };
    match inner_arc.shutdown_with_timeout(timeout) {
        Ok(()) => {
            // Thread confirmed joined; clear the slot **only if it
            // still holds the same `Arc` we shut down**. A concurrent
            // caller may already have cleared it and re-spawned a
            // fresh COM thread via `ensure_uia_thread()`, in which
            // case clearing here would orphan that new thread (slot
            // → None) and let the next `ensure_uia_thread()` spawn a
            // third one — re-breaking the UIA singleton +
            // apartment-affinity invariant this `Ok` arm is supposed
            // to preserve. Codex review on PR #86 / horizontal port
            // of the L1 worker fix that closed ADR-007 §8 R11.
            let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
            if guard
                .as_ref()
                .map(|current| Arc::ptr_eq(current, &inner_arc))
                .unwrap_or(false)
            {
                *guard = None;
            }
            Ok(())
        }
        Err(e) => {
            // Slot retains the original Arc; the next ensure() returns
            // the same (potentially still-running) handle. Caller sees
            // the timeout error and can decide whether to retry.
            Err(e)
        }
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

    // ── P5c-1: register UIA event handlers ──────────────────────────────────
    // Owner holds the `IUIAutomation*EventHandler` instances; its `Drop`
    // calls the matching `Remove*EventHandler` so we tear down the
    // registration before `CoUninitialize` below. The handler holds an
    // `Arc<EventRing>` so it can push directly into the L1 ring without
    // ever touching `L1Inner` (which stays private to `l1_capture::worker`).
    let mut event_owner = event_handlers::UiaEventHandlerOwner::new(ctx.automation.clone());
    let ring = crate::l1_capture::ensure_l1().ring.clone();
    let focus_handler = event_handlers::focus::make_focus_handler(ring);
    if let Err(e) = event_owner.register_focus(&ctx.cache_request, focus_handler) {
        // Tier 1 graceful disable: log + continue. The COM thread is
        // still useful for everything else (existing UIA polling tasks
        // delivered via `rx`); we just lose focus event capture.
        eprintln!(
            "[uia-com] AddFocusChangedEventHandler failed: {e} -- focus events disabled"
        );
    }
    // ────────────────────────────────────────────────────────────────────────

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

    // ── P5c-1: drop the handler owner *before* CoUninitialize so each
    // `Remove*EventHandler` runs while the apartment is still alive.
    // Explicit drop pins the order; we don't rely on lexical scope.
    drop(event_owner);

    // CoUninitialize must happen on this same thread, after the apartment is
    // fully drained.
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
