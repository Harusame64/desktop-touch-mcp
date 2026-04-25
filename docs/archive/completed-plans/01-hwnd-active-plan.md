## 📋 実装指示書：安定した対象指定（`@active` / `hwnd`）

### 1. 目的（解決したい課題）
* 動的にタイトルが変わるアプリケーション（Chromeのタブ切り替え、YouTube動画遷移など）において、`windowTitle` による曖昧な対象指定を排除し、操作対象を見失う（`WindowNotFound`等）エラーを防ぐ。
* 毎回完全なタイトルを指定・取得するLLMのトークン消費と推論コストを削減する。

### 2. 対象となる主要ツール群
以下のツール群の入力スキーマ（パラメータ）に `hwnd` を追加し、`windowTitle` の特殊値として `@active` を許容する。

* **スクリーンショット系**: `screenshot`, `screenshot_ocr`
* **マウス系**: `mouse_click`, `mouse_move`, `mouse_drag`, `scroll`
* **キーボード系**: `keyboard_type`, `keyboard_press`
* **UIA系**: `click_element`, `set_element_value`, `get_ui_elements`
* **知覚系**: `perception_register` (target.match用)

### 3. 仕様詳細と優先順位

ウィンドウを特定するロジック（例: `win32.ts` 内の探索関数）において、以下の優先順位でターゲットを解決する。

1. **`hwnd` 指定（最優先）**:
   * 明示的に `hwnd` (文字列) が渡された場合は、タイトル検索をバイパスして直接そのウィンドウハンドルを対象とする。
2. **`@active` 指定（ショートカット）**:
   * `windowTitle === "@active"` が渡された場合、直ちに `win32.getForegroundHwnd()` を呼び出し、OSの現在の最前面ウィンドウをターゲットとして解決する。
3. **`windowTitle` 指定（従来通り）**:
   * 部分一致による従来の検索。

### 4. 具体的な実装ステップ（TypeScript側）

#### Step 1: ツールのパラメータスキーマ（Zod等）の拡張
各ツールのZodスキーマに `hwnd` を追加します。
```typescript
z.object({
  // 既存の windowTitle はオプショナルのまま維持（あるいは @active をドキュメント化）
  windowTitle: z.string().optional().describe("Target window title, or '@active' for foreground window"),
  hwnd: z.string().optional().describe("Direct window handle ID (takes precedence over windowTitle)"),
  // ...
})
```

#### Step 2: ウィンドウ解決ユーティリティの改修
おそらく `win32.ts` やツールハンドラの共通部分にある「指定された条件からウィンドウを探すロジック」をアップデートします。

```typescript
// 概念的なコードイメージ
export async function resolveTargetWindow(params: { hwnd?: string, windowTitle?: string }): Promise<WindowInfo> {
  // 1. hwnd指定の場合
  if (params.hwnd) {
    const win = await getWindowByHwnd(params.hwnd);
    if (!win) throw new Error(`Window with hwnd ${params.hwnd} not found`);
    return win;
  }

  // 2. @active指定の場合
  if (params.windowTitle === "@active") {
    const activeHwnd = win32.getForegroundHwnd();
    const win = await getWindowByHwnd(String(activeHwnd));
    if (!win) throw new Error("No active window found");
    return win;
  }

  // 3. 従来のタイトル検索
  if (params.windowTitle) {
    return findWindowByTitle(params.windowTitle);
  }

  // フォールバック処理...
}
```

#### Step 3: レスポンス（`post` ブロック等）への `hwnd` の露出
LLMが次回以降のアクションで `hwnd` を指定できるように、`get_windows` や `workspace_snapshot`、各アクション後の `post.focusedWindow` などの戻り値に、対象の `hwnd` を明示的に含めるようにします。

### 5. ⚠️ 実装上の注意点・ハマりどころ（エンジニアリングノートより）

* **koffiの型問題 (`intptr` のキャスト)**
  `system-overview.md` にもあった通り、koffiの `intptr` は実行時にJSの `number` (または環境によっては `bigint`) として返ってきます。比較時の `number === bigint` による常時 false バグを防ぐため、**引数として受け取る `hwnd` は `string` 型とし、内部の比較ロジックでも必ず `String(w.hwnd) === params.hwnd` のように文字列キャストして比較**してください。
* **知覚レンズ（Perception Lens）との整合性**
  すでに `target.identity` として `hwnd` や `pid` をトラッキングする仕組み（v0.11+）が入っているため、今回の `hwnd` 直接指定が、既存の Perception Guard (`target.identityStable` など) と競合しないよう、取得した `hwnd` をそのままLensのターゲットバインディングに流し込めるように連携を確認してください。
* **`@active` と `dock_window` の干渉**
  `dock_window(pin=true)` でターミナル（Claude CLI）を最前面に固定している場合、LLMが深く考えずに `@active` を使うと、**自分自身（ターミナル）をターゲットにしてしまう**危険性があります。これを防ぐため、「`@active` 解決時に `DESKTOP_TOUCH_DOCK_TITLE` に一致するウィンドウは除外（または警告）する」といったフェイルセーフを一段噛ませておくと完璧です。
