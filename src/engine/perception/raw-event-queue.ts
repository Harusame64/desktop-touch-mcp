/**
 * raw-event-queue.ts
 *
 * Bounded ring-buffer for raw WinEvent records emitted by the native sidecar.
 * Overflow drops oldest entries and flags a global dirty signal so the
 * reconciliation loop can recover. Pure data structure — no OS imports.
 */

export interface RawWinEvent {
  /** WinEvent constant (e.g. EVENT_SYSTEM_FOREGROUND = 3) */
  event: number;
  /** Target window handle as decimal string */
  hwnd: string;
  /** OBJID_* constant (0 = OBJID_WINDOW) */
  idObject: number;
  /** Child object id */
  idChild: number;
  /** Thread that owns the target window */
  eventThread: number;
  /**
   * Timestamp from the sidecar's side (milliseconds, epoch).
   * Use for diagnostics / ordering hints only — never compare to Node clocks.
   */
  sourceEventTimeMs: number;
  /** Monotonically incrementing counter assigned by the sidecar */
  sidecarSeq: number;
  /** Monotonic ms (performance.now()) captured in Node when the event was received */
  receivedAtMonoMs: number;
  /** Wall-clock ms (Date.now()) captured in Node when the event was received */
  receivedAtUnixMs: number;
  /** Global sequence assigned by the Node receiver */
  globalSeq: number;
}

export interface RawEventQueueDiagnostics {
  totalEnqueued: number;
  totalDropped: number;
  totalDrained: number;
  overflowCount: number;
  pendingCount: number;
}

const DEFAULT_MAX_SIZE  = 1024;
const DEFAULT_BATCH_MAX = 256;

export class RawEventQueue {
  private readonly maxSize: number;
  private readonly batchMax: number;
  private buffer: RawWinEvent[] = [];
  private _totalEnqueued = 0;
  private _totalDropped  = 0;
  private _totalDrained  = 0;
  private _overflowCount = 0;

  /** Set by the queue when overflow occurs; cleared by the drain consumer. */
  overflowPending = false;

  constructor(opts?: { maxSize?: number; batchMax?: number }) {
    this.maxSize  = opts?.maxSize  ?? DEFAULT_MAX_SIZE;
    this.batchMax = opts?.batchMax ?? DEFAULT_BATCH_MAX;
  }

  /** Enqueue a single raw event. Returns true if accepted, false if overflow drop. */
  enqueue(event: RawWinEvent): boolean {
    if (this.buffer.length >= this.maxSize) {
      // Drop oldest (front of ring) — keep newest
      this.buffer.shift();
      this._totalDropped++;
      this._overflowCount++;
      this.overflowPending = true;
    }
    this.buffer.push(event);
    this._totalEnqueued++;
    return true;
  }

  /**
   * Drain up to batchMax events and return them.
   * Clears overflowPending flag on first drain after overflow.
   */
  drain(): RawWinEvent[] {
    const count = Math.min(this.buffer.length, this.batchMax);
    if (count === 0) return [];
    const batch = this.buffer.splice(0, count);
    this._totalDrained += batch.length;
    this.overflowPending = false;
    return batch;
  }

  /** Number of events currently buffered. */
  get pendingCount(): number {
    return this.buffer.length;
  }

  diagnostics(): RawEventQueueDiagnostics {
    return {
      totalEnqueued:  this._totalEnqueued,
      totalDropped:   this._totalDropped,
      totalDrained:   this._totalDrained,
      overflowCount:  this._overflowCount,
      pendingCount:   this.buffer.length,
    };
  }

  __resetForTests(): void {
    this.buffer          = [];
    this._totalEnqueued  = 0;
    this._totalDropped   = 0;
    this._totalDrained   = 0;
    this._overflowCount  = 0;
    this.overflowPending = false;
  }
}
