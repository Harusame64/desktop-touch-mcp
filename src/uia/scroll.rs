//! Scroll operations: ScrollItemPattern / ScrollPattern interaction.
//!
//! Mirrors `scrollElementIntoView`, `getScrollAncestors`, and `scrollByPercent`
//! from `uia-bridge.ts`.

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::{
    GW_CHILD, GW_HWNDNEXT, GetClassNameW, GetWindow, GetWindowRect, IsChild, IsWindowVisible,
};
use windows::core::Interface;

use super::thread::{self, UiaContext, win_err};
use super::tree::find_window;
use super::types::*;
use super::control_type_name;

const DEFAULT_TIMEOUT_MS: u32 = 8_000;
const MAX_SEARCH_DEPTH: u32 = 14;
/// Maximum UIA nodes visited during Phase B DFS to bound COM RPC cost on wide
/// trees (e.g. File Explorer list views with hundreds of item children). When
/// the budget is exhausted the DFS returns `None` and the caller falls through
/// to Tier 4 SendInput rather than blocking for the full 8 s timeout.
const MAX_SCROLL_DFS_NODES: u32 = 512;

// ─── Options from JS ─────────────────────────────────────────────────────────

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct ScrollIntoViewOptions {
    pub window_title: String,
    pub name: Option<String>,
    pub automation_id: Option<String>,
}

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct ScrollAncestorsOptions {
    pub window_title: String,
    pub element_name: String,
}

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct ScrollByPercentOptions {
    pub window_title: String,
    pub element_name: String,
    pub vertical_percent: f64,
    pub horizontal_percent: f64,
}

/// ADR-018 Phase 1b — destination-explicit Tier 1 wheel options. The HWND is
/// passed as a string (BigInt-safe across the napi boundary) and converted to
/// `i64` inside `scroll_by_wheel_at_hwnd_impl`. Wheel deltas use the Win32
/// `WHEEL_DELTA = 120` units-per-notch convention (down/right positive).
#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct ScrollByWheelAtHwndOptions {
    pub hwnd: String,
    pub wheel_delta_y: i32,
    pub wheel_delta_x: i32,
    /// internal #409 — a Chromium page's own windows (`Chrome_RenderWidgetHostHWND`, as decimal strings) and a screen
    /// point inside one of them. Given all three, only a Document drawn in one of these windows that holds the point
    /// is scrolled (`find_page_document_scroll`); otherwise the search is the one below, as before.
    pub page_windows: Option<Vec<String>>,
    pub point_x: Option<i32>,
    pub point_y: Option<i32>,
}

/// ADR-019 MVP-1 (Stage 1) — read-only sibling of `ScrollByWheelAtHwndOptions`.
/// Walks UIA ancestors then a bounded DFS subtree (mirroring the dispatch path's
/// Phase A / Phase B walk) looking for the first `IUIAutomationScrollPattern`
/// whose `CurrentVerticallyScrollable` / `CurrentHorizontallyScrollable` matches
/// the requested axis. Returns the percent value when found, `None` otherwise
/// (custom-paint receivers like Excel `NUIScrollbar` / Word `_WwG`).
///
/// Pure observation: never writes (no `SetScrollPercent` side effect). Used by
/// the `postWheelToHwnd` chain-trust branch in `src/tools/_input-pipeline.ts`
/// for pre/post percent snapshot verification (TMOL `scroll_translation`
/// primitive, fast path).
#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct ReadScrollPercentAtHwndOptions {
    pub hwnd: String,
    pub axis: String, // "vertical" | "horizontal"
}

// ─── Public API ──────────────────────────────────────────────────────────────

pub fn scroll_into_view(opts: ScrollIntoViewOptions) -> napi::Result<ScrollResult> {
    // internal #216 — it changes the window, so it runs on the act client (`thread.rs::UiaContexts`).
    thread::execute_act_with_timeout(
        move |ctx| scroll_into_view_impl(ctx, &opts),
        DEFAULT_TIMEOUT_MS,
    )
}

pub fn get_scroll_ancestors(opts: ScrollAncestorsOptions) -> napi::Result<Vec<ScrollAncestor>> {
    thread::execute_with_timeout(
        move |ctx| get_scroll_ancestors_impl(ctx, &opts),
        DEFAULT_TIMEOUT_MS,
    )
}

pub fn scroll_by_percent(opts: ScrollByPercentOptions) -> napi::Result<ScrollResult> {
    // internal #216 — it changes the window, so it runs on the act client (`thread.rs::UiaContexts`).
    thread::execute_act_with_timeout(
        move |ctx| scroll_by_percent_impl(ctx, &opts),
        DEFAULT_TIMEOUT_MS,
    )
}

/// ADR-018 Phase 1b — Tier 1 dispatch: resolve element via `ElementFromHandle`
/// and call `SetScrollPercent` on the first ScrollPattern ancestor (or the
/// element itself). Returns `ScrollResult { scrolled: false }` when no
/// ScrollPattern is reachable; the caller (TS dispatcher) interprets this as
/// "fall through to Tier 4 SendInput" until Phase 4 Tier 3 lands.
pub fn scroll_by_wheel_at_hwnd(opts: ScrollByWheelAtHwndOptions) -> napi::Result<ScrollResult> {
    // internal #216 — it changes the window, so it runs on the act client (`thread.rs::UiaContexts`).
    thread::execute_act_with_timeout(
        move |ctx| scroll_by_wheel_at_hwnd_impl(ctx, &opts),
        DEFAULT_TIMEOUT_MS,
    )
}

/// ADR-019 MVP-1 (Stage 1) — read-only `ScrollPercent` observation companion to
/// `scroll_by_wheel_at_hwnd`. Returns `Some(percent)` (0.0..=100.0) when a
/// ScrollPattern ancestor / descendant exposes the requested axis as scrollable
/// AND `CurrentVerticalScrollPercent` / `CurrentHorizontalScrollPercent` returns
/// Ok; `None` otherwise. Mirrors the Phase A ancestor walk + Phase B DFS
/// subtree search in `scroll_by_wheel_at_hwnd_impl` but never writes. The TS
/// dispatcher (`src/tools/_input-pipeline.ts::postWheelToHwnd`) calls this
/// pre/post the PostMessage chunking loop; a meaningful diff witnesses
/// `observation.source: "uia_scroll_percent"` per ADR-019 §2.1.
pub fn read_scroll_percent_at_hwnd(
    opts: ReadScrollPercentAtHwndOptions,
) -> napi::Result<Option<f64>> {
    thread::execute_with_timeout(
        move |ctx| read_scroll_percent_at_hwnd_impl(ctx, &opts),
        DEFAULT_TIMEOUT_MS,
    )
}

// ─── Implementation ──────────────────────────────────────────────────────────

fn scroll_into_view_impl(
    ctx: &UiaContext,
    opts: &ScrollIntoViewOptions,
) -> napi::Result<ScrollResult> {
    let window = match find_window(ctx, &opts.window_title) {
        Ok(w) => w,
        Err(e) => {
            return Ok(ScrollResult {
                ok: false,
                scrolled: false,
                error: Some(e.reason),
            });
        }
    };

    let elem = match super::actions::find_element_in_window(
        ctx, &window, opts.name.as_deref(), opts.automation_id.as_deref(), None,
    ) {
        Ok(e) => e,
        Err(e) => {
            return Ok(ScrollResult {
                ok: false,
                scrolled: false,
                error: Some(e.reason),
            });
        }
    };

    // Try to invoke ScrollItemPattern::ScrollIntoView.
    unsafe {
        if let Ok(pat) = elem.GetCurrentPattern(UIA_ScrollItemPatternId)
            && let Ok(sip) = pat.cast::<IUIAutomationScrollItemPattern>()
        {
            match sip.ScrollIntoView() {
                Ok(()) => {
                    return Ok(ScrollResult {
                        ok: true,
                        scrolled: true,
                        error: None,
                    });
                }
                Err(e) => {
                    return Ok(ScrollResult {
                        ok: true,
                        scrolled: false,
                        error: Some(format!("{e}")),
                    });
                }
            }
        }
        Ok(ScrollResult {
            ok: true,
            scrolled: false,
            error: Some("ScrollItemPattern not available".into()),
        })
    }
}

fn get_scroll_ancestors_impl(
    ctx: &UiaContext,
    opts: &ScrollAncestorsOptions,
) -> napi::Result<Vec<ScrollAncestor>> {
    let window = match find_window(ctx, &opts.window_title) {
        Ok(w) => w,
        Err(_) => return Ok(Vec::new()),
    };

    let elem = match super::actions::find_element_in_window(
        ctx, &window, Some(&opts.element_name), None, None,
    ) {
        Ok(e) => e,
        Err(_) => return Ok(Vec::new()),
    };

    walk_scroll_ancestors(ctx, &elem)
}

fn scroll_by_percent_impl(
    ctx: &UiaContext,
    opts: &ScrollByPercentOptions,
) -> napi::Result<ScrollResult> {
    let window = match find_window(ctx, &opts.window_title) {
        Ok(w) => w,
        Err(e) => {
            return Ok(ScrollResult {
                ok: false,
                scrolled: false,
                error: Some(e.reason),
            });
        }
    };

    let elem = match super::actions::find_element_in_window(
        ctx, &window, Some(&opts.element_name), None, None,
    ) {
        Ok(e) => e,
        Err(e) => {
            return Ok(ScrollResult {
                ok: false,
                scrolled: false,
                error: Some(e.reason),
            });
        }
    };

    // Clamp values: < 0 means "no scroll" (UIA_ScrollPatternNoScroll = -1).
    let vp = if opts.vertical_percent < 0.0 {
        -1.0
    } else {
        opts.vertical_percent.clamp(0.0, 100.0).round()
    };
    let hp = if opts.horizontal_percent < 0.0 {
        -1.0
    } else {
        opts.horizontal_percent.clamp(0.0, 100.0).round()
    };

    // Walk parents to find the nearest ScrollPattern ancestor.
    let root: IUIAutomationElement =
        unsafe { ctx.automation.GetRootElement().map_err(win_err)? };
    let mut current: Option<IUIAutomationElement> =
        unsafe { ctx.walker.GetParentElement(&elem).ok() };

    while let Some(parent) = current {
        let is_root = unsafe {
            ctx.automation
                .CompareElements(&parent, &root)
                .unwrap_or_default()
        };
        if is_root == true {
            break;
        }

        unsafe {
            if let Ok(pat) = parent.GetCurrentPattern(UIA_ScrollPatternId)
                && let Ok(scroll) = pat.cast::<IUIAutomationScrollPattern>()
            {
                // Issue #291 P2 (scroll_by_percent_impl): only accept this
                // ancestor if it is actually scrollable on the needed axes —
                // otherwise continue walking upward (same filter as
                // scroll_by_wheel_at_hwnd_impl Phase A).
                // `vp/hp >= 0.0` ↔ axis requested (clamped value); `-1.0` means
                // no scroll on that axis. When both are -1.0 (caller requests
                // no movement on either axis), need_v=false & need_h=false so
                // the filter passes unconditionally — this matches pre-fix
                // behaviour and is a caller-side concern, not a bug here.
                let need_v = vp >= 0.0;
                let need_h = hp >= 0.0;
                let v_ok = !need_v
                    || scroll.CurrentVerticallyScrollable().map(|b| b.0 != 0).unwrap_or(false);
                let h_ok = !need_h
                    || scroll.CurrentHorizontallyScrollable().map(|b| b.0 != 0).unwrap_or(false);
                if v_ok && h_ok {
                    // UIA convention: horizontal first, vertical second.
                    return match scroll.SetScrollPercent(hp, vp) {
                        Ok(()) => Ok(ScrollResult {
                            ok: true,
                            scrolled: true,
                            error: None,
                        }),
                        Err(e) => Ok(ScrollResult {
                            ok: false,
                            scrolled: false,
                            error: Some(format!("{e}")),
                        }),
                    };
                }
            }
        }

        current = unsafe { ctx.walker.GetParentElement(&parent).ok() };
    }

    Ok(ScrollResult {
        ok: false,
        scrolled: false,
        error: Some("No ScrollPattern ancestor found".into()),
    })
}

/// ADR-018 Phase 1b — convert a signed wheel delta into a UIA scroll-percent
/// step.
///
/// **Units contract**: `view_size` is the UIA `Current{Vertical,Horizontal}ViewSize`
/// value, which is ALREADY a percentage of the total content area (0..100).
/// The returned step is in the same 0..100 percent units as
/// `Current{Vertical,Horizontal}ScrollPercent`, so the caller adds it directly
/// to the current percent — **no extra `* 100` scaling** (regression guard for
/// PR #288 Round 2 P1: the old formula multiplied by an extra 100, turning a
/// one-notch scroll on a typical 20%-viewport into a 200% step that clamped
/// straight to the 0%/100% boundary).
///
/// 1 notch = `WHEEL_DELTA` (120) units. `SCROLL_STEP_MULTIPLIER` (0.1) makes
/// one notch ≈ one-tenth of the visible viewport — empirically close to
/// Windows' default 3-line wheel scroll for typical apps, without swinging
/// small viewports straight to the boundary. Tunable per-app in Phase 4
/// (sub-plan §2.1#2).
fn wheel_step_percent(wheel_delta: i32, view_size: f64) -> f64 {
    const SCROLL_STEP_MULTIPLIER: f64 = 0.1;
    (wheel_delta as f64 / 120.0) * view_size * SCROLL_STEP_MULTIPLIER
}

/// ADR-018 Phase 1b — resolve HWND → IUIAutomationElement, walk from the
/// element itself up through ancestors to find the first ScrollPattern, then
/// scroll by wheel delta. The wheel delta is converted to a UIA percent step
/// by `wheel_step_percent` (see that fn for the units contract).
fn scroll_by_wheel_at_hwnd_impl(
    ctx: &UiaContext,
    opts: &ScrollByWheelAtHwndOptions,
) -> napi::Result<ScrollResult> {
    let hwnd_i64: i64 = opts.hwnd.parse().map_err(|e| {
        napi::Error::from_reason(format!("ScrollByWheelAtHwndOptions.hwnd parse error: {e}"))
    })?;
    if hwnd_i64 == 0 {
        return Ok(ScrollResult {
            ok: false,
            scrolled: false,
            error: Some("hwnd is 0 (null)".into()),
        });
    }
    let hwnd = HWND(hwnd_i64 as *mut std::ffi::c_void);

    // Resolve element from HWND. On failure (invalid hwnd / element not in UIA
    // tree) we return ok:false so the TS dispatcher falls through to legacy.
    let elem: IUIAutomationElement = match unsafe { ctx.automation.ElementFromHandle(hwnd) } {
        Ok(e) => e,
        Err(e) => {
            return Ok(ScrollResult {
                ok: false,
                scrolled: false,
                error: Some(format!("ElementFromHandle failed: {e}")),
            });
        }
    };

    // Clone for the DFS fallback (Phase B) — the while loop consumes `elem`
    // via the Option<> wrapper. Issue #291.
    let elem_for_dfs = elem.clone();

    // Axis flags — hoisted before Phase A so both phases use the same filter
    // (P2-A: Phase A must also skip ScrollPattern elements that are not
    // scrollable on the needed axis, for symmetry with Phase B).
    let need_vertical = opts.wheel_delta_y != 0;
    let need_horizontal = opts.wheel_delta_x != 0;

    // internal #409 — the caller placed the wheel on a Chromium page: only that page's Document may move.
    if let Some(page) = page_at_point(opts) {
        let mut dfs_budget = MAX_SCROLL_DFS_NODES;
        let found = find_page_document_scroll(
            ctx, &elem, MAX_SEARCH_DEPTH, hwnd_i64 as isize, &page,
            need_vertical, need_horizontal, &mut dfs_budget,
        );
        return match found {
            Some(scroll) => apply_scroll_with_pattern(&scroll, opts),
            None => Ok(ScrollResult {
                ok: false,
                scrolled: false,
                error: Some("No Document of the page's window at the point has a ScrollPattern".into()),
            }),
        };
    }

    // Phase A: walk from the element itself up through ancestors looking for
    // the first ScrollPattern. Stop at the desktop root (CompareElements true)
    // so we don't probe the root element (which has no useful ScrollPattern).
    let root: IUIAutomationElement = unsafe { ctx.automation.GetRootElement().map_err(win_err)? };
    let mut current: Option<IUIAutomationElement> = Some(elem);

    while let Some(e) = current {
        let is_root = unsafe {
            ctx.automation
                .CompareElements(&e, &root)
                .unwrap_or_default()
        };
        if is_root == true {
            break;
        }

        unsafe {
            if let Ok(pat) = e.GetCurrentPattern(UIA_ScrollPatternId)
                && let Ok(scroll) = pat.cast::<IUIAutomationScrollPattern>()
            {
                // P2-A: only accept this ancestor if it is actually scrollable
                // on the needed axes — otherwise continue walking upward.
                let v_ok = !need_vertical
                    || scroll.CurrentVerticallyScrollable().map(|b| b.0 != 0).unwrap_or(false);
                let h_ok = !need_horizontal
                    || scroll.CurrentHorizontallyScrollable().map(|b| b.0 != 0).unwrap_or(false);
                if v_ok && h_ok {
                    return apply_scroll_with_pattern(&scroll, opts);
                }
            }
        }

        current = unsafe { ctx.walker.GetParentElement(&e).ok() };
    }

    // Phase B: upward walk found nothing — the ScrollPattern is likely on a
    // descendant (e.g. Windows 11 Notepad WinUI3, WPF, Electron apps where
    // the root HWND element does not carry ScrollPattern but a child does).
    // DFS the subtree from the original elem, constrained to target_hwnd's
    // subtree and filtered by axis scrollability (Issue #291 P2-1/P2-2).
    let mut dfs_budget = MAX_SCROLL_DFS_NODES;
    if let Some(scroll) = find_scroll_pattern_in_subtree(
        ctx, &elem_for_dfs, MAX_SEARCH_DEPTH,
        hwnd_i64 as isize, need_vertical, need_horizontal,
        &mut dfs_budget,
    ) {
        return apply_scroll_with_pattern(&scroll, opts);
    }

    Ok(ScrollResult {
        ok: false,
        scrolled: false,
        error: Some(
            "No ScrollPattern found (ancestor walk + subtree DFS both exhausted)".into(),
        ),
    })
}

/// ADR-019 MVP-1 (Stage 1) — read-only `ScrollPercent` observation. Mirrors the
/// Phase A ancestor walk + Phase B DFS subtree search in
/// `scroll_by_wheel_at_hwnd_impl`, but never writes. Returns `Some(percent)`
/// (0.0..=100.0) when a ScrollPattern element exposes the requested axis as
/// scrollable AND `Current*ScrollPercent` returns Ok; `None` for any failure
/// (invalid HWND, no pattern in tree, axis not scrollable, percent read error).
fn read_scroll_percent_at_hwnd_impl(
    ctx: &UiaContext,
    opts: &ReadScrollPercentAtHwndOptions,
) -> napi::Result<Option<f64>> {
    let want_vertical = match opts.axis.as_str() {
        "vertical" => true,
        "horizontal" => false,
        other => {
            return Err(napi::Error::from_reason(format!(
                "ReadScrollPercentAtHwndOptions.axis must be 'vertical' or 'horizontal', got: {other}"
            )));
        }
    };
    let hwnd_i64: i64 = opts.hwnd.parse().map_err(|e| {
        napi::Error::from_reason(format!(
            "ReadScrollPercentAtHwndOptions.hwnd parse error: {e}"
        ))
    })?;
    if hwnd_i64 == 0 {
        return Ok(None);
    }
    let hwnd = HWND(hwnd_i64 as *mut std::ffi::c_void);

    let elem: IUIAutomationElement = match unsafe { ctx.automation.ElementFromHandle(hwnd) } {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    let elem_for_dfs = elem.clone();

    // Axis flags match the write path's gate logic (Phase A / Phase B) so a
    // pattern is only accepted when it's scrollable on the requested axis.
    let need_vertical = want_vertical;
    let need_horizontal = !want_vertical;

    // Phase A — walk from the element itself up through ancestors.
    let root: IUIAutomationElement = unsafe { ctx.automation.GetRootElement().map_err(win_err)? };
    let mut current: Option<IUIAutomationElement> = Some(elem);
    while let Some(e) = current {
        let is_root = unsafe {
            ctx.automation
                .CompareElements(&e, &root)
                .unwrap_or_default()
        };
        if is_root == true {
            break;
        }
        unsafe {
            if let Ok(pat) = e.GetCurrentPattern(UIA_ScrollPatternId)
                && let Ok(scroll) = pat.cast::<IUIAutomationScrollPattern>()
            {
                let v_ok = !need_vertical
                    || scroll.CurrentVerticallyScrollable().map(|b| b.0 != 0).unwrap_or(false);
                let h_ok = !need_horizontal
                    || scroll.CurrentHorizontallyScrollable().map(|b| b.0 != 0).unwrap_or(false);
                if v_ok && h_ok {
                    return read_scroll_percent_from_pattern(&scroll, want_vertical);
                }
            }
        }
        current = unsafe { ctx.walker.GetParentElement(&e).ok() };
    }

    // Phase B — DFS subtree under the original element, constrained to
    // `target_hwnd`'s Win32 child window family (per `find_scroll_pattern_in_subtree`).
    let mut dfs_budget = MAX_SCROLL_DFS_NODES;
    if let Some(scroll) = find_scroll_pattern_in_subtree(
        ctx,
        &elem_for_dfs,
        MAX_SEARCH_DEPTH,
        hwnd_i64 as isize,
        need_vertical,
        need_horizontal,
        &mut dfs_budget,
    ) {
        return read_scroll_percent_from_pattern(&scroll, want_vertical);
    }

    Ok(None)
}

/// Read a single axis percent from an already-obtained `IUIAutomationScrollPattern`.
/// Returns `None` when the COM call fails (some apps expose `IsScrollable=true`
/// but reject `CurrentVerticalScrollPercent` reads when the document is in a
/// transient state — better to fall through to chain-trust than to throw).
fn read_scroll_percent_from_pattern(
    scroll: &IUIAutomationScrollPattern,
    want_vertical: bool,
) -> napi::Result<Option<f64>> {
    let result = if want_vertical {
        unsafe { scroll.CurrentVerticalScrollPercent() }
    } else {
        unsafe { scroll.CurrentHorizontalScrollPercent() }
    };
    match result {
        Ok(v) => {
            // Microsoft UIA defines `UIA_ScrollPatternNoScroll = -1.0` as the
            // sentinel returned when the axis is not scrollable / no valid
            // position is available (transient provider state). Treat it as
            // observation-unavailable so the TS layer falls back to
            // chain-trust (Codex PR #309 Round 1 P1). The sentinel is exactly
            // -1.0; allow a small numeric slack (negative below the legal
            // 0.0..=100.0 range) so providers that round are also captured.
            if !v.is_finite() || v < 0.0 || v > 100.0 {
                Ok(None)
            } else {
                Ok(Some(v))
            }
        }
        Err(_) => Ok(None),
    }
}

/// Apply one scroll step using an already-obtained `IUIAutomationScrollPattern`.
/// Captures pre-state percents, computes targets, calls `SetScrollPercent`, then
/// polls post-state to confirm movement (ADR-018 §2.6.2 emission gate).
///
/// Returns `ok:false` if any percent read or `SetScrollPercent` fails so the TS
/// dispatcher can fall through to Tier 4 SendInput.
fn apply_scroll_with_pattern(
    scroll: &IUIAutomationScrollPattern,
    opts: &ScrollByWheelAtHwndOptions,
) -> napi::Result<ScrollResult> {
    // ADR §2.6.2 — `delivered_via_uia` requires UIA pre/post percent to differ.
    // Capture pre-state, perform SetScrollPercent, re-read post-state, compare.
    //
    // Per-axis: only the axis being scrolled is read — fetching (and failing on)
    // the unused axis would make Tier 1 falsely unreachable for elements that
    // scroll one axis but don't expose the other (Codex PR #288 Round 3 P1).
    // `view_size` is already a percentage (0..100, UIA ViewSize semantics).
    unsafe {
        let cur_v: Option<f64> = if opts.wheel_delta_y == 0 {
            None
        } else {
            match scroll.CurrentVerticalScrollPercent() {
                Ok(v) => Some(v),
                Err(err) => {
                    return Ok(ScrollResult {
                        ok: false,
                        scrolled: false,
                        error: Some(format!(
                            "CurrentVerticalScrollPercent unavailable: {err}"
                        )),
                    });
                }
            }
        };
        let cur_h: Option<f64> = if opts.wheel_delta_x == 0 {
            None
        } else {
            match scroll.CurrentHorizontalScrollPercent() {
                Ok(v) => Some(v),
                Err(err) => {
                    return Ok(ScrollResult {
                        ok: false,
                        scrolled: false,
                        error: Some(format!(
                            "CurrentHorizontalScrollPercent unavailable: {err}"
                        )),
                    });
                }
            }
        };

        // UIA convention: -1.0 means "no scroll on this axis".
        let target_v = match cur_v {
            None => -1.0,
            Some(cv) => {
                let view_v = match scroll.CurrentVerticalViewSize() {
                    Ok(v) => v,
                    Err(err) => {
                        return Ok(ScrollResult {
                            ok: false,
                            scrolled: false,
                            error: Some(format!(
                                "CurrentVerticalViewSize unavailable: {err}"
                            )),
                        });
                    }
                };
                // NOT a silent unwrap_or(0.0) — a fake baseline would jump to
                // start of content (Codex PR #288 Round 6 P2).
                (cv + wheel_step_percent(opts.wheel_delta_y, view_v)).clamp(0.0, 100.0)
            }
        };
        let target_h = match cur_h {
            None => -1.0,
            Some(ch) => {
                let view_h = match scroll.CurrentHorizontalViewSize() {
                    Ok(v) => v,
                    Err(err) => {
                        return Ok(ScrollResult {
                            ok: false,
                            scrolled: false,
                            error: Some(format!(
                                "CurrentHorizontalViewSize unavailable: {err}"
                            )),
                        });
                    }
                };
                (ch + wheel_step_percent(opts.wheel_delta_x, view_h)).clamp(0.0, 100.0)
            }
        };

        // UIA convention: horizontal first, vertical second.
        if let Err(err) = scroll.SetScrollPercent(target_h, target_v) {
            return Ok(ScrollResult {
                ok: false,
                scrolled: false,
                error: Some(format!("SetScrollPercent failed: {err}")),
            });
        }

        // ADR §2.6.2 emission gate — pre/post must differ by SCROLL_PERCENT_EPSILON
        // (1e-3 in 0..100 percent units). Poll a few times because some UIA
        // providers update ScrollPercent asynchronously (Codex PR #288 Round 5 P1).
        const SCROLL_PERCENT_EPSILON: f64 = 1e-3;
        const POST_READ_RETRIES: u32 = 6;
        const POST_READ_DELAY_MS: u64 = 5;
        let mut moved = false;
        let mut attempt: u32 = 0;
        loop {
            if let Some(cv) = cur_v {
                let post_v = scroll.CurrentVerticalScrollPercent().unwrap_or(cv);
                if (post_v - cv).abs() >= SCROLL_PERCENT_EPSILON {
                    moved = true;
                }
            }
            if !moved {
                if let Some(ch) = cur_h {
                    let post_h = scroll.CurrentHorizontalScrollPercent().unwrap_or(ch);
                    if (post_h - ch).abs() >= SCROLL_PERCENT_EPSILON {
                        moved = true;
                    }
                }
            }
            attempt += 1;
            if moved || attempt >= POST_READ_RETRIES {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(POST_READ_DELAY_MS));
        }

        Ok(ScrollResult {
            ok: true,
            scrolled: moved,
            error: if moved {
                None
            } else {
                Some(
                    "SetScrollPercent returned Ok but pre/post percent unchanged".into(),
                )
            },
        })
    }
}

/// DFS over the UIA subtree rooted at `elem` to find the first element that
/// exposes `IUIAutomationScrollPattern` AND is scrollable on the requested
/// axes. Returns `None` when the subtree is exhausted, `depth` reaches 0, or
/// `node_budget` is depleted. Silently skips COM errors on individual child
/// queries so a broken child branch does not abort the whole search.
///
/// `target_hwnd`: HWND of the top-level window being scrolled (as isize).
///   Children whose `CurrentNativeWindowHandle` returns a non-zero HWND that
///   is neither `target_hwnd` nor a Win32 child of it are skipped (P2-1
///   boundary guard, Issue #291). This allows descent into embedded child
///   windows like WinUI3's `DesktopChildSiteBridge` / `DirectUIHWND` that are
///   children of the target window while still blocking descent into unrelated
///   top-level windows. Elements with HWND == 0 are pure UIA nodes and are
///   always searched.
///
/// `need_vertical` / `need_horizontal`: which axes are being scrolled. An
///   element with ScrollPattern that reports not scrollable on the needed axis
///   is skipped so the DFS continues to the next candidate (P2-2 scrollable
///   filter, Issue #291).
///
/// `node_budget`: mutable counter decremented for every UIA node visited.
///   When it reaches 0 the DFS stops immediately so a wide tree (e.g. File
///   Explorer list view with hundreds of item children) does not exhaust the
///   8 s COM timeout (P2-3, Issue #291).
///
/// Used by `scroll_by_wheel_at_hwnd_impl` Phase B (Issue #291): when the
/// upward ancestor walk finds nothing, the ScrollPattern is likely on a child
/// (e.g. the text editor inside Windows 11 Notepad's WinUI3 root HWND).
fn find_scroll_pattern_in_subtree(
    ctx: &UiaContext,
    elem: &IUIAutomationElement,
    depth: u32,
    target_hwnd: isize,
    need_vertical: bool,
    need_horizontal: bool,
    node_budget: &mut u32,
) -> Option<IUIAutomationScrollPattern> {
    // internal #407 — a docked DevTools sits in the browser frame's own tree, ahead of the page's Document, and its
    // Elements tree carries a ScrollPattern: the search scrolled it and answered scrolled while the page stayed still
    // (win2, dev/407-uia-devtools U1/U2). Its Document reads devtools:// (U4), so the first pass passes over its
    // subtree. When that pass found nothing, passed over a DevTools Document, and met no other Document, the window
    // is DevTools itself (undocked, named by the caller): the search runs again without passing over it, as before.
    let mut seen = DevToolsSeen::default();
    if let Some(found) = find_scroll_pattern_dfs(
        ctx, elem, depth, target_hwnd, need_vertical, need_horizontal, node_budget, true, &mut seen,
    ) {
        return Some(found);
    }
    // Not when the first pass ran out of budget: the page's Document may lie past where it stopped.
    if seen.devtools && !seen.other_document && *node_budget > 0 {
        let mut budget = MAX_SCROLL_DFS_NODES;
        return find_scroll_pattern_dfs(
            ctx, elem, depth, target_hwnd, need_vertical, need_horizontal, &mut budget, false, &mut seen,
        );
    }
    None
}

/// internal #409 — a Chromium page's own windows and a screen point inside one of them.
struct PageAtPoint {
    windows: Vec<isize>,
    x: i32,
    y: i32,
}

/// internal #409 — the page and point the caller gave, or `None` when any part is missing or unreadable (the search is
/// then the one it was before).
fn page_at_point(opts: &ScrollByWheelAtHwndOptions) -> Option<PageAtPoint> {
    let (Some(list), Some(x), Some(y)) = (opts.page_windows.as_ref(), opts.point_x, opts.point_y) else {
        return None;
    };
    let windows: Vec<isize> = list
        .iter()
        .map(|w| w.parse::<i64>().ok().filter(|h| *h != 0).map(|h| h as isize))
        .collect::<Option<Vec<_>>>()?;
    if windows.is_empty() {
        return None;
    }
    Some(PageAtPoint { windows, x, y })
}

/// internal #409 — the window a UIA element is drawn in: itself when it carries one, else the nearest RawView ancestor
/// that does. A web Document's is the `Chrome_RenderWidgetHostHWND` its page is drawn in: one step up for a page,
/// DevTools or a side panel, 3–13 for an out-of-process iframe or the PDF viewer's inner Documents, none in Chrome 120,
/// where the Document is that window's own element (win2, dev/409-spike rounds 2 and 4: 43 of 43 and every Chrome
/// 120 cell). `None` when the walk fails or runs past `MAX_DRAWN_IN_STEPS` steps.
fn drawn_in_window(ctx: &UiaContext, elem: &IUIAutomationElement) -> Option<isize> {
    let raw = unsafe { ctx.automation.RawViewWalker().ok()? };
    let mut current = elem.clone();
    for _ in 0..MAX_DRAWN_IN_STEPS {
        let h = unsafe { current.CurrentNativeWindowHandle().ok()? }.0 as isize;
        if h != 0 {
            return Some(h);
        }
        current = unsafe { raw.GetParentElement(&current).ok()? };
    }
    None
}

/// internal #409 — RawView steps `drawn_in_window` takes at most: the deepest seen was 13 (the PDF viewer's body), with
/// room for a PDF inside an iframe. Only a corrupt or cyclic tree reaches it.
const MAX_DRAWN_IN_STEPS: u32 = 40;

fn rect_holds(r: &RECT, x: i32, y: i32) -> bool {
    x >= r.left && x < r.right && y >= r.top && y < r.bottom
}

/// internal #409 — the frame-wide search took whatever ScrollPattern came first: a docked DevTools pane, a side panel,
/// an extension's panel, the New Tab page's customize button, the PDF viewer's thumbnails. It scrolled that and
/// answered delivered while the page stayed still (win2, dev/409-spike). With a page and point, this search keeps only
/// a Document drawn in one of the page's windows (`drawn_in_window`) that holds the point and scrolls on the needed
/// axes. The first in tree order wins, so the outermost: the page's own Document before a scrollable iframe at the
/// point, as the frame-wide search had it; on a PDF, whose outer Documents do not scroll, the viewer's body.
///
/// What it does not do:
/// - It does not go down from the page's window (`ElementFromHandle`). In Chrome's immersive reading mode the hidden
///   page is drawn in a window at the same rect, and a Document reached that way scrolled by both read-back and the
///   page's own position while nothing on screen moved (round 2). Only what the frame's own tree shows is a candidate.
/// - It does not use a descendant's ScrollPattern. An inner box of the page is moved by the posted wheel at the
///   point (Tier 3), which Chromium hit-tests, so it is left to that.
/// - A Document drawn in another window is passed over with its whole subtree: what is nested in it is drawn there
///   too. One whose RawView ancestor is not the window its RuntimeId names (once in Chrome 157's split view, round 4)
///   is passed over, and Tier 3 posts at the point instead.
#[allow(clippy::too_many_arguments)]
fn find_page_document_scroll(
    ctx: &UiaContext,
    elem: &IUIAutomationElement,
    depth: u32,
    target_hwnd: isize,
    page: &PageAtPoint,
    need_vertical: bool,
    need_horizontal: bool,
    node_budget: &mut u32,
) -> Option<IUIAutomationScrollPattern> {
    if depth == 0 || *node_budget == 0 {
        return None;
    }
    *node_budget = node_budget.saturating_sub(1);
    unsafe {
        if is_document(elem) {
            match drawn_in_window(ctx, elem) {
                Some(h) if page.windows.contains(&h) => {}
                _ => return None,
            }
            let holds = elem
                .CurrentBoundingRectangle()
                .map(|r| rect_holds(&r, page.x, page.y))
                .unwrap_or(false);
            if holds
                && let Ok(pat) = elem.GetCurrentPattern(UIA_ScrollPatternId)
                && let Ok(scroll) = pat.cast::<IUIAutomationScrollPattern>()
            {
                let v_ok = !need_vertical
                    || scroll.CurrentVerticallyScrollable().map(|b| b.0 != 0).unwrap_or(false);
                let h_ok = !need_horizontal
                    || scroll.CurrentHorizontallyScrollable().map(|b| b.0 != 0).unwrap_or(false);
                if v_ok && h_ok {
                    return Some(scroll);
                }
            }
        }
        let first = ctx.walker.GetFirstChildElement(elem).ok()?;
        let mut child: Option<IUIAutomationElement> = Some(first);
        while let Some(c) = child {
            // The same window boundary as `find_scroll_pattern_dfs` (P2-1).
            let child_hwnd = match c.CurrentNativeWindowHandle() {
                Err(_) => {
                    child = ctx.walker.GetNextSiblingElement(&c).ok();
                    continue;
                }
                Ok(h) => h.0 as isize,
            };
            if child_hwnd != 0
                && child_hwnd != target_hwnd
                && !IsChild(
                    HWND(target_hwnd as *mut std::ffi::c_void),
                    HWND(child_hwnd as *mut std::ffi::c_void),
                ).as_bool()
            {
                child = ctx.walker.GetNextSiblingElement(&c).ok();
                continue;
            }
            if let Some(found) = find_page_document_scroll(
                ctx, &c, depth - 1, target_hwnd, page, need_vertical, need_horizontal, node_budget,
            ) {
                return Some(found);
            }
            if *node_budget == 0 {
                return None;
            }
            child = ctx.walker.GetNextSiblingElement(&c).ok();
        }
    }
    None
}

/// internal #409 — the Views class of the area a Chromium browser draws its tabs' contents in. In Chrome 157 and Edge
/// 157 the page's Document and a docked DevTools' are under it, and side panels, extension panels and Edge's side pane
/// are outside it (win2, dev/409-spike rounds 3 and 4). Chrome 120 and Electron have no such element.
const CONTENTS_VIEW_CLASS: &str = "MultiContentsView";

/// internal #409 — the windows the Documents inside a Chromium frame's contents area are drawn in, or `None` when the
/// frame has no contents area in its UIA tree (an older Chromium, Electron) or it cannot be read. The page surface uses
/// it to tell the page from a side panel beside it when their windows alone cannot.
pub fn page_windows_in_contents(frame: String) -> napi::Result<Option<Vec<String>>> {
    thread::execute_with_timeout(move |ctx| page_windows_in_contents_impl(ctx, &frame), DEFAULT_TIMEOUT_MS)
}

fn page_windows_in_contents_impl(ctx: &UiaContext, frame: &str) -> napi::Result<Option<Vec<String>>> {
    let raw: i64 = frame
        .parse()
        .map_err(|e| napi::Error::from_reason(format!("uia_page_windows_in_contents: hwnd parse error: {e}")))?;
    if raw == 0 {
        return Ok(None);
    }
    let Ok(root) = (unsafe { ctx.automation.ElementFromHandle(HWND(raw as *mut std::ffi::c_void)) }) else {
        return Ok(None);
    };
    let mut budget = MAX_SCROLL_DFS_NODES;
    let page_rects = page_window_rects(HWND(raw as *mut std::ffi::c_void));
    let Some(contents) = find_contents_view(ctx, &root, MAX_SEARCH_DEPTH, &page_rects, &mut budget) else {
        return Ok(None);
    };
    let mut windows: Vec<isize> = Vec::new();
    let mut budget = MAX_SCROLL_DFS_NODES;
    collect_document_windows(ctx, &contents, MAX_SEARCH_DEPTH, &mut budget, &mut windows);
    // A crashed tab's view is a Document drawn in the frame itself: its page window is gone, and what is left in the
    // contents area (a docked DevTools) is not the page (win2, dev/409-spike rounds 2–4, Chrome 157 and Edge 157).
    // Then nothing is said, and the page stays as unplaced as before.
    if windows.contains(&(raw as isize)) {
        return Ok(None);
    }
    Ok(Some(windows.into_iter().map(|h| (h as i64).to_string()).collect()))
}

/// internal #409 — the rects of the frame's visible page windows (`Chrome_RenderWidgetHostHWND`, its direct children,
/// as every one measured was: win2, dev/409-spike round 2). At most 64 children are looked at.
fn page_window_rects(frame: HWND) -> Vec<RECT> {
    let mut out = Vec::new();
    let mut child = unsafe { GetWindow(frame, GW_CHILD) }.ok();
    for _ in 0..64 {
        let Some(h) = child.filter(|h| !h.0.is_null()) else { break };
        let mut buf = [0u16; 64];
        let len = unsafe { GetClassNameW(h, &mut buf) };
        let is_page = len > 0 && String::from_utf16_lossy(&buf[..len as usize]) == "Chrome_RenderWidgetHostHWND";
        let mut r = RECT::default();
        if is_page && unsafe { IsWindowVisible(h) }.as_bool() && unsafe { GetWindowRect(h, &mut r) }.is_ok() {
            out.push(r);
        }
        child = unsafe { GetWindow(h, GW_HWNDNEXT) }.ok();
    }
    out
}

fn rect_is_empty(r: &RECT) -> bool {
    r.right <= r.left || r.bottom <= r.top
}

fn rects_overlap(a: &RECT, b: &RECT) -> bool {
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

fn is_document(elem: &IUIAutomationElement) -> bool {
    unsafe { elem.CurrentControlType() }
        .map(|ct| ct.0 == UIA_DocumentControlTypeId.0)
        .unwrap_or(false)
}

/// internal #409 — the first element of class `CONTENTS_VIEW_CLASS` in tree order. It does not go into a Document: web
/// content holds no browser views, and the walk would spend its budget there.
///
/// It passes over an element whose rect overlaps none of `page_rects` (the frame's page windows): the tab strip, the
/// toolbar and the bookmarks bar, which come first in tree order and would otherwise spend the budget with many tabs
/// open (gate 2 on #986). An element whose rect cannot be read or is empty is gone into, as before.
fn find_contents_view(
    ctx: &UiaContext,
    elem: &IUIAutomationElement,
    depth: u32,
    page_rects: &[RECT],
    budget: &mut u32,
) -> Option<IUIAutomationElement> {
    if depth == 0 || *budget == 0 {
        return None;
    }
    *budget -= 1;
    if unsafe { elem.CurrentClassName() }.map(|c| c == CONTENTS_VIEW_CLASS).unwrap_or(false) {
        return Some(elem.clone());
    }
    if is_document(elem) {
        return None;
    }
    if let Ok(r) = unsafe { elem.CurrentBoundingRectangle() }
        && !page_rects.is_empty()
        && !rect_is_empty(&r)
        && !page_rects.iter().any(|p| rects_overlap(&r, p))
    {
        return None;
    }
    let mut child = unsafe { ctx.walker.GetFirstChildElement(elem) }.ok();
    while let Some(c) = child {
        if let Some(found) = find_contents_view(ctx, &c, depth - 1, page_rects, budget) {
            return Some(found);
        }
        if *budget == 0 {
            return None;
        }
        child = unsafe { ctx.walker.GetNextSiblingElement(&c) }.ok();
    }
    None
}

/// internal #409 — the windows (`drawn_in_window`) of the outermost Documents under `elem`, each once. What is nested
/// in a Document is drawn in its window, so the walk does not go into one.
fn collect_document_windows(
    ctx: &UiaContext,
    elem: &IUIAutomationElement,
    depth: u32,
    budget: &mut u32,
    out: &mut Vec<isize>,
) {
    if depth == 0 || *budget == 0 {
        return;
    }
    *budget -= 1;
    if is_document(elem) {
        if let Some(h) = drawn_in_window(ctx, elem)
            && !out.contains(&h)
        {
            out.push(h);
        }
        return;
    }
    let mut child = unsafe { ctx.walker.GetFirstChildElement(elem) }.ok();
    while let Some(c) = child {
        collect_document_windows(ctx, &c, depth - 1, budget, out);
        if *budget == 0 {
            return;
        }
        child = unsafe { ctx.walker.GetNextSiblingElement(&c) }.ok();
    }
}

/// internal #407 — what the DFS has met so far.
#[derive(Default)]
struct DevToolsSeen {
    devtools: bool,
    other_document: bool,
}

enum DocumentKind {
    NotDocument,
    DevTools,
    Other,
}

/// internal #407 — whether a DevTools front-end URL: `devtools://` or `chrome-devtools://`, in any case (the same set
/// as `DEVTOOLS_FRONTEND` in cdp-default-tab.ts).
fn is_devtools_url(url: &str) -> bool {
    let l = url.trim_start().to_ascii_lowercase();
    l.starts_with("devtools://") || l.starts_with("chrome-devtools://")
}

/// internal #407 — `elem` as a Document: DevTools' (its value, the URL, is a DevTools front end), another, or not a
/// Document. A value that cannot be read counts as another Document, so the search goes on as before.
fn document_kind(elem: &IUIAutomationElement) -> DocumentKind {
    unsafe {
        let Ok(ct) = elem.CurrentControlType() else { return DocumentKind::NotDocument };
        if ct.0 != UIA_DocumentControlTypeId.0 {
            return DocumentKind::NotDocument;
        }
        let url = elem
            .GetCurrentPattern(UIA_ValuePatternId)
            .ok()
            .and_then(|p| p.cast::<IUIAutomationValuePattern>().ok())
            .and_then(|vp| vp.CurrentValue().ok())
            .map(|b| b.to_string());
        match url {
            Some(u) if is_devtools_url(&u) => DocumentKind::DevTools,
            _ => DocumentKind::Other,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn find_scroll_pattern_dfs(
    ctx: &UiaContext,
    elem: &IUIAutomationElement,
    depth: u32,
    target_hwnd: isize,
    need_vertical: bool,
    need_horizontal: bool,
    node_budget: &mut u32,
    skip_devtools: bool,
    seen: &mut DevToolsSeen,
) -> Option<IUIAutomationScrollPattern> {
    if depth == 0 || *node_budget == 0 {
        return None;
    }
    *node_budget = node_budget.saturating_sub(1);
    unsafe {
        // internal #407 — see `find_scroll_pattern_in_subtree`: a DevTools Document's subtree is passed over on the
        // first pass, and any other Document is noted.
        match document_kind(elem) {
            DocumentKind::DevTools if skip_devtools => {
                seen.devtools = true;
                return None;
            }
            DocumentKind::Other => seen.other_document = true,
            _ => {}
        }
        // Check elem itself (P2-2: only accept if scrollable on needed axes).
        if let Ok(pat) = elem.GetCurrentPattern(UIA_ScrollPatternId)
            && let Ok(scroll) = pat.cast::<IUIAutomationScrollPattern>()
        {
            let v_ok = !need_vertical
                || scroll.CurrentVerticallyScrollable().map(|b| b.0 != 0).unwrap_or(false);
            let h_ok = !need_horizontal
                || scroll.CurrentHorizontallyScrollable().map(|b| b.0 != 0).unwrap_or(false);
            if v_ok && h_ok {
                return Some(scroll);
            }
            // Has ScrollPattern but not scrollable on the needed axis —
            // keep searching (P2-2).
        }
        // DFS into children (P2-1: stop at unrelated window boundaries).
        let first = ctx.walker.GetFirstChildElement(elem).ok()?;
        let mut child: Option<IUIAutomationElement> = Some(first);
        while let Some(c) = child {
            // P2-1 boundary guard: if this child carries a native HWND that
            // is neither `target_hwnd` nor a Win32 child window of it, the
            // child belongs to a completely different window hierarchy. Skip
            // it to avoid crossing into an unrelated window. Win32 child
            // windows of target_hwnd (e.g. WinUI3 DirectUIHWND, Electron
            // chrome_widgetwin sub-windows) are allowed because they are part
            // of the same logical app. HWND == 0 means no native window (pure
            // UIA node) — always descend.
            // Err: COM failure means we cannot determine which window this
            // child belongs to — skip it rather than treating it as a "pure
            // UIA node" and descending into potentially the wrong hierarchy
            // (Codex PR #292 P2).
            let child_hwnd = match c.CurrentNativeWindowHandle() {
                Err(_) => {
                    child = ctx.walker.GetNextSiblingElement(&c).ok();
                    continue;
                }
                Ok(h) => h.0 as isize,
            };
            if child_hwnd != 0
                && child_hwnd != target_hwnd
                && !IsChild(
                    HWND(target_hwnd as *mut std::ffi::c_void),
                    HWND(child_hwnd as *mut std::ffi::c_void),
                ).as_bool()
            {
                child = ctx.walker.GetNextSiblingElement(&c).ok();
                continue;
            }
            if let Some(found) = find_scroll_pattern_dfs(
                ctx, &c, depth - 1, target_hwnd, need_vertical, need_horizontal,
                node_budget, skip_devtools, seen,
            ) {
                return Some(found);
            }
            child = ctx.walker.GetNextSiblingElement(&c).ok();
        }
    }
    None
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// The scroll roads search with `actions::find_element_in_window` — one search for every road.
//
// They had their own copy, and it was the ORIGINAL: the acts' search delegated to it, which is how
// the window-first test reached them (internal #133). The reads and the scroll roads kept it until
// #134 moved every road to descendants-only, on both clients at once. A window matched by name was
// never an answer here either — `walk_scroll_ancestors` walks UP from what it found, so a window
// yields an empty list, and `ScrollItemPattern` is not on a top-level window.

/// Walk from element upward, collecting ancestors that expose ScrollPattern.
/// Returns outer→inner order (reversed from walk order, matching TS behaviour).
fn walk_scroll_ancestors(
    ctx: &UiaContext,
    elem: &IUIAutomationElement,
) -> napi::Result<Vec<ScrollAncestor>> {
    let mut ancestors = Vec::new();
    let root: IUIAutomationElement =
        unsafe { ctx.automation.GetRootElement().map_err(win_err)? };

    let mut current: Option<IUIAutomationElement> =
        unsafe { ctx.walker.GetParentElement(elem).ok() };

    while let Some(parent) = current {
        let is_root = unsafe {
            ctx.automation
                .CompareElements(&parent, &root)
                .unwrap_or_default()
        };
        if is_root == true {
            break;
        }

        // Parent wasn't fetched with cache — use Current* accessors (live RPC).
        unsafe {
            if let Ok(pat) = parent.GetCurrentPattern(UIA_ScrollPatternId)
                && let Ok(scroll) = pat.cast::<IUIAutomationScrollPattern>()
            {
                let name = parent
                    .CurrentName()
                    .map(|b| b.to_string())
                    .unwrap_or_default();
                let aid = parent
                    .CurrentAutomationId()
                    .map(|b| b.to_string())
                    .unwrap_or_default();
                let ct_id = super::current_control_type(&parent).unwrap_or(UIA_CustomControlTypeId);
                let ct = control_type_name(ct_id).to_string();

                let vp = scroll.CurrentVerticalScrollPercent().unwrap_or(-1.0);
                let hp = scroll.CurrentHorizontalScrollPercent().unwrap_or(-1.0);
                let vs = scroll
                    .CurrentVerticallyScrollable()
                    .map(|b| b == true)
                    .unwrap_or(false);
                let hs = scroll
                    .CurrentHorizontallyScrollable()
                    .map(|b| b == true)
                    .unwrap_or(false);

                ancestors.push(ScrollAncestor {
                    name,
                    automation_id: aid,
                    control_type: ct,
                    vertical_percent: vp,
                    horizontal_percent: hp,
                    vertically_scrollable: vs,
                    horizontally_scrollable: hs,
                });
            }
        }

        current = unsafe { ctx.walker.GetParentElement(&parent).ok() };
    }

    // Reverse to outer→inner (matching TS `[array]::Reverse($ancestors)`).
    ancestors.reverse();
    Ok(ancestors)
}

#[cfg(test)]
mod tests {
    #[test]
    fn devtools_urls_are_told_from_pages() {
        use super::is_devtools_url;
        assert!(is_devtools_url("devtools://devtools/bundled/devtools_app.html"));
        assert!(is_devtools_url("chrome-devtools://devtools/bundled/inspector.html"));
        assert!(is_devtools_url("DevTools://devtools/bundled/devtools_app.html"));
        assert!(!is_devtools_url("https://example.com/devtools://"));
        assert!(!is_devtools_url("http://127.0.0.1:8080/wheel-hit-path.html#panes"));
        assert!(!is_devtools_url(""));
        assert!(!is_devtools_url("chrome://settings"));
    }

    /// internal #409 — the page search runs only with every part given and readable; anything else keeps the old one.
    #[test]
    fn a_page_and_point_are_read_only_when_whole() {
        use super::{page_at_point, ScrollByWheelAtHwndOptions};
        let opts = |w: Option<Vec<&str>>, x: Option<i32>, y: Option<i32>| ScrollByWheelAtHwndOptions {
            hwnd: "1".into(),
            wheel_delta_y: 120,
            wheel_delta_x: 0,
            page_windows: w.map(|v| v.into_iter().map(String::from).collect()),
            point_x: x,
            point_y: y,
        };
        let p = page_at_point(&opts(Some(vec!["49482696", "105384926"]), Some(423), Some(540))).unwrap();
        assert_eq!(p.windows, vec![49482696, 105384926]);
        assert_eq!((p.x, p.y), (423, 540));
        assert!(page_at_point(&opts(None, Some(1), Some(1))).is_none());
        assert!(page_at_point(&opts(Some(vec!["5"]), None, Some(1))).is_none());
        assert!(page_at_point(&opts(Some(vec!["5"]), Some(1), None)).is_none());
        assert!(page_at_point(&opts(Some(vec![]), Some(1), Some(1))).is_none());
        // One unreadable or null window makes the whole list unreadable, rather than a shorter list.
        assert!(page_at_point(&opts(Some(vec!["5", "x"]), Some(1), Some(1))).is_none());
        assert!(page_at_point(&opts(Some(vec!["5", "0"]), Some(1), Some(1))).is_none());
    }

    #[test]
    fn a_rect_holds_its_top_left_but_not_its_far_edges() {
        use super::rect_holds;
        let r = windows::Win32::Foundation::RECT { left: 108, top: 187, right: 737, bottom: 892 };
        assert!(rect_holds(&r, 108, 187));
        assert!(rect_holds(&r, 423, 540));
        assert!(!rect_holds(&r, 737, 540));
        assert!(!rect_holds(&r, 423, 892));
        assert!(!rect_holds(&r, 107, 540));
        assert!(!rect_holds(&r, 1015, 540));
    }

    use super::wheel_step_percent;

    /// Regression guard for PR #288 Round 2 P1 (Codex + Opus consensus): the
    /// old formula multiplied by an extra 100, turning a one-notch scroll on a
    /// typical 20%-viewport into a 200% step that clamped straight to the
    /// 0%/100% boundary instead of moving incrementally.
    #[test]
    fn wheel_step_percent_applies_no_extra_hundred() {
        // 1 notch (120 units), viewport = 20% of content → 0.1 * 20 * 1 = 2.0%.
        assert!((wheel_step_percent(120, 20.0) - 2.0).abs() < 1e-9);
        // 3 notches (360 units), viewport = 20% → 6.0% (stays well below 100).
        assert!((wheel_step_percent(360, 20.0) - 6.0).abs() < 1e-9);
        // With SCROLL_STEP_MULTIPLIER = 0.1, a single notch on any 0..100
        // viewport yields at most 10% (view=100 → 1.0 * 100 * 0.1). This pins
        // that the *current multiplier* keeps one notch incremental rather than
        // a boundary jump — it is NOT a structural invariant of the formula
        // (the hard 0..100 bound is the `clamp` at the call site, not here).
        for view in [1.0_f64, 25.0, 50.0, 100.0] {
            assert!(wheel_step_percent(120, view).abs() <= 10.0);
        }
    }

    #[test]
    fn wheel_step_percent_sign_follows_delta() {
        assert!(wheel_step_percent(120, 30.0) > 0.0);
        assert!(wheel_step_percent(-120, 30.0) < 0.0);
        assert_eq!(wheel_step_percent(0, 30.0), 0.0);
    }
}
