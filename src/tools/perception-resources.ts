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
 *
 * Resources expose cached lens state. They do not force Win32/CDP/UIA refresh;
 * call perception_read when attention is dirty, settling, or stale.
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
import { ResourceNotificationScheduler } from "../engine/perception/resource-notifications.js";
import {
  getStore,
  getLens,
  getAllLenses,
  getDirtyJournal,
  getLensAttention,
  getNativePerceptionDiagnostics,
  addLensLifecycleListener,
  addPerceptionChangeListener,
} from "../engine/perception/registry.js";

export const resourceRegistry = new ResourceRegistry();

let _disposeLifecycleListener: (() => void) | null = null;
let _disposeChangeListener:    (() => void) | null = null;
let _notificationScheduler: ResourceNotificationScheduler | null = null;
let _server: McpServer | null = null;

/** Called once at server start to register the perception resource template. */
export function registerPerceptionResources(server: McpServer): void {
  _server = server;

  resourceRegistry.setOnListChanged(() => {
    server.sendResourceListChanged();
  });

  // F2: Wire lifecycle listener so resource list stays in sync with lens lifecycle.
  _disposeLifecycleListener?.();
  _disposeLifecycleListener = addLensLifecycleListener({
    onRegistered: lens => resourceRegistry.onLensRegistered(lens),
    onForgotten:  lensId => resourceRegistry.onLensForgotten(lensId),
  });

  // F7: Wire notification scheduler for attention-transition resource updates.
  _notificationScheduler?.dispose();
  _notificationScheduler = new ResourceNotificationScheduler(
    lensId => resourceRegistry.getUrisForLens(lensId),
    lensId => getLensAttention(lensId),
    {
      onNotify: uris => {
        // Try sendResourceUpdated if available (SDK version dependent).
        // Fall back to sendResourceListChanged as a best-effort signal.
        for (const uri of uris) {
          try {
            // @ts-expect-error — sendResourceUpdated is not in all SDK versions
            if (typeof server.sendResourceUpdated === "function") {
              // @ts-expect-error
              server.sendResourceUpdated({ uri });
            } else {
              server.sendResourceListChanged();
              break; // one list-changed is enough
            }
          } catch {
            // Non-fatal — notifications are best-effort.
          }
        }
      },
    }
  );

  _disposeChangeListener?.();
  _disposeChangeListener = addPerceptionChangeListener({
    onChanged: (lensIds) => {
      _notificationScheduler?.maybeNotify(lensIds, "attention_change");
    },
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
      description:
        "Read-only cached per-lens state for the Reactive Perception Graph. " +
        "Resource reads do not force Win32/CDP/UIA refresh; call perception_read when " +
        "attention is dirty, settling, or stale. Views: summary, guards, debug (flag-gated).",
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
        case "debug":   body = projectResourceDebug(snapshot, getNativePerceptionDiagnostics()); break;
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

/** Tear down resource listeners (called from test reset or server shutdown). */
export function unregisterPerceptionResources(): void {
  _disposeLifecycleListener?.(); _disposeLifecycleListener = null;
  _disposeChangeListener?.();    _disposeChangeListener    = null;
  _notificationScheduler?.dispose(); _notificationScheduler = null;
  _server = null;
  resourceRegistry.__resetForTests();
}
