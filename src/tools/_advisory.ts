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

/** UIA control types that represent an editable text input. */
const TEXT_INPUT_CONTROL_TYPES = new Set(["Edit", "Document"]);

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
 */
export function maybeAdvisory(
  toolName: string,
  args: Record<string, unknown>,
  focusedElement: PostElementInfo | null,
): AdvisoryHint | null {
  const hint = buildHint(toolName, args, focusedElement);
  if (hint) advisoryEmitCount++;
  return hint;
}

function buildHint(
  toolName: string,
  args: Record<string, unknown>,
  focusedElement: PostElementInfo | null,
): AdvisoryHint | null {
  // Round 1: keyboard(action='type') → desktop_act.
  if (toolName !== "keyboard" || args["action"] !== "type") return null;
  // Gate on the already-paid focused-element observation (built by
  // `_post.ts::snapshotFocusedElement`). UIA-blind targets and non-text controls
  // fail here (suppression is definitional, ADR-022 §5.3):
  //  - `type` is the UIA controlType (PostElementInfo.type)
  //  - `value !== undefined` ⇒ UIA exposed ValuePattern on it (set only when the
  //    focused element's UIA `value` is non-null)
  if (!focusedElement) return null;
  if (!TEXT_INPUT_CONTROL_TYPES.has(focusedElement.type)) return null;
  if (focusedElement.value === undefined) return null;

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

/** Make a string safe to embed inside the single-quoted example literal. */
function sanitize(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/'/g, "\\'");
}
