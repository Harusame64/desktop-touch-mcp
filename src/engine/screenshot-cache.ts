/**
 * Screenshot disk-cache + reference model (ADR-026).
 *
 * Capture bytes are persisted under the per-user runtime dir so MCP responses can
 * return a cheap `resource_link` (`screenshot://by-ref/{captureId}`) instead of an
 * inline base64 image. The opaque captureId indirects through an append-only index,
 * so callers never supply a filesystem path — shrinking the path-traversal surface.
 *
 * Security (ADR-026 §4): reads/deletes resolve a captureId to a file *inside the
 * canonical cache root only*, with symlink rejection performed BEFORE realpath, a
 * separator-aware containment check (`path.relative`, not `startsWith`), and a
 * dev/ino identity gate on the opened handle that defeats a lstat→open TOCTOU swap.
 * Bytes are read from the validated descriptor itself (never re-opened by path).
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import { getRuntimeDir, ensureDir } from "../utils/runtime-dir.js";

export interface CaptureMeta {
  mimeType: string;
  width: number;
  height: number;
  windowUuid?: string;
  processName?: string;
  tag?: string;
}

export interface PersistedCapture {
  captureId: string;
  /** `screenshot://by-ref/{captureId}` — an opaque id, never a caller path. */
  uri: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
}

export interface IndexEntry extends CaptureMeta {
  captureId: string;
  ts: number;
  bytes: number;
  /** Basename inside the cache root (never a path). */
  file: string;
}

export const REF_URI_PREFIX = "screenshot://by-ref/";
const INDEX_FILE = "_index.ndjson";

/** mimeType → file extension. Derived from mimeType (no hardcoded `.webp`; seed defect #5). */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpg",
};
function extForMime(mimeType: string): string {
  return MIME_EXT[mimeType] ?? "bin";
}

/** Raw (pre-canonical) cache dir. `DESKTOP_TOUCH_SCREENSHOTS_DIR` redefines the boundary. */
function rawCacheDir(env: NodeJS.ProcessEnv): string {
  const override = env["DESKTOP_TOUCH_SCREENSHOTS_DIR"];
  if (override !== undefined && override.trim() !== "") return path.resolve(override);
  return path.join(getRuntimeDir(env), "screenshots");
}

/**
 * Canonical, existing cache root. The override (if any) is canonicalized here and
 * becomes the anchored trust boundary for every subsequent read/delete.
 */
export function getScreenshotCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return fs.realpathSync(ensureDir(rawCacheDir(env)));
}

/** Opaque, time-sortable id: base36 millis + random hex. */
function newCaptureId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
}

function indexPath(root: string): string {
  return path.join(root, INDEX_FILE);
}

// ── Index mutation lock (ADR-026 Phase 3, Codex P1) ──────────────────────────
// The index is mutated by three paths — persistCapture (append), deleteCapture
// (remove one), gcCache (batch remove). A bare read-modify-rename rewrite loses a
// concurrent append from ANOTHER desktop-touch process sharing the same cache dir
// (the appended line isn't in the rewrite's snapshot and the rename drops it,
// orphaning a just-returned ref past the protectCaptureId invariant). An exclusive
// lockfile serializes ALL index mutations cross-process so every rewrite reads a
// stable index and no append is lost. Single-process (the common case) takes the
// lock with zero contention — one create+unlink syscall pair, no sleep.
//
// KNOWN RESIDUAL (Codex R3 P2, accepted — ADR-026 OQ8): an mtime-based lockfile
// cannot distinguish a crashed holder from one merely slow inside `fn`, so the
// stale-steal could in theory unlink a still-live holder's lock after LOCK_STALE_MS
// and let a concurrent mutation race the holder's rename. This is a non-issue here:
// every locked `fn` is a SYNCHRONOUS sub-millisecond op (one append, or a
// readIndex+write+rename over a count-bounded index), so reaching the 10 s window
// implies a frozen/dead process whose lock SHOULD be stolen; and any resulting loss
// is self-healing (the orphaned file is reclaimed by a later orphan sweep, never a
// wrong-file delete). Closing it fully would need OS advisory locks or an async
// heartbeat (impossible mid-sync-fn) — disproportionate for a local single-user
// cache. Deferred as a documented limitation, not a Phase-3 blocker.
const INDEX_LOCK_FILE = "_index.lock";
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 20;
// Give-up is LONGER than the stale window on purpose (Codex R3 P2): a legitimately
// held lock is always resolved first — either the holder releases (waiter acquires)
// or, if the holder crashed, the lock goes stale at LOCK_STALE_MS and the waiter
// steals it. So the unlocked-proceed backstop below is unreachable while a real
// holder exists; it only fires if stealing itself keeps failing (pathological),
// never as a premature give-up that would reintroduce the append-loss race.
const LOCK_MAX_WAIT_MS = 15_000;

/** Synchronous sleep (consistent with this module's sync-fs design). Only reached
 *  on cross-process lock contention — never in the single-process common path. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding an exclusive index lock (an `_index.lock` file created
 * with the `wx` flag). A stale lock (holder crashed) is stolen after
 * {@link LOCK_STALE_MS}. The unlocked-proceed backstop at {@link LOCK_MAX_WAIT_MS}
 * is deliberately LONGER than the stale window, so a legitimately held lock is
 * always resolved first (release → acquire, or stale → steal) — the backstop only
 * fires if stealing itself keeps failing, never as a premature give-up that would
 * let a concurrent append slip past the rewrite (Codex R3 P2). **NOT reentrant**:
 * call sites must not nest withIndexLock (they don't — persistCapture releases
 * before maybeAutoPrune; gcCache unlinks lock-free then takes one lock for the rewrite).
 */
function withIndexLock<T>(root: string, fn: () => T): T {
  const lockPath = path.join(root, INDEX_LOCK_FILE);
  const start = Date.now();
  let fd: number | null = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") break; // unlockable → best-effort
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { fs.unlinkSync(lockPath); } catch { /* raced another stealer */ }
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat → retry immediately
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) break; // give up → proceed best-effort
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

/** Persist capture bytes + append an index entry; returns the ref descriptor. */
export function persistCapture(
  data: Buffer,
  meta: CaptureMeta,
  env: NodeJS.ProcessEnv = process.env
): PersistedCapture {
  const root = getScreenshotCacheRoot(env);
  const captureId = newCaptureId();
  const file = `${captureId}.${extForMime(meta.mimeType)}`;
  // Exclusive create ("wx"): fail rather than follow a pre-planted symlink/file at
  // this path. The captureId carries 8 random bytes so a real collision is
  // astronomically unlikely; the flag is pure defense-in-depth on the write side.
  fs.writeFileSync(path.join(root, file), data, { mode: 0o600, flag: "wx" });

  const entry: IndexEntry = {
    captureId,
    ts: Date.now(),
    bytes: data.length,
    file,
    mimeType: meta.mimeType,
    width: meta.width,
    height: meta.height,
    ...(meta.windowUuid !== undefined ? { windowUuid: meta.windowUuid } : {}),
    ...(meta.processName !== undefined ? { processName: meta.processName } : {}),
    ...(meta.tag !== undefined ? { tag: meta.tag } : {}),
  };
  // Under the index lock so this atomic append cannot interleave with a gcCache /
  // deleteCapture rewrite that re-reads then renames (which would otherwise drop
  // this line). Released before maybeAutoPrune so the prune can take its own lock.
  withIndexLock(root, () => fs.appendFileSync(indexPath(root), JSON.stringify(entry) + "\n"));

  // Bound cache growth (R2) without the agent ever calling screenshot_gc. Throttled
  // + best-effort + protects this very captureId — a prune failure must NEVER fail a
  // capture, and auto-prune must never delete the ref this call is about to return
  // (ADR-026 Phase 3 §3.4, keep-newest invariant).
  try {
    maybeAutoPrune(captureId, env);
  } catch {
    /* never fail a capture because a background prune errored */
  }

  return {
    captureId,
    uri: REF_URI_PREFIX + captureId,
    mimeType: meta.mimeType,
    width: meta.width,
    height: meta.height,
    bytes: data.length,
  };
}

/** Parse the append-only index (latest line per captureId wins). Corrupt lines are skipped (R5). */
export function readIndex(root: string): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();
  let raw: string;
  try {
    raw = fs.readFileSync(indexPath(root), "utf8");
  } catch {
    return map; // no index yet
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as IndexEntry;
      if (e && typeof e.captureId === "string" && typeof e.file === "string") map.set(e.captureId, e);
    } catch {
      // skip corrupt line
    }
  }
  return map;
}

/**
 * Separator-aware containment: is `real` a strict descendant of `root`?
 *
 * Uses `path.relative` — NOT `real.startsWith(root)`, which would let a sibling
 * like `…/screenshots_evil/x` slip through the `…/screenshots` prefix (ADR-026
 * §4 / seed Codex-P1 cache-escape). Exported so the invariant is regression-
 * pinned directly: a revert to `startsWith` must fail a test, not silently pass.
 */
export function isWithinRoot(root: string, real: string): boolean {
  const rel = path.relative(root, real);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(".." + path.sep) &&
    !path.isAbsolute(rel)
  );
}

export type CaptureRefCode =
  | "not_found"
  | "outside_cache"
  | "symlink"
  | "identity_mismatch"
  | "not_regular_file"
  // Any non-ENOENT filesystem error (EACCES/EPERM/EBUSY/…) coerced to an opaque
  // ref error so the raw fs message — which can contain the absolute cache path
  // — never reaches the resource handler (ADR-026 §8 R9, Phase 3 hardening).
  | "unreadable";

export class CaptureRefError extends Error {
  constructor(public readonly code: CaptureRefCode, message: string) {
    super(message);
    this.name = "CaptureRefError";
  }
}

/**
 * Open a captureId's file with full validation and return the live descriptor.
 * Caller MUST close `fd`. Throws {@link CaptureRefError} on any failure; never
 * yields a handle to a file outside the canonical cache root.
 */
/**
 * Coerce a filesystem error into an opaque {@link CaptureRefError}.
 *
 * - ENOENT → `not_found`: a capture file can vanish (GC'd / deleted, R7) between
 *   index lookup and the actual syscall, so a dangling ref surfaces a documented
 *   `not_found` rather than a raw ENOENT.
 * - any other fs error with a `.code` (EACCES/EPERM/EBUSY/…) → `unreadable`:
 *   coerced WITHOUT echoing `e.message`, which can carry the absolute cache path,
 *   so the resource handler never leaks it (ADR-026 §8 R9, Phase 3 hardening).
 * - a non-fs error (no `.code`, e.g. a programming bug) is rethrown as-is.
 */
function asRefError(e: unknown, captureId: string): never {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") {
    throw new CaptureRefError("not_found", `capture file missing: ${captureId}`);
  }
  if (typeof code === "string") {
    throw new CaptureRefError("unreadable", `capture unreadable (${code}): ${captureId}`);
  }
  throw e;
}

function openValidatedCapture(
  captureId: string,
  env: NodeJS.ProcessEnv
): { fd: number; real: string; entry: IndexEntry } {
  const root = getScreenshotCacheRoot(env);
  const entry = readIndex(root).get(captureId);
  if (!entry) throw new CaptureRefError("not_found", `unknown captureId: ${captureId}`);

  // The index stores a basename only; reject anything that is not a plain file name.
  const file = entry.file;
  if (file !== path.basename(file) || file.includes("..") || path.isAbsolute(file)) {
    throw new CaptureRefError("outside_cache", `index file name is not a basename: ${file}`);
  }
  const candidate = path.join(root, file);

  // 1) Symlink rejection BEFORE realpath (order is load-bearing — realpath would follow
  //    the link and validate the *target*). lstat is no-follow; pin dev+ino as identity.
  //    A missing file here is a dangling ref (R7) → not_found, not a raw ENOENT.
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(candidate);
  } catch (e) {
    asRefError(e, captureId);
  }
  if (lst.isSymbolicLink()) throw new CaptureRefError("symlink", `symlink rejected: ${file}`);
  if (!lst.isFile()) throw new CaptureRefError("not_regular_file", `not a regular file: ${file}`);
  const pinnedDev = lst.dev;
  const pinnedIno = lst.ino;

  // 2) Canonicalize + separator-aware containment (NOT `startsWith`, which lets a
  //    sibling like `screenshots_evil` slip through the `screenshots` prefix).
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch (e) {
    asRefError(e, captureId);
  }
  if (!isWithinRoot(root, real)) {
    throw new CaptureRefError("outside_cache", `resolved path escapes cache: ${real}`);
  }

  // 3) No-follow open (POSIX) + dev/ino identity gate. If the regular file we lstat'd
  //    was swapped for a symlink between lstat and open, the opened handle's identity
  //    will not match the pinned dev/ino — reject. Bytes are read from THIS fd, so no
  //    by-path re-open reintroduces a window.
  //    Caveat: on a filesystem that reports dev/ino as 0 (some non-NTFS Windows
  //    volumes) this gate degrades to a no-op; the cache lives under %USERPROFILE%
  //    (NTFS) where dev/ino are meaningful, and step 1's symlink rejection +
  //    step 2's containment still hold regardless.
  const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | noFollow);
  } catch (e) {
    asRefError(e, captureId);
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.dev !== pinnedDev || st.ino !== pinnedIno) {
      throw new CaptureRefError("identity_mismatch", `file identity changed under ${file}`);
    }
    if (!st.isFile()) throw new CaptureRefError("not_regular_file", `opened handle is not a regular file: ${file}`);
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  return { fd, real, entry };
}

/**
 * Securely resolve a captureId to a validated absolute path inside the cache.
 *
 * WARNING: this returns a *path*, not a live handle. A caller that re-opens it
 * by path (e.g. a Phase-3 `screenshot_gc` `unlink`) reintroduces the very
 * lstat→open TOCTOU window the dev/ino identity gate closes. Such a caller must
 * either delete via the fd from {@link openValidatedCapture} or re-run the full
 * validation immediately before the mutation (ADR-026 §4 delete note).
 */
export function resolveCaptureFile(captureId: string, env: NodeJS.ProcessEnv = process.env): string {
  const { fd, real } = openValidatedCapture(captureId, env);
  fs.closeSync(fd);
  return real;
}

/** Read validated capture bytes for a captureId, straight from the gated descriptor. */
export function readCaptureBytes(
  captureId: string,
  env: NodeJS.ProcessEnv = process.env
): { data: Buffer; entry: IndexEntry } {
  const { fd, entry } = openValidatedCapture(captureId, env);
  try {
    return { data: fs.readFileSync(fd), entry };
  } finally {
    fs.closeSync(fd);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADR-026 Phase 3 — query / gc / index walk / retention (GC policy)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Case/space-fold a `tag` so `screenshot_query` and `screenshot_gc` filters agree
 * on what "the same tag" means regardless of the casing it was stored with (seed
 * defect #9). The index keeps values verbatim (for display); this is applied ONLY
 * at compare time — the single source of truth for tag equality across both tools.
 */
export function normalizeCacheTag(tag: string): string {
  return tag.trim().toLowerCase();
}

export interface QueryFilter {
  tag?: string;
  windowUuid?: string;
  /** epoch ms, inclusive lower bound. */
  since?: number;
  /** epoch ms, inclusive upper bound. */
  until?: number;
  /** clamped to [1, 500], default 50. */
  limit?: number;
  /** clamped to >= 0, default 0. */
  offset?: number;
}

/**
 * A pixels-free listing row. Carries ONLY the opaque captureId + its ref uri and
 * metadata — never the on-disk `file` basename or an absolute path, so navigating
 * the cache cannot widen the path-traversal surface (opaque-ref model, R9).
 */
export interface QuerySummaryEntry {
  captureId: string;
  uri: string;
  ts: number;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  tag?: string;
  windowUuid?: string;
  processName?: string;
}

export interface QueryResult {
  /** matching count BEFORE limit/offset. */
  total: number;
  /** returned count. */
  count: number;
  /** newest-first. */
  captures: QuerySummaryEntry[];
  /** whole-cache stats so a caller can decide whether to gc (no path leaked). */
  cache: { totalCaptures: number; totalBytes: number };
}

/**
 * Read-only listing of cached captures (ADR-026 §5 / AC4). Always walks the full
 * index — a `tag` filter does NOT bypass the walk (seed defect #8). Returns
 * pixels-free metadata only; resolve a `uri` (resources/read) to get the bytes.
 */
export function queryCaptures(
  filter: QueryFilter = {},
  env: NodeJS.ProcessEnv = process.env
): QueryResult {
  const root = getScreenshotCacheRoot(env);
  const all = [...readIndex(root).values()];
  const totalCaptures = all.length;
  const totalBytes = all.reduce((s, e) => s + (e.bytes || 0), 0);

  const nTag = filter.tag !== undefined ? normalizeCacheTag(filter.tag) : undefined;
  const matched = all
    .filter((e) => {
      if (nTag !== undefined && normalizeCacheTag(e.tag ?? "") !== nTag) return false;
      if (filter.windowUuid !== undefined && e.windowUuid !== filter.windowUuid) return false;
      if (filter.since !== undefined && e.ts < filter.since) return false;
      if (filter.until !== undefined && e.ts > filter.until) return false;
      return true;
    })
    .sort((a, b) => b.ts - a.ts);

  const total = matched.length;
  const offset = Math.max(0, Math.floor(filter.offset ?? 0));
  const limit = Math.min(500, Math.max(1, Math.floor(filter.limit ?? 50)));
  const page = matched.slice(offset, offset + limit);

  return {
    total,
    count: page.length,
    captures: page.map((e) => ({
      captureId: e.captureId,
      uri: REF_URI_PREFIX + e.captureId,
      ts: e.ts,
      mimeType: e.mimeType,
      width: e.width,
      height: e.height,
      bytes: e.bytes,
      ...(e.tag !== undefined ? { tag: e.tag } : {}),
      ...(e.windowUuid !== undefined ? { windowUuid: e.windowUuid } : {}),
      ...(e.processName !== undefined ? { processName: e.processName } : {}),
    })),
    cache: { totalCaptures, totalBytes },
  };
}

/**
 * Validate that `file` (a basename, never a path) names a contained, non-symlink
 * regular file inside `root`, and return its canonical absolute path + the lstat
 * of THAT canonical path (the unlink target's own identity, not the pre-realpath
 * leaf). Shared by index-backed delete and the orphan sweep so the containment /
 * symlink rules are byte-identical on every delete path (ADR-026 §4). Mirrors
 * {@link openValidatedCapture}'s ordering: basename assert → lstat-before-realpath
 * symlink reject → realpath → exported {@link isWithinRoot} (never `startsWith`).
 * A missing file surfaces as ENOENT for the caller to treat as already-gone.
 */
function validateCacheFileForDelete(root: string, file: string): { real: string; st: fs.Stats } {
  if (file !== path.basename(file) || file.includes("..") || path.isAbsolute(file)) {
    throw new CaptureRefError("outside_cache", `index file name is not a basename: ${file}`);
  }
  const candidate = path.join(root, file);
  const lst = fs.lstatSync(candidate); // ENOENT bubbles up → caller treats as already-gone
  if (lst.isSymbolicLink()) throw new CaptureRefError("symlink", `symlink rejected: ${file}`);
  if (!lst.isFile()) throw new CaptureRefError("not_regular_file", `not a regular file: ${file}`);
  const real = fs.realpathSync(candidate);
  if (!isWithinRoot(root, real)) {
    throw new CaptureRefError("outside_cache", `resolved path escapes cache: ${file}`);
  }
  // Re-lstat the RESOLVED target and return ITS identity, not the pre-realpath
  // leaf's: a candidate→symlink swap between the lstat above and realpath would
  // make `real` resolve to a *different* in-cache file. The caller compares THIS
  // identity to its pinned dev/ino, so a mismatch (resolved elsewhere) is caught;
  // `real` is what gets unlinked, so identity and unlink target now agree (Codex).
  const st = fs.lstatSync(real);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new CaptureRefError("not_regular_file", `resolved target is not a regular file: ${file}`);
  }
  return { real, st };
}

/**
 * Securely unlink one cached capture's FILE by opaque captureId (does NOT touch
 * the index — see {@link deleteCapture} / {@link gcCache} for the index update).
 *
 * Runs the full {@link openValidatedCapture} gauntlet to pin the file's dev/ino
 * identity, releases the handle, then — immediately before unlink — re-validates
 * (re-lstat symlink reject + re-containment + identity re-check) to minimize the
 * realpath→unlink TOCTOU window Windows cannot close via fd. Never unlinks
 * anything outside the canonical cache root. Returns `{deleted:false}` when the
 * file is already gone (dangling ref). Kept index-free so a batch GC can rewrite
 * the index once instead of once per file.
 */
function unlinkValidatedCapture(
  captureId: string,
  env: NodeJS.ProcessEnv = process.env
): { bytes: number; deleted: boolean } {
  const root = getScreenshotCacheRoot(env);

  // 1) Read-grade validation → pin dev/ino, then release the handle.
  let entry: IndexEntry;
  let pinnedDev: number;
  let pinnedIno: number;
  try {
    const opened = openValidatedCapture(captureId, env);
    try {
      const st = fs.fstatSync(opened.fd);
      pinnedDev = st.dev;
      pinnedIno = st.ino;
    } finally {
      fs.closeSync(opened.fd);
    }
    entry = opened.entry;
  } catch (e) {
    if (e instanceof CaptureRefError && e.code === "not_found") return { bytes: 0, deleted: false };
    throw e;
  }

  // 2) Re-validate the basename immediately before unlink (symlink/containment).
  let real: string;
  let st: fs.Stats;
  try {
    ({ real, st } = validateCacheFileForDelete(root, entry.file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { bytes: 0, deleted: false };
    throw e;
  }

  // 3) Identity must still match the pinned regular file (defeats a lstat→unlink swap).
  if (st.dev !== pinnedDev || st.ino !== pinnedIno) {
    throw new CaptureRefError("identity_mismatch", `file identity changed before unlink: ${captureId}`);
  }

  const bytes = st.size;
  try {
    fs.unlinkSync(real);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { bytes: 0, deleted: false };
    // Non-ENOENT (EPERM/EBUSY/EACCES): coerce to an opaque ref error so the raw fs
    // message — which contains the absolute `real` cache path — never leaks (R9).
    asRefError(e, captureId);
  }
  return { bytes, deleted: true };
}

/**
 * Securely delete one cached capture — both its FILE and its index entry — by
 * opaque captureId. Unlinks via {@link unlinkValidatedCapture}, then drops the
 * index entry under the index lock so `screenshot_query` no longer lists a ref
 * that reads `not_found` (Codex P2) — whether the file was unlinked here or was
 * already gone. Returns `{deleted:false}` (with the index entry still cleaned)
 * for a dangling ref.
 */
export function deleteCapture(
  captureId: string,
  env: NodeJS.ProcessEnv = process.env
): { bytes: number; deleted: boolean } {
  const root = getScreenshotCacheRoot(env);
  const result = unlinkValidatedCapture(captureId, env);
  removeIndexEntries(root, new Set([captureId]), env);
  return result;
}

export interface GcPolicy {
  /** delete entries older than this (ms). */
  maxAgeMs?: number;
  /** keep the newest N, delete the rest. */
  maxCount?: number;
  /** keep the newest captures under this byte cap. */
  maxTotalBytes?: number;
  /** scope deletion to this tag only (normalized compare). */
  tag?: string;
}

export interface GcCandidate {
  /** index-backed only — same id `screenshot_query` surfaces, so exposing it leaks nothing. */
  captureId: string;
  bytes: number;
  ageMs: number;
  reason: "max_age" | "max_count" | "max_total_bytes";
}

export interface GcResult {
  dryRun: boolean;
  policy: { maxAgeMs: number | null; maxCount: number | null; maxTotalBytes: number | null; tag: string | null };
  /** index-backed candidates (captureId). */
  candidates: GcCandidate[];
  /** orphan on-disk files (no index entry) — aggregate ONLY; basenames are
   *  `{captureId}.ext`, i.e. ids `screenshot_query` deliberately hides, so they
   *  are never returned individually (ADR-026 Phase 3 P2-2). */
  orphans: { count: number; bytes: number };
  deleted: number;
  reclaimedBytes: number;
  remaining: { count: number; bytes: number };
}

/** Image extensions the orphan sweep considers (mirrors MIME_EXT). The index
 *  rewrite temp file (`_index.ndjson.<rand>.tmp`) is NOT an image ext, so it is
 *  never mistaken for an orphan (P3-3). */
const ORPHAN_IMAGE_EXTS = new Set(["png", "webp", "jpg", "bin"]);
const ORPHAN_GRACE_MS_DEFAULT = 5 * 60 * 1000;

/** Atomically replace the index with `entries` (temp→rename). Temp name is
 *  `_index.ndjson.<rand>.tmp` — excluded from the orphan sweep's ext filter. */
function writeIndexAtomic(root: string, entries: IndexEntry[]): void {
  const tmp = path.join(root, `${INDEX_FILE}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  // Exclusive create ("wx"): refuse to follow a pre-planted file/symlink at the
  // temp path (CodeQL js/insecure-temporary-file). The 6 random bytes make a real
  // collision astronomically unlikely; mirrors persistCapture's write-side flag.
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, indexPath(root));
}

/**
 * Drop the given captureIds from the index, under the index lock so the fresh
 * read + rewrite cannot lose a concurrent cross-process append (Codex P1). A
 * no-op when none of the ids are currently present (avoids a pointless rewrite).
 */
function removeIndexEntries(root: string, ids: Set<string>, _env: NodeJS.ProcessEnv): void {
  if (ids.size === 0) return;
  withIndexLock(root, () => {
    const all = [...readIndex(root).values()];
    if (!all.some((e) => ids.has(e.captureId))) return;
    try {
      writeIndexAtomic(root, all.filter((e) => !ids.has(e.captureId)));
    } catch {
      // Best-effort (plan §3.3): a failed rewrite leaves stale entries → read
      // surfaces not_found (AC3) and the next gc self-heals. Never propagate —
      // deleteCapture must not throw after a successful unlink, and gcCache must
      // still return its reclaimed-bytes summary.
    }
  });
}

/**
 * Reclaim cached captures by retention policy (ADR-026 §5 / R2 / R11).
 *
 * Caps are a **union** — an entry is a candidate if it violates ANY active cap.
 * The newest entry (rank 0) is structurally kept by the byte cap, and
 * `protectCaptureId` (auto-prune passes the just-written id) excludes a specific
 * id from ALL caps — together guaranteeing a fresh `persistCapture` ref is never
 * pruned out from under its caller (keep-newest invariant).
 *
 * `includeOrphans` also reclaims on-disk image files that have no index entry
 * (crash residue, or the Phase-2c fold-path orphan, R11) once older than a grace
 * window. Orphans are reported as an aggregate count/bytes only — never by
 * basename (which would leak ids `screenshot_query` hides, P2-2).
 *
 * `dryRun:true` computes candidates without deleting or rewriting the index.
 */
export function gcCache(
  opts: { dryRun: boolean; policy: GcPolicy; includeOrphans: boolean; now: number; protectCaptureId?: string },
  env: NodeJS.ProcessEnv = process.env
): GcResult {
  const { dryRun, policy, includeOrphans, now, protectCaptureId } = opts;
  const root = getScreenshotCacheRoot(env);
  const indexMap = readIndex(root);
  const all = [...indexMap.values()];

  const maxAgeMs = policy.maxAgeMs ?? null;
  const maxCount = policy.maxCount ?? null;
  const maxBytes = policy.maxTotalBytes ?? null;
  const nTag = policy.tag !== undefined ? normalizeCacheTag(policy.tag) : undefined;

  // universe = tag subset (if scoped) else everything, newest → oldest.
  const universe = all
    .filter((e) => (nTag === undefined ? true : normalizeCacheTag(e.tag ?? "") === nTag))
    .sort((a, b) => b.ts - a.ts);

  const candidates: GcCandidate[] = [];
  let running = 0;
  for (let i = 0; i < universe.length; i++) {
    const e = universe[i];
    running += e.bytes || 0; // count the byte even when protected — it occupies space
    if (protectCaptureId !== undefined && e.captureId === protectCaptureId) continue;

    let reason: GcCandidate["reason"] | null = null;
    if (maxAgeMs !== null && now - e.ts > maxAgeMs) {
      reason = "max_age"; // age cap can hit any rank (explicit "clear stale cache")
    } else if (maxCount !== null && i >= Math.max(1, maxCount)) {
      reason = "max_count"; // keep newest max(1,maxCount) → rank 0 survives
    } else if (maxBytes !== null && i >= 1 && running > maxBytes) {
      reason = "max_total_bytes"; // rank 0 always kept; cap reduces older entries
    }
    if (reason) {
      candidates.push({ captureId: e.captureId, bytes: e.bytes || 0, ageMs: now - e.ts, reason });
    }
  }

  // Orphan sweep — aggregate only (P2-2). Carries the scanned dev/ino so the
  // unlink can verify it is still the same inode (identity gate, Codex P2-788).
  const orphanFiles: { file: string; bytes: number; dev: number; ino: number }[] = [];
  if (includeOrphans) {
    const referenced = new Set(all.map((e) => e.file));
    const orphanGraceMs = Math.max(maxAgeMs ?? 0, ORPHAN_GRACE_MS_DEFAULT);
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (name === INDEX_FILE) continue;
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
      if (!ORPHAN_IMAGE_EXTS.has(ext)) continue; // skips _index.ndjson.<rand>.tmp + non-image
      if (referenced.has(name)) continue; // has an index entry → handled above
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(root, name));
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isFile()) continue;
      if (now - st.mtimeMs < orphanGraceMs) continue; // too fresh — index-append may be imminent
      orphanFiles.push({ file: name, bytes: st.size, dev: st.dev, ino: st.ino });
    }
  }
  const orphanBytes = orphanFiles.reduce((s, o) => s + o.bytes, 0);

  let deleted = 0;
  let reclaimedBytes = 0;
  const removedIds = new Set<string>();

  if (!dryRun) {
    // Unlink the FILES first (lock-free), collecting the ids to drop from the
    // index, then rewrite the index ONCE under the lock (removeIndexEntries) — so
    // the O(N) candidate deletes cost a single locked rewrite, not N.
    for (const c of candidates) {
      try {
        const r = unlinkValidatedCapture(c.captureId, env);
        if (r.deleted) { reclaimedBytes += r.bytes; deleted++; }
        // whether unlinked now or already gone, drop the (dead) index entry.
        removedIds.add(c.captureId);
      } catch {
        // a single failed delete must not abort the whole gc; leave its entry.
      }
    }
    // Remove the deleted entries from the index under the lock — the fresh read
    // happens INSIDE the lock, and persist appends also hold the lock, so no
    // concurrent cross-process append can be lost by the rewrite (Codex P1).
    removeIndexEntries(root, removedIds, env);
    for (const o of orphanFiles) {
      try {
        const { real, st } = validateCacheFileForDelete(root, o.file);
        // Identity gate (mirrors the index-backed delete): the orphan basename could
        // have been swapped for a symlink to another in-cache capture between the
        // sweep's lstat and now — validateCacheFileForDelete would then resolve
        // `real` to that OTHER (index-tracked) file. Require the resolved target to
        // be the SAME inode the sweep saw before unlinking it (Codex P2-788).
        if (st.dev !== o.dev || st.ino !== o.ino) continue;
        fs.unlinkSync(real);
        deleted++;
        reclaimedBytes += o.bytes;
      } catch {
        // skip — already gone / validation failed
      }
    }
  } else {
    for (const c of candidates) removedIds.add(c.captureId);
    reclaimedBytes = candidates.reduce((s, c) => s + c.bytes, 0) + orphanBytes;
  }

  const survivors = all.filter((e) => !removedIds.has(e.captureId));
  return {
    dryRun,
    policy: { maxAgeMs, maxCount, maxTotalBytes: maxBytes, tag: nTag ?? null },
    candidates,
    orphans: { count: orphanFiles.length, bytes: orphanBytes },
    deleted,
    reclaimedBytes,
    remaining: {
      count: survivors.length,
      bytes: survivors.reduce((s, e) => s + (e.bytes || 0), 0),
    },
  };
}

// ── Retention defaults + auto-prune (ADR-026 §3.4 / §3.6, R2) ────────────────

const MAX_COUNT_DEFAULT = 200;
const MAX_BYTES_DEFAULT = 256 * 1024 * 1024;
const AUTO_PRUNE_EVERY = 32;

/** Parse a non-negative integer env value; undefined/blank/invalid → undefined. */
function parseNonNegIntEnv(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * Retention caps from env (pure parser; ADR-026 §3.6 / OQ2). Count + bytes caps
 * are active by default so the cache stays bounded regardless of time; the age
 * cap is opt-in (env only) to avoid silently expiring recent captures.
 */
export function envDefaultPolicy(env: NodeJS.ProcessEnv = process.env): GcPolicy {
  const maxCount = parseNonNegIntEnv(env["DESKTOP_TOUCH_SCREENSHOT_MAX_COUNT"]) ?? MAX_COUNT_DEFAULT;
  const maxTotalBytes = parseNonNegIntEnv(env["DESKTOP_TOUCH_SCREENSHOT_MAX_BYTES"]) ?? MAX_BYTES_DEFAULT;
  const maxAgeMs = parseNonNegIntEnv(env["DESKTOP_TOUCH_SCREENSHOT_MAX_AGE_MS"]);
  return {
    maxCount,
    maxTotalBytes,
    ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
  };
}

function autoPruneEnabled(env: NodeJS.ProcessEnv): boolean {
  return env["DESKTOP_TOUCH_SCREENSHOT_AUTOPRUNE"] !== "0";
}

let persistsSincePrune = 0;

/** Reset the auto-prune throttle counter (tests only). */
export function _resetAutoPruneCounterForTest(): void {
  persistsSincePrune = 0;
}

/**
 * Best-effort, throttled cache prune invoked from {@link persistCapture}. Bounds
 * cache growth (R2) without the agent ever calling `screenshot_gc`. Fires on the
 * first persist of each process (0-origin counter) so short-lived sessions still
 * sweep prior-session cruft, then every `AUTO_PRUNE_EVERY` persists. Index-based
 * only (orphan sweep is the explicit gc's job) and protects the just-written
 * captureId so it can never delete the ref the caller is about to return.
 */
function maybeAutoPrune(justWrittenId: string, env: NodeJS.ProcessEnv): void {
  if (!autoPruneEnabled(env)) return;
  const due = persistsSincePrune % AUTO_PRUNE_EVERY === 0;
  persistsSincePrune++;
  if (!due) return;
  gcCache(
    {
      dryRun: false,
      policy: envDefaultPolicy(env),
      includeOrphans: false,
      now: Date.now(),
      protectCaptureId: justWrittenId,
    },
    env
  );
}
