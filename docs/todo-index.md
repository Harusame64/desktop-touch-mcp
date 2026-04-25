# ToDo Index

この文書は、`docs/` に散らばっている未完了事項を「今やること」「保留してよいこと」「もう追わない方針」に整理して集約した索引です。

目的は 3 つです。

1. 実作業の ToDo を 1 か所で見られるようにする
2. 研究テーマや将来構想を、日常の保守タスクと分離する
3. 過去の方針転換で「もうやらない」ものを明示し、古い文書に引っ張られないようにする

---

## 1. 今やる ToDo

### 1-1. docs / release 運用

- [ ] `release-automation-plan.md` の未反映チェックを閉じる
  - 実装済み: `scripts/update-sha.mjs`, `.github/workflows/release.yml`, `release-process.md` 更新
  - まだ確認が必要: npm Trusted Publisher 設定、初回運用の実地確認、MCP Registry publish の手順確認
  - 参照: [release-automation-plan.md](D:/git/desktop-touch-mcp/docs/release-automation-plan.md), [release-process.md](D:/git/desktop-touch-mcp/docs/release-process.md)
- [ ] docs の正本 / archive の境界を継続的にメンテする
  - 新しい plan を足したら、この文書にも「今やる / 保留 / やらない」のどこに入るかを追記
  - 参照: [README.md](D:/git/desktop-touch-mcp/docs/README.md)

### 1-2. Anti-Fukuwarai v2 hardening の残件

- [ ] H5 `windowTitle="terminal"` の曖昧一致対策
  - ねらい: terminal / dialog / 別タブへの誤送信を減らす
  - 参照: [anti-fukuwarai-v2-hardening-backlog.md](D:/git/desktop-touch-mcp/docs/anti-fukuwarai-v2-hardening-backlog.md)
- [ ] H6 日本語 `windowTitle` の encoding / serialization バグ確認
  - ねらい: `set_element_value(windowTitle="タイトルなし")` 系の再現 test を先に固定する
  - 参照: [anti-fukuwarai-v2-hardening-backlog.md](D:/git/desktop-touch-mcp/docs/anti-fukuwarai-v2-hardening-backlog.md)
- [ ] H7 app-specific query resilience
  - ねらい: GitHub body editor の `"on"` 問題のような query 耐性不足を潰す
  - 参照: [anti-fukuwarai-v2-hardening-backlog.md](D:/git/desktop-touch-mcp/docs/anti-fukuwarai-v2-hardening-backlog.md)

注記:
H1-H4 は文書上は未整理に見えますが、コード側にはかなり反映済みです。いまの優先残件は H5-H7 側です。

### 1-3. OCR 品質改善の未検証項目

- [ ] `tests/integration/ocr-golden.test.ts` の fixture を使って改善量を再測定する
  - 目標: `known-broken` が baseline 比 -15% / -30% を満たすか確認
- [ ] Outlook PWA 実機 dogfood で `"FANUC"` / `"CUSCNET-SUPPORT"` の補正確認
- [ ] UIA 正常ターゲットで OCR lane が起動しないことを確認
- [ ] 4K / 200% DPI で pipeline 時間を測る
  - 参照: [ocr-quality-improvement-plan.md](D:/git/desktop-touch-mcp/docs/ocr-quality-improvement-plan.md)

### 1-4. `main` へ戻すための土台整理

- [ ] tool surface の `core / expert` 方針を実装に落とす
- [ ] `DESKTOP_TOUCH_TOOL_SURFACE` の切り替え実装
- [ ] runtime registration / stub catalog / README の mode-aware 化
- [ ] `desktop_see` / `desktop_touch` を加えた公開面の整理
  - 参照: [v2-main-migration-checklist.md](D:/git/desktop-touch-mcp/docs/v2-main-migration-checklist.md), [tool-surface-reduction-plan.md](D:/git/desktop-touch-mcp/docs/tool-surface-reduction-plan.md), [tool-surface-phase1-naming-design.md](D:/git/desktop-touch-mcp/docs/tool-surface-phase1-naming-design.md)

---

## 2. 保留してよい ToDo

この章は「価値はあるが、今すぐ閉じなくてもよい」ものです。

### 2-1. Visual GPU の実機検証と公開物

- [ ] RX 9070 XT で warm p99 ≤ 30ms を計測
- [ ] iGPU で warm p99 ≤ 200ms を計測
- [ ] AMD + CPU の vendor portability を実機で確認
- [ ] 公開可能な `artifacts/visual-gpu-bench.json` / `BENCH.md` を整える
- [ ] Outlook PWA で OCR-only 比 30%+ recall 改善を測る
  - 参照: [visual-gpu-backend-adr-v2.md](D:/git/desktop-touch-mcp/docs/visual-gpu-backend-adr-v2.md), [phase4b-dogfood-runbook.md](D:/git/desktop-touch-mcp/docs/phase4b-dogfood-runbook.md)

### 2-2. `main` 移行で非ブロッカーの研究テーマ

- [ ] detector の最終本命選定
- [ ] multi-engine OCR の本格導入
- [ ] token-efficient DSL
- [ ] state classifier / relationship inference
- [ ] Hugging Face 公開、論文化
  - 参照: [v2-main-migration-checklist.md](D:/git/desktop-touch-mcp/docs/v2-main-migration-checklist.md)

### 2-3. 将来 ADR

- [ ] ADR-006: self fine-tuned model の training pipeline / dataset license
- [ ] ADR-007: WebGPU / wonnx / candle への将来移行判断
- [ ] ADR-008: Mac / Linux 対応計画
- [ ] ADR-009: WinML が DirectML を完全置換した後の移行戦略
  - 参照: [visual-gpu-backend-adr-v2.md](D:/git/desktop-touch-mcp/docs/visual-gpu-backend-adr-v2.md)

---

## 3. もう追わない / 既に方針変更したもの

### 3-1. release 手順

- 手動で SHA256 を計算して `bin/launcher.js` を書き戻す運用
- 手動 `npm publish` を正規 release 手順に含める運用

現在の正本は「zip 作成後に CI の `npm-publish` job が SHA を注入して publish」です。
参照: [release-process.md](D:/git/desktop-touch-mcp/docs/release-process.md)

### 3-2. Visual GPU の旧方針

- ADR-004 のまま進める方針
  - `onnxruntime-node` inline backend
  - DirectML default 固定
  - `win-ocr` 中心の保守的構成
- `visual-gpu-phase4-rollout.md` を現行 rollout の正本として扱うこと

現在の正本は ADR-005 相当の [visual-gpu-backend-adr-v2.md](D:/git/desktop-touch-mcp/docs/visual-gpu-backend-adr-v2.md) です。
旧文書は履歴としては残しますが、実装判断の基準にはしません。

### 3-3. `main` 移行を止める理由として扱わないもの

- detector の最終勝者がまだ決まっていないこと
- OmniParser / Florence-2 / 自前 fine-tune の勝者未確定
- multi-engine OCR 未実装
- DSL serializer 未実装
- state classifier / relationship inference 未実装
- Hugging Face 公開や論文化が未着手
- LLM 選定が研究継続中であること

これらは「研究 branch を続ける理由」であって、「`main` に戻せない理由」ではありません。
参照: [v2-main-migration-checklist.md](D:/git/desktop-touch-mcp/docs/v2-main-migration-checklist.md)

---

## 4. 文書の読み方

- 実装作業に入るときはこの文書の `1. 今やる ToDo` だけ見ればよい
- 中長期の研究判断をしたいときは `2. 保留してよい ToDo` を見る
- 古い plan を読んでいて迷ったら、まず `3. もう追わない / 既に方針変更したもの` に載っていないか確認する

---

## 5. 更新ルール

- 新しい plan / ADR を追加したら、この文書にも必ず 1 行追加する
- 何かを実装したら、元の文書だけでなくこの文書のチェック状態も更新する
- 方針転換が起きたら、単に古い文書を残すのではなく、この文書の `3. もう追わない` に追記する
