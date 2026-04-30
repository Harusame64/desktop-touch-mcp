//! Owner / lifetime guard for UIA event handlers (ADR-007 P5c-1).
//!
//! Holds the `IUIAutomation*EventHandler` instances and the
//! `IUIAutomation` they were registered against, so the matching
//! `Remove*EventHandler` always runs (R3 leak prevention) — including
//! when the COM thread tears down via the `shutdown_uia_for_test` path
//! (R11/R12 polling shutdown).
//!
//! P5c-3 will add a `window_handler` slot, P5c-4 a `scroll_handler`
//! slot. Their `Remove*` APIs have different shapes (5-arg
//! `RemoveAutomationEventHandler` / `RemovePropertyChangedEventHandler`),
//! so each gets its own `if let Some(h) = ...` arm in `Drop` rather than
//! a generic loop.

use windows::Win32::UI::Accessibility::{
    IUIAutomation, IUIAutomationCacheRequest, IUIAutomationFocusChangedEventHandler,
};

/// Owns the registered handler instances for the UIA COM thread.
///
/// Constructed inside `com_thread_main` after `build_context`, dropped
/// before `CoUninitialize` so the `Remove*EventHandler` calls run while
/// the apartment is still alive.
pub(crate) struct UiaEventHandlerOwner {
    automation: IUIAutomation,
    focus_handler: Option<IUIAutomationFocusChangedEventHandler>,
    // Future slots:
    //   window_handler: Option<IUIAutomationEventHandler>,           // P5c-3
    //   scroll_handler: Option<IUIAutomationPropertyChangedEventHandler>, // P5c-4
}

impl UiaEventHandlerOwner {
    pub(crate) fn new(automation: IUIAutomation) -> Self {
        Self {
            automation,
            focus_handler: None,
        }
    }

    /// Register a focus-changed handler with the COM apartment.
    ///
    /// `AddFocusChangedEventHandler` takes **2 arguments** (`cache_request`,
    /// `handler`) — unlike the 5-arg `AddAutomationEventHandler` /
    /// `AddPropertyChangedEventHandler` used by P5c-3 / P5c-4. Focus
    /// events are delivered for the entire desktop by default, so no
    /// `root` / `scope` parameter is required.
    pub(crate) fn register_focus(
        &mut self,
        cache_request: &IUIAutomationCacheRequest,
        handler: IUIAutomationFocusChangedEventHandler,
    ) -> windows::core::Result<()> {
        unsafe {
            self.automation
                .AddFocusChangedEventHandler(cache_request, &handler)?;
        }
        self.focus_handler = Some(handler);
        Ok(())
    }
}

impl Drop for UiaEventHandlerOwner {
    fn drop(&mut self) {
        // R3 + R10: Drop must not panic (would double-unwind). Failures
        // here are best-effort — most realistic cause is the COM
        // apartment having already torn down, which is not actionable.
        if let Some(h) = self.focus_handler.take() {
            unsafe {
                if let Err(e) = self.automation.RemoveFocusChangedEventHandler(&h) {
                    eprintln!(
                        "[uia-event-handler] RemoveFocusChangedEventHandler failed: {e}"
                    );
                }
            }
        }
    }
}
