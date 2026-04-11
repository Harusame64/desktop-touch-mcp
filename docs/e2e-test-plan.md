# E2E テスト計画

再起動後に実施するエンドツーエンドテスト。セキュリティ修正の検証を最優先とし、その後全ツールのリグレッションを確認する。

---

## Phase 1: セキュリティ修正の検証

### 1-A. フェイルセーフ（自動注入）

| # | 手順 | 期待結果 |
|---|---|---|
| 1 | マウスを画面左上コーナー（0,0付近）に移動した状態で任意のツールを呼ぶ | `FailsafeError: FAILSAFE triggered` が返る（ツールが実行されない） |
| 2 | 何も操作せずコーナー外でツールを呼ぶ | 正常に実行される |
| 3 | `run_macro` の途中でコーナーへ移動（マクロ開始後素早く） | 次ステップのチェック時にフェイルセーフ発動・マクロ中断 |

### 1-B. workspace_launch ブロックリスト

| # | コマンド | 期待結果 |
|---|---|---|
| 1 | `workspace_launch(command="cmd.exe")` | `Blocked: "cmd.exe" is a shell interpreter...` エラー |
| 2 | `workspace_launch(command="powershell.exe")` | 同様にブロック |
| 3 | `workspace_launch(command="notepad.exe")` | 正常起動・foundWindow返却 |
| 4 | `workspace_launch(command="script.bat")` | `Blocked: disallowed extension ".bat"` エラー |
| 5 | `workspace_launch(command="notepad.exe", args=["/d;calc"])` | `Blocked: argument contains shell metacharacters` エラー |

### 1-C. workspace_launch ホワイトリスト

| # | 手順 | 期待結果 |
|---|---|---|
| 1 | `~/.claude/desktop-touch-allowlist.json` を作成し `{ "allowedExecutables": ["pwsh.exe"] }` を書く | ファイル作成確認 |
| 2 | `workspace_launch(command="pwsh.exe")` | ブロックされずに起動する |
| 3 | ファイルを削除して再度 `workspace_launch(command="pwsh.exe")` | 再びブロックされる（即時反映確認） |

### 1-D. keyboard_press ブロック

| # | キー | 期待結果 |
|---|---|---|
| 1 | `keyboard_press(keys="win+r")` | `BlockedKeyComboError: "win+r" is not allowed` エラー |
| 2 | `keyboard_press(keys="Win+R")` | 同様（大文字小文字無関係） |
| 3 | `keyboard_press(keys="ctrl+c")` | 正常実行 |
| 4 | `keyboard_press(keys="alt+f4")` | 正常実行（ブロックされない） |

### 1-D'. run_macro 内でのキーブロック

| # | 手順 | 期待結果 |
|---|---|---|
| 1 | `run_macro` のステップに `keyboard_press(keys="win+r")` を含む | そのステップでエラー・stop_on_error=true なら中断 |

### 1-E. 入力長制限

| # | 手順 | 期待結果 |
|---|---|---|
| 1 | `keyboard_type(text="a" × 10001)` | Zod バリデーションエラー（max 10000） |
| 2 | `get_ui_elements(windowTitle="a" × 201)` | Zod バリデーションエラー（max 200） |

### 1-F. クリップボード復元

| # | 手順 | 期待結果 |
|---|---|---|
| 1 | クリップボードに任意テキストをコピー | 下準備 |
| 2 | `keyboard_type(text="test input", use_clipboard=true)` でメモ帳に入力 | `test input` が入力される |
| 3 | クリップボードの内容を確認 | 元のテキストに戻っている |

---

## Phase 2: PrintWindow flag=2 の検証

| # | 手順 | 期待結果 |
|---|---|---|
| 1 | Chrome ウィンドウを背面に置いて `screenshot_background(windowTitle="Chrome", fullContent=true)` | 黒画像ではなく実際のページが映る |
| 2 | 同じ状況で `fullContent=false` | 黒画像（旧動作） |
| 3 | `screenshot_background(windowTitle="メモ帳", fullContent=true)` | 正常にキャプチャ（非GPUアプリでも動作する） |

---

## Phase 3: スクリーンショット系リグレッション

| ツール | 確認内容 |
|---|---|
| `screenshot(detail="image")` | PNG が正常返却、スケール情報あり |
| `screenshot(detail="text", windowTitle=X)` | actionable[] + clickAt 座標 |
| `screenshot(detail="meta")` | タイトル + 座標のみ（画像なし） |
| `screenshot(dotByDot=true, windowTitle=X)` | 1:1 WebP + `origin: (x, y)` 情報 |
| `screenshot(diffMode=true)` 初回 | I-frame（全ウィンドウ、"10 new"等） |
| 操作後 `screenshot(diffMode=true)` | P-frame（変化したウィンドウのみ） |
| `workspace_snapshot()` | thumbnails + uiSummary.actionable[] が正常 |
| `get_screen_info` | モニター情報・DPI・カーソル位置 |

---

## Phase 4: ウィンドウ・マウス・キーボード系

| ツール | 確認内容 |
|---|---|
| `get_windows` | Z-order 順、日本語タイトル正常 |
| `get_active_window` | フォーカス窓のタイトルが正確（CJK対応） |
| `focus_window(title="電卓")` | 電卓がフォアグラウンドになる |
| `mouse_move(x, y)` | カーソルが指定座標に移動 |
| `mouse_click(x, y)` | 指定座標をクリック |
| `mouse_drag(sx,sy,ex,ey)` | ドラッグが実行される |
| `scroll(direction="down", amount=3)` | スクロール動作確認 |
| `get_cursor_position` | 正確な座標が返る |
| `keyboard_type(text="Hello")` | テキスト入力 |
| `keyboard_type(text="abc", use_clipboard=true)` | IMEバイパスで入力 |
| `keyboard_press(keys="ctrl+a")` | キー操作実行 |

---

## Phase 5: UI Automation 系

| ツール | 確認内容 |
|---|---|
| `get_ui_elements(windowTitle="メモ帳")` | 要素ツリーが返る |
| `click_element(windowTitle="メモ帳", name="設定")` | 設定ボタンが押せる |
| `set_element_value(windowTitle="メモ帳", name="テキスト エディター", value="test")` | 値がセットされる |
| `scope_element(windowTitle="電卓", name="5", controlType="Button")` | ズームキャプチャ + 子ツリー |
| `scope_element` で WinUI3（電卓） | "Element not found" にならない（Bug #18 回帰なし） |

---

## Phase 6: ワークスペース・マクロ系

| ツール | 確認内容 |
|---|---|
| `workspace_launch(command="calc.exe")` | foundWindow="電卓" |
| `workspace_launch(command="notepad.exe")` | 正常起動 |
| `pin_window(title="電卓")` | 最前面固定 |
| `unpin_window(title="電卓")` | 固定解除 |
| `run_macro` (focus→sleep→type→screenshot) | 4ステップが順番に実行される |
| `run_macro` (stop_on_error=true, 途中でエラー) | エラー以降のステップがスキップされる |
| `scroll_capture(windowTitle="Chrome")` | ページ全体のスティッチ画像が返る |

---

## テスト環境の準備

```
1. Claude CLI を再起動（新しいビルドを読み込む）
2. メモ帳を開いておく
3. 電卓を閉じておく（workspace_launch テスト用）
4. Chrome を開いておく（screenshot_background テスト用）
5. クリップボードに "clipboard-test-content" をコピーしておく（1-F用）
```

## 合格基準

- Phase 1 (セキュリティ): 全チェック合格 → **必須**
- Phase 2 (PrintWindow): Chrome 背面キャプチャで黒でない → **確認**
- Phase 3-6 (リグレッション): 既知の動作から後退なし → **必須**
