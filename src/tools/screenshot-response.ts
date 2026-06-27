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
import type { ContentBlock, ToolResult } from "./_types.js";

/**
 * Read a PNG's pixel dimensions straight from its IHDR chunk (pure byte parsing,
 * no native decoder — keeps this module native-free). The SoM pipeline returns
 * `{ base64, mimeType: "image/png" }` with no dims, so emitters that persist a
 * som bitmap derive width/height here for the cache index + ref description.
 * Returns null on any non-PNG / malformed buffer; callers fall back to 0×0.
 *
 * PNG layout: 8-byte signature, then a length(4)+type(4)="IHDR" chunk whose data
 * begins with width(4) + height(4) as big-endian uint32 — i.e. at byte offsets
 * 16 and 20.
 */
export function pngDimensions(base64: string): { width: number; height: number } | null {
  try {
    const buf = Buffer.from(base64, "base64");
    if (buf.length < 24) return null;
    // 0x89 'P' 'N' 'G' \r \n 0x1a \n
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
    if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

/** The exact warning surfaced when the disk-cache write fails (R6 degrade). */
const PERSIST_FAILED_WARNING =
  "Screenshot disk-cache write failed; returning inline pixels (no by-ref link). " +
  "Point DESKTOP_TOUCH_SCREENSHOTS_DIR or DESKTOP_TOUCH_MCP_HOME at a writable path to restore by-ref output.";

/** Default `resource_link` description — steers the agent away from auto-reading. */
function defaultDescribe(info: { width: number; height: number; mimeType: string; bytes: number }): string {
  return (
    `Screenshot ${info.width}×${info.height} (${info.mimeType}, ${info.bytes} bytes). ` +
    `Open this resource only if you need to inspect the pixels — the text above ` +
    `already carries dimensions and click coordinates.`
  );
}

/**
 * ADR-026 §2.1/§3 (Phase 2) — persist one captured image to the per-user
 * disk-cache and return the MCP content blocks for it (NOT a whole ToolResult).
 *
 * This is the per-image core shared by every image emitter (detail=image / som /
 * text-SoM fallback / diffMode frame / mode='background' / scroll-capture /
 * workspace thumbnail). Multi-image emitters (diffMode, workspace) call this once
 * per image and splice the returned `blocks` into their own content array; the
 * single-image whole-result `buildImageResponse` is a thin composer over it.
 *
 * Default (`wantInline=false`): `{ blocks: [resource_link] }` — a cheap by-ref
 * link only, NO inline base64. The agent reads the ref (resources/read) ONLY when
 * it actually needs pixels; auto-reading every ref re-expands base64 and defeats
 * the token saving (§2.2 read-policy).
 *
 * `wantInline=true` (confirmImage / dotByDot / mode='background'):
 * `{ blocks: [image, resource_link] }` — inline pixels for immediate vision AND
 * the ref so re-viewing later stays cheap.
 *
 * R6 degrade: if `persistCapture` throws (disk full / EACCES) we return
 * `{ blocks: [image], warning }` — inline pixels + a warning string for the
 * caller to surface, rather than erroring. Capability is preserved; only the
 * token saving is lost.
 */
export function buildImageBlocks(opts: {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
  wantInline: boolean;
  meta?: Partial<CaptureMeta>;
  env?: NodeJS.ProcessEnv;
  describe?: (info: { width: number; height: number; mimeType: string; bytes: number }) => string;
}): { blocks: ContentBlock[]; warning?: string } {
  const { base64, mimeType, width, height, wantInline, meta, env, describe } = opts;
  const inlineBlock: ContentBlock = { type: "image", data: base64, mimeType };

  let persisted;
  try {
    persisted = persistCapture(Buffer.from(base64, "base64"), { mimeType, width, height, ...meta }, env);
  } catch {
    // R6: degrade to inline + warning, never error on a cache-write failure.
    return { blocks: [inlineBlock], warning: PERSIST_FAILED_WARNING };
  }

  const info = { width, height, mimeType, bytes: persisted.bytes };
  const link: ContentBlock = {
    type: "resource_link",
    uri: persisted.uri,
    name: `screenshot-${persisted.captureId}`,
    mimeType,
    description: (describe ?? defaultDescribe)(info),
  };

  return { blocks: wantInline ? [inlineBlock, link] : [link] };
}

/**
 * ADR-026 §2.1 — whole-`ToolResult` builder for a single-image response
 * (`screenshot` detail=image / displayId / fullscreen). A thin composer over
 * {@link buildImageBlocks}: image/link blocks first, then the structured `text`
 * blocks (dimensions, dotByDot origin/scale, hints) which are ALWAYS emitted so
 * the coordinate contract survives even when pixels are deferred to the ref.
 *
 * Block ordering (pinned by `screenshot-response.test.ts` positional asserts):
 *   default    → [resource_link, ...texts]
 *   wantInline → [image, resource_link, ...texts]
 *   R6 degrade → [image, ...texts, warning]   (warning is the LAST block)
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
  const { textBlocks, ...blockOpts } = opts;
  const { blocks, warning } = buildImageBlocks(blockOpts);
  const texts: ContentBlock[] = textBlocks.map((t) => ({ type: "text", text: t }));

  if (warning) {
    return {
      content: [
        ...blocks,
        ...texts,
        { type: "text", text: JSON.stringify({ hints: { warnings: [warning] } }) },
      ],
    };
  }
  return { content: [...blocks, ...texts] };
}
