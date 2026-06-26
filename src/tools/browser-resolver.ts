/**
 * browser-resolver.ts — ADR-023 resolver core.
 *
 * The shared injected-JS builder for semantic element resolution. Extracts the
 * candidate-collection IIFE from browser_search so `browser_search` stays
 * bit-equal (snapshot-pinned by
 * tests/unit/browser-resolver-candidate-collection.test.ts) while actionability /
 * ancestor climb / physical-coord resolution are layered on top for
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
   * top-N cap, so the count + candidates reflect the role-filtered pool. The role
   * is checked against the matched element OR any ancestor within CLIMB_MAX_DEPTH
   * (the same climb the decision performs), so a button whose visible label is
   * wrapped in a child element (`<div role="button"><span>Save</span></div>`,
   * the common SPA shape) still matches — the filter targets the climb's
   * actionable target, not the matched leaf.
   */
  role?: string;
  /**
   * ADR-023 Phase 2b: when true, the gather ALSO embeds page-level `ModalFacts`
   * (for `detectModal`) + a per-candidate `occludedByDialogIndex` (which modal
   * dialog/backdrop, if any, occludes the candidate). Set only for `action:'click'`
   * (the modal-blocking preflight); `action:'fill'` leaves it off so the fill
   * gather stays bit-equal with the Phase 1 snapshot.
   */
  includeModal?: boolean;
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
/**
 * Shared injected-JS fragment: candidate matching body + score-desc top-N pool
 * (role-filtered). Emits through `const top = pool.slice(0, N)`, leaving
 * `filtered` / `matchScore` / `matchedByMap` / `N` / `D` / `pool` / `top` in
 * scope. Both the gather builder (buildActionCandidateFactsJs) and the fill-act
 * builder (buildFillActJs) embed this verbatim then append their own tail — a
 * single source for the role filter + top-N cap. Re-running it in the fill-act
 * eval re-selects the SAME top[index] deterministically (same querySelectorAll
 * order + scoring), so by-axis fill needs no selector/coordinate re-identification
 * (avoids re-non-uniqueness; plan §S5).
 */
function candidatePoolJs(args: ActionFactsArgs): string {
  const { by, pattern, scope, caseSensitive, role } = args;
  // maxResults/offset are unused by the tails (they take top-N of the full sorted
  // set); fixed values keep the shared body's interpolation total. The resolver
  // always collects visible elements and lets receivesEvents gate the viewport.
  return `${candidateMatchingBodyJs({ by, pattern, scope, maxResults: 200, offset: 0, visibleOnly: true, inViewportOnly: false, caseSensitive })}
  // ── ADR-023 Phase 1: action-target candidate pool (top-N, role-filtered). ──
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
  // The role filter targets the ACTIONABLE element (the climb resolves to a
  // clickable ancestor up to D), NOT the matched leaf. by:'text'/'regex' record
  // the element whose DIRECT text node matches — for a SPA button that wraps its
  // label in a child (<div role="button"><span>Save</span></div>) that leaf is a
  // role-less span, so a leaf-only role check drops every such button (real GSC
  // dogfood: by:'text'+role:'button' returned total:0). Match the role against the
  // leaf OR any ancestor within the SAME CLIMB_MAX_DEPTH the decision climbs, so
  // the role filter and the climb agree. The decision/climb logic is unchanged —
  // this only widens the pre-top-N pool (decideActionTarget still resolves /
  // dedupes by the climbed clickable's rect).
  function roleMatchesChain(el) {
    let node = el;
    for (let d = 0; node && d <= D; d++) {
      if (roleMatches(node)) return true;
      node = node.parentElement;
    }
    return false;
  }
  const pool = roleFilter ? filtered.filter(function(e) { return roleMatchesChain(e.el); }) : filtered;
  const top = pool.slice(0, N);`;
}

export function buildActionCandidateFactsJs(args: ActionFactsArgs): string {
  // ADR-023 Phase 2b: click-only modal block (kept off for fill so its gather +
  // the Phase 1 snapshot stay bit-equal). __modal = page-level ModalFacts;
  // __occludedDialogIndexForEl maps a candidate to the modal/backdrop occluding it.
  const modalSetup = args.includeModal
    ? `
  const __modal = ${buildPageLevelModalFactsJs()};
${occluderIndexHelperJs()}`
    : "";
  const occFact = args.includeModal ? `,
      occludedByDialogIndex: __occludedDialogIndexForEl(el)` : "";
  const modalReturn = args.includeModal ? `
    modalFacts: __modal,` : "";
  return `${candidatePoolJs(args)}${modalSetup}

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
    // :disabled is ancestor-aware — a control inside <fieldset disabled> has
    // el.disabled === false but is functionally disabled (Codex Round 2 P2).
    let disabled;
    try { disabled = el.matches(':disabled'); } catch (e) { disabled = !!el.disabled; }
    const enabled = !disabled && el.getAttribute('aria-disabled') !== 'true';
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
      // Role-filter match for THIS node (uses the same roleMatches predicate that
      // builds the pool, so input type is available). true when no role filter is
      // set. decideActionTarget gates the climb-resolved clickable on this so a
      // role-constrained action never resolves to a wrong-role ancestor (the climb
      // picks the NEAREST strong clickable, which the chain-aware pool filter may
      // have admitted via a FARTHER role-matching ancestor — e.g. role:'button'
      // with an <a> nested in a div[role=button]).
      roleMatch: roleFilter ? roleMatches(el) : true,
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
      containerHint: hintOf(el)${occFact},
    };
  });

  return {
    total: pool.length,
    returned: factsList.length,
    viewport: { screenX: sx, screenY: sy, dpr: dpr, chromeH: chromeH, chromeW: chromeW, innerWidth: window.innerWidth, innerHeight: window.innerHeight },
    candidates: factsList,${modalReturn}
  };
})()
`;
}

/**
 * Build the injected-JS IIFE that ACTS on a by-axis fill target (browser_fill
 * by-axis, plan §S5 — the 2nd eval: gather→decide ran in node, this acts). It
 * re-runs the SAME candidate matching/pool as the gather eval (deterministic —
 * identical querySelectorAll order + scoring), re-selects `top[index]`, climbs
 * `climbDepth` ancestors to the resolved element, verifies it is fillable
 * (input / textarea / contenteditable), focuses it, sets the value via the native
 * prototype setter + dispatches InputEvent/'change' (React/Vue-compatible — the
 * same path as the selector fill), and reads `element.value` back.
 *
 * Re-gather+index is used (NOT a fresh querySelector or an elementFromPoint
 * coordinate re-find) so a GSC dynamic class cannot re-match differently
 * (re-non-uniqueness) and an overlay cannot be mis-targeted (occlusion). Returns
 * `{ ok:true, actual, fullActualLen, fullMatches }` or `{ ok:false, error }`
 * (index_out_of_range / resolved_element_lost / not_fillable). Pinned by snapshot.
 */
export function buildFillActJs(
  args: ActionFactsArgs,
  index: number,
  climbDepth: number,
  value: string,
  expect: { name: string; role: string | null; ariaLabel: string | null; tag: string; total: number },
): string {
  return `${candidatePoolJs(args)}
  // ── ADR-023 Phase 1 PR4: by-axis fill ACT (deterministic re-gather + index). ──
  // IDENTITY GATE (Codex P1): the re-gather assumes the DOM is unchanged since the
  // resolve eval. If it mutated (a matching field inserted/removed/reordered),
  // top[index] could be a DIFFERENT field — a silent mis-fill. Verify the matched
  // element's identity (pool count + name/role/ariaLabel/tag of top[index] before
  // climb) against what resolve saw; on mismatch fail (the agent re-resolves) and
  // NEVER write.
  if (pool.length !== ${expect.total}) return { ok: false, error: 'identity_changed', detail: 'candidate_count' };
  if (top.length <= ${index}) return { ok: false, error: 'index_out_of_range' };
  const matched = top[${index}].el;
  const mName = elText(matched);
  const mRole = matched.getAttribute('role') || null;
  const mAria = matched.getAttribute('aria-label') || null;
  const mTag = matched.tagName.toLowerCase();
  if (mName !== ${JSON.stringify(expect.name)} || mRole !== ${JSON.stringify(expect.role)} || mAria !== ${JSON.stringify(expect.ariaLabel)} || mTag !== ${JSON.stringify(expect.tag)}) {
    return { ok: false, error: 'identity_changed', detail: 'signature' };
  }
  let el = matched;
  for (let d = 0; d < ${climbDepth} && el; d++) el = el.parentElement;
  if (!el) return { ok: false, error: 'resolved_element_lost' };

  const tag = el.tagName;
  const ty = (el.getAttribute('type') || '').toLowerCase();
  // Text-entry controls only. Exclude non-text input types (Codex P1): type=file
  // THROWS on a non-empty .value assignment; checkbox/radio/button/submit/reset/
  // image/range/color/hidden ignore a value string (a false-positive "filled") or
  // are not text targets. Same exclusion as the 'textbox' role filter.
  const isTextInput = tag === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/.test(ty);
  const isTextArea = tag === 'TEXTAREA';
  const isEditable = el.isContentEditable === true;
  if (!isTextInput && !isTextArea && !isEditable) {
    return { ok: false, error: 'not_fillable', tag: tag.toLowerCase() + (ty ? '[type=' + ty + ']' : '') };
  }

  el.focus();
  const val = ${JSON.stringify(value)};
  if (isTextInput || isTextArea) {
    if (typeof el.select === 'function') el.select();
    let proto = null;
    if (tag === 'INPUT') proto = HTMLInputElement.prototype;
    else if (tag === 'TEXTAREA') proto = HTMLTextAreaElement.prototype;
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (descriptor && descriptor.set) descriptor.set.call(el, val);
    else el.value = val;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const fullActual = el.value !== undefined ? el.value : '';
    return { ok: true, actual: (fullActual || '').slice(0, 100), fullActualLen: fullActual.length, fullMatches: fullActual === val };
  }
  // contenteditable
  el.textContent = val;
  el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: val }));
  const fullActual = el.textContent || '';
  return { ok: true, actual: (fullActual || '').slice(0, 100), fullActualLen: fullActual.length, fullMatches: fullActual === val };
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
  /** not `:disabled` (ancestor-aware — includes `<fieldset disabled>` descendants) and `aria-disabled !== "true"` */
  enabled: boolean;
  /** `document.elementFromPoint(center)` hit is this node or a descendant (not occluded) */
  receivesEvents: boolean;
  /**
   * Role-filter match for this node: `false` ONLY when a `role` filter was given
   * AND this node's role does not satisfy it (computed in the gatherer via the
   * same `roleMatches` predicate that builds the pool, so input `type` is
   * available). `undefined`/`true` otherwise (no filter, or a match).
   * `decideActionTarget` gates the climb-resolved clickable on `roleMatch !==
   * false`, so a role-constrained action never resolves to a wrong-role ancestor:
   * the chain-aware pool filter admits a candidate when ANY ancestor within D
   * matches the role, but the climb resolves to the NEAREST strong clickable —
   * which may be a different-role element (an `<a>` nested in a div[role=button]).
   * Without the gate, role:'button' could silently click that link.
   */
  roleMatch?: boolean;
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
  /**
   * ADR-023 Phase 2b (click gather only, `includeModal`): index into
   * `ModalFacts.dialogCandidates` of the modal dialog/backdrop occluding this
   * candidate's center, or null. Absent on the fill gather.
   */
  occludedByDialogIndex?: number | null;
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
  /** ADR-023 Phase 2b: page-level modal facts (present only on the click gather, `includeModal`). */
  modalFacts?: ModalFacts;
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
      // Role gate: the climb resolves to the nearest strong clickable, but the
      // chain-aware pool filter may have admitted this candidate via a FARTHER
      // role-matching ancestor. If the resolved clickable does not itself satisfy
      // the role filter (roleMatch === false), it is NOT actionable — a role-
      // constrained action must stop (noActionable) rather than silently act on a
      // wrong-role element (e.g. role:'button' resolving to an <a> nested in a
      // div[role=button]). roleMatch is undefined when no role filter was set.
      actionable: c ? isActionable(c.node, requireReceivesEvents) && c.node.roleMatch !== false : false,
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
// resolveBrowserActionTarget — the impure wrapper (gather eval → pure decide).
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
  /**
   * Override the receivesEvents (occlusion / in-viewport hit-test) gate. Default
   * derives from `action` (`action !== "fill"`). The selector actionability
   * rescue's scrollIntoView two-pass (issue #441) passes `false` on its 1st pass
   * to identify the unique visible candidate even when it is off-viewport, then
   * scrolls it in and re-resolves with the default gate. Applied via
   * nullish-coalescing so the fill default (false) is preserved when unset.
   */
  requireReceivesEvents?: boolean;
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
      /**
       * Identity of the MATCHED element (chain[0], i.e. top[index] before climb) +
       * the candidate-pool total. A by-axis fill re-gathers in a 2nd eval and must
       * verify this identity still holds at top[index] before writing — otherwise a
       * DOM mutation between resolve and act could silently mis-fill a different
       * field (Codex PR4 P1). Click does not need it (it acts by physical coords).
       */
      matched: { name: string; role: string | null; ariaLabel: string | null; tag: string; total: number };
    }
  | { kind: "ambiguous"; total: number; returned: number; truncated: boolean; candidates: AmbiguityCandidate[]; next: string[] }
  | {
      kind: "noActionable";
      total: number;
      returned: number;
      truncated: boolean;
      candidates: AmbiguityCandidate[];
      next: string[];
      /**
       * ADR-023 Phase 2b (click only): page-level modal facts + the top
       * candidate's occluding dialog index, propagated from the gather so the
       * handler can upgrade a modal-occluded noActionable to BrowserModalBlocking
       * (Round 3 P1-R3-1 plumbing). Added ONLY on this outcome (`ResolveDecision`
       * is unchanged); absent for fill / non-modal gathers.
       */
      modalFacts?: ModalFacts;
      occludedTopByDialogIndex?: number | null;
    }
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
    // ADR-023 Phase 2b: only the click path needs the modal-blocking preflight;
    // fill leaves it off so its gather stays bit-equal with the Phase 1 snapshot.
    includeModal: args.action === "click",
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
    // nullish-coalescing: an explicit requireReceivesEvents wins; otherwise the
    // per-action default (fill = false, click = true). Issue #441 rescue 1st pass
    // passes false to resolve an off-viewport candidate before scrolling it in.
    requireReceivesEvents: args.requireReceivesEvents ?? (args.action !== "fill"),
  });
  if (decision.kind === "resolved") {
    // Identity of the matched element (chain[0] = top[index] before climb) so a
    // by-axis fill can verify the 2nd-eval re-gather still points at the same
    // field before writing (Codex PR4 P1). decideActionTarget.target.index is a
    // facts index, so gathered.candidates[index] is that matched candidate.
    const f = gathered.candidates[decision.target.index];
    return {
      kind: "resolved",
      index: decision.target.index,
      rect: decision.target.rect,
      physical: physicalPoint(decision.target.rect, gathered.viewport),
      climbDepth: decision.target.climbDepth,
      viewport: gathered.viewport,
      matched: {
        name: f?.name ?? "",
        role: f?.role ?? null,
        ariaLabel: f?.ariaLabel ?? null,
        tag: f?.chain?.[0]?.tag ?? "",
        total: gathered.total,
      },
    };
  }
  // ADR-023 Phase 2b: propagate modal facts onto the noActionable outcome so the
  // handler can run detectModal + match the top candidate's occluding dialog
  // against the modal blocker (Round 3 P1-R3-1). Reconstruct the outcome (decision
  // is a ResolveDecision, which has no modal fields) — ResolveDecision stays
  // unchanged; only ResolveActionOutcome.noActionable carries these (Round 4 P1).
  if (decision.kind === "noActionable" && gathered.modalFacts) {
    // Use the TOP candidate (score order) as the representative occluded target
    // (plan §2.4). If the top candidate is not modal-occluded but a lower-ranked
    // one is, the handler degrades to the plain BrowserNoActionableTarget (a
    // fail-safe direction — never a false modal stop). The common case (the
    // intended target is the top match and a modal covers it) escalates correctly.
    return {
      ...decision,
      modalFacts: gathered.modalFacts,
      occludedTopByDialogIndex: gathered.candidates[0]?.occludedByDialogIndex ?? null,
    };
  }
  return decision;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #441 — selector actionability rescue: scroll a resolved candidate into
// view BY ITS POOL INDEX (the scrollIntoView two-pass). A viewport rect alone
// cannot be scrolled: `.scrollIntoView()` needs the live DOM node, and an
// off-viewport element is not reachable via elementFromPoint. So we re-run the
// SAME deterministic candidate pool as the resolve gather (identical
// querySelectorAll order + scoring via candidatePoolJs), re-select `top[index]`,
// and scroll the live node — which honours nested scroll containers, unlike a
// window-only scroll. Same re-gather+index DETERMINISM as buildFillActJs — but
// (unlike fill) NO identity gate: scroll is best-effort and writes nothing, and
// the caller's 2nd resolve pass re-gathers + re-gates actionability fresh, so a
// DOM mutation between resolve and scroll degrades to a wasted scroll + a
// noActionable+candidates stop (safe), never a wrong action.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the injected-JS IIFE that scrolls the resolved candidate `top[index]`
 * into view (`scrollIntoView({block:'center', inline:'nearest', behavior:'instant'})`,
 * parity with `scrollSelectorIntoViewIfNeeded`). Returns `{ ok }` or
 * `{ ok:false, error }`. Snapshot-exempt (not a browser_search builder).
 */
export function buildScrollToCandidateJs(args: ActionFactsArgs, index: number): string {
  return `${candidatePoolJs(args)}
  // ── Issue #441: scroll resolved candidate top[index] into view by re-gather+index. ──
  if (top.length <= ${index}) return { ok: false, error: 'index_out_of_range' };
  const el = top[${index}].el;
  if (!el || !el.isConnected) return { ok: false, error: 'candidate_lost' };
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  return { ok: true };
})()
`;
}

/** Args subset the candidate pool needs to re-gather deterministically (no action/port). */
export interface ScrollCandidateArgs {
  by: "text" | "regex" | "role" | "ariaLabel" | "selector";
  pattern: string;
  scope?: string;
  caseSensitive?: boolean;
  role?: string;
}

/**
 * Scroll a resolved selector-rescue candidate into view by its pool index, then
 * settle ~250ms so the layout stabilises before the caller's 2nd resolve pass
 * re-runs the receivesEvents hit-test. Best-effort: a failed scroll just means
 * the 2nd pass may still report `noActionable` (the caller surfaces that with
 * candidates). Mirrors `scrollSelectorIntoViewIfNeeded`'s settle.
 */
export async function scrollResolvedCandidateIntoView(
  args: ScrollCandidateArgs,
  index: number,
  tabId: string | null,
  port: number,
): Promise<void> {
  try {
    await evaluateInTab(
      buildScrollToCandidateJs(
        { by: args.by, pattern: args.pattern, scope: args.scope, caseSensitive: args.caseSensitive ?? false, role: args.role },
        index,
      ),
      tabId,
      port,
    );
    await new Promise<void>((r) => setTimeout(r, 250));
  } catch {
    /* best-effort scroll — the 2nd resolve pass gates actionability */
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ADR-023 Phase 2 (modal detection) — PR-2a observe route.
// Plan: desktop-touch-mcp-internal:docs/adr-023-phase-2-modal-plan.md §2.1-2.4.
//
// Same gather/decide split as Phase 1 (§2.bis): a self-contained injected-JS
// gatherer (`buildPageLevelModalFactsJs`) collects page-level structural modal
// signals (NO DOM access in TS), and a pure `detectModal(facts)` classifies them
// (node-unit testable). Signals are structural (ARIA / <dialog> / inert /
// scroll-lock / geometry / focus) — never class-name heuristics (plan §5.1).
// PR-2b adds the by-axis/selector preflight (occluder linkage, blockerDialogIndex
// matching); PR-2a wires only the `browser_overview` observe section.
// ───────────────────────────────────────────────────────────────────────────

/** One dialog/overlay candidate's structural modal signals (gathered by injected JS). */
export interface DialogFacts {
  /** explicit `role` attribute, lowercased; null when absent */
  role: string | null;
  /** lowercased tagName */
  tag: string;
  /** `aria-modal="true"` */
  ariaModal: boolean;
  /** native `<dialog>` in MODAL state (open && `:modal` = showModal, not `.show()`) */
  nativeDialogOpen: boolean;
  /** accessible name (aria-label / aria-labelledby / inner heading); capped to 80 */
  name: string;
  /** display/visibility/opacity not hiding it AND size > 0 */
  visible: boolean;
  /** viewport rect (CSS px), rounded */
  rect: RectXYWH;
  /** (rect ∩ viewport) / viewport area, 0-1 */
  viewportCoverage: number;
  /** has a CSS transform AND is fully outside the viewport (parked/animating drawer) */
  offscreenTransform: boolean;
  /** computed z-index, numeric (auto → 0) */
  zIndex: number;
  /** self/nearest-ancestor landmark role (navigation|complementary|main|...); null when none */
  landmarkRole: string | null;
  /** a viewport-covering fixed/absolute backdrop layer is associated, OR native `:modal` */
  hasBackdrop: boolean;
  /** a body-level sibling subtree (not containing this dialog) is `inert` / `aria-hidden` */
  siblingsInert: boolean;
}

/** Page-level modal signals (gathered once per page by `buildPageLevelModalFactsJs`). */
export interface ModalFacts {
  viewport: { innerWidth: number; innerHeight: number };
  /** `overflow`/`overflowY` of html or body is hidden/clip (modal scroll-lock) */
  bodyScrollLock: boolean;
  /** focused element + whether it sits inside any dialog candidate (focus-trap approximation) */
  activeElement: { tag: string; role: string | null; inDialogCandidate: boolean } | null;
  /** dialog/overlay candidates (small set: [role=dialog|alertdialog], [aria-modal], <dialog>) */
  dialogCandidates: DialogFacts[];
}

/** `detectModal` verdict — observe field (`{isModal, blocker?, signals}`) + internal preflight handle. */
export interface ModalVerdict {
  isModal: boolean;
  /** present only when isModal — native `BlockingElementInfo`-aligned shape (public) */
  blocker?: {
    /** dialog accessible name; "modal" when empty (always non-empty, native parity) */
    name: string;
    /** 'dialog' | 'alertdialog' (concrete for browser; native is often 'unknown') */
    role: string;
  };
  /**
   * INTERNAL (not serialized to the public observe section): index into
   * `ModalFacts.dialogCandidates` of the chosen blocker. PR-2b's by-axis preflight
   * matches `occludedTopByDialogIndex === blockerDialogIndex` (index identity beats
   * name/role when several / same-named dialogs exist — Codex P1-1).
   */
  blockerDialogIndex?: number;
  /**
   * why — machine-readable, for testability + threshold tuning (plan §2.3).
   * Provenance: signals are read from the chosen blocker (when isModal), else
   * from the topmost visible candidate (a "why not modal" snapshot); when no
   * candidate exists every per-candidate signal is false.
   */
  signals: {
    ariaModal: boolean;
    alertdialog: boolean;
    nativeDialogOpen: boolean;
    backdrop: boolean;
    scrollLock: boolean;
    siblingsInert: boolean;
    focusInside: boolean;
    viewportCoverage: number;
    /** drawer-exclusion suppressed a candidate from being modal (AC-7 evidence) */
    drawerExcluded: boolean;
  };
}

/**
 * Minimum viewport coverage for the no-strong-signal CSS-modal rescue (rule 4).
 * Tiebreaker/gate only — NOT a counted auxiliary signal (Round 2 P2-R2-2: backdrop
 * + high coverage alone is a cookie-wall / loading-splash, not a modal). Calibrated
 * against the fixture corpus then frozen (OQ-P2-c).
 */
export const MODAL_COVERAGE_THRESHOLD = 0.5;
/** K — minimum modal-BEHAVIOR signals (scroll-lock / inert / focus-inside) for rule 4 rescue. */
export const MODAL_RESCUE_MIN_BEHAVIOR_SIGNALS = 1;
/**
 * A backdrop-backed `role=dialog` candidate whose viewport coverage is below this
 * is treated as a drawer/side-panel (drawer-exclusion), not a modal — so
 * `drawerExcluded` correctly reflects the exclusion. Real GSC dogfood (2026-05-24):
 * its `role="dialog"` "navigational drawer" has `hasBackdrop:true` but only ~0.18
 * coverage, `aria-modal:false`, `landmark:null` — it slipped past the landmark
 * drawer signals and was only declined by the rescue coverage gate, so
 * `drawerExcluded` read false. A non-strong, backdrop-backed, low-coverage dialog
 * is a side panel (a real modal with a backdrop covers far more). Strong-signal
 * modals (aria-modal / alertdialog / native showModal) are unaffected — rule 2
 * classifies them before drawer exclusion. Below the rescue threshold (0.5).
 */
export const MODAL_DRAWER_MAX_COVERAGE = 0.35;

/**
 * Self-contained injected-JS IIFE (no outer-helper dependency — embeds verbatim
 * into both `browser_overview`'s eval and, in PR-2b, the resolver gather; plan
 * §2.2 P1-R2-1). Returns `ModalFacts`. Structural signals only.
 */
export function buildPageLevelModalFactsJs(): string {
  return `(function() {
  try {
  const VW = window.innerWidth, VH = window.innerHeight;
  const vpArea = Math.max(1, VW * VH);
  function num(z) { const n = parseInt(z, 10); return isNaN(n) ? 0 : n; }
  function rectOf(el) { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
  function coverage(r) {
    const ix = Math.max(0, Math.min(r.x + r.w, VW) - Math.max(r.x, 0));
    const iy = Math.max(0, Math.min(r.y + r.h, VH) - Math.max(r.y, 0));
    return Math.round((ix * iy) / vpArea * 100) / 100;
  }
  function nameOf(el) {
    let n = (el.getAttribute('aria-label') || '').trim();
    if (!n) {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) { const ref = document.getElementById(lb.split(/\\s+/)[0]); if (ref) n = (ref.textContent || '').trim(); }
    }
    if (!n) { const h = el.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]'); if (h) n = (h.textContent || '').trim(); }
    return n.replace(/\\s+/g, ' ').slice(0, 80);
  }
  const LANDMARK_RE = /^(navigation|complementary|main|banner|contentinfo|search|form|region)$/;
  function landmarkOf(el) {
    let node = el, guard = 0;
    while (node && node !== document.body && guard < 6) {
      const rr = ((node.getAttribute && node.getAttribute('role')) || '').toLowerCase();
      if (LANDMARK_RE.test(rr)) return rr;
      const tg = node.tagName ? node.tagName.toLowerCase() : '';
      if (tg === 'nav') return 'navigation';
      if (tg === 'aside') return 'complementary';
      node = node.parentElement; guard++;
    }
    return null;
  }
  function isBackdropLike(el) {
    if (!el || el.nodeType !== 1) return false;
    const cs = window.getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return (r.width * r.height) >= vpArea * 0.8;
  }
  function hasBackdropFor(el) {
    try { if (el.matches(':modal')) return true; } catch (e) {}
    // A viewport-covering fixed/absolute sibling layer (of the dialog or an ancestor
    // up to 4 levels) that does NOT contain the dialog = a backdrop/scrim.
    let node = el, guard = 0;
    while (node && node !== document.body && guard < 4) {
      const parent = node.parentElement;
      if (parent) {
        for (const s of parent.children) {
          if (s === node || s.contains(el)) continue;
          if (isBackdropLike(s)) return true;
        }
      }
      node = parent; guard++;
    }
    return false;
  }
  function siblingsInertFor(el) {
    if (!document.body) return false;
    for (const c of document.body.children) {
      if (c.contains(el)) continue;
      if (c.hasAttribute('inert') || c.getAttribute('aria-hidden') === 'true') {
        const r = c.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
    }
    return false;
  }
  const ae = document.activeElement;
  let activeInDialog = false;
  const cands = [];
  const nodes = document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog');
  for (const el of nodes) {
    const cs = window.getComputedStyle(el);
    const br = el.getBoundingClientRect();
    const rect = rectOf(el);
    const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && br.width > 0 && br.height > 0;
    const tag = el.tagName.toLowerCase();
    let nativeModal = false;
    if (tag === 'dialog' && el.open === true) { try { nativeModal = el.matches(':modal'); } catch (e) { nativeModal = true; } }
    const tr = cs.transform && cs.transform !== 'none';
    const offscreen = !!tr && (rect.x + rect.w <= 0 || rect.x >= VW || rect.y + rect.h <= 0 || rect.y >= VH);
    if (ae && el.contains(ae)) activeInDialog = true;
    cands.push({
      role: (el.getAttribute('role') || '').toLowerCase() || null,
      tag: tag,
      ariaModal: el.getAttribute('aria-modal') === 'true',
      nativeDialogOpen: nativeModal,
      name: nameOf(el),
      visible: visible,
      rect: rect,
      viewportCoverage: coverage(rect),
      offscreenTransform: offscreen,
      zIndex: num(cs.zIndex),
      landmarkRole: landmarkOf(el),
      hasBackdrop: hasBackdropFor(el),
      siblingsInert: siblingsInertFor(el),
    });
  }
  function lock(v) { return v === 'hidden' || v === 'clip'; }
  const htmlCs = document.documentElement ? window.getComputedStyle(document.documentElement) : null;
  const bodyCs = document.body ? window.getComputedStyle(document.body) : null;
  const bodyScrollLock = !!((bodyCs && (lock(bodyCs.overflow) || lock(bodyCs.overflowY))) || (htmlCs && (lock(htmlCs.overflow) || lock(htmlCs.overflowY))));
  return {
    viewport: { innerWidth: VW, innerHeight: VH },
    bodyScrollLock: bodyScrollLock,
    activeElement: ae ? { tag: ae.tagName ? ae.tagName.toLowerCase() : '', role: ((ae.getAttribute && ae.getAttribute('role')) || '').toLowerCase() || null, inDialogCandidate: activeInDialog } : null,
    dialogCandidates: cands,
  };
  } catch (e) {
    // Modal detection must never break browser_overview (Codex P1): degrade to a
    // safe default (isModal:false) on any unexpected DOM error (e.g. no document.body).
    return { viewport: { innerWidth: window.innerWidth || 0, innerHeight: window.innerHeight || 0 }, bodyScrollLock: false, activeElement: null, dialogCandidates: [] };
  }
})()`;
}

/**
 * Pure decision: classify page-level `ModalFacts` into a `ModalVerdict`. No DOM.
 * Evaluation order (plan §2.3, Round 2 P2-R2-3/P2-R2-2):
 *  1. keep visible candidates with non-zero rect.
 *  2. STRONG signal (aria-modal / alertdialog / native modal dialog) → modal,
 *     even for a drawer (an aria-modal drawer IS functionally modal).
 *  3. no strong → positive drawer evidence (navigation/complementary landmark or
 *     offscreen transform) is excluded (drawerExcluded), NOT modal.
 *  4. no strong, non-drawer → backdrop-mandatory rescue: backdrop AND ≥K behavior
 *     signals (scroll-lock / inert / focus-inside) AND coverage ≥ threshold.
 *  5. else not modal (fail-safe).
 * blocker = topmost (z-index → coverage); role defaults to "dialog".
 */
export function detectModal(facts: ModalFacts): ModalVerdict {
  const cands = facts.dialogCandidates.filter((c) => c.visible && c.rect.w > 0 && c.rect.h > 0);
  // focusInside is a PAGE-LEVEL approximation (focus is inside SOME dialog
  // candidate), shared across candidates in behaviorCount — not strict per-
  // candidate focus-trap (plan §2.4 "focus-trap 近似"). Harmless for the dominant
  // single-modal case; a stricter per-candidate trap check is a Phase 3+ option.
  const focusInside = facts.activeElement?.inDialogCandidate ?? false;
  const scrollLock = facts.bodyScrollLock;

  const isStrong = (c: DialogFacts): boolean => c.ariaModal || c.role === "alertdialog" || c.nativeDialogOpen;
  // Drawer / side-panel evidence (only consulted in the no-strong-signal branch):
  // a navigation/complementary landmark, an offscreen-parked transform, OR a
  // backdrop-backed dialog whose coverage is too small to be a real modal (real
  // GSC dogfood — its role=dialog "navigational drawer" has a backdrop but ~0.18
  // coverage, no aria-modal, no landmark). A strong-signal modal never reaches
  // here (rule 2), so this never suppresses a real modal.
  const isDrawer = (c: DialogFacts): boolean =>
    c.landmarkRole === "navigation" ||
    c.landmarkRole === "complementary" ||
    c.offscreenTransform ||
    (c.hasBackdrop && c.viewportCoverage < MODAL_DRAWER_MAX_COVERAGE);
  const behaviorCount = (c: DialogFacts): number =>
    (scrollLock ? 1 : 0) + (c.siblingsInert ? 1 : 0) + (focusInside ? 1 : 0);

  const topmost = (list: DialogFacts[]): DialogFacts | null =>
    list.reduce<DialogFacts | null>((best, c) => {
      if (!best) return c;
      if (c.zIndex !== best.zIndex) return c.zIndex > best.zIndex ? c : best;
      return c.viewportCoverage > best.viewportCoverage ? c : best;
    }, null);

  const idxOf = (c: DialogFacts): number => facts.dialogCandidates.indexOf(c);

  const verdict = (blocker: DialogFacts | null, drawerExcluded: boolean): ModalVerdict => {
    const s = blocker ?? topmost(cands);
    const base = {
      ariaModal: s?.ariaModal ?? false,
      alertdialog: s?.role === "alertdialog",
      nativeDialogOpen: s?.nativeDialogOpen ?? false,
      backdrop: s?.hasBackdrop ?? false,
      scrollLock,
      siblingsInert: s?.siblingsInert ?? false,
      focusInside,
      viewportCoverage: s?.viewportCoverage ?? 0,
      drawerExcluded,
    };
    if (blocker) {
      return {
        isModal: true,
        blocker: { name: blocker.name || "modal", role: blocker.role || "dialog" },
        blockerDialogIndex: idxOf(blocker),
        signals: { ...base, drawerExcluded: false },
      };
    }
    return { isModal: false, signals: base };
  };

  // Rule 2: strong signal wins (drawer exclusion does not override).
  const strong = cands.filter(isStrong);
  if (strong.length > 0) return verdict(topmost(strong), false);

  // Rules 3+4: no strong signal — drawer-exclude, then backdrop-mandatory rescue.
  const rescue = cands.filter(
    (c) =>
      !isDrawer(c) &&
      c.hasBackdrop &&
      behaviorCount(c) >= MODAL_RESCUE_MIN_BEHAVIOR_SIGNALS &&
      c.viewportCoverage >= MODAL_COVERAGE_THRESHOLD,
  );
  if (rescue.length > 0) return verdict(topmost(rescue), false);

  // Rule 5: not modal (fail-safe). drawerExcluded records that we declined a drawer.
  return verdict(null, cands.some(isDrawer));
}

// ───────────────────────────────────────────────────────────────────────────
// ADR-023 Phase 2 (modal detection) — PR-2b preflight occluder linkage.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Self-contained injected-JS fragment defining `__occludedDialogIndexForEl(el)`:
 * given an element, return the index of the modal dialog/backdrop occluding its
 * center (or null). `__mNodes` uses the SAME selector + DOM order as
 * `buildPageLevelModalFactsJs`'s dialogCandidates, so the returned index aligns
 * with `ModalFacts.dialogCandidates` (and `detectModal`'s `blockerDialogIndex`).
 * Backdrop-aware: a target behind a modal is typically occluded by the backdrop/
 * scrim (library modals put it in a sibling element, outside the dialog subtree).
 */
function occluderIndexHelperJs(): string {
  return `  const __mNodes = Array.prototype.slice.call(document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog'));
  function __mBackdrops(d) {
    const out = [];
    let node = d, guard = 0;
    while (node && node !== document.body && guard < 4) {
      const parent = node.parentElement;
      if (parent) {
        for (const s of parent.children) {
          if (s === node || s.contains(d)) continue;
          try {
            const cs = window.getComputedStyle(s);
            if ((cs.position === 'fixed' || cs.position === 'absolute') && cs.display !== 'none' && cs.visibility !== 'hidden') {
              const r = s.getBoundingClientRect();
              if (r.width * r.height >= window.innerWidth * window.innerHeight * 0.8) out.push(s);
            }
          } catch (e) {}
        }
      }
      node = parent; guard++;
    }
    return out;
  }
  const __mBd = __mNodes.map(__mBackdrops);
  function __occluderDialogIndex(hit) {
    if (!hit) return null;
    for (let i = 0; i < __mNodes.length; i++) {
      const d = __mNodes[i];
      if (d === hit || d.contains(hit)) return i;
      const bds = __mBd[i];
      for (let j = 0; j < bds.length; j++) { if (bds[j] === hit || bds[j].contains(hit)) return i; }
    }
    return null;
  }
  function __occludedDialogIndexForEl(el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cx >= window.innerWidth || cy < 0 || cy >= window.innerHeight) return null;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || hit === el || el.contains(hit)) return null;
    return __occluderDialogIndex(hit);
  }`;
}

/**
 * Selector-path modal probe (ADR-023 Phase 2b): for a single CSS selector,
 * gather page-level `ModalFacts` + the dialog index occluding the element's
 * center. Run by the selector click handler ONLY when `getElementScreenCoords`
 * already flagged the target occluded (so this extra eval is the rare path) —
 * `detectModal` (pure TS) then decides whether the occluder is a modal blocker.
 * Reuses the same modal fragments as the by-axis gather (single source of truth).
 */
export function buildModalOccluderProbeJs(selector: string): string {
  return `(function() {
  try {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { found: false };
  const __modal = ${buildPageLevelModalFactsJs()};
${occluderIndexHelperJs()}
  return { found: true, occludedByDialogIndex: __occludedDialogIndexForEl(el), modalFacts: __modal };
  } catch (e) { return { found: false }; }
})()`;
}

export interface SelectorModalProbe {
  modalFacts: ModalFacts;
  occludedByDialogIndex: number | null;
}

/**
 * TS wrapper for `buildModalOccluderProbeJs` — returns null on any failure (CDP
 * error / element gone / unexpected shape) so the caller degrades to its normal
 * non-modal path instead of throwing (a probe failure must never break a click).
 */
export async function probeSelectorModalOcclusion(
  selector: string,
  tabId: string | null,
  port: number,
): Promise<SelectorModalProbe | null> {
  let raw: unknown;
  try {
    raw = await evaluateInTab(buildModalOccluderProbeJs(selector), tabId, port);
  } catch {
    return null;
  }
  const r = raw as { found?: boolean; occludedByDialogIndex?: number | null; modalFacts?: ModalFacts } | null;
  if (!r || r.found !== true || !r.modalFacts) return null;
  return { modalFacts: r.modalFacts, occludedByDialogIndex: r.occludedByDialogIndex ?? null };
}
