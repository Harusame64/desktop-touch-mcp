/**
 * perception-resources.ts
 *
 * MCP resource registration for per-lens Reactive Perception Graph state.
 * Gated behind DESKTOP_TOUCH_PERCEPTION_RESOURCES=1.
 *
 * Views:
 *   perception://lens/{lensId}/summary  — attention, canAct, guards, target/browser
 *   perception://lens/{lensId}/guards   — full guard result list
 *   perception://lens/{lensId}/debug    — all fluents + diagnostics (DEBUG_RESOURCES=1 only)
 *   perception://lens/{lensId}/events   — reserved (DEBUG_RESOURCES=1 only)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildLensSnapshot,
  projectResourceSummary,
  projectResourceGuards,
  projectResourceDebug,
} from "../engine/perception/resource-model.js";
import { ResourceRegistry } from "../engine/perception/resource-registry.js";
import { getStore, getLens, getAllLenses } from "../engine/perception/registry.js";
import { getDirtyJournal } from "../engine/perception/registry.js";

export const resourceRegistry = new ResourceRegistry();

/** Called once at server start to register the perception resource template. */
export function registerPerceptionResources(server: McpServer): void {
  resourceRegistry.setOnListChanged(() => {
    server.sendResourceListChanged();
  });

  // Dynamic template: perception://lens/{lensId}/{view}
  const template = new ResourceTemplate(
    "perception://lens/{lensId}/{view}",
    {
      list: async () => {
        return { resources: resourceRegistry.listForClient() };
      },
      complete: {
        lensId: async (_value) => {
          return getAllLenses().map(l => l.lensId);
        },
        view: async (_value) => {
          const views = ["summary", "guards"];
          if (process.env.DESKTOP_TOUCH_PERCEPTION_DEBUG_RESOURCES === "1") {
            views.push("debug", "events");
          }
          return views;
        },
      },
    }
  );

  server.registerResource(
    "perception-lens",
    template,
    {
      title: "Perception Lens State",
      description: "Read-only per-lens state for the Reactive Perception Graph. Views: summary, guards, debug (flag-gated).",
      mimeType: "application/json",
    },
    async (uri, { lensId, view }) => {
      const resolvedLensId = Array.isArray(lensId) ? lensId[0] : lensId;
      const resolvedView   = Array.isArray(view)   ? view[0]   : view;

      // Check for tombstone first
      const tombstone = resourceRegistry.getTombstone(uri.href);
      if (tombstone) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              attention: "tombstone",
              lensId: tombstone.lensId,
              removedAtMs: tombstone.removedAtMs,
              message: tombstone.message,
            }, null, 2),
          }],
        };
      }

      // Debug/events views are restricted
      if ((resolvedView === "debug" || resolvedView === "events") &&
          process.env.DESKTOP_TOUCH_PERCEPTION_DEBUG_RESOURCES !== "1") {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              error: "not_found",
              message: `View '${resolvedView}' requires DESKTOP_TOUCH_PERCEPTION_DEBUG_RESOURCES=1`,
            }, null, 2),
          }],
        };
      }

      const lens = getLens(resolvedLensId);
      if (!lens) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              error: "not_found",
              message: `Lens '${resolvedLensId}' not found. Register it first with perception_register.`,
            }, null, 2),
          }],
        };
      }

      const store   = getStore();
      const journal = getDirtyJournal();
      const snapshot = buildLensSnapshot(lens, store, journal);

      let body: unknown;
      switch (resolvedView) {
        case "summary": body = projectResourceSummary(snapshot); break;
        case "guards":  body = projectResourceGuards(snapshot);  break;
        case "debug":   body = projectResourceDebug(snapshot);   break;
        case "events":  body = { lensId: lens.lensId, message: "events view not yet implemented" }; break;
        default:
          body = { error: "unknown_view", view: resolvedView };
      }

      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(body, null, 2),
        }],
      };
    }
  );
}
