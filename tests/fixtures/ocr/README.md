# OCR Golden Fixtures

## 目的

OCR 品質改善（フェーズ 1・フェーズ 2）の進捗を定量的に計測するための golden fixture。
`tests/integration/ocr-golden.test.ts` が参照する。

## ファイル構成

| ファイル | 内容 |
|---|---|
| `outlook-toolbar.png` | Outlook PWA をキャプチャした preprocess 前の PNG（グレースケール・normalize 済み） |
| `expected.json` | `known_correct`（正しく認識されるべき語）と `known_broken`（現状の誤認識例） |

## Fixture の再収集手順

Outlook PWA が起動・表示されている状態で以下を実行する：

```bash
UPDATE_FIXTURES=1 RUN_OCR_GOLDEN=1 npx vitest run --project integration
```

これにより：
- `outlook-toolbar.png` が Outlook PWA の現在画面でキャプチャされ上書きされる
- `expected.json` の `generatedAt` と `known_broken` が現在の OCR 出力で更新される

## Fixture の注意点

- `outlook-toolbar.png` は Outlook のメール一覧画面を対象とする。メールの内容は随時変わるが OCR 品質テストはツールバー・フォルダ名などの**固定 UI 要素**に着目するため問題ない
- `known_correct` に列挙した語は、実際の Outlook UI に存在し続ける語のみを残すこと
- fixture を差し替えた場合は `expected.json` の `known_broken` も同時に更新する（`UPDATE_FIXTURES=1` で自動更新される）
