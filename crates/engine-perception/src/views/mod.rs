//! Materialised views over the L1 input stream.
//!
//! Each view is a separate Rust module. The convention:
//!
//! - A typed `*View` handle (cheap to clone, `Arc<RwLock<...>>` inside)
//!   exposes the read-only API consumers use to query the latest state.
//! - A `build(scope, &events, view)` function wires the view's
//!   operator graph into a timely dataflow scope. Caller creates the
//!   view first (so it can be returned out of the worker thread) and
//!   passes it in.
//!
//! D1-3 lands `current_focused_element` only. D2 onwards adds
//! `dirty_rects_aggregate`, `semantic_event_stream`, etc. — see
//! `docs/views-catalog.md`.

pub mod current_focused_element;
pub mod latest_focus;

pub use current_focused_element::{CurrentFocusedElementView, UiElementRef};
pub use latest_focus::LatestFocusView;
