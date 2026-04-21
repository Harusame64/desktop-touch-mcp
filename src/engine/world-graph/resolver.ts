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
    // Prefer explicit locator from the candidate; fall back to sourceId inference.
    if (c.locator) {
      // group is sorted newest-first; spread so the CURRENT (older) entry fills only
      // missing fields — existing (newer) values win.
      if (c.locator.uia)      { loc.uia      = { ...c.locator.uia,      ...loc.uia      }; any = true; }
      if (c.locator.cdp)      { loc.cdp      = { ...c.locator.cdp,      ...loc.cdp      }; any = true; }
      if (c.locator.terminal) { loc.terminal = { ...c.locator.terminal, ...loc.terminal }; any = true; }
      if (c.locator.visual)   { loc.visual   = { ...c.locator.visual,   ...loc.visual   }; any = true; }
      continue;
    }

    // Legacy sourceId inference (P2-A backward compat bridge — remove in P3).
    // Log a warning so providers that haven't migrated to locator are visible.
    if (c.sourceId && process.env["NODE_ENV"] !== "test") {
      console.warn(`[resolver] entity "${c.label}" from source "${c.source}" uses deprecated sourceId — add locator in P3`);
    }
    if (c.source === "uia" && c.sourceId) {
      if (!loc.uia) { loc.uia = { automationId: c.sourceId, name: c.label }; any = true; }
    } else if (c.source === "cdp" && c.sourceId) {
      if (!loc.cdp) {
        loc.cdp = {
          selector: c.sourceId,
          tabId: c.target.kind === "browserTab" ? c.target.id : undefined,
        };
        any = true;
      }
    } else if (c.source === "visual_gpu" && c.sourceId) {
      if (!loc.visual) { loc.visual = { trackId: c.sourceId, rect: c.rect }; any = true; }
    } else if (c.source === "terminal") {
      // c.target.id for terminal is hwnd/session — use c.label as windowTitle proxy.
      // TODO: add dedicated terminalWindowTitle field on UiEntityCandidate in P3.
      if (!loc.terminal) {
        loc.terminal = { windowTitle: c.label ?? c.target.id };
        any = true;
      }
    }
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

    entities.push({
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
    });
  }
  return entities;
}
