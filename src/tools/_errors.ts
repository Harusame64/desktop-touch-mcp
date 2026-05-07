import { fail, type ToolFailure, type ToolResult } from "./_types.js";

// Context keys that must be hoisted to the root of the failure JSON so that
// _post.ts (withPostState) can find them. `_post.ts` reads obj._perceptionForPost /
// obj._richForPost from the root of the parsed response body; if we let failWith
// put them under `context`, the failure path never attaches post.perception.
const ROOT_HOISTED_KEYS = new Set<string>(["_perceptionForPost", "_richForPost"]);

// ─────────────────────────────────────────────────────────────────────────────
// Error code → suggest dictionary
// ─────────────────────────────────────────────────────────────────────────────

const SUGGESTS: Record<string, string[]> = {
  InvalidArgs: [
    "Check the required parameters for this tool",
    "At least one of name or automationId must be provided",
  ],
  WindowNotFound: [
    "Run desktop_discover to see available titles",
    "Try a shorter partial title match (e.g. first word only)",
    "The window may be minimized — try focus_window first",
    "If the app is still launching, use wait_until(condition='window_appears') before focus_window",
    "If the target is a Chrome/Edge tab (only the active tab's title appears in window titles), use browser_open to get the tabId, then browser_navigate to the target URL to switch tabs",
  ],
  ElementNotFound: [
    "Call desktop_discover to see candidate names and automationIds",
    "Use screenshot(detail='text') for actionable[] with clickAt coords",
    "Try a shorter partial name match",
    "The element may not be visible yet — use wait_until(condition='element_appears')",
  ],
  InvokePatternNotSupported: [
    "Use mouse_click with clickAt coords from screenshot(detail='text')",
    "Use desktop_act({action:'setValue'}) for text input fields",
    "Use screenshot({region:{x,y,width,height}}) to inspect the element region (after desktop_discover)",
  ],
  BlockedKeyCombo: [
    "Use workspace_launch to open applications by name instead",
    "If you need shell execution, use terminal({action:'send'}) to an existing terminal window",
  ],
  UiaTimeout: [
    "The target app may be unresponsive — wait and retry",
    "Try screenshot(detail='image') as a visual fallback",
  ],
  ElementDisabled: [
    "The element exists but is currently disabled",
    "Use wait_until(condition='value_changes') to wait for it to become enabled",
    "Check page state with screenshot(detail='text') before retrying",
  ],
  BrowserNotConnected: [
    "Call browser_open first with the correct port",
    "Verify Chrome was launched with --remote-debugging-port",
    "Or call browser_open({launch:{}}) to spawn a debug-mode Chrome on the configured port",
  ],
  TerminalWindowNotFound: [
    "Call desktop_discover to see available titles",
    "Try a partial title match (e.g. 'PowerShell' or 'pwsh')",
    "Filter by processName: pwsh / powershell / cmd / bash / WindowsTerminal",
  ],
  TerminalTextPatternUnavailable: [
    "Retry with source:'ocr' to use Windows OCR",
    "Or source:'auto' to auto-fallback when TextPattern is missing",
    "Some terminal apps (e.g. WSL inside vt100) do not implement TextPattern",
  ],
  TerminalMarkerStale: [
    "Omit sinceMarker to fetch full text",
    "Check hints.terminalMarker.invalidatedBy — pid_changed/process_restarted means a new shell instance",
    "After process_restarted, treat prior history as invalid",
  ],
  BrowserSearchNoResults: [
    "Try a different 'by' axis (text → ariaLabel, regex → role)",
    "Remove the scope parameter to search the full document",
    "Set visibleOnly:false to include hidden / off-viewport elements",
    "Toggle caseSensitive:false for text and regex",
  ],
  BrowserSearchTimeout: [
    "Reduce maxResults",
    "Narrow the scope via a CSS selector",
    "Try by:'selector' for a specific element if you know it",
  ],
  ScopeNotFound: [
    "Verify the scope CSS selector matches at least one element",
    "Omit the scope parameter to search the full document",
  ],
  WaitTimeout: [
    "Increase timeoutMs",
    "Verify the target window/element appears as expected",
    "Check intermediate state with screenshot(detail='meta') or desktop_state()",
  ],
  ScrollbarUnavailable: [
    "The target window has no Win32 scrollbar (e.g. overlay scrollbars or non-scrollable content)",
    "Try strategy:'image' with a hint param for binary-search scrolling",
    "Verify the target is actually a scrollable container",
  ],
  OverflowHiddenAncestor: [
    "A parent element has overflow:hidden which silently swallows scroll input",
    "Pass expandHidden:true to temporarily unlock it (mutates live CSS)",
    "Or click an expand/collapse control on the page to reveal the content first",
  ],
  VirtualScrollExhausted: [
    "The virtualised list did not reach the target after retryCount attempts",
    "Provide virtualIndex + virtualTotal for direct proportional seeking",
    "Increase retryCount (default 3) or narrow search with hint:'above'|'below'",
  ],
  MaxDepthExceeded: [
    "The scroll ancestor chain is deeper than maxDepth (default 3)",
    "Increase maxDepth to walk more layers",
    "Or scroll an outer container first via a separate scroll({action:'smart'}) call",
  ],
  GuardFailed: [
    "Read the perception envelope for attention/guard details",
    "Call desktop_state to force a fresh observation before retrying",
    "Consider a corrective action: focus_window, dismiss modal, or wait_until",
  ],
  LensNotFound: [
    "Drop the lensId — Auto Perception tracks state when you pass windowTitle / tabId directly",
    "If you cached a lensId from a prior session, treat it as expired",
  ],
  LensBudgetExceeded: [
    "Drop lensId — Auto Perception keeps envelope cost bounded automatically",
    "Or call desktop_state for a lightweight status check without the envelope",
  ],
  BackgroundInputUnsupported: [
    "Target app does not accept background input - use method:'foreground' or omit",
    "For Chrome/Edge: use browser_fill instead",
  ],
  BackgroundInputIncomplete: [
    "Input sent partially - retry with method:'foreground' for full input",
    "Check context.sent vs context.total",
  ],
  SetValueAllChannelsFailed: [
    "Verify the element supports text input",
    "Try click_element + keyboard({action:'type'}) manually",
    "Check context.attempts for per-channel error codes",
  ],
  // ADR-011 Phase B B-1: Working memory N upper bound (WORKING_MEMORY_N_MAX
  // = 50, layer-constraints §5 SSOT 整合) を超える要求が来た場合の typed
  // reason。silently truncate せず error を返す設計 (Phase B plan §4.3
  // acceptance、ADR-010 §5.6.1 truncation 規約と整合 — capacity 内 truncate
  // は `_truncation` notation で expose、上限超えは error)。
  WorkingMemoryNUpperBoundExceeded: [
    "Reduce working:N — upper bound is WORKING_MEMORY_N_MAX (= 50, layer-constraints §5)",
    "If you need more recent events, use include=[\"episodic:N\"] for richer rich-shape projection (B-2 land 後に有効)",
    "Working memory is a compact summary of recent commits — N typically ≤ 10 is sufficient for context",
  ],
  // ADR-011 Phase B B-2: Episodic memory N upper bound
  // (EPISODIC_MEMORY_N_MAX = 100, layer-constraints §5 SSOT 整合) を超える要求の typed reason。
  // Working との使い分けを suggest で誘導 (compact = working、rich = episodic)。
  EpisodicMemoryNUpperBoundExceeded: [
    "Reduce episodic:N — upper bound is EPISODIC_MEMORY_N_MAX (= 100, layer-constraints §5)",
    "Use include=[\"working:N\"] (compact summary) when the rich shape (lease_token / event_id / elapsed_ms) is unnecessary",
    "Episodic memory exposes the full ToolCallEvent shape — N typically ≤ 5 is sufficient for causal context recovery",
  ],
  // ADR-011 Phase B B-3: Semantic memory K upper bound
  // (SEMANTIC_MEMORY_K_MAX = 10) を超える要求の typed reason。
  // Working/Episodic との使い分けを suggest で誘導 (compact = working、
  // rich = episodic、pattern reuse = semantic)。
  SemanticMemoryKUpperBoundExceeded: [
    "Reduce semantic:K — upper bound is SEMANTIC_MEMORY_K_MAX (= 10)",
    "Semantic memory surfaces top-K learned UI patterns (rule-based: same windowTitle + 3+ successful commits)",
    "If you want recent commits instead of patterns, use include=[\"episodic:N\"] (rich shape) or [\"working:N\"] (compact)",
  ],
  // ADR-011 Phase B B-4: Procedural memory K upper bound
  // (PROCEDURAL_MEMORY_K_MAX = 10) を超える要求の typed reason。
  // suggest filter (success>=3 + failure==0 + no destructive) で expose
  // 候補は構造的に少なく、K 大幅増加に意味は薄い。
  ProceduralMemoryKUpperBoundExceeded: [
    "Reduce procedural:K — upper bound is PROCEDURAL_MEMORY_K_MAX (= 10)",
    "Procedural memory surfaces top-K successful repeated workflows (success>=3 + 0 failures + no destructive tools)",
    "Suggest candidates are limited by design — destructive macro suggest is non-goal in Phase B (consider Phase B follow-up for explicit consent UX)",
  ],
};

/**
 * @internal Read-only access to the SUGGESTS dictionary for typed-error
 * envelope wiring (Round 1 Opus P1-3 反映). `makeQueryWrapper` uses this
 * to populate `if_unexpected.try_next` with `{action: string}` entries
 * derived from SUGGESTS string lines, ensuring runtime hint delivery
 * for Phase B B-1 `WorkingMemoryNUpperBoundExceeded` and any future
 * code that needs `buildFailureEnvelope` direct call (rather than
 * `failWith`-based path).
 */
export function getSuggestsForCode(code: string): string[] {
  return SUGGESTS[code] ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

function classify(message: string): { code: string; suggest: string[] } {
  const m = message.toLowerCase();

  // Order matters: check more-specific patterns first, then fall back to general ones.
  // Perception guards and lens errors — check before generic "not found" patterns
  if (m.includes("guardfailed") || m.startsWith("guard failed") || m.includes("guard failed:")) {
    return { code: "GuardFailed", suggest: SUGGESTS.GuardFailed };
  }
  if (m.includes("lens not found") || m.includes("unknownlens")) {
    return { code: "LensNotFound", suggest: SUGGESTS.LensNotFound };
  }
  if (m.includes("lens budget") || m.includes("lensbudget")) {
    return { code: "LensBudgetExceeded", suggest: SUGGESTS.LensBudgetExceeded };
  }
  // "Terminal window not found" must match BEFORE "window not found" (substring).
  if (m.includes("terminal window not found") || m.includes("terminal not found")) {
    return { code: "TerminalWindowNotFound", suggest: SUGGESTS.TerminalWindowNotFound };
  }
  if (m.includes("textpattern") || m.includes("text pattern")) {
    return { code: "TerminalTextPatternUnavailable", suggest: SUGGESTS.TerminalTextPatternUnavailable };
  }
  if (m.includes("marker stale") || m.includes("sincemarker")) {
    return { code: "TerminalMarkerStale", suggest: SUGGESTS.TerminalMarkerStale };
  }
  if (m.includes("scope not found") || m.includes("scopenotfound")) {
    return { code: "ScopeNotFound", suggest: SUGGESTS.ScopeNotFound };
  }
  if (m.includes("wait timeout") || m.includes("waittimeout")) {
    return { code: "WaitTimeout", suggest: SUGGESTS.WaitTimeout };
  }
  if (m.includes("browser") && (m.includes("not connected") || m.includes("econnrefused"))) {
    return { code: "BrowserNotConnected", suggest: SUGGESTS.BrowserNotConnected };
  }
  if (m.includes("element is disabled") || m.includes("is disabled") || m === "disabled") {
    return { code: "ElementDisabled", suggest: SUGGESTS.ElementDisabled };
  }
  if (m.includes("is not allowed because it could open a shell")) {
    return { code: "BlockedKeyCombo", suggest: SUGGESTS.BlockedKeyCombo };
  }
  if (m.includes("invokepattern") || m.includes("invoke pattern")) {
    return { code: "InvokePatternNotSupported", suggest: SUGGESTS.InvokePatternNotSupported };
  }
  if (m.includes("window not found") || m.includes("no window")) {
    return { code: "WindowNotFound", suggest: SUGGESTS.WindowNotFound };
  }
  if (m.includes("element not found") || m.includes("no element")) {
    return { code: "ElementNotFound", suggest: SUGGESTS.ElementNotFound };
  }
  if (m.includes("timeout") || m.includes("timed out")) {
    return { code: "UiaTimeout", suggest: SUGGESTS.UiaTimeout };
  }
  if (m.includes("scrollbar unavailable") || m.includes("no scrollbar") || m.includes("no scrollpattern")) {
    return { code: "ScrollbarUnavailable", suggest: SUGGESTS.ScrollbarUnavailable ?? [] };
  }
  if (m.includes("overflow:hidden") || m.includes("overflowancestor")) {
    return { code: "OverflowHiddenAncestor", suggest: SUGGESTS.OverflowHiddenAncestor ?? [] };
  }
  if (m.includes("virtual scroll exhausted") || m.includes("virtualscrollexhausted")) {
    return { code: "VirtualScrollExhausted", suggest: SUGGESTS.VirtualScrollExhausted ?? [] };
  }
  if (m.includes("max depth") || m.includes("maxdepth exceeded")) {
    return { code: "MaxDepthExceeded", suggest: SUGGESTS.MaxDepthExceeded ?? [] };
  }
  if (m.includes("backgroundinputunsupported") || m.includes("background input unsupported")) {
    return { code: "BackgroundInputUnsupported", suggest: SUGGESTS.BackgroundInputUnsupported };
  }
  if (m.includes("backgroundinputincomplete") || m.includes("background input incomplete")) {
    return { code: "BackgroundInputIncomplete", suggest: SUGGESTS.BackgroundInputIncomplete };
  }
  if (m.includes("setvalueallchannelsfailed") || m.includes("all channels failed")) {
    return { code: "SetValueAllChannelsFailed", suggest: SUGGESTS.SetValueAllChannelsFailed };
  }

  return { code: "ToolError", suggest: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize any thrown value into a structured ToolFailure and return it
 * as a ToolResult. Automatically adds recovery suggestions based on error
 * message patterns.
 */
export function failWith(
  err: unknown,
  toolName: string,
  context?: Record<string, unknown>
): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const { code, suggest } = classify(message);

  // Split incoming context into (a) keys that belong on the root of the failure
  // JSON so downstream middleware (_post.ts) can find them, and (b) the actual
  // LLM-facing context that stays nested under `context`.
  const rootExtras: Record<string, unknown> = {};
  let nestedContext: Record<string, unknown> | undefined;
  if (context) {
    for (const [k, v] of Object.entries(context)) {
      if (ROOT_HOISTED_KEYS.has(k)) {
        rootExtras[k] = v;
      } else {
        if (!nestedContext) nestedContext = {};
        nestedContext[k] = v;
      }
    }
  }

  const failure: ToolFailure & Record<string, unknown> = {
    ok: false,
    code,
    error: `${toolName} failed: ${message}`,
    ...(suggest.length > 0 && { suggest }),
    ...(nestedContext && { context: nestedContext }),
    ...rootExtras,
  };

  return fail(failure);
}

/**
 * Return a structured ToolFailure for invalid / missing input arguments.
 * Use this instead of failWith() for validation errors so they get the
 * dedicated InvalidArgs code rather than the generic ToolError fallback.
 */
export function failArgs(
  message: string,
  toolName: string,
  context?: Record<string, unknown>
): ToolResult {
  const failure: ToolFailure = {
    ok: false,
    code: "InvalidArgs",
    error: `${toolName}: ${message}`,
    suggest: SUGGESTS.InvalidArgs,
    ...(context && { context }),
  };
  return fail(failure);
}
