# Phase 3 設計書 — Browser 再配置 (launch 吸収 / eval 拡張 / disconnect 非公開化)

- Status: **Implemented** (PR #40 merged into main 2026-04-26)
- 設計者: Claude (Opus 4.7)
- 実装担当: 判断系 batch は Opus 直 / 機械的 batch のみ Sonnet 委譲 (§9 サブ batch 表参照)
- レビュー: Opus 自己レビュー → Codex (PR 提出後)
- 対応プラン: `docs/tool-surface-reduction-plan.md` §8.3 / §9 / §15 Phase 3 / §16 互換性ポリシー
- 対応 handbook: `docs/phase4b-implementation-handbook.md` §3 設計書テンプレ全 9 セクション
- 前提 Phase: Phase 1 + Phase 2 完了 (PR #35 / #36 / #37 / #38 / #39 全 main 入り)
- 前提 docs: `docs/tool-surface-known-issues.md` §3 (Phase 3 で対応する事項)
- 並走前提: Phase 4b dogfood (vision-gpu) と独立、main `0dd5e14` から分岐

---

## 1. Goal

Phase 3 のゴールは、tool surface reduction plan §9 / §15 Phase 3 に従い **browser family の役割を再配置し 13 ツール → 9 ツールに整理** すること:

| 旧ツール | 新形式 | 統合方式 |
|---|---|---|
| `browser_launch` | `browser_open({launch: {...}})` | **吸収** (optional launch param) |
| `browser_get_dom` | `browser_eval({action: 'dom', selector, maxLength})` | **吸収** (discriminatedUnion) |
| `browser_get_app_state` | `browser_eval({action: 'appState', selectors, maxBytes})` | **吸収** (discriminatedUnion) |
| `browser_disconnect` | (非公開化、handler 残置) | **入り口削除のみ** |

合計 **13 → 9 (-4 ツール、約 31% 削減)**、能力ロスなし、breaking change として一括投入。

### 公開後の browser family (9 ツール)

| 格付け (plan §12) | tool |
|---|---|
| 主役 (5) | `browser_open` / `browser_navigate` / `browser_click` / `browser_fill` / `browser_form` |
| 補助 (3) | `browser_search` / `browser_overview` / `browser_locate` |
| 上級 (1) | `browser_eval` (action='js'/'dom'/'appState') |

### Phase 3 の範囲外 (Phase 4 で行う)

- `events_*` / `perception_*` / `get_history` / `mouse_move` の入り口削除
- `screenshot_background` / `screenshot_ocr` / `scope_element` の `screenshot` 吸収
- `set_element_value` の `desktop_act` 統合
- `get_*` 系の `desktop_state` / `desktop_discover` 吸収
- `run_macro` DSL の `TOOL_REGISTRY` 新名移行 (Phase 2 §2.1 引継ぎ)
- コメント内旧名 polish (Phase 1 §1.1 / Phase 2 §2.5 引継ぎ)

---

## 2. Files to touch

### 主編集 (公開面)

- **`src/tools/browser.ts`** (1927 行)
  - 削除: `server.tool("browser_launch", ...)` / `server.tool("browser_get_dom", ...)` / `server.tool("browser_get_app_state", ...)` / `server.tool("browser_disconnect", ...)` 登録 4 件
  - 書換: `browser_open` の schema を `browserOpenSchema` (旧 `browserConnectSchema` リネーム) に拡張、`launch` optional フィールド追加
  - 書換: `browser_eval` の schema を `z.discriminatedUnion("action", [...])` 化 (action='js'/'dom'/'appState')
  - 新規 dispatcher: `browserOpenHandler` (旧 `browserConnectHandler` リネーム + launch 分岐)、`browserEvalDispatchHandler` (action 分岐で内部 handler を呼ぶ)
  - 残置 (internal export): `browserConnectHandler` / `browserLaunchHandler` (browser_open 内部実装)、`browserEvalHandler` / `browserGetDomHandler` / `browserGetAppStateHandler` (browser_eval 内部実装)、`browserDisconnectHandler` (test/将来 facade 用)
  - 残置 schema: `browserConnectSchema` (旧名、内部 type 用)、`browserLaunchSchema` (内部 type 用)、`browserGetDomSchema` / `browserGetAppStateSchema` / `browserDisconnectSchema`

### 主編集 (LLM 露出文字列)

- **`src/tools/_errors.ts:49-53`** — `BrowserNotConnected` の suggest 配列内 `browser_launch` 言及を `browser_open({launch:{}})` に書換
  - 旧: `"Use browser_launch to open a new debugging-enabled Chrome instance"`
  - 新: `"Or call browser_open({launch:{}}) to spawn a debug-mode Chrome on the configured port"`
- **`src/tools/desktop-state.ts:282`** — description 内 `browser_get_dom` 言及を `browser_eval({action:'dom'})` に書換
  - 旧: `"Far cheaper than browser_get_dom for page orientation."`
  - 新: `"Far cheaper than browser_eval({action:'dom'}) for page orientation."`

### MCP server instructions

- **`src/server-windows.ts`** (browser 言及 2 箇所)
  - `browser_click(selector)` (line 91) — 変更不要 (tool 名そのまま)
  - `executor_failed → fall back to click_element / mouse_click / browser_click` (line 101) — 変更不要
  - **新規追加**: browser workflow 短い説明 (line 91 の直後または末尾) に `browser_open({launch:{}})` 1 行と `browser_eval({action:'dom'})` 言及を追加候補 → §3.5 参照

### Stub catalog

- **`scripts/generate-stub-tool-catalog.mjs`**
  - `TOOL_FILES` 変更不要 (既に `browser.ts` を含む)
  - 削除エントリ自動生成: `browser_launch` / `browser_get_dom` / `browser_get_app_state` / `browser_disconnect`
  - 残るエントリ: `browser_open` / `browser_eval` / `browser_search` / `browser_overview` / `browser_locate` / `browser_click` / `browser_navigate` / `browser_fill` / `browser_form` (9 件)
- **`src/stub-tool-catalog.ts`** — 自動再生成 (`node scripts/generate-stub-tool-catalog.mjs`)

### Tests

- **`tests/unit/tool-naming-phase3.test.ts`** (新規) — Phase 1+2 のテストパターン踏襲、§6 の 8 ケース
- **`tests/unit/tool-descriptions.test.ts`** — `expectedTools` 更新 (`browser_launch` / `browser_get_dom` / `browser_get_app_state` / `browser_disconnect` を期待値から削除)
- **`tests/e2e/browser-app-state.test.ts`** — describe 名 `browser_get_app_state` を `browser_eval({action:'appState'})` に追従、内部 handler 直呼びへ切替 (assertion 不変)
- **`tests/e2e/browser-tab-context.test.ts`** — `browser_get_dom` 言及を `browser_eval({action:'dom'})` に追従
- **`tests/e2e/browser-cdp.test.ts`** — コメント内 `browser_get_dom` 言及を新形式に
- **`tests/e2e/browser-connect-active.test.ts`** — `browser_open({launch:{}})` の launch path 動作確認 1 ケース追加 (Chrome 既起動時の idempotent 動作 + 未起動時の spawn 動作)
- **既存 unit/e2e tests** — assertion 変更禁止、tool 名追従のみ (handbook §4.1)

### Docs

- **`README.md`** — テーブル (line 169-181)、workflow 例 (line 240-265)、tab context troubleshooting (line 741) を新形式に書換
- **`README.ja.md`** — 同様
- **`docs/system-overview.md`** — browser family の説明更新 (現状確認後の差分のみ)
- **`docs/tool-surface-reduction-plan.md`** — §15 Phase 3 status を Implemented に flip (実装後)
- **`docs/tool-surface-known-issues.md`** — §3 を Implemented 版に書換 + §3.4 として「Phase 3 完了時の懸念事項」追加 (Phase 4 引継ぎ用)
- **`CHANGELOG.md`** — v1.0.0 entry に Phase 3 mapping 追記:
  - `browser_launch` → `browser_open({launch:{...}})`
  - `browser_get_dom` → `browser_eval({action:'dom', selector?, maxLength})`
  - `browser_get_app_state` → `browser_eval({action:'appState', selectors?, maxBytes})`
  - `browser_disconnect` → 削除 (内部状態は process 終了時に自動 cleanup)

### 削除禁止 (handler 残置方針 / Phase 1+2 学び)

- 旧 handler 関数 (`browserConnectHandler` / `browserLaunchHandler` / `browserGetDomHandler` / `browserGetAppStateHandler` / `browserDisconnectHandler`) — internal export として残置、新 dispatcher の内部で呼ぶ
- 旧 schema 定義 (`browserConnectSchema` / `browserLaunchSchema` / `browserGetDomSchema` / `browserGetAppStateSchema` / `browserDisconnectSchema`) — internal type 用に残置
- engine 層 (`src/engine/cdp-bridge.ts` / `src/utils/launch.ts`) — Phase 4 でも触らない
- Phase 4b skeleton (vision-gpu / native engine) — 触らない
- v2 (`desktop_state` / `desktop_discover` / `desktop_act`) — Phase 1 で凍結済み
- `src/utils/launch.ts:4` のコメント内 `browser_launch` 言及 — Phase 4 polish (LLM 非露出)

### 削除 (alias なしの即破壊 §16.1)

- 4 件の `server.tool` 登録のみ (handler / schema は残置)

---

## 3. API design

### 3.1. `browser_open` (launch 吸収)

```ts
// src/tools/browser.ts (内部書換)
export const browserOpenSchema = {
  port: portParam,  // 既存
  launch: z.object({
    browser: z.enum(["auto", "chrome", "edge", "brave"])
      .default("auto")
      .describe("Which browser to spawn. 'auto' tries chrome→edge→brave."),
    userDataDir: z.string()
      .default("C:\\tmp\\cdp")
      .describe("Path for --user-data-dir. Default is safe to reuse."),
    url: z.string()
      .optional()
      .describe("Optional URL to open in the new browser."),
    waitMs: z.coerce.number().int().min(1000).max(30_000)
      .default(10_000)
      .describe("Max ms to wait for CDP endpoint readiness (default 10000)."),
  }).optional().describe(
    "If set, spawn a debug-mode browser when no CDP endpoint is live on the target port. " +
    "Idempotent: if a CDP endpoint is already live, the launch step is skipped and connect proceeds. " +
    "Omit to perform pure connect (fail if no endpoint). " +
    "Pass {} to use all defaults (launch chrome with C:\\tmp\\cdp profile, no initial URL)."
  ),
};

export const browserOpenHandler = async ({
  port,
  launch,
}: {
  port: number;
  launch?: { browser: "auto" | "chrome" | "edge" | "brave"; userDataDir: string; url?: string; waitMs: number };
}): Promise<ToolResult> => {
  // ── 1. Launch path (optional) ──────────────────────────────────────────
  if (launch) {
    // Idempotent — listTabs probe; spawn only if endpoint not live.
    // Reuses browserLaunchHandler internally so the spawn / poll / url logic
    // stays single-source.
    const launchResult = await browserLaunchHandler({
      browser: launch.browser,
      port,
      userDataDir: launch.userDataDir,
      url: launch.url,
      waitMs: launch.waitMs,
    });
    // Surface launch errors (e.g. browser-not-installed) as-is.
    if (launchResult.content[0]?.type === "text") {
      const text = launchResult.content[0].text;
      // browser_launch returns plain-text error messages on failure
      // (not JSON). Parsability check distinguishes success from failure.
      try { JSON.parse(text); } catch { return launchResult; }
    }
  }

  // ── 2. Connect path (always) ──────────────────────────────────────────
  return browserConnectHandler({ port });
};

export function registerBrowserTools(server: McpServer): void {
  // ...
  server.tool(
    "browser_open",
    "Connect to Chrome/Edge running with --remote-debugging-port and return open tab IDs — required before all other browser_* tools. " +
    "Pass launch:{} (or with overrides) to auto-spawn a debug-mode browser when no CDP endpoint is live (idempotent: already-running endpoint is preferred). " +
    "Returns tabs[] with id, url, title, active — pass tabId to browser_* tools to target a specific tab. " +
    "Caveats: CDP connection is per-process; if Chrome restarts, call browser_open again to get fresh tab IDs. " +
    "A Chrome session started without --remote-debugging-port cannot be taken over — close it first or use a separate userDataDir.",
    browserOpenSchema,
    browserOpenHandler
  );
}
```

#### 3.1.1. 設計上の決定事項

1. **`launch` を optional object** にした理由:
   - discriminatedUnion `action='connect'|'launch'` 案も検討したが、launch は connect の前段に過ぎず別 action として並列にする必然性が薄い。「launch するときも結局 connect するから launch 内包の方が自然」(plan §15 Phase 3 「optional launch パラメータ」と一致)
   - `launch:{}` で defaults 利用、`launch:{url:'https://example.com'}` で URL 指定、と段階的に詳細化できる
   - 省略時は pure connect (現 `browser_connect` 互換)。Chrome が手動起動済みの dev 用途と整合
2. **`browserLaunchHandler` を internal helper として残置**:
   - spawn / poll / url validation のロジックは複雑 (~120 行)。dispatcher 内に inline すると可読性低下
   - test (`tests/e2e/browser-cdp.test.ts` 等) からの直呼びも可
   - エラーメッセージ (`url must not start with '-'` 等) は launch 内で組み立て、open dispatcher に成功/失敗を伝える形を維持
3. **戻り値統合**: launch 成功時の `{port, alreadyRunning, launched, tabs}` と connect の `{tabs[].active}` を統合せず、connect の戻り値を最終的に返す方針。launch 単独情報 (`alreadyRunning` 等) は **削除** (LLM が必要としていない)
4. **エラー時の挙動**: launch が失敗 (browser 未インストール / port 競合等) したら launch のエラーメッセージをそのまま返し、connect には進まない。失敗判定は plain-text vs JSON でディスパッチ (現 `browserLaunchHandler` の戻り値仕様に従う)

### 3.2. `browser_eval` (discriminatedUnion 化)

```ts
// src/tools/browser.ts (内部書換)
export const browserEvalSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("js"),
    expression: z.string().describe(
      "JavaScript expression to evaluate. " +
      "The server automatically wraps snippets in an async IIFE to avoid repeated const/let collisions. " +
      "For multi-statement snippets, use an explicit final return value. " +
      "Declarations (const/let/var) are scoped per snippet — use window.* / globalThis.* for persistence."
    ),
    withPerception: z.boolean().optional().default(false).describe(
      "When true, return structured JSON {ok, result, post} with post.perception attached. Default false preserves raw-text return."
    ),
    lensId: z.string().optional().describe(
      "Optional perception lens ID. Guards (target.identityStable) are evaluated before eval."
    ),
    tabId: tabIdParam,
    port: portParam,
    includeContext: includeContextParam,
  }),
  z.object({
    action: z.literal("dom"),
    selector: z.string().optional().describe(
      "CSS selector for root element. Omit for document.body."
    ),
    maxLength: z.coerce.number().int().min(100).max(100_000).default(10_000).describe(
      "Max characters of HTML to return (default 10000)."
    ),
    tabId: tabIdParam,
    port: portParam,
    includeContext: includeContextParam,
  }),
  z.object({
    action: z.literal("appState"),
    selectors: z.array(z.string()).optional().describe(
      "Custom probe selectors. Omit to use the default SPA framework set " +
      "(__NEXT_DATA__ / __NUXT_DATA__ / __REMIX_CONTEXT__ / __APOLLO_STATE__ / window:__INITIAL_STATE__ etc.)."
    ),
    maxBytes: z.coerce.number().int().min(1000).max(1_000_000).default(100_000).describe(
      "Max bytes per probe (default 100000). Probes exceeding the cap return truncated:true."
    ),
    tabId: tabIdParam,
    port: portParam,
    includeContext: includeContextParam,
  }),
]);

export const browserEvalHandler = async (
  args: z.infer<typeof browserEvalSchema>
): Promise<ToolResult> => {
  switch (args.action) {
    case "js":       return browserEvalJsHandler(args);        // 旧 browserEvalHandler を rename
    case "dom":      return browserGetDomHandler(args);
    case "appState": return browserGetAppStateHandler(args);
  }
};

export function registerBrowserTools(server: McpServer): void {
  // ...
  server.tool(
    "browser_eval",
    buildDesc({
      purpose: "Inspect or operate on a browser tab via 3 actions: 'js' (evaluate JS), 'dom' (get HTML), 'appState' (extract SSR-injected SPA state).",
      details:
        "action='js' — Run a JS expression. withPerception:true wraps in {ok, result, post}. " +
        "action='dom' — Return outerHTML of selector (or document.body). " +
        "action='appState' — Scan Next/Nuxt/Remix/Apollo/GitHub/Redux SSR injected JSON; pass selectors to override defaults.",
      prefer:
        "Use 'appState' BEFORE 'dom' or 'js' on SPAs where rendered HTML is sparse — it's a single CDP call. " +
        "Use 'dom' when 'appState' is empty and you need page structure. " +
        "Use 'js' as the escape hatch for arbitrary scripting.",
      caveats:
        "DOM nodes cannot be returned from 'js' directly (circular refs are serialized safely). " +
        "React/Vue/Svelte controlled inputs cannot be set via element.value — use keyboard(action='type') / browser_fill instead. " +
        "readyState is strictly checked; guard blocks if page is still loading.",
      examples: [
        "browser_eval({action:'js', expression:'document.title'})",
        "browser_eval({action:'dom', selector:'#main', maxLength:5000})",
        "browser_eval({action:'appState'})  // default SPA selectors",
      ],
    }),
    browserEvalSchema,
    withPostState("browser_eval", browserEvalHandler)
  );
}
```

#### 3.2.1. 設計上の決定事項

1. **既存 `browserEvalHandler` は `browserEvalJsHandler` にリネーム**:
   - dispatcher 名 `browserEvalHandler` を新 union dispatcher が占有
   - 旧 handler を internal helper としてリネームして残置
2. **`withPostState` wrap の位置**:
   - 旧 `browser_eval` は `withPostState("browser_eval", browserEvalHandler)` だった
   - dispatcher 全体を wrap することで、3 action 全てに post.perception 取得が一貫適用される
   - action='dom' / 'appState' でも guard 評価される。これは新仕様 (旧 `browser_get_dom` には guard 無し) だが、Phase 1 で全 browser 系に lensId 統一の方針と整合
3. **`action='js'` を主役名に**:
   - 旧 `browser_eval` の主用途は JS 評価。`'js'` に揃えることで mental model 維持
   - 代案 `'eval'` は冗長 (tool 名と重複)
4. **`appState` の `selectors` 互換**:
   - 旧 `browserGetAppStateSchema.selectors` の型 (`string[]?`) と一致
   - 既存 e2e fixtures (`tests/e2e/fixtures/test-page.html`) はそのまま動く
5. **discriminatedUnion v.s. ZodRawShape**:
   - Phase 2 の `keyboard` / `clipboard` / `terminal` / `scroll` / `window_dock` で全て discriminatedUnion 採用 → 同パターン
   - MCP SDK は ZodSchema を直接受けるため、`server.tool(name, desc, browserEvalSchema, handler)` の形で問題なし

### 3.3. `browser_disconnect` 非公開化

```ts
// src/tools/browser.ts (registerBrowserTools 内から削除)
- server.tool(
-   "browser_disconnect",
-   "Close cached CDP WebSocket sessions for a port. Call when browser interaction is complete to release connections.",
-   browserDisconnectSchema,
-   browserDisconnectHandler
- );
```

- `browserDisconnectHandler` / `browserDisconnectSchema` は **internal export として残置** (memory `feedback_disable_via_entry_block.md`)
- 既存の自動 cleanup (process 終了時の `disconnectAll`) で実用上の問題なし
- Phase 5 dogfood で接続リーク有無を確認、問題あれば facade として復活 (Phase 4 で別途検討)

### 3.4. 内部 helper の export 整理

```ts
// src/tools/browser.ts (export 一覧)
export {
  // Phase 3 公開 dispatcher
  browserOpenHandler,       // new
  browserEvalHandler,       // dispatcher (was browserEvalHandler raw → renamed below)
  // Phase 3 internal (test/将来 facade 用)
  browserConnectHandler,    // browser_open の connect 部分
  browserLaunchHandler,     // browser_open の launch 部分
  browserEvalJsHandler,     // 旧 browserEvalHandler、'js' action 実装
  browserGetDomHandler,     // 'dom' action 実装
  browserGetAppStateHandler,// 'appState' action 実装
  browserDisconnectHandler, // 非公開化済み、internal 残置
  // (ほか変更なしの handler)
};
```

リネーム作業:
- 旧 `browserEvalHandler` → `browserEvalJsHandler` (action='js' 専用 internal handler)
- 新 `browserEvalHandler` (dispatcher) を define
- 旧 `browserConnectHandler` はそのまま残置 (browser_open の connect 内部実装)

### 3.5. MCP server instructions text 更新案

現状 `src/server-windows.ts` の browser 言及は **2 箇所のみ**:
- Line 91: `1. browser_click(selector) — Chrome/Edge (CDP, stable across repaints)`
- Line 101: `executor_failed → fall back to click_element / mouse_click / browser_click`

これらは **変更不要** (`browser_click` は Phase 1 で確定済み tool 名)。

**新規追加候補** (Phase 3 で追加するか、Phase 5 dogfood 時に追加するかは要判断):

```
## Browser session
1. browser_open({launch:{}}) — Connect to or spawn debug-mode Chrome (idempotent)
2. browser_navigate / browser_search / browser_overview — Discovery
3. browser_click / browser_fill / browser_form — Action
4. browser_eval(action='js'|'dom'|'appState') — Escape hatch / DOM dump / SPA state
```

→ **Phase 3 では追加しない**。理由: 既存 instructions text は World Graph / Clicking priority / Observation priority に絞った最小設計。browser 専用 section の追加は Phase 5 dogfood で実機 LLM の迷い度を見てから判断。

---

## 4. Workflow / behavior changes

### 4.1. 旧 → 新 mapping 表

| 旧呼び出し | 新呼び出し |
|---|---|
| `browser_launch({})` | `browser_open({launch:{}})` |
| `browser_launch({browser:'chrome', port:9222, url:'https://...'})` | `browser_open({port:9222, launch:{browser:'chrome', url:'https://...'}})` |
| `browser_open({port:9222})` | `browser_open({port:9222})` (互換) |
| `browser_get_dom({selector:'#main', maxLength:5000})` | `browser_eval({action:'dom', selector:'#main', maxLength:5000})` |
| `browser_get_app_state({})` | `browser_eval({action:'appState'})` |
| `browser_get_app_state({selectors:['window:__MY_STATE__']})` | `browser_eval({action:'appState', selectors:['window:__MY_STATE__']})` |
| `browser_eval({expression:'document.title'})` | `browser_eval({action:'js', expression:'document.title'})` |
| `browser_eval({expression, withPerception:true})` | `browser_eval({action:'js', expression, withPerception:true})` |
| `browser_disconnect({port:9222})` | (削除 — process 終了時自動 cleanup) |

### 4.2. `browser_open({launch:{...}})` のフロー

```
LLM call: browser_open({port:9222, launch:{browser:'auto', url:'https://example.com'}})
  ↓
[1] launch != null なので browserLaunchHandler 内部呼び
  ├─ listTabs(9222) 試行 — 成功 (既起動) → spawn skip
  └─ listTabs(9222) 失敗 → spawnDetached → poll 10秒 → tabs 取得
  ↓
[2] browserConnectHandler 呼び
  ├─ listTabs(9222) (再)
  ├─ 各 tab で document.hasFocus() 並列評価
  └─ tabs[] with active flag を返す
```

idempotency 保証:
- launch 成功時 (alreadyRunning=true / spawn 完了) でも、connect が再度 `listTabs` を呼ぶため tab list は最新
- launch のみ実行して connect しない使い方は不可能 (1 ツールで両方こなす設計)

### 4.3. `browser_eval({action:'js'})` の guard 適用

旧 `browser_get_dom` / `browser_get_app_state` には guard / lensId なし。新形式 `browser_eval({action:'dom'|'appState'})` は dispatcher 全体を `withPostState("browser_eval", ...)` で wrap するため、**全 3 action で guard 評価 + post.perception 取得**。

ただし:
- action='js' の `withPerception:false` (default) では response body は raw text のまま (旧仕様維持)
- action='dom' / 'appState' は最初から JSON 構造を返すため、post block を常時付与

これは Phase 1 の「browser 系全 tool に lensId 統一」方針と整合。

### 4.4. Breaking changes (v1.0.0 cut の一部)

- `browser_eval({expression})` (action 無し) は **InputValidationError** で fail。`browser_eval({action:'js', expression})` 必須
- `browser_get_dom` / `browser_get_app_state` / `browser_launch` / `browser_disconnect` は tool list から消える
- `browser_open` の **戻り値変更**: `launch` 指定時の `alreadyRunning` / `launched` フィールドは廃止。常に connect の戻り値 (`tabs[].active`) のみ

CHANGELOG.md にこれらを明記し、移行例を提示。

---

## 5. Forbidden / out of scope

### 5.1. 触らない箇所

- `src/engine/cdp-bridge.ts` — engine 層
- `src/utils/launch.ts` (launch.ts:4 のコメント `browser_launch` 言及は **LLM 非露出** のため Phase 4 polish)
- v2 (`desktop_state` / `desktop_discover` / `desktop_act`) — Phase 1 で凍結
- Phase 4b (vision-gpu / native engine)
- `bin/win-ocr.exe` / `PocVisualBackend` — Tier ∞ safety net

### 5.2. Phase 3 でやらない判断

- **`browser_search` / `browser_overview` / `browser_locate` のリネーム / 統合** — Phase 1 でリネーム済 (`browser_get_interactive` → `browser_overview` 等)、追加統合は能力低下リスク
- **`browser_eval({action:'fill'})` の追加** — `browser_fill` は controlled input 専用で別ツール、eval 内に混ぜると役割が曖昧化
- **`browser_open({launch})` を non-optional にする** — pure connect 用途を残すため optional
- **`browser_disconnect` の facade 化** — Phase 4 で接続リーク確認後判断、Phase 3 では入り口削除のみ

### 5.3. Pre-existing flaky (Phase 4b dogfood と同根)

- `tests/e2e/context-consistency.test.ts` C3 (Save-As dialog 検出) — Win11 MSStore Notepad 問題、**Phase 5 dogfood で対応**
- `tests/e2e/rich-narration-edge.test.ts` B1 (Chromium narrate:rich) — Chrome focus 環境依存、**Phase 5 dogfood で対応**

これらは Phase 3 で発生しても **本 PR の責任ではない**。`.vitest-out-e2e.txt` で再現性確認のみ実施。

---

## 6. Tests

### 6.1. 新規 unit test

**`tests/unit/tool-naming-phase3.test.ts`** (推定 8 ケース):

```
describe("Phase 3 tool naming", () => {
  it("registers browser_open with launch optional schema", ...);
  it("registers browser_eval with discriminatedUnion(js/dom/appState)", ...);
  it("does NOT register browser_launch", ...);
  it("does NOT register browser_get_dom", ...);
  it("does NOT register browser_get_app_state", ...);
  it("does NOT register browser_disconnect", ...);
  it("browser_open dispatcher: launch=undefined → connect only", ...);
  it("browser_open dispatcher: launch={} → launch then connect", ...);
});

describe("browser_eval dispatcher", () => {
  it("action='js' → routes to browserEvalJsHandler", ...);
  it("action='dom' → routes to browserGetDomHandler", ...);
  it("action='appState' → routes to browserGetAppStateHandler", ...);
  it("rejects payload without action", ...);
  it("rejects unknown action", ...);
});
```

### 6.2. 既存 e2e tests の追従

- `tests/e2e/browser-app-state.test.ts` (3 describe 数) — `browserGetAppStateHandler` を `browserEvalHandler({action:'appState', ...})` 経由呼びに切替
- `tests/e2e/browser-tab-context.test.ts` (2 it 数) — 同様、`browser_get_dom` 言及を `browser_eval({action:'dom'})` に
- `tests/e2e/browser-cdp.test.ts:257` — コメント追従のみ
- `tests/e2e/browser-connect-active.test.ts` — 新規テストケース 1 件追加 (launch path):
  ```
  it("browser_open({launch:{}}) — chrome already running → connects without spawn", async () => { ... });
  it("browser_open({launch:{}}) — no chrome → spawns and connects", async () => { ... });
  ```

### 6.3. 既存 unit/e2e tests の assertion 不変ルール (handbook §4.1)

- assertion (`expect(...).toBe(...)` 等) の値は変更しない
- 変更してよいのは tool 名 / handler 直呼び形式 / fixture path のみ
- Sonnet がテスト書換しないように prompt で明示

### 6.4. テスト出力 capture ルール (memory `feedback_test_capture.md`)

- `npm run test:capture > .vitest-out.txt` で 1 回取得
- tail/grep で読む、再実行禁止

### 6.5. E2E pinpoint コマンド (memory `feedback_pinpoint_e2e_rerun.md`)

- 失敗時は `.vitest-out-e2e.txt` 末尾の個別コマンド再実行のみ

---

## 7. Known traps (Phase 1+2 引継ぎ事項)

### 7.1. LLM 露出文字列 audit (Phase 4 引継ぎから前倒し)

- **`src/tools/_errors.ts:52`** — `BrowserNotConnected.suggest` 内の `browser_launch` 言及 (LLM 露出) → **必須更新**
- **`src/tools/desktop-state.ts:282`** — description 内 `browser_get_dom` 言及 (LLM 露出) → **必須更新**
- 他 audit:
  ```bash
  grep -rn "browser_launch\|browser_get_dom\|browser_get_app_state\|browser_disconnect" \
    src/ scripts/ \
    --include="*.ts" --include="*.mjs" \
    | grep -v "// " | grep -v "/\* " | grep -v "\.test\." 
  ```
  ヒットゼロ (LLM 露出箇所のみ) を確認

### 7.2. README workflow 例の更新

- `README.md:262` / `README.ja.md:264` の workflow 例 `browser_open() → browser_get_dom() → browser_locate(selector) → browser_click(selector)` を `browser_open({launch:{}}) → browser_eval({action:'dom'}) → browser_locate(selector) → browser_click(selector)` に書換

### 7.3. tab context cache のリセット

- `_resetTabContextCache()` (test-only export) — Phase 3 で変更なし
- ただし `browser_eval({action:'dom'|'appState'})` で `withPostState` wrap 追加されるため、guard が tab cache を参照するタイミング変更あり
- **検証**: e2e で `browser_eval({action:'dom'})` 直後の `browser_eval({action:'js'})` が同 tab を見るか

### 7.4. `withPostState` の引数 tool 名

- 旧 `browser_eval` の wrap: `withPostState("browser_eval", browserEvalHandler)` — Phase 3 でも同じ tool 名 `"browser_eval"` を渡す
- 新 dispatcher の内部 handler 呼びは wrap 内で実行されるため、post.perception は 1 回だけ付与

### 7.5. Sonnet trace-ability (Phase 2 §2.4)

- Phase 3 担当が Sonnet になる batch (3a / 3c / 3d / 3e) は以下を必須:
  1. `docs/phase3-sonnet-work-log.md` に逐次追記 (時刻 / sub batch / 試行 / エラー / 判断)
  2. 各 sub batch ごとに commit + push (WIP commit OK)
  3. max 45 分 budget、超過時は WIP commit + 状況要約 + return
  4. テストエラー発生時は自分で修正せず Opus 相談 (memory `feedback_test_error_consult_opus.md`)
  5. E2E は 1 回まで、2 回目で Opus 委譲 (memory `feedback_sonnet_e2e_twice_delegate.md`)

### 7.6. 判断系 sub batch は Opus 直 (Phase 2 §2.3)

- batch 3b (`browser_open` launch 吸収) は Opus 直実装 — 新 schema 設計、既存 launch handler 呼び出し連携、エラー伝播判定を含む
- Sonnet 委譲は機械的繰り返しのみ (rename / regenerate / test 名追従)

### 7.7. `.gitignore` 強化 (Phase 2 §2.6)

- `.vitest-out*.txt` / `.vitest-out*.json` が untracked で commit に紛れる懸念
- Phase 3 着手前に `.gitignore` 確認、未追加なら追加 (機械的 batch 3a の最初に実施)

### 7.8. `browser_launch` の戻り値仕様の引継ぎ

- 旧 `browser_launch` は **plain text on error / JSON on success** という非対称仕様
- `browserOpenHandler` 内部で launch を呼ぶときに、戻り値 type を判定してエラーを伝播
- 設計上、JSON.parse 試行で判定する (§3.1 コード参照)

### 7.9. instructions text の Phase 3 追加見送り判断 (§3.5)

- Phase 3 では browser 専用 section を追加しない
- Phase 5 dogfood で実機 LLM の迷い度を観察してから判断
- 早期追加すると後で削るときに breaking になりやすい

---

## 8. Risk & rollback

### 8.1. Risk matrix

| Risk | 確率 | 影響 | 対策 |
|---|---|---|---|
| `browser_eval({expression})` 旧呼びが大量に存在する LLM 呼出が壊れる | 高 (確実) | 中 (alias 無し v1.0.0 cut で許容) | CHANGELOG / README に明記、移行例提示 |
| `browser_open({launch:{}})` で launch 失敗時に error が hidden | 中 | 中 (LLM が混乱) | §3.1 のエラー伝播ロジックで text-vs-JSON 判定、test カバー |
| `browser_eval` dispatcher の type narrowing が tsc で通らない | 低 | 高 | Phase 2 keyboard/clipboard と同パターン、`switch (args.action)` で OK |
| `withPostState` wrap が action='dom' / 'appState' で過剰なオーバーヘッド | 低 | 低 | post.perception は軽量、Phase 1 で全 browser 系統一済 |
| 既存 e2e (browser-app-state / browser-tab-context) の handler 直呼びが壊れる | 中 | 中 | handler は internal export として残置、test 修正最小 |
| `browser_disconnect` 削除で接続リーク発生 | 低 | 中 | engine 層の `disconnectAll` は process 終了時自動呼出、Phase 5 dogfood で確認 |

### 8.2. Rollback 計画

- PR を main にマージしないまま branch で保持
- 仮に main に入れた後問題発覚した場合:
  1. `git revert` で PR 単体 revert
  2. 緊急性高い場合は handler を一時的に server.tool 登録復活 (旧 schema を internal から公開に戻す)
- 旧 handler / schema は残置されているので **完全 revert は容易**

### 8.3. リリースタイミング

- Phase 3 単体では release しない
- Phase 4 + Phase 5 dogfood と合わせて **v1.0.0 cut** で一括公開 (plan §16)

---

## 9. Implementation order (sub-batches)

| batch | 内容 | 担当 | 種別 | 推定時間 | 依存 |
|---|---|---|---|---|---|
| **3a** | `.gitignore` に `.vitest-out*.txt` / `.vitest-out*.json` 追加。`browser_eval` を discriminatedUnion 化 (action='js'/'dom'/'appState')。dispatcher + 内部 handler rename (`browserEvalHandler` → `browserEvalJsHandler` + 新 dispatcher) | Sonnet | **機械的** (Phase 2 keyboard と同パターン) | 30-45 min | none |
| **3b** | `browser_open` launch 吸収 (新 `browserOpenSchema` + dispatcher、旧 `browserConnectHandler` / `browserLaunchHandler` を internal helper として残置)。`server.tool("browser_launch", ...)` 登録削除 | **Opus 直** | **判断系** (新 schema 設計、エラー伝播 logic) | 45-60 min | 3a |
| **3c** | `server.tool` 登録削除 3 件 (`browser_get_dom` / `browser_get_app_state` / `browser_disconnect`)。internal export 整理 | Sonnet | **機械的** | 15-20 min | 3b |
| **3d** | LLM 露出文字列 audit + 修正:`_errors.ts:52` (`BrowserNotConnected.suggest`)、`desktop-state.ts:282`。grep audit でヒットゼロ確認 | Sonnet | **機械的** (audit + 単純 replace) | 20-30 min | 3c |
| **3e** | tests 追従: `tool-naming-phase3.test.ts` 新規 + `tool-descriptions.test.ts` expectedTools 更新 + e2e (browser-app-state / browser-tab-context / browser-cdp) tool 名追従。`browser-connect-active.test.ts` に launch path 1 ケース追加 | Sonnet | **機械的** (assertion 不変、tool 名追従のみ) | 45-60 min | 3d |
| **3f** | docs 更新: README.md / README.ja.md / system-overview.md / tool-surface-reduction-plan.md status flip / tool-surface-known-issues.md §3 書換 + §3.4 追加 / CHANGELOG.md v1.0.0 entry 追記 | Sonnet | **機械的** | 30-45 min | 3e |
| **3g** | stub catalog 再生成 (`node scripts/generate-stub-tool-catalog.mjs`)、tsc / vitest unit / vitest e2e 全パス確認、`.vitest-out.txt` / `.vitest-out-e2e.txt` 取得 | Sonnet | **機械的** | 20-30 min | 3f |
| **3h** | Opus 自己レビュー (BLOCKING ゼロまで反復)、PR 作成 | Opus | **判断系** | 30-60 min | 3g |

合計推定時間: **3.5-5.5 時間**。Phase 2 (実 6 時間) より小規模。

### 9.1. Sonnet prompt template (batch 3a / 3c / 3d / 3e / 3f / 3g)

```
あなたは Sonnet 4.6 として desktop-touch-mcp の Phase 3 batch {N} を担当します。

設計書: docs/tool-surface-phase3-browser-rearrangement-design.md (必ず先読み)
作業ログ: docs/phase3-sonnet-work-log.md に時刻 / 試行 / エラー / 判断を逐次記録

絶対ルール:
1. 設計書 §{N} 範囲外の変更禁止。判断が必要な場面で迷ったら Opus 委譲
2. テストコードの書換禁止 (assertion 不変、tool 名追従のみ可)
3. テストエラー発生時は自分で修正せず Opus 相談
4. E2E は 1 回まで、2 回目で停止して Opus 委譲
5. max 45 分 budget、超過時は WIP commit + 状況要約 + return
6. sub batch 完了で commit + push (WIP commit でも OK)

成果物:
- 実装 commit (push 済み)
- 作業ログ追記
- テスト結果 (`.vitest-out.txt` / `.vitest-out-e2e.txt`)
```

### 9.2. Opus 直実装 batch (3b / 3h)

- Phase 2 incident (Sonnet が判断系 batch で 4 回 trial & error) の再発防止
- 設計書 §3.1 / §7.1 / §7.4 / §7.8 の判断ポイントを Opus 自身が実装

### 9.3. ブランチ戦略

- 分岐元: main `0dd5e14` (PR #39 merge 後)
- ブランチ名: `feat/tool-surface-v1-phase3` (Phase 1 / 2 と整合)
- PR 作成タイミング: 全 batch 完了 + Opus 自己レビュー BLOCKING ゼロ後

---

## 10. Review checklist (Opus 自己レビュー + Codex)

### 10.1. 公開面整合性

- [ ] `tools/list` で 9 ツール (browser_*) のみ返る (`browser_launch` / `browser_get_dom` / `browser_get_app_state` / `browser_disconnect` は消える)
- [ ] `browser_eval` schema が discriminatedUnion で 3 action 受付
- [ ] `browser_open` schema が `launch` optional フィールドを持つ
- [ ] stub catalog の expected count に整合 (browser 系 9 件)

### 10.2. LLM 露出文字列

- [ ] `_errors.ts:52` の `browser_launch` 言及が `browser_open({launch:{}})` 形式に書換済
- [ ] `desktop-state.ts:282` の `browser_get_dom` 言及が `browser_eval({action:'dom'})` 形式に書換済
- [ ] `src/` 全体 grep で旧 4 tool 名が **suggest / description / error.message / failWith 第 2 引数** に残っていない
  - `failWith(err, "browser_launch")` 等の literal は internal handler 呼びが残っている分は OK (handler 側の error 名は内部識別子)
- [ ] CHANGELOG.md v1.0.0 entry に 4 件 mapping 追記済

### 10.3. handler 残置確認

- [ ] `browserConnectHandler` / `browserLaunchHandler` / `browserGetDomHandler` / `browserGetAppStateHandler` / `browserDisconnectHandler` が export されている (テスト/将来 facade 用)
- [ ] schema (`browserConnectSchema` / `browserLaunchSchema` / `browserGetDomSchema` / `browserGetAppStateSchema` / `browserDisconnectSchema`) が internal type として export されている

### 10.4. workflow / API 互換

- [ ] `browser_open({port:9222})` (launch 無し) が現 `browser_connect` 互換動作
- [ ] `browser_open({port:9222, launch:{}})` で Chrome 未起動時 spawn、起動済時 skip
- [ ] `browser_eval({action:'js', expression, withPerception:true})` で旧 `browser_eval` の {ok, result, post} 互換戻り値
- [ ] `browser_eval({action:'dom', selector?, maxLength})` で旧 `browser_get_dom` 互換戻り値
- [ ] `browser_eval({action:'appState', selectors?, maxBytes})` で旧 `browser_get_app_state` 互換戻り値

### 10.5. テスト

- [ ] vitest unit 全パス (Phase 2 ベース 2052 + Phase 3 新規 8 ≒ 2060)
- [ ] vitest e2e 全パス (browser-app-state / browser-tab-context / browser-connect-active 含む)
- [ ] Pre-existing flaky 2 件以外失敗なし
- [ ] `.vitest-out-e2e.txt` の最終結果に "JSON report written" を含む

### 10.6. ビルド / lint

- [ ] `tsc --noEmit` exit 0
- [ ] `npm run build` exit 0
- [ ] discriminatedUnion narrowing が switch case 内で正しく型推論される

### 10.7. docs

- [ ] README.md / README.ja.md の browser テーブル + workflow 例が新形式
- [ ] system-overview.md の browser family が新形式
- [ ] tool-surface-reduction-plan.md §15 Phase 3 が Implemented ステータス
- [ ] tool-surface-known-issues.md §3 が更新済 (Phase 4 引継ぎ事項を §3.4 に追加)

### 10.8. PR description

- [ ] CHANGELOG diff へリンク
- [ ] 旧 → 新 mapping 表 (§4.1) を含む
- [ ] handler 残置方針 (memory `feedback_disable_via_entry_block.md`) を明記
- [ ] 検証結果 (unit / e2e count) を含む
- [ ] Codex review request コメントに「Phase 3 browser rearrangement, see design doc」を含める

---

## 11. 設計確定後の Phase 4 引継ぎ事項 (sketch)

Phase 3 完了時に `docs/tool-surface-known-issues.md` §3.4 (新規) に以下を記載:

- `browser_launch` 内部 helper として残置、Phase 4 で完全削除候補 (handler が他から呼ばれていなければ)
- `browser_disconnect` の facade 化判断 (dogfood 結果次第)
- `src/utils/launch.ts:4` のコメント `browser_launch` を Phase 4 polish で削除
- `tests/e2e/browser-connect-active.test.ts` で追加した launch path test の Win11 MSStore Notepad 環境での動作確認 (Phase 5 dogfood)

---

## 12. 結論

Phase 3 は browser family の役割再配置に集中し、**13 → 9 ツール (-4)** を達成する。Phase 1+2 と異なり family 統合よりも吸収/非公開化が主軸:

1. **`browser_open` に launch 吸収** — `launch:{}` で auto-spawn、idempotent
2. **`browser_eval` を discriminatedUnion 化** — action='js'/'dom'/'appState' で 3 機能統合
3. **`browser_disconnect` 入り口削除** — handler 残置、process 終了時自動 cleanup で実用問題なし
4. **LLM 露出文字列 audit** — `_errors.ts` / `desktop-state.ts` の旧名言及を更新 (Phase 4 引継ぎから前倒し)

実装は **判断系 batch (3b / 3h) を Opus 直、機械的 batch (3a / 3c-3g) を Sonnet 委譲**、Phase 2 incident の再発防止を組み込み済み。

完了基準: design ↔ plan ↔ implementation の 3 者一致を Opus 自己レビューが確認、Codex BLOCKING ゼロ、main merge 後 Phase 4 着手可能状態。
