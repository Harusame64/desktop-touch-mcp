/**
 * _fill-kind-js.ts — what an element browser_fill will not type into is, for its next steps, shared by the selector
 * road and the by-axis road (internal #420). It needs ELEMENT_NAME_JS (for __closest) spliced into the same script.
 */
/**
 * `__fillKind(el, axRole)`: an option, a toggle, a choice widget that opens a list, something named a text field,
 * or anything else. Roles: every token of the attribute and the tree's computed role (`axRole`, when the tree was
 * read); a part inside a widget (Select2's rendered value, role textbox) is the widget's. A menu holds commands, not
 * choices: only a list popup or a combobox is a choice widget (/code-review on #1023). Chrome's tree already calls a
 * button or div[role=button] with aria-haspopup=listbox a combobox (measured on #1023).
 *
 * `__choiceInput(el, axRole)`: a read-only <input> that is a choice widget (Ant Design's Select, Vuetify's v-select, a
 * read-only MUI Autocomplete), read-only natively, by aria-readonly, or by inputmode=none (Vuetify 3). A person cannot type into it; writing its value changes the text and not the widget's
 * choice, and the read-back matched, so it was reported filled (/code-review on #1023).
 */
export const FILL_KIND_JS = `
  function __fillKind(el, axRole) {
    const tag = el.tagName;
    const ty = (el.getAttribute('type') || '').toLowerCase();
    const roleToks = (el.getAttribute('role') || '').toLowerCase().split(/\\s+/).filter(Boolean);
    if (axRole) roleToks.push(axRole);
    const hasRole = function(r) { return roleToks.indexOf(r) >= 0; };
    const popup = (el.getAttribute('aria-haspopup') || '').toLowerCase();
    if (hasRole('option') || hasRole('menuitem') || hasRole('menuitemradio') || hasRole('menuitemcheckbox')) return 'option';
    if (tag === 'INPUT' && /^(checkbox|radio)$/.test(ty) || hasRole('checkbox') || hasRole('radio') || hasRole('switch')) return 'toggle';
    if (hasRole('combobox') || popup === 'listbox') return 'widget';
    if (__closest(el, '[role~=combobox i],[aria-haspopup=listbox i]')) return 'widget';
    // The box around a widget's own input (Ant Design's .ant-select-selector): a choice widget when the one control
    // inside it is that combobox, not a form that holds one among others (win2 on #1027, R5b).
    const W = '[role~=combobox i],[aria-haspopup=listbox i]';
    const inner = Array.prototype.slice.call(__qsa(el, 'input,select,textarea,button,[contenteditable],' + W));
    let one = null;
    if (inner.length > 0 && inner.every(function(n) {
      const c = __matches(n, W) ? n : __closest(n, W);
      if (!c || c === el || !__contains(el, c)) return false;
      // The outermost widget inside the box: one widget, not two side by side.
      let top = c;
      for (let up = __parent(c); up && up !== el; up = __parent(up)) if (__matches(up, W)) top = up;
      if (one === null) one = top;
      return one === top;
    })) return 'widget';
    if (hasRole('textbox') || hasRole('searchbox')) return 'textlike';
    return 'other';
  }
  function __choiceInput(el, axRole) {
    // Read-only natively, only to assistive technology (a widget that blocks keys in script), or an input that asks for
    // no keyboard inside a choice widget (Vuetify 3's v-select: inputmode=none, the combobox on the field around it,
    // win2 on #1027, R2).
    const ro = el.readOnly === true || (el.getAttribute('aria-readonly') || '').toLowerCase() === 'true' ||
      (el.getAttribute('inputmode') || '').toLowerCase() === 'none';
    return el.tagName === 'INPUT' && ro && __fillKind(el, axRole) === 'widget';
  }
`;
