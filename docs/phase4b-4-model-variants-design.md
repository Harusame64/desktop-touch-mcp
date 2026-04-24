# Phase 4b-4 設計書 — Model variant 登録 (`models.json`)

- Status: Implemented (2026-04-25、commits `6aaf99d`〜`aa2aab0`)
- 設計者: Claude (Opus 4.7)
- 実装担当: **Sonnet** (handbook §2 Step B、2026-04-25 workflow 再確定後の初 batch)
- レビュー担当: Opus 4.7 (別 subagent)
- 対応 ADR-005 セクション: D4' (model registry / download strategy) / D5' (detector 構成)
- 対応 ADR-005 §5 batch: 4b-4
- 前提 commits: `c4a9a7f`〜`e4f0e7b` (Phase 4a + 4b-1 + 4b-3 完了)
- 期待工数: **2-3 日 (Sonnet 実装、実質 TS-only batch)**

---

## 1. Goal

ADR-005 D5' で定めた Multi-stage 検出器を構成する model 群を、
`assets/models.json` という canonical manifest に variant matrix として登録する。
同時に Phase 4b-3 で cascade に組み込んだ **WebGPU EP** を model-registry の
EP taxonomy にも反映する (`EpName`: "Vulkan" → "WebGPU")。

単一目標:

> TS 側で `ModelRegistry.loadManifestFromFile("assets/models.json")` が成功し、
> dogfood profile (AMD RX 9070 XT、Win11 24H2、winml=true/directml=true) に対して
> 期待どおりの best variant が `selectVariant` で返る。

### 明示的に本 batch の scope 外

- 実際の artifact ダウンロード処理 (4b-5 以降)
- sha256 placeholder の実値埋め込み (artifact upload batch で実施)
- `VisionInitSessionTask` と ModelRegistry の接続 (4b-5)
- Stage 1/2/3 pipeline の直列化 (4b-5)
- benchmark harness (4b-7)

---

## 2. Files to touch

### 新規作成

| Path | 役割 | 推定行数 |
|---|---|---|
| `assets/models.json` | 4 model × 全 variant matrix (canonical source) | ~200 行 (JSON) |

### 変更

| Path:行 | 変更内容 |
|---|---|
| `src/engine/vision-gpu/model-registry.ts:67-68` | `EpName` type: `"Vulkan"` → `"WebGPU"` に rename |
| `src/engine/vision-gpu/model-registry.ts:200-204` | `collectAvailableEps` — `gpuVramMb > 0` の時 `eps.add("WebGPU")` (以前は `"Vulkan"`) |
| `src/engine/vision-gpu/model-registry.ts::selectVariant` (ソートブロック、既存 L132-137) | **bench_ms と size_mb の間に `isCpuOnlyVariant` ソートキーを挿入**。GPU EP を CPU-only variant より先に選ぶ (ADR-005 D2' cascade の「GPU preference、CPU は最終 fallback」思想と一致)。signature 変更ではなく internal sort logic 追記 (§9.1 は signature 禁止、internal logic は許容) |
| `tests/unit/visual-gpu-model-registry.test.ts:148-149` | ncnn format test: `ep: ["Vulkan"]` → `ep: ["WebGPU"]`、variant 名 `vulkan-ncnn` → `webgpu-fp16` (ncnn format は残す — format 判定は ep 名とは独立) |
| `tests/unit/visual-gpu-model-registry.test.ts` (追記) | bundled manifest loading block を describe として追加 (後述 §6) |
| `docs/visual-gpu-backend-adr-v2.md §5 4b-4 checklist` | `[x]` flip + summary 記入 |

### 削除禁止

- `src/engine/vision-gpu/model-registry.ts` の既存 method (`selectVariant`, `pathFor`, `verifyLocal`, `loadManifestFromFile`) — signature 変更禁止
- `ModelManifest` / `ModelVariant` interface の既存 required field 削除禁止
- Phase 4a / 4b-1 / 4b-3 の Rust 側 skeleton 全て (handbook §4.3)
- Phase 4b-3 の `SelectedEp::WebGPU { adapter }` / `webgpu_attempt` (4b-3 成果物維持)

### Forbidden な依存追加

- 新 npm package 追加禁止 (schema validation は既存 `validateManifest` で十分)
- 新 Rust crate 追加禁止 (本 batch は TS only、Rust 側を touch しない)
- `package.json` / `Cargo.toml` 全般変更禁止

---

## 3. API design

### 3.1 `EpName` 型修正

```typescript
// Before (model-registry.ts:67-68)
export type EpName =
  | "WinML" | "DirectML" | "ROCm" | "MIGraphX"
  | "CUDA" | "TensorRT" | "Vulkan" | "CoreML" | "OpenVINO" | "CPU";

// After (Phase 4b-4)
export type EpName =
  | "WinML" | "DirectML" | "ROCm" | "MIGraphX"
  | "CUDA" | "TensorRT" | "WebGPU" | "CoreML" | "OpenVINO" | "CPU";
```

**理由**: Phase 4b-3 で Layer 3 lane を ncnn/Vulkan-compute から **ort WebGPU EP** (wgpu 経由、
Vulkan / DX12 / Metal cross-backend) に切替決定済 (commit `b0600fb`)。model-registry の
EP taxonomy もそれに揃える。`SelectedEp::WebGPU` (Rust 側 `types.rs`) と label 一致。

### 3.2 `collectAvailableEps` の反映

```typescript
// Before (line 200-203)
// Vulkan EP availability is not currently reported by the profile (Phase 4b
// adds Vulkan compute device probe). Conservatively assume Vulkan exists on
// any non-zero-VRAM GPU until proper detection is added.
if (profile.gpuVramMb > 0) eps.add("Vulkan");

// After (Phase 4b-4)
// WebGPU EP (Phase 4b-3): ort webgpu lane runs wherever wgpu can acquire a
// physical adapter — practically any GPU with > 0 VRAM (DX12 / Vulkan / Metal
// auto-selected by wgpu). Capability-level detection is still coarse; ep_select
// (Rust) decides at session creation time whether registration actually succeeds.
if (profile.gpuVramMb > 0) eps.add("WebGPU");
```

### 3.2-bis `selectVariant` のソートキー追加 (Phase 4b-4 追補 2026-04-25)

既存 `selectVariant` (model-registry.ts L118-139) は bench_ms 欠落時 size_mb
昇順で tie-break する。これだと CPU-only variant の size_mb が GPU variant
より小さい (INT8 quantized で当然) 場合、GPU EP が available でも CPU が
選ばれてしまい、ADR-005 D2' cascade の意図 (GPU を最大活用、CPU は最終 fallback)
に反する。

**追加ソートキー** (bench_ms と size_mb の間に挿入):

```typescript
// 既存ソート (L132-137)
compatible.sort((a, b) => {
  const benchA = a.bench_ms?.[deviceKey] ?? Number.POSITIVE_INFINITY;
  const benchB = b.bench_ms?.[deviceKey] ?? Number.POSITIVE_INFINITY;
  if (benchA !== benchB) return benchA - benchB;
  // ← ここに isCpuOnly 判定を挿入
  const aIsCpu = isCpuOnlyVariant(a) ? 1 : 0;
  const bIsCpu = isCpuOnlyVariant(b) ? 1 : 0;
  if (aIsCpu !== bIsCpu) return aIsCpu - bIsCpu;  // GPU (0) が CPU (1) より先
  return a.size_mb - b.size_mb;
});

/**
 * CPU-only variant 判定。`ep` が `["CPU"]` のみなら true。
 * CPU が GPU EP と並列 listed (e.g. `["DirectML", "CPU"]`) の variant は
 * GPU EP 利用を意図したものとみなし GPU tier 扱いにする (稀ケース、現状 manifest では未使用)。
 */
function isCpuOnlyVariant(v: ModelVariant): boolean {
  return v.ep.length === 1 && v.ep[0] === "CPU";
}
```

**理由**:
- bench_ms が空 (本 batch のデフォルト、4b-7 で埋める予定) な状態でも
  GPU EP preference が保たれる
- ADR-005 D2' cascade `Layer 1 → Layer 2 → Layer 3 → Layer 4 (CPU)` の思想と一致
- `selectVariant` の public signature は変わらない (§9.1 禁則に抵触しない)
- bench_ms が後に埋まった時は従来どおり速度優先が最上位 (tier は tier-break、bench_ms が一致した時のみ効く)

### 3.3 `assets/models.json` の構造 (4 model × 全 variant)

`models` key の下に 4 entry:

| Model name (canonical) | task | 用途 (ADR D5') |
|---|---|---|
| `florence-2-base` | `ui_detector` | Stage 1 (region proposer) + 補助 OCR |
| `omniparser-v2-icon-detect` | `ui_detector` | Stage 2 (fine element detector) |
| `paddleocr-v4-server` | `text_recognizer` | Stage 3 メイン OCR (80+ 言語) |
| `paddleocr-v4-mobile` | `text_recognizer` | INT8 軽量、低密度ルート |

各 model の variant 列 (ADR §3 D4' matrix と engine compat §304-311 を元に):

| Variant name | ep | format | 対象環境 | 備考 |
|---|---|---|---|---|
| `winml-fp16` | `["WinML"]` | onnx | Win11 24H2+ | `min_os: "win11_24h2"` |
| `dml-fp16` | `["DirectML"]` | onnx | Windows 全般 | dogfood 主軸 |
| `rocm-fp16` | `["ROCm", "MIGraphX"]` | onnx | ROCm 7.2.1+ | `min_rocm: "7.2.1"` |
| `cuda-fp16` | `["CUDA"]` | onnx | NVIDIA driver | 参考値 |
| `trt-fp8` | `["TensorRT"]` | onnx | Ada 以上 | `min_arch: "ada"` |
| `webgpu-fp16` | `["WebGPU"]` | onnx | GPU-any | Layer 3 lane |
| `cpu-int8` | `["CPU"]` | onnx | 最終 fallback | INT8 quantized |

Model-specific の variant 有無 (ADR §304-311 表を参照):
- `florence-2-base`: winml/dml/webgpu/cuda/cpu-int8 (ROCm/MIGraphX は "△" で本 batch では除外、将来 4b-7 で追加検討)
- `omniparser-v2-icon-detect`: 全 variant (7 種) フルセット
- `paddleocr-v4-server`: 全 variant (7 種) フルセット、ncnn 移植豊富だが ort 経由は onnx format のみ
- `paddleocr-v4-mobile`: dml/webgpu/cpu-int8 の 3 variant (軽量モデルは量子化 + mobile EP を想定、ADR `PaddleOCR-mobile INT8` 方針)

### 3.4 sha256 / url / size_mb の扱い

- **url**: HuggingFace Hub 公式 URL を primary mirror として記入 (ADR §360 Mirror 順: GH Releases → HF Hub → R2)。
  - Florence-2-base: `https://huggingface.co/microsoft/Florence-2-base/resolve/main/model.onnx` 系
  - OmniParser-v2: `https://huggingface.co/microsoft/OmniParser-v2.0/resolve/main/icon_detect/model.onnx` 系
  - PaddleOCR-v4: `https://huggingface.co/PaddlePaddle/PaddleOCR/resolve/main/...` or PaddleOCR GitHub asset URL

  正確な path は Sonnet が HuggingFace Hub 上で 2026-04 時点で実在する URL に置換 (§8 許容範囲)。
  存在しない / 認証必要なら **URL は `"TBD:{model}/{variant}"` placeholder** で可 — ADR-005
  ダウンロード戦略は Mirror fallback を前提としており、URL 不在は 4b-5 以降で補完。
- **sha256**: **"pending:{model}/{variant}" sentinel を使う**。schema validator は非空 string であれば通る
  (line 185 `!v.sha256` check)。`verifyLocal` が呼ばれた時は hex decode 失敗で自然に null を返し、
  次 mirror fallback → Tier ∞ に流れる (ADR §358-364 のシナリオ通り)。
  実 sha256 は artifact を GH Releases に upload する将来 batch (4b-5 以降) で埋める。
- **size_mb**: upstream model card の値をそのまま記入 (実機でロードしないので誤差 ±10MB は許容)。
  未知の場合は ADR §307-311 表の数字を使用。
- **bench_ms**: 本 batch では空 object `{}` or 省略。4b-7 で実機測定後に埋める。

### 3.5 `assets/` ディレクトリ方針

プロジェクト root 直下に `assets/` を新設、`.gitignore` 対象外 (リポジトリ追跡)。
将来的に `.github/workflows/release.yml` で `assets/models.json` を GH Release asset
として upload する流れ。本 batch では **リポジトリ内の静的ファイル** としてだけ扱う。

読み込みは `ModelRegistry.loadManifestFromFile(path.join(__dirname, "../../../assets/models.json"))`
相当で、**自動ロードは行わない** (既存の API をそのまま使い、caller が必要なタイミングで load)。

---

## 4. `models.json` content (具体)

Sonnet 実装時は下記を雛形として `assets/models.json` を作成。`url` の具体値は
2026-04 時点の HF Hub 上で確認・置換可 (§8 許容範囲)。

```json
{
  "schema": "1.0",
  "generated_at": "2026-04-25",
  "models": {
    "florence-2-base": {
      "task": "ui_detector",
      "variants": [
        {
          "name": "winml-fp16",
          "ep": ["WinML"],
          "min_os": "win11_24h2",
          "url": "https://huggingface.co/microsoft/Florence-2-base/resolve/main/model.onnx",
          "sha256": "pending:florence-2-base/winml-fp16",
          "size_mb": 540
        },
        {
          "name": "dml-fp16",
          "ep": ["DirectML"],
          "url": "https://huggingface.co/microsoft/Florence-2-base/resolve/main/model.onnx",
          "sha256": "pending:florence-2-base/dml-fp16",
          "size_mb": 540
        },
        {
          "name": "webgpu-fp16",
          "ep": ["WebGPU"],
          "url": "TBD:florence-2-base/webgpu-fp16",
          "sha256": "pending:florence-2-base/webgpu-fp16",
          "size_mb": 540
        },
        {
          "name": "cuda-fp16",
          "ep": ["CUDA"],
          "url": "TBD:florence-2-base/cuda-fp16",
          "sha256": "pending:florence-2-base/cuda-fp16",
          "size_mb": 540
        },
        {
          "name": "cpu-int8",
          "ep": ["CPU"],
          "url": "TBD:florence-2-base/cpu-int8",
          "sha256": "pending:florence-2-base/cpu-int8",
          "size_mb": 180
        }
      ]
    },
    "omniparser-v2-icon-detect": {
      "task": "ui_detector",
      "variants": [
        { "name": "winml-fp16",  "ep": ["WinML"],    "min_os": "win11_24h2", "url": "https://huggingface.co/microsoft/OmniParser-v2.0/resolve/main/icon_detect/model.onnx", "sha256": "pending:omniparser-v2-icon-detect/winml-fp16", "size_mb": 32 },
        { "name": "dml-fp16",    "ep": ["DirectML"], "url": "https://huggingface.co/microsoft/OmniParser-v2.0/resolve/main/icon_detect/model.onnx", "sha256": "pending:omniparser-v2-icon-detect/dml-fp16", "size_mb": 32 },
        { "name": "rocm-fp16",   "ep": ["ROCm", "MIGraphX"], "min_rocm": "7.2.1", "url": "TBD:omniparser-v2-icon-detect/rocm-fp16", "sha256": "pending:omniparser-v2-icon-detect/rocm-fp16", "size_mb": 32 },
        { "name": "webgpu-fp16", "ep": ["WebGPU"],   "url": "TBD:omniparser-v2-icon-detect/webgpu-fp16", "sha256": "pending:omniparser-v2-icon-detect/webgpu-fp16", "size_mb": 30 },
        { "name": "cuda-fp16",   "ep": ["CUDA"],     "url": "TBD:omniparser-v2-icon-detect/cuda-fp16", "sha256": "pending:omniparser-v2-icon-detect/cuda-fp16", "size_mb": 32 },
        { "name": "trt-fp8",     "ep": ["TensorRT"], "min_arch": "ada", "url": "TBD:omniparser-v2-icon-detect/trt-fp8", "sha256": "pending:omniparser-v2-icon-detect/trt-fp8", "size_mb": 18 },
        { "name": "cpu-int8",    "ep": ["CPU"],      "url": "TBD:omniparser-v2-icon-detect/cpu-int8", "sha256": "pending:omniparser-v2-icon-detect/cpu-int8", "size_mb": 12 }
      ]
    },
    "paddleocr-v4-server": {
      "task": "text_recognizer",
      "variants": [
        { "name": "winml-fp16",  "ep": ["WinML"],    "min_os": "win11_24h2", "url": "TBD:paddleocr-v4-server/winml-fp16", "sha256": "pending:paddleocr-v4-server/winml-fp16", "size_mb": 95 },
        { "name": "dml-fp16",    "ep": ["DirectML"], "url": "TBD:paddleocr-v4-server/dml-fp16", "sha256": "pending:paddleocr-v4-server/dml-fp16", "size_mb": 95 },
        { "name": "rocm-fp16",   "ep": ["ROCm", "MIGraphX"], "min_rocm": "7.2.1", "url": "TBD:paddleocr-v4-server/rocm-fp16", "sha256": "pending:paddleocr-v4-server/rocm-fp16", "size_mb": 95 },
        { "name": "webgpu-fp16", "ep": ["WebGPU"],   "url": "TBD:paddleocr-v4-server/webgpu-fp16", "sha256": "pending:paddleocr-v4-server/webgpu-fp16", "size_mb": 95 },
        { "name": "cuda-fp16",   "ep": ["CUDA"],     "url": "TBD:paddleocr-v4-server/cuda-fp16", "sha256": "pending:paddleocr-v4-server/cuda-fp16", "size_mb": 95 },
        { "name": "trt-fp8",     "ep": ["TensorRT"], "min_arch": "ada", "url": "TBD:paddleocr-v4-server/trt-fp8", "sha256": "pending:paddleocr-v4-server/trt-fp8", "size_mb": 48 },
        { "name": "cpu-int8",    "ep": ["CPU"],      "url": "TBD:paddleocr-v4-server/cpu-int8", "sha256": "pending:paddleocr-v4-server/cpu-int8", "size_mb": 28 }
      ]
    },
    "paddleocr-v4-mobile": {
      "task": "text_recognizer",
      "variants": [
        { "name": "dml-fp16",    "ep": ["DirectML"], "url": "TBD:paddleocr-v4-mobile/dml-fp16", "sha256": "pending:paddleocr-v4-mobile/dml-fp16", "size_mb": 11 },
        { "name": "webgpu-fp16", "ep": ["WebGPU"],   "url": "TBD:paddleocr-v4-mobile/webgpu-fp16", "sha256": "pending:paddleocr-v4-mobile/webgpu-fp16", "size_mb": 11 },
        { "name": "cpu-int8",    "ep": ["CPU"],      "url": "TBD:paddleocr-v4-mobile/cpu-int8", "sha256": "pending:paddleocr-v4-mobile/cpu-int8", "size_mb": 5 }
      ]
    }
  }
}
```

---

## 5. Done criteria (binary check)

- [ ] `assets/models.json` 作成、`node -e 'JSON.parse(require("fs").readFileSync("assets/models.json", "utf8"))'` で parse 成功
- [ ] `tsc --noEmit` exit 0
- [ ] `npx vitest run --project=unit "tests/unit/visual-gpu-model-registry.test.ts"` 全パス (既存 + 新規)
- [ ] 必要なら `npm run test:capture -- --force` 1 回で全 1962 件超 green、**regression 0** (失敗件数が 4b-3 完了時の 2 件 pre-existing を超えないこと)
- [ ] ADR-005 §5 4b-4 checklist 2 行 (line 619) を `[x]` に flip + summary 記入
- [ ] 本設計書の Status を `Implemented (2026-04-??、commit hash)` に更新
- [ ] Opus self-review BLOCKING 0

**E2E 失敗時の取り扱い** (feedback_pinpoint_e2e_rerun.md 準拠):
- `npm run test:capture -- --force` で 2 件の pre-existing e2e failure が出ても regression ではない
- ピンポイント再確認は `.vitest-out.txt` 末尾の個別実行コマンドを使う
- full suite 再実行は最終 1 回のみ

---

## 6. Test cases

### 6.1 既存テストの更新 (rewrite ではなく rename、handbook §4.1 範囲内)

`tests/unit/visual-gpu-model-registry.test.ts:148` の ncnn format test:

```typescript
// Before
const v = { name: "vulkan-ncnn", ep: ["Vulkan"] as const, ...format: "ncnn"... };

// After (Phase 4b-4)
// ncnn format は現状 runtime で未使用 (Phase 4b-3 で ort WebGPU に統一済)。
// path_for の format 判定ロジック存続確認用に "webgpu-ncnn" は残す
// (ADR-007 候補としての ncnn lane の future-proof)。
const v = { name: "webgpu-ncnn", ep: ["WebGPU"] as const, ...format: "ncnn"... };
```

### 6.2 新規 describe block (追記、既存書換ではなく追加)

```typescript
// tests/unit/visual-gpu-model-registry.test.ts 末尾に追加
describe("ModelRegistry loads bundled assets/models.json", () => {
  const manifestPath = path.join(process.cwd(), "assets", "models.json");

  it("loadManifestFromFile parses bundled manifest without error", () => {
    const r = new ModelRegistry({ cacheRoot: process.cwd() + "/_test-cache-tmp" });
    expect(() => r.loadManifestFromFile(manifestPath)).not.toThrow();
    const m = r.getManifest();
    expect(m?.schema).toBe("1.0");
    expect(Object.keys(m?.models ?? {}).length).toBeGreaterThanOrEqual(4);
  });

  it("contains florence-2-base, omniparser-v2-icon-detect, paddleocr-v4-server, paddleocr-v4-mobile", () => {
    const r = new ModelRegistry({ cacheRoot: process.cwd() + "/_test-cache-tmp" });
    r.loadManifestFromFile(manifestPath);
    const models = r.getManifest()!.models;
    expect(models["florence-2-base"]).toBeDefined();
    expect(models["omniparser-v2-icon-detect"]).toBeDefined();
    expect(models["paddleocr-v4-server"]).toBeDefined();
    expect(models["paddleocr-v4-mobile"]).toBeDefined();
  });

  it("selectVariant on RX 9070 XT profile picks WinML or DirectML first for omniparser-v2-icon-detect", () => {
    const r = new ModelRegistry({ cacheRoot: process.cwd() + "/_test-cache-tmp" });
    r.loadManifestFromFile(manifestPath);
    // bench_ms が空なので size_mb tie-breaker で最小 = winml-fp16 か dml-fp16 のどちらか
    // (同 size なら入力順序で winml が先)
    const profile: NativeCapabilityProfile = {
      os: "windows", osBuild: 26100,
      gpuVendor: "AMD", gpuDevice: "Radeon RX 9070 XT", gpuArch: "RDNA4", gpuVramMb: 16384,
      winml: true, directml: true, rocm: false, cuda: false, tensorrt: false,
      cpuIsa: ["avx2", "avx"], backendBuilt: true, epsBuilt: ["directml"],
    };
    const v = r.selectVariant("omniparser-v2-icon-detect", profile);
    expect(v).not.toBeNull();
    expect(["winml-fp16", "dml-fp16"]).toContain(v!.name);
  });

  it("selectVariant falls back to cpu-int8 for CPU-only profile", () => {
    const r = new ModelRegistry({ cacheRoot: process.cwd() + "/_test-cache-tmp" });
    r.loadManifestFromFile(manifestPath);
    const profile: NativeCapabilityProfile = {
      os: "windows", osBuild: 26100,
      gpuVendor: "Unknown", gpuDevice: "", gpuArch: "Unknown", gpuVramMb: 0,
      winml: false, directml: false, rocm: false, cuda: false, tensorrt: false,
      cpuIsa: ["avx2"], backendBuilt: true, epsBuilt: [],
    };
    const v = r.selectVariant("omniparser-v2-icon-detect", profile);
    expect(v?.name).toBe("cpu-int8");
  });

  it("paddleocr-v4-mobile has fewer variants than paddleocr-v4-server", () => {
    const r = new ModelRegistry({ cacheRoot: process.cwd() + "/_test-cache-tmp" });
    r.loadManifestFromFile(manifestPath);
    const mobile = r.getManifest()!.models["paddleocr-v4-mobile"]!;
    const server = r.getManifest()!.models["paddleocr-v4-server"]!;
    expect(mobile.variants.length).toBeLessThan(server.variants.length);
  });
});
```

### 6.3 EpName rename 回帰確認テスト

```typescript
describe("WebGPU EP is recognized (Phase 4b-4 rename from Vulkan)", () => {
  it("selectVariant picks webgpu-fp16 when only GPU VRAM is available", () => {
    const r = new ModelRegistry();
    r.setManifest({
      schema: "1.0",
      models: {
        "t": {
          task: "ui_detector",
          variants: [
            { name: "webgpu-fp16", ep: ["WebGPU"], url: "u", sha256: "0".repeat(64), size_mb: 30 },
            { name: "cpu-int8",    ep: ["CPU"],     url: "u", sha256: "0".repeat(64), size_mb: 12 },
          ],
        },
      },
    });
    const p: NativeCapabilityProfile = {
      os: "windows", osBuild: 26100,
      gpuVendor: "Intel", gpuDevice: "Arc A770", gpuArch: "Alchemist", gpuVramMb: 16384,
      winml: false, directml: false, rocm: false, cuda: false, tensorrt: false,
      cpuIsa: ["avx2"], backendBuilt: true, epsBuilt: [],
    };
    // DirectML=false なので WebGPU が唯一の GPU lane、選ばれるべき
    expect(r.selectVariant("t", p)?.name).toBe("webgpu-fp16");
  });
});
```

---

## 7. Known traps

| 罠 | 対策 |
|---|---|
| `"Vulkan"` を "WebGPU" に rename すると既存 test が fail | §6.1 の 1 行 rename で解消 (handbook §4.1 rewrite ではなく、API 変更に伴う accuracy 追従) |
| JSON parse で BOM / trailing comma が混入 | Sonnet は strict JSON を出力、保存前に `JSON.parse(readFileSync)` で自己検証 |
| HuggingFace URL が model repository rename で 404 | `url` は best effort、不確実な path は `"TBD:..."` placeholder |
| sha256 placeholder で `verifyLocal` が呼ばれて panic | 現状の実装 (line 156-164) は try/catch で包んでおり、hex decode 失敗も `return null` で安全終了、panic しない |
| models.json 内 `ep` array が readonly vs mutable で型エラー | 既存 variant interface は `ReadonlyArray<EpName>` を受ける。JSON 配列は通常の array だが TS JSON import では `readonly` に推論される — 問題ないが `as const` 付与不要 |
| `paddleocr-v4-mobile` の variant 数が少ない (3 種) で test `"fewer variants"` が恣意的 | 意図どおり (ADR `mobile INT8 軽量` 方針、§3.3 表の通り) — 将来増やす場合は test の期待値側を調整 |
| `assets/` ディレクトリが既存リリースビルドで含まれない | `package.json` の `files` 配列または `.npmignore` を確認し、含まれない場合は Sonnet 判断で追記 (§8 許容範囲) |
| RX 9070 XT profile の test で bench_ms 欠落 → winml と dml が tie で順序不定 | `expect(["winml-fp16", "dml-fp16"]).toContain(v!.name)` で両方許容 |
| bench_ms 空 + size_mb で CPU-only variant が最小 → GPU EP available でも CPU が選ばれる (Sonnet 初回実装で発見、2026-04-25) | §3.2-bis の `isCpuOnlyVariant` ソートキーで GPU tier を優先、`cpu-int8` は最終 fallback に |

---

## 8. Acceptable Sonnet judgment scope

Sonnet が設計書内で独自判断して良い範囲:

- HuggingFace Hub URL の正確な path (2026-04 時点で実在する URL に置換、存在しなければ `"TBD:..."` placeholder)
- `size_mb` の具体値 (ADR §307-311 表 or HF Hub model card の数字、未知なら ±20% の推定値)
- 各 variant の `name` 英字表記の微調整 (e.g. `webgpu-fp16` vs `webgpu-default`、設計書では `webgpu-fp16` 推奨だが合理性あれば変更可)
- `package.json` `files` 配列への `assets/` 追加判断 (npm publish 時に配布するかどうか)
- `assets/models.json` 内のコメント (JSON はコメント不可、別途 `README.md` or `CHANGELOG` で補足したい場合は `docs/` に書く)
- 境界条件テストの追加 (既存 test の書換ではない、追記のみ)
- テスト名の wording (英語推奨)

---

## 9. Forbidden Sonnet judgments

### 9.1 API surface 変更
- `ModelManifest` / `ModelEntry` / `ModelVariant` interface の field 追加/削除/型変更禁止
- `ModelRegistry` class の既存 public method **signature** 変更禁止
  - 補足: `selectVariant` の **internal sort logic 追記** (§3.2-bis の `isCpuOnlyVariant` 挿入) は signature 変更ではないため許容
  - 新規 private helper (`isCpuOnlyVariant` など top-level 関数) の追加は許容 (§3.2-bis で明示)
- `EpName` に **"Vulkan" を残す / "WebGPU" 以外の新 EP を加える** 禁止 (rename のみ)
- `schema: "1.0"` → `"1.1"` 等の schema version bump 禁止 (後方互換を必要とする変更は ADR 化)

### 9.2 Scope 変更
- 実 artifact download 実装禁止 (4b-5 以降)
- sha256 placeholder を実値に置換する試み禁止 (network 依存、本 batch は offline)
- Stage 1/2/3 pipeline の直列化禁止 (4b-5 担当)
- Rust 側 `vision_backend` への変更禁止 (TS only batch)
- `visionInitSession` / `VisionInitSessionTask` への変更禁止 (4b-1 成果物維持)

### 9.3 依存追加禁止
- 新 npm package 追加禁止 (json schema validator 等も禁止、既存 `validateManifest` で十分)
- 新 Rust crate 追加禁止
- `package.json` scripts / dependencies / devDependencies への新規 entry 禁止
  - 例外: `files` 配列に `"assets"` 文字列を追加するのは許可 (§8)

### 9.4 テスト書換禁止
- 既存 test body の logic 変更禁止 (handbook §4.1)
- §6.1 の `"Vulkan"` → `"WebGPU"` rename は「API 変更に伴う accurate 追従」、logic 変更ではない。許容範囲
- 新規テストは既存 file への追記 (新規 describe block 作成) のみ、新規 test file 作成禁止

### 9.5 build / CI / version 変更禁止
- `bin/launcher.js` / `.github/workflows/` / `src/version.ts` / `Cargo.toml` 変更禁止

### 9.6 ドキュメント更新義務
- ADR-005 §5 4b-4 checklist 2 行 `[x]` flip + summary 記入
- 本設計書の Status を `Implemented (2026-04-??、commit hash)` に更新

---

## 10. Future work / 次 batch への hand-off

### 10.1 Phase 4b-5 で実装すべき (本 batch の成果を使う)

- `VisionInitSessionTask` が `ModelRegistry.loadManifestFromFile` でこの manifest を読み、
  `selectVariant` で best variant を決定、`pathFor` で on-disk path を取得、
  `verifyLocal` で cache 確認、不在なら (Phase 4b-5 以降で実装する) downloader を呼ぶ
- Stage 1 (Florence-2-base) → Stage 2 (OmniParser-v2) → Stage 3 (PaddleOCR) の 3 段直列
- multi-session 管理 (1 model = 1 session、`session_key` で cache)

### 10.2 Phase 4b-7 で実装すべき

- `assets/models.json` の `bench_ms` を実機測定値で埋める (RX 9070 XT 必須)
- `sha256: "pending:..."` を実 hex 64 文字に置換

### 10.3 将来 ADR-007 候補

- ncnn 自前 binding が必要になった場合、`format: "ncnn"` の variant を再有効化
  (本 batch の `webgpu-ncnn` test 1 件で format 判定 logic の future-proof は確保済)
- wonnx / burn-wgpu lane は ADR-007 で独立検討

---

## 11. 実装順序 (Sonnet 手順)

1. `src/engine/vision-gpu/model-registry.ts:67-68` の `EpName` 型 rename (`"Vulkan"` → `"WebGPU"`)
2. `src/engine/vision-gpu/model-registry.ts:200-203` の `collectAvailableEps` 中の `"Vulkan"` → `"WebGPU"` + コメント更新
3. `src/engine/vision-gpu/model-registry.ts` の `selectVariant` ソートブロック (L132-137) に §3.2-bis の `isCpuOnlyVariant` tier を追加 + ファイル下部に `isCpuOnlyVariant` helper 関数を追記
4. `tests/unit/visual-gpu-model-registry.test.ts:148-149` の ncnn format test の 1 行 rename
5. `npx vitest run --project=unit "tests/unit/visual-gpu-model-registry.test.ts"` で既存 test 全緑確認 (step 1-3 適用後、既存 test が通ることを確認)
6. `assets/` ディレクトリ作成、`assets/models.json` 作成 (§4 雛形をベースに実 URL に置換)
7. `node -e 'JSON.parse(require("fs").readFileSync("assets/models.json", "utf8"))'` で parse 確認
8. `tests/unit/visual-gpu-model-registry.test.ts` 末尾に §6.2 / §6.3 の describe block 追加
9. `npx vitest run --project=unit "tests/unit/visual-gpu-model-registry.test.ts"` で全緑
10. `npx tsc --noEmit` exit 0
11. `npm run test:capture -- --force` で最終 full suite 確認 (1 回のみ、regression 0)
12. ADR-005 §5 4b-4 checklist `[x]` flip + summary
13. 本設計書 Status を `Implemented` に + commit hash 記入
14. commit (2-3 commit に分割 — `selectVariant` tier 追加 / EpName rename / models.json 登録 で論理単位を分ける推奨)
15. push
16. Opus self-review subagent 起動
17. BLOCKING ゼロまで反復
18. 最終 commit + push + notification_show

---

END OF DESIGN DOC.
