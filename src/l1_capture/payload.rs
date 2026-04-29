use serde::{Deserialize, Serialize};

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
