/**
 * browser-resolver.ts — ADR-023 Phase 1 resolver core.
 *
 * The shared injected-JS builder for semantic element resolution. Phase 1 trunk
 * (S1/S7) extracts the candidate-collection IIFE VERBATIM from browser_search so
 * `browser_search` stays bit-equal (snapshot-pinned by
 * tests/unit/browser-resolver-candidate-collection.test.ts) while later phases
 * layer actionability / ancestor climb / physical-coord resolution on top for
 * browser_click({by}) / browser_fill({by}).
 *
 * The IIFE returns `{ total, returned, truncated, results[] }` (each result:
 * type / text / selector / role / ariaLabel / matchedBy / confidence /
 * inViewport / rect) or `{ __error }` (ScopeNotFound / InvalidRegex / Timeout).
 *
 * Plan: desktop-touch-mcp-internal:docs/adr-023-phase-1-resolver-plan.md S1/S7.
 */

import { evaluateInTab } from "../engine/cdp-bridge.js";

export interface CandidateCollectionArgs {
  by: "text" | "regex" | "role" | "ariaLabel" | "selector";
  pattern: string;
  scope?: string;
  maxResults: number;
  offset: number;
  visibleOnly: boolean;
  inViewportOnly: boolean;
  caseSensitive: boolean;
}

/** Args for the action-target fact gatherer (browser_click/fill by-axis, §2.bis). */
export interface ActionFactsArgs {
  by: "text" | "regex" | "role" | "ariaLabel" | "selector";
  pattern: string;
  scope?: string;
  caseSensitive: boolean;
  /**
   * Optional ARIA/implicit-role filter combined (AND) with the by-axis match —
   * `browser_click({by:'text', pattern:'Save', role:'button'})` keeps only Save
   * matches whose role is button. Applied to the full sorted match set before the
   * top-N cap, so the count + candidates reflect the role-filtered pool.
   */
  role?: string;
}

/**
 * Shared injected-JS body: candidate matching + scoring + visibility/viewport
 * filter + score-descending sort. Emits everything from the IIFE open through
 * building the sorted `filtered` array of `{ el, visible, rect, inVp }` (with the
 * `matchScore` / `matchedByMap` WeakMaps still in closure scope). Both
 * `buildCandidateCollectionJs` (browser_search serialization tail) and
 * `buildActionCandidateFactsJs` (resolver action-target fact tail) embed this
 * verbatim, then append their own tail — a single source for the candidate
 * matching/scoring contract (DRY without a second copy of the per-axis loops).
 *
 * The two public builders' snapshot tests pin the COMPOSED output byte-for-byte,
 * so the `browser_search` IIFE stays bit-equal (NFR-1 / AC-9): do not change the
 * emitted JS here without updating both snapshots.
 */
function candidateMatchingBodyJs(args: CandidateCollectionArgs): string {
  const { by, pattern, scope, maxResults, offset, visibleOnly, inViewportOnly, caseSensitive } = args;
  return `
(function() {
  const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : "document"};
  if (!root) return { __error: "ScopeNotFound" };

  const by = ${JSON.stringify(by)};
  const pat = ${JSON.stringify(pattern)};
  const cs  = ${JSON.stringify(caseSensitive)};
  const visibleOnly = ${JSON.stringify(visibleOnly)};
  const viewportOnly = ${JSON.stringify(inViewportOnly)};
  const maxN = ${JSON.stringify(maxResults + offset)};
  const offN = ${JSON.stringify(offset)};

  function isVisible(el) {
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function inViewportRect(rect) {
    return rect.top < window.innerHeight && rect.bottom > 0 &&
           rect.left < window.innerWidth && rect.right > 0;
  }
  function bestSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 80)
      return el.tagName.toLowerCase() + '[aria-label=' + JSON.stringify(aria) + ']';
    for (const attr of ['data-testid', 'data-asin']) {
      const v = el.getAttribute(attr);
      if (v && v.length < 60) return el.tagName.toLowerCase() + '[' + attr + '=' + JSON.stringify(v) + ']';
    }
    let node = el; let path = '';
    for (let depth = 0; depth < 2 && node.parentElement; depth++) {
      const p = node.parentElement;
      const idx = Array.from(p.children).indexOf(node) + 1;
      const seg = node.tagName.toLowerCase() + ':nth-child(' + idx + ')';
      path = path ? seg + ' > ' + path : seg;
      if (p.id) { path = '#' + CSS.escape(p.id) + ' > ' + path; break; }
      node = p;
    }
    return path || el.tagName.toLowerCase();
  }
  function classify(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || el.getAttribute('role') === 'button') return 'button';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'input';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'p' || tag === 'span' || tag === 'div') return 'text';
    return 'other';
  }
  function elText(el) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    if (!t && el.tagName === 'INPUT')
      return (el.placeholder || el.value || el.getAttribute('aria-label') || '').slice(0, 80);
    return t;
  }
  function score(matched, visible) {
    let s = matched;
    if (!visible) s = Math.max(0, s - 0.3);
    return Math.round(s * 100) / 100;
  }

  // Bound the scan — pages can have 10k+ nodes and CDP timeout is 15s.
  const SCAN_BUDGET_MS = 3000;
  const nowFn = (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now());
  const startTs = nowFn();
  const deadline = startTs + SCAN_BUDGET_MS;
  let aborted = false;
  // Sample the clock every 1024 iterations — cheap but keeps latency bounded.
  function overBudget(i) { return (i & 0x3FF) === 0 && nowFn() > deadline; }

  // IIFE-local match-state stores. WeakMap is essential: DOM elements persist
  // across Runtime.evaluate calls, so any expando we set (e.g. el.__matchScore)
  // would leak into the next search and contaminate scores / matchedBy / dedupe.
  // WeakMap is GC'd at IIFE end so each call starts clean.
  const matchScore = new WeakMap();
  const matchedByMap = new WeakMap();
  const pushed = new Set();
  function record(el, score, by) {
    const prev = matchScore.get(el) || 0;
    if (score > prev) { matchScore.set(el, score); matchedByMap.set(el, by); }
    if (!pushed.has(el)) { candidates.push(el); pushed.add(el); }
  }

  const all = root.querySelectorAll('*');
  let candidates = [];

  if (by === 'selector') {
    const selectorMatches = Array.from(root.querySelectorAll(pat));
    for (let i = 0; i < selectorMatches.length; i++) {
      if (overBudget(i)) { aborted = true; break; }
      record(selectorMatches[i], 1.0, 'selector');
    }
  } else if (by === 'text') {
    const needle = cs ? pat : pat.toLowerCase();
    let i = 0;
    for (const el of all) {
      if (overBudget(i++)) { aborted = true; break; }
      // Direct child text only (avoid double-counting parent matches via descendants)
      const direct = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent || '')
        .join('').trim();
      if (!direct) continue;
      const hay = cs ? direct : direct.toLowerCase();
      if (hay === needle) record(el, 1.0, 'text');
      else if (hay.includes(needle)) record(el, 0.8, 'text');
    }
  } else if (by === 'regex') {
    let re;
    try { re = new RegExp(pat, (cs ? '' : 'i') + 'u'); }
    catch (e) { return { __error: "InvalidRegex", message: String(e) }; }
    let i = 0;
    for (const el of all) {
      if (overBudget(i++)) { aborted = true; break; }
      const direct = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent || '').join('').trim();
      if (!direct) continue;
      if (re.test(direct)) record(el, 0.9, 'regex');
    }
  } else if (by === 'role') {
    const needle = cs ? pat : pat.toLowerCase();
    let i = 0;
    for (const el of all) {
      if (overBudget(i++)) { aborted = true; break; }
      const role = el.getAttribute('role') || '';
      const cmp = cs ? role : role.toLowerCase();
      if (cmp === needle) record(el, 0.75, 'role');
    }
    // Implicit roles — score slightly higher because they're guaranteed by tag.
    if (!aborted && needle === 'button')  for (const el of root.querySelectorAll('button')) record(el, 0.85, 'roleImplicit');
    if (!aborted && needle === 'link')    for (const el of root.querySelectorAll('a[href]')) record(el, 0.85, 'roleImplicit');
    if (!aborted && needle === 'heading') for (const el of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) record(el, 0.85, 'roleImplicit');
  } else if (by === 'ariaLabel') {
    const needle = cs ? pat : pat.toLowerCase();
    let i = 0;
    for (const el of all) {
      if (overBudget(i++)) { aborted = true; break; }
      const aria = el.getAttribute('aria-label') || '';
      if (!aria) continue;
      const cmp = cs ? aria : aria.toLowerCase();
      if (cmp === needle) record(el, 0.95, 'ariaLabel');
      else if (cmp.includes(needle)) record(el, 0.7, 'ariaLabel');
    }
  }

  // candidates already de-duplicated via the pushed Set in record()

  if (aborted && candidates.length === 0) {
    return { __error: "Timeout", message: "Scan budget exceeded with no matches; narrow scope or maxResults." };
  }

  const filtered = [];
  for (const el of candidates) {
    const visible = isVisible(el);
    if (visibleOnly && !visible) continue;
    const rect = el.getBoundingClientRect();
    const inVp = inViewportRect(rect);
    if (viewportOnly && !inVp) continue;
    filtered.push({ el, visible, rect, inVp });
  }

  // Score and sort by confidence desc
  filtered.sort((a, b) => {
    const sa = score(matchScore.get(a.el) || 0, a.visible);
    const sb = score(matchScore.get(b.el) || 0, b.visible);
    return sb - sa;
  });
`;
}

/**
 * Build the injected-JS IIFE that collects, scores, filters and shapes candidate
 * elements for `browser_search`. Composes the shared `candidateMatchingBodyJs`
 * with the search serialization tail. The generated string is byte-equal with
 * the former inline template (pinned by snapshot) so the public `browser_search`
 * contract is unchanged (NFR-1 / AC-9). Do not change the emitted JS without
 * updating the snapshot.
 */
export function buildCandidateCollectionJs(args: CandidateCollectionArgs): string {
  return `${candidateMatchingBodyJs(args)}
  const total = filtered.length;
  const sliced = filtered.slice(offN, offN + (maxN - offN));

  const results = sliced.map(({ el, visible, rect, inVp }) => ({
    type: classify(el),
    text: elText(el),
    selector: bestSelector(el),
    role: el.getAttribute('role') || undefined,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    matchedBy: matchedByMap.get(el),
    confidence: score(matchScore.get(el) || 0, visible),
    inViewport: inVp,
    rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
  }));

  return { total, returned: results.length, truncated: total > offN + results.length, results };
})()
`;
}

/**
 * Build the injected-JS IIFE that gathers RAW DOM FACTS for action-target
 * resolution (browser_click / browser_fill by-axis, ADR-023 §2.bis gather/decide
 * split). Composes the shared `candidateMatchingBodyJs` (same matching + scoring
 * as browser_search) with a fact-gathering tail that, for the top-N=8 candidates
 * by score, gathers:
 *
 *   - `chain`: self + up to D=3 ancestors, each a ClickableNode (tag / role /
 *     hasHref / tabindex / hasOnclick / cursorPointer / visible / enabled /
 *     receivesEvents via elementFromPoint hit-test / viewport rect).
 *   - `nearestLabels` (≤3 × 40 chars) / `containerHint` (≤40 chars) for ambiguity
 *     disambiguation.
 *   - window-level `viewport` metrics (screenX/screenY/dpr/chromeH/chromeW,
 *     getElementScreenCoords formula) so the resolved viewport rect converts to
 *     physical screen px WITHOUT a second querySelector (avoids GSC dynamic-class
 *     re-non-uniqueness; ADR §1.2 D1 / plan §2).
 *
 * ALL DOM access lives here; the actionability / climb / uniqueness DECISION is
 * the pure TS `decideActionTarget`. Returns `{ total, returned, viewport,
 * candidates: CandidateFacts[] }` or the shared `{ __error }` shape on
 * ScopeNotFound / InvalidRegex / Timeout. Pinned by snapshot.
 */
export function buildActionCandidateFactsJs(args: ActionFactsArgs): string {
  const { by, pattern, scope, caseSensitive, role } = args;
  // maxResults/offset are unused by the gather tail (it takes top-N of the full
  // sorted set); fixed values keep the shared body's interpolation total. The
  // resolver always collects visible elements and lets receivesEvents gate the
  // viewport (so off-viewport candidates fall out as non-actionable, not unseen).
  return `${candidateMatchingBodyJs({ by, pattern, scope, maxResults: 200, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive })}
  // ── ADR-023 Phase 1 PR2: action-target fact gathering (top-N only, §2.bis). ──
  const N = ${AMBIGUITY_CANDIDATE_CAP};
  const D = ${CLIMB_MAX_DEPTH};

  // Optional role filter (AND with the by-axis match) applied BEFORE the top-N
  // cap so total/candidates reflect the role-filtered pool (plan §S4 role combine).
  const roleFilter = ${role ? JSON.stringify(role.toLowerCase()) : "null"};
  function roleMatches(el) {
    const explicit = (el.getAttribute('role') || '').toLowerCase();
    if (explicit === roleFilter) return true;
    const tg = el.tagName.toLowerCase();
    const ty = (el.getAttribute('type') || '').toLowerCase();
    if (roleFilter === 'button') return tg === 'button' || (tg === 'input' && /^(button|submit|reset)$/.test(ty));
    if (roleFilter === 'link') return tg === 'a' && el.hasAttribute('href');
    if (roleFilter === 'textbox') return tg === 'textarea' || (tg === 'input' && !/^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/.test(ty));
    if (roleFilter === 'checkbox') return tg === 'input' && ty === 'checkbox';
    if (roleFilter === 'radio') return tg === 'input' && ty === 'radio';
    if (roleFilter === 'heading') return /^h[1-6]$/.test(tg);
    return false;
  }
  const pool = roleFilter ? filtered.filter(function(e) { return roleMatches(e.el); }) : filtered;
  const top = pool.slice(0, N);

  // Physical-coord conversion constants (getElementScreenCoords formula,
  // cdp-bridge.ts) — computed once so browser_click({by}) converts the resolved
  // viewport rect to screen px WITHOUT a second querySelector (ADR §1.2 D1).
  const dpr = window.devicePixelRatio || 1;
  const sx = window.screenX;
  const sy = window.screenY;
  const chromeH = window.outerHeight - window.innerHeight;
  const chromeW = Math.round((window.outerWidth - window.innerWidth) / 2);

  function actNode(el) {
    const cs2 = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const vis = cs2.display !== 'none' && cs2.visibility !== 'hidden' && cs2.opacity !== '0' && r.width > 0 && r.height > 0;
    const enabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    let receivesEvents = false;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx >= 0 && cx < window.innerWidth && cy >= 0 && cy < window.innerHeight) {
      const hit = document.elementFromPoint(cx, cy);
      receivesEvents = !!hit && (hit === el || el.contains(hit));
    }
    const tiRaw = el.getAttribute('tabindex');
    const ti = (tiRaw !== null && tiRaw.trim() !== '' && !isNaN(Number(tiRaw))) ? Number(tiRaw) : null;
    const roleAttr = el.getAttribute('role');
    return {
      tag: el.tagName.toLowerCase(),
      role: roleAttr ? roleAttr.toLowerCase() : null,
      hasHref: el.tagName === 'A' && el.hasAttribute('href'),
      tabindex: ti,
      hasOnclick: el.hasAttribute('onclick'),
      cursorPointer: cs2.cursor === 'pointer',
      visible: vis,
      enabled: enabled,
      receivesEvents: receivesEvents,
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }

  function chainOf(el) {
    const chain = [];
    let node = el;
    for (let d = 0; d <= D && node; d++) {
      chain.push(actNode(node));
      node = node.parentElement;
    }
    return chain;
  }

  function labelsOf(el) {
    const out = [];
    const seen = new Set();
    function add(t) {
      if (!t) return;
      const s = t.trim().replace(/\\s+/g, ' ').slice(0, 40);
      if (s && !seen.has(s)) { seen.add(s); out.push(s); }
    }
    const lb = el.getAttribute('aria-labelledby');
    if (lb) for (const id of lb.split(/\\s+/)) { const n = document.getElementById(id); if (n) add(n.textContent); }
    if (el.id) { try { for (const lab of document.querySelectorAll('label[for=' + JSON.stringify(el.id) + ']')) add(lab.textContent); } catch (e) {} }
    const wrapLabel = el.closest && el.closest('label');
    if (wrapLabel) add(wrapLabel.textContent);
    let prev = el.previousElementSibling;
    let hops = 0;
    while (prev && hops < 3 && out.length < 3) {
      const tg = prev.tagName.toLowerCase();
      if (tg === 'label' || /^h[1-6]$/.test(tg) || tg === 'legend') add(prev.textContent);
      prev = prev.previousElementSibling; hops++;
    }
    return out.slice(0, 3);
  }

  function hintOf(el) {
    let node = el.parentElement;
    let guard = 0;
    while (node && node !== document.body && guard < 40) {
      const r = node.getAttribute('role');
      const tg = node.tagName.toLowerCase();
      let lm = null;
      if (r && /^(navigation|dialog|alertdialog|main|banner|complementary|contentinfo|search|form|region)$/.test(r)) lm = r;
      else if (/^(nav|main|header|footer|aside|form|section)$/.test(tg)) lm = tg;
      if (lm) {
        const an = node.getAttribute('aria-label');
        return (lm + (an ? ' "' + an + '"' : '')).slice(0, 40);
      }
      node = node.parentElement; guard++;
    }
    return null;
  }

  const factsList = top.map(function(entry, i) {
    const el = entry.el;
    const roleAttr = el.getAttribute('role');
    return {
      index: i,
      chain: chainOf(el),
      type: classify(el),
      name: elText(el),
      role: roleAttr || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      matchedBy: matchedByMap.get(el),
      score: score(matchScore.get(el) || 0, entry.visible),
      nearestLabels: labelsOf(el),
      containerHint: hintOf(el),
    };
  });

  return {
    total: pool.length,
    returned: factsList.length,
    viewport: { screenX: sx, screenY: sy, dpr: dpr, chromeH: chromeH, chromeW: chromeW, innerWidth: window.innerWidth, innerHeight: window.innerHeight },
    candidates: factsList,
  };
})()
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-023 Phase 1 PR 2 — action-target resolution (gather / decide split, §2.bis)
//
// The injected JS gathers raw DOM facts (rects / visibility / elementFromPoint
// hit-testing / ancestor clickable signals — all layout-dependent). THESE pure
// functions make the actionability / ancestor-climb / uniqueness / ambiguity
// DECISION in node, so the core logic is unit-testable without a DOM. The
// injected fact-gatherer + the end-to-end pipeline are covered by real headless
// Chrome e2e (tests/e2e). See adr-023-phase-1-resolver-plan.md §2.bis.
// ─────────────────────────────────────────────────────────────────────────────

/** ADR §1.2 D4: max ancestor-climb depth. */
export const CLIMB_MAX_DEPTH = 3;
/** ADR §1.2 D3: ambiguity candidate cap (top-N by score). */
export const AMBIGUITY_CANDIDATE_CAP = 8;

export interface RectXYWH {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Clickable + actionability signals for one DOM node (a candidate's matched
 * element or an ancestor in its climb chain). Every field is layout-derived and
 * gathered by the injected JS — the decision functions below never touch the DOM.
 */
export interface ClickableNode {
  /** lowercased tagName */
  tag: string;
  /** explicit `role` attribute, lowercased; null when absent */
  role: string | null;
  /** `<a href>` — an anchor without href is not interactive */
  hasHref: boolean;
  /** parsed tabindex; null when the attribute is absent/non-numeric */
  tabindex: number | null;
  /** an `onclick` attribute is present */
  hasOnclick: boolean;
  /** computed `cursor: pointer` */
  cursorPointer: boolean;
  /** display/visibility/opacity not hiding it AND size > 0 */
  visible: boolean;
  /** not `disabled` and `aria-disabled !== "true"` */
  enabled: boolean;
  /** `document.elementFromPoint(center)` hit is this node or a descendant (not occluded) */
  receivesEvents: boolean;
  /** viewport rect (CSS px), rounded */
  rect: RectXYWH;
}

/** Raw facts the injected JS gathers for one matched candidate (top-N only). */
export interface CandidateFacts {
  /** 0-based, score-descending order; stable within one resolve call */
  index: number;
  /** [self, parent, ...] — self at [0], up to CLIMB_MAX_DEPTH ancestors */
  chain: ClickableNode[];
  /** classify(): link / button / input / heading / text / other */
  type: string;
  /** accessible-ish name (text / aria-label / placeholder); gatherer caps to 80 */
  name: string;
  role: string | null;
  ariaLabel: string | null;
  /** whyMatched — reuses browser_search's `matchedBy` */
  matchedBy: string;
  /** confidence score from collection */
  score: number;
  /** neighbouring label words; gatherer caps to 3 entries x 40 chars */
  nearestLabels: string[];
  /** nearest landmark role + accessible name; gatherer caps to 40 chars */
  containerHint: string | null;
}

/**
 * Window-level metrics the gatherer computes once (getElementScreenCoords
 * formula, cdp-bridge.ts) so the resolved viewport rect converts to physical
 * screen px without a second querySelector. CSS px unless noted.
 */
export interface ViewportMetrics {
  screenX: number;
  screenY: number;
  dpr: number;
  /** outerHeight - innerHeight (tab strip + address bar) */
  chromeH: number;
  /** (outerWidth - innerWidth) / 2 (left frame) */
  chromeW: number;
  innerWidth: number;
  innerHeight: number;
}

/** Full return shape of `buildActionCandidateFactsJs` (success path). */
export interface GatheredFacts {
  /** total matches in the full collection (may exceed candidates.length) */
  total: number;
  /** number of candidate facts returned (≤ AMBIGUITY_CANDIDATE_CAP) */
  returned: number;
  viewport: ViewportMetrics;
  candidates: CandidateFacts[];
}

/** Error shape the shared body returns (ScopeNotFound / InvalidRegex / Timeout). */
export interface GatherError {
  __error: string;
  message?: string;
}

export interface Actionability {
  visible: boolean;
  enabled: boolean;
  receivesEvents: boolean;
}

export interface ResolvedActionTarget {
  /** candidate index that resolved */
  index: number;
  /** the resolved clickable's viewport rect (the click target) */
  rect: RectXYWH;
  /** 0 = matched element itself, 1..D = ancestor distance climbed */
  climbDepth: number;
}

export interface AmbiguityCandidate {
  index: number;
  role: string | null;
  name: string;
  actionability: Actionability;
  rect: RectXYWH;
  nearestLabels: string[];
  containerHint: string | null;
  score: number;
  whyMatched: string;
}

export type ResolveDecision =
  | { kind: "resolved"; target: ResolvedActionTarget }
  | {
      kind: "ambiguous";
      total: number;
      returned: number;
      truncated: boolean;
      candidates: AmbiguityCandidate[];
      next: string[];
    }
  | {
      kind: "noActionable";
      total: number;
      returned: number;
      truncated: boolean;
      candidates: AmbiguityCandidate[];
      next: string[];
    };

export type ClickableStrength = "strong" | "medium" | "weak" | "none";

const STRONG_TAGS = new Set(["button", "input", "select", "textarea"]);
const STRONG_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "checkbox",
  "radio",
  "switch",
]);

/** ADR §1.2 D4 clickable signal strength (strong stops the climb / auto-acts). */
export function clickableStrength(n: ClickableNode): ClickableStrength {
  if (
    STRONG_TAGS.has(n.tag) ||
    (n.tag === "a" && n.hasHref) ||
    (n.role !== null && STRONG_ROLES.has(n.role))
  ) {
    return "strong";
  }
  if ((n.tabindex !== null && n.tabindex >= 0) || n.hasOnclick) return "medium";
  if (n.cursorPointer) return "weak";
  return "none";
}

/**
 * ADR §1.2 D4 actionability gate. `requireReceivesEvents` defaults to true (click
 * path — the occlusion / off-viewport hit-test is needed before an OS click). The
 * fill path passes `false`: fill acts via a CDP eval on the resolved element, so
 * `receivesEvents` (a click-occlusion guard) is not a precondition (plan §S2/S5,
 * Round 1 P2-2). `visible` + `enabled` still gate both paths.
 */
export function isActionable(n: ClickableNode, requireReceivesEvents = true): boolean {
  return n.visible && n.enabled && (!requireReceivesEvents || n.receivesEvents);
}

/**
 * Climb the chain (matched element → ancestors, nearest first) to the nearest
 * STRONG clickable within CLIMB_MAX_DEPTH. Returns null when none is strong —
 * weak/medium signals alone never auto-resolve (FR-4 safety, ADR §1.2 D4); such
 * candidates surface in the ambiguity/no-actionable response for explicit choice.
 */
export function climbToClickable(facts: CandidateFacts): { node: ClickableNode; depth: number } | null {
  const max = Math.min(facts.chain.length, CLIMB_MAX_DEPTH + 1); // index 0 = self
  for (let depth = 0; depth < max; depth++) {
    if (clickableStrength(facts.chain[depth]) === "strong") {
      return { node: facts.chain[depth], depth };
    }
  }
  return null;
}

function rectKey(r: RectXYWH): string {
  return `${r.x},${r.y},${r.w},${r.h}`;
}

function toFingerprint(f: CandidateFacts, clickable: ClickableNode | null): AmbiguityCandidate {
  const n = clickable ?? f.chain[0];
  return {
    index: f.index,
    role: f.role,
    name: f.name,
    actionability: { visible: n.visible, enabled: n.enabled, receivesEvents: n.receivesEvents },
    rect: n.rect,
    nearestLabels: f.nearestLabels,
    containerHint: f.containerHint,
    score: f.score,
    whyMatched: f.matchedBy,
  };
}

/** Fixed next-step hints (CodeQL CWE-94 — no interpolation, feedback_codeql_suggest_strings). */
export const AMBIGUITY_NEXT_HINTS: readonly string[] = [
  "Narrow the search with a scope (CSS selector or landmark container).",
  "Add distinguishing words from nearestLabels to the pattern.",
  "Combine with role to filter (e.g. role:'button').",
];

export const NO_ACTIONABLE_NEXT_HINTS: readonly string[] = [
  "Matches were found but none is an auto-clickable target (no strong interactive element within climb depth 3).",
  "Target a parent button/link, or use browser_click with a precise CSS selector.",
  "Verify the element is on-screen and not covered by an overlay (receivesEvents=false means it is occluded or off-viewport).",
];

/**
 * ADR §1.2 D3 uniqueness contract: auto-act ONLY when exactly one actionable
 * candidate resolves (after climb + actionability gate + dedup by resolved rect).
 * Two-or-more distinct → `ambiguous` (stop, return fingerprints). Zero strong-
 * actionable → `noActionable` (still returns the matched candidates so the agent
 * can pick by index / refine). Score margin is NEVER used to auto-act — same-name
 * buttons score equally, so a margin heuristic would silently mis-click.
 *
 * Pure: `facts` are the top-N (score-desc) candidate facts the injected JS
 * gathered; `totalMatches` is the full collection count (may exceed facts.length).
 *
 * `opts.requireReceivesEvents` defaults to true (click). The fill path passes
 * false so a non-occluded-but-not-hit-tested input still resolves (plan §S5).
 */
export function decideActionTarget(
  facts: CandidateFacts[],
  totalMatches: number,
  opts: { requireReceivesEvents?: boolean } = {},
): ResolveDecision {
  const requireReceivesEvents = opts.requireReceivesEvents ?? true;
  const resolved = facts.map((f) => {
    const c = climbToClickable(f);
    return {
      f,
      clickable: c?.node ?? null,
      depth: c?.depth ?? -1,
      actionable: c ? isActionable(c.node, requireReceivesEvents) : false,
    };
  });

  // Dedup: several matched candidates (e.g. a button's label span AND the button)
  // can climb to the SAME clickable rect → one distinct target, not ambiguity.
  const distinct = new Map<string, (typeof resolved)[number]>();
  for (const r of resolved) {
    if (r.actionable && r.clickable) {
      const key = rectKey(r.clickable.rect);
      if (!distinct.has(key)) distinct.set(key, r);
    }
  }

  if (distinct.size === 1) {
    const r = [...distinct.values()][0];
    return { kind: "resolved", target: { index: r.f.index, rect: r.clickable!.rect, climbDepth: r.depth } };
  }

  const candidates = resolved.map((r) => toFingerprint(r.f, r.clickable));
  const returned = facts.length;
  const truncated = totalMatches > returned;
  if (distinct.size === 0) {
    return { kind: "noActionable", total: totalMatches, returned, truncated, candidates, next: [...NO_ACTIONABLE_NEXT_HINTS] };
  }
  return { kind: "ambiguous", total: totalMatches, returned, truncated, candidates, next: [...AMBIGUITY_NEXT_HINTS] };
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveActionTarget — the impure wrapper (gather eval → pure decide).
//
// browser_click({by}) / browser_fill({by}) call this. It runs the fact-gather
// IIFE in the tab (the ONLY DOM access), then hands the facts to the pure
// decideActionTarget. On `resolved` it converts the resolved viewport rect to a
// physical screen point using the same-eval viewport metrics — so the click
// caller never issues a second querySelector (ADR §1.2 D1: no re-non-uniqueness).
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolveActionArgs {
  by: "text" | "regex" | "role" | "ariaLabel" | "selector";
  pattern: string;
  /** optional ARIA/implicit-role filter, AND-combined with the by-axis match */
  role?: string;
  scope?: string;
  caseSensitive?: boolean;
  /** click gates on receivesEvents; fill does not (acts via CDP eval, §S5) */
  action: "click" | "fill";
  tabId?: string | null;
  port: number;
}

export type ResolveActionOutcome =
  | {
      kind: "resolved";
      index: number;
      /** resolved clickable's viewport rect (CSS px) */
      rect: RectXYWH;
      /** physical screen point (device px), ready for an OS mouse click */
      physical: { x: number; y: number };
      /** 0 = matched element, 1..D = ancestor distance climbed */
      climbDepth: number;
      viewport: ViewportMetrics;
    }
  | { kind: "ambiguous"; total: number; returned: number; truncated: boolean; candidates: AmbiguityCandidate[]; next: string[] }
  | { kind: "noActionable"; total: number; returned: number; truncated: boolean; candidates: AmbiguityCandidate[]; next: string[] }
  /** gather-time failure surfaced by the shared body (ScopeNotFound / InvalidRegex / Timeout) */
  | { kind: "error"; code: string; message?: string };

/**
 * Convert a viewport rect's CENTER to a physical screen point using the gather
 * eval's window metrics — the getElementScreenCoords formula (cdp-bridge.ts),
 * computed once at gather time. Center-based so it matches the actionability
 * hit-test (`receivesEvents` = elementFromPoint(center)).
 *
 * NOTE (intentional, do not "fix" toward edge-rounding): we average the CSS-px
 * center first, then convert+round once. getElementScreenCoords instead rounds
 * each physical edge then averages — a ≤1px sub-pixel difference at the center,
 * harmless for an OS click and kept center-first to stay aligned with the
 * elementFromPoint hit-test that gated this target.
 */
export function physicalPoint(rect: RectXYWH, vp: ViewportMetrics): { x: number; y: number } {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return {
    x: Math.round((vp.screenX + vp.chromeW + cx) * vp.dpr),
    y: Math.round((vp.screenY + vp.chromeH + cy) * vp.dpr),
  };
}

/**
 * Resolve a semantic (by-axis) target to a single actionable element, or an
 * ambiguity / no-actionable / error outcome. One gather eval + a pure decision.
 *
 * Named distinctly from the native perception `resolveActionTarget`
 * (`src/engine/perception/action-target.ts`) — different layer, different shape.
 */
export async function resolveBrowserActionTarget(args: ResolveActionArgs): Promise<ResolveActionOutcome> {
  const expr = buildActionCandidateFactsJs({
    by: args.by,
    pattern: args.pattern,
    scope: args.scope,
    caseSensitive: args.caseSensitive ?? false,
    role: args.role,
  });
  let raw: unknown;
  try {
    raw = await evaluateInTab(expr, args.tabId ?? null, args.port);
  } catch (err) {
    // The injected JS can throw synchronously OUT of the IIFE for inputs the
    // shared body does not guard — an invalid CSS `scope`/`by:'selector'` makes
    // querySelector(All) throw a SyntaxError (DOMException), and CDP itself can
    // throw (timeout / detached). The shared body is byte-equal-pinned (can't add
    // a try there without breaking browser_search), so we normalise here into the
    // documented error union instead of rejecting (parity with browserSearchHandler).
    return { kind: "error", code: "EvalError", message: err instanceof Error ? err.message : String(err) };
  }
  if (raw && typeof raw === "object" && "__error" in (raw as object)) {
    const e = raw as GatherError;
    return { kind: "error", code: e.__error, message: e.message };
  }
  const gathered = raw as GatheredFacts;
  const decision = decideActionTarget(gathered.candidates, gathered.total, {
    requireReceivesEvents: args.action !== "fill",
  });
  if (decision.kind === "resolved") {
    return {
      kind: "resolved",
      index: decision.target.index,
      rect: decision.target.rect,
      physical: physicalPoint(decision.target.rect, gathered.viewport),
      climbDepth: decision.target.climbDepth,
      viewport: gathered.viewport,
    };
  }
  return decision;
}
