/**
 * reconciliation.ts
 *
 * Periodic full-reconciliation sweep for the Reactive Perception Graph.
 * Runs every RECONCILE_INTERVAL_MS to catch anything the event-driven path misses,
 * and also fires immediately on overflow signals from the raw event queue.
 *
 * This module holds the sweep timer and exposes startReconciliation / stopReconciliation.
 * It does NOT replace the 250ms polling sensor loop — both run in parallel until the
 * native events path is proven stable (Milestone 3 completion criterion).
 */

import type { PerceptionLens } from "./types.js";
import type { DirtyJournal } from "./dirty-journal.js";
import { buildRefreshPlan } from "./refresh-plan.js";
import type { LensEventIndex } from "./lens-event-index.js";

export interface ReconciliationCallbacks {
  /**
   * Called when the reconciler has determined which hwnds need full refresh.
   * The caller (registry) performs the actual sensor calls.
   */
  onReconcile(opts: {
    rectHwnds: Set<string>;
    identityHwnds: Set<string>;
    titleHwnds: Set<string>;
    needsEnumWindows: boolean;
    foreground: boolean;
    modalForLensIds: Set<string>;
    reason: string[];
    trigger: "sweep" | "overflow";
  }): void;
}

const RECONCILE_INTERVAL_MS = 5_000;

export class ReconciliationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    private readonly getLenses: () => PerceptionLens[],
    private readonly getJournal: () => DirtyJournal,
    private readonly getIndex: () => LensEventIndex,
    private readonly getAllHwnds: () => Set<string>,
    private readonly cbs: ReconciliationCallbacks,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.disposed) this.sweep("sweep");
    }, RECONCILE_INTERVAL_MS);
    // Allow the Node process to exit even if timer is running
    if (this.timer.unref) this.timer.unref();
  }

  /** Trigger an immediate reconciliation (e.g. on queue overflow). */
  triggerImmediate(): void {
    if (!this.disposed) this.sweep("overflow");
  }

  stop(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private sweep(trigger: "sweep" | "overflow"): void {
    const journal  = this.getJournal();
    const index    = this.getIndex();
    const allHwnds = this.getAllHwnds();
    const plan     = buildRefreshPlan(journal, index, allHwnds);

    if (
      !plan.needsEnumWindows &&
      plan.rectHwnds.size === 0 &&
      plan.identityHwnds.size === 0 &&
      plan.titleHwnds.size === 0 &&
      !plan.foreground &&
      plan.modalForLensIds.size === 0 &&
      trigger === "sweep"
    ) {
      // Nothing dirty — skip this sweep tick
      return;
    }

    this.cbs.onReconcile({
      rectHwnds:       plan.rectHwnds,
      identityHwnds:   plan.identityHwnds,
      titleHwnds:      plan.titleHwnds,
      needsEnumWindows: plan.needsEnumWindows,
      foreground:      plan.foreground,
      modalForLensIds: plan.modalForLensIds,
      reason:          plan.reason.length > 0 ? plan.reason : [`${trigger}_sweep`],
      trigger,
    });
  }

  __resetForTests(): void {
    this.stop();
    this.disposed = false;
  }
}
