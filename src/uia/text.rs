//! TextPattern text extraction.
//!
//! Mirrors `getTextViaTextPattern` from `uia-bridge.ts`:
//! finds the best TextPattern element in a window (preferring Document/Edit
//! control types) and returns the full buffer text.

use windows::Win32::UI::Accessibility::*;
use windows::core::Interface;

use super::thread::{self, UiaContext, win_err};
use super::tree::find_window;
use super::control_type_name;

// ─── Options from JS ─────────────────────────────────────────────────────────

#[napi_derive::napi(object)]
#[derive(Debug, Clone)]
pub struct GetTextOptions {
    pub window_title: String,
    pub timeout_ms: u32,
}

// ─── Public API ──────────────────────────────────────────────────────────────

/// Returns the full text content from the best TextPattern element,
/// or `None` if no TextPattern is available.
pub fn get_text_via_text_pattern(opts: GetTextOptions) -> napi::Result<Option<String>> {
    let timeout = opts.timeout_ms.max(1_000);
    thread::execute_with_timeout(
        move |ctx| get_text_impl(ctx, &opts),
        timeout,
    )
}

// ─── Implementation ──────────────────────────────────────────────────────────

fn get_text_impl(ctx: &UiaContext, opts: &GetTextOptions) -> napi::Result<Option<String>> {
    let window = match find_window(ctx, &opts.window_title) {
        Ok(w) => w,
        Err(_) => return Ok(None),
    };

    // Collect all descendants + the window itself, find the best TextPattern match.
    let condition = unsafe {
        ctx.automation.CreateTrueCondition().map_err(win_err)?
    };
    let all = unsafe {
        window
            .FindAll(TreeScope_Descendants, &condition)
            .map_err(win_err)?
    };
    let count = unsafe { all.Length().map_err(win_err)? };

    let mut best_text = String::new();
    let mut best_score: i32 = -1;
    let mut best_len: i32 = -1;

    // Helper: score a control type (higher = more preferred)
    let score_ct = |ct: &str| -> i32 {
        match ct {
            "Document" | "Edit" => 3,
            "Custom" => 2,
            "Pane" | "Group" => 1,
            _ => 0,
        }
    };

    // Check descendants
    for i in 0..count {
        if let Some((text, score)) = unsafe { try_text_pattern(&all, i, &score_ct) } {
            let len = text.len() as i32;
            if score > best_score || (score == best_score && len > best_len) {
                best_score = score;
                best_len = len;
                best_text = text;
            }
            // Short-circuit: Document/Edit with non-empty text is optimal
            if best_score == 3 && best_len > 0 {
                break;
            }
        }
    }

    // Also check the window element itself
    if best_score < 3 || best_len <= 0 {
        unsafe {
            if let Ok(pat) = window.GetCurrentPattern(UIA_TextPatternId)
                && let Ok(tp) = pat.cast::<IUIAutomationTextPattern>()
                && let Ok(range) = tp.DocumentRange()
                && let Ok(text) = range.GetText(-1)
            {
                let score = score_ct("Window");
                let len = text.len() as i32;
                if score > best_score
                    || (score == best_score && len > best_len)
                {
                    best_score = score;
                    best_text = text.to_string();
                }
            }
        }
    }

    if best_score < 0 {
        Ok(None)
    } else {
        Ok(Some(best_text))
    }
}

/// Try to extract text from element at index `i` in the element array.
/// Returns `Some((text, score))` if the element has TextPattern.
unsafe fn try_text_pattern(
    all: &IUIAutomationElementArray,
    i: i32,
    score_ct: &dyn Fn(&str) -> i32,
) -> Option<(String, i32)> {
    unsafe {
        let elem = all.GetElement(i).ok()?;
        let pat = elem.GetCurrentPattern(UIA_TextPatternId).ok()?;
        let tp: IUIAutomationTextPattern = pat.cast().ok()?;
        let range = tp.DocumentRange().ok()?;
        let text = range.GetText(-1).ok()?;

        let ct_id = elem
            .CurrentControlType()
            .unwrap_or(UIA_CustomControlTypeId);
        let ct_name = control_type_name(ct_id);
        let score = score_ct(ct_name);

        Some((text.to_string(), score))
    }
}
