/**
 * ui-pattern-store.ts — ADR-011 Phase B B-3 Semantic memory pattern store
 * (Phase B sub-plan §6.2)。
 *
 * In-memory LRU 100 patterns + 永続化 framework skeleton (env opt-in)。
 * Production path:
 *   - default (env OFF): in-memory only、LLM session 内で完結
 *   - `DESKTOP_TOUCH_MEMORY_PERSIST=1` (env ON): JSON 永続化 (本 PR scope 外、
 *     B-3 follow-up PR で disk write/load 実装、本 file は env parser + load/save
 *     method skeleton のみ)
 *   - `DESKTOP_TOUCH_MEMORY_REDACT_TITLES=1` (env ON): 永続化時の windowTitle
 *     hash redact (B-3 follow-up PR で実装)
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

import type { UiPatternRecord } from "../tools/_envelope.js";

/** Default LRU capacity (Phase B plan §6.2)。`SEMANTIC_MEMORY_K_MAX = 10` より
 *  大きい cap で envelope projection 経由 user expose 上限を確保。 */
const UI_PATTERN_STORE_CAPACITY = 100;

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
      // 集計は B-3 follow-up で多 observation 跨ぎ logic に拡張可能)
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
   * **B-3 本 PR scope 外** (skeleton)、follow-up PR で実装:
   *   - `path.join(os.homedir(), ".desktop-touch-mcp", "memory", "ui-patterns.json")`
   *     から JSON read
   *   - parse + validate (shape check) + LRU 順序復元
   *   - corruption / parse error 時は no-op で続行 (memory layer は best-effort)
   */
  async loadFromDisk(): Promise<void> {
    // B-3 follow-up PR で実装 (atomic read + parse + LRU populate)
    return Promise.resolve();
  }

  /**
   * Flush patterns to disk (env on 時 only、debounced or interval flush)。
   * **B-3 本 PR scope 外** (skeleton)、follow-up PR で実装:
   *   - atomic write (`fs.writeFile` + temp + rename) で corruption 防止
   *   - `DESKTOP_TOUCH_MEMORY_REDACT_TITLES=1` で window_title hash redact
   *   - 書き込み failure は warn して続行 (memory layer は best-effort)
   */
  async flushToDisk(): Promise<void> {
    // B-3 follow-up PR で実装 (atomic write + redact)
    return Promise.resolve();
  }

  /** @internal Test-only — store を空に (test 間 state leak 防止) */
  _resetForTest(): void {
    this.records.clear();
  }

  /** @internal Test-only — capacity 上書き (LRU eviction test 用) */
  _setCapacityForTest(n: number): void {
    this.capacity = n;
  }

  /** @internal Test-only — store 内 record 数 (debug / pin 用) */
  _sizeForTest(): number {
    return this.records.size;
  }
}

/**
 * Module-singleton store (production runtime 用)。複数 import で同一
 * instance を共有、`makeCommitWrapper` の commit completion hook と
 * `projectSemanticMemory` query path で共有 read/write。
 */
export const uiPatternStore = new UiPatternStore();
