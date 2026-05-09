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
| 10 | `scroll:raw` | `src/tools/scroll.ts` (delivery 実装は `mouse.ts` の `evaluateScrollDelivery` — 本 audit doc 内 cross-ref、matrix §3.1 line 146 自体は `SendInput WHEEL_DELTA` のみ列挙) | 146 |
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
| 2 | terminal:send FG | (gap: terminal:send FG 専用 success path automated pin 不在 — direct success pin は handler 経路が異なる: terminal.ts は inline 5-retry + auto-escalate ladder、keyboard:type の `focusWindowForKeyboard` shared helper 代表 `tests/unit/issue-184-foreground-refusal-pin.test.ts:228-255` は **family-level structural reference のみ**で terminal handler を直接 exercise しない、`tests/unit/issue-207-foreground-refusal-terminal.test.ts:163-194` は force=true refusal scenario)、success path は `dogfood-scenarios/terminal.md` §1.8 で manual | `tests/unit/issue-207-foreground-refusal-terminal.test.ts:118-162` (5-retry default + AttachThreadInput escalate 共拒否、`mockEnum:8 calls`/`mockRestore:6 calls` で ladder 構造 pin) | (gap: `preferClipboard` 切替 / clipboard paste fallback の structural pin) — `docs/llm-audit/dogfood-scenarios/terminal.md` §1.2 で manual scenario 化 | (gap: marker chain to terminal:read after FG send) — terminal-marker pin は BG/FG 共有 helper のため structural 同等、dogfood scenario `terminal.md` §1.4 で chain 検証 | **fix carry-over (scenario gap)** — E1 (preferClipboard / clipboard paste edge automated pin) |
| 3 | terminal:run | `tests/unit/terminal-run-validation.test.ts:124-139` (valid options → `completion.reason='window_not_found'` shape pin) + e2e (manual: `dogfood-scenarios/terminal.md` §1.5) | `tests/unit/terminal-run-validation.test.ts:36-122` (6 InvalidArgs cases: chunkSize:0 / unknown keys / windowTitle override / method:'invalid' / lines:999_999 / source:'invalid') | `tests/unit/terminal-run-validation.test.ts:142-209` (Zod default-leak guard、empty regex `^$` / `''` truthiness gate)、`docs/llm-audit/dogfood-scenarios/terminal.md` §1.6 (until-mode pattern) | (gap: warnings 配列 send_failed nested code surface — code review confirmed via `terminal.ts` §3.1 規範、automated chain pin 不在) — dogfood scenario `terminal.md` §1.7 で manual chain | **pass** |

### 3.2 keyboard (4 actions)

| # | Action | 正常 path | error path | edge case | chain | 判定 |
|---|---|---|---|---|---|---|
| 4 | keyboard:type BG | `tests/e2e/keyboard-bg-verification.test.ts:60-183` (issue #177 verification: `BackgroundInputNotDelivered` round-trip + verifyDelivery hint、real Notepad PostMessage WM_CHAR) | `tests/e2e/keyboard-bg-verification.test.ts:60-183` (BG path silent-drop → `BackgroundInputNotDelivered` typed code) | `tests/unit/keyboard-method-resolution.test.ts:122-167` (auto-pick class allowlist: WT excluded #173 / ConsoleWindowClass allowed)、`tests/unit/keyboard-leash-guard.test.ts:320-359` (surrogate pair / emoji-heavy text、UTF-16 typed/remaining) | `tests/unit/keyboard-leash-guard.test.ts:280-318` (chunkSize 4 で 8-char text → 2 chunks、focus theft mid-stream → typed=4/remaining=`efgh` retry chain) | **pass** |
| 5 | keyboard:type FG | `tests/unit/issue-184-foreground-refusal-pin.test.ts:228-255` (success path: target reaches foreground after default → no early-return) | `tests/unit/issue-184-foreground-refusal-pin.test.ts:142-226` (default+force escalation refusal、forceFocus:true skip default ladder)、`tests/unit/keyboard-leash-guard.test.ts:263-298` (PR #218 / I1 land 後 SSOT envelope shape: `code:"FocusLostDuringType"` top-level + `suggest` top-level + `context.{typed,remaining,total,chunkSize,focusLost}` single-nest) | `tests/unit/keyboard-leash-guard.test.ts:171-209` (`getLeashChunkSize` env clamp [1,1024])、`tests/unit/keyboard-leash-guard.test.ts:382-444` (modifier release safety valve 6 calls on theft) | `tests/unit/keyboard-leash-guard.test.ts:280-359` (typed/remaining + surrogate pair retry chain、`tests/e2e/keyboard-focus-lost.test.ts:17-66` (focusLost FG E2E)) | **pass** (PR #218 land 後、F4 contract drift 解消) |
| 6 | keyboard:press BG | `tests/e2e/keyboard-bg-verification.test.ts:184-` (issue #177 verification: enter/tab/arrow → terminal-class read-back、その他 combo → `verifyDelivery:'unverifiable'`)、`tests/unit/keyboard-method-resolution.test.ts:74-103` (explicit method passthrough) | `tests/e2e/keyboard-bg-verification.test.ts:184-` (verification 失敗時 `BackgroundKeyNotDelivered`)、Phase 2a F5 (description で typed code 言及不在 doc gap、I2 issue 起票候補) | `tests/unit/keyboard-method-resolution.test.ts:169-213` (degraded inputs: 空 title / window not found / class throw / enum throw → `auto` graceful fall-through) | (gap: combo `ctrl+a` semantic verification — UIA SelectionPattern read 観測経路は matrix §3.1 line 142 規範のみ、automated pin 不在) — `docs/llm-audit/dogfood-scenarios/keyboard.md` §2.4 で manual scenario | **pass** (F5 doc gap は I2 で別 PR、test 軸は covered) |
| 7 | keyboard:press FG | `tests/unit/issue-207-foreground-refusal-press.test.ts:158-177` (success path: target reaches foreground after default) | `tests/unit/issue-207-foreground-refusal-press.test.ts:99-156` (default+force refusal + forceFocus:true skip default ladder) | (gap: combo specific edge — modifier ordering / Ctrl+Shift+Tab focus shift detection) — `docs/llm-audit/dogfood-scenarios/keyboard.md` §2.5 で manual | `tests/e2e/keyboard-focus-lost.test.ts:67-` (keyboard_press focusLost contract、retry chain は scenario `keyboard.md` §2.6) | **`fix carry-over (scenario gap)` → Defer** PR #226 (E2 combo edge: structural family が `issue-207-foreground-refusal-press` + `key-map.test.ts` で covered、追加 case は real Win32 dispatch 必要、E5/H1/K6 同型 defer cluster) |

### 3.3 mouse (2 actions)

| # | Action | 正常 path | error path | edge case | chain | 判定 |
|---|---|---|---|---|---|---|
| 8 | mouse_click | `tests/unit/mouse-verify-classify.test.ts:39-72` (delivered 5 case: elementAtPoint / focusedElement / verticalScrollPos / foregroundHwnd 各 transition) + `tests/e2e/mouse-verify-delivery.test.ts:25-133` (real verifyDelivery 3 値 round-trip) | `tests/unit/issue-207-foreground-refusal-mouse.test.ts:130-209` (homing block 早期 return、click suppress + `mockClick:not.toHaveBeenCalled` で誤クリック防止 contract pin)、`tests/unit/mouse-verify-classify.test.ts:75-93` (focus_only no-observable-change) | `tests/unit/mouse-verify-classify.test.ts:106-140` (volatile field ignored / null scrollPos guard) | `tests/unit/mouse-click-commit-wrapper.test.ts:40-124` (L1 ToolCallStarted/Completed event push、include=causal で `caused_by.your_last_action` chain) | **pass** |
| 9 | mouse_drag | `tests/e2e/mouse-verify-delivery.test.ts:134-` (verifyDelivery 3 値 hint emit) | (gap: `applyHoming` shared だが `mouse_drag` 専用 ForegroundRestricted refusal pin が #207 carry-over scope 外 — handler 経路は同 helper、structural pin は mouse_click 代表) — `dogfood-scenarios/mouse.md` §3.2 で manual scenario | (gap: drag bounds / mid-drag release / modifier-key state 検証) — `dogfood-scenarios/mouse.md` §3.3 | (gap: tab-drag heuristic `detectTabDragRisk` pre-gate と drag 自身の delivery hint chain) — `dogfood-scenarios/mouse.md` §3.4 | **fix carry-over (scenario gap)** — E3 (mouse_drag-specific ForegroundRestricted automated pin) |

### 3.4 scroll (5 actions)

| # | Action | 正常 path | error path | edge case | chain | 判定 |
|---|---|---|---|---|---|---|
| 10 | scroll:raw | `tests/unit/scroll-raw-verify.test.ts:23-60` (delivered + page-end 6 case)、`tests/e2e/scroll-raw-verify.test.ts:56-` (E2E real Notepad/Chrome scroll roundtrip) | `tests/unit/scroll-raw-verify.test.ts:61-100` (silent drop → `not_delivered` + axis pin)、`tests/unit/scroll-raw-verify.test.ts:120-127` (no-axis + no-hash → unverifiable scrollbar_unavailable) | `tests/unit/scroll-raw-verify.test.ts:95-118` (epsilon noise / image hash fallback / vertical-only window) | `tests/unit/scroll-raw-verify.test.ts:129-147` (delta numerics shape pin、次 tool への percent feed) | **pass** |
| 11 | scroll:to_element | (gap: scroll:to_element 専用 success path automated pin 不在 — entity_outside_viewport recovery は scroll:raw 経由代理 cite で `tests/e2e/scroll-raw-verify.test.ts` を参照可能だが、scroll:to_element handler を直接 exercise する pin は不在)、`dogfood-scenarios/scroll.md` §4.4 で manual chain 観測 | (gap: `ElementNotFound` after scrollIntoView 不可達 typed code pin) — `dogfood-scenarios/scroll.md` §4.2 で manual | (gap: viewport edge / scroll container nesting / iframe boundary) — `dogfood-scenarios/scroll.md` §4.3 | (gap: matrix §3.1 line 147「entity_outside_viewport 復帰の代理指標として既に厚い」を pin する scroll:to_element-direct chain pin は不在、現状維持判定) — `dogfood-scenarios/scroll.md` §4.4 manual | **fix carry-over (scenario gap)** — E4 (scroll:to_element ElementNotFound automated pin) |
| 12 | scroll:smart | `tests/unit/scroll-ancestors.test.ts:45-53` (selector-like detection + UIA name)、`tests/unit/scroll-ancestors.test.ts:131-167` (innermostPageRatio clamp / null guard) | `tests/unit/scroll-ancestors.test.ts:72-112` (hidden / virtualized / maxDepth filtering — `OverflowHiddenAncestor` / `VirtualScrollExhausted` typed code 算定 source。Phase 6 cleanup で `MaxDepthExceeded` は classify+SUGGESTS から削除済 — smart-scroll は `while (depth < MAXDEPTH)` で walking を止めるのみで failWith 経路を持たない) | `tests/unit/scroll-ancestors.test.ts:131-167` (innermostPageRatio clamp / verticalPercent 範囲外) | (gap: 多経路 strategy 切替 chain — CDP→UIA→image fallback structural pin) — `dogfood-scenarios/scroll.md` §4.5 manual | **pass** |
| 13 | scroll:capture | (gap: frame seam + sizeReduced flag automated pin) — `dogfood-scenarios/scroll.md` §4.6 で manual scenario (real Edge / VS Code 縦長 capture)、Phase 2a で description は **pass** 判定 | (gap: capture 失敗 / OOM / 巨大 viewport edge) — `dogfood-scenarios/scroll.md` §4.7 manual | (gap: HiDPI / 縦長 200+ row / Chrome native scroll) — `dogfood-scenarios/scroll.md` §4.8 manual | (gap: capture → screenshot → OCR chain) — `dogfood-scenarios/scroll.md` §4.9 manual | **fix carry-over (scenario gap)** — E5 (scroll:capture frame seam automated pin、ただし image diff 軸は実機 GUI 依存高、Phase 5 release readiness 判定外し候補) |
| 14 | scroll:read | `tests/unit/scroll-read.test.ts:223-282` (3-page stitching with dedup、`stoppedReason: max_pages`) | `tests/unit/scroll-read.test.ts:437-489` (no-hwnd → ok:false `Window not found`)、`tests/unit/scroll-read.test.ts:724-772` (OCR throw on page 1 / partial output preserved on later page throw) | `tests/unit/scroll-read.test.ts:42-47` (29-line overlap dedup、ArrowDown line-by-line regression)、`tests/unit/scroll-read.test.ts:54-104` (locale → OCR language) | `tests/unit/scroll-read.test.ts:284-335` (no_change stop after 2 streak → next tool へ pages/text feed)、`tests/unit/scroll-read.test.ts:491-541` (BG path → focus path fallback chain) | **pass** |

### 3.5 clipboard (1 action)

| # | Action | 正常 path | error path | edge case | chain | 判定 |
|---|---|---|---|---|---|---|
| 15 | clipboard:write | `tests/unit/clipboard-write-readback.test.ts:33-44` (failWith → `code:"ClipboardWriteNotDelivered"` SSOT pull)、`tests/e2e/clipboard-readback.test.ts:47-` (real PowerShell Set-Clipboard / Get-Clipboard byte-equal) | `tests/unit/clipboard-write-readback.test.ts:46-66` (SUGGESTS payload §5.2 keywords / BG code 衝突なし) | `tests/unit/clipboard-write-readback.test.ts:68-77` (lower-case spaced message variant `clipboard write not delivered: race detected` も classify) | (gap: clipboard:write → clipboard:read round-trip chain で UTF-16LE byte-equal full 検証) — `dogfood-scenarios/clipboard.md` §5.4 で manual scenario | **pass** |

### 3.6 集計

判定値の集計は **action-level** (Plan §4.3 規範) と **cell-level** (本 phase 60 cell の `file:line` pin 単位) を別々に提示する。Action-level 判定は overall scenario 結論、cell-level は `(gap: ...)` 明示 admission の累計で、両者は粒度が異なる (Lesson 4 numeric count sync 教訓、CLAUDE.md §3.1 適用)。

#### Action-level (15 actions、Plan §4.3 整合)

- `pass`: **10 actions** — 1 (terminal:send BG)、3 (terminal:run)、4 (keyboard:type BG)、5 (keyboard:type FG、PR #218 / I1 land 後 F4 contract drift 解消)、6 (keyboard:press BG)、8 (mouse_click)、10 (scroll:raw)、12 (scroll:smart)、14 (scroll:read)、15 (clipboard:write)
- **Phase 5 closure 後の actual carry-over status (Round 2 update)**:
  - `Resolved` (Phase 5 follow-up で land 済): **3 actions** — 2 (terminal:send FG = E1, **PR #224**)、9 (mouse_drag = E3, **PR #223**)、11 (scroll:to_element = E4, **PR #225**)
  - `Defer` (Phase 5 release readiness 判定外し、dogfood scenario doc が代替 SoT): **2 actions** — 7 (keyboard:press FG = E2, **PR #226**)、13 (scroll:capture = E5)
  - 注: 当初の audit 文言は 5 actions すべて `fix carry-over (scenario gap)` だったが、Phase 5 follow-up で E1/E3/E4 = Resolved (production silent-fail 発見 + fix を含む)、E2/E5 = Defer cluster 入り。
- `fix carry-over (contract drift)`: **0 actions** (Phase 2a F4 / Phase 5 I1 = PR #218 で解消、本 phase で carry-over なし)
- `breaking change candidate`: 0
- `unverifiable accepted`: 0

Phase 2a 由来の doc gap (F5/F6/F7 等) は **doc 軸 I2 で別 PR**、本 phase の cell 判定は実機 / pin 軸のため重複しない (§8 sweep 整合)。

#### Cell-level (60 cells、`(gap: ...)` admission count)

- `file:line` 単位で automated pin 固定 (`(gap:` admission なし): **41 cells**
- `(gap: ...)` 明示 admission (dogfood scenario doc で永続化、別 PR で pin 候補): **19 cells**

Cell-level 内訳 (`(gap: ...)` admission の所在):
- 行 cell 2 normal / edge / chain (3 cell、E1)
- 行 cell 3 chain (1 cell、warnings nested code chain — automated pin gap)
- 行 cell 6 chain (1 cell、combo unverifiable semantic — automated pin gap)
- 行 cell 7 edge (1 cell、E2)
- 行 cell 9 error / edge / chain (3 cell、E3)
- 行 cell 11 normal / error / edge / chain (4 cell、E4)
- 行 cell 12 chain (1 cell、多経路 strategy 切替 chain — automated pin gap)
- 行 cell 13 normal / error / edge / chain (4 cell、E5)
- 行 cell 15 chain (1 cell、UTF-16LE byte-equal full chain — automated pin gap)

Cell-level admission 19 cells のうち E1-E5 が **15 cell** (issue 起票候補)、残 4 cell (cell 3 chain / cell 6 chain / cell 12 chain / cell 15 chain) は pass-judged action 内の chain-only gap で、**Phase 5 release readiness 判定に影響しない degradation hint で代替** (matrix §1.3 北極星整合)。

`verifyDelivery` の degradation hint は production-side で既出済 — 本 phase で追加判定なし、cell-level admission は automated pin gap 軸のみ。

## 4. Findings 詳細 (issue 起票候補、Phase 2a I1-I3 と独立)

### E1: terminal:send FG path で `preferClipboard` 切替 / clipboard paste fallback の structural pin 不在 — **Round 2 訂正: 実態は production silent-fail bug + test gap (PR #224 で fix)**

- **production fact (audit 当初の認識)**: `terminal.ts` line 920+ で `preferClipboard:true` または unicode fallback 時に `typeViaClipboard` (clipboard:write + Ctrl+V) chain。失敗時は keystroke fallback
- **Round 2 訂正 (PR #224 起票時に発覚)**: production code を読み直すと、`typeViaClipboard` (`keyboard.ts:38-84`) は clipboard:write を呼ばず `Set-Clipboard` PowerShell を直接叩いていた、かつ Get-Clipboard read-back verification が無いため DLP / clipboard manager intercept で Set-Clipboard が抑止されても sliently 旧 clipboard 内容を paste していた (silent paste of wrong text into target window)。これは PR #180 が `clipboard:write` (`clipboard.ts:60-118`) に Set+Get-Raw 一括 verify + `ClipboardWriteNotDelivered` emit を追加した時、同じ "clipboard chain" を使う `typeViaClipboard` を抜かしていた **silent-fail family inheritance miss** であり、Phase 5 北極星 (silent-success / contract drift 0 件) に違反する。北極星整合のため PR #224 で production fix + test pin を 1 PR に同梱。
- **production fix (PR #224、`keyboard.ts:38-100`)**: `clipboard.ts:60-118` と同じ pattern に揃え、Set-Clipboard + Get-Clipboard -Raw を 1 PowerShell invocation に combine、UTF-16LE byte-equal 比較、mismatch 時は `throw new Error("ClipboardWriteNotDelivered")` で auto-classify (`_errors.ts:397-398`) → `terminal:send` の catch 経由で top-level `code:'ClipboardWriteNotDelivered'` envelope。
- **test pin (PR #224、~150 line)**: `tests/unit/issue-211-typeviaclipboard-readback-pin.test.ts` で 3 case pin (mismatched read-back / empty read-back / matching read-back の paste dispatch)。`vi.hoisted()` + `util.promisify.custom` で `node:child_process` execFile を unit-mockable な層で抑える。
- **scenario 永続化**: `dogfood-scenarios/terminal.md` §1.2 (real PowerShell + DLP / clipboard manager intercept で typed code 観測)
- **教訓**: cross-tool 修正 PR (PR #180 のような unify 系) は family inheritance check (typeViaClipboard が clipboard:write と同じ "clipboard chain" を共有しても、関数本体内の verification 経路は別途追加必要) を必ず行う。本 audit Phase 2b §3 E1 の「production fact」記述 (typeViaClipboard が clipboard:write を呼ぶと assume) が誤読、E3 (mouse_drag) と並ぶ family inheritance miss pattern の 2 件目。Phase 5 closure で再発見できたのは Phase 5 audit の収穫 (Lesson 4 numeric count sync の cross-tool family 軸版、E3 と同型)。

### E2: keyboard:press FG combo edge (modifier ordering / Ctrl+Shift+Tab focus shift) automated pin 不在 — **Phase 5 final: defer 確定 (PR #226 で epic comment 化)**

**Defer 妥当性確認 (PR #226、Phase 5 final)**: 既存 pin 2 file で **structural family は coverage 完備**:
- `tests/unit/issue-207-foreground-refusal-press.test.ts` — keyboard:press FG refusal contract (3 cases、`focusWindowForKeyboard` shared helper)
- `tests/unit/key-map.test.ts` — `parseKeys()` modifier ordering / aliases / error handling (canonical combos / case-insensitivity / duplicate modifiers / unknown tokens)

E2 が想定する追加 case (Ctrl+Shift+Tab focus shift / Win+Tab task view 起動 → ForegroundRestricted) は **real Win32 input dispatch + foreground state 観測が必要**で unit-mockable な structural value は限定的。dogfood scenario doc `dogfood-scenarios/keyboard.md` §2.5 が代替 SoT、Phase 5 release readiness 判定外し妥当。E5 (scroll:capture frame seam) と同型の defer cluster 入り。

**以下、audit 当初 (Phase 2b 起票時、PR #226 land 前) の framing — Phase 5 final で defer に上書き済**:

- **production fact**: `keyboard.ts` line 1227 で `BackgroundKeyNotDelivered`、FG path は terminal:send FG / keyboard:type FG と同型 contract
- **test pin 状況**: `issue-207-foreground-refusal-press.test.ts` は単 combo `ctrl+n` で focus refusal の構造のみ pin、modifier ordering / focus shift detection は未 pin
- **scenario 永続化**: `dogfood-scenarios/keyboard.md` §2.5 (Ctrl+Shift+Tab で foreground swap、Win+Tab で task view 起動 → ForegroundRestricted)
- **当初の推奨 fix (PR #226 で Defer に上書き)**: ~~separate PR で `tests/integration/llm-audit/keyboard-press-fg-combo-edge.test.ts` 起票、優先度 Low (既存 single-combo pin で structural family は covered)~~ — Phase 5 final defer 判断: 既存 pin 2 file で structural family covered + real Win32 dispatch 必要で unit-mockable value 限定的、defer cluster 入り。

### E3: mouse_drag 専用 ForegroundRestricted automated pin 不在 — **Round 2 訂正: 実態は production silent-fail bug + test gap (PR #223 で fix)**

- **production fact (audit 当初の認識)**: `mouse.ts` line 815-829 で `mouse_drag` は `applyHoming` 共用 (mouse_click と同 helper)、`detectTabDragRisk` で pre-gate
- **Round 2 訂正 (PR #223 起票時に発覚)**: production code を読み直すと、`mouseClickHandler` (mouse.ts:502-531) は `applyHoming` が notes に push する `ForceFocusRefused` を検知して `ForegroundRestricted` early-return する一方、`mouseDragHandler` (mouse.ts:683 以下) には同等の early-return が存在しなかった。これは PR #202 / #206 の修正 (keyboard / mouse / terminal の foreground-refusal 統一) が `mouse_click` のみ対象で `mouse_drag` を抜けていた **silent-fail regression** であり、本来 Phase 5 の北極星 (silent-success / contract drift 0 件) に違反する。北極星整合のため PR #223 で production fix + test pin を 1 PR に同梱。
- **test pin 状況**: `issue-207-foreground-refusal-mouse.test.ts` (mouse_click) と同型の pin が `tests/unit/issue-207-foreground-refusal-mouse-drag.test.ts` で確立 (PR #223、~150 line)
- **scenario 永続化**: `dogfood-scenarios/mouse.md` §3.2 (real drag-and-drop 操作で foreground refusal、誤 drag 防止 contract)
- **教訓**: cross-tool 修正 PR (PR #202/#206 のような統一系) は family inheritance check (mouse_drag が mouse_click と同 helper を共有しても、handler 内の早期 return は別途必要) を必ず行う。本 audit Phase 2b §3 E3 が「test only」と分類したのは family inheritance を assume した結果で、実際は production producer 側の差異を見落としていた。Phase 5 closure で再発見できたのは Phase 5 audit の収穫 (Lesson 4 numeric count sync の cross-tool family 軸版)。

### E4: scroll:to_element `ElementNotFound` automated pin 不在 — **Resolved PR #225** (test only、production fact 一致)

- **production fact (Round 2 訂正)**: `scroll-to-element.ts` で `ElementNotFound` typed code が emit されるのは **(a) CDP path で `document.querySelector(selector)` が null** (line 65 → 74 failWith)、または **(b) UIA path で UIA tree walk が match しない** (uia-bridge.ts:1368 → scroll-to-element.ts:88 failWith)。両 case とも `_errors.ts:361-362` classify で `code:'ElementNotFound'` 解決。「element 存在で `scrollIntoView` 後 viewport 内に入らない」 case は CDP path で `ok:true` + viewportTop/Bottom 返却 (line 76-77、out-of-viewport coords 自体は failure ではない)、UIA path で `{ok:true, scrolled:false}` 返却 (uia-bridge.ts:1374-1375、ScrollItemPattern unsupported degradation hint) であり、`ElementNotFound` typed code は emit しない。当初の audit 文言「scrollIntoView 後 element bounds が visible viewport 内に入らなければ ElementNotFound emit」は production と乖離 — Round 2 で訂正。
- **test pin 状況**: `tests/unit/scroll-ancestors.test.ts` は smart 経路 ancestor 軸のみ、to_element 経路の typed code pin が不在
- **scenario 永続化**: `dogfood-scenarios/scroll.md` §4.2 (Chrome iframe boundary / virtualised list で scrollIntoView 不可達)
- **推奨 fix**: separate PR で `tests/integration/llm-audit/scroll-to-element-not-found.test.ts` 起票 (UIA mock + CDP mock で 不可達 scenario の typed code shape pin)、優先度 Medium

### E5: scroll:capture frame seam automated pin 不在 (image diff 軸)

- **production fact**: `scroll-capture.ts` で page seam + `sizeReduced` flag を degradation hint として返却 (Phase 2a description は pass)
- **test pin 状況**: image diff 軸は GUI 実機依存度が高く mockable 範囲が狭い、現状 unit pin 不在
- **scenario 永続化**: `dogfood-scenarios/scroll.md` §4.6-4.9 (real Edge / VS Code / Chrome HiDPI で 縦長 capture chain)
- **推奨 fix**: **Phase 5 release readiness 判定の外し候補**。image diff 軸は v1.4.0 時点で `unverifiable accepted` を hint で表現済 (matrix §3.1 line 149「frame seam + sizeReduced flag で degradation 表現」現状維持)、automated pin 化の cost-benefit が低い。dogfood scenario doc を以後の audit reference として固定し、breaking regression の発見時に initiate

## 5. Issue 起票候補 (Phase 5 closure に向けて、Phase 2a I1-I3 と統合管理)

優先度の意味: **High** = production contract drift で fix が SSOT 整合に必須 / **Medium** = test coverage gap で regression detection 強化 / **Low** = edge case pin で marginal coverage gain / **Defer** = automated pin 化の cost-benefit が低く dogfood scenario doc が代替 SoT。

| # | 内容 | 優先度 | 性質 | 推奨 PR 単位 |
|---|---|---|---|---|
| **E1** | terminal:send FG path typeViaClipboard read-back verification — **Round 2 訂正: production silent-fail bug + test pin (PR #224 で resolved)**、PR #180 が clipboard:write のみ修正で typeViaClipboard を抜かしていた family inheritance miss | **High** (北極星違反) → **Resolved** PR #224 | production code 改修 (keyboard.ts typeViaClipboard に Set+Get-Raw verify + ClipboardWriteNotDelivered emit) + new test (vi.hoisted() + util.promisify.custom mock) | 単独 PR、Opus 1+ round (Codex usage limit 時 Opus 単独 land 可) |
| **E2** | keyboard:press FG combo edge automated pin (modifier ordering / Ctrl+Shift+Tab focus shift) — **Phase 5 final: defer 確定 PR #226** (既存 issue-207-press FG refusal pin + key-map.test.ts parseKeys pin で structural family covered、追加 case は real Win32 input dispatch 必要で unit-mockable value 限定的、dogfood scenario doc §2.5 が代替 SoT) | Low → **Defer** PR #226 (E5/H1/K6 同型 defer cluster 入り) | new test only | epic #211 closure comment で defer 表明 |
| **E3** | mouse_drag 専用 ForegroundRestricted refusal — **Round 2 訂正: production silent-fail bug + test pin (PR #223 で resolved)**、PR #202/#206 が mouse_click のみ修正で mouse_drag を抜かしていた family inheritance miss | **High** (北極星違反) → **Resolved** PR #223 | production code 改修 + new test (issue-207-mouse の mechanical copy + early return 追加) | 単独 PR、Opus 2+ round (Codex 推奨だが usage limit 時 Opus 単独 land 可) |
| **E4** | scroll:to_element ElementNotFound automated pin (UIA mock + CDP mock) — **Resolved PR #225** (test only、production already emits ElementNotFound via classify line 361-362、E1/E3 同型 family inheritance miss なし) | Medium → **Resolved** PR #225 | new test only | 単独 PR、Opus 1+ round |
| **E5** | scroll:capture frame seam automated pin | **Defer** | optional | Phase 5 release readiness 外し候補、dogfood scenario doc が代替 SoT |

Phase 2a 既出 (I1-I3) との統合管理:

| # | Phase 2a / 2b 由来 | 優先度 |
|---|---|---|
| **I1** | F4 fix — `FocusLostDuringType` SSOT 登録 (production code 改修、Codex 必須) — **Resolved (PR #218 land 後)** | High → **Resolved** |
| **I2** | F1 + F3 + F5 + F6 + F7 + F8 + F9 + F10 description 補強 (docs only) | Medium |
| **I3** | F2 cross-tool ForegroundRestricted recovery path 統一 wording (docs only) | Medium |
| **E1-E4** | Phase 2b 由来 automated pin gap (test only、production fact / matrix 規範 OK) | E1/E3/E4=Medium、E2=Low |
| **E5** | scroll:capture frame seam automated pin | Defer |

I1 は **PR #218 で resolved** (Phase 5 closure 進捗)、E1/E3/E4 は test coverage gap (regression detection 強化、breaking regression の future protection)、E2 / E5 は **defer 妥当**。

## 6. Phase 2b closure conditions (本 PR スコープ)

- [x] 15 actions × 4 実機項目 audit 完了 (60 cell 全埋まり)
- [x] 各 cell に既存 pin file:line 引用 or dogfood scenario doc section リンク残置
- [x] 判定値 (pass / fix carry-over (test gap) / fix carry-over (scenario gap) / contract drift / breaking change candidate / unverifiable accepted) 記入
- [x] Issue 起票候補リスト (E1-E5) 作成 + PR 単位 / 優先度提案
- [x] Plan §6 acceptance 「scenario の永続化を 2 経路に分離」 — 既存 automated pins (`tests/unit/`、`tests/e2e/`) は本 doc 内 file:line 引用で永続化、新規 manual / dogfood scenarios は `docs/llm-audit/dogfood-scenarios/{terminal,keyboard,mouse,scroll,clipboard}.md` で永続化
- [x] CLAUDE.md §3.1 multi-table fact 整合 sweep — 各 fact を 5 view で bit-equal 確認:
  1. **matrix §3.1 規範** (`docs/operation-verification-matrix.md` line 137-151)
  2. **production code 実装事実** (`src/tools/{terminal,keyboard,mouse,scroll,scroll-*,clipboard}.ts`)
  3. **既存 automated unit / e2e pin** (本 doc 内 file:line 引用)
  4. **Phase 2a doc audit 判定** (`docs/llm-audit/phase2a-doc-audit.md` §2.1-2.5)
  5. **本 phase cell 判定** (本 doc §3.1-3.5 cell)

  確認した 3 fact:
  - 「`ForegroundRestricted` ladder 構造」 (default + force escalate / 5-retry / focus refusal early-return)
  - 「`verifyDelivery` 3 値 hint」 (`delivered` / `focus_only` / `unverifiable`)
  - 「`BackgroundInputNotDelivered` family contract」 (terminal:send BG / keyboard:type BG 共有 silent-drop fail mode)

## 7. Out of scope (本 PR)

- production code 改修 (F4 / I1 SSOT fix は **PR #218 (本 phase 後の closure PR) で resolved**、本 phase 自身は docs only)
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
| F4 (FocusLostDuringType SSOT 未登録、contract drift) | I1 = **PR #218 で resolved (Phase 5 closure)**、本 phase cell 5 (keyboard:type FG) は PR #218 land 後 **pass 判定継承** |
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
