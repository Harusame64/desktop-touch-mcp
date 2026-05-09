# LLM Operation Audit — Phase 3b Execution Sweep Results

- Status: **Phase 3b 完了 (Tier 2 commit 軸 実機 scenario audit、52 cell)**
- Date: 2026-05-09
- Authors: Claude (Opus, max effort) — user (Harusame64) 主導
- Branch: `feature/llm-audit-phase3b-execution-sweep`
- Origin: epic #211 Phase 3、Plan SSOT `docs/llm-operation-audit.md` §5 Phase 3
- Predecessor: Phase 2a (`phase2a-doc-audit.md`、PR #212) / Phase 2b (`phase2b-execution-audit.md`、PR #213) / Phase 3a (`phase3a-doc-audit.md`、PR #214)
- Scope: Tier 2 commit 軸 13 actions × 4 実機項目 = **52 cell**

---

## 1. Audit 対象 (Phase 3a と同 13 actions、matrix §3.1 line 152-164 整合)

| # | Action | Tool registration file | matrix §3.1 row |
|---|---|---|---|
| 16 | `focus_window` | `src/tools/window.ts` | 152 |
| 17 | `desktop_act` | `src/tools/desktop-register.ts` | 153 |
| 18 | `click_element` | `src/tools/ui-elements.ts` | 154 |
| 19 | `window_dock` | `src/tools/window-dock.ts` | 155 |
| 20 | `workspace_launch` | `src/tools/workspace.ts` | 156 |
| 21 | `run_macro` | `src/tools/macro.ts` | 157 |
| 22 | `notification_show` | `src/tools/notification.ts` | 158 |
| 23 | `browser_click` | `src/tools/browser.ts` | 159 |
| 24 | `browser_eval` | `src/tools/browser.ts` | 160 |
| 25 | `browser_navigate` | `src/tools/browser.ts` | 161 |
| 26 | `browser_fill` | `src/tools/browser.ts` | 162 |
| 27 | `browser_form` | `src/tools/browser.ts` | 163 |
| 28 | `browser_open` | `src/tools/browser.ts` | 164 |

## 2. 判定値 (Plan §4.3 整合、Phase 2b と同)

- `pass` — 既存 automated regression pin が cell の正常 / error / edge / chain contract を bit-equal に固定済、または dogfood scenario doc で完全カバー (本 PR 同梱)
- `fix carry-over (test gap)` — 別 PR で automated pin 追加候補
- `fix carry-over (scenario gap)` — automated pin 困難 (実機 GUI / OS 依存)、dogfood scenario doc で永続化済
- `fix carry-over (contract drift)` — Phase 3a G1 inheritance (notification_show)
- `unverifiable accepted` — `verifyDelivery` 等で degradation 明示済 (matrix §1.3 北極星整合)

`(gap: ...)` admission は Phase 2b と同 token 形式、cell-level は automated pin 不在 cells を明示。

## 3. Audit cells (13 actions × 4 実機項目)

各 cell で **既存 pin の file:line 引用** または **新規 dogfood scenario doc への section リンク** を残す。

### 3.1 OS-level / window 操作 (4 actions)

| # | Action | 正常 path | error path | edge case | chain | 判定 |
|---|---|---|---|---|---|---|
| 16 | focus_window | `tests/unit/focus-window-handler.test.ts:92-109` (default attempt success path、ok:true without escalation) | `tests/unit/focus-window-handler.test.ts:76-90` (WindowNotFound、no title match)、`tests/unit/issue-184-foreground-refusal-pin.test.ts` family の foreground refusal pin (representative) | `tests/unit/focus-window-handler.test.ts:111-130` (auto-escalate force=true after default fail、AttachThreadInput path) | `tests/e2e/workspace-chain.test.ts:25-61` (H1-base focus_window WindowNotFound + wait_until suggest chain) | **pass** |
| 17 | desktop_act | `tests/unit/desktop-act-commit-wrapper.test.ts:225-241` (G3-S4-1 happy path、ToolCallStarted+Completed、raw shape return) | `tests/unit/desktop-act-commit-wrapper.test.ts:243-266` (G3-S4-2 lease 'expired' → LeaseExpired + try_next desktop_discover) | `tests/unit/desktop-act-commit-wrapper.test.ts:268-283` (G3-S4-2b residual lease reasons → Unknown typed code) | `tests/unit/desktop-act-commit-wrapper.test.ts:513-528` (lease-less commit variant、click_element mechanical copy で skip validation) | **pass** |
| 18 | click_element | `tests/unit/click-element-commit-wrapper.test.ts:40-87` (G6-S6-1 makeCommitWrapper flow pass、ToolCallStarted/Completed、lease_token undefined) | `tests/e2e/error-quality.test.ts:35-78` (G1 InvokePatternNotSupported on non-InvokePattern element + suggest mouse_click) | `tests/e2e/ui-elements-cache.test.ts:26-59` (F1-base ElementNotFound nonexistent automationId + suggest desktop_discover) | `tests/e2e/ui-elements-cache.test.ts:61-74` (F1 context windowTitle for corrective get_ui_elements re-query) | **pass** |
| 19 | window_dock | `tests/unit/expansion-window-dock-wrapper.test.ts:45-90+` (makeCommitWrapper flow pass、ToolCallStarted/Completed) | `tests/e2e/dock-window.test.ts:86-99` (structured error for unknown titles) | `tests/e2e/dock-auto.test.ts:10-100` (resolveDimSpec / parseCorner / parseBoolEnv schema validation、DPI scaling、garbage input fallback) | `tests/unit/expansion-window-dock-wrapper.test.ts:78-89` + `:124-135` (action `pin` / `dock` discriminatedUnion dispatch、commit-axis chain) | **pass** |

### 3.2 launcher / macro / OS notification (3 actions)

| # | Action | 正常 path | error path | edge case | chain | 判定 |
|---|---|---|---|---|---|---|
| 20 | workspace_launch | `tests/unit/expansion-workspace-launch-wrapper.test.ts:45-90+` (makeCommitWrapper flow pass、ToolCallStarted/Completed) | (gap: workspace_launch error path automated pin 不在 — wait_until WaitTimeout 委譲のため direct error pin scope 外、`docs/llm-audit/dogfood-scenarios/launcher-macro.md` §1.2 で manual SoT) | `tests/e2e/workspace-chain.test.ts:73-109` (real notepad spawn + foundWindow structure validation) | `tests/e2e/workspace-chain.test.ts:111-127` (H1-chain workspace_launch → wait_until(window_appears) succeeds) | **pass** |
| 21 | run_macro | `tests/unit/expansion-run-macro-wrapper.test.ts:34-62` (makeCommitWrapper flow pass、ToolCallStarted/Completed) | (gap: run_macro 自身の error path automated pin 不在 — TOOL_REGISTRY 経由 recursion prevention で macro 内 macro が invocable 状態でないため direct macro-level error pin が design constraint で困難、per-step error は所属 tool の error pin に委譲、`docs/llm-audit/dogfood-scenarios/launcher-macro.md` §2.2 で manual SoT) | `tests/unit/expansion-run-macro-wrapper.test.ts:64-79` (raw shape return / envelope hoisted compat) | `tests/unit/expansion-run-macro-wrapper.test.ts:81-100+` (include=causal で `caused_by.your_last_action = run_macro(...)`) | **pass** |
| 22 | notification_show | `tests/unit/expansion-notification-show-wrapper.test.ts:45-90` (makeCommitWrapper flow pass、ToolCallStarted/Completed) | (gap: notification_show error path automated pin 不在 — OS-level balloon、Win32 API call、production-handler error test 不在、`docs/llm-audit/dogfood-scenarios/launcher-macro.md` §3.2 で manual SoT) + **Phase 3a G1 contract drift inheritance** (production line 69 で `hints.verifyDelivery: 'unverifiable'` emit 不在、matrix §3.1 line 158 規範未実装、J1 で別 PR 修正) | `tests/unit/expansion-notification-show-wrapper.test.ts:94-111` (raw shape return / envelope hoisted compat) | `tests/unit/expansion-notification-show-wrapper.test.ts:113-138` (include=causal chain) | **fix carry-over (contract drift)** — Phase 3a G1 inheritance (J1 production code 改修 + Codex 必須) |

### 3.3 browser_* (6 actions)

| # | Action | 正常 path | error path | edge case | chain | 判定 |
|---|---|---|---|---|---|---|
| 23 | browser_click | `tests/unit/expansion-browser-click-wrapper.test.ts:35-62` (makeCommitWrapper flow pass) | `tests/e2e/browser-cdp-verification.test.ts:87-155+` (issue #181 MutationObserver probe primitives、verifyDelivery contract) | `tests/e2e/browser-cdp-verification.test.ts` (verifyDelivery.status `delivered` / `unverifiable` based on DOM mutation) | `tests/unit/expansion-browser-click-wrapper.test.ts:65-80+` (raw shape return / envelope hoisted) | **pass** |
| 24 | browser_eval | `tests/unit/expansion-browser-eval-wrapper.test.ts:34-62` (makeCommitWrapper flow pass) | `tests/unit/browser-eval-iife.test.ts:15-40` (canParseAsExpression rejects statements (const/return)、accepts IIFE expressions) | `tests/unit/browser-eval-iife.test.ts:43-80` (isAlreadyWrappedIife semicolon handling、standalone vs statement-shaped) | `tests/e2e/browser-tab-context.test.ts:70-80+` (browserEvalJsHandler appends activeTab + readyState to success response) | **pass** |
| 25 | browser_navigate | `tests/unit/expansion-browser-navigate-wrapper.test.ts:45-90+` (makeCommitWrapper flow pass) | `tests/e2e/browser-navigate-wait.test.ts:68-79` (file:// URLs reject、http/https only) | `tests/e2e/browser-navigate-wait.test.ts` (waitForLoad loadTimeoutMs=1 timeout、readyState='complete' contract) | `tests/unit/expansion-browser-navigate-wrapper.test.ts:64-80+` (raw shape return) | **pass** |
| 26 | browser_fill | `tests/unit/expansion-browser-fill-wrapper.test.ts:33-61` (makeCommitWrapper flow pass) | `tests/e2e/browser-cdp-verification.test.ts` (BrowserFillNotDelivered when framework transforms value、element.value read-back check) | `tests/e2e/browser-search.test.ts:48-79+` (confidence scoring、by:'text'\|'regex' search paths fixture for fill/click) | `tests/unit/expansion-browser-fill-wrapper.test.ts:64-80+` (raw shape return) | **pass** |
| 27 | browser_form | `tests/unit/expansion-browser-form-wrapper.test.ts:34-61` (makeCommitWrapper flow pass) | (gap: browser_form error path automated pin 不在 — form field inspection は read-only、error path は CDP unavailability のみで delegation、`docs/llm-audit/dogfood-scenarios/browser-tier2.md` §6.2 で manual SoT) | `tests/unit/expansion-browser-form-wrapper.test.ts:64-80+` (fields array structure、raw shape return) | `tests/e2e/browser-tab-context.test.ts` (browserGetInteractiveHandler activeTab + readyState chain) | **pass** |
| 28 | browser_open | `tests/unit/expansion-browser-open-wrapper.test.ts:45-90+` (makeCommitWrapper flow pass) | `tests/unit/browser-launch-killexisting.test.ts:63-100` (killProcessesByName exit code 128 graceful + throw handling) | `tests/unit/browser-launch-killexisting.test.ts:69-83` (System32/taskkill.exe absolute path、PATH hijack defense) | `tests/e2e/browser-connect-active.test.ts:53-79` (tabs array with active boolean、top-level active field chain) | **pass** |

### 3.4 集計

判定値の集計は **action-level** と **cell-level** を別々に提示 (Phase 2b と同 Lesson 4 numeric count sync 教訓適用)。

#### Action-level (13 actions)

- `pass`: **12 actions** — 16 / 17 / 18 / 19 / 20 / 21 / 23 / 24 / 25 / 26 / 27 / 28
- `fix carry-over (contract drift)`: **1 action** — 22 (notification_show、Phase 3a G1 inheritance、J1 production code 改修)
- `fix carry-over (test gap)`: 0 (本 phase で新規 automated pin 必須 gap なし、scenario gap は dogfood で永続化)
- `unverifiable accepted`: 0
- `breaking change candidate`: 0

#### Cell-level (52 cells、`(gap: ...)` admission count)

- `file:line` 単位で automated pin 固定: **48 cells**
- `(gap: ...)` 明示 admission (dogfood scenario doc で永続化): **4 cells**

Cell-level admission 4 cells の所在:
- 行 cell 20 error (workspace_launch、`launcher-macro.md` §1.2)
- 行 cell 21 error (run_macro、`launcher-macro.md` §2.2、TOOL_REGISTRY recursion prevention design constraint)
- 行 cell 22 error (notification_show、`launcher-macro.md` §3.2、OS-level Win32 API design constraint)
- 行 cell 27 error (browser_form、`browser-tier2.md` §6.2、read-only design constraint)

**4 cells すべて design constraint による gap** (recursion prevention / OS-level / read-only)、新規 automated pin 化の cost-benefit が低く dogfood scenario doc で永続化が妥当。Phase 5 release readiness 判定外し候補。

**Note: cell 22 (notification_show error) は dual-flag**: cell-level では `(gap:)` admission の 1 件として count、action-level では Phase 3a G1 inheritance による 「fix carry-over (contract drift)」 の唯一の根拠。同 cell が 2 軸で別々に flag されるため、cell-axis 集計 (4 件) と action-axis 集計 (1 件) で重複 count なし。

## 4. Findings 詳細

Phase 3b は実機 cell 軸の audit、新規独立 finding なし — 全 4 scenario gap は **design constraint 由来** で別 PR の test 追加対象外。Phase 3a 由来の **J1 (G1 notification_show contract drift)** が action 22 cell-level に inherit される唯一の actionable item。

### H1 (defer): workspace_launch / run_macro / notification_show / browser_form error path automated pin

- **gap 内訳**:
  - workspace_launch: WaitTimeout 委譲 (matrix §3.1 line 156、wait_until 経由)
  - run_macro: TOOL_REGISTRY recursion prevention (macro 内 macro 不可能の design)
  - notification_show: OS-level Win32 API (balloon tip 失敗の direct test 困難)
  - browser_form: read-only inspection (delegation で error path direct test 不在)
- **scenario 永続化**: `dogfood-scenarios/launcher-macro.md` §1.2 / §2.2 / §3.2 + `dogfood-scenarios/browser-tier2.md` §6.2
- **推奨 fix**: **defer** (design constraint 由来、Phase 5 release readiness 判定外し候補、E5 と同型)

## 5. Issue 起票候補 (Phase 5 closure に向けて、Phase 2a I1-I3 + Phase 2b E1-E5 + Phase 3a J1-J4 + Phase 3b H1 統合管理)

| # | Source | Priority | Type |
|---|---|---|---|
| **I1** (Phase 2a F4) | `FocusLostDuringType` SSOT register | **High** | production code (Codex 必須) |
| **J1** (Phase 3a G1) | `notification_show` `hints.verifyDelivery` emit | **High** | production code (Codex 必須) |
| **I2** + **J2** | description 補強 (Phase 2a F1+F3+F5+F6+F7+F8+F9+F10 + Phase 3a G2+G3+G7+G8+G12) | Medium | docs only |
| **I3** | Phase 2a F2 cross-tool ForegroundRestricted unified wording | Medium | docs only |
| **J4** (Phase 3a G13) | matrix §3.1 line 159/162 browser_click verifyDelivery status enum narrowing | Medium | docs only (matrix update) |
| **E1-E4** (Phase 2b) | automated-pin gap | Medium / Low | new test only |
| **J3** (Phase 3a G9+G11) | description minor enrichment | Low | docs only |
| **E5** (Phase 2b) | scroll:capture frame seam | **Defer** | optional |
| **H1** (Phase 3b) | workspace_launch / run_macro / notification_show / browser_form error path automated pin | **Defer** | optional (design constraint 由来) |

I1 + J1 が依然 highest priority (production contract drift)、その他は docs / test 補強。release readiness 判定材料は Phase 5 closure 時点で I1 + J1 fix を blocking 条件、E5 / H1 は defer 妥当。

## 6. Phase 3b closure conditions (本 PR スコープ)

- [x] 13 actions × 4 実機項目 audit 完了 (52 cell 全埋まり)
- [x] 各 cell に既存 pin file:line 引用 or dogfood scenario doc section リンク残置
- [x] 判定値記入 (action-level: 12 pass / 1 contract drift inheritance / cell-level: 48 pinned / 4 (gap:) admission)
- [x] Issue 起票候補リスト (H1) 作成 + Phase 2a/2b/3a 統合管理表
- [x] Plan §6 acceptance 「scenario の永続化を 2 経路に分離」 — 既存 automated pins (`tests/unit/`、`tests/e2e/`) は本 doc 内 file:line 引用、新規 manual / dogfood scenarios は `docs/llm-audit/dogfood-scenarios/{launcher-macro,browser-tier2}.md` で永続化
- [x] CLAUDE.md §3.1 multi-table fact 整合 sweep — 各 fact を 5 view で bit-equal 確認:
  1. **matrix §3.1 規範** (line 152-164)
  2. **production code 実装事実** (`src/tools/{window,desktop-register,ui-elements,window-dock,workspace,macro,notification,browser}.ts`)
  3. **既存 automated unit / e2e pin** (本 doc 内 file:line 引用)
  4. **Phase 3a doc audit 判定** (`docs/llm-audit/phase3a-doc-audit.md`)
  5. **本 phase 実機 cell 判定** (本 doc §3.1-3.3 cell)

  確認した 3 fact:
  - 「`expansion-*-wrapper.test.ts` 系列の makeCommitWrapper contract pin」 (action 16-28 全行 で 正常 / chain pin が family に inherit)
  - 「Phase 3a J4 (matrix line 159 verifyDelivery 3↔2 narrowing)」 (本 phase cell 23 では `tests/e2e/browser-cdp-verification.test.ts` で 2 値 hint 観測、production type narrowing と整合)
  - 「`(gap: ...)` admission 4 cell の design constraint 由来」 (TOOL_REGISTRY recursion prevention / OS-level / read-only / wait_until 委譲)

- [x] CLAUDE.md §3.2 carry-over scope-shrink check — H1 carry-over は **既存 public API contract を破壊しない** (workspace_launch / run_macro / notification_show / browser_form の error path は既に dogfood scenario で代替表現、新規 pin が API 変更を要する case はない)

## 7. Out of scope (本 PR)

- production code 改修 (J1 production fix は別 PR で Codex 必須、Phase 5 closure 着手時)
- 新規 automated pin 実装 (H1 全 4 cells は defer、Phase 5 release readiness 判定外し候補)
- 11 tool query 軸 audit (Phase 4、Plan §5)

## 8. Phase 2a/2b/3a → 3b 連携整合 sweep (CLAUDE.md §3.1 適用)

Phase 3b は Tier 2 commit-axis 実機軸として独立、過去 phase との独立性 sweep:

| Phase | Sweep type | Phase 3b cell 判定整合 |
|---|---|---|
| Phase 2a (F1-F10) | Tier 1 doc | Phase 3b cell 判定とは独立 (Tier 軸が異なる)、I2 docs PR で別 fix |
| Phase 2b (E1-E5) | Tier 1 实机 | 同上、別 PR で test 追加 |
| Phase 3a (G1/G2/G3/G7/G8/G9/G11/G12/G13、9 distinct findings) | Tier 2 doc | **G1 inheritance** 確認 — action 22 cell 22 が 「fix carry-over (contract drift)」 で J1 production code 改修 trigger。**G13 family inheritance** 確認 — action 23 cell 23 の verifyDelivery 2 値 hint が browser-cdp-verification.test.ts で実機観測、Phase 3a の matrix narrowing recommendation と production reality 整合 |

**結論**: Phase 3b は Phase 3a の G1 (production code drift) を action-level inheritance で受け継ぐ唯一の cross-phase 整合事項、その他は独立 sweep で重複なし。

## 9. Related Files

- Plan SSOT: `docs/llm-operation-audit.md` (PR #210)
- Phase 2a / 2b / 3a 結果: `phase{2a-doc,2b-execution,3a-doc}-audit.md`
- 規範 doc: `docs/operation-verification-matrix.md` §3.1 line 152-164
- error code SSOT: `src/tools/_errors.ts`
- production code: `src/tools/{window,desktop-register,desktop-activation,ui-elements,window-dock,workspace,macro,notification,browser}.ts`
- 既存 automated pin (本 doc 内 file:line 引用済):
  - `tests/unit/{focus-window-handler,desktop-act-commit-wrapper,click-element-commit-wrapper,browser-eval-iife,browser-launch-killexisting}.test.ts`
  - `tests/unit/expansion-{window-dock,workspace-launch,run-macro,notification-show,browser-click,browser-eval,browser-navigate,browser-fill,browser-form,browser-open}-wrapper.test.ts`
  - `tests/e2e/{error-quality,ui-elements-cache,workspace-chain,dock-window,dock-auto,browser-cdp-verification,browser-navigate-wait,browser-search,browser-tab-context,browser-connect-active}.test.ts`
- 新規 dogfood scenarios (本 PR 同梱):
  - `docs/llm-audit/dogfood-scenarios/launcher-macro.md` (workspace_launch / run_macro / notification_show 3 actions、4 cells中 3 cells)
  - `docs/llm-audit/dogfood-scenarios/browser-tier2.md` (browser_* 6 actions Tier 2 軸、本 phase で focus は browser_form の 1 cell)
- Phase 4 ADR (別 epic): #185

---

END OF Phase 3b Execution Audit Results.
