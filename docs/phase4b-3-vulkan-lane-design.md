# Phase 4b-3 設計書 — Vulkan lane via ORT WebGPU EP

- Status: Implemented (2026-04-25、commit `b0600fb`)
- 設計者: Claude (Opus, max effort)
- 実装担当: **Opus 直接実装** (handbook §2 Step B、外部 library binding は Opus 原則)
- 対応 ADR-005 セクション: D2' Layer 3 (Vulkan/ncnn lane、ただし ncnn-rs 不在のため **ort webgpu EP** に切替) / D7' (vendor portability)
- 対応 ADR-005 §5 batch: 4b-3
- 前提 commits: `c4a9a7f`〜`3710320` (Phase 4a + 4b-1 + 4b-2 defer 完了)
- 期待工数: **1 week (Opus 直実装)**

---

## 1. Goal

ORT cascade の **Layer 3** として **WebGPU EP** (ort crate `webgpu` feature 経由) を追加し、
DirectML / ROCm / CUDA が使えない環境でも Vulkan/DX12/Metal 経由で GPU 推論が動く状態にする。

単一目標:

> `VisionSession::create` の cascade order に WebGPU EP 試行を DirectML の次・CPU の前として
> 追加し、WebGPU feature 有効時に `selectedEp == "WebGPU"` を返す動作確認ができる。

### ADR-005 設計からの修正点

ADR-005 §3 D2' Layer 3 は当初「Vulkan + ncnn」と定義されていた。リサーチで判明した事実:
- 汎用 `ncnn-rs` crate は存在せず (waifu2x / realcugan 向け特殊 binding のみ)
- ONNX → ncnn 変換 + 自前 Rust binding 開発は工数大
- **ort の `webgpu` feature が既に Phase 4a 設計で準備済** (Cargo.toml `vision-gpu-webgpu = ["vision-gpu", "ort/webgpu"]`)
- ONNX Runtime 本体の WebGPU EP は wgpu (Vulkan/DX12/Metal cross-backend) で動作
- AMD / NVIDIA / Intel / Qualcomm 全 vendor 対応

**結論**: Layer 3 を「Vulkan + ncnn」から「ort WebGPU EP (wgpu 経由 Vulkan/DX12/Metal)」に変更。
ncnn 自前 binding / wonnx / burn-wgpu は将来 ADR-007 候補として §10 に記載。

---

## 2. Files to touch

### 新規作成

| Path | 役割 | 推定行数 |
|---|---|---|
| (なし) | 既存 `ep_select.rs` に webgpu_attempt を追加するのみ、新規ファイルなし | - |

### 変更

| Path:行 | 変更内容 |
|---|---|
| `src/vision_backend/types.rs::SelectedEp` | `WebGPU { adapter: String }` variant を追加 |
| `src/vision_backend/ep_select.rs:94-95` (CPU の前) | `webgpu_attempt()` を cascade に追加 (feature gate `vision-gpu-webgpu`) |
| `src/vision_backend/ep_select.rs` (末尾) | `webgpu_attempt()` private fn の実装 |
| `src/vision_backend/ep_select.rs::tests` | WebGPU feature ON 時の cascade 順序テスト 1 件追加、SelectedEp::WebGPU label テスト 1 件追加 |
| `src/vision_backend/capability.rs::detect_eps_built` | `"webgpu"` を eps_built に含める条件を追加 (既存 `vision-gpu-webgpu` feature gate は既にある) |
| `docs/visual-gpu-backend-adr-v2.md §3 D2' Layer 3` | "Vulkan + ncnn" → "ort WebGPU EP (Vulkan/DX12/Metal via wgpu)" に文言変更、ncnn/wonnx/burn-wgpu を将来 ADR-007 候補として注記 |
| `docs/visual-gpu-backend-adr-v2.md §5 4b-3 checklist` | `[x]` flip + summary 更新 |

### 削除禁止

- Phase 4a / 4b-1 の skeleton 全て (handbook §4.3)
- `SelectedEp::WinML { registered_eps: Vec<String> }` 相当の「将来の EP 追加用 variant」(現状存在しない 4b-2 defer 済、ADR-006 で復活)
- 既存テスト (書換禁止)

### Forbidden な依存追加

- `ncnn-rs` / `wonnx` / `burn-wgpu` などの新 crate 追加は **禁止** (本 batch は ort 既存 feature のみで完結)
- それらは将来 ADR-007 候補として §10 に記載、独立検討

---

## 3. API design

### 3.1 `src/vision_backend/types.rs::SelectedEp` 拡張

```rust
pub enum SelectedEp {
    WinML,  // Phase 4b-1 stub、ADR-006 で拡張予定
    DirectML { device_id: u32 },
    Rocm { device_id: u32 },
    Cuda { device_id: u32 },
    WebGPU { adapter: String },  // ← 新規 (4b-3)
    Cpu,
    Fallback(String),
}

impl SelectedEp {
    pub fn as_label(&self) -> String {
        match self {
            // ... 既存 match arms ...
            Self::WebGPU { adapter } if adapter.is_empty() => "WebGPU".into(),
            Self::WebGPU { adapter } => format!("WebGPU({adapter})"),
            Self::Cpu => "CPU".into(),
            Self::Fallback(r) => format!("Fallback({r})"),
        }
    }
}
```

`adapter` フィールドは wgpu が選択した physical adapter 名 (例: `"AMD Radeon RX 9070 XT (Vulkan)"`) を
ort から取得できれば格納、取得できなければ空文字列。

### 3.2 `src/vision_backend/ep_select.rs` に webgpu_attempt 追加

```rust
// build_cascade の CPU 直前に追加 (Layer 3 として)
pub fn build_cascade(profile: &CapabilityProfile) -> Vec<EpAttempt> {
    let mut out: Vec<EpAttempt> = Vec::new();

    // Layer 1: WinML (Phase 4b-1 stub、ADR-006 でreal実装)
    if profile.winml && cfg!(feature = "vision-gpu-winml") {
        out.push(winml_attempt());
    }

    // Layer 2: vendor-specific direct EPs
    if profile.directml {
        out.push(directml_attempt(0));
    }
    #[cfg(feature = "vision-gpu-rocm")]
    if profile.rocm { out.push(rocm_attempt(0)); }
    #[cfg(feature = "vision-gpu-cuda")]
    if profile.cuda { out.push(cuda_attempt(0)); }

    // Layer 3: WebGPU (vendor-neutral Vulkan/DX12/Metal via wgpu)  ← 新規
    #[cfg(feature = "vision-gpu-webgpu")]
    if profile.gpu_vram_mb > 0 {
        out.push(webgpu_attempt());
    }

    // Layer 4: CPU (last)
    out.push(cpu_attempt());

    out
}

#[cfg(feature = "vision-gpu-webgpu")]
fn webgpu_attempt() -> EpAttempt {
    EpAttempt {
        kind: SelectedEp::WebGPU { adapter: String::new() },
        apply: std::sync::Arc::new(|builder| {
            use ort::execution_providers::WebGPUExecutionProvider;
            // Default adapter selection — let wgpu pick the best available device.
            // Phase 4b-7 benchmark may refine this (e.g. prefer discrete GPU).
            builder
                .with_execution_providers([WebGPUExecutionProvider::default().build()])
                .map_err(|e| ort::Error::new(e.to_string()))
        }),
    }
}
```

**Note**: `ort::execution_providers::WebGPUExecutionProvider` の正確な struct path は
ort 2.0.0-rc.12 の docs / source で要確認。API 名が異なる場合 (e.g. `WebGpuExecutionProvider`,
`JsExecutionProvider`) は Opus 実装時に adjust。

### 3.3 CapabilityProfile への影響

`capability::detect_eps_built` は既に `cfg!(feature = "vision-gpu-webgpu")` 分岐を持つ:

```rust
if cfg!(feature = "vision-gpu-webgpu") { eps.push("webgpu".into()); }
```

この行は既存 (Phase 4a から)、変更不要。

`CapabilityProfile` に「webgpu_supported」のような runtime 判定フィールドは追加しない
(build feature で十分)。wgpu の adapter 検出は ort session 作成時に内部で行われる。

---

## 4. EP cascade 順序の更新

| profile | features | 試行順序 (上から成功採用) |
|---|---|---|
| AMD RDNA4 (dogfood、default build) | default | DirectML(0) → **WebGPU** → CPU |
| AMD + `vision-gpu-webgpu` OFF | `--features vision-gpu` のみ | DirectML(0) → CPU (現状と同じ) |
| NVIDIA + WebGPU + CUDA | default + `vision-gpu-cuda,vision-gpu-webgpu` | DirectML(0) → CUDA(0) → **WebGPU** → CPU |
| Linux (将来) + ROCm + WebGPU | `vision-gpu,vision-gpu-rocm,vision-gpu-webgpu` | (DirectML Linux では skip) → ROCm(0) → WebGPU → CPU |
| CPU only | `vision-gpu,vision-gpu-webgpu` | (gpu_vram_mb==0 で WebGPU skip) → CPU |

---

## 5. Done criteria (binary check)

- [ ] `cargo check --release --features vision-gpu,vision-gpu-webgpu` exit 0
- [ ] `cargo check --release --features vision-gpu` exit 0 (webgpu OFF)
- [ ] `cargo check --release --features vision-gpu,vision-gpu-cuda,vision-gpu-rocm,vision-gpu-webgpu` exit 0
- [ ] `cargo check --release --no-default-features` exit 0
- [ ] `tsc --noEmit` exit 0
- [ ] `npm run test:capture -- --force` 全パス、新規 2 ケース pass、regression なし
- [ ] ADR-005 §3 D2' Layer 3 文言更新 + §5 4b-3 checklist `[x]` flip
- [ ] 設計書本文 §1 Status を「Implemented (commit ...)」に更新
- [ ] (実機 verify、ユーザーが実行) RX 9070 XT で:
  ```powershell
  $env:ORT_DYLIB_PATH = "$env:USERPROFILE\.desktop-touch-mcp\runtime\onnxruntime.dll"
  # vision-gpu-webgpu feature で build し直す必要あり
  # 実機 verify は build:rs の cargo features 指定方法次第
  ```
  → DirectML が OK なら WebGPU は試行されない (cascade 順序通り)。
     DirectML をテスト的に OFF して `selectedEp === "WebGPU"` が出るか確認。

---

## 6. Test cases

### 6.1 Rust unit tests (ep_select.rs `#[cfg(test)]`)

追加 2 ケース:

```rust
#[test]
fn cascade_includes_webgpu_before_cpu_when_feature_on() {
    #[cfg(feature = "vision-gpu-webgpu")]
    {
        let p = profile_amd_rdna4_no_extras();  // gpu_vram_mb > 0
        let attempts = build_cascade(&p);
        let labels: Vec<_> = attempts.iter().map(|a| a.kind.as_label()).collect();
        // Expected: ["DirectML(0)", "WebGPU", "CPU"]
        assert_eq!(labels, vec!["DirectML(0)", "WebGPU", "CPU"]);
    }
}

#[test]
fn webgpu_skipped_when_gpu_vram_zero() {
    #[cfg(feature = "vision-gpu-webgpu")]
    {
        let mut p = profile_amd_rdna4_no_extras();
        p.gpu_vram_mb = 0;  // CPU-only environment
        p.directml = false;
        let attempts = build_cascade(&p);
        // WebGPU must be skipped when no GPU is available
        assert!(!attempts.iter().any(|a| matches!(a.kind, SelectedEp::WebGPU { .. })));
    }
}
```

### 6.2 SelectedEp label テスト (types.rs or ep_select.rs tests)

```rust
#[test]
fn webgpu_selected_ep_label() {
    assert_eq!(SelectedEp::WebGPU { adapter: String::new() }.as_label(), "WebGPU");
    assert_eq!(
        SelectedEp::WebGPU { adapter: "AMD Radeon RX 9070 XT (Vulkan)".into() }.as_label(),
        "WebGPU(AMD Radeon RX 9070 XT (Vulkan))"
    );
}
```

### 6.3 TS 側 tests (visual-gpu-session.test.ts 既存に追加)

既存テストに追加 mock case 2 件:
- `visionInitSession` resolves with `{ ok: true, selectedEp: "WebGPU" }` → result 型検証
- `visionInitSession` resolves with `{ ok: true, selectedEp: "WebGPU(AMD Radeon RX 9070 XT (Vulkan))" }` → adapter 表示

既存テストファイルへの追加で、**新規テストファイル作成なし** (handbook §4.1: 既存書換禁止だが、並列で同じ file に追記は OK)。

---

## 7. Known traps

### Phase 4a / 4b-1 で観測した罠 (再発させない)

1. **ort prebuilt 不在 (msys2/gnu)** — load-dynamic で既に解決、影響なし
2. **windows crate API mismatch** — 本 batch は windows 操作なし、影響なし
3. **DXGI_ADAPTER_FLAG i32/u32 mismatch** — 影響なし

### 4b-3 で予想される罠

| 罠 | 対策 |
|---|---|
| `ort::execution_providers::WebGPUExecutionProvider` の正確な path 不明 | Opus 実装時に docs.rs/ort/2.0.0-rc.12 で確認。`WebGpu` / `JsExecutionProvider` 等の可能性あり。見つからない時は `--features webgpu` ビルドしてコンパイルエラーから逆引き |
| ort の WebGPU EP が AMD で未検証 | 実機 verify を実施、動かない場合は DirectML fallback で cascade が機能する (panic しない) |
| WebGPU EP の op coverage 不足で Session::commit_from_file が失敗 | commit 時に Err → cascade の次 (CPU) に fall through、L5 panic isolation は維持 |
| wgpu が実行時に GPU adapter 取得失敗 (headless 環境等) | EP 登録自体は通るが commit 時に失敗、CPU fallback |
| CI で WebGPU feature 有効にすると wgpu が GPU driver 要求 | CI 環境では `--features vision-gpu-webgpu` を避ける、もしくは headless wgpu (Microsoft basic render driver) で動かす |
| `gpu_vram_mb > 0` guard を適用すると Intel iGPU でも WebGPU 試行される | 意図通り (iGPU でも wgpu は動く)、adapter 選択は wgpu に委ねる |
| WebGPU feature 有効で build 時間増 | wgpu + ort webgpu 依存で +30-60s 想定、許容 |

### Opus 実装時の注意 (Opus 直実装の self-reminder)

1. ort の WebGPU EP struct 名確認を最優先 (compile error → 逆引き)
2. cascade 順序は「DirectML → ROCm → CUDA → WebGPU → CPU」の **Layer 2 fallback 後に Layer 3** が正しい
3. AMD dogfood マシンで DirectML が常に最初に成功するはずなので、WebGPU が実際に選ばれるのは「DirectML を明示的に disable した場合」のみ (実機 verify では env で強制必要)

---

## 8. Acceptable Opus/Sonnet judgment scope

Opus 直実装の場合は自分で判断可能、Sonnet 委譲時 (機械的部分のみ) は以下のみ自由:

- ort WebGPU EP の struct 名違い (docs.rs で逆引きして確定)
- `adapter` フィールドが ort から取得できない場合の `String::new()` 代替値
- log message wording
- test case 名 (英語推奨)
- 境界条件 test 追加

---

## 9. Forbidden judgments (Opus 直実装時も遵守)

### 9.1 API surface 変更
- `SelectedEp` の既存 variant 削除禁止、`WebGPU { adapter }` フィールド名変更禁止
- `build_cascade` 戻り値型変更禁止
- `vision_init_session` napi 関数の signature 変更禁止

### 9.2 Scope 変更
- ncnn-rs / wonnx / burn-wgpu への切替禁止 (別 ADR で議論)
- WebGPU attempt を cascade の別位置に動かす (Layer 2 前や Layer 4 後) 禁止
- 既存 DirectML / ROCm / CUDA attempt 削除禁止
- Phase 4a / 4b-1 skeleton への変更禁止

### 9.3 依存追加禁止
- 新 crate 追加禁止 (`wgpu`, `wonnx`, `burn`, `ncnn-rs` 等)
- ort の新 feature flag 追加禁止 (`ort/tensorrt` / `ort/coreml` は既存、本 batch では有効化しない)
- package.json dependencies 追加禁止

### 9.4 Build / CI 変更禁止
- `bin/launcher.js` / `.github/workflows/` / `src/version.ts` 変更禁止

### 9.5 ドキュメント更新義務
- ADR-005 §3 D2' Layer 3 文言更新 (ncnn → WebGPU)
- ADR-005 §5 の 4b-3 checklist `[x]` flip
- 本設計書の Status を「Implemented (commit hash)」に

---

## 10. Future work / ADR-007 候補

本 batch 完了後、以下を独立 ADR-007 として検討候補:

### 10.1 wonnx (WebGPU ONNX in Rust) 代替 lane
- 100% Rust、wgpu 上で動く ONNX runtime
- ort の WebGPU EP と重複する機能だが、「ORT 依存を減らす」独立 lane として価値
- SOTA model op coverage を事前に確認要
- 判断: 4b 全体完了後に wonnx の op coverage を調査、価値あれば ADR-007 起草

### 10.2 burn-wgpu (Burn framework) 統合
- Burn は Rust ネイティブの Deep Learning framework、ONNX import あり
- wgpu backend で AMD Vulkan 動作
- 課題: 既存 ort cascade と別 runtime、統合コストが大きい
- 判断: Burn の 2026 後半リリースで安定性を見てから検討

### 10.3 ncnn 汎用 Rust binding 開発
- 汎用 `ncnn-rs` は存在せず、自前開発で世界初
- 工数: 2-4 ヶ月独立 project
- 価値: OSS community 貢献、技術リード
- 判断: Phase 4c 以降、もしくはユーザーが ROI 無視方針で長期 project として承認した時

### 10.4 DirectX 12 Compute Shader 自前 kernel
- 最速の Windows 専用パス、wgpu より低レイヤ
- HLSL compute shader を自前書き
- 工数巨大、実用性は DirectML/WebGPU EP でカバー済
- 判断: Phase 4c 完了後の差別化要素、ADR-008 候補

---

## 11. 実装順序 (Opus 直実装の手順)

設計書 §2 Files to touch に従い、以下の順で実装:

1. `src/vision_backend/types.rs::SelectedEp` に `WebGPU { adapter: String }` variant 追加、`as_label` 実装
2. `src/vision_backend/ep_select.rs` に `webgpu_attempt()` 関数追加 + `build_cascade` に組み込み
3. `cargo check --release --features vision-gpu,vision-gpu-webgpu` で ort API 名確認 + コンパイル通過
4. ort API 名が間違っていたら docs.rs で正しい struct path に修正 (Known traps §7)
5. Rust unit tests 2-3 ケース追加 (§6.1, §6.2)
6. `cargo check` 4 種 全 exit 0
7. `tsc --noEmit` exit 0
8. TS 側の既存 `visual-gpu-session.test.ts` に mock case 2 件追加
9. `npm run test:capture -- --force` 全パス確認
10. ADR-005 §3 D2' 文言更新
11. ADR-005 §5 4b-3 checklist flip
12. 設計書 Status を Implemented (commit hash) に
13. commit 分割 (可能なら types 変更と ep_select 変更を別 commit)
14. push
15. Opus self-review subagent 起動
16. BLOCKING ゼロまで修正
17. 最終 push + notification

---

END OF DESIGN DOC.
