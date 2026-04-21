/**
 * terminal-ingress.ts — Terminal buffer change detector for title:xxx targets.
 *
 * Detects buffer changes for known `title:xxx` keys that match terminal window
 * patterns. Only `title:` keys for terminal-like windows are ever checked —
 * unrelated window titles are ignored (target isolation).
 *
 * Approach: read the terminal buffer tail via UIA TextPattern and compare with
 * a stored fingerprint. If the tail changed → invalidate that key.
 *
 * idle cost: getTextViaTextPattern() is called only when a terminal title: key
 * is tracked and getSnapshot() runs (bounded by see() call rate). No background
 * polling. Minimum interval per key avoids hammering UIA on rapid successive calls.
 *
 * Graceful degradation: UIA unavailable or window not found → skip, no invalidation.
 */

import type { IngressEventSource, IngressReason } from "./candidate-ingress.js";

const TERMINAL_PATTERN =
  /powershell|\bcommand prompt\b|\bterminal\b|\bbash\b|\b(wsl|zsh|fish|ksh|sh)\b|git.?bash|conemu|mintty/i;

/** Minimum ms between buffer reads per window (avoid UIA hammering). */
const MIN_CHECK_INTERVAL_MS = 1_000;

/** Number of chars from the end of the buffer used as fingerprint. */
const TAIL_LENGTH = 200;

function isTerminalTitle(title: string): boolean {
  return TERMINAL_PATTERN.test(title);
}

export function createTerminalIngressSource(): IngressEventSource {
  // windowTitle → last-known buffer tail fingerprint
  const lastFingerprint = new Map<string, string>();
  // windowTitle → last check timestamp
  const lastCheckMs = new Map<string, number>();

  return {
    async drain(knownKeys: ReadonlySet<string>): Promise<Iterable<{ key: string; reason: IngressReason }>> {
      // Only process title: keys that look like terminal windows.
      const terminalKeys = [...knownKeys].filter(
        (k) => k.startsWith("title:") && isTerminalTitle(k.slice(6))
      );
      if (terminalKeys.length === 0) return [];

      const invalidations: Array<{ key: string; reason: IngressReason }> = [];
      const now = Date.now();

      for (const key of terminalKeys) {
        const windowTitle = key.slice(6); // strip "title:"

        // Rate-limit: skip if checked too recently.
        const last = lastCheckMs.get(windowTitle) ?? 0;
        if (now - last < MIN_CHECK_INTERVAL_MS) continue;
        lastCheckMs.set(windowTitle, now);

        try {
          const { getTextViaTextPattern } = await import("../uia-bridge.js");
          const text = await getTextViaTextPattern(windowTitle);
          if (!text) continue;

          const tail        = text.slice(-TAIL_LENGTH);
          const prev        = lastFingerprint.get(windowTitle);

          if (prev !== undefined && prev !== tail) {
            invalidations.push({ key, reason: "winevent" });
          }
          lastFingerprint.set(windowTitle, tail);
        } catch {
          // Terminal window not found or UIA unavailable — skip silently.
        }
      }

      return invalidations;
    },

    dispose(): void {
      lastFingerprint.clear();
      lastCheckMs.clear();
    },
  };
}
