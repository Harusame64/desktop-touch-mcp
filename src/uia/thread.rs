//! UIA COM thread singleton.
//!
//! A single dedicated thread owns the COM apartment (`CoInitializeEx` MTA) and
//! keeps an `IUIAutomation` instance alive for the entire process lifetime.
//! Callers on libuv worker threads send closures via `crossbeam-channel`;
//! each closure receives `&UiaContext` and posts its result back through a
//! one-shot reply channel.

use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

use crossbeam_channel::{bounded, unbounded, Sender};
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED, CoCreateInstance, CLSCTX_INPROC_SERVER,
};
use windows::Win32::UI::Accessibility::*;

// ─── Error conversion helper ─────────────────────────────────────────────────

/// Convert `windows::core::Error` to `napi::Error`.
pub(crate) fn win_err(e: windows::core::Error) -> napi::Error {
    napi::Error::from_reason(format!("UIA/COM error: {e}"))
}

// ─── Public context handed to every task closure ─────────────────────────────

pub(crate) struct UiaContext {
    pub automation: IUIAutomation,
    pub walker: IUIAutomationTreeWalker,
    pub cache_request: IUIAutomationCacheRequest,
    /// ControlView filter for `FindAllBuildCache(TreeScope_Children)`.
    /// Created once and reused — matches the ControlViewWalker scope.
    pub control_view_condition: IUIAutomationCondition,
}

// ─── Task type ───────────────────────────────────────────────────────────────

/// A boxed closure that borrows `UiaContext` on the COM thread.
pub(crate) type UiaTask = Box<dyn FnOnce(&UiaContext) + Send + 'static>;

// ─── Singleton sender ────────────────────────────────────────────────────────

static SENDER: OnceLock<Sender<UiaTask>> = OnceLock::new();

fn ensure_sender() -> &'static Sender<UiaTask> {
    SENDER.get_or_init(|| {
        let (tx, rx) = unbounded::<UiaTask>();
        thread::Builder::new()
            .name("uia-com".into())
            .spawn(move || com_thread_main(rx))
            .expect("Failed to spawn UIA COM thread");
        tx
    })
}

// ─── COM thread entry point ──────────────────────────────────────────────────

fn com_thread_main(rx: crossbeam_channel::Receiver<UiaTask>) {
    // Safety: COM is initialised exactly once on this thread and never shared.
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            eprintln!("[uia-com] CoInitializeEx failed: HRESULT 0x{:08x}", hr.0);
            return;
        }
    }

    let ctx = match build_context() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[uia-com] Failed to initialise UIA context: {e}");
            unsafe { CoUninitialize(); }
            return;
        }
    };

    // Main loop — process tasks until the channel is closed.
    while let Ok(task) = rx.recv() {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            task(&ctx);
        }));
        if let Err(info) = res {
            eprintln!("[uia-com] Task panicked: {info:?}");
        }
    }

    // The channel is closed when all `Sender` handles are dropped (process exit).
    unsafe { CoUninitialize(); }
}

/// Build persistent COM objects that live for the entire thread lifetime.
fn build_context() -> windows::core::Result<UiaContext> {
    unsafe {
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;

        let walker = automation.ControlViewWalker()?;

        // Per-element cache request (TreeScope_Element) — used by
        // FindAllBuildCache and BuildUpdatedCache across all modules.
        let cr = automation.CreateCacheRequest()?;
        configure_cache_properties(&cr)?;
        cr.SetTreeScope(TreeScope_Element)?;

        // ControlView condition — reused by BFS tree walks in tree.rs.
        // Equivalent to what ControlViewWalker uses internally.
        let cv_condition = automation.ControlViewCondition()?;

        Ok(UiaContext {
            automation,
            walker,
            cache_request: cr,
            control_view_condition: cv_condition,
        })
    }
}

/// Add the standard set of 7 properties + 6 patterns to a CacheRequest.
unsafe fn configure_cache_properties(cr: &IUIAutomationCacheRequest) -> windows::core::Result<()> {
    unsafe {
        cr.AddProperty(UIA_NamePropertyId)?;
        cr.AddProperty(UIA_ControlTypePropertyId)?;
        cr.AddProperty(UIA_AutomationIdPropertyId)?;
        cr.AddProperty(UIA_BoundingRectanglePropertyId)?;
        cr.AddProperty(UIA_IsEnabledPropertyId)?;
        cr.AddProperty(UIA_IsOffscreenPropertyId)?;
        cr.AddProperty(UIA_ClassNamePropertyId)?;

        cr.AddPattern(UIA_InvokePatternId)?;
        cr.AddPattern(UIA_ValuePatternId)?;
        cr.AddPattern(UIA_ExpandCollapsePatternId)?;
        cr.AddPattern(UIA_SelectionItemPatternId)?;
        cr.AddPattern(UIA_TogglePatternId)?;
        cr.AddPattern(UIA_ScrollPatternId)?;
    }
    Ok(())
}

// ─── Public helper for callers ───────────────────────────────────────────────

/// Execute a closure on the COM thread with a caller-specified timeout.
pub(crate) fn execute_with_timeout<F, T>(f: F, timeout_ms: u32) -> napi::Result<T>
where
    F: FnOnce(&UiaContext) -> napi::Result<T> + Send + 'static,
    T: Send + 'static,
{
    let (reply_tx, reply_rx) = bounded(1);
    let task: UiaTask = Box::new(move |ctx| {
        let result = f(ctx);
        let _ = reply_tx.send(result);
    });
    ensure_sender()
        .send(task)
        .map_err(|_| napi::Error::from_reason("UIA COM thread unavailable"))?;
    reply_rx
        .recv_timeout(Duration::from_millis(timeout_ms as u64))
        .map_err(|e| match e {
            crossbeam_channel::RecvTimeoutError::Timeout => {
                napi::Error::from_reason(format!(
                    "UIA operation timed out after {timeout_ms}ms"
                ))
            }
            crossbeam_channel::RecvTimeoutError::Disconnected => {
                napi::Error::from_reason("UIA COM thread disconnected")
            }
        })?
}
