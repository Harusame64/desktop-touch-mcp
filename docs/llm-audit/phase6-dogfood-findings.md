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

## F4 (P3): keyboard:type BG on Notepad が `verifyDelivery: 'unverifiable'` 返却

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

**修正反映** (Phase 7 v1.4.1 patch、本 PR):
- §1.1 対象 app を `notepad.exe` → `chrome.exe` に変更 (line 136 共通 note 整合)
- §1.1 に「対象 app の選定」subsection を追加し truly single-instance / multi-instance の区別を明示
- 「Win11 New Notepad は multi-instance、本 scenario の対象外」note を追加 (将来の dogfood 担当が同じ罠を踏まないため)

---

## 推奨着手順

1. **F1 fix (P1, 本 doc 起票 PR と同時 land 推奨)** — release blocking 候補、`fix/run-macro-stop-on-error-inner-envelope` branch で fix + unit test pin
2. **F2 fix** — F1 と同 commit が望ましい (warnings[] surface も同 macro.ts handler 内編集)
3. **F3 fix** — Phase 7、別 PR (`_errors.ts` に SpawnFailed typed code 追加 + workspace.ts emit + classify branch)
4. **F4 fix** — Phase 7、別 PR (keyboard.ts verifyDelivery 内 ValuePattern fallback)
5. **F5 doc fix** — scenario doc rewrite、F1 fix PR と同梱可 (small change)

**北極星整合**: F1 fix が最優先 — Phase 5 closure 北極星 (silent-success = 0) が dogfood scope で再達成、v1.4.0 release readiness 復活。
