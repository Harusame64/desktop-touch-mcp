// ADR-014 v2 R3 Key Locker — L3 §1: the negative-binding ("[Never]") store.
//
// Plan: desktop-touch-mcp-internal:docs/adr-014-v2-r3-l3-3-manager-watch-plan.md (PR 2) +
//   adr-014-v2-r3-l3-capture-plan.md §1 (`policyStore.setNever`).
//
// When the user answers [Never] to a post-landing "save this credential?" offer, the capture-loop must
// not re-offer to save that binding again. This tombstone is a NEGATIVE-binding record — DISTINCT from
// the saved-row `confirmEveryInjection` policy (which only exists on rows that WERE saved). It holds NO
// secret (canonical keys only = URIs + public fingerprints), so like `BindingStore` it is plain JSON
// co-located with the locker store dir (a same-user process editing it is parent §8 out of scope — it
// could read the DPAPI store directly, same-user).
//
// SCOPE: the loop's NO-MATCH branch consults `has()` BEFORE the capture dialog and declines a tombstoned
// binding; the `onNever` seam calls `add()`. A resolved MATCH bypasses the store entirely (a manually
// re-saved binding still autofills — the tombstone only suppresses the capture-and-save OFFER, never a
// stored secret). Clearing a tombstone (e.g. when the user later manually `save`s the same binding) is a
// future L4-management nicety — not needed for correctness, since MATCH already bypasses this store.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Mirrors the locker's default store dir (Program.cs: %LOCALAPPDATA%\desktop-touch-mcp\locker). */
function defaultStoreDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "desktop-touch-mcp", "locker");
}

const FILE_NAME = "never.json";

interface NeverFile {
  version: 1;
  /** Canonical keys the user chose [Never] for. Sorted on write (determinism). */
  entries: string[];
}

/**
 * The set of canonical keys the user tombstoned via [Never], with atomic persistence. Create with
 * `NeverStore.load()`; `add` saves atomically (tmp write + rename, mirroring `BindingStore.save()`).
 * In-memory `Set` backs an O(1) `has`.
 */
export class NeverStore {
  private constructor(
    private readonly filePath: string,
    private readonly entries: Set<string>,
  ) {}

  /**
   * Load (or start) the store under `storeDir` (default: the locker's own store dir, so tests override
   * with the same `storeDir` the locker accepts). Tolerant of a corrupt / missing / wrong-shape file:
   * starts empty, preserving the corrupt original as `.corrupt` (a lost tombstone only re-offers a save
   * — a UX nuisance, never a security or wrong-target issue, so fail-safe to empty).
   */
  static load(storeDir?: string): NeverStore {
    const dir = storeDir ?? defaultStoreDir();
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, FILE_NAME);
    const entries = new Set<string>();
    if (existsSync(filePath)) {
      try {
        const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
        if (
          typeof raw === "object" && raw !== null &&
          (raw as NeverFile).version === 1 &&
          Array.isArray((raw as NeverFile).entries) &&
          (raw as NeverFile).entries.every((e) => typeof e === "string")
        ) {
          for (const e of (raw as NeverFile).entries) entries.add(e);
        } else {
          preserveCorrupt(filePath);
        }
      } catch {
        preserveCorrupt(filePath);
      }
    }
    return new NeverStore(filePath, entries);
  }

  /** True if the user chose [Never] for this canonical binding — the loop then skips the save offer. */
  has(canonicalKey: string): boolean {
    return this.entries.has(canonicalKey);
  }

  /** Record a [Never] tombstone (idempotent — a no-op + no write if already present). Atomic persist. */
  add(canonicalKey: string): void {
    if (this.entries.has(canonicalKey)) return;
    this.entries.add(canonicalKey);
    this.save();
  }

  /** Atomic persistence: write `<file>.tmp`, then rename over the real file (mirrors L0 Save()). */
  private save(): void {
    const tmp = `${this.filePath}.tmp`;
    const data: NeverFile = { version: 1, entries: [...this.entries].sort() };
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.filePath); // libuv rename uses MOVEFILE_REPLACE_EXISTING on Windows
  }
}

/** Keep forensic evidence of an unparseable file instead of silently overwriting it. */
function preserveCorrupt(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}.corrupt`);
  } catch { /* best-effort */ }
}
