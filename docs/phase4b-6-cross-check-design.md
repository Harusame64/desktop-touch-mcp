# Phase 4b-6 設計書 — Cross-check (multi-engine OCR voting) + win-ocr Tier ∞ 接続

- Status: Implemented (2026-04-25) — commits `0d7eae9`〜`6d16c36` + post-review B1 fix

**Post-review addendum (Opus review 2026-04-25、BLOCKING 1 → 0)**:
- **BLOCKING B1 修正**: `winOcrTierInfinity` が空 stdin で win-ocr.exe を呼ぶ ghost fallback だった問題を解消。`WinOcrFallbackFn` signature に `frameBuffer / frameWidth / frameHeight` を追加し、`sharp` で rect crop → PNG → win-ocr.exe stdin (async spawn) で本格 Tier ∞ fallback に変更
- **R1 修正**: stage3 + stage3b の並列化 (sequential await → `Promise.all([primaryReq, secondaryReq])`)
- **R2 修正**: `await import("./cross-check.js")` → static `import { crossCheckLabels }` に変更
- **R4 修正**: `winOcrFallback` throw 時に `console.warn` 追加
- 残: R3 (confidence 0.5 マジックナンバーのコメント追加) / N1 (secondary-only 時の provisional 維持) / N2 (JSON.parse コメント) / N3 (ADR 文言「14 ケース + 1」修正) は将来 batch
- cross-check test に「frameBuffer 欠落時 fallback skip」ケース 1 件追加 (16 → 17 ケース)
- 設計者: Claude (Opus 4.7)
- 実装担当: **Sonnet** (handbook §2 Step B)
- レビュー担当: Opus 4.7 (別 subagent)
- 対応 ADR-005 セクション: D3' (multi-engine voting) / Tier ∞ (win-ocr.exe safety net)
- 対応 ADR-005 §5 batch: 4b-6
- 前提 commits: `c4a9a7f`〜`ff12bb8` (4a〜4b-5c 完了、Stage 1/2/3 pipeline 完結)
- 期待工数: **3-4 日 (Sonnet 実装、TS 中心 + Rust 少量)**

---

## 1. Goal

ADR-005 §3 D3' の **cross-check (multi-engine voting)** を実装し、Stage 3 OCR の信頼度を
Levenshtein distance ベースの投票で向上させる。同時に **win-ocr.exe (Tier ∞) を最終 fallback**
として stage pipeline の最後の safety net 経路に明示接続する。

単一目標:

> `DESKTOP_TOUCH_VISUAL_CROSS_CHECK=1` 有効時、`OnnxBackend.ensureWarm` が
> PaddleOCR-v4-server と PaddleOCR-v4-mobile の **両方** を Stage 3 として load し、
> `runStagePipeline` が text-class 候補に対して両 engine を並列実行。
> Levenshtein distance が threshold 以下なら server 結果採用 (provisional=false)、
> それ以上なら両方 provisional=true で label 保持。
> どちらも失敗 / 空 label の場合は **win-ocr.exe (既存 bin)** を呼んで Tier ∞ fallback。

### scope 外

- Florence-2 icon_caption / GOT-OCR2 / Surya などの追加 engine — 将来 ADR
- Cross-check の **3-way voting** (server + mobile + 3rd engine) — 本 batch は 2-way のみ
- Benchmark (4b-7) / vendor matrix (4b-8)
- DXGI zero-copy — Phase 4c
- Cross-check を Rust 側で実装 — 本 batch は **TS 側** で実装 (win-ocr が既に TS 側 bin、統合が自然)

---

## 2. Files to touch

### 新規作成

| Path | 役割 | 推定行数 |
|---|---|---|
| `src/engine/vision-gpu/cross-check.ts` | Levenshtein distance 計算 + arbitration logic (server 優先 / 不一致時 provisional) + win-ocr fallback 呼び出し | ~220 |
| `tests/unit/vision-gpu-cross-check.test.ts` | cross-check unit tests (Levenshtein / arbitration / win-ocr fallback) | ~200 |

### 変更

| Path:行 | 変更内容 |
|---|---|
| `src/engine/vision-gpu/stage-pipeline.ts::StageSessionKeys` | Optional field `stage3b?: string` 追加 (PaddleOCR-mobile session、cross-check 有効時のみ設定) |
| `src/engine/vision-gpu/stage-pipeline.ts::runStagePipeline` | `keys.stage3b` が非 null の時、stage3 と stage3b を **並列実行**、戻り値を `crossCheckLabels(primary, secondary, winOcrFallback)` に渡す |
| `src/engine/vision-gpu/onnx-backend.ts::ensureWarm` | 環境変数 `DESKTOP_TOUCH_VISUAL_CROSS_CHECK === "1"` なら PaddleOCR-mobile の `visionInitSession` を追加 (4 session → 5 session)、stageKeys に stage3b を格納 |
| `src/engine/vision-gpu/onnx-backend.ts::recognizeRois` | win-ocr fallback 呼び出し用の callback を `runStagePipeline` に渡す (cross-check 内部から呼ばれる) |
| `docs/visual-gpu-backend-adr-v2.md §5 4b-6 checklist` | `[x]` flip + summary |

### 削除禁止

- 全 Phase 4 skeleton (Florence-2 / OmniParser / PaddleOCR / session_pool / model-registry / stage-pipeline)
- `PocVisualBackend` / `bin/win-ocr.exe` (本 batch では **使用拡大**、削除絶対禁止)
- `catch_unwind` barrier
- `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND` / `DESKTOP_TOUCH_DISABLE_VISUAL_GPU` kill-switch

### Forbidden な依存追加

- 新 npm package 禁止 (Levenshtein は手書き実装、~30 行)
- 新 Rust crate 禁止 (本 batch は Rust 側 paddleocr-mobile 経路を活用するのみ、新 code 無し)
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

---

## 3. API design

### 3.1 TS: `cross-check.ts` 新規 module

```typescript
/**
 * cross-check.ts — Phase 4b-6 multi-engine OCR voting.
 *
 * Arbitrates between two OCR engines (PaddleOCR-v4-server as primary,
 * PaddleOCR-v4-mobile as secondary) using Levenshtein distance. Falls through
 * to win-ocr.exe (Tier ∞) when both engines produce empty / mismatched output
 * beyond the acceptable threshold.
 *
 * ADR-005 §3 D3': distance < 0.2 ratio → primary wins, else both provisional.
 */

import type { NativeRawCandidate } from "../native-types.js";

/** Max normalized Levenshtein distance for primary to win unconditionally. */
export const CROSS_CHECK_AGREEMENT_THRESHOLD = 0.2;

/** Optional Tier ∞ fallback function. Invoked per-candidate when both engines
 *  produce empty labels. Should return a label string (or empty on failure). */
export type WinOcrFallbackFn = (
  targetKey: string,
  rect: { x: number; y: number; width: number; height: number },
) => Promise<string>;

/**
 * Compute normalized Levenshtein distance (0 = identical, 1 = totally different).
 * Pure TS implementation, no dependencies. O(m*n) DP.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0 || b.length === 0) return 1;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insert
        prev[j] + 1,            // delete
        prev[j - 1] + cost,     // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }
  const raw = prev[n];
  return raw / Math.max(m, n);
}

/**
 * Arbitrate between primary (server) and secondary (mobile) outputs.
 * Returns the merged candidate list keyed by trackId.
 *
 * Rules:
 *   - If both labels non-empty AND distance < threshold → use primary label,
 *     confidence = max(primary, secondary), provisional = false (agreed)
 *   - If both labels non-empty AND distance >= threshold → use primary label,
 *     provisional = true (disagreement), confidence slightly penalised
 *   - If only primary has label → use primary as-is (provisional from primary)
 *   - If only secondary has label → use secondary
 *   - If both empty → call winOcrFallback if provided, else return primary unchanged
 */
export async function crossCheckLabels(
  primary: NativeRawCandidate[],
  secondary: NativeRawCandidate[],
  options?: {
    threshold?: number;
    winOcrFallback?: WinOcrFallbackFn;
    targetKey?: string;
  },
): Promise<NativeRawCandidate[]> {
  const threshold = options?.threshold ?? CROSS_CHECK_AGREEMENT_THRESHOLD;
  const byTrackId = new Map(secondary.map((c) => [c.trackId, c]));
  const out: NativeRawCandidate[] = [];

  for (const p of primary) {
    const s = byTrackId.get(p.trackId);
    if (!s) {
      // No secondary counterpart — use primary as-is.
      out.push(p);
      continue;
    }
    const pLabel = p.label || "";
    const sLabel = s.label || "";

    if (pLabel !== "" && sLabel !== "") {
      const dist = levenshteinDistance(pLabel, sLabel);
      if (dist < threshold) {
        // Agreement — promote confidence, mark non-provisional.
        out.push({
          ...p,
          label: pLabel,
          confidence: Math.max(p.confidence, s.confidence),
          provisional: false,
        });
      } else {
        // Disagreement — keep primary label but mark provisional.
        out.push({
          ...p,
          label: pLabel,
          confidence: Math.min(p.confidence, 0.6),
          provisional: true,
        });
      }
      continue;
    }

    if (pLabel !== "") { out.push(p); continue; }
    if (sLabel !== "") { out.push({ ...p, label: sLabel, confidence: s.confidence }); continue; }

    // Both empty → Tier ∞ fallback if provided.
    if (options?.winOcrFallback) {
      try {
        const fallback = await options.winOcrFallback(options.targetKey ?? "", p.rect);
        out.push({ ...p, label: fallback, confidence: fallback ? 0.5 : 0.3, provisional: true });
      } catch {
        out.push(p);
      }
    } else {
      out.push(p);
    }
  }
  return out;
}
```

### 3.2 TS: `stage-pipeline.ts` 拡張

```typescript
// StageSessionKeys に stage3b 追加
export interface StageSessionKeys {
  stage1: string;
  stage2: string;
  stage3: string;
  /** Phase 4b-6: optional secondary OCR (PaddleOCR-mobile) for cross-check.
   *  When set, `runStagePipeline` runs stage3 and stage3b in parallel and
   *  arbitrates via `crossCheckLabels`. */
  stage3b?: string;
}

// runStagePipeline の Stage 3 部分を拡張
// ... existing stage1 / stage2 code unchanged ...

// Stage 3: OCR over text-class candidates
const textCandidates = stage2.filter((c) => isTextClass(c.class));
if (textCandidates.length === 0) return stage2;

const stage3Primary = await visionRecognize({
  targetKey: input.targetKey,
  sessionKey: keys.stage3,
  rois: textCandidates.map((c) => ({
    trackId: c.trackId, rect: c.rect, classHint: c.class || null,
  })),
  frameWidth: input.frameWidth,
  frameHeight: input.frameHeight,
  frameBuffer: input.frameBuffer,
  nowMs: input.nowMs,
});

// Phase 4b-6: cross-check with secondary engine if available
let stage3Final = stage3Primary;
if (keys.stage3b) {
  const stage3Secondary = await visionRecognize({
    targetKey: input.targetKey,
    sessionKey: keys.stage3b,
    rois: textCandidates.map((c) => ({
      trackId: c.trackId, rect: c.rect, classHint: c.class || null,
    })),
    frameWidth: input.frameWidth,
    frameHeight: input.frameHeight,
    frameBuffer: input.frameBuffer,
    nowMs: input.nowMs,
  });
  stage3Final = await crossCheckLabels(stage3Primary, stage3Secondary, {
    targetKey: input.targetKey,
    winOcrFallback: input.winOcrFallback,  // 追加パラメータ
  });
}

// stage3Final を label merge して返却 (既存 logic)
```

### 3.3 TS: `StagePipelineInput` に winOcrFallback 追加

```typescript
export interface StagePipelineInput {
  targetKey: string;
  rois: NativeRecognizeRequest["rois"];
  frameWidth: number;
  frameHeight: number;
  frameBuffer: Buffer;
  nowMs: number;
  /** Phase 4b-6: optional Tier ∞ fallback for when both OCR engines fail. */
  winOcrFallback?: WinOcrFallbackFn;
}
```

### 3.4 TS: `OnnxBackend.ensureWarm` 環境変数判定

```typescript
async ensureWarm(target: WarmTarget): Promise<WarmState> {
  if (!OnnxBackend.isAvailable()) {
    this.state = "evicted";
    return this.state;
  }
  if (this.state === "warm" && this.stageKeys !== null) return "warm";

  try {
    this.registry.loadManifestFromFile(MANIFEST_PATH);
  } catch (err) {
    console.error("[onnx-backend] manifest load failed:", err);
    this.state = "evicted";
    return this.state;
  }

  const profile = nativeVision!.detectCapability!();
  const crossCheckEnabled = process.env.DESKTOP_TOUCH_VISUAL_CROSS_CHECK === "1";

  const stage1Variant = this.registry.selectVariant("florence-2-base", profile);
  const stage2Variant = this.registry.selectVariant("omniparser-v2-icon-detect", profile);
  const stage3Variant = this.registry.selectVariant("paddleocr-v4-server", profile);
  const stage3bVariant = crossCheckEnabled
    ? this.registry.selectVariant("paddleocr-v4-mobile", profile)
    : null;

  if (!stage1Variant || !stage2Variant || !stage3Variant) {
    this.state = "evicted";
    return this.state;
  }
  // stage3b is optional — if cross-check enabled but mobile variant missing, log and continue without it

  const keys = await this.initStageSessions(
    stage1Variant, stage2Variant, stage3Variant, stage3bVariant,
  );
  if (!keys) {
    this.state = "evicted";
    return this.state;
  }
  this.stageKeys = keys;
  this.state = "warm";
  return this.state;
}

// initStageSessions 拡張 — stage3b を optional で init
```

### 3.5 TS: `OnnxBackend.recognizeRois` の winOcrFallback 注入

```typescript
// onnx-backend.ts
import { spawnSync } from "node:child_process";

// Tier ∞ adapter: win-ocr.exe を呼び出す (既存 bin/win-ocr.exe 活用)
const winOcrFallback: WinOcrFallbackFn = async (_targetKey, rect) => {
  try {
    // 既存 bin/win-ocr.exe の呼出パターン (PocVisualBackend と同じ convention)
    const result = spawnSync("bin/win-ocr.exe", [
      "--rect", `${rect.x},${rect.y},${rect.width},${rect.height}`,
    ], { encoding: "utf8", timeout: 2000 });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch (err) {
    console.error("[cross-check] win-ocr fallback failed:", err);
  }
  return "";
};

async recognizeRois(
  targetKey: string,
  rois: RoiInput[],
  frameWidth?: number,
  frameHeight?: number,
  frameBuffer?: Buffer,
): Promise<UiEntityCandidate[]> {
  // ... existing availability / warmth checks ...

  const input: StagePipelineInput = {
    targetKey,
    rois: nativeRois,
    frameWidth: frameWidth ?? this.opts.defaultFrameWidth ?? 0,
    frameHeight: frameHeight ?? this.opts.defaultFrameHeight ?? 0,
    frameBuffer: effectiveBuffer,
    nowMs: Date.now(),
    winOcrFallback,  // Phase 4b-6: Tier ∞ hook
  };
  // ... existing runStagePipeline call ...
}
```

**注**: `bin/win-ocr.exe` の正確な CLI signature は既存 `src/engine/poc/poc-visual-backend.ts`
or `src/tools/win-ocr-adapter.ts` 等を参照 (既存実装の呼出パターンを流用)。
Sonnet は現状の呼出箇所を grep で確認、そのパターンを踏襲。

---

## 4. Done criteria

- [ ] `cargo check --release --features vision-gpu` exit 0 (本 batch Rust 側変更なしでも fresh check)
- [ ] `tsc --noEmit` exit 0
- [ ] `npx vitest run --project=unit "tests/unit/vision-gpu-cross-check.test.ts"` 全緑 (新規 8+ ケース)
- [ ] `npx vitest run --project=unit "tests/unit/stage-pipeline.test.ts"` 既存全緑 + stage3b 分岐の新規 2 ケース
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-onnx-backend.test.ts"` 既存全緑 (env var で cross-check 有効時の 2 ケース追記可)
- [ ] 最終 full suite regression 0
- [ ] ADR-005 §5 4b-6 `[x]` flip + summary (Cross-check 完結 + win-ocr Tier ∞ 接続明記)
- [ ] 設計書 Status → Implemented + commit hash
- [ ] Opus self-review BLOCKING 0

---

## 5. Test cases

### 5.1 `vision-gpu-cross-check.test.ts` 新規 (最低 8 ケース)

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  levenshteinDistance,
  crossCheckLabels,
  CROSS_CHECK_AGREEMENT_THRESHOLD,
} from "../../src/engine/vision-gpu/cross-check.js";

function candidate(trackId: string, label: string, confidence = 0.7, provisional = false) {
  return {
    trackId, rect: { x: 0, y: 0, width: 10, height: 10 },
    label, class: "text", confidence, provisional,
  };
}

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("hello", "hello")).toBe(0);
  });
  it("returns 1 for totally disjoint strings of equal length", () => {
    // "abc" vs "xyz" distance 3, max length 3 → normalized 1.0
    expect(levenshteinDistance("abc", "xyz")).toBe(1);
  });
  it("returns 1 when one string is empty", () => {
    expect(levenshteinDistance("", "abc")).toBe(1);
    expect(levenshteinDistance("xyz", "")).toBe(1);
  });
  it("returns 0 when both strings are empty", () => {
    expect(levenshteinDistance("", "")).toBe(0);
  });
  it("normalizes by max length", () => {
    // "cat" vs "cut" — 1 substitution, max length 3 → 1/3
    expect(levenshteinDistance("cat", "cut")).toBeCloseTo(1 / 3, 5);
  });
});

describe("crossCheckLabels agreement path", () => {
  it("promotes confidence when distance < threshold", async () => {
    const p = [candidate("t1", "hello", 0.7, true)];
    const s = [candidate("t1", "hello", 0.8, true)];
    const out = await crossCheckLabels(p, s);
    expect(out[0].label).toBe("hello");
    expect(out[0].provisional).toBe(false);
    expect(out[0].confidence).toBe(0.8);
  });

  it("marks provisional when distance >= threshold", async () => {
    const p = [candidate("t1", "abc", 0.7)];
    const s = [candidate("t1", "xyz", 0.7)];  // distance 1.0
    const out = await crossCheckLabels(p, s);
    expect(out[0].label).toBe("abc"); // primary wins label
    expect(out[0].provisional).toBe(true);
  });
});

describe("crossCheckLabels fallback paths", () => {
  it("uses secondary when primary label is empty", async () => {
    const p = [candidate("t1", "", 0.3)];
    const s = [candidate("t1", "hello", 0.7)];
    const out = await crossCheckLabels(p, s);
    expect(out[0].label).toBe("hello");
  });

  it("keeps primary unchanged when no secondary counterpart", async () => {
    const p = [candidate("t1", "hello", 0.7)];
    const s: ReturnType<typeof candidate>[] = [];
    const out = await crossCheckLabels(p, s);
    expect(out[0].label).toBe("hello");
  });

  it("invokes winOcrFallback when both empty", async () => {
    const p = [candidate("t1", "", 0.2)];
    const s = [candidate("t1", "", 0.2)];
    const fallback = vi.fn().mockResolvedValue("ocr-result");
    const out = await crossCheckLabels(p, s, {
      winOcrFallback: fallback, targetKey: "w:1",
    });
    expect(fallback).toHaveBeenCalledOnce();
    expect(out[0].label).toBe("ocr-result");
    expect(out[0].provisional).toBe(true);
  });

  it("preserves primary when fallback throws", async () => {
    const p = [candidate("t1", "", 0.2)];
    const s = [candidate("t1", "", 0.2)];
    const fallback = vi.fn().mockRejectedValue(new Error("winocr crashed"));
    const out = await crossCheckLabels(p, s, { winOcrFallback: fallback });
    expect(out[0].label).toBe("");
  });
});

describe("CROSS_CHECK_AGREEMENT_THRESHOLD constant", () => {
  it("matches ADR-005 D3' value 0.2", () => {
    expect(CROSS_CHECK_AGREEMENT_THRESHOLD).toBe(0.2);
  });
});
```

### 5.2 `stage-pipeline.test.ts` 追記 (2 ケース)

```typescript
// 既存 6 ケースは keys.stage3b なしで動作継続 — accuracy 追従不要
// 新規 2 ケース:

it("invokes stage3b in addition to stage3 when stage3b key is set (cross-check)", async () => {
  const calls: string[] = [];
  const recognize: VisionRecognizeFn = async (req) => {
    calls.push(req.sessionKey);
    return req.rois.map((r) => ({
      trackId: r.trackId, rect: r.rect, label: "ocr", class: "text",
      confidence: 0.5, provisional: true,
    }));
  };
  const keys: StageSessionKeys = {
    stage1: "s1", stage2: "s2", stage3: "s3", stage3b: "s3b",
  };
  await runStagePipeline(keys, baseInput, recognize);
  expect(calls).toContain("s3");
  expect(calls).toContain("s3b");
});

it("skips stage3b when keys.stage3b is undefined (default no-cross-check)", async () => {
  const calls: string[] = [];
  const recognize: VisionRecognizeFn = async (req) => {
    calls.push(req.sessionKey);
    return req.rois.map((r) => ({
      trackId: r.trackId, rect: r.rect, label: "ocr", class: "text",
      confidence: 0.5, provisional: true,
    }));
  };
  const keys: StageSessionKeys = { stage1: "s1", stage2: "s2", stage3: "s3" };
  await runStagePipeline(keys, baseInput, recognize);
  expect(calls).not.toContain("s3b");
});
```

---

## 6. Known traps

| 罠 | 対策 |
|---|---|
| `process.env.DESKTOP_TOUCH_VISUAL_CROSS_CHECK` の評価タイミング | `ensureWarm` 実行時に 1 回読む (instantiate 時ではない)、env 動的変更に対応 |
| PaddleOCR-mobile variant が manifest に無い / selectVariant null | warn log + stage3b 無効で続行、primary のみで動作 |
| `bin/win-ocr.exe` が Windows 以外 / 未インストール | spawnSync が ENOENT → catch で空 string、silent fallback |
| Levenshtein DP が大きい string で O(n²) 遅い | typical OCR label は < 100 char、1 frame あたり全候補で合計 < 1ms |
| 並列 visionRecognize 呼出で GPU リソース contention | Rust 側 pool はセッション別、ort::Session::run は independent、問題なし |
| win-ocr spawn の timeout 2000ms が長すぎ | L1 warm p99 ≤ 30ms を壊す。fallback は最終手段として稀、typical path では呼ばれない |
| `recognizeRois` signature への winOcrFallback 追加は禁止 | `StagePipelineInput` に内部追加のみ、`VisualBackend` interface 不変 |
| Levenshtein normalize で "a" vs "" が 1.0 → 閾値 0.2 で必ず disagreement | 期待通り、短文ペアの片方空は disagreement として扱う |
| stage3 失敗で runStagePipeline 全体が落ちる | 既存 try/catch 維持、cross-check layer も例外伝播せず fallback |
| Env var が文字列 "1" 以外 (e.g. "true") で無効 | 単純文字列比較、"1" のみ有効と doc 化 (handbook §9.3 前例) |

---

## 7. Acceptable Sonnet judgment scope

- `bin/win-ocr.exe` CLI signature の確認と既存呼出パターン踏襲 (grep で現行の使用箇所確認)
- Levenshtein 実装の細部 (2D array vs 2 行バッファ、本設計は 2 行バッファ推奨)
- `CROSS_CHECK_AGREEMENT_THRESHOLD` 値 0.2 (ADR-005 D3' 明記、変更禁止)
- confidence 調整値 (disagreement 時 0.6 cap、agreement 時 max)
- commit 分割 (推奨 3-4: cross-check module / stage-pipeline 拡張 / onnx-backend wire+win-ocr / docs)
- test +α ケース (§5.1 8 ケース超え可)
- `winOcrFallback` 関数の実装詳細 (spawnSync vs child_process.exec vs 既存 util 流用)

---

## 8. Forbidden Sonnet judgments

### 8.1 API surface 変更
- `VisualBackend` interface 不変
- `ModelRegistry` / `ModelManifest` 不変
- `RecognizeRequest` / `NativeRecognizeRequest` 不変
- `OnnxBackend` public method signature 不変 (winOcrFallback は internal、signature に追加しない)
- `UiEntityCandidate` / `RawCandidate` shape 不変
- `StagePipelineInput` への `winOcrFallback?: ...` 追加は allowed (optional、既存 caller に影響なし)

### 8.2 Scope 変更
- 3-way cross-check (server + mobile + 3rd) 禁止 (将来 ADR)
- GOT-OCR2 / Surya / Florence icon_caption 追加禁止
- PaddleOCR detection model / direction classifier 追加禁止
- Benchmark 実装禁止 (4b-7)
- Vendor matrix 測定禁止 (4b-8)
- Rust 側 paddleocr.rs 変更禁止 (本 batch は TS 側のみ、`paddleocr-v4-mobile:` prefix dispatch は既存 paddleocr module の再利用)

### 8.3 依存追加禁止
- 新 npm package 禁止
- 新 Rust crate 禁止
- `package.json` / `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

### 8.4 テスト書換禁止
- 既存 test の body 変更禁止 (handbook §4.1)
- cross-check 無効 default (env 未設定) では既存 test 全パス維持

### 8.5 絶対不変
- `catch_unwind` barrier 削除禁止
- `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND` / `DESKTOP_TOUCH_DISABLE_VISUAL_GPU` 維持
- `PocVisualBackend` / `bin/win-ocr.exe` 削除禁止 **(本 batch では使用拡大)**
- Phase 4b-5 完成の legacy 除去を reintroduce 禁止

### 8.6 ドキュメント更新義務
- ADR-005 §5 4b-6 `[x]` flip + summary
- 本設計書 Status → Implemented + commit hash

---

## 9. Future work

- **4b-7**: BenchmarkHarness で cross-check ON/OFF の latency / recall 比較
- **4b-8**: vendor matrix benchmark
- **ADR-007 候補**: GOT-OCR2 / Surya 追加、3-way voting
- **ADR-008 候補**: Rust 側 cross-check 実装 (win-ocr も Rust 側から呼ぶ)

---

## 10. 実装順序

1. `src/engine/vision-gpu/cross-check.ts` 新規作成 (§3.1 全体)
2. `tests/unit/vision-gpu-cross-check.test.ts` 新規作成 (§5.1 8+ ケース)
3. `stage-pipeline.ts::StageSessionKeys` に stage3b 追加、`StagePipelineInput::winOcrFallback` 追加、`runStagePipeline` 拡張 (§3.2, §3.3)
4. `stage-pipeline.test.ts` に 2 ケース追記 (§5.2)
5. `onnx-backend.ts::ensureWarm` に env var 判定 + stage3b init (§3.4)
6. `onnx-backend.ts::recognizeRois` に winOcrFallback 注入 (§3.5)
7. `tsc --noEmit` exit 0
8. vitest 個別実行 (cross-check / stage-pipeline / onnx-backend / model-registry / session) 全緑
9. cargo check 3 features set 全 exit 0 (本 batch Rust 変更なしだが fresh check)
10. `npm run test:capture -- --force` 最終 1 回 (regression 0)
11. ADR-005 §5 4b-6 `[x]` flip + summary
12. 設計書 Status → Implemented + commit hash
13. commit 分割 (推奨 3-4):
    - A: `feat(vision-gpu): Phase 4b-6 — cross-check module (Levenshtein + arbitration)`
    - B: `feat(vision-gpu): Phase 4b-6 — stage-pipeline stage3b + winOcrFallback plumbing`
    - C: `feat(vision-gpu): Phase 4b-6 — OnnxBackend env var + win-ocr Tier ∞ wire`
    - D: `docs(vision-gpu): Phase 4b-6 — ADR §5 + design Status`
14. push origin
15. Opus self-review (本人 Opus session 別途)
16. notification + handbook §6.1 報告

END.
