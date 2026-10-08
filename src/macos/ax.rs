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
    children_read(e, timeout_secs).unwrap_or_default()
}

/// `AXChildren`, or `None` when it could not be read (`attr_opt`'s errors). An element that gives
/// no children is a leaf, not a failure. A caller that must
/// know it saw everything (`relocate`, a read's uniqueness, internal #260) tells the two apart.
pub(crate) fn children_read(e: &AXUIElement, timeout_secs: f32) -> Option<Vec<CFRetained<AXUIElement>>> {
    match attr_opt(e, "AXChildren") {
        Ok(Some(v)) => Some(children_of(v, timeout_secs)),
        Ok(None) => Some(Vec::new()),
        Err(_) => None,
    }
}

fn children_of(v: CFRetained<CFType>, timeout_secs: f32) -> Vec<CFRetained<AXUIElement>> {
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
    value_text_marked(e).map(|(s, _)| s)
}

/// `AXValue` as text, capped, and whether the cap cut it. A caller must not take a cut value for
/// the whole text: writing it back with something added would delete the rest (codex, #782).
pub(crate) fn value_text_marked(e: &AXUIElement) -> Option<(String, bool)> {
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
    let cut = s.chars().nth(VALUE_CHAR_CAP).is_some();
    Some((cap_chars(s, VALUE_CHAR_CAP), cut))
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

/// `attr`, telling a read that could not be made from an attribute the element does not give
/// (no value, unsupported): any other error is `Err`, and an identity built from it is not one —
/// the next read may differ (codex on #802). One measured exception: Calculator answers `failure`
/// for `AXSubrole` on the same two buttons in every read (5 of 5, 2026-10-08), a steady answer that
/// reads as absent; counted as a failed read it marked every Calculator read incomplete.
fn attr_opt(e: &AXUIElement, name: &'static str) -> Result<Option<CFRetained<CFType>>, AXError> {
    match attr(e, name) {
        Ok(v) => Ok(Some(v)),
        Err(AXError::NoValue | AXError::AttributeUnsupported) => Ok(None),
        Err(AXError::Failure) if name == "AXSubrole" => Ok(None),
        Err(err) => Err(err),
    }
}

/// `attr_string`, failing when the read failed rather than when the attribute is absent.
fn attr_string_strict(e: &AXUIElement, name: &'static str) -> Result<Option<String>, AXError> {
    Ok(attr_opt(e, name)?.and_then(|v| v.downcast_ref::<CFString>().map(|s| s.to_string())))
}

/// `frame`, failing when a read failed rather than when position or size is absent.
fn frame_strict(e: &AXUIElement) -> Result<Option<MacRect>, AXError> {
    frame_strict_with(e, &|| {})
}

/// `frame_strict`, calling `before` ahead of each of its two messages (`relocate` sets the time
/// left there, codex on #802).
fn frame_strict_with(e: &AXUIElement, before: &dyn Fn()) -> Result<Option<MacRect>, AXError> {
    before();
    let p = attr_opt(e, "AXPosition")?.and_then(|v| v.downcast::<AXValue>().ok()).and_then(|v| {
        let mut p = CGPoint { x: 0.0, y: 0.0 };
        unsafe { v.value(AXValueType::CGPoint, NonNull::from(&mut p).cast()) }.then_some(p)
    });
    before();
    let z = attr_opt(e, "AXSize")?.and_then(|v| v.downcast::<AXValue>().ok()).and_then(|v| {
        let mut s = CGSize { width: 0.0, height: 0.0 };
        unsafe { v.value(AXValueType::CGSize, NonNull::from(&mut s).cast()) }.then_some(s)
    });
    Ok(p.zip(z).map(|(p, s)| MacRect { x: p.x, y: p.y, width: s.width, height: s.height }))
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
/// U+001F. The value is left out, since acts change it. An empty string
/// counts as absent, so the key built while reading the tree and the one
/// built again at the act agree.
pub(crate) fn element_key_of(
    subrole: Option<&str>,
    identifier: Option<&str>,
    title: Option<&str>,
    description: Option<&str>,
    frame: Option<&MacRect>,
) -> String {
    let frame = frame.map(|f| format!("{},{},{},{}", f.x, f.y, f.width, f.height)).unwrap_or_default();
    // `Option<&str>` of "" and None both become "": the two call sites
    // filter empties differently.
    [subrole.unwrap_or(""), identifier.unwrap_or(""), title.unwrap_or(""), description.unwrap_or(""), &frame]
        .join("\u{1f}")
}

/// `element_key`, each of its reads held to the time left (`relocate`); `None` once it runs out or
/// a read fails (an absent attribute is not a failure).
fn element_key_within(
    e: &AXUIElement,
    timeout: f32,
    left: &dyn Fn() -> f32,
    late: &dyn Fn() -> bool,
) -> Option<String> {
    let read = |name: &'static str| {
        unsafe { e.set_messaging_timeout(timeout.min(left())) };
        let v = attr_string_strict(e, name).ok()?.filter(|s| !s.is_empty());
        if late() { None } else { Some(v) }
    };
    let subrole = read("AXSubrole")?;
    let identifier = read("AXIdentifier")?;
    let title = read("AXTitle")?;
    let description = read("AXDescription")?;
    let f = frame_strict_with(e, &|| {
        unsafe { e.set_messaging_timeout(timeout.min(left())) };
    })
    .ok()?;
    if late() {
        return None;
    }
    Some(element_key_of(subrole.as_deref(), identifier.as_deref(), title.as_deref(), description.as_deref(), f.as_ref()))
}

fn element_key(e: &AXUIElement) -> String {
    element_key_of(
        attr_string(e, "AXSubrole").as_deref(),
        attr_string(e, "AXIdentifier").as_deref(),
        attr_string(e, "AXTitle").as_deref(),
        attr_string(e, "AXDescription").as_deref(),
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
    /// `value` was cut at the cap: it is not the whole text.
    pub value_truncated: bool,
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
    /// Some element's children, role or element-key attributes could not be
    /// read (an AX error, not an absent attribute): the tree may miss an
    /// element, or two alike may read as different, though the walk was not
    /// cut short (internal #260, codex on #802).
    pub read_incomplete: bool,
    /// The main display was asleep when the walk ended; AX then answers
    /// windows with the application element (see the module comment).
    pub display_asleep: bool,
    /// AX could not be read at all (e.g. `api_disabled` when Accessibility
    /// is not granted, `cannot_complete` when the app does not answer).
    pub error: Option<String>,
    pub elapsed_ms: f64,
}

pub(crate) fn display_asleep() -> bool {
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
                    read_incomplete: false,
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
    let mut read_incomplete = false;
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
        let kids = match read!(children_read(&e, timeout)) {
            Some(kids) => kids,
            None => {
                read_incomplete = true;
                Vec::new()
            }
        };
        // What an element is (its role and element key) is read strictly: a failed read marks the
        // tree incomplete instead of passing for an absent attribute.
        let mut strict = |r: Result<Option<String>, AXError>| r.unwrap_or_else(|_| {
            read_incomplete = true;
            None
        });
        let role = strict(read!(attr_string_strict(&e, "AXRole"))).unwrap_or_default();
        let subrole = strict(read!(attr_string_strict(&e, "AXSubrole")));
        let title = strict(read!(attr_string_strict(&e, "AXTitle"))).filter(|s| !s.is_empty());
        let description = strict(read!(attr_string_strict(&e, "AXDescription"))).filter(|s| !s.is_empty());
        let marked = read!(value_text_marked(&e));
        let value_truncated = marked.as_ref().is_some_and(|(_, cut)| *cut);
        let value = marked.map(|(s, _)| s);
        let identifier = strict(read!(attr_string_strict(&e, "AXIdentifier"))).filter(|s| !s.is_empty());
        let frame = read!(frame_strict(&e)).unwrap_or_else(|_| {
            read_incomplete = true;
            None
        });
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
            value_truncated,
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
        read_incomplete,
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
    /// The `elementKey` the caller read for this id. When the path now names
    /// something else, the element is looked for under the same root by this
    /// key and the role (`relocate`); the act is refused (`element_changed`)
    /// when the root differs, or the element is not found there.
    pub expected_element_key: String,
    /// Whether the element was the only one under its root with this role and
    /// key when read (internal #260). Only then is it looked for again when
    /// its path moved: of two alike, the one left is not the one leased.
    pub relocatable: Option<bool>,
    pub timeout_secs: Option<f64>,
}

#[napi_derive::napi(object)]
#[derive(Clone, Debug, Default)]
pub struct MacActResult {
    pub ok: bool,
    /// Why the act was refused or failed: `element_not_found`,
    /// `element_changed`, `modal_blocking`, `action_not_advertised`, `value_not_settable`,
    /// `selection_not_settable`, `length_unknown`, or the AX error name.
    pub reason: Option<String>,
    /// The element's value read back after a write (capped).
    pub value_after: Option<String>,
    pub role: Option<String>,
    /// For `modal_blocking`: `sheet:<title>` or `modal_window:<title>`.
    pub blocker: Option<String>,
}

fn refused(reason: &str) -> MacActResult {
    MacActResult { ok: false, reason: Some(reason.to_string()), ..Default::default() }
}

fn locate(t: &MacAxTarget) -> Result<CFRetained<AXUIElement>, MacActResult> {
    let timeout = t.timeout_secs.map(|s| s as f32).unwrap_or(DEFAULT_TIMEOUT_SECS);
    let app = app_element(t.pid, timeout);
    let root_id = root_id_of(&t.id);
    let (root, at_path) = match resolve(&app, &t.id, timeout) {
        Some((root, e)) => (root, Some(e)),
        // The path runs past the children there are now: the root may still hold the element.
        None => match resolve(&app, &root_id, timeout) {
            Some((root, _)) => (root, None),
            None => return Err(refused("element_not_found")),
        },
    };
    if root_key(&root) != t.expected_root_key {
        return Err(refused("element_changed"));
    }
    let is_it = |e: &AXUIElement| {
        attr_string(e, "AXRole").as_deref() == Some(t.expected_role.as_str()) && element_key(e) == t.expected_element_key
    };
    let (e, id) = match at_path {
        Some(e) if is_it(&e) => (e, t.id.clone()),
        at_path => {
            let found = if t.relocatable == Some(true) {
                relocate(&app, &root, &root_id, &t.expected_role, &t.expected_element_key, timeout)
            } else {
                Relocated::NotTried
            };
            match found {
                Relocated::One(id, e) => (e, id),
                other => {
                    let role = at_path.as_ref().and_then(|e| attr_string(e, "AXRole"));
                    // Gone: the path names nothing and nothing under the root is it. Anything else —
                    // the path names another element, two are alike now, the walk was cut short —
                    // is a changed element, not a missing one (gate 2 on #802).
                    let gone = at_path.is_none() && matches!(other, Relocated::NotFound);
                    return Err(MacActResult { role, ..refused(if gone { "element_not_found" } else { "element_changed" }) });
                }
            }
        }
    };
    let role = attr_string(&e, "AXRole").unwrap_or_default();
    if let Some(blocker) = modal_blocker(&app, &root, &id, timeout) {
        return Err(MacActResult { role: Some(role), blocker: Some(blocker), ..refused("modal_blocking") });
    }
    Ok(e)
}

/// The path of the root an element path starts from: `a.<i>`, `f` or `m`.
fn root_id_of(id: &str) -> String {
    let mut parts = id.split('.');
    match parts.next() {
        Some("a") => format!("a.{}", parts.next().unwrap_or("")),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// What `relocate` found.
enum Relocated {
    One(String, CFRetained<AXUIElement>),
    NotFound,
    /// Two or more alike, or the walk was cut short: no one element to name.
    Unclear,
    /// The element was not unique when read, so it is not looked for.
    NotTried,
}

/// internal #260 — find the element a caller read by what it is (role and element key) under the
/// root it was read in, when its path now names something else or nothing: a sibling before it
/// came or went, so the path shifted while the element did not (Calculator: All Clear removes the
/// expression line, and every button's index drops by one; their keys do not change, measured
/// 2026-10-08). Asked only for an element that was the only one of its kind under its root when
/// read (`relocatable`), and answers only when exactly one matches now. The walk holds a 3 s and
/// 3000-element budget, no message waits past it, and a walk cut short answers `Unclear` rather
/// than a guess. Like the tree read, it never enters an element equal to an ancestor, the app
/// included (a sleeping display answers a window with the app itself).
fn relocate(
    app: &CFRetained<AXUIElement>,
    root: &CFRetained<AXUIElement>,
    root_id: &str,
    role: &str,
    key: &str,
    timeout: f32,
) -> Relocated {
    const MAX_ELEMENTS: usize = 3000;
    let t0 = std::time::Instant::now();
    let budget = std::time::Duration::from_millis(3000);
    let left = || budget.saturating_sub(t0.elapsed()).as_secs_f32().max(0.05);
    let mut found: Option<(String, CFRetained<AXUIElement>)> = None;
    type Entry = (String, CFRetained<AXUIElement>, Vec<CFRetained<AXUIElement>>);
    let mut stack: Vec<Entry> = vec![(root_id.to_string(), root.clone(), vec![app.clone()])];
    let mut visited = 0usize;
    while let Some((id, e, ancestors)) = stack.pop() {
        visited += 1;
        // Every message is held to the time left, and the budget is checked after each (codex on #802).
        let late = || t0.elapsed() >= budget;
        if visited > MAX_ELEMENTS || late() {
            return Relocated::Unclear;
        }
        unsafe { e.set_messaging_timeout(timeout.min(left())) };
        // The role first: one message, and most elements stop there.
        // A read that failed may hide the element or a twin: no one element can be named (codex on #802).
        let Ok(read_role) = attr_string_strict(&e, "AXRole") else { return Relocated::Unclear };
        let is_role = read_role.as_deref() == Some(role);
        if late() {
            return Relocated::Unclear;
        }
        if is_role {
            let Some(k) = element_key_within(&e, timeout, &left, &late) else { return Relocated::Unclear };
            if k == key {
                if found.is_some() {
                    return Relocated::Unclear;
                }
                found = Some((id.clone(), e.clone()));
            }
        }
        unsafe { e.set_messaging_timeout(timeout.min(left())) };
        // A subtree that could not be read may hold another one alike (codex on #802).
        let Some(kids) = children_read(&e, timeout.min(left())) else { return Relocated::Unclear };
        if late() {
            return Relocated::Unclear;
        }
        let mut lineage = ancestors;
        lineage.push(e.clone());
        for (i, k) in kids.into_iter().enumerate().rev() {
            if lineage.iter().any(|a| same(a, &k)) {
                continue;
            }
            stack.push((format!("{id}.{i}"), k, lineage.clone()));
        }
    }
    match found {
        Some((id, e)) => Relocated::One(id, e),
        None => Relocated::NotFound,
    }
}

/// What blocks an act on the element at `id` under `root`, if anything (measured 2026-10-04:
/// with TextEdit's save sheet open, AXValue and AXPress on the window behind it both took effect).
/// - a sheet on the element's window that the element is not inside (`sheet:<title>`); a sheet
///   whose contents live in another process (the open/save panel) blocks everything here;
/// - another window of the app that says it is modal (`AXModal`), e.g. an app-modal alert
///   (`modal_window:<title>`).
fn modal_blocker(app: &AXUIElement, root: &AXUIElement, id: &str, timeout: f32) -> Option<String> {
    let root_id = root_id_of(id);
    if root_id.is_empty() {
        return None;
    }
    for (i, child) in children(root, timeout).iter().enumerate() {
        if attr_string(child, "AXRole").as_deref() != Some("AXSheet") {
            continue;
        }
        let sheet_id = format!("{root_id}.{i}");
        if id != sheet_id && !id.starts_with(&format!("{sheet_id}.")) {
            return Some(format!("sheet:{}", attr_string(child, "AXTitle").unwrap_or_default()));
        }
    }
    if let Ok(v) = attr(app, "AXWindows")
        && let Ok(arr) = v.downcast::<CFArray>()
    {
        let arr: CFRetained<CFArray<CFType>> = unsafe { CFRetained::cast_unchecked(arr) };
        for w in arr.iter().filter_map(|w| w.downcast::<AXUIElement>().ok()) {
            let w = with_timeout(w, timeout);
            // Sheets are judged above, by where the element is; one listed here as a window must not
            // also block its own controls or other documents' windows (gate 2, #782).
            if attr_string(&w, "AXRole").as_deref() == Some("AXSheet") {
                continue;
            }
            if !same(&w, root) && attr_bool(&w, "AXModal") == Some(true) {
                return Some(format!("modal_window:{}", attr_string(&w, "AXTitle").unwrap_or_default()));
            }
        }
    }
    None
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64) -> MacRect {
        MacRect { x, y: 2.0, width: 3.0, height: 4.0 }
    }

    #[test]
    fn root_id_of_names_the_root_a_path_starts_from() {
        assert_eq!(root_id_of("a.0.0.0.1.0.14"), "a.0");
        assert_eq!(root_id_of("a.3"), "a.3");
        assert_eq!(root_id_of("f.2.1"), "f");
        assert_eq!(root_id_of("m"), "m");
        assert_eq!(root_id_of(""), "");
    }

    #[test]
    fn element_key_joins_all_fields_with_unit_separator() {
        let r = MacRect { x: 1.0, y: 2.0, width: 3.0, height: 4.0 };
        assert_eq!(
            element_key_of(Some("AXStandardWindow"), Some("id1"), Some("Title"), Some("Desc"), Some(&r)),
            "AXStandardWindow\u{1f}id1\u{1f}Title\u{1f}Desc\u{1f}1,2,3,4"
        );
    }

    #[test]
    fn element_key_all_none_is_four_separators() {
        assert_eq!(element_key_of(None, None, None, None, None), "\u{1f}\u{1f}\u{1f}\u{1f}");
    }

    #[test]
    fn element_key_differs_by_frame() {
        let (a, b) = (rect(10.0), rect(11.0));
        assert_ne!(
            element_key_of(Some("s"), Some("i"), Some("t"), Some("d"), Some(&a)),
            element_key_of(Some("s"), Some("i"), Some("t"), Some("d"), Some(&b))
        );
    }

    #[test]
    fn element_key_differs_by_title() {
        let r = rect(1.0);
        assert_ne!(
            element_key_of(Some("s"), Some("i"), Some("t1"), Some("d"), Some(&r)),
            element_key_of(Some("s"), Some("i"), Some("t2"), Some("d"), Some(&r))
        );
    }

    /// The read side passes `None` for an empty title / description /
    /// identifier, the act side passes `Some("")`: the keys must agree, or
    /// every act on an unnamed element would refuse.
    #[test]
    fn element_key_empty_string_equals_absent() {
        let r = rect(1.0);
        assert_eq!(
            element_key_of(Some("s"), None, None, None, Some(&r)),
            element_key_of(Some("s"), Some(""), Some(""), Some(""), Some(&r))
        );
    }

    #[test]
    fn cap_chars_truncates_and_passes_through() {
        assert_eq!(cap_chars("abc".to_string(), 2), "ab");
        assert_eq!(cap_chars("abc".to_string(), 3), "abc");
        assert_eq!(cap_chars("abc".to_string(), 10), "abc");
    }

    #[test]
    fn cap_chars_counts_chars_not_bytes() {
        assert_eq!(cap_chars("日本語😀x".to_string(), 4), "日本語😀");
    }

    #[test]
    fn cap_chars_empty() {
        assert_eq!(cap_chars(String::new(), 5), "");
    }
}
