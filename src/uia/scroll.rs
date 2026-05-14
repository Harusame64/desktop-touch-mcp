//! Scroll operations: ScrollItemPattern / ScrollPattern interaction.
//!
//! Mirrors `scrollElementIntoView`, `getScrollAncestors`, and `scrollByPercent`
//! from `uia-bridge.ts`.

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Accessibility::*;
use windows::core::Interface;

use super::thread::{self, UiaContext, win_err};
use super::tree::find_window;
use super::types::*;
use super::control_type_name;

const DEFAULT_TIMEOUT_MS: u32 = 8_000;
const MAX_SEARCH_DEPTH: u32 = 14;

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
}

// ─── Public API ──────────────────────────────────────────────────────────────

pub fn scroll_into_view(opts: ScrollIntoViewOptions) -> napi::Result<ScrollResult> {
    thread::execute_with_timeout(
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
    thread::execute_with_timeout(
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
    thread::execute_with_timeout(
        move |ctx| scroll_by_wheel_at_hwnd_impl(ctx, &opts),
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

    let elem = match find_element(ctx, &window, opts.name.as_deref(), opts.automation_id.as_deref())
    {
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

    let elem = match find_element(ctx, &window, Some(&opts.element_name), None) {
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

    let elem = match find_element(ctx, &window, Some(&opts.element_name), None) {
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

    // Walk from the element itself up through parents looking for the first
    // ScrollPattern. Stop at the desktop root (CompareElements true) so we
    // don't probe the root element (which has no useful ScrollPattern).
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
                // ADR §2.6.2 — `delivered_via_uia` requires UIA pre/post
                // percent to differ. Capture pre-state, perform
                // SetScrollPercent, re-read post-state, compare.
                //
                // Pre-state percent and target are computed per axis, ONLY for
                // the axis actually being scrolled. A failed pre-state OR
                // view-size read on the ACTIVE axis returns ok:false so the TS
                // dispatcher falls through to legacy nutjs — NOT a silent
                // `unwrap_or(0.0)`, which would compute the target from a fake
                // baseline and jump toward the start of content (Codex PR #288
                // Round 6 P2). The unused axis is never read — fetching (and
                // hard-failing on) it would make Tier 1 falsely unreachable for
                // elements that scroll one axis but don't reliably expose the
                // other (Codex PR #288 Round 3 P1). `view_size` is ALREADY a
                // percentage (0..100, per UIA ViewSize semantics) so
                // `wheel_step_percent` applies no extra `* 100` scaling.
                //
                // `cur_v` / `cur_h` are `Some(pre_percent)` exactly when that
                // axis is being scrolled — the post-state movement check below
                // considers only those axes.
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
                        (cv + wheel_step_percent(opts.wheel_delta_y, view_v))
                            .clamp(0.0, 100.0)
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
                        (ch + wheel_step_percent(opts.wheel_delta_x, view_h))
                            .clamp(0.0, 100.0)
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

                // ADR §2.6.2 emission gate — pre/post must differ to claim
                // `delivered_via_uia`. SCROLL_PERCENT_EPSILON is 1e-3 in
                // percent units (0..100 range). The TS-side mouse.ts epsilon
                // (1e-6) targets Win32 GetScrollInfo pageRatio (0..1 range)
                // and is not applicable to UIA percent semantics.
                //
                // Some UIA providers update Current*ScrollPercent
                // asynchronously — the value can still read stale for a few ms
                // after `SetScrollPercent` returns Ok. A single immediate
                // re-read would mis-classify a successful scroll as
                // `scrolled:false`, the TS dispatcher would fall through to
                // Tier 4 SendInput, and the wheel would fire a SECOND time on
                // the same call — over-scrolling or scrolling the wrong layer
                // (Codex PR #288 Round 5 P1). Poll the post-state a few times
                // with a short delay, breaking as soon as movement is observed
                // (the synchronous-provider common case exits on attempt 1,
                // before any sleep). Only the scrolled axes (`cur_* = Some`)
                // participate in the movement check — a non-scrolled axis was
                // sent -1.0 and must not influence the verdict. A failed
                // post-read falls back to the pre-value (`unwrap_or(c*)`),
                // i.e. "no movement observed" — the conservative verdict.
                const SCROLL_PERCENT_EPSILON: f64 = 1e-3;
                const POST_READ_RETRIES: u32 = 6;
                const POST_READ_DELAY_MS: u64 = 5;
                let mut moved = false;
                let mut attempt: u32 = 0;
                loop {
                    if let Some(cv) = cur_v {
                        let post_v = scroll
                            .CurrentVerticalScrollPercent()
                            .unwrap_or(cv);
                        if (post_v - cv).abs() >= SCROLL_PERCENT_EPSILON {
                            moved = true;
                        }
                    }
                    if !moved {
                        if let Some(ch) = cur_h {
                            let post_h = scroll
                                .CurrentHorizontalScrollPercent()
                                .unwrap_or(ch);
                            if (post_h - ch).abs() >= SCROLL_PERCENT_EPSILON {
                                moved = true;
                            }
                        }
                    }
                    attempt += 1;
                    if moved || attempt >= POST_READ_RETRIES {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(
                        POST_READ_DELAY_MS,
                    ));
                }

                return Ok(ScrollResult {
                    ok: true,
                    scrolled: moved,
                    error: if moved {
                        None
                    } else {
                        Some(
                            "SetScrollPercent returned Ok but pre/post percent unchanged"
                                .into(),
                        )
                    },
                });
            }
        }

        current = unsafe { ctx.walker.GetParentElement(&e).ok() };
    }

    Ok(ScrollResult {
        ok: false,
        scrolled: false,
        error: Some("No ScrollPattern ancestor found".into()),
    })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// DFS search for an element by name (case-insensitive substring) and/or
/// automationId (exact match). Uses CacheRequest to batch property fetches.
pub(crate) fn find_element(
    ctx: &UiaContext,
    window: &IUIAutomationElement,
    name: Option<&str>,
    automation_id: Option<&str>,
) -> napi::Result<IUIAutomationElement> {
    let name_lower = name.map(|n| n.to_lowercase());

    // Check the window element itself.
    if matches_element(window, &name_lower, automation_id) {
        return Ok(window.clone());
    }

    let mut stack: Vec<(IUIAutomationElement, u32)> = Vec::with_capacity(64);

    if let Ok(child) = unsafe {
        ctx.walker
            .GetFirstChildElementBuildCache(window, &ctx.cache_request)
    } {
        stack.push((child, 1));
    }

    while let Some((elem, depth)) = stack.pop() {
        // Push sibling before match check so siblings are always visited.
        if let Ok(sib) = unsafe {
            ctx.walker
                .GetNextSiblingElementBuildCache(&elem, &ctx.cache_request)
        } {
            stack.push((sib, depth));
        }

        if matches_element(&elem, &name_lower, automation_id) {
            return Ok(elem);
        }

        if depth < MAX_SEARCH_DEPTH
            && let Ok(child) = unsafe {
                ctx.walker
                    .GetFirstChildElementBuildCache(&elem, &ctx.cache_request)
            }
        {
            stack.push((child, depth + 1));
        }
    }

    Err(napi::Error::from_reason("Element not found"))
}

/// Check if an element matches by name (case-insensitive substring)
/// and/or automationId (exact). Both must pass when specified.
fn matches_element(
    elem: &IUIAutomationElement,
    name_lower: &Option<String>,
    automation_id: Option<&str>,
) -> bool {
    let name_ok = match name_lower {
        Some(target) => unsafe {
            elem.CachedName()
                .map(|n| n.to_string().to_lowercase().contains(target.as_str()))
                .unwrap_or(false)
        },
        None => true,
    };

    let id_ok = match automation_id {
        Some(target) => unsafe {
            elem.CachedAutomationId()
                .is_ok_and(|id| id == target)
        },
        None => true,
    };

    name_ok && id_ok
}

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
                let ct_id = parent
                    .CurrentControlType()
                    .unwrap_or(UIA_CustomControlTypeId);
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
