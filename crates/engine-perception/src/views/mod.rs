//! Materialised views over the L1 input stream.
//!
//! Each view is a separate Rust module. The convention (D2-E0
//! signature unification, `docs/adr-008-d2-e0-plan.md` §2.1 / §2.2):
//!
//! - A typed `*View` handle (cheap to clone, `Arc<RwLock<...>>` inside)
//!   exposes the read-only API consumers use to query the latest state.
//! - A `build_<view>(focus_stream)` function wires the view's
//!   operator graph onto the supplied input stream. In DD 0.23 the
//!   actual stream type is
//!   `&VecCollection<'scope, LogicalTime, FocusEvent, isize>` (i.e.
//!   `differential_dataflow::collection::vec::Collection`, not the
//!   bare `Collection<G, ...>` from older DD versions). The function
//!   constructs the view internally and returns either a
//!   `(<View>Arranged<'scope>, View)` pair where `<View>Arranged<'scope>`
//!   is a per-view module-local type alias (e.g.
//!   `CurrentFocusedElementArranged<'scope> = Arranged<'scope,
//!   TraceAgent<ValSpine<K, V, LogicalTime, isize>>>`) when the
//!   per-key arrangement needs to be reused by other subgraphs in the
//!   **same** `worker.dataflow` closure (e.g.
//!   `current_focused_element`), or just `View` (when no in-scope
//!   downstream import is planned, e.g. `latest_focus`).
//! - The returned `Arranged` is bound to the scope's `'scope`
//!   lifetime — storing it in an outside struct is statically rejected
//!   by timely's lifetime model (Codex v2 P2-9).
//!
//! D1-3 + D2-B-1 land `current_focused_element` + `latest_focus`. D2
//! onwards adds `dirty_rects_aggregate` (S2 walking-skeleton trunk),
//! `semantic_event_stream`, etc. — see `docs/views-catalog.md`.

pub mod current_focused_element;
pub mod dirty_rects_aggregate;
pub mod latest_focus;

pub use current_focused_element::{CurrentFocusedElementView, UiElementRef};
pub use dirty_rects_aggregate::DirtyRectsAggregateView;
pub use latest_focus::LatestFocusView;
