# Phase 1 設計書 — Naming Redesign + 主軸 family 責務境界凍結

- Status: Draft (2026-04-25) — ユーザー approve 待ち
- 設計者: Claude (Opus 4.7)
- 実装担当: Sonnet 4.6 (起動方法は §11 + 既存 `docs/phase4b-sonnet-prompt.md` Prompt 2 を流用)
- 対応プラン: `docs/tool-surface-reduction-plan.md` §6.1 / §6.3 / §15 Phase 1 / §16 互換性ポリシー
- 対応 handbook: `docs/phase4b-implementation-handbook.md` §3 設計書テンプレ全 9 セクション
- 並走前提: Phase 4b dogfood (PR #34 merged 後の `docs/phase4b-dogfood-runbook.md`) と独立 — Phase 1 は Phase 4b の機能 (vision-gpu) と互いに干渉しない

---

## 1. Goal

Phase 1 のゴールは、tool surface reduction plan §6 の **「主軸 3 family の命名再設計と責務境界凍結」** + その他確定リネーム (`server_status`、browser_* 6 ツール) を **breaking change として一括投入** すること。

具体的に達成すべきこと:

1. 主軸 3 family の **リネーム + schema 凍結**:
   - `get_context` → `desktop_state` (read-only 観測、attention フィールド吸収)
   - `desktop_see` → `desktop_discover` (lease 発行 + actionable / windows)
   - `desktop_touch` → `desktop_act` (lease 消費 + 操作 + attention 吸収)
2. 確定リネーム 7 ツール:
   - `engine_status` → `server_status`
   - `browser_connect` → `browser_open`
   - `browser_click_element` → `browser_click`
   - `browser_fill_input` → `browser_fill`
   - `browser_get_form` → `browser_form`
   - `browser_get_interactive` → `browser_overview`
   - `browser_find_element` → `browser_locate`
3. **MCP server instructions text の全面書き換え** (Standard workflow / Clicking priority / Observation priority / Recovery path / Reactive Perception)
4. README / README.ja / docs / `stub-tool-catalog.ts` / `tool-descriptions.test.ts` の全面更新
5. **alias なしで即破壊** (互換性ポリシー §16)
6. 各 Phase 完了時の instructions 再見直しタイミングを明文化 (§4.5 計画)

**Phase 1 の範囲外** (Phase 4 に回す):
- `get_*` 系 8 ツールの吸収 (`includeCursor` / `includeScreen` 等の `desktop_state` フィールド実装)
- `set_element_value` の `desktop_act` 内部統合
- `screenshot_background` / `screenshot_ocr` / `scope_element` の `screenshot` パラメータ吸収
- `events_*` / `perception_*` / `get_history` / `mouse_move` / `browser_disconnect` の入り口削除 (handler 残置)

Phase 1 は **「枠を作る」** のが目的。**中身の吸収は Phase 2-4** で順次。

---

## 2. Files to touch

### 新規作成

なし。リネーム中心。

### リネーム (ファイル名変更 + 内容書き換え)

- `src/tools/context.ts` → **`src/tools/desktop-state.ts`**
  - export 名: `registerContextTools` → `registerDesktopStateTools`
  - tool 登録名: `get_context` → `desktop_state`
  - handler 関数名: `getContextHandler` → `desktopStateHandler`
  - schema export 名: `getContextSchema` → `desktopStateSchema`
- `src/tools/engine-status.ts` → **`src/tools/server-status.ts`**
  - export 名: `registerEngineStatusTool` → `registerServerStatusTool`
  - tool 登録名: `engine_status` → `server_status`
  - handler 関数名: `engineStatusHandler` → `serverStatusHandler` (もしあれば)

### 内部書換 (ファイル名は据え置き、tool 登録名のみ変更)

- `src/tools/desktop-register.ts`
  - `desktop_see` → `desktop_discover`
  - `desktop_touch` → `desktop_act`
  - レスポンスに `attention` フィールドを必須で含める (Phase 4b の Auto Perception 出力を流用)
- `src/tools/browser.ts`
  - `browser_connect` → `browser_open`
  - `browser_click_element` → `browser_click`
  - `browser_fill_input` → `browser_fill`
  - `browser_get_form` → `browser_form`
  - `browser_get_interactive` → `browser_overview`
  - `browser_find_element` → `browser_locate`

### import 経路 / 呼び出し更新

- `src/server-windows.ts`
  - import: `./tools/context.js` → `./tools/desktop-state.js`、`./tools/engine-status.js` → `./tools/server-status.js`
  - 呼び出し: `registerContextTools(s)` → `registerDesktopStateTools(s)`、`registerEngineStatusTool(s)` → `registerServerStatusTool(s)`
  - **instructions text を §4 仕様に従い全面書き換え**
- `src/stub-tool-catalog.ts` (generator: `scripts/generate-stub-tool-catalog.mjs`)
  - エントリ 9 件のリネーム反映 (主軸 3 + server_status + browser 6)
  - 再生成は generator 経由で行う (手動 edit 禁止)

### テスト

- `tests/unit/tool-descriptions.test.ts`
  - 期待値 tool 名を更新 (主軸 3 + server_status + browser 6)
  - 旧名参照箇所をすべて新名へ
- 主軸 3 family の handler テストファイル (もしあれば、要 grep):
  - `tests/unit/desktop-touch-*.test.ts` 内の tool 名参照を `desktop_act` に
  - `tests/unit/desktop-see-*.test.ts` 内の tool 名参照を `desktop_discover` に
  - `tests/unit/get-context-*.test.ts` (もしあれば) を `desktop_state` に

### docs

- `README.md` / `README.ja.md`
  - tool 名一覧の更新
  - mental model 説明セクション (state / discover / act の 3 段)
- `docs/system-overview.md`
  - 主軸 3 family の説明追加
  - 旧名から新名への mapping 追記
- `docs/tool-surface-reduction-plan.md`
  - Status を Phase 1 完了で更新 (実装後)
- `CHANGELOG.md` (新規 or 既存に追記)
  - v1.0.0 entry のドラフト (release notes 必須事項 §16.2 を含む)

### 削除禁止 (handler 残置方針 / Phase 1 範囲外)

- `src/tools/events.ts` — Phase 4 で入り口削除、Phase 1 は触らない
- `src/tools/perception.ts` / `src/tools/perception-resources.ts` — Phase 4 で入り口削除、Phase 1 は触らない
- `src/engine/event-bus.ts` / `src/engine/perception/registry.ts` — engine 層、絶対残置
- `src/tools/scope-element.ts` (もしあれば) — Phase 4 で screenshot 吸収、Phase 1 では無触
- `src/tools/screenshot.ts` の `screenshot_background` / `screenshot_ocr` 部分 — Phase 4 でパラメータ統合
- `bin/win-ocr.exe` / `PocVisualBackend` — Tier ∞ safety net

### 削除 (alias なしの即破壊 §16.1)

なし (Phase 1 範囲では「リネーム」のみ。完全削除は Phase 4 の入り口塞ぎで行う)。

---

## 3. API design

### 3.1. `desktop_state` (旧 `get_context`)

```ts
// src/tools/desktop-state.ts
export const desktopStateSchema = {
  // Phase 1 では現行 get_context schema を継承
  // includeCursor / includeScreen / includeDocument は Phase 4 で追加
  windowTitle: z.string().optional().describe("Target window. Defaults to focused window."),
};

export interface DesktopStateResponse {
  focusedWindow: { title: string; hwnd: number; region: Rect };
  focusedElement?: { name?: string; role?: string; value?: string };
  modal: boolean;
  // ★ Phase 1 で必須化: Auto Perception 由来の attention 信号
  attention: "ok" | "dirty" | "identity_changed" | "guard_failed" | "settling" | "stale" | "changed";
  // 以下は Phase 4 で includeXxx flag に応じて optional 追加:
  // cursor?, screen?, document?
}

export const desktopStateHandler = async (
  args: z.infer<z.ZodObject<typeof desktopStateSchema>>
): Promise<ToolResult> => { /* 旧 getContextHandler のロジック流用 + attention 取得 */ };

export function registerDesktopStateTools(server: McpServer): void {
  server.tool(
    "desktop_state",
    buildDesc({
      purpose: "Read-only observation of the current desktop state. Returns focused window/element, modal flag, and attention signal from Auto Perception.",
      details: "Cheapest observation tool — use after each action to confirm state. attention='ok' means safe to proceed; other values require recovery (see suggest[]).",
      examples: ["desktop_state() → check attention before next action"],
    }),
    desktopStateSchema,
    desktopStateHandler
  );
}
```

### 3.2. `desktop_discover` (旧 `desktop_see`)

```ts
// src/tools/desktop-register.ts (内部書換、ファイル名据え置き)
// 現行 desktop_see schema を継承。lease 発行は維持。
// レスポンスに windows[] を併記 (Phase 4 で get_windows 吸収先として準備)

server.tool(
  "desktop_discover",
  buildDesc({
    purpose: "Find actionable entities and emit leases for desktop_act. Replaces desktop_see.",
    details: "Returns actionable[] (entity candidates with lease+ttl+digest) and windows[] (window list). Use after desktop_state if action target needed.",
    examples: ["desktop_discover({textIncludes:'OK'}) → pick lease → desktop_act(lease, action='click')"],
  }),
  desktopSeeSchema, // 既存 schema を継承
  async (args) => {
    const result = await desktopSeeHandler(args);
    // windows[] 補強は Phase 4 で実装、Phase 1 は actionable[] のみで OK
    return result;
  }
);
```

### 3.3. `desktop_act` (旧 `desktop_touch`)

```ts
// src/tools/desktop-register.ts (内部書換)
// 現行 desktop_touch schema を継承。レスポンスに attention 必須化。

server.tool(
  "desktop_act",
  buildDesc({
    purpose: "Act on a discovered entity (click/type/setValue/scroll). Replaces desktop_touch.",
    details: "Consumes lease from desktop_discover. On ok=false, read reason and follow recovery path. Response always includes attention signal.",
    examples: [
      "desktop_act({lease, action:'click'}) → ok+attention",
      "desktop_act({lease, action:'type', text:'hello'}) → ok+attention",
    ],
  }),
  desktopTouchSchema, // 既存 schema を継承
  async (args) => {
    const result = await desktopTouchHandler(args);
    // attention は既に Phase 4b Auto Perception で吸収済 (post.perception)
    // Phase 1 では返却フィールド名を attention に統一する程度で OK
    return result;
  }
);
```

### 3.4. `server_status` (旧 `engine_status`)

```ts
// src/tools/server-status.ts (リネーム後)
export const serverStatusSchema = {}; // 引数なし、現行と同じ

export const serverStatusHandler = async (): Promise<ToolResult> => {
  /* 旧 engineStatusHandler のロジック流用 */
};

export function registerServerStatusTool(server: McpServer): void {
  server.tool(
    "server_status",
    "Return MCP server status: version / native engine availability / Auto Perception state / v2 activation.",
    serverStatusSchema,
    serverStatusHandler
  );
}
```

### 3.5. browser family リネーム (6 ツール)

`src/tools/browser.ts` 内で機械的リネーム。schema / handler の中身は不変、tool 登録名と export 名のみ更新:

| 旧 tool 名 | 新 tool 名 | export 名 (旧 → 新) |
|---|---|---|
| `browser_connect` | `browser_open` | `browserConnectSchema` → `browserOpenSchema` (任意) |
| `browser_click_element` | `browser_click` | `browserClickElementSchema` → `browserClickSchema` (任意) |
| `browser_fill_input` | `browser_fill` | `browserFillInputSchema` → `browserFillSchema` (任意) |
| `browser_get_form` | `browser_form` | `browserGetFormSchema` → `browserFormSchema` (任意) |
| `browser_get_interactive` | `browser_overview` | `browserGetInteractiveSchema` → `browserOverviewSchema` (任意) |
| `browser_find_element` | `browser_locate` | `browserFindElementSchema` → `browserLocateSchema` (任意) |

export 名 (TS の symbol 名) のリネームは内部だけの問題で、tool 登録名さえ正しければ OK。Sonnet 判断で「旧名のまま (機械的に schema 名を変えない)」も §8 範囲内とする。

### 3.6. 削除する旧 tool 登録 (alias なし即破壊 §16.1)

- `get_context` の `server.tool("get_context", ...)` 呼び出しを削除
- `engine_status` の `server.tool("engine_status", ...)` 呼び出しを削除
- `desktop_see` の `server.tool("desktop_see", ...)` 呼び出しを削除
- `desktop_touch` の `server.tool("desktop_touch", ...)` 呼び出しを削除
- `browser_connect` 〜 `browser_find_element` の旧名 `server.tool` 呼び出しを削除

handler / schema 定義は残置せず、新名で完全置換 (Phase 1 のリネーム対象は旧名 = 新名の同義語であり、handler 残置の意味がない)。

---

## 4. Instructions text 更新仕様

`src/server-windows.ts:83-164` の `instructions` プロパティ全面書き換え。

### 4.1. Standard workflow

```
## Standard workflow
1. desktop_state — orient: focused window/element, modal, attention signal
2. desktop_discover — find actionable entities (returns lease)
3. desktop_act(lease, action) — act on entity (returns attention)
4. desktop_state — confirm
```

### 4.2. Clicking — priority order

```
## Clicking — priority order
1. browser_click(selector) — Chrome/Edge (CDP, stable across repaints)
2. desktop_act(lease, action='click') — native/dialog/visual (entity-based; use after desktop_discover)
3. click_element(name or automationId) — native UIA fallback if desktop_act ok=false
4. mouse_click(x, y, origin?, scale?) — pixel last resort; origin+scale from dotByDot screenshots only
```

### 4.3. desktop_act 失敗時の recovery

```
## When desktop_act returns ok:false
Read reason and follow the recovery path:
  lease_expired / lease_generation_mismatch / lease_digest_mismatch / entity_not_found → re-call desktop_discover;
  modal_blocking → dismiss modal via click_element, then retry;
  entity_outside_viewport → scroll via scroll/scroll_to_element, then re-call desktop_discover;
  executor_failed → fall back to click_element / mouse_click / browser_click
```

### 4.4. Observation — priority order

```
## Observation — priority order
1. desktop_state — cheapest; focused element, modal, attention
2. desktop_discover — actionable entities + lease (when action target needed)
3. screenshot(detail='text') — actionable elements with coords (visual fallback)
4. screenshot(dotByDot=true) — pixel-accurate image when text mode returns 0 elements
5. screenshot(detail='image', confirmImage=true) — visual inspection only
```

### 4.5. attention 値と recommended actions (Reactive Perception 統合版)

旧 `## Reactive Perception (lensId-based workflow)` セクションを丸ごと差し替える。Phase 1 では明示 lens ツールを公開しないため、attention は `desktop_state` / `desktop_act` レスポンスに常時含まれる前提:

```
## Attention signal (auto-perception)
desktop_state and desktop_act responses always include attention. Read it after each action:
  ok               — safe to act
  changed          — state updated; verify before next action
  dirty            — evidence pending; call desktop_state to refresh
  settling         — UI in motion; wait then call desktop_state
  stale            — evidence may be old; call desktop_state
  guard_failed     — unsafe; read suggestedAction in response
  identity_changed — window was replaced; re-discover with desktop_discover
```

### 4.6. その他のセクション

- `## Terminal workflow` — Phase 2 で `terminal(action='run')` 統合時に再更新する旨をコメント
- `## Waiting for state changes` — `wait_until` のまま (変更なし)
- `## Failure recovery` — tool 名を新名に置換 (`get_windows` → `desktop_discover`、`focus_window` 維持等)
- `## Scroll capture` — Phase 2 で scroll 統合時に再更新
- `## Auto-dock CLI window` — `dock_window` → Phase 2 で `window_dock(action='dock')` に変更後再更新
- `## Emergency stop (Failsafe)` — 変更なし

### 4.7. 各 Phase 完了時の instructions 再見直しタイミング (Opus 計画)

| Phase | 再更新する instructions セクション | 理由 |
|---|---|---|
| Phase 2 完了時 | `## Terminal workflow` / `## Scroll capture` / `## Auto-dock CLI window` / 一部 Failure recovery | terminal/scroll/keyboard/clipboard/window_dock 統合に伴い旧 tool 名が消える |
| Phase 3 完了時 | `## Clicking — priority order` の `browser_click` 詳細 / 関連 examples | browser リネーム + browser_get_dom/get_app_state を browser_eval に吸収、browser_disconnect 削除 |
| Phase 4 完了時 | `## Observation — priority order` の `screenshot` 詳細 / `## Failure recovery` の get_windows 言及 | screenshot_background/ocr/scope_element の吸収、get_* 系の最終吸収、events_*/perception_* 入り口削除 |
| Phase 5 dogfood 中 | 全 instructions の最終 polishing | 実運用フィードバックを反映、release notes と矛盾しないよう調整 |

各 Phase 設計書冒頭でこの表を参照し、該当 section の差分を明示する。

---

## 5. Done criteria (binary check)

- [x] `tsc --noEmit` exit 0
- [x] `npm run test:capture > .vitest-out.txt` 全パス、regression 0
- [x] `tools/list` RPC で以下の名前のみ返ること (旧名一切返さない):
  - 主軸 3: `desktop_state` / `desktop_discover` / `desktop_act`
  - リネーム 7: `server_status` / `browser_open` / `browser_click` / `browser_fill` / `browser_form` / `browser_overview` / `browser_locate`
  - 旧名で grep して `server.tool("旧名"` の hit が 0 件
- [x] `src/stub-tool-catalog.ts` の旧名エントリが 0 件 (generator 経由で再生成)
- [x] `tests/unit/tool-descriptions.test.ts` の期待値が新名のみ
- [x] `src/server-windows.ts` の instructions 内に旧名の文字列が出現しない
- [x] README.md / README.ja.md / docs/system-overview.md の旧名 mention が 0 件
- [x] CHANGELOG.md に v1.0.0 entry のドラフト (旧→新 mapping 表 + 削除対象一覧 + 吸収先明示)
- [x] 既存 e2e テストで旧名を呼んでいる箇所がある場合、新名に書換 (handbook §4.1 のテスト書換禁止は assertion 緩和の話であり、tool 名追従は許容)
- [x] handler 残置対象 (`events_*` / `perception_*` / 他 Phase 4 対象) のコードに変更 0

---

## 6. Test cases (最低カバー要件)

`tests/unit/tool-naming-phase1.test.ts` を新規作成し、最低以下を含む:

### 正常系

1. **`desktop_state` registered**: server に `desktop_state` ツールが登録され、handler が旧 `getContext` と同一の動作 (focused window/element/modal を返す)
2. **`desktop_discover` registered with lease emission**: 既存 desktop_see テストの assertion を新名で再実行
3. **`desktop_act` consumes lease**: 既存 desktop_touch テストの assertion を新名で再実行
4. **`server_status` returns version**: SERVER_VERSION が返却される
5. **`browser_open` registered (旧 browser_connect 動作)**: schema が継承されている
6. **`browser_click` / `browser_fill` / `browser_form` / `browser_overview` / `browser_locate` registered**: 各々の schema が旧名と同等

### 失敗系 (旧名の不在検証)

7. **旧名 `get_context` が tools/list に出ない**: server.tool が 1 度も呼ばれていない
8. **旧名 `desktop_see` / `desktop_touch` が tools/list に出ない**
9. **旧名 `engine_status` / `browser_connect` 等 6 ツールが tools/list に出ない**

### 境界

10. **attention フィールドが `desktop_state` / `desktop_act` レスポンスに常時含まれる**: enum 7 値のいずれか
11. **stub-tool-catalog 整合**: `STUB_TOOL_CATALOG` の name が tools/list 結果と完全一致 (旧名 0 件)

### regression

12. **`tool-descriptions.test.ts` 期待値テスト**: tier 化された description が新名で全部存在する
13. **既存 unit tests のうち、tool 名参照箇所が新名で動作する** (主軸 3 family + browser 6 が対象、検索条件は `grep -r "get_context\\|desktop_see\\|desktop_touch\\|engine_status\\|browser_connect\\|browser_click_element\\|browser_fill_input\\|browser_get_form\\|browser_get_interactive\\|browser_find_element" tests/`)

---

## 7. Known traps

### 7.1. v0.17 の v2 default-on logic と整合

`src/server-windows.ts:43-74` の v2 activation logic は `_desktopV2` として動的 import している。Phase 1 でリネームした関数 (`registerDesktopTools`) の export 名は **据え置き** (内部 register 関数の export 名)、tool 登録時の `server.tool("desktop_act", ...)` 部分のみ変更すること。export 名まで変えると `_desktopV2.registerDesktopTools(s)` 呼び出しが壊れる。

### 7.2. tool-descriptions.test.ts の固定 tool 数

memory `feedback_stub_catalog_generator.md` 参照。`stub-tool-catalog.ts` / `generator` / `contract test` の 3 か所同時更新必須。Phase 1 ではツール **数** は変わらない (リネームのみ) ため、固定値の N tools 数値は不変。**ただし name の期待値は全更新**。

### 7.3. `_desktopV2` モジュールの v2 default-on 環境変数 (`DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2`)

v0.17 で v2 が default-on になったため、`_v2Enabled` のテスト分岐が変わっている。Phase 1 のテストでは v2 enabled 状態で `desktop_discover` / `desktop_act` が登録されることを前提とする。disabled パス (kill-switch) は別途テスト。

### 7.4. e2e テストでの旧 tool 名参照

`tests/e2e/` 配下に旧名 (`get_context` / `desktop_see` / `desktop_touch` 等) を直接呼んでいるテストが存在する可能性。grep で全部洗い出して新名に置換。assertion は変えない (handbook §4.1)。

### 7.5. README / docs の embedded code blocks

README には tool 名を含むサンプルコードが多数。grep で全部洗い出して新名に置換。バックティック内も対象。

### 7.6. Auto Perception の attention 値 enum

現行の `attention` 値は `src/tools/desktop-register.ts` の `post.perception` 経由で出力される。enum は `"ok" | "changed" | "dirty" | "settling" | "stale" | "guard_failed" | "identity_changed"` の 7 値。Phase 1 では `desktop_state` レスポンスにも同じ enum を流用 (新 enum 定義はしない)。

### 7.7. browser family の handler 内の console log メッセージ

browser handler 内で `[browser_click_element]` のような log prefix が散在している可能性。grep して `[browser_click]` 等に置換。Sonnet 判断 §8 範囲内とする。

### 7.8. release-process.md / smoke-test の tool 名参照

`docs/release-process.md` の `tools/list` 期待値や `docs/smoke-test.ps1` (gitignored、ローカル) に旧名がある可能性。Phase 1 では release-process.md のみ更新、smoke-test.ps1 はローカルのため対象外 (memory `feedback_smoke_test_ps1.md` 参照)。

### 7.9. instructions text の文字数

現行 instructions は約 4500 chars。新文面に書き換えると同程度になる見込み。MCP `initialize` レスポンスの instructions field は通常制限ないが、念のため文字数 check。

---

## 8. Acceptable Sonnet judgment scope

設計書内で Sonnet が決めて良い:

- **handler 内部 log message の置換** (例: `[get_context]` → `[desktop_state]`)
- **export 名 (TS symbol)** のリネーム判断 (関数名・schema 名は handler ロジックを表現するなら任意。tool 登録名は本書で固定)
- **コメント / docstring の追加 / 翻訳調整** (LLM 向け description は本書 §3 ドラフトを基準、肉付けは Sonnet 判断)
- **lint warning 修正** (eslint / tsc strict)
- **import 順序の整理**
- **追加テストケース** (本書 §6 の最低 13 ケース + α は OK)
- **e2e テスト内の tool 名置換** (assertion は変更しない、handbook §4.1)
- **commit 分割粒度** (1a/1b/1c の 3 commit、または最終 1 commit のいずれでも OK、PR は 1 つ)

---

## 9. Forbidden Sonnet judgments

Sonnet が独自に決めてはいけない:

- **tool 登録名の変更** (本書 §3 で固定、新名のスペル変更不可)
- **schema 構造の変更** (Phase 1 ではリネームのみ、フィールド追加 / 削除 / 型変更禁止 — Phase 4 で行う)
- **handler ロジックの変更** (旧名 → 新名の同義語リネーム以外の動作変更禁止)
- **handler 残置対象 (`events_*` / `perception_*` / 他 Phase 4 対象) のファイル変更**
- **engine 層 (`src/engine/event-bus.ts` / `src/engine/perception/registry.ts` 等) の変更**
- **既存テストの assertion 緩和** (handbook §4.1)
- **Phase 4b skeleton (vision-gpu / native engine) の変更**
- **`src/version.ts` / `package.json:version` の変更** (v1.0.0 release は Phase 5 完了後、§16.3)
- **`bin/launcher.js` / `.github/workflows/release.yml` の変更** (リリース経路、Opus 設計で承認後のみ)
- **alias / deprecation 機構の追加** (§16.1 で即破壊と確定)
- **stub-tool-catalog.ts の手動編集** (generator 経由のみ、`scripts/generate-stub-tool-catalog.mjs` 経由)
- **新規 tool 追加** (Phase 1 はリネームのみ)

これらに該当する判断が必要になったら、即 Opus 委譲 (handbook §5 stop conditions)。

---

## 10. サブ batch 分割と実装順序

Phase 1 は規模が大きいため、3 サブ batch に分けて段階実装:

### Phase 1a: 主軸 3 family リネーム (commit 1)

- `src/tools/context.ts` → `src/tools/desktop-state.ts` rename + 内容書換
- `src/tools/desktop-register.ts` 内部の `desktop_see` / `desktop_touch` 登録名を `desktop_discover` / `desktop_act` に変更
- レスポンスの `attention` フィールドを `desktop_state` / `desktop_act` 双方で必須化
- `src/server-windows.ts` の import / 呼び出しを更新 (1a 範囲のみ)
- 関連 unit tests の tool 名参照を更新 (主軸 3 family のみ)
- 検証: `tsc --noEmit` + `npm run test:capture` 全パス

### Phase 1b: 確定リネーム 7 ツール (commit 2)

- `src/tools/engine-status.ts` → `src/tools/server-status.ts` rename
- `src/tools/browser.ts` 内 6 tool 登録名のリネーム (`browser_open` / `browser_click` / `browser_fill` / `browser_form` / `browser_overview` / `browser_locate`)
- `src/server-windows.ts` の import / 呼び出しを更新 (1b 範囲)
- handler 内 log prefix の置換
- 関連 unit tests の tool 名参照を更新 (server_status + browser 6)
- 検証: `tsc --noEmit` + `npm run test:capture` 全パス

### Phase 1c: instructions / docs / stub catalog / tests 全更新 (commit 3)

- `src/server-windows.ts` の instructions text を §4 仕様に従い全面書き換え (Phase 2-4 で再更新する section にコメント追加)
- `src/stub-tool-catalog.ts` を generator (`scripts/generate-stub-tool-catalog.mjs`) 経由で再生成
- `tests/unit/tool-descriptions.test.ts` 期待値の新名対応
- `README.md` / `README.ja.md` / `docs/system-overview.md` の tool 名・mental model 更新
- `CHANGELOG.md` v1.0.0 entry のドラフト追加 (旧 → 新 mapping 表 + 削除対象一覧 + 吸収先明示は Phase 4 完了時に最終版)
- `docs/tool-surface-reduction-plan.md` の Status を「Phase 1 Implemented」に flip + commit hash 記載
- 検証: 全 Done criteria (§5) を確認

### 順序 (絶対遵守)

1. Phase 1a → tsc + test pass → commit
2. Phase 1b → tsc + test pass → commit
3. Phase 1c → 全 Done criteria pass → commit
4. PR 作成 (1 PR で 3 commit)

各 commit は **stand-alone で動作する** ことが必須。Phase 1a で旧名を消す際、新名 register が同 commit 内にあること。

---

## 11. 実装着手 prompt (Sonnet)

`docs/phase4b-sonnet-prompt.md` Prompt 2 を流用しつつ、本 Phase 1 用に context 差し替え:

```text
あなたは Sonnet 4.6、Phase 1 (Tool Surface Reduction) の実装担当です。
Opus が docs/tool-surface-phase1-naming-design.md に設計書を書いたので、
それを **厳密に** 実装してください。

## 絶対に読むこと (起動直後に Read、この順序)

1. D:/git/desktop-touch-mcp/docs/tool-surface-phase1-naming-design.md
   ← これが今回の唯一の真実。これに書いてないことはやらない。
2. D:/git/desktop-touch-mcp/docs/phase4b-implementation-handbook.md
   特に §4 絶対条件、§5 stop conditions、§6.1 Sonnet 報告フォーマット
3. D:/git/desktop-touch-mcp/docs/tool-surface-reduction-plan.md §6.1 / §6.3 / §16

## 実装ルール

- 設計書 §2 Files to touch のリスト以外のファイルは触らない
- 設計書 §3 API design の tool 登録名を一字一句変えない
- 設計書 §6 Test cases を最低限カバー (Sonnet 判断で +α は OK)
- 設計書 §8 内なら自由に判断 (命名 / コメント / lint 修正)
- 設計書 §9 に該当する判断が必要になったら **即座に作業を止めて Opus 委譲**
- 実装順序は §10 の 1a → 1b → 1c を厳守、各 commit ごとに tsc + test pass を確認

## Stop conditions (handbook §5 から再掲)

(handbook §5 をそのまま参照)

## 完了基準

設計書 §5 Done criteria 全てが [x] になり、かつ tsc + test 全パス。
完了時は handbook §6.1「Sonnet → Opus」フォーマットで報告 + Opus レビュー要請。
notification_show で Windows 通知も出すこと。
```

---

## 12. 想定 diff size

- Phase 1a: 約 200-300 行 diff (主軸 3 ファイル + tests)
- Phase 1b: 約 100-200 行 diff (browser + engine-status)
- Phase 1c: 約 300-500 行 diff (instructions + stub-catalog + README + docs)
- 合計: 約 600-1000 行 diff (1 PR)

---

## 13. Risk と対応

| Risk | 影響 | 対応 |
|---|---|---|
| e2e テスト全壊 (旧名参照) | High | Phase 1a 着手前に grep で網羅、§7.4 |
| README/docs 更新漏れ | Medium | Phase 1c 完了時 grep で確認 (§5 Done criteria) |
| stub catalog generator のエッジケース | Medium | memory `feedback_stub_catalog_generator.md` を Sonnet が事前 read |
| v2 default-on logic 破壊 | High | export 名据え置きで吸収 (§7.1) |
| attention enum 値の表記揺れ | Low | 既存 `post.perception` を流用 (§7.6) |

---

## 14. Status

**Status: Implemented (2026-04-25)**

実装: Sonnet 4.6 (branch: tool-surface-v1)
完了後 Opus レビュー: 別 subagent でレビュー予定。

---

END OF DESIGN.
