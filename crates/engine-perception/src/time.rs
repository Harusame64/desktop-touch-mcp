//! Logical time type for the L3 dataflow.
//!
//! `Pair<u64, u32>` (= `(wallclock_ms, sub_ordinal)`) is the timestamp
//! we use throughout `engine-perception`. `wallclock_ms` is the L1
//! capture timestamp; `sub_ordinal` disambiguates events that share
//! a millisecond, mirroring `InternalEvent.sub_ordinal` from the
//! root crate.
//!
//! ## Why a custom Pair instead of `(u64, u32)`?
//!
//! `worker.dataflow::<T, _, _>` requires `T: Refines<()>`. timely 0.29
//! impls `Refines<()>` for primitive int types and `Duration` only
//! (`timely::progress::timestamp` macro `implement_refines_empty!`),
//! and **not** for tuples. The standard escape hatch — used in DD's
//! own `examples/multitemporal.rs` — is to define a `Pair<S, T>` that
//! implements `Timestamp + Refines<()> + PartialOrder + Lattice`.
//!
//! This file is a near-verbatim port of that example's `mod pair`,
//! specialized to our two-component case. Attribution goes to the
//! differential-dataflow project (multitemporal example, MIT-licensed).
//!
//! ## Order semantics — lexicographic / total
//!
//! D1-2 implements `timely::order::PartialOrder` as **lex order** and
//! marks the type `TotalOrder`. This is what `(u64, u32)` would be if
//! timely impl'd `Refines<()>` on tuples directly. Rationale:
//!
//! - `differential_dataflow::input::InputSession` (the simple input
//!   API used in worker_loop) requires `T: TotalOrder`. The
//!   alternative `new_unordered_input` API requires manual capability
//!   tracking and is overkill for D1-2's "ring → input" wiring.
//! - `wallclock_ms` is the dominant ordering field; `sub_ordinal`
//!   only matters when two events share a millisecond, in which case
//!   lex order matches the L1 capture order (sub_ordinal increments
//!   monotonically per capture thread).
//! - Watermark-based out-of-order acceptance works the same way under
//!   lex or product order: as long as `event_time >= watermark`, DD
//!   accepts the update.
//!
//! If a future view (D2+) needs true partial-order — e.g., to compose
//! independent (wallclock, virtual-time) axes — we'll introduce a
//! second timestamp type via `new_unordered_input`. D1-2 stays simple.

use std::fmt::{self, Debug, Formatter};

use serde::{Deserialize, Serialize};

use differential_dataflow::lattice::Lattice;
use timely::order::{PartialOrder, TotalOrder};
use timely::progress::timestamp::Refines;
use timely::progress::{PathSummary, Timestamp};

/// A pair of timestamps, partially ordered by the product order.
///
/// For ADR-008 D1-2, `S = u64` (wallclock_ms) and `T = u32` (sub_ordinal).
#[derive(Hash, Default, Clone, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct Pair<S, T> {
    pub first: S,
    pub second: T,
}

impl<S, T> Pair<S, T> {
    pub fn new(first: S, second: T) -> Self {
        Pair { first, second }
    }
}

// Lex order via the derived `Ord`. See module docs for rationale.
impl<S, T> PartialOrder for Pair<S, T>
where
    S: Ord,
    T: Ord,
{
    fn less_equal(&self, other: &Self) -> bool {
        self <= other
    }
}

// Marker: lex order is total when both component types have total Ord.
impl<S: Ord, T: Ord> TotalOrder for Pair<S, T> {}

impl<S: Timestamp, T: Timestamp> Refines<()> for Pair<S, T> {
    fn to_inner(_outer: ()) -> Self {
        Self::minimum()
    }
    fn to_outer(self) {}
    fn summarize(_summary: <Self as Timestamp>::Summary) {}
}

impl<S: Timestamp, T: Timestamp> PathSummary<Pair<S, T>> for () {
    fn results_in(&self, timestamp: &Pair<S, T>) -> Option<Pair<S, T>> {
        Some(timestamp.clone())
    }
    fn followed_by(&self, other: &Self) -> Option<Self> {
        Some(*other)
    }
}

impl<S: Timestamp, T: Timestamp> Timestamp for Pair<S, T> {
    fn minimum() -> Self {
        Pair {
            first: S::minimum(),
            second: T::minimum(),
        }
    }
    type Summary = ();
}

// **Lattice on lex-total order** — Codex PR #90 P1.
//
// `PartialOrder` for `Pair` is implemented as lex order (above), so
// the lattice ops MUST also be lex-consistent. A component-wise join
// would violate lattice laws under lex order:
//
//   join((1, 9), (2, 0)) — lex LUB = (2, 0), component-wise = (2, 9)
//   ← (2, 9) is lex-greater than (2, 0), so it's not the *least* upper
//     bound. DD uses Lattice for arrangement compaction / frontier
//     reasoning; a non-LUB join breaks that.
//
// Under a total order, join = max and meet = min in that order. We
// clone via the derived `PartialOrd` (which is lex by struct field
// order). The `Lattice + Ord` bound on the impl ensures we always
// have both DD's `Lattice` (for the inner-component bounds DD
// requires) and a usable `Ord` (for the lex comparison itself).
impl<S, T> Lattice for Pair<S, T>
where
    S: Lattice + Ord + Clone,
    T: Lattice + Ord + Clone,
{
    fn join(&self, other: &Self) -> Self {
        if self >= other {
            self.clone()
        } else {
            other.clone()
        }
    }
    fn meet(&self, other: &Self) -> Self {
        if self <= other {
            self.clone()
        } else {
            other.clone()
        }
    }
}

impl<S: Debug, T: Debug> Debug for Pair<S, T> {
    fn fmt(&self, f: &mut Formatter<'_>) -> Result<(), fmt::Error> {
        write!(f, "({:?}, {:?})", self.first, self.second)
    }
}

/// Logical time alias used throughout the L3 dataflow.
pub type LogicalTime = Pair<u64, u32>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lex_total_order() {
        // (1, 5) ≤ (2, 5) ✓ (first smaller)
        assert!(Pair::new(1u64, 5u32).less_equal(&Pair::new(2u64, 5u32)));
        // (1, 5) ≤ (1, 6) ✓ (first equal, second smaller)
        assert!(Pair::new(1u64, 5u32).less_equal(&Pair::new(1u64, 6u32)));
        // (2, 5) ≤ (1, 6) ✗ (lex-greater)
        assert!(!Pair::new(2u64, 5u32).less_equal(&Pair::new(1u64, 6u32)));
        // (1, 6) ≤ (2, 5) ✓ (lex order: 1 < 2 wins regardless of second)
        assert!(Pair::new(1u64, 6u32).less_equal(&Pair::new(2u64, 5u32)));
    }

    #[test]
    fn minimum_is_pair_zero() {
        let m: LogicalTime = LogicalTime::minimum();
        assert_eq!(m.first, 0);
        assert_eq!(m.second, 0);
    }

    #[test]
    fn lex_ord_consistent_with_product_when_first_differs() {
        // Lex Ord matches PartialOrder when first components differ.
        let a = Pair::new(1u64, 5u32);
        let b = Pair::new(2u64, 5u32);
        assert!(a < b);
        assert!(a.less_equal(&b));
    }

    // ─── Lattice consistency with lex order (Codex PR #90 P1) ────

    #[test]
    fn lattice_join_is_lex_lub() {
        // The original component-wise impl returned (2, 9) for these
        // — non-LUB under lex order. The fix uses lex max.
        let a = Pair::new(1u64, 9u32);
        let b = Pair::new(2u64, 0u32);
        let j = a.join(&b);
        assert_eq!(j, Pair::new(2u64, 0u32), "lex LUB of (1,9) and (2,0)");
        assert!(a.less_equal(&j));
        assert!(b.less_equal(&j));
        // Symmetry
        assert_eq!(b.join(&a), j);
    }

    #[test]
    fn lattice_meet_is_lex_glb() {
        let a = Pair::new(1u64, 9u32);
        let b = Pair::new(2u64, 0u32);
        let m = a.meet(&b);
        assert_eq!(m, Pair::new(1u64, 9u32), "lex GLB of (1,9) and (2,0)");
        assert!(m.less_equal(&a));
        assert!(m.less_equal(&b));
        assert_eq!(b.meet(&a), m);
    }

    #[test]
    fn lattice_idempotent() {
        let a = Pair::new(7u64, 3u32);
        assert_eq!(a.join(&a), a);
        assert_eq!(a.meet(&a), a);
    }

    #[test]
    fn lattice_associative_join() {
        let a = Pair::new(1u64, 5u32);
        let b = Pair::new(2u64, 0u32);
        let c = Pair::new(2u64, 9u32);
        // (a ∨ b) ∨ c == a ∨ (b ∨ c)
        let lhs = a.join(&b).join(&c);
        let rhs = a.join(&b.join(&c));
        assert_eq!(lhs, rhs);
    }
}
