/**
 * FlushScheduler — debounces and coalesces dirty marks before sensor refresh.
 *
 * High-frequency events (e.g. EVENT_OBJECT_LOCATIONCHANGE during a drag) can
 * fire hundreds of times per second. The FlushScheduler ensures that only one
 * refresh call is made per debounce window for each property class, using
 * monotonic timestamps for deadline calculations.
 *
 * Pure class — no OS imports. Uses performance.now() for monotonic time.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Property classes that drive different debounce windows.
 *
 * Debounce defaults (ms):
 * - foreground   100  Include sidecar IPC jitter. Sync refresh still happens inside guards.
 * - show_hide    100  Let z-order settle after show/hide animation.
 * - title        100  Avoid typing-update spam from name-change events.
 * - move_start     0  Set `settling` immediately; no refresh needed yet.
 * - move_end      50  Refresh rect after MOVESIZEEND.
 * - location     150  Coalesce drag/animation bursts.
 * - reorder      100  Recompute modal after z-order settles.
 * - overflow       0  Immediate: global dirty + reconciliation.
 */
export type PropertyClass =
  | "foreground"
  | "show_hide"
  | "title"
  | "move_start"
  | "move_end"
  | "location"
  | "reorder"
  | "overflow";

export const DEFAULT_DEBOUNCE_MS: Record<PropertyClass, number> = {
  foreground: 100,
  show_hide:  100,
  title:      100,
  move_start:   0,
  move_end:    50,
  location:   150,
  reorder:    100,
  overflow:     0,
};

export interface FlushSchedulerOptions {
  /** Override debounce windows. Partial: only specified classes are overridden. */
  debounceMs?: Partial<Record<PropertyClass, number>>;
  /** Called when a flush is due. The `reason` string describes what triggered it. */
  onFlush: (reason: string) => void | Promise<void>;
  /**
   * Clock function for monotonic time. Defaults to performance.now().
   * Injected for test determinism (fake timers replace setTimeout but tests
   * can also override the clock to control debounce deadline comparisons).
   */
  clock?: () => number;
  /**
   * Timer factory. Defaults to setTimeout. Injected for tests with fake timers.
   */
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (id: ReturnType<typeof setTimeout>) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// FlushScheduler
// ─────────────────────────────────────────────────────────────────────────────

export class FlushScheduler {
  private readonly _debounce: Record<PropertyClass, number>;
  private readonly _onFlush: (reason: string) => void | Promise<void>;
  private readonly _clock: () => number;
  private readonly _setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly _clearTimeout: (id: ReturnType<typeof setTimeout>) => void;

  /** Pending timer handle per property class. */
  private _timers = new Map<PropertyClass, ReturnType<typeof setTimeout>>();
  /** Pending reasons to include when the timer fires. */
  private _pendingReasons = new Map<PropertyClass, Set<string>>();

  private _disposed = false;

  constructor(opts: FlushSchedulerOptions) {
    this._debounce = { ...DEFAULT_DEBOUNCE_MS, ...opts.debounceMs };
    this._onFlush = opts.onFlush;
    this._clock = opts.clock ?? (() => performance.now());
    this._setTimeout = opts.setTimeout ?? setTimeout;
    this._clearTimeout = opts.clearTimeout ?? clearTimeout;
  }

  /**
   * Schedule a flush for the given property class.
   * If a timer is already pending for this class, it is reset (leading-debounce NOT used;
   * this is trailing-debounce: the flush fires after `debounceMs` of quiet time).
   */
  schedule(propertyClass: PropertyClass, reason?: string): void {
    if (this._disposed) return;

    const debounceMs = this._debounce[propertyClass];
    const effectiveReason = reason ?? propertyClass;

    // Accumulate reasons
    let reasons = this._pendingReasons.get(propertyClass);
    if (!reasons) { reasons = new Set(); this._pendingReasons.set(propertyClass, reasons); }
    reasons.add(effectiveReason);

    if (debounceMs === 0) {
      // Immediate flush: fire synchronously (within the same microtask)
      this._firePendingFor(propertyClass);
      return;
    }

    // Reset the timer (trailing debounce)
    const existing = this._timers.get(propertyClass);
    if (existing != null) this._clearTimeout(existing);

    const handle = this._setTimeout(() => {
      this._timers.delete(propertyClass);
      this._firePendingFor(propertyClass);
    }, debounceMs);
    this._timers.set(propertyClass, handle);
  }

  /** Force an immediate flush without waiting for the debounce window. */
  scheduleImmediate(reason: string): void {
    if (this._disposed) return;
    // Cancel all pending timers and fire one consolidated flush
    for (const [cls, handle] of this._timers) {
      this._clearTimeout(handle);
      this._timers.delete(cls);
    }
    const combinedReasons = new Set<string>([reason]);
    for (const reasons of this._pendingReasons.values()) {
      for (const r of reasons) combinedReasons.add(r);
    }
    this._pendingReasons.clear();
    void this._onFlush([...combinedReasons].join(","));
  }

  /** Cancel all pending timers and stop accepting new work. */
  dispose(): void {
    this._disposed = true;
    for (const handle of this._timers.values()) {
      this._clearTimeout(handle);
    }
    this._timers.clear();
    this._pendingReasons.clear();
  }

  /** Reset state for tests (does not dispose — the instance is reusable). */
  __resetForTests(): void {
    for (const handle of this._timers.values()) {
      this._clearTimeout(handle);
    }
    this._timers.clear();
    this._pendingReasons.clear();
    this._disposed = false;
  }

  private _firePendingFor(propertyClass: PropertyClass): void {
    const reasons = this._pendingReasons.get(propertyClass);
    this._pendingReasons.delete(propertyClass);
    const reasonStr = reasons ? [...reasons].join(",") : propertyClass;
    void this._onFlush(reasonStr);
  }
}
