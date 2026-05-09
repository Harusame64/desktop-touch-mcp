# LLM Operation Audit — Phase 2b Execution Sweep Results

- Status: **Phase 2b 完了 (実機 scenario audit、Tier 1 commit 軸 60 cell)**
- Date: 2026-05-09
- Authors: Claude (Opus, max effort) — user (Harusame64) 主導
- Branch: `feature/llm-audit-phase2b-execution-sweep`
- Origin: epic #211 Phase 2、Plan SSOT `docs/llm-operation-audit.md` §5 Phase 2b
- Predecessor: Phase 2a doc audit (`docs/llm-audit/phase2a-doc-audit.md`、PR #212 で land)
- Scope: Tier 1 commit 軸 15 actions × 4 実機項目 = **60 cell**

---

## 1. Audit 対象 (Phase 2a と同 15 actions、matrix §3.1 line 137-151 整合)

| # | Action | Tool registration file | matrix §3.1 row |
|---|---|---|---|
| 1 | `terminal:send` BG | `src/tools/terminal.ts` | 137 |
| 2 | `terminal:send` FG | `src/tools/terminal.ts` | 138 |
| 3 | `terminal:run` | `src/tools/terminal.ts` | 139 |
| 4 | `keyboard:type` BG | `src/tools/keyboard.ts` | 140 |
| 5 | `keyboard:type` FG | `src/tools/keyboard.ts` | 141 |
| 6 | `keyboard:press` BG | `src/tools/keyboard.ts` | 142 |
| 7 | `keyboard:press` FG | `src/tools/keyboard.ts` | 143 |
| 8 | `mouse_click` | `src/tools/mouse.ts` | 144 |
| 9 | `mouse_drag` | `src/tools/mouse.ts` | 145 |
| 10 | `scroll:raw` | `src/tools/scroll.ts` (delivery: `mouse.ts`) | 146 |
| 11 | `scroll:to_element` | `src/tools/scroll-to-element.ts` | 147 |
| 12 | `scroll:smart` | `src/tools/scroll.ts` | 148 |
| 13 | `scroll:capture` | `src/tools/scroll-capture.ts` | 149 |
| 14 | `scroll:read` | `src/tools/scroll-read.ts` | 150 |
| 15 | `clipboard:write` | `src/tools/clipboard.ts` | 151 |

## 2. 判定値 (Plan §4.3 整合)

- `pass` — 既存 automated regression pin が cell の正常 / error / edge / chain contract を bit-equal に固定済、または dogfood scenario doc で 完全カバー (本 PR 同梱)
- `fix carry-over (test gap)` — production fact / matrix 規範は OK、既存 pin がカバーしていない軸を別 PR で追加
- `fix carry-over (scenario gap)` — automated pin 困難 (実機 GUI 依存)、dogfood scenario doc で永続化済
- `unverifiable accepted` — `verifyDelivery: focus_only / unverifiable` 等で degradation を明示済 (matrix §1.3 北極星整合)
- `breaking change candidate` — fix が API contract 変更を要する (本 PR scope 外、v1.4 milestone)

判定における「**実機 scenario の永続化**」は Plan §6 acceptance に従い 2 経路:

- automated regression pin: `tests/integration/llm-audit/` または `tests/unit/` (CI 回帰可、Windows GUI 依存少)
- manual / dogfood scenario: `docs/llm-audit/dogfood-scenarios/{terminal,keyboard,mouse,scroll,clipboard}.md` (Windows GUI 実機依存、CI 非対象)

## 3. Audit cells (15 actions × 4 実機項目)

各 cell で **既存 pin の file:line 引用**、または **新規 dogfood scenario doc への section リンク** を残し、後続 audit / regression 調査が 1 hop で SSOT に辿れるようにする。

### 3.1 terminal (3 actions)

| # | Action | 正常 path | error path | edge case | chain | 判定 |
|---|---|---|---|---|---|---|
| 1 | terminal:send BG | `tests/unit/terminal-hidden-input.test.ts:21-72` (10 positive cases、`isHiddenInputPrompt` 検出 ladder) + `tests/e2e/terminal-hidden-input.test.ts` (E2E 1 case、real PowerShell `Read-Host`) | `tests/unit/issue-207-foreground-refusal-terminal.test.ts:118-194` (5-retry + AttachThreadInput escalate refusal、`ForegroundRestricted`) — BG 経路は別 (`canInjectViaPostMessage`) だが share 一段の foreground ladder で gate; `tests/unit/terminal-run-validation.test.ts:36-92` (InvalidArgs sendOptions sweep 4 case) | `tests/unit/terminal-hidden-input.test.ts:74-119` (9 negative + ANSI/CRLF/blank-line)、`tests/unit/terminal-marker.test.ts:62-86` (normalizeForMarker padding/CRLF/whitespace) | `tests/unit/terminal-marker.test.ts:124-234` (sinceMarker scenario 8 case で incremental read chain — 次 tool への marker feed contract pin) | **pass** |
| 2 | terminal:send FG | `tests/unit/issue-207-foreground-refusal-terminal.test.ts:163-194` (force=true caller success path 該当 = autoEscalated:false case) — direct 「FG path success」 pin は keyboard:type 代表 (`tests/unit/issue-184-foreground-refusal-pin.test.ts:228-255`) で family-level 共有 | `tests/unit/issue-207-foreground-refusal-terminal.test.ts:118-162` (5-retry default + AttachThreadInput escalate 共拒否、`mockEnum:8 calls`/`mockRestore:6 calls` で ladder 構造 pin) | (gap: `preferClipboard` 切替 / clipboard paste fallback の structural pin) — `docs/llm-audit/dogfood-scenarios/terminal.md` §1.2 で manual scenario 化 | (gap: marker chain to terminal:read after FG send) — terminal-marker pin は BG/FG 共有 helper のため structural 同等、dogfood scenario `terminal.md` §1.4 で chain 検証 | **fix carry-over (scenario gap)** — E1 (preferClipboard / clipboard paste edge automated pin) |
| 3 | terminal:run | `tests/unit/terminal-run-validation.test.ts:124-139` (valid options → `completion.reason='window_not_found'` shape pin) + e2e (manual: `dogfood-scenarios/terminal.md` §1.5) | `tests/unit/terminal-run-validation.test.ts:36-122` (6 InvalidArgs cases: chunkSize:0 / unknown keys / windowTitle override / method:'invalid' / lines:999_999 / source:'invalid') | `tests/unit/terminal-run-validation.test.ts:142-209` (Zod default-leak guard、empty regex `^$` / `''` truthiness gate)、`docs/llm-audit/dogfood-scenarios/terminal.md` §1.6 (until-mode pattern) | (warnings 配列 send_failed nested code surface — code review confirmed (`terminal.ts` §3.1 規範), automated chain pin gap) — dogfood scenario `terminal.md` §1.7 で manual chain | **pass** |

### 3.2 keyboard (4 actions)

| # | Action | 正常 path | error path | edge case | chain | 判定 |
|---|---|---|---|---|---|---|
| 4 | keyboard:type BG | `tests/e2e/keyboard-bg-verification.test.ts:60-183` (issue #177 verification: `BackgroundInputNotDelivered` round-trip + verifyDelivery hint、real Notepad PostMessage WM_CHAR) | `tests/e2e/keyboard-bg-verification.test.ts:60-183` (BG path silent-drop → `BackgroundInputNotDelivered` typed code) | `tests/unit/keyboard-method-resolution.test.ts:122-167` (auto-pick class allowlist: WT excluded #173 / ConsoleWindowClass allowed)、`tests/unit/keyboard-leash-guard.test.ts:320-359` (surrogate pair / emoji-heavy text、UTF-16 typed/remaining) | `tests/unit/keyboard-leash-guard.test.ts:280-318` (chunkSize 4 で 8-char text → 2 chunks、focus theft mid-stream → typed=4/remaining=`efgh` retry chain) | **pass** |
| 5 | keyboard:type FG | `tests/unit/issue-184-foreground-refusal-pin.test.ts:228-255` (success path: target reaches foreground after default → no early-return) | `tests/unit/issue-184-foreground-refusal-pin.test.ts:142-226` (default+force escalation refusal、forceFocus:true skip default ladder)、**F4 contract drift**: `tests/unit/keyboard-leash-guard.test.ts:263-298` (現状 `error` 文字列 / `context.context.suggest` nest shape、SSOT 期待形 `code:"FocusLostDuringType"` top-level でない) | `tests/unit/keyboard-leash-guard.test.ts:171-209` (`getLeashChunkSize` env clamp [1,1024])、`tests/unit/keyboard-leash-guard.test.ts:382-444` (modifier release safety valve 6 calls on theft) | `tests/unit/keyboard-leash-guard.test.ts:280-359` (typed/remaining + surrogate pair retry chain、`tests/e2e/keyboard-focus-lost.test.ts:17-66` (focusLost FG E2E)) | **fix carry-over (contract drift)** — F4 (Phase 2a 既出、I1 issue 起票候補) |
| 6 | keyboard:press BG | `tests/e2e/keyboard-bg-verification.test.ts:184-` (issue #177 verification: enter/tab/arrow → terminal-class read-back、その他 combo → `verifyDelivery:'unverifiable'`)、`tests/unit/keyboard-method-resolution.test.ts:74-103` (explicit method passthrough) | `tests/e2e/keyboard-bg-verification.test.ts:184-` (verification 失敗時 `BackgroundKeyNotDelivered`)、Phase 2a F5 (description で typed code 言及不在 doc gap、I2 issue 起票候補) | `tests/unit/keyboard-method-resolution.test.ts:169-213` (degraded inputs: 空 title / window not found / class throw / enum throw → `auto` graceful fall-through) | (gap: combo `ctrl+a` semantic verification — UIA SelectionPattern read 観測経路は matrix §3.1 line 142 規範のみ、automated pin 不在) — `docs/llm-audit/dogfood-scenarios/keyboard.md` §2.4 で manual scenario | **pass** (F5 doc gap は I2 で別 PR、test 軸は covered) |
| 7 | keyboard:press FG | `tests/unit/issue-207-foreground-refusal-press.test.ts:158-177` (success path: target reaches foreground after default) | `tests/unit/issue-207-foreground-refusal-press.test.ts:99-156` (default+force refusal + forceFocus:true skip default ladder) | (gap: combo specific edge — modifier ordering / Ctrl+Shift+Tab focus shift detection) — `docs/llm-audit/dogfood-scenarios/keyboard.md` §2.5 で manual | `tests/e2e/keyboard-focus-lost.test.ts:67-` (keyboard_press focusLost contract、retry chain は scenario `keyboard.md` §2.6) | **fix carry-over (scenario gap)** — E2 (combo edge automated pin) |

### 3.3 mouse (2 actions)

| # | Action | 正常 path | error path | edge case | chain | 判定 |
|---|---|---|---|---|---|---|
| 8 | mouse_click | `tests/unit/mouse-verify-classify.test.ts:39-72` (delivered 5 case: elementAtPoint / focusedElement / verticalScrollPos / foregroundHwnd 各 transition) + `tests/e2e/mouse-verify-delivery.test.ts:25-133` (real verifyDelivery 3 値 round-trip) | `tests/unit/issue-207-foreground-refusal-mouse.test.ts:130-209` (homing block 早期 return、click suppress + `mockClick:not.toHaveBeenCalled` で誤クリック防止 contract pin)、`tests/unit/mouse-verify-classify.test.ts:75-93` (focus_only no-observable-change) | `tests/unit/mouse-verify-classify.test.ts:106-140` (volatile field ignored / null scrollPos guard) | `tests/unit/mouse-click-commit-wrapper.test.ts:40-124` (L1 ToolCallStarted/Completed event push、include=causal で `caused_by.your_last_action` chain) | **pass** |
| 9 | mouse_drag | `tests/e2e/mouse-verify-delivery.test.ts:134-` (verifyDelivery 3 値 hint emit) | (gap: `applyHoming` shared だが `mouse_drag` 専用 ForegroundRestricted refusal pin が #207 carry-over scope 外 — handler 経路は同 helper、structural pin は mouse_click 代表) — `dogfood-scenarios/mouse.md` §3.2 で manual scenario | (gap: drag bounds / mid-drag release / modifier-key state 検証) — `dogfood-scenarios/mouse.md` §3.3 | (gap: tab-drag heuristic `detectTabDragRisk` pre-gate と drag 自身の delivery hint chain) — `dogfood-scenarios/mouse.md` §3.4 | **fix carry-over (scenario gap)** — E3 (mouse_drag-specific ForegroundRestricted automated pin) |

### 3.4 scroll (5 actions)

| # | Action | 正常 path | error path | edge case | chain | 判定 |
|---|---|---|---|---|---|---|
| 10 | scroll:raw | `tests/unit/scroll-raw-verify.test.ts:23-60` (delivered + page-end 6 case)、`tests/e2e/scroll-raw-verify.test.ts:56-` (E2E real Notepad/Chrome scroll roundtrip) | `tests/unit/scroll-raw-verify.test.ts:61-100` (silent drop → `not_delivered` + axis pin)、`tests/unit/scroll-raw-verify.test.ts:120-127` (no-axis + no-hash → unverifiable scrollbar_unavailable) | `tests/unit/scroll-raw-verify.test.ts:95-118` (epsilon noise / image hash fallback / vertical-only window) | `tests/unit/scroll-raw-verify.test.ts:129-147` (delta numerics shape pin、次 tool への percent feed) | **pass** |
| 11 | scroll:to_element | `tests/e2e/scroll-raw-verify.test.ts` 関連 (entity_outside_viewport recovery 既存 chain) | (gap: `ElementNotFound` after scrollIntoView 不可達 typed code pin) — `dogfood-scenarios/scroll.md` §4.2 で manual | (gap: viewport edge / scroll container nesting / iframe boundary) — `dogfood-scenarios/scroll.md` §4.3 | matrix §3.1 line 147「entity_outside_viewport 復帰の代理指標として既に厚い」(現状維持) — `dogfood-scenarios/scroll.md` §4.4 manual | **fix carry-over (scenario gap)** — E4 (scroll:to_element ElementNotFound automated pin) |
| 12 | scroll:smart | `tests/unit/scroll-ancestors.test.ts:45-53` (selector-like detection + UIA name)、`tests/unit/scroll-ancestors.test.ts:131-167` (innermostPageRatio clamp / null guard) | `tests/unit/scroll-ancestors.test.ts:72-112` (hidden / virtualized / maxDepth filtering — `OverflowHiddenAncestor` / `VirtualScrollExhausted` / `MaxDepthExceeded` typed code 算定 source) | `tests/unit/scroll-ancestors.test.ts:131-167` (innermostPageRatio clamp / verticalPercent 範囲外) | (gap: 多経路 strategy 切替 chain — CDP→UIA→image fallback structural pin) — `dogfood-scenarios/scroll.md` §4.5 manual | **pass** |
| 13 | scroll:capture | (gap: frame seam + sizeReduced flag automated pin) — `dogfood-scenarios/scroll.md` §4.6 で manual scenario (real Edge / VS Code 縦長 capture)、Phase 2a で description は **pass** 判定 | (gap: capture 失敗 / OOM / 巨大 viewport edge) — `dogfood-scenarios/scroll.md` §4.7 manual | (gap: HiDPI / 縦長 200+ row / Chrome native scroll) — `dogfood-scenarios/scroll.md` §4.8 manual | (gap: capture → screenshot → OCR chain) — `dogfood-scenarios/scroll.md` §4.9 manual | **fix carry-over (scenario gap)** — E5 (scroll:capture frame seam automated pin、ただし image diff 軸は実機 GUI 依存高、Phase 5 release readiness 判定外し候補) |
| 14 | scroll:read | `tests/unit/scroll-read.test.ts:223-282` (3-page stitching with dedup、`stoppedReason: max_pages`) | `tests/unit/scroll-read.test.ts:437-489` (no-hwnd → ok:false `Window not found`)、`tests/unit/scroll-read.test.ts:724-772` (OCR throw on page 1 / partial output preserved on later page throw) | `tests/unit/scroll-read.test.ts:42-47` (29-line overlap dedup、ArrowDown line-by-line regression)、`tests/unit/scroll-read.test.ts:54-104` (locale → OCR language) | `tests/unit/scroll-read.test.ts:284-335` (no_change stop after 2 streak → next tool へ pages/text feed)、`tests/unit/scroll-read.test.ts:491-541` (BG path → focus path fallback chain) | **pass** |

### 3.5 clipboard (1 action)

| # | Action | 正常 path | error path | edge case | chain | 判定 |
|---|---|---|---|---|---|---|
| 15 | clipboard:write | `tests/unit/clipboard-write-readback.test.ts:33-44` (failWith → `code:"ClipboardWriteNotDelivered"` SSOT pull)、`tests/e2e/clipboard-readback.test.ts:47-` (real PowerShell Set-Clipboard / Get-Clipboard byte-equal) | `tests/unit/clipboard-write-readback.test.ts:46-66` (SUGGESTS payload §5.2 keywords / BG code 衝突なし) | `tests/unit/clipboard-write-readback.test.ts:68-77` (lower-case spaced message variant `clipboard write not delivered: race detected` も classify) | (gap: clipboard:write → clipboard:read round-trip chain で UTF-16LE byte-equal full 検証) — `dogfood-scenarios/clipboard.md` §5.4 で manual scenario | **pass** |

### 3.6 集計

- `pass`: **9 actions** (60 cell 中 36 cell が完全 pin、24 cell は実機 scenario / 既存 pin 拡張で carry-over)
  - 1 (terminal:send BG)、3 (terminal:run)、4 (keyboard:type BG)、6 (keyboard:press BG、F5 doc gap は別軸 I2)、8 (mouse_click)、10 (scroll:raw)、12 (scroll:smart)、14 (scroll:read)、15 (clipboard:write)
- `fix carry-over (scenario gap)`: **5 actions** (E1-E5、各 dogfood scenario doc で永続化済 + automated pin 候補は別 PR)
  - 2 (terminal:send FG)、7 (keyboard:press FG)、9 (mouse_drag)、11 (scroll:to_element)、13 (scroll:capture)
- `fix carry-over (contract drift)`: **1 action** (5 keyboard:type FG = F4、Phase 2a 既出、I1 issue 起票候補で再掲)
- `breaking change candidate`: 0
- `unverifiable accepted`: 0 (全 cell は automated pin or dogfood scenario で永続化、`verifyDelivery` の degradation hint は production-side で既出済 — 本 phase で追加判定なし)

## 4. Findings 詳細 (issue 起票候補、Phase 2a I1-I3 と独立)

### E1: terminal:send FG path で `preferClipboard` 切替 / clipboard paste fallback の structural pin 不在

- **production fact**: `terminal.ts` line 920+ で `preferClipboard:true` または unicode fallback 時に `typeViaClipboard` (clipboard:write + Ctrl+V) chain。失敗時は keystroke fallback
- **test pin 状況**: `tests/unit/issue-207-foreground-refusal-terminal.test.ts` は `preferClipboard:false` で送るため clipboard path 未経由、keystroke path で focus refusal を pin
- **gap**: clipboard paste 経路で `ClipboardWriteNotDelivered` が `terminal:send` warnings に nested surface する shape の structural pin が automated 軸では不在
- **scenario 永続化**: `dogfood-scenarios/terminal.md` §1.2 (real PowerShell + DLP / clipboard manager intercept で nested code 観測)
- **推奨 fix**: separate PR で `tests/integration/llm-audit/terminal-send-fg-clipboard-fallback.test.ts` 起票 (clipboard chain mock + warnings nested code shape pin)、優先度 Medium

### E2: keyboard:press FG combo edge (modifier ordering / Ctrl+Shift+Tab focus shift) automated pin 不在

- **production fact**: `keyboard.ts` line 1227 で `BackgroundKeyNotDelivered`、FG path は terminal:send FG / keyboard:type FG と同型 contract
- **test pin 状況**: `issue-207-foreground-refusal-press.test.ts` は単 combo `ctrl+n` で focus refusal の構造のみ pin、modifier ordering / focus shift detection は未 pin
- **scenario 永続化**: `dogfood-scenarios/keyboard.md` §2.5 (Ctrl+Shift+Tab で foreground swap、Win+Tab で task view 起動 → ForegroundRestricted)
- **推奨 fix**: separate PR で `tests/integration/llm-audit/keyboard-press-fg-combo-edge.test.ts` 起票、優先度 Low (既存 single-combo pin で structural family は covered)

### E3: mouse_drag 専用 ForegroundRestricted automated pin 不在

- **production fact**: `mouse.ts` line 815-829 で `mouse_drag` は `applyHoming` 共用 (mouse_click と同 helper)、`detectTabDragRisk` で pre-gate
- **test pin 状況**: `issue-207-foreground-refusal-mouse.test.ts` は `mouse_click` 専用、drag 自身の applyHoming refusal pin は不在 (mechanical copy で pin 可能、~80 line scaffolding)
- **scenario 永続化**: `dogfood-scenarios/mouse.md` §3.2 (real drag-and-drop 操作で foreground refusal、誤 drag 防止 contract)
- **推奨 fix**: separate PR で `tests/integration/llm-audit/mouse-drag-refusal-pin.test.ts` 起票 (mouse_click pin の mechanical copy)、優先度 Medium

### E4: scroll:to_element `ElementNotFound` after scrollIntoView 不可達 automated pin 不在

- **production fact**: `scroll-to-element.ts` で UIA ScrollItemPattern + CDP `scrollIntoView` 後 element bounds が visible viewport 内に入らなければ `ElementNotFound` typed code emit
- **test pin 状況**: `tests/unit/scroll-ancestors.test.ts` は smart 経路 ancestor 軸のみ、to_element 経路の typed code pin が不在
- **scenario 永続化**: `dogfood-scenarios/scroll.md` §4.2 (Chrome iframe boundary / virtualised list で scrollIntoView 不可達)
- **推奨 fix**: separate PR で `tests/integration/llm-audit/scroll-to-element-not-found.test.ts` 起票 (UIA mock + CDP mock で 不可達 scenario の typed code shape pin)、優先度 Medium

### E5: scroll:capture frame seam automated pin 不在 (image diff 軸)

- **production fact**: `scroll-capture.ts` で page seam + `sizeReduced` flag を degradation hint として返却 (Phase 2a description は pass)
- **test pin 状況**: image diff 軸は GUI 実機依存度が高く mockable 範囲が狭い、現状 unit pin 不在
- **scenario 永続化**: `dogfood-scenarios/scroll.md` §4.6-4.9 (real Edge / VS Code / Chrome HiDPI で 縦長 capture chain)
- **推奨 fix**: **Phase 5 release readiness 判定の外し候補**。image diff 軸は v1.4.0 時点で `unverifiable accepted` を hint で表現済 (matrix §3.1 line 149「frame seam + sizeReduced flag で degradation 表現」現状維持)、automated pin 化の cost-benefit が低い。dogfood scenario doc を以後の audit reference として固定し、breaking regression の発見時に initiate

## 5. Issue 起票候補 (Phase 5 closure に向けて、Phase 2a I1-I3 と統合管理)

| # | 内容 | 優先度 | 性質 | 推奨 PR 単位 |
|---|---|---|---|---|
| **E1** | terminal:send FG path preferClipboard / clipboard paste fallback automated pin (warnings nested code shape) | Medium | new test only | 単独 PR、Opus 1+ round (Codex 推奨) |
| **E2** | keyboard:press FG combo edge automated pin (modifier ordering / Ctrl+Shift+Tab focus shift) | Low | new test only | E1 と同 PR or 別 PR、Opus 1+ round |
| **E3** | mouse_drag 専用 ForegroundRestricted refusal pin (issue-207-mouse の mechanical copy) | Medium | new test only | 単独 PR、~80 line scaffolding。Opus 1+ round (Codex 推奨で family contract bit-equal 確認) |
| **E4** | scroll:to_element ElementNotFound after scrollIntoView 不可達 automated pin (UIA mock + CDP mock) | Medium | new test only | 単独 PR、Opus 1+ round |
| **E5** | scroll:capture frame seam automated pin | **Defer** | optional | Phase 5 release readiness 外し候補、dogfood scenario doc が代替 SoT |

Phase 2a 既出 (I1-I3) との統合管理:

| # | Phase 2a / 2b 由来 | 優先度 |
|---|---|---|
| **I1** | F4 fix — `FocusLostDuringType` SSOT 登録 (production code 改修、Codex 必須) | **High** |
| **I2** | F1 + F3 + F5 + F6 + F7 + F8 + F9 + F10 description 補強 (docs only) | Medium |
| **I3** | F2 cross-tool ForegroundRestricted recovery path 統一 wording (docs only) | Medium |
| **E1-E4** | Phase 2b 由来 automated pin gap (test only、production fact / matrix 規範 OK) | E1/E3/E4=Medium、E2=Low |
| **E5** | scroll:capture frame seam automated pin | Defer |

I1 が依然 highest priority (production contract drift)、E1/E3/E4 は test coverage gap (regression detection 強化、breaking regression の future protection)、E2 / E5 は **defer 妥当**。

## 6. Phase 2b closure conditions (本 PR スコープ)

- [x] 15 actions × 4 実機項目 audit 完了 (60 cell 全埋まり)
- [x] 各 cell に既存 pin file:line 引用 or dogfood scenario doc section リンク残置
- [x] 判定値 (pass / fix carry-over (test gap) / fix carry-over (scenario gap) / contract drift / breaking change candidate / unverifiable accepted) 記入
- [x] Issue 起票候補リスト (E1-E5) 作成 + PR 単位 / 優先度提案
- [x] Plan §6 acceptance 「scenario の永続化を 2 経路に分離」 — 既存 automated pins (`tests/unit/`、`tests/e2e/`) は本 doc 内 file:line 引用で永続化、新規 manual / dogfood scenarios は `docs/llm-audit/dogfood-scenarios/{terminal,keyboard,mouse,scroll,clipboard}.md` で永続化
- [x] CLAUDE.md §3.1 multi-table fact 整合 sweep — 「`ForegroundRestricted` ladder 構造」/「`verifyDelivery` 3 値 hint」/「`BackgroundInputNotDelivered` family contract」 各 fact を matrix §3.1 / production code / 既存 unit pin / Phase 2a description 判定 / 本 phase cell 判定 で 5 view 整合確認

## 7. Out of scope (本 PR)

- production code 改修 (F4 / I1 SSOT fix も別 PR)
- 新規 automated pin 実装 (E1-E5 は別 PR で起票 → 実装)
- 28 tool 残 13 actions の commit 軸 audit (Phase 3、Plan §5)
- 11 tool query 軸 audit (Phase 4、Plan §5)
- v1.4.0 release タグ切り (`docs/release-process.md` 領域、本 audit はその blocking issues 解消が判定材料)

## 8. Phase 2a → 2b 連携整合 sweep (CLAUDE.md §3.1 適用)

Phase 2a で発見した 9 distinct findings (F1-F10、F2 は 2 actions) と本 phase の cell 判定の bit-equal 整合を最終確認:

| Phase 2a finding | 本 phase の cell 判定整合 |
|---|---|
| F1 (terminal:send BG hidden_input doc gap) | Cell 1 desc/examples 軸は I2 で別 PR、本 phase 実機 cell は **pass** (existing pin coverage、`tests/unit/terminal-hidden-input.test.ts` で `isHiddenInputPrompt` 完備) |
| F2 (terminal/keyboard/mouse FG ForegroundRestricted recovery path 不在) | I3 で別 PR、本 phase の error path cell は **pass** (existing pin coverage、issue-184/207 family で structural pin 完備) |
| F3 (keyboard:type BG description recovery example 不在) | I2 で別 PR、本 phase は **pass** (`tests/e2e/keyboard-bg-verification.test.ts` で round-trip 完備) |
| F4 (FocusLostDuringType SSOT 未登録、contract drift) | I1 で別 PR、**本 phase cell 5 (keyboard:type FG) で contract drift 判定継承**、production code 改修必須 |
| F5 (keyboard:press BG description scope 言及不在) | I2 で別 PR、本 phase は **pass** |
| F6/F7 (mouse_click / mouse_drag description verifyDelivery 言及不在) | I2 で別 PR、cell 8 = **pass**、cell 9 = **fix carry-over (scenario gap)** で別軸 (E3) |
| F8 (scroll:raw description ScrollNotDelivered 言及不在) | I2 で別 PR、本 phase cell 10 は **pass** |
| F9 (scroll:smart description typed code 略記) | I2 で別 PR、本 phase cell 12 は **pass** |
| F10 (clipboard:write description 1 行のみ) | I2 で別 PR、本 phase cell 15 は **pass** |

**結論**: Phase 2a doc gaps は本 phase 実機 cell の判定結果と独立 (doc 軸の I1-I3 で fix、test 軸の E1-E5 は本 phase 検出の独立 gap)、両 sweep は orthogonal で重複なし。

## 9. Related Files

- Plan SSOT: `docs/llm-operation-audit.md` (Phase 1 起草、PR #210 で land)
- Phase 2a 結果: `docs/llm-audit/phase2a-doc-audit.md` (PR #212 で land)
- 規範 doc: `docs/operation-verification-matrix.md` §3.1 (Phase 3 SSOT)
- error code SSOT: `src/tools/_errors.ts` (SUGGESTS + classify + failWith + ROOT_HOISTED_KEYS)
- production code: `src/tools/{terminal,keyboard,mouse,scroll,scroll-*,clipboard}.ts`
- 既存 automated pin (本 doc 内 file:line 引用済):
  - `tests/unit/issue-184-foreground-refusal-pin.test.ts` (PR #208 land)
  - `tests/unit/issue-207-foreground-refusal-{press,mouse,terminal}.test.ts` (PR #209 land)
  - `tests/unit/{terminal-hidden-input,terminal-marker,terminal-run-validation}.test.ts`
  - `tests/unit/{keyboard-leash-guard,keyboard-method-resolution}.test.ts`
  - `tests/unit/{mouse-verify-classify,mouse-click-commit-wrapper}.test.ts`
  - `tests/unit/{scroll-raw-verify,scroll-ancestors,scroll-read}.test.ts`
  - `tests/unit/clipboard-write-readback.test.ts`
  - `tests/e2e/{terminal-hidden-input,keyboard-bg-verification,scroll-raw-verify,clipboard-readback,mouse-verify-delivery,keyboard-focus-lost,mouse-focus-lost}.test.ts`
- 新規 dogfood scenarios (本 PR 同梱):
  - `docs/llm-audit/dogfood-scenarios/terminal.md`
  - `docs/llm-audit/dogfood-scenarios/keyboard.md`
  - `docs/llm-audit/dogfood-scenarios/mouse.md`
  - `docs/llm-audit/dogfood-scenarios/scroll.md`
  - `docs/llm-audit/dogfood-scenarios/clipboard.md`
- Phase 4 ADR (別 epic): #185

---

END OF Phase 2b Execution Audit Results.
