import { fail, type ToolFailure, type ToolResult } from "./_types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Error code → suggest dictionary
// ─────────────────────────────────────────────────────────────────────────────

const SUGGESTS: Record<string, string[]> = {
  InvalidArgs: [
    "Check the required parameters for this tool",
    "At least one of name or automationId must be provided",
  ],
  WindowNotFound: [
    "Run get_windows to see available titles",
    "Try a shorter partial title match (e.g. first word only)",
    "The window may be minimized — try focus_window first",
    "If the app is still launching, use wait_until(condition='window_appears') before focus_window",
  ],
  ElementNotFound: [
    "Call get_ui_elements to see candidate names and automationIds",
    "Use screenshot(detail='text') for actionable[] with clickAt coords",
    "Try a shorter partial name match",
    "The element may not be visible yet — use wait_until(condition='element_appears')",
  ],
  InvokePatternNotSupported: [
    "Use mouse_click with clickAt coords from screenshot(detail='text')",
    "Use set_element_value for text input fields",
    "Try scope_element to inspect available patterns for this element",
  ],
  BlockedKeyCombo: [
    "Use workspace_launch to open applications by name instead",
    "If you need shell execution, use terminal_send to an existing terminal window",
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
    "Call browser_connect first with the correct port",
    "Verify Chrome was launched with --remote-debugging-port",
    "Use browser_launch to open a new debugging-enabled Chrome instance",
  ],
  TerminalWindowNotFound: [
    "Call get_windows to see available titles",
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
    "Check intermediate state with screenshot(detail='meta') or get_context()",
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

function classify(message: string): { code: string; suggest: string[] } {
  const m = message.toLowerCase();

  // Order matters: check more-specific patterns first, then fall back to general ones.
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

  const failure: ToolFailure = {
    ok: false,
    code,
    error: `${toolName} failed: ${message}`,
    ...(suggest.length > 0 && { suggest }),
    ...(context && { context }),
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
