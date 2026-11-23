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
  // disabled field takes no typing, nor a read-only one once focus has reached it (behind a dialog, the dialog is what
  // stops a person, so that is the answer), nor one not shown. Otherwise the browser's focus decides: the focused element, through
  // open shadow roots, must be el or inside it (a custom element that hands focus to its own input), or the editing
  // host around el. Behind a modal dialog or under inert, focus stays where it was; a field that hands
  // focus on takes no typing either. The getters are the prototypes': a page's <img name="activeElement"> shadows
  // document.activeElement.
  // Whether the page has focus (a window in front, the tab shown). Without it the page's focus handlers have not run
  // yet: a field that hands focus on, or drops readonly as it takes focus, has not done so (internal #420).
  function __pageHasFocus() {
    return typeof Document !== 'undefined' ? Document.prototype.hasFocus.call(document) : !!(document.hasFocus && document.hasFocus());
  }
  function __typingRefused(el) {
    // Disabled by itself or by a <fieldset disabled> around it. First: a disabled field takes focus nowhere, so the
    // focus answer would only hide why.
    let off = el.disabled === true;
    try { off = off || __matches(el, ':disabled'); } catch (e) { }
    if (off) return { why: 'disabled' };
    // A prototype's getter, or null (no such class, or a page that removed it): then the instance's property is read.
    const getter = function(C, k) {
      if (typeof C === 'undefined') return null;
      const d = Object.getOwnPropertyDescriptor(C.prototype, k);
      return d && d.get ? d.get : null;
    };
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
    // A custom element that takes no focus itself (no tabindex, no delegatesFocus: its focus() did nothing, so no
    // handler of its own moved focus) but holds a text control (Ionic's ion-input): a person's click lands in the first
    // one shown, in its light DOM or its open shadow root (a hidden form proxy is not it), so that one is focused.
    const own = srGet ? srGet.call(el) : el.shadowRoot;
    if (!holds(a) && el.tagName.indexOf('-') > 0 && !el.hasAttribute('tabindex') && !(own && own.delegatesFocus)) {
      const TEXT = 'input:not([type=hidden]),textarea,[contenteditable]:not([contenteditable=false])';
      const all = Array.prototype.slice.call(el.querySelectorAll(TEXT)).concat(own ? Array.prototype.slice.call(own.querySelectorAll(TEXT)) : []);
      const inner = all.filter(function(c) { try { return c.getClientRects().length > 0; } catch (e) { return false; } })[0] || null;
      if (inner && inner.disabled === true) return { why: 'disabled' };
      if (inner) { inner.focus(); a = deep(); }
    }
    if (holds(a)) {
      // Read-only, itself (a custom element's readOnly too) or the control inside it that holds focus (sl-input's
      // input), once focus has reached it: behind a dialog, the dialog is what stops a person.
      const ctlRO = a && a !== el && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.readOnly === true;
      // On a page without focus read-only is not judged (it may be a guard against autofill that its focus handler
      // has not lifted yet): written as before, and the answer carries pageFocused:false.
      if ((el.readOnly === true || ctlRO) && __pageHasFocus()) return { why: 'read_only' };
      return null;
    }
    // Not shown (a hidden input, no box, visibility:hidden): no person sees it to type into.
    try {
      if ((el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') || el.getClientRects().length === 0 ||
        getComputedStyle(el).visibility === 'hidden') return { why: 'not_shown' };
    } catch (e) { }
    const docGet = function(k) { const g = getter(typeof Document !== 'undefined' ? Document : undefined, k); return g ? g.call(document) : document[k]; };
    const at = a && a !== docGet('body') && a !== docGet('documentElement') ? a : null;
    return { why: 'no_focus', focusAt: at ? { name: __personName(at), tag: at.tagName.toLowerCase() } : null };
  }
`;
