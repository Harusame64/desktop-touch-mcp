# Phase 4 設計書 — Privatize / Absorb (events / perception / get_* / mouse_move / screenshot / set_element_value)

- Status: **Implemented** (PR #41 merged into main 2026-04-26 — 65→28 public surface achieved)
- 設計者: Claude (Opus 4.7)
- 実装担当: 判断系 batch は Opus 直 / 機械的 batch のみ Sonnet 委譲 (§9 サブ batch 表参照)
- レビュー: Opus 自己レビュー + memory `feedback_pre_push_self_review.md` の **pre-push checklist 必須** → Codex (PR 提出後)
- 対応プラン: `docs/tool-surface-reduction-plan.md` §8.3 / §8.4 / §15 Phase 4 / §16 互換性ポリシー
- 前提 Phase: Phase 1 + 2 + 3 完了 (PR #35 / #36 / #37 / #38 / #39 / #40 全 main 入り)
- 前提 docs: `docs/tool-surface-known-issues.md` §4 (Phase 4 で対応する事項)
- 並走前提: Phase 4b dogfood (vision-gpu) と独立、main `39f55a3` から分岐
- ブランチ: `feat/tool-surface-v1-phase4`

---

## 1. Goal

Phase 4 のゴールは、tool surface reduction plan §8.3 / §8.4 / §15 Phase 4 に従い、**46 stub catalog tools → 26 stub catalog tools (-20、約 43% 削減)** を達成すること。Tool Surface Reduction の最大削減 phase。

| 区分 | 内訳 | 件数 |
|---|---|---|
| **入り口削除 (handler 残置)** | events_* (4) + perception_* (4) + get_history + mouse_move | **10** |
| **screenshot に吸収** | screenshot_background → `screenshot({mode:'background'})` / screenshot_ocr → `screenshot({detail:'ocr'})` / scope_element → `screenshot({region:{x,y,w,h}})` | **3** |
| **desktop_act に吸収** | set_element_value → `desktop_act({action:'setValue', ...})` | **1** |
| **desktop_state に吸収 (response field 拡張)** | get_active_window / get_cursor_position / get_document_state / get_screen_info | **4** |
| **desktop_discover に吸収 (response field 拡張)** | get_ui_elements / get_windows | **2** |
| **合計** | | **20** |

公開後合計: **stub catalog 26 + dynamic v2 (desktop_discover / desktop_act) 2 = 28 public tools** (plan §13 の目標値 27 ± 1 と整合)。

### Phase 4 で同時に処理する Phase 1+2+3 引継ぎ事項

- **`run_macro` DSL の `TOOL_REGISTRY` 新名移行** (Phase 2 §2.1 引継ぎ): 旧名 (`keyboard_type` / `pin_window` 等) を新 dispatcher 名に統一
- **コメント内旧名の polish** (Phase 1 §1.1 / Phase 2 §2.5 / Phase 3 §3.2 引継ぎ): LLM 非露出だが残置していた旧名を一括書換
- **`scripts/measure-tools-list-tokens.ts` の Tier 分類 refresh または削除** (Phase 3 §3.2 引継ぎ): pre-Phase 1 旧名のまま放置されている ad-hoc 計測スクリプト

### Phase 4 の範囲外 (Phase 5 で行う)

- **dogfood verify** (実機 LLM、軽量 LLM、browser/native/terminal workflow 検証)
- **`browser_disconnect` の facade 復活判断** (接続リーク有無を dogfood で確認後)
- **MCP server instructions text の browser/screenshot/desktop_act 拡張** (dogfood で迷い度観察後判断)
- **v1.0.0 release** (npm version + GitHub Release zip + npm publish + MCP Registry 更新)

---

## 2. Files to touch

### 主編集 (公開面)

#### 入り口削除 (handler / schema 残置、`server.tool(...)` 登録のみ削除)

- **`src/tools/events.ts`** — `events_subscribe` / `events_poll` / `events_unsubscribe` / `events_list` の `server.tool(...)` 4 件削除
- **`src/tools/perception.ts`** — `perception_register` / `perception_read` / `perception_forget` / `perception_list` の `server.tool(...)` 4 件削除
- **`src/tools/desktop-state.ts:299-301`** — `get_history` の `server.tool(...)` 1 件削除
- **`src/tools/mouse.ts:691`** — `mouse_move` の `server.tool(...)` 1 件削除

#### screenshot 吸収 (新パラメータ追加で 3 ツール統合)

- **`src/tools/screenshot.ts`** — `screenshotSchema` を拡張:
  - `mode?: 'normal' | 'background'` (default 'normal') — `screenshot_background` を吸収
  - `detail` enum に `'ocr'` を追加 — `screenshot_ocr` を吸収
  - `region?: {x, y, w, h}` — `scope_element` を吸収
  - dispatcher 内で mode/region に応じて旧 internal handler を呼ぶ
- **`src/tools/screenshot.ts`** — `screenshotBackgroundHandler` / `screenshotOcrHandler` を internal export として残置 (dispatcher が呼ぶ)
- **`src/tools/screenshot.ts`** — `screenshotBackgroundSchema` / `screenshotOcrSchema` を internal type として残置
- **`src/tools/screenshot.ts`** の `server.tool("screenshot_background", ...)` / `server.tool("screenshot_ocr", ...)` 登録削除
- **`src/tools/screenshot.ts`** の `server.tool("scope_element", ...)` 登録削除
- **`src/tools/screenshot.ts`** — `scopeElementHandler` / `scopeElementSchema` を internal export として残置

#### desktop_act 吸収 (action='setValue' 追加)

- **`src/tools/desktop.ts`** (or `desktop-act.ts`) — `desktopActSchema` の action enum に `'setValue'` を追加、value パラメータ追加
- **`src/tools/desktop-executor.ts`** — `'setValue'` action の dispatch を追加 (内部で旧 `setElementValueHandler` 呼び)
- **`src/tools/ui-elements.ts`** — `set_element_value` の `server.tool(...)` 削除、`setElementValueHandler` / `setElementValueSchema` は internal export として残置

#### desktop_state response field 拡張 (4 ツール吸収)

- **`src/tools/desktop-state.ts`** — `desktopStateSchema` を拡張:
  - `includeCursor?: boolean` (default false) — true で response に `cursor: {x, y, monitor?}` 追加 (`get_cursor_position` 吸収)
  - `includeScreen?: boolean` (default false) — true で response に `screen: {monitors[], primaryIndex}` 追加 (`get_screen_info` 吸収)
  - `includeDocument?: boolean` (default false) — true で response に `document: {url, title, readyState, selection?, scroll?}` 追加 (`get_document_state` 吸収)
  - `focusedWindow` field は **既に常時 return 済み** (Phase 1 で `get_active_window` 吸収完了) — 本 Phase で削除のみ
- **`src/tools/desktop-state.ts`** — `desktopStateHandler` 内で flag に応じて旧 handler 相当ロジックを呼ぶ
- **`src/tools/desktop-state.ts`** — `getCursorPositionHandler` / `getScreenInfoHandler` / `getDocumentStateHandler` を internal helper として残置
- **`src/tools/desktop-state.ts`** の `server.tool("get_active_window", ...)` / `server.tool("get_cursor_position", ...)` / `server.tool("get_document_state", ...)` / `server.tool("get_screen_info", ...)` 登録削除
- **`src/tools/window.ts`** の `server.tool("get_active_window", ...)` 登録があれば削除 (確認: `getActiveWindowHandler` は internal 残置)
- **`src/tools/mouse.ts:700`** の `server.tool("get_cursor_position", ...)` 登録削除

#### desktop_discover response field 拡張 (2 ツール吸収)

- **v2 `src/tools/desktop-register.ts`** (or `desktop.ts`) — `desktopDiscoverSchema` の response shape を確認:
  - `actionable[]` は既に entity 配列を返しているか? 既存実装で `get_ui_elements` 相当の情報が取れるか確認
  - `windows[]` は既に Z-order + region + isActive を返しているか? `get_windows` 相当か確認
  - 不足する field があれば追加 (例: `processName` / `automationId` 等)
- **`src/tools/ui-elements.ts`** の `server.tool("get_ui_elements", ...)` 登録削除、handler 残置
- **`src/tools/window.ts`** の `server.tool("get_windows", ...)` 登録削除、handler 残置

### 主編集 (LLM 露出文字列 audit + 修正)

Phase 4 完了前に必ず以下の grep を実行し、ヒットゼロにする (memory `feedback_pre_push_self_review.md` §5):

```bash
grep -rn "events_subscribe\|events_poll\|events_unsubscribe\|events_list\|perception_register\|perception_read\|perception_forget\|perception_list\|get_history\|mouse_move\|screenshot_background\|screenshot_ocr\|scope_element\|set_element_value\|get_active_window\|get_cursor_position\|get_document_state\|get_screen_info\|get_ui_elements\|get_windows" \
  src/ scripts/ \
  --include="*.ts" --include="*.mjs" \
  | grep -v -E "^[^:]+:[0-9]+:\s*(\\/\\/|\\*|/\\*)"
```

LLM 露出箇所:
- description / `buildDesc({...})` の各 field / `server.tool(name, desc, ...)` 第 2 引数
- suggest 配列 (`_errors.ts` の `SUGGESTS` map)
- `failWith(err, "tool_name")` 第 2 引数
- engine 層の literal type (例: `SuggestedFix.tool` — Phase 1 で発見済み)

### 主編集 (run_macro DSL 新名移行 — Phase 2 §2.1 引継ぎ)

- **`src/tools/macro.ts`** — `TOOL_REGISTRY` の旧名キー (`keyboard_type` / `keyboard_press` / `clipboard_read` / `clipboard_write` / `pin_window` / `unpin_window` / `dock_window` / `scroll_to_element` / `smart_scroll` / `scroll_capture` / `terminal_read` / `terminal_send` / `screenshot_background` / `screenshot_ocr` / `scope_element` / `set_element_value`) を新 dispatcher / 公開名に置換
- **`src/tools/macro.ts`** の `ToolEntry` 型を `z.ZodTypeAny` に拡張 (discriminated union 対応)
- **`src/tools/macro.ts`** の examples (description 内) を新 dispatcher 形式に書換 — 例: `{tool:'keyboard_type', params:{text:'hello'}}` → `{tool:'keyboard', params:{action:'type', text:'hello'}}`
- **breaking change** として CHANGELOG に追記

### コメント polish (LLM 非露出、Phase 1+2+3 引継ぎ)

| ファイル | 旧名 | 新名 |
|---|---|---|
| `src/utils/launch.ts:4` | `browser_launch` | `browser_open` |
| `src/tools/browser.ts:64` | `browser_launch` | `browser_open(launch:{...})` |
| `src/tools/browser.ts:1462` | `browser_launch + browser_open` | `browser_open dispatcher` |
| `src/tools/browser.ts:1755` | `browser_get_app_state` | `browser_eval(action:'appState')` |
| `src/engine/uia-bridge.ts:401` | `get_context` | `desktop_state` |
| `src/engine/uia-bridge.ts:657` | `smart_scroll` | `scroll(action='smart')` |
| `src/tools/desktop-constraints.ts:51,55,56,74,76,84` | `desktop_see` / `desktop_touch` / `terminal_read` / `terminal_send` | `desktop_discover` / `desktop_act` / `terminal(action='read')` / `terminal(action='send')` |
| `src/engine/vision-gpu/backend.ts:36` | `desktop_see` | `desktop_discover` |
| `src/tools/desktop-executor.ts:2` | `desktop_touch` | `desktop_act` |
| `src/tools/desktop-providers/ocr-provider.ts:59` | `desktop_see` | `desktop_discover` |
| `src/tools/desktop.ts:156` | `desktop_see / desktop_touch` | `desktop_discover / desktop_act` |
| `src/engine/world-graph/lease-ttl-policy.ts:42` | `desktop_see` | `desktop_discover` |
| `src/engine/layer-buffer.ts:376,398` | `smart_scroll` | `scroll(action='smart')` |
| `src/engine/ocr-bridge.ts:286` | `terminal_read` | `terminal(action='read')` |
| `src/server-windows.ts:195` | `desktop_see / desktop_touch` | `desktop_discover / desktop_act` |

### measure-tools-list-tokens.ts の扱い

選択肢 (§9 batch 4g で判断):
- **A**: ツール完全削除 (今後使わないなら)
- **B**: Tier 分類を Phase 1+2+3 後の新名に refresh
- **C**: ファイル先頭に「この script は v1.0.0 cut で stale」と warning 追記 + Phase 5 dogfood 後に判断

推奨: **B**。ad-hoc でも「token cost を測りたい」用途は v1.0.0 release notes 用に残ると見込まれる。

### Stub catalog

- **`scripts/generate-stub-tool-catalog.mjs`**
  - `TOOL_FILES` 変更不要 (既に対象 .ts ファイル全部含まれる)
  - 新規 schema (screenshot 拡張 / desktop_act 拡張 / desktop_state 拡張) は既存 ZodRawShape または discriminatedUnion パスで処理可
  - `if (tools.length < 26)` に閾値更新 (現 46 → 26)
- **`src/stub-tool-catalog.ts`** — 自動再生成

### Tests

- **`tests/unit/tool-naming-phase4.test.ts`** (新規) — §6 の 30+ ケース
- **`tests/unit/tool-descriptions.test.ts`** — `expectedTools` 更新 (現 46 → 26)
- **`scripts/generate-stub-tool-catalog.mjs`** — 閾値 50 → 26 に更新
- **`tests/e2e/http-transport.test.ts`** H3 — 閾値 46 → 26 に更新 (stub catalog 26 + dynamic 2 = 28)
- **既存 unit/e2e tests** — assertion 不変、tool 名追従のみ
  - events / perception 直接呼びの test は internal handler 経由に書換
  - get_* 系 test は desktop_state / desktop_discover 経由に切替
  - screenshot variants test は新パラメータ経由に切替
  - set_element_value test は desktop_act(action:'setValue') 経由に切替

### Docs

- **`README.md`** / **`README.ja.md`** — テーブル更新 (events / perception / get_* / screenshot variants / set_element_value 行削除)、workflow 例更新、screenshot section 拡張
- **`docs/system-overview.md`** — events / perception / get_* / screenshot variants / set_element_value sections 統合または削除
- **`docs/tool-surface-reduction-plan.md`** — §15 Phase 4 status を Implemented に flip
- **`docs/tool-surface-known-issues.md`** — §4 を Implemented 版に書換 + Phase 5 dogfood 引継ぎ事項を §4.5 に追加
- **`CHANGELOG.md`** — v1.0.0 entry に Phase 4 mapping 追記:
  - 入り口削除 10 件
  - 吸収先表 (旧 → 新呼び出し対応)

---

## 3. API design

### 3.1. screenshot 拡張 (3 ツール吸収)

```ts
// src/tools/screenshot.ts
export const screenshotSchema = {
  // 既存
  windowTitle: z.string().optional().describe(...),
  detail: z.enum(["text", "image", "meta", "ocr"]).default("text").describe(  // ★ "ocr" 追加
    "text: actionable elements + coords (default). image: PNG. meta: focused element only. " +
    "ocr: Windows OCR over the captured image (absorbs former screenshot_ocr)."
  ),
  // ... 既存 fields ...

  // ★ Phase 4 新規 — screenshot_background 吸収
  mode: z.enum(["normal", "background"]).default("normal").optional().describe(
    "normal: foreground capture (default). background: BitBlt without bringing window to front (absorbs former screenshot_background)."
  ),

  // ★ Phase 4 新規 — scope_element 吸収
  region: z.object({
    x: z.coerce.number().int(),
    y: z.coerce.number().int(),
    width: z.coerce.number().int().positive(),
    height: z.coerce.number().int().positive(),
  }).optional().describe(
    "Optional crop region in screen coordinates. Absorbs former scope_element. " +
    "Use to zoom in on a specific UI element when discovered via desktop_state / desktop_discover."
  ),

  // ★ Phase 4 新規 — OCR language (was screenshot_ocr param)
  ocrLanguage: z.string().max(20).default("en").optional().describe(
    "BCP-47 tag for OCR language when detail='ocr' (default 'en'; 'ja' for Japanese)."
  ),
};

export const screenshotHandler = async (args: ParsedArgs): Promise<ToolResult> => {
  // detail='ocr' && mode!='background' → screenshotOcrHandler
  if (args.detail === "ocr") return screenshotOcrHandler(args);
  // mode='background' → screenshotBackgroundHandler
  if (args.mode === "background") return screenshotBackgroundHandler(args);
  // region 指定 → scopeElementHandler (内部で screenshot + crop)
  if (args.region) return scopeElementHandler(args);
  // それ以外: 既存 screenshot 実装
  return screenshotDefaultHandler(args);
};
```

#### 3.1.1. 設計上の決定事項

1. **discriminatedUnion ではなく optional params** — screenshot は「同じ観測ツールの異なる強さ/詳細」であり「異なる action」ではない。`action` discriminator 化は不自然。
2. **`detail='ocr'` の選択** — 旧 `screenshot_ocr` は detail パラメータの新値として吸収。`screenshot({detail:'ocr'})` で OCR 実行
3. **`mode='background'`** — 既存の他 tool との衝突なし、明示的な mode フラグ
4. **`region` はオブジェクト** — 旧 `scope_element` は (x,y,w,h) 4 引数。1 オブジェクトにまとめて scope を明示
5. **mode + detail + region の組合せ** — dispatcher で priority 順に判定 (ocr > background > region > default)。同時指定はテストでカバー

### 3.2. desktop_act に action='setValue' 追加 (1 ツール吸収)

```ts
// src/tools/desktop-register.ts (or wherever desktopActSchema is defined)
export const desktopActSchema = z.discriminatedUnion("action", [
  // 既存 actions
  z.object({ action: z.literal("click"), lease: ..., ... }),
  z.object({ action: z.literal("type"), lease: ..., text: ..., ... }),
  z.object({ action: z.literal("scroll"), lease: ..., ... }),

  // ★ Phase 4 新規
  z.object({
    action: z.literal("setValue"),
    lease: z.object({ digest: z.string(), entityId: z.string() }),
    value: z.string().max(10000).describe("Value to set on the element (UIA ValuePattern)."),
    // ... lensId / fixId 等 既存 ...
  }),
]);
```

`desktop-executor.ts` の switch case に `'setValue'` を追加し、内部で旧 `setElementValueHandler` を呼ぶ。

### 3.3. desktop_state response field 拡張 (4 ツール吸収)

```ts
// src/tools/desktop-state.ts
export const desktopStateSchema = {
  // ★ Phase 4 新規 — flag で response field を制御
  includeCursor: z.boolean().optional().default(false).describe(
    "When true, include `cursor: {x, y, monitor?}` in the response. Absorbs former get_cursor_position."
  ),
  includeScreen: z.boolean().optional().default(false).describe(
    "When true, include `screen: {monitors[], primaryIndex}` in the response. Absorbs former get_screen_info."
  ),
  includeDocument: z.boolean().optional().default(false).describe(
    "When true, include `document: {url, title, readyState, selection?, scroll?}` for the focused Chrome tab. Absorbs former get_document_state."
  ),
  // includeUiElements は scope 外 — get_ui_elements は desktop_discover に吸収する (§3.4)
};

// Response shape (always returned):
//   focusedWindow: { title, hwnd, processName, region }   ← 既存 (Phase 1 で get_active_window 吸収済)
//   focusedElement: { name, type, value, automationId } ← 既存
//   modal: boolean                                        ← 既存
//   attention: AttentionState                             ← 既存
//
// Response shape (flag-controlled):
//   cursor?: { x, y, monitor? }                           ← Phase 4 新規 (includeCursor)
//   screen?: { monitors: [...], primaryIndex }            ← Phase 4 新規 (includeScreen)
//   document?: { url, title, readyState, selection?, scroll? }  ← Phase 4 新規 (includeDocument)
```

`desktopStateHandler` 内で flag を見て対応する旧 handler 相当のロジックを呼ぶ。旧 handler (`getCursorPositionHandler` / `getScreenInfoHandler` / `getDocumentStateHandler`) は internal helper として残置。

### 3.4. desktop_discover response 拡張 (2 ツール吸収)

```ts
// src/tools/desktop-register.ts (or wherever desktopDiscoverSchema lives)
// 既存 schema に変更なし — request パラメータは Phase 1 で凍結済
//
// Response shape (Phase 1 で確定 + Phase 4 で確認 / 拡張):
//   actionable: Entity[]                                  ← 既存 — get_ui_elements 互換
//                                                            (name / role / value / automationId / region 含む)
//   windows: WindowMeta[]                                 ← 既存 — get_windows 互換
//                                                            (zOrder / title / hwnd / region / isActive 含む)
```

Phase 4 では:
- `desktop_discover` response の `actionable[]` が `get_ui_elements` 相当の情報を全て含むことを確認、不足あれば field 追加
- `windows[]` が `get_windows` 相当の情報 (Z-order / title / hwnd / region / isActive / processName) を含むことを確認、不足あれば field 追加
- 旧 `getUiElementsHandler` / `getWindowsHandler` は internal helper として残置

### 3.5. 入り口削除 (handler 残置、optional params なし)

以下は schema / handler 変更なし、`server.tool(...)` 登録のみ削除:

- `events_subscribe` / `events_poll` / `events_unsubscribe` / `events_list` (4): handler は internal export 維持、event-bus engine 層も維持。`wait_until` で代替可能
- `perception_register` / `perception_read` / `perception_forget` / `perception_list` (4): v0.12 Auto Perception で自動化済み、明示 lens 操作の必要性低下。`attention` 信号は `desktop_state` / `desktop_act` レスポンスに常時含まれる
- `get_history` (1): debug 用、LLM 主操作 workflow には不要
- `mouse_move` (1): hover-trigger UI が稀、必要時は内部 API として残置

---

## 4. Workflow / behavior changes

### 4.1. 旧 → 新 mapping 表

| 旧呼び出し | 新呼び出し / 状態 |
|---|---|
| `events_subscribe({...})` | (削除 — `wait_until({condition:'window_appears'})` 等で代替) |
| `events_poll({...})` | (削除) |
| `events_unsubscribe({...})` | (削除) |
| `events_list({})` | (削除) |
| `perception_register({...})` | (削除 — Auto Perception で自動化済) |
| `perception_read({...})` | (削除) |
| `perception_forget({...})` | (削除) |
| `perception_list({})` | (削除) |
| `get_history({n})` | (削除 — debug は server log で対応) |
| `mouse_move({x, y})` | (削除 — `mouse_click({x, y, dryRun:true})` 等の代替検討は Phase 5) |
| `screenshot_background({windowTitle})` | `screenshot({windowTitle, mode:'background'})` |
| `screenshot_ocr({windowTitle, ocrLanguage})` | `screenshot({windowTitle, detail:'ocr', ocrLanguage})` |
| `scope_element({windowTitle, x, y, w, h})` | `screenshot({windowTitle, region:{x, y, width:w, height:h}})` |
| `set_element_value({lease, value})` | `desktop_act({action:'setValue', lease, value})` |
| `get_active_window({})` | `desktop_state({}).focusedWindow` |
| `get_cursor_position({})` | `desktop_state({includeCursor:true}).cursor` |
| `get_document_state({port, tabId})` | `desktop_state({includeDocument:true}).document` |
| `get_screen_info({})` | `desktop_state({includeScreen:true}).screen` |
| `get_ui_elements({windowTitle})` | `desktop_discover({windowTitle}).actionable` |
| `get_windows({})` | `desktop_discover({}).windows` |

### 4.2. Breaking changes (v1.0.0 cut の最終ピース)

- **20 旧 tool が tools/list から消える**
- 既存呼出を新形式に書換える必要あり
- handler は internal で残置されているため、ロールバックは `server.tool(...)` 登録の復活のみで済む
- CHANGELOG / README に明記

### 4.3. run_macro DSL の breaking change

`run_macro({steps:[{tool:'keyboard_type', params:{text:'hello'}}]})` のような旧名指定は失敗。新形式 `{tool:'keyboard', params:{action:'type', text:'hello'}}` に統一。examples を CHANGELOG / description に明記。

---

## 5. Forbidden / out of scope

### 5.1. 触らない箇所

- engine 層 (`src/engine/cdp-bridge.ts` / `src/engine/event-bus.ts` / `src/engine/perception-store.ts` / `src/engine/win32.ts` / `src/engine/uia-bridge.ts` の **動作ロジック** — コメント polish は除く)
- v2 (`desktop_state` / `desktop_discover` / `desktop_act`) — Phase 1 で凍結 schema は維持、Phase 4 では response field 拡張のみ
- Phase 4b (vision-gpu / native engine)
- `bin/win-ocr.exe` / `PocVisualBackend` — Tier ∞ safety net

### 5.2. Phase 4 でやらない判断

- **`mouse_move` の代替動線** — Phase 5 dogfood で hover 系 UI の頻度を確認後判断。Phase 4 は単純削除
- **`browser_disconnect` の facade 復活** — Phase 3 で削除済、Phase 5 dogfood で接続リーク確認後判断
- **MCP server instructions text の screenshot/desktop_act 拡張** — Phase 5 dogfood で実機 LLM の迷い度を観察してから判断
- **`scope_element` の dpr 自動補正** — 既存実装通り (region は screen 座標)
- **events / perception 完全削除** — handler / engine 層は資産として維持

### 5.3. Pre-existing flaky (Phase 4 で対応しない)

- `tests/unit/registry-lru.test.ts` 全 unit suite 実行時の test isolation flake (Phase 3 §3.3) — vitest `vi.mock` leak 問題、Phase 4 でも対応見送り (Phase 5 で別途対応 or 別 PR)
- `tests/e2e/context-consistency.test.ts` C3 (Save-As dialog 検出) / `tests/e2e/rich-narration-edge.test.ts` B1 (Chromium narrate:rich) — Phase 5 dogfood で対応

---

## 6. Tests

### 6.1. 新規 unit test

**`tests/unit/tool-naming-phase4.test.ts`** (推定 30+ ケース):

```
describe("Phase 4 — entry-point removals (handler retained)", () => {
  // 入り口削除 10 件
  it("events_subscribe is NOT registered (handler retained)", ...);
  it("events_poll is NOT registered", ...);
  it("events_unsubscribe is NOT registered", ...);
  it("events_list is NOT registered", ...);
  it("perception_register is NOT registered", ...);
  it("perception_read is NOT registered", ...);
  it("perception_forget is NOT registered", ...);
  it("perception_list is NOT registered", ...);
  it("get_history is NOT registered", ...);
  it("mouse_move is NOT registered", ...);
  it("retains internal handler exports for tests/future facade", ...);
});

describe("Phase 4 — screenshot absorbs background/ocr/scope", () => {
  it("screenshot_background is NOT registered", ...);
  it("screenshot_ocr is NOT registered", ...);
  it("scope_element is NOT registered", ...);
  it("screenshot schema accepts mode:'background'", ...);
  it("screenshot schema accepts detail:'ocr'", ...);
  it("screenshot schema accepts region:{x,y,width,height}", ...);
  it("screenshot dispatcher routes detail='ocr' → ocr handler", ...);
  it("screenshot dispatcher routes mode='background' → bg handler", ...);
  it("screenshot dispatcher routes region:{...} → scope handler", ...);
});

describe("Phase 4 — desktop_act absorbs set_element_value", () => {
  it("set_element_value is NOT registered", ...);
  it("desktop_act schema accepts action:'setValue' with value field", ...);
  it("desktop_act dispatcher routes action='setValue' → setElementValueHandler", ...);
});

describe("Phase 4 — desktop_state absorbs get_* (response field expansion)", () => {
  it("get_active_window is NOT registered", ...);
  it("get_cursor_position is NOT registered", ...);
  it("get_document_state is NOT registered", ...);
  it("get_screen_info is NOT registered", ...);
  it("desktop_state schema accepts includeCursor / includeScreen / includeDocument", ...);
  it("desktop_state response always includes focusedWindow", ...);
  it("desktop_state(includeCursor:true) returns cursor field", ...);
  it("desktop_state(includeScreen:true) returns screen field", ...);
  it("desktop_state(includeDocument:true) returns document field", ...);
});

describe("Phase 4 — desktop_discover absorbs get_ui_elements / get_windows", () => {
  it("get_ui_elements is NOT registered", ...);
  it("get_windows is NOT registered", ...);
  it("desktop_discover response actionable[] includes name/role/value/automationId/region", ...);
  it("desktop_discover response windows[] includes zOrder/title/hwnd/region/isActive", ...);
});

describe("Phase 4 — stub catalog integrity", () => {
  it("catalog has exactly 26 entries", ...);
  it("catalog drops 20 absorbed/privatized tool names", ...);
  it("dispatcher schemas (screenshot/desktop_state) preserve action-specific fields", ...);
});

describe("Phase 4 — LLM-exposed string audit", () => {
  it("no old tool names in description / suggest / error / failWith", ...);
});

describe("Phase 4 — run_macro DSL TOOL_REGISTRY new names", () => {
  it("keyboard / clipboard / window_dock / scroll / terminal / screenshot accept new dispatcher names", ...);
  it("old DSL names (keyboard_type / pin_window / scroll_capture / etc.) rejected", ...);
});
```

### 6.2. 既存 unit/e2e tests の追従

assertion 不変、tool 名 / handler 直呼び形式 / fixture path のみ更新:

- `tests/unit/events-*.test.ts` — internal handler 直呼びへ切替
- `tests/unit/perception-*.test.ts` — 同上
- `tests/unit/screenshot*.test.ts` — 新パラメータ経由 / または internal handler 直呼び
- `tests/e2e/*` — 影響範囲の確認 + tool 名追従

### 6.3. http-transport / tool-descriptions 閾値更新

- `tests/e2e/http-transport.test.ts` H3: 46 → 26 (stub catalog) または 28 (含む dynamic v2)
- `tests/unit/tool-descriptions.test.ts` `expectedTools.length`: 46 → 26
- `scripts/generate-stub-tool-catalog.mjs` 閾値: 46 → 26

### 6.4. テスト出力 capture ルール (memory `feedback_test_capture.md`)

`npm run test:capture > .vitest-out.txt` で 1 回取得、tail/grep。

### 6.5. E2E pinpoint コマンド (memory `feedback_pinpoint_e2e_rerun.md`)

失敗時は `.vitest-out-e2e.txt` 末尾の個別コマンド再実行のみ。

---

## 7. Known traps (Phase 1+2+3 引継ぎ事項 + Phase 4 固有)

### 7.1. **pre-push checklist 必須** (memory `feedback_pre_push_self_review.md`)

PR #40 で Codex / CodeQL から 4 ラウンド指摘を受けたため、Phase 4 では **push 前に下記 7 項目を全部通過**:

1. payload shape 判定 (JSON parse 成功 ≠ 成功)
2. wrapper / decorator の網羅性 (`s.tool` だけでなく `s.registerTool` も)
3. 自動生成 artifact の中身まで grep で検証
4. 未使用パラメータ / dead code 削除
5. リネーム grep audit (description / suggest / error / failWith / engine literal type)
6. テストの shape verification (count だけでなく実際の構造)
7. tsc + vitest + 生成物 grep の最終ドライラン

### 7.2. desktop_state response field の hot-target-cache 連携 (Phase 1 §1.4)

- `desktop_state.attention` は HotTargetCache 経由で取得 (B1 修正)
- includeCursor / includeScreen / includeDocument 追加時は cache invalidation との整合性を確認
- multi-monitor / virtual desktop 切替時の動作は Phase 5 dogfood で再確認

### 7.3. desktop_discover response の actionable[] / windows[] 充足度

- Phase 1 §6.3 で response shape が凍結されているが、実装で `get_ui_elements` / `get_windows` の全 field を再現できているか **実装前に確認**
- 不足 field があれば追加 — ただし v2 schema を変えるのは慎重に
- engine 層 (`uia-bridge.ts` / `enumWindowsInZOrder`) からの provider 経由で取得する形を維持

### 7.4. screenshot dispatcher のパラメータ優先順位

`detail='ocr'` / `mode='background'` / `region:{...}` が同時指定された場合の優先順位:

1. `detail='ocr'` (OCR は最終出力 — 他は OCR 入力としては機能しない、エラー)
2. `mode='background'` (capture 方式の選択)
3. `region:{...}` (crop)
4. default (foreground capture, full screen / window)

dispatcher 内で if-else で優先順位を実装、テストでカバー。

### 7.5. desktop_act action='setValue' の lease 整合性

- 旧 `set_element_value` は windowTitle + element name で対象を指定していた可能性
- 新 `desktop_act({action:'setValue', lease, value})` は lease (entity 指定) に統一
- lease 取得には `desktop_discover` が必要 — workflow が増えるが、これは Phase 1 設計で確定済の方針

### 7.6. run_macro DSL の examples 更新と internal type 拡張

- `ToolEntry` 型を `z.ZodTypeAny` 等に拡張する必要あり (現在は `ZodObject<{ ... }>`)
- examples (description 内) を新 dispatcher 形式に書き換え
- breaking change であることを CHANGELOG に明記

### 7.7. Sonnet trace-ability (Phase 2 §2.4 / Phase 3 §3.5)

機械的 batch (4a / 4e / 4f / 4g / 4h) を Sonnet に委譲する場合は以下必須:
1. `docs/phase4-sonnet-work-log.md` に逐次追記
2. 各 sub batch ごとに commit + push (WIP commit OK)
3. max 45 分 budget、超過時は WIP commit + 状況要約 + return
4. テストエラー発生時は自分で修正せず Opus 相談 (memory `feedback_test_error_consult_opus.md`)
5. E2E は 1 回まで、2 回目で Opus 委譲 (memory `feedback_sonnet_e2e_twice_delegate.md`)

### 7.8. 判断系 sub batch は Opus 直 (Phase 2 §2.3 / Phase 3 §7.6)

- 4b (screenshot 拡張): 新パラメータ設計、優先順位ロジック → Opus 直
- 4c (desktop_act setValue): 新 action + lease 連携 → Opus 直
- 4d (desktop_state / desktop_discover 拡張): response field 設計、handler 連携 → Opus 直
- 4i (Opus 自己レビュー + PR): pre-push checklist 適用 → Opus 直

### 7.9. macro.ts TOOL_REGISTRY と公開ツール名の同期

- macro.ts は run_macro DSL が受け付ける tool 名を持つ (LLM 露出)
- Phase 4 までに同期されていない (Phase 2 §2.1 引継ぎ)
- examples 旧名 → 新名書換、`ToolEntry` 型拡張、内部 router の旧→新名 mapping を撤廃

### 7.10. v2 (desktop_discover / desktop_act) が default-on 前提

- v0.17+ で `_v2Enabled` がデフォルト true (`DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` で kill)
- Phase 4 の get_* 系吸収は v2 動作前提
- v2 disable 環境では get_* 系を呼べないことになる — Phase 4 設計書に明記、CHANGELOG に「v0.17+ では DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1 を使うと get_* 相当機能も失われる」旨を警告

---

## 8. Risk & rollback

### 8.1. Risk matrix

| Risk | 確率 | 影響 | 対策 |
|---|---|---|---|
| desktop_state の include* flag 実装ミスで response field が空 | 中 | 中 | unit test で各 flag の return field を assert |
| desktop_discover の actionable[] / windows[] 充足度不足 | 中 | 高 (互換性破壊) | 実装前に旧 handler の return shape と diff、不足 field を pre-implement で追加 |
| screenshot dispatcher の優先順位が直感に反する | 中 | 中 | description で明示 + test で全組合せをカバー |
| desktop_act setValue の lease 解決が UIA ValuePattern 不整合で fail | 中 | 中 | 旧 `setElementValueHandler` の error path を維持、Phase 5 dogfood で確認 |
| macro.ts ToolEntry 型拡張で tsc エラー大量発生 | 中 | 中 | 段階的に migrate、必要なら `as` cast で逃がす (Phase 5 で再 audit) |
| Phase 4 削除した events / perception を実は使っていた | 低 | 中 | handler 残置のため facade で復活可能 (Phase 5 で判断) |
| 旧 tool 名が generated artifact に残る | 低 | 中 | pre-push checklist §3 で grep 検証 |
| Pre-existing flaky 増殖 | 低 | 低 | known-issues §4 で別 PR 化 |

### 8.2. Rollback 計画

- PR を main にマージしない状態で branch 保持
- マージ後問題発覚時:
  1. `git revert` で PR 単体 revert
  2. 緊急時は server.tool 登録のみ復活 (handler / schema は残置されているので 1 行追加で済む)
- 旧 handler / schema は全て internal export として残置 → 完全 revert は容易

### 8.3. リリースタイミング

- Phase 4 単体では release しない
- Phase 5 dogfood verify と合わせて **v1.0.0 cut** で一括公開 (plan §16)

---

## 9. Implementation order (sub-batches)

| batch | 内容 | 担当 | 種別 | 推定 | 依存 |
|---|---|---|---|---|---|
| **4a** | events_* / perception_* / mouse_move / get_history 入り口削除 (10 tools)。handler / schema は internal export 残置 | Sonnet | 機械的 | 30-45 min | none |
| **4b** | **screenshot 拡張 (mode/detail='ocr'/region) — 3 tools 吸収** | **Opus 直** | **判断系** (新パラメータ設計、優先順位ロジック) | 60-90 min | 4a |
| **4c** | **desktop_act に action='setValue' 追加 — set_element_value 吸収** | **Opus 直** | **判断系** (新 action + lease 連携) | 45-60 min | 4b |
| **4d** | **desktop_state include* flag 実装 + desktop_discover response 拡張 — 6 tools 吸収** | **Opus 直** | **判断系** (response field 設計、旧 handler 連携) | 90-120 min | 4c |
| **4e** | run_macro DSL TOOL_REGISTRY 新名移行 + examples 書換 | Sonnet | 機械的 (Phase 2 §2.1 引継ぎ、ToolEntry 型拡張は機械的に進められるはず) | 30-45 min | 4d |
| **4f** | コメント polish (LLM 非露出旧名 16+ 箇所一括書換) | Sonnet | 機械的 | 30-45 min | 4e |
| **4g** | scripts/measure-tools-list-tokens.ts Tier refresh | Sonnet | 機械的 | 15-30 min | 4f |
| **4h** | tests + docs (tool-naming-phase4.test.ts 新規 / tool-descriptions.test.ts 閾値 / http-transport.test.ts 閾値 / README × 2 / system-overview / known-issues / CHANGELOG / plan §15 Phase 4 status flip) | Sonnet | 機械的 (assertion 不変、tool 名追従のみ) | 60-90 min | 4g |
| **4i** | Opus 自己レビュー (pre-push checklist 7 項目) + PR 作成 | **Opus 直** | **判断系** | 60-90 min | 4h |

合計推定時間: **6.5-10 時間** (Phase 3 の ~1.5-2 倍規模)。

### 9.1. Sonnet prompt template (batch 4a / 4e / 4f / 4g / 4h)

```
あなたは Sonnet 4.6 として desktop-touch-mcp の Phase 4 batch {N} を担当します。

設計書: docs/tool-surface-phase4-privatize-absorb-design.md (必ず先読み)
作業ログ: docs/phase4-sonnet-work-log.md に時刻 / 試行 / エラー / 判断を逐次記録

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

### 9.2. Opus 直実装 batch (4b / 4c / 4d / 4i)

判断系 batch は全て Opus 直。Phase 3 incident (Codex 4 ラウンド連打) の再発防止のため、push 前に **memory `feedback_pre_push_self_review.md` のチェックリスト 7 項目を必ず通過**。

### 9.3. ブランチ戦略

- 分岐元: main `39f55a3` (PR #40 merge 後)
- ブランチ名: `feat/tool-surface-v1-phase4`
- PR 作成タイミング: 全 batch 完了 + Opus 自己レビュー BLOCKING ゼロ + pre-push checklist 通過後

---

## 10. Review checklist (Opus 自己レビュー + Codex)

### 10.1. 公開面整合性

- [ ] `tools/list` で 26 stub catalog tool + 2 dynamic v2 = 28 ツールのみ返る
- [ ] 20 旧 tool が消える (events_* 4 / perception_* 4 / get_history / mouse_move / screenshot_background / screenshot_ocr / scope_element / set_element_value / get_active_window / get_cursor_position / get_document_state / get_screen_info / get_ui_elements / get_windows)
- [ ] screenshot schema が mode / detail='ocr' / region フィールドを持つ
- [ ] desktop_act schema が action='setValue' を持つ
- [ ] desktop_state schema が includeCursor / includeScreen / includeDocument flag を持つ
- [ ] stub catalog の expected count に整合 (26 件)

### 10.2. LLM 露出文字列 (pre-push checklist §5)

- [ ] grep audit: 旧 20 tool 名が `description` / `suggest` / `error.message` / `failWith` 第 2 引数 / engine 層 literal type に残っていない
- [ ] CHANGELOG.md v1.0.0 entry に Phase 4 mapping 全件追記済
- [ ] README.md / README.ja.md のテーブル / workflow examples が新形式

### 10.3. handler 残置確認 (memory `feedback_disable_via_entry_block.md`)

- [ ] events_* 4 handler / schema が internal export
- [ ] perception_* 4 handler / schema が internal export
- [ ] getHistoryHandler / mouseMoveHandler / screenshotBackgroundHandler / screenshotOcrHandler / scopeElementHandler / setElementValueHandler / getActiveWindowHandler / getCursorPositionHandler / getDocumentStateHandler / getScreenInfoHandler / getUiElementsHandler / getWindowsHandler が internal export

### 10.4. workflow / API 互換 (機能ロスゼロ)

- [ ] `screenshot({mode:'background'})` で旧 `screenshot_background` 互換動作
- [ ] `screenshot({detail:'ocr', ocrLanguage:'ja'})` で旧 `screenshot_ocr` 互換動作
- [ ] `screenshot({region:{x,y,width,height}})` で旧 `scope_element` 互換動作
- [ ] `desktop_act({action:'setValue', lease, value})` で旧 `set_element_value` 互換動作
- [ ] `desktop_state({includeCursor:true})` で旧 `get_cursor_position` 互換情報を含む
- [ ] `desktop_state({includeScreen:true})` で旧 `get_screen_info` 互換情報を含む
- [ ] `desktop_state({includeDocument:true})` で旧 `get_document_state` 互換情報を含む
- [ ] `desktop_state({})` の `focusedWindow` が旧 `get_active_window` 互換情報を含む
- [ ] `desktop_discover({windowTitle})` の `actionable[]` が旧 `get_ui_elements` 互換情報を含む
- [ ] `desktop_discover({}).windows[]` が旧 `get_windows` 互換情報を含む

### 10.5. テスト

- [ ] vitest unit 全パス (Phase 3 ベース 2131 + Phase 4 新規 30+ ≒ 2160+)
- [ ] vitest e2e 全パス (含む http-transport の閾値更新)
- [ ] Pre-existing flaky 2 件以外失敗なし
- [ ] `.vitest-out-e2e.txt` の最終結果に "JSON report written" を含む

### 10.6. ビルド / lint

- [ ] `tsc --noEmit` exit 0
- [ ] `npm run build` exit 0
- [ ] discriminatedUnion narrowing が switch case 内で正しく型推論される

### 10.7. docs

- [ ] README.md / README.ja.md の table + workflow が新形式
- [ ] system-overview.md の events / perception / get_* sections 統合または削除
- [ ] tool-surface-reduction-plan.md §15 Phase 4 が Implemented ステータス
- [ ] tool-surface-known-issues.md §4 が更新済 (Phase 5 引継ぎ事項を §4.5 に追加)

### 10.8. PR description

- [ ] CHANGELOG diff へリンク
- [ ] 旧 → 新 mapping 表 (§4.1) を含む
- [ ] handler 残置方針 (memory `feedback_disable_via_entry_block.md`) を明記
- [ ] 検証結果 (unit / e2e count) を含む
- [ ] Codex review request コメントに「Phase 4 privatize/absorb, see design doc」を含める

### 10.9. Pre-push self-review checklist (memory `feedback_pre_push_self_review.md`)

- [ ] §1 payload shape 判定確認
- [ ] §2 wrapper / decorator 網羅性
- [ ] §3 自動生成 artifact (stub-tool-catalog.ts) を grep で shape 検証
- [ ] §4 未使用パラメータ / dead code 削除
- [ ] §5 リネーム grep audit
- [ ] §6 テストの shape verification
- [ ] §7 最終ドライラン (tsc + vitest + 生成物 grep)

---

## 11. Phase 5 引継ぎ事項 (sketch)

Phase 4 完了時に `docs/tool-surface-known-issues.md` §4.5 (新規) に記載:

- **dogfood verify の重点ポイント**:
  - Multi-monitor 環境で `desktop_state.includeScreen=true` の monitor info 正確性
  - `desktop_act(action='setValue')` の UIA ValuePattern 失敗時の挙動 (suggestedFix の提示等)
  - `screenshot(detail='ocr')` の OCR 言語自動判定 (Phase 4 では明示 ocrLanguage、Phase 5 で自動化判断)
  - `mouse_move` 削除後の hover 系 UI 影響 — 必要なら facade 化検討
  - `events_*` / `perception_*` 削除後の代替動線 — `wait_until` で全部カバーできるか
- **v1.0.0 release smoke test**:
  - 別マシンで `npx -y @harusame64/desktop-touch-mcp` → tools/list が 28 ツール
  - run_macro DSL 旧名 fail / 新名 OK の動作
  - Glama listing / MCP Registry 更新

---

## 12. 結論

Phase 4 は Tool Surface Reduction の **最大削減 phase** (-20 tools、約 43% 削減)。Phase 1+2+3 の積み重ねにより、入り口削除と response field 拡張で能力ロスゼロを達成できる:

1. **入り口削除 10 件** — events / perception / get_history / mouse_move (handler 残置で revert 容易)
2. **screenshot 吸収 3 件** — mode='background' / detail='ocr' / region:{...} optional params
3. **desktop_act 吸収 1 件** — action='setValue' 追加
4. **desktop_state 吸収 4 件** — includeCursor / includeScreen / includeDocument flag + 既存 focusedWindow
5. **desktop_discover 吸収 2 件** — actionable[] / windows[] response field を get_* 互換に

**完了基準**: design ↔ plan ↔ implementation の 3 者一致を Opus 自己レビュー (pre-push checklist 含む) が確認、Codex BLOCKING ゼロ、main merge 後 Phase 5 dogfood 着手可能状態。

最終的に Phase 5 dogfood で v1.0.0 cut の **「48 → 28 public tools (能力ロスゼロ)」** を確定し、release フローへ。
