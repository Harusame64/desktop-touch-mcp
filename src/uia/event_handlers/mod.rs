//! UIA event handlers (ADR-007 P5c-1).
//!
//! `IUIAutomation*EventHandler` implementations that push events into the
//! L1 ring. Each handler receives an `Arc<EventRing>` (the ring is the
//! only L1 surface they need; `L1Inner` itself stays private to the
//! `l1_capture::worker` module — see `docs/adr-007-p5c-1-plan.md` §1.3 (c)
//! for the privacy / scope-minimisation reasoning).
//!
//! Handler lifetime is owned by [`UiaEventHandlerOwner`]; its `Drop` impl
//! calls the matching `Remove*EventHandler` so the COM apartment can be
//! torn down cleanly. The owner is constructed and dropped on the UIA
//! COM thread (`src/uia/thread.rs::com_thread_main`) so the Remove call
//! always runs before `CoUninitialize`.

pub(crate) mod focus;
pub(crate) mod owner;

pub(crate) use owner::UiaEventHandlerOwner;
