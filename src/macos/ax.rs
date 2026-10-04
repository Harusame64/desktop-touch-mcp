//! Accessibility (AX) reads and acts for the Mac port (M1).
//!
//! Elements are named by a path of child indexes from a root:
//! `a.<i>.<j>...` walks `AXChildren` from the application element,
//! `f.<j>...` starts at the app's `AXFocusedWindow`, `m.<j>...` at its
//! `AXMainWindow`. The spike found that a window on another Space is not in
//! `AXChildren`/`AXWindows` but is reachable through the focused/main
//! window, so those two roots are listed only when the window is not
//! already under `a`.
//!
//! A path is not stable across UI changes: when an app's windows change
//! order, `a.1...` names the other document (measured 2026-10-04, TextEdit,
//! two documents). So every element carries its root's key (the window's
//! title and document), every act takes the key and the role the caller
//! read, and the act is refused (`element_changed`) when either differs now.
//!
//! While the display sleeps, AX answers a window with the application
//! element itself (2026-10-04, TextEdit and Calculator; Swift too), so a
//! walk would descend into the app again. The walk never enters an element
//! equal to one of its ancestors, and the tree says `selfReference` and
//! `displayAsleep` so a caller does not take such a tree as the app's UI.

use std::ptr::NonNull;

use objc2_application_services::{AXError, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFNumber, CFRange, CFRetained, CFString, CFType, CGPoint, CGSize,
};

pub(crate) const DEFAULT_TIMEOUT_SECS: f32 = 3.0;
const VALUE_CHAR_CAP: usize = 2000;

pub(crate) fn cfstr(s: &'static str) -> CFRetained<CFString> {
    CFString::from_static_str(s)
}

pub(crate) fn app_element(pid: i32, timeout_secs: f32) -> CFRetained<AXUIElement> {
    let app = unsafe { AXUIElement::new_application(pid) };
    unsafe { app.set_messaging_timeout(timeout_secs) };
    app
}

pub(crate) fn attr(e: &AXUIElement, name: &'static str) -> Result<CFRetained<CFType>, AXError> {
    let mut out: *const CFType = std::ptr::null();
    let err = unsafe { e.copy_attribute_value(&cfstr(name), NonNull::from(&mut out)) };
    if err != AXError::Success {
        return Err(err);
    }
    match NonNull::new(out as *mut CFType) {
        Some(p) => Ok(unsafe { CFRetained::from_raw(p) }),
        None => Err(AXError::NoValue),
    }
}

pub(crate) fn attr_string(e: &AXUIElement, name: &'static str) -> Option<String> {
    let v = attr(e, name).ok()?;
    v.downcast_ref::<CFString>().map(|s| s.to_string())
}

fn attr_bool(e: &AXUIElement, name: &'static str) -> Option<bool> {
    let v = attr(e, name).ok()?;
    v.downcast_ref::<CFBoolean>().map(|b| b.as_bool())
}

/// The AX messaging timeout is per element (only the system-wide element
/// sets the process default), so every element reached from another one is
/// given the caller's timeout before it is asked anything.
fn with_timeout(e: CFRetained<AXUIElement>, timeout_secs: f32) -> CFRetained<AXUIElement> {
    unsafe { e.set_messaging_timeout(timeout_secs) };
    e
}

pub(crate) fn attr_element(e: &AXUIElement, name: &'static str, timeout_secs: f32) -> Option<CFRetained<AXUIElement>> {
    let child = attr(e, name).ok()?.downcast::<AXUIElement>().ok()?;
    Some(with_timeout(child, timeout_secs))
}

pub(crate) fn children(e: &AXUIElement, timeout_secs: f32) -> Vec<CFRetained<AXUIElement>> {
    let Ok(v) = attr(e, "AXChildren") else { return Vec::new() };
    let Ok(arr) = v.downcast::<CFArray>() else { return Vec::new() };
    let arr: CFRetained<CFArray<CFType>> = unsafe { CFRetained::cast_unchecked(arr) };
    arr.iter()
        .filter_map(|c| c.downcast::<AXUIElement>().ok())
        .map(|c| with_timeout(c, timeout_secs))
        .collect()
}

/// `AXValue` rendered as text: strings as-is, numbers and booleans printed.
/// Capped so a document body does not flood the result.
pub(crate) fn value_text(e: &AXUIElement) -> Option<String> {
    let v = attr(e, "AXValue").ok()?;
    let s = if let Some(s) = v.downcast_ref::<CFString>() {
        s.to_string()
    } else if let Some(n) = v.downcast_ref::<CFNumber>() {
        match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
            Some(f) => format!("{f}"),
            None => return None,
        }
    } else {
        v.downcast_ref::<CFBoolean>()?.as_bool().to_string()
    };
    Some(cap_chars(s, VALUE_CHAR_CAP))
}

fn cap_chars(s: String, cap: usize) -> String {
    match s.char_indices().nth(cap) {
        Some((i, _)) => s[..i].to_string(),
        None => s,
    }
}

pub(crate) fn action_names(e: &AXUIElement) -> Vec<String> {
    let mut out: *const CFArray = std::ptr::null();
    let err = unsafe { e.copy_action_names(NonNull::from(&mut out)) };
    if err != AXError::Success {
        return Vec::new();
    }
    let Some(p) = NonNull::new(out as *mut CFArray<CFString>) else { return Vec::new() };
    let arr: CFRetained<CFArray<CFString>> = unsafe { CFRetained::from_raw(p) };
    arr.iter().map(|s| s.to_string()).collect()
}

pub(crate) fn is_settable(e: &AXUIElement, name: &'static str) -> bool {
    // Boolean (an unsigned char) in the C signature.
    let mut settable: u8 = 0;
    let err = unsafe { e.is_attribute_settable(&cfstr(name), NonNull::from(&mut settable)) };
    err == AXError::Success && settable != 0
}

fn ax_point(e: &AXUIElement) -> Option<CGPoint> {
    let v = attr(e, "AXPosition").ok()?.downcast::<AXValue>().ok()?;
    let mut p = CGPoint { x: 0.0, y: 0.0 };
    let ok = unsafe { v.value(AXValueType::CGPoint, NonNull::from(&mut p).cast()) };
    ok.then_some(p)
}

fn ax_size(e: &AXUIElement) -> Option<CGSize> {
    let v = attr(e, "AXSize").ok()?.downcast::<AXValue>().ok()?;
    let mut s = CGSize { width: 0.0, height: 0.0 };
    let ok = unsafe { v.value(AXValueType::CGSize, NonNull::from(&mut s).cast()) };
    ok.then_some(s)
}

/// Screen rectangle in points, top-left origin (the AX coordinate space).
#[napi_derive::napi(object)]
#[derive(Clone, Debug)]
pub struct MacRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub(crate) fn frame(e: &AXUIElement) -> Option<MacRect> {
    let p = ax_point(e)?;
    let s = ax_size(e)?;
    Some(MacRect { x: p.x, y: p.y, width: s.width, height: s.height })
}

pub(crate) fn ax_error_name(e: AXError) -> String {
    let name = match e {
        AXError::Success => "success",
        AXError::Failure => "failure",
        AXError::IllegalArgument => "illegal_argument",
        AXError::InvalidUIElement => "invalid_ui_element",
        AXError::InvalidUIElementObserver => "invalid_ui_element_observer",
        AXError::CannotComplete => "cannot_complete",
        AXError::AttributeUnsupported => "attribute_unsupported",
        AXError::ActionUnsupported => "action_unsupported",
        AXError::NotificationUnsupported => "notification_unsupported",
        AXError::NotImplemented => "not_implemented",
        AXError::NotificationAlreadyRegistered => "notification_already_registered",
        AXError::NotificationNotRegistered => "notification_not_registered",
        AXError::APIDisabled => "api_disabled",
        AXError::NoValue => "no_value",
        AXError::ParameterizedAttributeUnsupported => "parameterized_attribute_unsupported",
        AXError::NotEnoughPrecision => "not_enough_precision",
        _ => return format!("ax_error_{}", e.0),
    };
    name.to_string()
}

// ─── Roots ──────────────────────────────────────────────────────────────────

fn same(a: &AXUIElement, b: &AXUIElement) -> bool {
    let a: &CFType = a;
    let b: &CFType = b;
    a == b
}

/// What a root is called, to tell its windows apart when their order
/// changes: title, document URL and frame, joined by U+001F. The frame is
/// there for windows that share a title and have no document (two Terminal
/// windows, two Finder windows on one folder). The cost is the other way:
/// moving, resizing or retitling the window refuses the next act until the
/// caller reads again. TextEdit's AXTitle does not change on edit (measured).
/// What an element is, to tell it from a sibling that took its path when
/// the children changed (a Calculator's buttons shift as its display
/// grows): subrole, identifier, title, description and frame, joined by
/// U+001F. The value is left out, since acts change it.
pub(crate) fn element_key_of(
    subrole: Option<&str>,
    identifier: Option<&str>,
    title: Option<&str>,
    description: Option<&str>,
    frame: Option<&MacRect>,
) -> String {
    let frame = frame.map(|f| format!("{},{},{},{}", f.x, f.y, f.width, f.height)).unwrap_or_default();
    [subrole.unwrap_or(""), identifier.unwrap_or(""), title.unwrap_or(""), description.unwrap_or(""), &frame]
        .join("\u{1f}")
}

fn element_key(e: &AXUIElement) -> String {
    let nonempty = |s: Option<String>| s.filter(|s| !s.is_empty());
    element_key_of(
        attr_string(e, "AXSubrole").as_deref(),
        nonempty(attr_string(e, "AXIdentifier")).as_deref(),
        nonempty(attr_string(e, "AXTitle")).as_deref(),
        nonempty(attr_string(e, "AXDescription")).as_deref(),
        frame(e).as_ref(),
    )
}

pub(crate) fn root_key(e: &AXUIElement) -> String {
    let frame = frame(e)
        .map(|f| format!("{},{},{},{}", f.x, f.y, f.width, f.height))
        .unwrap_or_default();
    format!(
        "{}\u{1f}{}\u{1f}{}",
        attr_string(e, "AXTitle").unwrap_or_default(),
        attr_string(e, "AXDocument").unwrap_or_default(),
        frame
    )
}

/// The roots a tree read starts from, with their path prefixes, and
/// whether a child equal to the app itself was skipped. Stops early (with
/// what it has) once `late()` says the caller's budget is spent.
pub(crate) fn roots(
    app: &AXUIElement,
    include_menu_bar: bool,
    timeout_secs: f32,
    late: &dyn Fn() -> bool,
) -> (Vec<(String, CFRetained<AXUIElement>)>, bool) {
    let mut out = Vec::new();
    let mut self_reference = false;
    let kids = children(app, timeout_secs);
    for (i, k) in kids.iter().enumerate() {
        if late() {
            return (out, self_reference);
        }
        if same(k, app) {
            self_reference = true;
            continue;
        }
        if !include_menu_bar && attr_string(k, "AXRole").as_deref() == Some("AXMenuBar") {
            continue;
        }
        out.push((format!("a.{i}"), k.clone()));
    }
    for (prefix, name) in [("f", "AXFocusedWindow"), ("m", "AXMainWindow")] {
        if late() {
            break;
        }
        if let Some(w) = attr_element(app, name, timeout_secs) {
            if same(&w, app) {
                self_reference = true;
                continue;
            }
            let seen = kids.iter().any(|k| same(k, &w))
                || out.iter().any(|(_, e)| same(e, &w));
            if !seen {
                out.push((prefix.to_string(), w));
            }
        }
    }
    (out, self_reference)
}

/// Resolve a path written by [`roots`] + child indexes, returning the
/// root it starts from and the element.
pub(crate) fn resolve(
    app: &AXUIElement,
    path: &str,
    timeout_secs: f32,
) -> Option<(CFRetained<AXUIElement>, CFRetained<AXUIElement>)> {
    let mut parts = path.split('.');
    let root = match parts.next()? {
        "a" => {
            let i: usize = parts.next()?.parse().ok()?;
            children(app, timeout_secs).into_iter().nth(i)?
        }
        "f" => attr_element(app, "AXFocusedWindow", timeout_secs)?,
        "m" => attr_element(app, "AXMainWindow", timeout_secs)?,
        _ => return None,
    };
    let mut cur = root.clone();
    for p in parts {
        let i: usize = p.parse().ok()?;
        cur = children(&cur, timeout_secs).into_iter().nth(i)?;
    }
    Some((root, cur))
}

// ─── Tree read ──────────────────────────────────────────────────────────────

#[napi_derive::napi(object)]
#[derive(Clone, Debug, Default)]
pub struct MacAxTreeOptions {
    pub pid: i32,
    /// Stop after this many elements (default 3000). `truncated` says so.
    pub max_elements: Option<u32>,
    /// Do not descend below this depth (default 40).
    pub max_depth: Option<u32>,
    /// Include the app's menu bar (default false: menus are large and
    /// rarely what a caller wants first).
    pub include_menu_bar: Option<bool>,
    /// Per-message AX timeout in seconds (default 3).
    pub timeout_secs: Option<f64>,
    /// Stop the walk after this long (default 15000 ms): a hung app would
    /// otherwise cost the per-message timeout for every attribute. Checked
    /// after every read, roots included, and no message waits past it, so
    /// the overrun is one message at most.
    pub max_ms: Option<u32>,
}

#[napi_derive::napi(object)]
#[derive(Clone, Debug)]
pub struct MacAxElement {
    pub id: String,
    /// The key of the root (window) this element is under; pass it back as
    /// `expectedRootKey` to act on the element.
    pub root_key: String,
    /// What this element is; pass it back as `expectedElementKey`.
    pub element_key: String,
    pub depth: u32,
    pub role: String,
    pub subrole: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub value: Option<String>,
    pub identifier: Option<String>,
    pub frame: Option<MacRect>,
    pub enabled: Option<bool>,
    pub focused: Option<bool>,
    pub actions: Vec<String>,
    pub value_settable: bool,
    pub child_count: u32,
}

#[napi_derive::napi(object)]
#[derive(Clone, Debug)]
pub struct MacAxTree {
    pub pid: i32,
    pub app_title: Option<String>,
    pub elements: Vec<MacAxElement>,
    pub truncated: bool,
    /// Why the walk stopped early: `max_elements`, `max_depth` or `max_ms`.
    pub stopped_by: Option<String>,
    /// A child was equal to one of its ancestors and was not entered.
    pub self_reference: bool,
    /// The main display was asleep when the walk ended; AX then answers
    /// windows with the application element (see the module comment).
    pub display_asleep: bool,
    /// AX could not be read at all (e.g. `api_disabled` when Accessibility
    /// is not granted, `cannot_complete` when the app does not answer).
    pub error: Option<String>,
    pub elapsed_ms: f64,
}

fn display_asleep() -> bool {
    objc2_core_graphics::CGDisplayIsAsleep(objc2_core_graphics::CGMainDisplayID())
}

pub(crate) fn read_tree(opts: &MacAxTreeOptions) -> MacAxTree {
    let t0 = std::time::Instant::now();
    let timeout = opts.timeout_secs.map(|t| t as f32).unwrap_or(DEFAULT_TIMEOUT_SECS);
    let app = app_element(opts.pid, timeout);
    let max_elements = opts.max_elements.unwrap_or(3000) as usize;
    let max_depth = opts.max_depth.unwrap_or(40);

    let app_title = match attr(&app, "AXTitle") {
        Ok(v) => v.downcast_ref::<CFString>().map(|s| s.to_string()),
        Err(AXError::APIDisabled) | Err(AXError::CannotComplete) | Err(AXError::InvalidUIElement) => {
            let err = attr(&app, "AXRole").err().map(ax_error_name);
            if err.is_some() {
                return MacAxTree {
                    pid: opts.pid,
                    app_title: None,
                    elements: Vec::new(),
                    truncated: false,
                    stopped_by: None,
                    self_reference: false,
                    display_asleep: display_asleep(),
                    error: err,
                    elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0,
                };
            }
            None
        }
        Err(_) => None,
    };

    let deadline = std::time::Duration::from_millis(opts.max_ms.unwrap_or(15_000) as u64);
    let late = || t0.elapsed() >= deadline;
    let left = || deadline.saturating_sub(t0.elapsed()).as_secs_f32().max(0.05);
    let mut elements = Vec::new();
    let mut stopped_by: Option<&str> = None;
    // Depth-first, children in order, so ids read top to bottom. Each entry
    // carries its ancestors (app first) so a child equal to one is skipped,
    // and its root's key.
    type Entry = (String, CFRetained<AXUIElement>, Vec<CFRetained<AXUIElement>>, std::rc::Rc<String>);
    // The budget covers the roots too: no message waits past it.
    unsafe { app.set_messaging_timeout(timeout.min(left())) };
    let (root_list, mut self_reference) =
        roots(&app, opts.include_menu_bar.unwrap_or(false), timeout.min(left()), &late);
    let mut stack: Vec<Entry> = Vec::new();
    for (id, e) in root_list {
        if late() {
            break;
        }
        unsafe { e.set_messaging_timeout(timeout.min(left())) };
        let key = std::rc::Rc::new(root_key(&e));
        stack.push((id, e, vec![app.clone()], key));
    }
    if late() {
        stopped_by = Some("max_ms");
    }
    stack.reverse();
    while let Some((id, e, ancestors, key)) = stack.pop() {
        if elements.len() >= max_elements {
            stopped_by = Some("max_elements");
            break;
        }
        if t0.elapsed() >= deadline {
            stopped_by = Some("max_ms");
            break;
        }
        let depth = (ancestors.len() - 1) as u32;
        // Hold the budget inside the element too: no single message may wait
        // past it, and the reads stop as soon as it is spent (the partly read
        // element is dropped).
        unsafe { e.set_messaging_timeout(timeout.min(left())) };
        macro_rules! read {
            ($x:expr) => {{
                let v = $x;
                if late() {
                    stopped_by = Some("max_ms");
                    break;
                }
                v
            }};
        }
        let kids = read!(children(&e, timeout));
        let role = read!(attr_string(&e, "AXRole").unwrap_or_default());
        let subrole = read!(attr_string(&e, "AXSubrole"));
        let title = read!(attr_string(&e, "AXTitle").filter(|s| !s.is_empty()));
        let description = read!(attr_string(&e, "AXDescription").filter(|s| !s.is_empty()));
        let value = read!(value_text(&e));
        let identifier = read!(attr_string(&e, "AXIdentifier").filter(|s| !s.is_empty()));
        let frame = read!(frame(&e));
        let enabled = read!(attr_bool(&e, "AXEnabled"));
        let focused = read!(attr_bool(&e, "AXFocused"));
        let actions = read!(action_names(&e));
        let value_settable = read!(is_settable(&e, "AXValue"));
        elements.push(MacAxElement {
            id: id.clone(),
            root_key: (*key).clone(),
            element_key: element_key_of(
                subrole.as_deref(),
                identifier.as_deref(),
                title.as_deref(),
                description.as_deref(),
                frame.as_ref(),
            ),
            depth,
            role,
            subrole,
            title,
            description,
            value,
            identifier,
            frame,
            enabled,
            focused,
            actions,
            value_settable,
            child_count: kids.len() as u32,
        });
        if depth < max_depth {
            let mut chain = ancestors;
            chain.push(e.clone());
            for (i, k) in kids.into_iter().enumerate().rev() {
                if chain.iter().any(|a| same(a, &k)) {
                    self_reference = true;
                    continue;
                }
                stack.push((format!("{id}.{i}"), k, chain.clone(), key.clone()));
            }
        } else if !kids.is_empty() {
            stopped_by.get_or_insert("max_depth");
        }
    }

    MacAxTree {
        pid: opts.pid,
        app_title,
        elements,
        truncated: stopped_by.is_some(),
        stopped_by: stopped_by.map(str::to_string),
        self_reference,
        display_asleep: display_asleep(),
        error: None,
        elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0,
    }
}

// ─── Acts ───────────────────────────────────────────────────────────────────

#[napi_derive::napi(object)]
#[derive(Clone, Debug, Default)]
pub struct MacAxTarget {
    pub pid: i32,
    pub id: String,
    /// The role the caller read for this id.
    pub expected_role: String,
    /// The `rootKey` the caller read for this id.
    pub expected_root_key: String,
    /// The `elementKey` the caller read for this id. The act is refused
    /// (`element_changed`) when the root, the element or the role differs now.
    pub expected_element_key: String,
    pub timeout_secs: Option<f64>,
}

#[napi_derive::napi(object)]
#[derive(Clone, Debug, Default)]
pub struct MacActResult {
    pub ok: bool,
    /// Why the act was refused or failed: `element_not_found`,
    /// `element_changed`, `action_not_advertised`, `value_not_settable`,
    /// `selection_not_settable`, `length_unknown`, or the AX error name.
    pub reason: Option<String>,
    /// The element's value read back after a write (capped).
    pub value_after: Option<String>,
    pub role: Option<String>,
}

fn refused(reason: &str) -> MacActResult {
    MacActResult { ok: false, reason: Some(reason.to_string()), ..Default::default() }
}

fn locate(t: &MacAxTarget) -> Result<CFRetained<AXUIElement>, MacActResult> {
    let timeout = t.timeout_secs.map(|s| s as f32).unwrap_or(DEFAULT_TIMEOUT_SECS);
    let app = app_element(t.pid, timeout);
    let Some((root, e)) = resolve(&app, &t.id, timeout) else { return Err(refused("element_not_found")) };
    if root_key(&root) != t.expected_root_key {
        return Err(refused("element_changed"));
    }
    let role = attr_string(&e, "AXRole").unwrap_or_default();
    if role != t.expected_role {
        return Err(MacActResult { role: Some(role), ..refused("element_changed") });
    }
    if element_key(&e) != t.expected_element_key {
        return Err(MacActResult { role: Some(role), ..refused("element_changed") });
    }
    Ok(e)
}

/// Perform an AX action, but only one the element advertises: Chrome's web
/// links answer success to `AXPress` without advertising it and without
/// navigating (spike round 2).
pub(crate) fn perform(t: &MacAxTarget, action: &str) -> MacActResult {
    let e = match locate(t) {
        Ok(e) => e,
        Err(r) => return r,
    };
    if !action_names(&e).iter().any(|a| a == action) {
        return refused("action_not_advertised");
    }
    let err = unsafe { e.perform_action(&CFString::from_str(action)) };
    if err != AXError::Success {
        return refused(&ax_error_name(err));
    }
    MacActResult { ok: true, value_after: value_text(&e), ..Default::default() }
}

pub(crate) fn set_value(t: &MacAxTarget, value: &str) -> MacActResult {
    let e = match locate(t) {
        Ok(e) => e,
        Err(r) => return r,
    };
    if !is_settable(&e, "AXValue") {
        return refused("value_not_settable");
    }
    let v = CFString::from_str(value);
    let err = unsafe { e.set_attribute_value(&cfstr("AXValue"), &v) };
    if err != AXError::Success {
        return refused(&ax_error_name(err));
    }
    MacActResult { ok: true, value_after: value_text(&e), ..Default::default() }
}

/// Insert text through the selection, no keyboard: move the caret to `at`
/// (UTF-16 offset; negative = end; `None` = keep the current selection,
/// which the text then replaces), then set `AXSelectedText`.
pub(crate) fn insert_text(t: &MacAxTarget, text: &str, at: Option<i64>) -> MacActResult {
    let e = match locate(t) {
        Ok(e) => e,
        Err(r) => return r,
    };
    // Check everything before moving the caret, so a refusal leaves the
    // selection as it was.
    if !is_settable(&e, "AXSelectedText") {
        return refused("selection_not_settable");
    }
    if let Some(at) = at {
        if !is_settable(&e, "AXSelectedTextRange") {
            return refused("selection_not_settable");
        }
        let location = if at < 0 {
            let len = attr(&e, "AXNumberOfCharacters")
                .ok()
                .and_then(|v| v.downcast_ref::<CFNumber>().and_then(|n| n.as_i64()))
                .or_else(|| attr_string(&e, "AXValue").map(|s| s.encode_utf16().count() as i64));
            // Not 0: "end" must not silently become "start".
            let Some(len) = len else { return refused("length_unknown") };
            len
        } else {
            at
        };
        let mut range = CFRange { location: location as isize, length: 0 };
        let Some(rv) = (unsafe { AXValue::new(AXValueType::CFRange, NonNull::from(&mut range).cast()) }) else {
            return refused("failure");
        };
        let err = unsafe { e.set_attribute_value(&cfstr("AXSelectedTextRange"), &rv) };
        if err != AXError::Success {
            return refused(&ax_error_name(err));
        }
    }
    let err = unsafe { e.set_attribute_value(&cfstr("AXSelectedText"), &CFString::from_str(text)) };
    if err != AXError::Success {
        return refused(&ax_error_name(err));
    }
    MacActResult { ok: true, value_after: value_text(&e), ..Default::default() }
}
