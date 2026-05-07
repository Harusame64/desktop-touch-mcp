/**
 * macro-outcome-store.ts — ADR-011 Phase B B-4 Procedural memory outcome store
 * (Phase B sub-plan §6.2、B-3 `ui-pattern-store.ts` と同型 LRU + JSON persist)。
 *
 * **Phase B B-4 MVP scope (Phase B plan §11.1 順 4 番、land 2026-05-07)**:
 *   - in-memory LRU 100 + JSON persistence (env opt-in、B-3 と同経路)
 *   - macro_id (= inner tool sequence の FNV-1a hash) で集計
 *   - success_count / failure_count / contains_destructive / last_seen_at_ms 保持
 *   - suggest filter は `projectProceduralMemory` 側で実装 (本 store は raw 集計)
 *
 * **suggest filter 閾値 (Phase B plan §10 OQ #8 + B-4 着手時 user 諮問
 * 2026-05-07 で確定)**:
 *   - success_count >= 3
 *   - failure_count == 0 (1 回でも失敗があれば suggest しない)
 *   - contains_destructive == false (destructive_candidate を含まない)
 *
 * **永続化** (B-3 と同 JSON、env opt-in):
 *   - default (env OFF): in-memory only、LLM session 内で完結
 *   - `DESKTOP_TOUCH_MEMORY_PERSIST=1`: JSON 永続化、起動時 loadFromDisk +
 *     5s debounced flushToDisk + shutdown 時 flushImmediateForShutdown
 *   - `DESKTOP_TOUCH_MEMORY_REDACT_TITLES=1`: macro outcome に window_title
 *     直接 store しないので **redact 影響なし** (B-3 と差別化、tools 名は
 *     PII でないため)
 *
 * **storage location** (env on 時):
 * `%USERPROFILE%\.desktop-touch-mcp\memory\macro-outcomes.json`
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Procedural memory record — 1 macro pattern 単位 (inner tool sequence で
 * fingerprint された outcome 集計)。
 */
export interface MacroOutcomeRecord {
  /** FNV-1a hash of inner tool name sequence (e.g. `["focus_window","keyboard","keyboard"]`) */
  macro_id: string;
  /** Inner tool name sequence (順序保持、suggest 出力用) */
  tools: string[];
  /** 成功回数 (`run_macro` 全 step ok=true) */
  success_count: number;
  /** 失敗回数 (1 step でも fail or stop_on_error 切断) */
  failure_count: number;
  /** Inner steps に destructive tool が含まれていたか (suggest filter で skip 用) */
  contains_destructive: boolean;
  /** 最終観測時刻 (LRU recency 順 + suggest 表示用) */
  last_seen_at_ms: number;
}

/** Default LRU capacity (Phase B plan §6.2、B-3 同等)。 */
const MACRO_OUTCOME_STORE_CAPACITY = 100;

/** Persistence file schema version (forward-compat、B-3 同型 axis)。 */
const PERSIST_SCHEMA_VERSION = 1;

/** Default debounce window before flushing pending writes (B-3 同等 5s)。 */
const PERSIST_DEBOUNCE_MS = 5_000;

/** Pure parser for `DESKTOP_TOUCH_MEMORY_PERSIST` env (B-3 と shared semantics、
 *  CLAUDE.md `feedback_pure_parser_for_env_helpers.md` 整合)。 */
function parseMemoryPersistMode(raw: string | undefined): boolean {
  return raw === "1";
}

/** 32-bit FNV-1a hash (B-3 `ui-pattern-store.ts` / `_envelope.ts` と同型 algorithm)。 */
export function fnv1aHash16(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Compute macro_id from inner tool sequence (FNV-1a of `tool1→tool2→...`)。 */
export function computeMacroId(tools: string[]): string {
  return fnv1aHash16(tools.join("→"));
}

/** Default storage dir (B-3 と同経路、CLAUDE.md launcher 経路整合)。 */
function defaultStorageDir(): string {
  return path.join(os.homedir(), ".desktop-touch-mcp", "memory");
}

/** Default storage file path。 */
function defaultStorageFilePath(): string {
  return path.join(defaultStorageDir(), "macro-outcomes.json");
}

/** Persisted JSON shape (schema v1)。 */
interface PersistedShape {
  version: number;
  outcomes: MacroOutcomeRecord[];
}

/** Runtime validator for `PersistedShape` (corruption recovery、B-3 同型)。 */
function isPersistedShape(value: unknown): value is PersistedShape {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.version !== "number") return false;
  if (!Array.isArray(v.outcomes)) return false;
  for (const r of v.outcomes) {
    if (typeof r !== "object" || r === null) return false;
    const rr = r as Record<string, unknown>;
    if (
      typeof rr.macro_id !== "string" ||
      !Array.isArray(rr.tools) ||
      typeof rr.success_count !== "number" ||
      typeof rr.failure_count !== "number" ||
      typeof rr.contains_destructive !== "boolean" ||
      typeof rr.last_seen_at_ms !== "number"
    ) {
      return false;
    }
    for (const t of rr.tools) {
      if (typeof t !== "string") return false;
    }
  }
  return true;
}

/**
 * In-memory LRU outcome store with persistence (B-3 と同型 design)。
 */
export class MacroOutcomeStore {
  private records: Map<string, MacroOutcomeRecord> = new Map();
  capacity: number = MACRO_OUTCOME_STORE_CAPACITY;
  private storageFilePath: string = defaultStorageFilePath();
  private pendingFlushTimer: NodeJS.Timeout | null = null;
  private debounceMs: number = PERSIST_DEBOUNCE_MS;

  /**
   * Record a macro outcome (called from `run_macro` handler tail)。
   * `success` flag は run 全体の成否 (1 step でも fail なら false)。
   */
  recordOutcome(args: {
    tools: string[];
    success: boolean;
    containsDestructive: boolean;
    nowMs?: number;
  }): void {
    const macro_id = computeMacroId(args.tools);
    const nowMs = args.nowMs ?? Date.now();
    const existing = this.records.get(macro_id);
    if (existing) {
      if (args.success) {
        existing.success_count += 1;
      } else {
        existing.failure_count += 1;
      }
      existing.last_seen_at_ms = nowMs;
      // contains_destructive は static (tool sequence 変わらない限り) だが
      // defensive で再計算 (新観測の値で上書き)
      existing.contains_destructive = args.containsDestructive;
      // LRU touch
      this.records.delete(macro_id);
      this.records.set(macro_id, existing);
    } else {
      this.records.set(macro_id, {
        macro_id,
        tools: [...args.tools],
        success_count: args.success ? 1 : 0,
        failure_count: args.success ? 0 : 1,
        contains_destructive: args.containsDestructive,
        last_seen_at_ms: nowMs,
      });
      while (this.records.size > this.capacity) {
        const oldestKey = this.records.keys().next().value;
        if (oldestKey === undefined) break;
        this.records.delete(oldestKey);
      }
    }
    this.scheduleFlushDebounced();
  }

  /**
   * Top-K outcome by `last_seen_at_ms` 降順、**suggest filter 適用**:
   * `success_count >= minSuccessCount` + `failure_count == 0` +
   * `contains_destructive == false` の 3 条件全 pass 件のみ返す。
   *
   * 同 `last_seen_at_ms` tie 時の sort 順は **V8 stable sort** で Map
   * insertion order = LRU touch 順を保つ (recordOutcome 経路で必ず Map
   * touch 済、insertion order ≈ recency-then-LRU の bounded order)。
   *
   * **重要**: 本 method は suggest 用 filter 済 read API。filter 前 raw
   * は `_allRecordsForTest` でしか参照不可 (production code は filter 経由
   * しか触らせない、destructive 流出 fail-safe)。
   */
  getTopKForSuggest(k: number, minSuccessCount = 3): MacroOutcomeRecord[] {
    const filtered = [...this.records.values()].filter(
      (r) =>
        r.success_count >= minSuccessCount &&
        r.failure_count === 0 &&
        r.contains_destructive === false,
    );
    filtered.sort((a, b) => b.last_seen_at_ms - a.last_seen_at_ms);
    return filtered.slice(0, Math.max(0, k));
  }

  async loadFromDisk(): Promise<void> {
    const persistOn = parseMemoryPersistMode(
      process.env.DESKTOP_TOUCH_MEMORY_PERSIST,
    );
    if (!persistOn) return;
    let raw: string;
    try {
      raw = await fs.readFile(this.storageFilePath, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        console.warn(
          `[macro-outcome-store] loadFromDisk failed: code=${e.code ?? "unknown"} message=${e.message}`,
        );
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(
        `[macro-outcome-store] loadFromDisk: corrupt JSON at ${this.storageFilePath}, ignoring`,
      );
      return;
    }
    if (!isPersistedShape(parsed)) {
      console.warn(
        `[macro-outcome-store] loadFromDisk: schema mismatch at ${this.storageFilePath}, ignoring`,
      );
      return;
    }
    if (parsed.version !== PERSIST_SCHEMA_VERSION) {
      console.warn(
        `[macro-outcome-store] loadFromDisk: schema version ${parsed.version} != ${PERSIST_SCHEMA_VERSION}, ignoring`,
      );
      return;
    }
    this.records.clear();
    for (const r of parsed.outcomes) {
      // field allowlist (B-3 と同型 prototype pollution defensive)
      this.records.set(r.macro_id, {
        macro_id: r.macro_id,
        tools: [...r.tools],
        success_count: r.success_count,
        failure_count: r.failure_count,
        contains_destructive: r.contains_destructive,
        last_seen_at_ms: r.last_seen_at_ms,
      });
      while (this.records.size > this.capacity) {
        const oldestKey = this.records.keys().next().value;
        if (oldestKey === undefined) break;
        this.records.delete(oldestKey);
      }
    }
  }

  async flushToDisk(): Promise<void> {
    return this._flushInternal({
      persist: parseMemoryPersistMode(process.env.DESKTOP_TOUCH_MEMORY_PERSIST),
    });
  }

  private async _flushInternal(opts: { persist: boolean }): Promise<void> {
    if (!opts.persist) return;
    const dir = path.dirname(this.storageFilePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      console.warn(
        `[macro-outcome-store] flushToDisk mkdir failed: code=${e.code ?? "unknown"} message=${e.message}`,
      );
      return;
    }
    const outcomes = [...this.records.values()];
    const payload: PersistedShape = {
      version: PERSIST_SCHEMA_VERSION,
      outcomes,
    };
    const tmpPath = `${this.storageFilePath}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(payload), "utf8");
      await fs.rename(tmpPath, this.storageFilePath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      console.warn(
        `[macro-outcome-store] flushToDisk failed: code=${e.code ?? "unknown"} message=${e.message}`,
      );
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore
      }
    }
  }

  scheduleFlushDebounced(): void {
    // Closure capture (B-3 P2-4 同型 fix)、env mid-flight race 構造解消。
    const persistSnapshot = parseMemoryPersistMode(
      process.env.DESKTOP_TOUCH_MEMORY_PERSIST,
    );
    if (!persistSnapshot) return;
    if (this.pendingFlushTimer) clearTimeout(this.pendingFlushTimer);
    this.pendingFlushTimer = setTimeout(() => {
      this.pendingFlushTimer = null;
      void this._flushInternal({ persist: persistSnapshot });
    }, this.debounceMs);
    this.pendingFlushTimer.unref();
  }

  async flushImmediateForShutdown(): Promise<void> {
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
    await this.flushToDisk();
  }

  /** @internal Test-only — store reset (between test cases) */
  _resetForTest(): void {
    this.records.clear();
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }
  }
  /** @internal Test-only — capacity 上書き */
  _setCapacityForTest(n: number): void {
    this.capacity = n;
  }
  /** @internal Test-only — record 数 (debug pin 用) */
  _sizeForTest(): number {
    return this.records.size;
  }
  /** @internal Test-only — filter 前 raw records 参照 (production 経路では
   *  `getTopKForSuggest` のみ exposing、destructive 含 record の test 検証用) */
  _allRecordsForTest(): MacroOutcomeRecord[] {
    return [...this.records.values()];
  }
  /** @internal Test-only — storage path 上書き (tmpdir redirect 用) */
  _setStorageFilePathForTest(p: string): void {
    this.storageFilePath = p;
  }
  /** @internal Test-only — storage path リセット */
  _resetStorageFilePathForTest(): void {
    this.storageFilePath = defaultStorageFilePath();
  }
  /** @internal Test-only — debounce window 上書き */
  _setDebounceMsForTest(ms: number): void {
    this.debounceMs = ms;
  }
  /** @internal Test-only — debounce window リセット */
  _resetDebounceMsForTest(): void {
    this.debounceMs = PERSIST_DEBOUNCE_MS;
  }
  /** @internal Test-only — pending flush timer の生存確認 */
  _hasPendingFlushForTest(): boolean {
    return this.pendingFlushTimer !== null;
  }
}

/** Module-singleton store (production runtime 用、B-3 と同型 design)。 */
export const macroOutcomeStore = new MacroOutcomeStore();
