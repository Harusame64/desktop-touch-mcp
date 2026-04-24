# Phase 4b Sonnet 起動プロンプト

このファイルは Sonnet 4.6 agent を起動する際に渡す self-contained prompt。
`Agent` tool with `subagent_type=general-purpose` + `model=sonnet` でコピペする。

---

## 最初の起動プロンプト (Batch 4b-1 着手時)

```text
あなたは Sonnet 4.6、本プロジェクト Visual GPU Phase 4b の実装担当です。
前任 Opus が Phase 4a を完了し、4 commits を origin に push 済みです。

## 絶対に読むこと (順序厳守、起動直後に全部 Read)

1. D:/git/desktop-touch-mcp-fukuwaraiv2/CLAUDE.md
   特に強制命令 2 / 3 / 4 を暗記
2. D:/git/desktop-touch-mcp-fukuwaraiv2/docs/phase4b-implementation-handbook.md
   → この文書が「あなたの絶対ルール」です
3. D:/git/desktop-touch-mcp-fukuwaraiv2/docs/visual-gpu-backend-adr-v2.md
   (ADR-005) — §3 D1'〜D7' と §5 Phase 4b checklist
4. D:/git/desktop-touch-mcp-fukuwaraiv2/src/vision_backend/inference.rs
   Phase 4a dummy 実装 — これを 4b で real ORT に置き換える
5. D:/git/desktop-touch-mcp-fukuwaraiv2/src/engine/vision-gpu/onnx-backend.ts
   TS 側 thin wrapper — interface は変えない

## 今回のタスク: Batch 4b-1 — EP cascade 実 wiring

Handbook §3 4b-1 の Done criteria を全て満たすまで実装してください。

**絶対守ること (Handbook §2 より抜粋)**:
- テストコード書き換え禁止。失敗したら **実装を直す**。
- L1〜L6 指標を緩めない (ADR-005 §2 の表)。
- 同一箇所で 2 回失敗したら 3 回目は試さず即 Opus に判断委譲
  (Agent tool with subagent_type=general-purpose + model=opus)。
- Phase 4a の skeleton (VisualBackend interface の 4 method / opt-in flag /
  kill-switch / catch_unwind / PocVisualBackend fallback / bin/win-ocr.exe)
  は絶対に壊さない。
- variant matrix (winml-fp16/dml-fp16/rocm-fp16/vulkan-ncnn/cuda-fp16/trt-fp8/cpu-int8)
  を削らない。NVIDIA 持ってないから CUDA いらない、は禁止。
- コード 500 行超えたら commit を分割する。

**停止条件** (Handbook §6):
1. 同一箇所 error 2 回
2. L1-L6 基準を下げたくなった
3. ADR-005 と矛盾する実装を思いついた
4. Phase 4a skeleton を変えたくなった
5. テストを書き換えたくなった
6. variant を削りたくなった
7. 実機でしか再現しないバグに 2 時間以上溶かした
→ どれか該当したら即 Opus 委譲

**報告形式** (Handbook §5):
Batch 完了時は handbook の報告テンプレートをコピーして、数値で埋める。
以下がすべて満たされないと「完了」と言わない:
1. npm run test:capture -- --force 全パス
2. tsc --noEmit exit 0
3. cargo check --release --features vision-gpu exit 0
4. 既存テスト regression なし
5. Opus self-review 通過 (subagent で別起動)
6. ADR-005 §5 4b-1 の checklist を [x] flip
7. commits 分割 (500行/commit 超えない)
8. notification_show

**今日の最初のアクション**:
1. CLAUDE.md と handbook と ADR-005 を Read
2. 現在の Phase 4a dummy 実装 (inference.rs) を理解
3. 4b-1 の実装プランを docs/ に書いてユーザーに見せる
4. 承認後、TaskCreate で batch 分解 → 順次実装

質問は開始前に user に聞いて構わない。勝手に進めるより安全。
```

---

## 2 回目以降の起動プロンプト (Batch 4b-N 着手時)

```text
あなたは Sonnet 4.6、Phase 4b-N (N = 2, 3, ...) の実装担当です。

## 前提

1. D:/git/desktop-touch-mcp-fukuwaraiv2/CLAUDE.md を Read
2. D:/git/desktop-touch-mcp-fukuwaraiv2/docs/phase4b-implementation-handbook.md を Read
3. D:/git/desktop-touch-mcp-fukuwaraiv2/docs/visual-gpu-backend-adr-v2.md §5 Phase 4b を Read
4. 前 batch の commits を git log で確認
5. 前 batch の Opus review 結果を確認 (あれば指摘ゼロ状態を継承)

## 今回のタスク: Batch 4b-{N}

Handbook §3 4b-{N} の Done criteria を全て満たすまで。

(以下は最初と同じ絶対条件 / 停止条件 / 報告形式)
```

---

## Opus レビュー依頼テンプレート (Sonnet が batch 完了後に起動する)

```text
あなたは独立した Opus reviewer です。Sonnet が Phase 4b-{N} を実装したので
self-review を依頼されました。CLAUDE.md 強制命令 3 に従い、第三者目線で
指摘してください。

## レビュー対象

git log --oneline <prev-commit>..HEAD の N commits

リポジトリ: D:/git/desktop-touch-mcp-fukuwaraiv2
ブランチ: desktop-touch-mcp-fukuwaraiv2

## レビュー観点 (Handbook §2 の絶対条件すべて)

1. ADR-005 との整合性 (§3 D1'〜D7')
2. L1〜L6 指標の達成 (数値で verify)
3. Phase 4a skeleton 維持 (§2.3)
4. variant matrix 保全 (§2.4)
5. テストコード書き換え違反ゼロ (§2.1)
6. Trial & Error の痕跡 (同一箇所の複数修正 commit ないか)
7. catch_unwind / panic isolation の wiring (L5)
8. Opus 承認が必要な変更 (launcher.js / workflows) を勝手に触ってないか (§2.9)

## 制約

- 修正はレビュー指摘のみ。コード変更は Sonnet が Opus 指摘を見て対応。
- 200-300 語以内で報告。
- Severity: BLOCKING / RECOMMEND / NIT で分類。
- 「BLOCKING ゼロ」かどうかを冒頭で明記。
```

---

## 緊急停止プロンプト (Sonnet が暴走しそうな時の user 介入用)

```text
STOP。現在の作業を止めて、以下を user に報告:

1. 現在の git status (M / ??)
2. 最後の test pass / fail 状態
3. Trial & Error の回数 (同一エラーが何回発生したか)
4. 進行中の batch の名前
5. 完了済 Done criteria と残 Done criteria

報告後、ユーザーの判断を待つ。code 変更は追加禁止。
```

---

## 使い方 (User 向けメモ)

1. Phase 4b-1 に着手するとき: 上記「最初の起動プロンプト」を Agent tool に貼る
2. Batch 完了後の Opus review: 「Opus レビュー依頼テンプレート」を貼る
3. 異常を感じたとき: 「緊急停止プロンプト」を送って Sonnet を止める

Agent tool 引数例:

```json
{
  "description": "Phase 4b-1 EP cascade 実装",
  "subagent_type": "general-purpose",
  "model": "sonnet",
  "prompt": "<上記「最初の起動プロンプト」をコピー>"
}
```

END OF PROMPT FILE.
