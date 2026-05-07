/**
 * ui-pattern-store-persistence.test.ts — ADR-011 Phase B B-3 follow-up
 * Persistence disk I/O contract test。
 *
 * Coverage (10 case):
 *   - PERSIST-1 env off で loadFromDisk no-op (file 存在しても load しない)
 *   - PERSIST-2 env off で flushToDisk no-op (file 作成されない)
 *   - PERSIST-3 env on で flushToDisk → file 作成 + JSON valid + schema v1
 *   - PERSIST-4 round-trip: flush → load → in-memory state 完全復元
 *   - PERSIST-5 corrupt JSON → load no-op (warn logged、initial state 保持)
 *   - PERSIST-6 schema version mismatch → load no-op
 *   - PERSIST-7 missing file → load no-op (ENOENT silent skip)
 *   - PERSIST-8 redact env on で window_title が hash に置換されて disk へ
 *   - PERSIST-9 atomic write: tmp → rename 経路 (途中 crash で部分書き込み残らない)
 *   - PERSIST-10 debounced flush: 連続 recordPattern で 1 回だけ disk write
 */

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { uiPatternStore } from "../../src/store/ui-pattern-store.js";

let tmpDir: string;
let tmpFile: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "uipattern-test-"));
  tmpFile = path.join(tmpDir, "ui-patterns.json");
  uiPatternStore._setStorageFilePathForTest(tmpFile);
  uiPatternStore._resetForTest();
  uiPatternStore._setCapacityForTest(100);
});

afterEach(async () => {
  uiPatternStore._resetForTest();
  uiPatternStore._resetStorageFilePathForTest();
  uiPatternStore._resetDebounceMsForTest();
  delete process.env.DESKTOP_TOUCH_MEMORY_PERSIST;
  delete process.env.DESKTOP_TOUCH_MEMORY_REDACT_TITLES;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function seedRecord(id: string, title: string, count = 3) {
  uiPatternStore.recordPattern({
    pattern_id: id,
    window_title: title,
    step_count: count,
    last_seen_at_ms: 1000 + count,
    success_count: count,
    failure_count: 0,
    example_actions: ["focus_window", "keyboard"],
  });
}

describe("PERSIST-1: env off で loadFromDisk no-op", () => {
  it("file が存在しても env 不在なら load しない (in-memory empty 維持)", async () => {
    delete process.env.DESKTOP_TOUCH_MEMORY_PERSIST;
    await fs.writeFile(
      tmpFile,
      JSON.stringify({
        version: 1,
        patterns: [
          {
            pattern_id: "pat-A",
            window_title: "Notepad",
            step_count: 3,
            last_seen_at_ms: 1000,
            success_count: 3,
            failure_count: 0,
            example_actions: ["k"],
          },
        ],
      }),
    );
    await uiPatternStore.loadFromDisk();
    expect(uiPatternStore._sizeForTest()).toBe(0);
  });
});

describe("PERSIST-2: env off で flushToDisk no-op", () => {
  it("env 不在なら recordPattern しても file が作られない", async () => {
    delete process.env.DESKTOP_TOUCH_MEMORY_PERSIST;
    seedRecord("pat-A", "Notepad");
    await uiPatternStore.flushToDisk();
    await expect(fs.access(tmpFile)).rejects.toThrow();
  });
});

describe("PERSIST-3: env on で flushToDisk → JSON valid + schema v1", () => {
  it("env=1 で 1 record flush → schema v1 + patterns 配列内 record 1 件", async () => {
    process.env.DESKTOP_TOUCH_MEMORY_PERSIST = "1";
    seedRecord("pat-A", "Notepad");
    await uiPatternStore.flushToDisk();
    const raw = await fs.readFile(tmpFile, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.patterns).toHaveLength(1);
    expect(parsed.patterns[0]).toMatchObject({
      pattern_id: "pat-A",
      window_title: "Notepad",
      step_count: 3,
      success_count: 3,
    });
  });
});

describe("PERSIST-4: round-trip flush → load 完全復元", () => {
  it("flush 後 reset + load で in-memory state が同一", async () => {
    process.env.DESKTOP_TOUCH_MEMORY_PERSIST = "1";
    seedRecord("pat-A", "Notepad");
    seedRecord("pat-B", "Chrome");
    await uiPatternStore.flushToDisk();

    uiPatternStore._resetForTest();
    expect(uiPatternStore._sizeForTest()).toBe(0);

    await uiPatternStore.loadFromDisk();
    expect(uiPatternStore._sizeForTest()).toBe(2);
    const top = uiPatternStore.getTopK(10);
    expect(top.map((r) => r.pattern_id).sort()).toEqual(["pat-A", "pat-B"]);
  });
});

describe("PERSIST-5: corrupt JSON → load no-op + initial state 保持", () => {
  it("invalid JSON が disk にあっても in-memory store は破壊されない", async () => {
    process.env.DESKTOP_TOUCH_MEMORY_PERSIST = "1";
    await fs.writeFile(tmpFile, "{not-valid-json", "utf8");
    seedRecord("pat-X", "Initial");
    await uiPatternStore.loadFromDisk();
    // load 失敗で in-memory 既存 record は keep される (load は records.clear()
    // を valid parse 後にしか実行しないため)
    expect(uiPatternStore._sizeForTest()).toBe(1);
    expect(uiPatternStore.getTopK(1)[0]?.pattern_id).toBe("pat-X");
  });
});

describe("PERSIST-6: schema version mismatch → load no-op", () => {
  it("version: 99 を load しない (forward-compat)", async () => {
    process.env.DESKTOP_TOUCH_MEMORY_PERSIST = "1";
    await fs.writeFile(
      tmpFile,
      JSON.stringify({
        version: 99,
        patterns: [
          {
            pattern_id: "pat-A",
            window_title: "Notepad",
            step_count: 3,
            last_seen_at_ms: 1000,
            success_count: 3,
            failure_count: 0,
            example_actions: ["k"],
          },
        ],
      }),
    );
    await uiPatternStore.loadFromDisk();
    expect(uiPatternStore._sizeForTest()).toBe(0);
  });
});

describe("PERSIST-7: missing file → load no-op (ENOENT silent)", () => {
  it("file 不在で ENOENT raised → silent skip + no error trace", async () => {
    process.env.DESKTOP_TOUCH_MEMORY_PERSIST = "1";
    // tmpFile は存在しない (beforeEach で mkdtemp したが file は作っていない)
    await expect(uiPatternStore.loadFromDisk()).resolves.toBeUndefined();
    expect(uiPatternStore._sizeForTest()).toBe(0);
  });
});

describe("PERSIST-8: redact env on で window_title hash 化", () => {
  it("DESKTOP_TOUCH_MEMORY_REDACT_TITLES=1 で flush → disk 上の window_title が hash 表記", async () => {
    process.env.DESKTOP_TOUCH_MEMORY_PERSIST = "1";
    process.env.DESKTOP_TOUCH_MEMORY_REDACT_TITLES = "1";
    seedRecord("pat-A", "Sensitive Document.txt - Notepad");
    await uiPatternStore.flushToDisk();
    const raw = await fs.readFile(tmpFile, "utf8");
    const parsed = JSON.parse(raw);
    const wt = parsed.patterns[0].window_title;
    expect(wt).toMatch(/^redacted:[0-9a-f]{8}$/);
    expect(wt).not.toContain("Sensitive");
    expect(wt).not.toContain("Notepad");
    // in-memory 側は raw 維持 (env を session 中に切り替えた時の挙動切替を担保)
    expect(uiPatternStore.getTopK(1)[0]?.window_title).toBe(
      "Sensitive Document.txt - Notepad",
    );
  });
});

describe("PERSIST-9: atomic write — tmp 経路 + rename", () => {
  it("flush 後 .tmp が残らない (rename で移動完了)", async () => {
    process.env.DESKTOP_TOUCH_MEMORY_PERSIST = "1";
    seedRecord("pat-A", "Notepad");
    await uiPatternStore.flushToDisk();
    const tmpPath = `${tmpFile}.tmp`;
    await expect(fs.access(tmpPath)).rejects.toThrow();
    await expect(fs.access(tmpFile)).resolves.toBeUndefined();
  });
});

describe("PERSIST-10: debounced flush — 連続 recordPattern で disk write 1 回", () => {
  it("debounce ms 短縮 + 連続 record で final flush 1 回 (timer coalesce)", async () => {
    process.env.DESKTOP_TOUCH_MEMORY_PERSIST = "1";
    uiPatternStore._setDebounceMsForTest(50);
    for (let i = 0; i < 5; i++) {
      seedRecord(`pat-${i}`, `Win${i}`);
    }
    // pending timer 1 件 (5 record で 1 timer 集約)
    expect(uiPatternStore._hasPendingFlushForTest()).toBe(true);
    // debounce 経過待ち
    await new Promise((r) => setTimeout(r, 100));
    // timer 完了 → file 作成済 + 5 records 全件入っている
    expect(uiPatternStore._hasPendingFlushForTest()).toBe(false);
    const raw = await fs.readFile(tmpFile, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.patterns).toHaveLength(5);
  });
});

describe("PERSIST-11: flushImmediateForShutdown — pending cancel + 即時 flush", () => {
  it("pending debounce ありで shutdown flush → timer cleared + final disk write 完了", async () => {
    process.env.DESKTOP_TOUCH_MEMORY_PERSIST = "1";
    uiPatternStore._setDebounceMsForTest(60_000);
    seedRecord("pat-A", "Notepad");
    expect(uiPatternStore._hasPendingFlushForTest()).toBe(true);
    await uiPatternStore.flushImmediateForShutdown();
    expect(uiPatternStore._hasPendingFlushForTest()).toBe(false);
    const raw = await fs.readFile(tmpFile, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.patterns).toHaveLength(1);
  });
});

// ── PERSIST-12: redact load 後 二重 hash 防止 (Round 2 P2-1 fix) ────────────

describe("PERSIST-12: redact disk load 後 flush で 二重 hash 化されない (P2-1 regression)", () => {
  it("redact env on で flush → disk hash → load → 再 flush で `redacted:redacted:...` にならない", async () => {
    process.env.DESKTOP_TOUCH_MEMORY_PERSIST = "1";
    process.env.DESKTOP_TOUCH_MEMORY_REDACT_TITLES = "1";
    seedRecord("pat-A", "Sensitive Doc.txt - Notepad");
    await uiPatternStore.flushToDisk();
    let raw = await fs.readFile(tmpFile, "utf8");
    let parsed = JSON.parse(raw);
    const firstHash = parsed.patterns[0].window_title;
    expect(firstHash).toMatch(/^redacted:[0-9a-f]{8}$/);

    // reset + load (in-memory に redacted 文字列が固着)
    uiPatternStore._resetForTest();
    await uiPatternStore.loadFromDisk();
    expect(uiPatternStore.getTopK(1)[0]?.window_title).toBe(firstHash);

    // 再 flush で redacted:redacted:... に二重 hash されないこと
    await uiPatternStore.flushToDisk();
    raw = await fs.readFile(tmpFile, "utf8");
    parsed = JSON.parse(raw);
    expect(parsed.patterns[0].window_title).toBe(firstHash); // 同 hash で安定
    expect(parsed.patterns[0].window_title).not.toMatch(/redacted:redacted:/);
  });
});

// ── PERSIST-13: prototype pollution 防御 (Round 2 P2-2 fix) ─────────────────

describe("PERSIST-13: load 時 disk file の extra field を field allowlist で排除 (P2-2 regression)", () => {
  it("disk file に __proto__ 等の extra field があっても in-memory record に流入しない", async () => {
    process.env.DESKTOP_TOUCH_MEMORY_PERSIST = "1";
    // 攻撃者風の extra field を含む disk payload
    await fs.writeFile(
      tmpFile,
      JSON.stringify({
        version: 1,
        patterns: [
          {
            pattern_id: "pat-A",
            window_title: "Notepad",
            step_count: 3,
            last_seen_at_ms: 1000,
            success_count: 3,
            failure_count: 0,
            example_actions: ["focus_window", "keyboard"],
            // extra fields (field allowlist で drop されるべき)
            malicious_field: "leak-attempt",
            another_unexpected: { nested: "data" },
          },
        ],
      }),
    );
    await uiPatternStore.loadFromDisk();
    const top = uiPatternStore.getTopK(1)[0];
    expect(top).toBeDefined();
    expect(top?.pattern_id).toBe("pat-A");
    expect(top?.window_title).toBe("Notepad");
    // extra field は in-memory record に存在しないこと
    expect((top as Record<string, unknown>)?.malicious_field).toBeUndefined();
    expect(
      (top as Record<string, unknown>)?.another_unexpected,
    ).toBeUndefined();
  });
});

// ── PERSIST-14: env race closure capture (Round 2 P2-4 fix) ────────────────

describe("PERSIST-14: scheduleFlushDebounced で env を closure capture (P2-4 regression)", () => {
  it("schedule 時 env on → mid-flight env off → 予定通り flush (closure snapshot)", async () => {
    process.env.DESKTOP_TOUCH_MEMORY_PERSIST = "1";
    uiPatternStore._setDebounceMsForTest(50);
    seedRecord("pat-A", "Notepad");
    expect(uiPatternStore._hasPendingFlushForTest()).toBe(true);

    // 5s 中途で env を off に flip (race window simulation)
    delete process.env.DESKTOP_TOUCH_MEMORY_PERSIST;

    // debounce 経過待ち
    await new Promise((r) => setTimeout(r, 100));
    expect(uiPatternStore._hasPendingFlushForTest()).toBe(false);

    // closure capture により schedule 時点 on で commit 済 → 予定通り flush 完了
    const raw = await fs.readFile(tmpFile, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.patterns).toHaveLength(1);
    expect(parsed.patterns[0].pattern_id).toBe("pat-A");
  });

  it("schedule 時 env off → schedule そのものが skip (timer 走らない)", async () => {
    delete process.env.DESKTOP_TOUCH_MEMORY_PERSIST;
    uiPatternStore._setDebounceMsForTest(50);
    seedRecord("pat-A", "Notepad");
    expect(uiPatternStore._hasPendingFlushForTest()).toBe(false);
    // 後で env on にしても schedule が走っていないので flush しない
    process.env.DESKTOP_TOUCH_MEMORY_PERSIST = "1";
    await new Promise((r) => setTimeout(r, 100));
    await expect(fs.access(tmpFile)).rejects.toThrow();
  });
});
