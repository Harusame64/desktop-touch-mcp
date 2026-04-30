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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

// Explicit imports (NOT `use napi::bindgen_prelude::*`) — the glob
// would shadow `std::result::Result` and break this module's
// pre-existing `Result<(), &'static str>` shutdown signatures.
use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::Win32::UI::Accessibility::UIA_CONTROLTYPE_ID;

use crate::win32::safety::napi_safe_call;

use engine_perception::input::{spawn_perception_worker, FocusInputHandle, L1Sink, PerceptionWorker};
use engine_perception::views::current_focused_element::CurrentFocusedElementView;
use engine_perception::views::latest_focus::LatestFocusView;

use crate::l1_capture::ensure_l1;

use self::focus_pump::FocusPump;

/// Test helper: spawn the full perception pipeline on the existing
/// L1 ring (`ensure_l1()`).
///
/// Order is critical (Codex v1 P2-2 / v3 P1):
///   1. Spawn the perception worker (cmd channel up, view handle ready).
///   2. Take a clone of the L1 ring `Arc`.
///   3. Spawn the pump LAST — its `spawn()` does the parent-side
///      `subscribe(...)` synchronously, so by the time this helper
///      returns, the subscription is registered with the ring and
///      a caller can `ring.push(...)` without losing events.
///
/// Returns `(worker, handle, view, pump)`. The `view` is the
/// `current_focused_element` reader-side handle (D1-3). Drop or
/// [`shutdown_perception_pipeline_for_test`] in pump → worker order.
pub(crate) fn spawn_perception_pipeline_for_test() -> (
    PerceptionWorker,
    FocusInputHandle,
    CurrentFocusedElementView,
    FocusPump,
) {
    // D2-B-1: spawn_perception_worker now returns 4 elements
    // (latest_focus_view added). Existing test callers don't need
    // the latest_focus_view, so we drop it here. Production
    // `spawn_pipeline_inner` keeps it on `PerceptionPipeline`.
    let (worker, handle, view, _latest_view) = spawn_perception_worker();
    let ring = ensure_l1().ring.clone();
    let sink: Arc<dyn L1Sink> = Arc::new(handle.clone());
    let pump = FocusPump::spawn(ring, sink);
    (worker, handle, view, pump)
}

/// Shut down a pipeline started by
/// [`spawn_perception_pipeline_for_test`]. Order: pump → worker.
/// Pump first so its `Subscription` Drop unsubscribes from the ring
/// before the worker thread joins.
///
/// Renamed from `shutdown_perception_pipeline_for_test` (D2-0,
/// 2026-04-30) to free that name for the production-lifecycle
/// `Arc<PerceptionPipeline>` API. This helper still serves
/// `spawn_perception_pipeline_for_test` callers that take ownership
/// of `(worker, pump)` directly (used in `helper_pair_spawn_and_shutdown`
/// and any future bench harness that wants per-instance lifecycle
/// without going through `PERCEPTION_SLOT`).
pub(crate) fn shutdown_spawned_pipeline_for_test(
    worker: PerceptionWorker,
    pump: FocusPump,
) -> Result<(), &'static str> {
    pump.shutdown(Duration::from_secs(2))?;
    worker.shutdown(Duration::from_secs(2))?;
    Ok(())
}

// ─── Production pipeline lifecycle (D2-0, ADR-008) ────────────────────────
//
// Mirrors the L1 ring's slot pattern (`L1_SLOT: OnceLock<Mutex<Option<
// Arc<L1Inner>>>>`, `src/l1_capture/worker.rs:227`) so callers get the
// same shutdown / restart semantics as the L1 layer.
//
// ## Why the slot is an `Arc<PerceptionPipeline>` and not a `Box`
//
// Codex review v3 P2-2: a future caller may hold an `Arc` clone past
// our shutdown (e.g. a long-running napi binding holding the view).
// `&self`-based `shutdown_with_timeout` lets us stop the internal
// threads without consuming the value, so outstanding clones that
// only read from the view handle stay valid (read paths don't depend
// on the worker thread).
//
// ## Why pump / worker live behind `Mutex<Option<...>>`
//
// `PerceptionWorker::shutdown(self, timeout)` and
// `FocusPump::shutdown(self, timeout)` are both **consume-on-shutdown**
// — they take `self`. To call them from `&self`, we hold each behind a
// `Mutex<Option<T>>` and `take()` the value before shutdown. The
// existing `is_finished()` + deadline polling lives **inside** those
// `shutdown` impls (`engine_perception::input::PerceptionWorker::shutdown`
// at `crates/engine-perception/src/input.rs:218-241`,
// `FocusPump::shutdown` mirroring it), so we just split the timeout
// budget half-and-half across pump and worker and delegate.
//
// ## Slot-clear protocol (Codex v4 P1-6, North-Star)
//
// `shutdown_perception_pipeline_for_test` MUST clear the slot only on
// success and only after `Arc::ptr_eq` confirms the slot still holds
// the same instance we shut down. The L1 layer landed this exact
// invariant in `worker.rs:267-292` (Codex PR #86 P2). We follow the
// same shape so a concurrent `ensure_perception_pipeline()` that
// re-init'd the slot mid-shutdown does not get its fresh instance
// orphaned.

/// Production-lifecycle bundle. `view` / `handle` are clone-cheap
/// read/write surfaces; `worker` and `pump` own retain-on-timeout
/// JoinHandles internally (each via its own `Mutex<Option<JoinHandle>>`),
/// so `shutdown_with_timeout(&self, ...)` can poll without consuming
/// either side.
///
/// ## Why `worker` / `pump` are NOT wrapped in `Mutex<Option<...>>` here
///
/// An earlier draft wrapped each in `Mutex<Option<PerceptionWorker>>` /
/// `Mutex<Option<FocusPump>>` and `take()`-ed before calling their
/// consume-form `shutdown(self, timeout)`. Codex review v6 P1
/// flagged that as unsound: a single failed `shutdown` would replace
/// the leg with `None`, so a later retry could observe `None` and
/// return `Ok(())` while the timed-out thread was still alive. That
/// would let `ensure_perception_pipeline()` spawn a duplicate worker
/// after `shutdown_perception_pipeline_for_test` cleared the slot.
///
/// Fix: push the retain-on-timeout invariant down into
/// `PerceptionWorker` and `FocusPump` themselves (each holds a
/// `Mutex<Option<JoinHandle<()>>>` and exposes
/// `shutdown_with_timeout(&self, ...)`). The pipeline can then store
/// them as plain fields and delegate `shutdown_with_timeout` directly.
pub struct PerceptionPipeline {
    pub view: CurrentFocusedElementView,
    /// Singleton-key "latest globally focused element" view (D2-B-1
    /// / `docs/adr-008-d2-plan.md` §5.bis). `desktop_state.ts` reads
    /// this one because the focused element's HWND is not always
    /// the foreground-window HWND (Codex v3 P1-4).
    pub latest_focus_view: LatestFocusView,
    pub handle: FocusInputHandle,
    worker: PerceptionWorker,
    pump: FocusPump,
    /// Set when `shutdown_with_timeout` returns `Err` from either leg
    /// (Codex review v8 P2-16). A poisoned pipeline has lost the
    /// retain-on-timeout safety: at minimum the pump has signalled
    /// its `shutdown` flag (so the L1 → engine forward path is
    /// stopped), and one of the legs may have its `JoinHandle`
    /// already taken — the pipeline can no longer be considered
    /// "live" for the production caller. `ensure_perception_pipeline`
    /// detects this flag and evicts the slot, retrying the shutdown
    /// once and respawning. Without this guard, the slot's
    /// `Arc<PerceptionPipeline>` would be returned by `ensure(...)`
    /// after a failed shutdown attempt, exposing callers to a
    /// half-stopped pipeline that no longer forwards events.
    poisoned: AtomicBool,
}

impl PerceptionPipeline {
    /// Stop the pump and worker threads with a combined deadline of
    /// `timeout`. Order: pump → worker (Codex v3 P2-2 + v4 P2-12 +
    /// `docs/adr-008-d1-plan.md` §5.3). Each leg gets `timeout / 2`.
    ///
    /// On `Err`, **both legs retain their JoinHandles internally**
    /// (Codex v6 P1) — a later call with a longer timeout resumes
    /// polling the same threads. The slot for the pipeline (in
    /// `PERCEPTION_SLOT`) retains the original `Arc<PerceptionPipeline>`
    /// so a later `ensure_perception_pipeline()` returns the same
    /// instance and does NOT spawn a second worker.
    ///
    /// **Poison on first failure** (Codex v8 P2-16): if either leg
    /// fails (or both), we set `self.poisoned`. The retain-Arc is
    /// still useful for a `shutdown_perception_pipeline_for_test`
    /// retry path (which does not re-check `poisoned`), but
    /// `ensure_perception_pipeline()` checks it and evicts the slot
    /// instead of handing out a half-stopped pipeline.
    pub fn shutdown_with_timeout(&self, timeout: Duration) -> Result<(), &'static str> {
        let half = timeout / 2;
        let pump_result = self.pump.shutdown_with_timeout(half);
        // Attempt the worker leg even if the pump failed — its
        // JoinHandle is retained on Err either way, so a retry
        // path can still complete it.
        let worker_result = self.worker.shutdown_with_timeout(half);

        match (pump_result, worker_result) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(e), _) | (_, Err(e)) => {
                // Either leg's failure means the pipeline is no
                // longer fully live: pump.shutdown stored `true` on
                // its own shutdown AtomicBool before polling, so
                // even if the pump's JoinHandle was retained, its
                // forwarder thread is winding down. Mark poisoned
                // so `ensure_perception_pipeline()` can evict.
                self.poisoned.store(true, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    /// Whether `shutdown_with_timeout` has ever failed on this
    /// pipeline. A poisoned pipeline must not be returned from
    /// `ensure_perception_pipeline()` to a fresh production caller —
    /// at best the pump has stopped forwarding L1 events, at worst
    /// one or both threads are still alive but in an undefined
    /// post-signal state. Callers that already hold an `Arc` to a
    /// poisoned pipeline can still read `view`/`latest_focus_view`
    /// safely (those are pure data) but should not push new events
    /// or expect new ones from L1.
    pub fn is_poisoned(&self) -> bool {
        self.poisoned.load(Ordering::Acquire)
    }
}

// Slot pattern: identical shape to `L1_SLOT` in
// `src/l1_capture/worker.rs:227`.
static PERCEPTION_SLOT: OnceLock<Mutex<Option<Arc<PerceptionPipeline>>>> = OnceLock::new();

/// Lazy-init the production perception pipeline. Returns a clone of
/// the shared `Arc<PerceptionPipeline>` — concurrent callers all see
/// the same instance (or, in the poisoned-but-stuck case below, the
/// same poisoned instance), mirroring `ensure_l1()` (`worker.rs:229`).
///
/// First call spawns the perception worker, takes the L1 ring from
/// `ensure_l1()`, and starts the focus pump. Subsequent calls simply
/// `Arc::clone` the existing slot.
///
/// ## Poisoned-slot handling (Codex review v8 P2-16 + v9 P2-17)
///
/// If a previous `shutdown_with_timeout` returned `Err`, the slot's
/// pipeline is marked poisoned (one or both legs are no longer
/// live, see `PerceptionPipeline::is_poisoned`). On the next
/// `ensure_perception_pipeline()` call we attempt **one best-effort
/// short-timeout retry** (100ms). The slot is then handled by the
/// outcome of that retry:
///
///   - **Retry succeeded** → both threads have joined, the slot can
///     safely host a fresh pipeline. We clear the slot and the
///     `if guard.is_none()` arm below spawns a new instance.
///   - **Retry failed** → at least one thread is still running. We
///     leave the slot pointing at the poisoned `Arc` and return it.
///     **Spawning a fresh pipeline now would create a duplicate
///     worker** (Codex v9 P2-17), violating the v6 P1 北極星
///     ("shutdown failure must never cause two simultaneously live
///     workers"). Callers detect this case via
///     [`PerceptionPipeline::is_poisoned`] and may invoke
///     `shutdown_perception_pipeline_for_test(longer_timeout)` to
///     clear the slot once the stuck thread eventually exits.
///
/// Outstanding `Arc` clones to a poisoned pipeline keep their
/// `view`/`latest_focus_view` reads safe (those are pure data) but
/// are no longer the slot's "live" instance.
pub fn ensure_perception_pipeline() -> Arc<PerceptionPipeline> {
    let cell = PERCEPTION_SLOT.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());

    // Poisoned-slot handling. Only evict on a successful retry —
    // otherwise spawning a fresh pipeline beside a still-running
    // poisoned worker would create two simultaneously live workers
    // (Codex v9 P2-17 / v6 P1 北極星 regression).
    if let Some(existing) = guard.as_ref() {
        if existing.is_poisoned() {
            // The retry runs `shutdown_with_timeout` which, after the
            // pipeline is already poisoned, is allowed to be a no-op
            // for any leg whose JoinHandle was already taken on a
            // previous attempt. The leg(s) still holding handles
            // resume polling.
            if existing
                .shutdown_with_timeout(Duration::from_millis(100))
                .is_ok()
            {
                // Clean — both legs are gone. Clear the slot; the
                // spawn block below will respawn fresh.
                *guard = None;
            }
            // Else: at least one thread is still alive. Retain the
            // slot pointing at the poisoned Arc so we don't spawn a
            // duplicate. The next ensure() / explicit shutdown call
            // can retry; the caller observes the retained poisoned
            // pipeline via the return value's `is_poisoned()`.
        }
    }

    if guard.is_none() {
        *guard = Some(Arc::new(spawn_pipeline_inner()));
    }
    Arc::clone(guard.as_ref().expect("just inserted Some"))
}

/// Shut down the slot-held pipeline and clear the slot **only if**
/// the shutdown succeeded AND the slot still holds the same `Arc`
/// we were shutting down (Codex v4 P1-6 — slot-clear-on-success-only).
///
/// Returns `Ok(())` when:
///   - The slot was empty (nothing to do, idempotent).
///   - The pipeline cleanly shut down within `timeout`.
///
/// Returns `Err` when the pump or worker missed the deadline. In that
/// case **the slot retains the original `Arc<PerceptionPipeline>`**
/// (we never removed it from the slot — `pipeline_arc` is just a
/// borrowed clone, not a take). The caller can retry with a longer
/// timeout, or call `ensure_perception_pipeline()` to keep using the
/// still-running instance — either way we never spawn a second
/// worker, preserving the singleton invariant.
///
/// Mirrors `shutdown_l1_for_test` in `src/l1_capture/worker.rs:252`.
pub(crate) fn shutdown_perception_pipeline_for_test(
    timeout: Duration,
) -> Result<(), &'static str> {
    let cell = match PERCEPTION_SLOT.get() {
        Some(c) => c,
        None => return Ok(()), // never initialised
    };
    // Borrow the Arc out of the slot without removing it yet — we need
    // confirmation that the threads stopped before we let
    // `ensure_perception_pipeline()` spawn a fresh one.
    let pipeline_arc = {
        let guard = cell.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(arc) => Arc::clone(arc),
            None => return Ok(()),
        }
    };
    match pipeline_arc.shutdown_with_timeout(timeout) {
        Ok(()) => {
            // Threads confirmed joined. Clear the slot **only if** it
            // still holds the same `Arc` we shut down. A concurrent
            // caller may have cleared it and re-spawned a fresh
            // instance via `ensure_perception_pipeline()`; clearing
            // here would orphan that new pipeline. Mirrors the L1
            // safeguard from `worker.rs:269-284` (Codex PR #86 P2).
            let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
            if guard
                .as_ref()
                .map(|current| Arc::ptr_eq(current, &pipeline_arc))
                .unwrap_or(false)
            {
                *guard = None;
            }
            Ok(())
        }
        Err(e) => {
            // Slot retains the original Arc. The next ensure() returns
            // the same (potentially still-running) handle. Caller sees
            // the timeout error and can retry. NEVER clear the slot on
            // failure — that would let `ensure_perception_pipeline()`
            // spawn a second worker, breaking the singleton invariant
            // (Codex v4 P1-6, North-Star regression target).
            Err(e)
        }
    }
}

/// Build a fresh `PerceptionPipeline` — used by
/// `ensure_perception_pipeline` for first init and by
/// `five_cycle_ensure_shutdown` between cycles. Wires the worker and
/// pump in the same order as `spawn_perception_pipeline_for_test` so
/// the parent-side `subscribe(...)` runs synchronously (Codex v3 P1).
fn spawn_pipeline_inner() -> PerceptionPipeline {
    let (worker, handle, view, latest_focus_view) = spawn_perception_worker();
    let ring = ensure_l1().ring.clone();
    let sink: Arc<dyn L1Sink> = Arc::new(handle.clone());
    let pump = FocusPump::spawn(ring, sink);
    PerceptionPipeline {
        view,
        latest_focus_view,
        handle,
        worker,
        pump,
        poisoned: AtomicBool::new(false),
    }
}

// ─── napi-exposed view read API (D2-B-1) ──────────────────────────────────
//
// `view_get_focused` is the seam through which `desktop_state.ts`'s
// focus-only path replacement reads the perception engine's
// `latest_focus` view. The shape is intentionally identical to the
// existing UIA `focus.controlType` row in `desktop-state.ts` so the
// caller can fall through between view and UIA without restructuring
// — `controlType` is a STRING (e.g. "Button", "Pane"), not the raw
// `UIA_CONTROLTYPE_ID` u32 the engine stores (Codex v3 P1-3
// bit-equal contract). The `crate::uia::control_type_name` helper
// (`src/uia/mod.rs:27`) is the same table the existing UIA bridge
// uses, so the string mapping is shared.
//
// The `view_get_focused` call also honours the production-lifecycle
// poison flag (Codex v9 P2-17 + v3.6 contract): when the slot is
// poisoned the napi function returns `None` so the TS caller falls
// back to UIA-direct rather than serving a half-stopped pipeline.

/// Read shape returned to napi callers from [`view_get_focused`].
/// Matches `desktop-state.ts`'s existing `ElementInfo` shape: `name`,
/// `automationId`, `type` (string), `windowTitle`. The `value` field
/// is omitted because the engine doesn't carry it through (UIA
/// `ValuePattern` reads happen on the JS side).
///
/// Naming follows the existing `Native*` convention used elsewhere
/// in this addon (e.g. `NativeUiaFocusInfo`); the hand-maintained
/// `index.d.ts` / `index.js` re-exports use the same identifier.
#[napi(object)]
pub struct NativeFocusedElement {
    pub name: String,
    pub automation_id: Option<String>,
    /// Human-readable UIA control type name (e.g. "Button", "Pane",
    /// "Edit"). Mapped from the engine's raw `UIA_CONTROLTYPE_ID` via
    /// `crate::uia::control_type_name`.
    pub control_type: String,
    pub window_title: String,
}

/// Read the latest globally focused element from the perception
/// engine's `latest_focus` view. Returns `None` when:
///
///   - the perception pipeline has never received a focus event,
///   - the slot is poisoned (a previous shutdown attempt failed),
///     in which case the caller should use the UIA fallback path,
///   - or the `latest_focus` view's `snapshot()` has nothing live.
///
/// First call lazily spawns the pipeline (`ensure_perception_pipeline`).
///
/// Wrapped in `napi_safe_call` per ADR-007 §3.4 — any panic in the
/// pipeline init / view read path turns into a typed napi error
/// instead of unwinding through the addon boundary (which would
/// take down the Node process).
#[napi]
pub fn view_get_focused() -> napi::Result<Option<NativeFocusedElement>> {
    napi_safe_call("view_get_focused", || {
        let pipeline = ensure_perception_pipeline();
        if pipeline.is_poisoned() {
            return Ok(None);
        }
        let Some(ui_ref) = pipeline.latest_focus_view.snapshot() else {
            return Ok(None);
        };
        Ok(Some(NativeFocusedElement {
            name: ui_ref.name,
            automation_id: ui_ref.automation_id,
            control_type: crate::uia::control_type_name(UIA_CONTROLTYPE_ID(
                ui_ref.control_type as i32,
            ))
            .to_string(),
            window_title: ui_ref.window_title,
        }))
    })
}

/// Diagnostic snapshot of the perception pipeline's runtime state.
/// `desktop_state.ts` and `server_status` use this to surface when
/// the view path is unavailable (so the UIA fallback isn't silent).
#[napi(object)]
pub struct NativeViewFocusedPipelineStatus {
    /// `true` once `ensure_perception_pipeline` has spawned at least
    /// one pipeline in this process.
    pub initialized: bool,
    /// `true` when the slot's current pipeline has had a failed
    /// shutdown (Codex v9 P2-17). Callers should fall back to UIA.
    pub poisoned: bool,
    /// Cumulative `Cmd::PushFocus` count the worker has dequeued
    /// and run through `update_at` + `flush`. 0 when the pipeline
    /// is not yet initialized.
    pub processed_count: BigInt,
}

#[napi]
pub fn view_focused_pipeline_status() -> napi::Result<NativeViewFocusedPipelineStatus> {
    napi_safe_call("view_focused_pipeline_status", || {
        let status = match PERCEPTION_SLOT.get() {
            None => NativeViewFocusedPipelineStatus {
                initialized: false,
                poisoned: false,
                processed_count: BigInt::from(0u64),
            },
            Some(cell) => {
                let g = cell.lock().unwrap_or_else(|e| e.into_inner());
                match g.as_ref() {
                    None => NativeViewFocusedPipelineStatus {
                        initialized: false,
                        poisoned: false,
                        processed_count: BigInt::from(0u64),
                    },
                    Some(pipeline) => NativeViewFocusedPipelineStatus {
                        initialized: true,
                        poisoned: pipeline.is_poisoned(),
                        processed_count: BigInt::from(pipeline.worker.processed_count()),
                    },
                }
            }
        };
        Ok(status)
    })
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
    ///
    /// D2-0 (2026-04-30): exposed as `pub(super)` so the production-
    /// lifecycle test module reuses the same lock — both modules
    /// touch `ensure_l1()` and `PERCEPTION_SLOT` so they must
    /// serialize against each other, not just within their own module.
    pub(super) fn lifecycle_lock() -> &'static Mutex<()> {
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
        // 200ms-spaced wallclocks (per seq) so the input's watermark
        // advances past earlier seqs after the later ones land — the
        // default 100ms watermark shift means events whose
        // wallclock_ms is within 100ms of the latest stay below the
        // frontier and are not yet released by the dataflow. With a
        // 200ms gap, seq 0 and 1 get released after 3 pushes; seq 2
        // sits at the frontier and is not asserted on.
        let internal = InternalEvent {
            envelope_version: 1,
            event_id: 0,
            wallclock_ms: 1_800_000_000_000
                + cycle as u64 * 10_000
                + seq as u64 * 200,
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
            // confirm cmds crossed into the dataflow path; the view
            // exposes the materialised current_focused_element state).
            let (worker, handle, view, _latest_view) =
                engine_perception::input::spawn_perception_worker();

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

            // (4c) D1-3 view assertion — the dataflow's reduce + inspect
            // updated the view's per-hwnd state. With 200ms-spaced
            // wallclocks (see push_focus_to_ring), seq 0 and 1 fall
            // strictly below the input's watermark immediately after
            // seq 2's push (frontier = latest_wallclock - 100ms
            // shift). seq 2 itself starts at the frontier and is
            // released slightly later by idle-advance (PR #91 P2).
            // Wait for all 3 to appear.
            let h0 = 0xD000_u64 + cycle as u64 * 16;
            let h1 = 0xD000_u64 + cycle as u64 * 16 + 1;
            let h2 = 0xD000_u64 + cycle as u64 * 16 + 2;
            let view_for_wait = view.clone();
            let all_settled = {
                let deadline = Instant::now() + Duration::from_millis(500);
                let mut got = false;
                while Instant::now() < deadline {
                    if view_for_wait.get(h0).is_some()
                        && view_for_wait.get(h1).is_some()
                        && view_for_wait.get(h2).is_some()
                    {
                        got = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                got
            };
            assert!(
                all_settled,
                "cycle {}: view did not settle 3 hwnds (idle-advance): \
                 h0={:?} h1={:?} h2={:?}",
                cycle,
                view.get(h0).map(|e| e.name),
                view.get(h1).map(|e| e.name),
                view.get(h2).map(|e| e.name),
            );
            let elem0 = view.get(h0).expect("h0 live");
            assert_eq!(elem0.window_title, format!("LifecycleWin{}", cycle));
            assert_eq!(elem0.name, format!("Cyc{}Seq{}", cycle, 0));
            let elem1 = view.get(h1).expect("h1 live");
            assert_eq!(elem1.name, format!("Cyc{}Seq{}", cycle, 1));
            let elem2 = view.get(h2).expect("h2 live");
            assert_eq!(elem2.name, format!("Cyc{}Seq{}", cycle, 2));

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

        let (worker, _handle, view, pump) = spawn_perception_pipeline_for_test();
        assert!(
            ring.subscriber_count() >= baseline + 1,
            "spawn must add at least one subscriber slot (baseline={}, after_spawn={})",
            baseline,
            ring.subscriber_count()
        );
        // No events pushed → view stays empty.
        assert!(view.is_empty(), "fresh pipeline view should be empty");
        shutdown_spawned_pipeline_for_test(worker, pump).expect("shutdown clean");
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

// ─── Production pipeline lifecycle tests (D2-0, ADR-008) ──────────────────
//
// Cover the slot pattern's correctness contracts (Codex review v3
// P2-2, v4 P1-6, v4 P2-12). The five tests below are deliberately
// race-free; the timeout-failure cases (drain a worker that ignores
// `Cmd::Shutdown`, observe the slot retains the original `Arc`) need
// a test-only fixture in `engine-perception` and are tracked in
// `docs/adr-008-d2-plan.md` §10 OQ #14.
#[cfg(test)]
mod production_pipeline_lifecycle_tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    use crate::l1_capture::{
        encode_payload, EventKind, InternalEvent, TimestampSource, UiElementRef,
        UiaFocusChangedPayload,
    };

    /// Reuse the lifecycle_tests serialization lock so production-
    /// lifecycle tests don't race with the existing 5-cycle test on
    /// `PERCEPTION_SLOT` or the global L1 ring.
    fn lifecycle_lock() -> &'static std::sync::Mutex<()> {
        super::lifecycle_tests::lifecycle_lock()
    }

    /// Drain `PERCEPTION_SLOT` if a previous test left it populated.
    /// `shutdown_perception_pipeline_for_test` is idempotent — `Ok(())`
    /// when the slot is already empty.
    fn drain_slot() {
        let _ = shutdown_perception_pipeline_for_test(Duration::from_secs(2));
    }

    fn push_one_focus_event(ring: &crate::l1_capture::EventRing, hwnd: u64, name: &str, wc: u64) {
        let payload = UiaFocusChangedPayload {
            before: None,
            after: Some(UiElementRef {
                hwnd,
                name: name.into(),
                automation_id: None,
                control_type: 50000,
            }),
            window_title: "ProductionLifecycle".into(),
        };
        let internal = InternalEvent {
            envelope_version: 1,
            event_id: 0,
            wallclock_ms: wc,
            sub_ordinal: 0,
            timestamp_source: TimestampSource::StdTime as u8,
            kind: EventKind::UiaFocusChanged as u16,
            payload: encode_payload(&payload),
            session_id: None,
            tool_call_id: None,
        };
        ring.push(internal);
    }

    /// Test 1 — concurrent `ensure_perception_pipeline()` calls return
    /// the **same** `Arc<PerceptionPipeline>` instance (Codex v3 P2-2).
    /// Mirrors `ensure_l1_returns_same_instance` (`worker.rs:337`).
    #[test]
    fn ensure_returns_same_arc_under_concurrent_calls() {
        let _guard = lifecycle_lock().lock().unwrap_or_else(|e| e.into_inner());
        drain_slot();

        const N: usize = 32;
        let barrier = Arc::new(Barrier::new(N));
        let baseline = ensure_perception_pipeline();
        // Raw pointers aren't Send; transport identity via `usize`.
        let baseline_addr = Arc::as_ptr(&baseline) as usize;

        let handles: Vec<_> = (0..N)
            .map(|_| {
                let b = Arc::clone(&barrier);
                thread::spawn(move || -> usize {
                    b.wait();
                    let p = ensure_perception_pipeline();
                    Arc::as_ptr(&p) as usize
                })
            })
            .collect();
        for h in handles {
            let addr = h.join().expect("thread join");
            assert_eq!(
                addr, baseline_addr,
                "all concurrent ensure_perception_pipeline() must return the same Arc"
            );
        }

        shutdown_perception_pipeline_for_test(Duration::from_secs(2))
            .expect("clean shutdown");
    }

    /// Test 2 — calling `shutdown_perception_pipeline_for_test` twice
    /// is idempotent. Second call returns `Ok(())` because the slot
    /// is already empty (no work to do).
    #[test]
    fn double_shutdown_is_idempotent() {
        let _guard = lifecycle_lock().lock().unwrap_or_else(|e| e.into_inner());
        drain_slot();

        let _p = ensure_perception_pipeline();
        shutdown_perception_pipeline_for_test(Duration::from_secs(2))
            .expect("first shutdown clean");
        shutdown_perception_pipeline_for_test(Duration::from_secs(2))
            .expect("second shutdown is a no-op");
    }

    /// Test 3 — 5-cycle ensure → shutdown without leaks. Mirrors the
    /// L1 layer's `worker.rs:345` 5-cycle test (ADR-007 §11.3). Each
    /// cycle: spawn a fresh pipeline, hold a clone past shutdown,
    /// shut down cleanly, drop the clone post-shutdown. The slot
    /// identity guarantee (slot clears on success → next ensure
    /// returns a fresh Arc) is pinned separately by Test 5
    /// `slot_clears_after_clean_shutdown` — comparing `Arc::as_ptr`
    /// across cycles here would race the allocator, which legitimately
    /// reuses freed heap slots.
    #[test]
    fn five_cycle_ensure_shutdown() {
        let _guard = lifecycle_lock().lock().unwrap_or_else(|e| e.into_inner());
        drain_slot();

        for cycle in 0..5 {
            let p = ensure_perception_pipeline();
            // Hold an extra clone here too — must not block shutdown
            // (Codex v3 P2-2). Drop happens at the end of the cycle.
            let hold = Arc::clone(&p);
            drop(p);
            shutdown_perception_pipeline_for_test(Duration::from_secs(2))
                .unwrap_or_else(|e| panic!("cycle {} shutdown: {}", cycle, e));
            // Read-handle on the clone must remain safe post-shutdown.
            let _ = hold.view.is_empty();
            drop(hold);
        }
    }

    /// Test 4 — an `Arc<PerceptionPipeline>` clone outliving
    /// `shutdown_perception_pipeline_for_test` does NOT block the
    /// shutdown (because `shutdown_with_timeout(&self)` only needs
    /// `&self` to take internal `Mutex<Option<...>>` slots, not
    /// ownership of the `Arc`) and the surviving clone's `view`
    /// snapshot remains readable post-shutdown (Codex v3 P2-2).
    #[test]
    fn arc_clone_outliving_shutdown_is_safe() {
        let _guard = lifecycle_lock().lock().unwrap_or_else(|e| e.into_inner());
        drain_slot();

        let p = ensure_perception_pipeline();
        let hold = Arc::clone(&p);

        // Push one event so the view has something to read after
        // shutdown (otherwise it's just empty either way).
        let ring = ensure_l1().ring.clone();
        push_one_focus_event(&ring, 0xE001, "OutlivingShutdown", 1_900_000_000_000);
        // Allow the pipeline to materialise the event.
        thread::sleep(Duration::from_millis(150));

        // Drop the original handle, then shutdown — clone is still alive.
        drop(p);
        shutdown_perception_pipeline_for_test(Duration::from_secs(2))
            .expect("shutdown succeeds despite outstanding Arc clone");

        // Post-shutdown reads from the held clone must NOT panic.
        // The view's underlying `Arc<RwLock<...>>` outlives the
        // worker thread; `is_empty()` / `len()` / `get()` only read
        // the BTreeMap, no thread interaction.
        let _ = hold.view.is_empty();
        let _ = hold.view.len();
        let _ = hold.view.get(0xE001);

        drop(hold);
    }

    /// Test 5 (continued below: 6 + 7 cover the timeout failure path
    /// previously deferred under OQ #14 — possible without a worker-
    /// blocking fixture because the new `shutdown_with_timeout(&self, ...)`
    /// API takes a `Duration` and we can pass `Duration::from_nanos(1)`
    /// to force the deadline to expire before the worker can finish
    /// joining; the `JoinHandle` is then retained per Codex v6 P1).
    ///
    /// Test 5 itself: after a clean shutdown the slot is `None` (Codex v4
    /// P1-6 slot-clear-on-success-only protocol). Asserts the slot
    /// state directly rather than via `Arc::as_ptr` comparison: the
    /// allocator legitimately reuses freed heap slots, so two
    /// successive `Arc<PerceptionPipeline>` allocations can have the
    /// same address. The contract under test is "slot is empty after
    /// success", not "next allocation is at a different address".
    #[test]
    fn slot_clears_after_clean_shutdown() {
        let _guard = lifecycle_lock().lock().unwrap_or_else(|e| e.into_inner());
        drain_slot();

        let p = ensure_perception_pipeline();
        drop(p);
        // Slot is populated after ensure.
        assert!(
            PERCEPTION_SLOT
                .get()
                .expect("slot OnceLock initialised")
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some(),
            "slot must be populated after ensure_perception_pipeline()"
        );

        shutdown_perception_pipeline_for_test(Duration::from_secs(2))
            .expect("clean shutdown");

        // Slot is cleared on successful shutdown (北極星).
        assert!(
            PERCEPTION_SLOT
                .get()
                .expect("slot OnceLock initialised")
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_none(),
            "slot must be None after successful shutdown (Codex v4 P1-6)"
        );

        // Subsequent ensure repopulates.
        let p2 = ensure_perception_pipeline();
        assert!(
            PERCEPTION_SLOT
                .get()
                .expect("slot OnceLock initialised")
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some(),
            "slot must be repopulated after second ensure"
        );
        drop(p2);
        shutdown_perception_pipeline_for_test(Duration::from_secs(2))
            .expect("teardown clean");
    }

    /// Test 6 — failed shutdown poisons the pipeline. On the next
    /// `ensure_perception_pipeline()`, a 100ms shutdown retry runs.
    /// In this test the worker is healthy (only the original
    /// 1-nanosecond deadline made it `Err`; the worker thread has
    /// long since broken on the queued `Cmd::Shutdown`), so the
    /// retry succeeds and the slot is evicted, letting the spawn
    /// branch return a fresh non-poisoned pipeline (Codex v8 P2-16).
    ///
    /// **The v9 P2-17 contract** ("only evict after a successful
    /// retry") is exercised on the success branch here. The other
    /// branch (retry fails → keep poisoned Arc, do not respawn) is
    /// tracked under §10 OQ #15 — exercising it requires a
    /// stuck-worker fixture in `engine-perception`, which is queued
    /// for D2-A alongside other fixture work.
    ///
    /// Asserts:
    ///   1. `Err` is returned (shutdown timed out).
    ///   2. The retained `Arc` reports `is_poisoned() == true`
    ///      before the next `ensure`.
    ///   3. The original Arc, still held by the test, also reports
    ///      `is_poisoned() == true` (the flag lives on the value,
    ///      not a per-Arc shadow).
    ///   4. A subsequent `ensure_perception_pipeline()` returns a
    ///      pipeline with `is_poisoned() == false` (the retry
    ///      succeeded → eviction happened → fresh spawn).
    #[test]
    fn shutdown_timeout_failure_poisons_slot_and_evicts_on_next_ensure() {
        let _guard = lifecycle_lock().lock().unwrap_or_else(|e| e.into_inner());
        drain_slot();

        let p1 = ensure_perception_pipeline();
        assert!(!p1.is_poisoned(), "fresh pipeline must not be poisoned");
        let arc1_addr = Arc::as_ptr(&p1) as usize;

        // Force a timeout. 1ns is below the polling interval (10ms)
        // so the deadline always expires before is_finished() flips.
        let result = shutdown_perception_pipeline_for_test(Duration::from_nanos(1));
        assert!(
            result.is_err(),
            "1ns deadline must produce an Err (got {:?})",
            result
        );

        // (2) slot retained, and the pipeline self-reports poisoned.
        {
            let g = PERCEPTION_SLOT
                .get()
                .expect("slot OnceLock initialised")
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let arc = g.as_ref().expect("slot still populated after timeout");
            assert_eq!(Arc::as_ptr(arc) as usize, arc1_addr);
            assert!(
                arc.is_poisoned(),
                "failed shutdown must mark pipeline poisoned (Codex v8 P2-16)"
            );
        }

        // (3) Outstanding clone also observes the poison — the flag
        // lives on the `PerceptionPipeline` value, not on a per-Arc
        // shadow. Callers holding stale clones can detect the
        // poisoned state directly.
        assert!(p1.is_poisoned(), "outstanding Arc clone observes poison");
        drop(p1);

        // (4) ensure() now triggers eviction + respawn. The new
        // pipeline is not poisoned. We can't reliably assert
        // `Arc::as_ptr(&p2) != arc1_addr` because the allocator
        // legitimately reuses freed slots; `is_poisoned()` is the
        // discriminator.
        let p2 = ensure_perception_pipeline();
        assert!(
            !p2.is_poisoned(),
            "ensure after poison must spawn a fresh (non-poisoned) pipeline"
        );
        drop(p2);

        shutdown_perception_pipeline_for_test(Duration::from_secs(2))
            .expect("teardown clean");
    }

    /// Test 7 — partial-shutdown failure scenario: pump succeeds but
    /// worker times out, then a retry completes the worker shutdown.
    /// Verifies that the per-leg retain semantics inside
    /// `PerceptionPipeline::shutdown_with_timeout` lets a failed call
    /// be resumed without entering a degraded state where one leg is
    /// gone forever (Codex v6 P1).
    ///
    /// We can't easily target only the worker for timeout (the pump
    /// shuts down faster than the worker, so a tiny timeout normally
    /// fails on the pump leg first). Instead we exercise the same
    /// invariant from the other side: an immediate-timeout shutdown
    /// followed by a successful retry must leave the pipeline
    /// completely shut down (slot None) without panicking on either
    /// leg. If either leg's JoinHandle had been consumed by the
    /// failing call (the v3.2 bug Codex v6 caught), the retry would
    /// no-op against `None` and either:
    ///   - return `Ok(())` while the thread is still alive (slot
    ///     incorrectly cleared), OR
    ///   - panic when it tries to take an already-`None` Mutex slot.
    /// Neither happens with the v3.3 retain-on-timeout design.
    #[test]
    fn pipeline_recovers_from_partial_shutdown() {
        let _guard = lifecycle_lock().lock().unwrap_or_else(|e| e.into_inner());
        drain_slot();

        let _p = ensure_perception_pipeline();

        // First attempt times out. Both legs (or at least one) miss
        // the 1ns deadline; retain semantics keep their JoinHandles.
        assert!(
            shutdown_perception_pipeline_for_test(Duration::from_nanos(1)).is_err(),
            "1ns deadline must fail"
        );

        // Slot still populated (failure path).
        assert!(
            PERCEPTION_SLOT
                .get()
                .expect("slot OnceLock initialised")
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some(),
            "slot must retain Some after timeout"
        );

        // Retry succeeds — both legs poll their retained JoinHandles,
        // observe is_finished() true (the threads have had >= 1ns to
        // exit since the previous Cmd::Shutdown / shutdown flag was
        // signalled), join cleanly. Slot clears on success.
        shutdown_perception_pipeline_for_test(Duration::from_secs(2))
            .expect("retry succeeds with retained JoinHandles");

        assert!(
            PERCEPTION_SLOT
                .get()
                .expect("slot OnceLock initialised")
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_none(),
            "slot cleared after successful retry"
        );

        // ensure() spawns a fresh pipeline (the previous one is gone).
        let p_new = ensure_perception_pipeline();
        assert!(
            PERCEPTION_SLOT
                .get()
                .expect("slot OnceLock initialised")
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some(),
            "fresh pipeline populates the slot"
        );
        drop(p_new);
        shutdown_perception_pipeline_for_test(Duration::from_secs(2))
            .expect("teardown clean");
    }

    /// Test 8 — D2-A-0 / OQ #15 (Codex v9 P2-17 retry-fail branch
    /// regression): a stuck worker that genuinely cannot honor
    /// `Cmd::Shutdown` within the 100ms retry budget MUST keep the
    /// poisoned `Arc` in the slot. `ensure_perception_pipeline()`
    /// MUST NOT spawn a duplicate worker (二重 worker spawn is the
    /// v6 P1 北極星 violation we've been guarding against).
    ///
    /// Scenario:
    ///   1. Build a fresh pipeline.
    ///   2. Use the test-fixture `block_worker_for_test(2s)` to make
    ///      the worker sleep for 2s before processing the next cmd.
    ///      Subsequent `Cmd::Shutdown` is queued but cannot be acted
    ///      on until the sleep elapses.
    ///   3. Call `shutdown_perception_pipeline_for_test(50ms)` —
    ///      worker stuck → returns `Err`. Pipeline gets poisoned.
    ///   4. Call `ensure_perception_pipeline()`. Per v3.6, the
    ///      poison-eviction retry uses 100ms timeout. The worker is
    ///      still mid-sleep, so the retry also fails.
    ///   5. **Per the v3.6 contract, the retry's failure means the
    ///      slot must NOT be cleared and the same poisoned `Arc`
    ///      must be returned**. Assert via `Arc::as_ptr` identity
    ///      AND via `is_poisoned()`.
    ///   6. Wait for the block to elapse, then a final
    ///      `shutdown_perception_pipeline_for_test(2s)` retry
    ///      cleanly resolves and clears the slot.
    #[test]
    fn poisoned_pipeline_with_stuck_worker_keeps_slot_retained_on_ensure() {
        let _guard = lifecycle_lock().lock().unwrap_or_else(|e| e.into_inner());
        drain_slot();

        let p1 = ensure_perception_pipeline();
        let arc1_addr = Arc::as_ptr(&p1) as usize;
        assert!(!p1.is_poisoned(), "fresh pipeline must not be poisoned");

        // (2) Make the worker stuck for 2 seconds.
        let block_duration = Duration::from_millis(2_000);
        p1.handle.block_worker_for_test(block_duration);

        // Give the worker a moment to dequeue the BlockForTest cmd
        // and enter its sleep — without this the next Shutdown could
        // be processed first if the channel is empty when Shutdown
        // arrives.
        std::thread::sleep(Duration::from_millis(50));

        // (3) Try to shutdown with a tight deadline. The worker is
        // sleeping → can't see Cmd::Shutdown → timeout.
        let result1 = shutdown_perception_pipeline_for_test(Duration::from_millis(50));
        assert!(
            result1.is_err(),
            "stuck worker must produce shutdown timeout (got {:?})",
            result1
        );
        assert!(
            p1.is_poisoned(),
            "failed shutdown must mark pipeline poisoned"
        );

        // (4)+(5) ensure() — poison eviction retry runs internally
        // with 100ms timeout. The worker is still sleeping, so the
        // retry also fails → slot must retain the poisoned Arc.
        let p2 = ensure_perception_pipeline();
        assert_eq!(
            Arc::as_ptr(&p2) as usize,
            arc1_addr,
            "stuck worker must NOT cause a duplicate spawn — \
             ensure() must return the same poisoned Arc (Codex v9 P2-17 北極星)"
        );
        assert!(
            p2.is_poisoned(),
            "ensure() returns the poisoned pipeline so callers can detect \
             the degraded state via is_poisoned()"
        );
        drop(p2);
        drop(p1);

        // (6) Wait for the block to elapse, then a final retry must
        // succeed. We give the worker generous time — the test
        // fixture sleep is 2s, plus we want margin for the cmd
        // queue (BlockForTest first, then Shutdown queued behind).
        std::thread::sleep(Duration::from_millis(2_100));
        shutdown_perception_pipeline_for_test(Duration::from_secs(2))
            .expect("final retry succeeds once stuck worker exits its block");

        // Slot cleared.
        assert!(
            PERCEPTION_SLOT
                .get()
                .expect("slot OnceLock initialised")
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_none(),
            "slot cleared after final clean shutdown"
        );
    }
}
