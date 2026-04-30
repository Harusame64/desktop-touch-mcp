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
//! Three scenarios:
//!
//! 1. `view_get_hit` — **steady-state lookup**: `view.get(hwnd)` for a
//!    hwnd that has a live row. The dataflow's inspect callback has
//!    already applied the focus change; a consumer (D2 envelope
//!    assembly, future MCP `desktop_state` etc.) queries the view's
//!    `Arc<RwLock<HashMap>>` snapshot.
//!
//! 2. `view_get_miss` — **steady-state miss**: `view.get(hwnd_unknown)`
//!    for a hwnd not in the map. Fast path — bails before the BTreeMap
//!    scan.
//!
//! 3. `view_update_latency` — **engine-perception ingestion latency**:
//!    the round-trip from `handle.push_focus(ev)` to `view.get(hwnd)`
//!    reflecting `ev.name`. This includes the cmd-channel hop, the
//!    timely worker's idle/poll loop, `update_at`, watermark advance,
//!    DD reduce, inspect callback, and the `apply_diff` write under
//!    the view's RwLock. Each iteration uses a monotone-increasing
//!    `wallclock_ms` so the new event lies above the frontier; the
//!    frontier is advanced by `worker_loop`'s idle-advance branch
//!    (PR #91 P2 fix), and `WATERMARK_SHIFT_MS=0` is set so the
//!    watermark catches up within ~1ms (the worker's idle sleep).
//!
//!    NB: this is **not** "real L1 input" — pushing into the
//!    `FocusInputHandle` directly skips the L1 `EventRing` + the
//!    `src/l3_bridge/focus_pump.rs` decode hop. That hop is bounded
//!    by `recv_timeout(100ms)` + bincode decode (~µs typical), but
//!    a true ring-to-view bench needs root-crate access (cdylib
//!    constraint, see `docs/adr-008-d1-followups.md` §2.3) and is
//!    deferred to D2 (where `desktop_state` will exercise the full
//!    L1 ring → focus_pump → handle → view path under MCP transport).
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

/// **Update-latency bench** (PR #92 P2 review fix).
///
/// Measures the end-to-end latency from `handle.push_focus(ev)` to
/// `view.get(hwnd)` reflecting the new event's name. See module-level
/// docs scenario 3 for what's included / excluded from this path.
///
/// Setup notes:
///
/// - `WATERMARK_SHIFT_MS=0` — the worker's `latest_wallclock - shift`
///   watermark would otherwise add up to 100ms per iteration. With
///   shift=0 the watermark advances to `latest_wallclock` immediately;
///   idle-advance projects 1ms past anchor each loop, so the
///   just-pushed event falls below frontier within ~1 worker tick
///   (~1ms) and gets released by DD's reduce.
/// - Each iteration uses a fresh `(name, wallclock_ms)` pair so the
///   reduce sees a new "max-by-time" row and the inspect emits a
///   diff. Without uniqueness DD would consolidate identical rows
///   and the spin-wait wouldn't make progress.
/// - The wait spins on `view.get(hwnd) == Some({ name == new_name })`
///   to skip transient retraction-only states (BTreeMap diff
///   bookkeeping is convergent but order-non-deterministic — see
///   `docs/adr-008-d1-followups.md` §3.1).
fn bench_view_update_latency(c: &mut Criterion) {
    // SAFETY: this bench owns the perception worker exclusively for
    // its duration (no other test/bench in this crate reads
    // `DESKTOP_TOUCH_WATERMARK_SHIFT_MS` while we run). Restored at
    // the end so subsequent benches in the same process see the
    // default behaviour.
    let prior = std::env::var("DESKTOP_TOUCH_WATERMARK_SHIFT_MS").ok();
    unsafe {
        std::env::set_var("DESKTOP_TOUCH_WATERMARK_SHIFT_MS", "0");
    }

    let (worker, handle, view) = spawn_perception_worker();

    // Prime: drive a first event through and wait for the view to
    // materialise, so subsequent iterations measure pure update
    // latency, not first-push warm-up cost (timely worker dataflow
    // construction, etc.).
    let base_wc = 1_700_000_000_000u64;
    handle.push_focus(make_event_with(
        0, HWND_LIVE, "prime", base_wc,
    ));
    let prime_deadline = Instant::now() + Duration::from_millis(500);
    while view.get(HWND_LIVE).map(|e| e.name) != Some("prime".into()) {
        if Instant::now() >= prime_deadline {
            panic!("prime event did not materialise — idle-advance regression?");
        }
        std::thread::sleep(Duration::from_millis(1));
    }

    let mut wc_offset: u64 = 0;

    c.bench_function("view_update_latency", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                wc_offset += 1;
                let new_name = format!("upd-{}", wc_offset);
                let ev = make_event_with(
                    wc_offset,
                    HWND_LIVE,
                    &new_name,
                    base_wc + wc_offset * 10, // 10ms apart, monotone
                );

                let t0 = Instant::now();
                handle.push_focus(ev);
                // Spin until view reflects the new name. We compare
                // by name (not by Some/None) because the previous
                // iteration's row is still present until the reduce
                // retracts it; a None/Some flip would be incorrect.
                loop {
                    if let Some(elem) = view.get(HWND_LIVE) {
                        if elem.name == new_name {
                            break;
                        }
                    }
                    std::hint::spin_loop();
                }
                total += t0.elapsed();
            }
            total
        });
    });

    // Restore env first so a panic in shutdown still cleans up.
    match prior {
        Some(v) => unsafe {
            std::env::set_var("DESKTOP_TOUCH_WATERMARK_SHIFT_MS", v);
        },
        None => unsafe {
            std::env::remove_var("DESKTOP_TOUCH_WATERMARK_SHIFT_MS");
        },
    }

    drop(handle);
    worker
        .shutdown(Duration::from_secs(2))
        .expect("perception worker shutdown");
}

/// Build a synthetic FocusEvent with the supplied name + wallclock.
/// Distinct from `make_event` (the steady-state-bench helper, fixed
/// wallclock) — the update-latency bench needs monotone wallclocks
/// per iteration.
fn make_event_with(source_event_id: u64, hwnd: u64, name: &str, wallclock_ms: u64) -> FocusEvent {
    FocusEvent {
        source_event_id,
        hwnd,
        name: name.into(),
        automation_id: Some("auto-bench".into()),
        control_type: 50000,
        window_title: "BenchWindow".into(),
        wallclock_ms,
        sub_ordinal: 0,
        timestamp_source: 0,
    }
}

criterion_group!(
    d1_view,
    bench_view_get_hit,
    bench_view_get_miss,
    bench_view_update_latency
);
criterion_main!(d1_view);
