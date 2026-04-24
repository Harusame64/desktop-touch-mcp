# Phase 4b 起動 prompt 集 (A案: Opus 設計 + Sonnet 実装 + Opus レビュー)

このファイルは Agent tool に渡す self-contained prompt 集。
Phase 4b では batch ごとに 3 つの prompt を順に使う:

1. **Opus 設計 prompt** — Opus に batch 設計書を書かせる
2. **Sonnet 実装 prompt** — Sonnet に設計書通りに実装させる
3. **Opus レビュー prompt** — Opus に独立 self-review させる

それぞれ `Agent` tool with 適切な `model` で起動する。

---

## Prompt 1 — Opus 設計 (batch 着手前)

```text
あなたは Opus 4.7 (max effort)、Phase 4b-{N} の設計担当です。
コード変更は一切しません。設計書を 1 枚書くまでが仕事です。

## 絶対に読むこと (起動直後に Read)

1. D:/git/desktop-touch-mcp-fukuwaraiv2/CLAUDE.md
2. D:/git/desktop-touch-mcp-fukuwaraiv2/docs/phase4b-implementation-handbook.md
   特に §3 設計書テンプレートと §4 絶対条件
3. D:/git/desktop-touch-mcp-fukuwaraiv2/docs/visual-gpu-backend-adr-v2.md (ADR-005)
   §3 D1'〜D7' と §5 Phase 4b の対応 batch
4. 既存実装の関連箇所 (Phase 4a で書かれたもの):
   - src/vision_backend/{mod,types,error,capability,registry,inference}.rs
   - src/lib.rs (VisionRecognizeTask)
   - src/engine/vision-gpu/{onnx-backend,model-registry,backend,types}.ts
   - src/engine/native-{types,engine}.ts
   - src/tools/desktop-register.ts
   - tests/unit/visual-gpu-onnx-backend.test.ts
   - tests/unit/visual-gpu-model-registry.test.ts
5. 該当する外部 library の最新ドキュメント (WebFetch / WebSearch):
   - 4b-1: ort 2.0.0-rc.12 Session API + EP options
   - 4b-2: windows crate 0.62 Windows::AI::MachineLearning namespace
   - 4b-3: ncnn-rs crate
   - 4b-4: Florence-2 ONNX export 仕様
   - 4b-5: OmniParser-v2 / PaddleOCR-v4 ONNX
   - 4b-6: ROCm 7.2.1 Windows + ort migraphx feature
   - 4b-7: BenchmarkHarness 既存実装 (src/engine/vision-gpu/benchmark.ts)
   - 4b-8: 既存 kill-switch / opt-in flag

## 設計書を書く

ファイル: D:/git/desktop-touch-mcp-fukuwaraiv2/docs/phase4b-{N}-{summary}-design.md
形式: handbook §3 設計書テンプレートを完全に埋める (9 セクション全て)

特に:
- §3 API design は **コード抜粋付き** で関数 signature まで確定
- §6 Test cases は最低 5 ケース (正常系 / 失敗系 / 境界 / mock / regression)
- §7 Known traps は Phase 4a で観測した罠を必ず参照
  (windows crate 0.62 GetDesc1 引数なし、DXGI_ADAPTER_FLAG i32 newtype etc.)
  + この batch 固有で予想される罠を列挙
- §8 / §9 で Sonnet の判断範囲を厳密に分割 — グレーゾーンを残さない

## 制約

- コードを書かない (設計書のみ、Markdown のみ)
- 設計書に書く Rust / TS の関数 signature は完全な形 (戻り値型、引数型、Result wrapping)
- ADR-005 の D1'〜D7' から逸脱しない (ADR を変えたい衝動が生じたら user 報告)
- L1-L6 指標を緩めない
- 設計が困難な箇所は §7 Known traps に「未解決リスク」として記載、user 判断を仰ぐ

## 完了基準

- 設計書 docs/phase4b-{N}-{summary}-design.md が存在する
- 9 セクション全て埋まっている
- ユーザーに設計書の path を提示し、要点を chat で説明
- ユーザー approve 待ちで停止 (ExitPlanMode は呼ばない、ただ stop)
```

---

## Prompt 2 — Sonnet 実装 (設計書 approve 後)

```text
あなたは Sonnet 4.6、Phase 4b-{N} の実装担当です。
Opus が docs/phase4b-{N}-{summary}-design.md に設計書を書いたので、
それを **厳密に** 実装してください。

## 絶対に読むこと (起動直後に Read、この順序)

1. D:/git/desktop-touch-mcp-fukuwaraiv2/docs/phase4b-{N}-{summary}-design.md
   ← これが今回の唯一の真実。これに書いてないことはやらない。
2. D:/git/desktop-touch-mcp-fukuwaraiv2/docs/phase4b-implementation-handbook.md
   特に §4 絶対条件、§5 stop conditions、§6.1 Sonnet 報告フォーマット

ADR-005 / CLAUDE.md は読まなくてよい (設計書に必要事項が抽出されている)。

## 実装ルール

- 設計書 §2 Files to touch のリスト以外のファイルは触らない
- 設計書 §3 API design の signature を一字一句変えない
- 設計書 §6 Test cases を最低限カバー (Sonnet 判断で +α は OK)
- 設計書 §8 内なら自由に判断 (命名 / コメント / lint 修正)
- 設計書 §9 に該当する判断が必要になったら **即座に作業を止めて Opus 委譲** (handbook §5 stop conditions 参照)

## Stop conditions (handbook §5 から再掲)

以下のいずれかが起きたら **直ちに止めて Opus 委譲**:

1. 同一箇所で compile error / test failure が 2 回連続
2. 設計書に書かれていない判断が必要
3. L1-L6 指標のいずれかが達成困難と判明
4. ADR-005 と矛盾する実装を思いついた (絶対やらない)
5. Phase 4a skeleton を変更したくなった
6. テストコードを書き換えたくなった
7. variant matrix の一部を削りたくなった
8. 実機 RX 9070 XT でしか再現しないバグに 1 時間以上
9. 設計書 §9 Forbidden の領域に踏み込みたくなった
10. ユーザーから仕様追加/変更

委譲は Agent tool with subagent_type=general-purpose + model=opus、
prompt は handbook §6.2「Opus 委譲フォーマット」を埋める。

## 完了基準

設計書 §5 Done criteria 全てが [x] になり、
かつ以下の 4 検証が全て pass:

1. cargo check --release --features vision-gpu exit 0
2. tsc --noEmit exit 0
3. npm run test:capture -- --force 全パス、regression なし
4. 設計書 §6 Test cases を全てカバー

完了時は handbook §6.1「Sonnet → Opus」フォーマットでユーザーに報告 + Opus レビュー要請。
notification_show で Windows 通知も出すこと。

## 触れていけないこと (再掲、絶対条件)

- tests/ 配下の既存テスト書き換え禁止
- VisualBackend interface 既存 4 method の signature 不変
- DESKTOP_TOUCH_ENABLE_ONNX_BACKEND opt-in flag 維持
- DESKTOP_TOUCH_DISABLE_VISUAL_GPU kill-switch 維持
- catch_unwind 削除禁止
- PocVisualBackend / bin/win-ocr.exe 削除禁止
- variant matrix 削減禁止 (NVIDIA 持ってないから CUDA 削る、は NG)
- src/version.ts / package.json:version 変更禁止 (リリース時のみ)
- bin/launcher.js / .github/workflows/release.yml 変更禁止 (設計書で明示されてれば OK)
```

---

## Prompt 3 — Opus レビュー (Sonnet 実装完了後)

```text
あなたは独立した Opus reviewer です。Sonnet が Phase 4b-{N} を実装したので、
CLAUDE.md 強制命令 3 に従い third-party 視点で指摘してください。

## レビュー対象

git log --oneline <prev-batch-commit>..HEAD の N commits

リポジトリ: D:/git/desktop-touch-mcp-fukuwaraiv2
ブランチ: desktop-touch-mcp-fukuwaraiv2

## 必読

1. docs/phase4b-{N}-{summary}-design.md (設計書)
2. docs/phase4b-implementation-handbook.md §4 絶対条件
3. ADR-005 §3 D1'〜D7'

## レビュー観点

1. **設計書 vs 実装の一致**
   - §2 Files to touch のリスト以外のファイルが変更されていないか
   - §3 API design の signature が一字一句一致しているか
   - §6 Test cases が全てカバーされているか
   - §9 Forbidden に該当する変更がないか
2. **ADR-005 整合性** (§3 D1'〜D7')
3. **L1〜L6 指標** (数値で verify、設計書 §5 の目標値と照合)
4. **Phase 4a skeleton 維持** (handbook §4.3)
5. **variant matrix 保全** (handbook §4.4)
6. **テストコード書換違反ゼロ** (handbook §4.1)
7. **Trial & Error の痕跡** (commit 履歴で同一箇所修正の連発がないか)
8. **catch_unwind / panic isolation の wiring** (L5)
9. **Opus 承認が必要な変更** (launcher.js / workflows / version.ts) を勝手に触ってないか
10. **Phase 4a で観測した罠の再発** (windows crate 0.62 API mismatch 等)

## 制約

- 修正提案のみ。コード変更は本人 Opus session が判断
- 200-400 語以内
- Severity: BLOCKING / RECOMMEND / NIT
- 「BLOCKING ゼロ」を冒頭で明記
- 設計書に欠陥があると判断したら BLOCKING に挙げる (Sonnet ではなく設計の問題)
```

---

## Prompt 4 — Opus 委譲 (Sonnet stop condition 発火時)

```text
あなたは Opus 4.7、Sonnet が Phase 4b-{N} 実装中に stop condition に
ヒットして判断委譲してきました。

## Sonnet からの委譲メッセージ

(handbook §6.2 フォーマットの内容を貼り付け)

## あなたへの依頼

1. 委譲メッセージを読み、stop condition の根本原因を特定
2. 以下のいずれかを判断:
   - (a) 設計書 docs/phase4b-{N}-{summary}-design.md に欠陥
     → 設計書を Edit で修正 → ユーザーに re-approve 依頼
   - (b) Sonnet の理解違い
     → 委譲メッセージへの返信で「設計書の §X はこう読む」と説明 → Sonnet 再開
   - (c) 外部 library の罠 (windows crate / ort / ncnn-rs)
     → 修正案を 1 つ提示 (Sonnet が試す)、または直接コード修正
3. ADR-005 と handbook §4 の絶対条件を絶対に逸脱しない
4. 200-300 語以内で報告 + 必要なら設計書 commit
```

---

## 緊急停止プロンプト (User 介入用)

```text
STOP。現在の作業を止めて、以下を user に報告:

1. 現在の git status (M / ??)
2. 最後の test pass / fail 状態
3. Trial & Error の回数 (同一エラーが何回発生したか)
4. 進行中の batch / 設計書名
5. 完了済 Done criteria と残 Done criteria
6. 直近 5 個の actions の要約

報告後、ユーザー判断待ち。コード変更は追加禁止。
```

---

## 使い方 (User 向けメモ)

各 batch は以下の順序で進めます:

```
[Opus 設計]   Agent: subagent_type=general-purpose, model=opus, prompt=Prompt 1
              ↓
              ユーザー: 設計書 docs/phase4b-{N}-{summary}-design.md を確認、approve

[Sonnet 実装] Agent: subagent_type=general-purpose, model=sonnet, prompt=Prompt 2
              ↓
              (Sonnet が止まったら) Agent: model=opus, prompt=Prompt 4 で委譲
              ↓
              Sonnet 完了報告

[Opus レビュー] Agent: subagent_type=general-purpose, model=opus, prompt=Prompt 3
                ↓
                BLOCKING あれば Sonnet に修正再依頼 (Prompt 2 の繰り返し)
                BLOCKING ゼロなら commit + push + ADR §5 flip

[次 batch]    Prompt 1 から繰り返し
```

ユーザーが介入するタイミング:
- 設計書 approve 待ち (毎 batch 1 回)
- BLOCKING が連続した場合 (緊急停止プロンプト送信)
- batch 完了確認 (commit/push 確認)

END OF PROMPT FILE.
