/**
 * _advisory.ts — success-path advisory hints (ADR-022 / issue #352).
 *
 * When a tool SUCCEEDS but a better path was available, attach an additive
 * `advisory` to the response with a concrete, filled-in example. LLMs follow a
 * corrected example in their own tool history far more strongly than an abstract
 * instruction (compiler "did you mean…?" / ESLint-autofix principle).
 *
 * Round 1 wires one pair: `keyboard(action='type')` → `desktop_act`, emitted only
 * when the focused element is a UIA text input (so UIA-blind targets — PWA /
 * Electron / Canvas — get no advisory and keyboard stays the right call).
 *
 * Probe cost: ZERO. The gate reads the focused-element snapshot `withPostState`
 * already takes every call (`_post.ts` `snapshotFocusedElement`) — no fresh UIA
 * round-trip. This module is a pure builder over `PostElementInfo`; it calls no
 * UIA and has no dependency on the discover handler (no `keyboard → desktop_discover`
 * edge). Design: `desktop-touch-mcp-internal/docs/adr-022-success-path-advisory-hints.md`.
 */

import type { PostElementInfo } from "./_post.js";

export interface AdvisoryHint {
  /** The tool/path the LLM should prefer next time (e.g. "desktop_act"). */
  preferredPath: string;
  /** Why the preferred path is better — concrete, not a generic rule. */
  reason: string;
  /** A filled-in call sequence with the real args bound (windowTitle / text). */
  example: string;
}

// ── Generic credential-advisor hook (ADR-014 R3 OQ-W-16-bis, Phase 3) ─────────────
// A nullable slot the Key Locker WIRING fills, so this module (and terminal.ts) stay
// locker-agnostic — no terminal→locker import (the "terminal fold" coupling the plan
// rejected). buildHint calls it for `terminal(action='send')`; the wiring decides
// whether a credential command went to a non-anchored pane and returns the nudge.
type CredentialAdvisor = (args: Record<string, unknown>) => AdvisoryHint | null;
let credentialAdvisor: CredentialAdvisor | null = null;
export function setCredentialAdvisor(fn: CredentialAdvisor | null): void {
  credentialAdvisor = fn;
}

/** UIA control types that represent an editable text input. NOTE: ComboBox is
 *  deliberately EXCLUDED — dogfood (ADR-022) showed Chromium exposes web text
 *  inputs (e.g. Google search) as ComboBox, so admitting it would mis-fire on
 *  browser content where browser_* / keyboard is the right path, not desktop_act. */
const TEXT_INPUT_CONTROL_TYPES = new Set(["Edit", "Document"]);

/** UIA automationId of a Chromium web-area root. dogfood (ADR-022) showed a
 *  browser's focused element resolves to this Document with value=URL — a wrong
 *  desktop_act nudge (web content uses browser_* / keyboard, not desktop_act). */
const WEB_AREA_AUTOMATION_ID = "RootWebArea";

/** Browser executables — when the focused window is one of these, the target is
 *  web content (UIA-blind / RootWebArea / web ComboBox/Edit) where browser_* is
 *  the right path, so the keyboard→desktop_act advisory is suppressed entirely
 *  (belt-and-suspenders beyond the RootWebArea check; ADR-022 dogfood). */
const BROWSER_PROCESS_NAMES = new Set([
  "chrome", "msedge", "brave", "opera", "vivaldi", "chromium",
]);

function isBrowserProcess(processName: string): boolean {
  // processName may carry a ".exe" suffix or different case depending on source.
  const base = processName.toLowerCase().replace(/\.exe$/, "");
  return BROWSER_PROCESS_NAMES.has(base);
}

/** Max length of the `text` echoed into the example before truncation. */
const EXAMPLE_TEXT_MAX = 40;

// ── Emit counter (OQ-5) ───────────────────────────────────────────────────────
// The only objective fire-rate signal (the LLM-driven E2E harness was scrapped).
// Surfaced via server_status; lets dogfood see whether advisories are emitted at
// all (under-fire risk, ADR-022 R2). Process-lifetime cumulative.
let advisoryEmitCount = 0;
export function getAdvisoryEmitCount(): number {
  return advisoryEmitCount;
}

/**
 * Build a success-path advisory for `toolName(args)` given the focused-element
 * snapshot, or `null` when none applies. Increments the emit counter on a hit.
 *
 * @param toolName  the wrapping tool name (e.g. "keyboard")
 * @param args      the tool call args (read-only; e.g. {action,windowTitle,text})
 * @param focusedElement  the snapshot `withPostState` already captured (may be null)
 * @param processName  the focused window's process (for browser suppression)
 */
export function maybeAdvisory(
  toolName: string,
  args: Record<string, unknown>,
  focusedElement: PostElementInfo | null,
  processName: string,
): AdvisoryHint | null {
  const hint = buildHint(toolName, args, focusedElement, processName);
  if (hint) advisoryEmitCount++;
  return hint;
}

function buildHint(
  toolName: string,
  args: Record<string, unknown>,
  focusedElement: PostElementInfo | null,
  processName: string,
): AdvisoryHint | null {
  // ADR-014 R3 OQ-W-16-bis (Phase 3): terminal(action='send') → key_locker launch_console.
  // Delegated to the wiring-supplied hook (locker state lives there, not here). Returns a nudge
  // when a credential command was sent to a pane the locker can't autofill; null otherwise.
  if (toolName === "terminal" && args["action"] === "send") {
    return credentialAdvisor !== null ? credentialAdvisor(args) : null;
  }
  // Round 1: keyboard(action='type') → desktop_act.
  if (toolName !== "keyboard" || args["action"] !== "type") return null;
  // Browser suppression (ADR-022 dogfood): web content uses browser_* / keyboard,
  // not desktop_act — never advise desktop_act when the focused window is a browser.
  if (isBrowserProcess(processName)) return null;
  // Gate on the already-paid focused-element observation (built by
  // `_post.ts::snapshotFocusedElement`). UIA-blind targets and non-text controls
  // fail here (suppression is definitional, ADR-022 §5.3):
  //  - `type` is the UIA controlType (PostElementInfo.type)
  //  - `value !== undefined` ⇒ UIA exposed ValuePattern on it (set only when the
  //    focused element's UIA `value` is non-null)
  //  - automationId !== RootWebArea ⇒ not an embedded web-area root (a Chromium
  //    page root reports Document + value=URL; that is a wrong desktop_act nudge —
  //    belt with the browser-process check above for Electron/embedded Chromium).
  if (!focusedElement) return null;
  if (!TEXT_INPUT_CONTROL_TYPES.has(focusedElement.type)) return null;
  if (focusedElement.value === undefined) return null;
  if (focusedElement.automationId === WEB_AREA_AUTOMATION_ID) return null;

  const windowTitle = typeof args["windowTitle"] === "string" ? (args["windowTitle"] as string) : undefined;
  const text = typeof args["text"] === "string" ? (args["text"] as string) : undefined;

  const discoverArg = windowTitle
    ? `{target:{windowTitle:'${sanitize(windowTitle)}'}}`
    : `{target:{focused:true}}`;
  const actArg =
    text !== undefined
      ? `{lease, action:'type', text:'${sanitize(truncate(text))}'}`
      : `{lease, action:'type', text:'…'}`;

  return {
    preferredPath: "desktop_act",
    reason:
      "the focused element is a UIA text input (ValuePattern) — desktop_act runs the lease flow (lease verification, modal-blocking detection, attention diff) that keyboard:type does not. keyboard is correct only for UIA-blind targets (PWA / Electron / Canvas).",
    example: `desktop_discover(${discoverArg}) → desktop_act(${actArg})`,
  };
}

/** Truncate `text` for the illustrative example (keeps the hint compact). */
function truncate(text: string): string {
  return text.length > EXAMPLE_TEXT_MAX ? `${text.slice(0, EXAMPLE_TEXT_MAX)}…` : text;
}

/** Make a string safe to embed inside the single-quoted example literal.
 *  Escape backslash FIRST (else a later `'`→`\'` would be mis-paired), then the
 *  quote, then collapse newlines (CodeQL: incomplete string escaping). */
function sanitize(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/[\r\n]+/g, " ");
}
