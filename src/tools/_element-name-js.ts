/**
 * _element-name-js.ts — how every CDP script names an element, and which values it never reads.
 *
 * Three scripts named elements with copies of one function, and for an <input> with no placeholder
 * all three used its VALUE as its name. On an ordinary login form a password field came back as its
 * password: the entity's label in `desktop_discover`, the item's text in `browser_overview`, a
 * candidate's name in `browser_click` (MEASURED 2026-09-11 win2, internal `dev/cdp-password/RESULTS.md`
 * and `RESULTS-retake-before.md`, on `befc1e8b` — an aria-label and a `<label for>` did not help, and
 * a typed value came back the same way). This is the one definition, spliced into every CDP script
 * that names an element, so no copy drifts from it.
 *
 * Two rules:
 *
 * 1. **An entry is never a name.** An entry is what the user types into: a form field (<input>,
 *    <textarea>, <select>) or the host of an editable region (contenteditable, an ARIA textbox or
 *    searchbox). Its value, or its own text — a <textarea>'s text node is its initial value — is not
 *    taken for its name, whatever its type. A field is named the way HTML-AAM names a
 *    text input (§4.1.1, read 2026-09-11 at https://w3c.github.io/html-aam/): aria-labelledby, then
 *    aria-label; then its label elements' text; then title; then placeholder; then aria-placeholder.
 *    A button-type input takes its labels, then its value — the caption drawn on it, page text rather
 *    than an entry — then title (§4.1.2); an image input takes its labels, then alt, then title
 *    (§4.1.3). The localised default captions ("Submit", "Reset", "Submit Query") are not supplied:
 *    a script in the page cannot know the language the screen shows them in. Any text taken for a
 *    name — a label's, a referenced element's, an element's own — leaves out every entry inside it,
 *    which is stricter than the spec (it leaves out only the labelled control's own value), and a
 *    reference that points at an entry itself gives nothing. Text inside a label that aria-hidden or
 *    display:none hides is still read: a difference from the spec, not a leak of an entry.
 * 2. **What the page masks is never read out of the page** — a password input, or any element under
 *    `-webkit-text-security`: an input, a <textarea>, a contenteditable PIN pad, a span. Its value is
 *    withheld, its text is not taken for a name, and the text axes do not match it. The rule is about
 *    what the page draws, or would draw, as dots: a hidden input, a checkbox or another input that
 *    draws no text is not masked, and a tool that returns values returns theirs when asked to (PR 側
 *    codex and win's outside read on #623 — the first version checked inputs only). A field inside a
 *    display:none subtree that inherits the style is withheld: its computed style still carries it,
 *    and what it holds is what the page would draw as dots once the section is shown. That fails
 *    closed on purpose — PR 側 codex on 5b60380 asked for the opposite, and this sentence used to
 *    promise the opposite without the code doing it.
 *
 * An editable region is its host — the element whose parent is not editable. The elements inside an
 * editor are not entries: they are named by the text the screen shows, and that includes typed text,
 * since a rich editor puts what is typed into child paragraphs. What the page masks stays out, and
 * so does any entry nested inside — a field, an ARIA textbox, another host in a non-editable island
 * (win's outside reads on #623 — the rule is written for the host, and says so). An element with the
 * ARIA role textbox or searchbox is an entry wherever it sits; the host rule is contenteditable's.
 *
 * The helpers are prefixed `__` because they share an IIFE with each script's own functions.
 */
/**
 * Text the page never draws: a script's or a style's source, a noscript's content while scripts run, a template's,
 * what <head> holds (the title), noembed and noframes. browser_search's text axes leave it out (#1015), and an
 * element's text never carries it (internal #420: a container matched by its own words reported a script's source).
 * Each element is judged by its own reason for drawing nothing, not by its tag or its layout box (/code-review on
 * #1015, four rounds: a box goes missing for a hidden ancestor and for display:contents too):
 * - an SVG element (script, style, or a noscript parsed into an <svg>) is never drawn: the SVG renderer has no place
 *   for it, and its display computes inline;
 * - a noscript, by whether scripts run in this document, read at most once per script and only when a noscript is
 *   reached, from the scripting media feature, which writes nothing to the page (an innerHTML probe broke under
 *   Trusted Types). It follows CDP's setScriptExecutionDisabled and Chrome's JavaScript site setting (measured: mac,
 *   and win2 on #1015, where a Report-Only Trusted Types policy received no report from a search). A browser that
 *   knows the feature matches exactly one of its three values; a Chromium before 120 matches none of them (codex on
 *   #1015: 104-119 keep an unknown feature's text rather than reading "not all"). There browser_search's text axes
 *   parse a fragment, on the same flag; a name read takes it that scripts run and writes nothing (/code-review on
 *   #1016);
 * - the rest, by a computed display of none: a style a page shows with CSS is drawn.
 */
/**
 * closest, matches and contains, called from the prototype. A <form> exposes a control named so as form.closest (and a
 * custom element can define its own), and a call on it threw: the text walker on #1016, the press rule and the gather
 * on #1018/#1019. Looked up when called, and the element's own method where there is no Element (the unit tests'
 * fake DOM). Function declarations only, so a script may splice it more than once.
 */
export const SAFE_DOM_JS = `
  function __matches(c, sel) { return (typeof Element !== 'undefined' ? Element.prototype.matches : c.matches).call(c, sel); }
  function __closest(c, sel) { return (typeof Element !== 'undefined' ? Element.prototype.closest : c.closest).call(c, sel); }
  function __contains(a, b) { return (typeof Node !== 'undefined' ? Node.prototype.contains : a.contains).call(a, b); }
`;

export const DRAWS_NOTHING_JS = `
  // var, not const: spliced twice into one scope (ELEMENT_NAME_JS beside pressLandingRuleJs()), it stays valid.
  var __NOT_TEXT = 'head, script, style, noscript, template, noembed, noframes';
  var __scriptsRun = null;
${SAFE_DOM_JS}
  // probe: whether a browser without the scripting feature may parse a fragment to find out. Only browser_search's
  // text axes ask for it; a name read answers that scripts run, without writing to the page (/code-review on #1016).
  function __drawsNothing(a, probe) {
    if (a.namespaceURI === 'http://www.w3.org/2000/svg') return true;
    if (a.localName === 'noscript') {
      if (__scriptsRun !== null) return __scriptsRun;
      try {
        const none = matchMedia('(scripting: none)').matches;
        const on = matchMedia('(scripting: enabled)').matches || matchMedia('(scripting: initial-only)').matches;
        if (none || on) return (__scriptsRun = !none);
        if (!probe) return true;
        const d = document.createElement('div'); d.innerHTML = '<noscript><i></i></noscript>';
        return (__scriptsRun = !d.querySelector('i'));
      } catch (e) { return true; }
    }
    return getComputedStyle(a).display === 'none';
  }
  // An element whose text the page never draws: skipped by every walker that collects an element's words.
  function __skipsText(c) { return __matches(c, __NOT_TEXT) && __drawsNothing(c, false); }
`;

export const ELEMENT_NAME_JS = `
${DRAWS_NOTHING_JS}
  function __isMasked(el) {
    if (el.tagName === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      if (t === 'password') return true;
      // An input that draws no text has nothing for the style to hide; an inherited one had
      // withheld a hidden input's value and a checkbox's state (2ゲート目 on #623). A file input
      // draws the chosen file's name, so it stays under the style (win's outside read).
      if (/^(hidden|checkbox|radio|range|color|image)$/.test(t)) return false;
    }
    try {
      const s = window.getComputedStyle(el);
      const sec = s.webkitTextSecurity || s.getPropertyValue('-webkit-text-security');
      return !!sec && sec !== 'none';
    } catch (e) { return false; }
  }
  function __isEntry(el) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
    // The editing host, not everything inside it: isContentEditable is true for every descendant,
    // and a draft's headings and links are named by the text the screen shows (2ゲート目 on #623).
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    return role === 'textbox' || role === 'searchbox';
  }
  function __textWithoutFields(node) {
    if (node.nodeType === 1 && (__isEntry(node) || __isMasked(node) || __skipsText(node))) return '';
    let out = '';
    (function walk(n) {
      for (const c of n.childNodes) {
        if (out.length > 400) return;
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1 && !__isEntry(c) && !__isMasked(c) && !__skipsText(c)) walk(c);
      }
    })(node);
    return out.trim().replace(/\\s+/g, ' ');
  }
  function __fieldName(el) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.trim().split(/\\s+/).map(function(id) {
        const n = document.getElementById(id);
        return n ? __textWithoutFields(n) : '';
      }).filter(Boolean).join(' ');
      if (t) return t.slice(0, 80);
    }
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) return aria.slice(0, 80);
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map(function(l) { return __textWithoutFields(l); }).filter(Boolean).join(' ');
      if (t) return t.slice(0, 80);
    }
    const type = el.tagName === 'INPUT' ? (el.getAttribute('type') || '').toLowerCase() : '';
    const pressable = /^(button|submit|reset|image)$/.test(type);
    if (type === 'image') {
      const alt = (el.getAttribute('alt') || '').trim();
      if (alt) return alt.slice(0, 80);
    } else if (pressable && !__isMasked(el)) {
      // A caption the page draws as dots is withheld like any other masked text (PR 側 codex on #623).
      const caption = (el.value || '').trim();
      if (caption) return caption.slice(0, 80);
    }
    for (const attr of pressable ? ['title'] : ['title', 'placeholder', 'aria-placeholder']) {
      const v = (el.getAttribute(attr) || '').trim();
      if (v) return v.slice(0, 80);
    }
    return '';
  }
  // A control the page keeps out of the tab order and the accessibility tree (Select2's original select: tabindex -1,
  // aria-hidden): not one a person uses; the widget drawn for it stands in.
  function __keptFromPeople(el) { return el.getAttribute('aria-hidden') === 'true' && el.getAttribute('tabindex') === '-1'; }
  // The control a widget stands for: a select inside it (Choices), or the select the page keeps from people just before
  // the widget's box (Select2 puts its span after the select it hides). A search field inside the widget (Select2's
  // multiple) is not it, nor a hidden select a script fills for another field.
  function __standsFor(el) {
    const inner = el.querySelector('select'); if (inner) return inner;
    for (let a = el, d = 0; a && d < 4; a = a.parentElement, d++) {
      const prev = a.previousElementSibling;
      if (prev && prev.tagName === 'SELECT' && __keptFromPeople(prev)) return prev;
    }
    return null;
  }
  // The name a person reads for a control, to list it among others (internal #420): aria-labelledby, then aria-label,
  // then, for a widget (a combobox or listbox), the label of the select it stands for, then the words it draws. A
  // button "X" with aria-label "Close dialog" is "Close dialog"; Select2's box is its select's label. A field keeps its
  // field name, never its value.
  function __personName(el) {
    if (__isEntry(el) || __isMasked(el)) return __fieldName(el);
    const lb = (el.getAttribute('aria-labelledby') || '').trim();
    if (lb) {
      const t = lb.split(/\\s+/).map(function(id) {
        const n = document.getElementById(id);
        return n ? __textWithoutFields(n) : '';
      }).filter(Boolean).join(' ');
      if (t) return t.slice(0, 80);
    }
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) return aria.slice(0, 80);
    // The role as written: Chrome's tree does not read role="Combobox" as a combobox either (measured on #1017).
    if (/^(combobox|listbox)$/.test(el.getAttribute('role') || '')) {
      // The select's own name, by the same rule as any field's: aria-labelledby, aria-label, then its <label>
      // (/code-review on #1017: a select named by aria-label lent nothing).
      const inner = __standsFor(el);
      const t = inner ? __fieldName(inner) : '';
      if (t) return t;
    }
    return __elText(el);
  }
  function __elText(el) {
    // A <select>'s text is its options, which the page wrote; it keeps the name it had.
    if (el.tagName === 'SELECT' && !__isMasked(el)) return (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    if (__isEntry(el) || __isMasked(el)) return __fieldName(el);
    return __textWithoutFields(el).slice(0, 80);
  }
`;
