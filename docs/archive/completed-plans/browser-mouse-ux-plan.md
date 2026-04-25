# Claude Desktop FB — browser/mouse UX 4 件 設計計画

**Target branch**: `feat/anti-fukuwarai` (PR #7) に追加 — hints/post 哲学の延長なので同 PR に同居させて Ready for review に昇格させる

**Source**: `memory/project_claude_desktop_fb_browser_ux.md` — 2026-04-13 に Claude Desktop で AWS コンソール作業中に発見された UX 欠損。優先度 ②→①→③→④ で、②と①が迷走の直接原因。

**Implementation model**: Sonnet。**Design/Review**: Opus。

---

## スコープサマリ

| 順 | 変更箇所 | 追加 field / param | 実装規模 |
|---|---|---|---|
| ② | `src/tools/mouse.ts::mouseClickHandler` | `focusLost: { afterMs, expected, stolenBy, stolenByProcessName }` | 小 |
| ① | `src/tools/browser.ts` の 6 handler + `src/engine/cdp-bridge.ts` helper | `activeTab: {id,title,url}` + `readyState` | 中 |
| ③ | `src/tools/browser.ts::browserNavigateHandler` | param `waitForLoad=true`、応答に `readyState/title/url/elapsedMs` | 小 |
| ④ | `src/tools/browser.ts::browserConnectHandler` | `tabs[].active` + top-level `active` | 小 |
| ⑤ | `src/engine/win32.ts` + 4 action tools | `forceSetForegroundWindow` + `forceFocus?:boolean` + env `DESKTOP_TOUCH_FORCE_FOCUS` + `hints.warnings:["ForceFocusRefused"]` | 中 |
| ⑥ | `src/tools/keyboard.ts` (type / press) | `focusLost` 付与 (shared helper 化) | 小 |

**追加スコープ (user 承認で本 PR に統合)**:
- ⑤ **Force-Focus** (AttachThreadInput opt-in) — `mouse_click` / `keyboard_type` / `keyboard_press` / `terminal_send` に `forceFocus` 追加
- ⑥ **focusLost 横展開** — `keyboard_type` / `keyboard_press` にも focusLost 付与、`terminal_send` は既存 `ForegroundNotTransferred` と併走

---

## ② mouse_click focusLost 検出 (最優先)

### 現象
homing で target window を前面化してもクリック後 ~数百 ms で pinned な Claude CLI が focus を奪取 → 続く keystrokes が CLI に吸われる。今回の迷走の主因。

### 設計
- `withPostState` は共通ラッパのままで拡張しない。**`mouseClickHandler` 内に focus 検出を局所実装**する (scope discipline)
- クリック完了後 `settleMs` 待機 (default `300`ms)、`GetForegroundWindow()` + `getWindowTitleW()` + `getProcessIdentityByPid()` を取得し比較
- 検出条件: **homing が target 窓を前面化した or windowTitle が指定されているのに実 fg が target ではない**
- 成功応答 JSON に追加:
  ```json
  "focusLost": {
    "afterMs": 320,
    "expected": "Google Chrome",
    "stolenBy": "Claude — Claude CLI",
    "stolenByProcessName": "claude.exe"
  }
  ```
- パラメータ `trackFocus: z.boolean().default(true)` を足して opt-out 可能に。`homing=false && windowTitle` 未指定なら noop path (settle も削減)
- target 判定: homing の `applyHoming` が `notes: ["brought \"Xxx\" to front", ...]` を返す既存契約を活用。`brought` で始まる note があれば target 復元が起きた → focus 検証対象。または `windowTitle` の明示がある時も対象

### 実装タッチポイント
- `src/engine/win32.ts`: 既に `GetForegroundWindow`, `getWindowProcessId`, `getProcessIdentityByPid`, `getWindowTitleW`, `enumWindowsInZOrder` は export 済。追加 binding は不要
- `src/tools/mouse.ts`:
  - `mouseClickSchema` に `trackFocus` と `settleMs` (z.coerce.number().int().min(0).max(2000).default(300)) を追加
  - `mouseClickHandler` 末尾 (ok 返却前) に `detectFocusLoss(target, homingNotes, settleMs)` を同期実行して結果を応答 JSON に差し込む
  - `withPostState` 側の `post` はそのまま。`focusLost` は **action result 本体**に入る（post-narration とは層が違う: post は「いまどの窓か」、focusLost は「target から奪われたか」)

### false-positive 対策
- windowTitle も homing target もない (screen-absolute で LLM が決め打ちクリック) → detect しない
- click 自身が新窓を立ち上げたケース: activated → 新しい fg が target "を含む" なら focusLost=false。単純な substring 比較で足りる
- Claude CLI 自身が target (dock_window で 480x360) → stolen=false (target と一致)

---

## ① browser_eval activeTab/readyState 付与

### 現象
タブ切り替えや遷移中に誤タブで eval が走っても応答に識別情報がない → LLM がタブズレに気付けない。

### 設計
- `src/engine/cdp-bridge.ts` に helper 追加:
  ```ts
  export interface TabContext {
    id: string;
    title: string;
    url: string;
    readyState: "loading" | "interactive" | "complete";
  }
  export async function getTabContext(tabId: string | null, port: number): Promise<TabContext>
  ```
  - `resolveTab()` で id 取得 → `evaluateInTab("JSON.stringify([document.title, location.href, document.readyState])", tabId, port)` を 1 回
  - 失敗 (evaluate exception / ws 切断) は throw せず `{id, title:"", url:"", readyState:"loading"}` を返す best-effort (context 付与で本体失敗させない)
- 対象 handler (**成功時のみ付与**、失敗は pristine):
  - `browserEvalHandler`
  - `browserClickElementHandler`
  - `browserFindElementHandler`
  - `browserGetDomHandler`
  - `browserSearchHandler`
  - `browserGetInteractiveHandler`
- `navigate` / `connect` / `launch` / `disconnect` は対象外 (前者 3 は別途 tab 情報を返す、disconnect は context 無意味)
- 付与形: handler 返却 text が JSON でない handler (find_element / click_element 等は text 混合) もあるため、**末尾に JSON 行で追加**するのは ugly。現行の `content[0].text` を壊さずに付与するには:
  - JSON のみ返す handler (eval/search/get_interactive) → 返却オブジェクトに `activeTab`/`readyState` プロパティを追加
  - JSON + 説明文の handler (find/click/navigate) → JSON ブロック内に同 field を追加 or 末尾に `\nactiveTab: { ... }\nreadyState: ...` を append
- **統一方針**: 全 handler の返却を **`{ ok: true, data: ..., activeTab, readyState }` の JSON shape** に揃える (既存 text ラベルは残しつつ JSON 本体を pure JSON 化)。ただしこれは破壊的変更 → **互換維持のため、既存の text を残したまま `activeTab`/`readyState` を別ラインで append** する方針
  ```
  Element found: #submit
  { ... existing JSON ... }
  
  activeTab: { "id": "FB10...", "title": "IAM", "url": "https://..." }
  readyState: "complete"
  ```
- `withPostState` でラップされる handler (click_element / navigate / eval) の `post` と並列で問題なし

### コスト
- Runtime.evaluate × 1 ≈ 10-30 ms/call
- 6 handler × 呼び出し頻度に比例。LLM の迷走コスト (screenshot 追加撮影 etc) より桁違いに小さい

---

## ③ browser_navigate — waitForLoad + 完了詳細

### 現象
`browser_navigate` は `Page.navigate` を投げたら即終了。LLM が毎回 `browser_eval("document.readyState")` で完了確認 → round-trip が無駄。

### 設計
- `browserNavigateSchema` に追加:
  - `waitForLoad: z.boolean().default(true)` — false で現行互換
  - `loadTimeoutMs: z.coerce.number().int().min(500).max(30000).default(15000)`
- handler 拡張:
  1. `navigateTo(url, tabId, port)` を従来通り発行
  2. `waitForLoad=true` なら **200ms 初期遅延** 後 `pollUntil` で `document.readyState === "complete"` を待つ (intervalMs=150, timeoutMs=loadTimeoutMs)
  3. ready または timeout 後、`getTabContext()` を呼び title/url/readyState を取得
  4. 応答 JSON:
     ```json
     {
       "ok": true,
       "url": "https://...",
       "title": "IAM",
       "readyState": "complete",
       "elapsedMs": 1230,
       "waited": true
     }
     ```
  5. timeout 時: `ok: true, readyState: "loading" | "interactive", "hints": { "warnings": ["NavigateTimeout"] }` (失敗ではない、LLM は続行可能)
- **`waitForLoad=false`** の時は即応答、`readyState` フィールドは省略 (現行互換)
- `Page.navigate` response に `errorText` が含まれる場合 (DNS 失敗 etc) → `fail("browser_navigate", code:"NavigateFailed", message:errorText)` で pristine エラー

### 実装タッチポイント
- `cdp-bridge.ts::navigateTo` は現在 `void` を返す → `Promise<{ frameId?: string; errorText?: string }>` に変更して handler 側でエラー判定。**破壊的変更ではない** (現 caller は戻り値未使用)
- handler は既存 `pollUntil` ヘルパーを活用

---

## ④ browser_connect — active タブ明示

### 現象
tabs[] は返るが LLM がどの tab が active かわからず推測で id 選択しがち。

### 設計
- `browserConnectHandler` で listTabs 後、各 page tab で `document.hasFocus()` を並列 evaluate
- 失敗 (attach 不可 / eval timeout) は `active: false` 扱い
- 応答:
  ```json
  {
    "port": 9222,
    "active": "FB10B83...",  // null if none
    "tabs": [
      { "id": "FB10B83...", "title": "...", "url": "...", "active": true },
      { "id": "...",        "title": "...", "url": "...", "active": false }
    ]
  }
  ```
- 既存の text format は維持し、`summary` 配列に `active` を追加するだけ

### 実装
- `Promise.allSettled(pageTabs.map(t => evaluateInTab("document.hasFocus()", t.id, port)))`
- 並列コスト: tab 数分の evaluate。page tab は通常 5-20 個程度。各 <50ms → 並列合計 <200ms

### 代替案と却下理由
- CDP `Target.getTargets()` の `attached` — attached は DevTools 接続有無であり visual focus とは別物
- `Page.bringToFront` は副作用あり (フォーカス変化) → 却下
- **採用**: `document.hasFocus()` eval — 副作用なし、実体と一致

---

---

## ⑤ Force-Focus — AttachThreadInput opt-in

### 現象・要求
Windows の foreground-stealing protection で `SetForegroundWindow` が refuse されると、後続の keystrokes / clicks が別窓 (pinned CLI 等) に吸収される silent failure が頻発。user 明示要望 (2026-04-13 メモ): 「ターゲットアプリのフォーカスを強制的に ON に出来ると良い」。

### 採用アプローチ: AttachThreadInput
メモ `project_force_focus_proposal.md` の比較通り ALT pre-press / SPI_SETFOREGROUNDLOCKTIMEOUT より副作用が局所化されているため採用。

```c
DWORD fgThread = GetWindowThreadProcessId(GetForegroundWindow(), NULL);
DWORD myThread = GetCurrentThreadId();
BOOL attached  = AttachThreadInput(myThread, fgThread, TRUE);
if (attached) {
  SetForegroundWindow(hwnd);
  BringWindowToTop(hwnd);   // secondary hint
  AttachThreadInput(myThread, fgThread, FALSE);
}
```

### 実装タッチポイント

**`src/engine/win32.ts`**:
- 新 koffi binding:
  - `AttachThreadInput(idAttach: DWORD, idAttachTo: DWORD, fAttach: BOOL) -> BOOL` from `user32.dll`
  - `GetCurrentThreadId() -> DWORD` from `kernel32.dll`
  - `GetWindowThreadProcessId(hwnd, lpdwProcessId: LPDWORD) -> DWORD` (既存の `getWindowProcessId` は PID のみ取得なので、thread id を返す低レベル版が必要 — 既存 binding を見直し or 追加 helper)
- 新 helper: `forceSetForegroundWindow(hwnd: unknown): { ok: boolean; attached: boolean; fg_before: bigint; fg_after: bigint }`
  - 同一スレッドなら attach 不要 → attach=false でそのまま SetForegroundWindow
  - attach 後は finally で必ず detach (`try/finally`)
  - `GetForegroundWindow` を post に呼び、target と一致しなければ `ok:false` 返す
- 既存 `restoreAndFocusWindow(hwnd)` を `restoreAndFocusWindow(hwnd, opts?: { force?: boolean })` に拡張 (opts 省略で現行互換)

**action tool schemas**:
- `mouse_click` / `keyboard_type` / `keyboard_press` / `terminal_send` に追加:
  ```ts
  forceFocus: z.boolean().optional().describe(
    "When true, bypass Windows foreground-stealing protection via AttachThreadInput " +
    "before focusing the target window. Required when a pinned window (e.g. Claude CLI) " +
    "keeps stealing focus. Default: follows env DESKTOP_TOUCH_FORCE_FOCUS (default false). " +
    "Set DESKTOP_TOUCH_FORCE_FOCUS=1 to make true the global default."
  )
  ```
- default 解決: `forceFocus ?? (process.env.DESKTOP_TOUCH_FORCE_FOCUS === '1')` を ツール handler 冒頭で計算
- `applyHoming` と `ensureBrowserFocused` / `ensureWindowFocused` に force flag を伝播 → restoreAndFocusWindow の force を切り替え

**contract**:
- force=true で attach しても foreground が取れなかった → 応答 `hints.warnings: ["ForceFocusRefused"]` (action は実行、結果に警告)
- force=true の時は後段 `focusLost` 検出の閾値を下げても良い（attach 失敗 + focusLost 両方見えれば原因が明確）
- terminal_send の既存 `ForegroundNotTransferred` warning は **force=true の時のみ** `ForceFocusRefused` に置き換える（force=false なら従来通り）

**README 追記** (`README.md` + `README.ja.md`):
- 新セクション「Force-Focus (AttachThreadInput)」
- 文面: 「本機能は OS の foreground protection を意図的に迂回する。ユーザが他アプリを手動操作中は false に戻すこと」+ env 有効化手順
- 「Known tradeoffs」: attach 中の ~10ms で 2 スレッド間の key state / mouse capture が共有される。マクロ連打時にレース可能性あり (稀)

### false-positive / 副作用

- **自プロセスへの attach**: 同一スレッドならスキップ (上記)
- **target が既に fg**: `GetForegroundWindow() == hwnd` なら何もしない (現行通り)
- **attach 失敗**: attach が false を返せば legacy path (SetForegroundWindow のみ) にフォールバック

### テスト

- 新 e2e: `tests/e2e/force-focus.test.ts` — dock_window で CLI を pin → `mouse_click(..., forceFocus:true)` でターゲット窓クリック → 応答に `ForceFocusRefused` が出ないことを確認、さらに後続 `keyboard_press` がターゲットに届くことを `wait_until(focus_changes)` で検証。Windows foreground-stealing の再現が不安定な環境では **conditional skip** を許容 (feedback_e2e_patterns.md の foreground-stealing 項参照)
- unit: `forceSetForegroundWindow` の attach / detach が finally で必ず走ること (mock 化)

---

## ⑥ focusLost 横展開 — keyboard_type / keyboard_press

### 設計
- `mouseClickHandler` 内に実装する `detectFocusLoss(target, settleMs)` を **`src/tools/_focus.ts` (新規)** に shared util として切り出し
- `keyboardTypeHandler` / `keyboardPressHandler` にも `trackFocus`/`settleMs` param と応答 `focusLost` を追加
- target 推定: keyboard 系は `windowTitle` 的 hint が現状ない → 新 param `windowTitle?: string` を optional で追加し、指定時のみ focusLost 検出。指定なしなら呼び出し時 fg を target として扱う (current fg から別窓に奪われたら focusLost)
- **terminal_send**: 既存 `ForegroundNotTransferred` warning は維持しつつ、追加で `focusLost` を出す
  - `ForegroundNotTransferred`: pre-send の SetForegroundWindow が即 refuse された (既存)
  - `focusLost`: send 完了後 settleMs 後に fg が変わっていた (新規)
  - 両者は意味が違うので共存可、対応も別
- shared util は mouse_click の detectFocusLoss と 100% 同一ロジックにする (DRY)

### out-of-scope within ⑥
- `mouse_drag` / `scroll` への focusLost — drag/scroll は「窓を移動」操作とも解釈され、focus 変化が正当な side effect になり得る → 本 iteration では触らない

---

## LLM instruction (`src/index.ts`) 更新

以下を既存 browser セクションに追記:

```
browser_connect → tabs[].active / top-level "active": どれが focused tab か即分かる
browser_eval, browser_find/click_element, browser_get_dom, browser_search, browser_get_interactive
  → 応答末尾に activeTab: {id,title,url} + readyState: "complete" を付与 (タブズレ検出用)
browser_navigate(url, waitForLoad=true, loadTimeoutMs=15000)
  → default で document.readyState=="complete" まで待って title/url/readyState を返す
mouse_click / keyboard_type / keyboard_press / terminal_send
  → 成功応答に focusLost:{afterMs,expected,stolenBy,stolenByProcessName} を付与
  (target から焦点が奪われた時のみ)。trackFocus=false で opt-out
mouse_click / keyboard_type / keyboard_press / terminal_send
  → forceFocus:true で Windows foreground-stealing protection を AttachThreadInput で迂回
  env DESKTOP_TOUCH_FORCE_FOCUS=1 で global default を true に
  force が refuse された場合 hints.warnings:["ForceFocusRefused"]
```

---

## テスト計画

### 既存テストへの影響確認
- `tests/e2e/browser-cdp.test.ts` — activeTab/readyState 付与で壊れないか (pure JSON 判定箇所は少ないはず、text substring assert が中心)
- `tests/e2e/browser-search.test.ts` — 同上
- `tests/e2e/wait-until.test.ts` — 影響なし

### 新規 suite
- `tests/e2e/mouse-focus-lost.test.ts`: dock_window で CLI を pin → mouse_click で別窓クリック → `focusLost.stolenBy` に CLI 情報が載ることを検証。Windows foreground-stealing protection で必ず再現できない場合は `wait_until(focus_changes)` hook で代用、**skip with reason も許容**
- `tests/e2e/browser-tab-context.test.ts`: headless Chrome で `browser_eval("1+1")` → 応答パース、`activeTab`/`readyState` 検証
- `tests/e2e/browser-navigate-wait.test.ts`: `browser_navigate(url)` → `readyState: "complete"` + title 検証、`waitForLoad: false` でも動くか、`loadTimeoutMs: 500` で never-loads URL への timeout hints 検証
- `tests/e2e/browser-connect-active.test.ts`: 2 タブ開く → `active` が最後にフォーカスした tab の id と一致、`tabs[].active` flag も整合
- `tests/e2e/force-focus.test.ts`: pinned CLI 環境で `forceFocus:true` を指定した keyboard_press がターゲット窓に届くことを確認。env `DESKTOP_TOUCH_FORCE_FOCUS=1` 経路も併せて検証。foreground-stealing の再現不安定時は skip with reason
- `tests/e2e/keyboard-focus-lost.test.ts`: keyboard_type / keyboard_press に `focusLost` が付与されること、`windowTitle` 指定時と未指定時の挙動差を検証

### 単体ロジック (vitest)
- `src/tools/_focus.ts::detectFocusLoss` を export → table-driven test (target="A" / actual fg="A/B/null" / homing notes 有無)
- `src/engine/win32.ts::forceSetForegroundWindow` — attach/detach が finally で必ず走ること (AttachThreadInput を mock 化)

---

## How to Proceed

1. **[現在] Opus で本計画を作成 → チャット表示 → ExitPlanMode で user 承認**
2. Sonnet サブエージェントに実装委譲 (`Agent(subagent_type=general-purpose, model=sonnet, ...)` で `docs/browser-mouse-ux-plan.md` を参照しつつ実装)
3. Sonnet が lint + typecheck + test を通して完了報告
4. Opus 再レビューエージェントを起動 (`Agent(subagent_type=general-purpose, model=opus, ...)`) → findings を列挙
5. Sonnet で修正 → Opus 再レビュー を指摘ゼロまで反復
6. 最終 commit → PR #7 更新 (Ready for review 昇格は user 判断)

## 期待効果

- **②**: 迷走の主因だった silent focus 奪取を LLM が即認識 → retry or force-focus 判断に直結
- **①**: タブ間違い eval の silent failure を排除。どのタブの何の readyState かが常時可視
- **③**: 平均 1-2 往復削減 (navigate → readyState check パターンが消える)
- **④**: tab id 推測の迷いが消える、tabs[] を LLM が即 sort できる
