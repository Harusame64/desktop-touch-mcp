/**
 * desktop-register.ts — MCP tool registration for desktop_see / desktop_touch.
 *
 * Guarded by env flag DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1.
 * Only imported when the flag is set — OFF path has zero side-effects.
 *
 * Facade lifecycle:
 *   - Process-local singleton (shared across all createMcpServer() calls).
 *   - In stateless HTTP mode, multiple requests share the same facade instance;
 *     session state (leases, generations) persists within the process lifetime.
 *     This is required: desktop_see in request N must be followed by desktop_touch
 *     in request N+1 using the same session.
 *   - State bleed between targets is prevented by the per-target SessionRegistry
 *     (each hwnd/tabId/windowTitle has its own LeaseStore and generation counter).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DesktopFacade, type CandidateProvider, type DesktopSeeInput } from "./desktop.js";
import type { EntityLease } from "../engine/world-graph/types.js";
import {
  SnapshotIngress,
  createWinEventIngressSource,
} from "../engine/world-graph/candidate-ingress.js";
import type { TargetSpec } from "../engine/world-graph/session-registry.js";
import { composeCandidates } from "./desktop-providers/compose-providers.js";

// ── Process-level facade singleton ───────────────────────────────────────────

let _facade: DesktopFacade | undefined;

/**
 * Return the process-level DesktopFacade.
 * Created lazily on first call; no heavy initialization happens at import time.
 *
 * P2-B: uses composeCandidates() as the provider — routes to browser/terminal/uia
 * based on target type and merges results additively.
 */
export function getDesktopFacade(): DesktopFacade {
  if (!_facade) {
    const provider: CandidateProvider = (input: DesktopSeeInput) =>
      composeCandidates(input.target);

    const ingress = new SnapshotIngress(
      async (key: string) => composeCandidates(targetKeyToSpec(key)),
      createWinEventIngressSource()
    );

    _facade = new DesktopFacade(provider, { ingress });
  }
  return _facade;
}

/**
 * Parse a TargetSessionKey back to a TargetSpec.
 * `window:__default__` returns undefined so the provider sees no target and returns [].
 * "@active" foreground fallback is handled inside each individual provider.
 */
function targetKeyToSpec(key: string): TargetSpec | undefined {
  if (key.startsWith("window:") && key !== "window:__default__") return { hwnd: key.slice(7) };
  if (key.startsWith("tab:"))    return { tabId: key.slice(4) };
  if (key.startsWith("title:"))  return { windowTitle: key.slice(6) };
  return undefined;
}

/**
 * Reset the facade singleton (for testing only).
 * Calls dispose() to close ingress event subscriptions before clearing.
 */
export function _resetFacadeForTest(): void {
  (_facade as unknown as { dispose?: () => void })?.dispose?.();
  _facade = undefined;
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const targetSchema = z.object({
  windowTitle: z.string().optional(),
  hwnd:        z.string().optional(),
  tabId:       z.string().optional(),
}).optional();

const leaseSchema = z.object({
  entityId:         z.string(),
  viewId:           z.string(),
  targetGeneration: z.string(),
  expiresAtMs:      z.number(),
  evidenceDigest:   z.string(),
});

const desktopSeeSchema = {
  target:      targetSchema.describe("Target window (windowTitle / hwnd) or browser tab (tabId). Omit for foreground window."),
  view:        z.enum(["action", "explore", "debug"]).optional().describe("action (default, ≤20 entities), explore (≤50), debug (includes raw rect)"),
  query:       z.string().optional().describe("Filter entities by label substring (case-insensitive)"),
  maxEntities: z.number().int().min(1).max(200).optional().describe("Override entity count limit"),
  debug:       z.boolean().optional().describe("Include raw screen coordinates in response (debug only — never relay to end-users)"),
};

const desktopTouchSchema = {
  lease:  leaseSchema.describe("Lease returned by desktop_see. Expires after TTL; re-call desktop_see if touch fails with lease_expired."),
  action: z.enum(["auto", "invoke", "click", "type", "select"]).optional().describe("Action to perform. 'auto' selects the best affordance from the entity."),
  text:   z.string().optional().describe("Text to type (required when action=type)"),
};

// ── Tool registration ─────────────────────────────────────────────────────────

/**
 * Register desktop_see and desktop_touch on the MCP server.
 * Only called when DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1.
 */
export function registerDesktopTools(server: McpServer): void {
  const facade = getDesktopFacade();

  server.tool(
    "desktop_see",
    [
      "[EXPERIMENTAL] Observe a window or browser tab and return interactive entities as structured data.",
      "Supports multiple source lanes: UIA (native), CDP (browser), terminal buffer, and visual GPU.",
      "Returns entities with leases — pass a lease to desktop_touch to interact.",
      "Raw screen coordinates are NOT returned in normal mode (debug=true only).",
    ].join(" "),
    desktopSeeSchema,
    async (input) => {
      const output = await facade.see(input as DesktopSeeInput);
      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    }
  );

  server.tool(
    "desktop_touch",
    [
      "[EXPERIMENTAL] Interact with an entity returned by desktop_see.",
      "Validates the lease before executing — rejects stale, expired, or mismatched leases.",
      "Returns a semantic diff (entity_disappeared, modal_appeared, etc.) and a 'next' hint.",
      "If ok=false, read 'reason' and re-call desktop_see to refresh the view.",
    ].join(" "),
    desktopTouchSchema,
    async (input) => {
      const result = await facade.touch({
        lease: input.lease as EntityLease,
        action: input.action,
        text: input.text,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
}
