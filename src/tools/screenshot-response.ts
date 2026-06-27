/**
 * screenshot-response.ts
 *
 * The ADR-026 image response builder, kept in its own module so it can be
 * unit-tested WITHOUT importing `screenshot.ts` (which transitively loads
 * `engine/nutjs` → native libnut and aborts on a host without the native deps,
 * e.g. a Linux unit lane). This module only depends on the pure cache layer and
 * the tool result types — no native bindings (Codex review).
 */
import { persistCapture } from "../engine/screenshot-cache.js";
import type { CaptureMeta } from "../engine/screenshot-cache.js";
import type { ToolResult } from "./_types.js";

/**
 * ADR-026 §2.1 — persist captured pixels to the per-user disk-cache and build
 * the MCP content blocks for an image response.
 *
 * Default (`wantInline=false`): a cheap `resource_link`
 * (`screenshot://by-ref/{captureId}`) plus the structured `text` blocks only —
 * NO inline base64. The agent reads the ref (resources/read) ONLY when it
 * actually needs to look at pixels; auto-reading every ref re-expands base64 and
 * defeats the token saving (§2.2 read-policy).
 *
 * `wantInline=true` (confirmImage, or dotByDot coordinate use): additionally
 * embeds the inline `image` block so vision is immediate, AND still returns the
 * ref so re-viewing later is cheap. (mode='background' will join this set in
 * Phase 2 — `screenshotBgHandler` is not yet routed through this helper.)
 *
 * The structured `text` blocks (dimensions, dotByDot origin/scale, hints) are
 * ALWAYS emitted, so the coordinate contract survives even when pixels are
 * deferred to the ref (§3: pixels may move to the ref, coords must not).
 *
 * R6 degrade: if `persistCapture` throws (disk full / EACCES) we fall back to an
 * inline base64 image + a warning rather than erroring — capability preserved,
 * only the token saving is lost.
 */
export function buildImageResponse(opts: {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
  wantInline: boolean;
  textBlocks: string[];
  meta?: Partial<CaptureMeta>;
  env?: NodeJS.ProcessEnv;
}): ToolResult {
  const { base64, mimeType, width, height, wantInline, textBlocks, meta, env } = opts;
  const inlineBlock = { type: "image" as const, data: base64, mimeType };
  const texts = textBlocks.map((t) => ({ type: "text" as const, text: t }));

  let persisted;
  try {
    persisted = persistCapture(
      Buffer.from(base64, "base64"),
      { mimeType, width, height, ...meta },
      env,
    );
  } catch {
    // R6: degrade to inline + warning, never error on a cache-write failure.
    return {
      content: [
        inlineBlock,
        ...texts,
        {
          type: "text" as const,
          text: JSON.stringify({
            hints: {
              warnings: [
                "Screenshot disk-cache write failed; returning inline pixels (no by-ref link). " +
                  "Point DESKTOP_TOUCH_SCREENSHOTS_DIR or DESKTOP_TOUCH_MCP_HOME at a writable path to restore by-ref output.",
              ],
            },
          }),
        },
      ],
    };
  }

  const link = {
    type: "resource_link" as const,
    uri: persisted.uri,
    name: `screenshot-${persisted.captureId}`,
    mimeType,
    description:
      `Screenshot ${width}×${height} (${mimeType}, ${persisted.bytes} bytes). ` +
      `Open this resource only if you need to inspect the pixels — the text above ` +
      `already carries dimensions and click coordinates.`,
  };

  return wantInline
    ? { content: [inlineBlock, link, ...texts] }
    : { content: [link, ...texts] };
}
