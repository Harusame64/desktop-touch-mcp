//! L1 → engine-perception input boundary.
//!
//! ## Direction of dep
//!
//! The root crate (`desktop-touch-engine`) owns the L1 capture ring,
//! decodes `EventEnvelope` payloads, and pushes pure data into a
//! [`L1Sink`] implementation provided by this crate. The reverse
//! direction (engine-perception depending on the root crate) was
//! considered and rejected in Codex review v2 P1 — it would drag the
//! root crate's heavy compile graph (napi, ORT, tokenizers,
//! windows-rs, vision-gpu) into this crate and break the
//! "pure timely + DD compute" contract from
//! `docs/adr-008-d1-plan.md` §2.
//!
//! ## D1-2 wiring
//!
//! P5c-0b lands the trait + the `FocusEvent` data type as a stable
//! contract that the bridge in `src/l3_bridge/focus_pump.rs` (D1-2,
//! a follow-up PR) will write against. The actual `FocusInputHandle`
//! that wraps a `differential_dataflow::input::InputSession` lives
//! here in this crate but is filled in alongside D1-2 — keeping the
//! `timely` / `differential-dataflow` API surface out of this PR
//! (PR-P5c-0b) which is intentionally limited to plumbing.

#![allow(dead_code)] // populated by D1-2

use std::sync::{Arc, Mutex};

/// A focus-changed event received from the root-side bridge.
///
/// All fields are pure Rust — no `windows-rs` types, no napi types.
/// `hwnd: 0` is a valid unresolved case (the focused UIA element has
/// no resolvable native window). Consumers must not crash on it; the
/// `current_focused_element` view will key by `hwnd` and treat 0 as
/// the "unattached" bucket per the contract in
/// `docs/adr-008-d1-plan.md` §3 D1-2.
#[derive(Debug, Clone)]
pub struct FocusEvent {
    pub hwnd: u64,
    pub name: String,
    pub automation_id: Option<String>,
    /// Raw `UIA_CONTROLTYPE_ID` (e.g. `50000` = Button). The string
    /// mapping happens at the L4 envelope layer, not here.
    pub control_type: u32,
    pub window_title: String,
    pub wallclock_ms: u64,
    pub sub_ordinal: u32,
}

/// The seam through which the root-side bridge pushes decoded L1
/// events into this crate. Implementors are expected to forward into
/// a `differential_dataflow::input::InputSession` (see
/// [`FocusInputHandle`]).
///
/// Each method takes `&self`, not `&mut self`, because the bridge
/// runs on a dedicated thread and the InputSession sits behind a
/// `Mutex`. A trait object (`Arc<dyn L1Sink>`) is the expected
/// transport — handing the bridge a concrete type would force the
/// root crate to name `differential_dataflow::input::InputSession`,
/// re-introducing the dep direction we just rejected.
pub trait L1Sink: Send + Sync {
    /// Push a focus-changed event. D1-2 wires this to the
    /// `current_focused_element` view's input session.
    fn push_focus(&self, event: FocusEvent);

    // P5c-2 / P5c-3 / P5c-4 will extend this trait with
    // `push_dirty_rect`, `push_window_change`, `push_scroll`. They
    // are deliberately omitted in P5c-0b to keep the contract small
    // until the corresponding L1 emitters exist.
}

/// Handle the bridge keeps to push focus events. The actual
/// `differential_dataflow::input::InputSession` is wrapped here in a
/// later sub-batch (D1-2). Lives in this crate so the timely / DD
/// types stay private to engine-perception.
pub struct FocusInputHandle {
    inner: Arc<Mutex<FocusInputState>>,
}

/// Private state behind the [`FocusInputHandle`]. Currently a
/// placeholder; D1-2 replaces this with
/// `InputSession<Pair<u64, u32>, FocusEvent, isize>` plus the
/// last-seen-per-hwnd map needed for retraction.
struct FocusInputState {
    // Populated in D1-2.
}

impl FocusInputHandle {
    /// Construct a handle. D1-2 takes a `Worker` / `InputSession` and
    /// returns one of these wired to that session; for P5c-0b this
    /// is just the public stub.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(FocusInputState {})),
        }
    }
}

impl Default for FocusInputHandle {
    fn default() -> Self {
        Self::new()
    }
}

impl L1Sink for FocusInputHandle {
    fn push_focus(&self, _event: FocusEvent) {
        // D1-2: forward to the wrapped InputSession + advance frontier.
        let _guard = self.inner.lock().expect("FocusInputState poisoned");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_input_handle_compiles_and_accepts_push() {
        // P5c-0b smoke: the trait exists, the handle constructs, push
        // is callable. Real semantics arrive in D1-2.
        let h = FocusInputHandle::new();
        h.push_focus(FocusEvent {
            hwnd: 0,
            name: "test".into(),
            automation_id: None,
            control_type: 50000,
            window_title: String::new(),
            wallclock_ms: 0,
            sub_ordinal: 0,
        });
    }

    #[test]
    fn l1sink_object_safety() {
        // Trait must be object-safe so the bridge can hold
        // `Arc<dyn L1Sink>` without naming the concrete type.
        let _h: Arc<dyn L1Sink> = Arc::new(FocusInputHandle::new());
    }
}
