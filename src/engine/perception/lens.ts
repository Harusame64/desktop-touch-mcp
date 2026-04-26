/**
 * Lens compilation and binding resolution.
 * Pure functions — no OS imports. Callers inject window snapshots.
 */

import type {
  BrowserTabIdentity,
  EntityRef,
  LensSpec,
  PerceptionLens,
  ResolvedBinding,
  WindowIdentity,
} from "./types.js";

export interface WindowSnapshot {
  hwnd: string;      // bigint as decimal
  title: string;
  zOrder: number;
  isActive: boolean;
  pid?: number;
  processName?: string;
  processStartTimeMs?: number;
}

let _lensCounter = 0;

/** Generate a stable lens ID. Use the injectable seed in tests. */
export function nextLensId(seed?: () => string): string {
  return seed ? seed() : `perc-${++_lensCounter}`;
}

export function resetLensCounter(): void { _lensCounter = 0; }

/**
 * Build the concrete fluent-store key for any entity kind.
 * Format: "<kind>:<id>.<property>"
 * Throws on unknown entity kind to catch missed migrations during testing.
 */
export function fluentKeyForEntity(entity: EntityRef, property: string): string {
  if (entity.kind === "window" || entity.kind === "browserTab") {
    return `${entity.kind}:${entity.id}.${property}`;
  }
  throw new Error(`Unknown entity kind: ${(entity as { kind: string }).kind}`);
}

/**
 * Expand a lens's maintain list into concrete fluent-store keys using the resolved binding.
 */
export function expandFluentKeys(lens: Pick<PerceptionLens, "spec" | "binding">): string[] {
  const kind = lens.spec.target.kind;
  const id = lens.binding.hwnd;
  return lens.spec.maintain.map(property => fluentKeyForEntity({ kind, id } as EntityRef, property));
}

/**
 * Find the best-matching window for a window-kind lens target spec from a live snapshot.
 *
 * Selection strategy:
 *   1. Foreground (isActive) window that matches titleIncludes — highest priority
 *   2. Any visible window with lowest zOrder (frontmost) that matches
 *
 * Returns null when no window matches.
 */
export function resolveBindingFromSnapshot(
  spec: LensSpec,
  windows: WindowSnapshot[]
): ResolvedBinding | null {
  if (spec.target.kind !== "window") return null;
  const needle = spec.target.match.titleIncludes.toLowerCase();
  const candidates = windows.filter(w => w.title.toLowerCase().includes(needle));
  if (candidates.length === 0) return null;

  const foreground = candidates.find(w => w.isActive);
  const best = foreground ?? [...candidates].sort((a, b) => a.zOrder - b.zOrder)[0]!;
  return { hwnd: best.hwnd, windowTitle: best.title };
}

/**
 * Find the best-matching tab for a browserTab-kind lens target spec.
 * CDP returns tabs in MRU order; first match = most-recently-active.
 * Returns null when no tab matches.
 */
export function resolveBrowserTabBindingFromTabs(
  spec: LensSpec,
  tabs: Array<{ id: string; title: string; url: string }>
): ResolvedBinding | null {
  if (spec.target.kind !== "browserTab") return null;
  const { urlIncludes, titleIncludes } = spec.target.match;
  const match = tabs.find(t => {
    const urlOk = urlIncludes ? t.url.toLowerCase().includes(urlIncludes.toLowerCase()) : true;
    const titleOk = titleIncludes ? t.title.toLowerCase().includes(titleIncludes.toLowerCase()) : true;
    return urlOk && titleOk;
  });
  if (!match) return null;
  // Re-use hwnd field to store tabId; windowTitle stores tab title
  return { hwnd: match.id, windowTitle: match.title };
}

/**
 * Build a BrowserTabIdentity from tab listing data (used at browserTab lens registration).
 */
export function buildBrowserTabIdentity(
  tabId: string,
  title: string,
  url: string,
  port: number
): BrowserTabIdentity {
  return { tabId, title, url, port };
}

/**
 * Compile a raw lens spec and initial binding into a PerceptionLens.
 * Assumes binding has already been resolved (call resolveBindingFromSnapshot or
 * resolveBrowserTabBindingFromTabs first).
 */
export function compileLens(
  spec: LensSpec,
  binding: ResolvedBinding,
  boundIdentity: WindowIdentity | BrowserTabIdentity,
  seq: number,
  idSeed?: () => string
): PerceptionLens {
  const lensId = nextLensId(idSeed);
  const draft: Pick<PerceptionLens, "spec" | "binding"> = { spec, binding };
  return {
    lensId,
    spec,
    binding,
    boundIdentity,
    fluentKeys: expandFluentKeys(draft),
    registeredAtSeq: seq,
    registeredAtMs: Date.now(),
  };
}
