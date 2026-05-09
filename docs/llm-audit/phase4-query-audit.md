# LLM Operation Audit — Phase 4 Query-Axis Sweep Results

- Status: **Phase 4 完了 (Tier 3 query 軸 doc + 实机 audit、88 cell)**
- Date: 2026-05-09
- Authors: Claude (Opus, max effort) — user (Harusame64) 主導
- Branch: `feature/llm-audit-phase4-query-sweep`
- Origin: epic #211 Phase 4、Plan SSOT `docs/llm-operation-audit.md` §5 Phase 4
- Predecessor: Phase 2a (`phase2a-doc-audit.md`、PR #212) / 2b (`phase2b-execution-audit.md`、PR #213) / 3a (`phase3a-doc-audit.md`、PR #214) / 3b (`phase3b-execution-audit.md`、PR #215)
- Scope: Tier 3 query 軸 11 tools × **(4 doc + 4 实机) = 8 columns** = **88 cell**

Plan §5 Phase 4 は query 軸を副作用なしと位置づけ、实机 4 項目を以下に置換:

- 正常 path → query 結果が schema 通りに返るか (`hints` / metadata 含む)
- error path → typed code (WindowNotFound / Timeout 等) emit
- edge case → 空結果 / 巨大結果 / Unicode / lensId scope
- chain → 結果が次 commit 軸 tool に正しく feed されるか

doc audit 4 項目 (description / SUGGESTS / classify / matrix row) は commit 軸と同一。本 phase は doc + 实机 を **一元 audit** で扱う (Tier 3 は副作用なし、cell 数 11×4=44 ずつでも 88 を 1 PR が密度的に妥当)。

---

## 1. Audit 対象 (matrix §3.2、L5 invariant 6 全 28 tool 不変原則)

| # | Tool | Tool registration file | matrix §3.2 row | typed codes 主要 |
|---|---|---|---|---|
| Q1 | `screenshot` | `src/tools/screenshot.ts` | §3.2 line 176 | (generic) |
| Q2 | `desktop_state` | `src/tools/desktop-state.ts` | §3.2 line 177 | (generic) |
| Q3 | `desktop_discover` | `src/tools/desktop-register.ts` | §3.2 line 178 | (none、`response.constraints` で structured warnings) |
| Q4 | `wait_until` | `src/tools/wait-until.ts` | §3.2 line 179 | `WaitTimeout`, `InvalidArgs` |
| Q5 | `clipboard:read` | `src/tools/clipboard.ts` (action=read) | §3.2 line 180 | (generic、read path、write path の `ClipboardWriteNotDelivered` は Phase 2a F10 / I2 で別 fix) |
| Q6 | `terminal:read` | `src/tools/terminal.ts` (action=read) | §3.2 line 181 | `TerminalWindowNotFound`, `TerminalTextPatternUnavailable`, `TerminalMarkerStale` (classify 経由) |
| Q7 | `server_status` | `src/tools/server-status.ts` | §3.2 line 182 | (none、diagnostic-only) |
| Q8 | `browser_overview` | `src/tools/browser.ts` | §3.2 line 183 | `BrowserNotConnected`, `ScopeNotFound` |
| Q9 | `browser_search` | `src/tools/browser.ts` | §3.2 line 184 | `BrowserSearchNoResults`, `BrowserSearchTimeout`, `BrowserNotConnected` |
| Q10 | `browser_locate` | `src/tools/browser.ts` | §3.2 line 185 | `BrowserNotConnected`, `ElementNotFound` |
| Q11 | `workspace_snapshot` | `src/tools/workspace.ts` | §3.2 line 186 | (generic) |

合計 11 tools。typed code 持つ tool 5 件 (Q4 / Q6 / Q8 / Q9 / Q10)、generic / structured-warning tool 6 件 (Q1 / Q2 / Q3 / Q5 / Q7 / Q11)。

## 2. 判定値 (Plan §4.3 整合)

- `pass` — contract bit-equal、SSOT 同期済 + automated pin coverage 完備
- `fix carry-over (doc gap)` — production fact は規範通りだが description / examples で LLM に伝わっていない
- `fix carry-over (test gap)` — 別 PR で automated pin 追加候補
- `fix carry-over (scenario gap)` — automated pin 困難、dogfood scenario doc で永続化
- `fix carry-over (contract drift)` — production fact ≠ matrix 規範で SSOT 同期不能
- `breaking change candidate` — fix が API contract 変更を要する

## 3. Audit cells (11 tools × 8 columns)

各 cell で **既存 pin file:line 引用** または **production code / matrix line cite**。`(gap: ...)` admission token は Phase 2b/3b と同形式で明示。

### 3.1 generic / structured-warning tools (6 tools — Q1/Q2/Q3/Q5/Q7/Q11)

doc 4 columns:

| # | Tool | desc/examples | SUGGESTS | classify | matrix row | doc 判定 |
|---|---|---|---|---|---|---|
| Q1 | screenshot | pass (5 detail levels + caveats 完備、token cost / dotByDot / region 説明完備) | N/A (no typed codes) | N/A | pass | **pass** |
| Q2 | desktop_state | pass (focusedElementSource 'view'/'uia'/'cdp' 区別、Chromium caveat 明示) | N/A | N/A | pass | **pass** |
| Q3 | desktop_discover | pass (`response.constraints` 詳細 + entityZeroReason 5 種 + recovery path 14 種、LLM-perspective で best-in-class) | N/A (uses `constraints`) | N/A | pass | **pass** |
| Q5 | clipboard:read | pass (description shared with write、action='read' returns empty for non-text caveat 明示、Phase 2a F10 の write 軸 description gap は I2 で別 fix、read 軸自体は generic で SSOT 整合) | N/A (read path emits no typed codes、write path の `ClipboardWriteNotDelivered` は Q5 query 軸 scope 外) | N/A | pass | **pass** |
| Q7 | server_status | pass (diagnostic-only、uia/imageDiff backend 状態の記述完備) | N/A | N/A | pass | **pass** |
| Q11 | workspace_snapshot | pass (thumbnail 説明 + diffMode reset 副作用明示 + ADR-010 §11 OQ carry-over 言及) | N/A | N/A | pass | **pass** |

实机 4 columns:

| # | Tool | 正常 path | error path | edge case | chain | 实机 判定 |
|---|---|---|---|---|---|---|
| Q1 | screenshot | `tests/unit/screenshot-ocr-path.test.ts` + `tests/unit/screenshot-som.test.ts` (OCR/SOM detail 経路 schema) | `tests/e2e/screenshot-electron.test.ts:77-` (custom-drawn UI fallback、generic ToolError catch) | `tests/unit/expansion-screenshot-wrapper.test.ts` (dispatcher schema wrapping) | `tests/e2e/tool-chain.test.ts` (screenshot → desktop_discover windowTitle resolution chain) | **pass** |
| Q2 | desktop_state | `tests/unit/desktop-state-focus-builder.test.ts:36-99` (ElementInfo shape bit-equal across view/UIA/CDP source) | `tests/unit/desktop-state-causal-include.test.ts` (include flag validation) | `tests/unit/desktop-state-envelope.test.ts:70-88` (envelope opt-in priority chain G3-1 to G3-8) | `tests/e2e/perception-mvp.test.ts` (desktop_state → attention signal → action recovery) | **pass** |
| Q3 | desktop_discover | `tests/unit/desktop-register.test.ts` (lease 生成 + entity 抽出 schema) | `tests/e2e/tool-chain.test.ts` (missing windowTitle recovery `no_provider_matched`) | `tests/unit/candidate-producer.test.ts` (UIA/CDP/terminal/visual provider composition) | `tests/e2e/tool-chain.test.ts` (desktop_discover lease → desktop_act lease 検証 chain) | **pass** |
| Q5 | clipboard:read | `tests/unit/clipboard-write-readback.test.ts` family-level shared (write+readback で read 経路 implicit cover、Get-Clipboard -Raw schema integrity) | (gap: read 経路 dedicated typed-error pin 不在 — non-text payload は empty string return が production fact、design constraint 由来) | `tests/e2e/clipboard-readback.test.ts` family-level shared (UTF-16LE byte-equal、surrogate pair preservation) | `tests/e2e/tool-chain.test.ts` (clipboard:read → 次 tool feed、e.g. browser_fill paste) | **pass** |
| Q7 | server_status | `tests/unit/expansion-server-status-wrapper.test.ts` (dispatcher schema wrapping) | (gap: error path automated pin 不在 — diagnostic-only、init failure は process-fatal で direct test 困難) | (gap: edge case 不在 — fixed response schema、空結果 / lensId scope は N/A) | (gap: chain なし — query-only diagnostic、downstream tool に feed しない) | **pass** (diagnostic-only design constraint 由来 gap、Phase 5 release readiness 判定外し候補) |
| Q11 | workspace_snapshot | `tests/e2e/workspace-chain.test.ts` (thumbnail 生成 + actionable[] shape 整合) | (gap: typed error 不在、generic exception only) | `tests/unit/expansion-workspace-snapshot-wrapper.test.ts` (diffMode baseline reset contract) | `tests/e2e/workspace-chain.test.ts` (workspace_snapshot → screenshot diffMode=true で P-frame detection chain) | **pass** |

### 3.2 typed-code tools (5 tools — Q4/Q6/Q8/Q9/Q10)

doc 4 columns:

| # | Tool | desc/examples | SUGGESTS | classify | matrix row | doc 判定 |
|---|---|---|---|---|---|---|
| Q4 | wait_until | partial (条件名 / target shape 詳細あり、`WaitTimeout error with suggest hints` mention あるが typed code shape direct 言及不在) | pass (`WaitTimeout` SUGGESTS at `_errors.ts:91-95`) | pass (line 332 keyword "wait timeout") | pass | fix carry-over (doc gap) — K1 |
| Q6 | terminal:read | gap (typed code 名 `TerminalWindowNotFound` / `TerminalTextPatternUnavailable` / `TerminalMarkerStale` direct 言及不在、source:'auto' OCR fallback は説明あり) | pass (3 typed codes 全 SUGGESTS at `_errors.ts:61-75`) | pass (classify at `_errors.ts:321/324/327`) | pass | fix carry-over (doc gap) — K2 |
| Q8 | browser_overview | gap (typed code 名 `BrowserNotConnected` / `ScopeNotFound` direct 言及不在) | pass (`_errors.ts:56-60` + `:87-90`) | pass (line 335 + 329) | pass | fix carry-over (doc gap) — K3 |
| Q9 | browser_search | gap (典型 typed code 名 `BrowserSearchNoResults` / `BrowserSearchTimeout` / `BrowserNotConnected` direct 言及不在) | pass (`_errors.ts:76-86`) | pass (line 335-336) | pass | fix carry-over (doc gap) — K4 |
| Q10 | browser_locate | partial (selector → coords 整合 + reflow caveat あり、typed code 名 `BrowserNotConnected` / `ElementNotFound` direct 言及不在) | pass (`_errors.ts:32-37` + 56-60) | pass (line 350 + 335) | pass | fix carry-over (doc gap) — K5 |

实机 4 columns:

| # | Tool | 正常 path | error path | edge case | chain | 实机 判定 |
|---|---|---|---|---|---|---|
| Q4 | wait_until | `tests/e2e/wait-until.test.ts:34-45` (WaitTimeout + suggest pinning) | `tests/e2e/wait-until.test.ts:51-87` (window_appears/disappears actual transitions) | `tests/unit/wait-until-url-matches.test.ts` (URL pattern regex + SPA route matching) | `tests/e2e/wait-until.test.ts` (wait_until 出力 → 次 action 判断 chain) | **pass** |
| Q6 | terminal:read | `tests/e2e/terminal.test.ts:33-120` (action:'run' + until:'pattern' integration、内部で read 経由) | `tests/unit/terminal-run-validation.test.ts` (until schema validation + completion reason enum) | `tests/e2e/terminal-hidden-input.test.ts` (password prompt hidden input、no echo detection) | `tests/unit/issue-196-terminal-run-quiet-detection.test.ts` (quiet mode detection vs premature completion 1500ms SLO) | **pass** |
| Q8 | browser_overview | `tests/e2e/browser-search.test.ts:71-98` (search-text integration + state field for toggles) | `tests/unit/expansion-browser-overview-wrapper.test.ts` (ScopeNotFound classification) | `tests/e2e/browser-search.test.ts:72-79` (confidence scoring + selector stability) | `tests/e2e/tool-chain.test.ts` (browser_overview scope → browser_click selector chain) | **pass** |
| Q9 | browser_search | `tests/e2e/browser-search.test.ts:71-98` (by:'text' exact match + caseSensitive toggle) | `tests/e2e/browser-search.test.ts:92-97` (BrowserSearchNoResults code + suggest) | `tests/e2e/browser-search.test.ts:100-140` (by:'regex' / 'role' / 'ariaLabel' coverage) | `tests/e2e/browser-search.test.ts:150-160` (scope + pagination offset/maxResults + confidence sorting) | **pass** |
| Q10 | browser_locate | `tests/unit/expansion-browser-locate-wrapper.test.ts` (coordinate return shape) | (gap: ElementNotFound dedicated pin 不在 — `tests/e2e/browser-search.test.ts` で family-level 共有) | `tests/e2e/browser-cdp.test.ts` (stale coordinate detection after reflow) | `tests/e2e/tool-chain.test.ts` (browser_locate → mouse_click coords feed chain) | **pass** |

### 3.3 集計

判定値の集計は **action-level** と **cell-level** を別々に提示 (Phase 2b/3b 同型 Lesson 4 numeric count sync 教訓適用)。

#### Action-level (11 tools × 2 軸 = 22 judgement)

doc 軸 11 件:
- `pass`: 6 件 — Q1 (screenshot) / Q2 (desktop_state) / Q3 (desktop_discover) / Q5 (clipboard:read) / Q7 (server_status) / Q11 (workspace_snapshot)
- `fix carry-over (doc gap)`: 5 件 — Q4 (K1 wait_until) / Q6 (K2 terminal:read) / Q8 (K3 browser_overview) / Q9 (K4 browser_search) / Q10 (K5 browser_locate)

实机 軸 11 件:
- `pass`: 11 件 (全 11 tools 实机軸 pass、scenario gap は cell-level admission として 5 cells のみ)

合計 22 judgement: **17 pass + 5 doc gap = 22**。0 contract drift / 0 breaking change candidate。

#### Cell-level (88 cells、`(gap: ...)` admission count)

- `file:line` 単位で automated pin 固定 + doc 4 cells で SUGGESTS/classify/matrix が pass: **82 cells**
- `(gap: ...)` 明示 admission cells: **6 cells**
  - cell Q5 error (1 cell、clipboard:read read-path dedicated typed-error pin 不在 — non-text payload で empty string return が production fact、design constraint 由来)
  - cell Q7 error / edge / chain (3 cells、server_status diagnostic-only design constraint 由来 — fixed response schema、init failure process-fatal、no downstream feed)
  - cell Q10 error (1 cell、browser_locate ElementNotFound dedicated pin 不在 — `tests/e2e/browser-search.test.ts` で family-level 共有可)
  - cell Q11 error (1 cell、workspace_snapshot generic exception のため typed error 不在 — design constraint 由来)

合計: 88 = 82 pinned + 6 admission。design constraint 由来 (diagnostic-only / generic exception / family-level shared / non-text payload empty return) で automated pin 化の cost-benefit 低、Phase 5 release readiness 判定外し候補 (E5 / H1 と同型 defer cluster K6)。

## 4. Findings 詳細 (issue 起票候補)

### K1 (Medium): wait_until description で WaitTimeout typed code shape direct 言及不在

- **matrix §3.2 line 179 規範**: query 軸 N/A 表のため verification 契約は構文的に不在。但し description で typed code は LLM が読み取る前提
- **production 実装事実**: `wait-until.ts` で `WaitTimeout` failWith、`_errors.ts:91-95` SUGGESTS 完備
- **description fact (`wait-until.ts:404-423`)**: 「Returns {ok:true, ...} on success, or WaitTimeout error with suggest hints」 — partial mention あり、`code:'WaitTimeout'` shape direct 言及不在
- **推奨 fix**: caveats を 2 行化「failure 時は `code:'WaitTimeout'` ok:false envelope、`suggest:[...]` array で `timeoutMs` 増加 / target 確認 / 中間 state 観測 (`screenshot(detail='meta')` または `desktop_state`) を提示」を追記

### K2 (Medium): terminal:read description で 3 typed codes 名 direct 言及不在

- **production 実装事実**: `terminal.ts:279` で generic `failWith("Terminal window not found: " + windowTitle)` (string error)、`terminal.ts:308` で direct `code:'TerminalTextPatternUnavailable'` emit。`TerminalWindowNotFound` / `TerminalMarkerStale` は `terminal.ts` 内 string error として emit、typed code 解決は `_errors.ts` の classify 経由 (lines 321 / 324 / 327)
- **SUGGESTS**: `_errors.ts:61-75` で 3 typed codes 全完備
- **classify**: `_errors.ts:321` (TerminalWindowNotFound) / `:324` (TerminalTextPatternUnavailable) / `:327` (TerminalMarkerStale) — substring 一致経由
- **description fact (`terminal.ts:1547-1569`)**: action='read' の説明で source:'auto' OCR fallback 言及あるが typed code 名 direct 言及不在
- **推奨 fix**: caveats を 3 行追加「action='read' で `code:'TerminalWindowNotFound'`/`'TerminalTextPatternUnavailable'`/`'TerminalMarkerStale'` のいずれかが ok:false envelope で返る、各 SUGGESTS で recovery path (`source:'ocr'` 強制 / sinceMarker omit / desktop_discover で title 確認) を提示」

### K3 (Medium): browser_overview description で BrowserNotConnected / ScopeNotFound 言及不在

- **production 実装事実**: `_errors.ts:56-60` + `:87-90` SUGGESTS 完備、classify line 335/329
- **description fact (`browser.ts:2637-2642`)**: scope subsection 説明 + state field caveats あるが typed code 名 direct 言及不在
- **推奨 fix**: caveats に「CDP 接続切断時 `code:'BrowserNotConnected'` (browser_open で auto-spawn or reconnect)、scope CSS selector 不一致時 `code:'ScopeNotFound'` (selector 確認 / scope omit で全 document 検索)」を追記

### K4 (Medium): browser_search description で 3 typed codes 名 direct 言及不在

- **production 実装事実**: `BrowserSearchNoResults` / `BrowserSearchTimeout` / `BrowserNotConnected` SUGGESTS at `_errors.ts:76-86` + 56-60、classify line 335-336
- **description fact (`browser.ts:2630-2635`)**: by axis enum + pagination 説明あり、typed code 名 direct 言及不在
- **推奨 fix**: caveats に「empty result は `code:'BrowserSearchNoResults'`、長 timeout は `code:'BrowserSearchTimeout'` (各 SUGGESTS で recovery path)」を追記

### K5 (Low): browser_locate description で BrowserNotConnected / ElementNotFound partial mention

- **production 実装事実**: `BrowserNotConnected` + `ElementNotFound` SUGGESTS 完備
- **description fact (`browser.ts:2655-2660`)**: reflow caveat あり、typed code 名 direct 言及不在 (browser_click 経由 prefer の説明はあり)
- **推奨 fix**: caveats に「element selector 不一致 `code:'ElementNotFound'`、CDP 切断 `code:'BrowserNotConnected'` (recovery path 同 G8/G12)」を追記

## 5. Issue 起票候補 (Phase 5 closure に向けて、Phase 2a/2b/3a/3b 統合管理)

| # | Source | Priority | Type |
|---|---|---|---|
| **I1** (Phase 2a F4) | `FocusLostDuringType` SSOT register | **High** | production code (Codex 必須) |
| **J1** (Phase 3a G1) | `notification_show` `hints.verifyDelivery` emit | **High** | production code (Codex 必須) |
| **I2** + **J2** + **K1-K5** | description 補強 (Phase 2a F1+F3+F5+F6+F7+F8+F9+F10 + Phase 3a G2+G3+G7+G8+G12 + Phase 4 K1-K5) | Medium | docs only |
| **I3** | Phase 2a F2 cross-tool ForegroundRestricted unified wording | Medium | docs only |
| **J4** (Phase 3a G13) | matrix §3.1 line 159/162 browser_click verifyDelivery status enum narrowing | Medium | docs only (matrix update) |
| **E1-E4** (Phase 2b) | automated-pin gap | Medium / Low | new test only |
| **J3** (Phase 3a G9+G11) | description minor enrichment | Low | docs only |
| **E5** (Phase 2b) | scroll:capture frame seam | **Defer** | optional |
| **H1** (Phase 3b) | design-constraint error path automated pin | **Defer** | optional |
| **K6** (Phase 4) | Q5/Q7/Q10/Q11 design-constraint cell-level (gap:) admission (clipboard:read / server_status / browser_locate / workspace_snapshot) | **Defer** | optional |

I1 + J1 が production contract drift で Phase 5 closure における highest priority。description 補強 (I2+J2+K1-K5) は 統合 1 PR で land 可、Medium priority。design-constraint defer (E5 + H1 + K6) は automated pin 化の cost-benefit が低く、dogfood scenario doc が代替 SoT。

## 6. Phase 4 closure conditions (本 PR スコープ)

- [x] 11 tools × 8 columns audit 完了 (88 cell 全埋まり)
- [x] doc 4 + 实机 4 columns 各 cell に判定値記入
- [x] 既存 pin file:line 引用 / production code line / matrix § 引用残置
- [x] Issue 起票候補リスト (K1-K5 doc gap + K6 defer) 作成 + Phase 2a/2b/3a/3b 統合管理表 (I1-J4 + E1-E5 + H1 + K1-K6)
- [x] Plan §6 acceptance 「scenario の永続化を 2 経路に分離」 — 既存 automated pins は本 doc 内 file:line 引用、6 cell の design-constraint admission は本 doc §3.3 cell-level 内訳で永続化 (新規 dogfood scenario 不要、E5/H1 と同型 defer)
- [x] CLAUDE.md §3.1 multi-table fact 整合 sweep — 各 fact を 5 view で bit-equal 確認:
  1. matrix §3.2 規範 (line 176-186)
  2. production code 実装事実 (`src/tools/{screenshot,desktop-state,desktop-register,wait-until,clipboard,terminal,server-status,browser,workspace}.ts`)
  3. 既存 automated unit / e2e pin (本 doc 内 file:line 引用)
  4. Phase 3a doc audit / Phase 3b execution audit 判定 (typed-code family inheritance)
  5. 本 phase doc + 实机 cell 判定

  確認した 3 fact:
  - 「query 軸 副作用 None / event_id 不発」 (L5 invariant 2 整合、本 phase 11 tools 全行で side-effect 不在)
  - 「typed-code family inheritance」 (Phase 3a で発見した browser_* family contract が Q8/Q9/Q10 で同型適用)
  - 「`(gap: ...)` design constraint admission family」 (E5 → H1 → K6 で 3 phase 連続 same pattern、Phase 5 release readiness 判定外し candidate cluster)

- [x] CLAUDE.md §3.2 carry-over scope-shrink check — K1-K6 carry-over は **既存 public API contract を破壊しない** (description / docs only or new test、production code 改修なし)

## 7. Out of scope (本 PR)

- production code 改修 (J1 / I1 production fix は Phase 5 closure 着手時、Codex 必須)
- description 補強実装 (I2+J2+K1-K5 統合 PR、Phase 5 着手時)
- 28 tool 全 audit 完了 — Phase 4 で 28/28 tool 全て audit 表に存在

## 8. Phase 2a/2b/3a/3b → 4 連携整合 sweep (CLAUDE.md §3.1 適用)

Phase 4 は Tier 3 query 軸として独立、過去 phase との独立性 sweep:

| Phase | Sweep type | Phase 4 cell 判定整合 |
|---|---|---|
| Phase 2a (F1-F10、9 distinct) | Tier 1 doc | 独立軸、commit/query 軸の SSOT 共有なし、I2 docs PR で別 fix |
| Phase 2b (E1-E5) | Tier 1 实机 | 同上、別 PR で test 追加 |
| Phase 3a (G1/G2/G3/G7/G8/G9/G11/G12/G13、9 distinct findings) | Tier 2 doc | **typed-code description-gap pattern repetition** (NOT direct inheritance): Phase 3a G7 (browser_click) / G8 (browser_eval) / G12 (browser_open) は Tier 2 commit-axis、Phase 4 K3 (browser_overview) / K4 (browser_search) / K5 (browser_locate) は Tier 3 query-axis で **別 tool** だが、「typed code 名を caveats に direct 明示しない」 same fix shape で I2+J2+K1-K5 統合 PR で one-shot 適用可能 |
| Phase 3b (H1) | Tier 2 实机 | H1 design constraint defer pattern が K6 (Q7/Q10/Q11 cell-level admission) と同型、defer cluster 整合 |

**結論**: Phase 4 は Phase 3a typed-code description-gap **pattern (fix shape)** を K3/K4/K5 で同型再発 (browser_* family の 6 tools 中 K3-K5 の 3 query-axis tool は Phase 3a G7/G8/G12 の 3 commit-axis tool と別 tool だが same fix shape)、Phase 3b design constraint pattern を K6 で受け継ぐ。新規 contract drift / breaking change candidate なし、production code 改修候補は **既出の I1 / J1 のみ** (Phase 4 で新規追加なし)。28 tool 全て audit 表に存在 (Phase 5 acceptance 整合)。

## 9. Related Files

- Plan SSOT: `docs/llm-operation-audit.md` (PR #210)
- Phase 2a/2b/3a/3b 結果: `phase{2a,2b,3a,3b}-*-audit.md`
- 規範 doc: `docs/operation-verification-matrix.md` §3.2 line 176-186
- error code SSOT: `src/tools/_errors.ts` (SUGGESTS + classify)
- production code: `src/tools/{screenshot,desktop-state,desktop-register,wait-until,clipboard,terminal,server-status,browser,workspace}.ts`
- 既存 automated pin (本 doc 内 file:line 引用済):
  - `tests/unit/{screenshot-ocr-path,screenshot-som,desktop-state-focus-builder,desktop-state-causal-include,desktop-state-envelope,desktop-register,candidate-producer,wait-until-url-matches,terminal-run-validation,issue-196-terminal-run-quiet-detection}.test.ts`
  - `tests/unit/expansion-{screenshot,server-status,workspace-snapshot,browser-overview,browser-locate}-wrapper.test.ts`
  - `tests/e2e/{screenshot-electron,perception-mvp,tool-chain,wait-until,terminal,terminal-hidden-input,clipboard-readback,browser-search,browser-cdp,workspace-chain}.test.ts`
- 本 phase 新規 dogfood scenario なし (5 design-constraint admission cells は K6 で defer cluster、E5/H1 と同型)
- Phase 4 ADR (別 epic): #185

---

END OF Phase 4 Query-Axis Audit Results.
