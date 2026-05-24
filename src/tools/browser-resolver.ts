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

/**
 * Build the injected-JS IIFE that collects, scores, filters and shapes candidate
 * elements for `browser_search`. This is a VERBATIM extraction of the former
 * inline template in `browserSearchHandler` — the generated string is byte-equal
 * (pinned by snapshot) so the public `browser_search` contract is unchanged
 * (NFR-1 / AC-9). Do not change the emitted JS without updating the snapshot.
 */
export function buildCandidateCollectionJs(args: CandidateCollectionArgs): string {
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

/** ADR §1.2 D4 actionability gate. */
export function isActionable(n: ClickableNode): boolean {
  return n.visible && n.enabled && n.receivesEvents;
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
 */
export function decideActionTarget(facts: CandidateFacts[], totalMatches: number): ResolveDecision {
  const resolved = facts.map((f) => {
    const c = climbToClickable(f);
    return { f, clickable: c?.node ?? null, depth: c?.depth ?? -1, actionable: c ? isActionable(c.node) : false };
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
