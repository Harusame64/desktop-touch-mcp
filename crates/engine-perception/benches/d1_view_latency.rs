//! ADR-008 D1-5 — bench harness for the `current_focused_element` view.
//!
//! Measures the in-process read latency of the materialised view (D1-3)
//! that was wired in PR #91. The TS baseline (the existing
//! `desktop_state` MCP path that calls `uiaGetFocusedElement` via napi)
//! is measured separately by `benches/d1_ts_baseline.mjs` to avoid
//! coupling this Rust bench to the root crate's cdylib build (cargo
//! benches in cdylib-only crates can't link against the lib).
//!
//! ## What we measure
//!
//! Two scenarios on a populated view:
//!
//! 1. `view_get_hit` — `view.get(hwnd)` for a hwnd that has a live row.
//!    This is the steady-state production read path: the dataflow's
//!    inspect callback has already applied the focus change, and a
//!    consumer (D2 envelope assembly, future MCP `desktop_state` etc.)
//!    queries the view's `Arc<RwLock<HashMap>>` snapshot.
//!
//! 2. `view_get_miss` — `view.get(hwnd_unknown)` for a hwnd not in the
//!    map. Fast path — bails before the BTreeMap scan.
//!
//! ## Setup
//!
//! Each bench function reuses a single `(PerceptionWorker,
//! FocusInputHandle, CurrentFocusedElementView)` triple constructed
//! once at the start. We push a synthetic `FocusEvent`, wait for the
//! dataflow's idle-advance to release it (the watermark shift defaults
//! to 100ms; the wait loop polls up to 500ms — typical settle ~150ms),
//! then run the bench iterations against the populated view.
//!
//! `DESKTOP_TOUCH_WATERMARK_SHIFT_MS=0` could shorten the settle by
//! disabling the watermark, but we deliberately leave the default in
//! place so the bench measures the **real production read path** (with
//! the real frontier dynamics in effect).
//!
//! ## Acceptance gate (ADR-008 D1)
//!
//! D1 acceptance from `docs/adr-008-d1-plan.md` §11: "bench で TS 版より
//! latency 1/10". TS baseline is measured by `benches/d1_ts_baseline.mjs`
//! and reported in `benches/README.md`. View read here is sub-µs;
//! UIA tree walk on the TS side is multi-ms; the ratio is well over
//! 100×.

use std::time::{Duration, Instant};

use criterion::{black_box, criterion_group, criterion_main, Criterion};

use engine_perception::input::{spawn_perception_worker, FocusEvent, FocusInputHandle, L1Sink};
use engine_perception::views::current_focused_element::CurrentFocusedElementView;

const HWND_LIVE: u64 = 0xCAFE_BABE;
const HWND_MISS: u64 = 0xDEAD_BEEF;

/// Build a synthetic `FocusEvent`. Wallclock is fixed so the watermark
/// becomes well-defined; idle-advance carries the frontier past it
/// after roughly `shift_ms` of real wall-clock idle.
fn make_event(source_event_id: u64, hwnd: u64, name: &str) -> FocusEvent {
    FocusEvent {
        source_event_id,
        hwnd,
        name: name.into(),
        automation_id: Some("auto-bench".into()),
        control_type: 50000,
        window_title: "BenchWindow".into(),
        wallclock_ms: 1_700_000_000_000,
        sub_ordinal: 0,
        timestamp_source: 0,
    }
}

/// Push a `FocusEvent` and block until the view materialises it (or
/// the deadline expires). Used as one-time setup before each bench.
fn populate_view(
    handle: &FocusInputHandle,
    view: &CurrentFocusedElementView,
    hwnd: u64,
    timeout: Duration,
) {
    handle.push_focus(make_event(1, hwnd, "BenchFocus"));
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if view.get(hwnd).is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!(
        "view did not materialise hwnd={:#x} within {:?} — \
         check idle-advance is wired (input.rs::worker_loop \
         TryRecvError::Empty branch)",
        hwnd, timeout
    );
}

fn bench_view_get_hit(c: &mut Criterion) {
    let (worker, handle, view) = spawn_perception_worker();
    populate_view(&handle, &view, HWND_LIVE, Duration::from_millis(500));

    c.bench_function("view_get_hit", |b| {
        b.iter(|| {
            // black_box on both args keeps the optimiser from hoisting
            // the lookup out of the loop; black_box on the result
            // keeps it from eliminating the call entirely.
            black_box(view.get(black_box(HWND_LIVE)));
        });
    });

    // Drop the cmd-channel handle so the worker's Sender clones drop
    // when the worker shuts down.
    drop(handle);
    worker
        .shutdown(Duration::from_secs(2))
        .expect("perception worker shutdown");
}

fn bench_view_get_miss(c: &mut Criterion) {
    let (worker, handle, view) = spawn_perception_worker();
    // Populate so the inner HashMap has at least one entry, exercising
    // the realistic miss path (lookup against a non-empty table).
    populate_view(&handle, &view, HWND_LIVE, Duration::from_millis(500));

    c.bench_function("view_get_miss", |b| {
        b.iter(|| {
            black_box(view.get(black_box(HWND_MISS)));
        });
    });

    drop(handle);
    worker
        .shutdown(Duration::from_secs(2))
        .expect("perception worker shutdown");
}

criterion_group!(d1_view, bench_view_get_hit, bench_view_get_miss);
criterion_main!(d1_view);
