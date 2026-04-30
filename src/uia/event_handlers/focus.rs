//! UIA Focus Changed event handler (ADR-007 P5c-1).
//!
//! Implements [`IUIAutomationFocusChangedEventHandler`] and pushes a
//! `EventKind::UiaFocusChanged` envelope into the L1 ring on every focus
//! change delivered by the UIA COM apartment.
//!
//! ## Design choices (see `docs/adr-007-p5c-1-plan.md` §5)
//!
//! - **`Arc<EventRing>` instead of `Arc<L1Inner>`** (Codex review v1 P1):
//!   `L1Inner` is private; `EventRing` is `pub` re-exported from
//!   `l1_capture::mod`. The handler only ever needs `ring.push()`, so
//!   the narrower borrow keeps privacy clean and the import surface
//!   minimal.
//! - **Cached* methods only** in [`crate::uia::focus::cached_element_to_focus_info`]:
//!   the COM delivery thread must not touch live UIA (would block /
//!   deadlock the COM apartment). `UIA_NativeWindowHandlePropertyId` was
//!   added to the cache request in P5c-0b so `CachedNativeWindowHandle`
//!   resolves without falling back to a live call.
//! - **`get_root_hwnd(GA_ROOT)` before reading the title** (Codex review
//!   v1 P2 #1): `cached_element_to_focus_info` returns the focused
//!   element's own hwnd, which is a child-control HWND for Edit/TextBox
//!   focus. Reading `GetWindowTextW` on that yields empty/control text;
//!   the GA_ROOT normalisation gives us the containing top-level title.
//! - **`catch_unwind` at the outermost layer** (R1): a panic inside an
//!   `IUIAutomation*EventHandler` would unwind across the COM ABI
//!   (UB) and tear down the whole UIA thread. We catch, push a
//!   `Failure` event, and always return `Ok(())` to the COM caller.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

use windows::core::{implement, Ref, Result};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Accessibility::{
    IUIAutomationElement, IUIAutomationFocusChangedEventHandler,
    IUIAutomationFocusChangedEventHandler_Impl,
};

// `payload` module is private; struct re-exports live in `l1_capture::mod`
// (`pub use payload::{...}` at l9-14). Codex review v2 P1 reminder.
use crate::l1_capture::{
    build_event, encode_payload, make_failure_event, EventKind, EventRing, UiElementRef,
    UiaFocusChangedPayload,
};
use crate::uia::focus::cached_element_to_focus_info;
use crate::win32::window::{get_root_hwnd, get_window_text};

/// COM-callable handler that converts each `UiaFocusChanged` event into an
/// L1 ring envelope. Owned by [`super::UiaEventHandlerOwner`].
#[implement(IUIAutomationFocusChangedEventHandler)]
pub(crate) struct FocusEventHandler {
    ring: Arc<EventRing>,
}

impl IUIAutomationFocusChangedEventHandler_Impl for FocusEventHandler_Impl {
    fn HandleFocusChangedEvent(&self, sender: Ref<'_, IUIAutomationElement>) -> Result<()> {
        // R1: a panic crossing the COM ABI is UB. Catch everything, log
        // it as a Failure event in the ring, and always return Ok(()) so
        // the COM apartment stays alive.
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            // `Ref::ok()` returns Result<&I>; treat E_POINTER (no sender)
            // as a graceful skip rather than an error.
            let Ok(elem) = sender.ok() else { return };
            let Some(info) = cached_element_to_focus_info(elem) else { return };

            // Codex v1 P2 #1: normalise child HWND → top-level via GA_ROOT
            // before reading the title. Otherwise focus on an Edit /
            // TextBox child returns empty text from GetWindowTextW.
            //
            // `payload.window_title`   = top-level (root) window title
            // `UiElementRef.hwnd`      = focused element's own hwnd
            //                            (child or self, possibly 0 when
            //                            CachedNativeWindowHandle was NULL)
            let window_title = if info.hwnd != 0 {
                let element_hwnd = HWND(info.hwnd as isize as *mut std::ffi::c_void);
                let root = get_root_hwnd(element_hwnd);
                get_window_text(root)
            } else {
                String::new()
            };

            let payload = UiaFocusChangedPayload {
                before: None, // P5c-1 does not track previous focus
                after: Some(UiElementRef {
                    hwnd: info.hwnd,
                    name: info.name,
                    automation_id: info.automation_id,
                    control_type: info.control_type,
                }),
                window_title,
            };

            let event = build_event(
                EventKind::UiaFocusChanged as u16,
                encode_payload(&payload),
                None,
                None,
            );
            self.ring.push(event);
        }));

        if let Err(panic_payload) = outcome {
            let detail = if let Some(s) = panic_payload.downcast_ref::<&'static str>() {
                (*s).to_string()
            } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "<non-string panic payload>".to_string()
            };
            let event = make_failure_event(
                "uia-event-handler",
                "HandleFocusChangedEvent",
                "HandlerPanic",
                Some(detail),
            );
            self.ring.push(event);
        }

        Ok(())
    }
}

/// Build a COM-callable focus-changed handler bound to the given ring.
/// The returned `IUIAutomationFocusChangedEventHandler` is what
/// [`super::UiaEventHandlerOwner::register_focus`] passes to
/// `AddFocusChangedEventHandler`.
pub(crate) fn make_focus_handler(ring: Arc<EventRing>) -> IUIAutomationFocusChangedEventHandler {
    FocusEventHandler { ring }.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::l1_capture::ensure_l1;

    /// Sanity smoke: the handler can be constructed against the L1 ring
    /// and dropped without panic. Also exercises the
    /// `windows::core::implement` macro expansion (P5c-1 is the first
    /// place we use `#[implement]`) and the `Arc<EventRing>` borrow
    /// path (Codex review v1 P1).
    ///
    /// Live event-delivery testing requires a real UIA apartment +
    /// foreground focus changes, which is gated to vitest (planned
    /// follow-up PR — Notepad has known MSStore alias hangs on Win11
    /// per `memory/feedback_notepad_launcher_msstore_hang.md`, so the
    /// live test needs a different fixture).
    #[test]
    fn make_focus_handler_constructs_and_drops_cleanly() {
        let ring = ensure_l1().ring.clone();
        let handler = make_focus_handler(ring);
        // Force the drop here (COM `AddRef` → `Release` once).
        drop(handler);
    }
}
