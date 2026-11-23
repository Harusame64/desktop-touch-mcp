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
  // Whether a person could type into el once it was focused (internal #420): null when they could, else why not. A
  // disabled or read-only field takes no typing. Otherwise the browser's focus decides: the focused element, through
  // open shadow roots, must be el or inside it (a custom element that hands focus to its own input), or the editing
  // host around el. Behind a modal dialog or under inert, focus stays where it was; a field that hands
  // focus on takes no typing either. The getters are the prototypes': a page's <img name="activeElement"> shadows
  // document.activeElement.
  function __typingRefused(el) {
    // Disabled by itself or by a <fieldset disabled> around it.
    let off = el.disabled === true;
    try { off = off || __matches(el, ':disabled'); } catch (e) { }
    if (off) return { why: 'disabled' };
    // Read-only is read once the page's focus handlers ran: a field can drop readonly as it takes focus (a guard
    // against autofill). browser_fill gives the page focus for its call (CDP focus emulation), so they have; a page
    // still without focus (the emulation could not be set) runs them only when it gets focus, so there the field is
    // written as before.
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.readOnly === true &&
      (typeof Document !== 'undefined' ? Document.prototype.hasFocus.call(document) : !!(document.hasFocus && document.hasFocus()))) return { why: 'read_only' };
    const getter = function(C, k) { return typeof C !== 'undefined' ? Object.getOwnPropertyDescriptor(C.prototype, k).get : null; };
    const docAct = getter(typeof Document !== 'undefined' ? Document : undefined, 'activeElement');
    const srAct = getter(typeof ShadowRoot !== 'undefined' ? ShadowRoot : undefined, 'activeElement');
    const srGet = getter(typeof Element !== 'undefined' ? Element : undefined, 'shadowRoot');
    const deep = function() {
      let a = docAct ? docAct.call(document) : document.activeElement;
      const sr = function(n) { return srGet ? srGet.call(n) : n.shadowRoot; };
      for (let r = a && sr(a); r && (srAct ? srAct.call(r) : r.activeElement); r = a && sr(a)) a = srAct ? srAct.call(r) : r.activeElement;
      return a;
    };
    // A part inside a contenteditable (a paragraph) takes no focus of its own; a person's click puts the caret in the
    // editing host around it, so the host is focused.
    if (el.isContentEditable) {
      let host = el;
      while (__parent(host) && __parent(host).isContentEditable) host = __parent(host);
      if (host !== el && deep() !== host) host.focus();
    }
    const holds = function(a) {
      if (a && a.isContentEditable && __contains(a, el)) return true;
      // Up the composed tree from the focused element: el itself, a control inside it (Vaadin's slotted <input>), or
      // one in its shadow tree (Shoelace, Material Web: delegatesFocus).
      for (let n = a, d = 0; n && d < 64; d++) {
        if (n === el) return true;
        const p = __parent(n);
        if (p) { n = p; continue; }
        const root = typeof Node !== 'undefined' ? Node.prototype.getRootNode.call(n) : (n.getRootNode ? n.getRootNode() : null);
        n = root && root.nodeType === 11 && root.host ? root.host : null;
      }
      return false;
    };
    let a = deep();
    // A custom element that takes no focus itself but holds a text control (Ionic's ion-input): a person's click lands
    // in that control, so it is focused.
    if (!holds(a) && el.tagName.indexOf('-') > 0) {
      const TEXT = 'input:not([type=hidden]),textarea,[contenteditable]:not([contenteditable=false])';
      const sr = srGet ? srGet.call(el) : el.shadowRoot;
      const inner = el.querySelector(TEXT) || (sr ? sr.querySelector(TEXT) : null);
      if (inner) { inner.focus(); a = deep(); }
    }
    if (holds(a)) return null;
    const docGet = function(k) { const g = getter(typeof Document !== 'undefined' ? Document : undefined, k); return g ? g.call(document) : document[k]; };
    const at = a && a !== docGet('body') && a !== docGet('documentElement') ? a : null;
    return { why: 'no_focus', focusAt: at ? { name: __personName(at), tag: at.tagName.toLowerCase() } : null };
  }
`;
