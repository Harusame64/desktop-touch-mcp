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
 *
 * Cache-dir robustness (ADR-026 Phase 4 / OQ7): on a locked-down machine the usual
 * cache dir can be uncreatable / read-only. {@link getScreenshotCacheRoot} walks an
 * ordered write-probe ladder — explicit `DESKTOP_TOUCH_SCREENSHOTS_DIR` → per-user
 * runtime dir → OS tmpdir — and returns the first dir it can actually create+write,
 * so the by-ref token saving keeps working instead of silently degrading to inline.
 * If every candidate fails it throws {@link CacheUnwritableError}, which the image
 * emitters catch and degrade to inline pixels (R6) — a capture is never an error.
 * The chosen dir is still `realpathSync`'d and remains the anchored trust boundary;
 * the ladder changes only WHICH dir, never the per-file gauntlet — so a shared tmpdir
 * is exactly as safe as the per-user dir (the {@link CAPTURE_ID_RE} ownership gates
 * keep foreign files un-addressable / un-reclaimable).
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";

import { getRuntimeDir } from "../utils/runtime-dir.js";

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
/** Metadata sidecar extension. Each capture is `{captureId}.{imgExt}` (pixels) +
 *  `{captureId}.json` (this sidecar) — there is NO shared index file, so nothing is
 *  ever rewritten and concurrent multi-process access cannot race (ADR-026 Phase 3). */
const SIDECAR_EXT = "json";

/** Our captureId shape: base36 millis + "-" + 16 hex (see {@link newCaptureId}). Used
 *  to positively identify cache-OWNED image files / temp writes so the orphan sweep
 *  NEVER reclaims an unrelated file when the cache dir is shared (Codex P2). */
const CAPTURE_ID_RE = /^[0-9a-z]+-[0-9a-f]{16}$/;
/** Our sidecar temp-write shape: `{captureId}.json.{hex}.tmp`. */
const SIDECAR_TMP_RE = /^[0-9a-z]+-[0-9a-f]{16}\.json\.[0-9a-f]+\.tmp$/;

/** mimeType → file extension. Derived from mimeType (no hardcoded `.webp`; seed defect #5). */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpg",
};
function extForMime(mimeType: string): string {
  return MIME_EXT[mimeType] ?? "bin";
}

/**
 * Raised when NO candidate cache dir (explicit override → runtime dir → tmpdir) is
 * writable. The image emitters catch this and degrade to inline pixels (R6) — a
 * cache-write failure NEVER turns a capture into an error. The message is path-free
 * (only a count) so it can flow through `failWith` without leaking the cache path
 * into the JSON-RPC channel (ADR-026 §8 R9); the offending `candidates` paths live
 * on the field for local diagnostics only.
 */
export class CacheUnwritableError extends Error {
  constructor(public readonly candidates: string[]) {
    super(`no writable screenshot cache dir (tried ${candidates.length} candidate(s))`);
    this.name = "CacheUnwritableError";
  }
}

/**
 * True iff we can create `dir` AND create+remove a uniquely-named probe file in it.
 * The `.probe-*` name never matches {@link CAPTURE_ID_RE} and has no `.json` suffix,
 * so the sidecar fold / orphan sweep ignore it even in the (sub-ms) window before
 * the unlink — and it is created with `wx` (exclusive) so it can never clobber a
 * pre-existing file. A pure membership test: no throw escapes.
 */
function probeWritableDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${crypto.randomBytes(6).toString("hex")}`);
    fs.writeFileSync(probe, "", { flag: "wx" });
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** One-shot (deduped per primary→chosen pair) fallback notice. Goes to stderr, which
 *  is NOT the stdio JSON-RPC channel (R-P4-2), so it cannot corrupt the protocol; a
 *  busy session is not spammed. Hook point for a future tray balloon. */
const warnedCacheDirFallbacks = new Set<string>();

/** Reset the one-shot cache-dir fallback warning dedupe (tests only). */
export function _resetCacheDirWarningForTest(): void {
  warnedCacheDirFallbacks.clear();
}

function warnCacheDirFallback(primary: string, chosen: string): void {
  const key = `${primary} ${chosen}`;
  if (warnedCacheDirFallbacks.has(key)) return;
  warnedCacheDirFallbacks.add(key);
  console.warn(
    `[desktop-touch] screenshot cache dir "${primary}" is not writable; ` +
      `falling back to "${chosen}". Set DESKTOP_TOUCH_SCREENSHOTS_DIR to a writable path to silence this.`
  );
}

/**
 * Resolve the first WRITABLE cache dir from the ordered ladder (ADR-026 Phase 4 / OQ7):
 *   1. `DESKTOP_TOUCH_SCREENSHOTS_DIR` (explicit override), if set & non-empty
 *   2. `getRuntimeDir(env)/screenshots` (default; resolves MCP_HOME / %USERPROFILE%)
 *   3. `os.tmpdir()/desktop-touch-mcp/screenshots` (final fallback — almost always writable)
 *
 * No privilege elevation (a security/UX anti-pattern — tmpdir makes it unnecessary).
 * Not memoized: every caller re-probes so a dir that becomes writable mid-session is
 * picked up and the chosen dir is always currently-writable. The probe is sub-ms and
 * these calls are human-paced (persist / read / query / gc). Throws
 * {@link CacheUnwritableError} only if EVERY candidate fails (system-level breakage).
 */
/**
 * Process-lifetime memo of the chosen cache dir, keyed by the candidate-path
 * SIGNATURE (not by writability). Once a root is selected for a given env it is
 * PINNED for the process: a later writability flip — the explicit dir becomes
 * writable again, or a transient `ENOTDIR`/`EACCES` clears — must NOT relocate the
 * cache, or a `screenshot://by-ref/{id}` handed out earlier would resolve against a
 * different root and 404 (Codex P2 / Opus P2-2; captureIds do not encode their root,
 * so the root must be stable). Reset between tests via `_resetCacheRootForTest`.
 */
const cacheRootMemo = new Map<string, string>();

/** Clear the resolved-cache-dir memo (tests only). */
export function _resetCacheRootForTest(): void {
  cacheRootMemo.clear();
}

function resolveWritableCacheDir(env: NodeJS.ProcessEnv): string {
  const explicit = env["DESKTOP_TOUCH_SCREENSHOTS_DIR"];
  const candidates: string[] = [];
  if (explicit !== undefined && explicit.trim() !== "") candidates.push(path.resolve(explicit));
  candidates.push(path.join(getRuntimeDir(env), "screenshots"));
  candidates.push(path.join(os.tmpdir(), "desktop-touch-mcp", "screenshots"));

  // Pin the first successful resolution for this candidate set. `\x1f` (unit
  // separator) joins the key without putting a control-NUL into any string.
  const key = candidates.join("\x1f");
  const pinned = cacheRootMemo.get(key);
  if (pinned !== undefined) {
    // Self-heal: recreate the pinned dir if it was deleted out from under us, but do
    // NOT re-probe writability — honoring the pinned root is the whole point. If the
    // pinned dir is now unwritable the subsequent write fails → R6 degrade, which is
    // the correct outcome (we never silently move the cache mid-session).
    try {
      fs.mkdirSync(pinned, { recursive: true });
    } catch {
      /* a write against the pinned root will surface the failure as R6 */
    }
    return pinned;
  }

  const primary = candidates[0];
  const seen = new Set<string>();
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (probeWritableDir(dir)) {
      if (dir !== primary) warnCacheDirFallback(primary, dir);
      cacheRootMemo.set(key, dir);
      return dir;
    }
  }
  throw new CacheUnwritableError(candidates);
}

/**
 * Canonical, existing, WRITABLE cache root. The chosen dir (override / runtime /
 * tmpdir, first one that passes the write-probe) is canonicalized here and becomes
 * the anchored trust boundary for every subsequent read/delete.
 */
export function getScreenshotCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return fs.realpathSync(resolveWritableCacheDir(env));
}

/** Opaque, time-sortable id: base36 millis + random hex. */
function newCaptureId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
}

// ── Per-capture sidecar storage (ADR-026 Phase 3) ───────────────────────────
// There is NO shared index file. Each capture is two independent files written /
// removed atomically: the image `{captureId}.{imgExt}` and its metadata sidecar
// `{captureId}.json`. Liveness = both files exist. Because no two processes ever
// write the same file and nothing is ever rewritten in place, concurrent access
// from multiple desktop-touch processes on one PC is correct WITHOUT a lock — the
// read-modify-rewrite race that lock/tombstone designs had to guard simply cannot
// exist. The directory IS the index; `readIndex` folds the sidecars.

/** Per-capture metadata sidecar path: `{captureId}.json`. */
function sidecarPath(root: string, captureId: string): string {
  return path.join(root, `${captureId}.${SIDECAR_EXT}`);
}

/**
 * The captureId is caller-supplied on read/delete and gets joined to a path, so it
 * MUST be exactly one of OUR generated ids — {@link CAPTURE_ID_RE} (`base36-16hex`).
 * This both blocks path escape (`..`, separators, NUL) AND prevents a caller from
 * naming an unrelated `{x}.json` / `{x}.png` in a shared cache dir (e.g. a crafted
 * `settings.json` whose JSON mimics a sidecar): only our id shape is ever accepted,
 * so a foreign file can never be addressed (Codex P2). A legitimate caller always
 * passes an id it got verbatim from a screenshot response, which is this shape.
 */
function assertSafeCaptureId(captureId: string): void {
  if (!CAPTURE_ID_RE.test(captureId)) {
    throw new CaptureRefError("outside_cache", `invalid captureId: ${captureId}`);
  }
}

/**
 * Publish a capture's metadata sidecar atomically (temp→rename): a concurrent reader
 * never observes a partial sidecar, and the capture goes "live" the instant the
 * rename lands `{id}.json`. The temp name is per-capture (unique id) → no cross-capture
 * race, no shared mutable file. `wx` on the temp satisfies CodeQL insecure-temp-file.
 */
function writeSidecarAtomic(root: string, captureId: string, entry: IndexEntry): void {
  const tmp = path.join(root, `${captureId}.${SIDECAR_EXT}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, sidecarPath(root, captureId));
}

/** Read + parse one capture's sidecar; null if missing/corrupt/mismatched. The
 *  sidecar's own captureId must match (a planted `{x}.json` claiming a different id
 *  is rejected). The referenced image is validated separately by the caller. */
function readSidecar(root: string, captureId: string): IndexEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sidecarPath(root, captureId), "utf8");
  } catch {
    return null;
  }
  try {
    const e = JSON.parse(raw) as IndexEntry;
    if (e && e.captureId === captureId && typeof e.file === "string") return e;
  } catch {
    /* corrupt / partial */
  }
  return null;
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
  // Publish the metadata sidecar atomically — the image is written first (above), so
  // the capture goes live only once both files exist. No shared index → this can
  // never race a concurrent delete/persist from another process on the same PC.
  writeSidecarAtomic(root, captureId, entry);

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

/**
 * Build the current live set by folding the per-capture sidecars (the directory IS
 * the index). A capture is live iff BOTH its `{id}.json` sidecar and its image exist;
 * a sidecar whose image was deleted (or crashed away) is an orphan — skipped here and
 * reclaimed by gc, never listed. Corrupt/partial sidecars and `*.tmp` writes are
 * skipped. Stat cost is one read + one stat per live capture, bounded by auto-prune.
 */
export function readIndex(root: string): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>();
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return map; // no cache dir yet
  }
  const suffix = `.${SIDECAR_EXT}`;
  for (const name of names) {
    if (!name.endsWith(suffix)) continue; // sidecars only (skips images + `*.tmp`)
    // Ownership gate: the basename must be one of OUR generated captureIds, so a
    // shared/overridden cache dir never surfaces a foreign `*.json` as a capture or
    // feeds an invalid id into retention (Codex P2). Same gate as the orphan sweep.
    const idFromName = name.slice(0, -suffix.length);
    if (!CAPTURE_ID_RE.test(idFromName)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    let e: IndexEntry;
    try {
      e = JSON.parse(raw) as IndexEntry;
    } catch {
      continue; // partial / corrupt sidecar
    }
    if (!e || e.captureId !== idFromName || typeof e.file !== "string") continue;
    if (e.file !== path.basename(e.file)) continue; // image must be a plain basename
    // Liveness gate: the referenced image must exist (skip image-less orphan sidecars).
    try {
      if (!fs.statSync(path.join(root, e.file)).isFile()) continue;
    } catch {
      continue;
    }
    map.set(e.captureId, e);
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
  assertSafeCaptureId(captureId); // caller-supplied id → safe path component before any join
  const root = getScreenshotCacheRoot(env);
  const entry = readSidecar(root, captureId); // one sidecar read, not a whole-dir walk
  if (!entry) throw new CaptureRefError("not_found", `unknown captureId: ${captureId}`);

  // The sidecar stores a basename only; reject anything that is not a plain file name.
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
 * Securely delete one cached capture — both its image and its metadata sidecar — by
 * opaque captureId. Securely unlinks the image via {@link unlinkValidatedCapture},
 * then removes the `{id}.json` sidecar so `screenshot_query` no longer lists it
 * (Codex P2) — whether the image was unlinked here or was already gone (dangling).
 * Both are independent files (no shared index), so this is cross-process safe.
 * Returns `{deleted:false}` (sidecar still removed) for a dangling ref.
 */
export function deleteCapture(
  captureId: string,
  env: NodeJS.ProcessEnv = process.env
): { bytes: number; deleted: boolean } {
  assertSafeCaptureId(captureId);
  const root = getScreenshotCacheRoot(env);
  // Is there a sidecar that is genuinely OURS (parses with this captureId)? Only then
  // may we unlink it — never a foreign `{id}.json` a caller named by accident (Codex P2).
  const ownSidecar = readSidecar(root, captureId) !== null;
  const result = unlinkValidatedCapture(captureId, env);
  if (ownSidecar) {
    try { fs.unlinkSync(sidecarPath(root, captureId)); } catch { /* already gone */ }
  }
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

/** Image extensions the orphan sweep recognizes (mirrors MIME_EXT). Sidecars
 *  (`.json`) and partial sidecar writes (`.json.<rand>.tmp`) are NOT image exts —
 *  the sweep classifies those separately. */
const ORPHAN_IMAGE_EXTS = new Set(["png", "webp", "jpg", "bin"]);
const ORPHAN_GRACE_MS_DEFAULT = 5 * 60 * 1000;

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
  // Eviction floor (multi-LLM safety): NEVER evict a capture younger than this, so a
  // ref another process just handed its caller survives long enough to be read even
  // if a DIFFERENT desktop-touch process floods the shared cache. The retention budget
  // is per-cache-dir global, so without this floor LLM-B's persists could auto-prune a
  // ref LLM-A was just given (graceful not_found, but avoidable). Env-tunable; 0 disables.
  const minEvictAgeMs =
    parseNonNegIntEnv(env["DESKTOP_TOUCH_SCREENSHOT_MIN_EVICT_AGE_MS"]) ?? MIN_EVICT_AGE_MS_DEFAULT;

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
    if (now - e.ts < minEvictAgeMs) continue; // eviction floor — protect just-handed refs

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

  // Orphan sweep — aggregate only (P2-2). Reclaims dead-weight files: an image with
  // no live sidecar pairing (crash between image-write and sidecar-publish, or a
  // half-deleted capture, R11), a sidecar whose image is gone, and stale `*.tmp`
  // partial sidecar writes. Each carries the scanned dev/ino so the unlink verifies
  // it is still the same inode (identity gate, Codex P2-788). The grace is a FIXED
  // short window (a file written moments ago whose sibling write is imminent), NOT
  // scaled by the retention maxAgeMs — these files are unreadable dead weight.
  const orphanFiles: { file: string; bytes: number; dev: number; ino: number }[] = [];
  if (includeOrphans) {
    const liveIds = new Set(all.map((e) => e.captureId));
    const liveImages = new Set(all.map((e) => e.file));
    const orphanGraceMs = ORPHAN_GRACE_MS_DEFAULT;
    const suffix = `.${SIDECAR_EXT}`;
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      names = [];
    }
    for (const name of names) {
      // Only reclaim files we can POSITIVELY identify as cache-owned, so a shared /
      // overridden cache dir never loses unrelated files like `settings.json` (Codex P2).
      const dot = name.lastIndexOf(".");
      const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
      let isOrphan = false;
      if (ORPHAN_IMAGE_EXTS.has(ext) && CAPTURE_ID_RE.test(name.slice(0, name.length - ext.length - 1))) {
        // An image named like a captureId, with no live sidecar pairing.
        isOrphan = !liveImages.has(name);
      } else if (name.endsWith(suffix) && CAPTURE_ID_RE.test(name.slice(0, -suffix.length))) {
        // A sidecar NAMED like our captureId (ownership gate, same as the image/temp
        // branches) whose image is gone AND which still parses as our sidecar — so a
        // foreign `*.json` (even a crafted one) in a shared cache dir is left alone.
        const id = name.slice(0, -suffix.length);
        if (!liveIds.has(id) && readSidecar(root, id) !== null) isOrphan = true;
      } else if (SIDECAR_TMP_RE.test(name)) {
        isOrphan = true; // OUR stale partial sidecar write
      }
      if (!isOrphan) continue;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(root, name));
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isFile()) continue;
      if (now - st.mtimeMs < orphanGraceMs) continue; // too fresh — a sibling write may be in flight
      orphanFiles.push({ file: name, bytes: st.size, dev: st.dev, ino: st.ino });
    }
  }
  const orphanBytes = orphanFiles.reduce((s, o) => s + o.bytes, 0);

  let deleted = 0;
  let reclaimedBytes = 0;
  const removedIds = new Set<string>();

  if (!dryRun) {
    // Securely unlink the candidate IMAGE, then remove its sidecar (de-list). Both
    // are independent files — no shared index to rewrite, no append to lose.
    for (const c of candidates) {
      try {
        const r = unlinkValidatedCapture(c.captureId, env);
        if (r.deleted) { reclaimedBytes += r.bytes; deleted++; }
        removedIds.add(c.captureId);
        try { fs.unlinkSync(sidecarPath(root, c.captureId)); } catch { /* already gone */ }
      } catch {
        // a single failed delete must not abort the whole gc; leave its entry.
      }
    }
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
/** Eviction floor (multi-LLM safety, Opus P2): retention NEVER evicts a capture
 *  younger than this, so a just-handed ref survives long enough to be read even when
 *  another process is flooding the shared cache. 60 s ≫ the read-within-a-turn window. */
const MIN_EVICT_AGE_MS_DEFAULT = 60_000;

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
