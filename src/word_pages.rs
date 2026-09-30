//! internal #217 — where the navigation of Word's document area stops.
//!
//! Kept out of `uia` (Windows-only) so the rule is a pure function with tests that run anywhere; the
//! COM walk in `uia/tree.rs` feeds it each child's page-ness and offscreen state.

/// Word names each page `UIA_AutomationId_Word_Page_<n>` (measured, win2, 2026-09-30). Only these are
/// pages: an onscreen child that is not one (the leading Pane, or any other region) says nothing about
/// where the visible pages are (gate 2).
pub(crate) fn is_word_page(automation_id: &str) -> bool {
    automation_id.starts_with("UIA_AutomationId_Word_Page_")
}

/// internal #217 part 2 — a page's body: an `Edit` named `Body` with no window of its own, drawn in
/// Word's `_WwG` document window (measured, win2, 2026-09-30). Its TextPattern answers that page's
/// text alone, not the document's.
pub(crate) fn is_word_body(control_type: &str, automation_id: &str, own_window: bool, host_class: Option<&str>) -> bool {
    control_type == "Edit" && automation_id == "Body" && !own_window && host_class == Some("_WwG")
}

/// The most characters a body's visible text is kept to. Only `query` matching reads it. A dense
/// page shown whole (two columns of 9pt, tables) can pass 4000 characters (gate 2), so this is
/// several such pages' worth.
pub(crate) const BODY_TEXT_CAP: usize = 16_000;

/// The visible text of a body, one piece per range, put back together as it stands in the page and
/// cut to `BODY_TEXT_CAP` characters. MEASURED win2 (2026-09-30, re-check on `3393622f`): Word gives
/// one range per visible PARAGRAPH, wrapped lines included, each ending in its own `\r` (an earlier
/// report of one range per line came from a document whose paragraphs were one line each). Nothing is
/// put between the pieces: the text already carries its breaks, and a separator added where a range
/// ends without one would split a word the query is looking for ("コンテン" | "ツ"; gate 2). Where a
/// paragraph only partly on screen is cut is not measured.
pub(crate) fn join_visible_lines<I: IntoIterator<Item = String>>(lines: I) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    for line in lines {
        if count >= BODY_TEXT_CAP {
            break;
        }
        for ch in line.chars() {
            if count >= BODY_TEXT_CAP {
                break;
            }
            out.push(ch);
            count += 1;
        }
    }
    out
}

/// Pages come in document order: offscreen ones above the view, the visible ones, offscreen ones
/// below. Once a page has been onscreen, the next offscreen page ends the list — the rest are below
/// the view and would be pruned by the walk. An offscreen state that could not be read neither starts
/// nor ends anything.
#[derive(Default)]
pub(crate) struct PageStop {
    page_seen_on_screen: bool,
}

impl PageStop {
    /// Whether the list ends before this child.
    pub(crate) fn ends_before(&mut self, is_page: bool, offscreen: Option<bool>) -> bool {
        if !is_page {
            return false;
        }
        match offscreen {
            Some(true) => self.page_seen_on_screen,
            Some(false) => {
                self.page_seen_on_screen = true;
                false
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds a list of children and returns how many are kept before the list ends.
    fn kept(children: &[(bool, Option<bool>)]) -> usize {
        let mut stop = PageStop::default();
        children.iter().take_while(|(page, off)| !stop.ends_before(*page, *off)).count()
    }

    const PANE_ON: (bool, Option<bool>) = (false, Some(false));
    const ON: (bool, Option<bool>) = (true, Some(false));
    const OFF: (bool, Option<bool>) = (true, Some(true));
    const UNREAD: (bool, Option<bool>) = (true, None);

    #[test]
    fn keeps_pages_scrolled_past_above_the_view() {
        // Scrolled to page 3: the onscreen Pane first, pages 1-2 above the view, page 3 visible.
        assert_eq!(kept(&[PANE_ON, OFF, OFF, ON, OFF, OFF]), 4);
    }

    #[test]
    fn ends_at_the_first_offscreen_page_after_a_visible_one() {
        assert_eq!(kept(&[PANE_ON, ON, ON, OFF, ON]), 3);
    }

    #[test]
    fn an_onscreen_child_that_is_not_a_page_starts_nothing() {
        assert_eq!(kept(&[PANE_ON, (false, Some(false)), OFF, ON]), 4);
    }

    #[test]
    fn an_unreadable_offscreen_state_neither_starts_nor_ends() {
        assert_eq!(kept(&[PANE_ON, UNREAD, OFF, ON, UNREAD, OFF]), 5);
    }

    #[test]
    fn keeps_everything_when_no_page_is_visible() {
        assert_eq!(kept(&[PANE_ON, OFF, OFF, OFF]), 4);
    }

    #[test]
    fn a_body_is_an_edit_named_body_without_its_own_window_in_wwg() {
        assert!(is_word_body("Edit", "Body", false, Some("_WwG")));
        assert!(!is_word_body("Edit", "Body", true, Some("_WwG")));
        assert!(!is_word_body("Edit", "Body", false, Some("OpusApp")));
        assert!(!is_word_body("Edit", "Body", false, None));
        assert!(!is_word_body("Edit", "body", false, Some("_WwG")));
        assert!(!is_word_body("Document", "Body", false, Some("_WwG")));
    }

    #[test]
    fn joins_visible_lines_as_they_stand_so_a_wrapped_word_stays_whole() {
        let lines = ["確認するコンテン".to_string(), "ツです。\r".to_string(), "hello ".to_string(), "world\r".to_string()];
        let out = join_visible_lines(lines);
        assert_eq!(out, "確認するコンテンツです。\rhello world\r");
        assert!(out.contains("コンテンツ"));
        assert!(out.contains("hello world"));
    }

    #[test]
    fn cuts_the_text_at_the_cap_in_characters() {
        let line = "あ".repeat(BODY_TEXT_CAP + 10);
        let out = join_visible_lines([line, "later".to_string()]);
        assert_eq!(out.chars().count(), BODY_TEXT_CAP);
        assert!(!out.contains("later"));
    }

    #[test]
    fn no_lines_is_empty() {
        assert_eq!(join_visible_lines(Vec::<String>::new()), "");
    }

    #[test]
    fn names_pages_by_their_automation_id() {
        assert!(is_word_page("UIA_AutomationId_Word_Page_1"));
        assert!(is_word_page("UIA_AutomationId_Word_Page_34"));
        assert!(!is_word_page("Body"));
        assert!(!is_word_page(""));
        assert!(!is_word_page("uia_automationid_word_page_1"));
    }
}
