//! L3 Compute layer for desktop-touch-mcp (ADR-008).
//!
//! Hosts the differential-dataflow / timely-dataflow operator graph that
//! materialises views from L1 Capture events. D1 milestone provides the
//! `current_focused_element` view; D2 onwards adds more views, time-travel,
//! cyclic / lens computation, HW-accelerated views, and replay.
//!
//! D1-2 landed the input pipeline (`L1Sink` + `FocusInputHandle` +
//! timely worker thread + watermark advance). D1-3 (this PR) adds the
//! `current_focused_element` operator graph in `views::`.

/// L1Sink trait + pure data types received from the root crate's
/// `src/l3_bridge/` adapter. See `docs/adr-007-p5c-plan.md` §12.
pub mod input;

/// Logical time / timestamp type (`Pair<u64, u32>`). Custom because
/// timely 0.29 only impls `Refines<()>` for primitive ints, not tuples.
pub mod time;

/// Materialised views over the L1 input stream. D1-3 lands
/// `current_focused_element`; D2-B-1 adds `latest_focus`; D2-E0
/// (this PR) unifies the build API to
/// `build_<view>(&focus_stream) -> (Arranged, View)` so subgraphs in
/// the same `worker.dataflow` closure can borrow per-key arrangements
/// (D2-E `predicted_post_state`, S2 `dirty_rects_aggregate`).
/// See `docs/views-catalog.md` + `docs/adr-008-d2-e0-plan.md`.
pub mod views;
