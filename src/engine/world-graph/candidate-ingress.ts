/**
 * candidate-ingress.ts — Event-driven candidate cache layer.
 *
 * Decouples DesktopFacade.see() from pull-based CandidateProvider.
 * Instead of fetching candidates on every see() call, the ingress:
 *   1. Caches candidates per target key
 *   2. Marks cache dirty when events arrive (WinEvent / CDP)
 *   3. Lazily refreshes only the dirty target on the NEXT see() call
 *   4. Never fetches in idle state — zero background polling cost
 *
 * Refresh policy:
 *   - Cache hit + clean + within TTL  → return immediately (0 fetches)
 *   - Cache hit + dirty or expired    → fetch, update cache
 *   - Cache miss (startup / new key)  → fetch (recovery path)
 *   - Fetch error                     → return stale cache, mark dirty for retry
 *
 * Target isolation:
 *   Each key (window:hwnd / tab:id / title:...) has its own cache entry and
 *   subscriber set. An event for key A never touches key B's cache.
 */

import type { UiEntityCandidate } from "../vision-gpu/types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type IngressReason = "winevent" | "cdp" | "dirty-rect" | "startup" | "cache-miss" | "manual";

/**
 * Result envelope returned by providers and the ingress.
 *
 * Warning codes are stable machine-readable strings (not prose):
 *   uia_provider_failed       — UIA call threw or returned an error
 *   cdp_provider_failed       — CDP evaluateInTab failed or timed out
 *   terminal_provider_failed  — getTextViaTextPattern threw
 *   visual_provider_unavailable — visual GPU lane is a Phase 3 stub
 *   terminal_buffer_empty     — terminal window found but buffer was empty
 *   ingress_fetch_error       — ingress fetchFn threw; stale cache returned
 *   no_provider_matched       — target omitted and foreground window could not be resolved
 *   partial_results_only      — primary provider returned 0 entities; fallback used
 */
export interface ProviderResult {
  candidates: UiEntityCandidate[];
  /** Non-fatal diagnostic codes. Empty means all providers succeeded. */
  warnings: string[];
}

export interface CandidateIngress {
  /** Return candidates + warnings for a target key. Refreshes if dirty or expired. */
  getSnapshot(targetKey: string): Promise<ProviderResult>;
  /** Mark a target's cache as dirty. Called by event adapters. */
  invalidate(targetKey: string, reason: IngressReason): void;
  /** Subscribe to invalidation events. Returns an unsubscribe function. */
  subscribe(targetKey: string, cb: () => void): () => void;
  /** Optional: clear the dirty flag after a manual reconciliation. */
  markRecovered?(targetKey: string): void;
  dispose(): void;
}

/**
 * Injectable event source — drains pending events and maps them to target keys.
 * Returns async to allow ESM dynamic imports inside the adapter.
 */
export interface IngressEventSource {
  drain(knownKeys: ReadonlySet<string>): Promise<Iterable<{ key: string; reason: IngressReason }>>;
  dispose(): void;
}

// ── SnapshotIngress ───────────────────────────────────────────────────────────

interface CacheEntry {
  candidates: UiEntityCandidate[];
  warnings: string[];
  fetchedAtMs: number;
  dirty: boolean;
}

export interface SnapshotIngressOptions {
  /** Cache TTL in ms — entries older than this are treated as dirty (default: 30 000). */
  cacheTtlMs?: number;
}

/**
 * Default CandidateIngress implementation.
 *
 * Idle cost: zero — no background timers. Events are drained lazily on each
 * getSnapshot() call. Only dirty/expired entries trigger a refetch.
 */
export class SnapshotIngress implements CandidateIngress {
  private readonly cache     = new Map<string, CacheEntry>();
  private readonly subs      = new Map<string, Set<() => void>>();
  private readonly knownKeys = new Set<string>();
  private readonly cacheTtlMs: number;
  private disposed = false;

  constructor(
    private readonly fetchFn: (targetKey: string) => Promise<ProviderResult>,
    private readonly eventSource?: IngressEventSource,
    opts: SnapshotIngressOptions = {}
  ) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
  }

  async getSnapshot(targetKey: string): Promise<ProviderResult> {
    if (this.disposed) return { candidates: [], warnings: [] };
    this.knownKeys.add(targetKey);

    // Drain events lazily — no background polling needed.
    if (this.eventSource) {
      const pending = await this.eventSource.drain(this.knownKeys);
      for (const { key, reason } of pending) {
        this._markDirty(key, reason);
      }
    }

    const entry = this.cache.get(targetKey);
    const now   = Date.now();
    const fresh = entry && !entry.dirty && (now - entry.fetchedAtMs) < this.cacheTtlMs;
    if (fresh) return { candidates: entry!.candidates, warnings: entry!.warnings };

    // Cache miss, dirty, or TTL expired → fetch.
    try {
      const result = await this.fetchFn(targetKey);
      this.cache.set(targetKey, {
        candidates: result.candidates,
        warnings: result.warnings,
        fetchedAtMs: now,
        dirty: false,
      });
      return result;
    } catch (err) {
      console.error(`[candidate-ingress] Fetch error for "${targetKey}":`, err);
      // Stale cache fallback — mark dirty so next call retries.
      if (entry) {
        entry.dirty = true;
        return { candidates: entry.candidates, warnings: [...entry.warnings, "ingress_fetch_error"] };
      }
      return { candidates: [], warnings: ["ingress_fetch_error"] };
    }
  }

  invalidate(targetKey: string, reason: IngressReason): void {
    this._markDirty(targetKey, reason);
  }

  subscribe(targetKey: string, cb: () => void): () => void {
    let set = this.subs.get(targetKey);
    if (!set) { set = new Set(); this.subs.set(targetKey, set); }
    set.add(cb);
    return () => set!.delete(cb);
  }

  markRecovered(targetKey: string): void {
    const entry = this.cache.get(targetKey);
    if (entry) entry.dirty = false;
  }

  dispose(): void {
    this.disposed = true;
    this.eventSource?.dispose();
    this.cache.clear();
    this.subs.clear();
    this.knownKeys.clear();
  }

  private _markDirty(targetKey: string, _reason: IngressReason): void {
    const entry = this.cache.get(targetKey);
    if (entry) entry.dirty = true;
    this.subs.get(targetKey)?.forEach((cb) => cb());
  }
}

// ── WinEvent adapter ──────────────────────────────────────────────────────────

type WindowEventLike = { hwnd?: string; windowTitle?: string };

/**
 * Match a window event to a TargetSessionKey.
 *
 * `window:{hwnd}` → matched by hwnd equality
 * `title:{title}` → matched by case-insensitive substring
 * `tab:{tabId}`   → not matched (handled by CDP adapter)
 */
export function windowEventMatchesKey(event: WindowEventLike, key: string): boolean {
  if (key.startsWith("window:")) {
    return event.hwnd === key.slice(7);
  }
  if (key.startsWith("title:")) {
    const title = key.slice(6).toLowerCase();
    return typeof event.windowTitle === "string" &&
           event.windowTitle.toLowerCase().includes(title);
  }
  return false;
}

// ── Source composition ────────────────────────────────────────────────────────

/**
 * Combine multiple IngressEventSource instances into one.
 * Each sub-source is drained independently; results are deduplicated by key.
 * If a sub-source throws, it is skipped (graceful degradation — one broken source
 * does not block the others).
 *
 * Composite source preserves target isolation: each sub-source is responsible for
 * only emitting events for keys it recognises.
 */
export function combineEventSources(sources: IngressEventSource[]): IngressEventSource {
  return {
    async drain(knownKeys: ReadonlySet<string>): Promise<Iterable<{ key: string; reason: IngressReason }>> {
      const results: Array<{ key: string; reason: IngressReason }> = [];
      const seen = new Set<string>();

      for (const source of sources) {
        try {
          const events = await source.drain(knownKeys);
          for (const e of events) {
            if (!seen.has(e.key)) {
              seen.add(e.key);
              results.push(e);
            }
          }
        } catch {
          // One broken source never blocks the others.
        }
      }

      return results;
    },

    dispose(): void {
      for (const source of sources) {
        try { source.dispose(); } catch { /* best-effort */ }
      }
    },
  };
}

/**
 * Create an IngressEventSource backed by event-bus.ts.
 *
 * The event-bus runs its own 500ms poll internally. This adapter drains
 * buffered events on demand (inside getSnapshot) — no additional timers.
 *
 * The subscription is created lazily on first drain to avoid importing
 * event-bus during module load (flag-OFF path safety).
 */
export function createWinEventIngressSource(): IngressEventSource {
  let subId: string | null = null;

  async function ensureSubscribed(): Promise<typeof import("../event-bus.js")> {
    const bus = await import("../event-bus.js");
    if (!subId) {
      subId = bus.subscribe(["window_appeared", "window_disappeared", "foreground_changed"]);
    }
    return bus;
  }

  return {
    async drain(knownKeys) {
      if (knownKeys.size === 0) return [];
      try {
        const bus    = await ensureSubscribed();
        const events = bus.poll(subId!);
        const out: Array<{ key: string; reason: IngressReason }> = [];

        for (const event of events) {
          const added = new Set<string>();
          for (const key of knownKeys) {
            if (!added.has(key) && windowEventMatchesKey(event as WindowEventLike, key)) {
              out.push({ key, reason: "winevent" });
              added.add(key);
            }
          }
        }
        return out;
      } catch {
        return [];
      }
    },

    dispose() {
      if (subId) {
        import("../event-bus.js")
          .then((bus) => { bus.unsubscribe(subId!); subId = null; })
          .catch(() => {/* best-effort */});
      }
    },
  };
}
