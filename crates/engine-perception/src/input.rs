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
//! ## Lifecycle
//!
//! [`spawn_perception_worker`] returns
//! `(PerceptionWorker, FocusInputHandle, CurrentFocusedElementView)`.
//! Drop the handle (or all clones thereof) and call
//! `PerceptionWorker::shutdown(timeout)` to stop the thread. The view
//! handle (D1-3) is independent of the worker's lifetime — it remains
//! readable after shutdown but stops receiving updates.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, Sender, TryRecvError};
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

/// Owner of the timely worker thread. Returned alongside the
/// `FocusInputHandle` from [`spawn_perception_worker`]. Drop or
/// `shutdown(timeout)` to stop the thread.
pub struct PerceptionWorker {
    join: Option<JoinHandle<()>>,
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

    /// Signal shutdown and join the worker thread, polling so the
    /// deadline applies even if the worker is mid-step. Mirrors the
    /// L1 worker's `shutdown_with_timeout` shape (root
    /// `src/l1_capture/worker.rs`, ADR-007 R11).
    pub fn shutdown(mut self, timeout: Duration) -> Result<(), &'static str> {
        let _ = self.tx.send(Cmd::Shutdown);
        let Some(handle) = self.join.take() else {
            return Ok(());
        };

        let deadline = Instant::now() + timeout;
        let poll_interval = Duration::from_millis(10);
        loop {
            if handle.is_finished() {
                let _ = handle.join();
                return Ok(());
            }
            if Instant::now() >= deadline {
                // Re-place the handle so callers can retry. (We took
                // it out of self.join above; rebuild self for Drop.)
                // Actually we can't rebuild — `self` was consumed.
                // Drop the handle; the thread will eventually exit
                // and the OS will reap it. Caller sees the timeout.
                return Err("perception worker join timed out");
            }
            thread::sleep(poll_interval);
        }
    }
}

impl Drop for PerceptionWorker {
    fn drop(&mut self) {
        // Best-effort: signal shutdown. Don't block in Drop.
        let _ = self.tx.send(Cmd::Shutdown);
        if let Some(h) = self.join.take() {
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
        join: Some(join),
        tx: tx.clone(),
        processed_count,
    };
    let handle = FocusInputHandle { tx };
    (worker, handle, view)
}

/// Body of the timely worker thread.
///
/// Runs `timely::execute_directly` with a single-thread allocator;
/// the worker pumps the cmd channel until `Cmd::Shutdown`. After the
/// closure returns, `execute_directly` drains remaining work
/// (`while worker.has_dataflows() { worker.step_or_park(None); }`)
/// before the function returns.
fn worker_loop(
    rx: Receiver<Cmd>,
    processed: Arc<AtomicU64>,
    view: CurrentFocusedElementView,
) {
    let shift_ms = watermark_shift_ms();

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

        loop {
            match rx.try_recv() {
                Ok(Cmd::PushFocus(ev)) => {
                    let event_time = ev.logical_time();

                    // Guard: DD asserts session_time <= update time.
                    // Our session_time tracks `current_watermark`,
                    // so out-of-order events older than the frontier
                    // would panic. Drop them with a log instead.
                    use timely::order::PartialOrder;
                    if !current_watermark.less_equal(&event_time) {
                        eprintln!(
                            "[perception-worker] out-of-order event dropped: \
                             event_time={:?} watermark={:?} source_event_id={}",
                            event_time, current_watermark, ev.source_event_id
                        );
                    } else {
                        input.update_at(ev.clone(), event_time.clone(), 1);
                    }

                    // Frontier advances on monotone `wallclock_ms`.
                    if ev.wallclock_ms > latest_wallclock_ms {
                        latest_wallclock_ms = ev.wallclock_ms;
                        let new_wm = watermark_for(latest_wallclock_ms, shift_ms);
                        if current_watermark.less_equal(&new_wm)
                            && current_watermark != new_wm
                        {
                            current_watermark = new_wm.clone();
                            input.advance_to(new_wm);
                        }
                    }
                    input.flush();
                    // Increment AFTER flush so an observer that sees
                    // processed_count == N is guaranteed N events are
                    // visible to the dataflow (Codex PR #90 review P2).
                    processed.fetch_add(1, Ordering::Relaxed);
                }
                Ok(Cmd::Shutdown) => break,
                Err(TryRecvError::Empty) => {
                    worker.step();
                    thread::sleep(Duration::from_millis(1));
                }
                Err(TryRecvError::Disconnected) => break,
            }
            worker.step();
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
