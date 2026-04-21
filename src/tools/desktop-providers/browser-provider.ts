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

interface BrowserElement {
  type: string;
  text: string;
  selector: string;
  inViewport: boolean;
  href?: string;
  value?: string;
}

function cdpRoleFromType(type: string): string {
  if (type === "link")   return "link";
  if (type === "button" || type.startsWith("toggle[")) return "button";
  if (type.startsWith("input[") || type === "select" || type === "textarea") return "textbox";
  if (type === "menuitem" || type === "option" || type === "tab") return "menuitem";
  return "unknown";
}

function cdpActionability(type: string): Array<"click" | "invoke" | "type" | "read"> {
  if (type === "link" || type === "button" || type.startsWith("toggle[")) return ["invoke", "click"];
  if (type.startsWith("input[") || type === "textarea" || type === "select") return ["type", "click"];
  if (type === "menuitem" || type === "option" || type === "tab") return ["invoke", "click"];
  return ["read"];
}

const INTERACTIVE_SCRIPT = `
(function() {
  const CSS_Q = "a[href], button:not([disabled]), [role='button'], input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled]), [role='menuitem']:not([aria-disabled='true']), [role='tab']:not([aria-disabled='true']), [role='switch']:not([aria-disabled='true'])";
  function isVisible(el) {
    const s = window.getComputedStyle(el);
    if (s.display==='none'||s.visibility==='hidden'||s.opacity==='0') return false;
    const r = el.getBoundingClientRect();
    return r.width>0 && r.height>0;
  }
  function bestSel(el) {
    if (el.id) return '#'+CSS.escape(el.id);
    const n=el.getAttribute('name'); if(n) return el.tagName.toLowerCase()+'[name='+JSON.stringify(n)+']';
    const al=el.getAttribute('aria-label'); if(al&&al.length<80) return el.tagName.toLowerCase()+'[aria-label='+JSON.stringify(al)+']';
    const dt=el.getAttribute('data-testid'); if(dt&&dt.length<60) return el.tagName.toLowerCase()+'[data-testid='+JSON.stringify(dt)+']';
    const p=el.parentElement; if(p){const idx=Array.from(p.children).indexOf(el)+1;return el.tagName.toLowerCase()+':nth-child('+idx+')';}
    return el.tagName.toLowerCase();
  }
  function elType(el) {
    const tag=el.tagName.toLowerCase(), role=el.getAttribute('role');
    if(role==='switch'||role==='checkbox'||role==='radio') return 'toggle['+role+']';
    if(role==='tab') return 'tab';
    if(role==='menuitem'||role==='option') return role;
    if(tag==='a') return 'link';
    if(tag==='button'||role==='button') return 'button';
    if(tag==='input') return 'input['+(el.type||'text')+']';
    return tag;
  }
  function elText(el) {
    const t=(el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,80);
    if(!t&&el.tagName==='INPUT') return (el.placeholder||el.value||el.getAttribute('aria-label')||'').slice(0,80);
    return t;
  }
  const out=[];
  for(const el of document.querySelectorAll(CSS_Q)) {
    if(!isVisible(el)) continue;
    const r=el.getBoundingClientRect();
    const inVP=r.top<window.innerHeight&&r.bottom>0&&r.left<window.innerWidth&&r.right>0;
    const item={type:elType(el),text:elText(el),selector:bestSel(el),inViewport:inVP};
    if(el.tagName==='A') item.href=el.href;
    if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.tagName==='SELECT') item.value=el.value;
    out.push(item);
    if(out.length>=60) break;
  }
  return out;
})()
`;

export async function fetchBrowserCandidates(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  if (!target?.tabId) return { candidates: [], warnings: [] };
  const tabId = target.tabId;

  try {
    const { evaluateInTab, DEFAULT_CDP_PORT } = await import("../../engine/cdp-bridge.js");
    const elements = await evaluateInTab(INTERACTIVE_SCRIPT, tabId, DEFAULT_CDP_PORT) as BrowserElement[];

    if (!Array.isArray(elements)) {
      return { candidates: [], warnings: ["cdp_provider_failed"] };
    }

    const candidates: UiEntityCandidate[] = elements
      .filter((el) => el.text || el.href)
      .map((el): UiEntityCandidate => ({
        source: "cdp",
        target: { kind: "browserTab", id: tabId },
        sourceId: el.selector,
        locator: { cdp: { selector: el.selector, tabId } },
        role: cdpRoleFromType(el.type),
        label: el.text || el.href || el.selector,
        value: el.value,
        actionability: cdpActionability(el.type),
        confidence: el.inViewport ? 1.0 : 0.7,
        observedAtMs: Date.now(),
        provisional: false,
      }));

    const warnings = candidates.length === 0 ? ["cdp_no_elements"] : [];
    return { candidates, warnings };
  } catch (err) {
    console.error(`[browser-provider] CDP error for tab "${tabId}":`, err);
    return { candidates: [], warnings: ["cdp_provider_failed"] };
  }
}
