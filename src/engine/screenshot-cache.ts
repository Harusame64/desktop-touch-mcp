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

/** Persist capture bytes + append an index entry; returns the ref descriptor. */
export function persistCapture(
  data: Buffer,
  meta: CaptureMeta,
  env: NodeJS.ProcessEnv = process.env
): PersistedCapture {
  const root = getScreenshotCacheRoot(env);
  const captureId = newCaptureId();
  const file = `${captureId}.${extForMime(meta.mimeType)}`;
  fs.writeFileSync(path.join(root, file), data, { mode: 0o600 });

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
  fs.appendFileSync(indexPath(root), JSON.stringify(entry) + "\n");

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

export type CaptureRefCode =
  | "not_found"
  | "outside_cache"
  | "symlink"
  | "identity_mismatch"
  | "not_regular_file";

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
  const lst = fs.lstatSync(candidate);
  if (lst.isSymbolicLink()) throw new CaptureRefError("symlink", `symlink rejected: ${file}`);
  if (!lst.isFile()) throw new CaptureRefError("not_regular_file", `not a regular file: ${file}`);
  const pinnedDev = lst.dev;
  const pinnedIno = lst.ino;

  // 2) Canonicalize + separator-aware containment (NOT `startsWith`, which lets a
  //    sibling like `screenshots_evil` slip through the `screenshots` prefix).
  const real = fs.realpathSync(candidate);
  const rel = path.relative(root, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CaptureRefError("outside_cache", `resolved path escapes cache: ${real}`);
  }

  // 3) No-follow open (POSIX) + dev/ino identity gate. If the regular file we lstat'd
  //    was swapped for a symlink between lstat and open, the opened handle's identity
  //    will not match the pinned dev/ino — reject. Bytes are read from THIS fd, so no
  //    by-path re-open reintroduces a window.
  const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const fd = fs.openSync(real, fs.constants.O_RDONLY | noFollow);
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

/** Securely resolve a captureId to a validated absolute path inside the cache. */
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
