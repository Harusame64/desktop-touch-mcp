# テスト計画書 — v3.2 + scroll_capture

作成日: 2026-04-11  
対象: desktop-touch-mcp v3.2（22ツール + scroll_capture = 23ツール）

---

## 前提条件

- Claude CLI を**再起動済み**（新しい `dist/` を読み込んでいること）
- Chrome が起動していてスクロール可能なページを開いていること
- メモ帳（Notepad）が起動していること

---

## テスト 1: get_windows — isOnCurrentDesktop 修正確認

**目的**: `koffi.address()` を `String(bigint)` に修正したことで get_windows が動くことを確認。

**呼び出し**:
```
get_windows
（引数なし）
```

**期待結果**:
- ✅ エラーなく JSON が返る
- ✅ 各ウィンドウに `isOnCurrentDesktop: true/false` が含まれる
- ✅ `isActive: true` のウィンドウがちょうど 1 つある（フォーカス中のウィンドウ）
- ✅ `zOrder: 0` が最前面ウィンドウ
- ✅ 日本語タイトルが文字化けしない

**失敗パターン**:
- ❌ `get_windows failed: TypeError: Cannot convert object to primitive value` → 修正が効いていない
- ❌ `isActive: true` が全ウィンドウ → isActive 比較がまだ壊れている

---

## テスト 2: scroll_capture — 基本動作（Chrome 縦スクロール）

**前提**: Chrome でスクロールが必要な長いページを開く（例: wikipedia.org の記事）

**呼び出し**:
```json
{
  "tool": "scroll_capture",
  "params": {
    "windowTitle": "Chrome",
    "maxScrolls": 5,
    "scrollDelayMs": 500
  }
}
```

**期待結果**:
- ✅ 1枚の縦長画像が返る
- ✅ `frames: 2〜6` 程度（短ければ少ない）
- ✅ `stitchedSize` の幅がウィンドウ幅以下（最大 1280px）
- ✅ `stitchedSize` の高さがウィンドウ高さ × frames より小さい（重複除去されている）
- ✅ `overlapWarnings` がない or 少ない（重複検出成功）
- ✅ 画像内にブラウザのタブ・アドレスバーが先頭 1 回だけ含まれる

**目視確認**:
- ページ上部のコンテンツ → ページ下部のコンテンツの順に続いているか
- 継ぎ目に重複コンテンツや黒い線がないか

---

## テスト 3: scroll_capture — 短いページ（スクロール不要）

**前提**: スクロールしないくらい短いページを Chrome で開く（例: about:blank や短いページ）

**呼び出し**:
```json
{
  "tool": "scroll_capture",
  "params": { "windowTitle": "Chrome", "maxScrolls": 10 }
}
```

**期待結果**:
- ✅ `frames: 1`（2フレーム目がフレーム1と同一 → 底到達と判定して停止）
- ✅ 通常の screenshot と同等の画像が返る

---

## テスト 4: scroll_capture — maxScrolls 到達（長いページ）

**前提**: Wikipedia の長い記事など

**呼び出し**:
```json
{
  "tool": "scroll_capture",
  "params": {
    "windowTitle": "Chrome",
    "maxScrolls": 3,
    "scrollDelayMs": 400
  }
}
```

**期待結果**:
- ✅ `frames: 4`（maxScrolls=3 なので最大 4 フレーム）
- ✅ `warning: "maxScrolls reached, image may be truncated"` が含まれる
- ✅ 画像がページ途中で終わっている

---

## テスト 5: scroll_capture — ウィンドウ未発見

**呼び出し**:
```json
{
  "tool": "scroll_capture",
  "params": { "windowTitle": "存在しないウィンドウXYZ123" }
}
```

**期待結果**:
- ✅ `{ "ok": false, "error": "No window found matching: ..." }` が返る
- ✅ エラーで落ちない

---

## テスト 6: scroll_capture — run_macro 内から呼び出し

**目的**: TOOL_REGISTRY に登録できていることを確認。

**呼び出し**:
```json
{
  "tool": "run_macro",
  "params": {
    "steps": [
      { "tool": "sleep", "params": { "ms": 200 } },
      {
        "tool": "scroll_capture",
        "params": {
          "windowTitle": "Chrome",
          "maxScrolls": 2,
          "scrollDelayMs": 400
        }
      }
    ]
  }
}
```

**期待結果**:
- ✅ エラーなく実行される
- ✅ ステップ 2 の結果に画像が含まれる
- ✅ `[step 2: scroll_capture]` ラベルが出力される

---

## テスト 7: scroll_capture — 水平スクロール（direction: "right"）

**前提**: 横に広いコンテンツがあるウィンドウ（スプレッドシート、横スクロールするWebページ等）

**呼び出し**:
```json
{
  "tool": "scroll_capture",
  "params": {
    "windowTitle": "Chrome",
    "direction": "right",
    "maxScrolls": 3,
    "scrollDelayMs": 500
  }
}
```

**期待結果**:
- ✅ 横長の画像が返る（または水平スクロールが機能しない場合は `frames: 1`）
- ✅ エラーで落ちない
- ⚠️ このテストは環境依存。水平スクロールが効かないページでは `frames: 1` で正常終了

---

## テスト 8: pin_window / unpin_window

**前提**: Notepad を開いておく

**呼び出し（手順）**:
1. `pin_window { "title": "Notepad" }` — メモ帳を最前面固定
2. 別のウィンドウをクリックしてフォーカスを移す
3. `unpin_window { "title": "Notepad" }` — 固定解除

**期待結果**:
1. ✅ `{ "ok": true, "action": "pinned (call unpin_window to remove)" }`
2. フォーカスが移っても Notepad が前面に留まること（目視確認）
3. ✅ `{ "ok": true, "action": "unpinned" }`
4. 解除後に Notepad が他ウィンドウの後ろに隠れられること（目視確認）

---

## テスト 9: scope_element

**前提**: Notepad を開いておく

**呼び出し**:
```json
{
  "tool": "scope_element",
  "params": {
    "windowTitle": "Notepad",
    "controlType": "Edit"
  }
}
```

**期待結果**:
- ✅ テキスト編集エリアのクロップ画像が返る
- ✅ `element` に name, controlType, boundingRect が含まれる
- ✅ `children` に子要素リストが含まれる

---

## テスト 10: run_macro — フル連携シナリオ

**前提**: Chrome が開いている

**呼び出し**:
```json
{
  "tool": "run_macro",
  "params": {
    "steps": [
      { "tool": "pin_window", "params": { "title": "Chrome" } },
      { "tool": "focus_window", "params": { "title": "Chrome" } },
      { "tool": "sleep", "params": { "ms": 300 } },
      { "tool": "scroll_capture", "params": { "windowTitle": "Chrome", "maxScrolls": 3 } },
      { "tool": "unpin_window", "params": { "title": "Chrome" } }
    ]
  }
}
```

**期待結果**:
- ✅ 全ステップが順番に実行される
- ✅ scroll_capture の結合画像が返る
- ✅ 最後に Chrome のピン固定が解除される

---

## チェックリスト

| # | テスト | 結果 | 備考 |
|---|--------|------|------|
| 1 | get_windows isOnCurrentDesktop | ⬜ | |
| 2 | scroll_capture 基本動作 | ⬜ | |
| 3 | scroll_capture 短ページ | ⬜ | |
| 4 | scroll_capture maxScrolls 到達 | ⬜ | |
| 5 | scroll_capture ウィンドウ未発見 | ⬜ | |
| 6 | scroll_capture run_macro 内 | ⬜ | |
| 7 | scroll_capture direction:right | ⬜ | 環境依存 |
| 8 | pin_window / unpin_window | ⬜ | |
| 9 | scope_element | ⬜ | |
| 10 | run_macro フル連携 | ⬜ | |

---

## 既知の注意点

- **scroll_capture の画像サイズ**: ページが長いと出力画像が大きくなる。`maxScrolls: 3〜5` から試すことを推奨。
- **scrollDelayMs**: 動的コンテンツ（アニメーション、遅延読み込み）があるページでは `600〜800` に上げると安定する。
- **direction: "right"**: マウスの水平スクロールを使うため、ウィンドウが対応していない場合は `frames: 1` になる。
- **get_windows の isActive**: フォーカスウィンドウが 1 つのはずが複数 `true` になる場合は win32.ts の `GetForegroundWindow` の型を再確認。
