import type { WarmTarget, WarmState, VisualGpuRuntime } from "./types.js";

export interface WarmupOptions {
  /** Simulated cold warmup latency in ms. Production: model load + session compile. */
  coldWarmupMs?: number;
  /** Optional custom warmup function. Replaces the default simulated delay. */
  warmupFn?: (target: WarmTarget) => Promise<void>;
}

export class GpuWarmupManager implements VisualGpuRuntime {
  private state: WarmState = "cold";
  private warmTarget: WarmTarget | null = null;
  private warmingPromise: Promise<WarmState> | null = null;
  private disposed = false;
  private readonly coldWarmupMs: number;
  private readonly warmupFn: ((target: WarmTarget) => Promise<void>) | undefined;

  constructor(opts: WarmupOptions = {}) {
    this.coldWarmupMs = opts.coldWarmupMs ?? 50;
    this.warmupFn = opts.warmupFn;
  }

  async ensureWarm(target: WarmTarget): Promise<WarmState> {
    if (this.state === "warm" && this.warmTarget?.id === target.id) {
      return "warm";
    }
    if (this.warmingPromise) {
      return this.warmingPromise;
    }
    // evicted acts as a re-usable cold state: ensureWarm resets the disposed flag
    this.disposed = false;
    this.state = "warming";
    this.warmingPromise = this._doWarmup(target);
    return this.warmingPromise;
  }

  private async _doWarmup(target: WarmTarget): Promise<WarmState> {
    try {
      if (this.warmupFn) {
        await this.warmupFn(target);
      } else {
        await new Promise<void>((r) => setTimeout(r, this.coldWarmupMs));
      }
      // Guard against dispose() racing with warmup completion.
      if (!this.disposed) {
        this.state = "warm";
        this.warmTarget = target;
      }
    } finally {
      this.warmingPromise = null;
    }
    return this.state;
  }

  getState(): WarmState {
    return this.state;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.state = "evicted";
    this.warmTarget = null;
    // Any in-flight warmingPromise will see disposed=true and skip the state=warm assignment.
  }
}
