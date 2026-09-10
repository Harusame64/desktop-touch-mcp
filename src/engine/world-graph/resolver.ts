import { createHash } from "node:crypto";
import type { UiEntityCandidate } from "../vision-gpu/types.js";
import type {
  UiEntity, UiEntityRole, UiAffordance, AffordanceVerb,
  ExecutorKind, EntitySourceKind, EntityLocator,
} from "./types.js";

const ROLE_ALLOW: ReadonlySet<string> = new Set([
  "button", "textbox", "link", "menuitem", "label",
]);

function normalizeRole(raw?: string): UiEntityRole {
  if (raw && ROLE_ALLOW.has(raw)) return raw as UiEntityRole;
  return "unknown";
}

const AFFORDANCE_MAP: Record<string, { executors: ExecutorKind[]; confidence: number }> = {
  invoke:   { executors: ["uia", "mouse"],          confidence: 0.9  },
  click:    { executors: ["mouse"],                  confidence: 0.8  },
  type:     { executors: ["uia", "cdp", "terminal"], confidence: 0.9  },
  select:   { executors: ["uia", "cdp"],             confidence: 0.85 },
  scrollTo: { executors: ["mouse"],                  confidence: 0.7  },
  read:     { executors: [],                         confidence: 1.0  },
};

function synthesizeAffordances(verbs: string[]): UiAffordance[] {
  return verbs.map((verb) => {
    const m = AFFORDANCE_MAP[verb] ?? { executors: ["mouse"], confidence: 0.5 };
    return {
      verb: verb as AffordanceVerb,
      executors: m.executors,
      confidence: m.confidence,
      preconditions: [],
      postconditions: [],
    };
  });
}

function snapRect(n: number, px = 8): number {
  return Math.round(n / px) * px;
}

/**
 * Derive a cross-source identity key for a candidate.
 *
 * When a `digest` is present (set by CandidateProducer), use it directly — it
 * already incorporates source, targetId, label, and rect bucket.
 *
 * Fallback: omit `source` so that UIA + visual_gpu observations for the same
 * label+rect merge into one entity. Rect is quantized to ±8px to tolerate
 * sub-pixel noise between source integrations.
 */
function candidateKey(c: UiEntityCandidate): string {
  if (c.digest) return c.digest;
  const label = c.label ?? "";
  const rect = c.rect
    ? [snapRect(c.rect.x), snapRect(c.rect.y), snapRect(c.rect.width), snapRect(c.rect.height)].join(",")
    : "norect";
  return createHash("sha1")
    .update(`${c.target.kind}:${c.target.id}|${label}|${rect}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Produce a human-debuggable entityId: "ent_" + 16-char evidence digest.
 * The entityId prefix makes it easy to spot the relationship in logs:
 *   entityId = "ent_" + evidenceDigest
 */
function stableEntityId(key: string): string {
  return `ent_${key}`;
}

/**
 * Build an EntityLocator by merging source-specific fields from all candidates in a group.
 * Each source contributes the fields it knows; merging gives the executor unambiguous routing.
 */
function mergeLocators(candidates: UiEntityCandidate[]): EntityLocator | undefined {
  const loc: EntityLocator = {};
  let any = false;

  for (const c of candidates) {
    // Every provider populates `locator` with the source-specific fields it knows.
    // group is sorted newest-first; spread so the CURRENT (older) entry fills only
    // missing fields — existing (newer) values win. Candidates without a locator
    // (e.g. OCR) contribute no routing fields and are routed to mouse by source.
    if (!c.locator) continue;
    if (c.locator.uia)      { loc.uia      = { ...c.locator.uia,      ...loc.uia      }; any = true; }
    if (c.locator.cdp)      { loc.cdp      = { ...c.locator.cdp,      ...loc.cdp      }; any = true; }
    if (c.locator.terminal) { loc.terminal = { ...c.locator.terminal, ...loc.terminal }; any = true; }
    if (c.locator.visual)   { loc.visual   = { ...c.locator.visual,   ...loc.visual   }; any = true; }
  }

  return any ? loc : undefined;
}

/**
 * Merge UiEntityCandidates from multiple sources into UiEntity objects.
 *
 * - Provisional candidates are excluded (fusion not yet stable).
 * - Candidates sharing the same key (digest or label+rect fallback) are merged.
 * - Sources are unioned; confidence is max; most-recent observedAtMs wins for label/rect.
 */
export function resolveCandidates(
  candidates: UiEntityCandidate[],
  generation: string
): UiEntity[] {
  const valid = candidates.filter((c) => !c.provisional);

  const groups = new Map<string, UiEntityCandidate[]>();
  for (const c of valid) {
    const key = candidateKey(c);
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }

  const entities: UiEntity[] = [];
  for (const [key, group] of groups) {
    group.sort((a, b) => b.observedAtMs - a.observedAtMs);
    const primary = group[0];
    const sources = [...new Set(group.map((c) => c.source as EntitySourceKind))];
    const confidence = Math.max(...group.map((c) => c.confidence));
    const verbSet = new Set<string>();
    for (const c of group) c.actionability.forEach((v) => verbSet.add(v));

    // Issue #296: carry the UIA-side controlType and union of pattern names
    // through to the entity. UIA is the authoritative source for pattern data
    // (CDP / visual lanes don't speak UIA patterns), so we look up the first
    // UIA candidate in the group rather than using `primary` (which could be
    // a non-UIA candidate that happened to be observed more recently).
    const uiaCandidate = group.find((c) => c.source === "uia");
    const controlType = uiaCandidate?.controlType;
    let patterns: string[] | undefined;
    if (uiaCandidate !== undefined) {
      const set = new Set<string>();
      for (const c of group) {
        if (c.source !== "uia") continue;
        for (const p of c.patterns ?? []) set.add(p);
      }
      patterns = [...set];
    }

    // Whose handle this is, in the order the evidence supports.
    //
    // 1. The PRIMARY's own, when it has one. The entity's rect and locator come from that
    //    candidate, so its handle is the one that certainly describes them — a handle borrowed
    //    from another lane is an assumption that both lanes resolved the same window, and a
    //    title-only query against two overlapping same-titled windows is exactly where that fails
    //    (PR 側 codex, 2026-09-10).
    // 2. Otherwise the group's, when every lane that recorded one agrees. This is the case the
    //    previous commit was for: the UIA lane records no handle at all, so a merged uia+ocr entity
    //    lost the handle the OCR capture had resolved whenever the UIA candidate arrived last.
    // 3. Otherwise nothing — and when the reason is DISAGREEMENT, say so. "The lanes named two
    //    different windows" and "nobody looked" are different facts, and they were arriving at the
    //    executor as the same missing field: `coordHwnd` undefined, so the coordinate ladder was
    //    skipped entirely and the remembered point was pressed with no containment and no occlusion
    //    check. Declining to aim had become pressing blind.
    const groupHwnds = [...new Set(group.map((c) => c.originHwnd).filter((h) => h !== undefined))];
    const hwndConflict = groupHwnds.length > 1 && primary.originHwnd === undefined;
    const groupHwnd = primary.originHwnd ?? (groupHwnds.length === 1 ? groupHwnds[0] : undefined);

    const entity: UiEntity = {
      entityId: stableEntityId(key),
      role: normalizeRole(primary.role),
      label: primary.label,
      value: primary.value,
      rect: primary.rect,
      confidence,
      sources,
      affordances: synthesizeAffordances([...verbSet]),
      locator: mergeLocators(group),
      generation,
      evidenceDigest: key,
      // ADR-029 Phase 1: carry the primary candidate's discovery-time target
      // through to the entity so the viewport gate can compare against the
      // origin window's current rect. `target` is required on
      // UiEntityCandidate, so `primary.target` is always present.
      //
      // ADR-036 item 12 — the HANDLE, though, is a fact about the group rather than about whichever
      // lane happened to observe last. `primary` is the most recent candidate and the UIA lane
      // records no handle at all, so a merged uia+ocr entity dropped the handle the OCR capture had
      // resolved whenever the UIA candidate arrived later — a race deciding whether the coordinate
      // ladder runs at all (PR 側 codex, 2026-09-10). Every candidate in a group describes the same
      // element, so any one that resolved a handle answers for all of them.
      origin: groupHwnd !== undefined
        ? { ...primary.target, hwnd: groupHwnd }
        : hwndConflict
          ? { ...primary.target, hwndConflict: true as const }
          : primary.target,
    };
    if (controlType !== undefined) entity.controlType = controlType;
    if (patterns !== undefined) entity.patterns = patterns;
    entities.push(entity);
  }
  return entities;
}
