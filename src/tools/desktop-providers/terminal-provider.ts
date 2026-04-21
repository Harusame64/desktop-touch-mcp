/**
 * terminal-provider.ts — Candidate provider for terminal windows.
 *
 * Reads the terminal buffer via UIA TextPattern and synthesises entities:
 *   - One "textbox" entity for the current input prompt (always present)
 *   - One "label" entity for each visible output line (for read access)
 *
 * Populated locator: { terminal: { windowTitle } }
 *
 * Warnings:
 *   terminal_provider_failed — getTextViaTextPattern threw
 *   terminal_buffer_empty    — window found but buffer was empty or unreadable
 */

import type { UiEntityCandidate } from "../../engine/vision-gpu/types.js";
import type { TargetSpec } from "../../engine/world-graph/session-registry.js";
import type { ProviderResult } from "../../engine/world-graph/candidate-ingress.js";

function isPromptLine(line: string): boolean {
  return /[>$#]\s*$/.test(line.trim());
}

export async function fetchTerminalCandidates(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  // getTextViaTextPattern takes a title string — hwnd-only targets are not supported
  // until a dedicated hwnd overload is added. Return [] rather than passing hwnd as title.
  if (!target?.windowTitle) return { candidates: [], warnings: [] };
  const windowTitle = target.windowTitle;
  const targetId    = target.hwnd ?? target.windowTitle;

  try {
    const { getTextViaTextPattern } = await import("../../engine/uia-bridge.js");
    const raw = await getTextViaTextPattern(windowTitle);

    const candidates: UiEntityCandidate[] = [];
    const warnings: string[] = [];
    const now = Date.now();

    if (raw) {
      const lines = raw.split("\n").map((l) => l.trimEnd()).filter(Boolean);
      const promptLine = [...lines].reverse().find(isPromptLine);

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

      // Last few visible output lines as readable labels.
      // NOTE: getTextViaTextPattern may return large buffers (vim/less scrollback).
      // TODO (Phase 3): add a line-cap parameter to getTextViaTextPattern.
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
      // Buffer unreadable — return bare input entity so touch still works.
      warnings.push("terminal_buffer_empty");
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

    return { candidates, warnings };
  } catch (err) {
    console.error(`[terminal-provider] Error for "${windowTitle}":`, err);
    return { candidates: [], warnings: ["terminal_provider_failed"] };
  }
}
