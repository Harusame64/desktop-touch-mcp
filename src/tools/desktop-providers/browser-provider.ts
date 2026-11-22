/**
 * browser-provider.ts — CDP candidate provider for browser tabs.
 *
 * Queries interactive DOM elements via evaluateInTab and converts them to
 * UiEntityCandidates with locator.cdp set.
 *
 * Warnings:
 *   cdp_provider_failed — evaluateInTab threw (CDP unavailable, port mismatch, etc.)
 *   cdp_no_elements     — tab reachable but no interactive elements found
 */

import type { UiEntityCandidate } from "../../engine/vision-gpu/types.js";
import type { TargetSpec } from "../../engine/world-graph/session-registry.js";
import type { ProviderResult } from "../../engine/world-graph/candidate-ingress.js";
import { probeLane } from "../../engine/aim-probe.js";
import { ELEMENT_NAME_JS } from "../_element-name-js.js";
import { UNIQUE_SELECTOR_JS } from "../_unique-selector-js.js";
import { createHash, randomUUID } from "node:crypto";

/** The attribute markAxMatches marks with (cdp-bridge's AX_MARK_ATTR; cdp-bridge is loaded lazily here). */
const AX_MARK_ATTR = "data-dtm-ax";

interface BrowserElement {
  type: string;
  text: string;
  selector: string;
  inViewport: boolean;
  /** What tells it apart from controls that share its name (blockName), when one does. */
  ctx?: string;
  href?: string;
  value?: string;
}

// A checkbox, radio or switch reads as a button, as UIA's are (uiaRoleFromControlType): it is pressed, not typed
// into (internal #420: a native checkbox read "textbox"). A combobox a widget draws (Select2, Choices) is pressed to
// open, so it is a button too; a native select and a text field stay textboxes.
/** A submit, reset, image or button input: pressed, not typed into (win2 on #1009: "Send" read as a textbox). */
function isPressInput(type: string): boolean {
  return /^input\[(submit|reset|image|button)\]$/.test(type);
}

function cdpRoleFromType(type: string): string {
  if (type === "link")   return "link";
  if (isPressInput(type)) return "button";
  if (type === "button" || type.startsWith("toggle[")) return "button";
  if (type.startsWith("input[") || type === "select" || type === "textarea" || type === "textbox") return "textbox";
  if (type === "menuitem" || type === "option" || type === "tab") return "menuitem";
  if (type === "treeitem") return "listitem";
  return "unknown";
}

/** An element the page takes typed text into — named by its type when it has no name. */
function isField(type: string): boolean {
  return type.startsWith("input[") || type === "textarea" || type === "textbox";
}

function cdpActionability(type: string): Array<"click" | "invoke" | "type" | "read"> {
  if (isPressInput(type)) return ["invoke", "click"];
  if (type === "link" || type === "button" || type.startsWith("toggle[")) return ["invoke", "click"];
  if (type.startsWith("input[") || type === "textarea" || type === "select" || type === "textbox") return ["type", "click"];
  if (type === "menuitem" || type === "option" || type === "tab" || type === "treeitem") return ["invoke", "click"];
  return ["read"];
}

/**
 * The page-side list. With `axNonce`, the controls the accessibility tree showed ({@link markAxMatches} with
 * `by: "controls"`) join it in document order: a checkbox under a skin (iCheck), Select2's combobox, Choices' select,
 * a role=checkbox div (internal #420, PR-C2b).
 */
export function interactiveScript(axNonce: string | null): string {
  const axSel = axNonce === null ? "" : `, [${AX_MARK_ATTR}*=${JSON.stringify(axNonce + ":")}]`;
  return `
(function() {
  const CSS_Q = "a[href], button:not([disabled]), [role='button'], input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled]), [role='menuitem']:not([aria-disabled='true']), [role='tab']:not([aria-disabled='true']), [role='switch']:not([aria-disabled='true'])" + ${JSON.stringify(axSel)};
  const axNonce = ${JSON.stringify(axNonce)};
  // The role the tree gave a marked element, or null.
  function axRole(el) {
    if (axNonce === null) return null;
    const toks = (el.getAttribute('${AX_MARK_ATTR}') || '').split(' ');
    for (let i=0;i<toks.length;i++) { const v = toks[i].split(':'); if (v[0] === axNonce) return v[3] || null; }
    return null;
  }
  function isVisible(el) {
    const s = window.getComputedStyle(el);
    if (s.display==='none'||s.visibility==='hidden') return false;
    // A checkbox, radio or select the tree shows is seen when it has a box or a shown label, as the by-axis resolver
    // reads it (#1008): iCheck's opacity: 0 input under its skin, a 0x0 radio pressed through its label. desktop_act
    // presses it where a person would (the label, the skin, the widget in its place).
    if (axRole(el) !== null && ((el.tagName==='INPUT' && (el.type==='checkbox'||el.type==='radio')) || el.tagName==='SELECT')) {
      const b = el.getBoundingClientRect();
      if (b.width>0 && b.height>0) return true;
      const labs = el.labels || [];
      for (let i=0;i<labs.length;i++) {
        const ls = window.getComputedStyle(labs[i]), lr = labs[i].getBoundingClientRect();
        if (ls.display!=='none' && ls.visibility!=='hidden' && ls.opacity!=='0' && lr.width>0 && lr.height>0) return true;
      }
      return false;
    }
    if (s.opacity==='0') return false;
    const r = el.getBoundingClientRect();
    return r.width>0 && r.height>0;
  }
  // A selector that matches this element alone, the one definition browser_search and browser_overview share. This
  // copy had kept a selector whose one match was another element, and returned a path of eight levels it knew
  // matched more than one (internal #420, after #1012).
${UNIQUE_SELECTOR_JS}
  const selDeadline = performance.now() + 3000;
  function bestSel(el) { return __uniqueSelector(el, () => performance.now() > selDeadline); }
  // What tells controls that share a name apart, as a person reads it (the user's decision, internal #420): the
  // smallest block that holds this control and none of its namesakes (a table row, a product card, an example's box),
  // named by its heading; a row or an item by its words; any other block by the heading before it (Bootstrap's
  // examples), else the landmark it sits in, else its words. Read node by node: the control itself and its own labels left out, and nothing the page
  // does not show as text: an entry, a masked part, a script or style, an element hidden (hidden, display none,
  // visibility hidden) (/code-review on #1026: a secret in a display:none span was read into a label). Words of
  // separate elements are kept apart, and the result is cut at a word, not mid-word (win2 on #1026).
  const __shownEl = function(n) {
    if (n.hidden) return false;
    const cs = getComputedStyle(n);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  function wordsOf(node, skip) {
    const out = [];
    let len = 0;
    (function walk(n) {
      for (const c of n.childNodes) {
        if (len > 120) return;
        if (c.nodeType === 3) { const t = c.nodeValue.trim(); if (t) { out.push(t); len += t.length + 1; } continue; }
        if (c.nodeType !== 1 || c === skip) continue;
        if (c.tagName === 'LABEL' && skip && c.control === skip) continue;
        if (__isEntry(c) || __isMasked(c) || __skipsText(c) || !__shownEl(c)) continue;
        // A code sample is page text, but its source is not a name (win2 on #1026: Bootstrap's snippets).
        if (c.tagName === 'PRE' || c.tagName === 'CODE') continue;
        walk(c);
      }
    })(node);
    return out.join(' ').replace(/\\s+/g, ' ').trim();
  }
  function cutAtWord(t, max) {
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    return (sp > max / 2 ? cut.slice(0, sp) : cut) + '…';
  }
  function blockName(el, others) {
    let unit = el;
    for (let p = __parent(el); p && p !== document.body; p = __parent(p)) {
      if (others.some(function(o) { return __contains(p, o); })) break;
      unit = p;
    }
    if (unit === el) return '';
    const shownIn = function(sel) {
      const list = __qsa(unit, sel);
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        if (n === el || __contains(n, el) || __contains(el, n) || !__shownEl(n)) continue;
        const t = wordsOf(n, el);
        if (t) return t;
      }
      return '';
    };
    const before = function() {
      const hs = __qsa(document, 'h1,h2,h3,h4,h5,h6,[role=heading]');
      for (let i = hs.length - 1; i >= 0; i--) {
        if (hs[i].compareDocumentPosition(unit) & Node.DOCUMENT_POSITION_FOLLOWING) { const h = wordsOf(hs[i], el); if (h) return h; }
      }
      return '';
    };
    // Its heading; for a row or an item, its words; for any other block, the heading before it, then its words. Not a
    // neighbouring link: that read as another target (win2 on #1026: footer links named by the link beside them).
    // The landmark the block sits in, by its name or its kind: "navigation", "footer" (a nav's links beside each other
    // are not names for one another).
    const landmark = function() {
      const lm = __closest(unit, 'nav,header,footer,aside,main,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=main]');
      if (!lm) return '';
      const named = (lm.getAttribute('aria-label') || '').trim();
      if (named) return named;
      const role = (lm.getAttribute('role') || '').toLowerCase();
      const kinds = { nav: 'navigation', header: 'header', footer: 'footer', aside: 'sidebar', main: 'main',
        navigation: 'navigation', banner: 'header', contentinfo: 'footer', complementary: 'sidebar' };
      return kinds[role] || kinds[lm.tagName.toLowerCase()] || '';
    };
    const isRow = __matches(unit, 'tr,[role=row],li,[role=listitem],article,[role=article],[role=option]');
    const t = shownIn('h1,h2,h3,h4,h5,h6,[role=heading]') || (isRow ? wordsOf(unit, el) : '') || before() || landmark() || wordsOf(unit, el);
    return cutAtWord(t, 48);
  }
  function elType(el) {
    const tag=el.tagName.toLowerCase(), role=el.getAttribute('role'), ax=axRole(el);
    if(role==='switch'||role==='checkbox'||role==='radio') return 'toggle['+role+']';
    if(ax==='switch'||ax==='checkbox'||ax==='radio') return 'toggle['+ax+']';
    if(tag==='input'&&(el.type==='checkbox'||el.type==='radio')) return 'toggle['+el.type+']';
    if(ax==='treeitem') return 'treeitem';
    if((ax==='combobox'||ax==='listbox')&&tag!=='input'&&tag!=='select') return 'button';
    if(ax==='option'||ax==='tab') return ax;
    if(ax==='menuitem'||ax==='menuitemcheckbox'||ax==='menuitemradio') return 'menuitem';
    if(role==='tab') return 'tab';
    if(role==='menuitem'||role==='option') return role;
    if(tag==='a') return 'link';
    if(tag==='button'||role==='button') return 'button';
    if(tag==='input') return 'input['+(el.type||'text')+']';
    return tag;
  }
  // Names, and which values are never read, come from the one definition every CDP script shares.
${ELEMENT_NAME_JS}
  const out=[];
  // Shared with the resolver's candidate names (_element-name-js.ts).
  const keptFromPeople = __keptFromPeople;
  // A part the tree shows inside a widget's combobox (Select2's rendered value, role textbox) is the combobox's. A
  // real text field inside one (the ARIA 1.0 combobox) is still typed into, and stays (/code-review on #1009). Text
  // fields are not marked in controls mode today, so this holds for one a later mode would mark.
  function insideCombobox(el) {
    if(el.tagName==='INPUT'||el.tagName==='TEXTAREA') return false;
    for(let a=__parent(el); a; a=__parent(a)) { if(axRole(a)==='combobox') return true; }
    return false;
  }
  const standsFor = __standsFor;
  // The value a widget shows: what its aria-labelledby points at inside the widget (Select2's rendered value); a
  // label outside it is a name, not a value.
  function shownValue(el) {
    const ids=(el.getAttribute('aria-labelledby')||'').trim().split(/\\s+/).filter(Boolean);
    return ids.map(function(id){const x=document.getElementById(id);return x&&__contains(el, x)?textUnmasked(x):'';}).filter(Boolean).join(' ').replace(/\\s+/g,' ').slice(0,80);
  }
  // Its text, leaving out any part the page masks (a descendant drawn as dots): the value is never read through a
  // raw textContent (PR 側 codex on #1009, P1).
  function textUnmasked(n) {
    if (n.nodeType === 1 && (__isMasked(n) || __skipsText(n))) return '';
    let out = '';
    for (const c of n.childNodes) {
      if (out.length > 400) break;
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.nodeType === 1 && !__skipsText(c)) out += textUnmasked(c);
    }
    return out.trim();
  }
  // A widget's combobox is named as a field is (aria-labelledby, aria-label), then by the label of the control it
  // stands for (a <label for> on the select it hides), then by the value it shows, then by its text. The label comes
  // before the value: two Select2 boxes showing "Select an option" stay two entities (/code-review on #1009).
  function widgetName(el) {
    const n=__fieldName(el); if(n) return n;
    const inner=standsFor(el);
    if(inner && inner.labels && inner.labels.length) {
      const t=Array.from(inner.labels).map(function(l){return __textWithoutFields(l);}).filter(Boolean).join(' ');
      if(t) return t.slice(0,80);
    }
    return shownValue(el) || __elText(el);
  }
  for(const el of document.querySelectorAll(CSS_Q)) {
    if(!isVisible(el)) continue;
    if(keptFromPeople(el)) continue;
    if(axRole(el)!==null && insideCombobox(el)) continue;
    // The tree's controls join the list by their mark, past CSS_Q's :not([disabled]); a disabled one stays out as
    // before (PR 側 codex on #1009).
    if(axRole(el)!==null) { let off=false; try { off=__matches(el, ':disabled'); } catch(e) {} if(off||el.getAttribute('aria-disabled')==='true') continue; }
    const r=el.getBoundingClientRect();
    const inVP=r.top<window.innerHeight&&r.bottom>0&&r.left<window.innerWidth&&r.right>0;
    const type=elType(el);
    const widget=type==='button' && (axRole(el)==='combobox'||axRole(el)==='listbox');
    // A control the tree showed is named as the tree names it: aria-labelledby or aria-label before its text (a
    // role=checkbox div named only by aria-label; PR 側 codex on #1009).
    const item={type:type,text:widget?widgetName(el):(axRole(el)!==null?(__fieldName(el)||__elText(el)):__elText(el)),selector:bestSel(el),inViewport:inVP};
    item.__el=el;
    if(el.tagName==='A') item.href=el.href;
    if((el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.tagName==='SELECT')&&!__isMasked(el)) item.value=el.value;
    else if(widget) { const v=shownValue(el); if(v) item.value=v; }
    out.push(item);
    if(out.length>=60) break;
  }
  // Names for the controls that share one, over what this script lists (its cap: 60; desktop_discover may show fewer,
  // so a namesake past what it shows still counts).
  const byName = new Map();
  out.forEach(function(it) { const k = it.text || it.href || ''; if (k) byName.set(k, (byName.get(k) || []).concat([it])); });
  byName.forEach(function(group) {
    if (group.length < 2) return;
    // Links of one name that go to one place are one target: nothing to tell apart.
    if (group.every(function(it) { return it.href && it.href === group[0].href; })) return;
    const els = group.map(function(it) { return it.__el; });
    group.forEach(function(it) {
      const ctx = blockName(it.__el, els.filter(function(o) { return o !== it.__el; }));
      if (ctx && ctx !== (it.text || it.href)) it.ctx = ctx;
    });
  });
  out.forEach(function(it) { delete it.__el; });
  return out;
})()
`;
}

export async function fetchBrowserCandidates(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  if (!target?.tabId) {
    return probeLane("cdp", "skipped", { why: "no_tab" }, { candidates: [], warnings: [] });
  }
  const tabId = target.tabId;

  try {
    const cdp = await import("../../engine/cdp-bridge.js");
    const { evaluateInTab, portForTab } = cdp;
    // The port the tab was listed on (browser_open's), not a fixed 9222 (llm22 F13).
    const port = portForTab(tabId);
    // The tree's controls are marked for the list and the marks cleared after it; a tree that cannot be read leaves
    // the list as it was.
    const nonce = randomUUID().slice(0, 8);
    const marked = await Promise.resolve()
      .then(() => cdp.markAxMatches({ by: "controls", pattern: "", caseSensitive: false, nonce }, tabId, port))
      .catch(() => null);
    const axNonce = marked !== null && marked > 0 ? nonce : null;
    let elements: BrowserElement[];
    try {
      elements = await evaluateInTab(interactiveScript(axNonce), tabId, port) as BrowserElement[];
    } finally {
      if (axNonce !== null) await cdp.clearAxMarks(axNonce, tabId, port);
    }

    if (!Array.isArray(elements)) {
      return probeLane("cdp", "failed", { tabId, why: "not_an_array" }, { candidates: [], warnings: ["cdp_provider_failed"] });
    }

    const kept = elements
      // A field with no name keeps its place under its type and selector. It used to borrow its
      // value for a name, which is how a password became a label. The selector is part of the label
      // because a CDP candidate has no rect: two unnamed password fields labelled by type alone
      // resolved to one entity, and the second could not be reached (2ゲート目 on #623). `bestSel`
      // gives each field a selector that matches it alone, so two fields stay apart.
      // A checkbox or radio with no name (a table's row-select box) keeps its place the same way (/code-review on #1009).
      .filter((el) => el.text || el.href || isField(el.type) || el.type.startsWith("toggle["));
    const candidates: UiEntityCandidate[] = kept
      .map((el): UiEntityCandidate => ({
        source: "cdp",
        target: { kind: "browserTab", id: tabId },
        locator: { cdp: { selector: el.selector, tabId } },
        role: cdpRoleFromType(el.type),
        label: el.text || el.href || `${el.type} ${el.selector}`,
        value: el.value,
        actionability: cdpActionability(el.type),
        confidence: el.inViewport ? 1.0 : 0.7,
        observedAtMs: Date.now(),
        provisional: false,
      }));
    // Controls that share a label get what tells them apart, as a person reads it: "Delete — Beta", "Add to cart —
    // <product>" (the user's decision, internal #420; blockName in the page). A CDP candidate has no rect, so the
    // resolver keys it by tab and label: these words keep each its own entity, and keep it when another goes. A label
    // the page has once is left as it is. The words are kept beside the label (labelContext), so a query matches the
    // control's own name. Controls still alike after that are numbered in page order for the reader ("(2 of 2)") and
    // keyed by their selector, which matches the control alone.
    candidates.forEach((c, i) => {
      const ctx = kept[i].ctx;
      if (!ctx) return;
      c.label = `${c.label} — ${ctx}`;
      c.labelContext = ctx;
    });
    const groupsLeft = new Map<string, number[]>();
    candidates.forEach((c, i) => groupsLeft.set(c.label ?? "", [...(groupsLeft.get(c.label ?? "") ?? []), i]));
    for (const idxs of groupsLeft.values()) {
      if (idxs.length < 2) continue;
      // Links of one name to one place are one target, merged as before.
      if (idxs.every((i) => kept[i].href && kept[i].href === kept[idxs[0]].href)) continue;
      const g = idxs.map((i) => candidates[i]);
      g.forEach((c, n) => {
        c.digest = createHash("sha1").update(`cdp|browserTab:${tabId}|${c.label ?? ""}|${c.locator!.cdp!.selector}`).digest("hex").slice(0, 16);
        const nth = `(${n + 1} of ${g.length})`;
        c.labelContext = c.labelContext ? `${c.labelContext} ${nth}` : nth;
        c.label = `${c.label}${c.label?.endsWith(nth) ? "" : (c.label?.includes(" — ") ? " " : " — ") + nth}`;
      });
    }

    const warnings = candidates.length === 0 ? ["cdp_no_elements"] : [];
    // Counts only: a label on a page can carry anything the user has in front of them.
    return probeLane("cdp", "read", { tabId, elementCount: elements.length }, { candidates, warnings });
  } catch (err) {
    console.error(`[browser-provider] CDP error for tab "${tabId}":`, err);
    return probeLane("cdp", "failed", { tabId, why: "threw" }, { candidates: [], warnings: ["cdp_provider_failed"] });
  }
}
