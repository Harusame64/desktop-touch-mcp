# Phase 6 Dogfood Findings (post-Phase-6 closure manual real-world testing)

- Status: **Active** (起票 2026-05-09、Phase 6 PR-A #227 + PR-B #228 merged 後の dogfood scenario 実機実行で発見)
- Origin: `docs/llm-audit/dogfood-scenarios/*.md` の手順を Step 1+2 で順次実機実行 (clipboard / keyboard / mouse / scroll / launcher-macro / browser-tier2 / notification)
- Scope: production code 改修 dogfood で初めて catch された **silent-success / contract drift** + scenario doc の outdated 表記

## Why this doc

Phase 5 closure では北極星「silent-success / contract drift = 0」を **automated audit + production fix で達成済**と評価したが、Phase 6 dogfood (real-world manual testing) で **automated test では cover 不能な run_macro メタレベル contract drift** が 1 件 + 軽微な finding 4 件発見。memory に書くと揮発する (強制命令 9) ため本 docs に永続化、別 PR で fix。

---

## F1 (P1, 北極星違反): run_macro stop_on_error が tool inner ok:false envelope で halt しない

**Location**: `src/tools/macro.ts:447-466` (`runMacroHandler` の try/catch block)

**事実**:
- matrix §3.1 line 157 規範: "stop_on_error=true (default) halts on first failure"
- Scenario `launcher-macro.md` §2.1 explicit expectation: step 0 が `ok:false (WindowNotFound)` を返した場合、step 1 は skip
- 実機:
  ```
  run_macro({steps:[
    {tool:"focus_window", params:{title:"__nonexistent__"}},
    {tool:"keyboard", params:{action:"type", text:"should not run"}}
  ], stop_on_error:true})
  ```
  - step 0 inner content: `{"ok":false, "code":"WindowNotFound"}`
  - step 0 outer wrapper: `"ok": true` (handler が exception を投げなかったため)
  - step 1 EXECUTED → "should not run" が Notepad に landing (silent state corruption)

**Root cause**: `runMacroHandler` の try block (line 447-462) は `entry.handler(validated)` が exception を投げない限り `results.push({step, tool, ok: true, text})` で wrapper-level success 扱い。`text[0]` 内の `ok:false` envelope を parse する path がない。`if (stop_on_error) break;` は catch block 内のみで発火。

**Severity**: **P1 北極星違反 (silent-success contract drift)**。
- agent flow が `stop_on_error: true` に依存して destructive sequence を中断する設計の場合、prereq 失敗でも全 step run → silent state corruption / 誤入力が wrong app に landing
- Phase 5 closure 北極星 (silent-success / contract drift = 0) が **dogfood scope では未達成**

**修正方針** (実装反映済 PR #229):
1. `entry.handler(validated)` 後、`textLines[0]` を `JSON.parse` で safely parse (`try/catch` で non-JSON 吸収、`parsed && typeof parsed === "object"` で primitive guard、`parsed.ok === false` strict equality)
2. parse 成功 + `parsed.ok === false` の場合: step-level に `ok:false` + `error: parsed.error ?? parsed.code ?? "inner ok:false (no error/code fields, see step.text[0])"` + (`parsed.code` が string なら別 field `code: parsed.code` も保持) を push
3. step-level `ok:false` の場合 `stop_on_error: true` で `break`
4. Unit test `tests/unit/run-macro-stop-on-error-inner-envelope.test.ts` 新規追加で contract pin (halt + surface + no-failure + throw + non-JSON safe + warnings shape + partial-success summary 7 case)

**北極星整合**: 修正後、`stop_on_error: true` が「tool throw」「tool inner ok:false」両方で halt → silent-success 経路解消。

---

## F2 (P2): run_macro stop_on_error:false で nested step ok:false が `warnings[]` に surface しない

**Location**: `src/tools/macro.ts:496-505` (final summary build block)

**事実**:
- Scenario `launcher-macro.md` §2.3 expectation: "stop_on_error: false で全 step 実行、各 step result + warnings nested"
- 実機: top-level summary `{steps_total, steps_completed, results: [...]}` のみ、`warnings[]` array 不在
- LLM が nested step 失敗を catch するには `results[i].text[0]` を JSON parse して `ok:false` を判定必須

**Severity**: P2 — `stop_on_error:false` で意図的に partial result を許容する flow で nested code が surface しないと、LLM が成功/失敗の混在を判断するために text block を parse する必要があり、context window と processing cost が増える。

**修正方針**:
- F1 fix と同 commit で `summary.warnings[]` を追加: nested step ok:false の `{step, tool, code, error}` を集約
- `results[]` array は raw text 維持 (backward compat)
- Top-level に `warnings[]` を追加するのみで non-breaking

---

## F3 (P2): workspace_launch "command not found" が typed code 不在

**Location**: `src/tools/workspace.ts` (workspaceLaunchHandler、ShellExecute 経由 PATH 探索 pre-validation)

**事実**:
- Scenario `launcher-macro.md` §1.2 expectation: 起動失敗で `code:'WaitTimeout'` (wait_until 委譲経由) または別 typed code (`SpawnFailed` 等)
- 実機 (`workspace_launch({command:"__nonexistent_app__.exe", waitMs:3000})`):
  - `ok:false`
  - `code:"ToolError"` (generic fallback)
  - `error:"Command \"__nonexistent_app__.exe\" not found. Provide the full path (e.g. \"C:\\Program Files\\..\\app.exe\")."`
  - `suggest[]` 不在
- 起動失敗が actionable error message に full path 提示あり (silent ok:true 回避は OK)、ただし typed code + SUGGESTS なし

**Severity**: P2 — error message は actionable だが LLM-perspective recovery (typed code → SUGGESTS array) が不在、generic ToolError fall-through で agent が typed code 経由 retry pattern を組めない。

**修正方針** (Phase 7 candidate):
- `_errors.ts` に `SpawnFailed` typed code + SUGGESTS 追加 (PATH 確認 / full path 提示 / executable 存在確認 等)
- `workspace.ts` の "Command ... not found" path で `failWith(new Error("SpawnFailed: ..."))` emit
- classify branch substring `"command "` + `"not found"` で `SpawnFailed` resolve

---

## F4 (P3, **RE-OPENED 2026-05-10 dogfood**): keyboard:type BG on Notepad が `verifyDelivery: 'unverifiable'` 返却

**Status**: **Re-opened by PR #234 → Resolved by PR #235** (PR #233 ValuePattern fallback gate に regression、2026-05-10 v1.4.1 dogfood Step 1 で再現 — 詳細は §F4-bis)。元 Phase 7 patch (`getTextViaValuePattern` helper 新設 + keyboard.ts BG type path で TextPattern 失敗時 ValuePattern delta 比較 fallback 追加) は **gate 条件不足** で Win11 New Notepad の実機 path に到達しなかったが、PR #235 Hybrid (b)+(c)-light で gate 補強済 (v1.4.2 release で Closed 昇格予定、実機 dogfood Step 1 で `delivered` 確認後)。

**Location**: `src/tools/keyboard.ts` BG path 内 verifyDelivery hint 構築

**事実**:
- Scenario `keyboard.md` §2.1 expectation: BG path で `hints.verifyDelivery.status === 'delivered'` (matrix §3.1 line 140 規範: pre/post UIA TextPattern read-back 一致)
- 実機 (`keyboard({action:"type", method:"background", windowTitle:"メモ帳", text:"hello world"})`):
  - `ok:true, typed:11, method:"background", channel:"wm_char"` ✓
  - 実 delivery 成功: `post.focusedElement.value: "hello world"` ✓
  - **`hints.verifyDelivery: {status:"unverifiable", reason:"read_back_unsupported", channel:"wm_char", fallback:"method:'foreground'"}`** (期待 `delivered` ではない)

**Hypothesis**: Notepad edit control が UIA TextPattern 非対応 (Win11 New Notepad は Edit ValuePattern のみ実装の可能性)、verifyDelivery が TextPattern read-back を試行 → 失敗 → ValuePattern fallback 不在で `unverifiable` 返却。

**Severity**: P3 — matrix §1.3 規範では `unverifiable` も hint 許容範囲内 (北極星違反ではない)、`post.focusedElement.value` で実 delivery は確認可能。ただし LLM が `unverifiable` を見て retry した場合 "hello worldhello world" 重複 risk → contract 強化余地。

**修正方針** (Phase 7 candidate):
- verifyDelivery 内で TextPattern read-back 失敗時 → ValuePattern read-back を試行 → match なら `delivered` 返却
- ValuePattern も読めない場合のみ `unverifiable + read_back_unsupported` 返却

**修正反映** (Phase 7 patch、本 PR):
- `src/engine/uia-bridge.ts` に `getTextViaValuePattern(windowTitle)` helper 新設。focused element の ValuePattern.Value を返す PowerShell-backed 関数、TreeWalker で focused 要素が target window の toplevel HWND 内に居ることを scoping (focus が外部に逃げた場合は null で無視)。
- `src/tools/keyboard.ts` BG type path で TextPattern baseline / post-read が両方 null の case に ValuePattern delta 比較 fallback 追加。`postValue.includes(checkText)` AND (`delta > 0` OR `!baseline.includes(checkText)`) で delivered 判定、両者一致で length 不変は `unverifiable` 維持 (false-positive 防止)。
- 10 unit case (`tests/unit/phase7-f4-value-pattern-fallback.test.ts`) で classify decision logic を pin: empty baseline / non-empty baseline / replaceAll / partial / 不変 / 重複 baseline + 拡大 / multi-line などの shape を網羅。
- contract 強化により Win11 New Notepad / RichEdit / TextBox / Edit など ValuePattern-only な control での北極星整合 hint surface が向上 (旧: unverifiable → 新: delivered when ValuePattern fallback succeeds)。**ただし §F4-bis で gate 不足が露呈、Win11 New Notepad では実発火せず、F4 は v1.4.1 dogfood Step 1 で re-opened (本 §F4-bis 参照)。→ PR #235 で Hybrid (b)+(c)-light land、v1.4.2 release で Closed 昇格予定。**

---

## F4-bis (P3, **Resolved by PR #235**, pending v1.4.2 release closeout): PR #233 ValuePattern fallback gate が Win11 New Notepad で発火しない

**Status**: **Resolved** (PR #235 で Hybrid (b)+(c)-light land、起票 2026-05-10 → land 2026-05-10、v1.4.1 dogfood gate Step 1 = `keyboard:type method:'background'` Win11 Notepad で再現していた gate dead path を解消)。本 §F4-bis は permanent record として保持、Status を v1.4.2 release 時に **Closed** へ昇格予定 (実機 dogfood Step 1 で `delivered` 確認後)。

**Location** (source TS、`main` `d979579` 時点): `src/tools/keyboard.ts:728-856` (BG type baseline 判定 + ValuePattern fallback 分岐) ↔ `src/engine/uia-bridge.ts:1116-1215` (`getTextViaTextPattern` PowerShell descendant 走査) ↔ `src/engine/uia-bridge.ts:1247-1317` (`getTextViaValuePattern` focused element scoping)

### 実機証拠 (2026-05-10、v1.4.1 cache + dev local dist `D:/git/desktop-touch-mcp/dist/index.js` PID 15960、両 path で同事象)

呼出:
```
keyboard({action:"type", method:"background", windowTitle:"無題 - メモ帳", text:"hello world"})
```
返却:
```jsonc
{
  "ok": true, "typed": 11, "method": "background", "channel": "wm_char",
  "hints": {
    "verifyDelivery": {
      "status": "unverifiable",       // ❌ 期待 "delivered"
      "reason": "read_back_unsupported",
      "channel": "wm_char",
      "fallback": "method:'foreground'"
    }
  },
  "post": {
    "focusedElement": {
      "name": "テキスト エディター",
      "type": "Edit",
      "automationId": "15",
      "value": "hello world"           // ← ValuePattern.Value 経路は読めている
    }
  }
}
```

直後の `desktop_state` でも `focusedElement.value: "hello world"` (`hints.focusedElementSource: "uia"`)、ValuePattern 自体は対象 control で正常稼働。

### Root cause hypothesis

`getTextViaTextPattern` の PowerShell 実装 (`uia-bridge.ts:1148-1166`) は target window 配下の **全 descendant** を `TreeScope::Descendants` で走査し、TextPattern を実装した descendant が 1 つでも見つかれば候補に追加して `bestText` を返す:

```powershell
$all = $target.FindAll($desc, $trueC)
foreach ($el in $all) {
    try {
        $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        if ($null -ne $tp) {
            $candidates.Add(@{ tp=$tp; controlType=... })
        }
    } catch {}
}
```

Win11 New Notepad の RichEditD2DPT 自体は TextPattern 非対応でも、補助 descendant (menu / pane / title bar 等) のいずれかが TextPattern を露出していれば `$candidates.Count > 0` になり non-null text が返る。結果:

1. `keyboard.ts:728-735` で `[baselineRaw, valueBaselineRaw]` 並列取得 → `baselineRaw !== null` (descendant 由来)
2. `keyboard.ts:736-737` で `baselineMarker = makeKeyboardBaselineMarker(...)` が non-null
3. `keyboard.ts:741` で `valueBaseline = baselineMarker === null ? valueBaselineRaw : null` により ValuePattern baseline が **破棄**
4. `keyboard.ts:781-785` で `verifiable === true` (baselineMarker !== null) 経路に進入 (`if (verifiable)` 786 行)
5. `keyboard.ts:786-803` で post-send `getTextViaTextPattern` も同じ descendant を読むため `applyKeyboardSinceMarker` が match せず `sliced.matched === false`
6. `keyboard.ts:804-806` で `verifiedDelivery === "unverifiable"`、`verifyReason = "read_back_unsupported"` 確定
7. **`keyboard.ts:810-856` の ValuePattern fallback 分岐は `else if (verificationNeeded)` (= `!verifiable`) 配下で、`baselineMarker !== null` の本ケースでは絶対到達しない**

つまり PR #233 の gating 前提「TextPattern null = 非対応 / non-null = 対応 → null の時のみ ValuePattern にフォールバック」は **focused element ではなく target window 配下の任意 descendant を見ている** ため成立せず、descendant 偶発 hit で fallback path が dead path 化している。

### Severity

P3 維持 (matrix §1.3 規範では `unverifiable` も hint 許容範囲、北極星違反ではない)。ただし PR #233 で謳った「Win11 New Notepad で `delivered` 返却」契約 = **未達成**、本来の F4 修正意図が production に反映されていない silent contract drift。LLM が `unverifiable` を見て retry した場合の "hello worldhello world" 重複 risk も解消できていない。

### 修正方針候補 (design space)

(a) **focused-element-bound TextPattern 判定**: `getTextViaTextPattern` を「focused element およびその ancestor chain」に限定スコープ化、descendant 偶発 hit を排除。focused 経路で TextPattern 不在 → null 返却 → 既存 ValuePattern fallback gate (`baselineMarker === null`) が正しく発火。
(b) **ValuePattern 並列 fallback 強制**: gate を変更し `baselineMarker !== null` でも `valueBaseline` を保持、post-send で TextPattern slicing が `unverifiable` だった場合に ValuePattern delta 比較を **第二防衛線**として追加。Phase 7 fallback path をそのまま再利用可能、gate 条件のみ修正。
(c) **descendant 走査の controlType allowlist**: `Document` / `Edit` / `Custom` / `RichEdit` などの input echoable 系のみ候補化、menu / title bar / button label 由来の TextPattern 偶発 hit を排除 (full allowlist 版)。
(d) **TextPattern viability probe**: `getTextViaTextPattern` の戻り値を `getTextViaValuePattern` snapshot と比較し、focused control の reading を含まない場合は TextPattern を unreliable と判定して null fall-through。tree scoping に依存しない content-validity guard として (a)/(c) と直交補完。

trade-off:
- (a) は scope 縮小で正しさは出るが、Windows Terminal / conhost (TextPattern が non-focused pane / document descendant に存在、`uia-bridge.ts:1168-1175` の `Document/Edit=3, Custom=2, Pane/Group=1` score 表は WT/conhost の descendant 構造に合わせた既存設計) で **regression hard 確実**。
- (b) は gate のみ修正で WT/conhost 既存経路を温存できるが、TextPattern 経路が誤った要素を読み続ける fact 自体は残る (隠れた false-negative source、診断 log でしか露見しない)。
- (c) full allowlist は Custom typed terminal pane を破壊する risk、新 control type 追加で都度修正が要る運用負担。**Score-0 (Window/MenuItem/Title/Button 等) の strict drop に縮小した「(c)-light」**は WT/conhost の Custom (score 2) 経路を温存しつつ Notepad menu / title bar 由来の偶発 hit のみ排除、安全な subset。
- (d) は tree scoping 非依存だが TP/VP cross-validation 自体が PS spawn を 2 回必要として hot path overhead。冷 path のみ起動なら現実的。

### Opus 諮問結果 (2026-05-10)

**推奨**: **Hybrid (b) + (c)-light**。

- (a) は **却下**: WT/conhost で TextPattern が focused element ancestor chain に存在しない構造 (`uia-bridge.ts:1168-1175` の score 表が pane/document descendant 前提) のため、ancestor 縛りで `terminal:read` + WT/conhost BG type 両方を silent regression させる。test coverage も実 WT が必要で cheap には pin できない。
- (b) は **gate-only 修正**: `keyboard.ts:741` を `const valueBaseline = valueBaselineRaw;` (常時保持) に変更し、`if (verifiable)` 786 行内で post-send slicing が `unverifiable` 確定後 (`keyboard.ts:804-806`) に **ValuePattern delta 比較を第二防衛線**として追加する。TextPattern path は WT/conhost contract そのまま、ValuePattern は完全な代替ではなく層追加。
- (c)-light は **(b) と補完**: `getTextViaTextPattern` の `ControlTypeScore` (`uia-bridge.ts:1168-1175`) で **score-0 候補を strict drop** (`bestScore === 0` を candidates から除外)。Notepad menu / title-bar / button label 由来の TextPattern 偶発 hit が candidate set に乗らなくなり、本来の `baselineMarker === null` gate が正しく発火 → Phase 7 fallback も従来通り動作。Custom (score 2) は温存で WT/conhost 影響なし。

**False-positive guard 維持**: 現 Phase 7 code `keyboard.ts:835` の `delta > 0 || !valueBaseline.includes(checkText)` ガードはそのまま preserve。再 type with no length growth は `unverifiable` 維持で false-positive `delivered` 返却防止。Password field (ValuePattern.Value 空文字) は `postValue.includes(checkText) === false` 経路で `BackgroundInputNotDelivered` 経由 surface (現 unverifiable よりやや conservative、許容)。

**Hot path 影響**: ValuePattern baseline は既に `Promise.all` 並列取得 (`keyboard.ts:730-735`) のため hot path コスト不変。post-send VP read は **TP slicing unverifiable 時のみ** 起動する条件付き、failure recovery path のみで wall-clock +200-400ms (PS spawn 1 回)。

### Verification gate (修正後 dogfood Step)

1. **Win11 New Notepad** 起動 → `keyboard({action:"type", method:"background", windowTitle:"無題 - メモ帳", text:"hello world"})` → `hints.verifyDelivery.status === "delivered"` (本 §F4-bis 主修正対象、正常 path)
2. **Windows Terminal (PowerShell prompt)** → `keyboard({action:"type", method:"background", windowTitle:"PowerShell", text:"echo dogfood"})` → `delivered` (WT/conhost regression guard、(c)-light で Custom score 2 が温存されることを確認)
3. **conhost (cmd.exe)** → 同上 (TextPattern Custom-typed pane regression guard)
4. **Outlook compose (RichEdit + ValuePattern)** → `delivered` (ValuePattern 並列 fallback 経路の追加対象)
5. **VS Code search box** → `delivered` (RichEdit/Edit ValuePattern coverage)
6. **再 type into Notepad already containing "hello world"** → `unverifiable` (false-positive 防御の意図的 conservative behavior、re-type 重複 risk を caller に surface)
7. **Hidden-input prompt (sudo / git push password / SSH passphrase)** → `BackgroundInputNotDelivered` 経由 fail surface (silent ok:true 回避、既存 issue #183 hidden-input 検出 path との整合確認)
8. **Embedded newline 文字列** (`"line1\nline2"`) → 現 code `keyboard.ts:818` の `hasEmbeddedNewline` guard で fallback 自体が skip され `unverifiable + embedded_newline` 維持 (multi-line 検証は本 hotfix scope 外、carry-over)
9. **Focus race during VP read** → `getTextViaValuePattern` の TreeWalker scoping (`uia-bridge.ts:1278-1287`) で focus が target window 外に移動した場合 null fall-through、`unverifiable + read_back_unsupported` 維持

### Unit test pinning (hotfix PR で追加)

`tests/unit/phase7-f4-value-pattern-fallback.test.ts` に gate 条件側 test を 8 case 追加:

1. **Notepad re-bug**: TP 非null descendant text、slicing match=false → VP delta 成功 → `delivered` (本 §F4-bis 修正の primary pin)
2. **WT regression guard**: TP returns pane buffer、slicing match=true with exact substring → `delivered` (VP not consulted、TextPattern 経路温存確認)
3. **conhost regression guard**: TP returns Custom-typed pane text、slicing tail-N match → `delivered`
4. **Re-type safety**: TP slicing match=false、VP `delta=0` AND `valueBaseline.includes(checkText)` → `unverifiable` (false-positive 防御)
5. **replaceAll path**: TP slicing match=false、VP `delta<0` BUT `!valueBaseline.includes(checkText)` → `delivered`
6. **Password field**: TP slicing match=false、VP returns "" → `BackgroundInputNotDelivered` (silent ok:true 回避)
7. **Focus race**: VP returns null (TreeWalker scoping rejection) → `unverifiable + read_back_unsupported` 維持
8. **Score-0 descendant strip**: `getTextViaTextPattern` 単体 unit (Notepad-like fixture with menu/title TextPattern providers のみ) → `null` 返却 (既存 `baselineMarker === null` 経路が原 design 通り発火)

### Carry-over OQ (本 hotfix 後の follow-up)

- **Native ValuePattern binding**: PS spawn cost on hot path 残存。native `uiaGetTextViaValuePattern` 追加で TP/VP 並列を Rust 経由に。defer to follow-up PR、本 hotfix では cold-path-only invocation で wall-clock impact 抑制。
- **Score-0 strict drop の broad audit**: 万一 `Window`/`MenuItem`/`Title`/`Button` 系で input echo を提供する非標準 control が実在した場合の regression。mitigation = `Custom` (score 2) は温存、strict score-0 のみ drop。問題発生時に再判定。
- **`unverifiable` retry を agent 側で discourage する documentation**: orthogonal 改善、Phase 8 doc candidate (matrix doc / README で「unverifiable は post.focusedElement.value で側面確認、retry すると重複 risk」と明示)。
- **Embedded newline + ValuePattern 経路**: 本 hotfix scope 外、multi-line type の verifyDelivery は別途検討。

---

## F5 (doc only, **FIXED Phase 7**): scenario doc が Win11 Notepad multi-instance を反映していない

**Status**: **Fixed** (Phase 7 patch、対象 app を `chrome.exe` に変更 + Win11 Notepad multi-instance note 追加)

**Location**: `docs/llm-audit/dogfood-scenarios/launcher-macro.md` §1.1

**事実**:
- Scenario §1.1 expectation: "single-instance app reuses existing window (HWND 不変)、新 HWND 検出されず WaitTimeout"
- 実機: Win11 New Notepad は **multi-instance** (新 HWND を毎回起動)、production は新 HWND を正しく検出 (silent reuse 誤判定なし)
- production 動作は正しい、scenario doc の前提が outdated

**修正方針**:
- §1.1 の対象 app を `chrome.exe` / `outlook.exe` / `vscode.exe` 等 truly single-instance app に変更
- または Win11 Notepad multi-instance に合わせて scenario rewrite

**修正反映** (Phase 7 patch、本 PR):
- §1.1 対象 app を `notepad.exe` → `chrome.exe` に変更 (§3 末尾の「共通操作上の note」整合)
- §1.1 に「対象 app の選定」subsection を追加し truly single-instance / multi-instance の区別を明示
- 「Win11 New Notepad は multi-instance、本 scenario の対象外」note を追加 (将来の dogfood 担当が同じ罠を踏まないため)
- §1.3 にも「本 scenario は新規 HWND 採番 path のテストなので multi-instance Notepad は適合」note 追加 (§1.1 → §1.3 順読時の見かけ矛盾を解消)

---

## 推奨着手順

1. **F1 fix (P1, 本 doc 起票 PR と同時 land 推奨)** — release blocking 候補、`fix/run-macro-stop-on-error-inner-envelope` branch で fix + unit test pin
2. **F2 fix** — F1 と同 commit が望ましい (warnings[] surface も同 macro.ts handler 内編集)
3. **F3 fix** — Phase 7、別 PR (`_errors.ts` に SpawnFailed typed code 追加 + workspace.ts emit + classify branch)
4. **F4 fix** — Phase 7、別 PR (keyboard.ts verifyDelivery 内 ValuePattern fallback) — PR #233 で land したが §F4-bis で gate 不足が露呈、別 hotfix 必要 → **PR #235 で land 完了**
5. **F5 doc fix** — scenario doc rewrite、F1 fix PR と同梱可 (small change)
6. **F4-bis fix** — **PR #235 で land 完了** (Hybrid (b)+(c)-light、修正方針は Opus 諮問結果準拠)。`main` 反映済、v1.4.2 release で Closed 昇格予定 (実機 dogfood Step 1 で `delivered` 確認後)

**北極星整合**: F1 fix が最優先 — Phase 5 closure 北極星 (silent-success = 0) が dogfood scope で再達成、v1.4.0 release readiness 復活。F4-bis は P3 で北極星違反ではないが、PR #233 contract claim の未達成 = silent contract drift だった、PR #235 land で `main` 上では解消、v1.4.2 release 後に北極星 F4 entry 完全達成扱い。
