use crossbeam_channel::{bounded, Sender, TrySendError};
use crossbeam_queue::ArrayQueue;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use super::envelope::{EventEnvelope, InternalEvent};

pub struct CaptureStats {
    pub push_count: u64,
    pub drop_count: u64,
    pub current_buffered: usize,
    pub event_id_high_water: u64,
}

/// Pure-Rust snapshot of an `InternalEvent`, distributed to broadcast
/// subscribers (`EventRing::subscribe`).
///
/// Why a separate type from [`EventEnvelope`]:
/// - `EventEnvelope` carries napi types (`BigInt`, `Buffer`) intended
///   for the JS surface. Subscribers live entirely in Rust (the L3
///   bridge in `src/l3_bridge/`) and don't want the BigInt round-trip
///   on the hot path.
/// - `payload: Arc<[u8]>` makes per-subscriber `clone()` cheap (just
///   refcount), so multi-subscriber fan-out doesn't allocate per
///   subscriber.
///
/// Codex review v2 P1 — keep this type napi-free so it never gets
/// pulled into `#[napi(object)]` codegen.
#[derive(Clone, Debug)]
pub struct SubscriptionEvent {
    pub event_id: u64,
    pub kind: u16,
    pub wallclock_ms: u64,
    pub sub_ordinal: u32,
    pub timestamp_source: u8,
    pub envelope_version: u32,
    pub payload: Arc<[u8]>,
    pub session_id: Option<String>,
    pub tool_call_id: Option<String>,
}

impl From<&InternalEvent> for SubscriptionEvent {
    fn from(e: &InternalEvent) -> Self {
        SubscriptionEvent {
            event_id: e.event_id,
            kind: e.kind,
            wallclock_ms: e.wallclock_ms,
            sub_ordinal: e.sub_ordinal,
            timestamp_source: e.timestamp_source,
            envelope_version: e.envelope_version,
            payload: Arc::from(e.payload.as_slice()),
            session_id: e.session_id.clone(),
            tool_call_id: e.tool_call_id.clone(),
        }
    }
}

/// Per-subscriber slot inside `EventRing.subscribers`.
struct SubscriberSlot {
    tx: Sender<SubscriptionEvent>,
    /// Shared with the [`Subscription`] so the receiver side can read
    /// its own drop count via `Subscription::dropped_count()`.
    drop_count: Arc<AtomicU64>,
}

/// Handle returned by [`EventRing::subscribe`]. Drop unsubscribes
/// automatically — broadcast subscribers do not leak slots.
///
/// **Drop-newest semantics on full** (Codex review v1 P2-1): when the
/// subscriber's bounded channel is full, `EventRing::push` discards
/// the *new* snapshot, not the oldest already in the channel. The
/// counter exposed via [`Self::dropped_count`] tracks how many
/// snapshots were dropped this way.
pub struct Subscription {
    rx: crossbeam_channel::Receiver<SubscriptionEvent>,
    id: u64,
    parent: Arc<EventRing>,
    /// Read by `dropped_count()`. Marked `allow` because the only
    /// production caller path today is `dropped_count()` itself,
    /// which is reserved for D2 metrics + already exercised by unit
    /// tests. Removing the field would silently regress the
    /// drop-newest visibility once D2 wires it up.
    #[allow(dead_code)]
    drop_count: Arc<AtomicU64>,
}

#[allow(dead_code)] // D1-2: focus_pump uses recv_timeout; the other
                    // accessors (try_recv / recv / dropped_count) are
                    // reserved for D2 metrics + bench harness (D1-5).
impl Subscription {
    pub fn try_recv(&self) -> Result<SubscriptionEvent, crossbeam_channel::TryRecvError> {
        self.rx.try_recv()
    }

    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<SubscriptionEvent, crossbeam_channel::RecvTimeoutError> {
        self.rx.recv_timeout(timeout)
    }

    pub fn recv(&self) -> Result<SubscriptionEvent, crossbeam_channel::RecvError> {
        self.rx.recv()
    }

    /// Snapshots dropped because this subscriber's bounded channel was
    /// full at push time. Drop-newest, not drop-oldest.
    pub fn dropped_count(&self) -> u64 {
        self.drop_count.load(Ordering::Relaxed)
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.parent.unsubscribe(self.id);
    }
}

pub struct EventRing {
    queue: ArrayQueue<InternalEvent>,
    event_id_counter: AtomicU64,
    drop_count: AtomicU64,
    push_count: AtomicU64,
    /// Broadcast subscribers (ADR-008 D1-2). Each subscriber receives
    /// a `SubscriptionEvent` snapshot at every `push()`. Independent
    /// of the destructive `pop()` path used by the napi `l1Poll`
    /// surface — both paths can coexist on the same ring.
    subscribers: RwLock<HashMap<u64, SubscriberSlot>>,
    subscriber_id_counter: AtomicU64,
}

impl EventRing {
    pub fn new(capacity: usize) -> Self {
        EventRing {
            queue: ArrayQueue::new(capacity),
            // Start at 1 so that cursor 0 is the universal "beginning of time"
            // sentinel: poll(since=0, max) returns every event in the ring.
            event_id_counter: AtomicU64::new(1),
            drop_count: AtomicU64::new(0),
            push_count: AtomicU64::new(0),
            subscribers: RwLock::new(HashMap::new()),
            subscriber_id_counter: AtomicU64::new(1),
        }
    }

    /// Drop-oldest 押し込み。`force_push` は満杯時に最古を pop して捨てる。
    /// 返値は採番された `event_id`。
    ///
    /// Broadcast (ADR-008 D1-2): when subscribers exist, the snapshot
    /// is also fanned out to every subscriber's bounded channel via
    /// `try_send`. Full channels discard the *new* snapshot
    /// (drop-newest, Codex P2-1). Subscribers absent → no snapshot
    /// is built (early return on `is_empty()`), preserving the
    /// existing push p99 < 1ms SLO.
    pub fn push(&self, mut event: InternalEvent) -> u64 {
        let id = self.event_id_counter.fetch_add(1, Ordering::SeqCst);
        event.event_id = id;

        // ─── Broadcast fan-out (drop-newest on full) ─────────────────
        // Read-lock the subscribers map; if empty, skip snapshot
        // construction entirely so the hot path keeps its SLO.
        let subs_guard = self.subscribers.read().unwrap_or_else(|e| e.into_inner());
        if !subs_guard.is_empty() {
            let snapshot = SubscriptionEvent::from(&event);
            for slot in subs_guard.values() {
                match slot.tx.try_send(snapshot.clone()) {
                    Ok(_) => {}
                    Err(TrySendError::Full(_)) => {
                        // Drop-newest: the new snapshot is the one
                        // that was rejected. Counter is observable
                        // via Subscription::dropped_count().
                        slot.drop_count.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        // Subscription dropped between our read-lock
                        // and try_send — its Drop will clear the slot
                        // on its own. No-op here.
                    }
                }
            }
        }
        drop(subs_guard);
        // ────────────────────────────────────────────────────────────

        if self.queue.force_push(event).is_some() {
            self.drop_count.fetch_add(1, Ordering::Relaxed);
        }
        self.push_count.fetch_add(1, Ordering::Relaxed);
        id
    }

    /// `since_event_id` より新しい event を最大 `max` 件 drain して返す。
    /// drain は破壊的操作 — 同じ event が二度返ることはない。
    pub fn poll(&self, since_event_id: u64, max: usize) -> Vec<EventEnvelope> {
        let mut buf = Vec::with_capacity(max.min(self.queue.len()));
        while buf.len() < max {
            match self.queue.pop() {
                Some(e) if e.event_id > since_event_id => buf.push(EventEnvelope::from(&e)),
                Some(_) => continue, // since_event_id 以下は捨てる (drop-oldest で gap が生じた場合)
                None => break,
            }
        }
        buf
    }

    pub fn stats(&self) -> CaptureStats {
        CaptureStats {
            push_count: self.push_count.load(Ordering::Relaxed),
            drop_count: self.drop_count.load(Ordering::Relaxed),
            current_buffered: self.queue.len(),
            event_id_high_water: self.event_id_counter.load(Ordering::Relaxed).saturating_sub(1),
        }
    }

    /// Number of currently-registered broadcast subscribers. Test-only
    /// observation — do not depend on this on the hot path.
    #[allow(dead_code)] // exercised by unit + lifecycle tests; reserved
                        // for D2 metrics endpoint.
    pub fn subscriber_count(&self) -> usize {
        self.subscribers
            .read()
            .map(|g| g.len())
            .unwrap_or(0)
    }

    /// Register a broadcast subscriber that receives every subsequent
    /// `push()` as a `SubscriptionEvent` snapshot.
    ///
    /// **Not historical replay** (Codex P2-2): only events pushed
    /// *after* this call are delivered. Callers that need to observe
    /// pushes performed shortly after `subscribe` must do the
    /// subscribe **before** the push (e.g., bridge spawn helpers do
    /// it on the parent thread, see `FocusPump::spawn` Codex v2 P1).
    ///
    /// `capacity` is the per-subscriber bounded channel size. Full
    /// channels drop the *new* snapshot (drop-newest); see
    /// `Subscription::dropped_count`.
    pub fn subscribe(self: &Arc<Self>, capacity: usize) -> Subscription {
        let id = self.subscriber_id_counter.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = bounded::<SubscriptionEvent>(capacity);
        let drop_count = Arc::new(AtomicU64::new(0));

        {
            let mut subs = self
                .subscribers
                .write()
                .unwrap_or_else(|e| e.into_inner());
            subs.insert(
                id,
                SubscriberSlot {
                    tx,
                    drop_count: Arc::clone(&drop_count),
                },
            );
        }

        Subscription {
            rx,
            id,
            parent: Arc::clone(self),
            drop_count,
        }
    }

    fn unsubscribe(&self, id: u64) {
        let mut subs = self
            .subscribers
            .write()
            .unwrap_or_else(|e| e.into_inner());
        subs.remove(&id);
    }
}

pub fn ring_capacity_from_env() -> usize {
    std::env::var("DESKTOP_TOUCH_RING_CAPACITY")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n >= 1024 && n <= 10_000_000)
        .unwrap_or(1_000_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::l1_capture::{EventKind, TimestampSource};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_event(kind: u16) -> InternalEvent {
        InternalEvent {
            envelope_version: 1,
            event_id: 0, // overwritten by push()
            wallclock_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            sub_ordinal: 0,
            timestamp_source: TimestampSource::StdTime as u8,
            kind,
            payload: vec![],
            session_id: None,
            tool_call_id: None,
        }
    }

    fn make_event_with_payload(kind: u16, payload: Vec<u8>) -> InternalEvent {
        let mut e = make_event(kind);
        e.payload = payload;
        e
    }

    #[test]
    fn push_assigns_monotonic_ids() {
        let ring = EventRing::new(16);
        let id0 = ring.push(make_event(EventKind::Heartbeat as u16));
        let id1 = ring.push(make_event(EventKind::Heartbeat as u16));
        let id2 = ring.push(make_event(EventKind::Heartbeat as u16));
        assert!(id0 < id1);
        assert!(id1 < id2);
    }

    #[test]
    fn poll_returns_events_after_cursor() {
        let ring = EventRing::new(16);
        let id0 = ring.push(make_event(EventKind::Heartbeat as u16));
        let id1 = ring.push(make_event(EventKind::Heartbeat as u16));
        let id2 = ring.push(make_event(EventKind::Heartbeat as u16));
        let _ = (id0, id1);

        let got = ring.poll(id1, 10);
        assert_eq!(got.len(), 1);
        let (_, ev_id, _) = got[0].event_id.get_u128();
        assert_eq!(ev_id as u64, id2);
    }

    #[test]
    fn drop_oldest_when_full() {
        let cap = 8usize;
        let ring = EventRing::new(cap);
        // push cap + 4 events
        for _ in 0..cap + 4 {
            ring.push(make_event(EventKind::Heartbeat as u16));
        }
        let stats = ring.stats();
        assert_eq!(stats.drop_count, 4);
        assert_eq!(stats.push_count, (cap + 4) as u64);
        assert_eq!(stats.current_buffered, cap);
    }

    #[test]
    fn poll_all_returns_all_buffered() {
        let ring = EventRing::new(16);
        ring.push(make_event(EventKind::SessionStart as u16));
        ring.push(make_event(EventKind::Heartbeat as u16));
        ring.push(make_event(EventKind::SessionEnd as u16));

        let got = ring.poll(u64::MAX.wrapping_sub(1), 100);
        // since_event_id = MAX-1, all event_ids are < MAX so this returns nothing
        assert_eq!(got.len(), 0);

        // Re-insert; poll from 0 should return all
        let ring2 = EventRing::new(16);
        ring2.push(make_event(EventKind::Heartbeat as u16));
        ring2.push(make_event(EventKind::Heartbeat as u16));
        let got2 = ring2.poll(u64::MAX, 100); // no event can be > MAX
        assert_eq!(got2.len(), 0);
    }

    #[test]
    fn poll_from_zero_returns_all() {
        let ring = EventRing::new(16);
        // IDs start at 1; cursor 0 is the "beginning of time" sentinel.
        let id0 = ring.push(make_event(EventKind::Heartbeat as u16));
        let _ = ring.push(make_event(EventKind::Heartbeat as u16));
        let _ = ring.push(make_event(EventKind::Heartbeat as u16));
        assert_eq!(id0, 1); // first ID is now 1
        // poll(since = 0) means "since before any event" → returns all 3.
        let got = ring.poll(0, 10);
        assert_eq!(got.len(), 3);
    }

    // ─── Broadcast subscribe tests (ADR-008 D1-2) ─────────────────────

    #[test]
    fn single_subscriber_receives_events() {
        // Codex P2-2: subscribe BEFORE push, otherwise broadcast misses
        // (broadcast is not historical replay).
        let ring = Arc::new(EventRing::new(16));
        let sub = ring.subscribe(64);

        let id1 = ring.push(make_event(EventKind::Heartbeat as u16));
        let id2 = ring.push(make_event(EventKind::SessionEnd as u16));
        let id3 = ring.push(make_event(EventKind::Failure as u16));

        let e1 = sub.try_recv().expect("event 1");
        let e2 = sub.try_recv().expect("event 2");
        let e3 = sub.try_recv().expect("event 3");
        assert_eq!(e1.event_id, id1);
        assert_eq!(e1.kind, EventKind::Heartbeat as u16);
        assert_eq!(e2.event_id, id2);
        assert_eq!(e2.kind, EventKind::SessionEnd as u16);
        assert_eq!(e3.event_id, id3);
        assert_eq!(e3.kind, EventKind::Failure as u16);
        assert_eq!(sub.dropped_count(), 0);
    }

    #[test]
    fn multi_subscriber_each_receives_all() {
        let ring = Arc::new(EventRing::new(16));
        let sub_a = ring.subscribe(64);
        let sub_b = ring.subscribe(64);

        for _ in 0..3 {
            ring.push(make_event(EventKind::Heartbeat as u16));
        }

        for _ in 0..3 {
            assert!(sub_a.try_recv().is_ok());
            assert!(sub_b.try_recv().is_ok());
        }
        assert!(sub_a.try_recv().is_err());
        assert!(sub_b.try_recv().is_err());
    }

    #[test]
    fn subscribe_after_push_does_not_replay() {
        // Broadcast is NOT historical replay (Codex P2-2). Events
        // pushed before subscribe are invisible to the subscriber.
        let ring = Arc::new(EventRing::new(16));
        ring.push(make_event(EventKind::Heartbeat as u16));
        ring.push(make_event(EventKind::Heartbeat as u16));

        let sub = ring.subscribe(64);
        assert!(matches!(
            sub.try_recv(),
            Err(crossbeam_channel::TryRecvError::Empty)
        ));
    }

    #[test]
    fn subscriber_drop_removes_slot() {
        let ring = Arc::new(EventRing::new(16));
        {
            let _sub = ring.subscribe(8);
            assert_eq!(ring.subscriber_count(), 1);
        }
        // Subscription Drop ran → slot removed
        assert_eq!(ring.subscriber_count(), 0);
    }

    #[test]
    fn subscriber_full_drops_new_with_counter() {
        // Codex P2-1: bounded channel try_send full → the NEW snapshot
        // is dropped (not oldest). dropped_count reflects this.
        let ring = Arc::new(EventRing::new(64));
        let sub = ring.subscribe(4); // capacity 4

        for _ in 0..10 {
            ring.push(make_event(EventKind::Heartbeat as u16));
        }

        // 4 received, 6 dropped (newest)
        for _ in 0..4 {
            assert!(sub.try_recv().is_ok());
        }
        assert!(sub.try_recv().is_err());
        assert_eq!(sub.dropped_count(), 6);
    }

    #[test]
    fn existing_destructive_poll_unaffected() {
        // Subscribers and the destructive pop() path are independent.
        // Both should observe every push.
        let ring = Arc::new(EventRing::new(16));
        let sub = ring.subscribe(64);

        ring.push(make_event(EventKind::Heartbeat as u16));
        ring.push(make_event(EventKind::SessionEnd as u16));
        ring.push(make_event(EventKind::Failure as u16));

        // Broadcast side
        for _ in 0..3 {
            assert!(sub.try_recv().is_ok());
        }

        // Destructive side (l1_poll_events) — should also see all 3
        let got = ring.poll(0, 100);
        assert_eq!(got.len(), 3);
    }

    #[test]
    fn push_with_no_subscribers_avoids_snapshot() {
        // Loose timing assert — strict SLO is in benches/ — but a
        // reasonable upper bound on 1k pushes with no subscribers.
        // Snapshot construction is gated by `subscribers.is_empty()`.
        let ring = EventRing::new(2048);
        let start = std::time::Instant::now();
        for _ in 0..1_000 {
            ring.push(make_event_with_payload(
                EventKind::Heartbeat as u16,
                vec![0u8; 64],
            ));
        }
        let elapsed = start.elapsed();
        // 1000 pushes in well under 100ms on any reasonable machine
        // (the original SLO is push p99 < 1ms; this is a 100x margin).
        assert!(
            elapsed < Duration::from_millis(100),
            "1000 pushes (no subscribers) took {:?}",
            elapsed
        );
    }

    #[test]
    fn subscription_event_carries_payload_via_arc() {
        let ring = Arc::new(EventRing::new(16));
        let sub = ring.subscribe(8);
        let payload = vec![1u8, 2, 3, 4, 5];
        ring.push(make_event_with_payload(
            EventKind::UiaFocusChanged as u16,
            payload.clone(),
        ));

        let env = sub.try_recv().expect("snapshot");
        assert_eq!(env.kind, EventKind::UiaFocusChanged as u16);
        assert_eq!(&env.payload[..], &payload[..]);
        // Arc<[u8]> — subsequent clones are cheap (refcount only)
        let _clone = env.payload.clone();
    }
}
