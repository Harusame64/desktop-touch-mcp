/**
 * _unique-selector-js.ts — the selector a CDP script hands back for an element: one that matches that element alone.
 *
 * A returned selector is passed on to browser_click or browser_fill, which press the first element it matches. A
 * selector that matches two elements presses the wrong one without a word: Select2's `span:nth-child(1) >
 * span:nth-child(1)`, a radio group's shared `input[name=size]`, an id the page repeats (win2 on #1011). browser_search
 * and browser_overview had a copy each, and only the first asked the document (internal #420). This is the one
 * definition, spliced into both scripts.
 *
 * An id, a name, an aria-label, a caller's own candidates (browser_overview's link paths), then data-testid or
 * data-asin: each is used only when the document has no other element it matches. Otherwise the selector is a path of
 * `:nth-child` steps, two at least, longer until it matches this element alone or reaches an ancestor with an id the
 * page does not repeat. The document is asked for paths of two to eight steps while the caller's time budget lasts
 * (/code-review on #1011: a query per level and element). Past that, the path climbs on to <body> without asking: a
 * path of positions from <body> is unique by construction (win2 on #1011: blocks built alike matched twice at eight).
 *
 * `overdue` is the caller's clock: a function that answers true once its time budget is spent. The helpers are
 * prefixed `__` because they share an IIFE with each script's own functions.
 */
export const UNIQUE_SELECTOR_JS = `
  function __alone(sel) { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } }
  function __uniqueSelector(el, overdue, extra) {
    if (overdue()) return __pathTo(el, false, overdue);
    const tg = el.tagName.toLowerCase();
    const tries = [];
    if (el.id) tries.push('#' + CSS.escape(el.id));
    const name = el.getAttribute('name');
    if (name) tries.push(tg + '[name=' + JSON.stringify(name) + ']');
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 80) tries.push(tg + '[aria-label=' + JSON.stringify(aria) + ']');
    if (extra) for (const s of extra(el)) tries.push(s);
    for (const attr of ['data-testid', 'data-asin']) {
      const v = el.getAttribute(attr);
      if (v && v.length < 60) tries.push(tg + '[' + attr + '=' + JSON.stringify(v) + ']');
    }
    for (const s of tries) if (__alone(s)) return s;
    return __pathTo(el, true, overdue);
  }
  function __pathTo(el, ask, overdue) {
    let node = el; let path = '';
    for (let depth = 0; node.parentElement; depth++) {
      const p = node.parentElement;
      const idx = Array.from(p.children).indexOf(node) + 1;
      const seg = node.tagName.toLowerCase() + ':nth-child(' + idx + ')';
      path = path ? seg + ' > ' + path : seg;
      if (p.id && __alone('#' + CSS.escape(p.id))) { path = '#' + CSS.escape(p.id) + ' > ' + path; break; }
      node = p;
      if (ask && depth >= 1 && __alone(path)) break;
      if (depth >= 7 || overdue()) ask = false;
    }
    return path || el.tagName.toLowerCase();
  }
`;
