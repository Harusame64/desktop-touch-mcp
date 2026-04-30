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
//!    `wallclock_ms` (200ms apart) so the new event lies above the
//!    idle-advance-projected frontier; under v3.8 release is owned
//!    by `worker_loop`'s idle-advance branch (PR #91 P2) and the
//!    bench runs with the **production-default `WATERMARK_SHIFT_MS`
//!    (100ms)** — release is therefore floored at `shift_ms`. See
//!    `docs/adr-008-d2-plan.md` v3.8 / v3.9 for the rationale and
//!    the setup-dependence of the absolute number.
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

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use criterion::{black_box, criterion_group, criterion_main, Criterion};

use engine_perception::input::{spawn_perception_worker, FocusEvent, FocusInputHandle, L1Sink};
use engine_perception::views::current_focused_element::CurrentFocusedElementView;

// ─── D2-A-3: true p99 extraction (Codex review v8 / D1-followups §2.1)
//
// Criterion reports mean ± confidence interval, which is fine for
// `view_get_hit` (p99 ≈ mean + a few CI widths because the
// distribution is tight) but misleading for `view_update_latency`
// where the worker's cmd-channel + dataflow-step path produces a
// long tail. We need true sample-based percentiles.
//
// Approach: each bench captures Instants into a thread-local Vec
// during `b.iter_custom`, then emits a percentile summary into a
// JSON sidecar file at `target/criterion/d2_summary.json`. Each
// bench appends one record; the file is overwritten only when the
// first bench in a run starts (tracked via a one-shot Mutex).
//
// **Sample cap (Codex review v11 P2)**: the lookup benches run at
// ~100ns/iter, which at criterion's default 5s measurement window
// produces ~50M iterations. Storing 50M `Duration`s pushes
// hundreds of MB of memory and adds `Vec::push` overhead that
// criterion's `iter_custom` returned-time accounting does not
// include — skewing criterion's own measurement. Cap each bench's
// captured samples at `MAX_SAMPLES_PER_BENCH`; once the cap is
// reached subsequent iterations skip the push. p99 / p999 from
// 100k samples is statistically stable for these distributions
// (the concern was nanos-bench memory blowup, not sample count).
const MAX_SAMPLES_PER_BENCH: usize = 100_000;

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    // Nearest-rank percentile (matches criterion's internal style;
    // simple, no interpolation, robust on small samples).
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    let n = sorted.len();
    let rank = ((p * n as f64).ceil() as usize).clamp(1, n);
    sorted[rank - 1]
}

fn fmt_duration_ns(d: Duration) -> u128 {
    d.as_nanos()
}

/// Bench summary record written to `d2_summary.json`. One JSON
/// object per line (jsonl) so multiple benches can append without
/// parsing/rewriting the whole file.
struct BenchSummary {
    name: &'static str,
    n_samples: usize,
    p50_ns: u128,
    p95_ns: u128,
    p99_ns: u128,
    p999_ns: u128,
    min_ns: u128,
    max_ns: u128,
}

impl BenchSummary {
    fn write_jsonl(&self, path: &PathBuf) {
        let line = format!(
            "{{\"name\":\"{}\",\"n_samples\":{},\"p50_ns\":{},\"p95_ns\":{},\"p99_ns\":{},\"p999_ns\":{},\"min_ns\":{},\"max_ns\":{}}}\n",
            self.name,
            self.n_samples,
            self.p50_ns,
            self.p95_ns,
            self.p99_ns,
            self.p999_ns,
            self.min_ns,
            self.max_ns,
        );
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

/// Wipe the summary file the first time any bench reports in a run.
/// A `Mutex<bool>` is enough — Cargo runs benches serially per group.
static SUMMARY_RESET: Mutex<bool> = Mutex::new(false);

fn summary_path() -> PathBuf {
    PathBuf::from("target")
        .join("criterion")
        .join("d2_summary.jsonl")
}

fn report_samples(name: &'static str, mut samples: Vec<Duration>) {
    if samples.is_empty() {
        return;
    }
    samples.sort_unstable();
    let summary = BenchSummary {
        name,
        n_samples: samples.len(),
        p50_ns: fmt_duration_ns(percentile(&samples, 0.50)),
        p95_ns: fmt_duration_ns(percentile(&samples, 0.95)),
        p99_ns: fmt_duration_ns(percentile(&samples, 0.99)),
        p999_ns: fmt_duration_ns(percentile(&samples, 0.999)),
        min_ns: fmt_duration_ns(*samples.first().expect("non-empty")),
        max_ns: fmt_duration_ns(*samples.last().expect("non-empty")),
    };

    // First report in a run wipes the file.
    let path = summary_path();
    {
        let mut reset = SUMMARY_RESET.lock().unwrap_or_else(|e| e.into_inner());
        if !*reset {
            let _ = std::fs::remove_file(&path);
            *reset = true;
        }
    }
    summary.write_jsonl(&path);

    // Also echo to stdout so the bench output shows percentiles
    // alongside criterion's mean.
    eprintln!(
        "[d2-summary] {name}: n={n} p50={p50}ns p95={p95}ns p99={p99}ns p999={p999}ns min={min}ns max={max}ns",
        name = summary.name,
        n = summary.n_samples,
        p50 = summary.p50_ns,
        p95 = summary.p95_ns,
        p99 = summary.p99_ns,
        p999 = summary.p999_ns,
        min = summary.min_ns,
        max = summary.max_ns,
    );
}

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
    let (worker, handle, view, _latest_view) = spawn_perception_worker();
    populate_view(&handle, &view, HWND_LIVE, Duration::from_millis(500));

    // D2-A-3: capture iteration elapsed for percentile reporting.
    // Capped at MAX_SAMPLES_PER_BENCH (Codex v11 P2): nanos-scale
    // benches run for tens of millions of iterations under
    // criterion's default 5s window; storing every Duration would
    // burn hundreds of MB and skew criterion's iter_custom timing.
    let samples: Mutex<Vec<Duration>> =
        Mutex::new(Vec::with_capacity(MAX_SAMPLES_PER_BENCH));

    c.bench_function("view_get_hit", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            // Pre-size the per-batch buffer to the smaller of iter
            // count and the global cap; once the global cap is
            // reached we skip the push entirely so no allocation
            // happens on the hot path.
            let cap = MAX_SAMPLES_PER_BENCH
                .saturating_sub(samples.lock().unwrap_or_else(|e| e.into_inner()).len());
            let local_cap = (iters as usize).min(cap);
            let mut local: Vec<Duration> = Vec::with_capacity(local_cap);
            for _ in 0..iters {
                let t0 = Instant::now();
                black_box(view.get(black_box(HWND_LIVE)));
                let elapsed = t0.elapsed();
                total += elapsed;
                if local.len() < local_cap {
                    local.push(elapsed);
                }
            }
            if !local.is_empty() {
                samples.lock().unwrap_or_else(|e| e.into_inner()).extend(local);
            }
            total
        });
    });

    let captured = samples.into_inner().unwrap_or_else(|e| e.into_inner());
    report_samples("view_get_hit", captured);

    drop(handle);
    worker
        .shutdown(Duration::from_secs(2))
        .expect("perception worker shutdown");
}

fn bench_view_get_miss(c: &mut Criterion) {
    let (worker, handle, view, _latest_view) = spawn_perception_worker();
    populate_view(&handle, &view, HWND_LIVE, Duration::from_millis(500));

    let samples: Mutex<Vec<Duration>> =
        Mutex::new(Vec::with_capacity(MAX_SAMPLES_PER_BENCH));

    c.bench_function("view_get_miss", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            let cap = MAX_SAMPLES_PER_BENCH
                .saturating_sub(samples.lock().unwrap_or_else(|e| e.into_inner()).len());
            let local_cap = (iters as usize).min(cap);
            let mut local: Vec<Duration> = Vec::with_capacity(local_cap);
            for _ in 0..iters {
                let t0 = Instant::now();
                black_box(view.get(black_box(HWND_MISS)));
                let elapsed = t0.elapsed();
                total += elapsed;
                if local.len() < local_cap {
                    local.push(elapsed);
                }
            }
            if !local.is_empty() {
                samples.lock().unwrap_or_else(|e| e.into_inner()).extend(local);
            }
            total
        });
    });

    let captured = samples.into_inner().unwrap_or_else(|e| e.into_inner());
    report_samples("view_get_miss", captured);

    drop(handle);
    worker
        .shutdown(Duration::from_secs(2))
        .expect("perception worker shutdown");
}

/// **Update-latency bench** (PR #92 P2 review fix, v3.8 watermark
/// contract restored).
///
/// Measures the end-to-end latency from `handle.push_focus(ev)` to
/// `view.get(hwnd)` reflecting the new event's name. See module-level
/// docs scenario 3 for what's included / excluded from this path.
///
/// Setup notes (v3.8 / v3.9):
///
/// - Runs with the **production-default `WATERMARK_SHIFT_MS`**
///   (no env override). Release is therefore floored at
///   `shift_ms` (the idle-advance branch needs that much real
///   wall-clock to project past `latest_wallclock`). The previous
///   v3.7 setup forced `WATERMARK_SHIFT_MS=0` to collapse the
///   window, but that combined with v3.7's `advance_to(max_wc + 1)`
///   broke the N2 partial-order contract (Codex v10 P1/P2 / plan
///   v3.8) and is no longer used.
/// - Each iteration uses a fresh `(name, wallclock_ms)` pair so the
///   reduce sees a new "max-by-time" row and the inspect emits a
///   diff. Without uniqueness DD would consolidate identical rows
///   and the spin-wait wouldn't make progress.
/// - `wc` advances 200ms per iteration (matching the integration
///   tests in `tests/d1_minimum.rs`) so each new push lies above
///   the idle-advance-projected frontier; smaller spacings lose
///   pushes to the projection's race.
/// - The wait spins on `view.get(hwnd) == Some({ name == new_name })`
///   to skip transient retraction-only states (BTreeMap diff
///   bookkeeping is convergent but order-non-deterministic — see
///   `docs/adr-008-d1-followups.md` §3.1).
fn bench_view_update_latency(c: &mut Criterion) {
    // **D2-A v3.8 bench setup** (Codex v10 P1/P2 fix follow-up):
    //
    // The earlier D2-A v3.7 setup forced `WATERMARK_SHIFT_MS=0` to
    // collapse the watermark window — that worked when `worker_loop`
    // released events at `max_wc + 1 sub_ord` immediately after each
    // cmd batch, but that release shape broke the documented
    // out-of-order acceptance contract (Codex v10 P1/P2). v3.8 reverts
    // `worker_loop` to the D1 watermark-shift logic
    // (`advance_to(max_wc - shift_ms)`), where release is owned by the
    // idle-advance branch projecting `latest_wallclock + real_elapsed`
    // forward.
    //
    // Under v3.8:
    //   - With `shift_ms = 0` and a small `wc` increment per iteration,
    //     idle-advance can race past the next iteration's `wc`, drop
    //     it as out-of-order, and stall the spin loop. Empirically
    //     this measured ~32ms p99 — not a real latency, an interaction
    //     with the bench's own clock.
    //   - With `shift_ms = default` (100ms) and a 200ms-spaced `wc`
    //     stream (matching the integration tests in
    //     `tests/d1_minimum.rs`), each new push lies above the
    //     idle-advance-projected frontier and the spin loop measures
    //     genuine engine-perception ingestion latency.
    //
    // We deliberately do NOT override `WATERMARK_SHIFT_MS` here so the
    // bench reflects the production worker's behaviour.

    let (worker, handle, view, _latest_view) = spawn_perception_worker();

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
    // update_latency runs at ms scale so even uncapped the sample
    // count stays under 10k for a 5s criterion window. We still
    // route through the same cap path for consistency with the
    // lookup benches (Codex v11 P2 follow-through).
    let samples: Mutex<Vec<Duration>> =
        Mutex::new(Vec::with_capacity(MAX_SAMPLES_PER_BENCH.min(10_000)));

    c.bench_function("view_update_latency", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            let cap = MAX_SAMPLES_PER_BENCH
                .saturating_sub(samples.lock().unwrap_or_else(|e| e.into_inner()).len());
            let local_cap = (iters as usize).min(cap);
            let mut local: Vec<Duration> = Vec::with_capacity(local_cap);
            for _ in 0..iters {
                wc_offset += 1;
                let new_name = format!("upd-{}", wc_offset);
                // 200ms-spaced wallclocks — matches the integration
                // tests in `tests/d1_minimum.rs` so each push sits
                // above the idle-advance-projected frontier (the
                // projection adds ~real elapsed ms per iteration and
                // a 200ms gap is comfortably above that).
                let ev = make_event_with(
                    wc_offset,
                    HWND_LIVE,
                    &new_name,
                    base_wc + wc_offset * 200,
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
                let elapsed = t0.elapsed();
                total += elapsed;
                if local.len() < local_cap {
                    local.push(elapsed);
                }
            }
            if !local.is_empty() {
                samples.lock().unwrap_or_else(|e| e.into_inner()).extend(local);
            }
            total
        });
    });

    let captured = samples.into_inner().unwrap_or_else(|e| e.into_inner());
    report_samples("view_update_latency", captured);

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
