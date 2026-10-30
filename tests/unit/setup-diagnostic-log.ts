/**
 * setup-diagnostic-log.ts — keep the unit suite out of the user's real
 * diagnostic log.
 *
 * The log is on by default and `logDiagnostic` appends synchronously to
 * `%USERPROFILE%\.desktop-touch-mcp\logs\diagnostic.log`. Unit tests that drive
 * a real handler therefore append real records to a real file on the developer's
 * machine — and since ADR-035 Phase 1 instrumented the resolvers and dispatch
 * sinks, that is most of them. Individual files used to opt out by mocking the
 * module; that only works for the files that remember to (Opus Round 2 P3).
 *
 * Disabling it here instead is the structural version of the same fix, and it
 * costs nothing: a test that wants to OBSERVE events mocks the module and
 * overrides BOTH `logDiagnostic` (to capture) and `isDiagnosticLogEnabled` (to
 * re-enable the producers, which return early on a disabled log) — see
 * `resolve-log.test.ts` and `resolve-log-keyboard-sink.test.ts`.
 */
process.env.DESKTOP_TOUCH_DIAGNOSTIC_LOG_DISABLE = "1";

// Internal #322 — `keyboard(action:'type')` asks UI Automation for the focused element before it sends.
// In a unit test that read would ask the real desktop, so its answer would depend on whatever window
// holds the focus on the machine running the suite. Here it says nothing (null, as a failed read
// does); `keyboard-type-refuses-a-focus-that-takes-no-text.test.ts` sets the answer and tests the read.
import { vi } from "vitest";
vi.mock("../../src/tools/_type-focus.js", () => ({
  focusedControlThatTakesNoText: vi.fn(async () => null),
}));
