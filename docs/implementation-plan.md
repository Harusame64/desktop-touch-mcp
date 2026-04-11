# desktop-touch-mcp 改訂プラン v3

## Context

Claude CLI からデスクトップアプリを自由に操作できる MCP サーバー。スクリーンショット・マウス・キーボード・ウィンドウ管理に加え、Claude が「ワークスペース」として一括把握・操作できる高レベル抽象を提供する。

## アーキテクチャ — 3層構成

```
┌─────────────────────────────────────────────────┐
│  Layer 3: Workspace（Claude 向け高レベル抽象）    │
│  workspace_snapshot / workspace_launch / arrange  │
├─────────────────────────────────────────────────┤
│  Layer 2: Tools（MCP ツール群）                   │
│  screenshot, mouse, keyboard, window, ui_elements │
├─────────────────────────────────────────────────┤
│  Layer 1: Engine（低レベルAPI統合）               │
│  nut-js / koffi+user32 / PowerShell UIA / sharp   │
└─────────────────────────────────────────────────┘
```

### Layer 1: Engine — 4つの柱

| エンジン | 役割 | 強み |
|---|---|---|
| **nut-js** | マウス・キーボード・前景ウィンドウ管理・スクリーンショット | 統合 API、autoDelayMs=0 で高速 |
| **koffi + user32.dll** | バックグラウンド操作・PrintWindow・SendMessage | コンパイル不要、フォーカス不要で操作可能 |
| **PowerShell UIA** | UI 要素ツリー取得・要素名でクリック・値読み書き | 座標推測不要の精密操作 |
| **sharp** | 画像リサイズ・BGR→RGB 変換・PNG 圧縮 | 高速、トークンコスト削減 |

### Layer 2: MCP ツール一覧（18ツール）

#### スクリーンショット & ディスプレイ (3)

| ツール | パラメータ | エンジン |
|---|---|---|
| `screenshot` | `windowTitle?`, `region?`, `displayId?`, `maxDimension?=1280` | nut-js `screen.grab()` / `grabRegion()` |
| `screenshot_background` | `windowTitle` | koffi `PrintWindow` — **裏に隠れたウィンドウもキャプチャ** |
| `get_screen_info` | なし | koffi `EnumDisplayMonitors` + `GetMonitorInfoW` + `GetDpiForMonitor` |

#### ウィンドウ管理 (3)

| ツール | パラメータ | エンジン |
|---|---|---|
| `get_windows` | なし → `{handle, title, region}[]` | nut-js `getWindows()` |
| `get_active_window` | なし | nut-js `getActiveWindow()` |
| `focus_window` | `title: string` (部分一致) | nut-js `window.focus()` |

#### マウス (5)

| ツール | パラメータ | エンジン |
|---|---|---|
| `mouse_click` | `x, y, button?, doubleClick?` | nut-js |
| `mouse_move` | `x, y` | nut-js |
| `mouse_drag` | `startX, startY, endX, endY` | nut-js `mouse.drag()` |
| `scroll` | `amount, x?, y?, direction?` | nut-js |
| `get_cursor_position` | なし | nut-js `mouse.getPosition()` |

#### キーボード (2)

| ツール | パラメータ | エンジン |
|---|---|---|
| `keyboard_type` | `text: string` | nut-js |
| `keyboard_press` | `keys: string` (例: `"ctrl+c"`) | nut-js |

#### UI 要素 (3)

| ツール | パラメータ | エンジン |
|---|---|---|
| `get_ui_elements` | `windowTitle, maxDepth?=3, maxElements?=50` | PowerShell UIA |
| `click_element` | `windowTitle, name?, automationId?, controlType?` | PowerShell UIA InvokePattern |
| `set_element_value` | `windowTitle, name?, automationId?, value` | PowerShell UIA ValuePattern |

#### ワークスペース (2)

| ツール | パラメータ | エンジン |
|---|---|---|
| `workspace_snapshot` | `maxDimension?=800` | 全エンジン統合 |
| `workspace_launch` | `command, args?, waitMs?=1000` | child_process + nut-js |

### Layer 3: Workspace — Claude 専用の仮想デスクトップ

#### `workspace_snapshot` — 一撃で全状態把握

Claude がツールを何度も呼ぶ代わりに、**1回の呼び出しで作業環境を一括把握**:

```typescript
// 返却イメージ
{
  screen: { width: 1920, height: 1080 },
  cursor: { x: 500, y: 300 },
  activeWindow: { handle: 12345, title: "Notepad" },
  windows: [
    {
      handle: 12345,
      title: "Notepad",
      region: { x: 100, y: 100, width: 800, height: 600 },
      isActive: true,
      // PrintWindow で裏ウィンドウもサムネイル取得
      thumbnail: "<base64 PNG (小さめ)>",
      // UIA で取得可能なら UI 要素サマリ
      uiSummary: {
        editFields: [{ name: "Text Editor", hasValue: true }],
        buttons: ["File", "Edit", "View", "Help"],
        elementCount: 42
      }
    },
    // ... 他のウィンドウ
  ]
}
```

これにより Claude は:
1. **1回の呼び出し**で全ウィンドウの状態を把握
2. 各ウィンドウのサムネイルで視覚的確認
3. UI 要素サマリで操作対象を特定
4. 次のアクションを即座に決定

#### `workspace_launch` — アプリ起動 + 状態取得

```typescript
// メモ帳を起動し、ウィンドウが表示されるまで待つ
workspace_launch({ command: "notepad.exe", waitMs: 2000 })
// → 起動後のウィンドウ情報 + スクリーンショットを返却
```

## 技術スタック

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@nut-tree-fork/nut-js": "^4.2.6",
    "koffi": "^2.15.0",
    "sharp": "^0.34.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

- `screenshot-desktop` → 不要（nut-js + PrintWindow で代替）
- `winax` (COM) → 将来追加（Office 深い制御）
- PowerShell → 追加依存なし（OS 標準）

## プロジェクト構造

```
desktop-touch-mcp/
  package.json
  tsconfig.json
  src/
    index.ts                  # エントリポイント
    tools/
      screenshot.ts           # screenshot, screenshot_background, get_screen_info
      mouse.ts                # mouse_click, mouse_move, mouse_drag, scroll, get_cursor_position
      keyboard.ts             # keyboard_type, keyboard_press
      window.ts               # get_windows, get_active_window, focus_window
      ui-elements.ts          # get_ui_elements, click_element, set_element_value
      workspace.ts            # workspace_snapshot, workspace_launch
    engine/
      nutjs.ts                # nut-js 初期化・ラッパー (autoDelayMs=0)
      win32.ts                # koffi + user32.dll ラッパー (PrintWindow, SendMessage, FindWindow, EnumDisplayMonitors, DPI)
      uia-bridge.ts           # PowerShell UIA 実行エンジン
      image.ts                # screen.grab() → toRGB() → sharp → base64 パイプライン
    utils/
      key-map.ts              # キー名 → Key enum マッピング
      tray.ts                 # システムトレイ (PowerShell NotifyIcon)
```

## 実装ステップ

### Phase 1: Foundation（基盤）

1. プロジェクト初期化 — package.json, tsconfig.json, npm install
2. `engine/nutjs.ts` — nut-js 初期化、autoDelayMs=0 設定
3. `engine/image.ts` — screen.grab() → BGR→RGB → sharp resize → base64
4. `engine/win32.ts` — koffi で user32.dll ロード、PrintWindow/FindWindow/SendMessage
5. `engine/uia-bridge.ts` — PowerShell 子プロセスで UIA クエリ実行
6. `utils/key-map.ts` — キー名マッピングテーブル

### Phase 2: Basic Tools（基本ツール）

7. `tools/screenshot.ts` — screenshot + screenshot_background + get_screen_info
8. `tools/mouse.ts` — 5つのマウスツール
9. `tools/keyboard.ts` — 2つのキーボードツール
10. `tools/window.ts` — 3つのウィンドウ管理ツール
11. `tools/ui-elements.ts` — 3つのUI要素ツール

### Phase 3: Workspace（ワークスペース）

12. `tools/workspace.ts` — workspace_snapshot, workspace_launch
13. `utils/tray.ts` — システムトレイ

### Phase 4: Integration

14. `index.ts` — 全ツール統合、McpServer 作成、stdio 接続
15. ビルド & Claude CLI MCP 設定

## Claude CLI 設定

```json
{
  "mcpServers": {
    "desktop-touch": {
      "command": "node",
      "args": ["D:/git/desktop-touch-mcp/dist/index.js"]
    }
  }
}
```

## 検証シナリオ

### 基本動作

1. `npm run build` → エラーなし
2. 起動 → タスクトレイにアイコン表示
3. `get_screen_info` → 解像度 + カーソル位置
4. `screenshot` → スクリーンショット取得
5. `get_windows` → 全ウィンドウ一覧

### ウィンドウ操作

6. `focus_window("Edge")` → Edge が前面に
7. `screenshot_background("メモ帳")` → 裏のメモ帳もキャプチャ可能
8. `get_ui_elements("Edge")` → UI 要素ツリー取得
9. `click_element("Edge", { name: "再読み込み" })` → 座標なしでクリック

### ワークスペース

10. `workspace_snapshot` → 全ウィンドウのサムネイル + UI サマリが一括取得
11. `workspace_launch({ command: "notepad.exe" })` → 起動 + 状態返却

### E2E シナリオ

12. Claude CLI で「メモ帳を開いて "Hello World" と入力して保存」を実行
    - workspace_launch → keyboard_type → keyboard_press("ctrl+s") → UI 操作

## マルチディスプレイ & DPI 対応

### get_screen_info の返却値

```typescript
{
  virtualScreen: { x: -1920, y: 0, width: 3840, height: 1080 },
  displays: [
    { id: 0, name: "Dell AW2523HF", primary: true,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      dpi: 96, scale: 100 },
    { id: 1, name: "LG 27UK850", primary: false,
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
      dpi: 120, scale: 125 }
  ],
  cursor: { x: 500, y: 300 }
}
```

### 実装

- **モニター列挙**: koffi で `EnumDisplayMonitors` + `GetMonitorInfoW` 呼び出し
- **DPI 取得**: koffi で `GetDpiForMonitor` (モニター別 DPI)
- **DPI 対応初期化**: プロセス起動時に `SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)` を呼ぶ → 全 API が物理ピクセル座標を返す
- **モニター指定スクリーンショット**: `screenshot({ displayId: 1 })` → `GetMonitorInfoW` で bounds 取得 → `screen.grabRegion(bounds)`
- **座標系**: Windows 仮想スクリーン座標をそのまま使用（左モニターは負の X 値）
- **workspace_snapshot**: display レイアウト情報を含める

## 注意事項

- `@nut-tree-fork/nut-js` は node-gyp + Visual Studio Build Tools が必要
- `koffi` はプリビルドバイナリ同梱でコンパイル不要
- UAC 昇格ウィンドウへの操作は非昇格プロセスから失敗する場合あり
- `stdout` は MCP プロトコル専用 — ログは `console.error()` (stderr) へ
- nut-js `screen.grab()` は BGR — `image.toRGB()` で変換必要
- PowerShell UIA の `BoundingRectangle` は最小化ウィンドウで Infinity — 要ガード
- `PrintWindow` は一部の DirectComposition/DXGI ベースの描画で黒画面になる場合あり
- マルチモニターで異なる DPI の場合、DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 必須

## 将来の拡張

- **COM Automation** (`winax`): Office アプリの深い制御（セル操作、ドキュメント編集）
- **DXGI/WGC 高速キャプチャ**: 動画レベルの連続キャプチャ
- **Windows Virtual Desktop API**: Claude 専用の実際の仮想デスクトップ作成
- **iohook**: グローバル入力監視（操作の成功確認に使用）
