import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mouse, Button, Point, straightTo, DEFAULT_MOUSE_SPEED } from "../engine/nutjs.js";
import { enumWindowsInZOrder, restoreAndFocusWindow } from "../engine/win32.js";
import { updateWindowCache } from "../engine/window-cache.js";
import { ok, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith, failCode } from "./_errors.js";
import { coercedBoolean } from "./_coerce.js";
import { pollUntil } from "../engine/poll.js";
import {
  listTabs,
  evaluateInTab,
  getElementScreenCoords,
  navigateTo,
  getDomHtml,
  disconnectAll,
  getTabContext,
  CMD_TIMEOUT_MS,
  type TabContext,
} from "../engine/cdp-bridge.js";
import { resolveWellKnownPath, spawnDetached, killProcessesByName } from "../utils/launch.js";
import { getCdpPort } from "../utils/desktop-config.js";
import { setBrowserSearchHook } from "./wait-until.js";
import { narrateParam, withRichNarration } from "./_narration.js";
import { makeCommitWrapper, makeQueryWrapper, withEnvelopeIncludeSchema, withEnvelopeIncludeForUnion, flattenUnionToObjectSchema, parseActionArgsOrFail, genericQueryCausedByProjector, defaultQuerySessionId } from "./_envelope.js";
import type { RichBlock } from "../engine/uia-diff.js";
import { evaluatePreToolGuards, buildEnvelopeFor } from "../engine/perception/registry.js";
import { runActionGuard, isAutoGuardEnabled, validateAndPrepareFix, consumeFix } from "./_action-guard.js";
import { prepareBrowserEvalExpression } from "./browser-eval-helpers.js";
import { buildCandidateCollectionJs, resolveBrowserActionTarget, type ResolveActionOutcome } from "./browser-resolver.js";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

// Read once at startup — respects desktop-touch-config.json { "cdpPort": N }
const _defaultPort = getCdpPort();

const portParam = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .default(_defaultPort)
  .describe(`Chrome/Edge CDP remote debugging port (default ${_defaultPort}; configurable via desktop-touch-config.json)`);

const tabIdParam = z
  .string()
  .optional()
  .describe("Tab ID from browser_open. Omit to use the first page tab.");

const selectorParam = z
  .string()
  .describe("CSS selector for the target element (e.g. '#submit', '.btn', 'button[type=submit]')");

// Phase 3: kept for internal documentation. Public registration uses
// `browserOpenSchema` (defined below) which wraps connect + optional launch.
export const browserConnectSchema = {
  port: portParam,
};

// Phase 3: browser_open dispatcher schema (connect-only by default,
// optional launch absorbs former browser_launch).
export const browserOpenSchema = {
  port: portParam,
  launch: z
    .object({
      browser: z
        .enum(["auto", "chrome", "edge", "brave"])
        .default("auto")
        .describe("Which browser to spawn. 'auto' tries chrome → edge → brave. Ignored when a CDP endpoint is already live."),
      userDataDir: z
        .string()
        .default("C:\\tmp\\cdp")
        .describe("Path for --user-data-dir. A dedicated profile avoids conflicts with the main browser session."),
      url: z
        .string()
        .optional()
        .describe("Optional URL to open in the new browser."),
      waitMs: z.coerce
        .number()
        .int()
        .min(1000)
        .max(30_000)
        .default(10_000)
        .describe("Max ms to wait for the CDP endpoint to become ready (default 10000)."),
      killExisting: coercedBoolean().default(false).describe(
        "When true, terminate existing browser processes before launch. " +
        "Use when a browser is already running WITHOUT --remote-debugging-port. " +
        "WARNING: unsaved input in the existing session will be lost."
      ),
    })
    .optional()
    .describe(
      "If set, spawn a debug-mode browser when no CDP endpoint is live on the target port (idempotent: " +
      "an already-running endpoint is preferred and the spawn step is skipped). " +
      "Pass {} to use defaults (chrome, C:\\tmp\\cdp, no initial URL). Omit to perform pure connect."
    ),
};

const includeContextParam = coercedBoolean()
  .default(true)
  .describe(
    "When true (default), append `activeTab` + `readyState` lines to the response. " +
    "Set false to skip — saves ~150 tokens per call when chaining several browser_* calls in the same tab."
  );

export const browserFindElementSchema = {
  selector: selectorParam,
  tabId: tabIdParam,
  port: portParam,
  includeContext: includeContextParam,
};

// ADR-023 Phase 1: by-axis (semantic) targeting params shared by browser_click /
// browser_fill. Provide EITHER `selector` (CSS, existing path, bit-equal) OR
// `by`+`pattern` (resolver path). `by` deliberately excludes 'selector' — CSS
// goes through the dedicated `selector` param. Exactly-one-of is enforced by a
// `.refine()` on the registration schema (see browserClickRegistrationSchema).
const byAxisParam = z
  .enum(["text", "regex", "role", "ariaLabel"])
  .optional()
  .describe(
    "Semantic axis to target by INSTEAD of a CSS selector: 'text' (visible text), 'regex', " +
    "'role' (ARIA/implicit role), 'ariaLabel'. Pair with `pattern`. The server resolves to a " +
    "SINGLE actionable element — climbing to a clickable ancestor up to 3 levels — and STOPS " +
    "with a candidate list (code:'BrowserAmbiguousTarget') if the match is ambiguous; it never guesses."
  );
const byPatternParam = z
  .string()
  .min(1)
  .optional()
  .describe("Value matched against the chosen `by` axis (required when `by` is set).");
const byRoleParam = z
  .string()
  .optional()
  .describe("Optional ARIA/implicit-role filter AND-combined with `by` (e.g. by:'text', pattern:'Save', role:'button').");
const byScopeParam = z
  .string()
  .optional()
  .describe("Optional CSS selector to limit the `by`-axis search scope (disambiguation).");
const byCaseSensitiveParam = coercedBoolean()
  .optional()
  .describe("Case-sensitive matching for by:'text'/'regex' (default false).");

export const browserClickElementSchema = {
  selector: z
    .string()
    .optional()
    .describe("CSS selector for the target element (e.g. '#submit', '.btn'). Provide EITHER selector OR by+pattern."),
  by: byAxisParam,
  pattern: byPatternParam,
  role: byRoleParam,
  scope: byScopeParam,
  caseSensitive: byCaseSensitiveParam,
  narrate: narrateParam,
  tabId: tabIdParam,
  port: portParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards (target.identityStable) are evaluated before clicking, " +
    "and a perception envelope is attached to post.perception on success."
  ),
  fixId: z.string().optional().describe("Approve a pending suggestedFix (one-shot, 15s TTL). Selector mode only."),
  scrollIntoView: coercedBoolean().default(false).describe(
    "When true, if the target is outside the viewport, scroll it into view (centered) before clicking, " +
    "instead of failing with ElementNotInViewport. Default false preserves the explicit " +
    "scrollIntoView-then-retry workflow. Selector mode only (by-axis resolves only in-viewport actionable targets)."
  ),
};

// Phase 3: kept as a ZodRawShape for internal documentation / type derivation;
// the runtime registration uses the `browserEvalSchema` discriminated union below.
export const browserEvalJsSchema = {
  expression: z.string().describe(
    "JavaScript expression to evaluate in the browser tab. " +
    "The server automatically wraps snippets in an async IIFE to avoid repeated const/let name collisions. " +
    "For multi-statement snippets, use an explicit final return value. " +
    "Declarations (const/let/var) are scoped to each snippet and will not persist across repeated browser_eval calls; " +
    "use window.* or globalThis.* for persistence."
  ),
  tabId: tabIdParam,
  port: portParam,
  includeContext: includeContextParam,
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards (target.identityStable) are evaluated before eval. " +
    "Note: action='js' returns raw text by default; pass withPerception:true to receive a structured envelope."
  ),
  withPerception: coercedBoolean().optional().default(false).describe(
    "When true, return structured JSON { ok, result, post } instead of raw text. " +
    "Enables post.perception attachment so the LLM can see guard status. " +
    "Default false preserves the raw-text return for backwards compatibility. " +
    "Example: browser_eval({action:'js', expression:'document.title', withPerception:true})"
  ),
};

export const browserGetDomSchema = {
  selector: z
    .string()
    .optional()
    .describe("CSS selector for root element. Omit for document.body."),
  tabId: tabIdParam,
  port: portParam,
  maxLength: z.coerce
    .number()
    .int()
    .min(100)
    .max(100_000)
    .default(10_000)
    .describe("Maximum characters to return (default 10000)"),
  includeContext: includeContextParam,
};

export const browserNavigateSchema = {
  url: z.string().describe("URL to navigate to"),
  narrate: narrateParam,
  tabId: tabIdParam,
  port: portParam,
  waitForLoad: coercedBoolean().default(true).describe(
    "When true (default), wait for document.readyState === 'complete' before returning. " +
    "Use waitForLoad:false for the legacy behavior (return immediately after Page.navigate). " +
    "Accepts the strings \"true\"/\"false\"."
  ),
  loadTimeoutMs: z.coerce.number().int().min(500).max(30000).default(15000).describe(
    "Max milliseconds to wait for page load when waitForLoad=true (default 15000). " +
    "On timeout, returns ok:true with readyState set to current state and hints.warnings=['NavigateTimeout']."
  ),
  lensId: z.string().optional().describe(
    "Optional perception lens ID. Guards (target.identityStable) are evaluated before navigating, " +
    "and a perception envelope is attached to post.perception on success."
  ),
};

export const browserDisconnectSchema = {
  port: portParam,
};

export const browserLaunchSchema = {
  browser: z
    .enum(["auto", "chrome", "edge", "brave"])
    .default("auto")
    .describe(
      "Which browser to launch. 'auto' tries chrome → edge → brave and picks the first installed. " +
      "Ignored if a CDP endpoint is already live on the target port."
    ),
  port: portParam,
  userDataDir: z
    .string()
    .default("C:\\tmp\\cdp")
    .describe(
      "Path for --user-data-dir. Using a dedicated profile avoids conflicts with your normal browser session. " +
      "Default C:\\tmp\\cdp is safe to reuse across sessions."
    ),
  url: z
    .string()
    .optional()
    .describe("Optional URL to navigate to immediately after launch."),
  waitMs: z.coerce
    .number()
    .int()
    .min(1000)
    .max(30_000)
    .default(10_000)
    .describe("Max milliseconds to wait for the CDP endpoint to become ready (default 10000)."),
  killExisting: coercedBoolean().default(false).describe(
    "When true, terminate existing chrome.exe / msedge.exe / brave.exe processes before launch. " +
    "Use this when a browser is already running WITHOUT --remote-debugging-port. " +
    "WARNING: unsaved input in the existing browser session will be lost. " +
    "Default false (preserves the user's current browser session)."
  ),
};

export const browserSearchSchema = {
  by: z.enum(["text", "regex", "role", "ariaLabel", "selector"])
    .describe("Search axis: text/regex/role/ariaLabel/selector"),
  pattern: z.string().min(1).describe("Pattern to match against the chosen axis."),
  scope: z.string().optional().describe("CSS selector to limit the search scope."),
  maxResults: z.coerce.number().int().min(1).max(200).default(50).describe("Max results returned (default 50)."),
  offset: z.coerce.number().int().min(0).default(0).describe("Offset into the result set (default 0)."),
  visibleOnly: coercedBoolean().default(true).describe("Only visible elements (default true). Set false to include hidden ones with confidence penalty."),
  inViewportOnly: coercedBoolean().default(false).describe("Only currently-in-viewport elements (default false)."),
  caseSensitive: coercedBoolean().default(false).describe("Case-sensitive matching for text/regex (default false)."),
  tabId: tabIdParam,
  port: portParam,
};

export const browserFillInputSchema = {
  selector: selectorParam,
  value: z.string().max(10_000).describe("Text to fill into the input element"),
  tabId: tabIdParam,
  port: portParam,
  includeContext: includeContextParam,
};

export const browserGetFormSchema = {
  selector: z
    .string()
    .describe(
      "CSS selector for the form or container element to inspect (e.g. '#login-form', '.search-bar'). " +
      "All input, select, textarea, and button descendants are returned."
    ),
  includeHidden: coercedBoolean()
    .default(false)
    .describe(
      "When true, include hidden inputs (type=hidden). Default false to avoid CSRF-token / serialized-state clutter."
    ),
  maxResults: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe("Maximum number of form fields to return (default 100)."),
  tabId: tabIdParam,
  port: portParam,
  includeContext: includeContextParam,
};

export const browserGetInteractiveSchema = {
  scope: z
    .string()
    .optional()
    .describe(
      "CSS selector to limit the search scope (e.g. '.s-main-slot', '#nav-search-form'). " +
      "Omit to scan the full page."
    ),
  types: z
    .array(z.enum(["link", "button", "input", "all"]))
    .default(["all"])
    .describe("Element types to include. Default 'all' returns links, buttons, and inputs."),
  inViewportOnly: coercedBoolean()
    .default(false)
    .describe("When true, only return elements currently visible in the viewport."),
  maxResults: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("Maximum number of elements to return (default 50)."),
  tabId: tabIdParam,
  port: portParam,
  includeContext: includeContextParam,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tab context cache (500ms TTL keyed by port:tabId)
//   - Eliminates duplicate `Runtime.evaluate` calls when the LLM chains several
//     browser_* calls in the same tab. Cache is short enough that "the page
//     just navigated" caller intent is still respected (next call refetches).
// ─────────────────────────────────────────────────────────────────────────────

const tabContextCache = new Map<string, { value: TabContext; expiresAt: number }>();
const TAB_CONTEXT_TTL_MS = 500;

async function getCachedTabContext(tabId: string | null, port: number): Promise<TabContext> {
  const key = `${port}:${tabId ?? ""}`;
  const cached = tabContextCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const fresh = await getTabContext(tabId, port);
  tabContextCache.set(key, { value: fresh, expiresAt: now + TAB_CONTEXT_TTL_MS });
  // Bound the map size — entries naturally expire, but a parade of unique
  // (port,tabId) pairs would otherwise leak.
  if (tabContextCache.size > 64) {
    for (const [k, v] of tabContextCache) {
      if (v.expiresAt <= now) tabContextCache.delete(k);
    }
  }
  return fresh;
}

/** Test-only — not exported via index, but accessible to e2e tests. */
export function _resetTabContextCache(): void {
  tabContextCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure a specific window is focused before sending mouse events.
 * If the active window already matches titleHint, this is a no-op.
 * Otherwise finds the window by title and brings it to the front.
 * Updates the window cache after enumeration.
 */
async function ensureWindowFocused(titleHint: string): Promise<void> {
  const windows = enumWindowsInZOrder();
  updateWindowCache(windows);
  const active = windows.find((w) => w.isActive);
  if (active && active.title.toLowerCase().includes(titleHint.toLowerCase())) {
    return; // already focused
  }
  const target = windows.find((w) =>
    w.title.toLowerCase().includes(titleHint.toLowerCase())
  );
  if (target) {
    restoreAndFocusWindow(target.hwnd);
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}

/**
 * Ensure a browser window is focused before sending mouse events.
 * Falls back to generic Chrome/Edge title search when tab title cannot be resolved.
 */
async function ensureBrowserFocused(port: number): Promise<void> {
  // Try to match by current tab title from CDP
  let tabTitle: string | undefined;
  try {
    const tabs = await listTabs(port);
    const pageTab = tabs.find((t) => t.type === "page");
    tabTitle = pageTab?.title;
  } catch {
    // ignore — fall back to browser name search
  }

  if (tabTitle) {
    await ensureWindowFocused(tabTitle);
    return;
  }

  // Fall back to browser process name
  const windows = enumWindowsInZOrder();
  updateWindowCache(windows);
  const active = windows.find((w) => w.isActive);
  if (
    active &&
    (active.title.includes("Google Chrome") || active.title.includes("Microsoft Edge"))
  ) {
    return;
  }
  const browserWindow = windows.find((w) =>
    w.title.includes("Google Chrome") || w.title.includes("Microsoft Edge")
  );
  if (browserWindow) {
    restoreAndFocusWindow(browserWindow.hwnd);
    await new Promise<void>((r) => setTimeout(r, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #181 — CDP delivery verification helpers
// matrix doc §3.1 規範観測経路: MutationObserver via Runtime.evaluate, 500ms timeout.
// ─────────────────────────────────────────────────────────────────────────────

/** Probe shape emitted by `installClickProbeExpr` and read by `readClickProbeExpr`. */
type ClickProbeReading = {
  // ok=false means we could not install / read the probe (frame mismatch, page navigated mid-probe, etc.)
  ok: boolean;
  reason?: string;
  // signals captured between install and read
  mutationCount?: number;
  urlChanged?: boolean;
  activeElementChanged?: boolean;
  // diagnostic context
  selectorFound?: boolean;
  inIframe?: boolean;
  beforeUrl?: string;
  afterUrl?: string;
};

/**
 * Install a MutationObserver on document.body + capture URL / activeElement
 * baseline. Stored on `window.__dtmClickProbe` so the post-click read can
 * pick up the result without re-installing. Idempotent within a single tab
 * — re-installing replaces the previous probe.
 *
 * matrix doc §3.1 規範: subtree:true, childList:true, attributes:true.
 * `characterData:true` is intentionally omitted — it produces high-noise
 * matches on text-content tickers (clocks, live regions) that fire
 * independently of the click and would mask silent-fail.
 */
function buildInstallClickProbeExpr(selector: string | null): string {
  return `
(function() {
  try {
    var sel = ${selector === null ? "null" : JSON.stringify(selector)};
    // by-axis (null selector): the resolver already located the element by
    // physical coords, so there is no CSS selector to look up — skip the
    // querySelector/iframe probe (always top-frame) and just observe the DOM.
    var el = sel === null ? null : document.querySelector(sel);
    var inIframe = false;
    if (sel !== null && !el) {
      // Selector might resolve inside an iframe — best-effort probe so we can
      // surface the frame mismatch as 'unverifiable' rather than asserting
      // delivered=false on a click we can't observe.
      try {
        var frames = document.querySelectorAll('iframe');
        for (var i = 0; i < frames.length; i++) {
          var f = frames[i];
          try {
            if (f.contentDocument && f.contentDocument.querySelector(sel)) {
              inIframe = true;
              break;
            }
          } catch (_e) { /* cross-origin — same-origin policy blocks read */ }
        }
      } catch (_e) { /* ignore */ }
    }
    // Reset any prior probe before creating a new one.
    if (window.__dtmClickProbe && window.__dtmClickProbe.observer) {
      try { window.__dtmClickProbe.observer.disconnect(); } catch (_e) { /* ignore */ }
    }
    var probe = {
      mutationCount: 0,
      beforeUrl: location.href,
      beforeActive: document.activeElement,
      selectorFound: !!el,
      inIframe: inIframe,
      observer: null
    };
    var obs = new MutationObserver(function(records) {
      // Aggregate count is sufficient — we only need to know "did anything happen".
      probe.mutationCount += records.length;
    });
    obs.observe(document.body, { subtree: true, childList: true, attributes: true });
    probe.observer = obs;
    window.__dtmClickProbe = probe;
    return { ok: true, selectorFound: !!el, inIframe: inIframe };
  } catch (e) {
    return { ok: false, reason: 'install_failed: ' + (e && e.message ? e.message : String(e)) };
  }
})()`;
}

/**
 * Read out the probe state, disconnect the observer, and clear the slot.
 * After this call the page state is back to baseline (no observer leak).
 */
function buildReadClickProbeExpr(): string {
  return `
(function() {
  try {
    var probe = window.__dtmClickProbe;
    if (!probe) return { ok: false, reason: 'probe_missing' };
    try { if (probe.observer) probe.observer.disconnect(); } catch (_e) { /* ignore */ }
    var afterUrl = location.href;
    var afterActive = document.activeElement;
    var result = {
      ok: true,
      mutationCount: probe.mutationCount,
      urlChanged: probe.beforeUrl !== afterUrl,
      activeElementChanged: probe.beforeActive !== afterActive,
      selectorFound: probe.selectorFound,
      inIframe: !!probe.inIframe,
      beforeUrl: probe.beforeUrl,
      afterUrl: afterUrl
    };
    delete window.__dtmClickProbe;
    return result;
  } catch (e) {
    return { ok: false, reason: 'read_failed: ' + (e && e.message ? e.message : String(e)) };
  }
})()`;
}

/**
 * Pre-click: install the MutationObserver probe. Best-effort — if install
 * fails (e.g. page just navigated, CDP detached), we return false and skip
 * the verification step rather than masking the click attempt with a
 * verification error.
 */
async function installClickProbe(
  selector: string | null,
  tabId: string | null,
  port: number,
): Promise<{ installed: boolean; selectorFound?: boolean; inIframe?: boolean; reason?: string }> {
  try {
    const r = (await evaluateInTab(buildInstallClickProbeExpr(selector), tabId, port)) as
      | { ok: true; selectorFound: boolean; inIframe: boolean }
      | { ok: false; reason: string };
    if (!r.ok) return { installed: false, reason: r.reason };
    return { installed: true, selectorFound: r.selectorFound, inIframe: r.inIframe };
  } catch (e) {
    return { installed: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Post-click: read out the MutationObserver probe and disconnect. Returns
 * `null` when the probe is unreadable (page navigated, frame swap, etc.),
 * which the caller should treat as `unverifiable`.
 */
async function readClickProbe(
  tabId: string | null,
  port: number,
): Promise<ClickProbeReading | null> {
  try {
    const r = (await evaluateInTab(buildReadClickProbeExpr(), tabId, port)) as ClickProbeReading;
    return r;
  } catch {
    return null;
  }
}

/**
 * Issue #181 hint shape (matrix doc §4.2):
 *   hints.verifyDelivery = {
 *     status: "delivered" | "unverifiable",
 *     reason?: string,           // §4.3 enum
 *     channel: "cdp",
 *     observedSignals?: { mutationCount, urlChanged, activeElementChanged }
 *   }
 */
type VerifyDeliveryHint = {
  status: "delivered" | "unverifiable";
  channel: "cdp";
  reason?: string;
  observedSignals?: {
    mutationCount: number;
    urlChanged: boolean;
    activeElementChanged: boolean;
  };
};

/**
 * Shared OS-click + CDP delivery verification (Issue #181 matrix doc §3.1), used
 * by both the selector path and the by-axis path of browser_click. Focuses the
 * browser, moves the cursor FIRST (so hover mutations on the path are baselined,
 * not counted as click-delivery — Codex P1), installs a document.body
 * MutationObserver, left-clicks, settles 500ms, reads the probe, and returns the
 * verifyDelivery hint. `probeSelector` is null for by-axis clicks (no CSS
 * selector to look up — the probe still observes the whole document; top-frame
 * only). Never throws on a verification-setup error: install/read failures
 * degrade to an `unverifiable` hint. `activeElementChanged` is reported but is
 * intentionally NOT a delivery signal (a plain click on a focusable control
 * always moves focus; treating that as delivered would mask silent-fail).
 */
async function osClickAndVerify(
  x: number,
  y: number,
  probeSelector: string | null,
  tabId: string | null,
  port: number,
): Promise<VerifyDeliveryHint> {
  await ensureBrowserFocused(port);

  const speed = DEFAULT_MOUSE_SPEED;
  if (speed === 0) {
    await mouse.setPosition(new Point(x, y));
  } else {
    const prev = mouse.config.mouseSpeed;
    mouse.config.mouseSpeed = speed;
    try {
      await mouse.move(straightTo(new Point(x, y)));
    } finally {
      mouse.config.mouseSpeed = prev;
    }
  }

  // Probe installed AFTER the cursor move (Codex P1). Best-effort: install/read
  // failures never fail the click — they degrade to `unverifiable`.
  const probe = await installClickProbe(probeSelector, tabId, port);

  await mouse.click(Button.LEFT);

  let verifyDelivery: VerifyDeliveryHint = {
    status: "unverifiable",
    channel: "cdp",
    reason: "probe_install_failed",
  };
  if (probe.installed) {
    await new Promise<void>((r) => setTimeout(r, 500));
    const reading = await readClickProbe(tabId, port);
    if (reading && reading.ok) {
      const mutationCount = reading.mutationCount ?? 0;
      const urlChanged = !!reading.urlChanged;
      const activeElementChanged = !!reading.activeElementChanged;
      const anySignal = mutationCount > 0 || urlChanged;
      if (reading.inIframe) {
        verifyDelivery = { status: "unverifiable", channel: "cdp", reason: "iframe_context_mismatch", observedSignals: { mutationCount, urlChanged, activeElementChanged } };
      } else if (anySignal) {
        verifyDelivery = { status: "delivered", channel: "cdp", observedSignals: { mutationCount, urlChanged, activeElementChanged } };
      } else {
        verifyDelivery = { status: "unverifiable", channel: "cdp", reason: "no_dom_mutation", observedSignals: { mutationCount, urlChanged, activeElementChanged } };
      }
    } else {
      verifyDelivery = { status: "unverifiable", channel: "cdp", reason: "probe_read_failed" };
    }
  }
  return verifyDelivery;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export const browserFillInputHandler = async ({
  selector,
  value,
  tabId,
  port,
  includeContext,
}: {
  selector: string;
  value: string;
  tabId?: string;
  port: number;
  includeContext: boolean;
}): Promise<ToolResult> => {
  try {
    // Fill sequence: focus the element first, then update its value from page context
    // using the native prototype setter and dispatch InputEvent/change so frameworks
    // such as React/Vue observe the same DOM updates they listen for in normal input flows.
    const focusExpr = `
(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
  el.focus();
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type') || '';
  return { ok: true, tag, type };
})()`;
    const focusResult = await evaluateInTab(focusExpr, tabId ?? null, port) as { ok: boolean; error?: string; tag?: string; type?: string };
    if (!focusResult.ok) {
      return failWith(focusResult.error ?? "browser_fill: focus failed", "browser_fill");
    }

    // Fill the input using the React-compatible path:
    //   focus → select all → use native prototype setter (bypasses React's proxy) +
    //   dispatch InputEvent so React fiber intercepts the synthetic event.
    // This is more reliable than execCommand('insertText') which is deprecated.
    //
    // Issue #181 / matrix doc §3.1: we now read back the *full* element.value
    // after dispatch (not a truncated slice) so the caller side can perform
    // exact equality. The previous 100-char truncation was a token-saving
    // measure — we keep a truncated `actual` in the response for display, but
    // the verification verdict uses the full string.
    const fillExpr = `
(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: 'Element not found after focus' };
  el.focus();
  // Select all existing content before replacing
  if (typeof el.select === 'function') {
    el.select();
  }
  // Pick the correct native prototype setter by element type to avoid
  // "Illegal invocation" when calling HTMLInputElement.prototype.set on a textarea.
  const tag = el.tagName;
  let proto = null;
  if (tag === 'INPUT') proto = HTMLInputElement.prototype;
  else if (tag === 'TEXTAREA') proto = HTMLTextAreaElement.prototype;
  const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
  if (descriptor && descriptor.set) {
    descriptor.set.call(el, ${JSON.stringify(value)});
  } else {
    el.value = ${JSON.stringify(value)};
  }
  // Dispatch native InputEvent — React 16+ intercepts 'input' for onChange
  el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  // Read back AFTER the synthetic events fire so React/Vue controlled inputs
  // get a chance to write the (possibly transformed) value back into the DOM
  // node. Comparing this against the requested value is the post-fill
  // verification (matrix doc §3.1 browser_fill).
  const fullActual = el.value !== undefined ? el.value : (el.textContent || '');
  return {
    ok: true,
    actual: (fullActual || '').slice(0, 100),
    fullActualLen: fullActual.length,
    fullMatches: fullActual === ${JSON.stringify(value)}
  };
})()`;
    const fillResult = await evaluateInTab(fillExpr, tabId ?? null, port) as
      { ok: boolean; error?: string; actual?: string; fullActualLen?: number; fullMatches?: boolean };
    if (!fillResult.ok) {
      return failWith(fillResult.error ?? "browser_fill: fill failed", "browser_fill");
    }

    // ── Issue #181: post-fill element.value verification (matrix doc §3.1) ──
    // fullMatches=false means the DOM did not retain the value we sent.
    // matrix doc §5.2 flags React controlled inputs as a known false-positive
    // source: the value was *delivered*, but the framework's onChange handler
    // rewrote it (numbers-only filter, max-length, format mask). We surface
    // this as a typed failure (BrowserFillNotDelivered) with a sub-reason on
    // the hint so the caller can disambiguate without resorting to retry.
    if (fillResult.fullMatches === false) {
      const requestedLen = value.length;
      const actualLen = fillResult.fullActualLen ?? 0;
      // Heuristic: if the actual length is *non-zero and shorter than
      // requested*, the framework most likely transformed the value
      // (truncation, character-class filter, format mask). Length ≥ requested
      // suggests the framework rejected the value entirely (e.g. type=email
      // with sanitization that prepends a default). Either way the value did
      // not land cleanly.
      const subReason =
        actualLen > 0 && actualLen <= requestedLen
          ? "controlled_input_transform"
          : "value_not_retained";
      // failWith treats every key in the third arg as a context entry except
      // those listed in ROOT_HOISTED_KEYS (`hints`, etc.). The diagnostic
      // fields below land under failure.context.* and `hints` lands at the
      // failure root — matching the success-path envelope shape (matrix doc
      // §4.2) so callers can read failure.hints.verifyDelivery and
      // success.hints.verifyDelivery from the same path.
      return failWith(
        new Error("BrowserFillNotDelivered"),
        "browser_fill",
        {
          selector,
          requested: value.slice(0, 100),
          requestedLen,
          actual: fillResult.actual,
          actualLen,
          subReason,
          note:
            subReason === "controlled_input_transform"
              ? "False-positive watch: React/Vue controlled inputs may rewrite the value in onChange (numbers-only filter, max-length, format mask). The bytes reached the page but the framework chose not to keep them. Treat actual as authoritative."
              : "The DOM did not retain the requested value after fill — input may be readOnly, disabled, or guarded by a synthetic-event proxy that rejects programmatic writes.",
          hints: {
            verifyDelivery: {
              status: "unverifiable",
              channel: "cdp",
              reason: "value_mismatch",
              subReason,
              actualLen,
              requestedLen,
            },
          },
        }
      );
    }

    const lines = [
      JSON.stringify({
        ok: true,
        selector,
        value,
        actual: fillResult.actual,
        // matrix doc §4.2 規範 hint shape — always emit `delivered` on success
        // path so callers can pin verification end-to-end without conditionally
        // checking `hints` presence.
        hints: {
          verifyDelivery: {
            status: "delivered",
            channel: "cdp",
          },
        },
      }),
    ];
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      lines.push(
        "",
        `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
        `readyState: "${tabCtx.readyState}"`,
      );
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  } catch (err) {
    return failWith(err, "browser_fill");
  }
};

export const browserGetFormHandler = async ({
  selector,
  includeHidden,
  maxResults,
  tabId,
  port,
  includeContext,
}: {
  selector: string;
  includeHidden: boolean;
  maxResults: number;
  tabId?: string;
  port: number;
  includeContext: boolean;
}): Promise<ToolResult> => {
  try {
    const expr = `
(function() {
  const scope = document.querySelector(${JSON.stringify(selector)});
  if (!scope) return { ok: false, error: 'element not found' };
  const FIELD_SEL = 'input, select, textarea, button';
  const isSelf = scope.matches(FIELD_SEL);
  const children = Array.from(scope.querySelectorAll(FIELD_SEL));
  const elements = isSelf ? [scope, ...children] : children;
  const includeHidden = ${includeHidden};
  const maxResults = ${maxResults};
  const MAX_VALUE_LEN = 200;
  const fields = [];
  for (const el of elements) {
    if (fields.length >= maxResults) break;
    const tagName = el.tagName.toLowerCase();
    const attrType = el.getAttribute('type') || '';
    const type = attrType ||
      (tagName === 'select' ? 'select' :
       tagName === 'textarea' ? 'textarea' :
       tagName === 'button' ? 'button' : 'text');
    if (!includeHidden && type === 'hidden') continue;
    const name = el.name || null;
    const id = el.id || null;
    let value = null;
    let checked = null;
    if (tagName === 'button') {
      value = el.textContent.trim() || null;
    } else if (tagName === 'input' && (type === 'checkbox' || type === 'radio')) {
      checked = el.checked;
      value = el.getAttribute('value');
    } else if (tagName === 'input' || tagName === 'textarea') {
      const raw = el.value || '';
      value = raw ? (raw.length > MAX_VALUE_LEN ? raw.slice(0, MAX_VALUE_LEN) + '\u2026' : raw) : null;
    } else if (tagName === 'select') {
      value = el.value || null;
    }
    // Resolve label: for[id] > ancestor LABEL (strip child inputs) > aria-labelledby > aria-label
    let label = null;
    if (id) {
      const labelEl = document.querySelector('label[for=' + JSON.stringify(id) + ']');
      if (labelEl) label = labelEl.textContent.trim() || null;
    }
    if (!label) {
      let p = el.parentElement;
      while (p) {
        if (p.tagName === 'LABEL') {
          const clone = p.cloneNode(true);
          clone.querySelectorAll(FIELD_SEL).forEach(function(n) { n.remove(); });
          label = clone.textContent.trim() || null;
          break;
        }
        p = p.parentElement;
      }
    }
    if (!label) {
      const lbAttr = el.getAttribute('aria-labelledby');
      if (lbAttr) {
        label = lbAttr.trim().split(/\\s+/).map(function(i) {
          var e = document.getElementById(i); return e ? e.textContent.trim() : '';
        }).filter(Boolean).join(' ') || null;
      }
    }
    if (!label) {
      label = el.getAttribute('aria-label') || null;
    }
    fields.push({
      tagName,
      type,
      name,
      id,
      value,
      checked,
      placeholder: el.placeholder || null,
      disabled: el.disabled,
      readOnly: !!el.readOnly,
      label,
    });
  }
  return { ok: true, selector: ${JSON.stringify(selector)}, count: fields.length, fields };
})()`;

    const result = await evaluateInTab(expr, tabId ?? null, port) as
      | { ok: true; selector: string; count: number; fields: unknown[] }
      | { ok: false; error: string };

    if (!result.ok) {
      return failWith("Element not found", "browser_form", { selector });
    }

    const lines = [JSON.stringify(result)];
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      lines.push(
        "",
        `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
        `readyState: "${tabCtx.readyState}"`,
      );
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  } catch (err) {
    return failWith(err, "browser_form");
  }
};

export const browserConnectHandler = async ({
  port,
}: {
  port: number;
}): Promise<ToolResult> => {
  try {
    const tabs = await listTabs(port);
    const pageTabs = tabs.filter((t) => t.type === "page");

    // Parallel hasFocus() evaluation to find the active tab
    const focusResults = await Promise.allSettled(
      pageTabs.map((t) =>
        evaluateInTab("document.hasFocus()", t.id, port)
          .then((v) => ({ id: t.id, active: !!v }))
          .catch(() => ({ id: t.id, active: false }))
      )
    );
    const focusMap = new Map<string, boolean>();
    for (const r of focusResults) {
      if (r.status === "fulfilled") {
        focusMap.set(r.value.id, r.value.active);
      }
    }

    const summary = pageTabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: focusMap.get(t.id) ?? false,
    }));

    const activeTab = summary.find((t) => t.active)?.id ?? null;

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Connected to Chrome/Edge CDP at port ${port}.`,
            `${pageTabs.length} page tab(s) found:`,
            JSON.stringify({ port, active: activeTab, tabs: summary }, null, 2),
            "",
            "Pass a tab's id to other browser_* tools to target it, or omit to use the first tab.",
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    return failWith(err, "browser_open");
  }
};

export const browserFindElementHandler = async ({
  selector,
  tabId,
  port,
  includeContext,
}: {
  selector: string;
  tabId?: string;
  port: number;
  includeContext: boolean;
}): Promise<ToolResult> => {
  try {
    const coords = await getElementScreenCoords(
      selector,
      tabId ?? null,
      port
    );
    const lines = [
      `Element found: ${selector}`,
      JSON.stringify({
        center: { x: coords.x, y: coords.y },
        topLeft: { x: coords.left, y: coords.top },
        size: { width: coords.width, height: coords.height },
        inViewport: coords.inViewport,
        clickAt: { x: coords.x, y: coords.y },
      }, null, 2),
      "",
      !coords.inViewport
        ? "Warning: element is outside the visible viewport. Scroll into view before clicking."
        : "Element is visible. Pass clickAt coords to mouse_click.",
    ];
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      lines.push(
        "",
        `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
        `readyState: "${tabCtx.readyState}"`,
      );
    }
    return {
      content: [
        {
          type: "text" as const,
          text: lines.join("\n"),
        },
      ],
    };
  } catch (err) {
    return failWith(err, "browser_locate");
  }
};

/**
 * Phase 0 (ADR-023 FR-5): opt-in scroll-into-view for browser_click. One eval
 * measures the element and, if its center is outside the viewport, calls
 * scrollIntoView({block:'center'}); the caller then waits briefly for the scroll
 * to settle so the subsequent coord fetch sees it on-screen. The in-viewport
 * test mirrors getElementScreenCoords' center-based definition (cdp-bridge.ts).
 * Best-effort: a missing element / eval failure is swallowed here and surfaced
 * by the existing viewport / coord checks downstream.
 */
async function scrollSelectorIntoViewIfNeeded(
  selector: string,
  tabId: string | null,
  port: number,
): Promise<void> {
  try {
    const expr = `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'missing';
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx >= 0 && cx < window.innerWidth && cy >= 0 && cy < window.innerHeight) return 'inViewport';
      // behavior:'instant' disables CSS scroll-behavior:smooth so the element is
      // in place by the time the short settle below elapses (Phase 0 review P2-3).
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      return 'scrolled';
    })()`;
    const res = await evaluateInTab(expr, tabId, port);
    if (res === "scrolled") {
      await new Promise<void>((r) => setTimeout(r, 250));
    }
  } catch {
    /* best-effort — the real failure is reported by the viewport check below */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-023 Phase 1: by-axis (semantic) resolution → action, shared by
// browser_click (PR3) and browser_fill (PR4).
// ─────────────────────────────────────────────────────────────────────────────

/** Map a resolver `error` outcome (gather-time failure) to a typed tool failure. */
function browserResolveErrorToFailure(
  outcome: Extract<ResolveActionOutcome, { kind: "error" }>,
  tool: string,
  ctx: Record<string, unknown>,
): ToolResult {
  const detail = outcome.message ? ` — ${outcome.message}` : "";
  switch (outcome.code) {
    case "ScopeNotFound":
      return failCode("ScopeNotFound", `${tool}: scope selector matched no element${detail}`, {
        suggest: ["Verify the scope CSS selector matches at least one element", "Omit scope to search the full document"],
        context: ctx,
      });
    case "InvalidRegex":
      return failCode("InvalidArgs", `${tool}: invalid regex pattern${detail}`, {
        suggest: ["Verify the regex syntax", "Use by:'text' for a literal substring"],
        context: ctx,
      });
    case "Timeout":
      return failCode("BrowserSearchTimeout", `${tool}: resolver scan budget exceeded${detail}`, {
        suggest: ["Narrow the search with a scope (CSS selector)", "Use a more specific pattern"],
        context: ctx,
      });
    case "EvalError":
      // The injected JS threw — most often an invalid CSS `scope` (querySelector
      // SyntaxError); also a transient CDP failure (detach/timeout). Surface as
      // InvalidArgs with a scope-validity hint rather than a generic ToolError.
      return failCode("InvalidArgs", `${tool}: resolver evaluation failed${detail}`, {
        suggest: ["Verify the scope CSS selector is valid", "Retry — the page may have navigated mid-call"],
        context: ctx,
      });
    default:
      return failCode("ToolError", `${tool}: resolver evaluation failed${detail}`, { context: ctx });
  }
}

/**
 * Map a resolver ambiguous / noActionable stop to a typed tool failure. The
 * candidate fingerprints + fixed next-hints are surfaced so the agent can
 * disambiguate (by index / refined pattern) and retry — the resolver never
 * guesses (ADR §1.2 D3). `BrowserAmbiguousTarget` / `BrowserNoActionableTarget`
 * use inline failCode (ElementNotInViewport precedent → no SUGGESTS/catalog drift).
 */
function browserResolveStopToFailure(
  outcome: Extract<ResolveActionOutcome, { kind: "ambiguous" | "noActionable" }>,
  tool: string,
  ctx: Record<string, unknown>,
): ToolResult {
  const code = outcome.kind === "ambiguous" ? "BrowserAmbiguousTarget" : "BrowserNoActionableTarget";
  const message =
    outcome.kind === "ambiguous"
      ? `${tool}: ${outcome.total} elements match — ambiguous, not auto-acting. Disambiguate and retry.`
      : `${tool}: ${outcome.total} match(es) found but none is an auto-actionable target.`;
  return failCode(code, message, {
    suggest: [...outcome.next],
    context: { ...ctx, total: outcome.total, returned: outcome.returned, truncated: outcome.truncated, candidates: outcome.candidates },
  });
}

/**
 * by-axis browser_click: resolve a single actionable target semantically, then
 * OS-click at its resolved physical coords (no second querySelector — coords come
 * from the same gather eval, ADR §1.2 D1). Ambiguous / non-actionable / error
 * stop with a typed failure. Selector mode stays on the bit-equal path.
 */
async function handleBrowserClickByAxis(args: {
  by: "text" | "regex" | "role" | "ariaLabel";
  pattern: string;
  role?: string;
  scope?: string;
  caseSensitive?: boolean;
  tabId?: string;
  port: number;
  lensId?: string;
}): Promise<ToolResult> {
  const { by, pattern, role, scope, caseSensitive, tabId, port, lensId } = args;

  let perceptionEnvBrowser: import("../engine/perception/types.js").PostPerception | undefined;
  if (lensId) {
    const guardResult = await evaluatePreToolGuards(lensId, "browser_click", {});
    if (!guardResult.ok && guardResult.policy === "block") {
      const env = buildEnvelopeFor(lensId, { toolName: "browser_click" });
      return failWith(
        new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
        "browser_click",
        { lensId, guard: guardResult.failedGuard, _perceptionForPost: env },
      );
    }
    perceptionEnvBrowser = buildEnvelopeFor(lensId, { toolName: "browser_click" }) ?? undefined;
  } else if (isAutoGuardEnabled() && (tabId || port)) {
    // Parity with the selector path's auto-guard (Opus PR3 P2): verify tab
    // readyState + identity before resolving, and attach the perception envelope
    // on success. Uses the "strict" readiness policy (block on readyState !==
    // "complete") — the by-axis resolver has no pre-resolution selector, and the
    // selector-in-viewport check is unnecessary because the gather eval's
    // receivesEvents hit-test already gates in-viewport actionability.
    const descriptor: import("./_action-guard.js").ActionTargetDescriptor = {
      kind: "browserTab", port, tabId, urlIncludes: undefined,
    };
    const ag = await runActionGuard({
      toolName: "browser_click", actionKind: "browserCdp", descriptor,
      browserReadinessPolicy: "strict",
    });
    if (ag.block) {
      return failWith(new Error(`AutoGuardBlocked: ${ag.summary.next}`), "browser_click", { _perceptionForPost: ag.summary });
    }
    perceptionEnvBrowser = ag.summary;
  }

  const outcome = await resolveBrowserActionTarget({
    by, pattern, role, scope, caseSensitive, action: "click", tabId: tabId ?? null, port,
  });
  const ctx = { by, pattern, ...(role ? { role } : {}), ...(scope ? { scope } : {}) };
  if (outcome.kind === "error") return browserResolveErrorToFailure(outcome, "browser_click", ctx);
  if (outcome.kind !== "resolved") return browserResolveStopToFailure(outcome, "browser_click", ctx);

  // Resolved: OS-click at the physical point (probe with null selector — the
  // resolver located the element by coords; document-level mutation probe).
  const verifyDelivery = await osClickAndVerify(outcome.physical.x, outcome.physical.y, null, tabId ?? null, port);
  const tabCtx = await getTabContext(tabId ?? null, port);
  return ok({
    ok: true,
    clicked: { by, pattern, ...(role ? { role } : {}) },
    at: outcome.physical,
    resolved: { rect: outcome.rect, climbDepth: outcome.climbDepth },
    activeTab: { id: tabCtx.id, title: tabCtx.title, url: tabCtx.url },
    readyState: tabCtx.readyState,
    hints: { verifyDelivery },
    ...(perceptionEnvBrowser && { _perceptionForPost: perceptionEnvBrowser }),
  });
}

export const browserClickElementHandler = async ({
  selector,
  by,
  pattern,
  role,
  scope,
  caseSensitive,
  narrate,
  tabId,
  port,
  lensId,
  fixId,
  scrollIntoView,
}: {
  selector?: string;
  by?: "text" | "regex" | "role" | "ariaLabel";
  pattern?: string;
  role?: string;
  scope?: string;
  caseSensitive?: boolean;
  narrate?: string;
  tabId?: string;
  port: number;
  lensId?: string;
  fixId?: string;
  scrollIntoView?: boolean;
}): Promise<ToolResult> => {
  try {
    // ADR-023 Phase 1: by-axis (semantic) targeting path. The registration
    // schema's .refine() guarantees exactly-one-of(selector | by+pattern), so a
    // present `by` means selector is absent → resolver path. The selector path
    // below is unchanged (bit-equal, NFR-1 / AC-9).
    if (by && pattern) {
      return await handleBrowserClickByAxis({ by, pattern, role, scope, caseSensitive, tabId, port, lensId });
    }
    if (!selector) {
      return failCode("InvalidArgs", "browser_click: provide either selector or by+pattern.", {
        suggest: ["Pass a CSS selector, or by+pattern (e.g. by:'text', pattern:'Save')."],
      });
    }

    // Phase G: fixId approval prologue
    let effectiveSelector = selector;
    let effectiveTabId = tabId;
    if (fixId) {
      const vr = validateAndPrepareFix(fixId, "browser_click");
      if (!vr.ok || !vr.fix) return failWith(new Error(vr.errorCode!), "browser_click");
      if (typeof vr.fix.args.selector === "string") effectiveSelector = vr.fix.args.selector;
      if (typeof vr.fix.args.tabId === "string") effectiveTabId = vr.fix.args.tabId;
      consumeFix(fixId);
    }

    let perceptionEnvBrowser: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "browser_click", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        const env = buildEnvelopeFor(lensId, { toolName: "browser_click" });
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "browser_click",
          { lensId, guard: guardResult.failedGuard, _perceptionForPost: env }
        );
      }
      perceptionEnvBrowser = buildEnvelopeFor(lensId, { toolName: "browser_click" }) ?? undefined;
    } else if (isAutoGuardEnabled() && (tabId || port)) {
      // Phase F: get coords first so we know inViewport for selectorInViewport policy
      const coordsForGuard = await getElementScreenCoords(effectiveSelector, effectiveTabId ?? null, port);
      // Phase 0 (ADR-023 FR-5): when scrollIntoView is requested, do NOT hard-fail
      // here — the post-guard scroll (after the block decision) brings it into view
      // and the main viewport check below still gates clickability. readyState!=
      // complete + off-viewport still blocks via the guard (browserSelectorInViewport).
      if (!coordsForGuard.inViewport && !scrollIntoView) {
        // Element not in viewport — fail before running guard
        return failCode(
          "ElementNotInViewport",
          `browser_click: element "${effectiveSelector}" is outside the visible viewport.`,
          {
            suggest: ["Element is outside the visible viewport. Scroll it into view first using browser_eval with element.scrollIntoView(), then retry browser_click."],
            context: { selector: effectiveSelector },
          },
        );
      }
      const descriptor: import("./_action-guard.js").ActionTargetDescriptor = {
        kind: "browserTab", port, tabId: effectiveTabId, urlIncludes: undefined,
      };
      // Phase F/G: pass inViewport + selectorInViewport policy; carry selector for fixId
      const ag = await runActionGuard({
        toolName: "browser_click", actionKind: "browserCdp", descriptor,
        browserReadinessPolicy: "selectorInViewport",
        browserSelectorInViewport: coordsForGuard.inViewport,
        fixCarryingArgs: { selector: effectiveSelector, tabId: effectiveTabId, port },
      });
      if (ag.block) {
        return failWith(new Error(`AutoGuardBlocked: ${ag.summary.next}`), "browser_click", { _perceptionForPost: ag.summary });
      }
      perceptionEnvBrowser = ag.summary;
    }
    // CDP snapshot before click (for narrate:"rich")
    let beforeUrl: string | null = null;
    if (narrate === "rich") {
      try {
        const ctx = await getTabContext(effectiveTabId ?? null, port);
        beforeUrl = ctx.url ?? null;
      } catch { /* ignore */ }
    }

    // Phase 0 (ADR-023 FR-5): opt-in auto-scroll, AFTER every guard block decision
    // (lens / auto-guard) so a denied action never mutates page state by scrolling
    // (Codex P1). No-op when already in view or not requested.
    if (scrollIntoView) {
      await scrollSelectorIntoViewIfNeeded(effectiveSelector, effectiveTabId ?? null, port);
    }

    const coords = await getElementScreenCoords(
      effectiveSelector,
      effectiveTabId ?? null,
      port
    );
    if (!coords.inViewport) {
      return failCode(
        "ElementNotInViewport",
        `browser_click: element "${effectiveSelector}" is outside the visible viewport.`,
        {
          suggest: ["Element is outside the visible viewport. Scroll it into view first using browser_eval with element.scrollIntoView(), then retry browser_click."],
          context: { selector: effectiveSelector },
        },
      );
    }
    // OS click + CDP delivery verification (Issue #181, shared with the by-axis
    // path). Focus → move → probe → click → settle → read → verifyDelivery.
    const verifyDelivery = await osClickAndVerify(coords.x, coords.y, effectiveSelector, effectiveTabId ?? null, port);

    const tabCtx = await getTabContext(effectiveTabId ?? null, port);

    // Build rich block for CDP diff
    let richBlock: RichBlock | undefined;
    if (narrate === "rich" && beforeUrl !== null) {
      try {
        const afterUrl = tabCtx.url ?? null;
        richBlock = {
          appeared: [],
          disappeared: [],
          valueDeltas: [],
          diffSource: "cdp",
          ...(beforeUrl !== afterUrl && afterUrl
            ? { navigation: { fromUrl: beforeUrl, toUrl: afterUrl } }
            : {}),
        };
      } catch {
        richBlock = { appeared: [], disappeared: [], valueDeltas: [], diffSource: "none", diffDegraded: "timeout" };
      }
    }

    return ok({
      ok: true,
      clicked: selector,
      at: { x: coords.x, y: coords.y },
      activeTab: { id: tabCtx.id, title: tabCtx.title, url: tabCtx.url },
      readyState: tabCtx.readyState,
      hints: { verifyDelivery },
      ...(richBlock ? { _richForPost: richBlock } : {}),
      ...(perceptionEnvBrowser && { _perceptionForPost: perceptionEnvBrowser }),
    });
  } catch (err) {
    return failWith(err, "browser_click");
  }
};

/** Phase J: safe JSON serialization for eval results — handles circular refs, functions, etc. */
function safeStringifyEval(value: unknown): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, val: unknown): unknown => {
    if (typeof val === "function") return "[Function]";
    if (typeof val === "symbol")   return "[Symbol]";
    if (typeof val === "bigint")   return String(val) + "n";
    if (val === undefined)         return "[Undefined]";
    if (val !== null && typeof val === "object") {
      if (seen.has(val as object)) return "[Circular]";
      seen.add(val as object);
    }
    return val;
  };
  try { return JSON.stringify(value, replacer, 2) ?? "[Unserializable]"; }
  catch {
    try { return String(value); }
    catch { return "[Unserializable]"; }
  }
}

/** Phase J: Deep-clone via JSON round-trip to break circular refs before passing to ok() transport. */
function safeCloneForTransport(value: unknown): unknown {
  try { return JSON.parse(safeStringifyEval(value)); }
  catch { return "[Unserializable]"; }
}

// Phase 3: 'js' action implementation. Public dispatcher `browserEvalHandler`
// (defined near the registration) routes here when args.action === "js".
/**
 * Phase 0 (ADR-023 FR-8): map a CDP per-command timeout thrown by evaluateInTab
 * into a typed BrowserEvalTimeout with a wait_until hint. A long in-page poll
 * inside a single eval always exhausts the CDP timeout; without this the raw
 * message would classify() to the generic UiaTimeout (`_errors.ts:579`), which
 * is misleading for an eval-polling failure.
 *
 * Keys off cdp-bridge's literal "CDP timeout:" prefix (`cdp-bridge.ts`
 * session.send). The string contract spans two files with no compile-time
 * guard, so it is pinned by tests/unit/browser-eval-timeout-typed-code.test.ts
 * (Phase 0 review P2-1). The user-facing seconds value is derived from
 * CMD_TIMEOUT_MS (single source, review P2-2). Returns null for any other error
 * so the caller falls through to failWith.
 */
export function maybeBrowserEvalTimeoutFailure(
  err: unknown,
  tabId: string | undefined,
  port: number,
): ToolResult | null {
  const msg = err instanceof Error ? err.message : String(err);
  // Match the bridge's exact "CDP timeout:" prefix (cdp-bridge.ts session.send).
  // A page-script error is wrapped as "JS exception in tab: ..." (cdp-bridge.ts),
  // so a user expression that merely mentions "CDP timeout" is NOT mislabeled
  // (Codex Round 2 P3 — prefix match, not substring).
  if (!msg.startsWith("CDP timeout:")) return null;
  return failCode(
    "BrowserEvalTimeout",
    `browser_eval hit the CDP per-command timeout (~${Math.round(CMD_TIMEOUT_MS / 1000)}s). ` +
      "A single eval cannot run longer than that, so in-page polling loops will always time out here.",
    {
      suggest: [
        "Do not poll inside browser_eval — one eval is bounded by the CDP per-command timeout.",
        "To wait for a DOM element or text, use wait_until({condition:'element_matches', target:{by, pattern, scope}}).",
        "To wait for an SPA route change, use wait_until({condition:'url_matches', target:{pattern}}).",
        "To wait for page load, use wait_until({condition:'ready_state'}).",
      ],
      context: { tabId, port },
    },
  );
}

export const browserEvalJsHandler = async ({
  expression,
  tabId,
  port,
  includeContext,
  lensId,
  withPerception,
}: {
  expression: string;
  tabId?: string;
  port: number;
  includeContext: boolean;
  lensId?: string;
  withPerception?: boolean;
}): Promise<ToolResult> => {
  try {
    let perceptionEnv: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "browser_eval", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "browser_eval",
          { lensId, guard: guardResult.failedGuard }
        );
      }
    } else if (isAutoGuardEnabled() && (tabId || port)) {
      const descriptor: import("./_action-guard.js").ActionTargetDescriptor = {
        kind: "browserTab", port, tabId, urlIncludes: undefined,
      };
      // Phase F: strict policy for browser_eval (v3 §5.4)
      const ag = await runActionGuard({
        toolName: "browser_eval", actionKind: "browserCdp", descriptor,
        browserReadinessPolicy: "strict",
      });
      if (ag.block) {
        return failWith(new Error(`AutoGuardBlocked: ${ag.summary.next}`), "browser_eval", {
          context: { guardStatus: ag.summary.status },
          ...(withPerception && { _perceptionForPost: ag.summary }),
        });
      }
      perceptionEnv = ag.summary;
    }

    const preparedExpression = prepareBrowserEvalExpression(expression);
    let rawResult: unknown;
    try {
      rawResult = await evaluateInTab(preparedExpression, tabId ?? null, port);
    } catch (evalErr) {
      // Phase 0 (ADR-023 FR-8): only the eval itself gets the BrowserEvalTimeout
      // remap — a CDP timeout from post-eval work (e.g. getCachedTabContext) keeps
      // its normal classification (Codex P2). Non-timeout eval errors re-throw to
      // the outer catch.
      const timeoutFailure = maybeBrowserEvalTimeoutFailure(evalErr, tabId, port);
      if (timeoutFailure) return timeoutFailure;
      throw evalErr;
    }

    if (withPerception) {
      // Phase J: structured response mode — safeClone to avoid circular ref in transport
      const safeResult = rawResult === null || rawResult === undefined ? null : safeCloneForTransport(rawResult);
      const tabCtx = includeContext ? await getCachedTabContext(tabId ?? null, port) : undefined;
      return ok({
        ok: true,
        result: safeResult,
        ...(tabCtx && { activeTab: { id: tabCtx.id, title: tabCtx.title, url: tabCtx.url }, readyState: tabCtx.readyState }),
        ...(perceptionEnv && { _perceptionForPost: perceptionEnv }),
      });
    }

    // Default raw text path (backwards compatible)
    const text = rawResult === null || rawResult === undefined
      ? "(null)"
      : typeof rawResult === "string"
        ? rawResult
        : safeStringifyEval(rawResult);
    const lines = [text];
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      lines.push(
        "",
        `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
        `readyState: "${tabCtx.readyState}"`,
      );
    }
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  } catch (err) {
    return failWith(err, "browser_eval");
  }
};

/**
 * Issue #24: when a selector misses, probe `document.body`'s top-level
 * children so the LLM gets an alternative-selector hint instead of having
 * to blindly retry. Returns a compact descriptor list (max 10 children,
 * tag/id/classes/childCount each) or null if probing itself fails.
 */
async function probeBodyStructure(
  tabId: string | null,
  port: number,
): Promise<Array<{ tag: string; id: string | null; classes: string[]; childCount: number }> | null> {
  try {
    const expr = `(function() {
      try {
        return JSON.stringify(
          Array.from(document.body.children).slice(0, 10).map(function(el) {
            var classList = (el.className && typeof el.className === 'string')
              ? el.className.trim().split(/\\s+/).slice(0, 3)
              : [];
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              classes: classList,
              childCount: el.children.length,
            };
          })
        );
      } catch (e) { return null; }
    })()`;
    const raw = await evaluateInTab(expr, tabId, port);
    if (typeof raw !== "string") return null;
    return JSON.parse(raw) as Array<{ tag: string; id: string | null; classes: string[]; childCount: number }>;
  } catch {
    return null;
  }
}

export const browserGetDomHandler = async ({
  selector,
  tabId,
  port,
  maxLength,
  includeContext,
}: {
  selector?: string;
  tabId?: string;
  port: number;
  maxLength: number;
  includeContext: boolean;
}): Promise<ToolResult> => {
  try {
    const html = await getDomHtml(
      selector ?? null,
      tabId ?? null,
      port,
      maxLength
    );
    const lines = [html];
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      lines.push(
        "",
        `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
        `readyState: "${tabCtx.readyState}"`,
      );
    }
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  } catch (err) {
    // Issue #24: when the failure is "Element not found", attach a small
    // body-structure descriptor so the LLM has a starting point for an
    // alternative selector instead of guessing blindly. Probing is itself
    // best-effort — any failure leaves the original error untouched.
    const msg = err instanceof Error ? err.message : String(err);
    if (selector && /Element not found:/i.test(msg)) {
      const bodyStructure = await probeBodyStructure(tabId ?? null, port);
      return failWith(err, "browser_eval", bodyStructure ? { selector, bodyStructure } : { selector });
    }
    // Phase 3: surfaced to LLM via browser_eval(action='dom') dispatcher.
    return failWith(err, "browser_eval");
  }
};

export const browserNavigateHandler = async ({
  url,
  narrate,
  tabId,
  port,
  waitForLoad,
  loadTimeoutMs,
  lensId,
}: {
  url: string;
  narrate?: string;
  tabId?: string;
  port: number;
  waitForLoad: boolean;
  loadTimeoutMs: number;
  lensId?: string;
}): Promise<ToolResult> => {
  try {
    let perceptionEnvNav: import("../engine/perception/types.js").PostPerception | undefined;
    if (lensId) {
      const guardResult = await evaluatePreToolGuards(lensId, "browser_navigate", {});
      if (!guardResult.ok && guardResult.policy === "block") {
        const env = buildEnvelopeFor(lensId, { toolName: "browser_navigate" });
        return failWith(
          new Error(`GuardFailed: ${guardResult.failedGuard?.reason ?? "guard evaluation failed"}`),
          "browser_navigate",
          { lensId, guard: guardResult.failedGuard, _perceptionForPost: env }
        );
      }
      perceptionEnvNav = buildEnvelopeFor(lensId, { toolName: "browser_navigate" }) ?? undefined;
    } else if (isAutoGuardEnabled() && (tabId || port)) {
      const descriptor: import("./_action-guard.js").ActionTargetDescriptor = {
        kind: "browserTab", port, tabId, urlIncludes: undefined,
      };
      // Phase F: navigationGate policy — interactive is acceptable for pre-navigation guard
      const ag = await runActionGuard({
        toolName: "browser_navigate", actionKind: "browserCdp", descriptor,
        browserReadinessPolicy: "navigationGate",
      });
      if (ag.block) {
        return failWith(new Error(`AutoGuardBlocked: ${ag.summary.next}`), "browser_navigate", { _perceptionForPost: ag.summary });
      }
      perceptionEnvNav = ag.summary;
    }
    const startedAt = Date.now();
    // Capture beforeUrl for rich narration
    let beforeUrl: string | null = null;
    if (narrate === "rich") {
      try {
        const ctx = await getTabContext(tabId ?? null, port);
        beforeUrl = ctx.url ?? null;
      } catch { /* ignore */ }
    }
    const navResult = await navigateTo(url, tabId ?? null, port);

    // Surface CDP navigation errors (DNS failure etc.)
    if (navResult.errorText) {
      return failCode(
        "NavigateFailed",
        `browser_navigate failed: ${navResult.errorText}`,
        {
          suggest: [
            "Check the URL is correct and reachable",
            "Verify network connectivity",
          ],
          context: { url, errorText: navResult.errorText },
        },
      );
    }

    if (!waitForLoad) {
      return ok({
        ok: true,
        url,
        waited: false,
        hint: `Wait a moment, then use browser_eval("document.readyState") to check if the page has loaded.`,
      });
    }

    // Wait for document.readyState === "complete"
    await new Promise<void>((r) => setTimeout(r, 200));
    const poll = await pollUntil(
      async () => {
        try {
          const state = await evaluateInTab("document.readyState", tabId ?? null, port);
          return state === "complete" ? true : null;
        } catch {
          return null;
        }
      },
      { intervalMs: 150, timeoutMs: loadTimeoutMs }
    );

    const tabCtx = await getTabContext(tabId ?? null, port);
    const elapsedMs = Date.now() - startedAt;

    if (!poll.ok) {
      // Timeout — not a failure, LLM can continue
      return ok({
        ok: true,
        url: tabCtx.url || url,
        title: tabCtx.title,
        readyState: tabCtx.readyState,
        elapsedMs,
        waited: true,
        hints: { warnings: ["NavigateTimeout"] },
      });
    }

    // Build rich navigation block
    const richBlock: RichBlock | undefined = narrate === "rich" ? {
      appeared: [],
      disappeared: [],
      valueDeltas: [],
      diffSource: "cdp",
      ...(beforeUrl && beforeUrl !== (tabCtx.url || url)
        ? { navigation: { fromUrl: beforeUrl, toUrl: tabCtx.url || url } }
        : {}),
    } : undefined;

    return ok({
      ok: true,
      url: tabCtx.url || url,
      title: tabCtx.title,
      readyState: tabCtx.readyState,
      elapsedMs,
      waited: true,
      ...(richBlock ? { _richForPost: richBlock } : {}),
      ...(perceptionEnvNav && { _perceptionForPost: perceptionEnvNav }),
    });
  } catch (err) {
    return failWith(err, "browser_navigate");
  }
};

export const browserGetInteractiveHandler = async ({
  scope,
  types,
  inViewportOnly,
  maxResults,
  tabId,
  port,
  includeContext,
}: {
  scope?: string;
  types: Array<"link" | "button" | "input" | "all">;
  inViewportOnly: boolean;
  maxResults: number;
  tabId?: string;
  port: number;
  includeContext: boolean;
}): Promise<ToolResult> => {
  try {
    const includeAll = types.includes("all");
    const includeLinks   = includeAll || types.includes("link");
    const includeButtons = includeAll || types.includes("button");
    const includeInputs  = includeAll || types.includes("input");

    // Build the CSS selector for targeted element types
    const parts: string[] = [];
    if (includeLinks)   parts.push("a[href]");
    if (includeButtons) parts.push("button:not([disabled])", "[role='button']");
    if (includeInputs)  parts.push(
      "input:not([type='hidden']):not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])"
    );
    // ARIA-roled custom controls (Radix / shadcn / MUI / Headless UI / GitHub all use these).
    // Always included when any type was requested — they are interactive by definition.
    if (includeAll || includeButtons || includeInputs || includeLinks) {
      parts.push(
        "[role='switch']:not([aria-disabled='true'])",
        "[role='checkbox']:not([aria-disabled='true'])",
        "[role='radio']:not([aria-disabled='true'])",
        "[role='tab']:not([aria-disabled='true'])",
        "[role='menuitem']:not([aria-disabled='true'])",
        "[role='option']:not([aria-disabled='true'])",
      );
    }
    const cssQuery = parts.join(", ");

    // Fix #1: guard against empty query (types:[]) which causes querySelectorAll("") to throw
    if (!cssQuery) {
      return {
        content: [{ type: "text" as const, text: "browser_overview: no element types selected. Pass at least one of 'link', 'button', 'input', or 'all'." }],
      };
    }

    const expression = `
(function() {
  const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : "document"} || document;
  const viewportOnly = ${JSON.stringify(inViewportOnly)};
  const maxN = ${JSON.stringify(maxResults)};
  const cssQ = ${JSON.stringify(cssQuery)};

  // Fix #2: use getBoundingClientRect for visibility — handles position:fixed correctly.
  // offsetParent is null for fixed elements even when visible, so we cannot use it.
  function isVisible(el) {
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function inViewportRect(rect) {
    return rect.top < window.innerHeight && rect.bottom > 0 &&
           rect.left < window.innerWidth && rect.right > 0;
  }

  // Fix #3: use CSS.escape for IDs; improve nth-child fallback to include parent path
  function bestSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const name = el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(name) + ']';
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.length < 80)
      return el.tagName.toLowerCase() + '[aria-label=' + JSON.stringify(ariaLabel) + ']';
    if (el.tagName === 'A' && el.href) {
      try {
        const u = new URL(el.href);
        const dp = u.pathname.match(/\\/dp\\/([A-Z0-9]{10})/);
        if (dp) return 'a[href*="/dp/' + dp[1] + '"]';
        if (u.pathname.length > 1 && u.pathname.length < 60)
          return 'a[href*=' + JSON.stringify(u.pathname.slice(0, 40)) + ']';
      } catch(e) {}
    }
    // Stable data attributes
    for (const attr of ['data-testid', 'data-asin']) {
      const v = el.getAttribute(attr);
      if (v && v.length < 60) return el.tagName.toLowerCase() + '[' + attr + '=' + JSON.stringify(v) + ']';
    }
    // nth-child with up to 2 ancestor levels for specificity
    let node = el;
    let path = '';
    for (let depth = 0; depth < 2 && node.parentElement; depth++) {
      const p = node.parentElement;
      const idx = Array.from(p.children).indexOf(node) + 1;
      const seg = node.tagName.toLowerCase() + ':nth-child(' + idx + ')';
      path = path ? seg + ' > ' + path : seg;
      if (p.id) { path = '#' + CSS.escape(p.id) + ' > ' + path; break; }
      node = p;
    }
    return path || el.tagName.toLowerCase();
  }

  function elType(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (role === 'switch' || role === 'checkbox' || role === 'radio') return 'toggle[' + role + ']';
    if (role === 'tab') return 'tab';
    if (role === 'menuitem' || role === 'option') return role;
    if (tag === 'a') return 'link';
    if (tag === 'button' || role === 'button') return 'button';
    if (tag === 'input') return 'input[' + (el.type || 'text') + ']';
    return tag;
  }

  // Surface ARIA toggle/expanded/selected state. Returns undefined when the
  // element exposes none of the four — keeps the response shape stable for
  // simple links and unstateful buttons.
  function elState(el) {
    const out = {};
    const ac = el.getAttribute('aria-checked');
    if (ac !== null) out.checked = (ac === 'true' || ac === 'mixed');
    const ap = el.getAttribute('aria-pressed');
    if (ap !== null) out.pressed = (ap === 'true');
    const as = el.getAttribute('aria-selected');
    if (as !== null) out.selected = (as === 'true');
    const ae = el.getAttribute('aria-expanded');
    if (ae !== null) out.expanded = (ae === 'true');
    return Object.keys(out).length ? out : undefined;
  }

  function elText(el) {
    const t = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    if (!t && el.tagName === 'INPUT')
      return (el.placeholder || el.value || el.getAttribute('aria-label') || '').slice(0, 80);
    return t;
  }

  // Use element center-point for consistency with the UIA/OCR viewport-position helper.
  function viewportPos(rect) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cy < 0) return 'above';
    if (cy >= window.innerHeight) return 'below';
    if (cx < 0) return 'left';
    if (cx >= window.innerWidth) return 'right';
    return 'in-view';
  }

  const _docHeight = document.documentElement.scrollHeight || 1;
  function pageRatio(rect) {
    const cy = rect.top + rect.height / 2 + window.scrollY;
    return Math.max(0, Math.min(1, cy / _docHeight));
  }

  const out = [];
  for (const el of root.querySelectorAll(cssQ)) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    const vp = inViewportRect(rect);
    if (viewportOnly && !vp) continue;
    const item = { type: elType(el), text: elText(el), selector: bestSelector(el), inViewport: vp, viewportPosition: viewportPos(rect), pageRatio: pageRatio(rect) };
    if (el.tagName === 'A') item.href = el.href;
    const st = elState(el);
    if (st) item.state = st;
    out.push(item);
    if (out.length >= maxN) break;
  }
  return out;
})()
`;

    const result = await evaluateInTab(expression, tabId ?? null, port);
    const items = Array.isArray(result) ? result : [];
    const lines = [
      `Found ${items.length} interactive element(s)${scope ? ` within "${scope}"` : ""}:`,
      JSON.stringify(items, null, 2),
    ];
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      lines.push(
        "",
        `activeTab: ${JSON.stringify({ id: tabCtx.id, title: tabCtx.title, url: tabCtx.url })}`,
        `readyState: "${tabCtx.readyState}"`,
      );
    }
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  } catch (err) {
    return failWith(err, "browser_overview");
  }
};

export const browserLaunchHandler = async ({
  browser,
  port,
  userDataDir,
  url,
  waitMs,
  killExisting,
}: {
  browser: "auto" | "chrome" | "edge" | "brave";
  port: number;
  userDataDir: string;
  url?: string;
  waitMs: number;
  killExisting: boolean;
}): Promise<ToolResult> => {
  try {
    // ── 1. Already running? ──────────────────────────────────────────────────
    // listTabs() hits http://127.0.0.1:PORT/json/list.
    // If it succeeds, a CDP endpoint is already live — skip spawn.
    // IMPORTANT: navigateTo errors must NOT escape this block, or control would
    // fall into the spawn path while the CDP endpoint is already live.
    try {
      const existingTabs = await listTabs(port);
      if (url) {
        try { await navigateTo(url, null, port); }
        catch { /* navigation failure doesn't affect the already-running result */ }
      }
      const pageTabs = existingTabs.filter((t) => t.type === "page");
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            port,
            alreadyRunning: true,
            launched: null,
            killed: [],
            tabs: pageTabs.map((t) => ({ id: t.id, title: t.title, url: t.url })),
          }, null, 2),
        }],
      };
    } catch { /* not running — proceed to spawn */ }

    // ── 2. Validate url early ─────────────────────────────────────────────────
    // Reject values that look like flags — Chrome would interpret them as CLI args.
    if (url !== undefined && url.startsWith("-")) {
      return {
        content: [{
          type: "text" as const,
          text: `browser_open: url must not start with '-' (got: ${JSON.stringify(url)})`,
        }],
      };
    }

    // ── 3. Resolve browser executable ────────────────────────────────────────
    type BrowserKey = "chrome" | "edge" | "brave";
    const candidates: Array<{ key: BrowserKey; exe: string }> =
      browser === "auto"
        ? [
            { key: "chrome", exe: "chrome.exe" },
            { key: "edge",   exe: "msedge.exe" },
            { key: "brave",  exe: "brave.exe"  },
          ]
        : [{ key: browser, exe: browser === "edge" ? "msedge.exe" : `${browser}.exe` }];

    let chosenKey: BrowserKey | null = null;
    let chosenPath: string | null = null;
    for (const c of candidates) {
      const { resolved, wasResolved } = resolveWellKnownPath(c.exe);
      if (wasResolved) { chosenKey = c.key; chosenPath = resolved; break; }
    }
    if (!chosenPath || !chosenKey) {
      return {
        content: [{
          type: "text" as const,
          text: browser === "auto"
            ? "No supported browser (Chrome/Edge/Brave) found in standard install locations. Install one or launch manually with --remote-debugging-port."
            : `${browser} not found in standard install locations. Install it or launch manually: ${browser === "edge" ? "msedge" : browser}.exe --remote-debugging-port=${port} --user-data-dir=${userDataDir}`,
        }],
      };
    }

    // ── 3.5. Kill existing if requested ──────────────────────────────────────
    let killed: string[] = [];
    if (killExisting) {
      // Kill only the chosen browser exe — minimise side effects
      const exeToKill = chosenKey === "edge" ? "msedge.exe" : `${chosenKey}.exe`;
      killed = killProcessesByName([exeToKill]);
      if (killed.length > 0) {
        // Grace period: right after kill, same user-data-dir lock may still linger
        await new Promise<void>((r) => setTimeout(r, 500));
      }
    }

    // ── 4. Spawn with CDP flags ───────────────────────────────────────────────
    const spawnArgs = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
    ];
    // Chrome/Edge/Brave accept an initial URL as a positional argument.
    // Passing it here avoids a post-launch navigateTo race.
    if (url) spawnArgs.push(url);
    await spawnDetached(chosenPath, spawnArgs);

    // ── 5. Poll listTabs until CDP is ready or deadline ───────────────────────
    // Give the browser a moment before the first probe — the spawn event fires as
    // soon as the OS hands off the process, long before Chrome initializes CDP.
    await new Promise<void>((r) => setTimeout(r, 200));
    let lastErr: unknown = null;
    const pollResult = await pollUntil(
      async () => {
        try {
          return await listTabs(port);
        } catch (e) {
          lastErr = e;
          return null;
        }
      },
      { intervalMs: 200, timeoutMs: waitMs }
    );
    if (!pollResult.ok) {
      return {
        content: [{
          type: "text" as const,
          text: [
            `${chosenKey} launched but CDP endpoint on port ${port} did not respond within ${waitMs}ms.`,
            `Last error: ${String(lastErr)}`,
            `Try increasing waitMs, or check that no stray process holds the port (close existing ${chosenKey} with the same --user-data-dir).`,
          ].join("\n"),
        }],
      };
    }
    const tabs = pollResult.value;

    const pageTabs = tabs.filter((t) => t.type === "page");
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          port,
          alreadyRunning: false,
          launched: { browser: chosenKey, path: chosenPath, userDataDir },
          killed,
          tabs: pageTabs.map((t) => ({ id: t.id, title: t.title, url: t.url })),
        }, null, 2),
      }],
    };
  } catch (err) {
    // Phase 3: surfaced to LLM via browser_open(launch:{...}) dispatcher.
    return failWith(err, "browser_open");
  }
};

// Phase 3: classify the text payload returned by browserLaunchHandler so
// browserOpenHandler can decide whether to short-circuit with the launch error
// or proceed to connect. Exported for unit testing — the failure-detection logic
// is the only thing that gates the connect step, so it must be exercisable in
// isolation.
//
// browserLaunchHandler can return:
//   - plain text on early failure (browser-not-found, CDP timeout, url validation)
//   - failWith JSON `{ok:false, code, error, ...}` on caught exceptions
//     (e.g. spawnDetached permission errors — Codex PR #40 review)
//   - success JSON `{port, alreadyRunning, launched, tabs}` on success
//     (success payloads omit `ok` entirely; treat anything not explicitly
//     `ok===false` as success)
export function classifyLaunchOutcome(text: string): "ok" | "fail" {
  if (!text) return "fail";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // plain text — early failure path (url validation / browser-not-found / CDP timeout)
    return "fail";
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { ok?: unknown }).ok === false
  ) {
    return "fail";
  }
  return "ok";
}

// Phase 3: browser_open dispatcher — optional launch then connect.
// Replaces former browser_launch + browser_open pair; reuses both internal
// handlers so the spawn / poll / url-validation logic stays single-source.
export const browserOpenHandler = async ({
  port,
  launch,
}: {
  port: number;
  launch?: {
    browser: "auto" | "chrome" | "edge" | "brave";
    userDataDir: string;
    url?: string;
    waitMs: number;
    killExisting: boolean;
  };
}): Promise<ToolResult> => {
  if (launch) {
    const launchResult = await browserLaunchHandler({
      browser: launch.browser,
      port,
      userDataDir: launch.userDataDir,
      url: launch.url,
      waitMs: launch.waitMs,
      killExisting: launch.killExisting,
    });
    const text = launchResult.content[0]?.type === "text" ? launchResult.content[0].text : "";
    if (classifyLaunchOutcome(text) === "fail") {
      return launchResult;
    }
  }
  return browserConnectHandler({ port });
};

export const browserSearchHandler = async ({
  by, pattern, scope, maxResults, offset, visibleOnly, inViewportOnly, caseSensitive, tabId, port,
}: {
  by: "text" | "regex" | "role" | "ariaLabel" | "selector";
  pattern: string;
  scope?: string;
  maxResults: number;
  offset: number;
  visibleOnly: boolean;
  inViewportOnly: boolean;
  caseSensitive: boolean;
  tabId?: string;
  port: number;
}): Promise<ToolResult> => {
  try {
    // ADR-023 Phase 1 (S1/S7): the candidate-collection IIFE is now built by the
    // shared resolver module (verbatim extraction; bit-equal output pinned by
    // tests/unit/browser-resolver-candidate-collection.test.ts). Later phases
    // layer actionability / climb / coords onto the same builder for by-axis
    // browser_click / browser_fill.
    const expression = buildCandidateCollectionJs({
      by, pattern, scope, maxResults, offset, visibleOnly, inViewportOnly, caseSensitive,
    });
    const result = await evaluateInTab(expression, tabId ?? null, port);
    if (result && typeof result === "object" && "__error" in (result as object)) {
      const r = result as { __error: string; message?: string };
      const code = r.__error === "ScopeNotFound" ? "ScopeNotFound"
                : r.__error === "InvalidRegex" ? "BrowserSearchNoResults"
                : r.__error === "Timeout" ? "BrowserSearchTimeout"
                : "ToolError";
      const suggest = code === "ScopeNotFound"
        ? ["Verify the scope CSS selector matches at least one element", "Omit scope to search the full document"]
        : code === "BrowserSearchTimeout"
        ? ["Reduce maxResults", "Narrow scope via CSS selector", "Try by:'selector' if you know the element"]
        : ["Verify your regex syntax", "Try a literal pattern with by:'text'"];
      return failCode(
        code,
        `browser_search: ${r.__error}${r.message ? " — " + r.message : ""}`,
        { suggest, context: { by, pattern, scope } },
      );
    }
    const payload = result as {
      total: number; returned: number; truncated: boolean;
      results: Array<{ confidence: number; selector: string; text: string }>;
    };
    if (payload.total === 0) {
      return failCode(
        "BrowserSearchNoResults",
        `browser_search(${by}, ${JSON.stringify(pattern)}) returned 0 results`,
        {
          suggest: [
            "Try a different 'by' axis",
            "Remove scope or set visibleOnly:false",
            "Toggle caseSensitive:false",
          ],
          context: { by, pattern, scope, visibleOnly, inViewportOnly },
        },
      );
    }
    const tabCtx = await getTabContext(tabId ?? null, port);
    return ok({ ...payload, activeTab: { id: tabCtx.id, title: tabCtx.title, url: tabCtx.url }, readyState: tabCtx.readyState });
  } catch (err) {
    return failWith(err, "browser_search", { by, pattern, scope });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// browser_get_app_state — extract embedded JSON / SPA hydration payloads
//
// Many SPAs render almost no useful HTML but ship the actual state in one of
// a handful of well-known script tags or window globals. Probing them blindly
// from the LLM costs 3-5 round-trips. This tool runs one CDP eval that scans
// the standard locations and returns whatever it finds, parsed.
// ─────────────────────────────────────────────────────────────────────────────

export const browserGetAppStateSchema = {
  selectors: z
    .array(z.string())
    .optional()
    .describe(
      "Optional override list of CSS selectors / window globals to probe. " +
      "Window globals must be prefixed with 'window:' (e.g. 'window:__INITIAL_STATE__'). " +
      "When omitted, scans the standard list (Next.js, GitHub react-app, Nuxt, Apollo, Remix, Redux SSR, JSON-LD)."
    ),
  maxBytes: z.coerce
    .number()
    .int()
    .min(256)
    .max(64_000)
    .default(4_000)
    .describe("Maximum bytes per individual payload (default 4000). Larger payloads are stringified and truncated."),
  tabId: tabIdParam,
  port: portParam,
  includeContext: includeContextParam,
};

interface AppStateHit {
  selector: string;
  framework: string;
  sizeBytes: number;
  truncated: boolean;
  payload: unknown;
}

export const browserGetAppStateHandler = async ({
  selectors,
  maxBytes,
  tabId,
  port,
  includeContext,
}: {
  selectors?: string[];
  maxBytes: number;
  tabId?: string;
  port: number;
  includeContext: boolean;
}): Promise<ToolResult> => {
  try {
    const probes: Array<{ selector: string; framework: string }> = selectors
      ? selectors.map((s) => ({ selector: s, framework: "custom" }))
      : [
          { selector: 'script#__NEXT_DATA__',                                                 framework: "next" },
          { selector: 'script#__NUXT_DATA__',                                                 framework: "nuxt" },
          { selector: 'script#__NUXT__',                                                      framework: "nuxt" },
          { selector: 'script#__REMIX_CONTEXT__',                                             framework: "remix" },
          { selector: 'script[type="application/json"][data-target$=".embeddedData"]',         framework: "react-app" },
          { selector: 'script[type="application/json"][data-target$="embeddedData"]',          framework: "react-app" },
          { selector: 'script[type="application/json"][id*="__APOLLO_STATE__"]',               framework: "apollo" },
          { selector: 'script[type="application/json"][id*="server-data"]',                    framework: "vue-ssr" },
          { selector: 'script[type="application/ld+json"]',                                   framework: "ld+json" },
          { selector: 'window:__INITIAL_STATE__',                                             framework: "redux-ssr" },
          { selector: 'window:__APOLLO_STATE__',                                              framework: "apollo" },
          { selector: 'window:__NUXT__',                                                      framework: "nuxt" },
        ];

    const expression = `
(function() {
  const probes = ${JSON.stringify(probes)};
  const maxBytes = ${JSON.stringify(maxBytes)};
  const found = [];
  const notFound = [];
  for (const p of probes) {
    try {
      let raw;
      if (p.selector.startsWith('window:')) {
        const key = p.selector.slice('window:'.length);
        const v = window[key];
        if (v === undefined || v === null) { notFound.push(p.selector); continue; }
        raw = (typeof v === 'string') ? v : JSON.stringify(v);
      } else {
        const els = document.querySelectorAll(p.selector);
        if (els.length === 0) { notFound.push(p.selector); continue; }
        // For multi-match selectors (ld+json), join entries; otherwise take first.
        if (els.length > 1 && p.framework === 'ld+json') {
          const parts = [];
          for (const el of els) parts.push(el.textContent || '');
          raw = '[' + parts.filter(s => s.trim()).join(',') + ']';
        } else {
          raw = els[0].textContent || '';
        }
      }
      const sizeBytes = raw.length;
      const truncated = sizeBytes > maxBytes;
      const slice = truncated ? raw.slice(0, maxBytes) : raw;
      let payload;
      try { payload = JSON.parse(slice); }
      catch (e) { payload = { __parseError: String(e && e.message || e), preview: slice.slice(0, 240) }; }
      found.push({ selector: p.selector, framework: p.framework, sizeBytes, truncated, payload });
    } catch (e) {
      notFound.push(p.selector);
    }
  }
  return JSON.stringify({ found, notFound });
})()
`;
    const raw = (await evaluateInTab(expression, tabId ?? null, port)) as string;
    const parsed = JSON.parse(raw) as { found: AppStateHit[]; notFound: string[] };
    const payload: Record<string, unknown> = {
      ok: true,
      found: parsed.found,
      notFound: parsed.notFound,
    };
    if (includeContext) {
      const tabCtx = await getCachedTabContext(tabId ?? null, port);
      payload.activeTab = { id: tabCtx.id, title: tabCtx.title, url: tabCtx.url };
      payload.readyState = tabCtx.readyState;
    }
    return ok(payload);
  } catch (err) {
    // Phase 3: surfaced to LLM via browser_eval(action='appState') dispatcher.
    return failWith(err, "browser_eval");
  }
};

export const browserDisconnectHandler = async ({
  port,
}: {
  port: number;
}): Promise<ToolResult> => {
  try {
    disconnectAll(port);
    return {
      content: [
        {
          type: "text" as const,
          text: `Closed all cached CDP sessions for port ${port}.`,
        },
      ],
    };
  } catch (err) {
    return failWith(err, "browser_disconnect");
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 dispatcher schemas (browser_eval action='js'|'dom'|'appState')
// ─────────────────────────────────────────────────────────────────────────────

export const browserEvalSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("js"),
    expression: z.string().describe(
      "JavaScript expression to evaluate. " +
      "The server automatically wraps snippets in an async IIFE to avoid repeated const/let collisions. " +
      "For multi-statement snippets, use an explicit final return value. " +
      "Declarations (const/let/var) are scoped per snippet — use window.* / globalThis.* for persistence. " +
      // "~15s" mirrors CMD_TIMEOUT_MS (cdp-bridge.ts). Kept literal — this describe()
      // runs at module load, and interpolating the imported const would break tests
      // that vi.mock cdp-bridge without re-exporting it. The runtime failCode message
      // (maybeBrowserEvalTimeoutFailure) derives the value from CMD_TIMEOUT_MS instead.
      "A single eval is bounded by the CDP per-command timeout (~15s): do NOT write in-page polling loops here — " +
      "use wait_until (element_matches / url_matches / ready_state) to wait for conditions instead."
    ),
    withPerception: coercedBoolean().optional().default(false).describe(
      "When true, return structured JSON {ok, result, post} with post.perception attached. Default false preserves raw-text return."
    ),
    lensId: z.string().optional().describe(
      "Optional perception lens ID. Guards (target.identityStable) are evaluated before eval."
    ),
    tabId: tabIdParam,
    port: portParam,
    includeContext: includeContextParam,
  }),
  z.object({
    action: z.literal("dom"),
    selector: z.string().optional().describe(
      "CSS selector for root element. Omit for document.body."
    ),
    maxLength: z.coerce.number().int().min(100).max(100_000).default(10_000).describe(
      "Max characters of HTML to return (default 10000)."
    ),
    tabId: tabIdParam,
    port: portParam,
    includeContext: includeContextParam,
  }),
  z.object({
    action: z.literal("appState"),
    selectors: z.array(z.string()).optional().describe(
      "Custom probe selectors. Omit to use the default SPA framework set " +
      "(__NEXT_DATA__ / __NUXT_DATA__ / __REMIX_CONTEXT__ / __APOLLO_STATE__ / window:__INITIAL_STATE__ etc.). " +
      "Window globals must be prefixed with 'window:'."
    ),
    maxBytes: z.coerce.number().int().min(256).max(64_000).default(4_000).describe(
      "Max bytes per individual payload (default 4000). Larger payloads are truncated."
    ),
    tabId: tabIdParam,
    port: portParam,
    includeContext: includeContextParam,
  }),
]);

export type BrowserEvalArgs = z.infer<typeof browserEvalSchema>;

export const browserEvalHandler = async (args: BrowserEvalArgs): Promise<ToolResult> => {
  // ADR-018 Phase 2a — strict per-action gate (§2.5.2). The registered wire
  // schema is the flat `flattenUnionToObjectSchema` output; re-parse against
  // the real (include-injected) union here. Scope fence: this touches ONLY the
  // `browser_eval` union — the flat-object browser tools in this file are not
  // affected.
  const parsed = parseActionArgsOrFail<BrowserEvalArgs>(browserEvalUnionWithInclude, args, "browser_eval");
  if (!parsed.ok) return parsed.result;
  const a = parsed.value;
  switch (a.action) {
    case "js":
      return browserEvalJsHandler(a);
    case "dom":
      return browserGetDomHandler(a);
    case "appState":
      return browserGetAppStateHandler(a);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `browser_open` is wrapped via `makeCommitWrapper` (lease-less commit
 * variant — `leaseValidator` omitted; CDP connect / optional browser spawn
 * without a lease 4-tuple, mirroring PR #130 notification_show / PR #133
 * workspace_launch pattern for OS-level commits).
 *
 * `windowTitleKey` is omitted because browser_open has no pre-existing
 * window-scoped target (the browser may not yet exist when launch:{} is
 * passed). `withRichNarration` falls through to `withPostState` only since
 * `narrate` isn't in the schema.
 *
 * Module-scope export so `run_macro` (`TOOL_REGISTRY.browser_open` in
 * `macro.ts`) shares the same wrapped instance (PR #112 shared
 * registration handler pattern, strip risk prevention).
 */
export const browserOpenRegistrationSchema = withEnvelopeIncludeSchema(browserOpenSchema);

export const browserOpenRegistrationHandler = makeCommitWrapper(
  withRichNarration(
    "browser_open",
    browserOpenHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
    {},
  ) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "browser_open",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `browser_navigate` is wrapped via `makeCommitWrapper` (lease-less commit
 * variant). Replaces the pre-expansion `withPostState("browser_navigate", ...)`
 * direct wrap. PR #134 browser_open 同型 pattern (raw shape 3a family、
 * windowTitleKey 省略 — browser targets a CDP tab not a Win32 window).
 */
export const browserNavigateRegistrationSchema = withEnvelopeIncludeSchema(browserNavigateSchema);

export const browserNavigateRegistrationHandler = makeCommitWrapper(
  withRichNarration(
    "browser_navigate",
    browserNavigateHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
    {},
  ) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "browser_navigate",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `browser_click` is wrapped via `makeCommitWrapper` (lease-less commit
 * variant). Replaces the pre-expansion `withPostState("browser_click", ...)`
 * direct wrap. PR #134 browser_open / PR #135 browser_navigate 同型 pattern.
 */
// ADR-023 Phase 1: exactly-one-of(selector | by+pattern) enforced by .refine().
// The refined ZodObject keeps `_def.type === 'object'` + shape in zod 4 so the
// MCP SDK still emits `tools/list` properties AND runs the refine at parse time
// (verified). Registered via server.registerTool — server.tool's 3-arg form
// throws on a ZodObject (raw-shape only); the browser_eval pattern.
export const browserClickRegistrationSchema = z
  .object(withEnvelopeIncludeSchema(browserClickElementSchema))
  .refine(
    (a) => {
      const hasSelector = typeof a.selector === "string" && a.selector.length > 0;
      const hasBy = typeof a.by === "string" && typeof a.pattern === "string" && a.pattern.length > 0;
      return hasSelector !== hasBy; // exactly one (XOR)
    },
    { message: "browser_click: provide EITHER selector OR (by + pattern), not both or neither." },
  );

export const browserClickRegistrationHandler = makeCommitWrapper(
  withRichNarration(
    "browser_click",
    browserClickElementHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
    {},
  ) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "browser_click",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `browser_fill` is wrapped via `makeCommitWrapper` (lease-less commit
 * variant). PR #134 browser_open / PR #135 browser_navigate / PR #136
 * browser_click 同型 pattern (raw shape 3a family、windowTitleKey 省略 —
 * browser targets a CDP tab not a Win32 window). pre-expansion では bare
 * `browserFillInputHandler` 直接渡しだったため post.* block も追加される
 * behavior 変化あり (additive、互換維持)。
 */
export const browserFillRegistrationSchema = withEnvelopeIncludeSchema(browserFillInputSchema);

export const browserFillRegistrationHandler = makeCommitWrapper(
  withRichNarration(
    "browser_fill",
    browserFillInputHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
    {},
  ) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "browser_fill",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `browser_form` is wrapped via `makeCommitWrapper` (lease-less commit
 * variant). Per `docs/walking-skeleton-expansion-plan.md` §2.1 line 38、
 * browser_form は swimlane 1 (commit) に分類される (form inspection は
 * read-only だが、L1 ToolCall event 記録 + envelope hoist の対象として
 * commit pipeline に乗せる方針)。PR #134 browser_open / PR #135 browser_navigate
 * / PR #136 browser_click / PR #137 browser_fill 同型 pattern (raw shape 3a
 * family、windowTitleKey 省略 — browser targets a CDP tab not a Win32 window)。
 */
export const browserFormRegistrationSchema = withEnvelopeIncludeSchema(browserGetFormSchema);

export const browserFormRegistrationHandler = makeCommitWrapper(
  withRichNarration(
    "browser_form",
    browserGetFormHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
    {},
  ) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "browser_form",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

/**
 * Walking skeleton expansion phase swimlane 1 (L5 commit tool wrapper):
 * `browser_eval` is wrapped via `makeCommitWrapper` (lease-less commit
 * variant、discriminatedUnion 3b family — actions: js / dom / appState)。
 * 'js' / 'dom' は side-effecting でない読み取り、'appState' は SPA 状態
 * extraction で commit pipeline 適用 (form inspection 同様 read-only でも
 * L1 event 記録目的)。expansion plan §2.1 line 38 で commit (dual) 分類。
 * PR #126 clipboard / PR #127 scroll / PR #131 window_dock / PR #132
 * terminal の discriminatedUnion 3b family 同型 (windowTitleKey 省略 —
 * browser CDP tab; pre-expansion `withPostState` 直 wrap を置換)。
 */
// ADR-018 Phase 2a — `browserEvalUnionWithInclude` (include-injected union)
// feeds BOTH the flat wire schema AND the in-handler `parseActionArgsOrFail`
// gate. Scope fence: only the `browser_eval` union is flattened here.
const browserEvalUnionWithInclude = withEnvelopeIncludeForUnion(browserEvalSchema);
export const browserEvalRegistrationSchema = flattenUnionToObjectSchema(browserEvalUnionWithInclude);

export const browserEvalRegistrationHandler = makeCommitWrapper(
  withRichNarration(
    "browser_eval",
    browserEvalHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
    {},
  ) as (args: Record<string, unknown>) => Promise<ToolResult>,
  "browser_eval",
  {
    // leaseValidator omitted = lease-less commit variant
    // getSessionId / argsSummary / clock も default 利用 = mechanical コピー最小
  },
);

/**
 * Walking skeleton expansion phase swimlane 2 (L5 query tool wrapper):
 * `browser_overview` is wrapped via `makeQueryWrapper` (S4 query-axis wrapper).
 * browser_overview は read-only (interactive elements list) のため query 軸が
 * 正しい — L1 ToolCallStarted/Completed events は commit-axis 専用で本 PR では
 * 発行しない。S5 caused_by linkage は本 PR で wire しない (causedByProjector
 * 省略 → makeQueryWrapper の S4 fast path、PR #122 screenshot 同型)。
 *
 * `include=["envelope"]` per-call opt-in + env `DESKTOP_TOUCH_ENVELOPE=1`
 * server default は機能、`include=["causal"]` は envelope shape を返すが
 * `caused_by` projection なし (S4-default behaviour for tools not yet wired
 * with causedByProjector)。
 */
export const browserOverviewRegistrationSchema = withEnvelopeIncludeSchema(browserGetInteractiveSchema);

export const browserOverviewRegistrationHandler = makeQueryWrapper(
  browserGetInteractiveHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
  "browser_overview",
  {
    causedByProjector: genericQueryCausedByProjector,
    getSessionId: defaultQuerySessionId,
  },
);

/**
 * Walking skeleton expansion phase swimlane 2 (L5 query tool wrapper):
 * `browser_locate` is wrapped via `makeQueryWrapper`. PR #122 screenshot /
 * PR #140 browser_overview 同型 pattern (read-only DOM lookup、coordinate
 * extraction、L1 events 不発、causedByProjector 省略 fast path)。
 */
export const browserLocateRegistrationSchema = withEnvelopeIncludeSchema(browserFindElementSchema);

export const browserLocateRegistrationHandler = makeQueryWrapper(
  browserFindElementHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
  "browser_locate",
  {
    causedByProjector: genericQueryCausedByProjector,
    getSessionId: defaultQuerySessionId,
  },
);

/**
 * Walking skeleton expansion phase swimlane 2 (L5 query tool wrapper):
 * `browser_search` is wrapped via `makeQueryWrapper`. PR #122 screenshot /
 * PR #140 browser_overview / PR #141 browser_locate 同型 pattern (read-only
 * grep-like element lookup、L1 events 不発、causedByProjector 省略 fast path)。
 */
export const browserSearchRegistrationSchema = withEnvelopeIncludeSchema(browserSearchSchema);

export const browserSearchRegistrationHandler = makeQueryWrapper(
  browserSearchHandler as (args: Record<string, unknown>) => Promise<ToolResult>,
  "browser_search",
  {
    causedByProjector: genericQueryCausedByProjector,
    getSessionId: defaultQuerySessionId,
  },
);

export function registerBrowserTools(server: McpServer): void {
  // Wire wait_until(element_matches) — resolve top result for callers that just need selector + text.
  setBrowserSearchHook(async ({ port, tabId, by, pattern, scope }) => {
    try {
      const result = await browserSearchHandler({
        by, pattern, scope, maxResults: 5, offset: 0,
        visibleOnly: true, inViewportOnly: false, caseSensitive: false,
        tabId, port: port ?? _defaultPort,
      });
      const text = result.content[0]?.type === "text" ? result.content[0].text : "{}";
      const parsed = JSON.parse(text) as { results?: Array<{ selector: string; text: string }> };
      return parsed.results ?? [];
    } catch {
      return [];
    }
  });

  server.tool(
    "browser_search",
    "Grep-like element search across the current page. by: 'text' (literal substring), 'regex', 'role', 'ariaLabel', 'selector' (CSS). Returns results[] sorted by confidence descending — pass results[0].selector to browser_click. Pagination via offset/maxResults. Caveats: Use browser_overview for broad discovery; use browser_search when you know specific text or role to target. Typed errors: code:'BrowserSearchNoResults' (broaden the by:'text' substring or relax the by:'regex' pattern; switch to browser_overview to enumerate selectors), code:'BrowserSearchTimeout' (reduce maxResults / narrow scope), code:'ScopeNotFound' (the scope CSS selector did not match — verify the selector or omit scope), code:'BrowserNotConnected' (call browser_open first, or browser_open({launch:{}}) to auto-spawn).",
    browserSearchRegistrationSchema,
    browserSearchRegistrationHandler as typeof browserSearchHandler
  );

  server.tool(
    "browser_overview",
    "List all interactive elements (links, buttons, inputs, ARIA controls) on the current page with CSS selectors, visible text or value for inputs, and viewport status — use before browser_click to discover stable selectors, and prefer this over screenshot when verifying button/toggle state after submission (no image tokens, structured output). scope limits to a CSS subsection (e.g. '.sidebar'). Returns state (checked/pressed/selected/expanded) for ARIA custom controls. Caveats: Selectors are CDP-generated snapshots — re-call after page navigates or re-renders. Input text reflects the empty-field hint text when defined (takes priority over typed value) — use browser_eval('document.querySelector(sel).value') to read actual typed content. Typed errors: code:'BrowserNotConnected' (CDP not attached — call browser_open or browser_open({launch:{}})). Note: a non-matching scope CSS selector silently falls back to the full document (does not raise an error) — verify the selector via browser_eval if scoped enumeration is required.",
    browserOverviewRegistrationSchema,
    browserOverviewRegistrationHandler as typeof browserGetInteractiveHandler
  );

  server.tool(
    "browser_open",
    "Connect to Chrome/Edge running with --remote-debugging-port and return open tab IDs — required before all other browser_* tools. " +
    "Pass launch:{} (or with overrides) to auto-spawn a debug-mode browser when no CDP endpoint is live (idempotent: an already-running endpoint is preferred). " +
    "Returns tabs[] with id, url, title, active — pass tabId to browser_* tools to target a specific tab. " +
    "Caveats: CDP connection is per-process; if Chrome restarts, call browser_open again to get fresh tab IDs. " +
    "A Chrome session started without --remote-debugging-port cannot be taken over — close it first or use a separate userDataDir. " +
    "If the CDP endpoint is unreachable and launch is omitted, returns ok:false (typically code:'BrowserNotConnected' when the fetch surfaces ECONNREFUSED, otherwise code:'ToolError' with error 'Cannot reach Chrome/Edge CDP...'); re-call with launch:{} (idempotent) to auto-spawn or start Chrome manually with --remote-debugging-port=9222.",
    browserOpenRegistrationSchema,
    browserOpenRegistrationHandler as typeof browserOpenHandler
  );

  server.tool(
    "browser_locate",
    "Find a DOM element by CSS selector and return its physical screen coordinates — compatible directly with mouse_click. Prefer browser_click to find+click in one step. Prefer browser_overview to discover selectors. Caveats: Coordinates are captured at call time; if the page reflows before mouse_click, coords may be stale. Typed errors: code:'BrowserNotConnected' (call browser_open first), code:'ElementNotFound' (selector did not match — re-discover via browser_overview / browser_search).",
    browserLocateRegistrationSchema,
    browserLocateRegistrationHandler as typeof browserFindElementHandler
  );

  server.registerTool(
    "browser_click",
    {
      description:
        "Click a DOM element in Chrome/Edge. Two ways to target: (1) selector — a CSS selector (combines browser_locate + mouse_click; stable across repaints); or (2) by-axis (semantic) — by:'text'|'regex'|'role'|'ariaLabel' + pattern, so you do not have to build a CSS selector for dynamic-class SPAs. by-axis resolves to a SINGLE actionable element (climbing to a clickable ancestor up to 3 levels, hit-testing for occlusion) and STOPS with code:'BrowserAmbiguousTarget' (candidates[] + next[] hints) when 2+ actionable elements match, or code:'BrowserNoActionableTarget' when matches exist but none is clickable — it never guesses. Optionally add role to filter (by:'text',pattern:'Save',role:'button') and scope to narrow the search. Provide EITHER selector OR by+pattern (not both). Pass tabId+port so the server auto-guards (verifies tab readyState and identity) and returns post.perception.status. lensId is optional for advanced pinned-tab workflows. Caveats: selector mode fails if the element is outside the visible viewport — scroll it into view with browser_eval(\"document.querySelector('sel').scrollIntoView()\") first (by-axis only resolves in-viewport actionable targets). hints.verifyDelivery:{status:'delivered'|'unverifiable', reason, observedSignals:{mutationCount,urlChanged,activeElementChanged}} reports the post-click observation in 2 values: 'delivered' fires only when mutationCount>0 OR urlChanged (activeElementChanged is recorded in observedSignals but intentionally NOT a delivery signal — plain clicks on focusable controls always update focus, treating that as 'delivered' would mask silent-fail regressions); 'unverifiable' reason ∈ {'iframe_context_mismatch','no_dom_mutation','probe_install_failed','probe_read_failed'}. CDP emits 2 values only (focus_only is a UIA-path concept, N/A here). BrowserClickNotDelivered is reserved-only (false-positive risk too high to emit) — degradation reads from 'unverifiable' status.",
      inputSchema: browserClickRegistrationSchema,
    },
    browserClickRegistrationHandler as typeof browserClickElementHandler
  );

  server.registerTool(
    "browser_eval",
    {
      description: buildDesc({
        purpose: "Inspect or operate on a browser tab via 3 actions: 'js' (evaluate JS), 'dom' (get HTML), 'appState' (extract SSR-injected SPA state).",
        details:
          "action='js' — Run a JS expression. withPerception:true wraps in {ok, result, post}. " +
          "action='dom' — Return outerHTML of selector (or document.body), truncated to maxLength. " +
          "action='appState' — Scan Next/Nuxt/Remix/Apollo/GitHub/Redux SSR injected JSON; pass selectors to override defaults.",
        prefer:
          "Use action='appState' BEFORE 'dom' or 'js' on SPAs where rendered HTML is sparse — single CDP call. " +
          "Use 'dom' when 'appState' is empty and you need page structure. " +
          "Use 'js' as the escape hatch for arbitrary scripting.",
        caveats:
          "DOM nodes cannot be returned from action='js' directly (circular refs are serialized safely). " +
          "React/Vue/Svelte controlled inputs cannot be set via element.value — use keyboard(action='type') / browser_fill instead. " +
          "readyState is strictly checked; guard blocks if page is still loading. " +
          "Typed errors: code:'BrowserNotConnected' on CDP disconnect (re-attach via browser_open); code:'AutoGuardBlocked' when the auto-guard refuses (e.g. page still loading) — the error message preserves the guard's 1-sentence recommended next step (most often wait_until({condition:'ready_state'}) or browser_eval readyState polling, then retry).",
        examples: [
          "browser_eval({action:'js', expression:'document.title'}) → page title",
          "browser_eval({action:'dom', selector:'#main', maxLength:5000}) → outerHTML",
          "browser_eval({action:'appState'}) → default SPA state probes",
        ],
      }),
      inputSchema: browserEvalRegistrationSchema,
    },
    browserEvalRegistrationHandler as (args: Record<string, unknown>) => Promise<ToolResult>
  );

  server.tool(
    "browser_navigate",
    "Navigate a browser tab to a URL via CDP Page.navigate — more reliable than clicking the address bar. Pass tabId+port so the server auto-guards (verifies tab readyState) and returns post.perception.status. lensId is optional for advanced pinned-tab workflows. Caveats: Does not block until page load completes — the Page.navigate ack confirms only that the navigation request was accepted (frameStoppedLoading / loaderId observation is internal). Follow with wait_until({condition:'ready_state' or 'element_matches'}) or repeated browser_eval polling for slow pages. Typed errors: code:'NavigateFailed' (Page.navigate rejected — DNS failure, malformed URL, network unreachable; check URL + connectivity), code:'BrowserNotConnected' (CDP disconnect — re-attach via browser_open), code:'AutoGuardBlocked' when the auto-guard refuses (e.g. tab still loading) — the error message preserves the guard's 1-sentence recommended next step (most often wait_until({condition:'ready_state'}) then retry).",
    browserNavigateRegistrationSchema,
    browserNavigateRegistrationHandler as typeof browserNavigateHandler
  );

  server.tool(
    "browser_fill",
    "Fill a form input with a value via CDP — works on React/Vue/Svelte controlled inputs that reject browser_eval value assignment. Use browser_overview or browser_locate first to obtain a stable selector. Use this over browser_eval when setting a controlled input's value via JS does not update the framework state. Caveats: Requires browser_open (CDP active). Does not work on contenteditable rich-text editors — use keyboard(action='type') for those. actual in response shows what the element's value property reads after fill; verify it matches the intended value. Typed errors: code:'BrowserFillNotDelivered' on post-fill value mismatch — note the false-positive case where a React controlled input's onChange transforms the value (delivery actually succeeded; SUGGESTS context surfaces hints.verifyDelivery.subReason:'controlled_input_transform' for that case). When detected, the actual value in the response is authoritative.",
    browserFillRegistrationSchema,
    browserFillRegistrationHandler as typeof browserFillInputHandler
  );

  server.tool(
    "browser_form",
    "Inspect all form fields (input, select, textarea, button) within a CSS-selector-specified container and return their name, type, id, current value, hint text, disabled/readOnly state, and associated label text (resolved via for[id], ancestor LABEL, aria-labelledby, aria-label in that order). Use this before browser_fill to discover exact field selectors and avoid accidentally targeting the wrong input (e.g. a global search bar). Caveats: Requires browser_open (CDP active). Hidden inputs (type=hidden) are excluded by default — set includeHidden:true if needed. Value text is truncated at 200 chars.",
    browserFormRegistrationSchema,
    browserFormRegistrationHandler as typeof browserGetFormHandler
  );
}
