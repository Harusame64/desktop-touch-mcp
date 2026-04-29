//! L3 Compute layer for desktop-touch-mcp (ADR-008).
//!
//! Hosts the differential-dataflow / timely-dataflow operator graph that
//! materialises views from L1 Capture events. D1 milestone provides the
//! `current_focused_element` view; D2 onwards adds more views, time-travel,
//! cyclic / lens computation, HW-accelerated views, and replay.
//!
//! Currently empty: scaffolding lands in PR-α (ADR-008 D1-0). Subsequent
//! sub-batches (D1-1 dependencies, D1-2 L1 input adapter, D1-3 view) will
//! populate this crate.
