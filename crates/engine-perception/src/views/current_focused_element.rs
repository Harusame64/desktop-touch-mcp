//! `current_focused_element` view (ADR-008 D1-3).
//!
//! Per-hwnd last-by-time reduction over the [`FocusEvent`] collection,
//! producing a 1-row-per-hwnd state view. Contract: see
//! `docs/views-catalog.md` §3.1.
//!
//! ## Operator graph
//!
//! ```text
//! FocusEvent collection
//!     │
//!     │ map: FocusEvent → (hwnd, ((wallclock_ms, sub_ordinal), UiElementRef))
//!     ▼
//! reduce(): per-hwnd, pick the (ts, ui_ref) whose ts is largest among
//!           values with positive accumulated diff. Output one
//!           (hwnd, UiElementRef) row with diff = +1.
//!     │
//!     ▼
//! inspect: apply observed (data, time, diff) to the view's per-hwnd
//!          per-value diff-sum HashMap. A live row is one whose count
//!          > 0; rows whose count drops to 0 are evicted.
//! ```
//!
//! ## Why diff bookkeeping inside the inspect closure
//!
//! When focus moves on a given hwnd, DD's reduce retracts the previous
//! output row (-1) and asserts the new one (+1). The view's read state
//! must tolerate seeing the retraction in any order relative to the
//! assertion (DD does not guarantee within-time ordering of inspect
//! callbacks). Tracking per-(hwnd, value) diff sums keeps the view
//! convergent regardless of arrival order: any value with positive
//! sum is "live", and only values whose sum returns to zero are
//! evicted from the map.
//!
//! ## Watermark caveat
//!
//! Reads can lag the most recent push by up to the watermark shift
//! (`DESKTOP_TOUCH_WATERMARK_SHIFT_MS`, default 100ms), because DD only
//! emits output updates after the dataflow's input frontier advances
//! past a logical time. See `crates/engine-perception/src/input.rs`
//! module docs for the watermark semantics (北極星 N2).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

use differential_dataflow::collection::vec::Collection as VecCollection;

use crate::input::FocusEvent;
use crate::time::LogicalTime;

/// Output row of `current_focused_element`. Mirrors
/// `docs/views-catalog.md` §3.1. The string mapping for
/// `control_type` happens at the L4 envelope layer, not here — we
/// pass the raw `UIA_CONTROLTYPE_ID` through.
#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct UiElementRef {
    pub name: String,
    pub automation_id: Option<String>,
    pub control_type: u32,
    pub window_title: String,
}

impl UiElementRef {
    /// Project a [`FocusEvent`] into a [`UiElementRef`]. The pivot
    /// fields (`source_event_id`, `wallclock_ms`, `sub_ordinal`,
    /// `timestamp_source`) live on the event-time data axis and are
    /// not part of the view's output shape.
    pub fn from_event(ev: &FocusEvent) -> Self {
        Self {
            name: ev.name.clone(),
            automation_id: ev.automation_id.clone(),
            control_type: ev.control_type,
            window_title: ev.window_title.clone(),
        }
    }
}

/// Reader-side handle on the materialised state of the
/// `current_focused_element` view.
///
/// Cheap to clone — the inner state is `Arc<RwLock<...>>`. Reads take
/// a shared lock; the timely worker thread takes the write lock once
/// per inspect callback (typically in microseconds at D1's event rate).
#[derive(Clone, Default)]
pub struct CurrentFocusedElementView {
    inner: Arc<RwLock<ViewState>>,
}

#[derive(Default)]
struct ViewState {
    /// Per-hwnd diff-sum bookkeeping. After all retractions for a key
    /// settle, exactly one (or zero) value has a positive count; any
    /// value whose count returns to 0 is evicted from the inner map.
    by_hwnd: HashMap<u64, BTreeMap<UiElementRef, i64>>,
}

impl CurrentFocusedElementView {
    pub fn new() -> Self {
        Self::default()
    }

    /// Latest focused element for `hwnd`, if a live row exists.
    pub fn get(&self, hwnd: u64) -> Option<UiElementRef> {
        let g = self.inner.read().expect("view RwLock poisoned");
        g.by_hwnd
            .get(&hwnd)
            .and_then(|counts| counts.iter().find(|&(_, &c)| c > 0).map(|(v, _)| v.clone()))
    }

    /// Snapshot of all `(hwnd, latest)` pairs (no particular order).
    pub fn snapshot(&self) -> Vec<(u64, UiElementRef)> {
        let g = self.inner.read().expect("view RwLock poisoned");
        g.by_hwnd
            .iter()
            .filter_map(|(hwnd, counts)| {
                counts
                    .iter()
                    .find(|&(_, &c)| c > 0)
                    .map(|(v, _)| (*hwnd, v.clone()))
            })
            .collect()
    }

    /// Number of distinct hwnds with at least one live row.
    pub fn len(&self) -> usize {
        let g = self.inner.read().expect("view RwLock poisoned");
        g.by_hwnd
            .values()
            .filter(|counts| counts.iter().any(|(_, c)| *c > 0))
            .count()
    }

    /// `true` when no hwnd has a live row.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Apply a diff observation. Internal — called from the timely
    /// worker's inspect closure inside [`build`]. Public visibility is
    /// `pub(crate)` so tests inside the crate can drive the view
    /// directly without spinning a dataflow.
    pub(crate) fn apply_diff(&self, hwnd: u64, value: UiElementRef, diff: i64) {
        let mut g = self.inner.write().expect("view RwLock poisoned");
        let counts = g.by_hwnd.entry(hwnd).or_default();
        let new = counts.get(&value).copied().unwrap_or(0) + diff;
        // Defensive: a negative count shouldn't occur under DD's
        // diff invariants (every retraction matches a prior assertion),
        // but if it ever did we'd leak a `(value, -1)` entry that
        // pinned the hwnd in `by_hwnd` forever. Drop both and surface
        // the bug under debug builds.
        debug_assert!(
            new >= 0,
            "negative diff sum at hwnd={:#x}, value name={:?}, sum={}",
            hwnd,
            value.name,
            new,
        );
        if new <= 0 {
            counts.remove(&value);
        } else {
            counts.insert(value, new);
        }
        if counts.is_empty() {
            g.by_hwnd.remove(&hwnd);
        }
    }
}

/// Wire the `current_focused_element` operator graph onto `events`,
/// updating the supplied [`CurrentFocusedElementView`] handle as the
/// dataflow processes events.
///
/// Caller creates the view ahead of `worker.dataflow(...)` so the same
/// handle can be returned out of the worker thread alongside the
/// `InputSession`. `events` is consumed by the chained operator graph
/// — DD's `Collection` is `Clone`, so callers who need it elsewhere
/// should clone before passing it here.
pub fn build<'scope>(
    events: VecCollection<'scope, LogicalTime, FocusEvent, isize>,
    view: CurrentFocusedElementView,
) {
    let view_for_inspect = view;

    events
        .map(|ev: FocusEvent| {
            let key = ev.hwnd;
            let ts: (u64, u32) = (ev.wallclock_ms, ev.sub_ordinal);
            let value = UiElementRef::from_event(&ev);
            (key, (ts, value))
        })
        .reduce(|_key, input, output| {
            // input: &[(&((u64, u32), UiElementRef), isize)] — sorted by
            // value (which puts the larger ts first since ts is the
            // tuple's leading component).
            //
            // last-by-time semantics: pick the value with the largest
            // ts among entries with positive accumulated diff.
            let mut best: Option<&((u64, u32), UiElementRef)> = None;
            for (val_ref, diff) in input.iter() {
                if *diff <= 0 {
                    continue;
                }
                let cand: &((u64, u32), UiElementRef) = *val_ref;
                match best {
                    None => best = Some(cand),
                    Some(b) if cand.0 > b.0 => best = Some(cand),
                    _ => {}
                }
            }
            if let Some((_, ui_ref)) = best {
                output.push((ui_ref.clone(), 1));
            }
        })
        .inspect(move |((hwnd, ui_ref), _time, diff)| {
            view_for_inspect.apply_diff(*hwnd, ui_ref.clone(), *diff as i64);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ui(name: &str, win: &str) -> UiElementRef {
        UiElementRef {
            name: name.into(),
            automation_id: Some("auto".into()),
            control_type: 50000,
            window_title: win.into(),
        }
    }

    #[test]
    fn empty_view_get_returns_none() {
        let v = CurrentFocusedElementView::new();
        assert!(v.is_empty());
        assert_eq!(v.len(), 0);
        assert!(v.get(0xAAAA).is_none());
        assert_eq!(v.snapshot().len(), 0);
    }

    #[test]
    fn apply_diff_insert_then_retract_evicts_hwnd() {
        let v = CurrentFocusedElementView::new();
        let elem = ui("Edit", "Notepad");
        v.apply_diff(0xAAAA, elem.clone(), 1);
        assert_eq!(v.get(0xAAAA), Some(elem.clone()));
        assert_eq!(v.len(), 1);

        // Retract the same value: per-hwnd map empties, hwnd entry
        // is fully removed.
        v.apply_diff(0xAAAA, elem, -1);
        assert!(v.is_empty());
        assert!(v.get(0xAAAA).is_none());
    }

    #[test]
    fn apply_diff_swap_value_at_same_hwnd() {
        let v = CurrentFocusedElementView::new();
        let a = ui("A", "Win");
        let b = ui("B", "Win");

        v.apply_diff(0xBBBB, a.clone(), 1);
        // Swap: assert new value (+1), retract old (-1) — order shouldn't matter.
        v.apply_diff(0xBBBB, b.clone(), 1);
        v.apply_diff(0xBBBB, a, -1);

        assert_eq!(v.get(0xBBBB), Some(b.clone()));
        assert_eq!(v.len(), 1);
        let snap = v.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0], (0xBBBB, b));
    }

    #[test]
    fn apply_diff_retract_first_then_assert_settles() {
        // Out-of-order: retraction observed before the matching
        // assertion. Net diff after both events is unchanged, view
        // must converge to the asserted value.
        let v = CurrentFocusedElementView::new();
        let prev = ui("Prev", "Win");
        let next = ui("Next", "Win");
        v.apply_diff(0xCCCC, prev.clone(), 1);

        v.apply_diff(0xCCCC, prev, -1); // retraction first
        v.apply_diff(0xCCCC, next.clone(), 1); // then assertion

        assert_eq!(v.get(0xCCCC), Some(next));
    }

    #[test]
    fn snapshot_includes_all_live_hwnds() {
        let v = CurrentFocusedElementView::new();
        v.apply_diff(1, ui("A", "WA"), 1);
        v.apply_diff(2, ui("B", "WB"), 1);
        v.apply_diff(3, ui("C", "WC"), 1);
        let mut snap = v.snapshot();
        snap.sort_by_key(|(h, _)| *h);
        assert_eq!(snap.len(), 3);
        assert_eq!(snap[0].1.name, "A");
        assert_eq!(snap[1].1.name, "B");
        assert_eq!(snap[2].1.name, "C");
    }

    #[test]
    fn from_event_projects_only_view_fields() {
        // FocusEvent carries pivot fields (source_event_id,
        // timestamp_source, wallclock_ms, sub_ordinal) that must NOT
        // leak into the view's output shape — the view is consumed by
        // L4 envelope.data which has its own slot for traceability.
        let ev = FocusEvent {
            source_event_id: 12345,
            hwnd: 0xDEAD,
            name: "Btn".into(),
            automation_id: Some("a-id".into()),
            control_type: 50000,
            window_title: "App".into(),
            wallclock_ms: 1_700_000_000_000,
            sub_ordinal: 7,
            timestamp_source: 2,
        };
        let r = UiElementRef::from_event(&ev);
        assert_eq!(r.name, "Btn");
        assert_eq!(r.automation_id, Some("a-id".into()));
        assert_eq!(r.control_type, 50000);
        assert_eq!(r.window_title, "App");
        // No pivot fields on UiElementRef — compile-time guarantee.
    }
}
