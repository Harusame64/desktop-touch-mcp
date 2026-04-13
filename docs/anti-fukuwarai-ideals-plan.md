# llm-ux-ideals 実装計画

## Context

`docs/anti-fukuwarai-ideals.md` で定義した7つの理想を、**agentic LLMを使わず純粋なアルゴリズム改善**で実現する。
核心課題は「福笑い状態」の解消 — LLMが座標だけでなく意味・文脈・理由を伴って操作できるようにする。

既存コードの調査から、多くの情報が**既に計算済みだが返却されていない**ことが判明。
最小限の変更で大きな改善が得られる Quick Wins から着手し、段階的に高度な機能を追加する。

---

## Phase 1: Quick Wins（各1-2時間）

### 1A. changeFraction を P-frame レスポンスに公開
- **ファイル**: `src/engine/layer-buffer.ts`, `src/tools/screenshot.ts`
- **内容**: `computeChangeFraction()` は既に計算済み（layer-buffer.ts:76）。diffMode 時のレスポンスに `changeFraction: 0.03` を追加するだけ
- **効果**: LLMが「操作が効いたか」を数値で即判断。0.0 なら空振り、高ければ大きな変化

### 1B. keyboard_type / keyboard_press にフォーカス中ウィンドウ情報を付与
- **ファイル**: `src/tools/keyboard.ts`, `src/engine/window-info.ts`（新規ヘルパー）
- **内容**: `getForegroundTitle()` を PowerShell `GetForegroundWindow` で実装。keyboard 系ツールのレスポンスに `"targetWindow": "メモ帳"` を追加
- **効果**: キー入力が意図したアプリに届いたか確認可能。dock_window ピン時の誤送信を検知
- **依存**: このヘルパーは 2A, 3A, 3B でも再利用

### 1C. keyboard_press の未知キーエラーを建設的に
- **ファイル**: `src/utils/key-map.ts`
- **内容**: `parseKeys()` の `Unknown key` エラーに Levenshtein 距離 or prefix match で候補を提示。例: `Unknown key: "cntrl". Did you mean: "ctrl"?`
- **効果**: Ideal 6（建設的な失敗）の最小実装

---

## Phase 2: Post-Action Context（各2-4時間）

### 2A. mouse_click / mouse_move のレスポンスを enriched に
- **ファイル**: `src/tools/mouse.ts`
- **内容**: クリック後に以下を返却:
  - `focusedWindow`: 1B の `getForegroundTitle()` を再利用
  - `nearElement`: `window-cache.ts` の `findContainingWindow()` + UIA `getElementBounds()` で最寄り要素名を取得（Tier3 homing の既存ロジック流用）
  - `windowReady`: layer-buffer の `changeFraction` が安定したか（前回比）
- **効果**: Ideal 1（状態の言語化）— クリック結果が言葉で返る

### 2B. click_element の enriched レスポンス + 建設的エラー
- **ファイル**: `src/tools/ui-elements.ts`, `src/engine/uia-bridge.ts`
- **内容**:
  - 成功時: `{"ok":true, "element":"乗算", "why":"matched automationId='multiplyButton'", "state":"invoked"}`
  - `state` は UIA パターンから判定: `IsEnabled=false` → `"disabled"`, `ToggleState=On` → `"toggled"`
  - 失敗時: パターン不一致なら代替手段を提案: `"InvokePattern not supported on Document → try mouse_click or set_element_value"`
  - 要素未発見時: 部分一致候補を返す: `"not found: 'テキスト エディタ'. Similar: ['テキスト エディター', 'テキスト書式']"`
- **効果**: Ideal 2（理由）+ Ideal 6（建設的エラー）

---

## Phase 3: 新ツール追加（各3-5時間）

### 3A. `get_context` ツール — 軽量な文脈取得
- **ファイル**: `src/tools/context.ts`（新規）, `src/index.ts`
- **内容**: スクリーンショットなしで現在地を返す軽量API:
  ```json
  {
    "focusedWindow": "電卓",
    "focusedElement": "表示エリア (value: '29,232')",
    "cursorNear": "equalButton",
    "pageState": "ready"
  }
  ```
  - `focusedWindow`: 1B の `getForegroundTitle()`
  - `focusedElement`: UIA `GetFocusedElement()` で取得（新規 PowerShell スクリプト、単一要素なので <100ms）
  - `cursorNear`: カーソル座標 → `window-cache` + UIA `ElementFromPoint` で最寄り要素
  - `pageState`: layer-buffer の changeFraction 推移で判定（安定→`ready`、変化中→`loading`）
- **効果**: Ideal 3 — フルスクリーンショットなしで「今どこ」がわかる

### 3B. `wait_until` ツール — 条件待ちポーリング
- **ファイル**: `src/tools/wait.ts`（新規）, `src/index.ts`
- **内容**: 条件が満たされるまでサーバー側でポーリング:
  ```
  wait_until(windowTitle="電卓", condition="value_changed", timeout=5000)
  wait_until(windowTitle="Chrome", condition="title_contains", value="Dashboard")
  wait_until(condition="window_ready")  // changeFraction が安定
  ```
  - `value_changed`: UIA ValuePattern の値を 200ms 間隔でチェック
  - `title_contains`: ウィンドウタイトルを監視
  - `window_ready`: layer-buffer の changeFraction < 0.01 が 3連続
  - タイムアウト付き（デフォルト5秒、最大30秒）
- **効果**: Ideal 5 — ポーリング用の無駄なスクリーンショットが不要に

---

## Phase 4: OCR 信頼度ヒューリスティック（3-4時間）

### 4A. OCR 結果に疑似 confidence スコアを付与
- **ファイル**: `src/engine/ocr-bridge.ts`
- **内容**: Windows.Media.Ocr API には confidence フィールドがない（プラットフォーム制限）。以下のヒューリスティックで疑似スコアを算出:
  1. **文字種一貫性**: 単語内の文字種混在度（「Hョ「し5ョ01を64」→ 低スコア）
  2. **バウンディングボックス整合性**: 極端に細い/歪んだ矩形 → 低スコア
  3. **辞書マッチ**: 既知UIラベル（ファイル, 編集, 表示...）との部分一致 → 高スコア
  4. **行コンテキスト**: OcrLine.Text（現在未使用）を取得し、行全体の整合性チェック
- **出力**: `confidence: 0.23` + 低信頼時は `"suggest": "dotByDot screenshot of region"` を自動付与
- **効果**: Ideal 4 — 低信頼OCR結果へのフォールバック提案

---

## Phase 5: UIA キャッシュ（P-frame 方式）（6-8時間）

### 5A. UIA ツリーの差分キャッシュ
- **ファイル**: `src/engine/uia-cache.ts`（新規）, `src/engine/uia-bridge.ts`, `src/tools/ui-elements.ts`
- **内容**:
  - `Map<hwnd, { tree, timestamp }>` でウィンドウごとにUIAツリーをキャッシュ
  - `get_ui_elements(cached=true)` → TTL内（3秒）ならキャッシュ返却
  - 差分検出: ValuePattern の値変化のみを再取得し、ツリー構造はキャッシュ流用
  - キャッシュ無効化: ウィンドウタイトル変化、サイズ変化、changeFraction > 0.3 で自動パージ
  - レスポンスに `"cached": true, "age": "2.1s", "changed": ["display value '0' → '29,232'"]` を付与
- **効果**: Ideal 7 — 2回目以降のUIA取得が 8秒 → <200ms に

---

## 実装順序と依存関係

```
1A (changeFraction) ─────────────────────────────────────→ 独立
1B (getForegroundTitle) ──→ 2A (mouse enrich) ──→ 3A (get_context)
                          ──→ 3B (wait_until)
1C (key suggestions) ────────────────────────────────────→ 独立
2B (click_element enrich) ───────────────────────────────→ 独立
4A (OCR confidence) ─────────────────────────────────────→ 独立
5A (UIA cache) ──────────────────────────────────────────→ 独立（最後に着手）
```

推奨順: 1A → 1B → 1C → 2A → 2B → 3A → 3B → 4A → 5A

---

## 検証方法

各フェーズ完了後:
1. `npm run build` でコンパイル確認
2. Claude Code から MCP ツールを呼び出して実際のレスポンスを確認:
   - 1A: `screenshot(diffMode=true)` → changeFraction が含まれるか
   - 1B: `keyboard_type(text="test")` → targetWindow が含まれるか
   - 1C: `keyboard_press(keys="cntrl+c")` → 候補付きエラーか
   - 2A: `mouse_click(x, y)` → focusedWindow, nearElement が含まれるか
   - 2B: `click_element(name="存在しない")` → 部分一致候補が返るか
   - 3A: `get_context()` → 軽量にフォーカス情報が返るか
   - 3B: `wait_until(condition="window_ready")` → ポーリング後に結果が返るか
   - 4A: `screenshot_ocr()` → confidence 付きか
   - 5A: `get_ui_elements(cached=true)` → 2回目が高速か
3. 電卓・メモ帳・Chrome で end-to-end テスト
