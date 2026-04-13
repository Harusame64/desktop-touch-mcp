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
};

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

function classify(message: string): { code: string; suggest: string[] } {
  const m = message.toLowerCase();

  if (m.includes("window not found") || m.includes("no window")) {
    return { code: "WindowNotFound", suggest: SUGGESTS.WindowNotFound };
  }
  if (m.includes("element not found") || m.includes("no element")) {
    return { code: "ElementNotFound", suggest: SUGGESTS.ElementNotFound };
  }
  if (m.includes("invokepattern") || m.includes("invoke pattern")) {
    return { code: "InvokePatternNotSupported", suggest: SUGGESTS.InvokePatternNotSupported };
  }
  if (m.includes("timeout") || m.includes("timed out")) {
    return { code: "UiaTimeout", suggest: SUGGESTS.UiaTimeout };
  }
  if (m.includes("element is disabled") || m.includes("is disabled") || m === "disabled") {
    return { code: "ElementDisabled", suggest: SUGGESTS.ElementDisabled };
  }
  if (m.includes("browser") && (m.includes("not connected") || m.includes("econnrefused"))) {
    return { code: "BrowserNotConnected", suggest: SUGGESTS.BrowserNotConnected };
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
