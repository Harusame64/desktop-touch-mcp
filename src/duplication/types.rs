use napi_derive::napi;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct DirtyRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[napi(object)]
#[derive(Clone, Debug)]
pub struct OutputBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug)]
pub enum DuplicationError {
    InitFailed(String),
    AccessLost,
    Timeout,
    Unsupported,
    Disposed,
    Other(String),
}

impl From<DuplicationError> for napi::Error {
    fn from(e: DuplicationError) -> Self {
        use DuplicationError::*;
        let msg = match e {
            InitFailed(s)  => format!("E_DUP_INIT: {s}"),
            AccessLost     => "E_DUP_ACCESS_LOST: session lost, resubscribe".into(),
            Timeout        => "E_DUP_TIMEOUT: wait timeout".into(),
            Unsupported    => "E_DUP_UNSUPPORTED: RDP or unsupported driver".into(),
            Disposed       => "E_DUP_DISPOSED: subscription disposed".into(),
            Other(s)       => format!("E_DUP_OTHER: {s}"),
        };
        napi::Error::new(napi::Status::GenericFailure, msg)
    }
}
