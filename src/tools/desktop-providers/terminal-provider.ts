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
import { parseTargetHwnd, type TargetSpec } from "../../engine/world-graph/session-registry.js";
import type { ProviderResult } from "../../engine/world-graph/candidate-ingress.js";

function isPromptLine(line: string): boolean {
  return /[>$#]\s*$/.test(line.trim());
}

/** How long the buffer read itself may take; the wait around it adds the process start. */
const TERMINAL_READ_BUDGET_MS = 2000;

export async function fetchTerminalCandidates(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  // ADR-036 — `getTextViaTextPattern` takes a handle now, so a handle-keyed session reads the
  // buffer of the window it writes to rather than the first one answering to the title. That
  // half is live.
  //
  // The handle-ONLY half is not, and the door below is open ahead of it: nothing reaches this
  // provider except through `isTerminalTarget`, which is a regex over `target.windowTitle`
  // alone (`compose-providers.ts`) — so a session known only by handle is never a terminal, no
  // matter what class its window is. Deciding that by window class instead changes WHICH
  // provider runs for a given target, so it moves on its own rather than riding here
  // (2ゲート目の指摘: this branch is unreachable today, and saying so is cheaper than pretending
  // it is not there).
  const pinned = parseTargetHwnd(target);
  if (!target?.windowTitle && pinned === undefined) return { candidates: [], warnings: [] };
  const windowTitle = target?.windowTitle ?? "@active";
  const targetId    = target?.hwnd ?? target?.windowTitle ?? "@active";

  try {
    const { getTextViaTextPattern } = await import("../../engine/uia-bridge.js");
    // The read budget is passed rather than defaulted, because a scoped read leaves the native
    // engine and the wait around it is the budget plus the process start. Defaulting to 6000 put
    // a 10 s stall in front of every discover of a terminal-titled window — `normalizeTarget`
    // fills a handle for every call, so that is not an exceptional path (2ゲート目の指摘). 2000
    // keeps the worst case where it was before this ADR. It is a stall budget, not a measurement:
    // if a real conhost buffer needs more, the acceptance cell that reads one will say so.
    const raw = await getTextViaTextPattern(
      windowTitle, TERMINAL_READ_BUDGET_MS, pinned !== undefined ? { pinnedHwnd: pinned } : undefined,
    );

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
