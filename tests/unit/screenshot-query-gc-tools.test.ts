/**
 * ADR-026 Phase 3 — `screenshot_query` / `screenshot_gc` tool handler tests.
 *
 * Exercises the real raw handlers (not the envelope-wrapped registration handlers)
 * against a throwaway cache dir set via process.env, so the dryRun double-gate and
 * filter pass-through are pinned end-to-end. Auto-prune is disabled so seeded
 * counts are deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { screenshotQueryHandler } from "../../src/tools/screenshot-query.js";
import { screenshotGcHandler } from "../../src/tools/screenshot-gc.js";
import {
  persistCapture,
  readCaptureBytes,
  CaptureRefError,
  _resetAutoPruneCounterForTest,
} from "../../src/engine/screenshot-cache.js";
import type { ToolResult } from "../../src/tools/_types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function parse(result: ToolResult): Record<string, unknown> {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text) as Record<string, unknown>;
}

let cacheDir: string;
const saved: Record<string, string | undefined> = {};
const KEYS = [
  "DESKTOP_TOUCH_SCREENSHOTS_DIR",
  "DESKTOP_TOUCH_SCREENSHOT_AUTOPRUNE",
  "DESKTOP_TOUCH_SCREENSHOT_MAX_COUNT",
  "DESKTOP_TOUCH_SCREENSHOT_MAX_BYTES",
  "DESKTOP_TOUCH_SCREENSHOT_MAX_AGE_MS",
];

beforeEach(() => {
  cacheDir = path.join(os.tmpdir(), `dt-tool-test-${crypto.randomBytes(6).toString("hex")}`);
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  process.env.DESKTOP_TOUCH_SCREENSHOTS_DIR = cacheDir;
  process.env.DESKTOP_TOUCH_SCREENSHOT_AUTOPRUNE = "0"; // deterministic seeded counts
  _resetAutoPruneCounterForTest();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedCaptures(n: number, tag?: string): void {
  for (let i = 0; i < n; i++) {
    persistCapture(PNG, { mimeType: "image/png", width: 4, height: 4, ...(tag ? { tag } : {}) });
  }
}

describe("screenshot_query handler", () => {
  it("returns the listing payload (ok shape) with whole-cache stats", async () => {
    seedCaptures(2);
    const r = parse(await screenshotQueryHandler({}));
    expect(r.total).toBe(2);
    expect((r.captures as unknown[]).length).toBe(2);
    expect(r.cache).toEqual({ totalCaptures: 2, totalBytes: PNG.length * 2 });
  });

  it("passes the tag filter through (case-insensitive)", async () => {
    persistCapture(PNG, { mimeType: "image/png", width: 4, height: 4, tag: "Alpha" });
    persistCapture(PNG, { mimeType: "image/png", width: 4, height: 4, tag: "beta" });
    const r = parse(await screenshotQueryHandler({ tag: "ALPHA" }));
    expect(r.total).toBe(1);
    expect((r.captures as { tag: string }[])[0].tag).toBe("Alpha");
  });
});

describe("screenshot_gc handler — dryRun double gate", () => {
  it("defaults to a dry run: lists candidates, deletes nothing", async () => {
    seedCaptures(5);
    const r = parse(await screenshotGcHandler({ maxCount: 1 }));
    expect(r.dryRun).toBe(true);
    expect(r.deleted).toBe(0);
    expect((r.candidates as unknown[]).length).toBe(4);
    expect(r.requested).toEqual({ dryRun: true, confirm: false });
    expect(parse(await screenshotQueryHandler({})).total).toBe(5); // untouched
  });

  it("dryRun:false WITHOUT confirm is forced back to a dry run (no delete)", async () => {
    seedCaptures(5);
    const r = parse(await screenshotGcHandler({ dryRun: false, maxCount: 1 }));
    expect(r.dryRun).toBe(true); // forced — confirm was not set
    expect(r.deleted).toBe(0);
    expect(r.requested).toEqual({ dryRun: false, confirm: false });
    expect(parse(await screenshotQueryHandler({})).total).toBe(5);
  });

  it("confirm:true alone (dryRun omitted = default true) is forced to a dry run (no delete)", async () => {
    // Pins the 4th corner of the gate (Opus P2): a regression to
    // `effectiveDryRun = !confirm` would delete here — the dryRun term must remain.
    seedCaptures(5);
    const r = parse(await screenshotGcHandler({ confirm: true, maxCount: 1 }));
    expect(r.dryRun).toBe(true); // dryRun defaults true → not (false && true) → dry run
    expect(r.deleted).toBe(0);
    expect(parse(await screenshotQueryHandler({})).total).toBe(5);
  });

  it("dryRun:false AND confirm:true actually deletes", async () => {
    seedCaptures(5);
    const r = parse(await screenshotGcHandler({ dryRun: false, confirm: true, maxCount: 1 }));
    expect(r.dryRun).toBe(false);
    expect(r.deleted).toBe(4);
    expect(parse(await screenshotQueryHandler({})).total).toBe(1);
  });

  it("a bare gc (no caps) falls back to env retention defaults (cache stays bounded)", async () => {
    process.env.DESKTOP_TOUCH_SCREENSHOT_MAX_COUNT = "2";
    seedCaptures(5);
    const r = parse(await screenshotGcHandler({ dryRun: false, confirm: true }));
    expect(r.deleted).toBe(3); // keep newest 2
    expect(parse(await screenshotQueryHandler({})).total).toBe(2);
  });

  it("an EXPLICIT cap does NOT also pull in the env default caps (Codex P2)", async () => {
    // env default would keep only 2, but an explicit maxAgeMs that matches nothing
    // must NOT be silently widened by the default count cap — only the explicit cap
    // applies, so all 5 recent captures survive.
    process.env.DESKTOP_TOUCH_SCREENSHOT_MAX_COUNT = "2";
    seedCaptures(5);
    const r = parse(await screenshotGcHandler({ dryRun: false, confirm: true, maxAgeMs: 365 * 24 * 3600 * 1000 }));
    expect(r.deleted).toBe(0); // nothing old enough; default maxCount:2 must NOT apply
    expect(parse(await screenshotQueryHandler({})).total).toBe(5);
  });
});

describe("screenshot_query → gc → query roundtrip (AC3 dangling)", () => {
  it("a capture deleted by gc disappears from query and its ref reads back not_found", async () => {
    seedCaptures(3);
    expect(parse(await screenshotQueryHandler({})).total).toBe(3);

    const gc = parse(await screenshotGcHandler({ dryRun: false, confirm: true, maxCount: 1 }));
    expect(gc.deleted).toBe(2);
    const deletedId = (gc.candidates as { captureId: string }[])[0].captureId;

    // gone from the listing
    const after = parse(await screenshotQueryHandler({}));
    expect(after.total).toBe(1);
    expect((after.captures as { captureId: string }[]).some((c) => c.captureId === deletedId)).toBe(false);

    // and its by-ref read is an explicit not_found, never a silent empty read.
    try {
      readCaptureBytes(deletedId);
      throw new Error("expected the deleted ref to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CaptureRefError);
      expect((e as CaptureRefError).code).toBe("not_found");
    }
  });
});
