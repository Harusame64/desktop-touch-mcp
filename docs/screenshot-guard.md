# screenshot-guard: `detail='image'` サーバー側ブロック

## 目的

`screenshot(detail='image')` の無意識な呼び出しによる大きな画像ペイロードとトークン消費を構造的に防ぐ。  
instructions の "avoid unless necessary" という弱い表現ではなく、サーバー側でブロックすることで強制力を持たせる。

## 動作

| 呼び出し | 結果 |
|---|---|
| `screenshot()` | `meta`（デフォルト変更済み）— window 一覧 JSON |
| `screenshot(detail='text', windowTitle=X)` | UIA actionable[] + clickAt 座標 |
| `screenshot(diffMode=true)` | 差分フレーム（変更ウィンドウのみ） |
| `screenshot(dotByDot=true, windowTitle=X)` | 1:1 WebP（ブロックなし） |
| `screenshot(detail='image')` | **isError: true** + ガードメッセージ |
| `screenshot(detail='image', confirmImage=true)` | 通常の画像レスポンス |

## ガードメッセージ

```
[screenshot-guard] detail='image' was blocked to prevent accidental heavy image payloads.

Prefer these lighter alternatives (in order):
  1. screenshot(detail='text', windowTitle=X)  — UIA actionable[] with clickAt coords
  2. screenshot(diffMode=true)                 — only changed windows as image
  3. screenshot(dotByDot=true, windowTitle=X)  — 1:1 WebP for pixel-perfect coords

If an image truly is required, re-call with confirmImage=true (and prefer windowTitle).
To disable this guard globally, set DESKTOP_TOUCH_DISABLE_IMAGE_GUARD=1 in the environment.
```

## 全体無効化

環境変数 `DESKTOP_TOUCH_DISABLE_IMAGE_GUARD=1` をセットして MCP サーバーを起動すると、ガードが完全に OFF になる（デバッグ用途）。

## 実装箇所

- `src/tools/screenshot.ts` — `screenshotSchema` に `confirmImage` フィールド追加、`detail` デフォルトを `'meta'` に変更、ハンドラ先頭にガード節挿入
- `src/index.ts` — instructions の "Data retrieval priority" 節を "Screenshot rules (mandatory)" に書き換え

## カバー範囲

- 直接 MCP 呼び出し: ✅ ガードあり
- `run_macro` 経由: ✅ `screenshotHandler` を再利用しているため自動カバー
- `screenshot_background`: 対象外（明示的な背景キャプチャ専用ツール）
- `dotByDot=true` / `diffMode=true`: 対象外（instructions 推奨の軽量経路）
