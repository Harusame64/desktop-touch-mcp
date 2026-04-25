# Docs Guide

このディレクトリは「いま参照する文書」を上位に残し、完了済みの計画書や作業メモは `archive/` に移す方針で整理しています。

## まず読む文書

- [release-process.md](D:/git/desktop-touch-mcp/docs/release-process.md): リリース手順の正本
- [todo-index.md](D:/git/desktop-touch-mcp/docs/todo-index.md): 今やること / 保留 / やらない方針の集約
- [system-overview.md](D:/git/desktop-touch-mcp/docs/system-overview.md): 全体アーキテクチャと tool surface
- [tool-descriptions.md](D:/git/desktop-touch-mcp/docs/tool-descriptions.md): ツール一覧の短い索引
- [competitor-research.md](D:/git/desktop-touch-mcp/docs/competitor-research.md): 競合比較と方向性

## 現在も追うべき文書

- [Anti-Fukuwarai-V2.md](D:/git/desktop-touch-mcp/docs/Anti-Fukuwarai-V2.md): v2 の全体像
- [anti-fukuwarai-v2-hardening-backlog.md](D:/git/desktop-touch-mcp/docs/anti-fukuwarai-v2-hardening-backlog.md): post-Go hardening の残課題
- [anti-fukuwarai-v2-default-on-readiness.md](D:/git/desktop-touch-mcp/docs/anti-fukuwarai-v2-default-on-readiness.md): default-on 判断の状態
- [visual-gpu-backend-adr-v2.md](D:/git/desktop-touch-mcp/docs/visual-gpu-backend-adr-v2.md): visual GPU の現行 ADR
- [adr-006-winml-rust-binding.md](D:/git/desktop-touch-mcp/docs/adr-006-winml-rust-binding.md): WinML 方針の ADR
- [ocr-quality-improvement-plan.md](D:/git/desktop-touch-mcp/docs/ocr-quality-improvement-plan.md): OCR 品質改善の実装と未検証項目
- [v2-main-migration-checklist.md](D:/git/desktop-touch-mcp/docs/v2-main-migration-checklist.md): `main` へ戻す判断用チェックリスト
- [release-automation-plan.md](D:/git/desktop-touch-mcp/docs/release-automation-plan.md): release 自動化の残タスク
- [tool-surface-reduction-plan.md](D:/git/desktop-touch-mcp/docs/tool-surface-reduction-plan.md): tool surface 再編の親計画
- [tool-surface-phase1-naming-design.md](D:/git/desktop-touch-mcp/docs/tool-surface-phase1-naming-design.md): naming と surface 変更の具体設計

## いま見えている未完了事項

- `tool surface` 再編はまだ未完了です。`DESKTOP_TOUCH_TOOL_SURFACE` の実装痕跡が現行コードに見当たらず、[v2-main-migration-checklist.md](D:/git/desktop-touch-mcp/docs/v2-main-migration-checklist.md) の Gate A は未達です。
- OCR 品質改善はコード実装自体は入っていますが、golden fixture と実機 dogfood の確認が未完です。[ocr-quality-improvement-plan.md](D:/git/desktop-touch-mcp/docs/ocr-quality-improvement-plan.md) の未チェック項目がそれです。
- Visual GPU は 4b 実装メモ上はかなり進んでいますが、実機ベンチ結果の公開 artifact 化と複数環境検証がまだ残っています。[visual-gpu-backend-adr-v2.md](D:/git/desktop-touch-mcp/docs/visual-gpu-backend-adr-v2.md) の Done criteria を先に見るのが安全です。
- Anti-Fukuwarai v2 hardening は H1-H4 のコードが既に入っている一方、backlog 文書の完了反映が追いついていません。いま本当に残っていそうなのは H5-H7 側です。
- release 自動化は workflow と `update-sha.mjs` までは入っています。今後忘れやすいのは「Trusted Publisher 設定」「MCP Registry publish」「スモークテスト」です。

## ルートに残しているが歴史文書寄りのもの

- `phase4b-*.md`: 実装 batch ごとの詳細設計。ADR から深く参照しているため、いったんルートに残しています。
- `anti-fukuwarai-v2-*instructions.md` / `*-review.md` / `*-memo.md`: 参照の鎖がまだ強く、まとめて移すとリンク修正が大きくなるため後回しにしています。
- `rpg-phase5-6-*.md`: Reactive Perception Graph の実装レビュー資料。歴史文書寄りですが、現行の perception 実装を追うときにまだ参照価値があります。

## アーカイブ方針

- 完了済みで再編集しない計画書は `archive/completed-plans/`
- ローカルバックアップや一時退避は `archive/backups/`
- ルートに置くのは「現行仕様」「運用手順」「まだ閉じていない計画」に限定

詳細は [archive/README.md](D:/git/desktop-touch-mcp/docs/archive/README.md) を参照してください。
