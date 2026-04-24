# ADR-004: Visual GPU Phase 4 — Backend Architecture Choice

- Status: **Superseded by ADR-005** (`docs/visual-gpu-backend-adr-v2.md`, 2026-04-24)
  - 理由: DirectML maintenance mode + AMD RX 9070 XT (RDNA4) dogfood baseline + WinML 移行 + vendor portability (L6) を織り込む再判断が必要だった
- Date: 2026-04-24
- Authors: Claude (Opus) — project `desktop-touch-mcp-fukuwaraiv2`
- Supersedes: `docs/visual-gpu-dataplane-plan.md` §Phase 4 の backend skeleton
- Superseded by: `docs/visual-gpu-backend-adr-v2.md` (ADR-005)
- Related:
  - `docs/visual-gpu-phase4-rollout.md` (こちらも Superseded)
  - `docs/visual-gpu-capability-audit.md`
  - `docs/gpu-visual-poc-plan.md`
- Blocking: Phase 3 (DirtyRectRouter) の完了
- Blocks: ~~Phase 4 implementation PR~~ (ADR-005 に引き継ぎ)

---

## 1. この ADR が決めるもの / 決めないもの

この ADR は **Visual GPU lane の恒久アーキテクチャ判断**だけを扱う。

### 決めるもの

- `VisualBackend` を実装する実ランタイムの形
- ONNX 実行基盤を main process inline に置くか sidecar に分けるか
- GPU execution provider の優先順
- recognizer / model distribution の恒久方針

### 決めないもの

- Phase 4a / 4b の段階導入順序
- detector skip をどこまで許容するか
- OmniParser をいつ default にするか
- benchmark gate をどこで満たしたとみなすか

これらの **移行判断 / rollout 判断**は ADR ではなく
[`visual-gpu-phase4-rollout.md`](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/visual-gpu-phase4-rollout.md)
で扱う。

---

## 2. Context

### 2.1 現状

Phase 3 時点の visual_gpu lane は、DirtyRectRouter で ROI を作りつつも、実際の認識は
`runSomPipeline` に依存している。そのため候補生成の実体はまだ OCR 中心であり、
Outlook PWA / Electron SaaS のような UIA-blind target で text 以外の UI 要素は拾えない。

### 2.2 Phase 4 で本当に必要なこと

Phase 4 の本質は「detector をすぐ入れること」ではなく、
**real detector / recognizer を後から差し込める backend architecture を確定すること**
である。

この project が避けたいのは次の 2 つ。

1. detector 導入のたびに runtime shape を変えること
2. GPU / model / cache failure が visual lane 全体を壊すこと

---

## 3. Decision

### D1. Backend shape

**採用: `onnxruntime-node` inline backend**

- `OnnxVisualBackend` を Node.js main process 内で動かす
- `VisualBackend` interface は維持する
- sidecar 分離は将来 option として残すが、Phase 4 の採用形にはしない

**理由**

- 既存の warmup / lifecycle / fallback 設計に自然に乗る
- `desktop-register.ts` での差し替えが最小で済む
- デバッグ / telemetry / rollback を 1 process 内で扱える
- Phase 4 の工数と zip 複雑度の増加を抑えられる

**却下した案**

- native sidecar
  - crash isolation は魅力だが、IPC / spawn / health check / model path 同期が増え、Phase 4 の主目的をぼかす

### D2. Execution provider policy

**採用: DirectML first, CPU fallback, CUDA opt-in only**

- default path は `DirectML -> CPU`
- CUDA は明示 opt-in でのみ有効

**理由**

- Windows 11 前提の配布で最も現実的
- driver 差異で全体が壊れにくい
- fallback policy が明確で、dogfood / release gate と相性が良い

### D3. Recognizer policy

**採用: recognizer は既存 `bin/win-ocr.exe` を継続**

- detector backend を差し替えても recognizer は温存する
- OCR を捨てるのではなく、detector と組み合わせる

**理由**

- 日本語/英語 OCR 品質がすでに十分
- 既存 pipeline / tests / golden 資産をそのまま使える
- detector 導入と recognizer 置換を同時にやる必要がない

### D4. Model distribution policy

**採用: zip 非同梱 + 初回ダウンロード + ローカル cache**

- 実モデルは GitHub Release などから取得
- `%USERPROFILE%\\.desktop-touch-mcp\\models` に cache
- sha256 検証を必須とする

**理由**

- launcher / zip のサイズ制約に収めやすい
- model 更新と runtime 更新を緩く分離できる
- failure 時に transparent fallback を取りやすい

### D5. Detector model selection

**この ADR では確定しない**

detector model の採否は、architecture ではなく rollout judgement に強く依存する。
Phase 4a で detector skip を許容するか、Phase 4b で OmniParser を採用するかは
[`visual-gpu-phase4-rollout.md`](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/visual-gpu-phase4-rollout.md)
で扱う。

この ADR の立場は次の 1 行に尽きる。

> detector は差し替え可能な前提で backend を固定し、特定モデルの rollout は別文書で判断する。

---

## 4. Resulting architecture

```text
DirtyRectRouter / scheduleRois
        │
        ▼
OnnxVisualBackend.recognizeRois
        ├─ ensureWarm()
        ├─ detector (optional / rollout-gated)
        ├─ recognizer = win-ocr.exe
        ├─ merge / dedup
        ▼
TrackStore -> TemporalFusion -> CandidateProducer -> pushDirtySignal
        ▼
VisualRuntime -> visual-provider
```

この構造では detector が未投入でも backend shape は変わらない。
Phase 4a の暫定状態も、Phase 4b の detector 有効化も、同じ backend boundary 上で扱える。

---

## 5. Consequences

### 良い点

- architecture decision と rollout compromise を分離できる
- detector 導入前でも backend boundary を先に安定化できる
- fallback / cache / execution provider の責務が明確

### 悪い点

- detector model 自体の採否は別文書参照になる
- 1 枚で全部分かる感じは減る
- sidecar を今すぐ試したい場合の自由度は下がる

---

## 6. Acceptance criteria for this ADR

この ADR が Accepted になる条件は、detector の有無ではなく次の 4 点。

1. `VisualBackend` の実装先として inline ORT を採用することに合意できる
2. execution provider policy (`DirectML -> CPU`, CUDA opt-in) に合意できる
3. recognizer 継続方針 (`win-ocr.exe`) に合意できる
4. model distribution policy (zip 非同梱 + cache) に合意できる

Phase 4a / 4b の done criteria は rollout plan 側で管理する。

---

## 7. Rejected alternatives

- **sidecar first**
  - architecture choice と rollout complexity を同時に背負いすぎる
- **CUDA default**
  - driver 依存が強く、Windows 配布の default としては危険
- **recognizer まで同時置換**
  - detector backend 導入と別問題を混ぜる
- **detector model を ADR で先に固定**
  - rollout / benchmark / packaging judgement と切り離せない
