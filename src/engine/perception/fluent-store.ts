/**
 * FluentStore — core data structure for the Reactive Perception Graph.
 * Pure class, no OS imports.
 */

import type { Fluent, Observation } from "./types.js";
import { confidenceFor, isStale, makeEvidence } from "./evidence.js";

function fluentKey(entity: { kind: string; id: string }, property: string): string {
  return `${entity.kind}:${entity.id}.${property}`;
}

export class FluentStore {
  private store = new Map<string, Fluent>();
  private _seq = 0;

  currentSeq(): number { return this._seq; }

  /** Apply a batch of observations. Returns the set of changed fluent keys. */
  apply(observations: Observation[]): { changed: Set<string> } {
    const changed = new Set<string>();
    const nowMs = Date.now();

    for (const obs of observations) {
      this._seq++;
      const key = fluentKey(obs.entity, obs.property);
      const existing = this.store.get(key);

      // TMS-lite: reject if observation is older than current
      if (existing && obs.seq < existing.validFromSeq) continue;

      // Watermark check: if the observation's monotonic timestamp is NOT newer than
      // the last dirty-mark, the evidence predates the invalidation hint — keep dirty.
      const obsMonoMs = obs.monoMs ?? performance.now();
      if (existing?.lastDirtyAtMonoMs != null && obsMonoMs <= existing.lastDirtyAtMonoMs) continue;

      // Same source: newer overrides
      // Different source: higher confidence replaces lower
      if (existing && obs.seq === existing.validFromSeq) {
        const existingConf = confidenceFor(existing.support[0]!, nowMs);
        if (obs.confidence <= existingConf) {
          // Lower-confidence observation — add to contradictions if source differs
          if (obs.evidence.source !== existing.support[0]?.source) {
            existing.contradictions.push(obs.evidence);
          }
          continue;
        }
      }

      const updated: Fluent = {
        entity: obs.entity,
        property: obs.property,
        value: obs.value,
        validFromSeq: obs.seq,
        validFromMonoMs: obsMonoMs,
        confidence: obs.confidence,
        support: [obs.evidence],
        contradictions: existing?.contradictions ?? [],
        status: "observed",
        // Preserve generation across updates (cleared only on identity change)
        ...(existing?.generation != null && { generation: existing.generation }),
      };
      this.store.set(key, updated);
      changed.add(key);
    }

    return { changed };
  }

  read(key: string): Fluent | undefined {
    return this.store.get(key);
  }

  readMany(keys: string[]): Map<string, Fluent> {
    const result = new Map<string, Fluent>();
    for (const k of keys) {
      const f = this.store.get(k);
      if (f) result.set(k, f);
    }
    return result;
  }

  markDirty(keys: string[]): void {
    for (const k of keys) {
      const f = this.store.get(k);
      if (f) f.status = "dirty";
    }
  }

  /**
   * Mark fluents dirty with a cause and monotonic timestamp.
   * The monoMs watermark is used by apply() to decide whether subsequent observations
   * are newer than this invalidation hint.
   */
  markDirtyWithCause(keys: string[], cause: string, monoMs: number, seq?: number): void {
    for (const k of keys) {
      const f = this.store.get(k);
      if (f) {
        f.status = "dirty";
        f.lastDirtyCause = cause;
        f.lastDirtyAtMonoMs = monoMs;
        if (seq != null) f.lastDirtySeq = seq;
      }
    }
  }

  /**
   * Mark fluents as "settling" — used when a move/resize starts.
   * Settling is a soft dirty: the value is becoming invalid due to an in-progress
   * animation or drag. Guards should block on settling rects.
   */
  markSettling(keys: string[], monoMs: number): void {
    for (const k of keys) {
      const f = this.store.get(k);
      if (f) {
        f.status = "settling";
        f.lastDirtyAtMonoMs = monoMs;
        f.lastDirtyCause = "settling";
      }
    }
  }

  markStale(keys: string[]): void {
    for (const k of keys) {
      const f = this.store.get(k);
      if (f) f.status = "stale";
    }
  }

  markInvalidated(keys: string[]): void {
    for (const k of keys) {
      const f = this.store.get(k);
      if (f) f.status = "invalidated";
    }
  }

  /** Sweep entries whose primary evidence TTL has expired. */
  sweepTTL(nowMs: number): string[] {
    const staled: string[] = [];
    for (const [key, fluent] of this.store) {
      const ev = fluent.support[0];
      if (ev && isStale(ev, nowMs) && fluent.status === "observed") {
        fluent.status = "stale";
        staled.push(key);
      }
    }
    return staled;
  }

  keys(): string[] {
    return [...this.store.keys()];
  }

  size(): number { return this.store.size; }

  /** Build an Observation from a raw Win32 read. Convenience for sensors. */
  static buildObservation(
    seq: number,
    hwnd: string,
    property: string,
    value: unknown,
    confidence: number
  ): Observation {
    const nowMs = Date.now();
    return {
      seq,
      tsMs: nowMs,
      source: "win32",
      entity: { kind: "window", id: hwnd },
      property,
      value,
      confidence,
      evidence: makeEvidence("win32", seq, nowMs),
    };
  }

  /** Reset all state. Only for tests. */
  __resetForTests(): void {
    this.store.clear();
    this._seq = 0;
  }
}
