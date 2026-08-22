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
