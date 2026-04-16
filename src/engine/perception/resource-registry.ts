/**
 * resource-registry.ts
 *
 * Maps lens IDs to MCP resource URIs and manages tombstones (30s TTL).
 * Pure state machine — no MCP server imports.
 */

import type { PerceptionLens } from "./types.js";

const TOMBSTONE_TTL_MS  = 30_000;
const MAX_TOMBSTONES    = 128;

export interface ResourceUri {
  lensId: string;
  uri: string;
  view: "summary" | "guards" | "debug" | "events";
}

export interface TombstoneEntry {
  lensId: string;
  uri: string;
  removedAtMs: number;
  message: string;
}

/** Callback invoked when the list of resources changes (add/remove). */
export type OnResourceListChanged = () => void;

export class ResourceRegistry {
  private readonly lensUris = new Map<string, string[]>(); // lensId → [uri, ...]
  private readonly uriToLensId = new Map<string, string>();
  private readonly tombstones  = new Map<string, TombstoneEntry>(); // uri → tombstone
  private tombstoneTimers      = new Map<string, ReturnType<typeof setTimeout>>();

  private onListChanged?: OnResourceListChanged;

  setOnListChanged(cb: OnResourceListChanged): void {
    this.onListChanged = cb;
  }

  onLensRegistered(lens: PerceptionLens): string[] {
    const uris: string[] = [];
    for (const view of ["summary", "guards"] as const) {
      const uri = `perception://lens/${lens.lensId}/${view}`;
      uris.push(uri);
      this.uriToLensId.set(uri, lens.lensId);
    }

    // Debug/events only if debug resources flag is enabled
    if (process.env.DESKTOP_TOUCH_PERCEPTION_DEBUG_RESOURCES === "1") {
      for (const view of ["debug", "events"] as const) {
        const uri = `perception://lens/${lens.lensId}/${view}`;
        uris.push(uri);
        this.uriToLensId.set(uri, lens.lensId);
      }
    }

    this.lensUris.set(lens.lensId, uris);

    // Clear any tombstone for this lens (re-registered)
    for (const uri of uris) {
      if (this.tombstones.has(uri)) {
        this.clearTombstone(uri);
      }
    }

    this.onListChanged?.();
    return uris;
  }

  onLensForgotten(lensId: string): void {
    const uris = this.lensUris.get(lensId) ?? [];
    this.lensUris.delete(lensId);
    for (const uri of uris) {
      this.uriToLensId.delete(uri);
      this.addTombstone(uri, lensId);
    }
    this.onListChanged?.();
  }

  getLensId(uri: string): string | undefined {
    return this.uriToLensId.get(uri);
  }

  getTombstone(uri: string): TombstoneEntry | undefined {
    return this.tombstones.get(uri);
  }

  /** All active (non-tombstone) resource URIs. */
  listUris(): string[] {
    const all: string[] = [];
    for (const uris of this.lensUris.values()) all.push(...uris);
    return all;
  }

  listForClient(): Array<{ uri: string; name: string; mimeType: string }> {
    return this.listUris().map(uri => ({
      uri,
      name: uri.split("/").slice(-2).join("/"),
      mimeType: "application/json",
    }));
  }

  // ── Tombstone helpers ────────────────────────────────────────────────────────

  private addTombstone(uri: string, lensId: string): void {
    // Evict oldest tombstone if over limit
    if (this.tombstones.size >= MAX_TOMBSTONES) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest) this.clearTombstone(oldest);
    }

    const entry: TombstoneEntry = {
      lensId,
      uri,
      removedAtMs: Date.now(),
      message: `Lens ${lensId} was forgotten. Resource URI is no longer active.`,
    };
    this.tombstones.set(uri, entry);

    const timer = setTimeout(() => {
      this.clearTombstone(uri);
      this.onListChanged?.();
    }, TOMBSTONE_TTL_MS);
    if (timer.unref) timer.unref();
    this.tombstoneTimers.set(uri, timer);
  }

  private clearTombstone(uri: string): void {
    const timer = this.tombstoneTimers.get(uri);
    if (timer) { clearTimeout(timer); this.tombstoneTimers.delete(uri); }
    this.tombstones.delete(uri);
  }

  __resetForTests(): void {
    for (const t of this.tombstoneTimers.values()) clearTimeout(t);
    this.lensUris.clear();
    this.uriToLensId.clear();
    this.tombstones.clear();
    this.tombstoneTimers.clear();
  }
}
