/**
 * ADR-026 Phase 3 — `screenshot-cache.ts` query / gc / retention engine tests.
 *
 * Hermetic: every test runs against a throwaway `DESKTOP_TOUCH_SCREENSHOTS_DIR`
 * and disables auto-prune unless the test is specifically about it, so the index
 * reflects exactly what was seeded. Covers AC3 (secure delete — no out-of-cache
 * unlink), AC4 (query index walk + case-folded tag), R2 (auto-prune bounding),
 * R11 (orphan-file reclaim), and the P1-1 keep-newest invariant.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  persistCapture,
  readCaptureBytes,
  readIndex,
  getScreenshotCacheRoot,
  queryCaptures,
  deleteCapture,
  gcCache,
  normalizeCacheTag,
  envDefaultPolicy,
  CaptureRefError,
  _resetAutoPruneCounterForTest,
  type IndexEntry,
} from "../../src/engine/screenshot-cache.js";

/** 短いラベル → strict captureId (base36 + 16 hex)。CAPTURE_ID_RE 準拠。 */
const cid = (label: string): string => `${label}-0000000000000000`;

let cacheDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  // mkdtempSync (not path.join + random) so the cache dir is a securely-created
  // temp dir — CodeQL js/insecure-temporary-file is satisfied for writes into it.
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-qg-test-"));
  // Auto-prune OFF by default so seeded counts are deterministic.
  env = { DESKTOP_TOUCH_SCREENSHOTS_DIR: cacheDir, DESKTOP_TOUCH_SCREENSHOT_AUTOPRUNE: "0" };
  _resetAutoPruneCounterForTest();
});
afterEach(() => {
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Seed a real, deletable capture: write the image of `bytes` length + its metadata
 *  sidecar `{id}.json` with explicit ts (deterministic ordering). Returns the entry.
 *  flag:"wx" = exclusive create (CodeQL js/insecure-temporary-file, Phase 1 pattern). */
function seed(
  root: string,
  e: { captureId: string; ts: number; bytes: number; tag?: string; windowUuid?: string; processName?: string; mimeType?: string },
): IndexEntry {
  const mimeType = e.mimeType ?? "image/png";
  const ext = mimeType === "image/webp" ? "webp" : mimeType === "image/jpeg" ? "jpg" : "png";
  const file = `${e.captureId}.${ext}`;
  fs.writeFileSync(path.join(root, file), Buffer.alloc(e.bytes), { mode: 0o600, flag: "wx" });
  const entry: IndexEntry = {
    captureId: e.captureId, ts: e.ts, bytes: e.bytes, file, mimeType, width: 4, height: 4,
    ...(e.tag !== undefined ? { tag: e.tag } : {}),
    ...(e.windowUuid !== undefined ? { windowUuid: e.windowUuid } : {}),
    ...(e.processName !== undefined ? { processName: e.processName } : {}),
  };
  fs.writeFileSync(path.join(root, `${e.captureId}.json`), JSON.stringify(entry), { mode: 0o600, flag: "wx" });
  return entry;
}

/** Write a raw metadata sidecar directly (for security tests that need a controlled
 *  or hostile entry whose image may not exist). */
function writeRawSidecar(root: string, captureId: string, entry: Record<string, unknown>): void {
  fs.writeFileSync(path.join(root, `${captureId}.json`), JSON.stringify(entry), { mode: 0o600, flag: "wx" });
}

function expectRefCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected CaptureRefError(${code}) but nothing threw`);
  } catch (e) {
    expect(e).toBeInstanceOf(CaptureRefError);
    expect((e as CaptureRefError).code).toBe(code);
  }
}

const NOW = 1_000_000_000_000;

// ─────────────────────────────────────────────────────────────────────────────
describe("normalizeCacheTag (seed defect #9)", () => {
  it("folds case + trims so query/gc agree on tag identity", () => {
    expect(normalizeCacheTag("  Chrome.EXE  ")).toBe("chrome.exe");
    expect(normalizeCacheTag("roi-View5")).toBe(normalizeCacheTag("ROI-view5"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("queryCaptures (AC4 — index walk, filters, no path leak)", () => {
  it("lists newest-first with whole-cache stats and an opaque uri (no file/abs path)", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("a"), ts: NOW - 300, bytes: 10 });
    seed(root, { captureId: cid("b"), ts: NOW - 100, bytes: 20 });
    seed(root, { captureId: cid("c"), ts: NOW - 200, bytes: 30 });

    const r = queryCaptures({}, env);
    expect(r.total).toBe(3);
    expect(r.count).toBe(3);
    expect(r.captures.map((x) => x.captureId)).toEqual([cid("b"), cid("c"), cid("a")]); // newest-first
    expect(r.cache).toEqual({ totalCaptures: 3, totalBytes: 60 });

    const first = r.captures[0]!;
    expect(first.uri).toBe(`screenshot://by-ref/${first.captureId}`);
    // opaque-ref model: no `file` basename, no absolute cache path anywhere.
    expect("file" in first).toBe(false);
    expect(JSON.stringify(r).includes(cacheDir)).toBe(false);
  });

  it("tag filter is case-insensitive and still walks the full index (seed defect #8)", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("a"), ts: NOW - 1, bytes: 1, tag: "Roi-5" });
    seed(root, { captureId: cid("b"), ts: NOW - 2, bytes: 1, tag: "other" });
    const r = queryCaptures({ tag: "ROI-5" }, env);
    expect(r.captures.map((x) => x.captureId)).toEqual([cid("a")]);
  });

  it("windowUuid / since / until / limit / offset are all honored", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("old"), ts: NOW - 1000, bytes: 1, windowUuid: "w1" });
    seed(root, { captureId: cid("mid"), ts: NOW - 500, bytes: 1, windowUuid: "w1" });
    seed(root, { captureId: cid("new"), ts: NOW - 100, bytes: 1, windowUuid: "w2" });

    expect(queryCaptures({ windowUuid: "w1" }, env).captures.map((x) => x.captureId).sort())
      .toEqual([cid("mid"), cid("old")]);
    expect(queryCaptures({ since: NOW - 600, until: NOW - 200 }, env).captures.map((x) => x.captureId))
      .toEqual([cid("mid")]);
    // limit/offset over the newest-first ordering [new, mid, old]
    expect(queryCaptures({ limit: 1, offset: 1 }, env).captures.map((x) => x.captureId)).toEqual([cid("mid")]);
    expect(queryCaptures({ limit: 1 }, env).total).toBe(3); // total is pre-page
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("gcCache — retention policy union (R2)", () => {
  it("maxCount keeps the newest N and lists the rest as candidates (dryRun: no delete)", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("n1"), ts: NOW - 100, bytes: 1 });
    seed(root, { captureId: cid("n2"), ts: NOW - 200, bytes: 1 });
    seed(root, { captureId: cid("n3"), ts: NOW - 300, bytes: 1 });

    const r = gcCache({ dryRun: true, policy: { maxCount: 1 }, includeOrphans: false, now: NOW }, env);
    expect(r.candidates.map((c) => c.captureId).sort()).toEqual([cid("n2"), cid("n3")]);
    expect(r.candidates.every((c) => c.reason === "max_count")).toBe(true);
    expect(r.deleted).toBe(0); // dryRun
    expect(readIndex(root).size).toBe(3); // nothing removed
    expect(fs.existsSync(path.join(root, `${cid("n2")}.png`))).toBe(true);
  });

  it("maxAgeMs marks entries older than the window", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("fresh"), ts: NOW - 1000, bytes: 1 });
    seed(root, { captureId: cid("stale"), ts: NOW - 60_000, bytes: 1 });
    const r = gcCache({ dryRun: true, policy: { maxAgeMs: 10_000 }, includeOrphans: false, now: NOW }, env);
    expect(r.candidates.map((c) => c.captureId)).toEqual([cid("stale")]);
    expect(r.candidates[0]!.reason).toBe("max_age");
  });

  it("tag scope only ever considers the matching tag's captures", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("k1"), ts: NOW - 100, bytes: 1, tag: "keep" });
    seed(root, { captureId: cid("d1"), ts: NOW - 200, bytes: 1, tag: "DROP" });
    seed(root, { captureId: cid("d2"), ts: NOW - 300, bytes: 1, tag: "drop" });
    // age cap CAN clear the whole tag (unlike count/byte which keep the newest);
    // case-folded 'drop' scope must leave 'keep' entirely untouched.
    const r = gcCache({ dryRun: true, policy: { maxAgeMs: 0, tag: "drop" }, includeOrphans: false, now: NOW }, env);
    expect(r.candidates.map((c) => c.captureId).sort()).toEqual([cid("d1"), cid("d2")]);
  });

  it("count/byte caps keep the newest of a tag scope; age cap can clear it (keep-newest asymmetry)", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("d1"), ts: NOW - 200, bytes: 1, tag: "drop" });
    seed(root, { captureId: cid("d2"), ts: NOW - 300, bytes: 1, tag: "drop" });
    // maxCount:0 is clamped to max(1,0) → newest of the tag (d1) is kept.
    const r = gcCache({ dryRun: true, policy: { maxCount: 0, tag: "drop" }, includeOrphans: false, now: NOW }, env);
    expect(r.candidates.map((c) => c.captureId)).toEqual([cid("d2")]);
  });

  it("dryRun:false actually deletes, rewrites the index, and query no longer returns them", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("n1"), ts: NOW - 100, bytes: 5 });
    seed(root, { captureId: cid("n2"), ts: NOW - 200, bytes: 7 });
    seed(root, { captureId: cid("n3"), ts: NOW - 300, bytes: 9 });

    const r = gcCache({ dryRun: false, policy: { maxCount: 1 }, includeOrphans: false, now: NOW }, env);
    expect(r.deleted).toBe(2);
    expect(r.reclaimedBytes).toBe(16); // 7 + 9
    expect(fs.existsSync(path.join(root, `${cid("n2")}.png`))).toBe(false);
    expect(fs.existsSync(path.join(root, `${cid("n1")}.png`))).toBe(true);
    expect(queryCaptures({}, env).captures.map((x) => x.captureId)).toEqual([cid("n1")]);
    expect(r.remaining.count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("gcCache — keep-newest invariant (P1-1)", () => {
  it("byte cap NEVER deletes the newest entry, even when it alone exceeds the cap", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("solo"), ts: NOW, bytes: 100 });
    const r = gcCache({ dryRun: true, policy: { maxTotalBytes: 50 }, includeOrphans: false, now: NOW }, env);
    expect(r.candidates).toEqual([]); // rank 0 is structurally kept
  });

  it("byte cap reduces older entries while keeping rank 0 + the running cap", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("new"), ts: NOW - 100, bytes: 100 });
    seed(root, { captureId: cid("mid"), ts: NOW - 200, bytes: 100 });
    seed(root, { captureId: cid("old"), ts: NOW - 300, bytes: 100 });
    // cap 150: keep new (rank0, sum 100<=150); mid rank1 sum 200>150 → drop; old drop.
    const r = gcCache({ dryRun: true, policy: { maxTotalBytes: 150 }, includeOrphans: false, now: NOW }, env);
    expect(r.candidates.map((c) => c.captureId).sort()).toEqual([cid("mid"), cid("old")]);
    expect(r.candidates.every((c) => c.reason === "max_total_bytes")).toBe(true);
  });

  it("protectCaptureId excludes a specific id from ALL caps", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("new"), ts: NOW - 100, bytes: 100 });
    seed(root, { captureId: cid("mid"), ts: NOW - 200, bytes: 100 });
    seed(root, { captureId: cid("old"), ts: NOW - 300, bytes: 100 });
    const r = gcCache(
      { dryRun: true, policy: { maxTotalBytes: 150 }, includeOrphans: false, now: NOW, protectCaptureId: cid("old") },
      env,
    );
    expect(r.candidates.map((c) => c.captureId)).toEqual([cid("mid")]); // old protected
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("deleteCapture — secure delete (AC3)", () => {
  it("deletes a real capture and reports the reclaimed bytes", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("x"), ts: NOW, bytes: 42 });
    const r = deleteCapture(cid("x"), env);
    expect(r).toEqual({ bytes: 42, deleted: true });
    expect(fs.existsSync(path.join(root, `${cid("x")}.png`))).toBe(false);
  });

  it("removes the index entry too, so query stops listing it (Codex P2)", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("g1"), ts: NOW, bytes: 5 });
    seed(root, { captureId: cid("g2"), ts: NOW - 1, bytes: 5 });
    expect(deleteCapture(cid("g1"), env).deleted).toBe(true);
    expect(readIndex(root).has(cid("g1"))).toBe(false);
    expect(queryCaptures({}, env).captures.map((c) => c.captureId)).toEqual([cid("g2")]);
  });

  it("a dangling sidecar (image gone) is never listed, and delete removes the sidecar (R2 P2)", () => {
    const root = getScreenshotCacheRoot(env);
    writeRawSidecar(root, cid("dang"), { captureId: cid("dang"), ts: 1, bytes: 1, file: `${cid("dang")}.png`, mimeType: "image/png", width: 1, height: 1 });
    // readIndex excludes a sidecar whose image is missing — query never shows a dead ref.
    expect(readIndex(root).has(cid("dang"))).toBe(false);
    expect(fs.existsSync(path.join(root, `${cid("dang")}.json`))).toBe(true);
    expect(deleteCapture(cid("dang"), env)).toEqual({ bytes: 0, deleted: false });
    expect(fs.existsSync(path.join(root, `${cid("dang")}.json`))).toBe(false); // orphan sidecar cleaned
  });

  it("a dangling captureId (image already gone) → {deleted:false}, never throws", () => {
    const root = getScreenshotCacheRoot(env);
    writeRawSidecar(root, cid("gone"), { captureId: cid("gone"), ts: 1, bytes: 1, file: `${cid("gone")}.png`, mimeType: "image/png", width: 1, height: 1 });
    expect(deleteCapture(cid("gone"), env)).toEqual({ bytes: 0, deleted: false });
  });

  it("a sidecar whose image path escapes the cache (traversal) never unlinks the victim", () => {
    const root = getScreenshotCacheRoot(env);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-qg-outside-"));
    const victim = path.join(outsideDir, "victim.png");
    fs.writeFileSync(victim, Buffer.alloc(3), { flag: "wx" });
    const rel = path.relative(root, victim); // ..\..\<tmp>\victim.png
    writeRawSidecar(root, cid("evil"), { captureId: cid("evil"), ts: 1, bytes: 1, file: rel, mimeType: "image/png", width: 1, height: 1 });
    try {
      expect(() => deleteCapture(cid("evil"), env)).toThrow(CaptureRefError);
      expect(fs.existsSync(victim)).toBe(true); // the out-of-cache file is untouched
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("no thrown cache error message leaks the absolute cache path (R9 intent)", () => {
    getScreenshotCacheRoot(env);
    let msg = "";
    try { deleteCapture(cid("notarealid"), env); } catch (e) { msg = (e as Error).message; }
    // unknown id is {deleted:false} not a throw, so assert via a traversal sidecar:
    const root = getScreenshotCacheRoot(env);
    writeRawSidecar(root, cid("tt"), { captureId: cid("tt"), ts: 1, bytes: 1, file: "../x.png", mimeType: "image/png", width: 1, height: 1 });
    try { deleteCapture(cid("tt"), env); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toContain(cacheDir);
  });

  // POSIX-only: chmod 0o000 denies the owner read on Linux/macOS (non-root) →
  // openSync(O_RDONLY) → EACCES. Windows ignores 000 for the owner, so skip there.
  it.skipIf(process.platform === "win32")(
    "a non-ENOENT read failure (EACCES) coerces to opaque `unreadable`, no path leaked (R9)",
    () => {
      const root = getScreenshotCacheRoot(env);
      const e = seed(root, { captureId: cid("noperm"), ts: NOW, bytes: 8 });
      const file = path.join(root, e.file);
      fs.chmodSync(file, 0o000); // owner loses read → openSync(O_RDONLY) → EACCES
      let err: unknown;
      try { readCaptureBytes(cid("noperm"), env); } catch (x) { err = x; }
      try { fs.chmodSync(file, 0o600); } catch { /* restore so afterEach rm works */ }
      if (err === undefined) return; // running as root → EACCES unenforceable, skip the assertion
      expect(err).toBeInstanceOf(CaptureRefError);
      expect((err as CaptureRefError).code).toBe("unreadable");
      expect((err as Error).message).not.toContain(cacheDir);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
describe("gcCache — orphan sweep (R11)", () => {
  it("reclaims an on-disk image file with no index entry once older than the grace window", () => {
    const root = getScreenshotCacheRoot(env);
    // a true orphan IMAGE named like a real captureId, NOT paired with a sidecar.
    const orphanId = "orphan1-0000000000000064";
    const orphan = path.join(root, `${orphanId}.png`);
    fs.writeFileSync(orphan, Buffer.alloc(64), { flag: "wx" });
    const old = (NOW - 60 * 60 * 1000) / 1000; // 1h old (> 5min grace)
    fs.utimesSync(orphan, old, old);

    const r = gcCache({ dryRun: false, policy: {}, includeOrphans: true, now: NOW }, env);
    expect(r.orphans.count).toBe(1);
    expect(r.orphans.bytes).toBe(64);
    expect(fs.existsSync(orphan)).toBe(false);
    // orphans are aggregate-only — no basename in the result JSON (P2-2).
    expect(JSON.stringify(r).includes(orphanId)).toBe(false);
  });

  it("does NOT reclaim a fresh orphan (within the grace window — a sibling write may be imminent)", () => {
    const root = getScreenshotCacheRoot(env);
    const fresh = path.join(root, "fresh01-000000000000000a.png");
    fs.writeFileSync(fresh, Buffer.alloc(10), { flag: "wx" });
    fs.utimesSync(fresh, NOW / 1000, NOW / 1000); // mtime == now
    const r = gcCache({ dryRun: false, policy: {}, includeOrphans: true, now: NOW }, env);
    expect(r.orphans.count).toBe(0);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("a live capture's image + sidecar are never treated as orphans", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("real"), ts: NOW, bytes: 1 });
    const r = gcCache({ dryRun: false, policy: {}, includeOrphans: true, now: NOW }, env);
    expect(r.orphans.count).toBe(0);
    expect(fs.existsSync(path.join(root, `${cid("real")}.png`))).toBe(true);
    expect(fs.existsSync(path.join(root, `${cid("real")}.json`))).toBe(true);
  });

  it("reclaims an orphan SIDECAR whose image is gone (older than grace)", () => {
    const root = getScreenshotCacheRoot(env);
    // a captureId-named sidecar with no image (crash during a delete, or half-write).
    const id = "orphsc1-000000000000003c";
    writeRawSidecar(root, id, { captureId: id, ts: 1, bytes: 1, file: `${id}.png`, mimeType: "image/png", width: 1, height: 1 });
    const old = (NOW - 60 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(root, `${id}.json`), old, old);
    const r = gcCache({ dryRun: false, policy: {}, includeOrphans: true, now: NOW }, env);
    expect(r.orphans.count).toBe(1);
    expect(fs.existsSync(path.join(root, `${id}.json`))).toBe(false);
  });

  it("NEVER reclaims foreign files in a shared cache dir (settings.json / other.tmp / non-id image) — Codex P2", () => {
    const root = getScreenshotCacheRoot(env);
    fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ theme: "dark" }), { flag: "wx" });
    fs.writeFileSync(path.join(root, "other.tmp"), "x", { flag: "wx" });
    fs.writeFileSync(path.join(root, "photo.png"), Buffer.alloc(5), { flag: "wx" }); // not a captureId name
    const old = (NOW - 60 * 60 * 1000) / 1000;
    for (const n of ["settings.json", "other.tmp", "photo.png"]) fs.utimesSync(path.join(root, n), old, old);
    const r = gcCache({ dryRun: false, policy: {}, includeOrphans: true, now: NOW }, env);
    expect(r.orphans.count).toBe(0);
    expect(fs.existsSync(path.join(root, "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "other.tmp"))).toBe(true);
    expect(fs.existsSync(path.join(root, "photo.png"))).toBe(true);
  });

  it("deleteCapture NEVER unlinks a foreign {id}.json (Codex P2)", () => {
    const root = getScreenshotCacheRoot(env);
    fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ theme: "dark" }), { flag: "wx" });
    expect(deleteCapture(cid("settings"), env)).toEqual({ bytes: 0, deleted: false });
    expect(fs.existsSync(path.join(root, "settings.json"))).toBe(true);
  });

  it("orphan grace is FIXED, not raised by maxAgeMs (Codex P2)", () => {
    // A multi-day capture-retention policy must NOT keep unreadable orphan residue
    // on disk for days — the orphan grace is only the short append-race window.
    const root = getScreenshotCacheRoot(env);
    const orphan = path.join(root, "orphan2-0000000000000020.png");
    fs.writeFileSync(orphan, Buffer.alloc(32), { flag: "wx" });
    const old = (NOW - 60 * 60 * 1000) / 1000; // 1h old: > 5min grace, << maxAgeMs(7d)
    fs.utimesSync(orphan, old, old);
    const r = gcCache(
      { dryRun: false, policy: { maxAgeMs: 7 * 24 * 3600 * 1000 }, includeOrphans: true, now: NOW },
      env,
    );
    expect(r.orphans.count).toBe(1); // reclaimed despite the 7-day retention policy
    expect(fs.existsSync(orphan)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("per-capture sidecar storage (lock-free cross-process correctness)", () => {
  it("a delete removes BOTH the image and its sidecar (no shared index to rewrite)", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("t1"), ts: NOW, bytes: 5 });
    expect(fs.existsSync(path.join(root, `${cid("t1")}.png`))).toBe(true);
    expect(fs.existsSync(path.join(root, `${cid("t1")}.json`))).toBe(true);
    deleteCapture(cid("t1"), env);
    expect(fs.existsSync(path.join(root, `${cid("t1")}.png`))).toBe(false);
    expect(fs.existsSync(path.join(root, `${cid("t1")}.json`))).toBe(false);
    expect(readIndex(root).has(cid("t1"))).toBe(false);
  });

  it("a delete and a concurrent persist touch disjoint files — neither can lose the other", () => {
    // The race lock/tombstone designs had to guard does not exist: there is no shared
    // mutable file. Deleting 'drop' only unlinks drop.{png,json}; persisting writes a
    // brand-new {id}.{png,json} pair — they cannot interfere even across processes.
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: cid("drop"), ts: NOW, bytes: 5 });
    deleteCapture(cid("drop"), env);
    const fresh = persistCapture(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), { mimeType: "image/png", width: 4, height: 4 }, env);
    const idx = readIndex(root);
    expect(idx.has(cid("drop"))).toBe(false);
    expect(idx.has(fresh.captureId)).toBe(true); // a fresh ref is never collateral to a delete
  });

  it("the sidecar is published atomically — readIndex never sees a partial write (no .tmp listed)", () => {
    const root = getScreenshotCacheRoot(env);
    const r = persistCapture(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), { mimeType: "image/png", width: 4, height: 4 }, env);
    // the live capture is listed; no leftover temp file remains in the dir.
    expect(readIndex(root).has(r.captureId)).toBe(true);
    expect(fs.readdirSync(root).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("an invalid captureId (path traversal) is rejected before any fs join", () => {
    getScreenshotCacheRoot(env);
    expectRefCode(() => deleteCapture("../evil", env), "outside_cache");
    expectRefCode(() => readCaptureBytes("a/b", env), "outside_cache");
  });
});

describe("envDefaultPolicy + auto-prune (R2 / §3.6)", () => {
  it("defaults: count + bytes caps active, age cap opt-in (absent)", () => {
    expect(envDefaultPolicy({})).toEqual({ maxCount: 200, maxTotalBytes: 256 * 1024 * 1024 });
    const p = envDefaultPolicy({ DESKTOP_TOUCH_SCREENSHOT_MAX_AGE_MS: "5000", DESKTOP_TOUCH_SCREENSHOT_MAX_COUNT: "3" });
    expect(p).toEqual({ maxCount: 3, maxTotalBytes: 256 * 1024 * 1024, maxAgeMs: 5000 });
  });

  it("persistCapture auto-prune fires on the first persist of the process and bounds the cache", () => {
    const pruneEnv: NodeJS.ProcessEnv = {
      DESKTOP_TOUCH_SCREENSHOTS_DIR: cacheDir,
      DESKTOP_TOUCH_SCREENSHOT_MAX_COUNT: "2",
      // auto-prune ENABLED (no AUTOPRUNE=0)
    };
    const root = getScreenshotCacheRoot(pruneEnv);
    // pre-seed 5 older captures (prior-session cruft).
    for (let i = 0; i < 5; i++) seed(root, { captureId: cid(`seed${i}`), ts: NOW - 10_000 - i, bytes: 1 });
    _resetAutoPruneCounterForTest();

    const fresh = persistCapture(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), { mimeType: "image/png", width: 2, height: 2 }, pruneEnv);
    // first persist (counter 0) → auto-prune with maxCount:2 → keep newest 2.
    expect(readIndex(root).size).toBe(2);
    // the just-written ref MUST survive (keep-newest / protectCaptureId).
    expect(() => readCaptureBytes(fresh.captureId, pruneEnv)).not.toThrow();
  });

  it("DESKTOP_TOUCH_SCREENSHOT_AUTOPRUNE=0 disables auto-prune", () => {
    const root = getScreenshotCacheRoot(env); // env has AUTOPRUNE=0
    for (let i = 0; i < 5; i++) seed(root, { captureId: cid(`s${i}`), ts: NOW - i, bytes: 1 });
    _resetAutoPruneCounterForTest();
    persistCapture(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), { mimeType: "image/png", width: 1, height: 1 }, { ...env, DESKTOP_TOUCH_SCREENSHOT_MAX_COUNT: "2" });
    expect(readIndex(root).size).toBe(6); // 5 seeded + 1, nothing pruned
  });
});
