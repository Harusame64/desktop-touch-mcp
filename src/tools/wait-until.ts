import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith, failCode } from "./_errors.js";
import { coercedBoolean, coercedJsonObject } from "./_coerce.js";
import { pollUntil } from "../engine/poll.js";
import { makeQueryWrapper, withEnvelopeIncludeSchema, genericQueryCausedByProjector, defaultQuerySessionId } from "./_envelope.js";
import {
  enumWindowsInZOrder,
  getWindowProcessId,
  type WindowZInfo,
} from "../engine/win32.js";
import { getElementBounds } from "../engine/uia-bridge.js";
import { WindowExcludedError } from "../engine/tool-exclusion.js";
import { evaluateInTab } from "../engine/cdp-bridge.js";
import { getCdpPort } from "../utils/desktop-config.js";

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

/**
 * internal #137 — what the last look saw, for a wait that ends in a timeout.
 *
 * A probe answers `null` for every reason it has: the element was not found, the read failed, the
 * element was found and the thing being waited for did not happen. The envelope then says
 * `WaitTimeout` and those are one answer, so a caller cannot tell "I watched the wrong thing" from
 * "I watched the right thing and it did not move" — MEASURED 2026-09-20 win2 (internal `bdef099`):
 * `value_changes` answered `WaitTimeout` at 3065 ms against a control arm's 3064 ms, and the two
 * were the same envelope.
 *
 * The probe writes what it last saw here, and the timeout carries it. The FIRST suggestion branches
 * on it — the only thing that does — because "wait longer" is the wrong first word for a name that
 * matched nothing.
 */
type LastLook = Record<string, unknown>;

/**
 * Replace the record, never merge into it. Writing key by key left a `why` and an `error` from an
 * earlier poll standing beside a later poll's `resolved: true`, so the "last look" was a composite
 * of two polls that contradicted each other (gate 2).
 */
/**
 * Which client answered, and whether the other one was asked first and threw — internal #142.
 *
 * `via` goes on every look, found or not, because the two clients do not name the same control the
 * same way (internal #136), so WHICH of them answered is part of what the answer means.
 * `nativeFailed` appears only when a read fell back mid-call: MEASURED 2026-09-20 win2 (internal
 * `25da27f`), hanging a window's UI thread makes the native call throw while the PowerShell road
 * answers normally, and before this the only trace was a line on the server's stderr.
 */
function provenance(answer: { via: string; nativeFailed?: string }): Record<string, unknown> {
  return { via: answer.via, ...(answer.nativeFailed !== undefined && { nativeFailed: answer.nativeFailed }) };
}

/**
 * The suggestions the last look earned, in the order the caller can act on them.
 *
 * Built as a list rather than a ternary chain because two of these can be true at once: a read
 * that fell back AND missed is about the vocabulary first and the name second, while a read that
 * fell back and could not find the window is about the window first. The chain could only ever
 * say one of them (internal #142, measured).
 */
function earnedAdvice(look: LastLook): string[] {
  const why = look["why"];
  const fellBack = look["nativeFailed"] !== undefined;
  const lines: string[] = [];

  // Said FIRST only where it is the thing to fix: a name that missed on a road the caller did not
  // choose. The two clients name some controls differently (internal #136).
  const vocabulary =
    "This read fell back to the PowerShell UIA client, which names some controls differently from the native engine ('Minimize' against '最小化', and twenty of Notepad's twenty-six elements differ). The name you passed may be the native engine's — check WHICH client's name you are using before changing it; context.lastLook.nativeFailed says why the road changed";
  if (fellBack && why === "element_not_found") lines.push(vocabulary);

  if (why === "window_not_found") {
    lines.push("No window matched target.windowTitle while waiting — the element was never looked for. Check the title (list_windows) before waiting longer or re-checking the element name");
  } else if (why === "element_not_found") {
    lines.push("No element by that name was found while waiting — check target.elementName against what {tool:reidentify_element} returns before waiting longer");
  } else if (why === "no_rectangle") {
    lines.push("The element was found but has no rectangle — it is collapsed, zero-size or offscreen. Bring it into view (scroll it, or expand the panel holding it) rather than waiting longer");
  } else if (why === "unreadable") {
    lines.push("The read answered 'not there' without saying whether the WINDOW or the ELEMENT was missing. Check the window title first (list_windows), then the element name — this build's UIA engine cannot tell the two apart");
  } else if (why === "read_unfinished") {
    lines.push("The read ran out of its own budget before answering — nothing was learned about either the window or the element, and this is the only silence a longer wait can turn into an answer. Some window on this desktop is answering slowly, not necessarily the one you named: raise timeoutMs rather than changing the target");
  } else if (why === "read_failed") {
    lines.push("The read itself failed, so nothing was learned about the window or the element — the error is in context.lastLook.error. Retry before changing the target");
  }

  // …and on every other silence the same fact is said after, because there it changes what a name
  // MEANS without being the thing to fix first.
  if (fellBack && why !== "element_not_found") lines.push(vocabulary);
  return lines;
}

function write(look: LastLook, seen: Record<string, unknown>): void {
  for (const key of Object.keys(look)) delete look[key];
  Object.assign(look, seen);
}

function probeElementAppears(windowTitle: string, elementName: string | undefined, look: LastLook): () => Promise<{ name: string; controlType?: string; automationId?: string; rect: unknown } | null> {
  return async () => {
    if (!elementName) return null;
    try {
      const answer = await getElementBounds(windowTitle, elementName);
      const bounds = answer.found;
      if (bounds && bounds.boundingRect) {
        // What it RESOLVED, not only that it did: the same read already carries the type and the
        // AutomationId, and a caller that got the wrong element has no other way to see it.
        return {
          name: bounds.name,
          ...(bounds.controlType !== undefined && { controlType: bounds.controlType }),
          ...(bounds.automationId ? { automationId: bounds.automationId } : {}),
          rect: bounds.boundingRect,
        };
      }
      // `resolved` is about the ELEMENT, and the ternary above proves one came back by that name
      // when `bounds` is set — it simply has no rectangle (a collapsed panel, an offscreen control;
      // `uia-bridge.ts` nulls the rect for an empty or infinite one). Calling that "never resolved"
      // put the wrong advice first, which is this change's own defect shape (gate 2).
      // The read's own account of the silence, not this probe's guess at it. `element_not_found`
      // used to be written here for every empty answer, including a window title that matched no
      // window at all (internal #142, measured) — the caller was then told to check a name that
      // was never the problem.
      write(look, bounds
        ? { resolved: true, why: "no_rectangle", ...provenance(answer) }
        : { resolved: false, why: answer.why, ...provenance(answer), ...(answer.error ? { error: answer.error } : {}) });
      return null;
    } catch (e) {
      // A window this server may not act through is a REFUSAL, not a thing that has not happened
      // yet: swallowing it polled the key locker for the whole timeout and answered `WaitTimeout`,
      // while the product has a `WindowExcluded` code that says nothing was done and why.
      //
      // **Rethrown with the code SPELLED INTO THE MESSAGE**, which is how this product carries a
      // declared code out through `failWith`: `classify` reads the message, never the class or the
      // name (`_errors.ts`), so the first version of this rethrow arrived as a bare `ToolError`
      // with no advice at all — the four hand-written `WindowExcluded` lines never fired, and the
      // description had just been corrected to say `ToolError` means a validation error (gate 2).
      // `probeUrlMatches` below does the same with `BrowserNotConnected:`.
      if (e instanceof WindowExcludedError) {
        throw new Error(`WindowExcluded: ${e.message}`, { cause: e });
      }
      // Defensive, not a live road: `getElementBounds` catches everything internally on both
      // clients, so with the exclusion rethrown above nothing else throws here today. It stands for
      // a future producer that does (gate 2).
      write(look, { resolved: false, why: "read_failed", error: e instanceof Error ? e.message : String(e) });
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

function probeValueChanges(windowTitle: string, elementName: string | undefined, look: LastLook): () => Promise<{ before: string; after: string } | null> {
  let baseline: string | null = null;
  return async () => {
    if (!elementName) return null;
    try {
      const answer = await getElementBounds(windowTitle, elementName);
      const bounds = answer.found;
      // THE DISTINCTION THIS CONDITION COULD NOT MAKE: no element at all, and an element whose
      // value never moved, both ended as `value ?? ""` and then as the same timeout. A missing
      // element is not a value of "" — `resolved` says which, and the baseline says what was being
      // compared against, which the probe has held all along and never returned.
      //
      // ON THE TIMEOUT ROAD ONLY, and the success road keeps a defect of its own that this does not
      // touch (gate 2): a baseline read from a live element, then a window that closes, still reads
      // as `"" !== "draft"` and answers `ok:true` with a change that never happened. `first` is the
      // old `baseline === null` guard renamed, not a fix for it — the first poll never produced
      // that answer either. Filed, not fixed here: saying it costs a shape this change does not
      // carry.
      const resolved = bounds !== null && bounds !== undefined;
      const cur = bounds?.value ?? "";
      const first = baseline === null;
      if (first) baseline = cur;
      // The readings are printed only where there was something to read. `baseline: ""` beside
      // `resolved: false` asserts an observation that never happened, and "" is exactly the value a
      // missing element is not (gate 2, the same shape one level down).
      write(look, resolved
        ? { resolved, baseline, latest: cur, ...provenance(answer) }
        : { resolved, why: answer.why, ...provenance(answer), ...(answer.error ? { error: answer.error } : {}) });
      if (!first && baseline !== null && cur !== baseline) {
        return { before: baseline, after: cur };
      }
      return null;
    } catch (e) {
      if (e instanceof WindowExcludedError) {
        throw new Error(`WindowExcluded: ${e.message}`, { cause: e });
      }
      // Defensive, not a live road: `getElementBounds` catches everything internally on both
      // clients, so with the exclusion rethrown above nothing else throws here today. It stands for
      // a future producer that does (gate 2).
      write(look, { resolved: false, why: "read_failed", error: e instanceof Error ? e.message : String(e) });
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
 * When `port` is omitted, falls back to the configured CDP port from
 * `desktop-touch-config.json` (`getCdpPort()`), matching how other browser
 * tools resolve their default. Plain `DEFAULT_CDP_PORT` would silently
 * disagree with the configured port and emit BrowserNotConnected even
 * when the browser is connected (Codex PR #58 P1).
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
  const effectivePort = port ?? getCdpPort();
  return async () => {
    try {
      const url = (await evaluateInTab("location.href", tabId ?? null, effectivePort)) as string | null;
      if (typeof url !== "string") return null;
      const matched = matcher ? matcher.test(url) : url.includes(pattern);
      return matched ? { url } : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not connected|econnrefused|cdp/i.test(msg)) {
        throw new Error("BrowserNotConnected: " + msg, { cause: err });
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
        throw new Error("BrowserNotConnected: " + msg, { cause: err });
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
    /** internal #137 — what the probe last saw, read only when the wait times out. */
    const lastLook: LastLook = {};

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
        probe = probeElementAppears(target.windowTitle, target.elementName, lastLook);
        // UIA probe spawns PS (~300ms each) — clamp interval to 500ms to avoid
        // saturating PowerShell startup cost with rapid polls.
        interval = Math.max(intervalMs, 500);
        break;
      case "value_changes":
        if (!target.windowTitle || !target.elementName) {
          return failWith("target.windowTitle and target.elementName are required for value_changes", "wait_until");
        }
        probe = probeValueChanges(target.windowTitle, target.elementName, lastLook);
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

    return failCode(
      "WaitTimeout",
      `wait_until(${condition}) timed out after ${r.elapsedMs}ms`,
      {
        // internal #137 — the first suggestion is the one the last look earned. "Increase timeoutMs"
        // is the right advice for a thing that has not happened YET, and the wrong advice for a
        // name that matched nothing: waiting longer for an element that was never there is the
        // recovery a caller would otherwise try three times.
        suggest: [
          // The ground is `why`, not `resolved`: an element that was found and has no rectangle IS
          // resolved, and telling its caller to re-check the name sends them to a tool that does not
          // list it either (gate 2). The tool is named by capability, so the sentence says
          // `get_ui_elements` at the kill-switch corner where `desktop_discover` is not registered.
          //
          // internal #142 — `window_not_found` and `unreadable` used to arrive here spelled
          // `element_not_found`, so a wait against a title that matches NO WINDOW was answered
          // with "check target.elementName" (measured 2026-09-20 win2). The element name was never
          // the problem, and no amount of re-reading it would have been.
          // internal #142 — one line per silence, and the ORDER decided by what the caller can
          // act on. MEASURED 2026-09-20 win2 (internal `c4374e9`): with an unrelated window hung,
          // the native read throws, the PowerShell road COMPLETES, and it genuinely has no element
          // called `最小化` — it calls that control `Minimize`. So `element_not_found` is TRUE and
          // "check target.elementName" is the wrong recovery: the name was right and the ROAD was
          // wrong. The first round put the vocabulary line second and the machine showed an
          // envelope opening with advice that could not work.
          ...earnedAdvice(lastLook),
          "Increase timeoutMs",
          "Verify the target is correct",
          "Inspect intermediate state with screenshot(detail='meta')",
        ],
        context: {
          condition, target, timeoutMs,
          // What the last poll saw. Absent when the probe had nothing to say (a condition that does
          // not look at an element), rather than an empty object that reads as "it saw nothing".
          ...(Object.keys(lastLook).length > 0 ? { lastLook } : {}),
        },
      },
    );
  } catch (err) {
    return failWith(err, "wait_until", { condition, target });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walking skeleton expansion phase swimlane 2 (L5 query tool wrapper):
 * `wait_until` is wrapped via `makeQueryWrapper`. PR #122 screenshot 同型
 * pattern (read-only condition polling、L1 events 不発、causedByProjector
 * 省略 fast path)。
 */
export const waitUntilRegistrationSchema = withEnvelopeIncludeSchema(waitUntilSchema);

export const waitUntilRegistrationHandler = makeQueryWrapper(
  waitUntilHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
  "wait_until",
  {
    causedByProjector: genericQueryCausedByProjector,
    getSessionId: defaultQuerySessionId,
  },
);

export function registerWaitUntilTool(server: McpServer): void {
  server.tool(
    "wait_until",
    buildDesc({
      purpose: "Server-side poll for an observable condition — eliminates screenshot-polling loops when waiting for state changes.",
      details: "condition selects what to watch: window_appears/window_disappears (target.windowTitle required), focus_changes (optional target.fromHwnd), element_appears/value_changes (target.windowTitle + target.elementName required, UIA; min 500ms interval), ready_state (target.windowTitle; visible + not minimized), terminal_output_contains (target.windowTitle + target.pattern required [+target.regex:true], needs terminal tools loaded), element_matches (target.by + target.pattern required, needs browser tools loaded), url_matches (target.pattern required [+target.regex:true]; matches the active tab's location.href via CDP — use for SPA route changes, redirects, OAuth flows). Returns {ok:true, elapsedMs, observed} on success, or WaitTimeout error with suggest hints. timeoutMs default 5000 (max 60000).",
      prefer: "Use instead of run_macro({sleep:N}) + screenshot loops. Use terminal_output_contains to detect CLI command completion. Use element_matches for browser DOM readiness after navigation. Use url_matches when the URL is the most reliable signal (SPA routing / redirect cascades).",
      caveats: "terminal_output_contains/element_matches/url_matches need a browser CDP connection (open --remote-debugging-port=9222 first). element_appears/value_changes spawn a UIA process per poll (interval floor 500ms). On timeout: {ok:false, code:'WaitTimeout', error, suggest:[...]}; suggest[] may open with a line earned by the last poll — read it, do not index. Those two also return context.lastLook: did the element resolve, why not, and for value_changes baseline/latest — the field's VALUE, so a masked credential arrives as mask characters. Other codes: 'ToolError' (validation / missing hook — read the message), 'BrowserNotConnected' (re-attach via browser_open), and 'WindowExcluded' for a target this server may not act through, answered at once rather than polled. Branch on code.",
      examples: [
        "wait_until({condition:'window_appears', target:{windowTitle:'Save As'}, timeoutMs:10000})",
        "wait_until({condition:'terminal_output_contains', target:{windowTitle:'Terminal', pattern:'$ '}, timeoutMs:30000})",
        "wait_until({condition:'element_matches', target:{by:'text', pattern:'Submit', scope:'#checkout-form'}})",
        "wait_until({condition:'url_matches', target:{pattern:'/dashboard'}, timeoutMs:15000})",
        "wait_until({condition:'url_matches', target:{pattern:'^https://app\\\\.example\\\\.com/orders/[0-9]+$', regex:true}})",
      ],
    }),
    waitUntilRegistrationSchema,
    waitUntilRegistrationHandler as typeof waitUntilHandler
  );
}
