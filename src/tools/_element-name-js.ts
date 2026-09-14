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
export const ELEMENT_NAME_JS = `
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
    if (node.nodeType === 1 && (__isEntry(node) || __isMasked(node))) return '';
    let out = '';
    (function walk(n) {
      for (const c of n.childNodes) {
        if (out.length > 400) return;
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1 && !__isEntry(c) && !__isMasked(c)) walk(c);
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
  function __elText(el) {
    // A <select>'s text is its options, which the page wrote; it keeps the name it had.
    if (el.tagName === 'SELECT' && !__isMasked(el)) return (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    if (__isEntry(el) || __isMasked(el)) return __fieldName(el);
    return __textWithoutFields(el).slice(0, 80);
  }
`;
