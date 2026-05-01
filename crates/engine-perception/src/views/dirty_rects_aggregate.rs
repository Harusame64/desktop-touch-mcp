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

use std::collections::{BTreeMap, BTreeSet, HashMap};
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
    /// Per-`(monitor, frame)` map of `count_value -> diff_sum`. Mirrors
    /// `current_focused_element`'s per-`(hwnd, ui_ref)` pattern (Codex
    /// v3 P1-1 inspect-order tolerance, Opus PR #108 Round 1 P2-1):
    /// DD reduce can fire retraction `(old_count, -1)` and assertion
    /// `(new_count, +1)` in any order across inspect callbacks, so the
    /// view stores diff sums per `(key, count_value)` and resolves the
    /// "live count" by finding the count_value with positive diff sum.
    /// In steady state at most one count_value per `(monitor, frame)`
    /// has a positive sum (= the live count); transiently both may
    /// coexist while assertion / retraction settle.
    by_key: HashMap<(u32, u64), BTreeMap<u64, i64>>,
    /// Sorted set of currently-live `frame_index`es per monitor. Used
    /// for **frame-recency eviction** (Codex round 1 P2-A): when the
    /// per-monitor live set exceeds `PER_MONITOR_FRAME_CAP`, drop the
    /// **lowest** frame_index. This preserves the contract "retain
    /// the most recent N frame indices per monitor" even when the
    /// worker accepts late-arriving older events within the watermark
    /// window — insertion-FIFO eviction (the prior shape) would have
    /// dropped a NEWER frame to make room for an older late arrival,
    /// inverting the contract.
    ///
    /// Entries are added on first-positive-diff observation and
    /// removed when the (monitor, frame) cumulative state settles
    /// to zero (= no count_value with positive diff sum).
    live_frames_by_monitor: HashMap<u32, BTreeSet<u64>>,
}

impl DirtyRectsAggregateView {
    pub fn new() -> Self {
        Self::default()
    }

    /// Per-`(monitor_index, frame_index)` count lookup. Returns the
    /// `count_value` with a positive diff sum (= the live count), or
    /// `None` when the frame has not been observed (or has been
    /// evicted under the per-monitor FIFO cap, or all diff sums
    /// settled to ≤ 0).
    pub fn get(&self, monitor_index: u32, frame_index: u64) -> Option<u64> {
        let g = self.inner.read().expect("view RwLock poisoned");
        g.by_key
            .get(&(monitor_index, frame_index))
            .and_then(|counts| counts.iter().find(|&(_, &c)| c > 0).map(|(&v, _)| v))
    }

    /// Number of currently-live frames for `monitor_index` (= frames
    /// where some `count_value` has positive diff sum). Used by the
    /// napi binding's `live_frame_count` field.
    pub fn live_frame_count(&self, monitor_index: u32) -> usize {
        let g = self.inner.read().expect("view RwLock poisoned");
        g.by_key
            .iter()
            .filter(|((m, _), counts)| {
                *m == monitor_index && counts.iter().any(|(_, &c)| c > 0)
            })
            .count()
    }

    /// Latest live `(frame_index, count)` for `monitor_index` — the
    /// frame with the highest `frame_index` whose count_value still
    /// has positive diff sum. Used by the napi binding's `latest`
    /// field. Expansion-phase `recent_n` / `recent_window` API
    /// supersedes this.
    pub fn latest(&self, monitor_index: u32) -> Option<(u64, u64)> {
        let g = self.inner.read().expect("view RwLock poisoned");
        g.by_key
            .iter()
            .filter(|((m, _), _)| *m == monitor_index)
            .filter_map(|((_, fi), counts)| {
                counts
                    .iter()
                    .find(|&(_, &c)| c > 0)
                    .map(|(&v, _)| (*fi, v))
            })
            .max_by_key(|(fi, _)| *fi)
    }

    /// Total number of monitors with at least one live frame (= some
    /// `(monitor, frame)` whose count_value has positive diff sum).
    pub fn monitor_count(&self) -> usize {
        let g = self.inner.read().expect("view RwLock poisoned");
        let mut monitors: std::collections::HashSet<u32> = std::collections::HashSet::new();
        for ((m, _), counts) in &g.by_key {
            if counts.iter().any(|(_, &c)| c > 0) {
                monitors.insert(*m);
            }
        }
        monitors.len()
    }

    /// `true` when no `(monitor, frame)` has a count_value with
    /// positive diff sum.
    pub fn is_empty(&self) -> bool {
        let g = self.inner.read().expect("view RwLock poisoned");
        !g.by_key
            .iter()
            .any(|(_, counts)| counts.iter().any(|(_, &c)| c > 0))
    }

    /// Apply a diff observation from the timely worker's inspect
    /// closure inside [`build_dirty_rects_aggregate`]. `pub(crate)`
    /// so tests inside the crate can drive the view directly.
    ///
    /// **Inspect-order tolerance** (mirror of
    /// `current_focused_element::CurrentFocusedElementView::apply_diff`):
    /// DD reduce can fire retraction `(old_count, -1)` and assertion
    /// `(new_count, +1)` in any order across inspect callbacks. The
    /// per-`(key, count_value)` diff sum store keeps the read API
    /// convergent regardless of arrival order — the `get` lookup
    /// always finds whichever count_value has a positive sum. Net
    /// effect after both retraction and assertion settle: only the
    /// new count_value's sum is positive, the old one's is 0
    /// (evicted from the inner BTreeMap).
    pub(crate) fn apply_count(
        &self,
        monitor_index: u32,
        frame_index: u64,
        count_value: u64,
        diff: i64,
    ) {
        let mut g = self.inner.write().expect("view RwLock poisoned");
        let key = (monitor_index, frame_index);

        // ── Step 1: update the per-(key, count_value) diff sum ────
        let counts = g.by_key.entry(key).or_default();
        let prior = counts.get(&count_value).copied().unwrap_or(0);
        let new_diff = prior + diff;

        // **Late retraction for evicted/never-asserted (key, count_value)**
        // (Opus PR #108 Round 2 P2-A): the cap eviction in Step 3
        // can remove `(monitor, frame)` from `by_key` after a prior
        // assertion landed (late-older-arrival path). A subsequent
        // DD reduce retraction for the same key/value then lands on
        // an empty BTreeMap, with `prior == 0` and `diff < 0` ⇒
        // `new_diff == -1`. The pre-Round 4 shape panicked in debug
        // builds on this `debug_assert!` even though the retraction
        // is semantically a no-op (the data is gone). Drop silently
        // and clean up the BTreeMap entry created by `entry().or_default()`.
        if prior == 0 && diff < 0 {
            if counts.is_empty() {
                g.by_key.remove(&key);
            }
            return;
        }
        // Defensive: any other negative diff sum shouldn't occur under
        // DD's diff invariants (every retraction matches a prior
        // assertion, even if observed out-of-order). Surface the bug
        // in debug builds without panicking — same posture as
        // `current_focused_element::apply_diff`.
        debug_assert!(
            new_diff >= 0,
            "negative diff sum at (monitor={}, frame={}, count_value={}): {} (prior={}, diff={})",
            monitor_index,
            frame_index,
            count_value,
            new_diff,
            prior,
            diff,
        );
        if new_diff <= 0 {
            counts.remove(&count_value);
        } else {
            counts.insert(count_value, new_diff);
        }
        // ── Step 2: track liveness — is any count_value still live? ──
        let key_now_live = g
            .by_key
            .get(&key)
            .map(|c| c.iter().any(|(_, &d)| d > 0))
            .unwrap_or(false);
        // Drop the (monitor, frame) entry entirely once all
        // count_values' diff sums settle to 0.
        if g.by_key.get(&key).map(|c| c.is_empty()).unwrap_or(false) {
            g.by_key.remove(&key);
        }

        // ── Step 3: maintain `live_frames_by_monitor` + cap eviction
        //          (Codex round 1 P2-A: evict by frame recency, not
        //          insertion order). ────────────────────────────────
        if key_now_live {
            // Compute eviction list first (mutating only
            // `live_frames_by_monitor`), then drop that borrow before
            // touching `by_key` again — avoids E0499 by keeping the
            // two HashMaps' mutable borrows non-overlapping.
            let mut to_evict: Vec<(u32, u64)> = Vec::new();
            {
                let live = g.live_frames_by_monitor.entry(monitor_index).or_default();
                live.insert(frame_index);
                while live.len() > PER_MONITOR_FRAME_CAP {
                    // Evict the LOWEST frame_index (= the oldest
                    // frame by `frame_index` ordering, which is
                    // monotone in DXGI emit order). Out-of-order
                    // late arrivals within the watermark window are
                    // still admitted by the worker, but if their
                    // frame_index is older than the live set's
                    // current min the eviction step removes them —
                    // not a newer frame.
                    if let Some(&evict_frame) = live.iter().next() {
                        live.remove(&evict_frame);
                        to_evict.push((monitor_index, evict_frame));
                    } else {
                        break;
                    }
                }
            }
            for evict_key in to_evict {
                g.by_key.remove(&evict_key);
            }
        } else {
            // Frame settled to fully-dead — remove from the live set.
            if let Some(live) = g.live_frames_by_monitor.get_mut(&monitor_index) {
                live.remove(&frame_index);
                if live.is_empty() {
                    g.live_frames_by_monitor.remove(&monitor_index);
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
    //
    // inspect callback shape: `((key, count_value), time, diff)`
    // where `key = (monitor_index, frame_index)` and `count_value`
    // is the reduce-output count_u64. `diff` is +1 (assertion of new
    // value) or -1 (retraction of old value). The view's per-(key,
    // count_value) diff bookkeeping handles inspect-order tolerance
    // (Opus PR #108 Round 1 P2-1, mirror of `current_focused_element`).
    reduced
        .clone()
        .inspect(move |((key, count_value), _time, diff)| {
            let (monitor_index, frame_index) = *key;
            view_for_inspect.apply_count(
                monitor_index,
                frame_index,
                *count_value,
                *diff as i64,
            );
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
        // aggregation. `apply_count(monitor, frame, count_value, +1)`
        // asserts `count_value` as the live count for that frame.
        let v = DirtyRectsAggregateView::new();
        v.apply_count(0, 1, 3, 1);
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
        v.apply_count(0, 1, 2, 1);
        v.apply_count(1, 1, 3, 1);
        assert_eq!(v.get(0, 1), Some(2));
        assert_eq!(v.get(1, 1), Some(3));
        assert_eq!(v.live_frame_count(0), 1);
        assert_eq!(v.live_frame_count(1), 1);
        assert_eq!(v.monitor_count(), 2);
    }

    #[test]
    fn apply_count_eviction_by_frame_recency() {
        // Codex round 1 P2-A: eviction must drop the LOWEST
        // frame_index when the per-monitor cap is exceeded, NOT the
        // first-inserted frame_index. Critical when the worker
        // accepts late older arrivals within the watermark window.
        let v = DirtyRectsAggregateView::new();
        for fi in 0..(PER_MONITOR_FRAME_CAP as u64 + 2) {
            v.apply_count(0, fi, 1, 1);
        }
        assert_eq!(v.live_frame_count(0), PER_MONITOR_FRAME_CAP);
        // Lowest 2 frames evicted.
        assert!(v.get(0, 0).is_none());
        assert!(v.get(0, 1).is_none());
        // Newest frame retained.
        assert_eq!(v.get(0, PER_MONITOR_FRAME_CAP as u64 + 1), Some(1));
        assert_eq!(
            v.latest(0),
            Some((PER_MONITOR_FRAME_CAP as u64 + 1, 1))
        );
    }

    #[test]
    fn apply_count_late_older_arrival_does_not_evict_newer() {
        // Codex round 1 P2-A regression scenario: insert frames
        // 0..CAP (live set full), then a LATE older frame_index
        // arrives. The eviction step must drop the newly-arriving
        // older frame (its frame_index is below the live set's
        // current min only when it's truly old — here we insert at
        // the boundary case where the new frame is the new min).
        // Result: live set keeps the most-recent CAP frames.
        let v = DirtyRectsAggregateView::new();
        for fi in 1..=(PER_MONITOR_FRAME_CAP as u64) {
            v.apply_count(0, fi, 1, 1);
        }
        assert_eq!(v.live_frame_count(0), PER_MONITOR_FRAME_CAP);
        // Now a late older frame arrives (frame_index = 0). Live set
        // becomes 9 elements; cap eviction drops the lowest = 0
        // itself (so the new arrival is what gets evicted).
        v.apply_count(0, 0, 1, 1);
        assert_eq!(v.live_frame_count(0), PER_MONITOR_FRAME_CAP);
        // Frame 0 evicted (or never made it into the live set
        // beyond a transient state).
        assert!(v.get(0, 0).is_none());
        // All originally-inserted frames 1..CAP retained.
        for fi in 1..=(PER_MONITOR_FRAME_CAP as u64) {
            assert_eq!(v.get(0, fi), Some(1), "frame {} must remain live", fi);
        }
    }

    #[test]
    fn apply_count_zero_evicts_key() {
        // Compaction can produce a 0 diff sum for a count_value —
        // the view must drop the (key, count_value) entry, and if
        // it was the last live count_value, drop the (monitor,
        // frame) entry from the live set entirely.
        let v = DirtyRectsAggregateView::new();
        v.apply_count(0, 1, 5, 1);
        v.apply_count(0, 1, 5, -1);
        assert!(v.get(0, 1).is_none());
        assert_eq!(v.live_frame_count(0), 0);
        assert!(v.is_empty());
    }

    #[test]
    fn apply_count_value_axis_retraction_settles_to_new_value() {
        // Opus round 1 P2-3: DD reduce can produce value-axis
        // retraction + new assertion on the same (monitor, frame)
        // key when the count changes. Both arrival orders must
        // converge to the new count.
        let v = DirtyRectsAggregateView::new();
        // Initial state: count=3 for (0, 1).
        v.apply_count(0, 1, 3, 1);
        assert_eq!(v.get(0, 1), Some(3));
        // Count grows to 5: DD emits retraction(3) + assertion(5).
        v.apply_count(0, 1, 3, -1);
        v.apply_count(0, 1, 5, 1);
        assert_eq!(v.get(0, 1), Some(5));
        assert_eq!(v.live_frame_count(0), 1);
    }

    #[test]
    fn apply_count_late_older_arrival_followed_by_retraction_does_not_panic() {
        // **Opus PR #108 Round 2 P2-A regression**: late-older arrival
        // path evicts `(monitor, frame)` from `by_key` after a prior
        // assertion (cap full + new frame is the new min). A subsequent
        // DD reduce retraction for the same `(key, count_value)` then
        // lands on an empty BTreeMap, with `prior == 0` and `diff < 0`
        // ⇒ `new_diff == -1`. Pre-Round 4 shape panicked in debug builds
        // on `debug_assert!(new_diff >= 0)`. Round 4 fix drops such
        // retractions silently (the data is already gone via eviction).
        let v = DirtyRectsAggregateView::new();
        // Fill the per-monitor live cap with frames 1..=CAP.
        for fi in 1..=(PER_MONITOR_FRAME_CAP as u64) {
            v.apply_count(0, fi, 1, 1);
        }
        assert_eq!(v.live_frame_count(0), PER_MONITOR_FRAME_CAP);
        // Late older arrival = frame 0. Cap eviction picks min = 0
        // (the just-inserted frame), removes it from both
        // live_frames_by_monitor and by_key.
        v.apply_count(0, 0, 1, 1);
        assert!(v.get(0, 0).is_none(), "frame 0 evicted (late-older drop)");
        // Now DD reduce fires retraction for the just-evicted (0, 0,
        // count_value=1). Pre-Round 4: panic. Round 4: silent drop.
        v.apply_count(0, 0, 1, -1);
        // View state unchanged — the retraction is a no-op for an
        // already-evicted key. Surviving frames 1..=CAP intact.
        assert!(v.get(0, 0).is_none());
        assert_eq!(v.live_frame_count(0), PER_MONITOR_FRAME_CAP);
        for fi in 1..=(PER_MONITOR_FRAME_CAP as u64) {
            assert_eq!(v.get(0, fi), Some(1), "frame {} survived eviction sequence", fi);
        }
    }

    #[test]
    fn apply_count_value_axis_retraction_arrives_first_settles_correctly() {
        // Opus round 1 P2-3 + sub-plan §2.2 Codex v3 P1-1
        // inspect-order tolerance: retraction arrives BEFORE the
        // matching assertion. View must converge to the new value
        // regardless of arrival order.
        let v = DirtyRectsAggregateView::new();
        v.apply_count(0, 1, 3, 1);
        // Out-of-order: assertion of new value 5 arrives BEFORE
        // retraction of old value 3.
        v.apply_count(0, 1, 5, 1);
        v.apply_count(0, 1, 3, -1);
        assert_eq!(v.get(0, 1), Some(5));
        assert_eq!(v.live_frame_count(0), 1);
    }
}
