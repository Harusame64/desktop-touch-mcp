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
    fn names_pages_by_their_automation_id() {
        assert!(is_word_page("UIA_AutomationId_Word_Page_1"));
        assert!(is_word_page("UIA_AutomationId_Word_Page_34"));
        assert!(!is_word_page("Body"));
        assert!(!is_word_page(""));
        assert!(!is_word_page("uia_automationid_word_page_1"));
    }
}
