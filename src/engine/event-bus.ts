/**
 * event-bus.ts — Polled HWND state observer.
 *
 * Phase 3.4 of anti-fukuwarai-ideals-plan.md.
 * Detects window_appeared / window_disappeared / foreground_changed events
 * via 500ms EnumWindows sweeps. Buffers events for `events_poll`.
 *
 * Note: MCP notifications/message push is not implemented — clients should
 * call events_poll at the start of each turn.
 */

import { enumWindowsInZOrder, getWindowProcessId, getProcessIdentityByPid } from "./win32.js";

export type WindowEvent =
  | { type: "window_appeared"; windowTitle: string; hwnd: string; processName: string; tsMs: number }
  | { type: "window_disappeared"; windowTitle: string; hwnd: string; processName: string; tsMs: number }
  | { type: "foreground_changed"; from: string | null; to: string; toHwnd: string; processName: string; tsMs: number };

export interface Subscription {
  id: string;
  types: Set<string>;
  buffer: WindowEvent[];
  createdAt: number;
}

const subscriptions = new Map<string, Subscription>();
let lastSnapshot: { hwnd: string; title: string; isActive: boolean; processName: string }[] = [];
let timer: NodeJS.Timeout | null = null;
let prevForeground: string | null = null;

const POLL_MS = 500;
const BUFFER_MAX = 200;
let nextId = 1;

// pid → processName memo. Process name is stable for a given pid (Windows doesn't
// reuse pids immediately), so we cache aggressively and rely on event-bus stop
// (maybeStop) to clear. Bounded to prevent unbounded growth in long sessions.
const pidNameCache = new Map<number, { name: string; tsMs: number }>();
const PID_NAME_TTL_MS = 30_000;
const PID_NAME_MAX = 200;

function resolveProcessNameCached(pid: number): string {
  if (pid === 0) return "";
  const now = Date.now();
  const cached = pidNameCache.get(pid);
  if (cached && now - cached.tsMs < PID_NAME_TTL_MS) return cached.name;
  let name = "";
  try { name = getProcessIdentityByPid(pid).processName; } catch { /* best-effort */ }
  if (pidNameCache.has(pid)) pidNameCache.delete(pid);
  pidNameCache.set(pid, { name, tsMs: now });
  if (pidNameCache.size > PID_NAME_MAX) {
    const oldest = pidNameCache.keys().next().value;
    if (oldest !== undefined) pidNameCache.delete(oldest);
  }
  return name;
}

function enrichWindow(w: { hwnd: bigint; title: string; isActive: boolean }) {
  let processName = "";
  try {
    processName = resolveProcessNameCached(getWindowProcessId(w.hwnd));
  } catch { /* best-effort */ }
  return { hwnd: String(w.hwnd), title: w.title, isActive: w.isActive, processName };
}

function tick(): void {
  let wins;
  try { wins = enumWindowsInZOrder(); } catch { return; }
  const cur = wins.map(enrichWindow);
  const prevByHwnd = new Map(lastSnapshot.map((w) => [w.hwnd, w]));
  const curByHwnd = new Map(cur.map((w) => [w.hwnd, w]));

  const events: WindowEvent[] = [];
  const now = Date.now();

  // Appeared
  for (const w of cur) {
    if (!prevByHwnd.has(w.hwnd)) {
      events.push({ type: "window_appeared", windowTitle: w.title, hwnd: w.hwnd, processName: w.processName, tsMs: now });
    }
  }
  // Disappeared — processName comes from the prior snapshot (process may be gone now).
  for (const w of lastSnapshot) {
    if (!curByHwnd.has(w.hwnd)) {
      events.push({ type: "window_disappeared", windowTitle: w.title, hwnd: w.hwnd, processName: w.processName, tsMs: now });
    }
  }
  // Foreground change
  const fg = cur.find((w) => w.isActive);
  const fgHwnd = fg?.hwnd ?? null;
  if (fgHwnd && fgHwnd !== prevForeground) {
    const prev = lastSnapshot.find((w) => w.hwnd === prevForeground);
    events.push({
      type: "foreground_changed",
      from: prev?.title ?? null,
      to: fg!.title,
      toHwnd: fg!.hwnd,
      processName: fg!.processName,
      tsMs: now,
    });
    prevForeground = fgHwnd;
  }

  if (events.length > 0) {
    for (const sub of subscriptions.values()) {
      for (const e of events) {
        if (sub.types.has(e.type)) {
          sub.buffer.push(e);
          if (sub.buffer.length > BUFFER_MAX) sub.buffer.shift();
        }
      }
    }
  }

  lastSnapshot = cur;
}

function ensureRunning(): void {
  if (timer) return;
  // Initialize baseline
  try { lastSnapshot = enumWindowsInZOrder().map(enrichWindow); }
  catch { lastSnapshot = []; }
  prevForeground = lastSnapshot.find((w) => w.isActive)?.hwnd ?? null;
  timer = setInterval(tick, POLL_MS);
  timer.unref();
}

function maybeStop(): void {
  if (subscriptions.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
    lastSnapshot = [];
    prevForeground = null;
  }
}

export function subscribe(types: string[]): string {
  ensureRunning();
  const id = `sub-${nextId++}`;
  subscriptions.set(id, {
    id,
    types: new Set(types),
    buffer: [],
    createdAt: Date.now(),
  });
  return id;
}

export function poll(id: string, sinceMs?: number, drain = true): WindowEvent[] {
  const sub = subscriptions.get(id);
  if (!sub) return [];
  const events = sinceMs !== undefined ? sub.buffer.filter((e) => e.tsMs > sinceMs) : [...sub.buffer];
  if (drain) {
    if (sinceMs !== undefined) {
      // Only drain returned (matching) events; keep older ones for next poll with smaller sinceMs.
      sub.buffer = sub.buffer.filter((e) => e.tsMs <= sinceMs);
    } else {
      sub.buffer.length = 0;
    }
  }
  return events;
}

export function unsubscribe(id: string): boolean {
  const ok = subscriptions.delete(id);
  maybeStop();
  return ok;
}

export function getActiveSubscriptions(): string[] {
  return Array.from(subscriptions.keys());
}
