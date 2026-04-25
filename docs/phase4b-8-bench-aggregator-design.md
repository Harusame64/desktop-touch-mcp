# Phase 4b-8 設計書 — Bench aggregator + vendor matrix markdown report

- Status: Implemented (2026-04-25) — commits ea5021d (aggregator+tests) / 4206286 (CLI)
- 設計者: Claude (Opus 4.7)
- 実装担当: **Sonnet** (handbook §2 Step B)
- レビュー担当: Opus 4.7 (別 subagent)
- 対応 ADR-005 セクション: §5 4b-8 / L6 (vendor portability)
- 前提 commits: `c4a9a7f`〜`8caa477` (4a〜4b-7 完了)
- 期待工数: **2 日 (Sonnet 実装、TS only、軽量)**

---

## 1. Goal

複数 bench.json (異なる vendor / 環境) を読んで集約し、**README で比較可能な markdown table** を
生成する `BenchAggregator` + CLI を実装。L6 (vendor portability) の発信材料 infra を完成。

実 vendor 測定は user dogfood (RX 9070 XT 必須、CPU、可能なら iGPU/NVIDIA)。
本 batch は **集約 + 表示 infra** のみ、Phase 4 全 Done criteria の最終 piece。

単一目標:

> `node scripts/generate-bench-report.mjs --input bench-rx9070xt.json bench-cpu.json --output BENCH.md`
> 実行で 2 つの bench result を読み、warm p99 / cold latency / capability profile の
> 比較表を含む `BENCH.md` を生成。

### scope 外

- 実機測定 (user dogfood、RX 9070 XT 必須)
- regression detection (4b-7 の bench.json 単発比較は OK、history 追跡は別 ADR)
- README への自動 commit / GitHub Actions 連携 (将来 ADR)
- recall / precision 集約 (annotation データ必要、別 ADR)

---

## 2. Files to touch

### 新規作成

| Path | 役割 | 行数 |
|---|---|---|
| `src/engine/vision-gpu/bench-aggregator.ts` | 複数 BenchmarkResult 読込 + warm p99 / cold latency 統計 + markdown formatter | ~180 |
| `scripts/generate-bench-report.mjs` | CLI: argv → JSON 読込 → markdown 出力 | ~80 |
| `tests/unit/vision-gpu-bench-aggregator.test.ts` | 集約 / formatter / fault path 8+ ケース | ~150 |

### 変更

| Path:行 | 変更内容 |
|---|---|
| `docs/visual-gpu-backend-adr-v2.md §5 4b-8 checklist` | `[x]` flip + summary + Phase 4b 全完了明記 |

### 削除禁止

- 全 Phase 4 skeleton
- BenchmarkHarness / BenchmarkRunner / runAndWrite / warmP99 / defaultBenchPath (4b-7 成果物)
- catch_unwind / kill-switch / Tier ∞

### Forbidden な依存追加

- 新 npm / Rust crate 禁止
- package.json / bin/launcher.js / .github/workflows / src/version.ts / Cargo.toml 変更禁止

---

## 3. API design

### 3.1 `bench-aggregator.ts`

```typescript
/**
 * bench-aggregator.ts — Phase 4b-8 vendor matrix aggregator + markdown report.
 *
 * Reads multiple BenchmarkResult JSON files (one per vendor / environment) and
 * produces:
 *   - `aggregate(results)`: per-vendor warm p99 / cold latency / metric counts
 *   - `formatMarkdownTable(rows)`: GitHub-flavored markdown table
 *
 * Used by `scripts/generate-bench-report.mjs` to publish L6 vendor portability
 * tables in README.
 */

import { readFileSync } from "node:fs";

import type { BenchmarkResult } from "./benchmark.js";
import { warmP99 } from "./bench-runner.js";

export interface VendorRow {
  /** Display label, e.g. "AMD Radeon RX 9070 XT (RDNA4)" */
  label: string;
  /** Source bench.json path (or any unique identifier). */
  source: string;
  /** Warm p99 latency in ms, or null if no warm metrics (evicted run). */
  warmP99Ms: number | null;
  /** Cold latency in ms (first cold metric), or null if absent. */
  coldMs: number | null;
  /** Number of warm samples (sample size for p99 stability). */
  warmSamples: number;
  /** Whether the run completed in "warm" state (false = evicted). */
  ranWarm: boolean;
  /** Notes propagated from the cold metric (e.g. "evicted (state=evicted)..."). */
  notes?: string;
}

/**
 * Convert a single BenchmarkResult into a VendorRow.
 */
export function aggregateOne(result: BenchmarkResult, source: string): VendorRow {
  const cold = result.metrics.find((m) => m.mode === "cold");
  const warm = result.metrics.filter((m) => m.mode === "warm");
  const profile = result.capabilityProfile;
  const label = profile
    ? `${profile.gpuVendor} ${profile.gpuDevice} (${profile.gpuArch})`.trim()
    : `Unknown (${source})`;
  const ranWarm = warm.length > 0;
  return {
    label,
    source,
    warmP99Ms: ranWarm ? warmP99(result) : null,
    coldMs: cold ? cold.latencyMs : null,
    warmSamples: warm.length,
    ranWarm,
    notes: cold?.notes,
  };
}

/**
 * Aggregate multiple BenchmarkResult into a sorted vendor matrix.
 * Sorted by warmP99 ascending (faster vendors first), evicted runs last.
 */
export function aggregate(
  inputs: Array<{ result: BenchmarkResult; source: string }>,
): VendorRow[] {
  const rows = inputs.map(({ result, source }) => aggregateOne(result, source));
  rows.sort((a, b) => {
    if (!a.ranWarm && b.ranWarm) return 1;
    if (a.ranWarm && !b.ranWarm) return -1;
    if (a.warmP99Ms === null && b.warmP99Ms === null) return 0;
    if (a.warmP99Ms === null) return 1;
    if (b.warmP99Ms === null) return -1;
    return a.warmP99Ms - b.warmP99Ms;
  });
  return rows;
}

/**
 * Read a bench.json file and return the parsed BenchmarkResult.
 * Throws on file-not-found / parse error — caller decides how to handle.
 */
export function readBenchFile(path: string): BenchmarkResult {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as BenchmarkResult;
}

/**
 * Generate a GitHub-flavored markdown table from VendorRows.
 *
 * Layout:
 * | Vendor                                | warm p99 | cold | samples | notes |
 * |---------------------------------------|---------:|-----:|--------:|-------|
 * | AMD Radeon RX 9070 XT (RDNA4)         |  18.5 ms | 240 ms | 20 | — |
 * | (evicted) Intel Iris Xe (Xe)          |        — |   — |  0 | artifact missing |
 */
export function formatMarkdownTable(rows: VendorRow[]): string {
  if (rows.length === 0) return "_(no benchmark inputs)_\n";
  const lines: string[] = [];
  lines.push("| Vendor | warm p99 | cold | samples | notes |");
  lines.push("|---|---:|---:|---:|---|");
  for (const r of rows) {
    const w = r.warmP99Ms === null ? "—" : `${r.warmP99Ms.toFixed(1)} ms`;
    const c = r.coldMs === null ? "—" : `${r.coldMs.toFixed(1)} ms`;
    const note = r.notes ? r.notes.replace(/\|/g, "\\|") : (r.ranWarm ? "—" : "_evicted_");
    lines.push(`| ${r.label.replace(/\|/g, "\\|")} | ${w} | ${c} | ${r.warmSamples} | ${note} |`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Generate the full BENCH.md content (table + L1 target callout).
 */
export function formatBenchMarkdown(rows: VendorRow[]): string {
  const banner = [
    "# Visual GPU Phase 4 — Vendor Matrix",
    "",
    "Generated by `scripts/generate-bench-report.mjs` from bench.json files.",
    "",
    "**ADR-005 L1 target**: warm p99 ≤ 30ms (RX 9070 XT dogfood baseline).",
    "**ADR-005 L4 target**: GPU steady-state ≤ 25% (out of scope here, measured separately).",
    "**ADR-005 L6 target**: vendor portability — every vendor cell should show a real warm p99,",
    "no `_evicted_` rows for supported vendors.",
    "",
  ].join("\n");
  return banner + formatMarkdownTable(rows);
}
```

### 3.2 `scripts/generate-bench-report.mjs`

```javascript
#!/usr/bin/env node
/**
 * generate-bench-report.mjs — Phase 4b-8 vendor matrix report generator.
 *
 * Usage:
 *   node scripts/generate-bench-report.mjs \
 *     --input bench-rx9070xt.json bench-cpu.json [...] \
 *     --output BENCH.md
 *
 * Without --output, prints to stdout.
 */

import { writeFileSync } from "node:fs";

import {
  aggregate,
  formatBenchMarkdown,
  readBenchFile,
} from "../dist/engine/vision-gpu/bench-aggregator.js";

const args = process.argv.slice(2);
const inputs = [];
let output;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--input") {
    while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      inputs.push(args[++i]);
    }
  } else if (args[i] === "--output") {
    output = args[++i];
  }
}

if (inputs.length === 0) {
  console.error("ERROR: at least one --input <bench.json> required");
  console.error("Usage: node scripts/generate-bench-report.mjs --input bench-a.json bench-b.json [--output BENCH.md]");
  process.exit(1);
}

const parsed = inputs.map((source) => {
  try {
    return { result: readBenchFile(source), source };
  } catch (err) {
    console.error(`ERROR: failed to read ${source}: ${err}`);
    process.exit(1);
  }
});

const rows = aggregate(parsed);
const md = formatBenchMarkdown(rows);

if (output) {
  writeFileSync(output, md, "utf8");
  console.log(`[bench-report] wrote ${output} (${rows.length} rows)`);
} else {
  process.stdout.write(md);
}
```

---

## 4. Done criteria

- [ ] cargo check 3 features set 全 exit 0 (Rust 変更なし)
- [ ] tsc --noEmit exit 0
- [ ] vitest `vision-gpu-bench-aggregator.test.ts` 全緑 (8+ ケース) + 既存 regression 0
- [ ] 最終 full suite で regression 0
- [ ] ADR-005 §5 4b-8 `[x]` flip + summary + Phase 4b 全 batch 完了明記
- [ ] 設計書 Status → Implemented + commit hash
- [ ] Opus self-review BLOCKING 0

---

## 5. Test cases (8+ ケース)

```typescript
import { describe, it, expect } from "vitest";
import {
  aggregate,
  aggregateOne,
  formatMarkdownTable,
  formatBenchMarkdown,
} from "../../src/engine/vision-gpu/bench-aggregator.js";
import type { BenchmarkResult } from "../../src/engine/vision-gpu/benchmark.js";

function syntheticResult(opts: {
  vendor?: string; arch?: string; device?: string;
  warmLatencies?: number[]; cold?: number; notes?: string;
}): BenchmarkResult {
  const metrics = [];
  if (opts.cold !== undefined) {
    metrics.push({ target: "chrome" as const, mode: "cold" as const, latencyMs: opts.cold, timestampMs: 0, notes: opts.notes });
  }
  for (const ms of opts.warmLatencies ?? []) {
    metrics.push({ target: "chrome" as const, mode: "warm" as const, latencyMs: ms, timestampMs: 0 });
  }
  return {
    runId: "test", startedAtMs: 0, metrics,
    capabilityProfile: opts.vendor ? {
      os: "windows", osBuild: 26100,
      gpuVendor: opts.vendor,
      gpuDevice: opts.device ?? "Test GPU",
      gpuArch: opts.arch ?? "Test",
      gpuVramMb: 8192, winml: false, directml: true,
      rocm: false, cuda: false, tensorrt: false,
      cpuIsa: ["avx2"], backendBuilt: true, epsBuilt: ["directml"],
    } : undefined,
  };
}

describe("aggregateOne", () => {
  it("computes warm p99 and cold latency for a healthy run", () => {
    const r = syntheticResult({
      vendor: "AMD", arch: "RDNA4", device: "RX 9070 XT",
      cold: 240, warmLatencies: [15, 16, 17, 18, 19, 20],
    });
    const row = aggregateOne(r, "rx9070xt.json");
    expect(row.label).toContain("AMD");
    expect(row.label).toContain("RDNA4");
    expect(row.warmSamples).toBe(6);
    expect(row.ranWarm).toBe(true);
    expect(row.coldMs).toBe(240);
    expect(row.warmP99Ms).toBeGreaterThanOrEqual(15);
    expect(row.warmP99Ms).toBeLessThanOrEqual(20);
  });

  it("marks evicted run with ranWarm=false", () => {
    const r = syntheticResult({
      vendor: "Unknown", cold: 5, notes: "evicted (state=evicted)",
    });
    const row = aggregateOne(r, "evicted.json");
    expect(row.ranWarm).toBe(false);
    expect(row.warmP99Ms).toBeNull();
    expect(row.warmSamples).toBe(0);
    expect(row.notes).toMatch(/evicted/);
  });

  it("falls back to source label when capabilityProfile missing", () => {
    const r = syntheticResult({ warmLatencies: [10] });
    const row = aggregateOne(r, "no-profile.json");
    expect(row.label).toContain("Unknown");
    expect(row.label).toContain("no-profile.json");
  });
});

describe("aggregate", () => {
  it("sorts by warm p99 ascending (faster first)", () => {
    const slow = syntheticResult({ vendor: "Slow", warmLatencies: [50, 50, 50] });
    const fast = syntheticResult({ vendor: "Fast", warmLatencies: [10, 10, 10] });
    const rows = aggregate([
      { result: slow, source: "slow.json" },
      { result: fast, source: "fast.json" },
    ]);
    expect(rows[0]!.label).toContain("Fast");
    expect(rows[1]!.label).toContain("Slow");
  });

  it("places evicted rows last", () => {
    const evicted = syntheticResult({ vendor: "Evicted", cold: 5 });
    const ok = syntheticResult({ vendor: "OK", warmLatencies: [10] });
    const rows = aggregate([
      { result: evicted, source: "e.json" },
      { result: ok, source: "ok.json" },
    ]);
    expect(rows[0]!.label).toContain("OK");
    expect(rows[1]!.label).toContain("Evicted");
    expect(rows[1]!.ranWarm).toBe(false);
  });

  it("returns empty array on empty input", () => {
    expect(aggregate([])).toEqual([]);
  });
});

describe("formatMarkdownTable", () => {
  it("returns placeholder for empty rows", () => {
    expect(formatMarkdownTable([])).toMatch(/no benchmark inputs/);
  });

  it("escapes pipe characters in labels and notes", () => {
    const rows = [{
      label: "Acme | Inc.",
      source: "x.json",
      warmP99Ms: 10, coldMs: 100, warmSamples: 5,
      ranWarm: true, notes: "good | run",
    }];
    const md = formatMarkdownTable(rows);
    expect(md).toContain("Acme \\| Inc.");
    expect(md).toContain("good \\| run");
  });

  it("renders evicted rows with em-dash and italic note", () => {
    const rows = [{
      label: "Test",
      source: "x.json",
      warmP99Ms: null, coldMs: null, warmSamples: 0,
      ranWarm: false,
    }];
    const md = formatMarkdownTable(rows);
    expect(md).toContain("_evicted_");
    expect(md).toMatch(/—/); // em-dash for missing values
  });
});

describe("formatBenchMarkdown", () => {
  it("includes ADR-005 L1/L4/L6 callouts", () => {
    const md = formatBenchMarkdown([]);
    expect(md).toMatch(/L1.*30ms/);
    expect(md).toMatch(/L4.*25%/);
    expect(md).toMatch(/L6.*portability/);
  });
});
```

---

## 6. Known traps

| 罠 | 対策 |
|---|---|
| BenchmarkResult.capabilityProfile が undefined (4b-7 evicted run) | aggregateOne で `Unknown (${source})` fallback |
| markdown table の pipe char escape (label / notes 内) | `replace(/\|/g, "\\|")` で escape |
| empty rows | `formatMarkdownTable` で placeholder text 返す |
| inputs と sources の長さ不一致 | API は `Array<{result, source}>` でペア渡し、長さ同期は caller 責務 |
| `readBenchFile` の error は CLI 側で catch、aggregator は throw |
| ADR §5 4b-8 entry が「最終 batch」と明記 | summary に Phase 4b 全完了を書く |
| sort stability (同 p99 で順序保証なし) | ベンチ用途では問題なし、安定 sort は明示しない |

---

## 7. Acceptable Sonnet judgment scope

- markdown formatter の細部 (table column 順、注記文言)
- argv parse の細部 (--input multi-arg vs comma-separated)
- ADR §5 4b-8 summary の wording (Phase 4b 全完了の announcement 含めて)
- commit 分割 (推奨 2-3: aggregator+tests / scripts / docs)

---

## 8. Forbidden Sonnet judgments

- 既存 Phase 4 全 skeleton 変更禁止
- BenchmarkHarness / BenchmarkRunner / warmP99 / OnnxBackend signature 不変
- 新 crate 追加禁止
- package.json / Cargo.toml / bin/launcher.js / workflows / version 変更禁止
- 既存 test 書換禁止
- regression detection / GitHub Actions 連携禁止 (将来 ADR)
- recall / precision 集約禁止 (annotation データ別途)

---

## 9. Future work (Phase 4c 候補)

- regression detection: 過去 N 回の bench.json を比較、p99 が前回比 +20% で fail
- GitHub Actions PR comment 自動投稿
- README 自動更新 (CI で BENCH.md → README append)
- Recall / precision aggregator (annotation データ整備後)
- Phase 4c: fine-tuned detector + DSL + 公開

---

## 10. 実装順序

1. `src/engine/vision-gpu/bench-aggregator.ts` 新規作成 (§3.1 全体)
2. `scripts/generate-bench-report.mjs` 新規作成 (§3.2)
3. `tests/unit/vision-gpu-bench-aggregator.test.ts` 新規作成 (§5 8+ ケース)
4. tsc --noEmit exit 0
5. vitest 個別実行で 8+ ケース pass
6. 既存 6 test file regression 0
7. cargo check 3 features set fresh check
8. `npm run test:capture -- --force` 最終 1 回 (regression 0)
9. ADR-005 §5 4b-8 `[x]` flip + Phase 4b 全完了明記
10. 設計書 Status → Implemented + commit hash
11. commit 分割 (推奨 3): aggregator+tests / scripts / docs
12. push origin
13. Opus self-review (本人 Opus session 別途)
14. notification + handbook §6.1 報告

END.
