# Phase 4b-7 設計書 — BenchmarkRunner (cold/warm/idle 測定 + bench.json 永続化)

- Status: Implemented (2026-04-25) — commits `6b2b329` (bench-runner + benchmark拡張) / `7dfe2da` (scripts + tests)
- 設計者: Claude (Opus 4.7)
- 実装担当: **Sonnet** (handbook §2 Step B)
- レビュー担当: Opus 4.7 (別 subagent)
- 対応 ADR-005 セクション: §2 L1 (warm latency) / §3 D5' / §5 4b-7
- 前提 commits: `c4a9a7f`〜`20da5dd` (4a〜4b-6 完了)
- 期待工数: **2-3 日 (Sonnet 実装、TS 中心)**

---

## 1. Goal

既存 `BenchmarkHarness` を `OnnxBackend` + `runStagePipeline` と接続し、
**cold / warm / idle 3 mode** の latency を測定して `~/.desktop-touch-mcp/bench.json` に
永続化する `BenchmarkRunner` を実装。実機 dogfood で `node scripts/run-bench.mjs` 起動可能。

L1 (warm p99 ≤ 30ms) / L4 (GPU ≤ 25%) / L6 (vendor portability) 計測 infra を完成させる。
実測値は user dogfood 必須、本 batch は **infra のみ**。

単一目標:

> `node scripts/run-bench.mjs --target=test --frames=20` 実行で OnnxBackend warm-up →
> 20 frame 推論測定 → `~/.desktop-touch-mcp/bench.json` に `BenchmarkResult` 書き出し。
> Artifact 不在時は warm-up 失敗 → "evicted" → bench result に `notes: "evicted"` 記録 + skip。

### scope 外

- 実機実測 (user dogfood)
- vendor matrix 自動切替 (4b-8)
- Recall / precision 測定 (annotation データ要、別 ADR)
- GPU usage / VRAM 計測 (Windows perf counter API、別 ADR)
- フレーム動画再生 (replay-backend.ts 別途)

---

## 2. Files to touch

### 新規作成

| Path | 役割 | 行数 |
|---|---|---|
| `src/engine/vision-gpu/bench-runner.ts` | `BenchmarkRunner` クラス: OnnxBackend wiring + cold/warm/idle scenario + JSON 永続化 | ~220 |
| `scripts/run-bench.mjs` | CLI entry: argv parse → runBench → bench.json 書き出し | ~120 |
| `tests/unit/vision-gpu-bench-runner.test.ts` | mock OnnxBackend + scenario 実行 / JSON 形式 / fault path | ~180 |

### 変更

| Path:行 | 変更内容 |
|---|---|
| `src/engine/vision-gpu/benchmark.ts` | `BenchmarkResult` に optional `capabilityProfile` field 追加 (L6 vendor matrix 出力用、4b-8 で活用) |
| `docs/visual-gpu-backend-adr-v2.md §5 4b-7 checklist` | `[x]` flip + summary (実測値は user dogfood) |

### 削除禁止

- 全 Phase 4 skeleton (florence2 / omniparser / paddleocr / cross-check / stage-pipeline / model-registry)
- `BenchmarkHarness` 既存 method (`measure` / `record` / `getMetrics` / `toResult`)
- `replay-backend.ts` (将来 frame 再生用)
- `catch_unwind` barrier / kill-switch / Tier ∞

### Forbidden な依存追加

- 新 npm package 禁止
- 新 Rust crate 禁止
- `package.json` 変更禁止 (npm script は追加しない、`node scripts/run-bench.mjs` 直接起動)
- `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

---

## 3. API design

### 3.1 `BenchmarkResult` 拡張

```typescript
// benchmark.ts に追加
import type { NativeCapabilityProfile } from "../native-types.js";

export interface BenchmarkResult {
  runId: string;
  startedAtMs: number;
  metrics: BenchmarkMetrics[];
  /** Phase 4b-7: capability profile snapshot at run start (used by 4b-8 vendor matrix). */
  capabilityProfile?: NativeCapabilityProfile;
}
```

### 3.2 `BenchmarkRunner` (bench-runner.ts)

```typescript
/**
 * bench-runner.ts — Phase 4b-7 cold/warm/idle benchmark orchestrator.
 *
 * Wires `BenchmarkHarness` with `OnnxBackend` to produce `BenchmarkResult`
 * suitable for ADR-005 L1 (warm p99 ≤ 30ms) / L4 (GPU ≤ 25%) / L6 (vendor portability)
 * verification. Writes results to `~/.desktop-touch-mcp/bench.json`.
 *
 * Scope:
 *   - cold: first inference after warm-up (slow path)
 *   - warm: N consecutive inferences (steady state, target metric)
 *   - idle: time delta between frames (no work)
 *
 * Tier ∞ wiring is *not* benchmarked here — that's a separate dogfood scenario.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { OnnxBackend } from "./onnx-backend.js";
import { BenchmarkHarness, type BenchmarkResult, type BenchmarkTarget } from "./benchmark.js";
import { nativeVision } from "../native-engine.js";

export interface BenchRunOptions {
  /** Target identifier — recorded in metrics; also used as targetKey in recognizeRois. */
  target: BenchmarkTarget;
  /** Number of warm iterations (default 20). */
  warmFrames?: number;
  /** Synthesized frame width × height (default 1920×1080). */
  frameWidth?: number;
  frameHeight?: number;
  /** Output path for bench.json (default ~/.desktop-touch-mcp/bench.json). */
  outputPath?: string;
}

/**
 * Default bench output path. Per ADR-005 §3 D2': "bench.json" cache lives
 * under `~/.desktop-touch-mcp/` so it survives across npm reinstalls.
 */
export function defaultBenchPath(): string {
  return join(homedir(), ".desktop-touch-mcp", "bench.json");
}

export class BenchmarkRunner {
  private readonly harness = new BenchmarkHarness();

  async run(opts: BenchRunOptions): Promise<BenchmarkResult> {
    const w = opts.frameWidth ?? 1920;
    const h = opts.frameHeight ?? 1080;

    // Capture capability profile early so it's preserved even on backend failure.
    const profile = nativeVision?.detectCapability?.();

    const backend = new OnnxBackend();
    const warmStart = performance.now();
    const state = await backend.ensureWarm({ kind: opts.target, id: `bench-${opts.target}` });
    const warmupMs = performance.now() - warmStart;

    if (state !== "warm") {
      // Artifact missing or backend not built — record skip and return.
      this.harness.record({
        target: opts.target,
        mode: "cold",
        latencyMs: warmupMs,
        timestampMs: Date.now(),
        notes: `evicted (state=${state}) — artifact likely missing`,
      });
      const result = this.harness.toResult();
      result.capabilityProfile = profile;
      return result;
    }

    // Synthesize a frame buffer (mid-grey RGBA) — real dogfood replaces this with DXGI capture.
    const frameBuffer = Buffer.alloc(w * h * 4, 0x80);
    const rois = [{ trackId: "bench-roi-0", rect: { x: 0, y: 0, width: w, height: h } }];

    // Cold: first inference (model warm-up + GPU pipeline init)
    await this.harness.measure(opts.target, "cold", async () => {
      await backend.recognizeRois(opts.target, rois, w, h, frameBuffer);
    });

    // Warm: N consecutive inferences (steady state)
    const warmFrames = opts.warmFrames ?? 20;
    for (let i = 0; i < warmFrames; i++) {
      await this.harness.measure(opts.target, "warm", async () => {
        await backend.recognizeRois(opts.target, rois, w, h, frameBuffer);
      });
    }

    // Idle: short pause to record timestamp (sentinel for downstream ratio analysis)
    await this.harness.measure(opts.target, "idle", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await backend.dispose();
    const result = this.harness.toResult();
    result.capabilityProfile = profile;
    return result;
  }
}

/**
 * Convenience: run + write to disk.
 * Returns the path written + the result.
 */
export async function runAndWrite(
  opts: BenchRunOptions,
): Promise<{ path: string; result: BenchmarkResult }> {
  const runner = new BenchmarkRunner();
  const result = await runner.run(opts);
  const path = opts.outputPath ?? defaultBenchPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result, null, 2), "utf8");
  return { path, result };
}

/**
 * Compute warm-mode p99 latency from a result. Returns -1 if no warm metrics.
 */
export function warmP99(result: BenchmarkResult): number {
  const warm = result.metrics.filter((m) => m.mode === "warm").map((m) => m.latencyMs);
  if (warm.length === 0) return -1;
  warm.sort((a, b) => a - b);
  const idx = Math.min(warm.length - 1, Math.floor(warm.length * 0.99));
  return warm[idx]!;
}
```

### 3.3 `scripts/run-bench.mjs`

```javascript
#!/usr/bin/env node
/**
 * run-bench.mjs — Phase 4b-7 CLI for benchmark dogfood.
 *
 * Usage: node scripts/run-bench.mjs [--target=chrome|terminal|game]
 *                                    [--frames=N]
 *                                    [--output=path/to/bench.json]
 *                                    [--width=W --height=H]
 *
 * Requires: real Florence-2 / OmniParser-v2 / PaddleOCR-v4 ONNX artifacts in
 * ~/.desktop-touch-mcp/models/ + ORT_DYLIB_PATH set. Without artifacts, the
 * runner records an "evicted" cold metric and exits 0 with a clear message.
 *
 * Exit codes:
 *   0 = bench completed (regardless of warm vs evicted)
 *   1 = invalid arguments / file write failure
 */

import { runAndWrite, warmP99 } from "../dist/engine/vision-gpu/bench-runner.js";

function parseArg(name, fallback) {
  const idx = process.argv.findIndex((a) => a.startsWith(`--${name}=`));
  return idx === -1 ? fallback : process.argv[idx].slice(name.length + 3);
}

const target = parseArg("target", "chrome");
const framesStr = parseArg("frames", "20");
const widthStr = parseArg("width", "1920");
const heightStr = parseArg("height", "1080");
const outputPath = parseArg("output", undefined);

const warmFrames = Number.parseInt(framesStr, 10);
const frameWidth = Number.parseInt(widthStr, 10);
const frameHeight = Number.parseInt(heightStr, 10);

if (!["chrome", "terminal", "game"].includes(target)) {
  console.error(`ERROR: unknown target "${target}" (allowed: chrome, terminal, game)`);
  process.exit(1);
}
if (!Number.isFinite(warmFrames) || warmFrames < 1) {
  console.error(`ERROR: invalid --frames=${framesStr}`);
  process.exit(1);
}

console.log(`[bench] target=${target} frames=${warmFrames} ${frameWidth}x${frameHeight}`);

try {
  const { path, result } = await runAndWrite({
    target, warmFrames, frameWidth, frameHeight, outputPath,
  });
  const p99 = warmP99(result);
  console.log(`[bench] wrote ${path}`);
  console.log(`[bench] runId=${result.runId}`);
  console.log(`[bench] capability=${result.capabilityProfile?.gpuVendor ?? "?"} ${result.capabilityProfile?.gpuArch ?? "?"}`);
  console.log(`[bench] metrics=${result.metrics.length}`);
  if (p99 >= 0) {
    console.log(`[bench] warm p99 = ${p99.toFixed(2)}ms (target ≤ 30ms)`);
  } else {
    console.log("[bench] no warm metrics (likely evicted — see notes in bench.json)");
  }
  process.exit(0);
} catch (err) {
  console.error("[bench] failed:", err);
  process.exit(1);
}
```

---

## 4. Done criteria

- [ ] cargo check 3 features set 全 exit 0 (本 batch Rust 変更なし)
- [ ] tsc --noEmit exit 0
- [ ] vitest `vision-gpu-bench-runner.test.ts` 全緑 (8+ ケース)
- [ ] 既存 vitest regression 0
- [ ] 最終 full suite で regression 0
- [ ] ADR-005 §5 4b-7 `[x]` flip + summary (実測は user dogfood 注記)
- [ ] 設計書 Status → Implemented + commit hash
- [ ] Opus self-review BLOCKING 0
- [ ] `node scripts/run-bench.mjs --help` 等で argv parse error 0

---

## 5. Test cases (8+ ケース)

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BenchmarkRunner, runAndWrite, warmP99, defaultBenchPath } from "../../src/engine/vision-gpu/bench-runner.js";

describe("BenchmarkRunner", () => {
  beforeEach(() => vi.resetModules());

  it("records evicted metric when ensureWarm fails", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: {
        detectCapability: vi.fn().mockReturnValue({ /* AMD profile */ }),
      },
      nativeEngine: null, nativeUia: null,
    }));
    vi.doMock("../../src/engine/vision-gpu/onnx-backend.js", () => ({
      OnnxBackend: class {
        async ensureWarm() { return "evicted"; }
        async dispose() {}
        async recognizeRois() { return []; }
      },
    }));
    const { BenchmarkRunner } = await import("../../src/engine/vision-gpu/bench-runner.js");
    const runner = new BenchmarkRunner();
    const result = await runner.run({ target: "chrome", warmFrames: 5 });
    expect(result.metrics.length).toBe(1);
    expect(result.metrics[0]!.mode).toBe("cold");
    expect(result.metrics[0]!.notes).toMatch(/evicted/);
  });

  it("records cold + warm + idle metrics on successful warm-up", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: { detectCapability: vi.fn().mockReturnValue(/* profile */) },
      nativeEngine: null, nativeUia: null,
    }));
    vi.doMock("../../src/engine/vision-gpu/onnx-backend.js", () => ({
      OnnxBackend: class {
        async ensureWarm() { return "warm"; }
        async recognizeRois() { return []; }
        async dispose() {}
      },
    }));
    const { BenchmarkRunner } = await import("../../src/engine/vision-gpu/bench-runner.js");
    const runner = new BenchmarkRunner();
    const result = await runner.run({ target: "chrome", warmFrames: 3 });
    const cold = result.metrics.filter((m) => m.mode === "cold");
    const warm = result.metrics.filter((m) => m.mode === "warm");
    const idle = result.metrics.filter((m) => m.mode === "idle");
    expect(cold).toHaveLength(1);
    expect(warm).toHaveLength(3);
    expect(idle).toHaveLength(1);
  });

  it("captures capability profile in result", async () => {
    const profile = { gpuVendor: "AMD", gpuArch: "RDNA4" };
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: { detectCapability: vi.fn().mockReturnValue(profile) },
      nativeEngine: null, nativeUia: null,
    }));
    vi.doMock("../../src/engine/vision-gpu/onnx-backend.js", () => ({
      OnnxBackend: class {
        async ensureWarm() { return "warm"; }
        async recognizeRois() { return []; }
        async dispose() {}
      },
    }));
    const { BenchmarkRunner } = await import("../../src/engine/vision-gpu/bench-runner.js");
    const result = await new BenchmarkRunner().run({ target: "chrome", warmFrames: 1 });
    expect(result.capabilityProfile).toMatchObject({ gpuVendor: "AMD" });
  });

  it("warmP99 returns -1 for empty metrics", () => {
    expect(warmP99({ runId: "x", startedAtMs: 0, metrics: [] })).toBe(-1);
  });

  it("warmP99 picks the 99th-percentile latency", () => {
    const metrics = Array.from({ length: 100 }, (_, i) => ({
      target: "chrome" as const,
      mode: "warm" as const,
      latencyMs: i + 1,  // 1..100
      timestampMs: 0,
    }));
    const result = { runId: "x", startedAtMs: 0, metrics };
    // 99th percentile of [1..100] should be near 99 (floor(100*0.99) = 99 → metrics[99] = 100)
    const p99 = warmP99(result);
    expect(p99).toBeGreaterThanOrEqual(99);
    expect(p99).toBeLessThanOrEqual(100);
  });

  it("warmP99 ignores cold/idle metrics", () => {
    const result = {
      runId: "x", startedAtMs: 0,
      metrics: [
        { target: "chrome" as const, mode: "cold" as const, latencyMs: 1000, timestampMs: 0 },
        { target: "chrome" as const, mode: "warm" as const, latencyMs: 20, timestampMs: 0 },
        { target: "chrome" as const, mode: "idle" as const, latencyMs: 50, timestampMs: 0 },
      ],
    };
    expect(warmP99(result)).toBe(20);
  });

  it("defaultBenchPath produces ~/.desktop-touch-mcp/bench.json", () => {
    const p = defaultBenchPath();
    expect(p).toMatch(/\.desktop-touch-mcp[\/\\]bench\.json$/);
  });

  it("runAndWrite writes JSON to specified path", async () => {
    vi.doMock("../../src/engine/native-engine.js", () => ({
      nativeVision: { detectCapability: vi.fn().mockReturnValue({ gpuVendor: "AMD" }) },
      nativeEngine: null, nativeUia: null,
    }));
    vi.doMock("../../src/engine/vision-gpu/onnx-backend.js", () => ({
      OnnxBackend: class {
        async ensureWarm() { return "warm"; }
        async recognizeRois() { return []; }
        async dispose() {}
      },
    }));
    const tmpDir = await import("node:os").then((m) => m.tmpdir());
    const join = (await import("node:path")).join;
    const fs = await import("node:fs");
    const outputPath = join(tmpDir, `bench-test-${Date.now()}.json`);
    const { runAndWrite } = await import("../../src/engine/vision-gpu/bench-runner.js");
    const { path } = await runAndWrite({ target: "chrome", warmFrames: 1, outputPath });
    expect(path).toBe(outputPath);
    expect(fs.existsSync(outputPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    expect(parsed.runId).toBeDefined();
    fs.unlinkSync(outputPath);
  });
});
```

---

## 6. Known traps

| 罠 | 対策 |
|---|---|
| `OnnxBackend` 内部で `nativeVision` 呼出 → mock が必要 | test では `vi.doMock` で OnnxBackend 全体を差し替え |
| `~/.desktop-touch-mcp/` ディレクトリ未作成 | `mkdirSync(..., { recursive: true })` で defensive |
| Synthetic mid-grey frame では Stage 1〜3 が空候補返す可能性 | OK、warm latency は inference 実行時間そのもの (空入力でも model forward は走る) |
| `performance.now()` 精度問題 | typical 1ms 単位、十分 |
| `tsdocs.ts` から TS で読める export 規律 | 全 export named (`BenchmarkRunner` / `runAndWrite` / `warmP99` / `defaultBenchPath` / `BenchRunOptions`) |
| `BenchmarkResult.capabilityProfile` の型 import | `NativeCapabilityProfile` を `native-types.ts` から import |
| run-bench.mjs が `dist/` を import (ESM) | 既存 Phase 4 cli pattern と一致 (build 必須、注意書き) |
| Tier ∞ fallback が cross-check 経由でしか呼ばれない | bench は cross-check 無効 default、Tier ∞ 経路は別 dogfood |
| 連続実行で Rust pool に session 残留 | OnnxBackend.dispose() で TS 側 stageKeys=null、Rust pool は process 寿命と一致 (memory leak 影響小) |

---

## 7. Acceptable Sonnet judgment scope

- run-bench.mjs argv parse の細部 (`--key=value` vs `--key value` の処理)
- frame buffer 中身 (mid-grey 0x80 推奨だが random も可)
- p99 計算の boundary (floor vs ceil、設計書は floor)
- test fixture path 命名
- commit 分割 (推奨 3-4: bench-runner / scripts / tests / docs)

---

## 8. Forbidden Sonnet judgments

- 既存 Phase 4 全 skeleton 変更禁止
- VisualBackend / ModelRegistry / OnnxBackend / RecognizeRequest 不変
- catch_unwind / kill-switch / Tier ∞ 維持
- package.json / bin/launcher.js / .github/workflows / src/version.ts / Cargo.toml 変更禁止
- 新 npm / Rust crate 追加禁止
- 既存 test 書換禁止
- vendor matrix orchestration 実装禁止 (4b-8)
- DXGI zero-copy 統合禁止
- Recall / precision / GPU usage 測定実装禁止 (別 ADR)

---

## 9. Future work (4b-8)

- vendor matrix runner: 複数 capability profile (AMD/NVIDIA/Intel/CPU-only) で連続実行
- bench-comparator: 過去 bench.json と diff、regression 検出
- README にベンチ結果テーブル自動更新

---

## 10. 実装順序

1. `benchmark.ts::BenchmarkResult` に `capabilityProfile?` 追加
2. `bench-runner.ts` 新規作成 (§3.2 全体)
3. `scripts/run-bench.mjs` 新規作成 (§3.3)、shebang + chmod 不要 (Windows なので node 経由起動)
4. `tests/unit/vision-gpu-bench-runner.test.ts` 新規作成 (§5 8+ ケース)
5. tsc --noEmit exit 0
6. vitest 個別実行で 8+ ケース pass
7. 既存 5 test file regression 0 (cross-check / stage-pipeline / onnx-backend / model-registry / session)
8. cargo check 3 features set fresh check
9. `npm run test:capture -- --force` 最終 1 回
10. ADR-005 §5 4b-7 `[x]` flip + summary
11. 設計書 Status → Implemented + commit hash
12. commit 分割 (推奨 3): bench-runner+benchmark拡張 / run-bench.mjs+tests / docs
13. push origin
14. Opus self-review (本人 Opus session 別途)
15. notification + handbook §6.1 報告

END.
