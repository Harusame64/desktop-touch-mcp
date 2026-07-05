// ADR-014 v2 R3 Key Locker — L1: the binding store (Node-side canonical-key → opaqueId mapping).
//
// Plan: desktop-touch-mcp-internal@6b0a085:docs/adr-014-v2-r3-l1-binding-plan.md (§5)
//
// Why Node-side, not in the locker: L0 froze the pipe protocol; adding bind/resolve/list verbs
// would amend it. This mapping holds NO SECRET (URIs, public fingerprints, opaque ids), so it
// needs no DPAPI and lives as plain JSON co-located with the locker's store dir. The locker keeps
// treating `k` as an opaque string; `opaqueId` here IS that `k`. (A same-user process editing this
// file is parent §8 out of scope — it could read the DPAPI store directly, same-user.)
//
// Authority split (§5.3): the LOCKER is authoritative for "does a secret exist"; the MAP is
// authoritative for "which canonical key points at which opaqueId". `resolve` therefore verifies
// via the locker's `exists()` and prunes stale rows; it never deletes locker entries (the reverse
// orphan is L3's discard-path obligation, not L1's).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Mirrors the locker's default store dir (Program.cs: %LOCALAPPDATA%\desktop-touch-mcp\locker). */
function defaultStoreDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "desktop-touch-mcp", "locker");
}

export type BindingScheme = "ssh" | "sudo" | "https-cred" | "sshkey";

/** One `bindings.json` row (no secret — URIs, public fingerprints, opaque ids, timestamps). */
export interface BindingMeta {
  scheme: BindingScheme;
  /** Human-facing URI (no fp-set) for management/logs. */
  displayUri: string;
  host?: string;
  user?: string;
  port?: number;
  /** sudo only. */
  targetUser?: string;
  /** ssh only (redundant with the canonical key; kept for display/audit). */
  fpSet?: string[];
  /** ISO-8601, stamped by the caller. */
  createdAt: string;
  /**
   * Per-binding injection policy (L4 §1 `set_policy`): when true, the locker asks the user to confirm
   * EVERY autofill for this binding (a per-binding opt-in — never a global no-confirm). Absent/false =
   * the default confirm-every behaviour. The L1 plan §5.1 RESERVED this as "an L3 field, not set in L1";
   * it is additive-optional, so it does not break the frozen L1 row shape.
   */
  confirmEveryInjection?: boolean;
}

export interface BindingRecord extends BindingMeta {
  /** The locker store key (`k` on the pipe) — Node-generated `randomBytes(16).toString("hex")`. */
  opaqueId: string;
}

export interface BindingSummary extends BindingRecord {
  canonicalKey: string;
}

interface BindingsFile {
  version: 1;
  bindings: Record<string, BindingRecord>;
}

/**
 * Thrown by `resolve`/`reconcile` on a MANAGEMENT-ONLY store (loaded without `existsInLocker`):
 * those verbs must verify against the live locker and cannot run without it. bind/unbind/list
 * work either way.
 */
export class LockerNotBoundError extends Error {
  readonly code = "LockerNotBound";
  constructor(verb: string) {
    super(`BindingStore.${verb} requires an existsInLocker check (store was loaded management-only)`);
    this.name = "LockerNotBoundError";
  }
}

const FILE_NAME = "bindings.json";

/**
 * The canonical-key → opaqueId map with atomic persistence and locker reconciliation.
 * Create with `BindingStore.load()`; every mutation saves atomically (tmp write + rename,
 * mirroring the locker's own Save()).
 */
export class BindingStore {
  private constructor(
    private readonly filePath: string,
    private readonly data: BindingsFile,
    private readonly existsInLocker?: (opaqueId: string) => Promise<boolean>,
  ) {}

  /**
   * Load (or start) the store under `storeDir` (default: the locker's own store dir, so tests
   * override both with the same `storeDir` the KeyLockerHost accepts). Tolerant of a corrupt /
   * missing / wrong-shape file: starts empty, preserving the corrupt original as `.corrupt`.
   * `existsInLocker` = the locker's async existence check (key-locker-host.ts `exists()`);
   * omit it for a management-only store (resolve/reconcile then throw `LockerNotBoundError`).
   */
  static load(storeDir?: string, existsInLocker?: (opaqueId: string) => Promise<boolean>): BindingStore {
    const dir = storeDir ?? defaultStoreDir();
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, FILE_NAME);
    let data: BindingsFile = { version: 1, bindings: {} };
    if (existsSync(filePath)) {
      try {
        const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
        // Row-level validation, not just the top-level shape: a null row or a record without a
        // string opaqueId would otherwise surface later as a resolve() throw instead of the
        // promised tolerant-load (Codex R4). Any malformed row ⇒ the whole file is corrupt
        // (preserved + start empty — bindings are re-creatable metadata, fail-safe).
        if (
          typeof raw === "object" && raw !== null &&
          (raw as BindingsFile).version === 1 &&
          typeof (raw as BindingsFile).bindings === "object" && (raw as BindingsFile).bindings !== null &&
          Object.values((raw as BindingsFile).bindings).every(
            (row) => typeof row === "object" && row !== null && typeof row.opaqueId === "string",
          )
        ) {
          data = { version: 1, bindings: { ...(raw as BindingsFile).bindings } };
        } else {
          preserveCorrupt(filePath);
        }
      } catch {
        preserveCorrupt(filePath);
      }
    }
    return new BindingStore(filePath, data, existsInLocker);
  }

  /**
   * The lookup-by-command hot path: map lookup, then VERIFY the secret still exists in the locker
   * (a map row proves only "canonical → opaqueId", not "the secret survives"); a stale row is
   * pruned and reported as no binding. One cheap local pipe round-trip per autofill offer.
   */
  async resolve(canonicalKey: string): Promise<{ opaqueId: string } | undefined> {
    if (this.existsInLocker === undefined) throw new LockerNotBoundError("resolve");
    const row = this.data.bindings[canonicalKey];
    if (row === undefined) return undefined;
    if (!(await this.existsInLocker(row.opaqueId))) {
      delete this.data.bindings[canonicalKey];
      this.save();
      return undefined;
    }
    return { opaqueId: row.opaqueId };
  }

  /**
   * Create/update a binding. `opaqueId` is caller-supplied (L3's capture-then-commit generates it
   * at capture time and hands it here on exit 0); `meta.createdAt` is stamped by the caller.
   */
  bind(canonicalKey: string, opaqueId: string, meta: BindingMeta): void {
    this.data.bindings[canonicalKey] = { opaqueId, ...meta };
    this.save();
  }

  /** Delete a binding row. Returns whether an entry was removed. Never touches the locker. */
  unbind(canonicalKey: string): boolean {
    if (!(canonicalKey in this.data.bindings)) return false;
    delete this.data.bindings[canonicalKey];
    this.save();
    return true;
  }

  /**
   * Set the per-binding `confirmEveryInjection` policy (L4 §1 `set_policy`). Returns whether a row was
   * updated (false = no such binding). Additive metadata only — never touches the locker secret. A
   * per-binding opt-in; there is no global no-confirm switch.
   */
  setPolicy(canonicalKey: string, confirmEveryInjection: boolean): boolean {
    const row = this.data.bindings[canonicalKey];
    if (row === undefined) return false;
    row.confirmEveryInjection = confirmEveryInjection;
    this.save();
    return true;
  }

  /** Enumerate all rows (management / L4). */
  list(): BindingSummary[] {
    return Object.entries(this.data.bindings).map(([canonicalKey, row]) => ({ canonicalKey, ...row }));
  }

  /**
   * Bulk prune: drop every map row whose locker entry no longer exists (locker `store.json`
   * deleted out of band, secrets removed via `delete`, …). Returns the pruned count. Used at
   * session start / from management. Never deletes locker entries (that direction is L3's).
   */
  async reconcile(): Promise<number> {
    if (this.existsInLocker === undefined) throw new LockerNotBoundError("reconcile");
    let pruned = 0;
    for (const [key, row] of Object.entries(this.data.bindings)) {
      if (!(await this.existsInLocker(row.opaqueId))) {
        delete this.data.bindings[key];
        pruned++;
      }
    }
    if (pruned > 0) this.save();
    return pruned;
  }

  /** Atomic persistence: write `<file>.tmp`, then rename over the real file (mirrors L0 Save()). */
  private save(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.filePath); // libuv rename uses MOVEFILE_REPLACE_EXISTING on Windows
  }
}

/** Keep forensic evidence of an unparseable file instead of silently overwriting it. */
function preserveCorrupt(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.corrupt`);
  } catch { /* best-effort */ }
}
