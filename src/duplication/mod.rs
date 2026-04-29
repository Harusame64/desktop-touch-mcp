use crossbeam_channel::bounded;
use napi::{bindgen_prelude::*, Task};
use napi_derive::napi;

use crate::win32::safety::napi_safe_call;
use std::sync::{Arc, Mutex};

mod device;
mod thread;
pub mod types;

use thread::{spawn, DuplicationCmd, DuplicationHandle};
use types::{DirtyRect, DuplicationError, OutputBounds};

#[napi]
pub struct DirtyRectSubscription {
    inner: Arc<Mutex<Option<DuplicationHandle>>>,
    bounds: OutputBounds,
}

#[napi]
impl DirtyRectSubscription {
    /// Create a subscription for the specified output index (0 = primary monitor).
    #[napi(constructor)]
    pub fn new(output_index: Option<u32>) -> Result<Self> {
        let handle = spawn(output_index.unwrap_or(0))?;
        let bounds = handle.bounds.clone();
        Ok(Self {
            inner: Arc::new(Mutex::new(Some(handle))),
            bounds,
        })
    }

    /// Poll for the next batch of dirty rectangles.
    /// Resolves with [] on timeout (normal when the screen is idle).
    /// Returns an AsyncTask; NAPI makes this a Promise<DirtyRect[]> on the JS side.
    #[napi]
    pub fn next(&self, timeout_ms: u32) -> Result<AsyncTask<NextFrameTask>> {
        let tx = {
            let guard = self
                .inner
                .lock()
                .map_err(|_| DuplicationError::Other("lock poisoned".into()))?;
            let h = guard
                .as_ref()
                .ok_or(DuplicationError::Disposed)?;
            h.tx.clone()
        };
        Ok(AsyncTask::new(NextFrameTask { tx, timeout_ms }))
    }

    #[napi(getter)]
    pub fn is_disposed(&self) -> bool {
        self.inner
            .lock()
            .map(|g| g.is_none())
            .unwrap_or(true)
    }

    #[napi(getter)]
    pub fn output_bounds(&self) -> OutputBounds {
        self.bounds.clone()
    }

    /// Release resources and stop the background DXGI thread.
    #[napi]
    pub fn dispose(&self) -> Result<()> {
        napi_safe_call("DirtyRectSubscription::dispose", || {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| DuplicationError::Other("lock poisoned".into()))?;
            if let Some(h) = guard.take() {
                let _ = h.tx.send(DuplicationCmd::Stop);
            }
            Ok(())
        })
    }
}

// ─── AsyncTask implementation ─────────────────────────────────────────────────

pub struct NextFrameTask {
    tx: crossbeam_channel::Sender<DuplicationCmd>,
    timeout_ms: u32,
}

impl Task for NextFrameTask {
    type Output = Vec<DirtyRect>;
    type JsValue = Vec<DirtyRect>;

    fn compute(&mut self) -> Result<Self::Output> {
        let (reply_tx, reply_rx) = bounded(1);
        self.tx
            .send(DuplicationCmd::Next {
                timeout_ms: self.timeout_ms,
                reply: reply_tx,
            })
            .map_err(|_| DuplicationError::Disposed)?;

        // Allow extra buffer beyond the DXGI timeout so the thread can reply cleanly.
        let deadline = std::time::Duration::from_millis(self.timeout_ms as u64 + 1000);
        let res = reply_rx
            .recv_timeout(deadline)
            .map_err(|_| DuplicationError::Other("reply timeout".into()))?;
        Ok(res?)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
