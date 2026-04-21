# GPU Visual PoC 実装計画

作成: 2026-04-21

## 1. この文書の役割

この文書は、Sonnet にそのまま渡して PoC を進めるための実装計画書である。  
ゴールは、最小限の迷いで実装バッチを切り、各バッチごとに完了条件を判定できるようにすること。

この PoC の主張は 1 つだけでよい。

```text
3D ゲームの visual-only UI を、GPU warm pipeline と ROI-first で entity 化し、
lease を介して安全に touch できる。
```

---

## 2. スコープ

### 含める

- Desktop Duplication ベースの visual substrate
- GPU warmup
- ROI scheduler
- scene-text detector / recognizer の実行基盤
- `UiEntityCandidate` への正規化
- lease を使った touch
- benchmark harness

### 含めない

- facade の完全公開
- 58 ツールの削除
- 永続 DB
- 全画面 world graph 永続化
- VLM sidecar 必須化

---

## 3. 既存資産の再利用

まず次を土台として使う。

- `D:/git/desktop-touch-mcp/src/engine/winevent-source.ts`
- `D:/git/desktop-touch-mcp/src/engine/event-bus.ts`
- `D:/git/desktop-touch-mcp/src/engine/ocr-bridge.ts`
- `D:/git/desktop-touch-mcp/src/tools/screenshot.ts`
- `D:/git/desktop-touch-mcp/src/engine/perception/*`
- `D:/git/desktop-touch-mcp/src/engine/uia-bridge.ts`
- `D:/git/desktop-touch-mcp/src/engine/cdp-bridge.ts`

PoC では既存コードを捨てない。  
visual GPU lane を side lane として足し、最後に facade へ統合する。

---

## 4. 推奨ファイル構成

PoC 用の新規配置は次を推奨する。

```text
src/engine/vision-gpu/
  types.ts
  warmup.ts
  roi-scheduler.ts
  track-store.ts
  detector.ts
  recognizer.ts
  temporal-fusion.ts
  candidate-producer.ts

src/engine/world-graph/
  types.ts
  resolver.ts
  lease-store.ts

src/tools/
  desktop.ts

tests/unit/
  roi-scheduler.test.ts
  track-store.test.ts
  temporal-fusion.test.ts
  world-graph-resolver.test.ts
  lease-store.test.ts

tests/e2e/
  gpu-visual-poc.test.ts

tests/fixtures/
  benchmark/
    chrome/
    terminal/
    game/
```

既存の `src/engine/ocr-bridge.ts` には adapter を追加し、最終的に `UiEntityCandidate` を返せるようにする。

---

## 5. 実装バッチ

### Batch 0 - Benchmark Harness

### 目的

改善を測れないまま最適化しないための土台を作る。

### 実装

- benchmark fixture 管理
- metrics 出力形式の統一
- cold / warm / idle の 3 モード計測

### 期待成果物

- benchmark README または docs 断片
- sample result JSON
- fixture 置き場

### 完了条件

- Chrome / Terminal / Game の 3 ケースで同じ形式の計測結果が出る

---

### Batch 1 - GPU Warmup Manager

### 目的

pre-shot warmup を明示的に管理する。

### 実装

- model load
- session create
- persistent buffer allocate
- dummy inference
- warm / cold state 管理

### 推奨 API

```ts
type VisualGpuRuntime = {
  ensureWarm(target: WarmTarget): Promise<WarmState>;
  getState(): WarmState;
  dispose(): Promise<void>;
};
```

### 完了条件

- cold start と warm start が計測できる
- warm 状態が再利用される

---

### Batch 2 - ROI Scheduler

### 目的

dirty rect を ROI に変換し、毎フレーム full inference を防ぐ。

### 実装

- dirty rect expand
- merge
- debounce
- cooldown
- stable 判定

### 推奨 API

```ts
type RoiScheduleInput = {
  dirtyRects: Rect[];
  nowMs: number;
};

type RoiScheduleOutput = {
  rois: Rect[];
  skipped: number;
  mode: "idle" | "tracking" | "recognize";
};
```

### 完了条件

- 同じ ROI が無限再評価されない
- full-frame fallback が通常ルートに入っていない

---

### Batch 3 - Track Store

### 目的

時間の仮想化を、frame diff ではなく track persistence として持つ。

### 実装

- track 生成
- IoU ベース更新
- lost 管理
- best frame 管理

### 推奨 API

```ts
type TrackStore = {
  update(rois: Rect[], nowMs: number): VisualTrack[];
  getStableTracks(): VisualTrack[];
  markRecognized(trackId: string, result: RecognizedText): void;
};
```

### 完了条件

- track の stable / lost が正しく遷移する
- recognizer は stable track のみ受ける

---

### Batch 4 - Detector / Recognizer Binding

### 目的

GPU 推論を最小構成で動かす。

### 実装

- detector 実行
- recognizer 実行
- device-local / bound memory 優先
- CPU への不要コピーを避ける

### 完了条件

- ROI から text candidate が取れる
- warm path が cold より速い

---

### Batch 5 - Temporal Fusion

### 目的

1 フレームの OCR ミスを吸収する。

### 実装

- confidence weighted vote
- consecutive agreement
- best frame retention

### 推奨 API

```ts
type TemporalFusion = {
  update(trackId: string, candidate: RecognizedText): FusedTextState;
};
```

### 完了条件

- 文字列が揺れるケースで premature commit しない
- stable text 判定ができる

---

### Batch 6 - Candidate Producer

### 目的

visual lane の結果を world schema に乗せる。

### 実装

- `UiEntityCandidate` 生成
- role / actionability 仮付与
- confidence 集約

### 完了条件

- visual-only lane の候補が resolver 入力として使える

---

### Batch 7 - World Resolver + Lease

### 目的

candidate を entity に名寄せし、touch 用 lease を発行する。

### 実装

- source merge
- stable entityId 生成
- lease 発行
- TTL / digest / generation 管理

### 推奨 API

```ts
type LeaseStore = {
  issue(entity: UiEntity, viewId: string, generation: string): EntityLease;
  validate(lease: EntityLease): LeaseValidationResult;
};
```

### 完了条件

- stale lease が拒否される
- same entity を再解決できる

---

### Batch 8 - Guarded Touch Loop

### 目的

visual-only entity を安全に操作する。

### 実装

- pre-touch re-resolve
- occlusion / modal check
- guarded mouse fallback
- semantic diff

### 完了条件

- 誤クリックではなく safe fail できる
- 実行後に diff が返る

---

### Batch 9 - Facade Integration

### 目的

PoC 成果を `desktop_see` / `desktop_touch` に載せる。

### 実装

- `src/tools/desktop.ts`
- `desktop_see`
- `desktop_touch`
- debug view だけ座標を返す

### 完了条件

- Game / Chrome / Terminal を同じ API で触れる

---

## 6. Sonnet への実装ルール

### ルール 1

batch を跨いで同時に大きく進めない。  
各 batch ごとに unit test と acceptance criteria を満たしてから次に進む。

### ルール 2

steady state で full-frame inference を入れない。  
どうしても必要なら recovery path に限定する。

### ルール 3

raw coordinates は facade の通常レスポンスに出さない。  
必要なら debug option を切る。

### ルール 4

認識精度だけでなく、idle load と game frame-time impact を常に一緒に見る。

---

## 7. チェックリスト

### 技術チェック

- [ ] warmup が 1 回だけ走る
- [ ] warm path が再利用される
- [ ] ROI scheduler が full-frame を常態化させない
- [ ] stable track のみ recognizer に送る
- [ ] `UiEntityCandidate` に正規化される
- [ ] lease validation がある
- [ ] guarded touch がある

### 品質チェック

- [ ] 3D game のボタン文字を再認識できる
- [ ] Chrome で structured lane に退避できる
- [ ] Terminal で text lane に退避できる
- [ ] idle load が低い
- [ ] touch success rate を計測できる

---

## 8. 最初の一手

Sonnet に最初に渡すなら、次の順が最も効率的である。

1. Batch 0
2. Batch 1
3. Batch 2
4. Batch 3

つまり最初の成果物は facade ではなく、**benchmarkable な warm ROI substrate** である。  
ここが固まると、その先の resolver と facade は一気に乗る。

---

## 9. 関連ドキュメント

- [Anti-Fukuwarai-V2.md](D:/git/desktop-touch-mcp/docs/Anti-Fukuwarai-V2.md)
- [空間と時間の仮想化-plan.md](D:/git/desktop-touch-mcp/docs/空間と時間の仮想化-plan.md)
