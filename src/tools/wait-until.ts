import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, fail, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { coercedBoolean, coercedJsonObject } from "./_coerce.js";
import { pollUntil } from "../engine/poll.js";
import {
  enumWindowsInZOrder,
  getWindowProcessId,
  type WindowZInfo,
} from "../engine/win32.js";
import { getElementBounds } from "../engine/uia-bridge.js";
import { evaluateInTab, DEFAULT_CDP_PORT } from "../engine/cdp-bridge.js";

// ─────────────────────────────────────────────────────────────────────────────
// External hooks — set by terminal.ts and browser.ts after they load.
// Avoids a hard import cycle: wait-until is registered first.
// ─────────────────────────────────────────────────────────────────────────────

export type TerminalReadHook = (windowTitle: string) => Promise<{ text: string; marker: string } | null>;
export type BrowserSearchHook = (params: {
  port?: number; tabId?: string;
  by: "text" | "regex" | "role" | "ariaLabel"; pattern: string; scope?: string;
}) => Promise<Array<{ text: string; selector: string }>>;

let terminalReadHook: TerminalReadHook | null = null;
let browserSearchHook: BrowserSearchHook | null = null;

/** Register the terminal_read backing for `wait_until(terminal_output_contains)`. Pass null to clear. */
export function setTerminalReadHook(fn: TerminalReadHook | null): void { terminalReadHook = fn; }
/** Register the browser_search backing for `wait_until(element_matches)`. Pass null to clear. */
export function setBrowserSearchHook(fn: BrowserSearchHook | null): void { browserSearchHook = fn; }

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const waitUntilSchema = {
  condition: z.enum([
    "window_appears",
    "window_disappears",
    "focus_changes",
    "value_changes",
    "element_appears",
    "ready_state",
    "terminal_output_contains",
    "element_matches",
    "url_matches",
  ]).describe("Condition to wait for. See per-condition target requirements."),
  target: coercedJsonObject({
    windowTitle: z.string().optional(),
    elementName: z.string().optional(),
    elementSelector: z.string().optional(),
    pattern: z.string().optional(),
    regex: coercedBoolean().optional(),
    scope: z.string().optional(),
    port: z.coerce.number().optional(),
    tabId: z.string().optional(),
    by: z.enum(["text", "regex", "role", "ariaLabel"]).optional(),
    fromHwnd: z.string().optional(),     // for focus_changes — initial fg HWND as decimal string
  }).default({}).describe(
    "Target descriptor — fields used depend on condition. Accepts an object literal or a JSON-stringified object."
  ),
  timeoutMs: z.coerce.number().int().min(100).max(60000).default(5000)
    .describe("Maximum time to wait (default 5000ms)"),
  intervalMs: z.coerce.number().int().min(50).max(5000).default(200)
    .describe("Poll interval (default 200ms — terminal_output_contains uses 500 internally)"),
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-condition probe builders
// ─────────────────────────────────────────────────────────────────────────────

function findWindow(partialTitle: string): WindowZInfo | null {
  const q = partialTitle.toLowerCase();
  const wins = enumWindowsInZOrder();
  return wins.find((w) => w.title.toLowerCase().includes(q)) ?? null;
}

function probeWindowAppears(title: string): () => Promise<{ windowTitle: string; hwnd: string; pid: number } | null> {
  return async () => {
    const w = findWindow(title);
    if (!w) return null;
    return {
      windowTitle: w.title,
      hwnd: String(w.hwnd),
      pid: getWindowProcessId(w.hwnd),
    };
  };
}

function probeWindowDisappears(title: string): () => Promise<{ disappeared: boolean } | null> {
  return async () => {
    const w = findWindow(title);
    return w ? null : { disappeared: true };
  };
}

function probeFocusChanges(fromHwnd?: string): () => Promise<{ from: string | null; to: string; toTitle: string } | null> {
  // If fromHwnd not provided, capture current foreground at first call.
  let initial: string | null = fromHwnd ?? null;
  return async () => {
    const wins = enumWindowsInZOrder();
    const fg = wins.find((w) => w.isActive);
    const fgKey = fg ? String(fg.hwnd) : "";
    if (initial === null) {
      initial = fgKey;
      return null;
    }
    if (fgKey && fgKey !== initial) {
      return { from: initial, to: fgKey, toTitle: fg?.title ?? "" };
    }
    return null;
  };
}

function probeElementAppears(windowTitle: string, elementName?: string): () => Promise<{ name: string; rect: unknown } | null> {
  return async () => {
    if (!elementName) return null;
    try {
      const bounds = await getElementBounds(windowTitle, elementName);
      if (bounds && bounds.boundingRect) {
        return { name: bounds.name, rect: bounds.boundingRect };
      }
      return null;
    } catch {
      return null;
    }
  };
}

function probeReadyState(_windowTitle?: string): () => Promise<{ ready: true } | null> {
  // For now: ready when the window is visible AND not minimized.
  return async () => {
    if (!_windowTitle) return null;
    const w = findWindow(_windowTitle);
    if (!w) return null;
    if (w.isMinimized) return null;
    return { ready: true };
  };
}

function probeValueChanges(windowTitle: string, elementName?: string): () => Promise<{ before: string; after: string } | null> {
  let baseline: string | null = null;
  return async () => {
    if (!elementName) return null;
    try {
      const bounds = await getElementBounds(windowTitle, elementName);
      const cur = bounds?.value ?? "";
      if (baseline === null) {
        baseline = cur;
        return null;
      }
      if (cur !== baseline) {
        return { before: baseline, after: cur };
      }
      return null;
    } catch {
      return null;
    }
  };
}

function probeTerminalOutput(windowTitle: string, pattern: string, regex: boolean): () => Promise<{ matchedLine: string; marker: string } | null> {
  let lastMarker: string | null = null;
  const matcher = regex
    ? new RegExp(pattern)
    : { test: (s: string) => s.includes(pattern) };
  return async () => {
    if (!terminalReadHook) {
      // Hook not yet wired (terminal.ts not loaded). Treat as no-match.
      return null;
    }
    const r = await terminalReadHook(windowTitle);
    if (!r) return null;
    if (r.marker === lastMarker) return null;
    lastMarker = r.marker;
    const lines = r.text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i] ?? "";
      if (matcher.test(line)) {
        return { matchedLine: line, marker: r.marker };
      }
    }
    return null;
  };
}

/**
 * Issue #23: probe the active tab's URL via CDP. `pattern` is matched as
 * a regex when `regex:true`, otherwise as a substring (case-sensitive both
 * ways — use a regex with `i` flag for case-insensitive substring search).
 *
 * Returns null while waiting and surfaces a "BrowserNotConnected" error if
 * CDP is unreachable so pollUntil can short-circuit.
 */
function probeUrlMatches(
  pattern: string,
  regex: boolean,
  port?: number,
  tabId?: string,
): () => Promise<{ url: string } | null> {
  const matcher = regex ? new RegExp(pattern) : null;
  return async () => {
    try {
      const url = (await evaluateInTab("location.href", tabId ?? null, port ?? DEFAULT_CDP_PORT)) as string | null;
      if (typeof url !== "string") return null;
      const matched = matcher ? matcher.test(url) : url.includes(pattern);
      return matched ? { url } : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not connected|econnrefused|cdp/i.test(msg)) {
        throw new Error("BrowserNotConnected: " + msg);
      }
      return null;
    }
  };
}

function probeElementMatches(
  by: "text" | "regex" | "role" | "ariaLabel",
  pattern: string,
  port?: number,
  tabId?: string,
  scope?: string
): () => Promise<{ selector: string; text: string } | null> {
  return async () => {
    if (!browserSearchHook) return null;
    try {
      const results = await browserSearchHook({ port, tabId, by, pattern, scope });
      if (results.length > 0) {
        return { selector: results[0]!.selector, text: results[0]!.text };
      }
      return null;
    } catch (err) {
      // Bubble up "browser not connected" — no point polling against a dead CDP.
      const msg = err instanceof Error ? err.message : String(err);
      if (/not connected|econnrefused|cdp/i.test(msg)) {
        throw new Error("BrowserNotConnected: " + msg);
      }
      return null;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

type WaitArgs = {
  condition:
    | "window_appears" | "window_disappears" | "focus_changes" | "value_changes"
    | "element_appears" | "ready_state" | "terminal_output_contains" | "element_matches"
    | "url_matches";
  target: {
    windowTitle?: string;
    elementName?: string;
    elementSelector?: string;
    pattern?: string;
    regex?: boolean;
    scope?: string;
    port?: number;
    tabId?: string;
    by?: "text" | "regex" | "role" | "ariaLabel";
    fromHwnd?: string;
  };
  timeoutMs: number;
  intervalMs: number;
};

export const waitUntilHandler = async ({ condition, target, timeoutMs, intervalMs }: WaitArgs): Promise<ToolResult> => {
  try {
    let probe: () => Promise<unknown | null>;
    let interval = intervalMs;

    switch (condition) {
      case "window_appears":
        if (!target.windowTitle) {
          return failWith("target.windowTitle is required for window_appears", "wait_until");
        }
        probe = probeWindowAppears(target.windowTitle);
        break;
      case "window_disappears":
        if (!target.windowTitle) {
          return failWith("target.windowTitle is required for window_disappears", "wait_until");
        }
        probe = probeWindowDisappears(target.windowTitle);
        break;
      case "focus_changes":
        probe = probeFocusChanges(target.fromHwnd);
        break;
      case "element_appears":
        if (!target.windowTitle || !target.elementName) {
          return failWith("target.windowTitle and target.elementName are required for element_appears", "wait_until");
        }
        probe = probeElementAppears(target.windowTitle, target.elementName);
        // UIA probe spawns PS (~300ms each) — clamp interval to 500ms to avoid
        // saturating PowerShell startup cost with rapid polls.
        interval = Math.max(intervalMs, 500);
        break;
      case "value_changes":
        if (!target.windowTitle || !target.elementName) {
          return failWith("target.windowTitle and target.elementName are required for value_changes", "wait_until");
        }
        probe = probeValueChanges(target.windowTitle, target.elementName);
        interval = Math.max(intervalMs, 500);
        break;
      case "ready_state":
        probe = probeReadyState(target.windowTitle);
        break;
      case "terminal_output_contains":
        if (!target.windowTitle || !target.pattern) {
          return failWith("target.windowTitle and target.pattern are required for terminal_output_contains", "wait_until");
        }
        if (!terminalReadHook) {
          return failWith(
            "terminal(action='read') hook not registered (terminal tools may not be loaded)",
            "wait_until"
          );
        }
        probe = probeTerminalOutput(target.windowTitle, target.pattern, target.regex ?? false);
        interval = Math.max(intervalMs, 500); // terminal output benefits from longer interval
        break;
      case "url_matches":
        // Issue #23: wait for the active tab's URL to match a pattern.
        // SPA route changes / redirects / OAuth flows produce a URL change
        // before the DOM stabilises — polling location.href is the cheap,
        // reliable signal.
        if (!target.pattern) {
          return failWith("target.pattern is required for url_matches", "wait_until");
        }
        probe = probeUrlMatches(target.pattern, target.regex ?? false, target.port, target.tabId);
        break;
      case "element_matches":
        if (!target.by || !target.pattern) {
          return failWith("target.by and target.pattern are required for element_matches", "wait_until");
        }
        if (!browserSearchHook) {
          return failWith(
            "browser_search hook not registered (browser tools may not be loaded)",
            "wait_until"
          );
        }
        probe = probeElementMatches(target.by, target.pattern, target.port, target.tabId, target.scope);
        break;
      default: {
        const _exhaust: never = condition;
        return failWith(`Unsupported condition: ${String(_exhaust)}`, "wait_until");
      }
    }

    const r = await pollUntil(probe, { intervalMs: interval, timeoutMs });
    if (r.ok) {
      return ok({ ok: true, condition, elapsedMs: r.elapsedMs, observed: r.value });
    }

    return fail({
      ok: false,
      code: "WaitTimeout",
      error: `wait_until(${condition}) timed out after ${r.elapsedMs}ms`,
      suggest: [
        "Increase timeoutMs",
        "Verify the target is correct",
        "Inspect intermediate state with screenshot(detail='meta')",
      ],
      context: { condition, target, timeoutMs },
    });
  } catch (err) {
    return failWith(err, "wait_until", { condition, target });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerWaitUntilTool(server: McpServer): void {
  server.tool(
    "wait_until",
    buildDesc({
      purpose: "Server-side poll for an observable condition — eliminates screenshot-polling loops when waiting for state changes.",
      details: "condition selects what to watch: window_appears/window_disappears (target.windowTitle required), focus_changes (optional target.fromHwnd), element_appears/value_changes (target.windowTitle + target.elementName required, UIA; min 500ms interval), ready_state (target.windowTitle; visible + not minimized), terminal_output_contains (target.windowTitle + target.pattern required [+target.regex:true], needs terminal tools loaded), element_matches (target.by + target.pattern required, needs browser tools loaded), url_matches (target.pattern required [+target.regex:true]; matches the active tab's location.href via CDP — use for SPA route changes, redirects, OAuth flows). Returns {ok:true, elapsedMs, observed} on success, or WaitTimeout error with suggest hints. timeoutMs default 5000 (max 60000).",
      prefer: "Use instead of run_macro({sleep:N}) + screenshot loops. Use terminal_output_contains to detect CLI command completion. Use element_matches for browser DOM readiness after navigation. Use url_matches when the URL is the most reliable signal (SPA routing / redirect cascades).",
      caveats: "terminal_output_contains, element_matches, and url_matches require a browser CDP connection (open --remote-debugging-port=9222 first). element_appears/value_changes spawn a UIA process per poll — interval clamped to 500ms minimum. On WaitTimeout, read the suggest[] array in the error for recovery steps.",
      examples: [
        "wait_until({condition:'window_appears', target:{windowTitle:'Save As'}, timeoutMs:10000})",
        "wait_until({condition:'terminal_output_contains', target:{windowTitle:'Terminal', pattern:'$ '}, timeoutMs:30000})",
        "wait_until({condition:'element_matches', target:{by:'text', pattern:'Submit', scope:'#checkout-form'}})",
        "wait_until({condition:'url_matches', target:{pattern:'/dashboard'}, timeoutMs:15000})",
        "wait_until({condition:'url_matches', target:{pattern:'^https://app\\\\.example\\\\.com/orders/[0-9]+$', regex:true}})",
      ],
    }),
    waitUntilSchema,
    waitUntilHandler
  );
}
