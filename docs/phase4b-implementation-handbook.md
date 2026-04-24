# Phase 4b 実装 Handbook — Sonnet 担当の妥協禁止指示書

- Status: Active (2026-04-24 発効)
- 担当: Sonnet 4.6 (実装) + Opus 4.7 (レビュー / 判断委譲先)
- 前提 ADR: [`visual-gpu-backend-adr-v2.md`](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/visual-gpu-backend-adr-v2.md) (ADR-005)
- 前提 commits (4 つ、既に origin に push 済):
  - `c4a9a7f` docs(vision-gpu): ADR-005 (AMD-first reconsideration)
  - `452abfc` feat(vision-gpu): Rust vision_backend skeleton
  - `f8ee3ca` feat(vision-gpu): TS OnnxBackend opt-in + ModelRegistry
  - `2599fc7` fix(vision-gpu): self-review feedback

---

## 1. この Handbook の位置づけ

Sonnet (実装担当) が Phase 4b を進める際に **絶対に守る** 指示書。
本人 (ユーザー) が明言した要件:

> ROI を気にしない。技術面のリードを GitHub で掲載することで、
> より LLM に負荷の少ないシステムを世界に展開する。
> 最高品質、最高難度での世界を作りたい。

この文書は「妥協した方がコストが下がる」という判断を **構造的に排除** するためにある。
Sonnet が以下のいずれかの誘惑に駆られた場合、**3 回目以降を試さず即 Opus に判断委譲** する。

---

## 2. 絶対条件 — 違反したら Opus 再レビューで reject される

### 2.1 テストコード改変の禁止

- `tests/unit/` / `tests/integration/` / `tests/e2e/` 配下の **既存テストの書き換えを禁止**。
- 失敗するテストがあった場合、テストではなく **実装コードを修正** する。
- テスト追加は OK (新しい batch ごとに必ず unit test を足す)。
- 既存テストの assertion を緩める修正は **即座に Opus に委譲**。

### 2.2 ADR-005 §2 の 6 指標 (L1〜L6) を緩めない

| 指標 | 目標値 | 緩めるのを禁止 |
|---|---|---|
| L1 warm latency p99 | RX 9070 XT ≤ 30ms / iGPU ≤ 200ms | 40ms や 300ms に変えない |
| L2 detector recall | ≥ 0.92 | 0.85 に下げない |
| L3 token compression | ≤ 0.30 | 0.50 等に緩めない (Phase 4c 事項だが基準は動かない) |
| L4 GPU steady-state | ≤ 25% | 40% 等に上げない |
| L5 inference crash → MCP 生存 | 100% (構造的) | 「たまに落ちてもログ残せば OK」は不可 |
| L6 vendor portability | AMD + CPU 必須 | NVIDIA-only / AMD-only 実装禁止 |

達成困難と判断したら Opus に「基準の再検討」を **判断委譲** する。勝手に下げない。

### 2.3 Phase 4a の構造 (skeleton) を壊さない

以下はすべて **維持** 必須:

- `VisualBackend` interface の既存 4 メソッド (`ensureWarm` / `getStableCandidates` / `onDirty` / `dispose`) の signature
- `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND=1` の opt-in flag (Phase 4b default on に切り替えるのは **Opus 承認後のみ**)
- `DESKTOP_TOUCH_DISABLE_VISUAL_GPU=1` kill-switch
- Rust `std::panic::catch_unwind` による L5 保護 (`src/vision_backend/inference.rs:recognize_rois_blocking`)
- TS 側の `recognizeRois` が native error を throw せず `[]` を返す契約
- `PocVisualBackend` (Phase 1-3 fallback) の **削除禁止** — `kill-switch` 時の fallback として残置
- `bin/win-ocr.exe` (Tier ∞) の **削除禁止** — どのモデルも load できない最悪時の safety net

### 2.4 モデル variant matrix を勝手に削らない

ADR-005 D4' の variant matrix:

```
winml-fp16 / dml-fp16 / rocm-fp16 / vulkan-ncnn / cuda-fp16 / trt-fp8 / cpu-int8
```

- 「NVIDIA は持ってないから cuda/trt は不要」と判断して **削るのは禁止**。
  NVIDIA 環境の協力者が後日測定する枠を維持する。
- 「Vulkan/ncnn は複雑だから後回し」も禁止。L6 (vendor portability) を構造的に担保する lane なので Phase 4b で必ず埋める。
- `rocm-fp16` は ONNX Runtime ROCm EP の Windows 対応が限定的な点を反映し、
  variant としては manifest に登録し、runtime で `profile.rocm === true` かつ
  `onnxruntime-rocm` が解決できたときのみ選択される設計にする。

### 2.5 AMD 実機 (Radeon RX 9070 XT / Win11 24H2) baseline を絶対軸にする

- ベンチ値は **RX 9070 XT で必ず取得**。他の環境のみで取ってはいけない。
- `bench_ms.rx9070xt` が埋まらない variant は manifest に登録しない (bench_ms 未測定はあり)。
- NVIDIA 実測は可能なら取得 (協力者環境) — 取れなくても Phase 4b は止まらない。

### 2.6 Trial & Error 2 回上限 (CLAUDE.md 強制命令 4 の厳格適用)

- 同一箇所で compile error / test failure が **2 回連続** したら 3 回目は試さず
  `subagent_type=general-purpose` + `model=opus` の subagent を起動して判断委譲する。
- 修正案を「まず試して通れば OK」のトライアンドエラーで回すのは禁止。
  Opus に relay する時のフォーマット:
  - エラーメッセージ full text
  - 該当ファイル + 該当行
  - これまで試した手数 (list)
  - 制約 (触ってはいけない周辺コード)

### 2.7 Phase 境界ごとの Opus 再レビュー義務 (CLAUDE.md 強制命令 3)

以下の batch 完了ごとに必ず Opus に self-review を依頼する:

- 4b-1 (EP cascade wiring 完了) → Opus レビュー → 指摘ゼロまで修正
- 4b-3 (Vulkan/ncnn lane 完了) → Opus レビュー
- 4b-5 (Stage 1-3 直列完了) → Opus レビュー
- 4b-7 (ベンチ取得完了) → Opus レビュー
- 4b 完了 → Opus 最終レビュー + ADR-005 の Gate B 判定

Opus レビューは `Agent` tool with `subagent_type=general-purpose` + `model=opus` で別 session 起動。
レビュー prompt は `docs/phase4b-sonnet-prompt.md` の「Opus レビュー依頼テンプレート」を使う。

### 2.8 完了報告前の最終チェック

ユーザーに「完了しました」と報告する前に:

1. `npm run test:capture -- --force` で全テストパス
2. `tsc --noEmit` exit 0
3. `cargo check --release --features vision-gpu` exit 0
4. 該当 batch の Done criteria が全部 `[x]`
5. 既存 Phase 1-3 のテスト regression なし (数値で確認)
6. Opus レビュー通過済
7. commits が分割されている (1 commit 500 行超えない)
8. `notification_show` で Windows 通知

1 つでも欠けたら「完了」と言わない。

### 2.9 既存依存の破壊禁止

- `package.json` の dependencies 削除禁止 (追加は OK)
- `bin/launcher.js` の変更は Opus 承認必須 (リリース経路に直結)
- `.github/workflows/release.yml` の変更は Opus 承認必須
- `src/version.ts` / `package.json:version` の変更は **リリース時のみ** (CLAUDE.md 強制命令 1)

### 2.10 ドキュメント更新の義務

Phase 4b-* 完了ごとに ADR-005 (`docs/visual-gpu-backend-adr-v2.md`) の checklist を
`[ ]` → `[x]` に flip する。flip せずに commit するのは禁止。

---

## 3. Phase 4b 実装 batch

ADR-005 §5 §Phase 4b のものを転記 + 詳細化:

### 4b-1: EP cascade の実 wiring (1-2 weeks)

- `src/vision_backend/inference.rs` に ORT session lifecycle を実装:
  - `ort::Session` を capability profile 基準で作成
  - EP 選択ロジック: WinML 試行 → DirectML → ROCm (`vision-gpu-rocm` feature 時) → CUDA → CPU
  - 初期化失敗時は次 EP に自動 fallback
- `ORT_DYLIB_PATH` env 経由で ONNX Runtime DLL の path を解決
  - path 未設定時は `%USERPROFILE%\.desktop-touch-mcp\runtime\onnxruntime.dll` を試す
  - launcher zip に runtime DLL を同梱する準備 (`.github/workflows/release.yml` 変更は Opus 承認必須)
- `src/vision_backend/inference.rs` の `VisionSessionPool` に `HashMap<ModelKey, Session>` を持たせる
- 実モデルは **まだロードしない** (dummy ONNX file で session 作成テストのみ、本物の Florence-2 等は 4b-4 以降)

**Done criteria**:
- [ ] ort::Session の作成/破棄が RX 9070 XT (DirectML EP) で通る
- [ ] 想定外の EP 失敗時に次段 fallback する (unit test で verify)
- [ ] 既存テスト regression なし
- [ ] Opus レビュー通過

### 4b-2: WinML 統合の feature 実装 (1 week)

- `Cargo.toml` の `vision-gpu-winml` feature の **実体を入れる**
- windows crate の `Windows::AI::MachineLearning` namespace または
  `onnxruntime-winml` package 経由で WinML EP を呼ぶ
- capability `profile.winml === true` の時に `selectVariant` が `winml-fp16` を選ぶ
- `epsBuilt` に "winml" が追加される

**Done criteria**:
- [ ] RX 9070 XT で WinML 経由で ONNX model を load + dummy inference 実行
- [ ] WinML 不可環境 (Win11 23H2 以下) で DirectML fallback

### 4b-3: Vulkan / ncnn lane (1-2 weeks)

- `ncnn-rs` crate または自前 FFI binding で ncnn Vulkan backend を呼ぶ
- ONNX → ncnn 変換 script を `scripts/` に置く (別 PR で OK)
- `src/vision_backend/inference.rs` に `VulkanNcnnBackend` を追加
- EP cascade の Layer 3 として統合 (DirectML で動かないモデルの fallback)

**Done criteria**:
- [ ] ncnn Vulkan で dummy model が推論できる
- [ ] L6 vendor portability 指標を満たす (AMD + NVIDIA 仮想環境で test 可)
- [ ] DirectML と Vulkan の結果差分が許容範囲 (IoU > 0.9 の同等性)

### 4b-4: 実モデル投入 — Florence-2 (2-3 weeks)

- Florence-2 base の ONNX weights を `models.json` に登録
- Hugging Face Hub または GitHub Releases から download + sha256 検証
- `src/vision_backend/inference.rs::recognize_rois_blocking` で Florence-2 を Stage 1 として呼ぶ
- dummy 実装を置き換え

**Done criteria**:
- [ ] Florence-2 が RX 9070 XT で動作 (DirectML / Vulkan 両方)
- [ ] 1024x1024 入力で warm p99 ≤ 30ms (RX 9070 XT)
- [ ] region proposer として出力が 8 region 以上返る
- [ ] 既存 Phase 1-3 regression なし

### 4b-5: Stage 2 / 3 を直列接続 (2-3 weeks)

- OmniParser-v2 icon_detect を Stage 2 として追加
- PaddleOCR-v4 server を Stage 3 (text recognizer) として追加
- ADR D3' の class-aware dispatch を実装 (text/icon/mixed → 適切な engine)
- multi-engine cross-check (optional flag) を実装

**Done criteria**:
- [ ] Outlook PWA で OCR-only より recall 30%+ 改善 (L2 ≥ 0.92)
- [ ] warm p99 ≤ 30ms 維持 (Stage 1+2+3 合計)
- [ ] false positive による token 爆発が制御できる

### 4b-6: ROCm opt-in 有効化 (1 week)

- `vision-gpu-rocm` feature を build に含める条件下で ROCm EP を有効化
- RX 9070 XT + ROCm 7.2.1 Windows で動作 verify
- capability `profile.rocm === true` の時に `rocm-fp16` variant を選択

**Done criteria**:
- [ ] ROCm 環境で推論速度が DirectML より速い (Phase 4b の目玉)
- [ ] ROCm 不在時に DirectML fallback が自動で動く
- [ ] ROCm EP 初期化失敗時の error 表示が明確

### 4b-7: BenchmarkHarness 実動 + L1 / L2 / L4 / L5 採取 (1 week)

- `src/engine/vision-gpu/benchmark.ts` を実 backend で動かす
- `RUN_VISUAL_GPU_BENCH=1` で RX 9070 XT + Outlook / Chrome / Notepad 計測
- 結果を `artifacts/visual-gpu-bench.json` に JSON で保存
- README に「Tested on: RX 9070 XT / DirectML / 27ms warm p99」 badge 追加

**Done criteria**:
- [ ] L1 / L2 / L4 / L5 全指標が目標値内 (§2.2 表参照)
- [ ] bench JSON が public で publish 可能形式

### 4b-8: default on 切替 (Opus 承認必須、1 day)

- `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND` の default を on に切替
- kill-switch (`DESKTOP_TOUCH_DISABLE_VISUAL_GPU=1`) は維持
- CHANGELOG.md に記載
- Opus 最終レビュー → リリース判定

**Done criteria**:
- [ ] default on + kill-switch で fallback できる動作確認
- [ ] Opus 最終レビュー通過
- [ ] Gate B (4b → 4c) 条件 (L1-L6 全達成) を ADR で `[x]` flip

---

## 4. 実装順序の制約

- 4b-1 → 4b-2 → 4b-3 → 4b-4 → 4b-5 → 4b-6 → 4b-7 → 4b-8 の順序を **守る**
- 並列化する場合は Opus に事前相談 (batch 間依存があるため)
- スキップ禁止 (4b-6 の ROCm を飛ばして 4b-7 に行くのは L6 を毀損する)

---

## 5. 報告フォーマット (各 batch 完了時)

以下をまとめて user に報告する:

```markdown
## Batch 4b-X 完了報告

### 実装ファイル
- path:line...

### 新規テスト
- tests/unit/*.test.ts (N cases, all pass)

### 検証
- [x] vitest N pass / skipped / fail
- [x] tsc --noEmit exit 0
- [x] cargo check --release --features vision-gpu exit 0
- [x] 実機 (RX 9070 XT) verify: ...

### Done criteria (ADR-005 §5 4b-X)
- [x] ...
- [x] ...

### Opus レビュー
- subagent id: ...
- Severity: BLOCKING 0, RECOMMEND N, NIT N
- 対応 commit: ...

### 指標
- L1 warm p99: XXms (目標 30ms)
- L2 recall: 0.XX (目標 0.92)
- ...
```

これを満たさず「完了」と報告するのは禁止。

---

## 6. Stop conditions (即座に Opus 委譲する状況)

次のいずれかが発生したら **Sonnet は作業を止めて即 Opus に判断委譲**:

1. 同一箇所で compile error / test failure が 2 回連続
2. L1-L6 指標のいずれかが達成できず、基準を変えたい衝動が発生
3. ADR-005 と矛盾する実装を思いついた
4. Phase 4a の skeleton (§2.3) を変更したくなった
5. テストコードを書き換えたくなった (§2.1)
6. variant matrix の一部を削りたくなった (§2.4)
7. 実機 (RX 9070 XT) で再現しないバグに時間を溶かしている
8. ユーザーから仕様追加/変更が入った

委譲の受け渡しは `Agent` tool with `subagent_type=general-purpose` + `model=opus` で。

---

## 7. 参照ドキュメント

- ADR-005: [`visual-gpu-backend-adr-v2.md`](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/visual-gpu-backend-adr-v2.md)
- Phase 4a 実装結果: `git log --oneline 3af2cba..2599fc7`
- CLAUDE.md 強制命令 3 (Opus レビュー義務), 4 (Trial & Error 上限)
- システム全体: [`system-overview.md`](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/system-overview.md)

END OF HANDBOOK.
