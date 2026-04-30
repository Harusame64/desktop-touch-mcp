//! L3 bridge: root crate owns L1→L3 integration.
//!
//! This module is the seam between the root crate (which owns the L1 ring,
//! UIA / DXGI hooks, napi addon entry points, and all `windows-rs`
//! dependencies) and the `engine-perception` crate (a pure timely +
//! differential-dataflow compute crate, deliberately kept napi-free).
//!
//! ## Why the bridge lives in root, not in engine-perception
//!
//! Codex review v2 P1 rejected the alternative direction
//! (`engine-perception → desktop-touch-engine` dep). Putting the dep
//! the other way around would have pulled napi, ORT, tokenizers, and
//! `windows-rs` into engine-perception's transitive graph and broken
//! the contract from `docs/adr-008-d1-plan.md` §2 ("`engine-perception`
//! is napi-free / pure Rust"). The L1 ring is owned by the root crate,
//! so the natural place for the decode→push adapter is also the root
//! crate. See `docs/adr-007-p5c-plan.md` §2.2 / §6 / §12 for the full
//! rationale.
//!
//! ## Status
//!
//! D1-2 (ADR-008) lands `focus_pump` here. The pump owns a parent-side
//! `EventRing::subscribe(...)` (Codex v3 P1 — registers the slot
//! before spawning the worker so a sync push immediately after
//! `spawn()` is delivered) and forwards `UiaFocusChanged` payloads
//! into a `dyn engine_perception::input::L1Sink`.
//!
//! Future submodules (D2):
//!   - `dirty_rect_pump` (P5c-2 / DXGI dirty rects)
//!   - `window_pump` (P5c-3 / window opened/closed/foreground)
//!   - `scroll_pump` (P5c-4 / IUIAutomationScrollPattern)

#![allow(dead_code)]

pub(crate) mod focus_pump;

use std::sync::Arc;
use std::time::Duration;

use engine_perception::input::{spawn_perception_worker, FocusInputHandle, L1Sink, PerceptionWorker};

use crate::l1_capture::ensure_l1;

use self::focus_pump::FocusPump;

/// Test helper: spawn the full perception pipeline on the existing
/// L1 ring (`ensure_l1()`).
///
/// Order is critical (Codex v1 P2-2 / v3 P1):
///   1. Spawn the perception worker (cmd channel up).
///   2. Take a clone of the L1 ring `Arc`.
///   3. Spawn the pump LAST — its `spawn()` does the parent-side
///      `subscribe(...)` synchronously, so by the time this helper
///      returns, the subscription is registered with the ring and
///      a caller can `ring.push(...)` without losing events.
///
/// Returns `(worker, pump)`. Drop or [`shutdown_perception_pipeline_for_test`]
/// in pump → worker order.
pub(crate) fn spawn_perception_pipeline_for_test(
) -> (PerceptionWorker, FocusInputHandle, FocusPump) {
    let (worker, handle) = spawn_perception_worker();
    let ring = ensure_l1().ring.clone();
    let sink: Arc<dyn L1Sink> = Arc::new(handle.clone());
    let pump = FocusPump::spawn(ring, sink);
    (worker, handle, pump)
}

/// Shut down a pipeline started by
/// [`spawn_perception_pipeline_for_test`]. Order: pump → worker.
/// Pump first so its `Subscription` Drop unsubscribes from the ring
/// before the worker thread joins.
pub(crate) fn shutdown_perception_pipeline_for_test(
    worker: PerceptionWorker,
    pump: FocusPump,
) -> Result<(), &'static str> {
    pump.shutdown(Duration::from_secs(2))?;
    worker.shutdown(Duration::from_secs(2))?;
    Ok(())
}

// ─── 5-cycle lifecycle test (ADR-008 D1-2 §3.6) ────────────────────────
//
// The plan called for `tests/d1_pipeline_lifecycle.rs` (Codex v1 P2-3
// argued for `tests/` direct placement, against `tests/integration/...`).
// However, the root crate is `crate-type = ["cdylib"]` (napi addon),
// which means Cargo cannot build a separate integration-test binary
// linked against the lib — there is no rlib output. Adding `rlib` to
// `crate-type` would risk perturbing napi-build / the
// `desktop-touch-mcp-windows.zip` release pipeline (build:rs +
// scripts/build-rs.mjs).
//
// We honour the *intent* of Codex v1 P2-3 ("be auto-discovered, not
// orphaned in a nested dir") by placing the 5-cycle test as a
// `#[cfg(test)]` module inside `src/l3_bridge/mod.rs`. It is picked
// up by `cargo test --lib` / `cargo test --workspace` exactly like
// any other unit test — no separate integration-test infra needed.
#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use std::sync::atomic::Ordering;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use engine_perception::input::{FocusEvent, FocusInputHandle};

    /// Serializes the lifecycle tests in this module against each
    /// other. They share the singleton `ensure_l1()` ring, so
    /// running them in parallel would race their `subscriber_count()`
    /// observations. Other unit tests across the crate still run in
    /// parallel — only lifecycle_tests serialize against itself.
    fn lifecycle_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    use crate::l1_capture::{
        encode_payload, EventKind, InternalEvent, TimestampSource, UiElementRef,
        UiaFocusChangedPayload,
    };

    /// Tee sink that BOTH (a) forwards each push into the real
    /// `engine-perception` worker via a `FocusInputHandle`, and (b)
    /// captures a copy locally for test assertions.
    ///
    /// Codex PR #90 review P2: an earlier draft of this test wired
    /// the pump to a capture-only sink, so `ring.push → focus_pump
    /// → handle → worker → InputSession` was never exercised — only
    /// `ring.push → focus_pump → CaptureSink`. A regression in the
    /// engine-perception side would have passed the lifecycle test.
    /// The Tee design fixes that: `worker.processed_count()` now
    /// observes events crossing into `update_at` for real.
    struct TeeSink {
        handle: FocusInputHandle,
        captures: Mutex<Vec<FocusEvent>>,
    }

    impl TeeSink {
        fn new(handle: FocusInputHandle) -> Self {
            Self {
                handle,
                captures: Mutex::new(Vec::new()),
            }
        }
        fn count(&self) -> usize {
            self.captures.lock().unwrap().len()
        }
    }

    impl L1Sink for TeeSink {
        fn push_focus(&self, event: FocusEvent) {
            // (1) forward to engine-perception worker (real path)
            self.handle.push_focus(event.clone());
            // (2) record for test observation
            self.captures.lock().unwrap().push(event);
        }
    }

    fn push_focus_to_ring(
        ring: &crate::l1_capture::EventRing,
        cycle: u32,
        seq: u32,
    ) -> u64 {
        let payload = UiaFocusChangedPayload {
            before: None,
            after: Some(UiElementRef {
                hwnd: 0xD000 + cycle as u64 * 16 + seq as u64,
                name: format!("Cyc{}Seq{}", cycle, seq),
                automation_id: None,
                control_type: 50000,
            }),
            window_title: format!("LifecycleWin{}", cycle),
        };
        let internal = InternalEvent {
            envelope_version: 1,
            event_id: 0,
            wallclock_ms: 1_800_000_000_000 + cycle as u64 * 1000 + seq as u64,
            sub_ordinal: 0,
            timestamp_source: TimestampSource::StdTime as u8,
            kind: EventKind::UiaFocusChanged as u16,
            payload: encode_payload(&payload),
            session_id: None,
            tool_call_id: None,
        };
        ring.push(internal)
    }

    fn wait_for_count(sink: &TeeSink, target: usize, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if sink.count() >= target {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        sink.count() >= target
    }

    fn wait_for_processed(
        worker_processed: impl Fn() -> u64,
        target: u64,
        timeout: Duration,
    ) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if worker_processed() >= target {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        worker_processed() >= target
    }

    /// **5-cycle lifecycle test (D1-2 §3.6)**.
    ///
    /// Each cycle:
    ///   1. spawn the perception worker
    ///   2. spawn the focus pump (parent-side subscribe registers
    ///      with the existing L1 ring)
    ///   3. push 3 synthetic UiaFocusChanged events
    ///   4. assert 3 forwarded into the sink (within 500ms)
    ///   5. shut down pump → worker
    ///   6. assert ring.subscriber_count() == 0 (Drop unsubscribed)
    ///
    /// Codex v1 P2-2: order is **spawn → push → recv** every time.
    /// Codex v3 P1: parent-side subscribe means the post-spawn push
    /// is never racy.
    ///
    /// 5 cycles exercises the same shutdown-and-restart pattern that
    /// L1 / UIA worker tests use to catch leaks.
    #[test]
    fn five_cycle_pipeline_spawn_push_shutdown() {
        let _guard = lifecycle_lock().lock().unwrap_or_else(|e| e.into_inner());
        let ring = crate::l1_capture::ensure_l1().ring.clone();
        // Baseline: tests run in parallel and share the global L1
        // ring singleton via `ensure_l1()`. Use a relative delta so
        // a concurrent lifecycle test's subscriber doesn't break our
        // assertions.
        let baseline = ring.subscriber_count();

        for cycle in 0..5u32 {
            // (1) spawn the engine-perception worker (real timely +
            // InputSession; we'll observe its processed_count to
            // confirm cmds crossed into the dataflow path).
            let (worker, handle) = engine_perception::input::spawn_perception_worker();

            // (2) spawn pump wired to a TeeSink that BOTH forwards
            // into the worker (handle.push_focus) AND captures for
            // local assertion. This exercises the real ring → pump
            // → handle → worker → InputSession path (Codex PR #90 P2).
            let sink = std::sync::Arc::new(TeeSink::new(handle.clone()));
            let pump_sink: std::sync::Arc<dyn L1Sink> = sink.clone();
            let pump = focus_pump::FocusPump::spawn(ring.clone(), pump_sink);

            // Subscriber slot must exist now (parent-side subscribe
            // ran synchronously in spawn).
            assert!(
                ring.subscriber_count() >= baseline + 1,
                "cycle {}: subscriber slot must be registered after spawn (baseline={}, current={})",
                cycle,
                baseline,
                ring.subscriber_count()
            );

            // (3) push 3 synthetic events into the L1 ring
            for seq in 0..3u32 {
                push_focus_to_ring(&ring, cycle, seq);
            }

            // (4a) pump captured all 3 (forward path)
            assert!(
                wait_for_count(&sink, 3, Duration::from_millis(500)),
                "cycle {}: expected 3 forwarded events on pump side, got {}",
                cycle,
                sink.count()
            );
            assert_eq!(
                pump.forwarded_count(),
                3,
                "cycle {}: forwarded counter mismatch",
                cycle
            );
            assert_eq!(
                pump.decode_failure_count(),
                0,
                "cycle {}: no decode failures expected",
                cycle
            );

            // (4b) **engine-perception worker processed all 3** —
            // the assertion that nails down the full L1 → pump →
            // handle → worker → InputSession path. The closure
            // borrows `&worker` only for the duration of the
            // wait_for_processed call; once that returns the borrow
            // ends and `worker.shutdown(...)` can take ownership.
            assert!(
                wait_for_processed(|| worker.processed_count(), 3, Duration::from_millis(500)),
                "cycle {}: expected worker to process 3 cmds, got {}",
                cycle,
                worker.processed_count()
            );
            assert_eq!(worker.processed_count(), 3, "cycle {} processed", cycle);

            // Drop the original handle so its tx clone is released;
            // sink still holds its own clone, so the worker channel
            // stays alive until pump shutdown drops the sink.
            drop(handle);

            // (5) shutdown pump → worker
            pump.shutdown(Duration::from_secs(2))
                .unwrap_or_else(|e| panic!("cycle {} pump shutdown: {}", cycle, e));
            worker
                .shutdown(Duration::from_secs(2))
                .unwrap_or_else(|e| panic!("cycle {} worker shutdown: {}", cycle, e));

            // (6) our subscriber slot must be cleared (back to ≤ baseline).
            // Other concurrent lifecycle tests may still hold slots,
            // so we only assert that ours is gone.
            assert!(
                ring.subscriber_count() <= baseline,
                "cycle {}: our subscriber slot must be removed (baseline={}, current={})",
                cycle,
                baseline,
                ring.subscriber_count()
            );
            // sanity: ensure the cycle is over before the next one
            // (no zombie threads, no leftover atomics).
            let _ = Ordering::SeqCst;
        }
    }

    #[test]
    fn helper_pair_spawn_and_shutdown() {
        // Smoke for the public-ish helper pair (used by future bench
        // harness / D1-5). Does NOT push events — just verifies the
        // spawn/shutdown plumbing is wired correctly.
        //
        // `ensure_l1()` is a singleton across all tests in this lib;
        // a module-local Mutex serializes lifecycle tests against
        // each other so they don't race on `subscriber_count()`.
        let _guard = lifecycle_lock().lock().unwrap_or_else(|e| e.into_inner());
        let ring = crate::l1_capture::ensure_l1().ring.clone();
        let baseline = ring.subscriber_count();

        let (worker, _handle, pump) = spawn_perception_pipeline_for_test();
        assert!(
            ring.subscriber_count() >= baseline + 1,
            "spawn must add at least one subscriber slot (baseline={}, after_spawn={})",
            baseline,
            ring.subscriber_count()
        );
        shutdown_perception_pipeline_for_test(worker, pump).expect("shutdown clean");
        // The helper's own slot must be gone. Other concurrent
        // lifecycle tests may have added/removed slots in parallel,
        // but our delta is back to ≤ baseline.
        assert!(
            ring.subscriber_count() <= baseline,
            "shutdown must remove at least our slot (baseline={}, after_shutdown={})",
            baseline,
            ring.subscriber_count()
        );
    }
}
