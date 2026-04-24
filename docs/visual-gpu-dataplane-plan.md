# Visual GPU Dataplane 実装方針設計書 (2026-04-24)

> **読者**: Claude Sonnet (実装担当)。
> **前提**: この設計書だけを見て迷いなく実装開始できることを目標に書かれている。
> **背景資料**:
> - `docs/visual-gpu-capability-audit.md` (欠けている配線 A/B/C/D を定義)
> - `docs/project-wiring-audit.md` (他サブシステムの監査、visual_gpu 以外に同パターン無し)
>
> **監査結論**: 再設計は不要。`VisualBackend` 抽象はそのまま、欠けた "producer" を埋める局所手術。
>
> **実装順序**: フェーズ 1 → 2 → 3 → 4 → 5。各フェーズは独立コミット・独立テスト可能。
> 先行フェーズの完了判定を満たさない限り次へ進んではならない。

---

## 全体像: データフローとフェーズのマッピング

```
         フェーズ 3 (Desktop Duplication)
            ┌──────────────────────────┐
            │ dirty-rect native source │
            └───────────┬──────────────┘
                        ▼
                [ RoiScheduler.scheduleRois ]   ← フェーズ 3 で初 call
                        │
                        ▼
                [ TrackStore.update ]            ← フェーズ 3
                        │
                        ▼
                [ TemporalFusion.update ]        ← フェーズ 1 (OCR経由) / フェーズ 3 (dirty-rect経由)
                        │
                        ▼
                [ CandidateProducer.ingest ]     ← フェーズ 1 (初登場)
                        │
                        ▼
                [ pushDirtySignal(key, cands) ]  ← フェーズ 1 (初登場)
                        │
          desktop-register.ts:146 onDirtySignal
                        ▼
                [ PocVisualBackend.updateSnapshot ]  ← 既存
                        ▼
                [ VisualRuntime → visual-provider ] ← 既存

         フェーズ 4: PocVisualBackend を SidecarBackend / OnnxBackend に置換
         フェーズ 2: dead exports 整理 + kill-switch
         フェーズ 5: Benchmark + リリース判定
```

---

# フェーズ 1 — OCR → CandidateProducer アダプター (Quick Win)

## 目的

既存の PrintWindow + `win-ocr.exe` パイプライン (`runSomPipeline`) の出力を
`CandidateProducer.ingest()` 経由で `pushDirtySignal` に流し込み、
`source: "visual_gpu"` の候補を **初めて** 実在させる。

Outlook PWA のような UIA-blind な窓でも、`visual_gpu` ラインから候補が返るようになる。

**新規ネイティブコード不要**。全部 TypeScript。見積り 4〜6 時間。

## 前提条件

- `DESKTOP_TOUCH_ENABLE_FUKUWARAI_V2=1` が有効
- `bin/win-ocr.exe` が存在 (既存の OCR プロバイダと同じ前提)
- 既存テスト (`tests/unit/visual-gpu-capability.test.ts`, `tests/integration/ocr-golden.test.ts`) が通ること

## 変更ファイル一覧 (パス:行番号)

| ファイル | 変更内容 | 推定行 |
|---|---|---|
| `src/engine/vision-gpu/ocr-adapter.ts` | **新規** — OCR → CandidateProducer アダプター | 約 180 行 |
| `src/tools/desktop-providers/ocr-provider.ts` (行 44-55) | adapter への副次呼び出しを追加 | +15 行 |
| `src/tools/desktop-register.ts` (行 136-152, `initVisualRuntime`) | アダプターのライフサイクルを持つ | +30 行 |
| `tests/unit/visual-gpu-ocr-adapter.test.ts` | **新規** — アダプターの単体テスト | 約 200 行 |

**触らないファイル** (重要):
- `src/engine/vision-gpu/candidate-producer.ts` — API は既に十分
- `src/engine/vision-gpu/track-store.ts` — 同上
- `src/engine/vision-gpu/temporal-fusion.ts` — 同上
- `src/engine/vision-gpu/poc-backend.ts` — 同上

## 実装詳細

### 1-1. `src/engine/vision-gpu/ocr-adapter.ts` (新規)

OCR から得た `SomElement[]` を、**同一 trackId** で 3 回 ingest すれば `TrackStore`
が stable に昇格させる。`TemporalFusion` も `stableConsecutive=2` で committed になる。
これを "pollOnce" の内部で人工的に起こす。

```ts
/**
 * ocr-adapter.ts — Bridge from SoM pipeline output to CandidateProducer.
 *
 * Phase 1 of visual-gpu-dataplane-plan.md: fills the production gap where no
 * component ever calls CandidateProducer.ingest(). Reuses the existing
 * PrintWindow + win-ocr.exe pipeline as a stand-in detector+recognizer.
 *
 * Per-target isolation: one OcrVisualAdapter instance per targetKey.
 * Adapter owns its TrackStore/TemporalFusion/CandidateProducer triple so
 * tracks from Outlook do not collide with tracks from Chrome.
 *
 * Poll semantics:
 *   pollOnce(target) runs runSomPipeline() once, converts SomElements to
 *   ROIs, drives TrackStore for STABLE_AGE_THRESHOLD (=3) frames so the
 *   tracks promote to `stable`, drives TemporalFusion for stableConsecutive
 *   (=2) frames so text commits, then pushes the resulting UiEntityCandidate[]
 *   via pushDirtySignal.
 *
 * The "3 synthesised frames" trick is deliberate: we have no real frame
 * source in Phase 1, so we simulate stability by calling update() with the
 * same ROIs three times in quick succession. The fusion/track store do not
 * know the difference. This is replaced by real per-frame ingestion in Phase 3.
 */

import type { TargetSpec } from "../world-graph/session-registry.js";
import type { UiEntityCandidate } from "./types.js";
import { TrackStore } from "./track-store.js";
import { TemporalFusion } from "./temporal-fusion.js";
import { CandidateProducer } from "./candidate-producer.js";
import { pushDirtySignal } from "./dirty-signal.js";
import type { SomElement, OcrDictionaryEntry } from "../ocr-bridge.js";

/** Compute the targetKey that both visual-provider and pushDirtySignal use. */
export function targetKeyFromSpec(target: TargetSpec): string {
  if (target.hwnd)        return `window:${target.hwnd}`;
  if (target.tabId)       return `tab:${target.tabId}`;
  if (target.windowTitle) return `title:${target.windowTitle}`;
  return "window:__default__";
}

export interface OcrVisualAdapterOptions {
  /** Min ms between pollOnce invocations for the same target (default 2000). */
  minPollIntervalMs?: number;
  /** Fusion stableConsecutive (default 2). */
  stableConsecutive?: number;
}

/**
 * Per-target adapter. Hold one instance per window/tab in a Map.
 */
export class OcrVisualAdapter {
  private readonly store: TrackStore;
  private readonly fusion: TemporalFusion;
  private readonly producer: CandidateProducer;
  private readonly targetKey: string;
  private readonly minPollIntervalMs: number;
  private lastPollMs = 0;
  private inFlight: Promise<UiEntityCandidate[]> | null = null;

  constructor(
    target: TargetSpec,
    opts: OcrVisualAdapterOptions = {},
  ) {
    this.targetKey = targetKeyFromSpec(target);
    this.minPollIntervalMs = opts.minPollIntervalMs ?? 2000;

    const fusion = new TemporalFusion({
      stableConsecutive: opts.stableConsecutive ?? 2,
    });
    // CandidateProducer.create wires onEvict → producer.evict automatically.
    const producerTarget = target.tabId
      ? { kind: "browserTab" as const, id: target.tabId }
      : { kind: "window" as const, id: target.hwnd ?? target.windowTitle ?? "@active" };
    const { store, producer } = CandidateProducer.create(
      {}, // TrackStoreOptions — onEvict auto-wired by factory
      fusion,
      { target: producerTarget }
    );
    this.store = store;
    this.fusion = fusion;
    this.producer = producer;
  }

  /**
   * Drive one observation of the target window.
   *
   * 1. Call runSomPipeline → SomElement[].
   * 2. Map SomElements → ROIs (screen-absolute rects from el.region).
   * 3. Call TrackStore.update(rois, nowMs) THREE times with same rois
   *    (STABLE_AGE_THRESHOLD=3) so tracks promote from new→tracking→stable.
   * 4. For each stable track, call CandidateProducer.ingest() with the
   *    SomElement text as RecognizedText. Call ingest() twice
   *    (stableConsecutive=2) to commit fusion.
   * 5. Push collected UiEntityCandidate[] via pushDirtySignal.
   *
   * Debounce: calls within minPollIntervalMs of the previous poll are skipped
   * to keep per-see() cost bounded.
   *
   * Returns [] on debounce, OCR failure, or zero stable candidates.
   * Never throws — OCR errors are swallowed and logged.
   */
  async pollOnce(
    target: TargetSpec,
    dictionary: OcrDictionaryEntry[] = [],
  ): Promise<UiEntityCandidate[]> {
    const now = Date.now();
    if (now - this.lastPollMs < this.minPollIntervalMs) return [];
    if (this.inFlight) return this.inFlight;
    this.lastPollMs = now;

    this.inFlight = this._doPoll(target, dictionary, now)
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async _doPoll(
    target: TargetSpec,
    dictionary: OcrDictionaryEntry[],
    nowMs: number,
  ): Promise<UiEntityCandidate[]> {
    let elements: SomElement[];
    try {
      const { runSomPipeline } = await import("../ocr-bridge.js");
      const hwnd = target.hwnd ? BigInt(target.hwnd) : null;
      const title = target.windowTitle ?? "@active";
      const result = await runSomPipeline(title, hwnd, "ja", 2, "auto", false, dictionary);
      elements = result.elements;
    } catch (err) {
      console.error("[ocr-adapter] runSomPipeline failed:", err);
      return [];
    }

    if (elements.length === 0) return [];

    // Stage 1: promote tracks to `stable` by feeding the same ROIs 3 times.
    // STABLE_AGE_THRESHOLD in TrackStore is 3. Use nowMs, nowMs+1, nowMs+2
    // so TemporalFusion's tsMs dedup does not reject the repeats.
    const rois = elements.map((e) => e.region);
    this.store.update(rois, nowMs);
    this.store.update(rois, nowMs + 1);
    this.store.update(rois, nowMs + 2);

    // Stage 2: match stable tracks back to their source SomElement via IoU
    // on the current ROI. TrackStore re-assigns the same trackId as long as
    // IoU ≥ 0.3 — for stable ROIs this is effectively deterministic.
    const stableTracks = this.store.getStableTracks();
    if (stableTracks.length === 0) return [];

    // Stage 3: feed TemporalFusion via producer.ingest() twice to reach
    // stableConsecutive=2.
    let candidates: UiEntityCandidate[] = [];
    for (let pass = 0; pass < 2; pass++) {
      const inputs = stableTracks.map((track, i) => {
        // Match the SomElement whose rect best overlaps this track's current ROI.
        const el = findBestMatchingElement(track.roi, elements) ?? elements[i];
        return {
          trackId: track.trackId,
          result: {
            text: el.text,
            confidence: el.confidence ?? 0.7,
            tsMs: nowMs + 10 + pass, // must be strictly increasing per trackId
          },
        };
      });
      candidates = this.producer.ingest(inputs);
    }

    // Stage 4: publish.
    if (candidates.length > 0) {
      pushDirtySignal(this.targetKey, candidates);
    }
    return candidates;
  }

  /** Reset internal state (tests / target teardown). */
  dispose(): void {
    for (const t of this.store.getStableTracks()) {
      this.fusion.clear(t.trackId);
    }
    this.lastPollMs = 0;
  }
}

function iouOf(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter === 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

function findBestMatchingElement(
  roi: { x: number; y: number; width: number; height: number },
  elements: SomElement[],
): SomElement | undefined {
  let best: SomElement | undefined;
  let bestScore = 0;
  for (const e of elements) {
    const s = iouOf(roi, e.region);
    if (s > bestScore) { bestScore = s; best = e; }
  }
  return best;
}
```

### 1-2. `src/tools/desktop-register.ts` — `initVisualRuntime` の拡張

行 **136-152** の `initVisualRuntime` に、**adapter レジストリ** と
**pollOnce ヘルパー** を追加する。`_facade` singleton と同じライフタイムで
`Map<targetKey, OcrVisualAdapter>` を保持する。

変更箇所 (行 136-152 を置き換え):

```ts
// 行 33 付近に追加インポート
import { OcrVisualAdapter, targetKeyFromSpec } from "../engine/vision-gpu/ocr-adapter.js";
import type { OcrDictionaryEntry } from "../engine/ocr-bridge.js";

// 行 91 付近に追加
let _ocrAdapters: Map<string, OcrVisualAdapter> | undefined;

/**
 * Phase 1: return (and lazily create) the OcrVisualAdapter for a target.
 * Called from ocr-provider after a successful SoM run.
 */
export function getOcrVisualAdapter(target: TargetSpec): OcrVisualAdapter {
  if (!_ocrAdapters) _ocrAdapters = new Map();
  const key = targetKeyFromSpec(target);
  let adapter = _ocrAdapters.get(key);
  if (!adapter) {
    adapter = new OcrVisualAdapter(target);
    _ocrAdapters.set(key, adapter);
  }
  return adapter;
}

// 行 214-219 付近の _resetFacadeForTest に追加
export function _resetFacadeForTest(): void {
  (_facade as unknown as { dispose?: () => void })?.dispose?.();
  _facade = undefined;
  _visualSource = undefined;
  _pocBackend = undefined;
  _ocrAdapters?.forEach((a) => a.dispose());
  _ocrAdapters = undefined;
}
```

### 1-3. `src/tools/desktop-providers/ocr-provider.ts` の拡張

行 **44-55** の直後 (`return { candidates, warnings: [] };` の直前) に、
**non-blocking で** アダプターを叩く。OCR プロバイダの戻り値は変えない。
visual ラインへの出力は後続の `desktop_see` 呼び出しで拾われる。

```ts
// 行 24 付近にインポート追加
import { getOcrVisualAdapter } from "../desktop-register.js";

// 行 44-55 の直後、return 前に挿入:
// Phase 1 dataplane hook: feed this SoM run into the visual lane so the
// next desktop_see returns the same entities under source:"visual_gpu".
// Non-blocking: adapter has its own debounce and runSomPipeline is idempotent.
//
// Fire-and-forget: awaiting here would double the latency of the primary
// OCR path. The adapter's own pollOnce re-runs runSomPipeline — this is
// acceptable in Phase 1 (Quick Win scope) and eliminated in Phase 3 when
// a real dirty-rect source removes the re-run.
try {
  const adapter = getOcrVisualAdapter(target);
  void adapter.pollOnce(target, dictionary).catch(() => {
    /* adapter logs its own errors; never block the OCR return */
  });
} catch (err) {
  console.error("[ocr-provider] visual adapter hook failed:", err);
  // Continue — primary OCR result is unaffected.
}
```

**注意**: アダプター内部で `runSomPipeline` を再実行するので 1 回の `desktop_see`
で SoM が 2 回走る。これは Phase 1 でのみ許容する設計。Phase 3 で dirty-rect
ソースが入ったら OCR 経由の再実行は不要になる。もし即座に重複を潰したいなら、
`pollOnce` に optional な `preFetchedElements` を渡す拡張を後付けできるが、
Phase 1 のスコープ外とする。

### 1-4. `tests/unit/visual-gpu-ocr-adapter.test.ts` (新規)

カバーするケース:

1. `runSomPipeline` が 0 要素を返すと candidates は空、`pushDirtySignal` も未呼出。
2. `runSomPipeline` が 2 要素返した直後に `pollOnce` を呼ぶと、候補は `pushDirtySignal` 経由で handler に到達。
3. 候補は `source: "visual_gpu"` かつ `digest` を持ち `provisional` が false。
4. デバウンス: `minPollIntervalMs=1000` で直後に再呼出すると空配列。
5. 二つの異なる target (`window:A`, `window:B`) は互いの stable tracks を汚染しない。
6. `runSomPipeline` 例外時は候補空、`pushDirtySignal` 未呼出、呼出元に例外伝播なし。

テストでは `runSomPipeline` を `vi.mock` で差し替える:

```ts
import { vi } from "vitest";
vi.mock("../../src/engine/ocr-bridge.js", () => ({
  runSomPipeline: vi.fn(),
}));
```

## コミット計画

| # | コミット | 内容 |
|---|---|---|
| 1-1 | `feat(vision-gpu): add OcrVisualAdapter for source:"visual_gpu" pipeline` | `src/engine/vision-gpu/ocr-adapter.ts` 新規 + Unit test |
| 1-2 | `feat(desktop-register): wire OcrVisualAdapter registry into facade lifecycle` | `desktop-register.ts` に `_ocrAdapters`, `getOcrVisualAdapter`, `_resetFacadeForTest` 拡張 |
| 1-3 | `feat(ocr-provider): hand SoM output to visual adapter (non-blocking)` | `ocr-provider.ts` に adapter.pollOnce 呼出 |
| 1-4 | `test(integration): verify visual_gpu candidates materialise on UIA-blind window` | `tests/integration/visual-gpu-vs-ocr.test.ts` に "after ocr-provider runs once" ケース追加、または新規 `visual-gpu-dataplane.test.ts` |

## テスト方法

```bash
# 単体
npx vitest run --project unit tests/unit/visual-gpu-ocr-adapter.test.ts

# 既存テスト退行チェック
npx vitest run --project unit tests/unit/visual-gpu-capability.test.ts
npx vitest run --project unit tests/unit/ocr-bridge.test.ts

# 手動 (Outlook PWA を立ち上げて)
RUN_VISUAL_GPU_AUDIT=1 VISUAL_GPU_AUDIT_TITLE="Outlook" \
  npx vitest run --project integration tests/integration/visual-gpu-vs-ocr.test.ts
```

## 完了判定 (すべて ✓ で次フェーズへ)

- [ ] Unit: 新規 `visual-gpu-ocr-adapter.test.ts` 全パス。
- [ ] Unit: 既存 `visual-gpu-capability.test.ts` 17 ケース全て依然パス。
- [ ] Unit: 既存 `ocr-bridge.test.ts` 依然パス。
- [ ] Integration: `visual-gpu-vs-ocr.test.ts` を手動起動 (`RUN_VISUAL_GPU_AUDIT=1`) した時、**2 回目の** `fetchVisualCandidates` 呼び出しで `candidates.length > 0` かつ全候補が `source === "visual_gpu"` であること (1 回目は adapter が動き始めるだけで空で正常)。
- [ ] Lint: `npm run lint` passes.
- [ ] Typecheck: `npm run typecheck` or `tsc --noEmit` passes.

## 注意点・落とし穴

1. **`runSomPipeline` の hwnd 型**: `target.hwnd` は string。`BigInt(target.hwnd)` で変換。既存の `ocr-provider.ts` 行 34 と同じパターンを踏襲。
2. **3 フレーム合成**: `TrackStore.STABLE_AGE_THRESHOLD = 3` は定数 (track-store.ts 行 4)。この値を変えるとテストが壊れるので、このフェーズでは触らない。
3. **`TemporalFusion` の tsMs 単調性**: 同一 trackId に対し `tsMs` が非増加だと観測が dedup で無視される (temporal-fusion.ts 行 59-66)。`nowMs`, `nowMs+1`, ... と必ず増やす。
4. **`CandidateProducer.ingest` は stable 限定**: track.state !== "stable" の trackId を渡しても無視される (candidate-producer.ts 行 100)。Stage 1 の 3 フレーム駆動を省略すると候補は一切出ない。
5. **`CandidateProducer.create` の `onEvict` 自動配線**: 手動で `new TrackStore({ onEvict: ... })` / `new CandidateProducer(...)` を書かない。必ず factory を使う。onEvict を繋ぎ忘れると fusion state がリーク。
6. **Target 引数の tabId 非対応パス**: `OcrVisualAdapter` 自身は tabId を受け取っても `runSomPipeline` が window 前提なので意味を持たない。Phase 1 では hwnd / windowTitle を持つ target のみで意味がある。`ocr-provider` 行 28 の early-return と一致する条件。
7. **初回 desktop_see は visual_gpu が空**: アダプターは non-blocking で動くため、最初の `desktop_see` は visual_gpu 候補ゼロで返る。2 回目で入る。これは仕様であり、設計書を見ない人が混乱しないように PR 本文で明記すること。
8. **Dedup digest 衝突**: `CandidateProducer.computeDigest` は `source|target.kind:id|label|rectBucket` の sha1 先頭 16文字。OCR 側の既存候補 (source="ocr") と digest が衝突することはない (source prefix が違う)。Resolver 側でラベル+rect マージが発火するのは別ロジック。問題にならないことを単体テストで確認。

---

# フェーズ 2 — Dead exports の整理 + kill-switch

## 目的

- フェーズ 1 完了後に未使用化する export を整理
- 運用者が visual_gpu ラインを丸ごと無効化できる環境変数を追加

## 前提条件

- フェーズ 1 が完全にマージ済み
- フェーズ 1 の完了判定が全部 ✓

## 変更ファイル一覧

| ファイル | 変更内容 | 行 |
|---|---|---|
| `src/tools/desktop-register.ts` (行 97-107, 136-193) | dead exports に `@internal` + kill-switch 追加 | 約 +20/-0 |
| `src/tools/desktop-providers/visual-provider.ts` (行 27-35) | kill-switch early return | +6 |
| `tests/unit/visual-gpu-kill-switch.test.ts` | **新規** | 約 80 行 |

## 実装詳細

### 2-1. kill-switch 追加

`src/tools/desktop-providers/visual-provider.ts` 行 **27** 直後に追加:

```ts
// H-killswitch: operator escape hatch. When set, the visual lane behaves
// exactly as if no backend were attached — the provider returns
// visual_provider_unavailable and composer falls through to OCR or
// structured-only mode. See visual-gpu-dataplane-plan.md Phase 2.
const VISUAL_GPU_DISABLED = process.env["DESKTOP_TOUCH_DISABLE_VISUAL_GPU"] === "1";

export async function fetchVisualCandidates(
  target: TargetSpec | undefined
): Promise<ProviderResult> {
  if (VISUAL_GPU_DISABLED) {
    return { candidates: [], warnings: ["visual_provider_unavailable"] };
  }
  const runtime = getVisualRuntime();
  // … 既存処理 …
}
```

**注意**: モジュール先頭で 1 度だけ評価する (`VISUAL_GPU_DISABLED` を関数内
に置かない) ことで、テスト時は `vi.stubEnv` + module reload で切替可能にする。

### 2-2. `desktop-register.ts` の dead-export 注記

行 **97-107** の JSDoc を更新:

```ts
/**
 * @internal Test-only entry point. Production code does not call this.
 * Kept exported for `tests/unit/{dirty-signal,poc-backend,benchmark-gates}.test.ts`
 * which need to inject snapshots without touching CandidateProducer.
 *
 * The production dataplane feeds PocVisualBackend via pushDirtySignal
 * from the OcrVisualAdapter (Phase 1) and, in Phase 3+, from the dirty-rect
 * event loop. External callers should use pushDirtySignal, not this function.
 */
export function getVisualIngressSource(): VisualIngressSource | undefined { ... }

/** @internal same rationale as getVisualIngressSource. */
export function getPocVisualBackend(): PocVisualBackend | undefined { ... }
```

削除はしない。テストが依存しているため。`@internal` マーカーで将来のリネーム
候補にする。

### 2-3. kill-switch skip for initVisualRuntime

`desktop-register.ts` の `getDesktopFacade()` 内 (行 **191-193**) で
`initVisualRuntime` 起動を同じ env ガードで囲む:

```ts
if (process.env["DESKTOP_TOUCH_DISABLE_VISUAL_GPU"] !== "1") {
  initVisualRuntime(_visualSource).catch((err) => {
    console.error("[desktop-register] Failed to initialize visual runtime:", err);
  });
}
```

これで PocVisualBackend 自体がアタッチされず、50ms の空 warmup も走らない。

### 2-4. テスト (`tests/unit/visual-gpu-kill-switch.test.ts`)

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("DESKTOP_TOUCH_DISABLE_VISUAL_GPU kill-switch", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("returns visual_provider_unavailable regardless of backend state", async () => {
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_VISUAL_GPU", "1");
    const { fetchVisualCandidates } =
      await import("../../src/tools/desktop-providers/visual-provider.js");
    const r = await fetchVisualCandidates({ hwnd: "123" });
    expect(r.candidates).toEqual([]);
    expect(r.warnings).toContain("visual_provider_unavailable");
  });

  it("normal path when flag unset", async () => {
    vi.stubEnv("DESKTOP_TOUCH_DISABLE_VISUAL_GPU", "");
    const { fetchVisualCandidates } =
      await import("../../src/tools/desktop-providers/visual-provider.js");
    const r = await fetchVisualCandidates({ hwnd: "123" });
    // Unavailable because no backend attached in this test scope,
    // but the code path is the normal one.
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
  });
});
```

## コミット計画

| # | コミット |
|---|---|
| 2-1 | `feat(visual-provider): add DESKTOP_TOUCH_DISABLE_VISUAL_GPU kill-switch` |
| 2-2 | `docs(desktop-register): mark getPocVisualBackend/getVisualIngressSource @internal` |
| 2-3 | `test(visual-provider): cover kill-switch env-gate` |

## 完了判定

- [ ] `DESKTOP_TOUCH_DISABLE_VISUAL_GPU=1` で `initVisualRuntime` がスキップされる (診断ログ手動確認)
- [ ] 新規 kill-switch テストパス
- [ ] `@internal` マーカーで既存テスト依然パス
- [ ] `npm run lint` / `tsc --noEmit` パス

## 注意点・落とし穴

1. **env 読み方**: Windows で env 変数の空文字は `""` / 未定義が混在しうる。`=== "1"` の厳格比較を徹底。`Boolean(process.env[...])` は使わない (`"0"` も true になる)。
2. **Module-level evaluation**: kill-switch を関数内読みにすると test reset が難しい。module-level に置き、テストは `vi.resetModules()` + `import()` で再読込。
3. **既存 "evicted retry" 経路と衝突しない**: kill-switch は `runtime.isAvailable` より前に効くので、attach 未発火のレースと区別がつかないが、運用者視点では同じ `visual_provider_unavailable` で十分。

---

# フェーズ 3 — Desktop Duplication dirty-rect ソース

## 目的

OCR ポーリング依存から脱却し、**イベント駆動**の dirty-rect 受信を入れる。
`RoiScheduler.scheduleRois` を初めて production で稼動させる。
OCR アダプター自体は残すが "フォールバック 2 次ソース" に降格。

**新規ネイティブコード**が必要 (Rust / NAPI, Desktop Duplication API wrapper)。
見積り 1〜2 日 (native) + 0.5 日 (TS 配線)。

## 前提条件

- フェーズ 1, 2 がマージ済み
- Rust ワークスペース (`native/`) がビルド可能
- 既存の `native-engine.ts` / `napi-rs` 設定で新 export を追加できる

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `native/src/dirty_rect.rs` | **新規** Rust 実装 |
| `native/src/lib.rs` | `dirty_rect` モジュール公開、NAPI export 追加 |
| `src/engine/native-types.ts` | `subscribeDirtyRects` 型追加 |
| `src/engine/vision-gpu/dirty-rect-source.ts` | **新規** TypeScript wrapper + RoiScheduler 駆動 |
| `src/tools/desktop-register.ts` (`initVisualRuntime`) | dirty-rect source を起動 |
| `tests/unit/dirty-rect-source.test.ts` | **新規** |

## 実装詳細

### 3-1. Rust: Desktop Duplication dirty-rect 取得

```rust
// native/src/dirty_rect.rs
//
// Desktop Duplication API wrapper.
// Exposes a polling subscribe interface: napi.js thread calls `next()` which
// blocks up to `timeout_ms` waiting for a frame with non-empty dirty rects.
//
// Design:
//   - One IDXGIOutputDuplication per monitor. For Phase 3 we take the
//     primary monitor only (Outlook PWA / Chrome / terminal always on
//     primary in dogfood env). Multi-monitor is a Phase 4 extension.
//   - DirtyRects are in desktop coordinates relative to the primary monitor.
//     Caller is responsible for HWND→rect intersection before scheduling ROIs.
//   - AcquireNextFrame timeout is short (16ms) to keep the thread responsive.

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi(object)]
pub struct DirtyRect {
    pub x: i32, pub y: i32, pub width: i32, pub height: i32,
}

#[napi]
pub struct DirtyRectSubscription {
    // ... IDXGIOutputDuplication handle, last-frame cursor, etc.
}

#[napi]
impl DirtyRectSubscription {
    #[napi(constructor)]
    pub fn new() -> Result<Self> { /* initialise duplication */ }

    /// Block up to `timeout_ms` waiting for the next dirty frame.
    /// Returns [] on timeout (no error).
    #[napi]
    pub async fn next(&self, timeout_ms: u32) -> Result<Vec<DirtyRect>> {
        // AcquireNextFrame(timeout_ms)
        // If ok: GetFrameDirtyRects → convert → Vec
        // If TIMEOUT: return Ok(vec![])
        // ReleaseFrame before return.
    }

    #[napi]
    pub fn dispose(&mut self) -> Result<()> { /* release duplication */ }
}
```

実装リファレンス (Microsoft Docs):
- `IDXGIOutputDuplication::AcquireNextFrame`
- `IDXGIOutputDuplication::GetFrameDirtyRects`

### 3-2. TS wrapper + scheduler ループ

```ts
// src/engine/vision-gpu/dirty-rect-source.ts
import { scheduleRois } from "./roi-scheduler.js";
import type { Rect } from "./types.js";
// NAPI import — adjust per your native bindings plumbing
// (see src/engine/native-engine.ts for the pattern used elsewhere)
import { DirtyRectSubscription } from "../native-engine.js";

export interface DirtyRectRouterOptions {
  /** Max time between AcquireNextFrame calls (default 16ms). */
  pollTimeoutMs?: number;
  /**
   * Callback invoked with rois scheduled for recognition.
   * Consumer is expected to drive TrackStore.update() + ingest flow.
   */
  onRois: (rois: Rect[], nowMs: number) => void;
}

export class DirtyRectRouter {
  private readonly sub: DirtyRectSubscription;
  private running = false;
  private lastScheduledMs: number | undefined;

  constructor(private readonly opts: DirtyRectRouterOptions) {
    this.sub = new DirtyRectSubscription();
  }

  start(): void {
    this.running = true;
    void this._loop();
  }

  private async _loop(): Promise<void> {
    while (this.running) {
      const rects = await this.sub.next(this.opts.pollTimeoutMs ?? 16);
      if (rects.length === 0) continue;
      const nowMs = Date.now();
      const out = scheduleRois(
        { dirtyRects: rects, nowMs, lastScheduledMs: this.lastScheduledMs },
        {}
      );
      if (out.mode === "recognize") {
        this.lastScheduledMs = nowMs;
        this.opts.onRois(out.rois, nowMs);
      }
    }
  }

  stop(): void {
    this.running = false;
    this.sub.dispose();
  }
}
```

### 3-3. `initVisualRuntime` 拡張

```ts
// desktop-register.ts 行 136-152 の initVisualRuntime 末尾に追加
import { DirtyRectRouter } from "../engine/vision-gpu/dirty-rect-source.js";

let _dirtyRouter: DirtyRectRouter | undefined;

async function initVisualRuntime(visualSource: VisualIngressSource): Promise<void> {
  // ... 既存コード ...

  // Phase 3: start dirty-rect router. Guarded by env so it can be
  // disabled alongside the kill-switch from Phase 2.
  if (process.env["DESKTOP_TOUCH_DISABLE_VISUAL_GPU"] !== "1"
      && process.env["DESKTOP_TOUCH_DISABLE_DIRTY_RECTS"] !== "1") {
    _dirtyRouter = new DirtyRectRouter({
      onRois: (rois, nowMs) => {
        // Route to the foreground-window's OcrVisualAdapter as the
        // recogniser. The adapter's pollOnce is reused, but without
        // running runSomPipeline on the whole window — instead each
        // roi is cropped and recognised. For Phase 3 simplicity we
        // still fall back to full-window SoM on any roi intersecting
        // the foreground window. This is replaced by per-roi
        // recognition in Phase 4.
        try {
          const wins = enumWindowsInZOrder();
          const fg = wins.find((w) => w.isActive);
          if (!fg) return;
          const target: TargetSpec = { hwnd: String(fg.hwnd), windowTitle: fg.title };
          const adapter = getOcrVisualAdapter(target);
          void adapter.pollOnce(target).catch(() => {});
        } catch { /* best-effort */ }
      },
    });
    _dirtyRouter.start();
  }
}

// _resetFacadeForTest に追加
_dirtyRouter?.stop();
_dirtyRouter = undefined;
```

### 3-4. テスト

1. `DirtyRectRouter` は native mock を差し替え可能にする (constructor に subscription を注入する inject pattern にしておく)。
2. `scheduleRois` を通った `rois` が `onRois` コールバックに届くこと。
3. `mode === "tracking"` では `onRois` が呼ばれないこと。
4. `stop()` 後に native `dispose` が呼ばれること。

## コミット計画

| # | コミット |
|---|---|
| 3-1 | `feat(native): add DirtyRectSubscription via Desktop Duplication API` |
| 3-2 | `feat(vision-gpu): add DirtyRectRouter driving RoiScheduler` |
| 3-3 | `feat(desktop-register): start DirtyRectRouter on facade init` |
| 3-4 | `test(vision-gpu): DirtyRectRouter with mocked native subscription` |

## 完了判定

- [ ] Native ビルド成功。`DirtyRectSubscription` が `npm run build:native` で出力される。
- [ ] Unit: `dirty-rect-source.test.ts` の 4 ケース全パス (mock 使用)。
- [ ] 手動: Outlook PWA でウィンドウに文字入力 → 1 秒以内に `pushDirtySignal` が発火する (console log で確認)。
- [ ] Regression: フェーズ 1/2 のテスト全パス。

## 注意点・落とし穴

1. **Desktop Duplication API の多重取得禁止**: 同一プロセスで 2 つ目の `IDXGIOutputDuplication` を取ると失敗する。DirtyRectRouter は singleton。
2. **RDP 環境では AcquireNextFrame が機能しない**: RDP 経由だと DXGI_ERROR_UNSUPPORTED が返ることがある。そのとき Rust 側で `Ok(vec![])` にフォールバックし OCR アダプターで機能維持。
3. **primary monitor 前提**: Phase 3 では primary monitor のみ。複数モニタ対応は Phase 4 (sidecar backend) で SidecarBackend 側に移す。
4. **HWND intersection**: dirty-rect は **全画面**の範囲。特定 window に関係する rect のみ処理するなら、`enumWindowsInZOrder` で foreground window のスクリーン矩形と AND を取る。Phase 3 では "foreground window 一択" として簡略化。
5. **RoiScheduler の `lastScheduledMs` 状態**: `DirtyRectRouter` 側で保持する。`scheduleRois` 自体は pure function なので渡し忘れない。
6. **Loop の CPU 浪費防止**: AcquireNextFrame は 16ms timeout で blocking。アイドル時もそれ以下にしてはならない。

---

# フェーズ 4 — SidecarBackend / OnnxBackend (Production backend)

## 目的

`PocVisualBackend` (stub) を実検出器に置き換え、`GpuWarmupManager._doWarmup`
の `setTimeout(50)` を本物の warmup (モデル load + session compile) に差し替える。

見積り 3〜5 日。native code 多い。

## 前提条件

- フェーズ 3 までマージ済み
- 選択肢 A (ONNX Runtime inline) or 選択肢 B (native sidecar process) の
  どちらかが決定している (設計判断。Opus レビュー推奨)。
- 選んだモデル (DETR/RT-DETR small など) の重みが入手済み

## 変更ファイル一覧

選択肢 A (ONNX Runtime) の場合:

| ファイル | 変更 |
|---|---|
| `src/engine/vision-gpu/onnx-backend.ts` | **新規** `VisualBackend` impl |
| `src/engine/vision-gpu/warmup.ts` (行 37-53) | `warmupFn` を ONNX session ctor に変更 |
| `src/tools/desktop-register.ts` (行 137) | `new PocVisualBackend()` → `new OnnxBackend()` |

選択肢 B (Sidecar) の場合:

| ファイル | 変更 |
|---|---|
| `src/engine/vision-gpu/sidecar-backend.ts` | **新規** |
| `bin/vision-sidecar.exe` (外部) | **新規** Rust/C++ 側実装 |
| 同上 warmup.ts, desktop-register.ts | 同上 |

## 実装詳細

Phase 4 の実装詳細はフェーズ 3 完了後に **別ドキュメント** で精緻化する。
このフェーズの時点で以下が定まっていればよい:

```
### 決定事項 (Phase 4 着手前に PR で確定):
- [ ] backend type: ONNX | Sidecar (どちら?)
- [ ] detector model: 重み URL + ライセンス + ファイルサイズ
- [ ] recognizer: 既存 win-ocr.exe 継続 or 新 path
- [ ] GPU target: DirectML | CUDA | CPU fallback 方針
- [ ] warmup allowance: 初回 N ms (現在 50 ms simulated)
```

**本フェーズの実装スケルトン** (選択肢 A):

```ts
// src/engine/vision-gpu/onnx-backend.ts (概念的スケルトン)
import * as ort from "onnxruntime-node";
import type { VisualBackend } from "./backend.js";
import { GpuWarmupManager } from "./warmup.js";
import type { WarmTarget, WarmState, UiEntityCandidate } from "./types.js";

export class OnnxBackend implements VisualBackend {
  private session: ort.InferenceSession | null = null;
  private readonly warmup: GpuWarmupManager;
  private readonly snapshots = new Map<string, UiEntityCandidate[]>();
  private readonly listeners = new Set<(key: string) => void>();

  constructor(opts: { modelPath: string; executionProviders?: string[] }) {
    this.warmup = new GpuWarmupManager({
      warmupFn: async () => {
        this.session = await ort.InferenceSession.create(opts.modelPath, {
          executionProviders: opts.executionProviders ?? ["dml", "cpu"],
        });
        // Optional: warm forward pass with a dummy tensor.
      },
    });
  }

  async ensureWarm(target: WarmTarget): Promise<WarmState> { return this.warmup.ensureWarm(target); }
  async getStableCandidates(key: string): Promise<UiEntityCandidate[]> { return this.snapshots.get(key) ?? []; }
  onDirty(cb: (k: string) => void) { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  /** Called from Phase 3 DirtyRectRouter with cropped rois. */
  async recognizeRois(targetKey: string, frame: Buffer, rois: Rect[]): Promise<void> {
    // 1. run detector (ORT) → boxes
    // 2. run recogniser (win-ocr.exe for text boxes)
    // 3. CandidateProducer.ingest → pushDirtySignal / updateSnapshot
  }

  async dispose() { await this.session?.release(); /* ... */ }
}
```

## コミット計画

- 4-1: backend choice ADR を `docs/visual-gpu-backend-adr.md` にコミット
- 4-2: backend 実装 + unit tests (fake session で)
- 4-3: warmup `warmupFn` 注入
- 4-4: desktop-register で attach を PocVisualBackend → OnnxBackend に切替
- 4-5: Integration smoke test (ONNX 実モデルが load できるか)

## 完了判定

- [ ] Backend ADR マージ済み
- [ ] `OnnxBackend` / `SidecarBackend` の unit test パス
- [ ] `GpuWarmupManager.warmupFn` 経由で real warmup 動作 (setTimeout 経路消滅)
- [ ] Outlook PWA で **10 個以上**の visual_gpu 候補が帰る (手動計測)
- [ ] Phase 1〜3 のテスト全パス

## 注意点

- ORT DirectML EP は Windows 11 + 最新 GPU driver 前提。ユーザーによっては CPU フォールバックが必要。
- sidecar 選択時は stdio frame protocol の設計が重い。ネゴシエーションを別 ADR で明示。
- warmup が本当に時間がかかるので `coldWarmupMs` のデフォルトは 50→3000ms など見直し。

---

# フェーズ 5 — BenchmarkHarness + リリース判定

## 目的

`src/engine/vision-gpu/benchmark.ts` を実稼働させ、latency / recall / frame-impact
の数値を採取。Go/No-Go を判断する閾値を決めてリリース可否を確定させる。

## 前提条件

- フェーズ 4 完了 (実 backend が動いている)

## 変更ファイル

| ファイル | 変更 |
|---|---|
| `tests/integration/visual-gpu-benchmark.test.ts` | **新規** (RUN_VISUAL_GPU_BENCH=1 gate) |
| `docs/visual-gpu-release-gates.md` | **新規** (閾値定義) |
| `src/engine/vision-gpu/benchmark.ts` (行 38-50) | 必要なら cpuPct / vramMb 計測追加 |

## 実装スケルトン

```ts
// tests/integration/visual-gpu-benchmark.test.ts
import { BenchmarkHarness } from "../../src/engine/vision-gpu/benchmark.js";
import { getVisualRuntime } from "../../src/engine/vision-gpu/runtime.js";
// ... setup ...

describe.skipIf(!process.env["RUN_VISUAL_GPU_BENCH"])("visual-gpu benchmark", () => {
  it("cold / warm / idle on Outlook + Chrome + Notepad", async () => {
    const h = new BenchmarkHarness();
    for (const target of ["outlook", "chrome", "notepad"] as const) {
      for (const mode of ["cold", "warm", "idle"] as const) {
        await h.measure(/* BenchmarkTarget */, mode, async () => {
          /* trigger desktop_see */
        });
      }
    }
    const metrics = h.getMetrics();
    // Write JSON to artifacts/visual-gpu-bench.json
    // Assert: warm-latency ≤ 250ms, idle-cpu ≤ 2%, touchSuccessRate ≥ 0.95
  });
});
```

## 完了判定

- [ ] `RUN_VISUAL_GPU_BENCH=1` で benchmark が完走し、JSON artifact を出力
- [ ] `docs/visual-gpu-release-gates.md` に閾値と現状値のセクションが埋まっている
- [ ] Go 判定: すべての target で warm-latency ≤ 目標、idle-cpu ≤ 目標、recall ≥ 目標

## 注意点

- cpu / vram 計測は Windows 固有の API (`Win32_PerfFormattedData_Counters_GPUEngine` など)。Phase 5 に入ってから精緻化。
- benchmark が真に信頼できるのは Phase 4 で real warmup が入ってから。それ以前の数字は全部 "stub の時間" で、リリース判定には使えない。

---

# 付録 A — フェーズ全体の依存関係と commit pointer

```
Phase 1 (OCR adapter) ──► commits 1-1..1-4
   │
   └─► Phase 2 (kill-switch) ──► 2-1..2-3
         │
         └─► Phase 3 (Desktop Dup) ──► 3-1..3-4
               │
               └─► Phase 4 (real backend) ──► 4-1..4-5
                     │
                     └─► Phase 5 (bench + gate) ──► 5-1..5-3
```

各フェーズは独立してロールバック可能。Phase 1 のみ merge した状態で本番運用
しても破綻しない (OCR が既に本番動作しているので、新たな失敗モードは adapter
内部 catch で封じ込める)。

# 付録 B — 既存テストとの互換性

| テスト | 影響 |
|---|---|
| `tests/unit/visual-gpu-capability.test.ts` (17 cases) | 変更なし。Section D "production gap snapshot" は Phase 1 後に更新要 (別 PR で) |
| `tests/unit/candidate-producer.test.ts` | 変更なし |
| `tests/unit/temporal-fusion.test.ts` | 変更なし |
| `tests/unit/track-store.test.ts` | 変更なし |
| `tests/unit/roi-scheduler.test.ts` | 変更なし |
| `tests/unit/poc-backend.test.ts` | Phase 4 で PocVisualBackend が production から外れる時に見直し |
| `tests/unit/dirty-signal.test.ts` | 変更なし |
| `tests/integration/visual-gpu-vs-ocr.test.ts` | Phase 1 後に "visual lane is now populated by OCR adapter" ケース追加 |
| `tests/integration/ocr-golden.test.ts` | 変更なし (adapter は OCR の戻り値を変えない) |

# 付録 C — 各フェーズ完了後の観察可能な変化

| Phase | desktop_see(Outlook) の visible change |
|---|---|
| 前 | UIA: 2 / visual_gpu: 0 / ocr: N |
| 1 | UIA: 2 / visual_gpu: N (2回目から) / ocr: N |
| 2 | 同上 (kill-switch OFF時) |
| 3 | UIA: 2 / visual_gpu: N (1秒以内に更新) / ocr: N |
| 4 | UIA: 2 / visual_gpu: M (>N, 検出器由来で richer) / ocr: N |
| 5 | 同上 + release gate が定量的に pass |

---

END OF PLAN.
