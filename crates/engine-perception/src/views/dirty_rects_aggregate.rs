//! `dirty_rects_aggregate` view (S2 D2-C walking skeleton trunk,
//! `docs/adr-008-d2-c-plan.md` §2.1 / §2.2 / §2.3).
//!
//! ## Count-only contract spike (S2 trunk)
//!
//! Per-`(monitor_index, frame_index)` count of dirty rects from a
//! single DXGI frame. The S2 walking skeleton trunk lands the
//! **count-only** contract: aggregate the **number** of rects per
//! `(monitor, frame)` tuple. Geometry (`Vec<Rect>` + total_area
//! summary) is reserved for expansion (`docs/adr-008-d2-c-plan.md`
//! §1.2).
//!
//! ## `monitor_index` integrity (CLAUDE.md §3.2, PR #102 教訓)
//!
//! The composite key `(monitor_index, frame_index)` is **mandatory** —
//! count-only does NOT mean dropping `monitor_index`. PR #102
//! (`db81fe2`) had to fix a `monitor_index: 0` hard-coded payload
//! that silently broke secondary-monitor subscriptions; the
//! sub-plan §1.4 / §3.2 R3 explicitly carries that lesson into S2.
//! Same-frame-index across monitors is not a collision because the
//! key tuple separates them.
//!
//! ## Operator graph
//!
//! ```text
//! DirtyRectEvent collection (input)
//!     │
//!     │ map: DirtyRectEvent → ((monitor_index, frame_index), ())
//!     ▼
//! count(): per (monitor_index, frame_index)、入力 row の数を集計。
//!          dirty rects are append-only (no DD retraction within a
//!          frame), so the count diff is monotonically non-decreasing.
//!     │
//!     ▼
//! inspect: (data, time, diff) を view の per-(monitor, frame) HashMap
//!          に apply。`(monitor, frame) → cumulative count` の materialised
//!          state を保持。
//! ```
//!
//! Note: we use DD's `count` operator (a `reduce` specialisation) to
//! get an `isize` diff per key. The view stores diffs as `u64`
//! after asserting non-negativity.
//!
//! ## Eviction policy (固定 N=8 frames per-monitor、§2.4)
//!
//! S2 trunk uses a fixed-size FIFO buffer: **at most 8 most recent
//! frame_indices per monitor** are retained. 60Hz × ~130ms 相当、
//! enough to capture the causal window of a typical commit-after-
//! action sequence (S5 caused_by linkage). 100ms wallclock-based
//! sliding window eviction lands in expansion (`docs/adr-008-d2-c-plan.md`
//! §1.2).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, RwLock};

use differential_dataflow::collection::vec::Collection as VecCollection;
use differential_dataflow::operators::arrange::{Arranged, TraceAgent};
use differential_dataflow::trace::implementations::ValSpine;

use crate::input::DirtyRectEvent;
use crate::time::LogicalTime;

/// Per-monitor cap on retained frame_indices. 60Hz × ~133ms.
const PER_MONITOR_FRAME_CAP: usize = 8;

/// Per-key arrangement of `dirty_rects_aggregate`'s reduce output.
/// Other subgraphs in the same `worker.dataflow` closure could borrow
/// this for join logic in a future phase; for the S2 trunk no
/// downstream consumer is wired yet, but the shape mirrors
/// `CurrentFocusedElementArranged<'scope>` so future joins are
/// mechanical (sub-plan §3.3 Lesson 1 contract integrity).
///
/// `'scope` is the timely worker's scope lifetime; storing it in an
/// outside struct is statically rejected by timely's lifetime model
/// (Codex v2 P2-9, S1 D2-E0 contract).
pub type DirtyRectsAggregateArranged<'scope> =
    Arranged<'scope, TraceAgent<ValSpine<(u32, u64), u64, LogicalTime, isize>>>;

/// Reader-side handle on the materialised state of the
/// `dirty_rects_aggregate` view. Cheap to clone (inner is
/// `Arc<RwLock<...>>`).
#[derive(Clone, Default)]
pub struct DirtyRectsAggregateView {
    inner: Arc<RwLock<ViewState>>,
}

#[derive(Default)]
struct ViewState {
    /// Per-monitor map of `frame_index -> count`. The BTreeMap is
    /// ordered by `frame_index`, so eviction (drop the oldest entry
    /// once the per-monitor cap is exceeded) is `pop_front`-style on
    /// the `BTreeMap::keys()` iteration.
    by_monitor: HashMap<u32, BTreeMap<u64, u64>>,
    /// FIFO of `(monitor_index, frame_index)` insertion order so
    /// eviction is O(1) — we keep a deque per monitor's first-seen
    /// frame indices and pop the front when the cap is exceeded.
    insertion_order: HashMap<u32, VecDeque<u64>>,
}

impl DirtyRectsAggregateView {
    pub fn new() -> Self {
        Self::default()
    }

    /// Per-`(monitor_index, frame_index)` count lookup. Returns
    /// `None` when the frame has not been observed (or has been
    /// evicted under the per-monitor FIFO cap).
    pub fn get(&self, monitor_index: u32, frame_index: u64) -> Option<u64> {
        let g = self.inner.read().expect("view RwLock poisoned");
        g.by_monitor
            .get(&monitor_index)
            .and_then(|frames| frames.get(&frame_index).copied())
    }

    /// Number of currently-retained frames for `monitor_index`. Used
    /// by the napi binding to surface a quick "live frames count" to
    /// the TS layer (`view_get_dirty_rects.live_frame_count`).
    pub fn live_frame_count(&self, monitor_index: u32) -> usize {
        let g = self.inner.read().expect("view RwLock poisoned");
        g.by_monitor
            .get(&monitor_index)
            .map(|frames| frames.len())
            .unwrap_or(0)
    }

    /// Latest `(frame_index, count)` for `monitor_index`. Useful for
    /// the napi binding's "most recent frame" surface; expansion-phase
    /// `recent_n` / `recent_window` API supersedes this.
    pub fn latest(&self, monitor_index: u32) -> Option<(u64, u64)> {
        let g = self.inner.read().expect("view RwLock poisoned");
        g.by_monitor
            .get(&monitor_index)
            .and_then(|frames| frames.iter().next_back().map(|(&fi, &c)| (fi, c)))
    }

    /// Total number of monitors with at least one retained frame.
    pub fn monitor_count(&self) -> usize {
        let g = self.inner.read().expect("view RwLock poisoned");
        g.by_monitor.len()
    }

    /// `true` when no monitor has any retained frame.
    pub fn is_empty(&self) -> bool {
        self.monitor_count() == 0
    }

    /// Apply a diff observation. Internal — called from the timely
    /// worker's inspect closure inside [`build_dirty_rects_aggregate`].
    /// `pub(crate)` so tests inside the crate can drive the view
    /// directly without spinning a dataflow.
    ///
    /// dirty rects are **append-only** within a DXGI frame (DD does
    /// not retract them once emitted), so diff is normally `+N` for
    /// `N` rects in the frame. Negative diffs would only appear if a
    /// future view reduces the count semantics — defensive
    /// `debug_assert!` catches that.
    pub(crate) fn apply_count(&self, monitor_index: u32, frame_index: u64, diff: i64) {
        let mut g = self.inner.write().expect("view RwLock poisoned");
        let frames = g.by_monitor.entry(monitor_index).or_default();
        let new = frames.get(&frame_index).copied().unwrap_or(0) as i64 + diff;
        debug_assert!(
            new >= 0,
            "negative count for (monitor={}, frame={}): {}",
            monitor_index,
            frame_index,
            new,
        );
        if new <= 0 {
            // Defensive: 0 → eviction (DD reduce can produce 0
            // diffs during compaction even though dirty rects are
            // append-only at the input level).
            frames.remove(&frame_index);
            // Also remove from insertion_order if present (best-effort).
            if let Some(order) = g.insertion_order.get_mut(&monitor_index) {
                if let Some(pos) = order.iter().position(|&fi| fi == frame_index) {
                    order.remove(pos);
                }
            }
            // If the per-monitor map is now empty, drop the
            // monitor key too so `monitor_count()` reflects reality.
            if g.by_monitor
                .get(&monitor_index)
                .map(|f| f.is_empty())
                .unwrap_or(false)
            {
                g.by_monitor.remove(&monitor_index);
                g.insertion_order.remove(&monitor_index);
            }
            return;
        }
        let new_u64 = new as u64;
        let was_new_key = !frames.contains_key(&frame_index);
        frames.insert(frame_index, new_u64);
        if was_new_key {
            // Track FIFO order for the per-monitor cap eviction.
            // Compute the eviction list first (mutating only
            // `insertion_order`), then drop that borrow before
            // touching `by_monitor` again — avoids E0499 by keeping
            // the two `HashMap`s' mutable borrows non-overlapping.
            let mut to_evict: Vec<u64> = Vec::new();
            {
                let order = g.insertion_order.entry(monitor_index).or_default();
                order.push_back(frame_index);
                while order.len() > PER_MONITOR_FRAME_CAP {
                    if let Some(evict) = order.pop_front() {
                        to_evict.push(evict);
                    }
                }
            }
            if let Some(frames) = g.by_monitor.get_mut(&monitor_index) {
                for evict in to_evict {
                    frames.remove(&evict);
                }
            }
        }
    }
}

/// Wire the `dirty_rects_aggregate` operator graph onto
/// `dirty_rect_stream`. Returns `(arranged, view)` mirroring the S1
/// D2-E0 unified `build_*` template (`build_current_focused_element`
/// shape, `docs/adr-008-d2-e0-plan.md` §2.1).
///
/// `dirty_rect_stream` is borrowed; the function clones internally
/// to drive the reduce twice (inspect + arrange_by_key), the same
/// 2-borrow pattern S1 established (sub-plan §7 R9 mitigation).
pub fn build_dirty_rects_aggregate<'scope>(
    dirty_rect_stream: &VecCollection<'scope, LogicalTime, DirtyRectEvent, isize>,
) -> (DirtyRectsAggregateArranged<'scope>, DirtyRectsAggregateView) {
    let view = DirtyRectsAggregateView::new();
    let view_for_inspect = view.clone();

    // Map each DirtyRectEvent to ((monitor_index, frame_index), ())
    // and reduce by counting `(diff sum)` per key — output is
    // `((monitor_index, frame_index), count_u64)`.
    let reduced = dirty_rect_stream
        .clone()
        .map(|ev: DirtyRectEvent| {
            let key = (ev.monitor_index, ev.frame_index);
            (key, ())
        })
        .reduce(|_key, input, output| {
            // input: &[(&(), isize)] — count the unit values
            // weighted by their diff. dirty rects are append-only at
            // the input level so the total is positive.
            let total: isize = input.iter().map(|(_, diff)| *diff).sum();
            if total > 0 {
                output.push((total as u64, 1));
            }
        });

    // 2-borrow shape: clone for inspect, original flows into
    // arrange_by_key (S1 D2-E0 sub-plan §7 R9 verified pattern).
    reduced
        .clone()
        .inspect(move |((key, count), _time, diff)| {
            let (monitor_index, frame_index) = *key;
            // diff is the change in the reduce's output value (count_u64).
            // For append-only inputs the inspect sees `+count` followed
            // by retraction `-count` if the key is later updated to a
            // new total. Net effect on the view is the latest non-zero
            // count.
            let signed_diff = (*count as i64) * (*diff as i64);
            view_for_inspect.apply_count(monitor_index, frame_index, signed_diff);
        });

    let arranged = reduced.arrange_by_key();
    (arranged, view)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_view_get_returns_none() {
        let v = DirtyRectsAggregateView::new();
        assert!(v.is_empty());
        assert_eq!(v.monitor_count(), 0);
        assert!(v.get(0, 0).is_none());
        assert_eq!(v.live_frame_count(0), 0);
        assert!(v.latest(0).is_none());
    }

    #[test]
    fn apply_count_per_frame_aggregates() {
        // G2 contract Test G2-1 (sub-plan §3.8): per-frame count
        // aggregation.
        let v = DirtyRectsAggregateView::new();
        // (monitor=0, frame=1) gets 3 rects.
        v.apply_count(0, 1, 3);
        assert_eq!(v.get(0, 1), Some(3));
        assert_eq!(v.live_frame_count(0), 1);
        assert_eq!(v.monitor_count(), 1);
    }

    #[test]
    fn apply_count_per_monitor_isolation() {
        // G2 contract Test G2-2 (sub-plan §3.8、CLAUDE.md §3.2 PR #102 教訓):
        // (monitor=0, frame=1) and (monitor=1, frame=1) must NOT
        // collide — composite key `(monitor_index, frame_index)`.
        let v = DirtyRectsAggregateView::new();
        v.apply_count(0, 1, 2);
        v.apply_count(1, 1, 3);
        assert_eq!(v.get(0, 1), Some(2));
        assert_eq!(v.get(1, 1), Some(3));
        assert_eq!(v.live_frame_count(0), 1);
        assert_eq!(v.live_frame_count(1), 1);
        assert_eq!(v.monitor_count(), 2);
    }

    #[test]
    fn apply_count_eviction_under_cap() {
        // Per-monitor FIFO cap eviction. PER_MONITOR_FRAME_CAP+1
        // frames inserted; the oldest must be evicted.
        let v = DirtyRectsAggregateView::new();
        for fi in 0..(PER_MONITOR_FRAME_CAP as u64 + 2) {
            v.apply_count(0, fi, 1);
        }
        assert_eq!(v.live_frame_count(0), PER_MONITOR_FRAME_CAP);
        // Oldest 2 frames must be gone.
        assert!(v.get(0, 0).is_none());
        assert!(v.get(0, 1).is_none());
        // Newest one is present.
        assert_eq!(v.get(0, PER_MONITOR_FRAME_CAP as u64 + 1), Some(1));
        // `latest` reflects the newest.
        assert_eq!(
            v.latest(0),
            Some((PER_MONITOR_FRAME_CAP as u64 + 1, 1))
        );
    }

    #[test]
    fn apply_count_zero_evicts_key() {
        // Compaction can produce a 0 diff sum for a key — the view
        // must drop the entry rather than store `0`.
        let v = DirtyRectsAggregateView::new();
        v.apply_count(0, 1, 5);
        v.apply_count(0, 1, -5);
        assert!(v.get(0, 1).is_none());
        assert_eq!(v.live_frame_count(0), 0);
        assert!(v.is_empty());
    }
}
