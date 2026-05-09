# Dogfood Scenarios — launcher / macro / notification (Tier 2)

- Status: **manual / dogfood scenarios for Phase 3b execution audit**
- Date: 2026-05-09
- Origin: `docs/llm-audit/phase3b-execution-audit.md` §3.2 carry-over (Plan §6 acceptance 2 経路目)
- Scope: workspace_launch / run_macro / notification_show の error path 実機 GUI / OS 依存シナリオ
- Parent audit section: 本 doc §1-§3 は `phase3b-execution-audit.md` §3.2 (cell 20-22) の carry-over scenario。各シナリオは parent table の cell 内 `dogfood-scenarios/launcher-macro.md §X.Y` 参照と相互リンク

---

## 1. workspace_launch (cell 20 error path SoT)

### 1.1 workspace_launch — single-instance app reuses existing window (HWND 不変)

**目的**: matrix §3.1 line 156 の "single-instance apps that reuse an existing window will not register as a new HWND" が実機で完全に再現されることを確認。description caveats に既に明示されているが、LLM が回避手順 (`desktop_discover` で既存検出) を実行する flow を end-to-end 観測。

**対象 app の選定**:
- **truly single-instance**: `chrome.exe` / `outlook.exe` / `vscode.exe` (line 136 共通 note 参照)。本 scenario は chrome.exe を例に記述。
- **multi-instance (本 scenario 対象外)**: Win11 New Notepad は毎起動で新 HWND 採番、本 scenario の reuse 期待を満たさない (production は新 HWND を正しく検出、silent ok:true regression なし — Phase 6 dogfood F5 検証で確認済)。`notepad.exe` を本シナリオの対象に使うと multi-instance 採番で「reuse 失敗 → 新 HWND 検出成功」の正常 path に流れ、reuse 観測ができない。

**手順**:
1. 既に Chrome (or vscode / outlook) が開いている状態で `workspace_launch({command: 'chrome.exe', windowTitle: 'Chrome'})` 呼出
2. response 観測: 内部 enum スナップショット で既存 Chrome HWND が前から存在 → 新 HWND 検出されず → `code:'WaitTimeout'` (wait_until 経由) または empty foundWindow
3. **回避**: `desktop_discover` で既存 Chrome を先に発見 → 既存 HWND を target にして次 tool

**期待**: timeout/error path で actionable suggest (例: "Call desktop_discover first to check if the window is already open")。
**Anti-pattern**: silent ok:true で foundWindow に古い HWND を返す → caller が新規プロセスと誤認 → focus / state stale。

### 1.2 workspace_launch — WaitTimeout (起動失敗) error path

**目的**: cell 20 error column の dogfood SoT。production-handler error path が `wait_until` 委譲のため direct automated pin がなく、real launch failure の typed code shape を実機確認。

**手順**:
1. 不在の exe で `workspace_launch({command: '__nonexistent_app.exe__', timeoutMs: 3000})` 呼出
2. response 観測: `ok:false`、`code:'WaitTimeout'` (wait_until 委譲経由)、suggest に `desktop_discover` 推奨
3. ShellExecute 自体は OS で executable not found error を投げる場合 → 別 typed code (`SpawnFailed` 等) emit

**期待**: 起動失敗が actionable typed code + suggest、partial result なし。
**Anti-pattern**: silent ok:true で空 foundWindow + windowTitle 不在 → caller が新規 process 起動成功と誤認。

### 1.3 workspace_launch → focus_window chain (Tier 2 inter-tool)

**目的**: matrix §3.1 line 156 の prefer pattern "Follow with focus_window(windowTitle) to interact with the launched app" を実機 chain で確認。

**手順**:
1. `workspace_launch({command: 'notepad.exe', windowTitle: 'Notepad'})` で新規 Notepad 起動
2. response の `foundWindow.windowTitle` を次 tool に feed
3. `focus_window({windowTitle: <step2 windowTitle>})` で foreground 化
4. `keyboard:type({windowTitle: <same>, text: 'Hello after launch'})` で文字入力

**期待**: chain で focus 維持 + landing 完了。
**Anti-pattern**: launch ok だが focus 取れず → keyboard:type が `ForegroundRestricted` → manual focus_window 必要。

---

## 2. run_macro (cell 21 error path SoT)

### 2.1 run_macro — stop_on_error 挙動 (前 step 失敗で halt)

**目的**: matrix §3.1 line 157 の "stop_on_error=true (default) halts on first failure" を実機確認。

**手順**:
1. `run_macro({steps: [{tool: 'focus_window', params: {windowTitle: '__nonexistent__'}}, {tool: 'keyboard', params: {action: 'type', text: 'should not run'}}], stop_on_error: true})` 呼出
2. response 観測: step 1 で `WindowNotFound` ok:false → step 2 skip、warnings 配列に step 1 nested code

**期待**: halt on first error、step 2 not executed。
**Anti-pattern**: step 1 fail で step 2 が strange state で動作 → silent state corruption。

### 2.2 run_macro — TOOL_REGISTRY recursion prevention (cell 21 error column SoT)

**目的**: cell 21 error column の dogfood SoT。matrix §3.1 line 157 の per-step verification 委譲 design constraint に従い、macro 内 macro が invocable 状態でないことを実機確認。

**手順**:
1. `run_macro({steps: [{tool: 'run_macro', params: {steps: [...]}}]})` 呼出
2. response 観測: `ok:false`、step 1 dispatch 段で `code:'InvalidArgs'` (run_macro が TOOL_REGISTRY excluded) + suggest "run_macro nesting is not supported by design"

**期待**: recursion 設計上禁止 が typed code で明示。
**Anti-pattern**: silent ok:true で nested execution が正常終了 → recursive depth で stack overflow / state corruption。

### 2.3 run_macro — partial result chain on mid-step failure (stop_on_error: false)

**目的**: per-step verification 継承で warnings 配列に nested code が surface する shape を実機確認。

**手順**:
1. `run_macro({steps: [{tool: 'screenshot'}, {tool: 'click_element', params: {name: '__nonexistent__'}}, {tool: 'screenshot'}], stop_on_error: false})` 呼出
2. response 観測: step 1 ok、step 2 ok:false (`ElementNotFound`)、step 3 ok、warnings 配列に step 2 nested code

**期待**: stop_on_error: false で全 step 実行、各 step result + warnings nested。
**Anti-pattern**: step 2 fail で step 3 skip → stop_on_error: true 偽装。

---

## 3. notification_show (cell 22 error path SoT)

### 3.1 notification_show — Focus Assist active (silent ok:true 現状動作)

**目的**: matrix §3.1 line 158 規範の現状未実装 (G1 contract drift) と description が反映する production fact を実機確認。**Phase 3a J1 fix が land すれば本 scenario の expected が変わる** (現状 ok:true → fix 後 hint 'unverifiable')。

**手順**:
1. Windows 設定 → Focus Assist → "Alarms only" mode 有効化
2. `notification_show({title: 'test', body: 'visibility test'})` 呼出
3. response 観測: 現状は `ok:true` のみ (matrix 規範違反)、Win11 system tray にも balloon 表示なし
4. **Phase 3a J1 fix 後** (production code 改修済): `ok:true` + `hints.verifyDelivery: {status: 'unverifiable', reason: 'user_visible_side_effect_uninspectable', channel: 'win32_balloon_tip'}`

**期待 (J1 fix 後)**: degradation hint で Focus Assist suppression を表現。
**Anti-pattern (現状)**: silent ok:true で user に届かない → silent-success regression (#173 同型)。

### 3.2 notification_show — PowerShell spawn failure (cell 22 error column SoT)

**目的**: cell 22 error column の dogfood SoT。production handler は `execFile('powershell.exe', ...)` で 15s timeout で fail-and-forget pattern、direct error path test 困難。real PowerShell 不在 / kill 経由で error path を実機確認。

**手順**:
1. PATH から PowerShell を一時的に外す (or rename) — risky な操作のため不要なら skip
2. `notification_show({title: 'test', body: 'fail test'})` 呼出
3. response 観測: `ok:false`、`code:'ToolError'` (generic failWith)、context.error に `spawn powershell.exe ENOENT` 等の system error
4. balloon は表示されず、user 観測経路なし

**期待**: spawn fail で actionable error + suggest "ensure powershell.exe is in PATH"。
**Anti-pattern**: silent ok:true で PowerShell 起動成功と誤認 → balloon 表示なしを user が気付かない。

### 3.3 notification_show → user attention chain (manual observation)

**目的**: notification の "user に reach した" 確認は原理的に観測不能 (matrix line 158 北極星) だが、agent flow 設計で post-notification の user response を `wait_until(focus_changes)` 等で間接観測する pattern を実機確認。

**手順**:
1. `notification_show({title: 'Confirm', body: 'Click Yes to continue'})` 呼出
2. response の `verifyDelivery: 'unverifiable'` (J1 fix 後) を読んで user attention 不確定と判定
3. `wait_until({criteria: 'focus_changes', timeoutMs: 30000})` で user が別 window を focus した event を観測
4. timeout なら user 不在 / Focus Assist 抑制と推定

**期待**: notification の delivery を直接観測せず、後続 user behavior で間接判定。
**Anti-pattern**: notification 後に即 keyboard:type で user 入力期待 → user reach 未確認で input 重複 / lost。

---

## 共通操作上の note

- **Focus Assist (Do Not Disturb) 影響**: notification_show は silent suppress、agent flow で user prompt を必要とする場合は事前確認 / ChatGPT 経由 etc 代替経路推奨。
- **TOOL_REGISTRY exclusion**: run_macro / desktop_discover / desktop_act 等 v2 dynamic tool は recursion prevention + state lifecycle で macro 内呼出不可、design constraint。
- **single-instance app pattern**: chrome.exe / outlook.exe / vscode.exe 等は HWND 再利用で `workspace_launch` が新 HWND 検出失敗、必ず `desktop_discover` 先行。
- **PowerShell spawn dependency**: notification_show / clipboard:write は PowerShell 起動依存、PATH / 起動失敗で direct error path、E2E 確認時に PATH 設定要注意。
