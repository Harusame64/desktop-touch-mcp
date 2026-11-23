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
  // Whether a person could type into el, by what the page's structure says (internal #420): null when nothing stops
  // them, else why. Facts only, none that waits on a page's focus handler (read-only, a field that hands focus on: not
  // judged here). Disabled (itself or by a <fieldset disabled>); a native control not shown; inside a part of the page
  // marked inert (an ancestor's inert attribute, across shadow roots: booking.com's sign-in prompt); outside the top
  // modal <dialog> while one is open. The top dialog is found from the focus, as #1031's note finds it: down open shadow
  // roots, then up the composed tree; else the one open modal dialog of the document or an open shadow root (a closed
  // one's is not seen; with several and the focus in none, only outside all of them is known). The getters and querySelectorAll
  // are the prototypes': a page's <img name="activeElement"> shadows document.activeElement.
  function __typingRefused(el) {
    let off = el.disabled === true;
    try { off = off || __matches(el, ':disabled'); } catch (e) { }
    if (off) return { why: 'disabled' };
    const tag = el.tagName;
    // Not shown: checkVisibility where Chrome has it (display:none, visibility hidden or collapse, inside a closed
    // <details> or content-visibility:hidden), else no box or visibility other than visible.
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      try {
        const unseen = typeof el.checkVisibility === 'function'
          ? !el.checkVisibility({ visibilityProperty: true })
          : el.getClientRects().length === 0 || getComputedStyle(el).visibility !== 'visible';
        if (unseen || (tag === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'hidden')) return { why: 'not_shown' };
      } catch (e) { }
    }
    const getter = function(C, k) {
      if (typeof C === 'undefined') return null;
      const d = Object.getOwnPropertyDescriptor(C.prototype, k);
      return d && d.get ? d.get : null;
    };
    const D = typeof Document !== 'undefined' ? Document : undefined;
    const docAct = getter(D, 'activeElement');
    const srAct = getter(typeof ShadowRoot !== 'undefined' ? ShadowRoot : undefined, 'activeElement');
    const srGet = getter(typeof Element !== 'undefined' ? Element : undefined, 'shadowRoot');
    const slotGet = getter(typeof Element !== 'undefined' ? Element : undefined, 'assignedSlot');
    // The composed parent: the assigned slot, the parent, or the host of the shadow root it sits in.
    const up = function(n) {
      const slot = n.nodeType === 1 && slotGet ? slotGet.call(n) : null;
      if (slot) return slot;
      const p = __parent(n);
      if (p) return p;
      const root = typeof Node !== 'undefined' ? Node.prototype.getRootNode.call(n) : (n.getRootNode ? n.getRootNode() : null);
      return root && root.nodeType === 11 && root.host ? root.host : null;
    };
    // The walks end at the document; the cap only guards against a page that loops its parent getters.
    const CAP = 100000;
    const within = function(n, box) { for (let d = 0; n && d < CAP; d++, n = up(n)) if (n === box) return true; return false; };
    let a = docAct ? docAct.call(document) : document.activeElement;
    for (let r = a && (srGet ? srGet.call(a) : a.shadowRoot); r && (srAct ? srAct.call(r) : r.activeElement); r = a && (srGet ? srGet.call(a) : a.shadowRoot)) {
      a = srAct ? srAct.call(r) : r.activeElement;
    }
    const docGet = function(k) { const g = getter(D, k); return g ? g.call(document) : document[k]; };
    const blocked = function(why) {
      const at = a && a !== docGet('body') && a !== docGet('documentElement') ? a : null;
      return { why: why, focusAt: at ? { name: __personName(at), tag: at.tagName.toLowerCase() } : null };
    };
    const hasAttr = typeof Element !== 'undefined' ? Element.prototype.hasAttribute : null;
    // Up to the first inert ancestor, but not past an open modal dialog: a modal dialog is not made inert by an inert
    // ancestor (measured: its field takes focus inside an inert <main>; codex on #1036).
    for (let n = el, d = 0; n && d < CAP; d++, n = up(n)) {
      if (n.nodeType === 1 && (hasAttr ? hasAttr.call(n, 'inert') : n.hasAttribute('inert'))) return blocked('inert');
      let openModal = false;
      try { openModal = n.nodeType === 1 && n.tagName === 'DIALOG' && __matches(n, ':modal'); } catch (e) { }
      if (openModal) break;
    }
    let top = null;
    for (let n = a, d = 0; n && d < CAP; d++, n = up(n)) {
      let modal = false;
      try { modal = n.nodeType === 1 && n.tagName === 'DIALOG' && __matches(n, ':modal'); } catch (e) { }
      if (modal) { top = n; break; }
    }
    if (top) return within(el, top) ? null : blocked('behind_modal');
    // Open modal dialogs: the document's, and those in open shadow roots (a component's dialog, focus elsewhere). A
    // closed shadow root's is not seen.
    let modals = [];
    try {
      const qsa = function(root, sel) { return Array.prototype.slice.call(D && root === document ? D.prototype.querySelectorAll.call(document, sel) : root.querySelectorAll(sel)); };
      const roots = [document];
      for (let i = 0; i < roots.length && i < 2000; i++) {
        modals = modals.concat(qsa(roots[i], 'dialog:modal'));
        qsa(roots[i], '*').forEach(function(n) { const r = srGet ? srGet.call(n) : n.shadowRoot; if (r) roots.push(r); });
      }
    } catch (e) { }
    if (modals.length === 1) return within(el, modals[0]) ? null : blocked('behind_modal');
    // Several open and the focus in none of them: outside all of them is behind one.
    if (modals.length > 1 && !modals.some(function(m) { return within(el, m); })) return blocked('behind_modal');
    return null;
  }
`;
