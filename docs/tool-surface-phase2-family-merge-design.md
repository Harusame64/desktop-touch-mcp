# Phase 2 設計書 — Family Merge (scroll / keyboard / clipboard / terminal / window_dock)

- Status: Draft (2026-04-25) — ユーザー approve 待ち
- 設計者: Claude (Opus 4.7)
- 実装担当: Sonnet 4.6 (起動方法は §11 + 既存 `docs/phase4b-sonnet-prompt.md` Prompt 2 を流用)
- 対応プラン: `docs/tool-surface-reduction-plan.md` §8.2 / §10 / §15 Phase 2 / §16 互換性ポリシー
- 対応 handbook: `docs/phase4b-implementation-handbook.md` §3 設計書テンプレ全 9 セクション
- 前提 Phase: Phase 1 完了 (PR #35 squash merge `2954e29`、設計書補足 `61ebc8c`)
- 並走前提: Phase 4b dogfood (vision-gpu) と独立

---

## 1. Goal

Phase 2 のゴールは、tool surface reduction plan §8.2 に従い **5 family を dispatcher 化して 13 ツール → 5 ツールに統合** すること:

| family | 旧ツール → 新 dispatcher | 統合方式 |
|---|---|---|
| **keyboard** (2 → 1) | `keyboard_type` / `keyboard_press` → **`keyboard(action='type'\|'press')`** | discriminated union |
| **clipboard** (2 → 1) | `clipboard_read` / `clipboard_write` → **`clipboard(action='read'\|'write')`** | discriminated union |
| **window_dock** (3 → 1) | `pin_window` / `unpin_window` / `dock_window` → **`window_dock(action='pin'\|'unpin'\|'dock')`** | discriminated union |
| **scroll** (4 → 1) | `scroll` / `scroll_to_element` / `smart_scroll` / `scroll_capture` → **`scroll(action='raw'\|'to_element'\|'smart'\|'capture')`** | discriminated union |
| **terminal** (2 → 1 + workflow 統合) | `terminal_read` / `terminal_send` → **`terminal(action='read'\|'send'\|'run')`** | discriminated union + new `run` action |

合計 **13 ツール → 5 ツール (62% 削減)**、能力ロスなし、breaking change として一括投入。

`focus_window` は **単独で維持** (recovery slot 主役、§7.2)。

### Phase 2 の範囲外 (Phase 3-4 で行う)

- `browser_*` リネーム後の dispatcher 化 / 役割再配置 (Phase 3)
- `events_*` / `perception_*` / `get_history` / `mouse_move` / `browser_disconnect` の入り口削除 (Phase 4)
- `screenshot_background` / `screenshot_ocr` / `scope_element` の `screenshot` 吸収 (Phase 4)
- `set_element_value` の `desktop_act` 統合 (Phase 4)
- `get_*` 系の `desktop_state` / `desktop_discover` 吸収 (Phase 4)

### terminal の `run` workflow 統合 (新機能、§4 詳述)

`run` action は `send → wait → read` を内包する high-level orchestration。LLM が 3 ツール呼びの代わりに 1 呼びで CLI command 実行 + 完了待ち + 出力取得を完結できる。完了 reason を first-class で返却:

- `quiet` — 出力が一定時間止まった (default mode)
- `pattern_matched` — 指定 regex / string にマッチ
- `timeout` — タイムアウト
- `window_closed` — ターミナル window がユーザーに閉じられた
- `window_not_found` — 起動後に window が消えた

---

## 2. Files to touch

### 新規作成

- **`src/tools/scroll.ts`** — scroll dispatcher (推定 200-300 行)
  - 4 sub-action (raw / to_element / smart / capture) を内部 handler 呼びで dispatch
  - schema は `z.discriminatedUnion("action", [...])`
- **`src/tools/window-dock.ts`** — window_dock dispatcher (推定 150-200 行)
  - 3 sub-action (pin / unpin / dock) を内部 handler 呼びで dispatch

### リネーム (公開 tool 名のみ、ファイル名据え置き)

- `src/tools/keyboard.ts` — `keyboard_type` / `keyboard_press` → `keyboard` (1 tool 登録)
  - 旧 schema (`keyboardTypeSchema` / `keyboardPressSchema`) は **internal** として残置 (handler 流用)
  - 新 export: `keyboardSchema` (discriminated union) / `keyboardHandler`
- `src/tools/clipboard.ts` — `clipboard_read` / `clipboard_write` → `clipboard` (1 tool 登録)
  - 旧 handler (`clipboardReadHandler` / `clipboardWriteHandler`) は internal helper として残置
- `src/tools/terminal.ts` — `terminal_read` / `terminal_send` → `terminal` (1 tool 登録)
  - `run` action 用の新 handler `terminalRunHandler` を追加
  - 旧 handler (`terminalReadHandler` / `terminalSendHandler`) は internal helper として残置 (run の内部で使う)

### 公開 tool 名削除 (新 dispatcher に移行)

- `src/tools/mouse.ts:699` — `server.tool("scroll", ...)` 登録を削除 (scroll.ts に移動)
  - `scrollSchema` / `scrollHandler` は scroll.ts へ move
- `src/tools/scroll-capture.ts` — `server.tool("scroll_capture", ...)` 登録削除、handler は internal export として残置
- `src/tools/smart-scroll.ts` — `server.tool("smart_scroll", ...)` 登録削除、handler は internal export として残置
- `src/tools/scroll-to-element.ts` — `server.tool("scroll_to_element", ...)` 登録削除、handler は internal export として残置
- `src/tools/dock.ts` — `server.tool("dock_window", ...)` 登録削除、handler は internal export として残置
- `src/tools/pin.ts` — `server.tool("pin_window", ...)` / `server.tool("unpin_window", ...)` 登録削除、handler は internal export として残置

### import 経路 / 呼び出し更新

- **`src/server-windows.ts`**
  - 新 import: `./tools/scroll.js` / `./tools/window-dock.js`
  - 削除 import: 不要 (scroll-capture / smart-scroll / scroll-to-element / dock / pin の register* 関数呼び出しを削除)
  - 呼び出し変更:
    - `registerScreenshotTools`, `registerMouseTools` (scroll 削除済みの mouse), `registerKeyboardTools` (1 tool に統合済み), 新規 `registerScrollTools(s)` / `registerWindowDockTools(s)`, etc.
    - 旧 `registerScrollCaptureTools` / `registerSmartScrollTools` / `registerScrollToElementTools` / `registerDockTools` / `registerPinTools` の呼び出しを削除
  - **instructions text の更新** (§4.1 設計書 Phase 1 §4.7 表に従い):
    - `## Auto-dock CLI window` 内の `dock_window` → `window_dock(action='dock')`
    - `## Scroll capture` 内の `scroll_capture` → `scroll(action='capture')`
    - `## Terminal workflow` を `terminal(action='run')` ベースに書き換え
    - `## Failure recovery` 内の `keyboard_press` / `keyboard_type` を `keyboard(action='press'|'type')` に
- **`src/stub-tool-catalog.ts`** — generator (`scripts/generate-stub-tool-catalog.mjs`) の `TOOL_FILES` を更新
  - 削除エントリ: `scroll`, `scroll_to_element`, `smart_scroll`, `scroll_capture`, `keyboard_type`, `keyboard_press`, `clipboard_read`, `clipboard_write`, `terminal_read`, `terminal_send`, `pin_window`, `unpin_window`, `dock_window` (13 件)
  - 追加エントリ: `scroll`, `keyboard`, `clipboard`, `terminal`, `window_dock` (5 件)

### テスト

- **`tests/unit/tool-naming-phase2.test.ts`** (新規) — 設計書 §6 の 13+ ケースをカバー
- **`tests/unit/tool-descriptions.test.ts`** — `TOOL_FILES` 更新 (新 dispatcher 5 + 削除 13)
- **`scripts/generate-stub-tool-catalog.mjs`** — 同様
- **既存 unit tests** — tool 名追従:
  - `tests/unit/keyboard.test.ts` (もしあれば) → `keyboard(action='type')` 形式に置換
  - `tests/unit/clipboard.test.ts` 同様
  - `tests/unit/scroll-*.test.ts` 同様
  - `tests/unit/terminal.test.ts` 同様
  - `tests/unit/dock.test.ts` / `tests/unit/pin.test.ts` 同様
  - **assertion は変更しない**、tool 名追従のみ (handbook §4.1)
- **既存 e2e tests** — tool 名追従

### docs

- **`README.md` / `README.ja.md`**
  - tool 名一覧の更新 (5 dispatcher、13 旧名削除)
  - mental model (action 指定) の説明追加
  - terminal の `run` action 例
- **`docs/system-overview.md`** — 主要 family の説明更新
- **`CHANGELOG.md`** — v1.0.0 entry に Phase 2 mapping 追記:
  - `keyboard_type` → `keyboard({action:"type", text})`
  - `keyboard_press` → `keyboard({action:"press", keys})`
  - `clipboard_read` → `clipboard({action:"read"})`
  - `clipboard_write` → `clipboard({action:"write", text})`
  - `pin_window` → `window_dock({action:"pin", title})`
  - `unpin_window` → `window_dock({action:"unpin", title})`
  - `dock_window` → `window_dock({action:"dock", title, corner, ...})`
  - `scroll` → `scroll({action:"raw", ...})`
  - `scroll_to_element` → `scroll({action:"to_element", ...})`
  - `smart_scroll` → `scroll({action:"smart", ...})`
  - `scroll_capture` → `scroll({action:"capture", ...})`
  - `terminal_read` → `terminal({action:"read", ...})`
  - `terminal_send` → `terminal({action:"send", ...})`
  - **新規**: `terminal({action:"run", input, until, timeoutMs})` で send → wait → read を内包
- **`docs/tool-surface-reduction-plan.md`** — Status を Phase 2 完了で flip (実装後)

### 削除禁止 (Phase 1 学び + handler 残置方針)

- 旧 handler 関数 (`keyboardTypeHandler` / `clipboardReadHandler` / `pinWindowHandler` / `dockWindowHandler` / `scrollHandler` / `scrollCaptureHandler` / `smartScrollHandler` / `scrollToElementHandler` / `terminalReadHandler` / `terminalSendHandler`) — internal export として残置、新 dispatcher の内部で呼ぶ
- 旧 schema 定義 (`keyboardTypeSchema` / `keyboardPressSchema` / etc.) — internal type として残置、新 dispatcher schema が参照する
- engine 層 (`src/engine/win32.ts` / `src/engine/bg-input.ts` / `src/engine/identity-tracker.js` / etc.) — Phase 4 でも触らない
- Phase 4b skeleton (vision-gpu / native engine) — 触らない
- v2 (`desktop_state` / `desktop_discover` / `desktop_act`) — Phase 1 で凍結済み、Phase 2 では触らない
- `bin/win-ocr.exe` / `PocVisualBackend` — Tier ∞ safety net

### 削除 (alias なしの即破壊 §16.1)

- 旧 13 ツールの `server.tool` 登録呼び出しのみ (handler / schema は残置)

---

## 3. API design

### 3.1. `keyboard` dispatcher

```ts
// src/tools/keyboard.ts (内部書換、ファイル名据え置き)
export const keyboardSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("type"),
    text: z.string().max(10000).describe("The text to type (max 10,000 characters)"),
    method: methodParam,
    narrate: narrateParam,
    use_clipboard: coercedBoolean().default(false).describe("..."),
    replaceAll: coercedBoolean().default(false).describe("..."),
    forceKeystrokes: coercedBoolean().default(false).describe("..."),
    windowTitle: windowTitleFocusParam,
    hwnd: hwndFocusParam,
    forceFocus: forceFocusParam,
    trackFocus: trackFocusParam,
    settleMs: settleMsParam,
    lensId: z.string().optional().describe("..."),
    fixId: z.string().optional().describe("..."),
  }),
  z.object({
    action: z.literal("press"),
    keys: z.string().max(100).describe("Key combo string, e.g. 'ctrl+c', 'alt+tab'."),
    method: methodParam,
    narrate: narrateParam,
    windowTitle: windowTitleFocusParam,
    hwnd: hwndFocusParam,
    forceFocus: forceFocusParam,
    trackFocus: trackFocusParam,
    settleMs: settleMsParam,
    lensId: z.string().optional().describe("..."),
  }),
]);

export const keyboardHandler = async (args: z.infer<typeof keyboardSchema>): Promise<ToolResult> => {
  if (args.action === "type") return keyboardTypeHandler(args);
  return keyboardPressHandler(args);
};

export function registerKeyboardTools(server: McpServer): void {
  server.tool(
    "keyboard",
    buildDesc({
      purpose: "Send keyboard input to a window: 'type' for text, 'press' for key combos.",
      details: "action='type' inserts text (auto-clipboard for non-ASCII / IME-safe). action='press' sends key combos like 'ctrl+c'/'alt+tab'.",
      prefer: "Use windowTitle to auto-focus before injection. Set lensId to enable perception guards.",
      caveats: "win+r/win+x/win+s/win+l blocked for security. Background mode (DTM_BG_AUTO=1) skips focus change.",
      examples: [
        "keyboard({action:'type', text:'hello', windowTitle:'Notepad'}) → text injected",
        "keyboard({action:'press', keys:'ctrl+c'}) → copy",
      ],
    }),
    keyboardSchema,
    keyboardHandler
  );
}
```

### 3.2. `clipboard` dispatcher

```ts
// src/tools/clipboard.ts (内部書換)
export const clipboardSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }),
  z.object({
    action: z.literal("write"),
    text: z.string().max(100_000).describe("Text to place on the clipboard"),
  }),
]);

export const clipboardHandler = async (args: z.infer<typeof clipboardSchema>): Promise<ToolResult> => {
  if (args.action === "read") return clipboardReadHandler();
  return clipboardWriteHandler(args);
};

export function registerClipboardTools(server: McpServer): void {
  server.tool(
    "clipboard",
    "Read or write the Windows clipboard. action='read' returns current text content (empty string if non-text). action='write' replaces clipboard with given text.",
    clipboardSchema,
    clipboardHandler
  );
}
```

### 3.3. `window_dock` dispatcher

```ts
// src/tools/window-dock.ts (新規)
export const windowDockSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("pin"),
    title: z.string().describe("Partial window title (case-insensitive)"),
    duration_ms: z.coerce.number().int().min(0).max(60000).optional().describe("Auto-unpin after this many ms (0–60000). Omit to pin indefinitely."),
  }),
  z.object({
    action: z.literal("unpin"),
    title: z.string().describe("Partial window title"),
  }),
  z.object({
    action: z.literal("dock"),
    title: z.string().describe("Partial window title"),
    corner: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).default("bottom-right"),
    width: z.coerce.number().int().positive().default(480),
    height: z.coerce.number().int().positive().default(360),
    pin: z.boolean().default(true),
    monitorId: z.coerce.number().int().min(0).optional(),
    margin: z.coerce.number().int().min(0).default(8),
  }),
]);

export const windowDockHandler = async (args: z.infer<typeof windowDockSchema>): Promise<ToolResult> => {
  switch (args.action) {
    case "pin": return pinWindowHandler(args);
    case "unpin": return unpinWindowHandler(args);
    case "dock": return dockWindowHandler(args);
  }
};

export function registerWindowDockTools(server: McpServer): void {
  server.tool(
    "window_dock",
    buildDesc({
      purpose: "Decorate a window: pin (always-on-top), unpin, or dock (move + resize + optional pin).",
      details: "action='pin' makes window always-on-top until unpin/duration_ms. action='dock' positions to corner with width/height (default 480x360 bottom-right).",
      prefer: "Use action='dock' for terminal/CLI window auto-positioning at session start.",
      caveats: "Pin survives minimize/restore; explicit 'unpin' needed. Dock fails on elevated processes.",
      examples: [
        "window_dock({action:'dock', title:'PowerShell', corner:'bottom-right', width:480, height:360})",
        "window_dock({action:'pin', title:'Settings', duration_ms:5000})",
      ],
    }),
    windowDockSchema,
    windowDockHandler
  );
}
```

### 3.4. `scroll` dispatcher

```ts
// src/tools/scroll.ts (新規)
export const scrollSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("raw"),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.coerce.number().int().min(1).max(100).default(3).describe("Number of wheel notches"),
    x: z.coerce.number().optional(),
    y: z.coerce.number().optional(),
    windowTitle: z.string().optional(),
    // (旧 scrollSchema の他フィールド継承)
  }),
  z.object({
    action: z.literal("to_element"),
    // (旧 scrollToElementSchema 継承)
    name: z.string().optional(),
    automationId: z.string().optional(),
    block: z.enum(["start", "center", "end"]).default("center"),
    // ...
  }),
  z.object({
    action: z.literal("smart"),
    // (旧 smartScrollSchema 継承)
    target: z.string(),
    strategy: z.enum(["text", "anchor", "auto"]).default("auto"),
    maxDepth: z.coerce.number().int().default(5),
    // ...
  }),
  z.object({
    action: z.literal("capture"),
    // (旧 scrollCaptureSchema 継承)
    windowTitle: z.string(),
    direction: z.enum(["down", "up"]).default("down"),
    maxScrolls: z.coerce.number().int().default(10),
    grayscale: z.boolean().default(false),
    // ...
  }),
]);

export const scrollHandler = async (args: z.infer<typeof scrollSchema>): Promise<ToolResult> => {
  switch (args.action) {
    case "raw": return rawScrollHandler(args);          // 旧 mouse.ts の scrollHandler
    case "to_element": return scrollToElementHandler(args);
    case "smart": return smartScrollHandler(args);
    case "capture": return scrollCaptureHandler(args);
  }
};

export function registerScrollTools(server: McpServer): void {
  server.tool(
    "scroll",
    buildDesc({
      purpose: "Scroll a window or page. 4 strategies via action: 'raw' (wheel notches), 'to_element' (UIA name/automationId), 'smart' (auto-detect target), 'capture' (full-page stitched image).",
      details: "Use 'to_element' or 'smart' for click target out-of-viewport recovery (entity_outside_viewport). Use 'capture' for reading long pages.",
      prefer: "Recovery slot §7.2 main: action='to_element' or 'smart' before re-calling desktop_discover.",
      caveats: "action='capture' returns stitched image, may downscale (sizeReduced=true) — for reading only, not click coords.",
      examples: [
        "scroll({action:'raw', direction:'down', amount:5, windowTitle:'Chrome'})",
        "scroll({action:'to_element', name:'OK', windowTitle:'Dialog'})",
        "scroll({action:'capture', windowTitle:'Chrome', maxScrolls:10})",
      ],
    }),
    scrollSchema,
    scrollHandler
  );
}
```

### 3.5. `terminal` dispatcher (with `run` workflow)

```ts
// src/tools/terminal.ts (内部書換)
export const terminalSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("read"),
    // (旧 terminalReadSchema 継承)
    windowTitle: z.string().max(200),
    lines: z.coerce.number().int().min(1).max(2000).default(50),
    sinceMarker: z.string().max(64).optional(),
    stripAnsi: z.boolean().default(true),
    source: z.enum(["auto", "uia", "ocr"]).default("auto"),
    ocrLanguage: z.string().max(20).default("ja"),
  }),
  z.object({
    action: z.literal("send"),
    // (旧 terminalSendSchema 継承)
    windowTitle: z.string().max(200),
    input: z.string().max(10000),
    method: z.enum(["auto", "background", "foreground"]).default("auto"),
    chunkSize: z.number().int().min(1).max(10000).default(100),
    pressEnter: z.boolean().default(true),
    focusFirst: z.boolean().default(true),
    restoreFocus: z.boolean().default(true),
    preferClipboard: z.boolean().default(true),
    pasteKey: z.enum(["auto", "ctrl+v", "ctrl+shift+v"]).default("auto"),
    forceFocus: z.boolean().optional(),
    trackFocus: z.boolean().default(true),
    settleMs: z.coerce.number().int().min(0).max(2000).default(300),
  }),
  z.object({
    action: z.literal("run"),
    // 新 schema (§4 詳細)
    windowTitle: z.string().max(200),
    input: z.string().max(10000).describe("Command to send (Enter is appended automatically)"),
    until: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("quiet"), quietMs: z.coerce.number().int().min(50).max(30000).default(800).describe("Stop when output is silent for this many ms") }),
      z.object({ mode: z.literal("pattern"), pattern: z.string().describe("Stop when output matches this regex (or string)"), regex: z.boolean().default(false) }),
      // 'snapshot' は将来追加候補
    ]).default({ mode: "quiet", quietMs: 800 }),
    timeoutMs: z.coerce.number().int().min(500).max(600_000).default(30_000).describe("Hard timeout (default 30s)"),
    sendOptions: z.object({ ... }).optional().describe("Forwarded to terminal_send (method, chunkSize, etc.)"),
    readOptions: z.object({ ... }).optional().describe("Forwarded to terminal_read (lines, source, ocrLanguage)"),
  }),
]);

export const terminalHandler = async (args: z.infer<typeof terminalSchema>): Promise<ToolResult> => {
  switch (args.action) {
    case "read": return terminalReadHandler(args);
    case "send": return terminalSendHandler(args);
    case "run": return terminalRunHandler(args);
  }
};

export function registerTerminalTools(server: McpServer): void {
  server.tool(
    "terminal",
    buildDesc({
      purpose: "Interact with a terminal window: read output, send input, or run+wait+read in one call.",
      details: "action='run' is the recommended high-level workflow: send command → wait until quiet/pattern/timeout → read output. Returns completion={reason, ...} first-class.",
      prefer: "action='run' for command execution + result. Use action='read'/'send' for fine-grained control.",
      caveats: "Do not screenshot the terminal — terminal(action='read') is cheaper and structured. action='run' supports completion reasons: quiet | pattern_matched | timeout | window_closed | window_not_found.",
      examples: [
        "terminal({action:'run', windowTitle:'PowerShell', input:'npm test', until:{mode:'pattern', pattern:'npm test:'}}) → {output, completion:{reason:'pattern_matched'}}",
        "terminal({action:'run', windowTitle:'pwsh', input:'ls'}) → quiet 800ms wait, returns output",
      ],
    }),
    terminalSchema,
    terminalHandler
  );
}
```

---

## 4. terminal `run` workflow 詳細仕様

### 4.1. レスポンス schema

```ts
interface TerminalRunResponse {
  ok: boolean;
  output: string;        // captured stdout/stderr (post-input, post-Enter)
  completion: {
    reason: "quiet" | "pattern_matched" | "timeout" | "window_closed" | "window_not_found";
    elapsedMs: number;
    matchedPattern?: string;  // when reason='pattern_matched'
  };
  marker?: string;       // sinceMarker for next call (incremental polling)
  warnings?: string[];   // focusLost, ForceFocusRefused, etc.
  hwnd?: string;
}
```

### 4.2. 実装フロー

1. **send phase**: 旧 `terminalSendHandler` を呼ぶ
   - `windowTitle` で terminal を解決
   - `input` を送信、`pressEnter: true` で Enter 押下
   - 失敗時 → `ok:false, completion:{reason:'window_not_found'}`
   - 送信直後に sinceMarker を生成 (timestamp + hash 等)
2. **wait phase**: `until` mode に応じて wait_until を内部使用
   - `mode='quiet'`: 出力が `quietMs` (default 800ms) 静止するまで待つ
     - 内部で `terminalReadHandler` を 200ms 間隔で polling、前回 output と diff を比較
   - `mode='pattern'`: 出力に regex / string がマッチするまで待つ
     - `pattern` を `terminalReadHandler` の output に対して match
   - **timeout 監視**: `timeoutMs` を超えたら interrupt → `completion:{reason:'timeout'}`
   - **window_closed 監視**: 200ms 間隔で `enumWindowsInZOrder` で hwnd 存続確認、消えたら interrupt → `completion:{reason:'window_closed'}`
3. **read phase**: 完了後 `terminalReadHandler` で最終 output を取得
   - `sinceMarker` で incremental diff
   - `output` フィールドにテキスト返却

### 4.3. 既存 `wait_until(terminal_output_contains, ...)` との関係

- `wait_until(condition='terminal_output_contains', pattern=...)` は引き続き存在 (Phase 2 範囲外、Phase 4 で見直し候補)
- `terminal({action:'run'})` は `wait_until` の終端条件を内部に取り込む形
- LLM が `terminal({action:'run', until:{mode:'pattern', pattern:'...'}})` を呼ぶと、3 ツール (`send` + `wait_until` + `read`) を 1 呼びで完結
- 旧 workflow `terminal_send → wait_until → terminal_read(sinceMarker)` も明示的に呼びたければ `terminal({action:'send'}) → wait_until(...) → terminal({action:'read', sinceMarker})` で動作

### 4.4. completion reason の優先順位

複数の終端条件が同時に発火した場合の優先順位:

1. `window_closed` (highest) — ユーザー操作で window 消失、安全に止める
2. `window_not_found` — send 後に window が消えた稀ケース
3. `pattern_matched` — 明示的な完了条件
4. `quiet` — silence-based 完了
5. `timeout` (lowest) — fallback

---

## 5. Done criteria (binary check)

- [ ] `tsc --noEmit` exit 0
- [ ] `npm run test:capture > .vitest-out.txt` (vitest unit) 全パス、regression 0
- [ ] `tools/list` RPC で旧名 13 件すべて出ない:
  - 旧名: `keyboard_type` / `keyboard_press` / `clipboard_read` / `clipboard_write` / `pin_window` / `unpin_window` / `dock_window` / `scroll_to_element` / `smart_scroll` / `scroll_capture` / `terminal_read` / `terminal_send` (12 件) + 旧 `scroll` (mouse.ts から移動済、新 dispatcher として再登場)
  - grep `server.tool("旧名"` で 0 件
- [ ] `tools/list` RPC で新 5 dispatcher が登場: `keyboard` / `clipboard` / `window_dock` / `scroll` / `terminal`
- [ ] `src/stub-tool-catalog.ts` の旧名エントリ 0 件、新 5 dispatcher エントリあり
- [ ] `tests/unit/tool-descriptions.test.ts` の TOOL_FILES 期待値が更新済
- [ ] `src/server-windows.ts` の instructions 内に旧名の文字列 0 件 (Phase 1 §4.7 表に従い該当 section 全更新)
- [ ] **LLM 露出文字列の旧名残留 0 件 (Phase 1 学び反映)**
  - 全件 grep: `grep -r "keyboard_type\|keyboard_press\|clipboard_read\|clipboard_write\|pin_window\|unpin_window\|dock_window\|scroll_to_element\|smart_scroll\|scroll_capture\|terminal_read\|terminal_send" src/` で 0 件 (コメント内は許容、Phase 4 で対応)
  - ただし `description` / `suggest[]` / `error.message` / engine 層 literal type は **0 件必須**
- [ ] `README.md` / `README.ja.md` / `docs/system-overview.md` の旧名 mention 0 件
- [ ] `CHANGELOG.md` v1.0.0 entry に Phase 2 mapping 追記 (13 旧名 → 5 dispatcher action)
- [ ] handler 残置対象 (旧 handler / schema、events_* / perception_* 等の Phase 4 対象) のコードに変更 0 (handler 関数 export は internal として残す)
- [ ] terminal `run` action の `completion.reason` enum 5 値全部の挙動確認 (テスト)
- [ ] **E2E テストは PR 提出直前に 1 回のみ** (再実行は Opus 委譲、memory `feedback_sonnet_e2e_twice_delegate.md`)

---

## 6. Test cases (最低カバー要件)

`tests/unit/tool-naming-phase2.test.ts` を新規作成し、最低以下を含む:

### 正常系 (5 dispatcher の register 確認 + sub-action equivalence)

1. **`keyboard({action:'type', text})` ≡ 旧 `keyboard_type({text})`** — handler 出力が同一
2. **`keyboard({action:'press', keys})` ≡ 旧 `keyboard_press({keys})`**
3. **`clipboard({action:'read'})` ≡ 旧 `clipboard_read()`**
4. **`clipboard({action:'write', text})` ≡ 旧 `clipboard_write({text})`**
5. **`window_dock({action:'pin', title, duration_ms})` ≡ 旧 `pin_window`**
6. **`window_dock({action:'unpin', title})` ≡ 旧 `unpin_window`**
7. **`window_dock({action:'dock', title, corner, width, height, pin, monitorId, margin})` ≡ 旧 `dock_window`**
8. **`scroll({action:'raw', direction, amount})` ≡ 旧 `scroll`**
9. **`scroll({action:'to_element', name, ...})` ≡ 旧 `scroll_to_element`**
10. **`scroll({action:'smart', target, ...})` ≡ 旧 `smart_scroll`**
11. **`scroll({action:'capture', windowTitle, ...})` ≡ 旧 `scroll_capture`**
12. **`terminal({action:'read', windowTitle, ...})` ≡ 旧 `terminal_read`**
13. **`terminal({action:'send', windowTitle, input, ...})` ≡ 旧 `terminal_send`**

### 失敗系 (旧名の不在)

14. 旧 13 ツール名が `tools/list` に出ない (grep / RPC レベル)
15. 旧名で `server.tool(...)` 呼び出しが 0 件 (registration レベル)

### 境界 (terminal `run` action)

16. **`terminal({action:'run', input, until:{mode:'quiet'}})`**: 出力が 800ms 静止したら `completion.reason = 'quiet'`
17. **`terminal({action:'run', input, until:{mode:'pattern', pattern:'foo'}})`**: 出力に 'foo' が現れたら `completion.reason = 'pattern_matched', matchedPattern: 'foo'`
18. **`terminal({action:'run', input, timeoutMs:500})`**: 500ms で `completion.reason = 'timeout'`
19. **`terminal({action:'run', ...})` で window が消えた場合**: `completion.reason = 'window_closed'` または `'window_not_found'`

### regression (Phase 1 学び)

20. **`tool-descriptions.test.ts`**: TOOL_FILES に新 5 dispatcher が含まれ、旧 13 が含まれない
21. **stub catalog 整合**: 新 dispatcher 5 件の name + description が `tools/list` と一致

### LLM 露出文字列 audit (新規 lint テスト推奨、Sonnet 判断 §8 範囲)

22. **grep test**: `src/` 配下で旧 13 名のうち description / suggest / error.message / literal type に登場するものが 0 件 (コメントは許容)

---

## 7. Known traps

### 7.1. discriminated union の Zod schema export

Zod `discriminatedUnion` を MCP server.tool に渡す際、schema が **z.object({...}) でなく z.ZodDiscriminatedUnion** になるため、MCP SDK の型推論が壊れる可能性。

対応: `keyboardSchema` を直接渡すのではなく、**inputSchema として MCP 用に shape を抽出する** か、`z.input()` で型を取り出す。Phase 1 では schema は z.object shape (record) を渡していたが、discriminated union は z.ZodSchema 直で渡す形になる。SDK の `.tool(name, desc, schema, handler)` の `schema` param が `ZodRawShape | ZodSchema` を許容するか要確認。

調査箇所: `node_modules/@modelcontextprotocol/sdk/server/mcp.d.ts` の `tool()` メソッド signature。

### 7.2. terminal `run` の `wait_until` 内部呼び出し

`wait_until(terminal_output_contains, pattern, timeoutMs)` の existing tool は引き続き登録される。`terminal({action:'run'})` 内部で wait_until を呼ぶか、独立に polling logic を書くか:

- **独立 polling 推奨**: `wait_until` の overhead (subscription / event-bus) を経由するより、`run` 内部で直接 setInterval + diff チェックの方が単純で predictable
- ただし memory `project_e2e_infra.md` の wait_until 既存 e2e との互換性を保つため、wait_until 自体は別途維持

### 7.3. `scroll` action='capture' の image return

旧 `scroll_capture` は `screenshot` と同様 image 返却。dispatcher 経由でも image binary を返せるか? MCP `ToolResult` は `content` array で image MIME type をサポート (memory 不要)。問題なし。

ただし、**scroll dispatcher の description が肥大化** (4 action 全部の examples + caveats) するため、Sonnet が description を簡潔に保つ判断が必要。Phase 1 の `screenshot` と同様の規模感 (1 tool で多 mode) を目安。

### 7.4. terminal `run` の completion reason `window_closed` 検出

`enumWindowsInZOrder` の polling (200ms) で hwnd 存続確認するが、**race condition**: send 直後に window が閉じられた場合、polling 開始前に消える可能性。

対応: `terminalSendHandler` から hwnd を返却し、`run` 内で **送信前後の hwnd 一致** を確認 (送信後の最初の poll で hwnd が一致しなければ `window_closed` 判定)。

### 7.5. discriminated union での `default()` 動作

Zod discriminated union の各 variant 内で `.default()` を使うと、action が指定されない場合に validation エラーになるか? 

対応: action は **必須フィールド** (default 不可)、各 variant 内の他フィールドは `.default()` OK。schema docstring で「action は必須」を明記。

### 7.6. tests/unit/keyboard-press.test.ts 等の旧名参照

既存 unit test に `keyboardTypeHandler` / `keyboardPressHandler` 直接呼びが多数。Phase 2 では handler 関数名を維持 (internal export として残す) ので **assertion 変更なし、import path 変更なし**。tool 名 (`"keyboard_type"` 等の文字列リテラル) を含む test のみ追従修正。

### 7.7. e2e tests/e2e/keyboard.test.ts 等

e2e で `keyboard_type` / `keyboard_press` を server.callTool 経由で呼んでいる場合、新名 `keyboard({action:'type', ...})` に置換必要。assertion は変更しない (handbook §4.1)。

### 7.8. Phase 4b dogfood との衝突

dogfood は vision-gpu / native engine 中心で、Phase 2 family は touch しないため独立。ただし dogfood の e2e benchmark で `terminal_send` / `keyboard_type` を使っている可能性 → Phase 2 PR merge 後に dogfood が壊れていないか要確認 (Phase 5 dogfood 段階で網羅)。

### 7.9. dock + pin の合成 action (`dock` の中の `pin: true`)

旧 `dock_window` は `pin: true` で内部的に `setWindowTopmost` も呼ぶ (= dock + pin 合成)。新 schema では `window_dock({action:'dock', pin:true, ...})` で同等動作を維持。**`pin: true` を default に保つ** (旧挙動踏襲)。

### 7.10. Phase 1 学び: LLM 露出文字列の audit 必須

Phase 2 終了前に必ず以下を実行:
```
grep -r "keyboard_type\|keyboard_press\|clipboard_read\|clipboard_write\|pin_window\|unpin_window\|dock_window\|scroll_to_element\|smart_scroll\|scroll_capture\|terminal_read\|terminal_send" src/
```
コメント内は許容、`description` / `suggest[]` / `error.message` / `literal type` は 0 件必須。Phase 1 で `_action-guard.ts` / `_errors.ts` / `mouse.ts` 等に旧名残留があった同じパターンを Phase 2 でも防ぐ。

---

## 8. Acceptable Sonnet judgment scope

設計書内で Sonnet が決めて良い:

- **dispatcher schema の Zod 型細部** (例: `z.discriminatedUnion` vs `z.union` の choice、`.default()` の有無、optional 配置)
- **handler 内 log message の置換** (例: `[keyboard_type]` → `[keyboard:type]`)
- **export 名 (TS symbol)** のリネーム判断 (例: `keyboardTypeHandler` を `keyboardTypeAction` に rename するなど、ただし既存 test がある場合は維持推奨)
- **コメント / docstring 追加 / 翻訳調整**
- **lint warning 修正**
- **import 順序の整理**
- **追加テストケース** (本書 §6 の最低 22 ケース + α は OK)
- **e2e テスト内の tool 名置換** (assertion は変更しない)
- **commit 分割粒度** (2a/2b/2c の 3 commit、または機能単位で 5 commit でも OK、PR は 1 つ)
- **terminal `run` の polling interval** (200ms 推奨だが 100-500ms 範囲で調整可)
- **scroll dispatcher の description 文字数調整** (簡潔さ優先)

---

## 9. Forbidden Sonnet judgments

Sonnet が独自に決めてはいけない (Phase 1 §9 の例外条項を引き継ぐ):

- **tool 登録名の変更** (本書 §3 で固定: `keyboard` / `clipboard` / `window_dock` / `scroll` / `terminal`)
- **action enum 値の変更** (`type`/`press` / `read`/`write` / `pin`/`unpin`/`dock` / `raw`/`to_element`/`smart`/`capture` / `read`/`send`/`run` を一字一句変えない)
- **terminal `run` の completion reason enum の変更** (`quiet`/`pattern_matched`/`timeout`/`window_closed`/`window_not_found` 5 値を固定)
- **schema 構造の大幅変更** (旧 schema のフィールド名・型を保つ、フィールド追加 / 削除 / 型変更禁止 — Phase 4 で行う)
  - **★ 例外**: discriminated union 化に伴う Zod schema 構造変更は §3 で定義済の必須化なので Forbidden に該当しない
- **handler ロジックの変更** (旧 handler を新 dispatcher 内部から呼ぶ wrapping 以外の動作変更禁止)
  - **★ 例外**: `terminal({action:'run'})` の新規実装は §4 を満たすために必要
- **handler 残置対象 (`events_*` / `perception_*` / `get_history` / `mouse_move` / `browser_disconnect` / 他 Phase 4 対象) のファイル変更**
- **engine 層 (`src/engine/event-bus.ts` / `src/engine/perception/registry.ts` / `src/engine/win32.ts` / 他) の変更**
  - **★ 例外 (Phase 1 §9 と同基準)**: engine 層のうち **LLM レスポンスに直接出力される literal type / suggest 文字列** は旧名 → 新名置換が必要
  - 全件 grep で `keyboard_type|keyboard_press|clipboard_read|clipboard_write|pin_window|unpin_window|dock_window|scroll_to_element|smart_scroll|scroll_capture|terminal_read|terminal_send` が `src/` 配下 (コメント除く) で 0 件になるまで置換
- **既存テストの assertion 緩和** (handbook §4.1)
- **Phase 4b skeleton (vision-gpu / native engine) の変更**
- **Phase 1 で凍結した v2 (`desktop_state` / `desktop_discover` / `desktop_act`) の変更**
- **`src/version.ts` / `package.json:version` の変更** (v1.0.0 release は Phase 5 完了後)
- **`bin/launcher.js` / `.github/workflows/release.yml` の変更**
- **alias / deprecation 機構の追加** (即破壊と確定 §16.1)
- **stub-tool-catalog.ts の手動編集** (generator 経由のみ)
- **新規 tool 追加** (Phase 2 は dispatcher 化のみ、5 新名以外の tool 追加禁止)

これらに該当する判断が必要になったら、即 Opus 委譲 (handbook §5 stop conditions)。

---

## 10. サブ batch 分割と実装順序

Phase 2 は規模が大きいため、3 サブ batch に分けて段階実装:

### Phase 2a: Simple dispatcher (commit 1) — keyboard / clipboard / window_dock

- 新規 `src/tools/window-dock.ts` 作成 (3 sub-action 統合)
- `src/tools/keyboard.ts` 内で `keyboard` dispatcher 化 (旧 2 tool 削除、新 1 tool 追加)
- `src/tools/clipboard.ts` 内で `clipboard` dispatcher 化
- `src/server-windows.ts` の register 呼び出し更新 (registerPinTools / registerDockTools 削除、registerWindowDockTools 追加)
- 関連 unit/e2e test の tool 名追従
- 検証: `tsc --noEmit` + `npm run test:capture` 全パス

### Phase 2b: Scroll dispatcher (commit 2)

- 新規 `src/tools/scroll.ts` 作成 (4 sub-action 統合: raw / to_element / smart / capture)
- `src/tools/mouse.ts:699` から `server.tool("scroll", ...)` 削除、scrollSchema/scrollHandler を scroll.ts へ move
- `src/tools/scroll-capture.ts` / `smart-scroll.ts` / `scroll-to-element.ts` の `server.tool` 呼び出しを削除 (handler は internal export として残置)
- `src/server-windows.ts` の register 呼び出し更新 (registerScrollCaptureTools / registerSmartScrollTools / registerScrollToElementTools 削除、registerScrollTools 追加)
- 関連 unit/e2e test の tool 名追従
- 検証: `tsc --noEmit` + `npm run test:capture` 全パス

### Phase 2c: Terminal dispatcher + `run` workflow (commit 3)

- `src/tools/terminal.ts` 内で `terminal` dispatcher 化 (read / send / run の 3 sub-action)
- 新規 `terminalRunHandler` 実装 (§4 仕様)
- `src/server-windows.ts` の register 呼び出し更新 (terminalSchema 1 つに統合)
- 新規テスト: `terminal({action:'run', ...})` の 4 完了 reason (quiet / pattern_matched / timeout / window_closed) のうち少なくとも 3 つを unit test でカバー (window_closed は e2e)
- 既存 unit/e2e test の tool 名追従
- 検証: `tsc --noEmit` + `npm run test:capture` 全パス

### Phase 2d: Final polish (commit 4)

- `src/server-windows.ts` の instructions text を Phase 1 §4.7 表に従い該当 section 更新
  - `## Auto-dock CLI window` → `window_dock(action='dock')` 形式
  - `## Scroll capture` → `scroll(action='capture')` 形式
  - `## Terminal workflow` → `terminal(action='run')` 形式
  - `## Failure recovery` → 新 dispatcher 名
- `src/stub-tool-catalog.ts` を generator 経由で再生成
- `tests/unit/tool-descriptions.test.ts` の TOOL_FILES 期待値更新
- `README.md` / `README.ja.md` / `docs/system-overview.md` の旧 13 名 mention を新 dispatcher 名に
- `CHANGELOG.md` に v1.0.0 entry の Phase 2 mapping 追記 (13 旧名 → 5 dispatcher action 表)
- `docs/tool-surface-reduction-plan.md` の Status を「Phase 2 Implemented」に flip + commit hash 記載
- 検証: 全 Done criteria (§5) を確認、最後に **E2E 1 回実施**

### 順序 (絶対遵守)

1. Phase 2a → tsc + test pass → commit
2. Phase 2b → tsc + test pass → commit
3. Phase 2c → tsc + test pass → commit
4. Phase 2d → 全 Done criteria pass → commit + LLM 露出文字列 grep audit + E2E 1 回 → PR 提出

各 commit は **stand-alone で動作する** ことが必須 (旧 tool 登録削除と新 dispatcher 登録は同 commit)。

---

## 11. 実装着手 prompt (Sonnet)

`docs/phase4b-sonnet-prompt.md` Prompt 2 を流用しつつ、本 Phase 2 用に context 差し替え。Phase 1 と同じ構造、E2E 2 回目 Opus 委譲ルール (memory `feedback_sonnet_e2e_twice_delegate.md`) を引き継ぐ。

```text
あなたは Sonnet 4.6、desktop-touch-mcp プロジェクトの Phase 2 (Tool Surface Reduction — Family Merge) の実装担当です。

## 起動直後に必ず読むこと (この順序)

1. D:/git/desktop-touch-mcp/docs/tool-surface-phase2-family-merge-design.md
   ← これが今回の唯一の真実。これに書いてないことはやらない。
2. D:/git/desktop-touch-mcp/docs/phase4b-implementation-handbook.md §4 / §5
3. D:/git/desktop-touch-mcp/CLAUDE.md 強制命令 1-7
4. D:/git/desktop-touch-mcp/docs/tool-surface-reduction-plan.md §8.2 / §10 / §15 / §16
5. (参考) Phase 1 の学び: D:/git/desktop-touch-mcp/docs/tool-surface-phase1-naming-design.md §9 例外条項

## 実装ルール / Stop conditions / 触れていけないこと

(Phase 1 prompt と同様、§5 / §9 を参照)

## サブ batch 順序 (絶対遵守)

Phase 2a (keyboard/clipboard/window_dock) → Phase 2b (scroll) → Phase 2c (terminal+run) → Phase 2d (polish + audit)

各 sub batch ごとに tsc + npm run test:capture (vitest unit) で regression 0 確認。
E2E は Phase 2d 完了直前に 1 回のみ、再実行は Opus 委譲。

## ブランチ

`tool-surface-v1-phase2` (新規作成、main から分岐)

## PR 提出

PR title: `refactor: Phase 2 — Family merge (5 dispatchers, 13→5 tools, v1.0.0 prep)`
PR body: 設計書参照 / Done criteria / sub batch 構成 / 13→5 mapping 表 / breaking change 警告

## 完了報告

handbook §6.1 フォーマット + notification_show
```

---

## 12. 想定 diff size

- Phase 2a: 約 300-400 行 diff (keyboard/clipboard schema 統合 + window-dock.ts 新規)
- Phase 2b: 約 300-400 行 diff (scroll.ts 新規 + 4 ファイル登録削除)
- Phase 2c: 約 400-600 行 diff (terminal dispatcher + terminalRunHandler 新規実装 + completion reason logic)
- Phase 2d: 約 300-400 行 diff (instructions + stub catalog + README + tests + CHANGELOG)
- **合計: 約 1300-1800 行 diff** (Phase 1 より大規模、`run` workflow が新規実装のため)

---

## 13. Risk と対応

| Risk | 影響 | 対応 |
|---|---|---|
| Zod discriminatedUnion と MCP SDK の型推論ミスマッチ | High | §7.1 で SDK signature 確認、Phase 2a 着手時に最初にプロトタイプ確認 |
| `terminal({action:'run'})` の polling race (window_closed 早期検出失敗) | Medium | §7.4 で send 後の hwnd 一致確認 logic |
| `scroll(action='capture')` の image return が dispatcher 経由で正しく返るか | Medium | MCP ToolResult content array で image MIME 動作、§7.3 |
| 既存 e2e tests の旧名参照 (約 13 ファイル想定) | Medium | Phase 2a 着手時に grep で網羅 + 各 batch で追従 |
| LLM 露出文字列の旧名残留 (Phase 1 同パターン) | High | §10 Phase 2d で必ず grep audit、§9 Forbidden 例外で engine 層 LLM 露出 type 対応 |
| `terminal({action:'run'})` の `wait_until` との重複 | Low | §7.2 で独立 polling 実装、wait_until は維持 |
| Phase 4b dogfood への影響 | Low | family は dogfood と独立、Phase 5 dogfood で再確認 |

---

## 14. Status

**Status: Draft (2026-04-25)** — ユーザー approve 待ち

実装着手は **ユーザー approve 後**。Sonnet 起動 prompt は §11、起動 tool は `Agent` with `subagent_type=general-purpose` + `model=sonnet`。

完了後 Opus レビューは別 subagent (`docs/phase4b-sonnet-prompt.md` Prompt 3 を流用、context は本設計書 + Phase 2 implementation diff)。

---

END OF DESIGN.
