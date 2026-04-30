//! L3 Compute layer for desktop-touch-mcp (ADR-008).
//!
//! Hosts the differential-dataflow / timely-dataflow operator graph that
//! materialises views from L1 Capture events. D1 milestone provides the
//! `current_focused_element` view; D2 onwards adds more views, time-travel,
//! cyclic / lens computation, HW-accelerated views, and replay.
//!
//! D1-2 (this PR): the input pipeline (`L1Sink` + `FocusInputHandle` +
//! timely worker thread + watermark advance). D1-3 will add the
//! `current_focused_element` operator graph in a `views/` submodule.

/// L1Sink trait + pure data types received from the root crate's
/// `src/l3_bridge/` adapter. See `docs/adr-007-p5c-plan.md` §12.
pub mod input;

/// Logical time / timestamp type (`Pair<u64, u32>`). Custom because
/// timely 0.29 only impls `Refines<()>` for primitive ints, not tuples.
pub mod time;
