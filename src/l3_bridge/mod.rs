//! L3 bridge: root crate owns L1→L3 integration.
//!
//! This module is the seam between the root crate (which owns the L1 ring,
//! UIA / DXGI hooks, napi addon entry points, and all `windows-rs`
//! dependencies) and the `engine-perception` crate (a pure timely +
//! differential-dataflow compute crate, deliberately kept napi-free).
//!
//! ## Why the bridge lives in root, not in engine-perception
//!
//! Codex review v2 P1 rejected the alternative direction
//! (`engine-perception → desktop-touch-engine` dep). Putting the dep
//! the other way around would have pulled napi, ORT, tokenizers, and
//! `windows-rs` into engine-perception's transitive graph and broken
//! the contract from `docs/adr-008-d1-plan.md` §2 ("`engine-perception`
//! is napi-free / pure Rust"). The L1 ring is owned by the root crate,
//! so the natural place for the decode→push adapter is also the root
//! crate. See `docs/adr-007-p5c-plan.md` §2.2 / §6 / §12 for the full
//! rationale.
//!
//! ## Status
//!
//! P5c-0b lands the **scaffold only**. The actual `focus_pump` adapter
//! (subscribe to the L1 ring, decode `UiaFocusChangedPayload`, push
//! `engine_perception::input::FocusEvent` into the engine) is the
//! sub-batch D1-2 of `docs/adr-008-d1-plan.md`, which depends on
//! P5c-1 (UIA Focus Changed event hook) being merged first.
//!
//! The empty module is committed now so:
//!   1. The root crate's dep on `engine-perception` is exercised in CI
//!      (the dep would otherwise be dead until D1-2 lands and could
//!      regress unnoticed if `cargo check --workspace` doesn't catch
//!      a missing import path).
//!   2. P5c-1 has a place to drop the focus-event handler that pushes
//!      to the bridge, without re-litigating the crate boundary.

#![allow(dead_code)]

// Future submodules:
//   pub(crate) mod focus_pump;       // D1-2 (PR-γ)
//   pub(crate) mod dirty_rect_pump;  // ADR-008 D2
//   pub(crate) mod window_pump;      // ADR-008 D2
//   pub(crate) mod scroll_pump;      // ADR-008 D2
