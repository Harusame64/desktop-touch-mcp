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
import { randomUUID } from "node:crypto";

/** The attribute markAxMatches marks with (cdp-bridge's AX_MARK_ATTR; cdp-bridge is loaded lazily here). */
const AX_MARK_ATTR = "data-dtm-ax";

interface BrowserElement {
  type: string;
  text: string;
  selector: string;
  inViewport: boolean;
  href?: string;
  value?: string;
}

// A checkbox, radio or switch reads as a button, as UIA's are (uiaRoleFromControlType): it is pressed, not typed
// into (internal #420: a native checkbox read "textbox"). A combobox a widget draws (Select2, Choices) is pressed to
// open, so it is a button too; a native select and a text field stay textboxes.
function cdpRoleFromType(type: string): string {
  if (type === "link")   return "link";
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
  // A selector is kept only when it names this one element: a radio group shares its name, and a press on
  // input[name=size] went to its first radio (/code-review on #1009).
  function alone(sel) { try { return document.querySelectorAll(sel).length===1; } catch(e) { return false; } }
  function bestSel(el) {
    if (el.id && alone('#'+CSS.escape(el.id))) return '#'+CSS.escape(el.id);
    const tg=el.tagName.toLowerCase();
    const n=el.getAttribute('name'); if(n && alone(tg+'[name='+JSON.stringify(n)+']')) return tg+'[name='+JSON.stringify(n)+']';
    const al=el.getAttribute('aria-label'); if(al&&al.length<80 && alone(tg+'[aria-label='+JSON.stringify(al)+']')) return tg+'[aria-label='+JSON.stringify(al)+']';
    const dt=el.getAttribute('data-testid'); if(dt&&dt.length<60 && alone(tg+'[data-testid='+JSON.stringify(dt)+']')) return tg+'[data-testid='+JSON.stringify(dt)+']';
    // A path of :nth-child steps up to an ancestor with an id, as far as it takes to name this one element: one
    // step alone named the first such element of the page (Choices' unnamed div, internal #420 PR-C2b).
    let node=el, path='', sel='';
    for(let d=0; d<8 && node && node.parentElement; d++) {
      const p=node.parentElement, idx=Array.from(p.children).indexOf(node)+1;
      path=node.tagName.toLowerCase()+':nth-child('+idx+')'+(path?' > '+path:'');
      // An ancestor id is used only when it is the page's one element with that id.
      const pid=p.id && alone('#'+CSS.escape(p.id)) ? '#'+CSS.escape(p.id)+' > ' : '';
      sel=pid+path;
      if(alone(sel)) return sel;
      if(pid) break;
      node=p;
    }
    // Nothing named it alone: the most specific path read, not a shorter one known to match more.
    return sel||tg;
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
    // A submit, reset, image or button input is pressed, not typed into (win2 on #1009: "Send" read as a textbox).
    if(tag==='input'&&/^(submit|reset|image|button)$/.test(el.type)) return 'button';
    if(tag==='input') return 'input['+(el.type||'text')+']';
    return tag;
  }
  // Names, and which values are never read, come from the one definition every CDP script shares.
${ELEMENT_NAME_JS}
  const out=[];
  // A control the page keeps out of the tab order and the accessibility tree (Select2's original select: tabindex -1,
  // aria-hidden) is not one a person uses; the widget drawn for it is listed instead.
  function keptFromPeople(el) { return el.getAttribute('aria-hidden')==='true' && el.getAttribute('tabindex')==='-1'; }
  // A part the tree shows inside a widget's combobox (Select2's rendered value, role textbox) is the combobox's. A
  // real text field inside one (the ARIA 1.0 combobox) is still typed into, and stays (/code-review on #1009).
  function insideCombobox(el) {
    if(el.tagName==='INPUT'||el.tagName==='TEXTAREA') return false;
    for(let a=el.parentElement; a; a=a.parentElement) { if(axRole(a)==='combobox') return true; }
    return false;
  }
  // The control a widget stands for: the select or input inside it (Choices), or the one the page keeps from people
  // just before the widget's box (Select2 puts its span after the select it hides).
  function standsFor(el) {
    const inner=el.querySelector('select, input'); if(inner) return inner;
    for(let a=el, d=0; a && d<4; a=a.parentElement, d++) {
      const prev=a.previousElementSibling;
      if(prev && (prev.tagName==='SELECT'||prev.tagName==='INPUT') && (keptFromPeople(prev)||prev.hidden)) return prev;
    }
    return null;
  }
  // The value a widget shows (Select2's rendered value, which its aria-labelledby points at).
  function shownValue(el) {
    const ids=(el.getAttribute('aria-labelledby')||'').trim().split(/\\s+/).filter(Boolean);
    return ids.map(function(id){const x=document.getElementById(id);return x&&!__isMasked(x)?(x.textContent||'').trim():'';}).filter(Boolean).join(' ').replace(/\\s+/g,' ').slice(0,80);
  }
  // A widget's combobox is named as a field is (aria-label, aria-labelledby), then by the label of the control it
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
    const r=el.getBoundingClientRect();
    const inVP=r.top<window.innerHeight&&r.bottom>0&&r.left<window.innerWidth&&r.right>0;
    const type=elType(el);
    const widget=type==='button' && (axRole(el)==='combobox'||axRole(el)==='listbox');
    const item={type:type,text:widget?widgetName(el):__elText(el),selector:bestSel(el),inViewport:inVP};
    if(el.tagName==='A') item.href=el.href;
    if((el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.tagName==='SELECT')&&!__isMasked(el)) item.value=el.value;
    else if(widget) { const v=shownValue(el); if(v) item.value=v; }
    out.push(item);
    if(out.length>=60) break;
  }
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

    const candidates: UiEntityCandidate[] = elements
      // A field with no name keeps its place under its type and selector. It used to borrow its
      // value for a name, which is how a password became a label. The selector is part of the label
      // because a CDP candidate has no rect: two unnamed password fields labelled by type alone
      // resolved to one entity, and the second could not be reached (2ゲート目 on #623). This keeps
      // two fields apart only as far as `bestSel` does: its one-level `:nth-child` fallback can
      // repeat, and then the locator itself cannot reach the second field either — as before.
      // A checkbox or radio with no name (a table's row-select box) keeps its place the same way (/code-review on #1009).
      .filter((el) => el.text || el.href || isField(el.type) || el.type.startsWith("toggle["))
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

    const warnings = candidates.length === 0 ? ["cdp_no_elements"] : [];
    // Counts only: a label on a page can carry anything the user has in front of them.
    return probeLane("cdp", "read", { tabId, elementCount: elements.length }, { candidates, warnings });
  } catch (err) {
    console.error(`[browser-provider] CDP error for tab "${tabId}":`, err);
    return probeLane("cdp", "failed", { tabId, why: "threw" }, { candidates: [], warnings: ["cdp_provider_failed"] });
  }
}
