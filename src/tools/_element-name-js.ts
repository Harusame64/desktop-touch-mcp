/**
 * _element-name-js.ts — how every CDP script names an element, and which values it never reads.
 *
 * Three scripts named elements with copies of one function, and for an <input> with no placeholder
 * all three used its VALUE as its name. On an ordinary login form a password field came back as its
 * password: the entity's label in `desktop_discover`, the item's text in `browser_overview`, a
 * candidate's name in `browser_click` (MEASURED 2026-09-11 win2, internal `dev/cdp-password/RESULTS.md`
 * and `RESULTS-retake-before.md`, on `befc1e8b` — an aria-label and a `<label for>` did not help, and
 * a typed value came back the same way). This is the one definition, spliced into each script, so a
 * fourth copy cannot drift from it.
 *
 * Two rules:
 *
 * 1. **A field's value is never its name**, whatever its type. A text field's value is what the user
 *    typed, and a <textarea>'s text node is its initial value. A field is named the way HTML-AAM names
 *    a text input (§4.1.1, read 2026-09-11 at https://w3c.github.io/html-aam/): aria-labelledby, then
 *    aria-label; then its label elements' text, without the text of any field inside them; then
 *    title; then placeholder; then aria-placeholder. The exception is a button-type input, whose
 *    value is the caption drawn on it (§4.1.2) — page text, not an entry.
 * 2. **A masked field's value is never read out of the page** — a field the page draws as dots:
 *    type=password, or an input under `-webkit-text-security`. What the screen hides, no tool returns.
 *
 * The helpers are prefixed `__` because they share an IIFE with each script's own functions.
 */
export const ELEMENT_NAME_JS = `
  function __textWithoutFields(node) {
    let out = '';
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1 && !/^(INPUT|TEXTAREA|SELECT)$/.test(c.tagName)) walk(c);
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
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName === 'INPUT' && /^(button|submit|reset|image)$/.test(type)) {
      const caption = ((type === 'image' ? el.getAttribute('alt') : '') || el.value || '').trim();
      if (caption) return caption.slice(0, 80);
    } else if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map(function(l) { return __textWithoutFields(l); }).filter(Boolean).join(' ');
      if (t) return t.slice(0, 80);
    }
    for (const attr of ['title', 'placeholder', 'aria-placeholder']) {
      const v = (el.getAttribute(attr) || '').trim();
      if (v) return v.slice(0, 80);
    }
    return '';
  }
  function __isMasked(el) {
    if (el.tagName !== 'INPUT') return false;
    if ((el.type || '').toLowerCase() === 'password') return true;
    try {
      const s = window.getComputedStyle(el);
      const sec = s.webkitTextSecurity || s.getPropertyValue('-webkit-text-security');
      return !!sec && sec !== 'none';
    } catch (e) { return false; }
  }
  function __elText(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return __fieldName(el);
    return (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  }
`;
