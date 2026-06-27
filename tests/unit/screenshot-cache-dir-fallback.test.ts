/**
 * ADR-026 Phase 4 (OQ7) — cache-dir write-probe ladder.
 *
 * Hermetic: every candidate is a per-test temp path, and `os.tmpdir` is spied so the
 * final fallback tier is controlled too (node:os is a singleton, so the spy is shared
 * with the module under test). No test ever writes into the real OS tmpdir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  getScreenshotCacheRoot,
  persistCapture,
  queryCaptures,
  gcCache,
  CacheUnwritableError,
  _resetCacheDirWarningForTest,
} from "../../src/engine/screenshot-cache.js";
import { buildImageBlocks } from "../../src/tools/screenshot-response.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B64 = PNG.toString("base64");

/** Make a fresh temp DIR (writable). */
function freshDir(): string {
  const d = path.join(os.tmpdir(), `dt-fb-${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/** Make a fresh temp FILE, and return a path UNDER it (so mkdir of that path fails). */
function unwritablePath(): { file: string; under: string } {
  const file = path.join(os.tmpdir(), `dt-fb-file-${crypto.randomBytes(6).toString("hex")}`);
  fs.writeFileSync(file, "x");
  return { file, under: path.join(file, "screenshots") };
}

let cleanup: string[];
let tmpdirSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetCacheDirWarningForTest();
  cleanup = [];
  // Default: point the tmpdir tier at a controlled, writable base so no test touches
  // the real shared OS tmpdir cache. Individual tests override this spy as needed.
  const ctrlTmp = freshDir();
  cleanup.push(ctrlTmp);
  tmpdirSpy = vi.spyOn(os, "tmpdir").mockReturnValue(ctrlTmp);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  tmpdirSpy.mockRestore();
  warnSpy.mockRestore();
  for (const d of cleanup) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("screenshot-cache-dir fallback ladder (ADR-026 Phase 4 / OQ7)", () => {
  it("explicit writable DESKTOP_TOUCH_SCREENSHOTS_DIR is used as-is (no fallback, no warning)", () => {
    const explicit = freshDir();
    cleanup.push(explicit);
    const env: NodeJS.ProcessEnv = { DESKTOP_TOUCH_SCREENSHOTS_DIR: explicit };
    expect(getScreenshotCacheRoot(env)).toBe(fs.realpathSync(explicit));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("unwritable explicit dir falls to the runtime dir (MCP_HOME) and warns once", () => {
    const { file, under } = unwritablePath();
    cleanup.push(file);
    const home = freshDir();
    cleanup.push(home);
    const env: NodeJS.ProcessEnv = {
      DESKTOP_TOUCH_SCREENSHOTS_DIR: under, // mkdir fails (parent is a file)
      DESKTOP_TOUCH_MCP_HOME: home,
    };
    const root = getScreenshotCacheRoot(env);
    expect(root).toBe(fs.realpathSync(path.join(home, "screenshots")));
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("explicit + runtime both unwritable falls all the way to the tmpdir tier", () => {
    const { file: f1, under: u1 } = unwritablePath();
    const { file: f2, under: u2 } = unwritablePath();
    cleanup.push(f1, f2);
    // runtime dir is also unwritable (MCP_HOME points under a file)
    const env: NodeJS.ProcessEnv = {
      DESKTOP_TOUCH_SCREENSHOTS_DIR: u1,
      DESKTOP_TOUCH_MCP_HOME: path.dirname(u2), // getRuntimeDir(env)/screenshots == u2 → fails
    };
    const root = getScreenshotCacheRoot(env);
    const expected = fs.realpathSync(
      path.join(os.tmpdir(), "desktop-touch-mcp", "screenshots")
    );
    expect(root).toBe(expected);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("every candidate unwritable → CacheUnwritableError (path-free message)", () => {
    const { file: f1, under: u1 } = unwritablePath();
    const { file: f2, under: u2 } = unwritablePath();
    const { file: f3, under: u3 } = unwritablePath();
    cleanup.push(f1, f2, f3);
    // make the tmpdir tier fail too: tmpdir() resolves under a regular file
    tmpdirSpy.mockReturnValue(u3);
    const env: NodeJS.ProcessEnv = {
      DESKTOP_TOUCH_SCREENSHOTS_DIR: u1,
      DESKTOP_TOUCH_MCP_HOME: path.dirname(u2),
    };
    let thrown: unknown;
    try {
      getScreenshotCacheRoot(env);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CacheUnwritableError);
    // R9: the message must not leak a candidate path (only a count).
    expect((thrown as Error).message).not.toContain(u1);
    expect((thrown as Error).message).not.toContain(os.tmpdir());
  });

  it("R6: when no dir is writable, the image emitter degrades to inline pixels + warning (never errors)", () => {
    const { file: f1, under: u1 } = unwritablePath();
    const { file: f2, under: u2 } = unwritablePath();
    const { file: f3, under: u3 } = unwritablePath();
    cleanup.push(f1, f2, f3);
    tmpdirSpy.mockReturnValue(u3);
    const env: NodeJS.ProcessEnv = {
      DESKTOP_TOUCH_SCREENSHOTS_DIR: u1,
      DESKTOP_TOUCH_MCP_HOME: path.dirname(u2),
    };
    const { blocks, warning } = buildImageBlocks({
      base64: PNG_B64,
      mimeType: "image/png",
      width: 4,
      height: 4,
      wantInline: false,
      env,
    });
    // degrade: inline image block only, no resource_link, a warning string set.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("image");
    expect(warning).toBeTruthy();
  });

  it("the fallback warning is emitted at most once per session (deduped)", () => {
    const { file, under } = unwritablePath();
    cleanup.push(file);
    const home = freshDir();
    cleanup.push(home);
    const env: NodeJS.ProcessEnv = {
      DESKTOP_TOUCH_SCREENSHOTS_DIR: under,
      DESKTOP_TOUCH_MCP_HOME: home,
    };
    getScreenshotCacheRoot(env);
    getScreenshotCacheRoot(env);
    getScreenshotCacheRoot(env);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("under the tmpdir fallback, a foreign settings.json is never listed or deleted (ownership gate holds)", () => {
    const { file: f1, under: u1 } = unwritablePath();
    const { file: f2, under: u2 } = unwritablePath();
    cleanup.push(f1, f2);
    const env: NodeJS.ProcessEnv = {
      DESKTOP_TOUCH_SCREENSHOTS_DIR: u1,
      DESKTOP_TOUCH_MCP_HOME: path.dirname(u2),
    };
    const root = getScreenshotCacheRoot(env); // tmpdir tier
    const foreign = path.join(root, "settings.json");
    fs.writeFileSync(foreign, JSON.stringify({ captureId: "evil", file: "../escape" }));

    const r = persistCapture(PNG, { mimeType: "image/png", width: 2, height: 2 }, env);
    const listing = queryCaptures({}, env);
    // only our own capture is surfaced; the foreign file is invisible.
    expect(listing.captures.map((c) => c.captureId)).toEqual([r.captureId]);

    // gc (even a real delete with orphans) must not remove the foreign file.
    gcCache({ dryRun: false, policy: { maxCount: 0 }, includeOrphans: true, now: Date.now() }, env);
    expect(fs.existsSync(foreign)).toBe(true);
  });
});
