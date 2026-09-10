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
import { probeLane } from "../../engine/aim-probe.js";

function isPromptLine(line: string): boolean {
  return /[>$#]\s*$/.test(line.trim());
}

/** How long a SCOPED buffer read may take; the wait around it adds the process start. */
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
  if (!target?.windowTitle && pinned === undefined) {
    return probeLane("terminal", "skipped", { why: "no_target" }, { candidates: [], warnings: [] });
  }
  const windowTitle = target?.windowTitle ?? "@active";
  const targetId    = target?.hwnd ?? target?.windowTitle ?? "@active";
  // ADR-036 item 14a — what this lane asks for, known before the read so a read that throws still
  // says it. Never the buffer: a terminal holds whatever the user typed, secrets included.
  const asked = {
    windowTitle,
    targetId,
    scoped: pinned !== undefined,
    pinnedHwnd: pinned !== undefined ? pinned.toString() : null,
  };

  try {
    const { getTextViaTextPattern } = await import("../../engine/uia-bridge.js");
    // The budget is shortened only on the SCOPED arm. That arm leaves the native engine, and the
    // wait around it is the budget plus the process start — so the 6000 default became a 10 s
    // stall in front of a discover. 2000 puts the worst case back where it was before this ADR.
    //
    // The unscoped arm keeps the default, because 2000 there is not a stall budget but a hard
    // cut: it goes to the native reader (or, without one, to PowerShell with no headroom added),
    // and a conhost buffer that read fine at 6000 would come back `null` — which this provider
    // reports as `terminal_buffer_empty`, "no buffer", for a read that merely ran out of time
    // (2ゲート目の指摘). A plain top-level window resolves to no handle at all
    // (`_resolve-window.ts` Case 3), so that arm is the common one, not the exception.
    //
    // Both numbers are stall budgets rather than measurements: if a real conhost buffer needs
    // more, the acceptance cell that reads one will say so.
    const raw = pinned !== undefined
      ? await getTextViaTextPattern(windowTitle, TERMINAL_READ_BUDGET_MS, { pinnedHwnd: pinned })
      : await getTextViaTextPattern(windowTitle);

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

    // Whether the buffer came back — never what it said.
    return probeLane("terminal", "read", { ...asked, bufferRead: Boolean(raw) }, { candidates, warnings });
  } catch (err) {
    console.error(`[terminal-provider] Error for "${windowTitle}":`, err);
    return probeLane("terminal", "failed", { ...asked, why: "threw" }, { candidates: [], warnings: ["terminal_provider_failed"] });
  }
}
