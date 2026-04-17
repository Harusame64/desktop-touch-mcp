# CLAUDE.md — desktop-touch-mcp

このファイルは会話開始時に必ず読まれる指示書です。埋め込み検索に頼らず、ここに書かれた手順に従って行動してください。回答・プランは日本語で、コード・ファイルパスは英語のまま。

---

## プロジェクト概要

Windows 向け MCP (Model Context Protocol) サーバ。Claude CLI から任意の Windows デスクトップアプリを操作するための 56 ツールを提供する。

- **配布**: npm `@harusame64/desktop-touch-mcp`（軽量ランチャー） + GitHub Release `desktop-touch-mcp-windows.zip`（実ランタイム）
- **起動**: `npx -y @harusame64/desktop-touch-mcp` — 初回は GH Release zip を `%USERPROFILE%\.desktop-touch-mcp` にダウンロード
- **3層構成**: Engine (nutjs / win32 / uia-bridge / cdp-bridge / perception) → 56 MCP tools → MCP server
- **現行版**: 0.12.0（詳細は `src/version.ts` と `package.json`）
- **システム詳細**: `docs/system-overview.md`

---

## 強制命令 1: リリース作業時は docs/release-process.md を full read

以下のトリガー語を含む依頼を受けたら、**他の行動より先に** `docs/release-process.md` を Read ツールで最初から最後まで読むこと。メモリや本ファイルのサマリだけで判断してはいけない。

- トリガー語: `release` / `リリース` / `publish` / `npm publish` / `tag` / `タグ` / `npm version` / `GitHub Release` / `バージョン上げ` / `version bump`

### 正しいリリース順序（絶対遵守）

npm launcher は GitHub Releases から zip をダウンロードする。**zip が存在しない状態で npm publish すると、ユーザーの初回 npx が 404 で失敗する。**

```
1. src/version.ts と package.json / package-lock.json を更新（npm version --no-git-tag-version）
2. node --check bin/launcher.js / npm run build / npm publish --dry-run で preflight
3. git commit & push
4. git tag vX.Y.Z && git push origin vX.Y.Z
5. GitHub Actions (.github/workflows/release.yml) が desktop-touch-mcp-windows.zip を生成するのを待つ
6. gh release view vX.Y.Z --json assets で zip の存在を確認
7. ★ ここで初めて npm publish（2FA ブラウザ認証あり）
8. クリーンキャッシュで npx スモークテスト（docs/release-process.md の "Smoke Test" 参照）
```

**禁則事項:**
- npm publish を GH Release zip 生成より先に実行しない
- 既存タグを移動しない（必ず新しい patch を切る）
- 壊れた版は `npm unpublish` より `npm deprecate` を優先
- `.npmrc` / OTP / トークンを git に含めない

---

## 強制命令 2: 大きな実装作業時は docs/ の関連ファイルを先に読む

以下のトリガー語を含む依頼は、実装に入る前に `docs/` 内の関連ドキュメントを読むこと。

| 依頼カテゴリ | 先読みすべきファイル |
|---|---|
| アーキテクチャ全体の把握 / 新規ツール追加 | `docs/system-overview.md` |
| Perception / RPG / lens 関連 | `docs/` 内 perception / rpg 関連プラン |
| 競合比較 / 追加機能検討 | `docs/competitor-research.md` |
| 大きめの feature プラン | `docs/*-plan.md`（該当機能） |

プランドキュメントを新規作成する場合は必ず `docs/` 配下に Markdown で保存する（ワークフローフィードバック参照）。

---

## 強制命令 3: Opus 再レビュー義務

以下の場面では **必ず Opus にレビューを依頼** し、指摘ゼロになるまで修正 → 再レビューを反復する。Sonnet で書き上げ、Opus で詰めるモデル役割分担。

1. **Phase 境界**: 大きめプランの各 Phase 完了時（概念設計 × プラン × 実装の 3 者一致を Opus が確認するまで次 Phase に進まない）
2. **リリース直前**: `npm publish` 前の最終チェック
3. **完了報告前**: 実装完了を報告する前に必ず Opus レビューを走らせる

実施方法: 別エージェント起動（`subagent_type=general-purpose` + `model=opus`）またはユーザーに Opus セッション切替を依頼。

---

## 強制命令 4: Trial & Error 2 回上限

同一箇所で trial & error が 2 回連続発生したら、**3 回目は試さず即 Opus に判断委譲**する（絶対条件）。

テストエラーが発生した場合は自分で修正せず、先に Opus に相談する。Sonnet agent は失敗を見ると勝手にテストを書き換える傾向があるため、agent プロンプトで明示的に「テストコードの書き換え禁止」を指示すること。

---

## 強制命令 5: 仕組みで対応する（メモリ頼みにしない）

問題が発生したとき、メモリに保存して「次回から気をつける」だけで終わらせない。

1. まず「コード・スクリプト・ツールの設計で防げないか」を検討する
2. 仕組みで防げるならコードで実装する（ガードチェック、バリデーション、型制約など）
3. 仕組みで防げない補完的な場合のみメモリに記録する

この CLAUDE.md 自体も「メモリに頼らずファイルで強制する」仕組みの一例。

---

## 作業フロー

1. プランが完成したら (1) `docs/` にプランファイルを書く → (2) 内容をチャットにも表示 → (3) ExitPlanMode を呼ぶ
2. ExitPlanMode だけ先に呼ばない（ユーザーは目視確認したい）
3. スコープは狭く保ち、周辺パターンへの波及提案は最小化する
4. 大きめ plan には Phase 毎の checklist を埋め込み、実装担当が `[ ]` → `[x]` と flip する
5. テスト出力は `npm run test:capture > .vitest-out.txt` で 1 回取得し、tail/grep で読む（再実行禁止）

---

## テスト・ビルド

```bash
npm run build              # tsc
npm test                   # vitest
npm run test:capture > .vitest-out.txt   # 出力を1回キャプチャ
```

---

## ユーザー環境

- Windows 11、VS Build Tools インストール済み
- 日本語コミュニケーション
- プラン目視確認派（ExitPlanMode 前にドキュメント表示を必須とする）
- Dock 小窓化の好み: 480x360 / bottom-right

---

## 参照先

- メモリ索引: `C:\Users\harus\.claude\projects\D--git-desktop-touch-mcp\memory\MEMORY.md`
- リリース手順: `docs/release-process.md`（リリース時は必ず full read）
- システム詳細: `docs/system-overview.md`
- GitHub: https://github.com/Harusame64/desktop-touch-mcp
