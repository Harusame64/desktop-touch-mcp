# Evaluation Assets

このディレクトリは、GitHub Pages に載せる評価データの置き場です。

## Purpose

- raw な実験結果を Pages 向けに整理する
- 表やグラフの元データを JSON / CSV で持つ
- 後から結果を差し替えやすくする

## Planned files

- `result-schema.json`
  - 単一 run の最小 schema
- `raw/*.json`
  - 個別シナリオの出力
- `summary/*.csv`
  - 集計結果
- `report/*.md`
  - 手書きコメント付きの短報

## Notes

- 最初は schema だけ置く
- 結果が出始めたら `raw/` と `summary/` を増やす
- Pages 側では raw を直接見せず、要約だけを表示する

