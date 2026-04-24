# ADR-004: Visual GPU Phase 4 — 実検出器 Backend の選定

- Status: Proposed (Phase 3 merge 後に Accepted へ昇格予定)
- Date: 2026-04-24
- Authors: Claude (Opus) — project `desktop-touch-mcp-fukuwaraiv2`
- Supersedes: `docs/visual-gpu-dataplane-plan.md` §Phase 4 の暫定スケルトン
- Related: `docs/visual-gpu-capability-audit.md`, `docs/gpu-visual-poc-plan.md`
- Blocking: Phase 3 (DirtyRectRouter) の完了
- Blocks: Phase 5 (Benchmark + Release Gate)

---

## 1. Context (背景)

### 1.1 現状 (Phase 1–3 完了時点で成立しているもの)

```
[Desktop Duplication / DXGI] ──► DirtyRectRouter ──► scheduleRois
                                     │
                                     ▼
                              (Phase 3 現在のフォールバック)
                              foreground hwnd → OcrVisualAdapter.pollOnce
                                     │
                                     ▼
               runSomPipeline (PrintWindow + bin/win-ocr.exe)
                                     │
                                     ▼
     TrackStore ─► TemporalFusion ─► CandidateProducer.ingest
                                     │
                                     ▼
                              pushDirtySignal(targetKey, cands)
                                     │
                                     ▼
                       PocVisualBackend.updateSnapshot (stub)
                                     │
                                     ▼
                       VisualRuntime → visual-provider
                                     │
                                     ▼
                       source:"visual_gpu" candidates
```

Phase 3 時点では **検出器 (detector) が存在しない**。ROI は「dirty-rect + IntersectRect(fgHwnd) + `runSomPipeline`」によって「OCR が text word としてクラスタ化した矩形」にとどまる。すなわち visual_gpu lane は実質 "OCR を dirty-rect で駆動し直したもの" であり、UIA-blind 窓 (Outlook PWA / Electron SaaS) に対してテキスト領域以外の要素 (アイコンボタン、チェックボックス、スライダー、画像リンク) は検出できない。

### 1.2 Phase 4 の目的

`PocVisualBackend` (Map ラッパ) と `GpuWarmupManager.setTimeout(50)` を **本物の検出器+認識器** に置き換えることで、OCR では拾えない UI 要素を visual_gpu lane に供給する。VisualBackend インターフェースは不変。

### 1.3 ユーザー制約の再掲

- OS: Windows 11 / VS Build Tools 済 / GPU 未知 (DirectML 想定、CUDA 任意)
- 配布: npm launcher + GH Release zip (`desktop-touch-mcp-windows.zip`) — **モデルの手動ダウンロード NG**
- 既存: napi-rs + windows crate v0.62 の Rust ネイティブ基盤 (`@harusame64/desktop-touch-engine`)
- 流用対象: `bin/win-ocr.exe` (PrintWindow→WinRT OCR→word+bbox) は **触らない**

### 1.4 設計原則

1. **既存コードを最大限流用** — `win-ocr.exe` / CandidateProducer / TrackStore は不変
2. **障害時は transparent fallback** — Rust 失敗時に TS fallback する UIA/Image engine 方式に倣う
3. **初回起動の体験を損なわない** — npx 初回 < 30s
4. **仕組みで防ぐ** (強制命令 7) — model 欠損・GPU 不在は "OCR fallback 継続" を型レベルで担保

---

## 2. Decisions (採用方針)

### 2.1 サマリ

| ID | 決定項目 | 採用 | 主な却下理由 |
|----|---------|------|--------------|
| **D1** | Backend アーキテクチャ | **A: `onnxruntime-node` inline** | Sidecar は stdio protocol / プロセス生死監視 / zip 容量すべてコスト高。Phase 4 は inline で回し、必要なら Phase 6+ で sidecar 化 |
| **D2** | Detector model | **段階的ロールアウト: Phase 4a = D2-E (detector skip)、Phase 4b = OmniParser v2 icon_detect (MIT)** | 汎用 DETR/RT-DETR は UI fine-tune 要、Florence-2 は 700MB+ でサイズ制約違反 |
| **D3** | GPU Execution Provider | **DirectML → CPU の自動フォールバック。CUDA は明示 opt-in のみ** | CUDA を default にすると driver 依存で初回失敗が増える |
| **D4** | Recognizer | **既存 `bin/win-ocr.exe` を継続** | WinRT OCR は無料かつ日本語/英語が十分 |

### 2.2 D1: なぜ inline (`onnxruntime-node`) か

| 評価軸 | A. onnxruntime-node inline | B. native sidecar |
|-------|---------------------------|-------------------|
| zip サイズ影響 | +~40MB | +~60MB |
| Phase 3 ライフサイクル統合 | 1 process で完結 | spawn/kill/crash-recovery 設計が追加必要 |
| warmup 実装 | `warmupFn` に session.create を差すだけ | IPC handshake 要 |
| デバッグ | `--inspect` でスタックトレースが繋がる | sidecar 側は別ロガーが必要 |
| 実装工数 | 2〜3 日 | 5〜7 日 |

### 2.3 D2: なぜ段階的か (D2-E → OmniParser)

Phase 4 を一発で「高精度検出器フル稼働」にすると以下の risk が同時発火:
1. モデル配信失敗で visual_gpu lane が死ぬ
2. DirectML warmup が想定を超えて desktop_see の p99 が悪化
3. 誤検出で候補数膨張による token budget 枯渇

よって **Phase 4a** (detector skip = OCR のみ、ただし warmup/backend 構造は本物化) と **Phase 4b** (OmniParser icon_detect 投入) に分ける。

**D2 候補比較:**

| 候補 | 採否 | 理由 |
|-----|------|------|
| RT-DETR-S | NG | UI fine-tune 済みモデル公開なし、自前学習要 |
| Florence-2 / Grounding DINO | NG | 700MB〜1.5GB、サイズ制約違反 |
| PaddleOCR Layout | NG | 文書レイアウト特化、UI アイコン苦手 |
| ScreenSpot / UI-DINO | 保留 | 再配布ライセンス不明瞭 |
| **OmniParser v2 icon_detect** | **Phase 4b 採用** | **Microsoft 公式、MIT、YOLOv8-nano ベースで ~50MB、UI アイコン/ボタン向け学習済み、ONNX export 公開済** |
| D2-E: detector skip | **Phase 4a 採用** | 実装工数ほぼゼロ、infra 本物化に集中 |

---

## 3. Recommended architecture (推奨アーキテクチャ全体図)

```
                              Phase 3 成果物 (そのまま)
                    ┌──────────────────────────────────────┐
                    │  DirtyRectRouter (Desktop Duplication)│
                    │    → scheduleRois → rois (screen abs) │
                    └───────────────┬──────────────────────┘
                                    ▼
                    ┌─────────── Phase 4 新設 ─────────────┐
                    │   OnnxVisualBackend.recognizeRois    │
                    │                                       │
                    │   0. ensureWarm (DirectML session)    │
                    │   1. crop rois from PrintWindow frame │
                    │   2. DETECT: OmniParser icon_detect   │  ← 4b で enable
                    │        (feature-flag: default OFF 4a) │
                    │   3. MERGE: icon boxes ∪ ocr words    │
                    │   4. RECOG: win-ocr.exe per-crop      │  ← 既存
                    │   5. dedup (IoU ≥ 0.5, label merge)   │
                    └───────────────┬──────────────────────┘
                                    ▼
                    ┌────────────── 既存 ──────────────────┐
                    │ TrackStore (IoU=0.3) → TemporalFusion │
                    │ → CandidateProducer.ingest            │
                    │ → pushDirtySignal                     │
                    └───────────────┬──────────────────────┘
                                    ▼
                    ┌─────── 置換 (stub→real) ─────────────┐
                    │   OnnxVisualBackend                   │
                    │   ── implements VisualBackend ──      │
                    │     ensureWarm  : real session.create │
                    │     getStable   : Map<key, cand[]>    │
                    │     onDirty     : push-based fanout   │
                    │     dispose     : session.release     │
                    └───────────────┬──────────────────────┘
                                    ▼
                              VisualRuntime → visual-provider
```

---

## 4. Implementation file list (実装ファイル一覧)

### 4.1 新規ファイル

| パス | 役割 | 推定行 |
|------|------|--------|
| `src/engine/vision-gpu/onnx-backend.ts` | `VisualBackend` 実装本体。session 管理 + recognizeRois | ~250 |
| `src/engine/vision-gpu/onnx-detector.ts` | OmniParser icon_detect の入出力 pre/post-process (NMS, letterbox) | ~180 |
| `src/engine/vision-gpu/model-cache.ts` | モデル自動 DL + sha256 検証 + `%USERPROFILE%\.desktop-touch-mcp\models` へのキャッシュ | ~150 |
| `src/engine/vision-gpu/recognizer.ts` | `win-ocr.exe` を "特定 bbox crop" モードで呼ぶ薄い wrapper | ~120 |
| `src/engine/vision-gpu/frame-capture.ts` | PrintWindow→RGBA buffer を export | ~80 |
| `tests/unit/onnx-backend.test.ts` | ORT session をモックして detector/recognizer 分離テスト | ~220 |
| `tests/unit/model-cache.test.ts` | sha256 ミスマッチ / DL 失敗 / 既存キャッシュ再利用 | ~150 |
| `tests/integration/visual-gpu-onnx-smoke.test.ts` | `RUN_VISUAL_GPU_ONNX=1` gated。実モデル DL + session.create + dummy inference | ~100 |
| `docs/visual-gpu-model-distribution.md` | モデル DL URL / sha256 / ライセンス表記 / キャッシュパス仕様 | — |

### 4.2 変更ファイル

| パス | 変更内容 |
|------|---------|
| `src/tools/desktop-register.ts` | `new PocVisualBackend()` → `OnnxVisualBackend.create()` に置換（failure 時は PocVisualBackend に透過フォールバック） |
| `src/engine/vision-gpu/poc-backend.ts` | **残す** (fallback 用)。JSDoc 追記のみ |
| `src/engine/vision-gpu/dirty-rect-source.ts` | `onRois` の receiver を env で A/B 切替 |
| `package.json` | `onnxruntime-node` を `optionalDependencies` に追加 |
| `src/version.ts` | モデルごとの sha256 + 推奨 ORT バージョンを export |

### 4.3 触らないファイル

`bin/win-ocr.exe`, `candidate-producer.ts`, `track-store.ts`, `temporal-fusion.ts`, `dirty-signal.ts`, `visual-provider.ts`, `backend.ts` (interface)

---

## 5. Done criteria (Phase 4 完了判定)

### 5.1 Phase 4a (detector skip, infra 本物化)

- [ ] `OnnxVisualBackend` が `VisualBackend` を実装し、unit test 全パス
- [ ] `warmupFn` 経由で **実 session load が走る** (setTimeout 50 消滅)
- [ ] `model-cache.ts`: GH Release から モデルを DL し sha256 合致、失敗時は PocVisualBackend に透過フォールバック
- [ ] `DESKTOP_TOUCH_DISABLE_VISUAL_GPU=1` kill-switch 未変更動作確認
- [ ] 既存テスト全パス (退行なし)
- [ ] Outlook PWA で desktop_see 2 回 → `source:"visual_gpu"` 候補が OCR 由来の N 個 ± 10% で出る

### 5.2 Phase 4b (OmniParser 有効化)

- [ ] `DESKTOP_TOUCH_VISUAL_GPU_DETECTOR=omniparser` feature flag 実装
- [ ] Outlook PWA で flag ON → OCR で拾えなかった icon ボタン ≥ 5 個出現
- [ ] Phase 5 benchmark: warm-latency p99 ≤ 400ms (DirectML) / ≤ 900ms (CPU)
- [ ] idle CPU 増分 ≤ 2%
- [ ] Model DL 成功率 ≥ 99% (sha256 検証 + retry 3 回)
- [ ] flag default を ON に切替える PR は **Opus レビュー必須**

---

## 6. Risks & mitigations

| # | リスク | 軽減策 |
|---|--------|--------|
| R1 | DirectML EP が特定 GPU driver で load 失敗 | CPU fallback を同一 session config で連結。失敗時は PocVisualBackend に透過 |
| R2 | モデル DL が企業 proxy 下でブロック | `HTTPS_PROXY` 尊重。`DESKTOP_TOUCH_MODEL_PATH` で手動配置も許容 |
| R3 | zip 肥大化 | **zip には同梱しない**。初回起動時 DL + cache |
| R4 | OmniParser 誤検出が OCR 候補を上書き | source prefix 分離は既存担保。feature flag 段階的有効化 |
| R5 | DirectML warmup 長大で see() latency 悪化 | `ensureWarm` は warming promise を返す設計 → OCR-only 先行返却 |
| R6 | CUDA opt-in で driver 不一致 | CUDA は明示 opt-in のみ、default には絶対入れない |
| R7 | Session 常駐による VRAM 占有 | 5 分アイドルで session release (GpuWarmupManager.evicted 既存仕様活用) |
| R8 | `win-ocr.exe` の per-bbox 呼び出しが N×遅い | Phase 4b 内で atlas packing + 1 回 OCR に最適化 |

---

## 7. Estimates & Phase 5 handoff

### 7.1 工数見積り

| Phase | 実装工数 | 主要タスク |
|-------|---------|-----------|
| 4a | **2〜3 日** | OnnxVisualBackend 骨格、warmupFn 注入、model-cache、unit + smoke |
| 4b | **3〜4 日** | OmniParser pre/post-process、per-roi recognition、feature flag、手動観測 |

### 7.2 Phase 5 接続指標

| 指標 | Phase 5 release gate 案 |
|------|-------------------------|
| cold warmup p95 | ≤ 3000ms (DirectML) / ≤ 8000ms (CPU) |
| warm desktop_see p99 | ≤ 400ms (DirectML) / ≤ 900ms (CPU) |
| visual_gpu recall vs OCR | ≥ 1.2 (4b 以降) |
| idle CPU delta | ≤ 2% |
| touchSuccessRate on Outlook PWA | ≥ 0.95 |

### 7.3 Opus レビュー強制ポイント (強制命令 3)

- Phase 4a の PR merge 前
- OmniParser feature flag の default を OFF→ON に倒す PR merge 前
- `npm publish` 前

---

## 8. Open questions

1. OmniParser v2 の ONNX export は commit hash を固定すべきか → Phase 4b 着手時に確定
2. Model cache の世代管理 (旧モデル自動削除) → Phase 6 へ
3. Sidecar 分離の将来 IPC 仕様 → ADR-005 で扱う

---

## 9. Appendix: 代替案却下理由 (one-liner)

- **D1-B Sidecar**: クラッシュ隔離は魅力的だが工数 2x、Phase 4 では見合わない
- **D2-A RT-DETR**: UI fine-tune データセットを自前で作るコストがスコープ外
- **D2-B Florence-2**: モデルサイズが制約 (200MB) を超える
- **D2-C PaddleOCR Layout**: UI アイコン検出精度が不足
- **D2-D ScreenSpot**: 再配布ライセンス不明瞭
- **D3 CUDA default**: driver 依存で dogfood 壊しの前科あり
- **D4 PP-OCR 置換**: WinRT OCR で品質十分、置換動機なし
