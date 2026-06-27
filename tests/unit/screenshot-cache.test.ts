import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  persistCapture,
  readCaptureBytes,
  resolveCaptureFile,
  readIndex,
  getScreenshotCacheRoot,
  CaptureRefError,
  type CaptureRefCode,
  REF_URI_PREFIX,
} from "../../src/engine/screenshot-cache.js";

let cacheDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  cacheDir = path.join(os.tmpdir(), `dt-sc-test-${crypto.randomBytes(6).toString("hex")}`);
  env = { DESKTOP_TOUCH_SCREENSHOTS_DIR: cacheDir };
});
afterEach(() => {
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function appendRawIndex(root: string, entry: object): void {
  fs.appendFileSync(path.join(root, "_index.ndjson"), JSON.stringify(entry) + "\n");
}

function expectRefCode(fn: () => unknown, code: CaptureRefCode): void {
  try {
    fn();
    throw new Error(`expected CaptureRefError(${code}) but nothing threw`);
  } catch (e) {
    expect(e).toBeInstanceOf(CaptureRefError);
    expect((e as CaptureRefError).code).toBe(code);
  }
}

describe("screenshot-cache — persist + read round-trip", () => {
  it("persistCapture writes bytes and returns an opaque by-ref URI (no caller path leaked)", () => {
    const r = persistCapture(PNG, { mimeType: "image/png", width: 100, height: 50 }, env);
    expect(r.uri).toBe(REF_URI_PREFIX + r.captureId);
    expect(r.uri.includes(cacheDir)).toBe(false);
    expect(r.bytes).toBe(PNG.length);
    expect(r.width).toBe(100);
    expect(r.height).toBe(50);
  });

  it("readCaptureBytes returns the exact bytes that were persisted", () => {
    const r = persistCapture(PNG, { mimeType: "image/png", width: 10, height: 10 }, env);
    const { data, entry } = readCaptureBytes(r.captureId, env);
    expect(data.equals(PNG)).toBe(true);
    expect(entry.mimeType).toBe("image/png");
    expect(entry.file.endsWith(".png")).toBe(true);
    expect(resolveCaptureFile(r.captureId, env)).toContain(r.captureId);
  });

  it("file extension is derived from mimeType (png/webp/jpeg)", () => {
    const png = persistCapture(PNG, { mimeType: "image/png", width: 1, height: 1 }, env);
    const webp = persistCapture(PNG, { mimeType: "image/webp", width: 1, height: 1 }, env);
    const jpg = persistCapture(PNG, { mimeType: "image/jpeg", width: 1, height: 1 }, env);
    const idx = readIndex(getScreenshotCacheRoot(env));
    expect(idx.get(png.captureId)!.file.endsWith(".png")).toBe(true);
    expect(idx.get(webp.captureId)!.file.endsWith(".webp")).toBe(true);
    expect(idx.get(jpg.captureId)!.file.endsWith(".jpg")).toBe(true);
  });

  it("the append-only index accumulates multiple captures", () => {
    persistCapture(PNG, { mimeType: "image/png", width: 1, height: 1 }, env);
    persistCapture(PNG, { mimeType: "image/png", width: 1, height: 1 }, env);
    expect(readIndex(getScreenshotCacheRoot(env)).size).toBe(2);
  });
});

describe("screenshot-cache — security (ADR-026 §4 / AC3 path traversal)", () => {
  it("unknown captureId → not_found", () => {
    getScreenshotCacheRoot(env);
    expectRefCode(() => resolveCaptureFile("does-not-exist", env), "not_found");
  });

  it("relative-traversal file name in index → outside_cache (basename rejection)", () => {
    const root = getScreenshotCacheRoot(env);
    appendRawIndex(root, { captureId: "evil1", ts: 1, bytes: 1, file: "../evil.png", mimeType: "image/png", width: 1, height: 1 });
    expectRefCode(() => resolveCaptureFile("evil1", env), "outside_cache");
  });

  it("absolute file name in index → outside_cache", () => {
    const root = getScreenshotCacheRoot(env);
    const abs = process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/passwd";
    appendRawIndex(root, { captureId: "evil2", ts: 1, bytes: 1, file: abs, mimeType: "image/png", width: 1, height: 1 });
    expectRefCode(() => resolveCaptureFile("evil2", env), "outside_cache");
  });

  it("nested-separator file name in index → outside_cache", () => {
    const root = getScreenshotCacheRoot(env);
    appendRawIndex(root, { captureId: "evil4", ts: 1, bytes: 1, file: "sub/evil.png", mimeType: "image/png", width: 1, height: 1 });
    expectRefCode(() => resolveCaptureFile("evil4", env), "outside_cache");
  });

  it("symlink inside the cache → symlink rejected (skipped where symlinks need privilege)", () => {
    const root = getScreenshotCacheRoot(env);
    const outside = path.join(os.tmpdir(), `dt-sc-outside-${crypto.randomBytes(6).toString("hex")}.png`);
    fs.writeFileSync(outside, PNG);
    const linkName = "linked.png";
    try {
      fs.symlinkSync(outside, path.join(root, linkName));
    } catch {
      fs.rmSync(outside, { force: true });
      return; // no symlink privilege (e.g. Windows without Developer Mode) — skip
    }
    appendRawIndex(root, { captureId: "evil3", ts: 1, bytes: 1, file: linkName, mimeType: "image/png", width: 1, height: 1 });
    try {
      expectRefCode(() => resolveCaptureFile("evil3", env), "symlink");
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
