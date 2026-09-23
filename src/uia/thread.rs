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
// friends require the COM apartment to still be alive, so they must run
// *before* `CoUninitialize`. Since internal #168 the focus handler is owned by
// its own registration thread (`spawn_focus_registration`), which keeps that
// order on itself; this thread only signals it and waits briefly.

pub(crate) struct UiaThreadHandle {
    sender: Sender<UiaTask>,
    shutdown_tx: Sender<()>,
    join_handle: Mutex<Option<thread::JoinHandle<()>>>,
}

impl UiaThreadHandle {
    /// Send a `UiaTask` to the COM thread. Returns `Err` if the channel is
    /// closed (thread is shutting down or already exited).
    pub(crate) fn send(&self, task: UiaTask) -> Result<(), crossbeam_channel::SendError<UiaTask>> {
        // ADR-036 H2 — counted here, at the only door to the thread, so a caller that sends without
        // going through `execute_with_timeout` is still counted. It counts attempts: a send that fails
        // because the thread is shutting down is still one.
        bump(&TASKS_SENT);
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

// ─── ADR-036 H2: what the engine has done in this process ────────────────────
//
// `DESKTOP_TOUCH_DISABLE_NATIVE_UIA=1` keeps the TypeScript side from calling this engine. Until now the
// only record of that was the switch itself: `server_status` and the probe's row zero both read the same
// env var, so a build where native UIA still ran under the switch reported "disabled" all the same.
// #626's second gate found exactly that. foreground_flash's paste-warning scan started this thread from
// inside a win32 call.
//
// These counts are kept by the engine, at the one place its COM thread is started and the one place a
// task is sent to it. So they answer from what happened, not from what was configured.
static COM_THREAD_STARTS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static TASKS_SENT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
// Internal #168 — how many tasks the COM thread has FINISHED (run to completion or panicked), beside how
// many were sent. The measured stall was "22 sent, 0 processed", and only `tasksSent` was visible.
static TASKS_DONE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
// Internal #168 — where the desktop-wide focus-handler registration is. A registration that never returns
// is `pending` for the life of the server, and focus events are then off; this is how a caller can see it.
static FOCUS_REGISTRATION: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(FOCUS_NOT_STARTED);
const FOCUS_NOT_STARTED: u8 = 0;
const FOCUS_PENDING: u8 = 1;
const FOCUS_REGISTERED: u8 = 2;
const FOCUS_FAILED: u8 = 3;

fn set_focus_registration(state: u8) {
    FOCUS_REGISTRATION.store(state, std::sync::atomic::Ordering::Relaxed);
}

/// Saturating, so a long-lived process can never wrap back round to the 0 that means "never ran".
fn bump(counter: &std::sync::atomic::AtomicU32) {
    use std::sync::atomic::Ordering::Relaxed;
    let _ = counter.fetch_update(Relaxed, Relaxed, |v| Some(v.saturating_add(1)));
}

/// What the UIA engine has done in this process: COM-thread starts, tasks sent, tasks finished, and
/// where the focus-handler registration is (`not_started` / `pending` / `registered` / `failed`).
pub(crate) fn engine_evidence() -> (u32, u32, u32, &'static str) {
    use std::sync::atomic::Ordering::Relaxed;
    let focus = match FOCUS_REGISTRATION.load(Relaxed) {
        FOCUS_PENDING => "pending",
        FOCUS_REGISTERED => "registered",
        FOCUS_FAILED => "failed",
        _ => "not_started",
    };
    (COM_THREAD_STARTS.load(Relaxed), TASKS_SENT.load(Relaxed), TASKS_DONE.load(Relaxed), focus)
}

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
/// applied to UIA thread in P5c-0b). The focus handler is not dropped here: since internal #168 its
/// registration thread removes it on the signal the COM thread sends as it leaves its loop.
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
    bump(&COM_THREAD_STARTS);
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

    // ── Internal #168: the focus handler is registered OFF this thread ──────
    // `AddFocusChangedEventHandler` is desktop-wide and synchronous, and it has no deadline. With one
    // unresponsive UIA provider anywhere on the desktop it did not return, and because it ran here —
    // before the task loop — the loop was never reached: 22 tasks sent in 75 s, 0 processed, every
    // native read a timeout for the life of the server (win2 / Opus, 2026-09-23, internal `2078af5`;
    // the suspect was a hung XboxPcTray CoreWindow). Tasks are served first now; the registration
    // runs on its own thread with its own apartment membership and its own `IUIAutomation`, and a
    // registration that never returns costs focus events only — which is what the old code's own
    // failure branch already accepted ("focus events disabled").
    let (focus_stop_tx, focus_stop_rx) = bounded::<()>(1);
    let focus_thread = spawn_focus_registration(focus_stop_rx);
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
                    bump(&TASKS_DONE);
                }
                Err(_) => break, // task channel disconnected
            },
            recv(shutdown_rx) -> _ => break,
        }
    }

    // Internal #168 — tell the registration thread to remove its handler and leave, and wait for it
    // only briefly. In the ordinary case the removal finishes inside the wait, so a re-spawned COM
    // thread (the tests' shutdown/restart cycles) never adds a handler while the old one is still
    // registered — the one-thread-at-a-time rule Microsoft states for adding and removing event
    // handlers (gate 2). If the registration never returned, the thread is still inside it: the wait
    // ends and the thread is left, rather than moving the stall this change removed to shutdown.
    let _ = focus_stop_tx.try_send(());
    if let Some(handle) = focus_thread {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !handle.is_finished() && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if handle.is_finished() {
            let _ = handle.join();
        }
    }

    // CoUninitialize must happen on this same thread, after the apartment is
    // fully drained.
    unsafe { CoUninitialize(); }
}

/// Internal #168 — register the desktop-wide focus-changed handler on a thread of its own.
///
/// P5c-1's rules still hold, on this thread: the owner is dropped (each `Remove*EventHandler` runs)
/// before `CoUninitialize`, and a registration failure is logged and costs focus events only.
/// The handler pushes into the shared L1 ring exactly as before; only the registering thread moved.
fn spawn_focus_registration(stop_rx: Receiver<()>) -> Option<thread::JoinHandle<()>> {
    let spawned = thread::Builder::new()
        .name("uia-focus-registration".into())
        .spawn(move || {
            // Safety: COM is initialised once on this thread; nothing it creates leaves it.
            unsafe {
                let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
                if hr.is_err() {
                    set_focus_registration(FOCUS_FAILED);
                    eprintln!("[uia-focus] CoInitializeEx failed: HRESULT 0x{:08x} -- focus events disabled", hr.0);
                    return;
                }
            }
            {
                let ctx = match build_context() {
                    Ok(c) => c,
                    Err(e) => {
                        set_focus_registration(FOCUS_FAILED);
                        eprintln!("[uia-focus] Failed to initialise UIA context: {e} -- focus events disabled");
                        unsafe { CoUninitialize(); }
                        return;
                    }
                };
                let mut event_owner = event_handlers::UiaEventHandlerOwner::new(ctx.automation.clone());
                let ring = crate::l1_capture::ensure_l1().ring.clone();
                let focus_handler = event_handlers::focus::make_focus_handler(ring);
                set_focus_registration(FOCUS_PENDING);
                let started = std::time::Instant::now();
                match event_owner.register_focus(&ctx.cache_request, focus_handler) {
                    Ok(()) => {
                        set_focus_registration(FOCUS_REGISTERED);
                        eprintln!("[uia-focus] focus handler registered in {} ms", started.elapsed().as_millis());
                    }
                    Err(e) => {
                        set_focus_registration(FOCUS_FAILED);
                        eprintln!("[uia-focus] AddFocusChangedEventHandler failed: {e} -- focus events disabled");
                    }
                }
                // Hold the registration until the task thread shuts down (or its sender is gone).
                let _ = stop_rx.recv();
                // P5c-1 — the owner before CoUninitialize, explicitly.
                drop(event_owner);
                drop(ctx);
            }
            unsafe { CoUninitialize(); }
        });
    match spawned {
        Ok(handle) => Some(handle),
        Err(e) => {
            set_focus_registration(FOCUS_FAILED);
            eprintln!("[uia-focus] could not start the registration thread: {e} -- focus events disabled");
            None
        }
    }
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

    /// The tests in this module that start, stop or use the one UIA thread take this lock, so they run
    /// one at a time. `cargo test` runs tests in parallel, and a shutdown landing while another test's
    /// task is queued can drop that task: the thread's `select!` picks among ready arms at random. That
    /// would redden the evidence test for a reason that has nothing to do with the count (2ゲート目,
    /// second read). No other module's tests touch this thread.
    static THREAD_TESTS: Mutex<()> = Mutex::new(());

    fn one_at_a_time() -> std::sync::MutexGuard<'static, ()> {
        THREAD_TESTS.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// ADR-036 H2 — a task sent to the thread is counted exactly once, and so is the thread's start. The
    /// counters are process-wide, so this compares before with after. With the thread tests serialized,
    /// the task count can be checked exactly: a count taken twice (in `execute_with_timeout` and in
    /// `send`) would read +2 and fail.
    #[test]
    fn engine_evidence_counts_a_task_and_the_thread_that_ran_it() {
        let _serial = one_at_a_time();
        let (_, tasks_before, done_before, _) = engine_evidence();
        let r: napi::Result<()> = execute_with_timeout(|_ctx| Ok(()), 5000);
        assert!(r.is_ok(), "the no-op task should run: {r:?}");
        let (starts, tasks_after, done_after, focus) = engine_evidence();
        assert!(starts >= 1, "the thread that ran the task was started, so its start was counted");
        assert_eq!(tasks_after, tasks_before + 1, "the task was counted exactly once");
        // Internal #168 — and FINISHED exactly once. The reply arrives after the task body returns and
        // before `TASKS_DONE` is bumped, so allow the bump a moment rather than racing it.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut done_now = done_after;
        while done_now < done_before + 1 && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
            done_now = engine_evidence().2;
        }
        assert_eq!(done_now, done_before + 1, "the task was counted as finished exactly once");
        assert!(
            ["not_started", "pending", "registered", "failed"].contains(&focus),
            "the focus registration answers one of its four words, got {focus:?}"
        );
    }

    /// ADR-036 H2 — the counts stop at the top rather than wrapping round to the 0 that means "never ran".
    #[test]
    fn engine_evidence_saturates_rather_than_wrapping_to_zero() {
        let c = std::sync::atomic::AtomicU32::new(u32::MAX - 1);
        bump(&c);
        bump(&c);
        assert_eq!(c.load(std::sync::atomic::Ordering::Relaxed), u32::MAX);
    }

    /// ADR-007 §3.4.3 acceptance, applied to the UIA thread in P5c-0b: the
    /// thread can be shut down and re-spawned through the `UIA_SLOT` and
    /// `shutdown_uia_for_test` API, mirroring the L1 worker's restart path.
    /// 5 cycles is the same multiplier the L1 test uses (matches the
    /// "graceful shutdown 3s" acceptance in P5a).
    #[test]
    fn shutdown_and_restart_5_cycles() {
        let _serial = one_at_a_time();
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
        let _serial = one_at_a_time();
        let _ = shutdown_uia_for_test(Duration::from_secs(3));
        let a = ensure_uia_thread();
        let b = ensure_uia_thread();
        assert!(Arc::ptr_eq(&a, &b));
        let _ = shutdown_uia_for_test(Duration::from_secs(3));
    }
}
