# ADR-006: WinML Rust binding path for Phase 4 Visual GPU

- Status: **Draft (Open question — 着手時期未定)**
- Date: 2026-04-24
- Authors: Claude (Opus, max effort) — project `desktop-touch-mcp-fukuwaraiv2`
- Related:
  - ADR-005: `docs/visual-gpu-backend-adr-v2.md` (D2' で WinML default を主張、4b-2 で実装予定だった)
  - ADR-005 §5 4b-2: Deferred (本 ADR に切り出し)
  - 旧設計書: `docs/phase4b-2-winml-design.md` (Status: Deferred、参考資料として保持)
- Blocks: ADR-005 D2' Layer 1 の真の実装、AMD Ryzen AI XDNA / Intel NPU / Qualcomm Hexagon 対応
- Blocked by: 適切な実装方針の決定 (3 オプション、本 ADR §3 参照)

---

## 1. Context

ADR-005 D2' で「WinML default + AMD-first cascade」を採用し、Phase 4b-2 で
`Microsoft.Windows.AI.MachineLearning.ExecutionProviderCatalog` 経由の EP cascade Layer 1 を
実装する予定だった。しかし 2026-04-24 の実装着手時に以下が判明:

### 1.1 `windows-app` crate の状況

- `crates.io/windows-app` の **0.4.0 〜 0.4.7 全版が yanked**
- `microsoft/windows-app-rs` GitHub repo が **archived** (read-only)
- Microsoft 公式アナウンス: 「WinAppSDK is too heavily tied to .NET and Visual Studio
  to be practically usable with other languages and toolchains」

### 1.2 設計書 §4.4 Path C (windows-bindgen 自前生成) の困難

- `Microsoft.WindowsAppSDK.ML.winmd` を NuGet から取得して `windows-bindgen` で
  Rust binding 生成は技術的に可能
- ただし **WinAppSDK 全体が framework-dependent deployment**
  - DynamicDependency::Bootstrap で WinAppSDK Runtime を activate する必要あり
  - app manifest (`MaxVersionTested`) で WinAppSDK depend 宣言
  - これらが .NET/VS 前提の chain で、Rust から手動再現するには数ヶ月規模
- Microsoft が archive した領域を独自に保守し続けるリスクあり

### 1.3 Phase 4b 全体への影響

- Phase 4b-3 以降 (Vulkan/ncnn / Florence-2 / Stage 直列接続 / ROCm / BenchmarkHarness)
  の進行を 4b-2 で止めるのは品質的に得策ではない
- L6 vendor portability の達成は Vulkan/ncnn (4b-3) でも大きく前進する
- WinML 統合の真の価値 (NPU 対応) は単独で深く取り組む価値あり

---

## 2. Decision: 4b-2 の WinML 統合を本 ADR に切り出し、Phase 4b-3 を先行

### 即時決定 (2026-04-24)

1. ADR-005 §5 4b-2 を `[-] Deferred to ADR-006` に変更
2. Sonnet が途中作成した `src/vision_backend/winml.rs` / `winml_fallback.rs` を **削除**
3. `Cargo.toml` から `windows-app` 依存を削除、`vision-gpu-winml` feature を Phase 4b-1 時点の stub (no-op) に戻す
4. `ep_select::winml_attempt` は Phase 4b-1 時点の stub (常に Err) を維持、cascade は DirectML に fall through
5. Phase 4b は **4b-3 (Vulkan/ncnn lane) を次の着手対象**として進行継続
6. 本 ADR-006 を Draft 状態で起草、長期 roadmap として位置付け

### 後日決定 (本 ADR §3 で判断、Phase 4b-3〜4b-8 完了後に着手検討)

実装方針を以下 3 オプションから選ぶ。

---

## 3. Implementation options (後日決定)

### Option α: 完全自前 COM binding (hand-rolled)

`Microsoft.Windows.AI.MachineLearning.dll` を `LoadLibrary` で動的ロードし、
`RoGetActivationFactory` 経由で `ExecutionProviderCatalog` を activation。
vtable を手動定義して各 method を呼び出す。

**メリット**:
- 任意の WinML version に追従可能 (NuGet の更新を独自に取り込み)
- `windows` crate にも依存しない (実は `windows-core` の WinRT primitive は使うが軽量)
- 世界初の Rust 完全対応 (Microsoft が archive した領域の復活)
- ユーザー方針 (最高品質、世界リード) と最強整合

**デメリット**:
- 工数 3-6 ヶ月 (1 人開発)
- COM ABI / WinRT activation の罠が多い (interface 継承、agile object、apartment threading)
- WinAppSDK Runtime の Bootstrap も自前実装要 (DynamicDependency 全体)
- メンテナンスコストが永続

### Option β: windows-bindgen 部分活用 + COM 手動の hybrid

`Microsoft.WindowsAppSDK.ML.winmd` を `windows-bindgen` で binding 生成 (interface 部分のみ)、
WinAppSDK Bootstrap は完全自前 COM 呼び出しで行う。

**メリット**:
- Interface vtable は windows-bindgen 生成 (correctness 高い)
- Bootstrap だけ手動なので工数 1.5-3 ヶ月に圧縮
- 将来 Microsoft が再開した時の移行コスト低 (interface は同じ)

**デメリット**:
- winmd と Bootstrap path の整合性 (version skew) 注意要
- `windows-bindgen` の generated code が pure WinRT 想定で、framework-dependent path に対応するか未検証

### Option γ: WinML 諦めて他経路で NPU 対応

WinML 経由を諦め、各 NPU vendor の SDK を **個別** に呼ぶ:
- AMD Ryzen AI: Vitis AI Runtime + ONNX Runtime VitisAI EP (`ort::execution_providers::VitisAIExecutionProvider`)
- Intel NPU: OpenVINO + ONNX Runtime OpenVINO EP (既に ort feature `vision-gpu-openvino` あり)
- Qualcomm: QNN + ONNX Runtime QNN EP (将来的に)

**メリット**:
- ort crate の既存 EP support に乗れる、追加 binding ゼロ
- Vendor 別の最適化を直接利用可能
- WinAppSDK の framework dependency 不要

**デメリット**:
- 各 vendor の SDK を個別に install + 設定する必要 (UX 悪化)
- WinML の auto-discovery 機能 (`EnsureReadyAsync` の自動 download) が無い
- ベンダー追加時に都度実装が必要

---

## 4. Recommendation (条件付き)

短期 (Phase 4b 完走まで):
- **Option γ partial**: ROCm / OpenVINO EP を Phase 4b-6 (本来 ROCm 専用 batch) で OpenVINO も含めて実装拡張、AMD Ryzen AI / Intel NPU の道を開く
- WinML 自動 discovery は諦める、ユーザーが手動で適切な ONNX Runtime EP DLL を配置

中長期 (Phase 4 完了後の独立 project):
- **Option β**: windows-bindgen + 手動 Bootstrap の hybrid を 2-3 ヶ月かけて開発
- Open Source として公開 (`harusame64/winml-rs` crate 等)
- 他 OSS プロジェクトからも使える形にして community 貢献

長期 (Microsoft の再開 or 他社 binding 出現を待つ):
- Microsoft が再度 Rust 対応する可能性をモニタ (windows-rs Issue tracker)
- 別の OSS プロジェクトが WinAppSDK Rust binding を出したら採用検討

---

## 5. Acceptance criteria for this ADR

ADR-006 が Accepted になる条件 (本 ADR は当面 Draft):

1. Phase 4b-3 〜 4b-8 が完了 (4b-2 は skip された状態)
2. ADR-005 D2' Layer 1 (WinML 真実装) の必要性が再評価される
3. Option α / β / γ のどれを採用するか合意できる
4. 採用 option の工数とユーザー / community への配布方針が確定する

---

## 6. Open questions

- Microsoft が WinAppSDK の Rust 対応を将来再開する可能性は?
  → `windows-rs` Issue/Discussion を定期的にウォッチ
- Option β で `windows-bindgen` が WinAppSDK の framework-dependent path を綺麗にハンドリングできるか?
  → 試作 PoC で確認要
- Option γ で AMD Ryzen AI / Intel NPU を ort 既存 EP feature でカバーできる範囲は?
  → 4b-6 batch 設計時に詳細調査

---

## 7. Related artifacts (現時点で残るもの)

- `docs/phase4b-2-winml-design.md` (Status: Deferred、参考資料として保持)
- `ep_select::winml_attempt` stub (常に Err、cascade fall through 用、Phase 4b-1 時点で実装済)
- `capability::detect_winml()` の OS build version 判定 (>=26100、現状機能維持)
- `Cargo.toml` の `vision-gpu-winml = ["vision-gpu"]` no-op feature (将来 ADR-006 採用 option に応じて拡張)

---

END OF ADR-006 (Draft).
