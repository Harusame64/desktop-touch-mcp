/**
 * screenshot-resources.ts
 *
 * MCP resource registration for the disk-cached screenshot reference model
 * (ADR-026). The `screenshot` tool persists capture bytes and returns a cheap
 * `resource_link` (`screenshot://by-ref/{captureId}`) by default; this resource
 * is what the client reads when it actually needs the pixels.
 *
 * Reads go through {@link readCaptureBytes}, which resolves the opaque captureId
 * to a file *inside the canonical cache root only* (symlink-rejected before
 * realpath, separator-aware containment, dev/ino identity gate — ADR-026 §4).
 *
 * Read-policy (ADR-026 §2.2): every read re-expands the image to base64, so the
 * token saving only materialises when reads are rare/deferred. The description
 * nudges the agent to open a ref ONLY when pixel inspection is genuinely needed.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  readCaptureBytes,
  CaptureRefError,
} from "../engine/screenshot-cache.js";

/** Register the `screenshot://by-ref/{captureId}` resource (always-on; ADR-026). */
export function registerScreenshotResources(server: McpServer): void {
  const template = new ResourceTemplate("screenshot://by-ref/{captureId}", {
    // Not enumerable via resources/list — refs are handed out by the screenshot
    // tool, not discovered. (Resource links are explicitly allowed to be absent
    // from resources/list per the MCP spec.)
    //
    // No `complete` callback by design: a captureId is the bearer token for
    // cached pixels, so completing/enumerating recent IDs would let a client
    // (in a multi-client / delegated-tool context) discover and read captures it
    // was never handed — defeating the opaque-ref model (Codex P1). The exact ref
    // must come from a screenshot tool response.
    list: undefined,
  });

  server.registerResource(
    "screenshot-by-ref",
    template,
    {
      title: "Screenshot by reference",
      description:
        "Disk-cached screenshot pixels addressed by an opaque captureId " +
        "(screenshot://by-ref/{captureId}). The screenshot tool returns this as a " +
        "resource_link by default instead of inline image bytes. Read it ONLY when " +
        "you need to inspect the pixels — every read re-expands the image to base64, " +
        "so auto-reading every ref defeats the token saving (ADR-026 read-policy).",
    },
    async (uri, { captureId }) => {
      const id = Array.isArray(captureId) ? captureId[0] : captureId;
      try {
        const { data, entry } = readCaptureBytes(id);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: entry.mimeType,
              blob: data.toString("base64"),
            },
          ],
        };
      } catch (err) {
        // AC3 / R7: a dangling (GC'd) or out-of-cache ref is surfaced as an
        // explicit error, never a silent empty read.
        if (err instanceof CaptureRefError) {
          throw new Error(`screenshot ref unavailable (${err.code}): ${id}`);
        }
        throw err;
      }
    },
  );
}
