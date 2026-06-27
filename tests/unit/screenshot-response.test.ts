import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { buildImageResponse, buildImageBlocks, pngDimensions } from "../../src/tools/screenshot-response.js";
import { readCaptureBytes, REF_URI_PREFIX } from "../../src/engine/screenshot-cache.js";

/**
 * Force `persistCapture` to fail so the R6 degrade path fires. With the ADR-026
 * Phase 4 write-probe ladder a single unwritable dir is NOT enough — an unwritable
 * `DESKTOP_TOUCH_SCREENSHOTS_DIR` now falls back to the runtime dir and then to the
 * OS tmpdir. To actually reach `CacheUnwritableError` we make ALL THREE rungs
 * unwritable: explicit + runtime (`MCP_HOME`) point under a regular file, and
 * `os.tmpdir()` is spied to the same. `os.tmpdir()` is spied AFTER the blocker dir
 * is created (so the temp dir itself is real). node:os is a singleton, so the spy
 * is shared with the module under test.
 */
function withNoWritableCacheDir<T>(fn: (env: NodeJS.ProcessEnv) => T): T {
  const blockerDir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-r6-"));
  const blocker = path.join(blockerDir, "file");
  fs.writeFileSync(blocker, "x");
  const spy = vi.spyOn(os, "tmpdir").mockReturnValue(path.join(blocker, "tmp"));
  try {
    return fn({
      DESKTOP_TOUCH_SCREENSHOTS_DIR: path.join(blocker, "explicit"),
      DESKTOP_TOUCH_MCP_HOME: path.join(blocker, "home"),
    });
  } finally {
    spy.mockRestore();
    fs.rmSync(blockerDir, { recursive: true, force: true });
  }
}

let cacheDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  cacheDir = path.join(os.tmpdir(), `dt-screenshot-resp-${crypto.randomBytes(6).toString("hex")}`);
  env = { DESKTOP_TOUCH_SCREENSHOTS_DIR: cacheDir };
});
afterEach(() => {
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// A tiny fake PNG payload (bytes are opaque to the cache layer).
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
const B64 = PNG.toString("base64");

function blocks(r: ReturnType<typeof buildImageResponse>) {
  return {
    image: r.content.find((c) => c.type === "image"),
    link: r.content.find((c) => c.type === "resource_link"),
    texts: r.content.filter((c) => c.type === "text"),
  };
}

describe("buildImageResponse — ADR-026 default ref / confirmImage inline", () => {
  it("default (wantInline=false) returns a resource_link and NO inline image", () => {
    const r = buildImageResponse({
      base64: B64, mimeType: "image/png", width: 100, height: 50,
      wantInline: false, textBlocks: ["Screenshot captured: 100x50px"], env,
    });
    const { image, link, texts } = blocks(r);
    expect(image).toBeUndefined();                                  // AC1: no inline pixels by default
    expect(link).toBeDefined();
    expect((link as { uri: string }).uri.startsWith(REF_URI_PREFIX)).toBe(true);
    expect(texts.map((t) => (t as { text: string }).text)).toContain("Screenshot captured: 100x50px");
    // Positional pin (P2-3): default ordering is [resource_link, ...texts].
    // A type-based find() would pass even if the blocks were reordered.
    expect(r.content[0].type).toBe("resource_link");
  });

  it("wantInline=true embeds the inline image AND the resource_link", () => {
    const r = buildImageResponse({
      base64: B64, mimeType: "image/png", width: 10, height: 10,
      wantInline: true, textBlocks: ["dims"], env,
    });
    const { image, link } = blocks(r);
    expect(image).toBeDefined();
    expect((image as { data: string }).data).toBe(B64);
    expect(link).toBeDefined();
    // Positional pin (P2-3): inline ordering is [image, resource_link, ...texts].
    expect(r.content[0].type).toBe("image");
    expect(r.content[1].type).toBe("resource_link");
  });

  it("the persisted ref reads back the exact bytes (round-trip)", () => {
    const r = buildImageResponse({
      base64: B64, mimeType: "image/png", width: 1, height: 1,
      wantInline: false, textBlocks: [], env,
    });
    const { link } = blocks(r);
    const captureId = (link as { uri: string }).uri.slice(REF_URI_PREFIX.length);
    const { data, entry } = readCaptureBytes(captureId, env);
    expect(data.equals(PNG)).toBe(true);
    expect(entry.mimeType).toBe("image/png");
  });

  it("the resource_link description steers the agent away from auto-reading", () => {
    const r = buildImageResponse({
      base64: B64, mimeType: "image/png", width: 1, height: 1,
      wantInline: false, textBlocks: [], env,
    });
    const { link } = blocks(r);
    expect((link as { description?: string }).description ?? "").toMatch(/only if you need/i);
  });

  it("R6: a cache-write failure degrades to inline pixels + a warning, never an error", () => {
    // No cache dir is writable (all three ladder rungs blocked) → persist throws.
    withNoWritableCacheDir((env) => {
      const r = buildImageResponse({
        base64: B64, mimeType: "image/png", width: 1, height: 1,
        wantInline: false, textBlocks: ["dims"],
        env,
      });
      const { image, link, texts } = blocks(r);
      expect(image).toBeDefined();                                  // degrade keeps capability
      expect(link).toBeUndefined();                                 // no ref when persist failed
      expect(texts.some((t) => /disk-cache write failed/i.test((t as { text: string }).text))).toBe(true);
      expect(r.isError).toBeUndefined();                            // R6: not an error
      // Positional pin (P2-3): R6 ordering is [image, ...texts, warning-LAST].
      expect(r.content[0].type).toBe("image");
      const last = r.content[r.content.length - 1] as { type: string; text: string };
      expect(last.type).toBe("text");
      expect(last.text).toMatch(/disk-cache write failed/i);
    });
  });
});

describe("buildImageBlocks — ADR-026 Phase 2 per-image core", () => {
  it("default (wantInline=false) → [resource_link] only, no inline image", () => {
    const { blocks, warning } = buildImageBlocks({
      base64: B64, mimeType: "image/png", width: 10, height: 10, wantInline: false, env,
    });
    expect(warning).toBeUndefined();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("resource_link");
    expect((blocks[0] as { uri: string }).uri.startsWith(REF_URI_PREFIX)).toBe(true);
  });

  it("wantInline=true → [image, resource_link] in that order", () => {
    const { blocks } = buildImageBlocks({
      base64: B64, mimeType: "image/png", width: 10, height: 10, wantInline: true, env,
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("image");
    expect((blocks[0] as { data: string }).data).toBe(B64);
    expect(blocks[1].type).toBe("resource_link");
  });

  it("the persisted ref reads back the exact bytes (round-trip)", () => {
    const { blocks } = buildImageBlocks({
      base64: B64, mimeType: "image/png", width: 1, height: 1, wantInline: false, env,
    });
    const captureId = (blocks[0] as { uri: string }).uri.slice(REF_URI_PREFIX.length);
    const { data } = readCaptureBytes(captureId, env);
    expect(data.equals(PNG)).toBe(true);
  });

  it("describe override is reflected in the link description", () => {
    const { blocks } = buildImageBlocks({
      base64: B64, mimeType: "image/png", width: 7, height: 3, wantInline: false, env,
      describe: (i) => `Set-of-Marks crop ${i.width}×${i.height}`,
    });
    expect((blocks[0] as { description?: string }).description).toBe("Set-of-Marks crop 7×3");
  });

  it("R6: persist failure → [image] + warning (no throw), never a ref", () => {
    withNoWritableCacheDir((env) => {
      const { blocks, warning } = buildImageBlocks({
        base64: B64, mimeType: "image/png", width: 1, height: 1, wantInline: false,
        env,
      });
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe("image");                          // capability preserved
      expect(warning).toMatch(/disk-cache write failed/i);
    });
  });
});

describe("pngDimensions — native-free IHDR reader", () => {
  it("reads width/height from a real PNG header", () => {
    // 1×1 PNG (smallest valid): signature + IHDR(width=1,height=1) + …
    const onePx =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    expect(pngDimensions(onePx)).toEqual({ width: 1, height: 1 });
  });

  it("returns null for a non-PNG / malformed buffer", () => {
    expect(pngDimensions("not-a-png")).toBeNull();
    expect(pngDimensions("")).toBeNull();
    // A WebP RIFF header is not a PNG.
    expect(pngDimensions(Buffer.from("RIFF????WEBPVP8 ").toString("base64"))).toBeNull();
  });
});
