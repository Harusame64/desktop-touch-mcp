//! Hot-path window APIs (ADR-007 P1).
//!
//! Every `#[napi]` here calls `napi_safe_call` with a unique name. The
//! `EnumWindows` callback also runs `catch_unwind` internally — Rust panics
//! must never unwind across the Windows ABI callback boundary (UB).

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::Ordering;

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::WindowsAndMessaging::{
    ChildWindowFromPointEx, EnumWindows, FindWindowExW, GetAncestor, GetClassNameW,
    GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, CWP_SKIPDISABLED,
    CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT, GA_ROOT, WINDOW_LONG_PTR_INDEX,
};

use super::safety::{napi_safe_call, PANIC_COUNTER};
use super::types::{NativeThreadProcessId, NativeWin32Rect};

// ─── HWND ↔ BigInt conversion helpers ────────────────────────────────────────

/// Reinterpret the low 64 bits of a JS `bigint` as an `HWND`. The sign-bit
/// from napi's `get_u64` (returns `(sign, value, lossless)`) is intentionally
/// dropped — `value` already holds the low 64 bits we want, and `as isize`
/// preserves the bit pattern on x64 Windows. (The output side
/// `hwnd_to_bigint` always emits a positive bigint, so JS round-trips of
/// HWNDs read from this addon never go negative; we accept negative input
/// only as a defensive concession to other callers.)
fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u64();
    HWND(val as isize as *mut std::ffi::c_void)
}

/// Emit an `HWND` as a positive `BigInt` (always non-negative) by routing
/// through `usize → u64`. JS-side `bigint` is therefore always >= 0n.
fn hwnd_to_bigint(h: HWND) -> BigInt {
    BigInt::from(h.0 as usize as u64)
}

// ─── EnumWindows callback (panic-safe across Windows ABI boundary) ──────────

/// Collect HWNDs into a `Vec<isize>` whose pointer was passed via `lparam`.
/// `Vec::push` may panic on alloc failure; that panic must NOT unwind back
/// into Win32 (UB). We catch it locally and stop enumeration with `BOOL(0)`.
unsafe extern "system" fn enum_windows_collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let result = catch_unwind(AssertUnwindSafe(|| {
        // Safety: lparam is a valid `*mut Vec<isize>` for the duration of the
        // EnumWindows call (allocated by the caller below, lifetime-pinned).
        let vec = unsafe { &mut *(lparam.0 as *mut Vec<isize>) };
        vec.push(hwnd.0 as isize);
    }));
    if result.is_err() {
        PANIC_COUNTER.fetch_add(1, Ordering::Relaxed);
        BOOL(0) // FALSE = stop enumeration
    } else {
        BOOL(1) // TRUE = continue
    }
}

// ─── 10 hot-path APIs ────────────────────────────────────────────────────────

/// Enumerate all top-level windows. Returns HWND values in EnumWindows order
/// (top-down z-order). The caller (TS `enumWindowsInZOrder`) decorates each
/// HWND with title, rect, etc. via the other native APIs in this module.
#[napi]
pub fn win32_enum_top_level_windows() -> napi::Result<Vec<BigInt>> {
    napi_safe_call("win32_enum_top_level_windows", || {
        let mut hwnds: Vec<isize> = Vec::with_capacity(256);
        let lparam = LPARAM(&mut hwnds as *mut Vec<isize> as isize);
        // Safety: enum_windows_collect's lparam expectation matches the
        // pointer we just passed. `hwnds` lives until EnumWindows returns.
        unsafe {
            EnumWindows(Some(enum_windows_collect), lparam)
                .map_err(|e| napi::Error::from_reason(format!("EnumWindows failed: {e}")))?;
        }
        Ok(hwnds
            .into_iter()
            .map(|h| BigInt::from(h as usize as u64))
            .collect())
    })
}

/// Get a window's title via `GetWindowTextW`. Returns `""` on failure or
/// when the window has no title — matching the existing koffi-backed
/// `getWindowTitleW` behavior in `src/engine/win32.ts`.
#[napi]
pub fn win32_get_window_text(hwnd: BigInt) -> napi::Result<String> {
    napi_safe_call("win32_get_window_text", || {
        Ok(get_window_text(hwnd_from_bigint(hwnd)))
    })
}

/// Read a window's bounding rectangle. Returns `None` when the window no
/// longer exists or the call fails (TS wrapper converts to `{ x, y, w, h }`).
#[napi]
pub fn win32_get_window_rect(hwnd: BigInt) -> napi::Result<Option<NativeWin32Rect>> {
    napi_safe_call("win32_get_window_rect", || {
        let h = hwnd_from_bigint(hwnd);
        let mut rect = RECT::default();
        let ok = unsafe { GetWindowRect(h, &mut rect) };
        if ok.is_err() {
            return Ok(None);
        }
        Ok(Some(NativeWin32Rect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }))
    })
}

/// Return the foreground window's HWND, or `None` when there is no
/// foreground window (e.g. lock screen, system process focus).
#[napi]
pub fn win32_get_foreground_window() -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_get_foreground_window", || {
        let h = unsafe { GetForegroundWindow() };
        if h.0.is_null() {
            Ok(None)
        } else {
            Ok(Some(hwnd_to_bigint(h)))
        }
    })
}

/// `IsWindowVisible(hwnd)`. Conservatively `false` on failure.
#[napi]
pub fn win32_is_window_visible(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_is_window_visible", || {
        Ok(unsafe { IsWindowVisible(hwnd_from_bigint(hwnd)).as_bool() })
    })
}

/// `IsIconic(hwnd)` — true iff the window is minimized.
#[napi]
pub fn win32_is_iconic(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_is_iconic", || {
        Ok(unsafe { IsIconic(hwnd_from_bigint(hwnd)).as_bool() })
    })
}

/// `IsZoomed(hwnd)` — true iff the window is maximized.
#[napi]
pub fn win32_is_zoomed(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_is_zoomed", || {
        Ok(unsafe { IsZoomed(hwnd_from_bigint(hwnd)).as_bool() })
    })
}

/// Get a window's registered class name (e.g. `"#32770"` for standard
/// Win32 dialogs). Returns `""` on failure.
#[napi]
pub fn win32_get_class_name(hwnd: BigInt) -> napi::Result<String> {
    napi_safe_call("win32_get_class_name", || {
        let h = hwnd_from_bigint(hwnd);
        let mut buf = [0u16; 256]; // matches existing TS buffer size
        let len = unsafe { GetClassNameW(h, &mut buf) };
        if len <= 0 {
            return Ok(String::new());
        }
        Ok(String::from_utf16_lossy(&buf[..len as usize]))
    })
}

/// Get the (thread, process) ids that own a window. Both fields are 0 on
/// failure (matching the existing `>>> 0` coercion in TS).
#[napi]
pub fn win32_get_window_thread_process_id(
    hwnd: BigInt,
) -> napi::Result<NativeThreadProcessId> {
    napi_safe_call("win32_get_window_thread_process_id", || {
        let h = hwnd_from_bigint(hwnd);
        let mut pid: u32 = 0;
        let tid = unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        Ok(NativeThreadProcessId {
            thread_id: tid,
            process_id: pid,
        })
    })
}

/// `GetWindowLongPtrW(hwnd, nIndex)`. Returns the value as `i32` to match
/// the existing koffi `long` declaration — the TS callers (`exStyle &
/// WS_EX_TOPMOST`, `GWL_EXSTYLE` reads) only consume the low 32 bits.
/// A future BigInt-typed sibling can be added if 64-bit indices like
/// `GWLP_USERDATA` ever become needed (see Opus review §10.7).
#[napi]
pub fn win32_get_window_long_ptr_w(hwnd: BigInt, n_index: i32) -> napi::Result<i32> {
    napi_safe_call("win32_get_window_long_ptr_w", || {
        let h = hwnd_from_bigint(hwnd);
        let v = unsafe { GetWindowLongPtrW(h, WINDOW_LONG_PTR_INDEX(n_index)) };
        // LONG_PTR is isize; truncate to i32 to match the koffi `long` shape.
        Ok(v as i32)
    })
}

// ─── Internal Rust helpers (ADR-007 P5c-1) ──────────────────────────────────
//
// These avoid the napi BigInt / napi::Result round-trip when called from
// other Rust modules (UIA event handlers in particular). The `#[napi]`
// wrappers above delegate to them so the externally observable behaviour is
// unchanged.

/// Get a window's title via `GetWindowTextW`. Returns `""` on failure or
/// when the window has no title.
///
/// The buffer is sized from `GetWindowTextLengthW`, NOT a fixed 512 wchars, so a
/// long title is read in FULL. This matches the key-locker's `TitleFp`
/// (`tools/key-locker/Injection.cs`), which sizes its buffer the same way and
/// hashes the whole title: a truncated read here would hash differently and abort
/// every SendInput injection with `target_mismatch` for a long-titled console
/// (Codex #496 P2). `GetWindowTextLengthW` may over-report, so the actual count
/// returned by `GetWindowTextW` remains authoritative for the slice.
pub(crate) fn get_window_text(hwnd: HWND) -> String {
    let text_len = unsafe { GetWindowTextLengthW(hwnd) };
    if text_len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; text_len as usize + 1]; // +1 for the NUL GetWindowTextW writes
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if len <= 0 {
        String::new()
    } else {
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

/// Resolve a (possibly child) HWND to its top-level (root) window via
/// `GetAncestor(hwnd, GA_ROOT)`. Falls back to the input `hwnd` when
/// `GetAncestor` returns null (already root, invalid hwnd, or call failed).
///
/// Used by the P5c-1 UIA Focus Changed event handler:
/// `cached_element_to_focus_info` returns the focused element's own hwnd,
/// which is a child-control HWND for Edit/TextBox focus and would yield
/// empty text from `GetWindowTextW`. Normalising via GA_ROOT before
/// reading the title keeps `payload.window_title` stable across child /
/// top-level focus targets.
pub(crate) fn get_root_hwnd(hwnd: HWND) -> HWND {
    // Safety: GetAncestor accepts any HWND (including invalid) and returns
    // a null HWND on failure. No invariants we can violate from Rust.
    let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
    if root.0.is_null() {
        hwnd
    } else {
        root
    }
}

// ─── ADR-018 Phase 5+N: scroll-leaf walker for MDI apps ─────────────────────
//
// `WM_MOUSEWHEEL` propagation is **upward only** (Microsoft Learn / DefWindowProc).
// `PostMessage(top_level, WM_MOUSEWHEEL, …)` therefore never trickles down to
// the child HWND that actually owns the scrollbar. Multiple MDI / OLE apps
// (Excel, Word) host their scrollable surface as a deep child window:
//
//   Excel:  XLMAIN (top) → XLDESK → EXCEL7 (workbook leaf, owns NUIScrollbar)
//   Word:   OpusApp (top) → _WwF → _WwG (document leaf, MFC custom-paint)
//
// `win32_find_scroll_leaf_for_top_level` walks a small class-name chain table
// using `FindWindowExW`. Any segment miss returns `None`, in which case the
// caller falls back to top-level POST (current behaviour) — the helper never
// mis-routes by guessing.
//
// The class table is intentionally small (covers only confirmed-regression
// cases). Future MDI apps that exhibit the same regression are added as one
// row each — no enumeration overhead is incurred for apps not in the table.
//
// See `docs/adr-018-phase-5-followup-leaf-walker-subplan.md` for the full design
// rationale and the web research that establishes the chain shapes.

/// Class chain table: each entry is `(top-level class, descending child
/// classes from top to leaf)`. `FindWindowExW` walks the chain once per call;
/// any miss returns `None`.
///
/// Add new MDI apps by appending a row. Order does not matter.
static SCROLL_LEAF_CHAINS: &[(&str, &[&str])] = &[
    ("XLMAIN", &["XLDESK", "EXCEL7"]),
    ("OpusApp", &["_WwF", "_WwG"]),
];

/// Depth cap for the generic hit-test descent. Deep enough for the measured
/// WebView2 chain (`WRY_WEBVIEW` -> `Chrome_WidgetWin_0` -> `Chrome_WidgetWin_1`,
/// 3 levels) with headroom; bounded so a pathological / cyclic parent-child
/// arrangement cannot spin.
const WHEEL_LEAF_MAX_DEPTH: usize = 8;

/// Generic stage-2 leaf resolution: hit-test the target's OWN client centre
/// down its OWN descendant chain (ADR-018 Phase 6 §2.2).
///
/// Motivation: `SCROLL_LEAF_CHAINS` only covers class shapes we have already
/// hit. WebView-based apps (Tauri/WRY, Electron, CEF) host the wheel receiver
/// several levels down and across a process boundary, so a class table would
/// need a new row per framework and per version. The hit test finds the
/// receiver structurally instead.
///
/// **Why not `WindowFromPoint`**: it hit-tests the whole screen, so a foreign
/// always-on-top overlay (Dell DDPM `EAWorkWindow`, Logitech Options+, AHK)
/// would be returned — exactly the ADR-018 §1.2 root cause this pipeline was
/// built to eliminate. `ChildWindowFromPointEx` walks `parent`'s own children
/// only, so the result is provably inside the destination's window tree.
///
/// **Why the window centre, not the cursor**: Tier 3 is destination-explicit.
/// The cursor is not part of the destination and must not influence routing.
///
/// **Why this cannot make delivery worse**: `DefWindowProc` forwards an
/// unhandled `WM_MOUSEWHEEL` **up** the parent chain, so posting to a
/// descendant that ignores the wheel degenerates to the top-level post we
/// would have done anyway. Posting to the top level, by contrast, can never
/// reach downward.
///
/// Measured on a Tauri host 2026-08-28: descent terminates at
/// `Chrome_WidgetWin_1`, which accepts the wheel; the top-level window and the
/// intermediate `WRY_WEBVIEW` both ignore it.
fn find_wheel_leaf_by_hittest(top: HWND) -> Option<HWND> {
    let mut rect = RECT::default();
    // Safety: `GetWindowRect` writes into a caller-owned RECT and reports
    // failure through its Result; an invalid HWND returns Err rather than
    // touching the buffer.
    if unsafe { GetWindowRect(top, &mut rect) }.is_err() {
        return None;
    }
    // A minimised or zero-area window has no meaningful interior point to hit
    // test; skip the descent rather than probing an off-screen coordinate.
    if rect.right <= rect.left || rect.bottom <= rect.top {
        return None;
    }
    let centre = POINT {
        x: rect.left + (rect.right - rect.left) / 2,
        y: rect.top + (rect.bottom - rect.top) / 2,
    };

    let mut parent = top;
    for _ in 0..WHEEL_LEAF_MAX_DEPTH {
        // `ChildWindowFromPointEx` takes coordinates in `parent`'s CLIENT
        // space, so the screen point is re-converted at every level.
        let mut pt = centre;
        // Safety: `ScreenToClient` writes through a caller-owned POINT.
        if !unsafe { ScreenToClient(parent, &mut pt) }.as_bool() {
            break;
        }
        // Safety: returns a plain HWND (NULL when the point is outside
        // `parent`'s client area or every child is skipped by the flags).
        let child = unsafe {
            ChildWindowFromPointEx(
                parent,
                pt,
                CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT | CWP_SKIPDISABLED,
            )
        };
        // NULL, or the documented "point is in `parent` itself" self-return,
        // both mean the walk is finished.
        if child.0.is_null() || child == parent {
            break;
        }
        parent = child;
    }

    (parent != top).then_some(parent)
}

/// Resolve a top-level HWND to the descendant HWND that actually receives
/// `WM_MOUSEWHEEL`, for apps whose scrollable surface is a child window.
///
/// Two stages, cheapest first:
/// 1. `SCROLL_LEAF_CHAINS` class-chain walk — the confirmed MDI / OLE shapes
///    (Excel, Word). A chain whose top-level class matches but whose segments
///    fail to resolve returns `None` without trying stage 2: a half-matched
///    Office shape means the app reorganised, and guessing is worse than the
///    top-level POST.
/// 2. `find_wheel_leaf_by_hittest` — structural descent for everything else
///    (WebView hosts and any other child-hosted surface).
///
/// The caller treats `None` as "no retarget needed; use the input HWND".
#[napi]
pub fn win32_find_scroll_leaf_for_top_level(top: BigInt) -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_find_scroll_leaf_for_top_level", || {
        let top_hwnd = hwnd_from_bigint(top);
        let top_class = get_class_name(top_hwnd);
        if top_class.is_empty() {
            return Ok(None);
        }
        let chain = match SCROLL_LEAF_CHAINS
            .iter()
            .find(|(cls, _)| *cls == top_class.as_str())
        {
            Some((_, chain)) => *chain,
            // ADR-018 Phase 6 §2.2 — stage 2. The class table only knows the
            // shapes we have already hit; fall back to the structural hit-test
            // descent so WebView hosts (Tauri/WRY, Electron, CEF) resolve
            // without a per-framework row.
            None => return Ok(find_wheel_leaf_by_hittest(top_hwnd).map(hwnd_to_bigint)),
        };
        let mut parent = top_hwnd;
        for child_class in chain {
            let wide: Vec<u16> = child_class
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            // Safety: FindWindowExW accepts any HWND values (including invalid)
            // and returns Err on no-match / call failure. The PCWSTR points
            // into `wide` whose lifetime spans the call. `hwndchildafter=None`
            // requests the first matching child (per MSDN: pass NULL to start
            // the search at the first child of `hwndparent`).
            let child = unsafe {
                FindWindowExW(
                    Some(parent),
                    None,
                    PCWSTR(wide.as_ptr()),
                    PCWSTR::null(),
                )
            };
            match child {
                Ok(h) if !h.0.is_null() => parent = h,
                _ => return Ok(None),
            }
        }
        Ok(Some(hwnd_to_bigint(parent)))
    })
}

/// Read the class name of `hwnd` as a UTF-16 string. Returns an empty string
/// on failure or when the window has no registered class — matching the
/// public `win32_get_class_name` napi shape. Internal helper used by the
/// scroll-leaf walker to avoid a napi BigInt round-trip per chain lookup.
fn get_class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256]; // matches existing TS buffer size
    let len = unsafe { GetClassNameW(hwnd, &mut buf) };
    if len <= 0 {
        String::new()
    } else {
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, HMENU, WINDOW_EX_STYLE, WS_CHILD, WS_POPUP, WS_VISIBLE,
    };

    /// RAII wrapper so a failing assertion still destroys the test windows.
    struct TestWindow(HWND);
    impl Drop for TestWindow {
        fn drop(&mut self) {
            // Safety: `DestroyWindow` on an already-destroyed HWND returns Err
            // rather than faulting; the result is intentionally ignored.
            let _ = unsafe { DestroyWindow(self.0) };
        }
    }

    /// Create a window far off-screen so the test never flashes anything on the
    /// user's desktop. Off-screen placement does not affect the hit test:
    /// `ChildWindowFromPointEx` works in the parent's CLIENT coordinates, which
    /// are independent of where the window sits on the virtual screen.
    fn make_window(parent: Option<HWND>) -> Option<TestWindow> {
        let (style, x, y) = match parent {
            // Child fills the parent's client area, so the parent's centre
            // point lands inside it.
            Some(_) => (WS_CHILD | WS_VISIBLE, 0, 0),
            None => (WS_POPUP | WS_VISIBLE, -20_000, -20_000),
        };
        // Safety: "STATIC" is a predefined system class, so no RegisterClassExW
        // is needed. All pointer arguments are static wide literals or None.
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("desktop-touch wheel-leaf test"),
                style,
                x,
                y,
                400,
                300,
                parent,
                None::<HMENU>,
                None,
                None,
            )
        }
        .ok()?;
        (!hwnd.0.is_null()).then(|| TestWindow(hwnd))
    }

    #[test]
    fn hittest_descent_finds_the_child_that_covers_the_centre() {
        let Some(parent) = make_window(None) else {
            // No window station (rare CI configuration) — nothing to assert.
            return;
        };
        let Some(child) = make_window(Some(parent.0)) else {
            return;
        };

        let leaf = find_wheel_leaf_by_hittest(parent.0);
        assert_eq!(
            leaf,
            Some(child.0),
            "descent must retarget the top-level window to the child covering its centre; \
             returning None here is the pre-Phase-6 behaviour that left WebView hosts unscrollable",
        );
    }

    #[test]
    fn hittest_descent_returns_none_for_a_childless_window() {
        let Some(solo) = make_window(None) else {
            return;
        };
        assert_eq!(
            find_wheel_leaf_by_hittest(solo.0),
            None,
            "a window with no children must not be retargeted — the caller relies on None \
             meaning 'post to the input HWND', and a self-retarget would be a silent no-op",
        );
    }

    #[test]
    fn hittest_descent_returns_none_for_an_invalid_window() {
        assert_eq!(
            find_wheel_leaf_by_hittest(HWND(std::ptr::null_mut())),
            None,
            "an unresolvable HWND must degrade to None, never panic across the napi boundary",
        );
    }

    #[test]
    fn hittest_descent_stays_inside_the_target_tree() {
        // The whole point of ChildWindowFromPointEx over WindowFromPoint: a
        // window that is NOT a descendant can never be selected, no matter what
        // else is on screen at that coordinate (ADR-018 §1.2 overlay root cause).
        let Some(parent) = make_window(None) else {
            return;
        };
        let Some(child) = make_window(Some(parent.0)) else {
            return;
        };
        let Some(stranger) = make_window(None) else {
            return;
        };

        let leaf = find_wheel_leaf_by_hittest(parent.0);
        assert_ne!(
            leaf,
            Some(stranger.0),
            "descent must never return a window outside the target's own tree",
        );
        assert_eq!(leaf, Some(child.0));
    }
}
