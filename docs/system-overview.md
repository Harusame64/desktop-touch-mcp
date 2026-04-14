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
    │   ├── uia-bridge.ts   — Windows UI Automation (PowerShell経由): 要素ツリー・クリック・値設定・getFocusedElement・ElementFromPoint
    │   ├── uia-diff.ts     — UIA スナップショット差分算出 (appeared/disappeared/valueDeltas)
    │   ├── image.ts        — 画像エンコード (sharp): PNG / WebP 1:1 / クロップ
    │   ├── layer-buffer.ts — ウィンドウレイヤーバッファ: フレーム差分検出 (MPEG P-frame方式)
    │   ├── cdp-bridge.ts   — Chrome DevTools Protocol: WebSocket セッション・DOM座標変換
    │   ├── window-cache.ts — ウィンドウ位置キャッシュ: ホーミング補正用 (dx,dy 差分計算)
    │   └── poll.ts         — pollUntil 共通ポーリングユーティリティ
    └── Layer 2: 45 MCP ツール
        screenshot(4) + window(3) + mouse(5) + keyboard(2) + ui_elements(4) +
        browser_cdp(10) + workspace(2) + pin(2) + dock(1) + macro(1) +
        scroll_capture(1) + context(3) + terminal(2) + events(4) + wait_until(1)
```

---

## アクション応答の共通構造（post ブロック）

すべてのアクションツール（mouse_click / keyboard_press / click_element 等）は成功時に `post` ブロックを返す。

```json
{
  "ok": true,
  "post": {
    "focusedWindow": "メモ帳",
    "focusedElement": { "name": "テキスト エディター", "type": "Document", "value": "Hello" },
    "windowChanged": false,
    "elapsedMs": 42,
    "rich": {
      "diffSource": "uia",
      "appeared":  [{ "name": "保存ダイアログ", "type": "Dialog" }],
      "disappeared": [],
      "valueDeltas": [{ "name": "ファイル名", "before": "", "after": "memo.txt" }]
    }
  }
}
```

| フィールド | 説明 |
|---|---|
| `focusedWindow` | アクション後のフォアグラウンドウィンドウタイトル |
| `focusedElement` | UIA フォーカス要素（名前・コントロール種別・値）。UIA 未対応時は null |
| `windowChanged` | アクション前後でフォーカスウィンドウが変わったか |
| `elapsedMs` | アクション実行時間 (ms) |
| `rich` | **opt-in** — `narrate:"rich"` 指定時のみ付与される UIA diff ブロック |

### narrate パラメータ

マウス・キーボード・UI 要素操作ツールは `narrate` パラメータを持つ。

| 値 | 動作 |
|---|---|
| `"minimal"` (デフォルト) | post ブロックのみ（追加コストなし） |
| `"rich"` | アクション前後の UIA スナップショットを差分計算して `post.rich` に付与。確認スクリーンショット不要になる |

`keyboard_press` では Enter/Tab/Esc/F5 等の「状態遷移キー」のみ rich が有効。単一文字キーは自動で minimal にダウングレード。

---

## ツール一覧

### 📸 スクリーンショット系

#### `screenshot`
最も重要なツール。3つのモードを持つ。

| パラメータ | 説明 |
|---|---|
| `windowTitle` | ウィンドウを名前で絞り込み |
| `displayId` | モニター指定 |
| `region` | 画面上の矩形領域（`windowTitle` 併用時はウィンドウ内相対座標 = ブラウザクロム除外に便利） |
| `maxDimension` | スケーリング上限 (デフォルト768px, PNG モード) |
| `dotByDot` | **1:1ピクセルモード** — WebP, 座標変換不要 |
| `dotByDotMaxDimension` | **dotByDot 時の最大辺 cap** — 指定すると response に `scale` が入り `screen_x = origin_x + image_x / scale` で逆算 |
| `grayscale` | グレースケール化で画像サイズ ~50% 削減（テキスト主体のキャプチャ向け） |
| `webpQuality` | WebP 品質 1-100 (デフォルト60) |
| `diffMode` | **レイヤー差分モード** — 変化したウィンドウのみ返す |
| `detail` | `"image"` / `"text"` / `"meta"` |
| `ocrFallback` | `"auto"`（既定: UIA sparse/空・Chromium 時に OCR）/ `"always"` / `"never"` |

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

#### `screenshot_ocr`
Windows OCR (Windows.Media.Ocr) で単語レベルのテキストと画面座標を返す。UIA が sparse なアプリへのフォールバック。

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

#### `dock_window`
任意のウィンドウを画面コーナーに小さく配置しつつ常時最前面化。Claude CLI を操作中も視界に残したい用途。
```
dock_window({title:'Claude Code', corner:'bottom-right', width:480, height:360, pin:true})
```
パラメータ: `corner`（top-left / top-right / bottom-left / bottom-right）, `width` / `height`, `pin`, `monitorId`, `margin`。最小化・最大化されたウィンドウは自動的に復元されてからドック。

**環境変数による MCP 起動時自動ドック:**

| 環境変数 | 説明 |
|---|---|
| `DESKTOP_TOUCH_DOCK_TITLE` | 必須（無効化したい時は未設定）。`"@parent"` 指定で MCP プロセスの親ツリーを walk してターミナルウィンドウを自動検出（タイトル依存無し、推奨） |
| `DESKTOP_TOUCH_DOCK_CORNER` | 既定 `bottom-right` |
| `DESKTOP_TOUCH_DOCK_WIDTH` / `HEIGHT` | `"480"`（px）または `"25%"`（workArea 比率）。4K/8K 自動追従 |
| `DESKTOP_TOUCH_DOCK_PIN` | 既定 `true` |
| `DESKTOP_TOUCH_DOCK_MONITOR` | モニター id（既定プライマリ） |
| `DESKTOP_TOUCH_DOCK_SCALE_DPI` | `true` で px 値を dpi/96 倍（opt-in） |

---

### 🖱️ マウス操作

全マウスツールは `speed` に加え `homing` / `windowTitle` / `elementName` / `elementId` パラメータを持つ。アクション後は `post` ブロックを返す（`narrate:"rich"` で UIA diff 付与可）。

#### `mouse_move`
カーソル移動。

#### `mouse_click`
クリック (`left` / `right` / `middle`)。`doubleClick=true` でダブルクリック。

**ホーミング補正（トラクションコントロール）:**  
スクリーンショット取得→クリック実行の間にウィンドウが移動・裏に隠れる問題を自動補正。

| Tier | トリガー | レイテンシ | 効果 |
|------|---------|-----------|------|
| 1 | 常時（cache あれば） | <1ms | GetWindowRect で差分計算 → (dx,dy) 補正 |
| 2 | `windowTitle` 指定 | ~100ms | 裏に隠れたウィンドウを `restoreAndFocusWindow` |
| 3 | `elementName/Id` + `windowTitle` + リサイズ検出 | 1-3s | UIA `getElementBounds` で最新座標を再クエリ |

```
mouse_click(x, y, windowTitle="メモ帳")           # Tier 1 + 2
mouse_click(x, y, homing=false)                   # 補正 OFF
```

キャッシュは `screenshot` / `get_windows` / `focus_window` / `workspace_snapshot` で自動更新。  
60 秒 TTL で HWND 再利用による誤補正を防止。

#### `mouse_drag`
ドラッグ (startX,startY) → (endX,endY)。ホーミング補正適用時は終点にも同じ delta を適用。

#### `scroll`
スクロール。`direction`: `up` / `down` / `left` / `right`。`amount` はステップ数。
内部で ×3 の乗算を適用（nut-js の1ステップが極小なため）。

#### `get_cursor_position`
現在のカーソル座標。

---

### ⌨️ キーボード操作

アクション後は `post` ブロックを返す（`narrate:"rich"` で状態遷移キーに限り UIA diff 付与可）。

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

> **⚠️ 入力ルーティング注意（dock_window pin 時）**
> `keyboard_type` / `keyboard_press` は**現在フォーカスがあるウィンドウ**にキー入力を送る。`dock_window(pin=true)` で Claude CLI が常時最前面化されていると、キー入力が CLI に奪われて目的アプリに届かない。
> **必ず `focus_window(title=...)` を呼んでから**キー操作し、`screenshot(detail='meta')` で `isActive=true` を確認すること。推奨パターン：`focus_window → keyboard_press/type → screenshot(diffMode=true)`。

---

### 🔍 UI Automation (UIA)

アクション系ツール（`click_element` / `set_element_value`）はアクション後に `post` ブロックを返す（`narrate:"rich"` で UIA diff 付与可）。

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

### 📊 コンテキスト・履歴

#### `get_context`
OS + アプリレベルの軽量コンテキスト取得。スクリーンショット不要で現状把握できる。

```json
{
  "focusedWindow": "メモ帳 — 無題",
  "focusedElement": { "name": "テキスト エディター", "type": "Document", "value": "Hello" },
  "cursorPos": {"x": 523, "y": 401},
  "cursorOverElement": { "name": "テキスト エディター", "type": "Document" },
  "windows": [...]
}
```

| フィールド | 説明 |
|---|---|
| `focusedElement` | UIA `GetFocusedElement` — 入力フォーカスのある要素（名前・型・値） |
| `cursorOverElement` | UIA `ElementFromPoint` — カーソル直下の UIA 要素 |
| `windows` | Z-order 付きウィンドウ一覧（`get_windows` 相当） |

Chromium ウィンドウでは UIA がスパースなため `focusedElement`/`cursorOverElement` は null になることがある（CDP ツールを使うこと）。

#### `get_history`
直近 n 件（デフォルト5、最大20）のアクション結果サマリを返す。

```json
[
  { "tool": "mouse_click", "ok": true,
    "post": { "focusedWindow": "メモ帳", "windowChanged": false, "elapsedMs": 35 },
    "tsMs": 1744600000000 }
]
```

ループや繰り返し操作で「直前に何をしたか」を確認するのに使用。`post.rich` はリングバッファには保存されない（サイズ節約）。

#### `get_document_state`
アクティブタブの CDP 状態取得（Chrome/Edge のみ）。

```json
{
  "title": "Google",
  "url": "https://www.google.com/",
  "readyState": "complete",
  "activeTab": { "id": "abc123", "port": 9222 }
}
```

---

### ⏱️ wait_until

#### `wait_until`
指定条件が満たされるまでサーバー側でポーリング。ラウンドトリップなしで待機できる。

```
wait_until(condition="window_appears",   target={windowTitle:"保存完了"}, timeoutMs=10000)
wait_until(condition="window_disappears", target={windowTitle:"読み込み中..."})
wait_until(condition="element_appears",  target={windowTitle:"メモ帳", elementName:"保存"})
wait_until(condition="focus_changes",    target={windowTitle:"メモ帳"})
wait_until(condition="value_matches",    target={windowTitle:"メモ帳", elementName:"ファイル名", pattern:"memo"})
wait_until(condition="page_ready",       target={windowTitle:"Chrome"})
wait_until(condition="terminal_output_contains", target={windowTitle:"PowerShell", pattern:"Done"})
wait_until(condition="element_matches",  target={windowTitle:"メモ帳", selector:"#status", pattern:"ready"})
```

| パラメータ | 説明 |
|---|---|
| `condition` | 待機条件（上記一覧） |
| `target` | 条件に応じた対象（`windowTitle` / `elementName` / `pattern` 等） |
| `timeoutMs` | タイムアウト (デフォルト 10000ms) |
| `pollMs` | ポーリング間隔 (デフォルト 500ms) |

---

### 🖥️ ターミナル操作

#### `terminal_read`
PowerShell / cmd / Windows Terminal の現在バッファを取得。TextPattern (UIA) または OCR で内容を読む。

```json
{
  "text": "PS C:\\> echo hello\nhello\nPS C:\\> ",
  "source": "uia"
}
```

#### `terminal_send`
ターミナルにコマンドを送信（SendKeys 経由）。`waitForPrompt` で次のプロンプト出現まで待機可。

---

### 📡 非同期イベント

#### `events_subscribe`
ウィンドウ変化・フォーカス変化・ブラウザナビゲーション等を購読。`subscriptionId` を返す。

#### `events_poll`
購読イベントのキューをドレイン（最大 `maxEvents` 件）。ロングポーリング相当。

#### `events_unsubscribe`
購読を解除。

#### `events_list`
アクティブな購読一覧。

**イベント種別:** `window_appeared` / `window_disappeared` / `window_moved` / `focus_changed` / `browser_navigated`

---

### 🌐 ブラウザ CDP (Chrome/Edge)

Chrome/Edge を `--remote-debugging-port=9222` で起動することで利用可能。

```bash
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\tmp\cdp
```

#### `browser_launch`
指定ポートで Chrome/Edge を起動し CDP 接続まで待機。`url` で初期ページ指定可。

#### `browser_connect`
CDP に接続してタブ一覧を返す。返却される `tabId` を他の browser_* ツールに渡して対象タブを指定できる。

#### `browser_find_element`
CSS セレクター → 物理ピクセル座標。  
座標変換式: `physX = (screenX + chromeW/2 + rect.left) * dpr`  
ブラウザ UI（タブストリップ + アドレスバー）の高さと `devicePixelRatio` を考慮済み。  
`inViewport` は要素中心点ベースの判定（エッジが 1px はみ出しても false にならない）。

#### `browser_click_element`
`getElementScreenCoords` + `ensureBrowserFocused` + nut-js click を1ステップで実行。  
`inViewport=false` の場合は scrollIntoView を促すメッセージを返して終了。

#### `browser_eval`
`Runtime.evaluate` (CDP) で JS 式を評価。`awaitPromise=true` で async 対応。  
エラー時は `exceptionDetails` を解析して `JS exception in tab: ...` をスロー。

#### `browser_get_dom`
要素または `document.body` の outerHTML を返す。`maxLength` で切り詰め。  
要素不在は structured error `{"__cdpError":"..."}` で区別。

#### `browser_get_interactive`
ページのインタラクティブ要素一覧（入力・ボタン・リンク等）と `clickAt` 座標を返す。UIA の `screenshot(detail="text")` のブラウザ版。

#### `browser_navigate`
`Page.navigate` (CDP) で URL 遷移。`http://` / `https://` のみ許可 (javascript: / file: は拒否)。`waitForLoad` で `domContentEventFired` まで待機可。

#### `browser_search`
ページ内テキスト・CSS セレクター・XPath で要素を検索。`by: "text" | "css" | "xpath"`。

#### `browser_disconnect`
ポートに紐づく全 WebSocket セッションをクローズ。HWND close 前に呼ぶことを推奨。

**セッション管理:**  
`sessions: Map<"port:tabId", CdpSession>` でキャッシュ。  
`connecting: Map` でコンカレントな同一タブへの接続をデデュープ。  
エラー・クローズ時は `_closed=true` にセットして新規コマンドをブロック。

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
| CDP コマンドタイムアウト | 15s (CMD_TIMEOUT_MS) — WebSocket 接続は 5s (CONNECT_TIMEOUT_MS) |
| CDP fetch タイムアウト | `AbortSignal.timeout(5s)` — /json エンドポイントが応答しない場合 |
| window-cache TTL | 60秒 — HWND 再利用による誤補正を防ぐため古いエントリを無視 |
| ホーミング Tier 3 閾値 | delta > 200px または sizeChanged=true のときのみ UIA 再クエリ発動 |
| post.focusedElement タイムアウト | 800ms — UIA 未対応アプリで応答しない場合の上限 |
| UIA diff キャップ | appeared/disappeared 各5件・valueDeltas 3件 — 超過分は `truncated` フィールドに件数 |
| narrate:"rich" settle 待機 | アクション後 120ms 待機してから after-snapshot 取得 |
| --disable-extensions 除外 | Chrome 147+ でこのフラグが CDP ポートバインドを阻害するため E2E テストから除外 |

---

## 登録設定

`~/.claude.json` の `mcpServers` に `desktop-touch` として stdio 登録済み。
Claude CLI 起動時に自動起動・終了。

ビルド: `cd D:\git\desktop-touch-mcp && npm run build`
