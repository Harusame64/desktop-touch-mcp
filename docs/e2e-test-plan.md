# desktop-touch-mcp E2E テスト計画

**対象**: LLM が MCP ツールを操作するシナリオで発生しやすいバグ・信頼性問題  
**作成**: 2026-04-14（Opus レビューを経て策定）

---

## A. フォーカス / ウィンドウ同期の不整合（最優先）

### A1: windowTitle 未指定で keyboard_type → 別ウィンドウへ誤入力
- **対象ツール**: `keyboard_type`、`get_context`
- **シナリオ**: Notepad フォアグラウンド → 別アプリ割り込み → `keyboard_type({ text:"secret" })`（windowTitle 省略）→ `get_context` で実際の入力先を確認
- **検証点**: `focusLost` または `windowChanged:true` が明確に報告されること
- **発生しやすいバグ**: LLM が「直前の get_context で Notepad がフォア = 今もフォア」と思い込み windowTitle を省略、別ウィンドウへ誤入力

### A2: `terminal_send(restoreFocus:true)` で元ウィンドウが最小化されていた
- **対象ツール**: `terminal_send`
- **シナリオ**: Notepad をアクティブ → 最小化 → `terminal_send({ restoreFocus:true })`
- **検証点**: 最小化状態を無断で解除しないこと、または hints で明示されること
- **発生しやすいバグ**: 最小化解除でユーザーのワークスペースが乱れる

### A3: forceFocus=true でも奪取失敗時に LLM が成功と誤認
- **対象ツール**: `keyboard_press`、`keyboard_type`（forceFocus 系）
- **シナリオ**: UAC ダイアログなど SetForegroundWindow が拒否される状況で `forceFocus:true` を指定
- **検証点**: `warnings:["ForceFocusRefused"]` が返ること。`post.focusedWindow !== windowTitle` で検出可能なこと
- **発生しやすいバグ**: 奪取が「一瞬だけ成功→戻る」場合に検出漏れ

### A4: Z オーダー変更後の座標ずれ（homing）
- **対象ツール**: `mouse_click({ x, y, windowTitle })`
- **シナリオ**: Calculator 起動 → screenshot で "5" ボタン座標取得 → Calculator を移動 → 取得済み座標でクリック
- **検証点**: `homingNotes` に補正情報が載ること、クリックが正しく着弾すること
- **発生しやすいバグ**: homing キャッシュが古いと補正が無効化される

---

## B. narrate:"rich" / UIA diff の欠落・誤認

### B1: Chromium で narrate:"rich" → 空 diff を「変化なし」と誤解
- **対象ツール**: `keyboard_press`（narrate:"rich"、Chrome 対象）
- **検証点**: `post.rich.diffDegraded === "chromium_sparse"` が必ず返ること。`appeared:[]` だけでは判断できない構造になっていること
- **発生しやすいバグ**: CHROMIUM_TITLE_RE にマッチしないタイトル（"Meet - Google Meet" など）が sparse 判定をすり抜ける

### B2: keyboard_press("a", narrate:"rich") がサイレントダウングレード
- **対象ツール**: `keyboard_press`
- **シナリオ**: `keyboard_press({ keys:"a", narrate:"rich" })`（isStateTransitioningKey が false）
- **検証点**: `post.rich` が付与されないとき、ダウングレードの理由シグナル（`diffDegraded:"trivial_key"` 等）が返ること
- **発生しやすいバグ**: LLM は `rich` を指定した以上 `post.rich` があると期待するが、欠落理由がないと次の手を誤る

### B3: UIA settle 前に後スナップショット → 偽陰性の valueDeltas
- **対象ツール**: `set_element_value(narrate:"rich")`
- **シナリオ**: 値更新が遅い WinUI3 テキストボックス
- **検証点**: UI_SETTLE_MS=120ms 不足時でも `valueDeltas` に新値が反映されるか、不足なら `diffDegraded` が立つこと
- **発生しやすいバグ**: before と after が同値 → `valueDeltas:[]` → LLM が「入力失敗」と誤解して再実行 → 二重入力

### B4: UIA キャッシュのクロスコール汚染
- **対象ツール**: `keyboard_type(narrate:"rich")` 連続呼び出し
- **シナリオ**: 同一ウィンドウに 3 回連続で `keyboard_type(narrate:"rich")`
- **検証点**: 各呼び出しの before スナップショットが独立であること
- **発生しやすいバグ**: module-level キャッシュが before スナップショットに漏れ、前回分の文字列が再度 valueDeltas に出る

### B5: narrate:"rich" 中にウィンドウが閉じた
- **対象ツール**: `keyboard_press({ keys:"alt+f4", narrate:"rich" })`
- **検証点**: `diffDegraded:"timeout"` または "window_closed" が立ち、例外にならないこと
- **発生しやすいバグ**: after スナップショット取得で throw → timeout 扱いになるが「ウィンドウが閉じた」という意味が失われる

---

## C. get_context の意味解釈

### C1: get_context → keyboard_type → get_context の値整合
- **対象ツール**: `get_context`、`keyboard_type`
- **シナリオ**: Notepad 起動 → `get_context()` で value 確認 → `keyboard_type("hello world")` → `get_context()` で value 再確認
- **検証点**: `focusedElement.value === "hello world"`、`hints.focusedElementSource === "uia"`
- **発生しやすいバグ**: Notepad の Document コントロールが ValuePattern を提供しないため `value` が undefined → LLM が「入力失敗」と誤判定

### C2: pageState="loading" が出ない（Chrome）
- **対象ツール**: `get_context`（Chrome フォアグラウンド時）
- **シナリオ**: `browser_navigate` 直後に `get_context()`
- **検証点**: readyState が complete 前は `pageState:"loading"` が返ること
- **発生しやすいバグ**: CDP 例外時に silent fail して常に `"ready"` が返る

### C3: hasModal の title-regex 過検出
- **対象ツール**: `get_context`
- **シナリオ**: タイトルに「通知」が入るファイル（`通知センター.md - VS Code`）を開く
- **検証点**: ファイル名と本物のモーダルが区別されること
- **発生しやすいバグ**: MODAL_RE がファイル名・タブタイトルを拾って `pageState:"dialog"` を誤報。LLM が Esc 連打 → 編集内容消失

### C4: 日本語 IME 変換中の focusedElement.value
- **対象ツール**: `get_context` + `keyboard_type`（IME on）
- **シナリオ**: IME ON 状態で `keyboard_type("こんにちは")` → 未確定文字列がある状態で `get_context()`
- **検証点**: ValuePattern が未確定を含むか除くかを文書化。`use_clipboard:true` を促すヒントを返すこと
- **発生しやすいバグ**: 未確定変換が ValuePattern に載らず「入力失敗」と誤解

---

## D. terminal_send / terminal_read の差分取得

### D1: sinceMarker の末尾パディング揺らぎ（リグレッション防止）
- **対象ツール**: `terminal_read(sinceMarker)`
- **シナリオ**: `terminal_read` → marker 取得 → コマンド実行（プロンプト再描画） → `terminal_read(sinceMarker: marker)`
- **検証点**: `matched:true` で差分のみ返ること。末尾スペース差で miss しないこと
- **備考**: `normalizeForMarker` 修正（2026-04-14）のリグレッションガード。`tests/unit/terminal-marker.test.ts` で単体テスト済み

### D2: terminal_send 直後の terminal_read で出力が追いついていない
- **対象ツール**: `terminal_send` + `terminal_read`
- **シナリオ**: `terminal_send({ input:"Start-Sleep 2; echo done" })` 直後に `terminal_read()`
- **検証点**: `wait_until({ condition:"terminal_output_contains", pattern:"done" })` を推奨するヒントが返ること
- **発生しやすいバグ**: LLM が「send したら read で取れる」と思い込み空を受け取り、失敗と判断して再送信 → 二重実行

### D3: UIA TextPattern がタブタイトルを拾う（リグレッション防止）
- **対象ツール**: `terminal_read`
- **シナリオ**: Windows Terminal で複数タブ開いた状態
- **検証点**: `source:"uia"` でタブタイトル行が先頭に混入しないこと（コミット `bec8721` のリグレッションガード）

### D4: ANSI + マルチバイトが混じる出力での stripAnsi ズレ
- **対象ツール**: `terminal_read({ stripAnsi:true })`
- **シナリオ**: `ls --color=always` 等のカラー出力 + 日本語ファイル名
- **検証点**: 色コードのみが落ち、日本語が壊れないこと
- **発生しやすいバグ**: ANSI 中間バイトとマルチバイト先頭バイトが同値で誤検出 → 文字化け → LLM がパス名を誤認

---

## E. Chrome CDP（browser_*）連携

### E1: browser_navigate の waitForLoad タイムアウトが silent 成功
- **対象ツール**: `browser_navigate`
- **シナリオ**: 15s 以上かかる重いページに `browser_navigate({ url, waitForLoad:true })`
- **検証点**: タイムアウト時 `hints.warnings:["NavigateTimeout"]` + 現在の readyState が返ること
- **発生しやすいバグ**: LLM が `ok:true` のみ確認して次アクション → まだ loading のボタンをクリック → 失敗

### E2: browser_search の WeakMap ステートリーク（リグレッション防止）
- **対象ツール**: `browser_search`（offset ページング）
- **シナリオ**: 同一 tabId に連続ページング → `browser_disconnect` → 再接続
- **検証点**: 新セッションで offset が正しく 0 から始まること（コミット `867a2fc` のリグレッションガード）

### E3: browser_click_element と DOM 再レンダリングの競合
- **対象ツール**: `browser_click_element`
- **シナリオ**: React SPA でクリック直後にボタンが detach → 再 mount
- **検証点**: stale element error を明確にエラーコード化し、`suggest` に次の手が含まれること

### E4: CDP 接続が生きているが tab が閉じた
- **対象ツール**: `browser_click_element`、`browser_eval`
- **シナリオ**: `tabId` 指定で操作中、ユーザーがそのタブを閉じる
- **検証点**: `code:"TabNotFound"` と代替 tabId の提示が返ること

### E5: browser_launch の user-data-dir が 8.3 短パス（リグレッション防止）
- **対象ツール**: `browser_launch`
- **検証点**: Chrome が `--user-data-dir` を拒否しないこと（`longTempDir()` 修正のリグレッションガード）

---

## F. get_ui_elements のキャッシュと整合性

### F1: cached:true でウィンドウ構造が変化済み
- **対象ツール**: `click_element`（古い automationId 使用）
- **シナリオ**: ダイアログ表示 → get_ui_elements でツリー取得 → ダイアログが閉じる → 取得済み automationId で click_element
- **検証点**: `not_found` として明確にエラーを返し、「cached stale → re-fetch」の suggest が返ること

### F2: UIA sparse（Electron/WinUI3）で actionable が 0
- **対象ツール**: `screenshot(detail:'text')`
- **シナリオ**: Slack（Electron）に `screenshot({ detail:"text" })`
- **検証点**: `hints.uiaSparse:true`、`hints.ocrFallbackFired:true`、`actionable[].source === "ocr"` であること
- **発生しやすいバグ**: UIA が 3〜4 要素返すと sparse 判定しきい値を外れて OCR fallback が走らず、LLM は 3 要素しか見えない

---

## G. エラー応答の LLM 可読性

### G1: click_element が InvokePattern 非対応
- **検証点**: error に `suggest:["mouse_click", "set_element_value"]` 等、LLM が次に試すべきツールが含まれること

### G2: wait_until がタイムアウト
- **検証点**: timeout 時に「直近で観測した最近接の状態」を `observed` として返すこと

### G3: keyboard_press で禁止キー（win+r 等）
- **検証点**: `BlockedKeyComboError` が「このキーはセキュリティ制限」と明示し、代替案を示すこと

---

## H. ツール連携の state 伝搬

### H1: workspace_launch → wait_until → focus_window
- **シナリオ**: 起動が遅いアプリで `workspace_launch` 直後に `focus_window`
- **検証点**: `wait_until` を挟まずに focus_window が呼ばれた場合、`suggest:["wait_until"]` が返ること

### H2: get_history の時系列整合
- **対象ツール**: `get_history`
- **シナリオ**: 複数アクション → `get_history(n=20)`（ring buffer 上書き境界テスト）
- **検証点**: 時系列順で並び、各 `post.focusedWindow` が実行時点のフォアグラウンドを保持していること

### H3: mouse_click 後に get_context 即時呼び出し
- **検証点**: クリック後のフォーカス移動が 300ms 以内に `get_context.focusedElement` に反映されること、またはその旨のヒントが返ること

---

## I. 並行呼び出し / 競合

### I1: keyboard_type を並列発行
- **検証点**: 入力順序が崩れず、modifier キーが漏れないこと（ctrl 押下状態が次のハンドラに伝播しない）

### I2: screenshot(detail='text') 実行中に get_context
- **検証点**: PowerShell プロセス数が無制限に増えないこと（UIA bridge のプールが有効に機能すること）

---

## J. Unit テスト（純関数の境界値）

### J1: `isStateTransitioningKey` の網羅
- **対象**: `src/tools/_narration.ts`
- **ケース**: `ctrl+s` true、`shift+a` false、`shift+tab` true、`Ctrl+Shift+S`（大文字）true、`""` false、`"ctrl+"` 空トークン
- **備考**: 修正済みバグのリグレッションガード。`tests/unit/narration-gate.test.ts` で実装済み

### J2: `applySinceMarker` の末尾スペース耐性
- **対象**: `src/tools/terminal.ts`
- **ケース**: CRLF/LF 混在、末尾スペース差、末尾空行差でもマーカーが一致すること
- **備考**: `tests/unit/terminal-marker.test.ts` で実装済み（20 テスト）

### J3: `computeUiaDiff` の不変条件
- **対象**: `src/engine/uia-diff.ts`
- **ケース**: 入力配列が mutate されない / appeared・disappeared・valueDeltas のサイズ上限超過時に `truncated` が立つ / `name:""` の要素は appeared に入らない
- **備考**: `tests/unit/uia-diff.test.ts` で既存テスト。補強推奨

### J4: `assertKeyComboSafe` の禁止リスト
- **対象**: `src/utils/key-safety.ts`
- **ケース**: `win+r`、`win+x`、`win+s`、`win+l` が必ず拒否。大文字小文字・`meta+r`・`super+r` エイリアスも拒否

### J5: `parseKeys` / `normalizeCombo` の曖昧入力
- **対象**: `src/utils/key-map.ts`、`src/utils/key-safety.ts`
- **ケース**: `"ctrl + s"`（スペース混入）、`"CTRL+S"`、`"ctrl+"` 空末尾、`"ctrl+ctrl+s"` 重複修飾子

---

## 実装ロードマップ

| 優先 | ファイル | カバーするシナリオ |
|------|----------|--------------------|
| P0 | `tests/e2e/focus-integrity.test.ts` | A1〜A4 |
| P0 | `tests/e2e/rich-narration-edge.test.ts` | B1〜B5 |
| P0 | `tests/e2e/context-consistency.test.ts` | C1〜C4 |
| P1 | `tests/e2e/terminal-marker.test.ts`（e2e 版） | D1〜D4 |
| P1 | `tests/e2e/browser-failure-modes.test.ts` | E1〜E5 |
| P2 | `tests/e2e/ui-elements-cache.test.ts` | F1〜F2 |
| P2 | `tests/e2e/error-quality.test.ts` | G1〜G3 |
| P2 | `tests/e2e/tool-chain.test.ts` | H1〜H3 |
| P3 | `tests/e2e/concurrency.test.ts` | I1〜I2 |
| P1 | `tests/unit/` 拡張 | J3〜J5 |

### 共通 Fixture 方針

- `tests/e2e/fixtures/` に以下を用意：
  - Notepad（UIA-native）
  - Calculator（UIA-rich）
  - Chrome + ローカル HTML（CDP）
  - Electron ダミーアプリ（sparse UIA）
  - Windows Terminal（pwsh、`desktop-touch-allowlist.json` で許可済み）
- `tests/e2e/helpers/` に追加：
  - `assertPostBlock(result)` — ok/post 構造の基本検証
  - `assertRichDiffShape(post)` — appeared/disappeared/valueDeltas/diffSource を検証
  - `withEphemeralNotepad()` — テスト毎に新規 Notepad を起動・終了
  - `withIMEState("ja-JP", active:true)` — IME 状態を制御

### 設計原則

1. **各テストで `post.focusedWindow` / `post.rich.diffSource` / `hints.*` を必ず assert** — これらの欠落が LLM を最も混乱させる
2. **エラー時も `suggest` / `warnings` を検証** — `ok:false` だけでは LLM が次の手を選べない
3. **Chromium と UIA-native を対にしてテスト** — 同じコードが両世界で正しく動くことが LLM 信頼性の要
