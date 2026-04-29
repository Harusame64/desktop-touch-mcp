//! Panic containment helpers (ADR-007 §3.4).
//!
//! Sync `#[napi]` exports MUST wrap their bodies in `napi_safe_call`. A panic
//! that escapes a sync `#[napi]` function unwinds across the napi-rs FFI
//! boundary onto the libuv main thread, which crashes the Node process. The
//! `catch_unwind` here turns any panic into a `napi::Error::from_reason` that
//! the JS side receives as a thrown `Error`, preserving process liveness.
//!
//! `PANIC_COUNTER` is exposed for `server_status.panic_rate_per_min`
//! (統合書 §17.6, P5a). Until P5a wires the read API, the symbol is unused
//! at runtime; the `#[allow(dead_code)]` keeps clippy quiet during P1.

use std::panic::{catch_unwind, UnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};

#[allow(dead_code)]
pub static PANIC_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Run `f` and convert any panic into a typed `napi::Error`. Increments
/// `PANIC_COUNTER` on hit so steady-state monitoring (panic_rate_per_min)
/// can detect regressions (ADR-007 §3.4.3).
pub fn napi_safe_call<T, F>(name: &'static str, f: F) -> napi::Result<T>
where
    F: FnOnce() -> napi::Result<T> + UnwindSafe,
{
    match catch_unwind(f) {
        Ok(result) => result,
        Err(payload) => {
            PANIC_COUNTER.fetch_add(1, Ordering::Relaxed);
            let detail = if let Some(s) = payload.downcast_ref::<&'static str>() {
                (*s).to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "<non-string panic payload>".to_string()
            };
            Err(napi::Error::from_reason(format!(
                "panic in {name}: {detail}"
            )))
        }
    }
}
