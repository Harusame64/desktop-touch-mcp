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

/** Seed a real, deletable capture: write a file of `bytes` length + append the
 *  raw index entry with explicit ts (deterministic ordering). Returns the entry. */
function seed(
  root: string,
  e: { captureId: string; ts: number; bytes: number; tag?: string; windowUuid?: string; processName?: string; mimeType?: string },
): IndexEntry {
  const mimeType = e.mimeType ?? "image/png";
  const ext = mimeType === "image/webp" ? "webp" : mimeType === "image/jpeg" ? "jpg" : "png";
  const file = `${e.captureId}.${ext}`;
  // flag:"wx" = exclusive create — refuse to follow a pre-planted file/symlink
  // in the shared temp dir (CodeQL js/insecure-temporary-file, Phase 1 pattern).
  fs.writeFileSync(path.join(root, file), Buffer.alloc(e.bytes), { mode: 0o600, flag: "wx" });
  const entry: IndexEntry = {
    captureId: e.captureId, ts: e.ts, bytes: e.bytes, file, mimeType, width: 4, height: 4,
    ...(e.tag !== undefined ? { tag: e.tag } : {}),
    ...(e.windowUuid !== undefined ? { windowUuid: e.windowUuid } : {}),
    ...(e.processName !== undefined ? { processName: e.processName } : {}),
  };
  fs.appendFileSync(path.join(root, "_index.ndjson"), JSON.stringify(entry) + "\n");
  return entry;
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
    seed(root, { captureId: "a", ts: NOW - 300, bytes: 10 });
    seed(root, { captureId: "b", ts: NOW - 100, bytes: 20 });
    seed(root, { captureId: "c", ts: NOW - 200, bytes: 30 });

    const r = queryCaptures({}, env);
    expect(r.total).toBe(3);
    expect(r.count).toBe(3);
    expect(r.captures.map((x) => x.captureId)).toEqual(["b", "c", "a"]); // newest-first
    expect(r.cache).toEqual({ totalCaptures: 3, totalBytes: 60 });

    const first = r.captures[0]!;
    expect(first.uri).toBe(`screenshot://by-ref/${first.captureId}`);
    // opaque-ref model: no `file` basename, no absolute cache path anywhere.
    expect("file" in first).toBe(false);
    expect(JSON.stringify(r).includes(cacheDir)).toBe(false);
  });

  it("tag filter is case-insensitive and still walks the full index (seed defect #8)", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: "a", ts: NOW - 1, bytes: 1, tag: "Roi-5" });
    seed(root, { captureId: "b", ts: NOW - 2, bytes: 1, tag: "other" });
    const r = queryCaptures({ tag: "ROI-5" }, env);
    expect(r.captures.map((x) => x.captureId)).toEqual(["a"]);
  });

  it("windowUuid / since / until / limit / offset are all honored", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: "old", ts: NOW - 1000, bytes: 1, windowUuid: "w1" });
    seed(root, { captureId: "mid", ts: NOW - 500, bytes: 1, windowUuid: "w1" });
    seed(root, { captureId: "new", ts: NOW - 100, bytes: 1, windowUuid: "w2" });

    expect(queryCaptures({ windowUuid: "w1" }, env).captures.map((x) => x.captureId).sort())
      .toEqual(["mid", "old"]);
    expect(queryCaptures({ since: NOW - 600, until: NOW - 200 }, env).captures.map((x) => x.captureId))
      .toEqual(["mid"]);
    // limit/offset over the newest-first ordering [new, mid, old]
    expect(queryCaptures({ limit: 1, offset: 1 }, env).captures.map((x) => x.captureId)).toEqual(["mid"]);
    expect(queryCaptures({ limit: 1 }, env).total).toBe(3); // total is pre-page
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("gcCache — retention policy union (R2)", () => {
  it("maxCount keeps the newest N and lists the rest as candidates (dryRun: no delete)", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: "n1", ts: NOW - 100, bytes: 1 });
    seed(root, { captureId: "n2", ts: NOW - 200, bytes: 1 });
    seed(root, { captureId: "n3", ts: NOW - 300, bytes: 1 });

    const r = gcCache({ dryRun: true, policy: { maxCount: 1 }, includeOrphans: false, now: NOW }, env);
    expect(r.candidates.map((c) => c.captureId).sort()).toEqual(["n2", "n3"]);
    expect(r.candidates.every((c) => c.reason === "max_count")).toBe(true);
    expect(r.deleted).toBe(0); // dryRun
    expect(readIndex(root).size).toBe(3); // nothing removed
    expect(fs.existsSync(path.join(root, "n2.png"))).toBe(true);
  });

  it("maxAgeMs marks entries older than the window", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: "fresh", ts: NOW - 1000, bytes: 1 });
    seed(root, { captureId: "stale", ts: NOW - 60_000, bytes: 1 });
    const r = gcCache({ dryRun: true, policy: { maxAgeMs: 10_000 }, includeOrphans: false, now: NOW }, env);
    expect(r.candidates.map((c) => c.captureId)).toEqual(["stale"]);
    expect(r.candidates[0]!.reason).toBe("max_age");
  });

  it("tag scope only ever considers the matching tag's captures", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: "k1", ts: NOW - 100, bytes: 1, tag: "keep" });
    seed(root, { captureId: "d1", ts: NOW - 200, bytes: 1, tag: "DROP" });
    seed(root, { captureId: "d2", ts: NOW - 300, bytes: 1, tag: "drop" });
    // age cap CAN clear the whole tag (unlike count/byte which keep the newest);
    // case-folded 'drop' scope must leave 'keep' entirely untouched.
    const r = gcCache({ dryRun: true, policy: { maxAgeMs: 0, tag: "drop" }, includeOrphans: false, now: NOW }, env);
    expect(r.candidates.map((c) => c.captureId).sort()).toEqual(["d1", "d2"]);
  });

  it("count/byte caps keep the newest of a tag scope; age cap can clear it (keep-newest asymmetry)", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: "d1", ts: NOW - 200, bytes: 1, tag: "drop" });
    seed(root, { captureId: "d2", ts: NOW - 300, bytes: 1, tag: "drop" });
    // maxCount:0 is clamped to max(1,0) → newest of the tag (d1) is kept.
    const r = gcCache({ dryRun: true, policy: { maxCount: 0, tag: "drop" }, includeOrphans: false, now: NOW }, env);
    expect(r.candidates.map((c) => c.captureId)).toEqual(["d2"]);
  });

  it("dryRun:false actually deletes, rewrites the index, and query no longer returns them", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: "n1", ts: NOW - 100, bytes: 5 });
    seed(root, { captureId: "n2", ts: NOW - 200, bytes: 7 });
    seed(root, { captureId: "n3", ts: NOW - 300, bytes: 9 });

    const r = gcCache({ dryRun: false, policy: { maxCount: 1 }, includeOrphans: false, now: NOW }, env);
    expect(r.deleted).toBe(2);
    expect(r.reclaimedBytes).toBe(16); // 7 + 9
    expect(fs.existsSync(path.join(root, "n2.png"))).toBe(false);
    expect(fs.existsSync(path.join(root, "n1.png"))).toBe(true);
    expect(queryCaptures({}, env).captures.map((x) => x.captureId)).toEqual(["n1"]);
    expect(r.remaining.count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("gcCache — keep-newest invariant (P1-1)", () => {
  it("byte cap NEVER deletes the newest entry, even when it alone exceeds the cap", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: "solo", ts: NOW, bytes: 100 });
    const r = gcCache({ dryRun: true, policy: { maxTotalBytes: 50 }, includeOrphans: false, now: NOW }, env);
    expect(r.candidates).toEqual([]); // rank 0 is structurally kept
  });

  it("byte cap reduces older entries while keeping rank 0 + the running cap", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: "new", ts: NOW - 100, bytes: 100 });
    seed(root, { captureId: "mid", ts: NOW - 200, bytes: 100 });
    seed(root, { captureId: "old", ts: NOW - 300, bytes: 100 });
    // cap 150: keep new (rank0, sum 100<=150); mid rank1 sum 200>150 → drop; old drop.
    const r = gcCache({ dryRun: true, policy: { maxTotalBytes: 150 }, includeOrphans: false, now: NOW }, env);
    expect(r.candidates.map((c) => c.captureId).sort()).toEqual(["mid", "old"]);
    expect(r.candidates.every((c) => c.reason === "max_total_bytes")).toBe(true);
  });

  it("protectCaptureId excludes a specific id from ALL caps", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: "new", ts: NOW - 100, bytes: 100 });
    seed(root, { captureId: "mid", ts: NOW - 200, bytes: 100 });
    seed(root, { captureId: "old", ts: NOW - 300, bytes: 100 });
    const r = gcCache(
      { dryRun: true, policy: { maxTotalBytes: 150 }, includeOrphans: false, now: NOW, protectCaptureId: "old" },
      env,
    );
    expect(r.candidates.map((c) => c.captureId)).toEqual(["mid"]); // old protected
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("deleteCapture — secure delete (AC3)", () => {
  it("deletes a real capture and reports the reclaimed bytes", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: "x", ts: NOW, bytes: 42 });
    const r = deleteCapture("x", env);
    expect(r).toEqual({ bytes: 42, deleted: true });
    expect(fs.existsSync(path.join(root, "x.png"))).toBe(false);
  });

  it("removes the index entry too, so query stops listing it (Codex P2)", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: "g1", ts: NOW, bytes: 5 });
    seed(root, { captureId: "g2", ts: NOW - 1, bytes: 5 });
    expect(deleteCapture("g1", env).deleted).toBe(true);
    expect(readIndex(root).has("g1")).toBe(false);
    expect(queryCaptures({}, env).captures.map((c) => c.captureId)).toEqual(["g2"]);
  });

  it("cleans a dangling index entry (file already gone) so query stops listing it", () => {
    const root = getScreenshotCacheRoot(env);
    fs.appendFileSync(
      path.join(root, "_index.ndjson"),
      JSON.stringify({ captureId: "dang", ts: 1, bytes: 1, file: "dang.png", mimeType: "image/png", width: 1, height: 1 }) + "\n",
    );
    expect(readIndex(root).has("dang")).toBe(true);
    expect(deleteCapture("dang", env)).toEqual({ bytes: 0, deleted: false });
    expect(readIndex(root).has("dang")).toBe(false); // stale entry cleaned (R2 P2)
  });

  it("a dangling captureId (file already gone) → {deleted:false}, never throws", () => {
    const root = getScreenshotCacheRoot(env);
    fs.appendFileSync(
      path.join(root, "_index.ndjson"),
      JSON.stringify({ captureId: "gone", ts: 1, bytes: 1, file: "gone.png", mimeType: "image/png", width: 1, height: 1 }) + "\n",
    );
    expect(deleteCapture("gone", env)).toEqual({ bytes: 0, deleted: false });
  });

  it("an index entry pointing outside the cache (traversal) is never unlinked", () => {
    const root = getScreenshotCacheRoot(env);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-qg-outside-"));
    const victim = path.join(outsideDir, "victim.png");
    fs.writeFileSync(victim, Buffer.alloc(3), { flag: "wx" });
    const rel = path.relative(root, victim); // ..\..\<tmp>\victim.png
    fs.appendFileSync(
      path.join(root, "_index.ndjson"),
      JSON.stringify({ captureId: "evil", ts: 1, bytes: 1, file: rel, mimeType: "image/png", width: 1, height: 1 }) + "\n",
    );
    try {
      expect(() => deleteCapture("evil", env)).toThrow(CaptureRefError);
      expect(fs.existsSync(victim)).toBe(true); // the out-of-cache file is untouched
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("no thrown cache error message leaks the absolute cache path (R9 intent)", () => {
    getScreenshotCacheRoot(env);
    let msg = "";
    try { deleteCapture("not-a-real-id", env); } catch (e) { msg = (e as Error).message; }
    // unknown id is {deleted:false} not a throw, so assert via a traversal entry:
    const root = getScreenshotCacheRoot(env);
    fs.appendFileSync(
      path.join(root, "_index.ndjson"),
      JSON.stringify({ captureId: "t", ts: 1, bytes: 1, file: "../x.png", mimeType: "image/png", width: 1, height: 1 }) + "\n",
    );
    try { deleteCapture("t", env); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toContain(cacheDir);
  });

  // POSIX-only: chmod 0o000 denies the owner read on Linux/macOS (non-root) →
  // openSync(O_RDONLY) → EACCES. Windows ignores 000 for the owner, so skip there.
  it.skipIf(process.platform === "win32")(
    "a non-ENOENT read failure (EACCES) coerces to opaque `unreadable`, no path leaked (R9)",
    () => {
      const root = getScreenshotCacheRoot(env);
      const e = seed(root, { captureId: "noperm", ts: NOW, bytes: 8 });
      const file = path.join(root, e.file);
      fs.chmodSync(file, 0o000); // owner loses read → openSync(O_RDONLY) → EACCES
      let err: unknown;
      try { readCaptureBytes("noperm", env); } catch (x) { err = x; }
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
    // a true orphan: file on disk, NOT in the index (crash residue / fold orphan).
    const orphan = path.join(root, "orphan123.png");
    fs.writeFileSync(orphan, Buffer.alloc(64), { flag: "wx" });
    const old = (NOW - 60 * 60 * 1000) / 1000; // 1h old (> 5min grace)
    fs.utimesSync(orphan, old, old);

    const r = gcCache({ dryRun: false, policy: {}, includeOrphans: true, now: NOW }, env);
    expect(r.orphans.count).toBe(1);
    expect(r.orphans.bytes).toBe(64);
    expect(fs.existsSync(orphan)).toBe(false);
    // orphans are aggregate-only — no basename in the result JSON (P2-2).
    expect(JSON.stringify(r).includes("orphan123")).toBe(false);
  });

  it("does NOT reclaim a fresh orphan (within the grace window — index-append may be imminent)", () => {
    const root = getScreenshotCacheRoot(env);
    const fresh = path.join(root, "fresh999.png");
    fs.writeFileSync(fresh, Buffer.alloc(10), { flag: "wx" });
    fs.utimesSync(fresh, NOW / 1000, NOW / 1000); // mtime == now
    const r = gcCache({ dryRun: false, policy: {}, includeOrphans: true, now: NOW }, env);
    expect(r.orphans.count).toBe(0);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("ignores the index file and never treats it as an orphan", () => {
    const root = getScreenshotCacheRoot(env);
    seed(root, { captureId: "real", ts: NOW, bytes: 1 });
    const r = gcCache({ dryRun: false, policy: {}, includeOrphans: true, now: NOW }, env);
    expect(r.orphans.count).toBe(0);
    expect(fs.existsSync(path.join(root, "_index.ndjson"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("index lock — stale steal (Codex P1/P2)", () => {
  it("steals a stale lock past the stale window instead of waiting/hanging", () => {
    const root = getScreenshotCacheRoot(env);
    // Plant a stale lock file (mtime well past the 10s stale window).
    const lockPath = path.join(root, "_index.lock");
    fs.writeFileSync(lockPath, "", { flag: "wx" });
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockPath, old, old);
    // A persist takes the index lock for its append — it must steal the stale lock
    // and complete promptly (not spin on the wedged-lock path), and the entry must
    // be indexed (the append ran under the stolen lock).
    const r = persistCapture(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), { mimeType: "image/png", width: 4, height: 4 }, env);
    expect(readIndex(root).has(r.captureId)).toBe(true);
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
    for (let i = 0; i < 5; i++) seed(root, { captureId: `seed${i}`, ts: NOW - 10_000 - i, bytes: 1 });
    _resetAutoPruneCounterForTest();

    const fresh = persistCapture(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), { mimeType: "image/png", width: 2, height: 2 }, pruneEnv);
    // first persist (counter 0) → auto-prune with maxCount:2 → keep newest 2.
    expect(readIndex(root).size).toBe(2);
    // the just-written ref MUST survive (keep-newest / protectCaptureId).
    expect(() => readCaptureBytes(fresh.captureId, pruneEnv)).not.toThrow();
  });

  it("DESKTOP_TOUCH_SCREENSHOT_AUTOPRUNE=0 disables auto-prune", () => {
    const root = getScreenshotCacheRoot(env); // env has AUTOPRUNE=0
    for (let i = 0; i < 5; i++) seed(root, { captureId: `s${i}`, ts: NOW - i, bytes: 1 });
    _resetAutoPruneCounterForTest();
    persistCapture(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), { mimeType: "image/png", width: 1, height: 1 }, { ...env, DESKTOP_TOUCH_SCREENSHOT_MAX_COUNT: "2" });
    expect(readIndex(root).size).toBe(6); // 5 seeded + 1, nothing pruned
  });
});
