/**
 * terminal-provider.ts — Candidate provider for terminal windows.
 *
 * Reads the terminal buffer via UIA TextPattern and synthesises entities:
 *   - One "textbox" entity for the current input prompt (always present)
 *   - One "label" entity for each visible output line (for read access)
 *
 * Populated locator: { terminal: { windowTitle } }
 */

import type { UiEntityCandidate } from "../../engine/vision-gpu/types.js";
import type { TargetSpec } from "../../engine/world-graph/session-registry.js";

/** Heuristic: does a line look like a shell prompt? */
function isPromptLine(line: string): boolean {
  return /[>$#]\s*$/.test(line.trim());
}

export async function fetchTerminalCandidates(
  target: TargetSpec | undefined
): Promise<UiEntityCandidate[]> {
  // getTextViaTextPattern takes a title string — hwnd-only targets are not supported
  // until a dedicated hwnd overload is added. Return [] rather than passing hwnd as title.
  if (!target?.windowTitle) return [];
  const windowTitle = target.windowTitle;
  const targetId    = target.hwnd ?? target.windowTitle;

  try {
    const { getTextViaTextPattern } = await import("../../engine/uia-bridge.js");
    const raw = await getTextViaTextPattern(windowTitle);

    const candidates: UiEntityCandidate[] = [];
    const now = Date.now();

    if (raw) {
      const lines = raw.split("\n").map((l) => l.trimEnd()).filter(Boolean);
      const promptLine = [...lines].reverse().find(isPromptLine);

      // Primary: the input prompt entity (always the touch target for terminal_send)
      candidates.push({
        source: "terminal",
        target: { kind: "window", id: targetId },
        locator: { terminal: { windowTitle } },
        role: "textbox",
        label: promptLine ?? "terminal input",
        actionability: ["type"],
        confidence: 1.0,
        observedAtMs: now,
        provisional: false,
      });

      // Secondary: last few visible output lines as readable labels
      const outputLines = lines.slice(-5).filter((l) => !isPromptLine(l));
      for (const line of outputLines) {
        candidates.push({
          source: "terminal",
          target: { kind: "window", id: targetId },
          locator: { terminal: { windowTitle } },
          role: "label",
          label: line.slice(0, 80),
          actionability: ["read"],
          confidence: 0.8,
          observedAtMs: now,
          provisional: false,
        });
      }
    } else {
      // Buffer unreadable — return a bare input entity so touch still works
      candidates.push({
        source: "terminal",
        target: { kind: "window", id: targetId },
        locator: { terminal: { windowTitle } },
        role: "textbox",
        label: "terminal input",
        actionability: ["type"],
        confidence: 0.6,
        observedAtMs: now,
        provisional: false,
      });
    }

    return candidates;
  } catch (err) {
    console.error(`[terminal-provider] Error for "${windowTitle}":`, err);
    return [];
  }
}
