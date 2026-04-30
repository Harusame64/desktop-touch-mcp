//! Focus event pump: L1 ring → engine-perception input.
//!
//! ## Why this lives in the root crate
//!
//! The bridge owns the L1 ring (`Arc<EventRing>`), decodes payloads
//! using bincode (which speaks the root-side `UiaFocusChangedPayload`
//! type), and pushes a pure `engine_perception::input::FocusEvent`
//! into a `dyn L1Sink`. Putting this in the engine-perception crate
//! would force that crate to take a dep on the root crate (rejected
//! by Codex review v2 P1, see `src/l3_bridge/mod.rs` rationale).
//!
//! ## parent-side subscribe (Codex review v3 P1)
//!
//! [`FocusPump::spawn`] calls `ring.subscribe(...)` on the **parent
//! thread** before spawning the worker, then moves the resulting
//! `Subscription` into the worker. This eliminates the race where
//! `spawn()` returns and the caller pushes immediately — without
//! parent-side subscribe the push could happen before the worker's
//! `subscribe()` registered, and broadcast is non-replay (Codex v1
//! P2-2 / `docs/adr-008-d1-2-plan.md` §1.4 (e)).
//!
//! ## What the pump does per UIA focus event
//!
//! 1. Recv a `SubscriptionEvent` from the ring's broadcast channel.
//! 2. Filter by `kind == EventKind::UiaFocusChanged`.
//! 3. bincode-decode the payload as `UiaFocusChangedPayload`.
//! 4. Skip `payload.after = None` (focus dropped — D2 semantic_event_stream scope).
//! 5. Build a `FocusEvent` carrying:
//!    - `source_event_id = env.event_id` (北極星 N1, traceability pivot)
//!    - `timestamp_source = env.timestamp_source` (replay)
//!    - `wallclock_ms` / `sub_ordinal` as event-time data (北極星 N2)
//! 6. Call `sink.push_focus(ev)`.
//!
//! Decode failures and `after = None` skips bump observable counters
//! so D2 metrics can read them.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::l1_capture::{
    EventKind, EventRing, Subscription, SubscriptionEvent, UiaFocusChangedPayload,
};
use engine_perception::input::{FocusEvent, L1Sink};

/// Per-recv timeout. Bounds shutdown latency; the worker checks the
/// shutdown flag at most this often when the ring is idle.
const RECV_TIMEOUT: Duration = Duration::from_millis(100);

/// Default subscription channel capacity. UIA focus rate << 10/s
/// under human use; 8192 is ample (see plan §1.4 (f)).
const SUB_CAPACITY: usize = 8192;

pub(crate) struct FocusPump {
    join: Option<JoinHandle<()>>,
    shutdown: Arc<AtomicBool>,
    forwarded_count: Arc<AtomicU64>,
    decode_failure_count: Arc<AtomicU64>,
    after_none_skip_count: Arc<AtomicU64>,
}

impl FocusPump {
    /// Spawn the pump.
    ///
    /// Codex v3 P1: `ring.subscribe(...)` runs on the parent thread
    /// BEFORE the worker thread is spawned. This way `spawn()` does
    /// not return until the subscription is registered with the ring,
    /// so the caller can `ring.push(...)` immediately afterward
    /// without losing events. The `Subscription` is moved into the
    /// worker thread (it's `Send` — `Receiver` + `Arc` + `u64` +
    /// `Arc<AtomicU64>`).
    pub(crate) fn spawn(ring: Arc<EventRing>, sink: Arc<dyn L1Sink>) -> Self {
        // ─── parent-side subscribe (Codex v3 P1) ─────────────────────
        let sub: Subscription = ring.subscribe(SUB_CAPACITY);
        // ────────────────────────────────────────────────────────────

        let shutdown = Arc::new(AtomicBool::new(false));
        let forwarded_count = Arc::new(AtomicU64::new(0));
        let decode_failure_count = Arc::new(AtomicU64::new(0));
        let after_none_skip_count = Arc::new(AtomicU64::new(0));

        let shutdown_clone = Arc::clone(&shutdown);
        let forwarded_clone = Arc::clone(&forwarded_count);
        let decode_failures_clone = Arc::clone(&decode_failure_count);
        let after_none_skip_clone = Arc::clone(&after_none_skip_count);

        let join = thread::Builder::new()
            .name("l3-focus-pump".into())
            .spawn(move || {
                run(
                    sub,
                    sink,
                    shutdown_clone,
                    forwarded_clone,
                    decode_failures_clone,
                    after_none_skip_clone,
                );
            })
            .expect("spawn l3-focus-pump");

        FocusPump {
            join: Some(join),
            shutdown,
            forwarded_count,
            decode_failure_count,
            after_none_skip_count,
        }
    }

    /// Signal shutdown and join the pump thread, polling so the
    /// deadline applies even mid-recv. Mirrors the L1 / perception
    /// worker shutdown shape.
    pub(crate) fn shutdown(mut self, timeout: Duration) -> Result<(), &'static str> {
        self.shutdown.store(true, Ordering::SeqCst);
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
                return Err("focus pump join timed out");
            }
            thread::sleep(poll_interval);
        }
    }

    pub(crate) fn forwarded_count(&self) -> u64 {
        self.forwarded_count.load(Ordering::Relaxed)
    }

    pub(crate) fn decode_failure_count(&self) -> u64 {
        self.decode_failure_count.load(Ordering::Relaxed)
    }

    pub(crate) fn after_none_skip_count(&self) -> u64 {
        self.after_none_skip_count.load(Ordering::Relaxed)
    }
}

impl Drop for FocusPump {
    fn drop(&mut self) {
        // Best-effort signal + best-effort join. Don't block in Drop.
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(h) = self.join.take() {
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
    after_none_skip: Arc<AtomicU64>,
) {
    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        match sub.recv_timeout(RECV_TIMEOUT) {
            Ok(env) => {
                if env.kind != EventKind::UiaFocusChanged as u16 {
                    continue;
                }
                if let Some(ev) = decode_focus_event(&env, &decode_failures, &after_none_skip) {
                    sink.push_focus(ev);
                    forwarded.fetch_add(1, Ordering::Relaxed);
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        }
    }
    // sub Drop unsubscribes from the ring automatically.
}

/// Decode one `SubscriptionEvent` into a `FocusEvent`. Returns
/// `None` for skip cases (decode failure, `payload.after = None`),
/// updating the supplied counters. Extracted as a free function so
/// the unit tests can exercise the decode path with synthetic
/// envelopes without spawning the full pump.
fn decode_focus_event(
    env: &SubscriptionEvent,
    decode_failures: &AtomicU64,
    after_none_skip: &AtomicU64,
) -> Option<FocusEvent> {
    let payload: UiaFocusChangedPayload =
        match bincode::serde::decode_from_slice(&env.payload, bincode::config::standard()) {
            Ok((p, _)) => p,
            Err(_) => {
                decode_failures.fetch_add(1, Ordering::Relaxed);
                return None;
            }
        };
    let after = match payload.after {
        Some(a) => a,
        None => {
            // Focus dropped — D2 semantic_event_stream scope.
            after_none_skip.fetch_add(1, Ordering::Relaxed);
            return None;
        }
    };
    Some(FocusEvent {
        source_event_id: env.event_id,
        hwnd: after.hwnd,
        name: after.name,
        automation_id: after.automation_id,
        control_type: after.control_type,
        window_title: payload.window_title,
        wallclock_ms: env.wallclock_ms,
        sub_ordinal: env.sub_ordinal,
        timestamp_source: env.timestamp_source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Mutex;

    use crate::l1_capture::{
        encode_payload, EventRing, TimestampSource, UiElementRef, UiaFocusChangedPayload,
    };

    /// In-memory `L1Sink` for tests — captures every push for
    /// later assertion.
    struct CaptureSink {
        events: Mutex<Vec<FocusEvent>>,
    }

    impl CaptureSink {
        fn new() -> Self {
            Self {
                events: Mutex::new(Vec::new()),
            }
        }
        fn snapshot(&self) -> Vec<FocusEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    impl L1Sink for CaptureSink {
        fn push_focus(&self, event: FocusEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    fn make_ring() -> Arc<EventRing> {
        Arc::new(EventRing::new(1024))
    }

    fn make_focus_event(
        ring: &EventRing,
        hwnd: u64,
        name: &str,
        window_title: &str,
    ) -> u64 {
        let payload = UiaFocusChangedPayload {
            before: None,
            after: Some(UiElementRef {
                hwnd,
                name: name.to_string(),
                automation_id: Some("auto-id-1".into()),
                control_type: 50000, // Button
            }),
            window_title: window_title.to_string(),
        };
        let payload_bytes = encode_payload(&payload);
        let internal = crate::l1_capture::InternalEvent {
            envelope_version: 1,
            event_id: 0, // assigned by push
            wallclock_ms: 1_700_000_000_000,
            sub_ordinal: 0,
            timestamp_source: TimestampSource::StdTime as u8,
            kind: EventKind::UiaFocusChanged as u16,
            payload: payload_bytes,
            session_id: None,
            tool_call_id: None,
        };
        ring.push(internal)
    }

    fn make_after_none_event(ring: &EventRing) -> u64 {
        let payload = UiaFocusChangedPayload {
            before: None,
            after: None,
            window_title: String::new(),
        };
        let payload_bytes = encode_payload(&payload);
        let internal = crate::l1_capture::InternalEvent {
            envelope_version: 1,
            event_id: 0,
            wallclock_ms: 1_700_000_000_001,
            sub_ordinal: 0,
            timestamp_source: TimestampSource::StdTime as u8,
            kind: EventKind::UiaFocusChanged as u16,
            payload: payload_bytes,
            session_id: None,
            tool_call_id: None,
        };
        ring.push(internal)
    }

    fn make_invalid_payload_focus_event(ring: &EventRing) -> u64 {
        let internal = crate::l1_capture::InternalEvent {
            envelope_version: 1,
            event_id: 0,
            wallclock_ms: 1_700_000_000_002,
            sub_ordinal: 0,
            timestamp_source: TimestampSource::StdTime as u8,
            kind: EventKind::UiaFocusChanged as u16,
            payload: vec![0xff, 0xff, 0xff], // not a valid bincode UiaFocusChangedPayload
            session_id: None,
            tool_call_id: None,
        };
        ring.push(internal)
    }

    fn make_heartbeat_event(ring: &EventRing) -> u64 {
        let internal = crate::l1_capture::InternalEvent {
            envelope_version: 1,
            event_id: 0,
            wallclock_ms: 1_700_000_000_003,
            sub_ordinal: 0,
            timestamp_source: TimestampSource::StdTime as u8,
            kind: EventKind::Heartbeat as u16,
            payload: vec![],
            session_id: None,
            tool_call_id: None,
        };
        ring.push(internal)
    }

    /// Wait up to `timeout` for `predicate(sink)` to become true.
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
    fn forwards_uia_focus_to_sink() {
        let ring = make_ring();
        let sink = Arc::new(CaptureSink::new());
        let pump = FocusPump::spawn(Arc::clone(&ring), sink.clone() as Arc<dyn L1Sink>);

        let event_id = make_focus_event(&ring, 0xAAAA, "Edit", "Notepad");

        assert!(
            wait_for(&sink, Duration::from_millis(500), |s| s
                .snapshot()
                .len()
                == 1),
            "expected 1 forwarded event, got {}",
            sink.snapshot().len()
        );

        let events = sink.snapshot();
        let ev = &events[0];
        assert_eq!(ev.source_event_id, event_id, "N1 source_event_id pivot");
        assert_eq!(ev.hwnd, 0xAAAA);
        assert_eq!(ev.name, "Edit");
        assert_eq!(ev.window_title, "Notepad");
        assert_eq!(ev.timestamp_source, TimestampSource::StdTime as u8);
        assert_eq!(pump.forwarded_count(), 1);
        assert_eq!(pump.decode_failure_count(), 0);
        assert_eq!(pump.after_none_skip_count(), 0);

        pump.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn spawn_then_immediate_push_arrives() {
        // Codex v3 P1 regression: spawn returns AFTER subscribe is
        // registered, so a sync push immediately after spawn must
        // be delivered. If parent-side subscribe regressed, this
        // test would flaky-fail.
        let ring = make_ring();
        let sink = Arc::new(CaptureSink::new());
        let pump = FocusPump::spawn(Arc::clone(&ring), sink.clone() as Arc<dyn L1Sink>);
        // No sleep / yield between spawn and push.
        make_focus_event(&ring, 0xBBBB, "Button", "App");

        assert!(
            wait_for(&sink, Duration::from_millis(500), |s| s
                .snapshot()
                .len()
                == 1),
            "immediate push must arrive (parent-side subscribe must be registered before spawn returns)"
        );

        pump.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn forwarded_event_carries_source_event_id() {
        let ring = make_ring();
        let sink = Arc::new(CaptureSink::new());
        let pump = FocusPump::spawn(Arc::clone(&ring), sink.clone() as Arc<dyn L1Sink>);

        let id_a = make_focus_event(&ring, 1, "A", "WinA");
        let id_b = make_focus_event(&ring, 2, "B", "WinB");
        let id_c = make_focus_event(&ring, 3, "C", "WinC");

        assert!(
            wait_for(&sink, Duration::from_millis(500), |s| s
                .snapshot()
                .len()
                == 3),
            "3 events forwarded"
        );

        let events = sink.snapshot();
        assert_eq!(events[0].source_event_id, id_a);
        assert_eq!(events[1].source_event_id, id_b);
        assert_eq!(events[2].source_event_id, id_c);

        pump.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn skips_non_focus_events() {
        let ring = make_ring();
        let sink = Arc::new(CaptureSink::new());
        let pump = FocusPump::spawn(Arc::clone(&ring), sink.clone() as Arc<dyn L1Sink>);

        make_heartbeat_event(&ring);
        // Wait long enough for the pump to process (or skip) the event.
        thread::sleep(Duration::from_millis(150));
        assert_eq!(sink.snapshot().len(), 0, "heartbeat must not forward");
        assert_eq!(pump.forwarded_count(), 0);
        assert_eq!(pump.decode_failure_count(), 0);
        assert_eq!(pump.after_none_skip_count(), 0);

        pump.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn skips_focus_with_no_after() {
        let ring = make_ring();
        let sink = Arc::new(CaptureSink::new());
        let pump = FocusPump::spawn(Arc::clone(&ring), sink.clone() as Arc<dyn L1Sink>);

        make_after_none_event(&ring);
        thread::sleep(Duration::from_millis(150));
        assert_eq!(sink.snapshot().len(), 0);
        assert_eq!(pump.forwarded_count(), 0);
        assert_eq!(pump.after_none_skip_count(), 1, "after=None counter");

        pump.shutdown(Duration::from_secs(2)).expect("shutdown");
    }

    #[test]
    fn decode_failure_increments_counter() {
        let ring = make_ring();
        let sink = Arc::new(CaptureSink::new());
        let pump = FocusPump::spawn(Arc::clone(&ring), sink.clone() as Arc<dyn L1Sink>);

        make_invalid_payload_focus_event(&ring);
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
        let pump = FocusPump::spawn(Arc::clone(&ring), sink as Arc<dyn L1Sink>);
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
                FocusPump::spawn(Arc::clone(&ring), sink.clone() as Arc<dyn L1Sink>);
            make_focus_event(&ring, 0xC000 + cycle, "X", "WX");
            assert!(
                wait_for(&sink, Duration::from_millis(500), |s| s
                    .snapshot()
                    .len()
                    == 1),
                "cycle {} expected 1 forwarded event",
                cycle
            );
            pump.shutdown(Duration::from_secs(2))
                .unwrap_or_else(|e| panic!("cycle {} shutdown failed: {}", cycle, e));
            // After shutdown, the Subscription drops → ring removes
            // its slot → subscriber_count == 0.
            assert_eq!(
                ring.subscriber_count(),
                0,
                "cycle {}: subscriber slot must be cleared on Drop",
                cycle
            );
        }
    }

    // ─── Direct decode_focus_event tests (no spawn) ───────────────────

    fn make_subscription_event_for_decode(
        kind: u16,
        payload: Vec<u8>,
        event_id: u64,
        wallclock_ms: u64,
    ) -> SubscriptionEvent {
        SubscriptionEvent {
            event_id,
            kind,
            wallclock_ms,
            sub_ordinal: 0,
            timestamp_source: TimestampSource::StdTime as u8,
            envelope_version: 1,
            payload: Arc::from(payload.as_slice()),
            session_id: None,
            tool_call_id: None,
        }
    }

    #[test]
    fn decode_preserves_event_id_and_timestamp_source() {
        let payload = UiaFocusChangedPayload {
            before: None,
            after: Some(UiElementRef {
                hwnd: 0x1234,
                name: "n".into(),
                automation_id: None,
                control_type: 50000,
            }),
            window_title: "wt".into(),
        };
        let bytes = encode_payload(&payload);
        let mut env =
            make_subscription_event_for_decode(EventKind::UiaFocusChanged as u16, bytes, 999, 42);
        env.timestamp_source = TimestampSource::Dxgi as u8; // 2

        let dec = AtomicU64::new(0);
        let none = AtomicU64::new(0);
        let ev = decode_focus_event(&env, &dec, &none).expect("decoded");
        assert_eq!(ev.source_event_id, 999, "N1");
        assert_eq!(ev.timestamp_source, TimestampSource::Dxgi as u8, "N1 副次");
        assert_eq!(ev.wallclock_ms, 42);
        assert_eq!(dec.load(Ordering::Relaxed), 0);
        assert_eq!(none.load(Ordering::Relaxed), 0);
    }
}
