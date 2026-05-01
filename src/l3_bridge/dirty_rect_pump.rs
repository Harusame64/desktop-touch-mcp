//! Dirty rect event pump: L1 ring → engine-perception input.
//!
//! S2 D2-C (`docs/adr-008-d2-c-plan.md` §3.5) sibling of `focus_pump`.
//! Subscribes to the L1 ring on the parent thread, then spawns a
//! worker that filters `EventKind::DirtyRect` payloads, decodes them
//! via bincode, builds a `DirtyRectEvent`, and pushes it through the
//! shared `L1Sink` into the engine.
//!
//! Same lifecycle / shutdown contract as `focus_pump.rs`:
//! - parent-side `subscribe` (Codex v3 P1)
//! - retain-on-timeout `JoinHandle` (Codex v6 P1)
//! - 5-cycle restart safe (test parity with focus_pump's
//!   `five_cycle_spawn_shutdown`)

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::l1_capture::{
    DirtyRectPayload, EventKind, EventRing, Subscription, SubscriptionEvent,
};
use engine_perception::input::{DirtyRectEvent, L1Sink, Rect};

/// Per-recv timeout. Bounds shutdown latency.
const RECV_TIMEOUT: Duration = Duration::from_millis(100);

/// Subscription channel capacity. P5c-2 emit fork rate is at most
/// monitor-refresh-rate × dirty-rects-per-frame ≤ a few hundred / sec
/// in worst case, so 8192 is ample (mirrors `focus_pump`).
const SUB_CAPACITY: usize = 8192;

/// L1 → engine-perception dirty rect event pump.
pub(crate) struct DirtyRectPump {
    join: Mutex<Option<JoinHandle<()>>>,
    shutdown: Arc<AtomicBool>,
    forwarded_count: Arc<AtomicU64>,
    decode_failure_count: Arc<AtomicU64>,
}

impl DirtyRectPump {
    /// Spawn the pump. Mirrors `FocusPump::spawn` exactly: parent-side
    /// `ring.subscribe(...)` first (Codex v3 P1), then move the
    /// `Subscription` into the worker.
    pub(crate) fn spawn(ring: Arc<EventRing>, sink: Arc<dyn L1Sink>) -> Self {
        let sub: Subscription = ring.subscribe(SUB_CAPACITY);

        let shutdown = Arc::new(AtomicBool::new(false));
        let forwarded_count = Arc::new(AtomicU64::new(0));
        let decode_failure_count = Arc::new(AtomicU64::new(0));

        let shutdown_clone = Arc::clone(&shutdown);
        let forwarded_clone = Arc::clone(&forwarded_count);
        let decode_failures_clone = Arc::clone(&decode_failure_count);

        let join = thread::Builder::new()
            .name("l3-dirty-rect-pump".into())
            .spawn(move || {
                run(
                    sub,
                    sink,
                    shutdown_clone,
                    forwarded_clone,
                    decode_failures_clone,
                );
            })
            .expect("spawn l3-dirty-rect-pump");

        DirtyRectPump {
            join: Mutex::new(Some(join)),
            shutdown,
            forwarded_count,
            decode_failure_count,
        }
    }

    /// Signal shutdown and poll the pump thread's `is_finished()`
    /// until the deadline. **The `JoinHandle` is retained on timeout**
    /// (Codex v6 P1), same retain semantics as `FocusPump`.
    pub(crate) fn shutdown_with_timeout(&self, timeout: Duration) -> Result<(), &'static str> {
        self.shutdown.store(true, Ordering::SeqCst);

        let deadline = Instant::now() + timeout;
        let poll_interval = Duration::from_millis(10);

        loop {
            let finished_or_done = {
                let mut guard = self.join.lock().unwrap_or_else(|e| e.into_inner());
                match guard.as_ref() {
                    Some(h) if h.is_finished() => {
                        let h = guard.take().expect("just observed Some");
                        let _ = h.join();
                        true
                    }
                    Some(_) => false,
                    None => true,
                }
            };
            if finished_or_done {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("dirty rect pump join timed out");
            }
            thread::sleep(poll_interval);
        }
    }

    /// Consume-form shutdown — delegates to `shutdown_with_timeout`.
    pub(crate) fn shutdown(self, timeout: Duration) -> Result<(), &'static str> {
        self.shutdown_with_timeout(timeout)
    }

    pub(crate) fn forwarded_count(&self) -> u64 {
        self.forwarded_count.load(Ordering::Relaxed)
    }

    pub(crate) fn decode_failure_count(&self) -> u64 {
        self.decode_failure_count.load(Ordering::Relaxed)
    }
}

impl Drop for DirtyRectPump {
    fn drop(&mut self) {
        // Best-effort signal + best-effort join. Don't block in Drop.
        self.shutdown.store(true, Ordering::SeqCst);
        let handle_opt = self
            .join
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(h) = handle_opt {
            let deadline = Instant::now() + Duration::from_secs(2);
            while !h.is_finished() {
                if Instant::now() >= deadline {
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            let _ = h.join();
        }
    }
}

fn run(
    sub: Subscription,
    sink: Arc<dyn L1Sink>,
    shutdown: Arc<AtomicBool>,
    forwarded: Arc<AtomicU64>,
    decode_failures: Arc<AtomicU64>,
) {
    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        match sub.recv_timeout(RECV_TIMEOUT) {
            Ok(env) => {
                if env.kind != EventKind::DirtyRect as u16 {
                    continue;
                }
                if let Some(ev) = decode_dirty_rect_event(&env, &decode_failures) {
                    sink.push_dirty_rect(ev);
                    forwarded.fetch_add(1, Ordering::Relaxed);
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        }
    }
    // sub Drop unsubscribes from the ring automatically.
}

/// Decode one `SubscriptionEvent` into a `DirtyRectEvent`. Returns
/// `None` on bincode decode failure (counter incremented). Extracted
/// as a free function so unit tests can drive the decode path with
/// synthetic envelopes without spawning the full pump (mirrors
/// `focus_pump::decode_focus_event`).
fn decode_dirty_rect_event(
    env: &SubscriptionEvent,
    decode_failures: &AtomicU64,
) -> Option<DirtyRectEvent> {
    let payload: DirtyRectPayload =
        match bincode::serde::decode_from_slice(&env.payload, bincode::config::standard()) {
            Ok((p, _)) => p,
            Err(_) => {
                decode_failures.fetch_add(1, Ordering::Relaxed);
                return None;
            }
        };
    Some(DirtyRectEvent {
        source_event_id: env.event_id,
        wallclock_ms: env.wallclock_ms,
        sub_ordinal: env.sub_ordinal,
        timestamp_source: env.timestamp_source,
        monitor_index: payload.monitor_index,
        frame_index: payload.frame_index,
        rect: Rect::from_array(payload.rect),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex as StdMutex;

    use crate::l1_capture::{encode_payload, DirtyRectPayload, EventRing, TimestampSource};
    use engine_perception::input::{DirtyRectEvent, FocusEvent};

    /// Capture-only `L1Sink` for tests.
    struct CaptureSink {
        events: StdMutex<Vec<DirtyRectEvent>>,
    }

    impl CaptureSink {
        fn new() -> Self {
            Self {
                events: StdMutex::new(Vec::new()),
            }
        }
        fn snapshot(&self) -> Vec<DirtyRectEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    impl L1Sink for CaptureSink {
        fn push_focus(&self, _event: FocusEvent) {
            // Not relevant for dirty-rect tests.
        }
        fn push_dirty_rect(&self, event: DirtyRectEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    fn make_ring() -> Arc<EventRing> {
        Arc::new(EventRing::new(1024))
    }

    fn make_dirty_rect_event(
        ring: &EventRing,
        monitor_index: u32,
        frame_index: u64,
        rect: [i32; 4],
        wallclock_ms: u64,
    ) -> u64 {
        let payload = DirtyRectPayload {
            rect,
            monitor_index,
            frame_index,
        };
        let payload_bytes = encode_payload(&payload);
        let internal = crate::l1_capture::InternalEvent {
            envelope_version: 1,
            event_id: 0,
            wallclock_ms,
            sub_ordinal: 0,
            timestamp_source: TimestampSource::Dxgi as u8,
            kind: EventKind::DirtyRect as u16,
            payload: payload_bytes,
            session_id: None,
            tool_call_id: None,
        };
        ring.push(internal)
    }

    fn wait_for<F: Fn(&CaptureSink) -> bool>(
        sink: &CaptureSink,
        timeout: Duration,
        predicate: F,
    ) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if predicate(sink) {
                return true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        predicate(sink)
    }

    #[test]
    fn forwards_dirty_rect_to_sink() {
        let ring = make_ring();
        let sink = Arc::new(CaptureSink::new());
        let pump = DirtyRectPump::spawn(Arc::clone(&ring), sink.clone() as Arc<dyn L1Sink>);

        let event_id =
            make_dirty_rect_event(&ring, 0, 1, [10, 20, 30, 40], 1_700_000_000_000);

        assert!(
            wait_for(&sink, Duration::from_millis(500), |s| s.snapshot().len() == 1),
            "expected 1 forwarded dirty rect, got {}",
            sink.snapshot().len()
        );

        let events = sink.snapshot();
        let ev = &events[0];
        assert_eq!(ev.source_event_id, event_id, "N1 source_event_id pivot");
        assert_eq!(ev.monitor_index, 0);
        assert_eq!(ev.frame_index, 1);
        assert_eq!(ev.rect.x, 10);
        assert_eq!(ev.rect.y, 20);
        assert_eq!(ev.rect.width, 30);
        assert_eq!(ev.rect.height, 40);
        assert_eq!(ev.timestamp_source, TimestampSource::Dxgi as u8);
        assert_eq!(pump.forwarded_count(), 1);
        assert_eq!(pump.decode_failure_count(), 0);

        pump.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn monitor_index_propagates_correctly() {
        // CLAUDE.md §3.2 PR #102 教訓: monitor_index must NOT be
        // hard-coded or dropped on the L1→L3 path.
        let ring = make_ring();
        let sink = Arc::new(CaptureSink::new());
        let pump = DirtyRectPump::spawn(Arc::clone(&ring), sink.clone() as Arc<dyn L1Sink>);

        make_dirty_rect_event(&ring, 0, 1, [0, 0, 100, 100], 1_700_000_000_000);
        make_dirty_rect_event(&ring, 1, 1, [0, 0, 200, 200], 1_700_000_000_001);

        assert!(wait_for(&sink, Duration::from_millis(500), |s| s.snapshot().len() == 2));

        let events = sink.snapshot();
        assert_eq!(events[0].monitor_index, 0);
        assert_eq!(events[1].monitor_index, 1);
        assert_eq!(events[0].rect.width, 100);
        assert_eq!(events[1].rect.width, 200);

        pump.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn skips_non_dirty_rect_events() {
        // Non-DirtyRect kind (e.g. UiaFocusChanged) must not forward.
        let ring = make_ring();
        let sink = Arc::new(CaptureSink::new());
        let pump = DirtyRectPump::spawn(Arc::clone(&ring), sink.clone() as Arc<dyn L1Sink>);

        let internal = crate::l1_capture::InternalEvent {
            envelope_version: 1,
            event_id: 0,
            wallclock_ms: 1_700_000_000_000,
            sub_ordinal: 0,
            timestamp_source: TimestampSource::StdTime as u8,
            kind: EventKind::Heartbeat as u16,
            payload: vec![],
            session_id: None,
            tool_call_id: None,
        };
        ring.push(internal);
        thread::sleep(Duration::from_millis(150));

        assert_eq!(sink.snapshot().len(), 0);
        assert_eq!(pump.forwarded_count(), 0);
        assert_eq!(pump.decode_failure_count(), 0);

        pump.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn decode_failure_increments_counter() {
        let ring = make_ring();
        let sink = Arc::new(CaptureSink::new());
        let pump = DirtyRectPump::spawn(Arc::clone(&ring), sink.clone() as Arc<dyn L1Sink>);

        // Invalid bincode payload under DirtyRect kind.
        let internal = crate::l1_capture::InternalEvent {
            envelope_version: 1,
            event_id: 0,
            wallclock_ms: 1_700_000_000_000,
            sub_ordinal: 0,
            timestamp_source: TimestampSource::Dxgi as u8,
            kind: EventKind::DirtyRect as u16,
            payload: vec![0xff, 0xff, 0xff],
            session_id: None,
            tool_call_id: None,
        };
        ring.push(internal);
        thread::sleep(Duration::from_millis(150));

        assert_eq!(sink.snapshot().len(), 0);
        assert_eq!(pump.decode_failure_count(), 1);
        assert_eq!(pump.forwarded_count(), 0);

        pump.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn shutdown_within_2s() {
        let ring = make_ring();
        let sink = Arc::new(CaptureSink::new());
        let pump = DirtyRectPump::spawn(Arc::clone(&ring), sink as Arc<dyn L1Sink>);
        let start = Instant::now();
        pump.shutdown(Duration::from_secs(2)).expect("shutdown");
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "shutdown should be fast (no events to drain)"
        );
    }

    #[test]
    fn five_cycle_spawn_shutdown() {
        let ring = make_ring();

        for cycle in 0..5 {
            let sink = Arc::new(CaptureSink::new());
            let pump =
                DirtyRectPump::spawn(Arc::clone(&ring), sink.clone() as Arc<dyn L1Sink>);
            make_dirty_rect_event(
                &ring,
                cycle as u32,
                cycle as u64,
                [0, 0, 10, 10],
                1_700_000_000_000 + cycle as u64,
            );
            assert!(
                wait_for(&sink, Duration::from_millis(500), |s| s.snapshot().len() == 1),
                "cycle {} expected 1 forwarded dirty rect",
                cycle
            );
            pump.shutdown(Duration::from_secs(2))
                .unwrap_or_else(|e| panic!("cycle {} shutdown failed: {}", cycle, e));
            assert_eq!(
                ring.subscriber_count(),
                0,
                "cycle {}: subscriber slot must be cleared on Drop",
                cycle
            );
        }
    }
}
