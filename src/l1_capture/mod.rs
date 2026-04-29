mod envelope;
pub(crate) mod napi;
mod payload;
mod ring;
mod worker;

pub use envelope::{EventEnvelope, EventKind, InternalEvent, TimestampSource};
pub(crate) use payload::encode_payload;
pub use payload::{
    DirtyRectPayload, FailurePayload, HeartbeatPayload, HwInputPostMessagePayload,
    ScrollChangedPayload, SessionEndPayload, SessionStartPayload, ToolCallCompletedPayload,
    ToolCallStartedPayload, UiElementRef, UiaFocusChangedPayload, WindowChangeKind,
    WindowChangedPayload,
};
pub use ring::{ring_capacity_from_env, CaptureStats, EventRing};
pub(crate) use worker::{build_event, ensure_l1, make_failure_event, now_ms, shutdown_l1_for_test};
