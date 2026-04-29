use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver, Sender};

use super::envelope::{EventKind, InternalEvent, TimestampSource};
use super::payload::{
    encode_payload, FailurePayload, HeartbeatPayload, SessionEndPayload, SessionStartPayload,
};
use super::ring::{ring_capacity_from_env, EventRing};

// ─── sub_ordinal helper ──────────────────────────────────────────────────────
// P5a: single StdTime source. Simple monotonic counter — satisfies the
// uniqueness invariant without the full per-source HashMap (P5d concern).

static SUB_ORDINAL: AtomicU32 = AtomicU32::new(0);

fn next_sub_ordinal() -> u32 {
    SUB_ORDINAL.fetch_add(1, Ordering::Relaxed)
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ─── Event builder ───────────────────────────────────────────────────────────

pub(crate) fn build_event(
    kind: u16,
    payload: Vec<u8>,
    session_id: Option<String>,
    tool_call_id: Option<String>,
) -> InternalEvent {
    InternalEvent {
        envelope_version: 1,
        event_id: 0, // assigned by ring.push()
        wallclock_ms: now_ms(),
        sub_ordinal: next_sub_ordinal(),
        timestamp_source: TimestampSource::StdTime as u8,
        kind,
        payload,
        session_id,
        tool_call_id,
    }
}

pub(crate) fn make_failure_event(
    layer: &str,
    op: &str,
    reason: &str,
    panic_payload: Option<String>,
) -> InternalEvent {
    build_event(
        EventKind::Failure as u16,
        encode_payload(&FailurePayload {
            layer: layer.to_owned(),
            op: op.to_owned(),
            reason: reason.to_owned(),
            panic_payload,
        }),
        None,
        None,
    )
}

fn make_session_start_event() -> InternalEvent {
    build_event(
        EventKind::SessionStart as u16,
        encode_payload(&SessionStartPayload {
            envelope_version: 1,
            addon_version: env!("CARGO_PKG_VERSION").to_owned(),
        }),
        None,
        None,
    )
}

fn make_session_end_event(reason: &str) -> InternalEvent {
    build_event(
        EventKind::SessionEnd as u16,
        encode_payload(&SessionEndPayload {
            reason: reason.to_owned(),
        }),
        None,
        None,
    )
}

fn make_heartbeat_event(ring: &EventRing, started_at: Instant) -> InternalEvent {
    let stats = ring.stats();
    build_event(
        EventKind::Heartbeat as u16,
        encode_payload(&HeartbeatPayload {
            uptime_ms: started_at.elapsed().as_millis() as u64,
            event_count: stats.push_count,
            drop_count: stats.drop_count,
        }),
        None,
        None,
    )
}

// ─── Worker thread ───────────────────────────────────────────────────────────

fn worker_loop(ring: Arc<EventRing>, shutdown: Receiver<()>, started_at: Instant) {
    let heartbeat_interval = Duration::from_millis(1000);
    loop {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match shutdown.recv_timeout(heartbeat_interval) {
                Ok(()) | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    ring.push(make_session_end_event("shutdown"));
                    false // signal exit
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                    ring.push(make_heartbeat_event(&ring, started_at));
                    true // continue
                }
            }
        }));
        match result {
            Ok(true) => continue,
            Ok(false) => return,
            Err(payload) => {
                let detail = if let Some(s) = payload.downcast_ref::<&'static str>() {
                    (*s).to_string()
                } else if let Some(s) = payload.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "<non-string panic payload>".to_string()
                };
                ring.push(make_failure_event(
                    "L1-worker",
                    "loop_panic",
                    "WorkerPanic",
                    Some(detail),
                ));
                // Continue loop — auto-restart equivalent without thread respawn.
            }
        }
    }
}

// ─── L1Inner ─────────────────────────────────────────────────────────────────

pub(crate) struct L1Inner {
    pub ring: Arc<EventRing>,
    pub started_at: Instant,
    shutdown_tx: Sender<()>,
    join_handle: Mutex<Option<thread::JoinHandle<()>>>,
}

impl L1Inner {
    pub fn shutdown_with_timeout(&self, timeout: Duration) -> Result<(), &'static str> {
        // Idempotent: bounded(1) なので 2 回送ると Err。無視して join 側へ進む。
        let _ = self.shutdown_tx.try_send(());
        let handle_opt = {
            let mut guard = self.join_handle.lock().unwrap_or_else(|e| e.into_inner());
            guard.take()
        };
        let handle = match handle_opt {
            Some(h) => h,
            None => return Ok(()), // already joined
        };
        // std::thread::JoinHandle::join に timeout API が無いので、別 thread で
        // join → mpsc で完了通知 → 元 thread が recv_timeout で待つ。
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        thread::spawn(move || {
            let _ = handle.join();
            let _ = tx.send(());
        });
        match rx.recv_timeout(timeout) {
            Ok(()) => Ok(()),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("worker join timed out"),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("join helper disconnected"),
        }
    }
}

impl Drop for L1Inner {
    fn drop(&mut self) {
        // Best-effort: shutdown signal だけ送る。Join は呼び出し元責務
        // (shutdown_with_timeout 経由)。Drop で block しない。
        let _ = self.shutdown_tx.try_send(());
    }
}

// ─── Static slot ─────────────────────────────────────────────────────────────

// OnceLock で slot 自体を 1 回だけ初期化。Mutex<Option<Arc<L1Inner>>> で
// inner を take/replace 可能にし、test 中の再 init を支援。
static L1_SLOT: OnceLock<Mutex<Option<Arc<L1Inner>>>> = OnceLock::new();

pub(crate) fn ensure_l1() -> Arc<L1Inner> {
    let cell = L1_SLOT.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(Arc::new(spawn_l1_inner()));
    }
    Arc::clone(guard.as_ref().unwrap())
}

/// L1 worker を shutdown して slot を None に戻す。次の `ensure_l1()` 呼び出しで
/// 再 init される (test の 5 回連続 shutdown/restart に対応)。
pub(crate) fn shutdown_l1_for_test(timeout: Duration) -> Result<(), &'static str> {
    let cell = match L1_SLOT.get() {
        Some(c) => c,
        None => return Ok(()),
    };
    let inner_opt = {
        let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
        guard.take()
    };
    match inner_opt {
        Some(inner) => inner.shutdown_with_timeout(timeout),
        None => Ok(()),
    }
}

fn spawn_l1_inner() -> L1Inner {
    let ring = Arc::new(EventRing::new(ring_capacity_from_env()));
    let (shutdown_tx, shutdown_rx) = bounded::<()>(1);
    let ring_for_worker = Arc::clone(&ring);
    let started_at = Instant::now();

    // Register the napi_safe_call panic hook so every caught panic also
    // produces a Failure event in the L1 ring. OnceLock::set only succeeds
    // once; the hook calls ensure_l1() dynamically so it always pushes to
    // the *current* ring even after test shutdown/restart cycles.
    let _ = crate::win32::safety::register_l1_panic_hook(|name, detail| {
        ensure_l1().ring.push(make_failure_event(
            "napi_safe_call",
            name,
            "Panic",
            Some(detail),
        ));
    });

    // SessionStart を最初に push してから worker thread を起動
    ring.push(make_session_start_event());

    let join = thread::Builder::new()
        .name("l1-capture".into())
        .spawn(move || worker_loop(ring_for_worker, shutdown_rx, started_at))
        .expect("spawn l1-capture thread");

    L1Inner {
        ring,
        started_at,
        shutdown_tx,
        join_handle: Mutex::new(Some(join)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn ensure_l1_returns_same_instance() {
        let a = ensure_l1();
        let b = ensure_l1();
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn shutdown_and_restart() {
        // 5 回連続 shutdown → ensure_l1 で再 init できること (§11.3)
        for _ in 0..5 {
            let _inner = ensure_l1();
            shutdown_l1_for_test(Duration::from_secs(2)).expect("shutdown failed");
        }
    }

    #[test]
    fn session_start_event_in_ring_after_ensure() {
        let _ = shutdown_l1_for_test(Duration::from_secs(2));
        let inner = ensure_l1();
        // Ring should have at least 1 event (SessionStart)
        let events = inner.ring.poll(u64::MAX, 100);
        // poll(MAX) returns nothing since no event_id > MAX
        // Use poll(0) ... actually event_id 0 is the SessionStart pushed first.
        // Drain all from before event_id 0 is impossible with u64 since 0 is min.
        // Instead verify push_count > 0
        let stats = inner.ring.stats();
        assert!(stats.push_count >= 1, "SessionStart should be in ring");
        let _ = shutdown_l1_for_test(Duration::from_secs(2));
    }
}
