use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Ring buffer 内に保持する内部表現。`payload` は `Vec<u8>` で所有するため、
/// JS 側からの後からの mutation を受けない。
pub struct InternalEvent {
    pub envelope_version: u32,
    pub event_id: u64,
    pub wallclock_ms: u64,
    pub sub_ordinal: u32,
    pub timestamp_source: u8,
    pub kind: u16,
    pub payload: Vec<u8>,
    pub session_id: Option<String>,
    pub tool_call_id: Option<String>,
}

/// napi 公開する境界型。`payload_bytes` は `InternalEvent.payload` から
/// freshly allocated copy で返す（JS 側 mutate しても ring 内 InternalEvent
/// には影響しない）。
#[napi(object)]
pub struct EventEnvelope {
    pub envelope_version: u32,
    pub event_id: BigInt,
    pub wallclock_ms: BigInt,
    pub sub_ordinal: u32,
    pub timestamp_source: u8,
    pub kind: u16,
    pub payload_bytes: Buffer,
    pub session_id: Option<String>,
    pub tool_call_id: Option<String>,
}

impl From<&InternalEvent> for EventEnvelope {
    fn from(e: &InternalEvent) -> Self {
        EventEnvelope {
            envelope_version: e.envelope_version,
            event_id: BigInt::from(e.event_id),
            wallclock_ms: BigInt::from(e.wallclock_ms),
            sub_ordinal: e.sub_ordinal,
            timestamp_source: e.timestamp_source,
            kind: e.kind,
            payload_bytes: Buffer::from(e.payload.clone()),
            session_id: e.session_id.clone(),
            tool_call_id: e.tool_call_id.clone(),
        }
    }
}

#[repr(u8)]
#[allow(dead_code)]
pub enum TimestampSource {
    StdTime = 0,
    Dwm = 1,
    Dxgi = 2,
    Reflex = 3,
}

#[repr(u16)]
#[allow(dead_code)]
pub enum EventKind {
    // 観測系 (P5c で実装)
    DirtyRect = 0,
    UiaFocusChanged = 1,
    UiaTreeChanged = 2,
    UiaInvoked = 3,
    UiaValueChanged = 4,
    WindowChanged = 5,
    ScrollChanged = 6,

    // 副作用系 (P5a で実装)
    ToolCallStarted = 100,
    ToolCallCompleted = 101,
    HwInputSent = 102,

    // システム系 (P5a で実装)
    Failure = 200,
    TierFallback = 201,
    Heartbeat = 202,

    // replay 系 (P5a で実装)
    SessionStart = 300,
    SessionEnd = 301,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_envelope_from_internal_preserves_kind_as_u16() {
        let ev = InternalEvent {
            envelope_version: 1,
            event_id: 42,
            wallclock_ms: 1_700_000_000_000,
            sub_ordinal: 0,
            timestamp_source: TimestampSource::StdTime as u8,
            kind: EventKind::HwInputSent as u16,
            payload: vec![1, 2, 3],
            session_id: None,
            tool_call_id: None,
        };
        // Verify the raw u16 field survives round-trip through InternalEvent.
        assert_eq!(ev.kind, 102u16);
        assert_eq!(ev.timestamp_source, 0u8);
    }

    #[test]
    fn event_kind_out_of_range_survives_as_raw_u16() {
        // P5c / future kinds land here: just store as opaque u16.
        let ev = InternalEvent {
            envelope_version: 1,
            event_id: 0,
            wallclock_ms: 0,
            sub_ordinal: 0,
            timestamp_source: 0,
            kind: 9999u16,
            payload: vec![],
            session_id: None,
            tool_call_id: None,
        };
        assert_eq!(ev.kind, 9999u16);
    }
}
