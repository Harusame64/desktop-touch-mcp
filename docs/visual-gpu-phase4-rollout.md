# Visual GPU Phase 4 Rollout

- Status: **Superseded by ADR-005 §5** (`docs/visual-gpu-backend-adr-v2.md` 内に統合済)
  - 理由: ADR 本体と rollout を分離する利点より、checklist 形式で 4a/4b/4c を 1 文書に集約する方が実装担当 (Opus) の作業効率が高い
作成: 2026-04-24
前提 ADR: ~~[`visual-gpu-backend-adr.md`](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/visual-gpu-backend-adr.md)~~ → [`visual-gpu-backend-adr-v2.md`](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/visual-gpu-backend-adr-v2.md) (ADR-005)

---

## 1. この文書の役割

この文書は Visual GPU Phase 4 の **段階導入計画** を扱う。
ここでは妥協や暫定措置を明示してよい。むしろそれを隠さずに管理するための文書である。

ADR が決めたのは backend architecture であり、この文書が決めるのは
**どの順番で user-visible capability を開けるか** である。

---

## 2. Phase 4 の北極星

Phase 4 の北極星は次の 1 行。

> OCR では拾えない UI 要素を visual_gpu lane に供給できる状態へ、安全に移行する。

このため、Phase 4 では次の 2 段階を分離する。

- **4a: backend infrastructure realisation**
- **4b: detector-enabled capability rollout**

---

## 3. Phase 4a — Backend infra realisation

### 3.1 位置づけ

Phase 4a は **detector 導入フェーズではない**。
ここでやるのは、detector を later-bind できる real backend を project に定着させること。

### 3.2 やること

- `PocVisualBackend` を fallback として残しつつ `OnnxVisualBackend` を実装
- real warmup / model cache / execution provider fallback を入れる
- detector は **skip してよい**
- recognizer は既存 `win-ocr.exe` を継続

### 3.3 Done criteria

- `OnnxVisualBackend` が real warmup / real session lifecycle を持つ
- model download + sha256 validation + cache reuse が動く
- failure 時に `PocVisualBackend` へ transparent fallback する
- kill switch が維持される
- regression がない

### 3.4 注意

4a は「real detector が入った」ことを意味しない。
4a の成功は **architecture が本物になった** ことであって、visual capability の最終完成ではない。

---

## 4. Phase 4b — Detector-enabled rollout

### 4.1 位置づけ

Phase 4b で初めて、visual_gpu lane に OCR 以外の UI 要素を増やす。

### 4.2 現時点の第一候補

**OmniParser v2 icon_detect**

採用理由:

- Microsoft 系の公開物で追跡しやすい
- サイズが比較的小さい
- UI アイコン / ボタン寄りの期待が持てる

ただし、これは architecture decision ではなく rollout candidate である。
bench / packaging / license / export 実態によっては差し替えてよい。

### 4.3 Done criteria

- detector feature flag が実装されている
- Outlook PWA / Electron blind targets で OCR-only では拾えない候補が増える
- warm latency / cold latency / idle CPU が gate を満たす
- token budget を破壊しない

---

## 5. Gates

### Gate A — 4a -> 4b

4a を終えたあと、次を確認してから 4b へ進む。

1. warmup / cache / fallback が dogfood を壊していない
2. visual lane failure が opaque でない
3. release artifact size が現実的

### Gate B — detector default-off -> wider rollout

1. detector flag ON で blind target の recall が OCR-only を上回る
2. warm latency / idle CPU が gate 内
3. false positive による token explosion が制御できる

---

## 6. 実装順序

1. 4a backend infra
2. 4a smoke / fallback / cache verification
3. 4b detector prototype behind flag
4. 4b benchmark
5. detector default judgement

---

## 7. Open decisions owned by rollout

- OmniParser を本当に 4b の first detector にするか
- 4a をどの release line に乗せるか
- detector flag をいつ default-on にするか
- model generation cleanup をいつやるか

これらは ADR ではなく、この rollout 文書か follow-up decision memo で扱う。
