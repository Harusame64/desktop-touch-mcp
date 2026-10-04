/**
 * act-motion.ts — internal #211 (D): what `desktop_act` says its action did to the window's pixels.
 *
 * MEASURED win2 (S1, 2026-09-29): the post-action DXGI poll returned `no_change` on 83 of 88
 * successful acts. It acquired its handle AFTER the action, so the window's repaint — which lands
 * when the executor returns, about 2 s into a UIA act — had already gone by, and it read the first
 * queued batch (usually another window's) and returned in 0.1–3.7 ms. And some windows repaint on
 * their own: a console's cursor row (15,624 px), a WinForms or Swing window's whole client area
 * every few hundred ms, where the smallest real change measured was 800–950 px.
 *
 * So, as the user chose (2026-09-29):
 *   - the handle is acquired BEFORE the action, and after the executor returns every batch is
 *     read for up to `ACT_MOTION.windowMs`, returning at the first rect that is a change;
 *   - a rect is a change when its part inside the window is at least `ACT_MOTION.minRectPx` —
 *     a caret (42–60 px) is not;
 *   - a window seen repainting itself between `desktop_discover` and the act (`PreActWatch`) is
 *     `indeterminate`: its real change and its noise are the same size in the same place. "Itself"
 *     means at least twice, `selfRepaintGapMs` apart: those windows repaint every few hundred ms,
 *     while one repaint is a one-off — a tooltip, or the end of the last act's own animation.
 *
 * Not told apart, recorded (gate 2): DXGI reports screen regions, not windows, so another window
 * repainting over the target's rect counts as the target's; and the activation repaint of a window
 * the act brings to the front counts as the act's change.
 *
 * Invariant: nothing here throws to the caller; a broker that fails mid-read is `indeterminate`.
 */

import type { VisualMotionObservation } from "../tools/_input-pipeline.js";
import type { Rect } from "./vision-gpu/types.js";
import type { BrokerSubscription, CacheAcquireState, DirtyRectBroker } from "./dxgi-broker.js";
import { resolveOutputIndexForHwnd } from "./any-change.js";
import { getWindowIdentity } from "./win32.js";

export const ACT_MOTION = Object.freeze({
  /** How long after the executor returns the window is watched: 9× the slowest repaint measured (16 ms, S1). */
  windowMs: 150,
  /** A rect's area inside the window that counts as a change: over a caret (≤ 60 px), under the smallest real one (800 px). */
  minRectPx: 500,
  /** How long a pre-act watch runs before it stops on its own (a watcher must end). */
  watchTtlMs: 120_000,
  /** Two repaints this far apart make a window one that repaints itself (S1: WinForms every ~170 ms, a console ~530 ms). */
  selfRepaintGapMs: 300,
  /**
   * A watch must have counted this long before it may call a window quiet: two repaints of the
   * slowest self-repainting window measured (a console, ~530 ms) fit in it whatever their phase
   * (PR codex P2).
   */
  minQuietWatchMs: 1100,
  /** A watch started right after an act ignores this long: the act's own repaint is still finishing. */
  afterActGraceMs: 1000,
  /** Watches kept at once; the oldest goes first (a view that is never acted on is never taken). */
  maxWatches: 8,
  /** A bound on the post-act read loop, whatever the broker answers. */
  maxBatches: 1000,
});

type Box = { x: number; y: number; width: number; height: number };

function insideArea(r: Box, t: Box): number {
  const w = Math.min(r.x + r.width, t.x + t.width) - Math.max(r.x, t.x);
  const h = Math.min(r.y + r.height, t.y + t.height) - Math.max(r.y, t.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function sameBox(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** The largest area any one rect of the batch covers inside the target. */
export function largestHit(rects: readonly Box[], target: Box): number {
  let best = 0;
  for (const r of rects) best = Math.max(best, insideArea(r, target));
  return best;
}

/** `a` minus `b`, as up to four boxes. */
function subtract(a: Box, b: Box): Box[] {
  if (insideArea(a, b) === 0) return [a];
  const out: Box[] = [];
  const ax2 = a.x + a.width, ay2 = a.y + a.height, bx2 = b.x + b.width, by2 = b.y + b.height;
  if (b.y > a.y) out.push({ x: a.x, y: a.y, width: a.width, height: b.y - a.y });
  if (by2 < ay2) out.push({ x: a.x, y: by2, width: a.width, height: ay2 - by2 });
  const top = Math.max(a.y, b.y), bottom = Math.min(ay2, by2);
  if (b.x > a.x) out.push({ x: a.x, y: top, width: b.x - a.x, height: bottom - top });
  if (bx2 < ax2) out.push({ x: bx2, y: top, width: ax2 - bx2, height: bottom - top });
  return out.filter((r) => r.width > 0 && r.height > 0);
}

/**
 * internal #245 — the parts of `frame` that windows above it leave on screen. DXGI reports what was
 * composed; a covered part's repaint is never composed, and another window's repaint there is not
 * this window's (win2: a video behind the target crossed its rect and read as the act's change).
 */
export function visibleParts(frame: Box, covers: readonly Box[]): Box[] {
  let parts: Box[] = [frame];
  for (const c of covers) {
    parts = parts.flatMap((p) => subtract(p, c));
    if (parts.length === 0) break;
  }
  return parts;
}

/** The largest area any one rect of the batch covers inside the visible parts. */
function largestVisibleHit(rects: readonly Box[], parts: readonly Box[]): number {
  let best = 0;
  for (const r of rects) {
    let inside = 0;
    for (const p of parts) inside += insideArea(r, p);
    best = Math.max(best, inside);
  }
  return best;
}

/** What a window did while nothing acted on it. */
export interface QuietRecord {
  /** Rects of at least `minRectPx` landed inside it at least twice, `selfRepaintGapMs` apart. */
  selfRepainting: boolean;
  /** How long it was watched. */
  watchedMs: number;
}

type Entry = { hwnd: bigint; rect: Box; stop: () => void; seen: { first?: number; selfRepainting: boolean }; since: number; countFrom: number; stoppedAt?: number };

type WatchBroker = Pick<DirtyRectBroker, "subscribe">;
type Enumerate = () => Array<{ bounds: Box }>;

/**
 * Watches a window from `desktop_discover` to the next act, and says whether it repainted on its
 * own. One watch per key (the view); starting one replaces it, `take` ends it. A watch stops by
 * itself after `ttlMs`, keeping what it saw.
 */
export class PreActWatch {
  private readonly watches = new Map<string, Entry>();
  /**
   * Windows a watch has seen repainting themselves. A window keeps doing it, so a later watch too
   * short to see it again — an act right after an act, inside the grace — still knows (PR codex P2).
   * Keyed by the handle AND its process (pid, start time): a handle is reused by another window
   * once its own closes, and must not bring this one's verdict with it (PR codex P2).
   */
  private readonly knownSelfRepainting = new Set<string>();

  private identityKey(hwnd: bigint): string | undefined {
    try {
      const id = (this.opts.identity ?? getWindowIdentity)(hwnd);
      return id.pid > 0 && id.processStartTimeMs > 0 ? `${hwnd}:${id.pid}:${id.processStartTimeMs}` : undefined;
    } catch {
      return undefined;
    }
  }

  /** `broker` is asked each time, so a disposed one is not held on to (gate 2). */
  constructor(
    private readonly broker: () => WatchBroker | null,
    private readonly opts: {
      now?: () => number;
      ttlMs?: number;
      enumerate?: Enumerate;
      identity?: (hwnd: bigint) => { pid: number; processStartTimeMs: number };
    } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? (() => performance.now()))();
  }

  /** `afterAct`: the watch follows an act on this window, whose own repaint is still finishing. */
  start(key: string, hwnd: bigint, windowRect: Box, opt: { afterAct?: boolean } = {}): void {
    this.end(key);
    const broker = this.broker();
    if (broker === null) return;
    const where = resolveOutputIndexForHwnd(hwnd, windowRect, this.opts.enumerate ? { enumerate: this.opts.enumerate } : undefined);
    if (!where.ok) return;
    const since = this.now();
    const countFrom = since + (opt.afterAct ? ACT_MOTION.afterActGraceMs : 0);
    const entry: Entry = { hwnd, rect: { ...windowRect }, stop: () => undefined, seen: { selfRepainting: false }, since, countFrom };
    const stopListening = () => {
      if (entry.stoppedAt === undefined) entry.stoppedAt = this.now();
    };
    let unsubscribe: () => void;
    let attached: boolean;
    try {
      const sub = broker.subscribe(
        where.outputIndex,
        (rects) => {
          if (entry.stoppedAt !== undefined) return;
          const t = this.now();
          if (t < countFrom || largestHit(rects, windowRect) < ACT_MOTION.minRectPx) return;
          if (entry.seen.first === undefined) entry.seen.first = t;
          else if (t - entry.seen.first >= ACT_MOTION.selfRepaintGapMs) entry.seen.selfRepainting = true;
        },
        // Invalidated (access lost: a lock screen, UAC): the watch ended there, and says so.
        stopListening,
      );
      unsubscribe = sub.unsubscribe;
      // A broker that is unavailable or backing off answers with a no-op: nothing is watched, and a
      // watch that saw nothing must not be taken for a quiet window (PR codex P2).
      attached = sub.state === "hit-subscription" || sub.state === "miss-init";
    } catch {
      return;
    }
    if (!attached) return;
    const timer = setTimeout(() => {
      unsubscribe();
      stopListening();
    }, this.opts.ttlMs ?? ACT_MOTION.watchTtlMs);
    (timer as { unref?: () => void }).unref?.();
    entry.stop = () => {
      clearTimeout(timer);
      unsubscribe();
    };
    this.watches.set(key, entry);
    // A view that is never acted on is never taken: keep the newest few (gate 2).
    while (this.watches.size > ACT_MOTION.maxWatches) {
      const oldest = this.watches.keys().next().value;
      if (oldest === undefined) break;
      this.end(oldest);
    }
  }

  /**
   * End the watch and say what it saw. `undefined` when there was none, or when it watched too little
   * after its grace to tell a quiet window from one that repaints every few hundred ms — unless an
   * earlier watch already saw this window do it.
   */
  take(key: string, now?: { hwnd: bigint; rect: Box }): QuietRecord | undefined {
    const w = this.watches.get(key);
    if (!w) return undefined;
    const end = w.stoppedAt ?? this.now();
    this.end(key);
    // Watched another window, or this one where it no longer is (moved, or onto another monitor):
    // what it saw is not about the window the act is on (PR codex P2).
    if (now !== undefined && (now.hwnd !== w.hwnd || !sameBox(now.rect, w.rect))) return undefined;
    const key2 = this.identityKey(w.hwnd);
    if (w.seen.selfRepainting && key2 !== undefined) {
      this.knownSelfRepainting.add(key2);
      while (this.knownSelfRepainting.size > ACT_MOTION.maxWatches * 4) {
        const oldest = this.knownSelfRepainting.values().next().value;
        if (oldest === undefined) break;
        this.knownSelfRepainting.delete(oldest);
      }
    }
    const known = w.seen.selfRepainting || (key2 !== undefined && this.knownSelfRepainting.has(key2));
    const watchedMs = end - w.since;
    if (!known && end - w.countFrom < ACT_MOTION.minQuietWatchMs) return undefined;
    return { selfRepainting: known, watchedMs };
  }

  private end(key: string): void {
    const w = this.watches.get(key);
    if (!w) return;
    w.stop();
    this.watches.delete(key);
  }

  /** Watches running, for tests. */
  get size(): number {
    return this.watches.size;
  }
}

/**
 * Read what the action did, from a handle acquired before it. The batches that queued while the
 * executor ran are read first; then the window is watched for the rest of `windowMs`, returning at
 * the first rect that is a change.
 */
export async function observeAfterAct(
  sub: BrokerSubscription,
  target: Box,
  quiet: QuietRecord | undefined,
  opts: {
    now?: () => number;
    windowMs?: number;
    cacheState?: CacheAcquireState;
    /** internal #245 — the parts of `target` on screen (`visibleParts`); all of it when absent. */
    visible?: readonly Box[];
  } = {},
): Promise<{ observation: VisualMotionObservation; dirtyRects: Rect[] }> {
  const now = opts.now ?? (() => performance.now());
  const windowMs = opts.windowMs ?? ACT_MOTION.windowMs;
  const parts: readonly Box[] = opts.visible ?? [target];
  const targetArea0 = Math.max(1, target.width * target.height);
  const visibleArea = parts.reduce((sum, p) => sum + p.width * p.height, 0);
  // Covered at all → a read of nothing is not "no change" (one pixel row of slack for rounding).
  const covered = visibleArea < targetArea0 - Math.max(target.width, target.height);
  const start = now();
  const seen: Rect[] = [];
  let best = 0;
  let totalInside = 0;
  let batches = 0;
  const cacheState = opts.cacheState !== undefined ? { cacheState: opts.cacheState } : {};
  try {
    for (let i = 0; i < ACT_MOTION.maxBatches; i++) {
      const left = windowMs - (now() - start);
      const batch = await sub.next(Math.max(0, left));
      if (sub.isDisposed) {
        return {
          observation: { motion: "indeterminate", source: "dxgi_dirty_rect", framesSampled: batches, totalElapsedMs: now() - start, ...cacheState },
          dirtyRects: seen,
        };
      }
      batches = i + 1;
      for (const r of batch) {
        seen.push({ x: r.x, y: r.y, width: r.width, height: r.height });
        totalInside += parts.reduce((sum, p) => sum + insideArea(r, p), 0);
      }
      best = Math.max(best, largestVisibleHit(batch, parts));
      if (best >= ACT_MOTION.minRectPx) break;
      if (now() - start >= windowMs) break;
    }
  } catch {
    return {
      observation: { motion: "indeterminate", source: "dxgi_dirty_rect", framesSampled: batches, totalElapsedMs: now() - start, ...cacheState },
      dirtyRects: seen,
    };
  }
  const elapsed = now() - start;
  const targetArea = Math.max(1, target.width * target.height);
  // Summed over every batch of a read that can span a 2 s executor, the area can pass the window's
  // own; the ratio is capped at the whole window (gate 2).
  const ratio = Math.min(1, totalInside / targetArea);
  const residual = seen.length > 0
    ? { residual: { fractionChanged: ratio, dirtyRectCount: seen.length, totalIntersectedAreaPx: totalInside, ratioOfTargetArea: ratio } }
    : {};
  const motion: VisualMotionObservation["motion"] = quiet?.selfRepainting
    ? "indeterminate"
    : best >= ACT_MOTION.minRectPx
      ? "any_change"
      : covered
        ? "indeterminate"
        : "no_change";
  return {
    observation: {
      motion,
      source: "dxgi_dirty_rect",
      ...residual,
      framesSampled: batches,
      totalElapsedMs: elapsed,
      ...(quiet !== undefined && { watchedBeforeMs: quiet.watchedMs }),
      ...(quiet?.selfRepainting && { selfRepainting: true }),
      ...(covered && { visibleFraction: Math.round((visibleArea / targetArea0) * 1000) / 1000 }),
      ...cacheState,
    },
    dirtyRects: seen,
  };
}
