//! ADR-008 D1-4 — integration tests for the `current_focused_element`
//! view (D1-3) end-to-end through the timely worker thread.
//!
//! Tests in this file exercise the **public API only** —
//! `spawn_perception_worker()` + `FocusInputHandle::push_focus()` +
//! `CurrentFocusedElementView::{get, snapshot, len, is_empty}`. They
//! do NOT poke `apply_diff` directly (that's covered by the in-file
//! unit tests in `views/current_focused_element.rs`). The path
//! exercised here:
//!
//! ```text
//! handle.push_focus(ev) → cmd channel → worker → InputSession::update_at
//!     → frontier advance via watermark → reduce per-hwnd last-by-time
//!     → inspect → view.apply_diff → view.get / snapshot
//! ```
//!
//! ## Watermark caveat
//!
//! `worker_loop` advances the input frontier to `latest_wallclock_ms -
//! 100ms` (default `DESKTOP_TOUCH_WATERMARK_SHIFT_MS`). For an event
//! at logical time `(t, 0)` to be released by DD's reduce, the
//! frontier must advance strictly past it — i.e. some later event
//! must land with `wallclock_ms > t + 100`. Tests below space their
//! events ≥ 200ms apart so each push advances the frontier past the
//! preceding push, while leaving the *most recent* push at the
//! frontier (deliberately not asserted on until a follow-up "pump"
//! event arrives).
//!
//! ## Determinism
//!
//! Each test polls the view for up to 500ms with a `wait_for_view`
//! helper. 500ms is chosen as ~8× the worker's idle `step` cycle
//! (1ms sleep + worker.step) and far below the test runner's per-test
//! timeout. If the view doesn't settle in 500ms, the worker is
//! deadlocked or the operator graph is wrong — both are bugs the
//! test should fail on.

use std::time::{Duration, Instant};

use engine_perception::input::{spawn_perception_worker, FocusEvent, FocusInputHandle, L1Sink};
use engine_perception::views::current_focused_element::{
    CurrentFocusedElementView, UiElementRef,
};

const SETTLE_TIMEOUT: Duration = Duration::from_millis(500);

fn focus_event(
    source_event_id: u64,
    hwnd: u64,
    wallclock_ms: u64,
    name: &str,
    window_title: &str,
) -> FocusEvent {
    FocusEvent {
        source_event_id,
        hwnd,
        name: name.into(),
        automation_id: Some(format!("auto-{}", source_event_id)),
        control_type: 50000, // UIA_ButtonControlTypeId
        window_title: window_title.into(),
        wallclock_ms,
        sub_ordinal: 0,
        timestamp_source: 0,
    }
}

fn push_all(handle: &FocusInputHandle, events: &[FocusEvent]) {
    for ev in events {
        handle.push_focus(ev.clone());
    }
}

fn wait_for_view<F: Fn(&CurrentFocusedElementView) -> bool>(
    view: &CurrentFocusedElementView,
    timeout: Duration,
    predicate: F,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if predicate(view) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn single_focus_event_appears_in_view() {
    let (worker, handle, view) = spawn_perception_worker();
    let base = 1_700_000_000_000u64;

    // Event we want to verify (target).
    handle.push_focus(focus_event(1, 0xAAAA, base, "Edit", "Notepad"));
    // Watermark pump: 200ms later, advances the input frontier past
    // the target event so the dataflow releases the target's row.
    handle.push_focus(focus_event(2, 0xBBBB, base + 200, "Pump", "PumpWin"));

    assert!(
        wait_for_view(&view, SETTLE_TIMEOUT, |v| v.get(0xAAAA).is_some()),
        "view did not materialise hwnd=0xAAAA within {:?}; \
         snapshot={:?}",
        SETTLE_TIMEOUT,
        view.snapshot()
    );

    let elem = view.get(0xAAAA).expect("hwnd=0xAAAA must be live");
    assert_eq!(elem.name, "Edit");
    assert_eq!(elem.window_title, "Notepad");
    assert_eq!(elem.control_type, 50000);
    assert_eq!(elem.automation_id, Some("auto-1".into()));

    // Pump's hwnd is at the frontier — not yet released.
    assert!(view.get(0xBBBB).is_none(), "pump event should still be at frontier");

    worker.shutdown(Duration::from_secs(2)).expect("shutdown");
}

#[test]
fn last_by_time_per_hwnd() {
    // Three events on the same hwnd, in wallclock-increasing order.
    // The view must converge to the LATEST (highest wallclock_ms).
    let (worker, handle, view) = spawn_perception_worker();
    let base = 1_700_000_000_000u64;
    let hwnd = 0xCAFE_u64;

    push_all(
        &handle,
        &[
            focus_event(1, hwnd, base, "v1", "App"),
            focus_event(2, hwnd, base + 200, "v2", "App"),
            focus_event(3, hwnd, base + 400, "v3", "App"),
            // Pump to advance frontier past base+400.
            focus_event(4, 0xFEED, base + 600, "Pump", "PumpWin"),
        ],
    );

    assert!(
        wait_for_view(&view, SETTLE_TIMEOUT, |v| v
            .get(hwnd)
            .map(|e| e.name == "v3")
            .unwrap_or(false)),
        "view did not converge to v3; got {:?}",
        view.get(hwnd)
    );

    let elem = view.get(hwnd).expect("hwnd live");
    assert_eq!(elem.name, "v3", "last-by-time semantics");

    worker.shutdown(Duration::from_secs(2)).expect("shutdown");
}

#[test]
fn out_of_order_events_settle_to_latest_by_time() {
    // **partial-order test** (D1-4 spec): submit two events for the
    // same hwnd in REVERSE wallclock order. Watermark default 100ms
    // means both events land within the watermark window of each
    // other — neither is dropped. The view must still pick the one
    // with the higher wallclock_ms (last-by-time semantics).
    let (worker, handle, view) = spawn_perception_worker();
    let base = 1_700_000_000_000u64;
    let hwnd = 0xCAFE_u64;

    push_all(
        &handle,
        &[
            // First push sets latest_wallclock = base + 50.
            // (Subsequent push at `base` is back-dated by 50ms;
            // 50ms < 100ms shift, so it's accepted.)
            focus_event(1, hwnd, base + 50, "Latest", "App"),
            focus_event(2, hwnd, base, "Earliest", "App"),
            // Pump to advance frontier past base+50.
            focus_event(3, 0xDEAD, base + 200, "Pump", "PumpWin"),
        ],
    );

    assert!(
        wait_for_view(&view, SETTLE_TIMEOUT, |v| v
            .get(hwnd)
            .map(|e| e.name == "Latest")
            .unwrap_or(false)),
        "view did not converge under out-of-order input; got {:?}",
        view.get(hwnd)
    );

    let elem = view.get(hwnd).expect("hwnd live");
    assert_eq!(
        elem.name, "Latest",
        "out-of-order partial order must still pick highest wallclock"
    );

    worker.shutdown(Duration::from_secs(2)).expect("shutdown");
}

#[test]
fn far_back_dated_event_dropped() {
    // An event back-dated > watermark shift (100ms default) lies
    // BELOW the frontier and is dropped by the worker_loop guard.
    // Test verifies the worker does NOT crash on such an event and
    // the view continues to reflect the in-window event.
    let (worker, handle, view) = spawn_perception_worker();
    let base = 1_700_000_000_000u64;
    let hwnd = 0xCAFE_u64;

    handle.push_focus(focus_event(1, hwnd, base + 1000, "Live", "App"));
    // 500ms back-dated — far outside the 100ms watermark window.
    handle.push_focus(focus_event(2, hwnd, base + 500, "Stale", "App"));
    // Pump.
    handle.push_focus(focus_event(3, 0xDEAD, base + 1200, "Pump", "PumpWin"));

    assert!(
        wait_for_view(&view, SETTLE_TIMEOUT, |v| v
            .get(hwnd)
            .map(|e| e.name == "Live")
            .unwrap_or(false)),
        "view did not converge; got {:?}",
        view.get(hwnd)
    );

    let elem = view.get(hwnd).expect("hwnd live");
    assert_eq!(
        elem.name, "Live",
        "stale back-dated event must be dropped, in-window event survives"
    );

    worker.shutdown(Duration::from_secs(2)).expect("shutdown");
}

#[test]
fn multiple_hwnds_tracked_independently() {
    let (worker, handle, view) = spawn_perception_worker();
    let base = 1_700_000_000_000u64;

    push_all(
        &handle,
        &[
            focus_event(1, 0xA, base, "A1", "WinA"),
            focus_event(2, 0xB, base + 200, "B1", "WinB"),
            focus_event(3, 0xC, base + 400, "C1", "WinC"),
            // Pump to release all of them.
            focus_event(4, 0xFEED, base + 600, "Pump", "PumpWin"),
        ],
    );

    let want = |v: &CurrentFocusedElementView| {
        v.get(0xA).is_some() && v.get(0xB).is_some() && v.get(0xC).is_some()
    };
    assert!(
        wait_for_view(&view, SETTLE_TIMEOUT, want),
        "expected 3 hwnds live, snapshot={:?}",
        view.snapshot()
    );

    assert_eq!(view.get(0xA).unwrap().name, "A1");
    assert_eq!(view.get(0xB).unwrap().name, "B1");
    assert_eq!(view.get(0xC).unwrap().name, "C1");

    let mut snap = view.snapshot();
    snap.sort_by_key(|(h, _)| *h);
    assert_eq!(snap.len(), 3);

    worker.shutdown(Duration::from_secs(2)).expect("shutdown");
}

#[test]
fn shutdown_without_events_is_clean() {
    // Acceptance criterion (D1-4 spec): "shutdown sequence で
    // deadlock しない". Even with no events ever pushed, the worker
    // must shut down within the timeout — the cmd channel handles
    // Cmd::Shutdown synchronously.
    let (worker, _handle, view) = spawn_perception_worker();
    assert!(view.is_empty());
    let start = Instant::now();
    worker
        .shutdown(Duration::from_secs(2))
        .expect("shutdown clean");
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "shutdown should be near-instant when idle"
    );
}

#[test]
fn shutdown_with_pending_events_drains() {
    // After pushing several events but BEFORE waiting for the view to
    // settle, calling shutdown must still drain cleanly (the worker
    // pumps remaining cmds before honouring Cmd::Shutdown — see
    // worker_loop's try_recv loop). No deadlock.
    let (worker, handle, _view) = spawn_perception_worker();
    let base = 1_700_000_000_000u64;
    for i in 0..50 {
        handle.push_focus(focus_event(
            i,
            0xA000 + i as u64,
            base + (i as u64 * 50),
            "x",
            "App",
        ));
    }
    let start = Instant::now();
    worker
        .shutdown(Duration::from_secs(2))
        .expect("shutdown drained");
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[test]
fn five_cycle_spawn_run_shutdown() {
    // Stress: 5 cycles of (spawn → push → assert view → shutdown).
    // Mirrors the L1 worker / focus_pump 5-cycle tests; flushes any
    // hidden state leak across cycles.
    for cycle in 0..5u64 {
        let (worker, handle, view) = spawn_perception_worker();
        let base = 1_700_000_000_000u64 + cycle * 1_000_000;
        handle.push_focus(focus_event(
            1,
            0xC000 + cycle,
            base,
            "X",
            &format!("WX{}", cycle),
        ));
        handle.push_focus(focus_event(
            2,
            0xD000 + cycle,
            base + 200,
            "Pump",
            "PumpWin",
        ));

        assert!(
            wait_for_view(&view, SETTLE_TIMEOUT, |v| v.get(0xC000 + cycle).is_some()),
            "cycle {} did not materialise; snapshot={:?}",
            cycle,
            view.snapshot()
        );
        let elem = view.get(0xC000 + cycle).expect("live");
        assert_eq!(elem.window_title, format!("WX{}", cycle));

        worker
            .shutdown(Duration::from_secs(2))
            .unwrap_or_else(|e| panic!("cycle {} shutdown: {}", cycle, e));
    }
}

#[test]
fn ui_element_ref_projection_is_lossy() {
    // **Compile-time** check that UiElementRef has only the four
    // view-output fields. `source_event_id` / `wallclock_ms` /
    // `sub_ordinal` / `timestamp_source` are pivot data on
    // FocusEvent and must NOT leak into the view's output shape —
    // the L4 envelope layer carries the pivot in its own slot.
    //
    // If a future PR adds one of those fields to UiElementRef, the
    // struct-literal init below will fail to compile because it
    // doesn't list the new field, AND the destructured `_pat` arm
    // below will start emitting an unused-field warning.
    let r = UiElementRef {
        name: "n".into(),
        automation_id: None,
        control_type: 0,
        window_title: "w".into(),
    };
    let UiElementRef {
        name: _,
        automation_id: _,
        control_type: _,
        window_title: _,
    } = r;
}
