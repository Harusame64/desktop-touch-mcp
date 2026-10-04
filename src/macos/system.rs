//! Windows, frontmost app, keystrokes and permissions for the Mac port (M1).

use objc2_application_services::{AXIsProcessTrusted, AXUIElement};
use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_graphics::{
    kCGWindowAlpha, kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowLayer, kCGWindowName,
    kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID, CGEvent, CGEventFlags,
    CGPreflightScreenCaptureAccess, CGWindowListCopyWindowInfo, CGWindowListOption,
};

use super::ax::{self, MacRect};

// ─── Permissions ────────────────────────────────────────────────────────────

#[napi_derive::napi(object)]
#[derive(Clone, Debug)]
pub struct MacPermissions {
    /// Accessibility, granted to the host process (Terminal, the Claude app).
    pub accessibility: bool,
    /// Screen Recording, needed for window titles from CGWindowList and for capture.
    pub screen_capture: bool,
}

/// Read-only: never shows the system prompt.
pub(crate) fn permissions() -> MacPermissions {
    MacPermissions {
        accessibility: unsafe { AXIsProcessTrusted() },
        screen_capture: CGPreflightScreenCaptureAccess(),
    }
}

// ─── Windows ────────────────────────────────────────────────────────────────

#[napi_derive::napi(object)]
#[derive(Clone, Debug)]
pub struct MacWindow {
    pub window_id: u32,
    pub pid: i32,
    pub owner_name: Option<String>,
    /// Empty without Screen Recording permission.
    pub title: Option<String>,
    pub bounds: Option<MacRect>,
    pub layer: i32,
    pub on_screen: bool,
    pub alpha: Option<f64>,
}

fn dict_get(d: &CFDictionary<CFString, CFType>, key: &CFString) -> Option<CFRetained<CFType>> {
    d.get(key)
}

fn dict_f64(d: &CFDictionary<CFString, CFType>, key: &'static str) -> Option<f64> {
    dict_get(d, &CFString::from_static_str(key))?
        .downcast_ref::<CFNumber>()?
        .as_f64()
}

/// Every window CGWindowList knows, front to back when `on_screen_only`.
/// Windows on other Spaces and minimised windows appear only without
/// `on_screen_only` (with `on_screen: false`).
pub(crate) fn list_windows(on_screen_only: bool) -> Vec<MacWindow> {
    let option = if on_screen_only {
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements
    } else {
        CGWindowListOption::OptionAll
    };
    let Some(arr) = CGWindowListCopyWindowInfo(option, 0) else { return Vec::new() };
    let arr: CFRetained<CFArray<CFDictionary<CFString, CFType>>> = unsafe { CFRetained::cast_unchecked(arr) };
    let mut out = Vec::new();
    for d in arr.iter() {
        let num = |k: &CFString| dict_get(&d, k).and_then(|v| v.downcast_ref::<CFNumber>().and_then(|n| n.as_i64()));
        let text = |k: &CFString| dict_get(&d, k).and_then(|v| v.downcast_ref::<CFString>().map(|s| s.to_string()));
        let (Some(window_id), Some(pid)) = (num(unsafe { kCGWindowNumber }), num(unsafe { kCGWindowOwnerPID })) else {
            continue;
        };
        let bounds = dict_get(&d, unsafe { kCGWindowBounds })
            .and_then(|v| v.downcast::<CFDictionary>().ok())
            .map(|b| {
                let b: CFRetained<CFDictionary<CFString, CFType>> = unsafe { CFRetained::cast_unchecked(b) };
                MacRect {
                    x: dict_f64(&b, "X").unwrap_or(0.0),
                    y: dict_f64(&b, "Y").unwrap_or(0.0),
                    width: dict_f64(&b, "Width").unwrap_or(0.0),
                    height: dict_f64(&b, "Height").unwrap_or(0.0),
                }
            });
        out.push(MacWindow {
            window_id: window_id as u32,
            pid: pid as i32,
            owner_name: text(unsafe { kCGWindowOwnerName }),
            title: text(unsafe { kCGWindowName }),
            bounds,
            layer: num(unsafe { kCGWindowLayer }).unwrap_or(0) as i32,
            on_screen: dict_get(&d, unsafe { kCGWindowIsOnscreen })
                .and_then(|v| v.downcast_ref::<CFBoolean>().map(|b| b.as_bool()))
                .unwrap_or(false),
            alpha: dict_get(&d, unsafe { kCGWindowAlpha })
                .and_then(|v| v.downcast_ref::<CFNumber>().and_then(|n| n.as_f64())),
        });
    }
    out
}

// ─── Frontmost / focus ──────────────────────────────────────────────────────

#[napi_derive::napi(object)]
#[derive(Clone, Debug, Default)]
pub struct MacFocus {
    /// The frontmost application.
    pub pid: Option<i32>,
    pub app_title: Option<String>,
    pub focused_role: Option<String>,
    pub focused_title: Option<String>,
    pub focused_window_title: Option<String>,
    /// `system_wide` (the system-wide AX element answered) or `app_scan`
    /// (it did not, and each app with a window was asked `AXFrontmost`).
    pub source: Option<String>,
    /// Why the system-wide element did not answer, when `source` is `app_scan`;
    /// or why nothing answered, when `pid` is absent.
    pub error: Option<String>,
}

fn app_pid(a: &AXUIElement) -> Option<i32> {
    let mut pid: i32 = 0;
    let err = unsafe { a.pid(std::ptr::NonNull::from(&mut pid)) };
    (err == objc2_application_services::AXError::Success).then_some(pid)
}

/// The system-wide element answers `cannot_complete` when the frontmost
/// app has no focused window on this Space (measured 2026-10-04: Terminal
/// frontmost with its window on another Space). Each app still answers
/// `AXFrontmost`, so scan the apps that own windows.
fn frontmost_by_scan() -> Option<CFRetained<AXUIElement>> {
    let mut pids: Vec<i32> = list_windows(false).into_iter().filter(|w| w.layer == 0).map(|w| w.pid).collect();
    pids.sort_unstable();
    pids.dedup();
    pids.into_iter().find_map(|pid| {
        let app = ax::app_element(pid, 1.0);
        let front = ax::attr(&app, "AXFrontmost").ok()?.downcast_ref::<CFBoolean>()?.as_bool();
        front.then_some(app)
    })
}

pub(crate) fn focus() -> MacFocus {
    // No timeout is set here: on the system-wide element it would change
    // the default for the whole process. This query, and the reads on the
    // app element it returns, use that default (6 s unless changed).
    let sys = unsafe { AXUIElement::new_system_wide() };
    let (app, source, error) = match ax::attr(&sys, "AXFocusedApplication") {
        Ok(v) => (v.downcast::<AXUIElement>().ok(), "system_wide", None),
        Err(e) => (frontmost_by_scan(), "app_scan", Some(ax::ax_error_name(e))),
    };
    let Some(app) = app else {
        return MacFocus { error: error.or(Some("no_frontmost_app".into())), ..Default::default() };
    };
    let focused = ax::attr_element(&app, "AXFocusedUIElement", ax::DEFAULT_TIMEOUT_SECS);
    let window = ax::attr_element(&app, "AXFocusedWindow", ax::DEFAULT_TIMEOUT_SECS);
    MacFocus {
        pid: app_pid(&app),
        app_title: ax::attr_string(&app, "AXTitle"),
        focused_role: focused.as_ref().and_then(|f| ax::attr_string(f, "AXRole")),
        focused_title: focused.as_ref().and_then(|f| ax::attr_string(f, "AXTitle")),
        focused_window_title: window.as_ref().and_then(|w| ax::attr_string(w, "AXTitle")),
        source: Some(source.into()),
        error,
    }
}

// ─── Keystrokes ─────────────────────────────────────────────────────────────

/// Post text to one process as keyboard events carrying Unicode strings
/// (one event pair per character), without taking the foreground. CGEvent
/// posting returns nothing: delivery is not confirmed here, so callers read
/// the target back.
pub(crate) fn post_text(pid: i32, text: &str) -> bool {
    for ch in text.chars() {
        let mut buf = [0u16; 2];
        let units = ch.encode_utf16(&mut buf);
        for down in [true, false] {
            let Some(ev) = CGEvent::new_keyboard_event(None, 0, down) else { return false };
            // No modifiers: keycode 0 is the "a" key, and a held modifier
            // picked up from the event source would turn it into a shortcut.
            CGEvent::set_flags(Some(&ev), CGEventFlags(0));
            unsafe { CGEvent::keyboard_set_unicode_string(Some(&ev), units.len() as _, units.as_ptr()) };
            CGEvent::post_to_pid(pid, Some(&ev));
        }
    }
    true
}

/// Post one virtual key (e.g. 36 = Return, 48 = Tab, 53 = Escape) with
/// modifier flags to one process.
pub(crate) fn post_key(pid: i32, key_code: u16, flags: u64) -> bool {
    for down in [true, false] {
        let Some(ev) = CGEvent::new_keyboard_event(None, key_code, down) else { return false };
        CGEvent::set_flags(Some(&ev), CGEventFlags(flags));
        CGEvent::post_to_pid(pid, Some(&ev));
    }
    true
}
