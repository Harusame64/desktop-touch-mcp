//! L1 → engine-perception input boundary.
//!
//! ## Direction of dep
//!
//! The root crate (`desktop-touch-engine`) owns the L1 capture ring,
//! decodes `EventEnvelope` payloads, and pushes pure data into a
//! [`L1Sink`] implementation provided by this crate. The reverse
//! direction (engine-perception depending on the root crate) was
//! considered and rejected in Codex review v2 P1 — it would drag the
//! root crate's heavy compile graph (napi, ORT, tokenizers,
//! windows-rs, vision-gpu) into this crate and break the
//! "pure timely + DD compute" contract from
//! `docs/adr-008-d1-plan.md` §2.
//!
//! ## D1-2 wiring
//!
//! P5c-0b landed the trait + the `FocusEvent` data type as a stable
//! contract that the bridge in `src/l3_bridge/focus_pump.rs`
//! writes against. D1-2 fills the actual `FocusInputHandle` (the
//! `differential_dataflow::input::InputSession` wrapper) and the
//! `PerceptionWorker` (the timely worker thread that owns the
//! InputSession).
//!
//! ## Why a worker thread + command channel?
//!
//! `differential_dataflow::input::InputSession` is **thread-local** —
//! it can only be poked from inside the timely worker that built the
//! dataflow. We can't expose `&InputSession` to the bridge directly.
//! So we run the InputSession inside a dedicated worker thread and
//! feed it via a `crossbeam_channel::Sender<Cmd>`. `FocusInputHandle`
//! holds the sender; the worker holds the receiver and the
//! InputSession.
//!
//! ## Watermark semantics (北極星 N2)
//!
//! Per `docs/adr-008-d1-2-plan.md` §1.5 N2, we keep event-time as
//! data on `FocusEvent.{wallclock_ms, sub_ordinal}` and use
//! [`crate::time::LogicalTime`] for both the dataflow timestamp and
//! the timely frontier. `update_at(ev, event_time, +1)` posts each
//! event at its own logical time; `advance_to(watermark)` advances
//! the frontier to `(latest_wallclock_ms - WATERMARK_SHIFT_MS, 0)`.
//! Out-of-order events that fall within the watermark window are
//! accepted; events older than the current frontier are dropped (DD
//! would panic on `update_at` with a time below the session time —
//! we guard before calling).
//!
//! ## Idle frontier advance (PR #91 P2)
//!
//! Real L1 capture has no heartbeat: when a user focuses a window
//! and stops, no further `UiaFocusChanged` events arrive. Without
//! intervention the dataflow's input frontier would sit at
//! `(latest_wallclock_ms - shift, 0)` forever, leaving the most
//! recent event at the frontier and never released — the view would
//! be stale for the *current* focus, the very state it's meant to
//! materialise.
//!
//! We solve this by anchoring the most recent event's wallclock_ms
//! to a real `Instant` and, in the idle branch of the worker loop,
//! projecting `latest_wallclock_ms` forward by the real elapsed time
//! since that anchor. The watermark advances accordingly. In
//! production, where L1 events carry monotone real-time wallclocks,
//! this projection is always ≤ a legitimate future event's
//! wallclock_ms, so it never causes valid later events to appear
//! back-dated relative to the frontier.
//!
//! ## Lifecycle
//!
//! [`spawn_perception_worker`] returns
//! `(PerceptionWorker, FocusInputHandle, CurrentFocusedElementView)`.
//! Drop the handle (or all clones thereof) and call
//! `PerceptionWorker::shutdown(timeout)` to stop the thread. The view
//! handle (D1-3) is independent of the worker's lifetime — it remains
//! readable after shutdown but stops receiving updates.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError, TrySendError};
use serde::{Deserialize, Serialize};

use differential_dataflow::input::{Input, InputSession};

use crate::time::LogicalTime;
use crate::views::current_focused_element::{self, CurrentFocusedElementView};

/// Default per-worker command-channel capacity. Sized for UIA focus
/// rate (< 10 events/sec under human use); the bridge sleeps for at
/// most 100ms between recvs, so 8192 is roughly 13 minutes of
/// buffering — ample for D1.
const CMD_CHANNEL_CAPACITY: usize = 8192;

/// Default watermark shift in milliseconds. Override via
/// `DESKTOP_TOUCH_WATERMARK_SHIFT_MS` (clamped to <= 60_000).
const DEFAULT_WATERMARK_SHIFT_MS: u64 = 100;

/// Sentinel cap on the env-overridable watermark shift (1 minute).
const WATERMARK_SHIFT_MAX_MS: u64 = 60_000;

/// D2-A revised tuning: idle-branch `recv_timeout` window. With
/// `recv_timeout` instead of `try_recv` + sleep, the worker wakes
/// immediately on cmd arrival instead of waiting up to a full poll
/// interval. Override via `DESKTOP_TOUCH_IDLE_RECV_TIMEOUT_MS`.
const DEFAULT_IDLE_RECV_TIMEOUT_MS: u64 = 1;

/// D2-A: cap how many cmds a single iteration drains in one batch.
/// Larger batches amortise dataflow stepping over more events but
/// extend the latency of the first event in the batch. Override via
/// `DESKTOP_TOUCH_MAX_BATCH_SIZE`.
const DEFAULT_MAX_BATCH_SIZE: usize = 64;

/// D2-A: cap how many `worker.step()` calls run after a batch is
/// drained. Bounds worst-case time per cmd-loop iteration if the
/// dataflow operator chain produces unbounded follow-on activations.
/// Override via `DESKTOP_TOUCH_MAX_STEPS_PER_CMD`.
const DEFAULT_MAX_STEPS_PER_CMD: usize = 32;

/// A focus-changed event received from the root-side bridge.
///
/// All fields are pure Rust — no `windows-rs` types, no napi types.
///
/// **`source_event_id` is the L1 ring's `event_id`** (北極星 N1) and
/// must never be dropped on the L1→L3 path. It's the pivot every
/// downstream layer (envelope, causal trail, replay, WAL) uses to
/// trace back to the originating capture event.
///
/// `hwnd: 0` is a valid unresolved case (the focused UIA element has
/// no resolvable native window). Consumers must not crash on it.
///
/// `wallclock_ms` and `sub_ordinal` are **event-time as data**
/// (北極星 N2). They are NOT used as the timely frontier; the
/// frontier advances on a watermark derived from the latest seen
/// `wallclock_ms` minus a shift (see module docs). Out-of-order
/// events within the watermark window are accepted by the dataflow;
/// older events are dropped.
// `Eq + Ord + PartialOrd + Hash` are required by differential-dataflow's
// `Data` bound (used for arrangement keys / sort during compaction).
#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct FocusEvent {
    /// L1 `event_id` of the originating push (北極星 N1).
    pub source_event_id: u64,
    pub hwnd: u64,
    pub name: String,
    pub automation_id: Option<String>,
    /// Raw `UIA_CONTROLTYPE_ID` (e.g. `50000` = Button). The string
    /// mapping happens at the L4 envelope layer, not here.
    pub control_type: u32,
    pub window_title: String,
    pub wallclock_ms: u64,
    pub sub_ordinal: u32,
    /// L1 `TimestampSource` enum encoded as `u8` (StdTime=0, Dwm=1,
    /// Dxgi=2, Reflex=3). Preserved for replay / WAL (D6).
    pub timestamp_source: u8,
}

impl FocusEvent {
    /// Convenience: build the dataflow logical time for this event.
    /// Used by both the worker (for `update_at`) and tests.
    pub fn logical_time(&self) -> LogicalTime {
        LogicalTime::new(self.wallclock_ms, self.sub_ordinal)
    }
}

/// The seam through which the root-side bridge pushes decoded L1
/// events into this crate.
///
/// Each method takes `&self`, not `&mut self`, because the bridge
/// runs on a dedicated thread and the channel is concurrent-safe.
/// A trait object (`Arc<dyn L1Sink>`) is the expected transport —
/// handing the bridge a concrete type would force the root crate to
/// name `differential_dataflow::input::InputSession`, re-introducing
/// the dep direction we just rejected.
pub trait L1Sink: Send + Sync {
    /// Push a focus-changed event.
    fn push_focus(&self, event: FocusEvent);

    // P5c-2 / P5c-3 / P5c-4 will extend this trait with
    // `push_dirty_rect`, `push_window_change`, `push_scroll`. They
    // are deliberately omitted in P5c-0b/D1-2 to keep the contract
    // small until the corresponding L1 emitters exist.
}

/// Internal command sent from `FocusInputHandle` to the worker.
enum Cmd {
    PushFocus(FocusEvent),
    Shutdown,
    /// Test-only: block the worker thread for the given duration
    /// before processing the next cmd. Used by the production
    /// lifecycle's `shutdown_timeout_failure_*` regression tests
    /// to simulate a stuck worker (Codex v9 P2-17 retry-fail branch).
    /// Production code never sends this variant.
    ///
    /// `cfg(any(test, feature = "test-fixtures"))` so the root
    /// crate can drive the fixture from its own test suite via
    /// `FocusInputHandle::block_worker_for_test` (enabled with
    /// `engine-perception = { features = ["test-fixtures"] }` in
    /// the root crate's `[dev-dependencies]`).
    #[cfg(any(test, feature = "test-fixtures"))]
    BlockForTest(Duration),
}

/// Sender-side handle the bridge holds. Cloneable — multiple bridges
/// can share one worker (D2 may exploit this).
#[derive(Clone)]
pub struct FocusInputHandle {
    tx: Sender<Cmd>,
}

impl L1Sink for FocusInputHandle {
    fn push_focus(&self, event: FocusEvent) {
        // Failure modes:
        // - Channel disconnected (worker shut down): drop silently.
        //   The bridge's own metrics ring records that we tried.
        // - Channel full: blocks. Capacity 8192 vs UIA rate < 10/s
        //   means this should never happen in practice; if it did,
        //   blocking is correct (we'd lose ordering otherwise).
        let _ = self.tx.send(Cmd::PushFocus(event));
    }
}

impl FocusInputHandle {
    /// Test-only fixture (D2-A-0 / Codex v9 P2-17 OQ #15): queue a
    /// `BlockForTest` cmd that makes the worker sleep for the given
    /// duration before processing the next cmd. Used by the root
    /// crate's `production_pipeline_lifecycle_tests` to drive the
    /// stuck-worker scenario where `ensure_perception_pipeline()`'s
    /// poison-eviction retry must fail (worker unable to honor
    /// `Cmd::Shutdown` within the 100ms retry budget) so the test
    /// can verify the slot retains the poisoned `Arc` rather than
    /// spawning a duplicate worker.
    ///
    /// Enabled via the `test-fixtures` feature on this crate; the
    /// root crate's `[dev-dependencies]` selects it. Production
    /// builds never see this method.
    #[cfg(any(test, feature = "test-fixtures"))]
    pub fn block_worker_for_test(&self, duration: Duration) {
        let _ = self.tx.send(Cmd::BlockForTest(duration));
    }
}

/// Owner of the timely worker thread. Returned alongside the
/// `FocusInputHandle` from [`spawn_perception_worker`]. Drop or
/// `shutdown_with_timeout(&self, timeout)` to stop the thread; a
/// consume-form `shutdown(self, timeout)` is also kept for callers
/// that want to ensure the worker is gone before continuing.
///
/// ## Shutdown handle retain (D2-0 / Codex review v6 P1)
///
/// Earlier versions held `join: Option<JoinHandle<()>>` and consumed
/// the handle inside `shutdown(self, ...)`. That pattern is unsound
/// for the production lifecycle in `src/l3_bridge/mod.rs`: if the
/// pipeline-level shutdown failed (timeout) on one leg, the consumed
/// handle was lost and a subsequent retry could no-op while the
/// timed-out thread was still running, allowing
/// `ensure_perception_pipeline()` to spawn a duplicate worker.
///
/// We now mirror the L1 worker's safety contract
/// (`src/l1_capture/worker.rs:174-194`): the JoinHandle lives behind
/// a `Mutex<Option<JoinHandle<()>>>` and is only `take()`-ed once
/// `is_finished()` reports true. On timeout the handle is retained,
/// so a later `shutdown_with_timeout(longer)` can resume polling the
/// same thread.
pub struct PerceptionWorker {
    join: Mutex<Option<JoinHandle<()>>>,
    tx: Sender<Cmd>,
    /// Total `Cmd::PushFocus` commands the worker has dequeued and
    /// run through `InputSession::update_at` + `advance_to` +
    /// `flush()`. Exposed as a test/D2-metrics observation hook so
    /// the L1 → focus_pump → handle → worker round-trip can be
    /// asserted end-to-end (Codex review on PR #90 P2).
    processed_count: Arc<AtomicU64>,
}

impl PerceptionWorker {
    /// Number of `Cmd::PushFocus` commands the worker has fully
    /// processed (post-`flush()`). Available on the live worker so
    /// callers can wait for the InputSession path to drain before
    /// shutting down.
    pub fn processed_count(&self) -> u64 {
        self.processed_count.load(Ordering::Relaxed)
    }

    /// Signal shutdown and poll the worker's `JoinHandle::is_finished()`
    /// until the deadline. **The `JoinHandle` is retained on timeout**
    /// so a later `shutdown_with_timeout(longer)` can resume — this
    /// is the L1-worker-equivalent retain semantics
    /// (`src/l1_capture/worker.rs:174-194`, Codex review v6 P1).
    ///
    /// ## Two-phase shape
    ///
    /// **Phase 1 — deliver `Cmd::Shutdown`**: The cmd channel is
    /// `bounded(8192)`, so a blocking `send` would suspend this
    /// method **before the deadline is even computed** (Codex v7 P2).
    /// We use `try_send` instead, but a single `try_send` that hits
    /// `Full` would silently drop the signal — the worker would then
    /// keep waiting on the channel and `shutdown_with_timeout`
    /// would always Err even when a healthy worker would have drained
    /// the backlog and accepted the cmd (Codex v8 P2-15). So we
    /// retry `try_send` within the same deadline: every
    /// `poll_interval` we attempt to deliver the cmd, breaking out
    /// when the send succeeds, the channel disconnects, or the
    /// deadline expires.
    ///
    /// **Phase 2 — wait for the worker to exit**: Once the cmd is
    /// queued (or the deadline forces us forward without a delivered
    /// cmd), poll `JoinHandle::is_finished()`. This phase shares the
    /// same `deadline`, so the total wall-clock spent in both phases
    /// is bounded by `timeout`. On timeout, the `JoinHandle` is
    /// retained inside the `Mutex<Option<...>>` so a later
    /// `shutdown_with_timeout(longer)` resumes the same polling.
    pub fn shutdown_with_timeout(&self, timeout: Duration) -> Result<(), &'static str> {
        let deadline = Instant::now() + timeout;
        let poll_interval = Duration::from_millis(10);

        // ─── Phase 1: deliver Cmd::Shutdown to the cmd channel ──
        // `try_send` so a full channel does not block; retry inside
        // the same deadline so a transient pile-up doesn't cause
        // the call to time out unnecessarily (Codex v8 P2-15).
        loop {
            match self.tx.try_send(Cmd::Shutdown) {
                Ok(()) => break,
                Err(TrySendError::Disconnected(_)) => {
                    // Receiver gone — worker is already exiting / exited.
                    // Phase 2 will observe `is_finished()` shortly.
                    break;
                }
                Err(TrySendError::Full(_)) => {
                    if Instant::now() >= deadline {
                        // Deadline hit before the channel drained.
                        // Fall through to phase 2; if the worker has
                        // exited via a previously-queued shutdown or
                        // panic propagation, `is_finished()` will
                        // observe it. Otherwise we'll Err with the
                        // worker still running and the JoinHandle
                        // retained.
                        break;
                    }
                    thread::sleep(poll_interval);
                }
            }
        }

        // ─── Phase 2: poll for worker exit ──────────────────────
        loop {
            // Peek `is_finished()` while holding the guard, then
            // promote to take + join in the same critical section so
            // we don't race a concurrent caller.
            let finished_or_done = {
                let mut guard = self.join.lock().unwrap_or_else(|e| e.into_inner());
                match guard.as_ref() {
                    Some(h) if h.is_finished() => {
                        let h = guard.take().expect("just observed Some");
                        let _ = h.join();
                        true
                    }
                    Some(_) => false,
                    None => true, // already shut down
                }
            };
            if finished_or_done {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("perception worker join timed out");
            }
            thread::sleep(poll_interval);
        }
    }

    /// Consume-form shutdown for callers that want the worker to be
    /// gone after this returns. Delegates to
    /// `shutdown_with_timeout(&self, ...)`. On `Err` the worker is
    /// dropped, but its underlying thread continues until it sees
    /// `Cmd::Shutdown` (already sent) or the cmd channel closes.
    pub fn shutdown(self, timeout: Duration) -> Result<(), &'static str> {
        self.shutdown_with_timeout(timeout)
    }
}

impl Drop for PerceptionWorker {
    fn drop(&mut self) {
        // Best-effort: signal shutdown. Don't block in Drop —
        // try_send keeps Drop bounded even if the cmd channel is
        // full or already disconnected (Codex v7 P2 / Drop must
        // not stall on a degenerate state).
        let _ = self.tx.try_send(Cmd::Shutdown);
        let handle_opt = self
            .join
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(h) = handle_opt {
            // Best-effort join, don't block forever.
            let deadline = Instant::now() + Duration::from_secs(2);
            while !h.is_finished() {
                if Instant::now() >= deadline {
                    // Detach: thread will exit when cmd channel
                    // closes (Sender drop on this struct's death).
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            let _ = h.join();
        }
    }
}

/// Read the watermark shift override from the env, clamped to
/// `[0, WATERMARK_SHIFT_MAX_MS]`. Fall back to default 100ms when
/// the var is absent or unparseable.
///
/// Codex PR #90 P2: an earlier version used `.filter(|n| n <= MAX)`
/// which falls back to the **default** on overflow. For an env value
/// like `120000` that meant the user intended a long watermark (more
/// out-of-order tolerance) but actually got 100ms (very strict),
/// dropping events they expected to keep. The fix saturates at MAX
/// instead.
fn watermark_shift_ms() -> u64 {
    std::env::var("DESKTOP_TOUCH_WATERMARK_SHIFT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .map(|n| n.min(WATERMARK_SHIFT_MAX_MS))
        .unwrap_or(DEFAULT_WATERMARK_SHIFT_MS)
}

fn watermark_for(latest_wallclock_ms: u64, shift_ms: u64) -> LogicalTime {
    LogicalTime::new(latest_wallclock_ms.saturating_sub(shift_ms), 0)
}

fn idle_recv_timeout_ms() -> u64 {
    // Reject 0 (Codex v11 P3): a Duration::ZERO recv_timeout would
    // make the idle branch a busy loop hammering worker.step()
    // without any sleep, pinning a CPU core. The other env knobs
    // (max_batch_size / max_steps_per_cmd) already filter > 0; this
    // matches.
    std::env::var("DESKTOP_TOUCH_IDLE_RECV_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_IDLE_RECV_TIMEOUT_MS)
}

fn max_batch_size() -> usize {
    std::env::var("DESKTOP_TOUCH_MAX_BATCH_SIZE")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_MAX_BATCH_SIZE)
}

fn max_steps_per_cmd() -> usize {
    std::env::var("DESKTOP_TOUCH_MAX_STEPS_PER_CMD")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_MAX_STEPS_PER_CMD)
}

/// Spawn the timely worker thread + return a triple
/// `(PerceptionWorker, FocusInputHandle, CurrentFocusedElementView)`.
///
/// The worker owns the `differential_dataflow::input::InputSession`
/// and the dataflow graph; the handle is the bridge's seam
/// (`Arc::new(handle): Arc<dyn L1Sink>`); the view is the read-only
/// reader-side of the `current_focused_element` materialised state
/// (D1-3). The view handle is created on the parent thread and cloned
/// into the worker so the dataflow's inspect callback can write to it.
pub fn spawn_perception_worker(
) -> (PerceptionWorker, FocusInputHandle, CurrentFocusedElementView) {
    let (tx, rx) = bounded::<Cmd>(CMD_CHANNEL_CAPACITY);
    let processed_count = Arc::new(AtomicU64::new(0));
    let processed_clone = Arc::clone(&processed_count);

    let view = CurrentFocusedElementView::new();
    let view_for_worker = view.clone();

    let join = thread::Builder::new()
        .name("l3-perception".into())
        .spawn(move || worker_loop(rx, processed_clone, view_for_worker))
        .expect("spawn l3-perception thread");

    let worker = PerceptionWorker {
        join: Mutex::new(Some(join)),
        tx: tx.clone(),
        processed_count,
    };
    let handle = FocusInputHandle { tx };
    (worker, handle, view)
}

/// Body of the timely worker thread (D2-A revised tuning).
///
/// Runs `timely::execute_directly` with a single-thread allocator;
/// the worker pumps the cmd channel until `Cmd::Shutdown`. After the
/// closure returns, `execute_directly` drains remaining work before
/// the function returns.
///
/// ## Why D2-A revised tuning (vs D1's `try_recv` + 1ms sleep)
///
/// PR #92 D1-5 measurement showed `view_update_latency` p99 ~4.7 ms
/// — over the SLO `p99 < 1 ms` from `docs/views-catalog.md` §3.1.
/// Three contributing factors all on the critical path:
///
///   1. `thread::sleep(1ms)` in the `Empty` arm: cmd-arrival
///      detection takes up to 1 ms, dataflow steps interleaved with it.
///   2. DD operator chain propagation needs 2-3 `worker.step()` calls
///      (input → map → reduce → inspect). With sleeps between them
///      they accumulate.
///   3. Cmd-branch `advance_to(watermark)` puts the frontier **at**
///      event_time, not past it — DD reduce can't finalise the new
///      row's diff until the idle-advance projects past it. The
///      post-cmd Empty branch is therefore also on the critical path.
///
/// ## D2-A fix (Codex review v8 P2-15 / `docs/adr-008-d2-plan.md` §4.2)
///
/// Two changes that preserve N3 partial-order while collapsing latency:
///
///   - **`recv_timeout(idle_recv_timeout)` instead of `try_recv` +
///     sleep**: the worker wakes immediately when a cmd arrives. The
///     `Empty` branch's idle-frontier-advance work moves into a
///     timeout-driven path that runs only when the channel is genuinely
///     idle.
///   - **Batch drain + max-observed time release**: each loop
///     iteration takes the first cmd via `recv_timeout`, then drains
///     the channel non-blockingly up to `MAX_BATCH_SIZE`. After all
///     cmds in the batch have called `update_at`, advance the frontier
///     to `(max_observed_wallclock_ms, max_observed_sub_ordinal + 1)`
///     — i.e. one tick past the latest event, NOT to a `wc + ε` for
///     some arbitrary ε. This preserves N3: a later same-`wallclock_ms`
///     event with a higher `sub_ordinal` is still accepted because the
///     frontier only advances past the observed `(wc, sub_ord)` pair.
///     A genuine stale (smaller `wc` or smaller `sub_ord` at same
///     `wc`) gets dropped per the existing watermark-shift logic.
///   - **`step_until_idle` after the batch**: drain the operator
///     chain in one go (capped at `MAX_STEPS_PER_CMD`) instead of
///     stepping once per loop iteration with a sleep between.
///
/// `event_count` guards (3): if the batch contained only `Shutdown`
/// (or a `BlockForTest` in tests), we skip `advance_to` / `flush` /
/// `step` / `processed_count` increment. Without this guard a
/// shutdown-only batch would advance the frontier past spurious data
/// and bump the processed counter.
///
/// ## Idle-branch frontier advance (PR #91 P2 retained, refactored)
///
/// When `recv_timeout` returns `Err(Timeout)`, project
/// `latest_wallclock_ms` forward by real elapsed since the last event
/// anchor and advance the watermark accordingly. Same semantics as D1
/// — a quiescent focus still gets materialised — just driven by the
/// `recv_timeout` cycle instead of `try_recv` + `sleep`.
fn worker_loop(
    rx: Receiver<Cmd>,
    processed: Arc<AtomicU64>,
    view: CurrentFocusedElementView,
) {
    let shift_ms = watermark_shift_ms();
    let idle_timeout = Duration::from_millis(idle_recv_timeout_ms());
    let batch_cap = max_batch_size();
    let step_cap = max_steps_per_cmd();

    // `less_equal` for the LogicalTime guard / watermark advance is
    // provided by `timely::order::PartialOrder`. Bring it into scope
    // for both the cmd path and the idle-advance branch.
    use timely::order::PartialOrder;

    timely::execute_directly(move |worker| {
        // D1-3: build the dataflow with the input collection +
        // `current_focused_element` view wired in. The InputSession
        // returned out of the closure is the seam through which the
        // cmd loop below feeds events.
        let mut input: InputSession<LogicalTime, FocusEvent, isize> =
            worker.dataflow::<LogicalTime, _, _>(|scope| {
                let (input, stream) = scope.new_collection::<FocusEvent, isize>();
                current_focused_element::build(stream, view.clone());
                input
            });

        let mut latest_wallclock_ms: u64 = 0;
        let mut current_watermark: LogicalTime = LogicalTime::new(0, 0);
        let mut last_event_anchor: Option<(u64, Instant)> = None;

        'outer: loop {
            // ─── Phase 1: take the first cmd (recv_timeout) ────
            // recv_timeout wakes us up the instant a cmd arrives —
            // the D1 try_recv + sleep(1ms) had a worst-case 1ms
            // wait per cmd. On Timeout we fall through to the idle
            // frontier-advance branch.
            let mut batch: Vec<Cmd> = Vec::with_capacity(batch_cap.min(16));
            let mut shutdown_requested = false;

            match rx.recv_timeout(idle_timeout) {
                Ok(cmd) => batch.push(cmd),
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                    // Idle frontier advance (PR #91 P2 semantics).
                    if let Some((anchor_wc, anchor_inst)) = last_event_anchor {
                        let elapsed = anchor_inst.elapsed().as_millis() as u64;
                        let projected = anchor_wc.saturating_add(elapsed);
                        if projected > latest_wallclock_ms {
                            latest_wallclock_ms = projected;
                            let new_wm = watermark_for(latest_wallclock_ms, shift_ms);
                            if current_watermark.less_equal(&new_wm)
                                && current_watermark != new_wm
                            {
                                current_watermark = new_wm.clone();
                                input.advance_to(new_wm);
                                input.flush();
                            }
                        }
                    }
                    worker.step();
                    continue 'outer;
                }
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break 'outer,
            }

            // ─── Phase 2: non-blocking drain up to batch_cap ───
            while batch.len() < batch_cap {
                match rx.try_recv() {
                    Ok(cmd) => batch.push(cmd),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        // Worker is shutting down — process what's in
                        // the batch then exit.
                        shutdown_requested = true;
                        break;
                    }
                }
            }

            // ─── Phase 3: apply each PushFocus, track max time ──
            let mut event_count: u64 = 0;
            let mut max_observed: Option<LogicalTime> = None;

            for cmd in batch.drain(..) {
                match cmd {
                    Cmd::PushFocus(ev) => {
                        let event_time = ev.logical_time();

                        // N3 partial-order guard: DD asserts
                        // session_time <= update time. The watermark
                        // is the session_time. Out-of-order events
                        // older than the frontier are dropped; same
                        // `wc` with larger `sub_ord` is still <= the
                        // frontier-of-events (the frontier we advance
                        // to is `(max_wc, max_sub_ord + 1)`, so an
                        // earlier-batch event at the same `wc` with a
                        // larger `sub_ord` is accepted within the
                        // batch — only across-batch back-dated events
                        // are dropped).
                        if !current_watermark.less_equal(&event_time) {
                            eprintln!(
                                "[perception-worker] out-of-order event dropped: \
                                 event_time={:?} watermark={:?} source_event_id={}",
                                event_time, current_watermark, ev.source_event_id
                            );
                            continue;
                        }
                        input.update_at(ev.clone(), event_time.clone(), 1);
                        event_count += 1;

                        // Update anchor for idle frontier advance —
                        // only when wallclock genuinely advances, so
                        // a flurry of same-`wc` events doesn't reset
                        // the anchor's `Instant::now()` and stretch
                        // the projected idle-time forward gauge.
                        if ev.wallclock_ms > latest_wallclock_ms {
                            latest_wallclock_ms = ev.wallclock_ms;
                            last_event_anchor = Some((ev.wallclock_ms, Instant::now()));
                        }

                        // Track the per-batch max event_time so the
                        // frontier can be moved past it after the
                        // batch is committed.
                        max_observed = Some(match max_observed {
                            None => event_time,
                            Some(prev) if prev.less_equal(&event_time) => event_time,
                            Some(prev) => prev,
                        });
                    }
                    Cmd::Shutdown => {
                        shutdown_requested = true;
                    }
                    #[cfg(any(test, feature = "test-fixtures"))]
                    Cmd::BlockForTest(d) => {
                        // Test-only stuck-worker fixture (Codex v9
                        // P2-17 retry-fail branch regression). Sleep
                        // synchronously so subsequent shutdown
                        // signals queue but cannot be acted on until
                        // the duration elapses.
                        thread::sleep(d);
                    }
                }
            }

            // ─── Phase 4: advance frontier + flush + step ──────
            // event_count guard (Codex v6 P2-8 + D2-A invariant 7):
            // a Shutdown-only / BlockForTest-only batch does NOT
            // advance the frontier or bump processed_count.
            if event_count > 0 {
                // **N2 watermark-shift contract** (Codex v10 P2):
                // advance the frontier to `max_wc - shift_ms`, NOT
                // `max_wc + 1 sub_ord`. The earlier "+1 sub_ord"
                // shape released the just-pushed event immediately,
                // which was great for view_update_latency but
                // *broke* the documented promise that out-of-order
                // events within `DESKTOP_TOUCH_WATERMARK_SHIFT_MS`
                // are accepted across batches: a later event at
                // (wc - 50ms) would be back-dated relative to the
                // already-advanced frontier and dropped, even though
                // it falls inside the shift window.
                //
                // The integration test
                // `multiple_hwnds_tracked_independently` documents
                // this contract by using a "pump" focus event whose
                // wallclock advances the frontier *past* the
                // earlier events but is itself NOT released (it sits
                // above the frontier). The "+1 sub_ord" shape
                // released the pump event too, growing the snapshot
                // to 4 entries instead of 3 (Codex v10 P1).
                //
                // Restoring `max_wc - shift_ms` here matches D1's
                // watermark behaviour. The latency improvement
                // versus D1 still comes from (a) batch-drain
                // amortising operator-chain steps over multiple
                // events and (b) `step_until_idle` collapsing the
                // sleep-between-steps overhead. Releasing the
                // just-committed event itself is left to the idle-
                // advance branch as in D1, preserving N2.
                if let Some(target) = max_observed {
                    let new_wm = watermark_for(target.first, shift_ms);
                    if current_watermark.less_equal(&new_wm)
                        && current_watermark != new_wm
                    {
                        current_watermark = new_wm.clone();
                        input.advance_to(new_wm);
                    }
                }
                input.flush();
                processed.fetch_add(event_count, Ordering::Relaxed);

                // Step until idle (capped) so the operator chain
                // makes progress on whatever the new watermark
                // released. Newly-pushed events at the watermark
                // edge are released by the idle-advance branch a
                // few `recv_timeout` cycles later.
                let mut steps = 0;
                while steps < step_cap {
                    if !worker.step() {
                        break;
                    }
                    steps += 1;
                }
            }

            if shutdown_requested {
                break 'outer;
            }
        }

        // Closure returns; `execute_directly` drains the remaining
        // dataflow before this thread exits.
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_event(source_event_id: u64, wallclock_ms: u64, sub_ordinal: u32) -> FocusEvent {
        FocusEvent {
            source_event_id,
            hwnd: 0x1234,
            name: "test".into(),
            automation_id: Some("auto-id".into()),
            control_type: 50000,
            window_title: "Test Window".into(),
            wallclock_ms,
            sub_ordinal,
            timestamp_source: 0,
        }
    }

    #[test]
    fn spawn_and_shutdown_clean() {
        let (worker, _handle, _view) = spawn_perception_worker();
        worker
            .shutdown(Duration::from_secs(2))
            .expect("shutdown clean");
    }

    #[test]
    fn push_focus_roundtrip_smoke() {
        let (worker, handle, _view) = spawn_perception_worker();
        for i in 0..3 {
            handle.push_focus(make_event(i, 1_000_000 + i, 0));
        }
        worker
            .shutdown(Duration::from_secs(2))
            .expect("shutdown after push");
    }

    #[test]
    fn processed_count_reflects_pushes() {
        // Codex PR #90 P2: confirm the worker actually consumes
        // Cmd::PushFocus from the channel, not just acknowledges
        // shutdown. Without this assertion the lifecycle test
        // could regress silently if the worker_loop body is gutted.
        let (worker, handle, _view) = spawn_perception_worker();
        for i in 0..5 {
            handle.push_focus(make_event(i, 5_000_000 + i, 0));
        }
        // Wait for the worker to drain its queue.
        let deadline = Instant::now() + Duration::from_millis(500);
        while worker.processed_count() < 5 {
            if Instant::now() >= deadline {
                panic!(
                    "worker did not process all 5 pushes: processed_count={}",
                    worker.processed_count()
                );
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(worker.processed_count(), 5);
        worker.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn five_cycle_spawn_shutdown() {
        for cycle in 0..5 {
            let (worker, handle, _view) = spawn_perception_worker();
            handle.push_focus(make_event(cycle, 2_000_000 + cycle, 0));
            worker
                .shutdown(Duration::from_secs(2))
                .unwrap_or_else(|e| panic!("cycle {} shutdown failed: {}", cycle, e));
        }
    }

    #[test]
    fn push_after_shutdown_silently_drops() {
        let (worker, handle, _view) = spawn_perception_worker();
        worker.shutdown(Duration::from_secs(2)).expect("shutdown");
        // After worker is gone, the receiver is dropped and the
        // channel disconnects. push_focus must NOT panic.
        handle.push_focus(make_event(99, 3_000_000, 0));
    }

    #[test]
    fn l1sink_object_safety() {
        // Trait must be object-safe so the bridge can hold
        // `Arc<dyn L1Sink>` without naming the concrete type.
        let (worker, handle, _view) = spawn_perception_worker();
        let _h: Arc<dyn L1Sink> = Arc::new(handle);
        worker.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn focus_event_carries_source_event_id_and_timestamp_source() {
        // Round-trip the data fields the bridge promises to preserve
        // (北極星 N1). We can't observe them inside the dataflow
        // without a view (D1-3), but we can construct + clone +
        // logical_time() and verify shape.
        let mut ev = make_event(12345, 1_700_000_000_000, 7);
        ev.timestamp_source = 2; // Dxgi
        assert_eq!(ev.source_event_id, 12345);
        assert_eq!(ev.timestamp_source, 2);
        let lt = ev.logical_time();
        assert_eq!(lt.first, 1_700_000_000_000);
        assert_eq!(lt.second, 7);

        // Clone preserves both fields.
        let ev2 = ev.clone();
        assert_eq!(ev2.source_event_id, ev.source_event_id);
        assert_eq!(ev2.timestamp_source, ev.timestamp_source);
    }

    #[test]
    fn watermark_within_shift_accepted() {
        // event_time = (T - 50ms, 0) when latest = T, shift = 100ms
        // → watermark = (T - 100ms, 0), and event_time >= watermark
        // → accepted (no out-of-order log expected).
        //
        // We can't observe the dataflow output yet (D1-3), but we
        // can confirm the worker doesn't crash on a back-dated push.
        let (worker, handle, _view) = spawn_perception_worker();
        // First push sets latest_wallclock_ms = 1_000_000
        handle.push_focus(make_event(1, 1_000_000, 0));
        // Sleep so the worker definitely processed the first push
        thread::sleep(Duration::from_millis(50));
        // Second push is 50ms back-dated — within the 100ms watermark
        handle.push_focus(make_event(2, 1_000_000 - 50, 0));
        // Third push extends the frontier
        handle.push_focus(make_event(3, 1_000_500, 0));
        worker.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn idle_advance_progresses_latest_wallclock() {
        // PR #91 P2 regression: a single push followed by quiescent
        // input must still cause the worker to project
        // `latest_wallclock_ms` forward and advance the watermark via
        // the idle branch. We can't observe the watermark directly,
        // but the view (D1-3) reflects whether the event was released
        // — see the integration counterpart
        // `quiescent_focus_eventually_materialises`. This in-file
        // test pins the *cmd path* (not the view): one push, no
        // shutdown signal, and we wait for the worker to drain the
        // single Cmd::PushFocus from the channel. Without idle
        // progression the worker would still drain (cmd channel work
        // is independent of frontier), so this test only guards
        // against a regression that breaks the idle branch entirely
        // (e.g. an early `break` or a panic in the projection code).
        let (worker, handle, _view) = spawn_perception_worker();
        handle.push_focus(make_event(1, 1_700_000_000_000, 0));
        let deadline = Instant::now() + Duration::from_millis(500);
        while worker.processed_count() < 1 {
            if Instant::now() >= deadline {
                panic!(
                    "worker did not process the single push: processed_count={}",
                    worker.processed_count()
                );
            }
            thread::sleep(Duration::from_millis(5));
        }
        // Allow at least 150ms of idle so the projection runs many
        // times. The worker must remain healthy throughout.
        thread::sleep(Duration::from_millis(150));
        assert_eq!(worker.processed_count(), 1, "no spurious processing");
        worker
            .shutdown(Duration::from_secs(2))
            .expect("shutdown after idle");
    }

    #[test]
    fn watermark_exceeding_shift_dropped() {
        // event_time = (T - 500ms, 0) when latest = T, shift = 100ms
        // → watermark = (T - 100ms, 0), and event_time < watermark
        // → dropped with log. Test verifies the worker survives.
        let (worker, handle, _view) = spawn_perception_worker();
        handle.push_focus(make_event(1, 2_000_000, 0));
        thread::sleep(Duration::from_millis(50));
        // 500ms back-dated — way outside the 100ms watermark default
        handle.push_focus(make_event(2, 2_000_000 - 500, 0));
        // Worker must still be alive
        handle.push_focus(make_event(3, 2_000_500, 0));
        worker.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    // ─── D2-A revised tuning: partial-order tests ─────────────
    //
    // Pin the four invariants in `docs/adr-008-d2-plan.md` §4.3:
    //   - same-wc, larger-sub_ord events in a single batch are
    //     accepted (frontier moves only past max-observed).
    //   - out-of-order arrival within a batch settles to the
    //     latest-by-(wc, sub_ord) row.
    //   - across-batch back-dated events (smaller wc) are dropped,
    //     not panicked.
    //   - idle-advance after a cmd-batch advance is monotone.

    fn make_focus_event_at(
        source_event_id: u64,
        wallclock_ms: u64,
        sub_ordinal: u32,
        hwnd: u64,
        name: &str,
    ) -> FocusEvent {
        FocusEvent {
            source_event_id,
            hwnd,
            name: name.into(),
            automation_id: None,
            control_type: 50000,
            window_title: "PartialOrderTest".into(),
            wallclock_ms,
            sub_ordinal,
            timestamp_source: 0,
        }
    }

    #[test]
    fn same_wallclock_different_sub_ordinal_all_observed() {
        // Three events at (W, 0), (W, 1), (W, 2) on the same hwnd.
        // The view's reduce(last-by-time) keeps the latest, so we
        // expect the (W, 2) name to win. The point of this test is
        // that the D2-A frontier-advance logic (advance to (max_wc,
        // max_sub_ord + 1)) does not drop the larger-sub_ord events
        // as back-dated.
        use crate::views::current_focused_element::CurrentFocusedElementView;
        let (worker, handle, view) = spawn_perception_worker();
        let _: &CurrentFocusedElementView = &view; // type assertion

        // wallclock far enough from 0 that the watermark shift
        // doesn't drop them.
        let w = 1_700_000_000_000_u64;
        let h = 0xA001;

        for sub in 0..3u32 {
            handle.push_focus(make_focus_event_at(
                sub as u64,
                w,
                sub,
                h,
                &format!("name-{}", sub),
            ));
        }

        // Wait for the worker to process all 3.
        let deadline = Instant::now() + Duration::from_millis(500);
        while worker.processed_count() < 3 {
            if Instant::now() >= deadline {
                panic!(
                    "worker did not process all 3 events: processed_count={}",
                    worker.processed_count()
                );
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(worker.processed_count(), 3, "all 3 events accepted");

        // After idle advance settles the frontier, the view should
        // have the latest name for the hwnd.
        let view_clone = view.clone();
        let view_deadline = Instant::now() + Duration::from_millis(500);
        loop {
            if let Some(el) = view_clone.get(h) {
                if el.name == "name-2" {
                    break;
                }
            }
            if Instant::now() >= view_deadline {
                panic!(
                    "view did not settle to name-2: got {:?}",
                    view_clone.get(h).map(|e| e.name.clone())
                );
            }
            thread::sleep(Duration::from_millis(5));
        }

        worker.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn out_of_order_same_wallclock_settles_correctly() {
        // Push (W, 2) first, then (W, 1), then (W, 0) — reverse
        // order of sub_ordinal. The view's last-by-time semantics
        // should still return (W, 2) — the largest LogicalTime
        // wins regardless of arrival order. This is the partial-
        // order acceptance test (北極星 N3).
        use crate::views::current_focused_element::CurrentFocusedElementView;
        let (worker, handle, view) = spawn_perception_worker();
        let _: &CurrentFocusedElementView = &view;

        let w = 1_700_000_500_000_u64;
        let h = 0xA002;

        // Reverse-order push.
        for sub in (0..3u32).rev() {
            handle.push_focus(make_focus_event_at(
                sub as u64,
                w,
                sub,
                h,
                &format!("name-{}", sub),
            ));
        }

        let deadline = Instant::now() + Duration::from_millis(500);
        while worker.processed_count() < 3 {
            if Instant::now() >= deadline {
                panic!(
                    "worker did not process all 3 reverse-order events: processed_count={}",
                    worker.processed_count()
                );
            }
            thread::sleep(Duration::from_millis(5));
        }

        let view_clone = view.clone();
        let view_deadline = Instant::now() + Duration::from_millis(500);
        loop {
            if let Some(el) = view_clone.get(h) {
                if el.name == "name-2" {
                    break;
                }
            }
            if Instant::now() >= view_deadline {
                panic!(
                    "reverse-order push did not settle to name-2: got {:?}",
                    view_clone.get(h).map(|e| e.name.clone())
                );
            }
            thread::sleep(Duration::from_millis(5));
        }

        worker.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn cmd_branch_does_not_back_advance_frontier() {
        // Push a far-future event (wc = T2) to advance the
        // frontier, then push an old event (wc = T1, T1 < T2 - 100ms
        // shift). The old event must be dropped (eprintln only),
        // and the worker must remain healthy.
        let (worker, handle, _view) = spawn_perception_worker();

        // T2 = 2_000_000, T1 = 2_000_000 - 500 (way past the 100ms
        // default shift, so the watermark guard rejects it).
        handle.push_focus(make_focus_event_at(1, 2_000_000, 0, 0xB001, "future"));
        thread::sleep(Duration::from_millis(50));
        handle.push_focus(make_focus_event_at(2, 2_000_000 - 500, 0, 0xB001, "stale"));
        // Worker must still be alive — push a third event to confirm.
        handle.push_focus(make_focus_event_at(3, 2_000_500, 0, 0xB001, "after-stale"));

        // processed_count counts all PushFocus that the worker
        // dequeued, but the stale one is dropped before
        // `update_at` (count not bumped). We expect 2 (future +
        // after-stale).
        let deadline = Instant::now() + Duration::from_millis(500);
        while worker.processed_count() < 2 {
            if Instant::now() >= deadline {
                panic!(
                    "worker did not process the two non-stale events: processed_count={}",
                    worker.processed_count()
                );
            }
            thread::sleep(Duration::from_millis(5));
        }

        worker.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn idle_advance_after_cmd_push_is_monotone() {
        // Push one event, let the idle branch run for several
        // cycles. The idle frontier-advance must never roll back
        // the watermark; we observe this indirectly by verifying
        // the worker remains healthy and processed_count stays at 1
        // (no spurious additional processing).
        let (worker, handle, _view) = spawn_perception_worker();

        handle.push_focus(make_focus_event_at(1, 1_800_000_000_000, 0, 0xB002, "anchor"));

        // Wait for the single push to be processed.
        let deadline = Instant::now() + Duration::from_millis(500);
        while worker.processed_count() < 1 {
            if Instant::now() >= deadline {
                panic!(
                    "worker did not process the anchor: processed_count={}",
                    worker.processed_count()
                );
            }
            thread::sleep(Duration::from_millis(5));
        }
        // Allow the idle-advance branch many cycles. Under monotone
        // semantics processed_count must not change.
        thread::sleep(Duration::from_millis(150));
        assert_eq!(
            worker.processed_count(),
            1,
            "idle branch must not spuriously process events"
        );

        worker.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn shutdown_only_batch_does_not_advance_frontier() {
        // Codex review v6 P2-8 invariant 7 (D2-A): a batch
        // containing only `Cmd::Shutdown` must NOT call
        // advance_to / flush / processed_count.fetch_add.
        // We can't observe the frontier directly from here, but
        // processed_count is a clean proxy: spawn-and-shutdown
        // without any PushFocus must leave processed_count = 0.
        let (worker, _handle, _view) = spawn_perception_worker();
        // No pushes — straight to shutdown. The shutdown signal
        // arrives as a single Shutdown-only batch.
        let pre_shutdown_count = worker.processed_count();
        assert_eq!(pre_shutdown_count, 0, "no pushes → no processing");
        worker.shutdown(Duration::from_secs(2)).expect("shutdown");
        // Implicit: if we got here without panic, advance_to wasn't
        // called on a (0, 1) frontier with no events queued.
    }

    // ─── End partial-order tests ──────────────────────────────

    #[test]
    fn shutdown_with_timeout_retries_send_when_channel_drains() {
        // Codex review v8 P2-15 regression: a single `try_send` that
        // hits `Full` would silently drop the shutdown signal, and
        // a healthy worker that subsequently drains its backlog
        // would never receive a Cmd::Shutdown — the shutdown call
        // would Err on timeout even though it could have succeeded.
        //
        // The fix is to retry `try_send` inside the same deadline.
        // This test pre-fills a cap-1 channel with a `PushFocus`,
        // spawns a worker that drains it after a short delay and
        // then waits for `Cmd::Shutdown`, and confirms
        // `shutdown_with_timeout` succeeds within the deadline (not
        // Err) — i.e. the retry loop delivered the cmd once the
        // channel had room.
        use crossbeam_channel::bounded;

        let (tx, rx) = bounded::<Cmd>(1);
        // Pre-fill so the first try_send by shutdown_with_timeout sees Full.
        tx.try_send(Cmd::PushFocus(make_event(0, 0, 0)))
            .expect("first try_send fits");

        // Worker: drain the pre-filled cmd after 50ms (gives us a
        // window where the channel is full while
        // shutdown_with_timeout is retrying), then wait for Shutdown.
        let join = thread::Builder::new()
            .name("test-draining-worker".into())
            .spawn(move || {
                thread::sleep(Duration::from_millis(50));
                let _ = rx.try_recv(); // drain pre-fill
                loop {
                    match rx.recv_timeout(Duration::from_millis(100)) {
                        Ok(Cmd::Shutdown) => return,
                        Ok(_) => continue,
                        Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                        Err(crossbeam_channel::RecvTimeoutError::Disconnected) => return,
                    }
                }
            })
            .expect("spawn test draining worker");

        let worker = PerceptionWorker {
            join: Mutex::new(Some(join)),
            tx,
            processed_count: Arc::new(AtomicU64::new(0)),
        };

        // Generous timeout: the worker drains after 50ms, then we
        // need 1 retry cycle (10ms poll_interval) to deliver the
        // shutdown, and one more cycle to observe is_finished().
        // 2 seconds is comfortably above. Under the bug (single
        // try_send), this would Err with the worker still alive.
        let start = Instant::now();
        let result = worker.shutdown_with_timeout(Duration::from_secs(2));
        let elapsed = start.elapsed();

        assert!(
            result.is_ok(),
            "retry loop must deliver Cmd::Shutdown after channel drains (got {:?}, elapsed {:?})",
            result,
            elapsed
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "shutdown should complete well before deadline once channel drains (took {:?})",
            elapsed
        );
    }

    #[test]
    fn shutdown_with_timeout_does_not_block_on_full_channel() {
        // Codex review v7 P2 regression: `shutdown_with_timeout` must
        // not block on `Sender::send` when the cmd channel is full.
        // The fix is `try_send`. This test pins the behaviour:
        //
        //   1. Build a `PerceptionWorker` whose cmd channel has
        //      capacity 1.
        //   2. Pre-fill the channel with a sentinel so any further
        //      send would block.
        //   3. Spawn a dummy "worker" thread that holds the receiver
        //      end so the channel stays connected and never drains
        //      (simulating a stuck worker_loop / panicked worker).
        //   4. Call `shutdown_with_timeout(50ms)` and measure the
        //      elapsed time.
        //   5. Assert the call returned `Err` (timeout) and finished
        //      within ~5x the deadline. With the bug (`send` instead
        //      of `try_send`) this would block indefinitely on the
        //      full channel before even computing the deadline; the
        //      test would hang and eventually time out at the cargo
        //      test level.
        use crossbeam_channel::bounded;

        let (tx, rx) = bounded::<Cmd>(1);
        // Pre-fill channel — any further send would block.
        tx.try_send(Cmd::Shutdown).expect("first try_send fits");

        // Dummy worker: holds `rx` so the channel stays connected,
        // never drains. This simulates a stuck / panicked worker
        // that ignores Cmd::Shutdown.
        let join = thread::Builder::new()
            .name("test-stuck-worker".into())
            .spawn(move || {
                // Hold rx for longer than the test's deadline so
                // Disconnected can't unblock the assertion.
                let _rx_held = rx;
                thread::sleep(Duration::from_secs(3));
            })
            .expect("spawn test stuck worker");

        let worker = PerceptionWorker {
            join: Mutex::new(Some(join)),
            tx,
            processed_count: Arc::new(AtomicU64::new(0)),
        };

        let start = Instant::now();
        let result = worker.shutdown_with_timeout(Duration::from_millis(50));
        let elapsed = start.elapsed();

        assert!(
            result.is_err(),
            "stuck worker + full channel must produce timeout Err, got {:?}",
            result
        );
        // Deadline 50ms + poll interval 10ms + scheduler slack. If
        // the bug (`send` instead of `try_send`) regresses, the call
        // would block on the full channel for the full 3-second
        // dummy-worker sleep before even starting the deadline, so a
        // 500ms ceiling is comfortably above the correct path and
        // well below the failure mode.
        assert!(
            elapsed < Duration::from_millis(500),
            "shutdown_with_timeout must respect deadline despite full channel \
             (took {:?}; would block indefinitely under the v6 send-vs-try_send bug)",
            elapsed
        );
    }

    #[test]
    fn watermark_shift_env_override() {
        // Smoke that the env hook is wired (no full dataflow
        // assertion, just that read-side returns the override).
        // SAFETY: this test mutates a process-global env var. The
        // var name is specific to this crate and no other test in
        // engine-perception reads it; cargo's parallel test runner
        // could in theory race here, but the var is not observed by
        // any other test in this crate.
        unsafe {
            std::env::set_var("DESKTOP_TOUCH_WATERMARK_SHIFT_MS", "250");
        }
        assert_eq!(watermark_shift_ms(), 250);

        // Codex PR #90 P2: oversized values must clamp to MAX, not
        // fall back to the default (which would be the **opposite**
        // of what the user wrote — a much smaller window).
        unsafe {
            std::env::set_var("DESKTOP_TOUCH_WATERMARK_SHIFT_MS", "120000"); // > MAX
        }
        assert_eq!(
            watermark_shift_ms(),
            WATERMARK_SHIFT_MAX_MS,
            "oversized env must saturate to WATERMARK_SHIFT_MAX_MS, not default"
        );

        unsafe {
            std::env::set_var("DESKTOP_TOUCH_WATERMARK_SHIFT_MS", "not_a_number");
        }
        assert_eq!(
            watermark_shift_ms(),
            DEFAULT_WATERMARK_SHIFT_MS,
            "unparseable env falls back to default"
        );

        unsafe {
            std::env::remove_var("DESKTOP_TOUCH_WATERMARK_SHIFT_MS");
        }
        assert_eq!(watermark_shift_ms(), DEFAULT_WATERMARK_SHIFT_MS);
    }
}
