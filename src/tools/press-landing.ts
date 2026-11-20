/**
 * internal #421 — press a page element the way a person would, and refuse only when a person would have to deal with
 * something first.
 *
 * The caller names an element it found (in the accessibility tree, by a selector). Decorations on that element are
 * this module's business, not the caller's: the press goes to a point that reaches it. Only when something a person
 * would have to answer or wait out stands in front — a dialog, an open calendar or popover, a cookie wall, a loading
 * overlay — is the press refused, and the refusal says what is in front and what it offers.
 *
 * The modal preflight that came before decided press-or-refuse by attributing the cover to one dialog and comparing
 * it with `detectModal`'s blocker. Spikes on real libraries (mac, headless Chrome 157, internal #421) found that pair
 * wrong for 8–12 of 17 presses that missed their element, while the facts below decided every case:
 *
 * - a point on the element itself, or inside it, reaches it — the centre first, then any visible part of its box;
 * - a point on the element's own `<label>` (`label.control === el`) reaches it: the browser forwards it (sr-only and
 *   Bootstrap btn-check inputs, whose own box is clipped);
 * - a point on ANOTHER control's label never does (btn-check groups stack their hidden inputs: the centre of "Right"
 *   is under the "Left" label);
 * - a skin — an empty layer drawn right over the control, in its parent or grandparent, which a script forwards
 *   (iCheck's `ins.iCheck-helper`) — reaches it. Tried last, and confirmed by the browser before the press: its
 *   accessibility node has no name and no role of its own. Every cover a person deals with has a name and a role
 *   (dialog, banner, a calendar day) or is another's label. Whether it listens for clicks is not asked (React and
 *   delegated jQuery handlers sit on the root); a skin that does not forward reads as unverifiable after the press;
 * - a widget drawn in place of a hidden element (Select2 hides the native <select>) is pressed as a person would;
 * - under a modal dialog that does not hold the element, only centres are tried, and no skin or replacement.
 *
 * A press that mislands anyway (the layout moved between the read and the press) is stopped in the page, as
 * Playwright does: trusted pointer, mouse and click events at window capture whose hit the rule does not allow are
 * cancelled. Measured: a plain press closed SweetAlert2 and a Bootstrap modal and picked a flatpickr date; with the
 * guard, none of them changed.
 */

import { ELEMENT_NAME_JS } from "./_element-name-js.js";

/** The landing rule, as page script: `__dtmLandsOn(el, hit)`, `__dtmDescribe(n)`, `__dtmName(n)`. */
export function pressLandingRuleJs(): string {
  return `
${ELEMENT_NAME_JS}
  var __DTM_INTERACTIVE = 'a[href],button,input,select,textarea,summary,[contenteditable=""],[contenteditable=true],[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=combobox],[role=textbox],[tabindex]:not([tabindex="-1"])';
  var __DTM_DIALOG = 'dialog,[role=dialog],[role=alertdialog],[aria-modal=true]';
  function __dtmArea(n) { var r = n.getBoundingClientRect(); return r.width * r.height; }
  // A dialog counts only while it is drawn: an open <dialog>, or any other with a box and not hidden by CSS
  // (/code-review on #1004: a hidden Bootstrap .modal named a loading spinner a dialog).
  function __dtmHiddenFromPeople(n) {
    if (n.getAttribute('aria-hidden') === 'true') return true;
    var r = n.getBoundingClientRect(); if (r.width <= 2 && r.height <= 2) return true;
    return getComputedStyle(n).opacity === '0';
  }
  function __dtmRoles(n) {
    var r = n.getAttribute('role'); if (r) return [r];
    var t = n.tagName, ty = (n.getAttribute('type') || '').toLowerCase();
    if (t === 'SELECT') return ['combobox', 'listbox'];
    if (t === 'INPUT' && ty === 'checkbox') return ['checkbox', 'switch'];
    if (t === 'INPUT' && ty === 'radio') return ['radio'];
    if (t === 'TEXTAREA' || (t === 'INPUT' && ['', 'text', 'search', 'email', 'url', 'tel', 'number'].indexOf(ty) >= 0)) return ['textbox', 'searchbox', 'combobox'];
    return [];
  }
  // The controls of the element's kind drawn beside it in its parent (outside the element), which stand for it while
  // it is hidden from people. The press goes to such a control's own point: Select2 opens on its combobox, and a
  // press on the widget's outer wrapper does nothing (win2 on #1004, db867002).
  function __dtmSameKindControls(el) {
    var want = __dtmRoles(el), parent = el.parentElement, out = [];
    if (want.length === 0 || !parent || !__dtmHiddenFromPeople(el)) return out;
    var nodes = parent.querySelectorAll('[role]');
    for (var i = 0; i < nodes.length && out.length < 4; i++) {
      if (nodes[i] === el || el.contains(nodes[i]) || nodes[i].contains(el)) continue;
      if (want.indexOf(nodes[i].getAttribute('role')) >= 0) out.push(nodes[i]);
    }
    return out;
  }
  function __dtmShown(d) {
    if (!d || !d.getBoundingClientRect) return false;
    if (d.tagName === 'DIALOG' && !d.open) return false;
    var r = d.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return false;
    var cs = getComputedStyle(d); return cs.display !== 'none' && cs.visibility !== 'hidden';
  }
  function __dtmModal(d) {
    if (!d || !d.matches) return false;
    if (d.getAttribute('aria-modal') === 'true') return true;
    try { return d.tagName === 'DIALOG' && d.matches(':modal'); } catch (e) { return false; }
  }
  // A modal dialog that is shown and does not hold the element: a person answers it first.
  // A shown modal that does not hold the element and is in front of it: when the element is itself inside a shown
  // modal (a second modal opened over the first), a modal counts only if what is at the element's centre is in it
  // (/code-review on #1004: modal A under a modal B holding the element is not in front of it).
  function __dtmModalAgainst(el) {
    var all = document.querySelectorAll(__DTM_DIALOG), mine = false, i;
    for (i = 0; i < all.length; i++) if (__dtmModal(all[i]) && __dtmShown(all[i]) && all[i].contains(el)) mine = true;
    var r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    for (i = 0; i < all.length; i++) {
      if (!__dtmModal(all[i]) || !__dtmShown(all[i]) || all[i].contains(el)) continue;
      if (!mine || (hit && all[i].contains(hit))) return all[i];
    }
    return null;
  }
  function __dtmShownDialogIn(root) {
    if (!root || !root.querySelectorAll) return null;
    var all = root.querySelectorAll(__DTM_DIALOG);
    for (var i = 0; i < all.length; i++) if (__dtmShown(all[i])) return all[i];
    return null;
  }
  // Names come from the one naming every CDP script shares (ELEMENT_NAME_JS): an entry's value is never a name, and
  // what the page masks is never read out — a password field over the element, or in what is in front of it, is
  // named by its label, never by what was typed into it (codex on #1004, P1).
  function __dtmName(n) {
    if (!n || !n.getAttribute) return '';
    var v = '';
    if (__isEntry(n) || __isMasked(n)) v = __fieldName(n);
    else {
      v = (n.getAttribute('aria-label') || '').trim();
      if (!v) {
        var lb = n.getAttribute('aria-labelledby');
        if (lb) v = lb.trim().split(/\\s+/).map(function(id) { var t = document.getElementById(id); return t ? __textWithoutFields(t) : ''; }).join(' ').trim();
      }
      if (!v) v = (n.getAttribute('title') || n.getAttribute('alt') || '').trim();
      if (!v) v = __textWithoutFields(n);
    }
    return String(v || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
  }
  function __dtmLandsOn(el, hit) {
    if (!hit) return { ok: false, how: 'nothing' };
    if (hit === el) return { ok: true, how: 'self' };
    if (el.contains(hit)) return { ok: true, how: 'inside' };
    // An element inside a button or a link is pressed as that button or link, as Playwright retargets its target
    // ('button-link'): an icon with pointer-events: none inside a close button is pressed through the button, which
    // is where a person's press goes (/code-review on #1005: the old browser_click road clicked it so).
    // Only an element that is not itself a control (Playwright keeps a button, a link or a field as it is), and only
    // a hit with no other control or label between it and the host: a press on another button in the same card is
    // not a press on this one (/code-review on #1005, round 2).
    var host = !el.matches(__DTM_INTERACTIVE) && el.parentElement && el.parentElement.closest ? el.parentElement.closest('a[href],button,[role=button],[role=link]') : null;
    if (host && (hit === host || host.contains(hit))) {
      // A node that holds the element (a focusable wrapper inside the link) is the element's own way to the host, not
      // a control beside it (round 3).
      for (var hn = hit; hn && hn !== host; hn = hn.parentElement) if (!hn.contains(el) && (hn.matches(__DTM_INTERACTIVE) || hn.tagName === 'LABEL')) return { ok: false, how: 'covered' };
      return { ok: true, how: 'host' };
    }
    var lab = hit.closest ? hit.closest('label') : null;
    if (lab) {
      if (lab.control === el) {
        // Interactive content inside the label (a "Terms" link in "I agree to the Terms") does not activate the
        // control; a press there follows the link (/code-review on #1004).
        for (var m = hit; m && m !== lab; m = m.parentElement) if (m !== el && m.matches(__DTM_INTERACTIVE)) return { ok: false, how: 'covered' };
        return { ok: true, how: 'own_label' };
      }
      if (lab.control) return { ok: false, how: 'other_label' };
    }
    // A hit that holds the element (its wrapper, with the element taking no pointer input) is not a skin of it.
    if (hit.contains(el)) return { ok: false, how: 'container' };
    // A replacement: the element is hidden from people (aria-hidden, a 1-2px box, or fully transparent) and the hit
    // is a control in the element's own parent — Select2 hides the native <select> (aria-hidden, clipped) and draws
    // its combobox beside it. A person presses the widget they see; so does this (win2 on #1004, R12: discover
    // lists the hidden select, and main pressed the widget).
    // It has to be a control of the same kind as the element — a combobox or listbox for a <select>, a checkbox or
    // switch for a checkbox, a radio for a radio — and the hit has to be in that control itself. A control that
    // merely shares a parent with a hidden input (a submit button, a link) is not its replacement (codex on #1004),
    // and nor is the widget's outer wrapper, which Select2 does not open on (win2). Not an id: Select2 gives an
    // id-less select a random token the select does not carry.
    var kin = __dtmSameKindControls(el);
    for (var z = 0; z < kin.length; z++) if (kin[z] === hit || kin[z].contains(hit)) return { ok: true, how: 'replacement' };
    // A skin candidate: a layer drawn right over the element — its box inside the element's box grown by 24px or
    // half the element's size, whichever is more — in the element's parent or grandparent, and nothing from the
    // hit up to that wrapper has text, a name, an interactive role, or is a dialog or a label. The browser confirms
    // it before the press (inspectHitAtPoint). The box test is what keeps a backdrop out: win2 measured a modal
    // backdrop pressed as a skin when the app root held both it and the target (#1004, R1).
    var er = el.getBoundingClientRect(), hr = hit.getBoundingClientRect();
    var grow = Math.max(24, Math.max(er.width, er.height) / 2);
    var over = hr.left >= er.left - grow && hr.top >= er.top - grow && hr.right <= er.right + grow && hr.bottom <= er.bottom + grow;
    var wrap = el.parentElement, up = 0;
    while (wrap && up < 1 && !wrap.contains(hit)) { wrap = wrap.parentElement; up++; }
    if (over && wrap && wrap.contains(hit)) {
      for (var n = hit; n && n !== wrap; n = n.parentElement) {
        if (__dtmName(n) !== '' || n.matches(__DTM_INTERACTIVE) || n.matches(__DTM_DIALOG) || n.tagName === 'LABEL') return { ok: false, how: 'covered' };
      }
      return { ok: true, how: 'skin' };
    }
    return { ok: false, how: 'covered' };
  }
  function __dtmDescribe(n) {
    if (!n || !n.tagName) return String(n);
    var s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    var c = (typeof n.className === 'string' ? n.className : '').trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    if (c.length) s += '.' + c.join('.');
    var role = n.getAttribute('role'); if (role) s += '[role=' + role + ']';
    var name = __dtmName(n); if (name) s += ' "' + name + '"';
    return s;
  }`;
}

export type PressPoint =
  | { x: number; y: number; via: "element" | "label"; how: "self" | "inside" | "host" | "own_label" | "skin" | "replacement" }
  | { error: string; outside?: boolean };

/**
 * Where to press `selector`, as page script. Tries, at the scroll position as it is and then centred, at the top and
 * at the bottom (a sticky header or footer over the element, as Playwright alternates): the element's centre and a
 * grid of points over its box, then each of its own labels. A point on the element or its label wins; a skin only
 * when nothing else does (the caller confirms it with the browser). No allowed point answers `{ none: true }` — the
 * caller then reads the cover with {@link buildCoverJs}.
 */
export function buildPressPointJs(selector: string): string {
  return `(function() {
  ${pressLandingRuleJs()}
  var sel = ${JSON.stringify(selector)};
  var el = document.querySelector(sel);
  if (!el) return { error: "Element not found: " + sel };
  var r0 = el.getBoundingClientRect();
  if (r0.width === 0 && r0.height === 0) return { error: "Element has zero size (hidden or not rendered): " + sel };
  function inView(x, y) { return x >= 0 && y >= 0 && x < innerWidth && y < innerHeight; }
  function points(n) {
    var r = n.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return [];
    var out = [{ x: r.left + r.width / 2, y: r.top + r.height / 2 }];
    var f = [0.2, 0.5, 0.8];
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) if (i !== 1 || j !== 1) out.push({ x: r.left + r.width * f[i], y: r.top + r.height * f[j] });
    return out;
  }
  // With a modal dialog shown that does not hold the element, only the element's centre and its own label are
  // tried: a strip of it left uncovered beside the dialog is not a way past it (win2 on #1004, R4).
  var modalAgainst = __dtmModalAgainst(el);
  function tryHere() {
    var targets = [{ n: el, via: 'element' }];
    var labs = el.labels ? Array.prototype.slice.call(el.labels) : [];
    for (var i = 0; i < labs.length; i++) targets.push({ n: labs[i], via: 'label' });
    var kin = __dtmSameKindControls(el);
    for (var z = 0; z < kin.length; z++) targets.push({ n: kin[z], via: 'element', kin: true });
    var skin = null;
    for (var t = 0; t < targets.length; t++) {
      var ps = points(targets[t].n);
      // Under a modal that does not hold the element: centres only, the element's and its labels', and no skin or
      // replacement — a layer over a control in the app the modal has made inert is not a way past it either
      // (/code-review on #1004).
      if (modalAgainst) ps = ps.slice(0, 1);
      for (var k = 0; k < ps.length; k++) {
        if (!inView(ps[k].x, ps[k].y)) continue;
        var v = __dtmLandsOn(el, document.elementFromPoint(ps[k].x, ps[k].y));
        if (!v.ok) continue;
        if (modalAgainst && (v.how === 'skin' || v.how === 'replacement')) continue;
        if (v.how !== 'skin' && v.how !== 'replacement') return { x: ps[k].x, y: ps[k].y, via: targets[t].via, how: v.how };
        // A replacement is pressed at the replacing control's own point when there is one, not at the hidden
        // element's corner that happens to fall on its edge (win2 on #1004, 3ea1c742).
        if (!skin || (v.how === 'replacement' && targets[t].kin && !skin.kin)) skin = { x: ps[k].x, y: ps[k].y, via: targets[t].via, how: v.how, kin: !!targets[t].kin };
      }
    }
    return skin ? { x: skin.x, y: skin.y, via: skin.via, how: skin.how } : null;
  }
  // A point on the element or its label at any scroll wins. A skin is kept as the fallback with the scroll it was
  // found at, and measured again there before it is returned: a point is only true at the scroll it was read at
  // (/code-review on #1004).
  var sx = scrollX, sy = scrollY;
  var c = el.getBoundingClientRect();
  var found = inView(c.left + c.width / 2, c.top + c.height / 2) ? tryHere() : null;
  var skinAt = found && (found.how === 'skin' || found.how === 'replacement') ? 'asIs' : null;
  if (found && !skinAt) return found;
  var anchors = ['center', 'start', 'end'];
  for (var a = 0; a < anchors.length; a++) {
    el.scrollIntoView({ block: anchors[a], inline: 'center', behavior: 'instant' });
    var here = tryHere();
    if (here && here.how !== 'skin' && here.how !== 'replacement') return here;
    if (here && !skinAt) skinAt = anchors[a];
  }
  if (skinAt) {
    if (skinAt === 'asIs') scrollTo(sx, sy); else el.scrollIntoView({ block: skinAt, inline: 'center', behavior: 'instant' });
    var again = tryHere();
    if (again) return again;
  }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  c = el.getBoundingClientRect();
  if (!inView(c.left + c.width / 2, c.top + c.height / 2)) return { error: "Element is outside the viewport and could not be scrolled into it: " + sel + ". Nothing was clicked.", outside: true };
  return { none: true };
})()`;
}

export interface PageCover {
  /** The element at the element's centre, described (tag, id, class, role, name). */
  cover: string;
  /** The dialog the cover belongs to (it is in it, holds it, or is its full-size backdrop), when there is one. */
  dialog: { name: string; role: string; modal: boolean } | null;
  /** Named controls a person could use in what is in front (the dialog, or the cover's own block), up to six. */
  offers: string[];
  /** An empty overlay over most of the page (no text, nothing to press): often loading, worth a short wait. */
  emptyOverlay: boolean;
  /** The hit holds the element: the element itself does not take a press at its point. */
  container?: boolean;
}

/** What is in front of `selector`'s centre, as page script (the element scrolled to the centre first). */
export function buildCoverJs(selector: string): string {
  return `(function() {
  ${pressLandingRuleJs()}
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  // The point search may have left the page at another anchor; the cover is read at the centred scroll.
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  var r = el.getBoundingClientRect();
  var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit) return null;
  // The hit holds the element: the element does not take the press at its own point (pointer-events: none, or a
  // container's ::before/::after drawn over it). Nothing is in front of it to name (/code-review on #1004).
  if (hit.contains(el)) return { cover: __dtmDescribe(hit), dialog: null, offers: [], emptyOverlay: false, container: true };
  // A dialog that holds the element is not in front of it: a part of the element's own dialog covers it.
  function notMine(d) { return d && !d.contains(el) ? d : null; }
  // What is in front: the dialog the cover is in, holds, or is the backdrop of; otherwise the topmost ancestor of
  // the cover that does not hold the element (Playwright's "from <root> subtree").
  var d = notMine(hit.closest(__DTM_DIALOG));
  if (d && !__dtmShown(d)) d = null;
  if (!d) d = notMine(__dtmShownDialogIn(hit));
  if (!d) {
    var cs = getComputedStyle(hit);
    if ((cs.position === 'fixed' || cs.position === 'absolute') && __dtmArea(hit) >= innerWidth * innerHeight * 0.8) {
      var all = document.querySelectorAll(__DTM_DIALOG);
      for (var i = 0; i < all.length && !d; i++) {
        if (!__dtmShown(all[i]) || all[i].contains(el)) continue;
        for (var a = all[i]; a && !d; a = a.parentElement) if (a.parentElement === hit.parentElement && a !== hit) d = all[i];
      }
    }
  }
  var root = d;
  if (!root) { root = hit; while (root.parentElement && root.parentElement !== document.body && !root.parentElement.contains(el)) root = root.parentElement; }
  var offers = [];
  var cands = root.querySelectorAll(__DTM_INTERACTIVE);
  for (var j = 0; j < cands.length && offers.length < 6; j++) {
    var cr = cands[j].getBoundingClientRect(); if (cr.width === 0 || cr.height === 0) continue;
    var nm = __dtmName(cands[j]); if (nm && offers.indexOf(nm) < 0) offers.push(nm);
  }
  var empty = !d && offers.length === 0 && (root.textContent || '').trim() === '' && __dtmArea(root) >= innerWidth * innerHeight * 0.8;
  return { cover: __dtmDescribe(hit), dialog: d ? { name: __dtmName(d), role: d.getAttribute('role') || d.tagName.toLowerCase(), modal: __dtmModal(d) } : null, offers: offers, emptyOverlay: empty };
})()`;
}

/**
 * Stop a press that mislands, as page script (Playwright's hit-target interceptor). Installed after the pointer has
 * moved and before the press; every trusted pointer, mouse or click event whose hit the rule does not allow is
 * cancelled at window capture and counted. Read and removed by {@link buildReadPressGuardJs}.
 */
export function buildPressGuardJs(selector: string): string {
  return `(function() {
  ${pressLandingRuleJs()}
  // An earlier guard goes first, also when this one cannot be installed: it is read after the press whatever the
  // install answered, and must not report another press's events (/code-review on #1005, round 2).
  if (window.__dtmPressGuard) { try { window.__dtmPressGuard.remove(); } catch (e) {} delete window.__dtmPressGuard; }
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false };
  var types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu'];
  // Decided once, on the first event of the press, as Playwright's interceptor does: a press that started on the
  // element is let through whole (a mousedown handler may open a menu over it, and stopping the rest would leave a
  // half-done press reported as none); one that started elsewhere is stopped whole (/code-review on #1004).
  var g = { blocked: 0, first: null, decided: null };
  function onEvent(e) {
    if (!e.isTrusted) return;
    if (g.decided === null) {
      var hit = document.elementFromPoint(e.clientX, e.clientY);
      g.decided = __dtmLandsOn(el, hit).ok ? 'pass' : 'stop';
      if (g.decided === 'stop') g.first = __dtmDescribe(hit);
    }
    if (g.decided === 'pass') return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    g.blocked++;
  }
  for (var i = 0; i < types.length; i++) window.addEventListener(types[i], onEvent, true);
  g.remove = function() { clearTimeout(g.timer); for (var i = 0; i < types.length; i++) window.removeEventListener(types[i], onEvent, true); };
  // It removes itself if it is never read (the read failed, or the install's answer was lost), so it cannot sit in
  // the page and cancel the user's own clicks (/code-review on #1004).
  g.timer = setTimeout(function() { g.remove(); if (window.__dtmPressGuard === g) delete window.__dtmPressGuard; }, 5000);
  window.__dtmPressGuard = g;
  return { ok: true };
})()`;
}

/** Read and remove the press guard: how many events it stopped, and what the first one hit. */
export function buildReadPressGuardJs(): string {
  return `(function() {
  var g = window.__dtmPressGuard;
  if (!g) return { ok: false };
  try { g.remove(); } catch (e) {}
  delete window.__dtmPressGuard;
  return { ok: true, blocked: g.blocked, first: g.first };
})()`;
}

/** The sentence a refusal carries: what is in front of the element, and what to do about it. */
export function coverSentence(selector: string, c: PageCover, tool: "desktop_act" | "browser_click" = "desktop_act", label?: string): string {
  // How the element is named in the sentence: its selector, quoted, unless the caller found it another way (a
  // by-axis click names it by what it searched for, not by the mark it put on it).
  const who = label ?? `"${selector}"`;
  // desktop_act re-reads the window with desktop_discover; browser_click is called again with its selector.
  const again = tool === "desktop_act" ? "re-call desktop_discover" : "retry browser_click";
  if (c.container) {
    return `${who} does not take a press at its own point: it goes to ${c.cover}, which holds it (the element ` +
      `has pointer-events: none, or something its container draws lies over it); nothing was clicked. Act on what the page offers instead, or ${again}.`;
  }
  const offers = c.offers.length > 0 ? ` It offers: ${c.offers.map((o) => JSON.stringify(o)).join(", ")}.` : "";
  if (c.dialog?.modal) {
    const name = c.dialog.name === "" ? "with no name" : JSON.stringify(c.dialog.name);
    return `${who} is behind a dialog in the page (${name}, role ${c.dialog.role}); nothing was clicked.${offers} ` +
      `Answer the dialog (one of its own controls, or Escape), then ${again}.`;
  }
  if (c.emptyOverlay) {
    return `${who} is under an empty overlay that covers the page (${c.cover}), which stayed through a short wait — often a page still loading; nothing was clicked. Wait for it to go, then try again.`;
  }
  return `${who} is covered in the page by ${c.cover}; nothing was clicked.${offers} Deal with what covers it (close it, or use one of its controls), or scroll so the element is clear, then ${again}.`;
}

/**
 * Where the element's scroll containers and the page are scrolled, kept in the page so a refusal can put them back:
 * the landing read scrolls (a sticky header, the cover read's centring), and a refused press must not leave the page
 * moved (/code-review on #1005: browser_click's rule, a denied action never scrolls).
 */
export function buildSaveScrollJs(selector: string): string {
  return `(function() {
  var el = document.querySelector(${JSON.stringify(selector)});
  var out = [];
  for (var n = el ? el.parentElement : null; n; n = n.parentElement) {
    if (n.scrollTop !== 0 || n.scrollLeft !== 0 || n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth) out.push([n, n.scrollLeft, n.scrollTop]);
  }
  out.push([null, scrollX, scrollY]);
  window.__dtmScrollSave = out;
  return true;
})()`;
}

/** Put back what {@link buildSaveScrollJs} kept (`restore` false only forgets it), innermost first, the page last. */
export function buildRestoreScrollJs(restore: boolean): string {
  return `(function() {
  var s = window.__dtmScrollSave; delete window.__dtmScrollSave;
  if (!s || !${restore}) return false;
  for (var i = 0; i < s.length; i++) {
    if (s[i][0] === null) scrollTo({ left: s[i][1], top: s[i][2], behavior: 'instant' });
    else s[i][0].scrollTo({ left: s[i][1], top: s[i][2], behavior: 'instant' });
  }
  return true;
})()`;
}
