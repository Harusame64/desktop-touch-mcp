//! `latest_focus` view (ADR-008 D2-B / `docs/adr-008-d2-plan.md` §5.bis).
//!
//! Singleton-key last-by-time reduction over the same [`FocusEvent`]
//! collection that feeds `current_focused_element`. Produces 0 or 1
//! "latest focused element globally" row regardless of which `hwnd`
//! emitted the event.
//!
//! ## Why this is separate from `current_focused_element`
//!
//! `current_focused_element` is keyed by `hwnd` so callers can ask
//! "what's focused inside this specific window?". Production
//! `desktop_state.ts`, however, exposes one global focused element —
//! and the focused element's `hwnd` (`UiElementRef::hwnd`) is not
//! always the foreground window's `hwnd` (a child / control HWND, or
//! the unresolved 0 sentinel from `focus_pump`, can populate it). A
//! `view_get_focused(activeHwnd)` lookup against the per-hwnd view
//! therefore misses in production-frequent cases (Codex v3 P1-4).
//!
//! `latest_focus` reduces the same input stream under the singleton
//! key `()`, so the produced row is the latest focus regardless of
//! which `hwnd` carried it. Both views share one input collection
//! (wired in `spawn_perception_worker` via the same `worker.dataflow`
//! closure), so memory growth is bounded — the raw event stream is
//! processed once and fanned out into two reduces.
//!
//! ## Operator graph
//!
//! ```text
//! FocusEvent collection
//!     │
//!     │ map: FocusEvent → ((), (LogicalTime, UiElementRef))
//!     ▼
//! reduce(): pick the (ts, ui_ref) whose ts is largest among values
//!           with positive accumulated diff. Output ((ts, ui_ref), +1).
//!     │
//!     ▼
//! inspect: apply (data, time, diff) to the view's BTreeMap-of-
//!          (LogicalTime, UiElementRef) → diff-sum (Codex v3 P1-1
//!          inspect-order tolerance pattern).
//! ```
//!
//! ## Diff bookkeeping with `LogicalTime` in the key (Codex v3 P1-1)
//!
//! DD's reduce inspect callback can fire the retraction of an old
//! winner before the assertion of a new winner (the order is not
//! guaranteed within a single time step). If the materialised state
//! were just `Option<UiElementRef>` set/cleared on each callback,
//! a stale `None` could be observed between the retraction and the
//! assertion, and a late retraction could even reset to `None` after
//! the new value was already in place.
//!
//! Mirroring `current_focused_element`'s defence, `LatestFocusView`
//! stores diff sums per `(LogicalTime, UiElementRef)` and resolves
//! the public read by reverse-walking the `BTreeMap` and returning
//! the first entry whose diff sum is positive. Convergence is
//! independent of inspect arrival order. The `LogicalTime` in the
//! key is what makes "largest ts wins" work across out-of-order
//! callbacks — without it the materialised state would lose the
//! discriminator (Codex v4 P2-13 reduce output shape).

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use differential_dataflow::collection::vec::Collection as VecCollection;

use super::current_focused_element::UiElementRef;
use crate::input::FocusEvent;
use crate::time::LogicalTime;

/// Reader-side handle on the materialised state of `latest_focus`.
/// Cheap to clone (inner is `Arc<RwLock<...>>`).
#[derive(Clone, Default)]
pub struct LatestFocusView {
    inner: Arc<RwLock<LatestFocusState>>,
}

#[derive(Default)]
struct LatestFocusState {
    /// Diff-sum bookkeeping keyed by `(LogicalTime, UiElementRef)`.
    /// `BTreeMap`'s lexicographic ordering plus `LogicalTime`'s lex
    /// ordering means iterating from the back finds the largest-ts
    /// live entry; ties on ts (which the L1 invariant says cannot
    /// happen) would tie-break by `UiElementRef`'s derived `Ord`.
    counts: BTreeMap<(LogicalTime, UiElementRef), i64>,
}

impl LatestFocusView {
    pub fn new() -> Self {
        Self::default()
    }

    /// Latest globally-focused element, if any. `None` when no event
    /// has yet been released by the dataflow's reduce + watermark.
    pub fn snapshot(&self) -> Option<UiElementRef> {
        let g = self.inner.read().expect("LatestFocusView RwLock poisoned");
        g.counts
            .iter()
            .rev()
            .find_map(|((_, ui_ref), &c)| if c > 0 { Some(ui_ref.clone()) } else { None })
    }

    /// Number of `(LogicalTime, UiElementRef)` keys with a positive
    /// diff sum. In a quiescent state (after retractions settle) this
    /// is 0 or 1; transiently during a focus change it can be 2.
    pub fn len(&self) -> usize {
        let g = self.inner.read().expect("LatestFocusView RwLock poisoned");
        g.counts.values().filter(|&&c| c > 0).count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Apply a diff observation. Internal — called from the timely
    /// worker's inspect closure inside [`build`]. `pub(crate)` so
    /// tests inside the crate can exercise the bookkeeping directly.
    pub(crate) fn apply_diff(&self, ts: LogicalTime, value: UiElementRef, diff: i64) {
        let mut g = self.inner.write().expect("LatestFocusView RwLock poisoned");
        let key = (ts, value);
        let new = g.counts.get(&key).copied().unwrap_or(0) + diff;
        debug_assert!(
            new >= 0,
            "negative diff sum in latest_focus, ts={:?} new={}",
            key.0,
            new
        );
        if new <= 0 {
            g.counts.remove(&key);
        } else {
            g.counts.insert(key, new);
        }
    }
}

/// Wire the `latest_focus` operator graph onto `events`. Same
/// caller-creates-view-ahead pattern as `current_focused_element::build`.
pub fn build<'scope>(
    events: VecCollection<'scope, LogicalTime, FocusEvent, isize>,
    view: LatestFocusView,
) {
    let view_for_inspect = view;

    events
        .map(|ev: FocusEvent| {
            let ts = ev.logical_time();
            let value = UiElementRef::from_event(&ev);
            // Singleton key `()`. The reduce sees one collection
            // worth of values and picks the largest-ts live one.
            ((), (ts, value))
        })
        .reduce(|_unit, input, output| {
            let mut best: Option<&(LogicalTime, UiElementRef)> = None;
            for (val_ref, diff) in input.iter() {
                if *diff <= 0 {
                    continue;
                }
                let cand: &(LogicalTime, UiElementRef) = *val_ref;
                match best {
                    None => best = Some(cand),
                    Some(b) if cand.0 > b.0 => best = Some(cand),
                    _ => {}
                }
            }
            if let Some((ts, ui_ref)) = best {
                output.push(((ts.clone(), ui_ref.clone()), 1));
            }
        })
        .inspect(move |(unit_and_value, _time, diff): &(((), (LogicalTime, UiElementRef)), LogicalTime, isize)| {
            // The reduce output is keyed by `()` so DD lifts the row
            // into `((), (ts, ui_ref))`. We destructure here.
            let (_unit, (ts, ui_ref)) = unit_and_value;
            view_for_inspect.apply_diff(ts.clone(), ui_ref.clone(), *diff as i64);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(wc: u64, sub: u32) -> LogicalTime {
        LogicalTime::new(wc, sub)
    }

    fn ref_(name: &str) -> UiElementRef {
        UiElementRef {
            name: name.into(),
            automation_id: None,
            control_type: 50000,
            window_title: "Win".into(),
        }
    }

    #[test]
    fn empty_view_snapshot_returns_none() {
        let v = LatestFocusView::new();
        assert!(v.is_empty());
        assert_eq!(v.snapshot(), None);
    }

    #[test]
    fn apply_diff_returns_largest_ts_live() {
        let v = LatestFocusView::new();
        v.apply_diff(ts(100, 0), ref_("a"), 1);
        v.apply_diff(ts(200, 0), ref_("b"), 1);
        // Both live; reverse-walk picks the larger-ts entry.
        assert_eq!(v.snapshot().unwrap().name, "b");
    }

    #[test]
    fn retraction_first_then_assertion_settles() {
        // Codex v3 P1-1 inspect-order tolerance: retraction can
        // arrive before the matching assertion. The view must still
        // converge to the assertion.
        let v = LatestFocusView::new();
        v.apply_diff(ts(100, 0), ref_("old"), 1);
        // Now focus moves: retraction of "old" arrives BEFORE the
        // assertion of "new".
        v.apply_diff(ts(100, 0), ref_("old"), -1);
        v.apply_diff(ts(200, 0), ref_("new"), 1);
        assert_eq!(v.snapshot().unwrap().name, "new");
    }

    #[test]
    fn assertion_first_then_retraction_settles() {
        let v = LatestFocusView::new();
        v.apply_diff(ts(100, 0), ref_("old"), 1);
        // Assertion of new value arrives FIRST, then retraction of
        // old. The view must end up with "new".
        v.apply_diff(ts(200, 0), ref_("new"), 1);
        v.apply_diff(ts(100, 0), ref_("old"), -1);
        assert_eq!(v.snapshot().unwrap().name, "new");
    }

    #[test]
    fn full_retraction_evicts() {
        let v = LatestFocusView::new();
        v.apply_diff(ts(100, 0), ref_("a"), 1);
        v.apply_diff(ts(100, 0), ref_("a"), -1);
        assert!(v.is_empty());
        assert_eq!(v.snapshot(), None);
    }

    #[test]
    fn same_wallclock_different_sub_ordinal_picks_higher_sub() {
        let v = LatestFocusView::new();
        v.apply_diff(ts(100, 0), ref_("a"), 1);
        v.apply_diff(ts(100, 5), ref_("b"), 1);
        // Higher sub_ordinal at the same wallclock wins.
        assert_eq!(v.snapshot().unwrap().name, "b");
    }
}
