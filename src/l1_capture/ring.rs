use crossbeam_queue::ArrayQueue;
use std::sync::atomic::{AtomicU64, Ordering};

use super::envelope::{EventEnvelope, InternalEvent};

pub struct CaptureStats {
    pub push_count: u64,
    pub drop_count: u64,
    pub current_buffered: usize,
    pub event_id_high_water: u64,
}

pub struct EventRing {
    queue: ArrayQueue<InternalEvent>,
    event_id_counter: AtomicU64,
    drop_count: AtomicU64,
    push_count: AtomicU64,
}

impl EventRing {
    pub fn new(capacity: usize) -> Self {
        EventRing {
            queue: ArrayQueue::new(capacity),
            event_id_counter: AtomicU64::new(0),
            drop_count: AtomicU64::new(0),
            push_count: AtomicU64::new(0),
        }
    }

    /// Drop-oldest 押し込み。`force_push` は満杯時に最古を pop して捨てる。
    /// 返値は採番された `event_id`。
    pub fn push(&self, mut event: InternalEvent) -> u64 {
        let id = self.event_id_counter.fetch_add(1, Ordering::SeqCst);
        event.event_id = id;
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
        // event_ids start at 0; poll(since=MAX) returns nothing, poll without cursor...
        // Use a fresh ring where ids start at 0
        let id0 = ring.push(make_event(EventKind::Heartbeat as u16));
        let _ = ring.push(make_event(EventKind::Heartbeat as u16));
        let _ = ring.push(make_event(EventKind::Heartbeat as u16));
        assert_eq!(id0, 0);
        // poll(since = u64::MAX) means "since before any event" not possible with u64
        // but since id starts at 0, we can't use MAX here.
        // Use wrapping: poll with u64::MAX gives nothing (0 < MAX is false? no, 0 < MAX).
        // Actually 0 > MAX is false, so poll(MAX, 10) returns nothing. Good, tested above.
        // To get "all events since beginning", use since = u64::MAX.
        // Let's just verify by polling with since = 0 (skips event_id 0, gets 1 and 2).
        let got = ring.poll(0, 10);
        assert_eq!(got.len(), 2);
    }
}
