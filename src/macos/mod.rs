//! Mac port, M1 (internal docs/mac-port-design.md): the native layer for
//! discover / act / state on macOS. AX for reading and acting, CGWindowList
//! for windows, CGEvent for keystrokes. Everything here acts without taking
//! the foreground; the spike measured each road on this OS first.
//!
//! AX calls can block up to the messaging timeout, so reads and acts are
//! `AsyncTask`s (run on the libuv pool). The cheap sync reads go through
//! `napi_safe_call`.

pub(crate) mod ax;
pub(crate) mod capture;
pub(crate) mod system;

use napi::bindgen_prelude::*;
use napi::Task;
use napi_derive::napi;

use crate::win32::safety::napi_safe_call;
use capture::{MacCaptureOptions, MacCaptureResult};
use ax::{MacActResult, MacAxTarget, MacAxTree, MacAxTreeOptions};
use system::{MacFocus, MacPermissions, MacWindow};

#[napi]
pub fn mac_permissions() -> napi::Result<MacPermissions> {
    napi_safe_call("mac_permissions", || Ok(system::permissions()))
}

#[napi]
pub fn mac_list_windows(on_screen_only: Option<bool>) -> napi::Result<Vec<MacWindow>> {
    napi_safe_call("mac_list_windows", || Ok(system::list_windows(on_screen_only.unwrap_or(false))))
}

#[napi]
pub fn mac_post_text(pid: i32, text: String) -> napi::Result<bool> {
    napi_safe_call("mac_post_text", || Ok(system::post_text(pid, &text)))
}

#[napi]
pub fn mac_post_key(pid: i32, key_code: u32, flags: Option<i64>) -> napi::Result<bool> {
    napi_safe_call("mac_post_key", || {
        let key_code = u16::try_from(key_code).map_err(|_| napi::Error::from_reason("key_code out of range"))?;
        Ok(system::post_key(pid, key_code, flags.unwrap_or(0) as u64))
    })
}

pub struct MacFocusTask;

impl Task for MacFocusTask {
    type Output = MacFocus;
    type JsValue = MacFocus;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(system::focus())
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Frontmost app and its focused element / window, from the system-wide AX element.
#[napi]
pub fn mac_get_focus() -> AsyncTask<MacFocusTask> {
    AsyncTask::new(MacFocusTask)
}

pub struct MacAxTreeTask(MacAxTreeOptions);

impl Task for MacAxTreeTask {
    type Output = MacAxTree;
    type JsValue = MacAxTree;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(ax::read_tree(&self.0))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Read an app's AX tree as a flat, depth-first list of elements.
#[napi]
pub fn mac_ax_tree(opts: MacAxTreeOptions) -> AsyncTask<MacAxTreeTask> {
    AsyncTask::new(MacAxTreeTask(opts))
}

pub enum MacActKind {
    Perform(String),
    SetValue(String),
    Insert { text: String, at: Option<i64> },
}

pub struct MacActTask(MacAxTarget, MacActKind);

impl Task for MacActTask {
    type Output = MacActResult;
    type JsValue = MacActResult;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(match &self.1 {
            MacActKind::Perform(action) => ax::perform(&self.0, action),
            MacActKind::SetValue(v) => ax::set_value(&self.0, v),
            MacActKind::Insert { text, at } => ax::insert_text(&self.0, text, *at),
        })
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Perform an AX action the element advertises (e.g. `AXPress`).
#[napi]
pub fn mac_ax_perform(target: MacAxTarget, action: String) -> AsyncTask<MacActTask> {
    AsyncTask::new(MacActTask(target, MacActKind::Perform(action)))
}

/// Replace the element's whole value.
#[napi]
pub fn mac_ax_set_value(target: MacAxTarget, value: String) -> AsyncTask<MacActTask> {
    AsyncTask::new(MacActTask(target, MacActKind::SetValue(value)))
}

/// Insert text at a UTF-16 offset (negative = end; omitted = replace the
/// current selection) through `AXSelectedText`.
#[napi]
pub fn mac_ax_insert_text(target: MacAxTarget, text: String, at: Option<i64>) -> AsyncTask<MacActTask> {
    AsyncTask::new(MacActTask(target, MacActKind::Insert { text, at }))
}

pub struct MacCaptureTask(MacCaptureOptions);

impl Task for MacCaptureTask {
    type Output = MacCaptureResult;
    type JsValue = MacCaptureResult;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(capture::capture_window(&self.0))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Capture one window (CGWindowID) with ScreenCaptureKit, cursor off.
/// What SCK cannot capture (seen: other-Space windows) answers `not_capturable`.
#[napi]
pub fn mac_capture_window(opts: MacCaptureOptions) -> napi::Result<AsyncTask<MacCaptureTask>> {
    napi_safe_call("mac_capture_window", || {
        // On the JS (main) thread: SCK needs CoreGraphics initialised first.
        capture::ensure_app_initialised();
        Ok(AsyncTask::new(MacCaptureTask(opts)))
    })
}
