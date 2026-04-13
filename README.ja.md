# desktop-touch-mcp

[English](README.md)

[Glamaリンク](https://glama.ai/mcp/servers/Harusame64/desktop-touch-mcp)

> **「Claude CLI にスクショを毎回コピーしていたあなたへ。」**

Claude がデスクトップを直接見て、直接操作する。  
マウス・キーボード・スクリーンショット・Windows UI Automation・ブラウザ CDP を統合した 32 のツールを提供する MCP サーバーです。

> *ウィンドウキャプチャに MPEG P フレーム方式の差分処理を適用。初回フレーム以降は変化したウィンドウのみを送信するため、一般的な自動化ループでトークン使用量を約 60〜80% 削減できます。*

---

## 特徴

- **LLM ネイティブ設計** — 人間の操作を模倣するのではなく、「LLM がいかにコンテキストを消費せず高速に動けるか」を前提に設計。`run_macro` による複数操作の一括実行（API 往復の削減）と、**MPEG P-frame 方式のレイヤー差分** (`diffMode`) を組み合わせることで、無駄な画像転送や推論ループを極限まで削ぎ落とす。
- **日本語/CJK 完全対応** — ウィンドウタイトル取得に Win32 `GetWindowTextW` を使用。nut-js の文字化けを回避。IME バイパス入力にも対応。
- **3 段階トークン削減** — `detail="image"`（~443 tok）/ `detail="text"`（~100-300 tok）/ `diffMode=true`（~160 tok）を用途に応じて使い分け。視覚確認が必要な時だけ画像を送る。
- **座標変換不要の 1:1 モード** — `dotByDot=true` で WebP 1:1 キャプチャ。画像上のピクセル座標 = 画面座標なのでスケール計算が不要。
- **UIA アクション要素抽出** — `detail="text"` でボタン・入力欄の名前と `clickAt` 座標を JSON で返すため、画像を見なくても操作できる。
- **緊急停止 (Failsafe)** — マウスを**画面左上コーナー (0,0 付近 10px)** に移動すると MCP サーバーが即座に終了。

---

## 前提環境

| 項目 | 要件 |
|---|---|
| OS | Windows 10 / 11 (64-bit) |
| Node.js | v20 以上推奨 (v22+ で動作確認済み) |
| PowerShell | 5.1 以上 (Windows 標準同梱) |
| Claude CLI | `claude` コマンドが使えること |

> **注意:** nut-js のネイティブバインディングは Visual C++ 再頒布可能パッケージを必要とします。  
> インストール済みでない場合は [Microsoft公式](https://learn.microsoft.com/ja-jp/cpp/windows/latest-supported-vc-redist) からダウンロードしてください。

---

## インストール

```bash
git clone https://github.com/Harusame64/desktop-touch-mcp.git
cd desktop-touch-mcp
npm install
npm run build
```

### Claude CLI への登録

`~/.claude.json` の `mcpServers` に追加：

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/path/to/desktop-touch-mcp/dist/index.js"]
    }
  }
}
```

> **注意:** `D:/path/to/desktop-touch-mcp` の部分は、このリポジトリをクローンした実際のパスに変更してください。

---

## ツール一覧 (32 ツール)

### スクリーンショット系 (4)
| ツール | 概要 |
|---|---|
| `screenshot` | メインキャプチャ。`detail` / `dotByDot` / `diffMode` 対応 |
| `screenshot_background` | 背面ウィンドウをキャプチャ (PrintWindow API) |
| `get_screen_info` | モニター解像度・DPI・カーソル位置 |
| `scroll_capture` | ページ全体をスクロールしながらスティッチ |

### ウィンドウ管理 (3)
| ツール | 概要 |
|---|---|
| `get_windows` | 全ウィンドウを Z-order 順で一覧 |
| `get_active_window` | フォーカス中ウィンドウの情報 |
| `focus_window` | タイトル部分一致でフォアグラウンドに |

### マウス操作 (5)
| ツール | 概要 |
|---|---|
| `mouse_move` / `mouse_click` / `mouse_drag` | 移動・クリック・ドラッグ。`speed` / `homing` パラメータ対応 |
| `scroll` | 上下左右スクロール。`speed` / `homing` パラメータ対応 |
| `get_cursor_position` | 現在カーソル座標 |

### キーボード操作 (2)
| ツール | 概要 |
|---|---|
| `keyboard_type` | テキスト入力 (`use_clipboard=true` で IME バイパス) |
| `keyboard_press` | キー入力・修飾キー組み合わせ |

### UI Automation (4)
| ツール | 概要 |
|---|---|
| `get_ui_elements` | UIA 要素ツリー取得 |
| `click_element` | 名前/ID でボタンをクリック (座標不要) |
| `set_element_value` | テキストフィールドに直接値をセット |
| `scope_element` | 要素を高解像度ズームキャプチャ + 子ツリー |

### ブラウザ CDP (7)
| ツール | 概要 |
|---|---|
| `browser_connect` | Chrome/Edge に CDP 接続してタブ一覧取得 |
| `browser_find_element` | CSS セレクター → 物理ピクセル座標 |
| `browser_click_element` | DOM 要素を検索してクリック（1ステップ） |
| `browser_eval` | ブラウザタブで JS 式を評価して結果を返す |
| `browser_get_dom` | 要素または body の outerHTML 取得 |
| `browser_navigate` | CDP 経由で URL 遷移（アドレスバー操作不要） |
| `browser_disconnect` | CDP WebSocket セッションをクリーンアップ |

### ワークスペース (2)
| ツール | 概要 |
|---|---|
| `workspace_snapshot` | 全ウィンドウをサムネイル + UI 要素サマリで一括取得 |
| `workspace_launch` | アプリ起動 + 新ウィンドウ自動検出 |

### ピン・マクロ (3)
| ツール | 概要 |
|---|---|
| `pin_window` / `unpin_window` | 最前面固定 / 解除 |
| `run_macro` | 最大 50 ステップを順次実行 |

---

## ブラウザ CDP 自動化

Chrome/Edge をリモートデバッグポート付きで起動するだけで、DOM 要素をピクセル精度でクリックできます。

```bash
# Chrome を CDP モードで起動
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\tmp\cdp
```

```
browser_connect()                        → タブ一覧 + tabId 取得
browser_find_element("#submit")          → CSS セレクター → 物理ピクセル座標
browser_click_element("#submit")         → 検索 + クリックを 1 ステップで
browser_eval("document.title")           → JS 評価して結果を返す
browser_get_dom("#main", maxLength=5000) → outerHTML を取得（文字数制限付き）
browser_navigate("https://example.com") → CDP 経由でページ遷移
browser_disconnect()                     → WebSocket セッションをクリーンアップ
```

`browser_find_element` が返す座標はブラウザUI（タブストリップ + アドレスバー）の高さと `devicePixelRatio` を考慮済みなので、`mouse_click` にそのまま渡せます。

**Web 操作の推奨フロー:**
```
browser_connect() → browser_get_dom() → browser_find_element(selector) → browser_click_element(selector)
```

---

## マウスホーミング補正（トラクションコントロール）

Claude が `screenshot(detail='text')` で座標を取得してから `mouse_click` を呼ぶまでの数秒間に、ウィンドウが移動・裏に隠れることがある「福笑い問題」を MCP サーバー側で自動補正します。

| Tier | 有効化方法 | レイテンシ | 効果 |
|------|-----------|-----------|------|
| 1 | 常時（cache あれば） | <1ms | ウィンドウ移動を (dx, dy) 補正 |
| 2 | `windowTitle` ヒントを指定 | ~100ms | 裏に隠れたウィンドウを自動前面化 |
| 3 | `elementName`/`elementId` + `windowTitle` | 1–3s | リサイズ時に UIA で最新座標を再クエリ |

```
# Tier 1 のみ（自動）
mouse_click(x=500, y=300)

# Tier 1 + 2: 裏に隠れていても前面化してクリック
mouse_click(x=500, y=300, windowTitle="メモ帳")

# Tier 1 + 2 + 3: リサイズ時も UIA で再クエリ
mouse_click(x=500, y=300, windowTitle="メモ帳", elementName="保存")

# トラクションコントロール OFF — 補正なし
mouse_click(x=500, y=300, homing=false)
```

`homing` パラメータは `mouse_click` / `mouse_move` / `mouse_drag` / `scroll` 全てで使えます。キャッシュは `screenshot()` / `get_windows()` / `focus_window()` / `workspace_snapshot()` 呼び出し時に自動更新されます。

---

## screenshot の主要パラメータ

```
detail="image"   — PNG/WebP 画像（デフォルト）
detail="text"    — UIA 要素 JSON + clickAt 座標（画像なし、~100-300 tok）
detail="meta"    — タイトル + 座標のみ（最軽量、~20 tok/窓）
dotByDot=true    — 1:1 WebP。image_px + origin = screen_px
diffMode=true    — 初回 I-frame、以降は変化した窓のみ P-frame（~160 tok）
```

**推奨ワークフロー:**
```
workspace_snapshot()                     → 全体把握（I-frame リセット）
screenshot(detail="text", windowTitle=X) → actionable[].clickAt でそのままクリック
mouse_click(x, y)
screenshot(diffMode=true)               → 変化した窓だけ確認（~160 tok）
```

---

## セキュリティ

### 緊急停止 (Failsafe)

**マウスを画面の左上コーナー (座標 0,0 付近 10px 以内) に素早く移動させると MCP サーバーが即座に停止します。**

- **ツール実行前チェック**: 各ツール呼び出しの開始時に毎回確認
- **バックグラウンド監視**: 500ms 間隔で常時監視（長時間処理中のバックアップ）
- コーナー判定範囲: 10px 以内

### ブロックされる操作

**`workspace_launch` のブロックリスト:**  
`cmd.exe`, `powershell.exe`, `pwsh.exe`, `wscript.exe`, `cscript.exe`, `mshta.exe`, `regsvr32.exe`, `rundll32.exe`, `msiexec.exe`, `bash.exe`, `wsl.exe` は起動不可。  
`.bat`, `.ps1`, `.vbs` 等のスクリプトファイルも拒否。引数に `;`, `&`, `|`, `` ` ``, `$(`, `${` を含む場合も拒否。

**`keyboard_press` のブロックリスト:**  
`Win+R`（Run ダイアログ）、`Win+X`（管理ツールメニュー）、`Win+S`（検索）、`Win+L`（ロック）は実行不可。

### PowerShell インジェクション対策

UIA ブリッジの `-like` パターンには `escapeLike()` でワイルドカード文字 (`*`, `?`, `[`, `]`) をエスケープ済み。

---

## マウス移動速度

`mouse_move` / `mouse_click` / `mouse_drag` / `scroll` は全て `speed` パラメータ（省略可）を受け付けます。

| 値 | 動作 |
|---|---|
| 省略 | 設定済みのデフォルト速度を使用（下記参照） |
| `0` | 瞬間移動（`setPosition()` — アニメーションなし） |
| `1〜N` | N px/秒 でアニメーション移動 |

**デフォルト速度は 1500 px/秒**。環境変数 `DESKTOP_TOUCH_MOUSE_SPEED` で永続的に変更できます。

```json
{
  "mcpServers": {
    "desktop-touch": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/path/to/desktop-touch-mcp/dist/index.js"],
      "env": {
        "DESKTOP_TOUCH_MOUSE_SPEED": "3000"
      }
    }
  }
}
```

主な目安: `0` = テレポート、`1500` = デフォルト（ゆっくり）、`3000` = 速い、`5000` = 超速。

---

## Force-Focus (AttachThreadInput)

Windows のフォアグラウンド保護機能により、ピン固定された Claude CLI などが前面にある状態では `SetForegroundWindow` が拒否されることがあります。その結果、後続のキー入力やクリックが意図しないウィンドウに送られるサイレント障害が発生します。

`mouse_click`、`keyboard_type`、`keyboard_press`、`terminal_send` はいずれも `forceFocus` パラメータを受け付けており、`AttachThreadInput` を使ってこの保護を迂回できます。

```json
{
  "name": "mouse_click",
  "arguments": {
    "x": 500,
    "y": 300,
    "windowTitle": "Google Chrome",
    "forceFocus": true
  }
}
```

強制フォーカスが拒否された場合、応答に `hints.warnings: ["ForceFocusRefused"]` が含まれます。

**環境変数でグローバルデフォルトを設定する:**

```json
{
  "mcpServers": {
    "desktop-touch": {
      "env": {
        "DESKTOP_TOUCH_FORCE_FOCUS": "1"
      }
    }
  }
}
```

`DESKTOP_TOUCH_FORCE_FOCUS=1` を設定すると、4 つのツールすべてで `forceFocus: true` がデフォルトになります。

**既知のトレードオフ:**

- `AttachThreadInput` が有効な約 10ms の間、2 スレッド間でキー状態とマウスキャプチャが共有されます。高速なマクロ連打では稀にレース状態が発生する可能性があります。
- ユーザーが別のアプリを手動操作している間は `forceFocus` を無効にするか、環境変数の設定を解除してください。予期しないフォーカス移動を防ぐためです。

---

## 既知の制限

| 制限 | 詳細 | 回避策 |
|---|---|---|
| ゲーム・動画プレイヤーの背面キャプチャが黒またはハング | DirectX フルスクリーン等は `PW_RENDERFULLCONTENT (flag=2)` でもキャプチャ不可な場合がある | `screenshot_background(fullContent=false)` で旧フラグに切り替え、それでも黒なら前面キャプチャ (`screenshot`) を使用 |
| UIA 呼び出しのオーバーヘッド | PowerShell 経由のため 1 回約 300ms。`workspace_snapshot` 内は 2s タイムアウトに短縮 | 操作前に `workspace_snapshot` で一括取得し、以降は `diffMode` で差分確認 |
| Chrome / WinUI3 の UIA 要素が空 | Chromium は UIA を限定的にしか公開しない | `browser_connect` + `browser_find_element` で DOM ベースのクリックを使用。視覚確認のみなら `screenshot(detail="image")` |
| レイヤーバッファの TTL | 90 秒操作なしでバッファが自動クリア → 次回 `diffMode` が I-frame になる | 長い待機後は `workspace_snapshot` で明示的にリセット |

---

## パフォーマンス目安

| モード | 転送トークン | 用途 |
|---|---|---|
| `screenshot` (768px PNG) | ~443 tok | 一般的な視覚確認 |
| `screenshot(dotByDot=true)` ウィンドウ | ~800 tok | 精密クリック（座標変換不要） |
| `screenshot(diffMode=true)` | ~160 tok | 操作後の差分確認 |
| `screenshot(detail="text")` | ~100-300 tok | UI 操作（画像不要） |
| `workspace_snapshot` | ~2000 tok | セッション開始時の全体把握 |

---

## Claude へのシステムプロンプト（自動注入）

**設定は不要です。** MCP 接続時にコマンドリファレンスが自動的に Claude へ送信されます。

MCP `initialize` レスポンスの `instructions` フィールドを利用しており、Claude CLI がセッション開始時に自動でシステムプロンプトへ組み込みます。以下は送信される内容の参考です。

```
# desktop-touch-mcp 操作指針

## 情報収集の優先順位（トークン節約）
1. workspace_snapshot() → セッション開始時・全体把握が必要な時のみ
2. screenshot(detail="text", windowTitle=X) → UI操作（ボタン名・入力欄の確認）
3. screenshot(diffMode=true) → 操作後の確認（変化した窓のみ ~160 tok）
4. screenshot(dotByDot=true, windowTitle=X) → 精密座標が必要な時のみ
5. screenshot(detail="image") → 視覚的確認が必要な時のみ（最重量）

## 座標の扱い
- detail="text" の actionable[].clickAt は画面座標として直接 mouse_click に渡せる（変換不要）
- dotByDot=true の場合: screen_x = origin_x + image_x（レスポンスのoriginを参照）
- デフォルト PNG の場合: screen_x = window.x + image_x * (window.width / image.width)

## 操作ループの基本形
workspace_snapshot() → detail="text" で要素確認 → mouse_click/keyboard_type → diffMode=true で確認

## 日本語入力
keyboard_type(use_clipboard=true) を使うこと（IME バイパス）
```

---

## `workspace_launch` 起動許可リスト

セキュリティ上、`cmd.exe` / `powershell.exe` 等のシェルインタープリタはデフォルトでブロックされます。  
特定の実行ファイルを許可するには **allowlist ファイル** を作成してください。

**設定ファイルの場所（上から順に検索）:**
1. 環境変数 `DESKTOP_TOUCH_ALLOWLIST` で指定したパス
2. `~/.claude/desktop-touch-allowlist.json`
3. サーバー実行ディレクトリ直下の `desktop-touch-allowlist.json`

**フォーマット:**
```json
{
  "allowedExecutables": [
    "pwsh.exe",
    "C:\\Tools\\myapp.exe"
  ]
}
```

ファイルの変更は即時反映されます（再起動不要）。

---

## ライセンス

MIT
