use std::time::Duration;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::win32::safety::{napi_safe_call, PANIC_COUNTER};
use std::sync::atomic::Ordering;

use super::envelope::EventEnvelope;
use super::payload::{
    encode_payload, FailurePayload, HwInputPostMessagePayload, ToolCallCompletedPayload,
    ToolCallStartedPayload,
};
use super::worker::{build_event, ensure_l1, make_failure_event, shutdown_l1_for_test};
use super::EventKind;

// ─── NativeCaptureStats ───────────────────────────────────────────────────────

#[napi(object)]
pub struct NativeCaptureStats {
    pub uptime_ms: BigInt,
    pub push_count: BigInt,
    pub drop_count: BigInt,
    pub current_buffered: u32,
    pub panic_count: BigInt,
    pub event_id_high_water: BigInt,
}

// ─── Typed push helpers ───────────────────────────────────────────────────────

/// `EventKind::ToolCallStarted` を push する。L5 wrapper が tool 受信時に呼ぶ。
#[napi]
pub fn l1_push_tool_call_started(
    tool: String,
    args_json: String,
    session_id: Option<String>,
    tool_call_id: Option<String>,
) -> napi::Result<BigInt> {
    napi_safe_call("l1_push_tool_call_started", || {
        let ring_inner = ensure_l1();
        let payload = encode_payload(&ToolCallStartedPayload { tool, args_json });
        let event = build_event(
            EventKind::ToolCallStarted as u16,
            payload,
            session_id,
            tool_call_id,
        );
        let id = ring_inner.ring.push(event);
        Ok(BigInt::from(id))
    })
}

/// `EventKind::ToolCallCompleted` を push する。
#[napi]
pub fn l1_push_tool_call_completed(
    tool: String,
    elapsed_ms: u32,
    ok: bool,
    error_code: Option<String>,
    session_id: Option<String>,
    tool_call_id: Option<String>,
) -> napi::Result<BigInt> {
    napi_safe_call("l1_push_tool_call_completed", || {
        let ring_inner = ensure_l1();
        let payload = encode_payload(&ToolCallCompletedPayload {
            tool,
            elapsed_ms,
            ok,
            error_code,
        });
        let event = build_event(
            EventKind::ToolCallCompleted as u16,
            payload,
            session_id,
            tool_call_id,
        );
        let id = ring_inner.ring.push(event);
        Ok(BigInt::from(id))
    })
}

/// `EventKind::HwInputSent` を push する（PostMessageW 経路）。
/// `win32.ts::postMessageToHwnd` 内部から呼ばれ、bg-input.ts の 6 callsite を一網打尽する。
/// `l_param` は signed (bit-31 が WM_KEYUP flag — PR #77 教訓)。
#[napi]
pub fn l1_push_hw_input_post_message(
    target_hwnd: BigInt,
    msg: u32,
    w_param: BigInt,
    l_param: BigInt,
    session_id: Option<String>,
    tool_call_id: Option<String>,
) -> napi::Result<BigInt> {
    napi_safe_call("l1_push_hw_input_post_message", || {
        let ring_inner = ensure_l1();
        let (_sign, hwnd_val, _lossless) = target_hwnd.get_u64();
        // wParam: sign-preserve via get_i64 then bit-reinterpret to u64 so
        // bit-31 is never silently flipped (PR #77 / Opus review §2.3).
        let (wp_signed, _lossless2) = w_param.get_i64();
        let (lp_val, _lossless) = l_param.get_i64();
        let payload = encode_payload(&HwInputPostMessagePayload {
            target_hwnd: hwnd_val,
            msg,
            w_param: wp_signed as u64,
            l_param: lp_val,
        });
        let event = build_event(
            EventKind::HwInputSent as u16,
            payload,
            session_id,
            tool_call_id,
        );
        let id = ring_inner.ring.push(event);
        Ok(BigInt::from(id))
    })
}

/// `EventKind::Failure` を push する。`napi_safe_call` の panic catch path から
/// 呼ばれる（Rust 内部）+ TS 側からも呼べる（例: tool call top-level catch）。
#[napi]
pub fn l1_push_failure(
    layer: String,
    op: String,
    reason: String,
    panic_payload: Option<String>,
    session_id: Option<String>,
    tool_call_id: Option<String>,
) -> napi::Result<BigInt> {
    napi_safe_call("l1_push_failure", || {
        let ring_inner = ensure_l1();
        let mut event = make_failure_event(&layer, &op, &reason, panic_payload);
        event.session_id = session_id;
        event.tool_call_id = tool_call_id;
        let id = ring_inner.ring.push(event);
        Ok(BigInt::from(id))
    })
}

// ─── Poll / stats / shutdown ──────────────────────────────────────────────────

/// `since_event_id` より新しい event を最大 `max_count` 件 drain して返す。
/// drain は破壊的操作 — 同じ event が二度返ることはない。
#[napi]
pub fn l1_poll_events(
    since_event_id: BigInt,
    max_count: u32,
) -> napi::Result<Vec<EventEnvelope>> {
    napi_safe_call("l1_poll_events", || {
        let ring_inner = ensure_l1();
        let (_sign, since_val, _lossless) = since_event_id.get_u64();
        let events = ring_inner.ring.poll(since_val, max_count as usize);
        Ok(events)
    })
}

/// L1 ring buffer のヘルスチェック。bench / server_status 用。
#[napi]
pub fn l1_get_capture_stats() -> napi::Result<NativeCaptureStats> {
    napi_safe_call("l1_get_capture_stats", || {
        let ring_inner = ensure_l1();
        let stats = ring_inner.ring.stats();
        Ok(NativeCaptureStats {
            uptime_ms: BigInt::from(
                ring_inner.started_at.elapsed().as_millis() as u64,
            ),
            push_count: BigInt::from(stats.push_count),
            drop_count: BigInt::from(stats.drop_count),
            current_buffered: stats.current_buffered as u32,
            panic_count: BigInt::from(PANIC_COUNTER.load(Ordering::Relaxed)),
            event_id_high_water: BigInt::from(stats.event_id_high_water),
        })
    })
}

/// L1 worker thread を強制 shutdown する（test 用）。
/// 1s timeout で join、超過時は napi::Error。
/// 次の `l1_push_*` / `l1_poll_events` / `l1_get_capture_stats` 呼び出しで
/// worker が自動 re-init される。
#[napi]
pub fn l1_shutdown_for_test() -> napi::Result<()> {
    napi_safe_call("l1_shutdown_for_test", || {
        shutdown_l1_for_test(Duration::from_secs(1))
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    })
}

/// Force a panic inside `napi_safe_call` to verify the PANIC_COUNTER
/// increments and the panic hook pushes a Failure event to the L1 ring.
/// Only compiled in debug builds; not part of the public npm surface.
/// Always returns an Error (the panic is caught by napi_safe_call).
#[cfg(debug_assertions)]
#[napi]
pub fn l1_test_force_panic() -> napi::Result<()> {
    napi_safe_call("l1_test_force_panic", || {
        panic!("intentional test panic — napi_safe_call hook verification");
    })
}
