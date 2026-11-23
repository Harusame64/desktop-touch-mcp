/**
 * _select-pick-js.ts — which option of a native <select> a fill takes, shared by browser_fill's selector road and its
 * by-axis road (internal #420), and the write that sets it. It needs ELEMENT_NAME_JS (for __standInFor and __isMasked)
 * spliced into the same script.
 */
/**
 * Which option of a native <select> a fill takes, as a person picks one (internal #420, /code-review on #1024): the
 * option whose value is the value, else the one option whose shown text (its label, or its text) is. Refused, with
 * the select untouched: a value or a text no option has, one several options share, a value one option has and a
 * text another shows, a disabled select or option (or one in a disabled group or fieldset), a hidden option, a
 * multiple-choice select (setting one would drop the others), and a select a widget stands in for (__standInFor:
 * setting it changes nothing the widget shows, win2 on #1023).
 */
export const SELECT_PICK_JS = `
  function __pickOption(el, want) {
    const dis = function(n) { try { return Element.prototype.matches.call(n, ':disabled'); } catch (e) { return !!n.disabled; } };
    // :disabled also covers a <fieldset disabled> around it and a disabled optgroup (/code-review on #1024).
    if (dis(el)) return { error: 'select_disabled' };
    if (__standInFor(el)) return { error: 'select_unseen' };
    if (el.multiple) return { error: 'select_multiple' };
    const opts = Array.prototype.slice.call(el.options);
    const w = String(want), wt = w.trim();
    const byValue = [], byText = [];
    opts.forEach(function(o, i) {
      if (o.value === w) byValue.push(i);
      if (wt !== '' && ((o.label || o.text || '').trim() === wt)) byText.push(i);
    });
    if (byValue.length > 1) return { error: 'option_value_repeats' };
    let idx = -1;
    if (byValue.length === 1) {
      // Any other option showing that text makes it ambiguous, also when the value's own option shows it too (codex
      // on #1024: value "Same" beside another option shown "Same").
      if (byText.some(function(i) { return i !== byValue[0]; })) return { error: 'option_ambiguous' };
      idx = byValue[0];
    } else if (byText.length === 1) idx = byText[0];
    else return { error: byText.length > 1 ? 'option_text_repeats' : 'no_such_option' };
    const o = opts[idx];
    if (dis(o)) return { error: 'option_disabled' };
    // A hidden option is one a person never sees to pick (a "Choose…" placeholder with hidden).
    if (o.hidden || getComputedStyle(o).display === 'none') return { error: 'no_such_option' };
    return { idx: idx, opt: o };
  }
  // Set the picked option and read it back, the one write both roads use (/code-review on #1025: two copies drifted).
  // Focus first, as a person's pick; then the pick again, since a focus handler can rebuild the list or change the
  // option (refused, unset, unless it picks the same option); the mask read after focus too, as the text road does.
  function __setPickedOption(el, pk, maskedBefore, want) {
    // A select a person could not reach (behind a modal dialog, under inert) is not changed, as a text field is not,
    // and is not focused first (internal #420). __typingRefused is FILL_KIND_JS's: every caller splices it.
    const refused = __typingRefused(el);
    if (refused) return { ok: false, typingRefused: refused };
    el.focus();
    // The whole pick again, after focus: a handler can rebuild the list, change the option's value or disable it
    // (codex on #1025). Written only when it still picks the same option.
    const again = __pickOption(el, want);
    if (again.error) return { ok: false, selectError: again.error };
    if (again.opt !== pk.opt) return { ok: false, selectError: 'options_changed' };
    const idx = again.idx;
    const maskedAfterFocus = __isMasked(el);
    const chosen = pk.opt.value;
    if (el.selectedIndex !== idx) {
      const sd = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
      if (sd && sd.set) sd.set.call(el, idx); else el.selectedIndex = idx;
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const masked = maskedBefore || maskedAfterFocus || __isMasked(el);
    return { ok: true, actual: masked ? undefined : (el.value || '').slice(0, 100), actualWithheld: masked || undefined,
      fullActualLen: (el.value || '').length, fullMatches: el.value === chosen, chose: masked ? undefined : chosen, select: true };
  }
`;
