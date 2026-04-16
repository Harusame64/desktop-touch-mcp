/**
 * DirtyJournal — records uncertainty about fluent state.
 *
 * Native WinEvents and queue-overflow conditions write to this journal.
 * The journal does NOT write fluent values. It records that something
 * MIGHT have changed so that a subsequent sensor refresh can resolve the truth.
 *
 * Pure class — no OS imports.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Semantic property names that native events can dirty.
 * The set is deliberately small: only properties trackable by WinEvent without
 * a full EnumWindows scan.
 */
export type DirtyProp =
  | "target.exists"
  | "target.identity"
  | "target.title"
  | "target.rect"
  | "target.zOrder"
  | "target.foreground"
  | "modal.above"
  | "stable.rect";

/**
 * Severity tiers for dirty entries.
 *
 * - `hint`: a single low-confidence event; cheap Win32 read likely sufficient.
 * - `structural`: show/hide/destroy; identity or existence may have changed.
 * - `identityRisk`: destroy + show same hwnd; re-verify identity before acting.
 * - `global`: queue overflow; all tracked lenses are affected; EnumWindows needed.
 */
export type DirtySeverity = "hint" | "structural" | "identityRisk" | "global";

export interface DirtyEntry {
  /** Fluent store entity key prefix, e.g. `window:12345` or `browserTab:tab-1`. */
  entityKey: string;
  /** Properties that are dirty for this entity. */
  props: Set<DirtyProp | string>;
  /** Human-readable causes that contributed to this entry (coalesced). */
  causes: string[];
  /** Monotonic time of the first event that created this entry. */
  firstEventAtMonoMs: number;
  /** Monotonic time of the most recent event that touched this entry. */
  lastEventAtMonoMs: number;
  /** Total number of raw events coalesced into this entry. */
  eventCount: number;
  /** Severity of the most-severe event seen. */
  severity: DirtySeverity;
  /** Source event timestamp range (diagnostic only, not comparable to monotonic). */
  sourceEventTimeMinMs?: number;
  sourceEventTimeMaxMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Severity ordering
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<DirtySeverity, number> = {
  hint: 0,
  structural: 1,
  identityRisk: 2,
  global: 3,
};

function maxSeverity(a: DirtySeverity, b: DirtySeverity): DirtySeverity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

// ─────────────────────────────────────────────────────────────────────────────
// DirtyJournal
// ─────────────────────────────────────────────────────────────────────────────

export class DirtyJournal {
  private _entries = new Map<string, DirtyEntry>();
  private _globalDirty = false;
  private _globalDirtyAtMonoMs = 0;
  private _globalDirtyCause = "";

  /**
   * Mark one or more properties of an entity as dirty.
   * Coalesces with any existing entry for the same entity.
   */
  mark(params: {
    entityKey: string;
    props: (DirtyProp | string)[];
    cause: string;
    monoMs: number;
    severity?: DirtySeverity;
    sourceEventTimeMs?: number;
  }): void {
    const { entityKey, props, cause, monoMs, severity = "hint", sourceEventTimeMs } = params;
    const existing = this._entries.get(entityKey);

    if (existing) {
      for (const p of props) existing.props.add(p);
      if (!existing.causes.includes(cause)) existing.causes.push(cause);
      existing.lastEventAtMonoMs = monoMs;
      existing.eventCount++;
      existing.severity = maxSeverity(existing.severity, severity);
      if (sourceEventTimeMs != null) {
        existing.sourceEventTimeMinMs = Math.min(existing.sourceEventTimeMinMs ?? sourceEventTimeMs, sourceEventTimeMs);
        existing.sourceEventTimeMaxMs = Math.max(existing.sourceEventTimeMaxMs ?? sourceEventTimeMs, sourceEventTimeMs);
      }
    } else {
      const entry: DirtyEntry = {
        entityKey,
        props: new Set(props),
        causes: [cause],
        firstEventAtMonoMs: monoMs,
        lastEventAtMonoMs: monoMs,
        eventCount: 1,
        severity,
        ...(sourceEventTimeMs != null && {
          sourceEventTimeMinMs: sourceEventTimeMs,
          sourceEventTimeMaxMs: sourceEventTimeMs,
        }),
      };
      this._entries.set(entityKey, entry);
    }
  }

  /** Mark all tracked entities as dirty (used on raw event queue overflow). */
  markGlobal(cause: string, monoMs: number): void {
    this._globalDirty = true;
    this._globalDirtyCause = cause;
    this._globalDirtyAtMonoMs = Math.max(this._globalDirtyAtMonoMs, monoMs);
    // Also mark the per-entity entries if present
    for (const entry of this._entries.values()) {
      entry.severity = "global";
      if (!entry.causes.includes(cause)) entry.causes.push(cause);
      entry.lastEventAtMonoMs = monoMs;
      entry.eventCount++;
    }
  }

  /** Whether a global dirty mark is currently active. */
  isGlobalDirty(): boolean {
    return this._globalDirty;
  }

  /** Monotonic timestamp of the global dirty mark, or 0 if not dirty. */
  globalDirtyAtMonoMs(): number {
    return this._globalDirtyAtMonoMs;
  }

  /** Clear the global dirty flag (call after a reconciliation sweep). */
  clearGlobal(): void {
    this._globalDirty = false;
    this._globalDirtyAtMonoMs = 0;
    this._globalDirtyCause = "";
  }

  /**
   * Clear dirty marks for specific props of an entity, but only if the provided
   * observation monotonic timestamp is NEWER than the last event that set those props.
   *
   * This preserves the invariant: "an observation clears dirty only if it was
   * taken AFTER the event that caused the invalidation."
   */
  clearFor(entityKey: string, props: (DirtyProp | string)[], observedAtMonoMs: number): void {
    const entry = this._entries.get(entityKey);
    if (!entry) return;

    if (observedAtMonoMs > entry.lastEventAtMonoMs) {
      // Observation is newer — remove the cleared props
      for (const p of props) entry.props.delete(p);
      if (entry.props.size === 0) {
        this._entries.delete(entityKey);
      }
    }
    // If observedAtMonoMs <= lastEventAtMonoMs, the observation predates the
    // most recent event — keep the entry unchanged.
  }

  /** Read-only snapshot of all per-entity dirty entries. */
  entries(): Map<string, DirtyEntry> {
    return this._entries;
  }

  /** Whether there are any dirty entries (including global). */
  hasDirty(): boolean {
    return this._globalDirty || this._entries.size > 0;
  }

  /** All entity keys that have at least one dirty prop. */
  dirtyEntityKeys(): string[] {
    return [...this._entries.keys()];
  }

  /** Reset all state. Only for tests. */
  __resetForTests(): void {
    this._entries.clear();
    this._globalDirty = false;
    this._globalDirtyAtMonoMs = 0;
    this._globalDirtyCause = "";
  }
}
