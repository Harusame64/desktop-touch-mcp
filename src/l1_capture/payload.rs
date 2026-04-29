use serde::{Deserialize, Serialize};

// ─── Observation event payloads (ADR-007 P5c-0b) ─────────────────────────────
//
// These structs are emitted by the P5c-1..P5c-4 hooks and decoded by the
// `src/l3_bridge/` adapter (see `docs/adr-007-p5c-plan.md` §6 / §12 and the
// reconciled D1 plan §5). They sit alongside the existing side-effect /
// system / replay payloads.
//
// `#[allow(dead_code)]` is applied per-struct because the first construct
// site lands in P5c-1 (focus) / P5c-2 (dirty rect) / P5c-3 (window) / P5c-4
// (scroll). Sealing the warning here keeps the dead_code lint useful for
// real misses elsewhere and avoids review noise on this PR.

/// Reference to a single UI element captured by an observation event.
///
/// Shape was left undefined in ADR-007 §4.2 and is fixed here:
///   - `hwnd: 0` is a *valid* unresolved case (focused element has no
///     native window). Bridge / view code must cope, not panic
///     (Codex review v3 P2 + v4 P2-2 on PR #83).
///   - `control_type` is the raw `UIA_CONTROLTYPE_ID` so bincode encodes
///     compactly; the string mapping happens at the L4 envelope layer
///     (views-catalog §3.1, run via `crate::uia::control_type_name`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)] // P5c-1 emit + l3_bridge decode
pub struct UiElementRef {
    pub hwnd: u64,
    pub name: String,
    pub automation_id: Option<String>,
    pub control_type: u32,
}

/// Payload for `EventKind::UiaFocusChanged` (=1).
///
/// `before` / `after` are both `Option` because UIA can emit a focus
/// transition where one end is unmapped (e.g., focus dropped, or
/// initial focus on session start). `window_title` lives at the
/// top level (ADR-007 §4.2 shape) — it's the host window of `after`
/// when present, captured via `GetWindowTextW(after.hwnd)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)] // P5c-1 emit + l3_bridge decode
pub struct UiaFocusChangedPayload {
    pub before: Option<UiElementRef>,
    pub after: Option<UiElementRef>,
    pub window_title: String,
}

/// Payload for `EventKind::DirtyRect` (=0). Emitted by P5c-2.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)] // P5c-2 emit
pub struct DirtyRectPayload {
    /// `[x, y, w, h]`, virtual-screen pixels.
    pub rect: [i32; 4],
    pub monitor_index: u32,
    /// DXGI frame counter.
    pub frame_index: u64,
}

/// Window-change discriminator used by `WindowChangedPayload`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)] // P5c-3 emit
pub enum WindowChangeKind {
    Opened,
    Closed,
    Foreground,
}

/// Payload for `EventKind::WindowChanged` (=5). Emitted by P5c-3.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)] // P5c-3 emit
pub struct WindowChangedPayload {
    pub kind: WindowChangeKind,
    pub hwnd: u64,
    pub title: String,
    pub process_name: String,
}

/// Payload for `EventKind::ScrollChanged` (=6). Emitted by P5c-4.
///
/// `*_percent` are the raw values returned by
/// `IUIAutomationScrollPattern::CurrentXxxScrollPercent`; `-1.0`
/// means the axis is not scrollable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)] // P5c-4 emit
pub struct ScrollChangedPayload {
    pub hwnd: u64,
    pub h_percent: f32,
    pub v_percent: f32,
}

// ─── Side-effect / system / replay payloads (existing, P5a) ──────────────────

#[derive(Serialize, Deserialize)]
pub struct ToolCallStartedPayload {
    pub tool: String,
    pub args_json: String,
}

#[derive(Serialize, Deserialize)]
pub struct ToolCallCompletedPayload {
    pub tool: String,
    pub elapsed_ms: u32,
    pub ok: bool,
    pub error_code: Option<String>,
}

/// PostMessageW 経路用。生の Win32 パラメータを記録する。
/// `l_param` は signed (bit-31 が WM_KEYUP flag を示す — PR #77 教訓)。
#[derive(Serialize, Deserialize)]
pub struct HwInputPostMessagePayload {
    pub target_hwnd: u64,
    pub msg: u32,
    pub w_param: u64,
    pub l_param: i64,
}

#[derive(Serialize, Deserialize)]
pub struct FailurePayload {
    pub layer: String,
    pub op: String,
    pub reason: String,
    pub panic_payload: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct HeartbeatPayload {
    pub uptime_ms: u64,
    pub event_count: u64,
    pub drop_count: u64,
}

#[derive(Serialize, Deserialize)]
pub struct SessionStartPayload {
    pub envelope_version: u32,
    pub addon_version: String,
}

#[derive(Serialize, Deserialize)]
pub struct SessionEndPayload {
    pub reason: String,
}

/// bincode 2.x serde 経路でエンコード。エンコード失敗時は空 Vec を返す
/// （シンプルな struct 群でエンコード失敗は実用上ありえない）。
pub fn encode_payload<T: Serialize>(val: &T) -> Vec<u8> {
    bincode::serde::encode_to_vec(val, bincode::config::standard()).unwrap_or_default()
}
