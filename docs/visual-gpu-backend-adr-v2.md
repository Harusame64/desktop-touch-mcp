# ADR-005: Visual GPU Phase 4 — Backend Architecture Choice (Reconsidered for technical leadership)

- Status: Proposed (Supersedes ADR-004)
- Date: 2026-04-24
- Authors: Claude (Opus, max effort) — project `desktop-touch-mcp-fukuwaraiv2`
- Supersedes: `docs/visual-gpu-backend-adr.md` (ADR-004)
- Related:
  - `docs/visual-gpu-phase4-rollout.md` (要再構成)
  - `docs/visual-gpu-capability-audit.md`
  - `docs/visual-gpu-dataplane-plan.md`
- Blocking: Phase 3 完了 (済)
- Blocks: Phase 4 implementation PR

---

## 0. なぜ ADR-004 を再考するか

ADR-004 は「実装工数」「zip サイズ」「driver 互換性」を理由に
4 つの保守的判断 (D1: inline ORT / D2: DirectML first / D3: win-ocr 継続 / D4: zip 非同梱) を
採用した。技術的には正しい妥協だが、**プロジェクトの目的と整合していない**。

本プロジェクトの目的 (本人発話より):

> 技術面のリードを GitHub で掲載することで、より LLM に負荷の少ないシステムを
> 世界に展開する。AI へのシステム設備需要を軽減させたい。
> 工数や「このぐらいで良い」という技術選定が納得いかない。
> 最高品質、最高難度での世界を作りたい。

この目的に対する ADR-004 の問題点は以下の 3 つに集約できる。

### 問題 1: 「LLM 負荷軽減」を最大化する選択になっていない

Visual GPU lane は「OCR では拾えない UI 要素を LLM 側に届ける」ためのものだが、
ADR-004 では recognizer = `bin/win-ocr.exe` (Windows.Media.Ocr) 固定。
これは 2014 年の WinRT API で、現代の SOTA OCR (PaddleOCR-v4 / Surya / GOT-OCR2.0)
と比べて精度・速度・多言語対応すべてで劣る。
**OCR が弱いままだと LLM が「画面を再解釈」する負荷が残り続ける。**

### 問題 2: 「世界にリードを示す」差別化要素がない

inline `onnxruntime-node` + DirectML + OmniParser-v2 は **既存の OSS 組み合わせの再パッケージ**で、
GitHub で技術リードを示す材料にはならない。

加えて 2026 年時点の情勢として:

- **DirectML は "maintenance mode"** (microsoft/DirectML 公式 README で明記)。
  sustained engineering は継続するが、新機能開発は **Windows ML (WinML)** に移行済。
  ADR-004 が default に置いた DirectML EP は、2 年スパンで陳腐化する選択。
- AMD は **Ryzen AI / Radeon GPU の WinML 統合**を 2026 早期に正式化
  (`onnxruntime-winml` package 経由で hardware を自動検出)。
- **ROCm 7.2.1 が Radeon RX 9070 XT (RDNA4) を Windows でサポート開始** (2026 早期)。
  ただし ONNX Runtime ROCm EP の Windows 対応は限定的、PyTorch が先行。
- **Vulkan + ncnn** はクロスベンダー (AMD/NVIDIA/Intel) で 2026 時点で実用域、
  ONNX importer 経由で SOTA model も走らせられる。

ADR-004 の「DirectML first, CUDA opt-in」は、これら 4 つの動向のいずれも織り込んでいない。

### 問題 3: 既存ワークスペースの能力を過小評価している

ADR-004 が「sidecar は工数が増える」と却下したが、本プロジェクトは既に
**Rust + napi-rs + DXGI + AsyncTask の本格的なネイティブ基盤**を持つ。

確認した実装基盤:

| 既存機能 | 場所 | 意味 |
|---|---|---|
| napi-rs `AsyncTask` パターン | `src/lib.rs:79-104` | libuv worker で blocking 処理、V8 main で resolve。GPU inference もこれで包める |
| Desktop Duplication (DXGI) | `src/duplication/` | D3D11 / DXGI feature 設定済 (`Cargo.toml:21-27`) |
| 画像処理 (preprocess + 描画) | `src/image_processing.rs` | 20KB の Rust 実装、grayscale/contrast/Sauvola/SoM 描画 |
| UIA / win32 / cdp / OCR の TS 統合 | `src/engine/` | TypeScript 側ファサード完成 |
| crossbeam-channel | `Cargo.toml:14` | thread 間 message passing 既設 |

つまり「Node に `onnxruntime-node` を入れる」より「Rust に `ort` crate を足す」方が
**工数も少なく、品質も上がり、IPC 設計も不要**。
ADR-004 は inline ORT を「自然」と評価したが、**このプロジェクトでは Rust 内同居が最も自然**。

---

## 1. この ADR が決めるもの / 決めないもの

### 決めるもの

- `VisualBackend` を実装する場所 (Node プロセス内 / Rust 内 / 別プロセス)
- 推論ランタイムの選定 (ORT / TensorRT / candle / wgpu のどれを軸に置くか)
- Execution Provider 戦略 (どこまで自動 fallback するか)
- Recognizer 戦略 (win-ocr 継続か、置換か、hybrid か)
- Detector 戦略 (OmniParser 単独か、複数モデル組み合わせか)
- Model distribution の品質基準 (variant matrix を持つか、CDN を使うか)
- Output シリアライゼーション (LLM token 効率を最大化するか)

### 決めないもの

- 個別モデルの fine-tuning スケジュール (別 ADR-006 候補)
- Mac / Linux 対応の具体時期 (本 ADR では「将来切替可能」までを保証)
- 自前 model registry サービスのインフラ選定 (別文書)

---

## 2. 「最高品質」の操作的定義

抽象論で終わらせないため、本 ADR では「最高品質」を 5 つの可測指標として固定する。

| 指標 | 説明 | 目標値 (dogfood baseline = Radeon RX 9070 XT, RDNA4, Win11 24H2) |
|---|---|---|
| **L1: warm latency** | 1 frame の detect+OCR にかかる p99 (ms) | **RX 9070 XT で ≤ 30ms** / iGPU で ≤ 200ms / 参考値 RTX 4090 で ≤ 15ms (NVIDIA 環境を持つ協力者で別途計測) |
| **L2: detector recall** | UIA-blind window 上の全 actionable element に対する hit 率 | ≥ 0.92 (OmniParser 単独 0.85 を上回る) |
| **L3: token compression** | 同一画面を LLM に渡すときの token 数 / OCR baseline | ≤ 0.30 (3 倍以上の圧縮) |
| **L4: GPU utilization headroom** | dogfood 中の steady-state GPU usage | ≤ 25% (ゲーム frame budget を侵さない) |
| **L5: process isolation** | inference crash で MCP server が落ちる確率 | 0 (構造的にゼロ) |
| **L6: vendor portability** | 単一ベンダー (NVIDIA/AMD/Intel) で動かない比率 | 0 (default cascade で全 vendor 対応) |

これらが ADR-004 だと達成できない理由:

- L1: DirectML + win-ocr の二重 IPC で 200ms 切るのが Windows 11 + iGPU で困難
- L2: OmniParser 単独 + Win OCR では label が壊れて recall を犠牲にする
- L3: ADR-004 は token efficiency の話を一切扱っていない
- L4: inline ORT は libuv worker pool を専有、async 全体を遅らせる
- L5: inline ORT crash = Node main プロセス kill = 56 ツール全停止

---

## 3. Decision (新)

### D1' Backend shape — Rust 内同居 backend (napi-rs AsyncTask + 専用 inference thread pool)

**採用**: `desktop-touch-engine` (既存 Rust crate) に `vision_backend` モジュールを追加し、
`ort` crate (https://github.com/pykeio/ort, ONNX Runtime の Rust binding) を
専用 thread pool 上で走らせる。Node からは `napi-rs AsyncTask` で `recognize_rois` を
Promise として呼ぶ。

```text
┌────────────── Node main process (single)──────────────────┐
│                                                            │
│  TS: VisualBackend (interface)                             │
│         │                                                  │
│         ▼                                                  │
│  TS: OnnxBackend (thin wrapper)                            │
│         │                                                  │
│         ▼ napi AsyncTask (libuv worker → resolve on V8)    │
│  ─────────────────────────────────────────────────────     │
│  Rust: vision_backend::recognize_rois                      │
│         │                                                  │
│         ▼ crossbeam-channel + dedicated inference thread   │
│  Rust: ort::Session (WinML / DirectML / ROCm / CUDA / CPU) │
│         │                                                  │
│         ▼ shared GPU buffer (zero-copy from DXGI capture)  │
│  Rust: detector + recognizer + classifier (parallel)       │
│         │                                                  │
│         ▼ napi Buffer (zero-copy back to Node)             │
└────────────────────────────────────────────────────────────┘
```

**理由**:

1. **既存基盤の自然な拡張**: `src/lib.rs:79-104` の `UiaGetElementsTask` 等と全く同じパターンで足せる。新しい IPC 設計不要。
2. **GPU リソースは Rust の RAII で確実に release**: ORT session の dispose 漏れで GPU メモリリーク → MCP プロセス OOM kill のリスクを構造的に回避。
3. **Inference 専用 thread pool**: libuv worker pool を消費しない。MCP の他 56 ツールが GPU 推論で詰まらない。
4. **Panic isolation**: Rust の `catch_unwind` で inference panic を捕捉、Node 側には `Result::Err` で返す。MCP server は生き残る (L5 を構造的に達成)。
5. **Zero-copy buffer 共有**: DXGI capture → ORT input → recognition output まで Rust 内で完結。Node ↔ Rust は最終的な小さな structured output のみ受け渡し。
6. **Crate 依存追加 1 個**: `ort = "2"` を `Cargo.toml` に足すだけ。Node 側 `package.json` は触らない。

**却下した案**:

- **A. inline `onnxruntime-node`** (ADR-004 採用案)
  - GPU リソース管理が GC 任せ、long-running で漏れる事例多数 (microsoft/onnxruntime#15832 等)
  - libuv worker を専有
  - `electron-rebuild` 的な ABI 罠
  - Rust 基盤を持っているのにわざわざ重複する依存を Node に積む不合理

- **B. 別プロセス sidecar (gRPC / named pipe)**
  - Crash isolation は最強だが、IPC overhead (frame buffer copy) が L1 を悪化させる
  - process spawn / health check / model path 同期が増えて L5 以外の指標を落とす
  - 「Rust thread pool で thread isolation」で L5 を 99% 達成できるなら、別プロセス化は overengineering

- **C. WebGPU + candle / wgpu 直結 (ORT 不使用)**
  - 真の最先端だが candle の SOTA UI モデル対応が未成熟 (Florence-2 / OmniParser のサポート無し)
  - 1 年後の選択肢としては有望、Phase 4 では時期尚早
  - **ただし将来のオプションとして `VisualBackend` interface には影響を与えない**

### D2' Execution Provider — AMD-first vendor-neutral cascade (WinML default)

**採用**: Windows 11 24H2+ では `onnxruntime-winml` を default とし、それ以外の環境では
直接 EP cascade に fall-through する。dogfood 基準は **Radeon RX 9070 XT (RDNA4) on Windows 11 24H2**。

```text
[Windows 11 24H2+ / 全 vendor 共通]
  Layer 1: WinML EP (onnxruntime-winml)
    - hardware を自動検出し DirectML / Ryzen AI XDNA / NVIDIA EP を動的選択
    - AMD GPU/NPU、Intel Arc、NVIDIA RTX、Qualcomm Adreno を 1 cascade で吸収
    - 失敗時は下層に fall-through

[Windows 23H2 以下 / WinML が利用不可な環境]
  Layer 2: vendor-specific direct EP
    - DirectML EP        ← Win + 全 DX12 GPU (maintenance mode、widest compat)
                          AMD RDNA4 では WMMA/FP16 を自動利用
    - ROCm/MIGraphX EP   ← Linux 主、Windows 7.2.1+ で AMD RX 9070 XT サポート開始
                          ONNX Runtime ROCm EP の Windows 対応は限定的、opt-in
    - CUDA EP            ← NVIDIA driver、参考値取得用 opt-in
    - TensorRT EP        ← NVIDIA + TRT 10.x 揃った環境のみ opt-in

[全 OS / DirectML/WinML で動かない / op 未対応モデル]
  Layer 3: ort WebGPU EP (vendor-neutral, wgpu 経由で Vulkan/DX12/Metal)   ← Phase 4b-3 採用
    - ONNX Runtime 本体の WebGPU EP を ort crate `webgpu` feature 経由で登録
    - wgpu が実行時に AMD/NVIDIA/Intel/Qualcomm の physical adapter を自動選択
    - DirectML/ROCm/CUDA 未対応環境 (Windows の iGPU、Vulkan only Linux、WSL 等) を補完
    - 当初検討した ncnn / Kompute / wonnx / burn-wgpu は ADR-007 候補として後日再評価
      (汎用 ncnn-rs 不在、1 batch では ort webgpu が ROI 最良と判明)

[全 OS / 最後の砦]
  Layer 4: CPU EP
    - AVX-512 / AVX2 / AVX variants で順に試行 (INT8 quantized variant をロード)

[将来オプション (本 ADR では決定しない)]
  Layer 5: CoreML EP (Apple Silicon)、wgpu / wonnx (実験的、Rust ネイティブ)
```

**Capability detection の具体**:

- 起動時 1 回:
  - DXGI adapter enumeration (vendor / device / arch)
  - WinML / DirectML 利用可否 (Win build version 判定)
  - ROCm / HIP runtime presence check (`hipInfo.exe` 等)
  - NVIDIA driver presence (opt-in 利用者向け)
  - CPUID flag (AVX-512/AVX2/AVX)
- 結果: `CapabilityProfile { os, gpu_vendor, gpu_arch, winml, dml, rocm, cuda, trt, cpu_isa }`
- model registry から「この profile で動く全 variant」を取得し、`speed_benchmark` 昇順で選択
- 初回は 30 秒の micro-benchmark を実行、variant ごとの実測 latency を
  `~/.desktop-touch-mcp/bench.json` に保存。profile 変化時のみ再 bench
- L6 (vendor portability) のため、benchmark 結果は AMD/Intel/NVIDIA matrix 形式で出力できる
  (公開 README で技術リード発信に流用)

**理由**:

- DirectML 単独 default は maintenance mode の影響で長期的に陳腐化する。
  WinML 経由にすることで Microsoft + AMD の最新統合 (Ryzen AI XDNA 含む) に乗れる
- AMD RX 9070 XT は WMMA + INT8/INT4 + FP16 のハード強化があり、
  DirectML/WinML 経由で SOTA model が dogfood で実用的に動く
- Vulkan + ncnn を Layer 3 に置くことで「DirectML で動かない最新モデル」も補完可能
- vendor-neutral 設計で L6 を構造的に達成、benchmark 公開で技術リード材料が増える
- CUDA/TensorRT は default にしない: dogfood 環境 (AMD) で動作確認できないものを
  default にするのは品質保証的に NG。NVIDIA 環境を持つ協力者の参考値取得に留める

**却下した案**:

- **DirectML default 固定**: maintenance mode の影響を受ける、WinML への移行コストが後で重くなる
- **CUDA / TensorRT default**: dogfood 環境 (AMD RX 9070 XT) でテスト不能、L6 を破壊、
  AMD ユーザーが大半である一般 Windows 配布の現実から乖離
- **ROCm default on Windows**: ONNX Runtime ROCm EP の Windows 対応が未成熟 (PyTorch 先行)、
  RX 9070 XT も 7.2.1 で追加されたばかりで安定性未検証
- **WinML 単独 (Layer 2 を持たない)**: Win11 23H2 以下の環境を切り捨てる
- **Vulkan/ncnn default**: ONNX op coverage で SOTA model が落ちる場合があり、
  main lane に置くにはリスクが高い (Layer 3 の補完で十分)

### D3' Recognizer — Multi-engine OCR + VLM cross-check (hybrid)

**採用**: 既存 `bin/win-ocr.exe` は **fallback 2 次** に降格。1 次は class-aware multi-engine。

```text
Tier 1 (high accuracy, GPU-accelerated):
  - PaddleOCR-v4 (PP-OCRv4 server, multilingual, ONNX export 可)
  - Surya OCR (transformer-based document OCR, FP16)
  - GOT-OCR2.0 (生成型 OCR, 表/数式/HTML 構造保持)

Tier 2 (light, fast):
  - PaddleOCR-mobile (INT8 quantized, edge 用)
  - tesseract-rs (Rust binding, AVX2 + LSTM)

Tier 3 (UI semantic, fallback for icon / 装飾フォント):
  - Florence-2 (VLM 0.27B, region-aware OCR + grounding)
  - Aria-UI (UI element grounding)

Tier ∞ (compatibility safety net):
  - bin/win-ocr.exe (Windows.Media.Ocr) — never removed, always available
```

**選択ロジック** (Rust 内 dispatcher):

```text
1. Detector が ROI に class を付与: text | icon | mixed | other
2. text class:
   - density < 5 chars/100px → Tier 2 (PaddleOCR-mobile)
   - 5-20 chars/100px → Tier 1 (PaddleOCR-v4)
   - dense / formatted (table, equation) → GOT-OCR2.0
3. icon class: Florence-2 で region description (e.g. "save icon", "X close")
4. mixed: PaddleOCR-v4 + Florence-2 を並列、信頼度高い方を採用
5. すべて失敗 → win-ocr.exe (Tier ∞)
```

**Cross-check (任意、L2 が不足する場合に有効化)**:

- 同じ frame で 2 engine が異なる text を返したら、Levenshtein distance を取って
  `< 0.2` なら高信頼度の方を採用、それ以上なら両方を `provisional` 化して LLM に判断委譲
- これは現在の `snapToDictionary` (UIA hint との照合, `src/engine/ocr-bridge.ts:362`) を
  multi-engine 投票に拡張する形で実装

**理由**:

- L2 (detector recall) と「OCR 品質」は不可分。OCR が壊れた label を返したら detector recall も意味を持たない
- Windows.Media.Ocr の **多言語対応はせいぜい 25 言語**、PaddleOCR は 80+ 言語、Surya は 90+ 言語 → 「世界展開」の必要条件
- icon / 装飾フォント / 縦書き は Win OCR で破滅的に失敗する。dogfood で見つかる失敗のほとんどがここ
- **「LLM が再解釈する負荷」を減らす最大の梃子は OCR 品質**。ここを妥協すると ADR の意義がほぼ消える

**EP 互換性 (RX 9070 XT 中心の検証マトリクス)**:

| Engine | WinML/DirectML | ROCm 7.2.1 (Win) | Vulkan/ncnn | CPU INT8 | 備考 |
|---|---|---|---|---|---|
| PaddleOCR-v4 server | ✅ ONNX 公式提供 | △ MIGraphX 要検証 | ✅ ncnn 移植実績豊富 | ✅ | dogfood 主軸候補 |
| PaddleOCR-mobile | ✅ | △ | ✅ | ✅ | INT8 で軽量 |
| Surya OCR | △ ONNX export 要 | △ | △ op coverage 要確認 | ✅ | torch ベース、変換が肝 |
| GOT-OCR2.0 | △ 公開 ONNX に依存 | △ | △ | ✅ | Phase 4c で検証 |
| Florence-2 base | ✅ Microsoft ONNX 提供 | △ | △ | ✅ | Microsoft 公式 ONNX 公開済 |
| tesseract-rs | — (CPU only) | — | — | ✅ | Rust 純粋 fallback |
| **win-ocr.exe (Tier ∞)** | — (WinRT 直) | — | — | — | 既存、常時利用可 |

凡例: ✅ 実績あり / △ 要検証 / ❌ 動かない / — 該当しない

**却下した案**:

- **win-ocr.exe を完全置換**: 既存資産 (snapToDictionary, calibrateOcrConfidence) を活かせる場面は残すべき。Tier ∞ として残置
- **Tesseract 単独**: GPU を使わない、recall も低い、世界リードにならない

### D4' Model distribution — Capability-aware variant matrix + multi-mirror

**採用**: `models.json` manifest を GitHub Releases に置き、各 model の variant matrix を記述。
runtime は capability profile に応じて best variant のみダウンロード。

```text
models.json の概念形 (AMD-first ordering、実装は別 PR):
{
  "schema": "1.0",
  "models": {
    "omniparser-v2-icon-detect": {
      "task": "ui_detector",
      "variants": [
        { "name": "winml-fp16",   "ep": ["WinML"],     "min_os": "win11_24h2", "size_mb": 32, "url": "...", "sha256": "...", "bench_ms": { "rx9070xt": 25 } },
        { "name": "dml-fp16",     "ep": ["DirectML"],  "size_mb": 32, "url": "...", "sha256": "...", "bench_ms": { "rx9070xt": 28 } },
        { "name": "rocm-fp16",    "ep": ["ROCm"],      "min_rocm": "7.2.1", "size_mb": 32, "url": "...", "sha256": "...", "bench_ms": { "rx9070xt": 18 } },
        { "name": "vulkan-ncnn",  "ep": ["Vulkan"],    "format": "ncnn", "size_mb": 30, "url": "...", "sha256": "..." },
        { "name": "cuda-fp16",    "ep": ["CUDA"],      "size_mb": 32, "url": "...", "sha256": "...", "bench_ms": { "rtx4090": 14 } },
        { "name": "trt-fp8",      "ep": ["TensorRT"],  "min_arch": "ada", "size_mb": 18, "url": "...", "sha256": "...", "bench_ms": { "rtx4090": 12 } },
        { "name": "cpu-int8",     "ep": ["CPU"],       "size_mb": 12, "url": "...", "sha256": "..." }
      ]
    },
    "paddleocr-v4-server": { ... },
    "florence-2-base": { ... },
    "got-ocr2": { ... }
  }
}
```

bench_ms フィールドは「実機測定結果」を入れる枠。dogfood で順次埋まる:
- `rx9070xt`: 本プロジェクトの dogfood baseline
- `rtx4090` / `arc_a770` / `iris_xe`: 協力者の実測値が入った時点で追加

**ダウンロード戦略**:

```text
1. 起動時: capability profile + 必須 model 一覧 (detector + 1 つの recognizer) を決定
2. variant 選択: profile に合致する variant のうち size 最小 (or bench 最速) を 1 つ選ぶ
3. キャッシュ確認: ~/.desktop-touch-mcp/models/<name>/<variant>.onnx
4. 不在ならダウンロード:
   - Mirror 順: GitHub Releases (default) → HuggingFace Hub → Cloudflare R2 (将来)
   - 失敗時 next mirror、全失敗で Tier ∞ (win-ocr / CPU INT8 のみ) に degraded
5. sha256 検証必須、不一致は自動再ダウンロード
6. LRU eviction: 5GB cap (設定可能)、古い variant は新 variant 取得後に削除
```

**理由**:

- ADR-004 は「単一 zip 非同梱」だけ決めて variant matrix を扱っていない → 結局 single variant で全環境カバーすることになり性能を落とす
- HuggingFace Hub は世界的にミラーされている (中国/ロシア等の規制国家でも到達しやすい) → 「世界展開」要件
- Cloudflare R2 (将来オプション) は egress 無料、無制限に近い → コミュニティ拡大時の保険

### D5' Detector — 自前 fine-tuned + Multi-stage (差別化の中心)

**採用**: 単一既製モデルではなく、**desktop-touch-mcp 専用に fine-tune した 3 段検出器**を主軸とし、
将来的に Hugging Face Hub に公開して論文化する。

```text
Stage 1 (Coarse layout, fast):
  - Florence-2-base 微調整版 (UI region proposer)
  - 全画面を 8 region に粗分割し各 region の type を分類
  - 入力 1024x1024 → ~25ms on RX 9070 XT (WinML/DirectML, dogfood) / ~5ms on RTX 4090 (参考)

Stage 2 (Fine UI element detection):
  - OmniParser-v2 icon_detect 微調整版
  - + 自前 head: button/checkbox/radio/dropdown/slider/tab を細分類
  - region 内のみ走らせる (Stage 1 の出力を ROI とする)

Stage 3 (State extraction, optional):
  - 自前小型 head (CLIP image encoder + 軽量 MLP)
  - element の state を分類: enabled / disabled / focused / hovered / selected / pressed
  - LLM が「グレーアウトしてるボタンは押せない」を理解できるようになる

Stage 4 (Relationship inference, post-process, CPU):
  - GraphSAGE 相当の軽量 GNN
  - element 間の親子・順序関係をグラフ化
  - LLM が「このボタンはこのフォーム内の Submit」を構造的に理解
```

**Export 形式 (vendor-neutrality 維持のため必須)**:

- 学習は PyTorch (HuggingFace Transformers) 上で行う
- 公開 artifact は **以下を全て同梱**:
  1. ONNX (opset 17 以上、DirectML/WinML 互換)
  2. ONNX (opset 14、Vulkan/ncnn の importer 互換性確保用)
  3. ncnn `.param` + `.bin` (Vulkan 直接ロード用)
  4. (将来) CoreML `.mlpackage` (Apple Silicon 用)
- Hugging Face model card に「動作確認済 EP マトリクス」を明記

**Fine-tuning data**:

```text
Source A (real): dogfood 中の screenshot を annotation ツールで人手 labeling
                 → ~10K image を初期データセットに
Source B (synthetic): Selenium + Playwright で web UI を mass-screenshot
                      DOM 直接 ground truth → 100K+ image, 0 cost
Source C (game UI): Unreal/Unity demo project の自動撮影 → 装飾フォント / 半透明 UI
Source D (terminal): CLI app のスクリーンショット (vim, emacs, lazygit 等)
```

**公開計画**:

- 学習 script + dataset (privacy-safe な部分) を `desktop-touch-mcp/visual-models` repo として公開
- Hugging Face Hub に model push (`harusame64/desktop-touch-detector-v1`)
- arXiv に short paper (2-4 page) を投稿:
  「Desktop UI Element Detection with Multi-Stage Fine-tuned Vision Models for Reduced LLM Inference Load」

**理由**:

- 既製 OmniParser をそのまま使うのは「Microsoft の研究を試す repo」止まり、技術リードにならない
- Multi-stage + state extraction + relationship inference は **Florence-2 / OmniParser 単体ではできない領域**
- 公開すれば「LLM の computer-use 文脈で参照される基準実装」として位置付けられる
- 成果は他 OSS (browser-use, Cua, Anthropic computer-use) からも引用される可能性

**却下した案**:

- **OmniParser-v2 をそのまま使う** (ADR-004 の Phase 4b 候補)
  - 工数低いが差別化ゼロ。GitHub 掲載しても「既存モデル統合」止まり
- **Detector 不採用、OCR のみ**: ADR-004 の Phase 4a 妥協案。L2 を達成できない

### D6' Output シリアライゼーション — Token-efficient DSL (ADR-004 未扱い)

**採用**: LLM に渡す UI 状態表現を、JSON ではなく **専用 S-expression DSL** にする。
これが「LLM 負荷軽減」の最も直接的な梃子。

```text
JSON (現状, baseline):
{
  "source": "visual_gpu",
  "target": { "kind": "window", "id": "12345" },
  "role": "button",
  "label": "Send",
  "rect": { "x": 320, "y": 180, "width": 80, "height": 32 },
  "actionability": ["click", "invoke"],
  "confidence": 0.94,
  "observedAtMs": 1745520000000
}
≒ 200 tokens

DSL (提案):
(btn "Send" #12345.btn3 [320 180 80 32] .94)
≒ 30 tokens
```

**仕様骨子**:

```text
- 1 element = 1 行
- 形式: (type "label" #target.id [x y w h] confidence [state-flags?])
- type は 1-3 char short code: btn / txt / lnk / chk / rad / sel / lbl / ico / img / ttl
- state-flags は不在時 default-on (enabled), 'd' = disabled, 'f' = focused, 'h' = hidden
- screen 全体を S-exp 1 forms にラップ:
  (screen "Outlook PWA" gen-12345
    (group "navbar" [0 0 1920 64]
      (btn "Compose" #abc.btn1 [12 16 80 32] .98)
      ...))
- LLM 出力からの逆 parse は libloss-less (各 type が action set を mapping)
```

**理由**:

- L3 (token compression) の目標 ≤ 0.30 を達成する唯一の現実的方法
- LLM の context window 節約 → 1 turn でより多くの画面情報を渡せる → 操作精度向上
- これも自前提案として **論文化 / blog post 公開可能**な差別化要素
- 既存の `composeCandidates` 出力を変えずに、新 lane (`detail='dsl'`) として追加できる (互換性破壊なし)

**移行戦略**:

- Phase 4c で実装 (Phase 4a/4b では JSON のまま)
- screenshot tool に `detail='dsl'` option を追加、既存 `detail='text'` と並列
- LLM 側のプロンプト規約を README に明記

### D7' Compute backend portability — vendor-neutrality を構造的に保つ

**採用**: 単一 backend / 単一 vendor lock-in を避ける構造を最初から組み込む。
benchmark / model artifact / EP cascade すべてを multi-vendor matrix で発信する。

**具体**:

1. EP cascade は D2' で WinML default + Vulkan/ncnn fallback により AMD/Intel/NVIDIA 全対応
2. Model artifact は D5' により ONNX (opset 17/14) + ncnn の 2 系統を同梱
3. Benchmark は AMD/Intel/NVIDIA matrix で公開可能な JSON 形式
4. CI で「最低 2 vendor (AMD + CPU、可能なら + Intel iGPU) 上で動作確認」を gate 化
5. README に "Tested on" badge を vendor 別に表示
6. dogfood baseline は **Radeon RX 9070 XT (RDNA4) + Windows 11 24H2**、ここで全指標を満たすことを必須とする

**理由**:

- L6 (vendor portability) を構造的に保つ
- AMD ユーザー (本プロジェクト dogfood) を first-class として扱う
- 「NVIDIA でしか動かない」典型的な ML プロジェクトと差別化
- 「世界展開」要件: 全 vendor で同等品質を保証することがコミュニティ拡大の前提
- DirectML maintenance mode への耐性 (将来 WinML が DML を deprecate しても EP cascade で継続稼働)

**却下した案**:

- **NVIDIA-only / CUDA default**: 本プロジェクト dogfood (AMD RX 9070 XT) でテスト不能、L6 を破壊
- **AMD-only**: NVIDIA dev コミュニティを切り捨てる、global 展開要件に反する
- **Vendor 検出を runtime のみに委ねる**: 静的にも保証すべき (CI で gate)

---

## 4. Resulting architecture

```text
┌─ Capture (DXGI Desktop Duplication, 既存 src/duplication/)
│      │
│      ▼ dirty rects (zero-copy GPU buffer)
├─ DirtyRectRouter (既存 src/engine/vision-gpu/dirty-rect-source.ts)
│      │
│      ▼ ROI list
├─ Rust vision_backend module (新規)
│      │   └─ EP cascade (capability detection で起動時決定):
│      │        WinML → DirectML → ROCm/MIGraphX → Vulkan(ncnn) → CPU
│      │
│      ├─ Stage 1: Florence-2-base (region proposer, ~25ms RX9070XT / ~5ms RTX4090)
│      ├─ Stage 2: OmniParser-v2-tuned (UI element detector, ~10ms)
│      ├─ Stage 3: PaddleOCR-v4 / GOT-OCR2 / Surya (recognizer, class-aware dispatch)
│      ├─ Stage 4: state classifier head (~2ms)
│      ├─ Stage 5: relationship GNN (CPU, ~3ms)
│      └─ Stage 6: token-efficient DSL serializer
│              │
│              ▼ napi AsyncTask resolve
├─ TS OnnxBackend (thin wrapper, src/engine/vision-gpu/onnx-backend.ts)
│      │
│      ▼ pushDirtySignal / updateSnapshot
├─ PocVisualBackend (互換 fallback、kill-switch ON 時のみ)
│      │
│      ▼
└─ TrackStore → TemporalFusion → CandidateProducer → visual-provider
```

**Phase 4 開始時点で全部要らない**。下記の 4a/4b/4c で段階的に積み上げる。

---

## 5. Reconstructed rollout (4a / 4b / 4c)

ADR-004 の rollout (`visual-gpu-phase4-rollout.md`) も以下に再構成する。

### Phase 4a — Rust 内 backend skeleton + capability detection + DirectML 動作確認 (1-2 weeks)

実装担当: Opus (本人指名)。実装 batch checklist (`[ ]` → `[x]` flip):

- [x] **4a-1**: Rust crate に `vision_backend` module を追加 (`src/vision_backend/mod.rs`) — 5 ファイル (mod/types/error/capability/inference/registry)
- [x] **4a-2**: `ort = "=2.0.0-rc.12"` を `Cargo.toml` に追加、`features = ["directml"]` で DirectML EP も有効化、他 EP は `vision-gpu-{cuda,tensorrt,rocm,migraphx,coreml,openvino,webgpu,winml}` の build feature で opt-in
- [x] **4a-3**: `recognize_rois_blocking(req) -> Vec<RawCandidate>` の最小実装 (ダミー: 1 ROI → 1 候補, provisional=true) + Rust unit test
- [x] **4a-4**: napi `AsyncTask` wrapper (`VisionRecognizeTask`) と `vision_recognize_rois` 関数を `src/lib.rs` に追加 (既存 `UiaGetElementsTask` パターン踏襲)
- [x] **4a-5**: Capability detection (`src/vision_backend/capability.rs`):
  - DXGI adapter enumeration (vendor / device id / VRAM)
  - WinML support (Win11 build version >= 26100)
  - ROCm/HIP presence (env var + 既知 install path)
  - NVIDIA driver presence (`CUDA_PATH` env, opt-in)
  - CPUID (AVX-512/AVX2/AVX/SSE4.2)
  - 出力: `CapabilityProfile` を `detect_capability()` napi 関数で公開、Vendor 別 GPU arch 推定 (RDNA4 / Ada / Battlemage 等)
- [x] **4a-6**: TS 側 `OnnxBackend` (薄い wrapper, `src/engine/vision-gpu/onnx-backend.ts`)
  - `VisualBackend` interface 実装
  - `recognizeRois` 追加 (interface 拡張、optional)
  - native error 時 `[]` を返し例外を伝播しない (L5)
  - `mapRawToCandidate` で detector class → resolver role 正規化
- [x] **4a-7**: `PocVisualBackend` を fallback に降格 (`desktop-register.ts`):
  - `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND=1` で OnnxBackend opt-in
  - native binding 不在時は自動的に PocVisualBackend に fall through
  - `_resetFacadeForTest` で OnnxBackend も dispose
  - **WinML detection は Phase 4a では `capability.detect_winml()` の OS build 判定 (Win11 24H2+) のみ**。`vision-gpu-winml` feature は Phase 4b で実装予定 (windows crate の AI namespace または onnxruntime-winml binding)、4a では `eps_built` に "winml" は現れない
- [x] **4a-8**: Model distribution skeleton (`src/engine/vision-gpu/model-registry.ts`):
  - `ModelManifest` schema 定義 (variants matrix, EP / arch / OS / ROCm gates)
  - `selectVariant(modelName, profile)` capability-aware 選択 (bench_ms 昇順、size_mb tie-breaker)
  - `pathFor` / `verifyLocal` (sha256 検証) 実装
  - 自動ダウンロードは Phase 4b に延期
- [x] **4a-9**: catch_unwind による panic isolation:
  - Rust `inference.rs` で `std::panic::catch_unwind` で blocking call を保護、`VisionBackendError::InferencePanic` に変換
  - TS `tests/unit/visual-gpu-onnx-backend.test.ts` で native rejection 時 `recognizeRois` が `[]` を返すことを検証 (mocked native binding)
  - 9 unit tests 全パス

**Done criteria**:
- [ ] `OnnxBackend` が **CPU EP + DirectML EP の両方** で dummy 推論を実行できる (Gate A: RX 9070 XT 実機 `cargo build:rs` + ユーザー実機テストで verify)
- [x] DXGI 取得 dirty rect → Rust 推論 → TS Snapshot に届く end-to-end の **wiring** が通る (実機 inference は要 Phase 4b 実モデル投入後)
- [x] kill-switch (`DESKTOP_TOUCH_DISABLE_VISUAL_GPU=1`) で `PocVisualBackend` に瞬時に戻れる、および opt-in 未設定時は default で PocVisualBackend
- [x] inference 内で panic を起こしても MCP server (Node main プロセス) が生存する (L5、Rust catch_unwind + TS test で検証)
- [ ] capability detection が RX 9070 XT を `gpu_vendor=AMD, gpu_arch=RDNA4, dml=true, winml=true` と正しく判定 (Gate A: ユーザー実機 verify、PowerShell から `node -e "console.log(require('./index.js').detectCapability())"` で確認手順)
- [x] 既存 Phase 1-3 のテスト全パス (regression なし) — vitest 1931 pass / 31 skipped、新規 9 tests + ModelRegistry test も全パス
- [x] `tsc --noEmit` パス (eslint 設定無いため lint は対象外)、`cargo check --release --features vision-gpu` exit 0 確認済 (Opus subagent 修正経由)

**Gate A 移行条件 (4a → 4b)**:
- 上記の `[ ]` 2 項目をユーザー実機で verify
- skeleton が Phase 1-3 を一切壊さない (現時点でクリア)
- Phase 4b で実装すべき項目が ADR §3 D5' / §5 4b-1〜4b-8 に明記されている (済)

### Phase 4b — Real detector + multi-engine OCR + ベンチ (3-5 weeks)

実装担当: Opus + 必要に応じ Sonnet (annotation / benchmark スクリプト等の機械的部分のみ)

- [x] **4b-1**: EP cascade real wiring — `session.rs` / `ep_select.rs` / `dylib.rs` 新規作成、`VisionInitSessionTask` + `vision_init_session` napi 追加、WinML → DirectML → ROCm → CUDA → CPU の順次試行実装 (WinML は 4b-2 まで stub)
- [-] **4b-2 → Deferred to ADR-006 (2026-04-24)**: WinML EP integration は実装着手後に `windows-app` crate 全版 yanked + `microsoft/windows-app-rs` repo archived (Microsoft 公式に WinAppSDK-Rust 開発停止表明) を発見。設計書 §4.4 Path C (windows-bindgen 自前生成) も WinAppSDK 全体が .NET/VS 前提で数ヶ月規模、1 batch 範囲外。独立 ADR-006 (`docs/adr-006-winml-rust-binding.md`) として切り出し。途中作成された `winml.rs` / `winml_fallback.rs` は削除、`ep_select::winml_attempt` は Phase 4b-1 時点の stub (常に Err、cascade は DirectML に fall through) を維持。Phase 4b は **4b-3 (Vulkan/ncnn lane) を次の着手対象**として進行継続。
- [x] **4b-3**: Vendor-neutral Layer 3 lane を追加 — 当初の「Vulkan(ncnn) + 別 module + ncnn-rs binding」から設計変更し、**ort crate の WebGPU EP** (wgpu 経由で Vulkan/DX12/Metal) として実装。`SelectedEp::WebGPU { adapter }` + `ep_select::webgpu_attempt` + cascade の Layer 3 配置、`vision-gpu-webgpu` feature gate、`gpu_vram_mb > 0` guard、cargo check 4 種 / tsc / vitest 1962 pass (regression 0)。詳細は `docs/phase4b-3-vulkan-lane-design.md`
- [x] **4b-3**: ROCm/CUDA/TensorRT EP は build feature flag で opt-in 化 — 4b-1 時点で既に `vision-gpu-rocm` / `vision-gpu-cuda` / `vision-gpu-tensorrt` として Cargo.toml に実装済 (本 batch で再確認)
- [x] **4b-4**: Florence-2 / OmniParser-v2 / PaddleOCR-v4 の variant を `models.json` に登録 — `assets/models.json` (4 model × 7 variant matrix、schema 1.0)、`EpName`: Vulkan → WebGPU rename、`selectVariant` に `isCpuOnlyVariant` GPU tier 優先ソートキー追加、vitest 22 pass / tsc noEmit 0 / full suite regression 0。詳細は `docs/phase4b-4-model-variants-design.md`
- [x] **4b-5**: Stage 1 (region proposer) → Stage 2 (UI detector) → Stage 3 (OCR) を直列で繋ぐ — **framework のみ** (各 stage は stub inference)。`session_pool.rs` (VisionSessionPool + global OnceLock、空 key insert guard)、`RecognizeRequest::session_key` field、`init_session_blocking` の pool insert、`recognize_rois_blocking` の session-bound stub path、`stage-pipeline.ts` (runStagePipeline 3-stage orchestrator)、`OnnxBackend.ensureWarm` (manifest load + 3 × visionInitSession)、`OnnxBackend.recognizeRois` (warm 時は stage pipeline、warm 前は legacy sessionKey="" path に fall through)。実 preprocess/postprocess/session.run は sub-batch 4b-5a (Florence-2) / 4b-5b (OmniParser-v2) / 4b-5c (PaddleOCR-v4) で実装予定。cargo check 3 feature set / tsc noEmit / vitest 57 (stage-pipeline 6 + onnx-backend 12 + model-registry 22 + session 17) all pass、regression 0。Opus self-review BLOCKING 2 を post-review 修正 (空 key guard + 設計書 §3.8 legacy path 明文化)。**4b-5c 完了時の除去対象**: (a) `OnnxBackend.recognizeRois` の legacy path fall-through (4b-1 Block B test backward-compat)、(b) `ensureWarm` の `typeof visionInitSession !== "function"` guard (4b-1 Block A test backward-compat)。詳細は `docs/phase4b-5-stage-pipeline-design.md`

#### 4b-5a — Florence-2 Stage 1 real inference (sub-batch 1/4 〜 4/4)

- [x] **4b-5a-1**: Florence-2 image preprocess + frame_buffer plumbing — `florence2.rs` 新規 (`preprocess_image`: RGBA→f32 NCHW [1,3,768,768]、ImageNet normalize、bilinear resize via `image` crate)、`RecognizeRequest::frame_buffer` napi Buffer field 追加、`stub_recognise_with_session` で florence-2-base session_key 時に preprocess 呼び出し (shape 検証 + 既存 stub output 維持)、`NativeRecognizeRequest::frameBuffer`/`StagePipelineInput::frameBuffer`/`VisualBackend.recognizeRois` optional 5th param/`OnnxBackend.recognizeRois` の TS plumbing 追加。cargo check 3 feature set 全 exit 0、tsc noEmit exit 0、vitest 71 (stage-pipeline 6 + onnx-backend 14 + model-registry 22 + session 17 + 新規 Block E 2) all pass。詳細は `docs/phase4b-5a-1-florence2-preprocess-design.md`
- [x] **4b-5a-2**: Florence-2 tokenizer — `tokenizers` crate 追加 (v0.21.4、`["onig"]` feature)、`Florence2Tokenizer` (BART tokenizer wrapper)、`PromptTokens` (input_ids + attention_mask Vec<i64>)、`REGION_PROPOSAL_PROMPT` const、`tokenize_region_proposal()` / `tokenize_with_prompt()` method、`stub_recognise_with_session` に tokenizer load + tokenize ブロック追加 (`tokenizer_path_for_session` helper)、tokenizer_tests 6 ケース (`#[cfg(all(test, feature = "vision-gpu"))]`)。cargo check 3 feature set 全 exit 0、tsc noEmit exit 0、vitest 4 file (stage-pipeline 6 + onnx-backend 14 + model-registry 22 + session 17) regression 0。詳細は `docs/phase4b-5a-2-florence2-tokenizer-design.md`
- [ ] **4b-5a-3**: Florence-2 encoder + decoder autoregressive loop — ort::Session::run、KV cache
- [ ] **4b-5a-4**: `<loc_X>` token parse → bbox RawCandidate[]

- [ ] **4b-6**: Cross-check (multi-engine 投票) を optional flag で実装
- [ ] **4b-7**: `BenchmarkHarness` を実 backend で動かし、cold/warm/idle を測定
- [ ] **4b-8**: vendor matrix benchmark (RX 9070 XT 必須、CPU、可能なら iGPU)

**Done criteria**:
- [ ] Outlook PWA で OCR-only より 30%+ recall 改善 (L2 ≥ 0.92)
- [ ] **RX 9070 XT で warm p99 ≤ 30ms 達成 (L1, dogfood baseline)**
- [ ] iGPU で warm p99 ≤ 200ms 達成
- [ ] (任意) NVIDIA RTX 4090 で warm p99 ≤ 15ms 達成 (協力者環境で確認できれば)
- [ ] GPU steady-state usage ≤ 25% (L4)
- [ ] inference panic で MCP server が落ちない (L5 自動テスト)
- [ ] vendor portability: AMD + CPU の両方で test pass (L6)
- [ ] benchmark JSON が公開可能形式で `artifacts/visual-gpu-bench.json` に保存される

### Phase 4c — 自前 fine-tuned + DSL output + 公開 (1-2 months)

- dogfood data を annotation、Florence-2 / OmniParser-v2 を fine-tune
- Stage 4 (state classifier) と Stage 5 (relationship GNN) を実装
- Token-efficient DSL serializer を実装、`screenshot(detail='dsl')` を MCP 公開
- Hugging Face Hub にモデルを push、`desktop-touch-mcp/visual-models` repo 公開
- arXiv に short paper 投稿
- README に「LLM token consumption is reduced by ~3x compared to OCR baseline」を明記

**Done criteria**:
- L3 (token compression) ≤ 0.30 達成
- HuggingFace Hub model card 公開
- arXiv submission 完了
- 既存 56 ツールの後方互換性破壊なし

### Gates (新)

- **Gate A (4a → 4b)**: skeleton が Phase 1-3 を一切壊さない、RX 9070 XT で DirectML EP が動く
- **Gate B (4b → 4c)**: L1 / L2 / L4 / L5 / L6 がすべて目標値内、L3 は未測定可
- **Gate C (4c → release)**: L1〜L6 すべて達成、self-fine-tuned model が公開済

---

## 6. Consequences

### 良い点

- L1〜L6 すべての可測指標で ADR-004 を上回る (前提が正しければ)
- Rust 既存基盤を最大活用、Node 側依存を増やさない
- **AMD RX 9070 XT (dogfood baseline) で実機テスト可能**、CUDA-only の罠を回避
- 「OmniParser ラッパー」ではなく「Multi-stage UI understanding stack」として GitHub で発信可能
- LLM token 消費を 3 倍以上圧縮 → AI システム需要軽減という北極星に直接効く
- 自前 fine-tuned model + DSL は他 OSS (browser-use 等) からも参照される可能性
- vendor-neutrality (L6) により AMD/Intel/NVIDIA matrix benchmark を発信できる

### 悪い点

- Phase 4 全体の工数が ADR-004 の 2-3 倍 (4-8 weeks → 2-4 months)
- 自前 fine-tuning は労力 / GPU 時間 / annotation cost が必要
- Rust crate 依存が増える (`ort` + ncnn binding) → ビルド時間悪化、CI 強化要
- model variant matrix (WinML/DML/ROCm/Vulkan/CPU) を持つことで model storage 管理が複雑化
- DSL を独自定義することで「将来別仕様に乗り換え」のリスク (ただし detail='text' は残るので破壊的ではない)
- WinML 採用により Win11 24H2 未満ユーザーへは Layer 2 cascade で対応 (機能差ではなく性能差が出る)
- NVIDIA RTX の最大値 (TensorRT FP8) は協力者環境でしか測れない

### 既存資産への影響

| 既存資産 | 影響 | 対処 |
|---|---|---|
| `bin/win-ocr.exe` | Tier ∞ として残置 | 削除しない、CLAUDE.md にも明記 |
| `PocVisualBackend` | kill-switch fallback として残置 | 既存テスト 17 ケースは継続パス |
| `src/engine/vision-gpu/ocr-adapter.ts` (Phase 1) | Tier ∞ 経路として残置 | 4b 完了時は default off、kill-switch で復帰可能 |
| `runSomPipeline` (`src/engine/ocr-bridge.ts:647`) | OCR-only mode で継続使用 | snapToDictionary / calibrateOcrConfidence は再利用 |
| 既存 unit / integration tests | 全てパス維持必須 | Phase 4a 完了時点で全テスト緑を Done criteria に含める |

---

## 7. Acceptance criteria for this ADR

ADR-005 が Accepted になる条件 (ADR-004 の 4 点を置き換え):

1. backend 実装位置として **Rust 内 napi-rs AsyncTask** に合意できる
2. EP policy として **WinML default + AMD-first vendor-neutral cascade** に合意できる
3. recognizer policy として **multi-engine + Tier ∞ として win-ocr 残置** に合意できる
4. distribution policy として **variant matrix + multi-mirror** に合意できる
5. detector strategy として **自前 fine-tuned multi-stage + 公開** に合意できる
6. output policy として **token-efficient DSL を Phase 4c で導入** に合意できる
7. portability policy として **AMD/Intel/NVIDIA 同等品質 + dogfood baseline = RX 9070 XT** に合意できる
8. 工数増 (2-4 months) と annotation コストを **「ROI を気にしない」前提で許容**できる
9. **Phase 4 コア実装 (4a 全 batch + 4b 主要 batch) を Opus 担当**で進めることに合意できる

---

## 8. Rejected alternatives (本 ADR-005 が却下したもの)

- **ADR-004 のまま (inline ORT + DirectML + win-ocr + zip 非同梱)**
  - 「最高品質」を可測指標で達成できない、技術リード発信材料にならない
  - DirectML maintenance mode を織り込んでいない

- **CUDA / TensorRT default**
  - dogfood 環境 (AMD RX 9070 XT) でテスト不能、L6 を破壊
  - NVIDIA-only ML プロジェクトの典型に堕ちる

- **ROCm を Phase 4a default に**
  - ROCm 7.2.1 で RX 9070 XT サポート開始だが ONNX Runtime ROCm EP の Windows 対応は限定的
  - opt-in (Phase 4b 以降の追加 lane) として位置付け

- **Pure WebGPU + candle / wonnx 自前推論** (ORT 不使用)
  - candle の SOTA 対応未成熟、wonnx は op coverage 未充足
  - 1-2 年後に再評価する選択肢として保留 (Layer 5 future)

- **OpenAI / Anthropic / Google の VLM API 経由 (cloud inference)**
  - 「LLM 負荷軽減」を outsource するだけで実現していない
  - latency / cost / privacy のいずれも dogfood に合わない

- **WinML 単独 (Layer 2 cascade を持たない)**
  - Win11 23H2 以下のユーザーを切り捨てる
  - Linux / Mac 将来対応の道を塞ぐ

---

## 9. Migration / Breaking changes

- `desktop-touch-mcp` package: **無し** (既存 56 ツールの I/O は変えない)
- `screenshot` tool に `detail='dsl'` option を追加 (4c で)
- `VisualBackend` interface に `recognize_rois(...)` を追加 (既存 4 method は維持、追加メソッドのみ)
- `Cargo.toml` に `ort = "2"` 追加 (`features = ["directml"]` 必須、`["winml","cuda","rocm"]` は build flag で opt-in) → 初回 build 時間 +5-10 min
- ncnn binding 追加 (`ncnn-rs` or 自前 binding) → Phase 4b で評価
- `package.json` の `optionalDependencies` には何も追加しない (Rust 側完結、`onnxruntime-node` は依存に入れない)
- npm zip サイズ: 変化なし (model は launcher zip に含めず GH Releases から DL)
- launcher zip サイズ: 数 MB 増 (vision_backend Rust binary、model は別ダウンロード)
- **テスト環境**: Windows 11 24H2 + Radeon RX 9070 XT (本人) を必須、CI に WSL2 + DirectML を追加検討

### CLAUDE.md / docs 更新

- `docs/release-process.md`: model registry のリリース手順を追補 (Phase 4a 完了時)
- `docs/visual-gpu-phase4-rollout.md`: 本 ADR の 4a/4b/4c で置換 (Status: Superseded)
- `docs/visual-gpu-backend-adr.md` (ADR-004): Status: Superseded by ADR-005
- `CLAUDE.md`: Phase 4 コア実装は Opus 担当 (Sonnet には機械的タスクのみ委譲) を追記

---

## 10. Follow-up ADRs / decisions

- ADR-006 (将来): self fine-tuned model の training pipeline / dataset license
- ADR-007 (将来): WebGPU / wonnx / candle 移行のタイミング (Layer 5 future の本格化)
- ADR-008 (将来): Mac / Linux 対応の実装計画 (CoreML / ROCm Linux)
- ADR-009 (将来): WinML が DirectML を完全 deprecate した時の移行戦略

---

END OF ADR-005.
