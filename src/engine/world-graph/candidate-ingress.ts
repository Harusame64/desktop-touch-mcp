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
import type { TargetSpec } from "./session-registry.js";
import type { WindowIdentity, AimOrigin } from "../aim.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type IngressReason = "winevent" | "cdp" | "dirty-rect" | "startup" | "cache-miss" | "manual";

/**
 * Result envelope returned by providers and the ingress.
 *
 * Warning codes are stable machine-readable strings (not prose):
 *   uia_provider_failed       — UIA call threw or returned an error
 *   uia_frame_names_synthesized — the window frame came from the MSAA synthesis, so its labels
 *                             are that vocabulary (`Close`, not `閉じる`) — ADR-036
 *   uia_tree_truncated        — the walk ran out of time; the entities are a prefix of the window
 *   cdp_provider_failed       — CDP evaluateInTab failed or timed out
 *   terminal_provider_failed  — getTextViaTextPattern threw
 *   visual_provider_unavailable — visual GPU lane is a Phase 3 stub
 *   terminal_buffer_empty     — terminal window found but buffer was empty
 *   ingress_fetch_error       — ingress fetchFn threw; stale cache returned. Also added by
 *                               `DesktopFacade.see` when a result arrives with no usable
 *                               candidate list, or with entries that are not objects (#161)
 *   no_provider_matched       — target omitted and foreground window could not be resolved
 *   partial_results_only      — primary provider returned 0 entities; fallback used
 */
export interface ProviderResult {
  candidates: UiEntityCandidate[];
  /** Non-fatal diagnostic codes. Empty means all providers succeeded. */
  warnings: string[];
  /**
   * ADR-036 — the target these candidates were actually read from, after resolution.
   *
   * `composeCandidates` resolves what the caller sent (`@active` and a bare call become a handle
   * and a title; a handle alone gains the title) and then reads every provider against THAT. The
   * session used to keep only what the caller sent, so a bare `desktop_discover()` left the write
   * path with no window at all while the view it had just returned described one — measured on the
   * real machine 2026-09-09: providers scoped to `2624042`, session stored `null`, the executor was
   * handed `"@active"` as a title and pressed a remembered coordinate instead.
   *
   * Carrying it here keeps the aim and the view the same window BY CONSTRUCTION, including on a
   * cache hit: a stale entry hands back the target its candidates came from, which is the one the
   * lease describes, rather than whatever is in the foreground now.
   *
   * Optional because a provider that does not resolve anything (a direct `CandidateProvider`, a
   * test double) has nothing to say here, and saying nothing must stay different from saying
   * "no window".
   */
  target?: TargetSpec;
  /**
   * ADR-036 — who owned that window WHEN THESE CANDIDATES WERE READ.
   *
   * Read here rather than when the session stores the result, because on a cache hit those are
   * different moments: a window that closed and had its handle recycled in between would be read
   * at store time as the baseline, the later comparison would answer "same", and the guard would
   * wave through an action against a window nobody discovered (gate 1, 2026-09-09). The identity
   * is evidence about the observation, so it is taken with it and cached with it — the
   * specification files it as a fluent of the entity for the same reason.
   */
  identity?: WindowIdentity;
  /**
   * ADR-036 — whether the identity was LOOKED FOR, as opposed to found.
   *
   * `identity: undefined` has two meanings and they must not be merged: this path does not read
   * identities at all (the direct `CandidateProvider`), or it read and the question could not be
   * answered (no native binding, the window already gone). The first may be repaired by reading
   * one later; the second may NOT — a later read describes whoever owns the handle NOW, which on a
   * cache hit can be the window that inherited it, and recording that as the baseline makes the
   * act-time comparison answer "same" about a stranger (PR 側 codex, 2026-09-09).
   *
   * So the flag says which of the two it is, rather than leaving the reader to infer it from an
   * absence — the same rule the probe had to learn twice today.
   */
  identityRead?: boolean;
  /**
   * ADR-036 item 5 — where that window WAS when these candidates were read, or the fact that it
   * would not hold still while they were being read.
   *
   * Carried with the candidates for the same reason the identity is: every rect in the snapshot is
   * a screen coordinate, and the window origin they were measured against is what makes them
   * meaningful later. Read at store time instead, a cache hit would pair coordinates from one
   * moment with an origin from another, and the correction built on the difference would move the
   * press by a delta that never happened.
   */
  origin?: AimOrigin;
  /**
   * ADR-036 item 8 — see {@link ProviderFreshness}.
   *
   * Named `freshness` rather than `observation` because `desktop_act` already answers with an
   * `observation` of a different shape (`VisualMotionObservation`, ADR-019 Stage 5): one server,
   * one name, two shapes is how a client helper reads `observation.verdict` off the wrong tool and
   * gets `undefined` with no error (gate 2, 2026-09-22).
   *
   * Optional because a direct `CandidateProvider` or a test double has nothing to say here, and
   * **`see()` reads an absent value as "not stated" rather than as "read"** — the same rule
   * `identityRead` exists for, applied to freshness instead of identity.
   */
  freshness?: ProviderFreshness;
}

/**
 * ADR-036 item 8 — whether the candidates in a result were READ for this call, or REMEMBERED.
 *
 * Measured on real hardware (internal #150, win2, 2026-09-21): against a window whose UI thread had
 * been hung for 90 s, `desktop_discover` answered in **4 ms with six entities and a fresh
 * generation**, while the probe recorded **no `provider.read` row at all** — no lane ran. The
 * envelope said nothing a caller could be suspicious of: `stale`, `cached`, `ageMs`, `status` and
 * `observed` were absent from both captures, and the one freshness field that exists (`attention`)
 * answers a different question — whether the UIA cache has passed its TTL, which a hung window
 * inside the TTL has not. Its neighbours are at least slow and empty; this one is fast and full.
 *
 * The ingress already knows the answer — `CacheEntry.fetchedAtMs` — it simply never travelled.
 * Carrying it changes nothing else: nothing is refused, nothing is re-read, no TTL moves.
 */
export type ProviderFreshness =
  /**
   * - `read` — a fetch ran for THIS call and these candidates came back from it. **It does not say
   *   anything looked**: the shipped composition catches a lane's failure inside
   *   (`compose-providers.ts`'s `settledLane`) and the visual lane can replay an earlier snapshot,
   *   so a fetch that resolved is not an observation. What each lane did is in its own
   *   `provider.read` probe row, and `warnings` / `constraints` carry the caller-visible part.
   * - `cache` — the entry was fresh, so nothing was asked; these were read at `observedAtMs`.
   * - `staleCache` — the FETCH ITSELF rejected and the remembered entry was served instead.
   *   **A LANE failing is not that**: `settledLane` catches a lane's rejection before the ingress
   *   sees it, so a failed read arrives as `read` with an empty `entities` and
   *   `uia_provider_failed` in `warnings` (measured on real hardware, 2026-09-22, arm D).
   *   **But the fetch itself does reject on a shipped road**: `normalizeTarget` rethrows
   *   `WindowExcludedError` (`compose-providers.ts:257`, `:277`) before any lane runs, so a window
   *   that is discovered and then becomes excluded serves its remembered entry under this value
   *   (gate 2, 2026-09-22 — an earlier draft of this comment claimed it could not happen at all,
   *   and the tree says otherwise). On that path the exclusion is bypassed by the cache, which is
   *   not this change's doing and is filed separately (internal #160).
   *
   *   **That road is read from source and has never been observed.** Reaching it needs the key
   *   locker's dialog on screen, which means an actual credential capture, so win2 declined to
   *   shoot it and was right to. The three failures they COULD produce without touching
   *   credentials — a hwnd that never existed, a window killed under a live cache entry, and the
   *   same past its TTL — all landed inside a lane, where `settledLane` caught them, and every one
   *   answered `read` with zero entities (2026-09-22). **So this value has never been observed on
   *   real hardware** — three roads tried, not a proof that none exists. (`unavailable` is a
   *   different case: it has two roads right here, `dispose()` and a fetch that throws with no
   *   entry, and a cell exercises the second. It has not been seen on hardware either, which is
   *   not the same as being unreachable.) The shipped description therefore states what to DO with
   *   each value rather than where it comes from.
   */
  | { from: "read" | "cache" | "staleCache"; observedAtMs: number }
  /**
   * No observation at all: the fetch rejected with nothing remembered, or the ingress is disposed.
   * **A reader that does not recognise a value must treat it as this one** (win2, 2026-09-22: a
   * kind added to an enum falls into whatever the default branch is, and a default on the readable
   * side turns "could not tell" into "fresh" without a word).
   */
  | { from: "unavailable"; observedAtMs?: undefined };

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
  /** ADR-036 — the resolved target these candidates describe; see `ProviderResult.target`. */
  target?: TargetSpec;
  /** ADR-036 — the identity read at the same moment; see `ProviderResult.identity`. */
  identity?: WindowIdentity;
  /** ADR-036 — whether it was looked for; see `ProviderResult.identityRead`. */
  identityRead?: boolean;
  /** ADR-036 item 5 — the window origin those candidates were measured against. */
  origin?: AimOrigin;
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
    if (this.disposed) return { candidates: [], warnings: [], freshness: { from: "unavailable" } };
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
    if (fresh) return { candidates: entry!.candidates, warnings: entry!.warnings, target: entry!.target, identity: entry!.identity, identityRead: entry!.identityRead, origin: entry!.origin, freshness: { from: "cache", observedAtMs: entry!.fetchedAtMs } };

    // Cache miss, dirty, or TTL expired → fetch.
    try {
      const result = await this.fetchFn(targetKey);
      this.cache.set(targetKey, {
        candidates: result.candidates,
        warnings: result.warnings,
        target: result.target,
        identity: result.identity,
        identityRead: result.identityRead,
        origin: result.origin,
        fetchedAtMs: now,
        dirty: false,
      });
      return { ...result, freshness: { from: "read", observedAtMs: now } };
    } catch (err) {
      console.error(`[candidate-ingress] Fetch error for "${targetKey}":`, err);
      // Stale cache fallback — mark dirty so next call retries.
      if (entry) {
        entry.dirty = true;
        return { candidates: entry.candidates, warnings: [...entry.warnings, "ingress_fetch_error"], target: entry.target, identity: entry.identity, identityRead: entry.identityRead, origin: entry.origin, freshness: { from: "staleCache", observedAtMs: entry.fetchedAtMs } };
      }
      return { candidates: [], warnings: ["ingress_fetch_error"], freshness: { from: "unavailable" } };
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
