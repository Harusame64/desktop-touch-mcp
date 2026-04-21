# Anti-Fukuwarai v2 Phase 3 指示書

作成: 2026-04-21  
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`  
基準コミット: `d189c5b feat(ingress): extend candidate invalidation across browser terminal and visual sources (Phase 2 P2-E)`

---

## 1. このフェーズの狙い

Phase 1 と Phase 2 で、`desktop_see` / `desktop_touch` の facade はかなり product-like になった。  
Phase 3 の主題は、**visual GPU lane を stub から実動へ置き換えること**である。

今回の最重要目標は 1 つ。

```text
3D ゲームの visual-only UI を、warm GPU pipeline と target-scoped dirty ingress で
desktop_see に自然に載せること。
```

このフェーズでは、

- TS control plane
- native / sidecar data plane

の境界を明確にしたまま進める。  
最初から全部を Rust に寄せる必要はないが、**hot path は native に落とせる設計に固定する**。

---

## 2. Phase 2 完了時点の現在地

### 2.1. 良い状態

- `desktop_see` / `desktop_touch` は server 上で呼べる
- session isolation / executor routing / warnings / semantic diff は揃った
- browser / terminal / UIA provider は複数 source を返せる
- ingress は WinEvent 以外にも広がった

### 2.2. まだ stub / 仮実装の箇所

#### A. visual provider は stub

[visual-provider.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-providers/visual-provider.ts#L1) は常に `visual_provider_unavailable` を返す。

#### B. warmup は simulated

[warmup.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/vision-gpu/warmup.ts#L1) は `coldWarmupMs` ベースで、まだ real runtime につながっていない。

#### C. visual ingress は manual dirty hook 止まり

[visual-ingress.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/world-graph/visual-ingress.ts#L1) は `markDirty()` のみで、GPU lane から自動で汚せる状態ではない。

#### D. benchmark は器のみ

[benchmark.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/vision-gpu/benchmark.ts#L1) は記録器としては十分だが、real metrics 収集や fixture 比較はまだこれから。

---

## 3. Phase 3 の方針

### 3.1. control plane / data plane 分離

このフェーズでも TS control plane は維持する。

#### TS control plane

- session registry
- resolver
- lease
- warnings
- semantic diff
- provider composition

#### native / sidecar data plane

- Desktop Duplication
- dirty rect / move rect
- GPU preprocess
- detector / recognizer
- device-local buffer 管理

### 3.2. Visual lane の最短価値

Phase 3 でまず証明すべきことは、UI 全般の完全認識ではない。  
次の 3 点で十分である。

1. game window 単位で warmup できる
2. stable candidate snapshot を返せる
3. dirty signal で ingress を汚せる

---

## 4. 実装順

Phase 3 は 5 Batch に分ける。

### Batch P3-A - Visual Runtime 境界の固定

#### 目的

- visual lane の control/data 境界を固定する
- `visual-provider.ts` が依存する runtime interface を明確化する

#### 実装方針

新規モジュール推奨:

```text
src/engine/vision-gpu/runtime.ts
src/engine/vision-gpu/backend.ts
```

推奨インターフェース:

```ts
type VisualBackend = {
  ensureWarm(target: WarmTarget): Promise<WarmState>;
  getStableCandidates(targetKey: string): Promise<UiEntityCandidate[]>;
  onDirty(cb: (targetKey: string) => void): () => void;
  dispose(): Promise<void>;
};
```

ここでは backend の中身はまだ mock / sidecar bridge でもよい。  
重要なのは interface を固定し、`visual-provider.ts` が stub を卒業できるようにすること。

#### 完了条件

- visual provider が runtime interface へ依存する
- warmup manager が backend 駆動になる
- manual stub を卒業する入口ができる

#### 推奨 commit

```text
refactor(vision-gpu): introduce runtime and backend boundary for visual lane
```

---

### Batch P3-B - Visual Provider 実動化

#### 目的

- `desktop_see` で visual lane の候補が実際に返るようにする

#### 実装方針

[visual-provider.ts](D:/git/desktop-touch-mcp-fukuwaraiv2/src/tools/desktop-providers/visual-provider.ts#L1) を runtime 経由に差し替える。

期待挙動:

- target が visual lane 対象なら `ensureWarm(target)` を踏む
- `getStableCandidates(targetKey)` から候補を取る
- 候補が 0 件でも runtime が生きていれば `visual_provider_unavailable` は出さない
- cold / warming / stale は warnings として返す

推奨 warning codes:

- `visual_provider_warming`
- `visual_provider_stale`
- `visual_provider_failed`

#### 完了条件

- visual provider が非空候補を返せる
- provider stub が消える
- warning policy が P2-C と整合する

#### 推奨 commit

```text
feat(facade): activate visual provider from gpu runtime snapshots
```

---

### Batch P3-C - Dirty Rect / Visual Ingress 接続

#### 目的

- visual runtime から `markDirty()` を自動で叩けるようにする
- event-first invalidation を visual lane でも本物にする

#### 実装方針

まずは full Desktop Duplication 本実装でなくてもよい。  
ただし visual runtime から dirty signal が出ることは必要。

2 段階で進める。

1. sidecar / backend から `onDirty(targetKey)` を発火
2. `visual-ingress.ts` の `markDirty()` へ接続

最終的には次の流れになる。

```text
GPU lane dirty ROI
  -> targetKey resolved
  -> visualIngress.markDirty(targetKey)
  -> next desktop_see calls ingress.getSnapshot(targetKey)
  -> visual provider refreshes only that target
```

#### 完了条件

- visual lane の dirty signal が ingress に入る
- unrelated target は dirty にならない
- idle で timer を増やさない

#### 推奨 commit

```text
feat(ingress): connect visual runtime dirty signals to target-scoped invalidation
```

---

### Batch P3-D - Real detector / recognizer backend

#### 目的

- warm pipeline を simulated から real GPU path へ進める

#### 実装方針

ここは TS で無理に抱え込まない。  
backend は sidecar でも Rust addon でもよいが、次を満たすこと。

- warmup
- candidate snapshot
- dirty callback

PoC 順としては、

1. fake backend
2. replay backend (fixture ベース)
3. real backend

の 3 段階でもよい。

もし real backend へ進む場合の推奨:

- ONNX / WinML / DirectML などは backend 内へ閉じる
- desktop-touch 側には `VisualBackend` interface しか見せない

#### 完了条件

- cold / warm の差が実測で見える
- simulated delay から卒業する
- 3D game fixture で候補を返せる

#### 推奨 commit

```text
feat(vision-gpu): connect real warm detector backend for visual candidates
```

---

### Batch P3-E - Benchmark / Gate

#### 目的

- Phase 3 の成功条件を数値で確認する

#### 実装方針

`BenchmarkHarness` を使って、最低限次を取る。

- cold warmup latency
- warm candidate latency
- idle CPU/GPU
- warnings frequency
- candidate hit rate

game fixture と browser/terminal regression を一緒に見る。

Gate:

1. `desktop_see` が visual candidate を返せる
2. idle cost が悪化していない
3. visual lane が unrelated target を汚さない
4. warning surface が破綻していない

#### 完了条件

- benchmark result を docs か JSON で保存できる
- visual lane 導入前後の比較ができる
- Phase 4 へ進む判断材料が揃う

#### 推奨 commit

```text
test(vision-gpu): add benchmark gates for visual runtime activation
```

---

## 5. 実装上の制約

### 維持すること

- `desktop_see` の通常レスポンスに raw coordinates を出さない
- env flag OFF の blast radius を増やさない
- target-scoped invalidation を崩さない
- warnings と diff code は stable string を維持する

### やらないこと

- この時点で default ON にすること
- release / publish
- full visual lane を一気に完成させようとすること
- TS facade に GPU 実装詳細を漏らすこと

---

## 6. テスト方針

### P3-A

- runtime interface test
- provider/runtime 分離 test

### P3-B

- visual provider warnings
- stable candidate snapshot

### P3-C

- dirty callback -> markDirty -> getSnapshot
- target isolation

### P3-D

- warmup state transition
- replay fixture candidate generation

### P3-E

- benchmark result generation
- regression gate

---

## 7. Phase 3 完了の定義

Phase 3 完了時点で次を満たすこと。

1. `desktop_see` で visual lane が real candidate を返す
2. visual lane が warmup / snapshot / dirty signal を持つ
3. visual invalidation が ingress に自動接続される
4. benchmark で cold/warm/idle が測れる
5. facade の surface は変わらない

ここまで来れば、Phase 4 で experimental quality review、default-on 判断、release planning へ進める。
