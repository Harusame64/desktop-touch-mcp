# desktop-touch-mcp システム概要

Claude CLI からデスクトップアプリを自由に操作する MCP (Model Context Protocol) サーバー。

---

## アーキテクチャ

```
Claude CLI
    │  stdio (MCP protocol)
    ▼
desktop-touch-mcp (Node.js / TypeScript)
    ├── Layer 1: Engine
    │   ├── nutjs.js        — マウス・キーボード・画面キャプチャ (nut-js)
    │   ├── win32.ts        — Win32 API (koffi): ウィンドウ列挙・DPI・PrintWindow・SetWindowPos
    │   ├── uia-bridge.ts   — Windows UI Automation (PowerShell経由): 要素ツリー・クリック・値設定
    │   ├── image.ts        — 画像エンコード (sharp): PNG / WebP 1:1 / クロップ
    │   └── layer-buffer.ts — ウィンドウレイヤーバッファ: フレーム差分検出 (MPEG P-frame方式)
    └── Layer 2: 25 MCP ツール
        screenshot(5) + window(3) + mouse(5) + keyboard(2) + ui_elements(4) + workspace(2) + pin(2) + macro(1) + scroll_capture(1)
```

---

## ツール一覧

### 📸 スクリーンショット系

#### `screenshot`
最も重要なツール。3つのモードを持つ。

| パラメータ | 説明 |
|---|---|
| `windowTitle` | ウィンドウを名前で絞り込み |
| `displayId` | モニター指定 |
| `region` | 画面上の矩形領域 |
| `maxDimension` | スケーリング上限 (デフォルト768px, PNG モード) |
| `dotByDot` | **1:1ピクセルモード** — WebP, 座標変換不要 |
| `webpQuality` | WebP 品質 1-100 (デフォルト60) |
| `diffMode` | **レイヤー差分モード** — 変化したウィンドウのみ返す |
| `detail` | `"image"` / `"text"` / `"meta"` |

**`detail` の選択指針:**

```
detail="image"  (デフォルト) — ピクセル画像。視覚確認が必要な時
detail="text"   — UIA要素ツリーJSON。ボタン名・入力欄の確認・操作
detail="meta"   — タイトル+座標のみ。ウィンドウ配置確認
```

**座標モードの違い:**

| モード | トークン | 座標計算 |
|---|---|---|
| デフォルト (768px PNG) | ~443 | `screen = window_origin + img_px / scale` |
| `dotByDot=true` (WebP) | ~800-2765 | `screen = origin + img_px` (変換不要) |
| `diffMode=true` | ~160 (差分のみ) | 変化したウィンドウのみ送信 |
| `detail="text"` | ~100-300 | 座標は `clickAt` として直接提供 |

**推奨ワークフロー:**
```
# 操作開始: 全体把握
workspace_snapshot()                    → I-frame + 全ウィンドウの actionable 要素

# 効率的な操作ループ
screenshot(detail="text", windowTitle=X) → actionable[].clickAt で直接クリック可能
mouse_click(clickAt.x, clickAt.y)
screenshot(diffMode=true)               → 変化したウィンドウのみ確認 (~160 tok)

# 精密確認が必要な時だけ画像
screenshot(dotByDot=true, windowTitle=X) → 1:1 WebP, 座標変換不要
```

#### `screenshot_background`
ウィンドウが背後にあっても捕捉 (PrintWindow API)。
- `dotByDot=true` で 1:1 WebP 出力可
- GPU レンダリングアプリ (Chrome/WinUI3) では黒画像になる既知制限あり

#### `get_screen_info`
全モニターの解像度・位置・DPI・カーソル位置。

---

### 🖥️ ウィンドウ管理

#### `get_windows`
全ウィンドウをZ-order順で一覧。
```json
{ "zOrder": 0, "title": "メモ帳", "region": {"x":78,"y":78,"w":976,"h":618},
  "isActive": true, "isMinimized": false, "isOnCurrentDesktop": true }
```

#### `get_active_window`
現在フォーカスのあるウィンドウの情報。

#### `focus_window`
タイトルの部分一致でウィンドウをフォアグラウンドに。
```
focus_window(title="メモ帳")
```

#### `pin_window` / `unpin_window`
ウィンドウを常に最前面に固定 / 解除。
- `duration_ms` で自動解除タイマー指定可

---

### 🖱️ マウス操作

#### `mouse_move`
カーソル移動。

#### `mouse_click`
クリック (`left` / `right` / `middle`)。`doubleClick=true` でダブルクリック。

#### `mouse_drag`
ドラッグ (startX,startY) → (endX,endY)。

#### `scroll`
スクロール。`direction`: `up` / `down` / `left` / `right`。`amount` はステップ数。
内部で ×3 の乗算を適用（nut-js の1ステップが極小なため）。

#### `get_cursor_position`
現在のカーソル座標。

---

### ⌨️ キーボード操作

#### `keyboard_type`
テキスト入力。
- `use_clipboard=true` で PowerShell 経由クリップボード入力 → **IME バイパス**
  - URL・パス・ASCII を日本語 IME 環境で入力する際は必須

#### `keyboard_press`
キー入力。修飾キー組み合わせ対応。
```
keyboard_press(keys="ctrl+c")
keyboard_press(keys="alt+f4")
keyboard_press(keys="ctrl+shift+s")
```

---

### 🔍 UI Automation (UIA)

#### `screenshot(detail="text")` ← 推奨
アクション指向の要素抽出。各要素に `clickAt` 座標付き。

```json
{
  "window": "メモ帳",
  "actionable": [
    { "action": "click", "name": "設定", "type": "Button",
      "clickAt": {"x": 1025, "y": 136}, "id": "SettingsButton" },
    { "action": "type", "name": "テキスト エディター", "type": "Document",
      "clickAt": {"x": 566, "y": 405}, "value": "現在のテキスト..." }
  ],
  "texts": [
    { "content": "行 1, 列 1", "at": {"x": 100, "y": 666} }
  ]
}
```

#### `get_ui_elements`
生の UIA ツリー全体。`automationId` 等を探す時に使用。

#### `click_element`
UIA の InvokePattern で名前/ID でボタンをクリック。座標不要。
```
click_element(windowTitle="メモ帳", name="設定", controlType="Button")
```

#### `set_element_value`
UIA の ValuePattern でテキストフィールドに直接値をセット。
```
set_element_value(windowTitle="メモ帳", name="テキスト エディター", value="Hello!")
```

#### `scope_element`
特定要素を高解像度 (1280px) でズームキャプチャ + 子要素ツリー。

---

### 🚀 ワークスペース

#### `workspace_snapshot`
デスクトップ全体を1回のコールで把握。
- 全ウィンドウのサムネイル (WebP)
- `uiSummary.actionable` — 各ウィンドウのインタラクティブ要素 + `clickAt` 座標
- レイヤーバッファをリセット → 以降の `screenshot(diffMode=true)` の I-frame になる

```json
{
  "windows": [{
    "title": "メモ帳",
    "region": {"x":78,"y":78,"width":976,"height":618},
    "uiSummary": {
      "actionable": [
        { "action": "click", "name": "設定", "clickAt": {"x":1025,"y":136} },
        { "action": "type",  "name": "テキスト エディター", "clickAt": {"x":566,"y":405}, "value": "..." }
      ],
      "texts": [{ "content": "UTF-8", "at": {"x":913,"y":666} }]
    }
  }]
}
```

#### `workspace_launch`
アプリ起動 + 新ウィンドウ自動検出 (起動前後の差分で判定 → 日本語タイトルのUWPアプリ対応)。

---

### 📜 マクロ・スクロール

#### `run_macro`
複数ツールをシーケンシャルに実行。最大50ステップ。
`sleep` 疑似コマンドで待機 (最大10000ms)。再帰禁止。

```json
{
  "steps": [
    { "tool": "focus_window",    "params": {"title": "メモ帳"} },
    { "tool": "sleep",           "params": {"ms": 300} },
    { "tool": "keyboard_type",   "params": {"text": "Hello!", "use_clipboard": true} },
    { "tool": "screenshot",      "params": {"windowTitle": "メモ帳", "detail": "text"} }
  ]
}
```

#### `scroll_capture`
ページを上から下までスクロールしながら全体をスティッチ。
長いWebページやドキュメントの全体確認に使用。

---

## レイヤーバッファの仕組み (MPEG P-frame 方式)

```
workspace_snapshot()
    │  → 全ウィンドウをキャプチャ & バッファに格納 (I-frame)
    │
操作 (click, type, ...)
    │
screenshot(diffMode=true)
    │  → 各ウィンドウを再キャプチャ
    │  → 8x8ブロック単位でピクセル比較 (ノイズ閾値=16)
    │  → 変化率 < 2%: unchanged (画像なし)
    │  → 変化率 2-100%: content_changed (そのウィンドウのみ送信)
    │  → 位置変化: moved (画像なし、座標のみ)
    │  → 新規: new (キャプチャして送信)
    └  → 閉じた: closed (通知のみ)
```

**効果:** 1クリック後の確認が ~443 tok (通常) → ~160 tok (差分) に削減。

---

## 技術ノート

| 項目 | 内容 |
|---|---|
| ウィンドウタイトル取得 | `GetWindowTextW` (koffi) — nut-js は CJK 文字化けするため |
| スクロール量 | nut-js 1ステップは極小 → 内部で `× SCROLL_MULTIPLIER=3` |
| UIA タイムアウト | workspace_snapshot 内は 2s (通常 8s) |
| PrintWindow フラグ | `0` — GPU/DX ウィンドウは黒になる既知制限 |
| WebP デフォルト品質 | `60` — テキストが読める最低品質 |
| レイヤーバッファ TTL | 90秒で自動クリア |
| focus_window フィルタ | width < 50 または height < 50 の補助窓はスキップ |
| UIA 要素検索 | 再帰 `FindAll(Children)` — `FindAll(Descendants)` は WinUI3 で一部漏れ |

---

## 登録設定

`~/.claude.json` の `mcpServers` に `desktop-touch` として stdio 登録済み。
Claude CLI 起動時に自動起動・終了。

ビルド: `cd D:\git\desktop-touch-mcp && npm run build`
