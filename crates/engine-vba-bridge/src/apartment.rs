//! STA worker thread management (ADR-015 §3.4).
//!
//! `Excel.Application` is a single-threaded apartment (STA) COM
//! object. All calls must originate from a thread that has called
//! `CoInitializeEx(COINIT_APARTMENTTHREADED)`. The structural pattern
//! mirrors `src/uia/thread.rs:1-50` (dedicated worker thread + a
//! crossbeam-channel command pump), with two intentional differences:
//!
//! 1. Apartment model: `src/uia/thread.rs` uses MTA
//!    (`COINIT_MULTITHREADED`); this module uses STA because Excel
//!    strictly requires it
//! 2. Lifetime: the UIA worker is a process-singleton (`OnceLock`);
//!    `ExcelSession` is per-instance so callers can hold multiple
//!    independent Excel.Application objects if they need to (e.g.
//!    parallel headless macro runs)
//!
//! ## Phase 1 scope
//!
//! Phase 1 ships the module skeleton + the `ExcelSession` handle type
//! signature. The actual worker spawn (`CoInitializeEx` + command
//! channel + `CoCreateInstance("Excel.Application")` + Drop-time
//! `CoUninitialize`) lands in Phase 2 alongside `excel.rs`. Phase 1
//! acceptance is `cargo build` + `cargo test` green; the stub here
//! compiles and exposes the type so Phase 2 can build on it without
//! re-shaping the public API.

use std::marker::PhantomData;

/// Owns one STA worker thread + the `IDispatch` pointer to
/// `Excel.Application` for the worker's lifetime.
///
/// Phase 1: opaque handle, only `new_stub()` constructor exposed so
/// downstream code (e.g. future Phase 2 `excel.rs`) can begin to
/// reference the type. Phase 2 replaces the body with the real worker
/// spawn + COM pointer + command channel.
pub struct ExcelSession {
    // Phase 2 will replace this with:
    //   - JoinHandle<()> for the STA worker thread
    //   - crossbeam_channel::Sender<Cmd> for the command pump
    //   - Atomic shutdown flag
    // See ADR-015 §3.4 for the design and `src/uia/thread.rs:1-100` for
    // the analogous (MTA) worker pattern.
    _phantom: PhantomData<*const ()>,
}

impl ExcelSession {
    /// Phase 1 stub constructor. Real spawn (`CoInitializeEx` +
    /// `CoCreateInstance`) lands in Phase 2.
    pub fn new_stub() -> Self {
        Self {
            _phantom: PhantomData,
        }
    }
}

// `ExcelSession` is not `Send` (the `PhantomData<*const ()>` makes it
// !Send + !Sync). Phase 2 will make it `Send` (the worker thread owns
// COM state; the handle just routes commands), but Phase 1 keeps it
// strictly !Send to prevent accidental misuse before the worker exists.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase1_stub_constructs() {
        let _s = ExcelSession::new_stub();
        // Phase 1 acceptance: the type compiles + constructs.
        // Phase 2 will add real spawn / shutdown / drop tests.
    }
}
