# Phase 4b 実装 Handbook — Opus 設計 + Sonnet 実装 + Opus レビュー

- Status: Active (2026-04-24 発効、A案 workflow 採用 + 2026-04-24 更に Opus 直実装に修正)
- 設計担当: Opus 4.7 (各 batch 着手前に設計書を docs/ に書く)
- 実装担当: **Opus 4.7 (直接実装)** 原則。Sonnet 4.6 は機械的部分 (annotation / benchmark script / doc formatting 等) のみ opt-in で委譲。4b-1 で Sonnet が cargo check 1 サイクル 4 エラー同時発生、4a で windows crate 0.62 API mismatch 3 連続失敗の経緯を踏まえた判断 (ユーザー 2026-04-24)
- レビュー担当: Opus 4.7 (各 batch 完了後、subagent で self-review、指摘ゼロまで反復)
- 前提 ADR: [`visual-gpu-backend-adr-v2.md`](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/visual-gpu-backend-adr-v2.md) (ADR-005)
- 前提 commits (5 つ、origin に push 済):
  - `c4a9a7f` docs(vision-gpu): ADR-005 (AMD-first reconsideration)
  - `452abfc` feat(vision-gpu): Rust vision_backend skeleton
  - `f8ee3ca` feat(vision-gpu): TS OnnxBackend opt-in + ModelRegistry
  - `2599fc7` fix(vision-gpu): self-review feedback
  - `f00b53d` docs(vision-gpu): Phase 4b handbook + Sonnet prompt

---

## 1. この Handbook の位置づけ

Phase 4b は **「Opus が指揮者、Sonnet が演奏者」** の役割分担で進める。
Sonnet を自走させた場合に発生する以下のリスクを構造的に排除するため:

- 外部ライブラリ (ort / ncnn-rs / windows crate) の API 罠 — Phase 4a で実証済 (windows 0.62 の `GetDesc1` 引数や `DXGI_ADAPTER_FLAG` の i32/u32 mismatch で 3 連続失敗)
- 設計段階での「work around 的」妥協 (ROI 軽視方針と矛盾)
- L1〜L6 指標の解釈変更
- handbook で明文化されていない edge case の独自判断

本人 (ユーザー) が明言した要件:

> ROI を気にしない。技術面のリードを GitHub で掲載することで、
> より LLM に負荷の少ないシステムを世界に展開する。
> 最高品質、最高難度での世界を作りたい。

この方針を Sonnet が独自判断で逸脱しないよう、**Opus が batch ごとに設計書を先行で書く** ことを必須とする。
既存 memory `feedback_opus_plan_sonnet_impl.md` の「Opus 計画 → Sonnet 実装 → Opus レビュー」パターンの厳格版。

---

## 2. ワークフロー (3 段ループ、各 batch ごと)

### Step A — Opus 設計 (batch 着手前)

Opus が `docs/phase4b-{batch}-design.md` を書く。**コード変更は一切しない**。
設計書のテンプレ (§3 参照):

1. Goal (ADR-005 D? に対応)
2. Files to touch (新規/変更/削除リスト)
3. API design (Rust 関数 signature / TS interface 詳細、コード抜粋付き)
4. EP / モデル統合の具体仕様
5. Done criteria (binary 判定可能)
6. Test cases (最低カバー要件)
7. Known traps (Phase 4a で観測した罠 + 4b で予想される罠)
8. Acceptable Sonnet judgment scope (設計書内で Sonnet が決めて良い範囲)
9. Forbidden Sonnet judgments (絶対に Sonnet が独自に決めてはいけない範囲)

設計書完成後、ユーザーに見せて approve をもらう (CLAUDE.md 作業フロー §1)。

### Step B — Opus 直接実装 (default) / Sonnet 委譲 (opt-in)

**default: Opus が設計書 §10 の実装順序に従って直接コードを書く**。
Sonnet 委譲はユーザー事前承認 + 以下のどれか該当時のみ:
- 機械的繰り返し作業 (model manifest の大量エントリ生成、benchmark harness の boilerplate、annotation script)
- 設計書で「Sonnet 委譲可」と明示した batch
- Opus の context が他 batch で圧迫されていてセッション分離したい場合

Sonnet 委譲時は `Agent` tool with `subagent_type=general-purpose` + `model=sonnet`、
prompt は `docs/phase4b-sonnet-prompt.md` の「Sonnet 実装起動 prompt」を使う。
Sonnet は設計書 + handbook §4 絶対条件のみ context、設計書にない判断は即 Opus 委譲。

Opus 直実装時は:
- 設計書 §10 の手順に従って順次コード作成
- 設計書 §9 Forbidden / handbook §4 absolute rules は自身にも適用
- 同一箇所で trial & error 2 連続したら別 Opus subagent 立ち上げて判断委譲 (強制命令 4)
- 完了後は Step C self-review subagent を必ず回す

### Step C — Opus レビュー (Sonnet 完了後)

Opus が独立 subagent で self-review (`subagent_type=general-purpose` + `model=opus`)。
レビュー prompt は `docs/phase4b-sonnet-prompt.md` の「Opus レビュー依頼テンプレート」を使う。

レビュー観点:
1. 実装 vs 設計書の差分 (Sonnet が設計から逸脱していないか)
2. ADR-005 D1'〜D7' との整合 (設計書の段階で抽出されているはずだが念押し)
3. L1〜L6 指標達成 (数値で verify)
4. Phase 4a skeleton 維持 (handbook §4.3)
5. variant matrix 保全 (handbook §4.4)
6. テストコード書換違反 (handbook §4.1)
7. Trial & Error の痕跡 (commit 履歴で同一箇所修正の連発がないか)
8. 設計時に見落とした罠 (Phase 4c に持ち越すか、4b 内で再修正するかの判断)

BLOCKING / RECOMMEND / NIT で分類。BLOCKING がある場合:
- 設計書に欠陥 → Opus が設計書を revise → Sonnet 再 invoke
- 実装ミス → Sonnet にもう 1 ループ修正依頼
- 指摘ゼロまで反復

### Step D — Commit + Push + ADR flip

Opus が最終 commit を切る (Sonnet の commit を整理しても良い)。
ADR-005 §5 の対応 batch checklist を `[x]` に flip。
push して次 batch の Step A へ。

---

## 3. 設計書テンプレート (`docs/phase4b-{batch}-design.md`)

各 batch で Opus が書く設計書の標準フォーマット:

```markdown
# Phase 4b-{N} 設計書 — {Batch 名}

- Status: Approved (YYYY-MM-DD) — ユーザー承認済
- 設計者: Claude (Opus)
- 実装担当: Sonnet (起動方法は docs/phase4b-sonnet-prompt.md)
- 対応 ADR-005 セクション: D? / §5 4b-{N}

## 1. Goal
(この batch で達成する単一の目標 + ADR-005 のどの判断を満たすか)

## 2. Files to touch

### 新規作成
- `path/to/file.rs` — 役割概要 (推定 N 行)

### 変更
- `path/to/file.ts:line-range` — 変更内容

### 削除禁止
- `path/to/file.rs` — Phase 4a skeleton として保護

## 3. API design

### Rust 側
```rust
// 設計済 signature をコード抜粋で示す
pub fn vision_load_session(...) -> Result<SessionHandle, VisionBackendError> {...}
```

### TS 側
```ts
// 設計済 interface
export interface SessionHandle { ... }
```

## 4. EP / モデル統合の具体仕様

(該当する場合のみ。例: WinML EP の初期化順、ROCm provider option 等)

## 5. Done criteria (binary check)

- [ ] cargo check --release --features vision-gpu exit 0
- [ ] tsc --noEmit exit 0
- [ ] npm run test:capture -- --force exit 0
- [ ] 新規 N tests pass / regression なし
- [ ] ADR-005 §5 4b-{N} の Done criteria 全て [x]
- [ ] (実機 verify が必要な場合) RX 9070 XT で具体コマンド実行 + 出力確認

## 6. Test cases (最低カバー要件)

`tests/unit/visual-gpu-{batch}.test.ts` を新規作成し、最低以下を含む:
- ケース 1: 正常系
- ケース 2: 失敗系 (具体的な error path)
- ケース 3: 境界条件
...

## 7. Known traps

Phase 4a で観測した罠:
- windows crate 0.62 の API mismatch (例: GetDesc1 は引数なし、DXGI_ADAPTER_FLAG は i32 newtype)
- ort 2.0.0-rc.12 の prebuilt 不在 → load-dynamic 必須

この batch で予想される罠:
- ...

## 8. Acceptable Sonnet judgment scope

設計書内で Sonnet が決めて良い:
- 関数/変数の命名 (機能を表すなら任意)
- コメント追加
- 設計書 test cases を超える追加テスト
- lint warning 修正
- import 順序の整理

## 9. Forbidden Sonnet judgments

Sonnet が独自に決めてはいけない:
- API signature の変更 (戻り値型、引数追加等)
- ファイル新規作成 (本書 §2 のリストに無いもの)
- ファイル削除 / 移動
- handbook §4 absolute rules の解釈変更
- L1-L6 指標の数値変更
- variant matrix の削減
- Phase 4a skeleton の改変
- テストコードの書き換え
- 既存依存の追加/削除

これらは設計書の改訂が必要 → Opus に判断委譲 (Sonnet stop conditions §5)
```

---

## 4. 絶対条件 — Sonnet・Opus 共通の不可侵ルール

### 4.1 テストコード改変の禁止 (Sonnet)

- `tests/unit/` / `tests/integration/` / `tests/e2e/` 配下の **既存テストの書き換えを禁止**
- 失敗するテストがあった場合、テストではなく **実装コードを修正**
- テスト追加は OK (設計書 §6 の最低数 + α)
- 既存テストの assertion を緩める修正は **即座に Opus に委譲**

### 4.2 ADR-005 §2 の 6 指標 (L1〜L6) を緩めない

| 指標 | 目標値 | 緩めるのを禁止 |
|---|---|---|
| L1 warm latency p99 | RX 9070 XT ≤ 30ms / iGPU ≤ 200ms | 40ms や 300ms に変えない |
| L2 detector recall | ≥ 0.92 | 0.85 に下げない |
| L3 token compression | ≤ 0.30 | 0.50 等に緩めない (Phase 4c 事項だが基準は動かない) |
| L4 GPU steady-state | ≤ 25% | 40% 等に上げない |
| L5 inference crash → MCP 生存 | 100% (構造的) | 「たまに落ちてもログ残せば OK」は不可 |
| L6 vendor portability | AMD + CPU 必須 | NVIDIA-only / AMD-only 実装禁止 |

設計段階で達成困難と判明したら Opus が設計書を revise + ユーザー再 approve。
実装段階で発覚したら Sonnet は止まって Opus に委譲。

### 4.3 Phase 4a の構造 (skeleton) を壊さない

以下はすべて **維持** 必須:

- `VisualBackend` interface の既存 4 メソッド (`ensureWarm` / `getStableCandidates` / `onDirty` / `dispose`) の signature
- `DESKTOP_TOUCH_ENABLE_ONNX_BACKEND=1` の opt-in flag (Phase 4b default on は **4b-8 batch でのみ**、Opus 設計書で明示後)
- `DESKTOP_TOUCH_DISABLE_VISUAL_GPU=1` kill-switch
- Rust `std::panic::catch_unwind` による L5 保護 (`src/vision_backend/inference.rs:recognize_rois_blocking`)
- TS 側の `recognizeRois` が native error を throw せず `[]` を返す契約
- `PocVisualBackend` (Phase 1-3 fallback) の **削除禁止** — `kill-switch` 時の fallback として残置
- `bin/win-ocr.exe` (Tier ∞) の **削除禁止** — どのモデルも load できない最悪時の safety net

### 4.4 モデル variant matrix を勝手に削らない

ADR-005 D4' の variant matrix:

```
winml-fp16 / dml-fp16 / rocm-fp16 / vulkan-ncnn / cuda-fp16 / trt-fp8 / cpu-int8
```

- 「NVIDIA 持ってないから cuda/trt 不要」と削るのは禁止 (NVIDIA 環境協力者の枠を維持)
- 「Vulkan/ncnn は複雑だから後回し」も禁止 (L6 vendor portability の要)
- `rocm-fp16` は Windows ROCm EP 未成熟を反映し、manifest には登録、runtime で解決可能時のみ選択

### 4.5 AMD 実機 (Radeon RX 9070 XT / Win11 24H2) baseline を絶対軸にする

- ベンチ値は **RX 9070 XT で必ず取得**
- `bench_ms.rx9070xt` が埋まらない variant は manifest に登録しない (空欄不可)
- NVIDIA 実測は協力者環境で取得 (取れなくても 4b は止まらない)

### 4.6 Trial & Error 2 回上限 (CLAUDE.md 強制命令 4)

- Sonnet は同一箇所で compile error / test failure が **2 回連続** したら 3 回目試さず Opus に判断委譲
- 委譲フォーマット (Sonnet → Opus):
  - エラーメッセージ full text
  - 該当ファイル + 該当行
  - これまで試した手数 (list)
  - 制約 (触ってはいけない周辺コード)
  - 設計書の該当 section リンク

### 4.7 ドキュメント更新の義務

batch 完了ごとに以下を更新:
- ADR-005 (`docs/visual-gpu-backend-adr-v2.md`) §5 の checklist `[ ]` → `[x]`
- 設計書 `docs/phase4b-{batch}-design.md` の Status を「Implemented」に変更 + 実装 commit hash 記載

flip せずに commit するのは禁止。

### 4.8 既存依存の破壊禁止

- `package.json` の dependencies 削除禁止 (追加は Opus 設計で承認後のみ)
- `bin/launcher.js` の変更は Opus 設計で明示必須 (リリース経路に直結)
- `.github/workflows/release.yml` の変更は Opus 設計で明示必須
- `src/version.ts` / `package.json:version` の変更は **リリース時のみ** (CLAUDE.md 強制命令 1)

---

## 5. Sonnet stop conditions (即座に Opus 委譲する状況)

Sonnet が以下のいずれかに該当したら **直ちに作業を止めて Opus に判断委譲**:

1. 同一箇所で compile error / test failure が 2 回連続
2. 設計書 (`docs/phase4b-{batch}-design.md`) に書かれていない判断が必要になった
3. L1-L6 指標のいずれかが達成困難と判明
4. ADR-005 と矛盾する実装を思いついた
5. Phase 4a skeleton (§4.3) を変更したくなった
6. テストコードを書き換えたくなった (§4.1)
7. variant matrix の一部を削りたくなった (§4.4)
8. 実機 (RX 9070 XT) でしか再現しないバグに 1 時間以上溶かしている
9. 設計書 §9 Forbidden の領域に踏み込みたくなった
10. ユーザーから仕様追加/変更が入った

委譲先: `Agent` tool with `subagent_type=general-purpose` + `model=opus`、prompt は handbook §6 の「Opus 委譲フォーマット」。

---

## 6. 報告フォーマット

### 6.1 Sonnet → Opus (batch 完了報告)

```markdown
## Batch 4b-X 実装完了 (Sonnet)

### 設計書
- 参照: docs/phase4b-{batch}-design.md (Implemented)

### 実装ファイル
- 新規: path... (N 行)
- 変更: path:line-range...

### 新規テスト
- tests/unit/*.test.ts (N cases, all pass)

### 検証
- [x] vitest N pass / skipped / fail
- [x] tsc --noEmit exit 0
- [x] cargo check --release --features vision-gpu exit 0
- [x] 設計書 §5 Done criteria 全て [x]

### 設計書 §8 内で Sonnet が判断した事項
- ...

### 設計書 §9 で迷った事項 (もしあれば、Opus 委譲履歴)
- ...

### Trial & Error 履歴 (該当箇所、試行回数)
- (なし、または各箇所を列挙)
```

### 6.2 Opus 委譲フォーマット (Sonnet → Opus, stop condition 発火時)

```markdown
## Opus 判断委譲依頼

### 該当 batch
4b-X — docs/phase4b-{batch}-design.md

### 発生した stop condition (handbook §5 のどれか)
N: ...

### 該当箇所
- ファイル: path:line
- エラー (full text):
  ```
  ...
  ```

### これまで試した手数
1. ...
2. ...

### 触ってはいけない周辺コード
- 設計書 §9 Forbidden 該当箇所: ...

### 私 (Sonnet) の判断
(止まった理由を 1-2 文で)
```

### 6.3 Opus → User (batch 完了報告)

Opus が最終 review 後にユーザーに報告:

```markdown
## Batch 4b-X 完了報告 (Opus 最終承認済)

### 設計書 → 実装 → レビュー
- 設計: docs/phase4b-{batch}-design.md (commit hash)
- 実装: Sonnet (commits ...)
- レビュー: Opus (issues: BLOCKING 0 / RECOMMEND N / NIT N)

### 指標
- L1 warm p99: XXms (目標 30ms)
- L2 recall: 0.XX (目標 0.92)
- ...

### Phase 4a skeleton への影響
- なし / 以下のみ追加: ...

### 次 batch
4b-{N+1} 設計書を書き始めます (もしくは Gate B 判定へ)
```

---

## 7. Phase 4b batch 一覧 (ADR-005 §5 から転記)

各 batch ごとに Opus が設計書を書く。設計書ファイル名は `docs/phase4b-{N}-{summary}-design.md`:

| Batch | summary | 設計書 (Opus 起草) | 実装 (Sonnet) |
|---|---|---|---|
| 4b-1 | EP cascade real wiring | `docs/phase4b-1-ep-cascade-design.md` | Rust `vision_backend::inference` で ort::Session lifecycle (✅完了) |
| ~~4b-2~~ | ~~WinML EP integration~~ | ~~`docs/phase4b-2-winml-design.md`~~ | **Deferred to ADR-006** (`windows-app` crate yanked + repo archived、独立 ADR で取り扱う) |
| 4b-3 | Vulkan/ncnn lane | `docs/phase4b-3-vulkan-ncnn-design.md` | ncnn-rs binding, Layer 3 統合 (**4b-2 deferred により次の着手対象**) |
| 4b-4 | Florence-2 投入 | `docs/phase4b-4-florence2-design.md` | Stage 1 region proposer |
| 4b-5 | OmniParser-v2 + PaddleOCR-v4 | `docs/phase4b-5-stage23-design.md` | Stage 2 + 3 直列接続 |
| 4b-6 | ROCm opt-in | `docs/phase4b-6-rocm-design.md` | RX 9070 XT + ROCm 7.2.1 動作 |
| 4b-7 | BenchmarkHarness 実動 | `docs/phase4b-7-bench-design.md` | L1-L6 計測 |
| 4b-8 | default on 切替 | `docs/phase4b-8-default-on-design.md` | Opus 承認必須、CHANGELOG 追加 |

順序は厳守 (依存関係あり)。

---

## 8. 参照ドキュメント

- ADR-005: [`visual-gpu-backend-adr-v2.md`](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/visual-gpu-backend-adr-v2.md)
- Sonnet/Opus 起動 prompt: [`phase4b-sonnet-prompt.md`](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/phase4b-sonnet-prompt.md)
- Phase 4a 実装結果: `git log --oneline 3af2cba..f00b53d`
- CLAUDE.md 強制命令 3 (Opus レビュー義務), 4 (Trial & Error 上限)
- 既存 memory: `feedback_opus_plan_sonnet_impl.md` (本 handbook の上位パターン)
- システム全体: [`system-overview.md`](D:/git/desktop-touch-mcp-fukuwaraiv2/docs/system-overview.md)

END OF HANDBOOK.
