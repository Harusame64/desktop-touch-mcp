/**
 * resource-notifications.ts
 *
 * Coalesced resource update notifications for the Reactive Perception Graph.
 * Fires at most once per lens per debounce window, and only on attention transitions.
 *
 * Attention transitions that trigger notifications:
 *   ok → guard_failed / dirty / settling / stale    (degradation)
 *   guard_failed / dirty / settling / stale → ok    (recovery)
 * Non-transitions (value unchanged) do NOT fire.
 * "changed" alone does NOT fire — too noisy for minor value updates.
 */

import type { AttentionState } from "./types.js";

export type NotificationTrigger = "attention_change" | "guard_transition" | "identity_changed";

/** "ok" and "changed" are "good" — everything else is "degraded". */
function isDegraded(attention: AttentionState | undefined): boolean {
  return attention !== undefined && attention !== "ok" && attention !== "changed";
}

const DEFAULT_DEBOUNCE_MS = 500;

interface LensNotificationState {
  lastAttention: AttentionState | undefined;
  timer: ReturnType<typeof setTimeout> | null;
  pendingUris: Set<string>;
}

export interface ResourceNotificationCallbacks {
  onNotify(uris: Set<string>): void;
}

export class ResourceNotificationScheduler {
  private readonly states = new Map<string, LensNotificationState>();
  private readonly debounceMs: number;
  private disposed = false;

  constructor(
    private readonly getUrisForLens: (lensId: string) => string[],
    private readonly getAttention: (lensId: string) => AttentionState | undefined,
    private readonly cbs: ResourceNotificationCallbacks,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  ) {
    this.debounceMs = debounceMs;
  }

  /**
   * Call after sensor observations are ingested for affected lenses.
   * Schedules notifications only for lenses whose attention has meaningfully transitioned.
   *
   * Policy:
   *   - "ok" and "changed" are both "good" states — transitions between them do NOT notify.
   *   - Transitions between "good" and "degraded" (guard_failed/dirty/settling/stale) DO notify.
   *   - First observation in a degraded state notifies; first observation in a good state does not.
   */
  maybeNotify(lensIds: Set<string>, _trigger: NotificationTrigger): void {
    if (this.disposed) return;

    for (const lensId of lensIds) {
      const newAttention = this.getAttention(lensId);
      if (newAttention === undefined) continue;

      const state = this.getOrCreateState(lensId);

      // No change — skip
      if (state.lastAttention === newAttention) continue;

      const wasDegraded = isDegraded(state.lastAttention);
      const nowDegraded = isDegraded(newAttention);

      // Only notify on good↔degraded transitions
      // (includes first-observation-in-degraded: undefined treated as "good")
      const isMeaningfulTransition = wasDegraded !== nowDegraded;

      state.lastAttention = newAttention;

      if (!isMeaningfulTransition) continue;

      // Add URIs to pending set and debounce
      const uris = this.getUrisForLens(lensId);
      for (const uri of uris) state.pendingUris.add(uri);

      if (!state.timer) {
        state.timer = setTimeout(() => {
          if (!this.disposed) this.flush(lensId);
        }, this.debounceMs);
        if (state.timer.unref) state.timer.unref();
      }
    }
  }

  private flush(lensId: string): void {
    const state = this.states.get(lensId);
    if (!state) return;
    state.timer = null;

    if (state.pendingUris.size > 0) {
      this.cbs.onNotify(new Set(state.pendingUris));
      state.pendingUris.clear();
    }
  }

  private getOrCreateState(lensId: string): LensNotificationState {
    let state = this.states.get(lensId);
    if (!state) {
      state = { lastAttention: undefined, timer: null, pendingUris: new Set() };
      this.states.set(lensId, state);
    }
    return state;
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.states.values()) {
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    }
    this.states.clear();
  }

  __resetForTests(): void {
    for (const state of this.states.values()) {
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    }
    this.states.clear();
    this.disposed = false;
  }
}
