/**
 * browser-ingress.ts — CDP-based invalidation source for browser tab targets.
 *
 * Detects URL/title changes for known `tab:xxx` keys by calling listTabsLight()
 * on each drain. Only `tab:` keys are ever invalidated — window/title keys are
 * ignored (target isolation).
 *
 * idle cost: listTabsLight() is called only when at least one tab: key is tracked
 * and getSnapshot() is called (i.e. when see() is invoked). No background polling.
 *
 * Graceful degradation: when CDP is unreachable (Chrome not running), drain()
 * returns [] without error — the cache remains valid until manually invalidated.
 */

import type { IngressEventSource, IngressReason } from "./candidate-ingress.js";

/**
 * Create a browser invalidation source.
 * Invalidates `tab:{tabId}` keys when their URL or title changes.
 */
export function createBrowserIngressSource(): IngressEventSource {
  // tabId → last-known "url|title" fingerprint
  const lastState = new Map<string, string>();

  return {
    async drain(knownKeys: ReadonlySet<string>): Promise<Iterable<{ key: string; reason: IngressReason }>> {
      const tabKeys = [...knownKeys].filter((k) => k.startsWith("tab:"));
      if (tabKeys.length === 0) return [];

      try {
        const { listTabsLight } = await import("../cdp-bridge.js");
        const tabs = await listTabsLight();
        const tabMap = new Map(tabs.map((t) => [t.id, t]));

        const invalidations: Array<{ key: string; reason: IngressReason }> = [];
        for (const key of tabKeys) {
          const tabId   = key.slice(4); // strip "tab:"
          const tab     = tabMap.get(tabId);
          if (!tab) continue; // tab closed or not found — skip, don't invalidate

          const fingerprint = `${tab.url}|${tab.title}`;
          const prev        = lastState.get(tabId);

          if (prev !== undefined && prev !== fingerprint) {
            invalidations.push({ key, reason: "cdp" });
          }
          lastState.set(tabId, fingerprint);
        }

        return invalidations;
      } catch {
        // CDP unavailable (Chrome not running, wrong port, etc.).
        // Graceful degradation: return no invalidations, let cache serve stale.
        return [];
      }
    },

    dispose(): void {
      lastState.clear();
    },
  };
}
