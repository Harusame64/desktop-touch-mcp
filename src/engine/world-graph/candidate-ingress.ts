/**
 * candidate-ingress.ts — the layer between DesktopFacade.see() and the providers.
 *
 * `SnapshotIngress` reads on every call and remembers nothing (internal #218: it used to serve a
 * target's last read for up to 30 s, and no event said when the window had changed inside).
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
 *   uia_tree_truncated        — the walk ran out of time, or (discover) stopped at its element cap;
 *                               the entities are a prefix of the window
 *   cdp_provider_failed       — CDP evaluateInTab failed or timed out
 *   terminal_provider_failed  — getTextViaTextPattern threw
 *   visual_provider_unavailable — visual GPU lane is a Phase 3 stub
 *   terminal_buffer_empty     — terminal window found but buffer was empty
 *   ingress_fetch_error       — ingress fetchFn threw (nothing was read). Also added by
 *                               `DesktopFacade.see` when a result arrives with no usable
 *                               candidate list, or with entries that are not objects (#161)
 *   no_provider_matched       — target omitted and foreground window could not be resolved
 *   target_window_gone        — target.hwnd names no window any more (internal #211 item 9(3))
 *   window_excluded           — the target is a window excluded from every tool surface (the key
 *                               locker's own); no lane runs (internal #222)
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
   * Carrying it here keeps the aim and the view the same window BY CONSTRUCTION, including from an
   * ingress that remembers: its entry hands back the target its candidates came from, which is the
   * one the lease describes, rather than whatever is in the foreground now.
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
  /**
   * internal #211 — the screen rectangle of the web page the UIA read found (the largest
   * `RootWebArea`: Chrome/Edge's page, an Electron app's content), read from every element the walk
   * returned, named or not. Set by the UIA lane only; the composer uses it to put the page first
   * and to run OCR alongside. Absent means no page was read.
   */
  webArea?: { x: number; y: number; width: number; height: number };
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
   *
   *   **`SnapshotIngress` answers neither since internal #218**: it remembers nothing. An injected
   *   ingress still may, so the values stay. What follows is the history of `staleCache` there.
   *   **A LANE failing is not that**: `settledLane` catches a lane's rejection before the ingress
   *   sees it, so a failed read arrives as `read` with an empty `entities` and
   *   `uia_provider_failed` in `warnings` (measured on real hardware, 2026-09-22, arm D).
   *   **But the fetch itself does reject on a shipped road**: `normalizeTarget` rethrows
   *   `WindowExcludedError` (both rethrows are in compose-providers.ts) before any lane runs, so a window
   *   that is discovered and then becomes excluded serves its remembered entry under this value
   *   (gate 2, 2026-09-22 — an earlier draft of this comment claimed it could not happen at all,
   *   and the tree says otherwise). On that path the exclusion was bypassed by the cache (internal
   *   #160) — the road that went with the fallback in #218 (gate 2).
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
   * No observation at all: the fetch rejected (with nothing remembered), or the ingress is disposed.
   * **A reader that does not recognise a value must treat it as this one** (win2, 2026-09-22: a
   * kind added to an enum falls into whatever the default branch is, and a default on the readable
   * side turns "could not tell" into "fresh" without a word).
   */
  | { from: "unavailable"; observedAtMs?: undefined };

export interface CandidateIngress {
  /** Return candidates + warnings for a target key; `freshness` says whether they were read now. */
  getSnapshot(targetKey: string): Promise<ProviderResult>;
  /** The target changed (an act, a query that found nothing): anything remembered is out of date. */
  invalidate(targetKey: string, reason: IngressReason): void;
  /** Subscribe to invalidation events. Returns an unsubscribe function. */
  subscribe(targetKey: string, cb: () => void): () => void;
  dispose(): void;
}

// ── SnapshotIngress ───────────────────────────────────────────────────────────

/**
 * Default CandidateIngress implementation: every call reads, and nothing is remembered.
 *
 * internal #218 — this used to serve a target's last read for up to 30 s unless an event had marked
 * it dirty. The events it could hear were a window appearing or disappearing and the foreground
 * changing; a change made INSIDE a window by anyone but our own act raised none of them. Measured
 * (win2): a field's text changed from outside, a control destroyed and a window moved were all
 * served from cache (2026-09-12, `dev/lease-cost/RESULTS-warm-cache.md` in the internal repo), and
 * so was an Excel sheet after COM changed its zoom and sheet (2026-09-29). A bare
 * `desktop_discover()` was keyed `window:__default__`, which no window event matches, so after an
 * Alt-Tab it kept serving the window that had been in front. Watching the window's pixels instead
 * does not close it: Excel with `ScreenUpdating` off changes its values without a repaint, a
 * covered part is not on screen, and a sleeping display delivers no frames (win2, 2026-09-29).
 * What the cache saved was 60–350 ms a call (Notepad 65, Explorer 272, Excel 354 read against 2–5
 * cached), and there is no idle cost either way: nothing reads between calls.
 *
 * Nor is the last read kept for a read that throws: the one throw that reached here on a shipped
 * road was `WindowExcludedError`, and handing back the read from before the exclusion was the
 * bypass internal #160 recorded (gate 2). Since internal #222 that is an answer, not a throw.
 */
export class SnapshotIngress implements CandidateIngress {
  private readonly subs = new Map<string, Set<() => void>>();
  private disposed = false;

  constructor(private readonly fetchFn: (targetKey: string) => Promise<ProviderResult>) {}

  async getSnapshot(targetKey: string): Promise<ProviderResult> {
    if (this.disposed) return { candidates: [], warnings: [], freshness: { from: "unavailable" } };
    const now = Date.now();
    try {
      const result = await this.fetchFn(targetKey);
      return { ...result, freshness: { from: "read", observedAtMs: now } };
    } catch (err) {
      console.error(`[candidate-ingress] Fetch error for "${targetKey}":`, err);
      return { candidates: [], warnings: ["ingress_fetch_error"], freshness: { from: "unavailable" } };
    }
  }

  /** Nothing is remembered, so there is nothing to end; subscribers are still told. */
  invalidate(targetKey: string, _reason: IngressReason): void {
    this.subs.get(targetKey)?.forEach((cb) => cb());
  }

  subscribe(targetKey: string, cb: () => void): () => void {
    let set = this.subs.get(targetKey);
    if (!set) { set = new Set(); this.subs.set(targetKey, set); }
    set.add(cb);
    return () => set!.delete(cb);
  }

  dispose(): void {
    this.disposed = true;
    this.subs.clear();
  }
}
