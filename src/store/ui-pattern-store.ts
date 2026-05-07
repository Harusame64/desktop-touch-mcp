/**
 * ui-pattern-store.ts — ADR-011 Phase B B-3 Semantic memory pattern store
 * (Phase B sub-plan §6.2)。
 *
 * In-memory LRU 100 patterns + JSON disk persistence (env opt-in、B-3 follow-up
 * land 後 fully wired)。
 * Production path:
 *   - default (env OFF): in-memory only、LLM session 内で完結
 *   - `DESKTOP_TOUCH_MEMORY_PERSIST=1` (env ON): JSON 永続化、起動時 loadFromDisk
 *     + recordPattern 後 debounced flushToDisk (5s coalesce) + shutdown 時
 *     flushImmediateForShutdown (data loss 防止)
 *   - `DESKTOP_TOUCH_MEMORY_REDACT_TITLES=1` (env ON): 永続化時の windowTitle
 *     を FNV-1a hash で置換 (irreversible)、in-memory には raw 維持で env を
 *     session 中 flip しても projection 即時切替を担保 (`projectSemanticMemory`
 *     redact 経路と整合)
 *
 * **Security tier framework (Phase B plan §10 OQ #10、carry-over)**:
 * env (operator ceiling) + LLM `include` axis (per-call floor) 二重 axis 設計
 * は B-3 land 後 follow-up PR で導入。本 file は env-only 制御の foundation。
 *
 * **storage location** (env on 時):
 * `%USERPROFILE%\.desktop-touch-mcp\memory\ui-patterns.json`
 * (Node.js `path.join(os.homedir(), ".desktop-touch-mcp", "memory", "ui-patterns.json")`、
 * CLAUDE.md launcher 経路 `%USERPROFILE%\.desktop-touch-mcp` と整合)
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { UiPatternRecord } from "../tools/_envelope.js";

/** Default LRU capacity (Phase B plan §6.2)。`SEMANTIC_MEMORY_K_MAX = 10` より
 *  大きい cap で envelope projection 経由 user expose 上限を確保。 */
const UI_PATTERN_STORE_CAPACITY = 100;

/** Persistence file schema version (forward-compat for future migrations)。 */
const PERSIST_SCHEMA_VERSION = 1;

/** Default debounce window before flushing pending writes to disk (ms)。
 *  per-write trigger を coalesce、頻発 commit でも disk I/O を抑制。 */
const PERSIST_DEBOUNCE_MS = 5_000;

/**
 * 32-bit FNV-1a hash (collision-tolerant、no crypto import 不要)。
 * windowTitle redact-on-persist 用 (`_envelope.ts:fnv1aHash16` と同型、
 * 互換性確保のため projection-time hash と同じアルゴリズム使用)。
 */
function fnv1aHash16(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Default storage dir (`%USERPROFILE%\.desktop-touch-mcp\memory\` on Windows、
 *  Phase B plan §3.3 / §6.2 既定、CLAUDE.md launcher 経路整合)。 */
function defaultStorageDir(): string {
  return path.join(os.homedir(), ".desktop-touch-mcp", "memory");
}

/** Default storage file path (`ui-patterns.json` 内 schema v1、Phase B plan §6.2)。 */
function defaultStorageFilePath(): string {
  return path.join(defaultStorageDir(), "ui-patterns.json");
}

/**
 * Parse `DESKTOP_TOUCH_MEMORY_PERSIST` env var (Phase B sub-plan §3.3 推奨
 * default OFF)。pure parser (CLAUDE.md `feedback_pure_parser_for_env_helpers.md`
 * 整合、env mutation race を構造的解消)。
 */
export function parseMemoryPersistMode(raw: string | undefined): boolean {
  return raw === "1";
}

/**
 * Parse `DESKTOP_TOUCH_MEMORY_REDACT_TITLES` env var (Phase B sub-plan §6.3
 * 推奨 default OFF、永続化時のみ実害)。pure parser。
 */
export function parseMemoryRedactMode(raw: string | undefined): boolean {
  return raw === "1";
}

/**
 * In-memory LRU pattern store with persistence framework skeleton。
 *
 * Production path:
 *   - `recordPattern(record)`: 既存 pattern_id があれば success/failure_count
 *     update + last_seen_at_ms refresh、新規なら追加 (LRU で oldest evict)
 *   - `getTopK(k)`: last_seen_at_ms 降順で top K record
 *   - `loadFromDisk()` / `flushToDisk()`: env on 時 only、本 PR scope では
 *     skeleton 実装 (no-op、B-3 follow-up PR で actual disk I/O 実装)
 *
 * Test seam:
 *   - `_resetForTest()`: store clear (test 間 state leak 防止)
 *   - `_setCapacityForTest(n)`: capacity 上書き (LRU eviction test 用)
 */
export class UiPatternStore {
  private records: Map<string, UiPatternRecord> = new Map();
  /** @internal Test-only — capacity 上書き seam */
  capacity: number = UI_PATTERN_STORE_CAPACITY;
  /** @internal Test-only — storage path 上書き seam (default は
   *  `%USERPROFILE%\.desktop-touch-mcp\memory\ui-patterns.json`)。 */
  private storageFilePath: string = defaultStorageFilePath();
  /** @internal Pending debounced flush timer (per-write trigger を coalesce)。 */
  private pendingFlushTimer: NodeJS.Timeout | null = null;
  /** @internal Test-only — debounce window 上書き seam */
  private debounceMs: number = PERSIST_DEBOUNCE_MS;

  /**
   * Record / merge a pattern observation。同 pattern_id 既存なら success_count
   * (or failure_count) を increment + last_seen_at_ms refresh、新規なら追加
   * (LRU で oldest evict)。
   *
   * `success` は run 内全 commit `ok=true` 前提なので true 固定 (本 helper は
   * `extractSemanticPatterns` の戻り値を merge する想定、rule 中断条件 = ok
   * != true で run flush せず、successful run のみ pattern 化する設計)。
   * 失敗 pattern の expose は B-4 / B-3 follow-up で別途検討。
   */
  recordPattern(record: UiPatternRecord, success = true): void {
    const existing = this.records.get(record.pattern_id);
    if (existing) {
      // 既存 pattern を update (count increment + last_seen_at_ms refresh)
      if (success) {
        existing.success_count += record.success_count;
      } else {
        existing.failure_count += record.failure_count;
      }
      existing.last_seen_at_ms = Math.max(
        existing.last_seen_at_ms,
        record.last_seen_at_ms,
      );
      // example_actions は最新観測の上位 3 件で更新 (rule 簡素化、frequency
      // 集計は §10 OQ #12 follow-up で多 observation 跨ぎ logic に拡張可能)
      existing.example_actions = record.example_actions;
      // LRU touch (Map.delete + set で末尾に移動)
      this.records.delete(record.pattern_id);
      this.records.set(record.pattern_id, existing);
    } else {
      // 新規 pattern 追加、LRU eviction
      this.records.set(record.pattern_id, { ...record });
      while (this.records.size > this.capacity) {
        // 最古 (Map iteration 順 = insertion 順) を evict
        const oldestKey = this.records.keys().next().value;
        if (oldestKey === undefined) break;
        this.records.delete(oldestKey);
      }
    }
    // Persistence follow-up: env on 時のみ debounced flush schedule。
    // env off は no-op (timer 走らない)、recordPattern hot path overhead ゼロ。
    this.scheduleFlushDebounced();
  }

  /**
   * Top K patterns by `last_seen_at_ms` 降順 (recency-first)。同値時は Map
   * insertion 順 (= recently updated 順、安定 ordering)。`projectSemanticMemory`
   * から呼ばれる read API。
   */
  getTopK(k: number): UiPatternRecord[] {
    const all = [...this.records.values()];
    all.sort((a, b) => b.last_seen_at_ms - a.last_seen_at_ms);
    return all.slice(0, Math.max(0, k));
  }

  /**
   * Load patterns from disk (env on 時 only、起動時 1 度呼ぶ)。
   *
   * - env `DESKTOP_TOUCH_MEMORY_PERSIST=1` 不在時 → no-op (load しない)
   * - file 不在 → no-op (初回起動相当)
   * - JSON parse error / shape mismatch → no-op で続行 (memory layer は
   *   best-effort、corruption 時は initial 状態から再構築)
   * - schema version 不一致 → no-op (forward-compat、後続 version で migration)
   *
   * Insertion 順序を file 内の順序に従って復元し、LRU の oldest 概念を
   * 維持 (Map iteration 順 = insertion 順 = LRU 順)。
   */
  async loadFromDisk(): Promise<void> {
    const persistOn = parseMemoryPersistMode(
      process.env.DESKTOP_TOUCH_MEMORY_PERSIST,
    );
    if (!persistOn) return;
    let raw: string;
    try {
      raw = await fs.readFile(this.storageFilePath, "utf8");
    } catch (err) {
      // ENOENT (file 不在) は無視、その他 I/O error は warn して続行
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(
          `[ui-pattern-store] loadFromDisk failed: ${(err as Error).message}`,
        );
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(
        `[ui-pattern-store] loadFromDisk: corrupt JSON at ${this.storageFilePath}, ignoring`,
      );
      return;
    }
    if (!isPersistedShape(parsed)) {
      console.error(
        `[ui-pattern-store] loadFromDisk: schema mismatch at ${this.storageFilePath}, ignoring`,
      );
      return;
    }
    if (parsed.version !== PERSIST_SCHEMA_VERSION) {
      console.error(
        `[ui-pattern-store] loadFromDisk: schema version ${parsed.version} != ${PERSIST_SCHEMA_VERSION}, ignoring`,
      );
      return;
    }
    // Patterns are inserted in disk order (= persisted LRU order)、capacity
    // 超過時は eviction (loaded data が古い場合の defensive)
    this.records.clear();
    for (const r of parsed.patterns) {
      this.records.set(r.pattern_id, { ...r });
      while (this.records.size > this.capacity) {
        const oldestKey = this.records.keys().next().value;
        if (oldestKey === undefined) break;
        this.records.delete(oldestKey);
      }
    }
  }

  /**
   * Flush patterns to disk (env on 時 only)。
   *
   * - env `DESKTOP_TOUCH_MEMORY_PERSIST=1` 不在時 → no-op
   * - storage dir を `mkdir -p` (`recursive: true`) で確保
   * - atomic write: `<file>.tmp` に書いてから `fs.rename` (POSIX-atomic、
   *   Windows では Node が internally `MoveFileExW` で同等)
   * - `DESKTOP_TOUCH_MEMORY_REDACT_TITLES=1` 時 window_title を hash 化
   *   して disk へ (irreversible redact)、env off で書いた後 on にすると
   *   既存 plaintext は次の flush で hash に置換される
   * - 書き込み failure は warn して続行 (memory layer best-effort)
   */
  async flushToDisk(): Promise<void> {
    const persistOn = parseMemoryPersistMode(
      process.env.DESKTOP_TOUCH_MEMORY_PERSIST,
    );
    if (!persistOn) return;
    const redactOn = parseMemoryRedactMode(
      process.env.DESKTOP_TOUCH_MEMORY_REDACT_TITLES,
    );
    const dir = path.dirname(this.storageFilePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      console.error(
        `[ui-pattern-store] flushToDisk mkdir failed: ${(err as Error).message}`,
      );
      return;
    }
    const patterns = [...this.records.values()].map((r) => {
      if (redactOn) {
        return {
          ...r,
          window_title: `redacted:${fnv1aHash16(r.window_title)}`,
        };
      }
      return r;
    });
    const payload: PersistedShape = {
      version: PERSIST_SCHEMA_VERSION,
      patterns,
    };
    const tmpPath = `${this.storageFilePath}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(payload), "utf8");
      await fs.rename(tmpPath, this.storageFilePath);
    } catch (err) {
      console.error(
        `[ui-pattern-store] flushToDisk failed: ${(err as Error).message}`,
      );
      // tmp 残存時 best-effort cleanup
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Schedule a debounced flush (per-write trigger を coalesce)。
   *
   * `recordPattern` 完了後に呼ぶことで、頻発 commit でも disk I/O は
   * `debounceMs` 内に 1 回に制限。pending timer を必ず unref して
   * Node プロセス終了の妨げにならない (`SIGINT` handler 経由の
   * `flushImmediateForShutdown` で確実に最終 flush)。
   */
  scheduleFlushDebounced(): void {
    const persistOn = parseMemoryPersistMode(
      process.env.DESKTOP_TOUCH_MEMORY_PERSIST,
    );
    if (!persistOn) return;
    if (this.pendingFlushTimer) clearTimeout(this.pendingFlushTimer);
    this.pendingFlushTimer = setTimeout(() => {
      this.pendingFlushTimer = null;
      void this.flushToDisk();
    }, this.debounceMs);
    this.pendingFlushTimer.unref();
  }

  /**
   * Immediate flush (cancel pending debounce + sync flush)。shutdown handler
   * 経路で呼ぶ、データ loss 最小化。
   */
  async flushImmediateForShutdown(): Promise<void> {
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
    await this.flushToDisk();
  }

  /** @internal Test-only — store を空に (test 間 state leak 防止) */
  _resetForTest(): void {
    this.records.clear();
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
  }

  /** @internal Test-only — capacity 上書き (LRU eviction test 用) */
  _setCapacityForTest(n: number): void {
    this.capacity = n;
  }

  /** @internal Test-only — store 内 record 数 (debug / pin 用) */
  _sizeForTest(): number {
    return this.records.size;
  }

  /** @internal Test-only — storage path 上書き (persistence test 用、
   *  default `%USERPROFILE%\.desktop-touch-mcp\memory\ui-patterns.json` を
   *  tmpdir 配下に redirect) */
  _setStorageFilePathForTest(p: string): void {
    this.storageFilePath = p;
  }

  /** @internal Test-only — storage path リセット (default に戻す) */
  _resetStorageFilePathForTest(): void {
    this.storageFilePath = defaultStorageFilePath();
  }

  /** @internal Test-only — debounce window 上書き (test で短縮) */
  _setDebounceMsForTest(ms: number): void {
    this.debounceMs = ms;
  }

  /** @internal Test-only — pending flush timer の生存確認 */
  _hasPendingFlushForTest(): boolean {
    return this.pendingFlushTimer !== null;
  }
}

/** Persisted JSON shape on disk (`ui-patterns.json` schema v1)。 */
interface PersistedShape {
  version: number;
  patterns: UiPatternRecord[];
}

/** Runtime validator for `PersistedShape` (best-effort、corruption recovery)。 */
function isPersistedShape(value: unknown): value is PersistedShape {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "number") return false;
  if (!Array.isArray(v.patterns)) return false;
  for (const p of v.patterns) {
    if (typeof p !== "object" || p === null) return false;
    const pp = p as Record<string, unknown>;
    if (
      typeof pp.pattern_id !== "string" ||
      typeof pp.window_title !== "string" ||
      typeof pp.step_count !== "number" ||
      typeof pp.last_seen_at_ms !== "number" ||
      typeof pp.success_count !== "number" ||
      typeof pp.failure_count !== "number" ||
      !Array.isArray(pp.example_actions)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Module-singleton store (production runtime 用)。複数 import で同一
 * instance を共有、`makeCommitWrapper` の commit completion hook と
 * `projectSemanticMemory` query path で共有 read/write。
 */
export const uiPatternStore = new UiPatternStore();
