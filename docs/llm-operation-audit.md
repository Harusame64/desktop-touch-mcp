# LLM Operation Audit — 29 tool LLM-perspective 総点検

- Status: **Draft (Phase 1 起草、user 合意待ち)**
- Date: 2026-05-09
- Authors: Claude (Opus, max effort) — user (Harusame64) 主導の企画
- Origin: 1.3 版で silent-success / regression / contract drift が複数発見された反省 (PR #173 / #196 / #202 等)。LLM agent (Claude Code 等) が tool を呼ぶ実環境視点で **動作 + 文書 contract** を 29 tool 全件総点検し、漏れを潰す
- Related:
  - 規範 doc: `docs/operation-verification-matrix.md` (Phase 3 SSOT、本 audit のリファレンス)
  - 親 issue: 本 plan に対応する new issue (本 doc land 後に起票)
  - 過去 audit: PR #186-#194 (Phase 3 child issues、tool 別 verification)、PR #208 (Phase 3 closure audit)

---

## 1. Goal

LLM agent (Claude Code、Claude Desktop 等) が **実環境で 29 tool を呼んだとき、tool description / examples / matrix doc 規範通りに動作するか** を機械検証 + LLM 視点 doc audit のハイブリッドで網羅確認する。1.3 版で複数発見された下記 failure mode を 0 件に追い込む:

| Failure mode | 1.3 版での例 |
|---|---|
| Silent-success | terminal BG path WT silent drop (#173) |
| Contract drift | matrix §3.1 doc と production code fact ズレ (#208 audit で 3 件発見) |
| Schema reject (LLM serialiser) | terminal `until` JSON-string reject (#196) |
| Foreground refusal silent regression | `ok:true + warning` で keystroke 誤窓 landing (#202) |
| Test residue | WT graceful kill 不在で WT window 累積 (#204) |

## 2. Scope

ハイブリッド audit:

- **実機 scenario** (LLM-perspective integration test): Claude agent が 29 tool を順次呼び、正常 path / error path / edge case / chain (tool 結果が次 tool に feed される) を実機検証
- **Doc audit** (LLM-perspective): tool description / examples / suggest dictionary / classify pattern / matrix doc 各行を LLM 視点で「これ見て tool を正しく使えるか」観点で audit、fact 整合 + 不足を発見

実機と doc を交互に。実機で発見した違和感を doc に書き起こすか production を直すか判断、doc audit で不明な箇所を実機で trial で確認。

## 3. Tool list (L5 全 29 tool — commit 軸 29 行 + query 軸 11 tool; +1 each from ADR-015 `excel` carve-out)

数え方の単位は `docs/operation-verification-matrix.md` §1.4 に整合: L5 MCP Tool Surface (`docs/layer-constraints.md` §6.3 invariant 6) は **29 tool 不変**、本書もその数を継承。**commit 軸**は action 別に行を立てて **28 行** (matrix §3.1 と一致)、**query 軸**は **11 tool** (matrix §3.2 と一致)。同じ tool が両軸に出る場合あり (例: `terminal:send/run` は commit 軸、`terminal:read` は query 軸)。

### 3.1 Commit 軸 (副作用あり、action 別 28 行、matrix §3.1 と bit-equal)

`scroll:read` は OCR を伴うが scroll wheel emit が副作用 (matrix §3.1 line 150 で commit 軸 Indirect 配置) のため本表に列挙。`terminal:read` / `clipboard:read` は副作用なしのため §3.2 query 軸に集約。

| # | Tool:Action | API レイヤ | matrix §3.1 row | 1.3 版 issue 履歴 |
|---|---|---|---|---|
| 1 | `terminal:send` BG | PostMessage WM_CHAR | 137 | #173 #196 #204 |
| 2 | `terminal:send` FG | SetForegroundWindow + SendInput / clipboard paste | 138 | #202 |
| 3 | `terminal:run` | send → wait → read 合成 | 139 | #196 |
| 4 | `keyboard:type` BG | PostMessage WM_CHAR | 140 | #177 #195 #198 |
| 5 | `keyboard:type` FG | SendInput | 141 | #202 |
| 6 | `keyboard:press` BG | PostMessage WM_KEYDOWN/UP | 142 | #177 |
| 7 | `keyboard:press` FG | SendInput VK_* | 143 | #202 |
| 8 | `mouse_click` | SendInput MOUSEEVENTF_LEFTDOWN/UP | 144 | #178 #202 |
| 9 | `mouse_drag` | SendInput sequence | 145 | #178 |
| 10 | `scroll:raw` | SendInput WHEEL_DELTA | 146 | #179 |
| 11 | `scroll:to_element` | UIA ScrollItemPattern + CDP scrollIntoView | 147 | partial |
| 12 | `scroll:smart` | 多経路 (CDP / UIA / image) | 148 | partial |
| 13 | `scroll:capture` | screenshot loop + scroll | 149 | partial |
| 14 | `scroll:read` | scroll + OCR (`stopWhenNoChange` 観測) | 150 | partial |
| 15 | `clipboard:write` | Set-Clipboard (PowerShell ラッパ) | 151 | #180 |
| 16 | `focus_window` | SetForegroundWindow + AttachThreadInput auto-escalate | 152 | #197 #202 |
| 17 | `desktop_act` | UIA InvokePattern / TogglePattern / setValue | 153 | partial |
| 18 | `click_element` | UIA InvokePattern + mouse_click fallback | 154 | partial |
| 19 | `window_dock` | SetWindowPos + WM_SIZE | 155 | partial |
| 20 | `workspace_launch` | start exe + wait_until | 156 | partial |
| 21 | `run_macro` | tool sequence 合成 (per-step verification 継承) | 157 | partial |
| 22 | `notification_show` | Win32 toast (Unverifiable 規範) | 158 | none |
| 23 | `browser_click` | CDP Runtime.evaluate で click() dispatch | 159 | #181 |
| 24 | `browser_eval` | CDP Runtime.evaluate | 160 | none |
| 25 | `browser_navigate` | CDP Page.navigate | 161 | partial |
| 26 | `browser_fill` | CDP Input.dispatchKeyEvent + value set | 162 | #181 |
| 27 | `browser_form` | fill + submit composite | 163 | partial |
| 28 | `browser_open` | CDP target attach + tab list | 164 | partial |

合計 **commit 軸 29 actions / 18 unique tool**。action 別 breakdown: `terminal` 3 + `keyboard` 4 + `mouse_click` 1 + `mouse_drag` 1 + `scroll` 5 + `clipboard:write` 1 + `focus_window` 1 + `desktop_act` 1 + `click_element` 1 + `window_dock` 1 + `workspace_launch` 1 + `run_macro` 1 + `notification_show` 1 + `browser_*` 6 + `excel:run_vba` 1 = **29 actions**。matrix doc §3.1 line 137-164 と bit-equal (`excel` adds 1 commit-axis action per ADR-015 §4.4; `excel:check_access_vbom` is per-action query-axis)。

### 3.2 Query 軸 (副作用なし、verification N/A、11 tool)

| Tool | 副作用 |
|---|---|
| `screenshot` | none |
| `desktop_state` | none |
| `desktop_discover` | none (lease 発行は L4 内部) |
| `wait_until` | none (polling 観測のみ) |
| `clipboard:read` | none (commit 軸 `clipboard:write` と同 tool 名、別 action) |
| `terminal:read` | none (commit 軸 `terminal:send/run` と同 tool 名、別 action) |
| `server_status` | none |
| `browser_overview` | none |
| `browser_search` | none |
| `browser_locate` | none |
| `workspace_snapshot` | none |

L5 全 29 tool (28 baseline + 1 ADR-015 `excel` carve-out per `docs/layer-constraints.md` §6.3 Note) と整合。 commit 軸 29 actions (= 18 unique tool) + query 軸 11 tool。注: `clipboard` `terminal` `scroll` `excel` は action 別に commit 軸 / query 軸 の両方に登場 (例: `clipboard:write` は commit、`clipboard:read` は query; `excel:run_vba` は commit、`excel:check_access_vbom` は query)。

## 4. Audit template per tool

各 tool について以下 **8 項目** (実機 4 + doc 4) を埋める。実機 + doc 交互。

### 4.1 実機 scenario (4 項目)

- **正常 path**: 仕様通りに呼んで `ok:true` が返るか、`hints` が contract 通り埋まっているか
- **error path**: WindowNotFound / InvalidArgs / Timeout 等の typed error が返るか、`suggest[]` が actionable か
- **edge case**: 境界条件 (空文字 / 巨大 input / Unicode / 多重呼び出し / 並走)
- **chain scenario**: 結果が次 tool に feed されるか (`marker` で sinceMarker、`hwnd` で focus_window 等)

### 4.2 Doc audit (4 項目)

- **description / examples**: LLM がこれを見て正しく使えるか (引数 / 戻り値 / 失敗時 contract が読み取れる)
- **suggest dictionary** (`_errors.ts:SUGGESTS`): 各 typed error の suggest が actionable か、recovery path 言及済か
- **classify() pattern** (`_errors.ts:classify()`): error message → typed code 変換が落とし穴なく動くか (本 tool が emit する error message を classify が正しく code に解決するか)
- **matrix doc row** (§3.1 / §3.2): production code と bit-equal か (PR #208 同型 audit を全 tool で適用)

### 4.3 出力

各 tool の audit 結果を表に整理 (実機 4 + doc 4 = 8 列):

| Tool | 正常 | error | edge | chain | desc/examples | suggest | classify | matrix | 判定 |
|---|---|---|---|---|---|---|---|---|---|

判定値:
- `pass` — contract bit-equal、scenario green、漏れなし
- `unverifiable accepted` — `verifyDelivery: focus_only / unverifiable` 等の hint で degradation を **明示的** に表現済 (matrix §1.3 北極星整合)。silent ok:true は **不可**、明示済のみ
- `fix carry-over` — 不整合検出、新 issue 起票 → 別 PR で fix
- `breaking change candidate` — fix が API contract 変更を要する、v1.4 系の release plan で扱う案件

## 5. Phase 分割

Audit scope (commit 軸 29 actions × 8 項目 = 232 item + query 軸 11 tool × 4 doc 項目 = 44 item、合計 **276 item**) のため Phase 分割:

### Phase 1: Plan + template land (本 doc)
本 doc を `docs/llm-operation-audit.md` に永続化、user 合意で epic issue 起票。

### Phase 2: Tier 1 commit 軸 (過去 issue 多発 tool 優先)

合計 **15 actions** (commit 軸 29 actions の過半):
- `terminal:send` BG / `terminal:send` FG / `terminal:run` (3 actions、#173 #196 #202 #204)
- `keyboard:type` BG / `keyboard:type` FG / `keyboard:press` BG / `keyboard:press` FG (4 actions、#177 #195 #198 #202)
- `mouse_click` / `mouse_drag` (2 actions、#178 #202)
- `scroll:raw` / `scroll:to_element` / `scroll:smart` / `scroll:capture` / `scroll:read` (5 actions、#179)
- `clipboard:write` (1 action、#180)

User 方針 (epic #211 着手時 2026-05-09 確認): doc audit 先行で 2 sub-phase に分割、検出した不整合を新 issue 起票。

#### Phase 2a: Doc audit 机上 sweep (15 actions × 4 doc 項目 = 60 cell)

description / examples / SUGGESTS dictionary / classify pattern / matrix doc row の bit-equal sweep。production fact と doc の差分検出、contract drift 候補を Phase 5 issue 起票候補としてリストアップ。結果を `docs/llm-audit/phase2a-doc-audit.md` に永続化。

#### Phase 2b: 実機 scenario audit (15 actions × 4 実機項目 = 60 cell、別 session)

正常 path / error path / edge case / chain scenario を実機検証。Plan §6 acceptance に従い:
- automated regression pins → `tests/integration/llm-audit/` or `tests/unit/`
- manual / dogfood scenarios → `docs/llm-audit/dogfood-scenarios/`

### Phase 3: Tier 2 commit 軸 (別 session、残 13 actions)

- `focus_window` / `desktop_act` / `click_element` / `window_dock` / `workspace_launch` / `run_macro` / `notification_show` (7 actions)
- browser_* (6 actions: `browser_click` / `browser_eval` / `browser_fill` / `browser_form` / `browser_navigate` / `browser_open`)

### Phase 4: Tier 3 query 軸 (別 session、11 tool、doc audit 中心)

query 軸は副作用なしのため §4.1 実機 4 項目のうち以下に置換:
- 正常 path: query 結果が schema 通りに返るか (`hints` / metadata 含む)
- error path: WindowNotFound / Timeout 等が typed code で返るか
- edge case: 空結果 / 巨大結果 / Unicode / lensId scope
- chain: 結果が次 commit 軸 tool に正しく feed されるか (e.g. `desktop_discover` の lease → `desktop_act`)

doc audit 4 項目は commit 軸と同一。

### Phase 5: Issue 起票 → fix → closure

各 Phase で発見した不整合を issue に切り出し、優先度別 fix。本 audit は v1.4.0 milestone の **release readiness 判定材料** を提供する位置づけ (実 release タグ切りは `docs/release-process.md` 領域、本 audit が解消すべき blocking issues を closeup → release-process.md の preflight が走る、という連結)。

## 6. Acceptance (Phase 5 closure 時点)

本節は **Phase 5 closure 時点での達成条件**。Phase 1 (本 PR) 完了時点では plan 起草のみで audit 表は未着手のため、下記 checkbox の大半は Phase 2-4 の進行で埋まる。

- [ ] L5 全 29 tool が audit 表に存在 (commit 軸 29 actions + query 軸 11 tool)
- [ ] 各行 8 項目 (実機 4 + doc 4) すべて埋まっている (query 軸は §5 Phase 4 の置換 4 項目で代替)
- [ ] silent-success / contract drift / schema reject / fact ズレ 0 件
- [ ] 検出した不整合は new issue 起票 → 別 PR で fix
- [ ] **scenario の永続化を 2 経路に分離**:
  - **automated regression pins** (`tests/integration/llm-audit/` or `tests/unit/`): vitest で CI/ローカルから繰返し実行可能、Windows GUI 依存が少ない unit-mockable contract 軸を pin (例: focus-refusal / schema validation / classify pattern)。本 audit で発見した contract drift の future protection
  - **manual / dogfood scenarios** (`docs/llm-audit/dogfood-scenarios/`): GUI 操作 / 実環境依存が強いシナリオを Markdown 仕様で永続化、CI からは回さず audit session 都度の手動 / Claude session で trial。Windows GUI / WT / Chrome 実機依存の維持コストを CI に持ち込まない
- [ ] v1.4.0 milestone の **release readiness 判定材料** を提供 (タグ切り自体は `docs/release-process.md` の領域、本 audit はその blocking issues 解消が判定材料)

## 7. Out of scope

- **新機能追加**: 本 audit は既存 29 tool の動作確認、新 tool 追加は別 epic
- **Phase 4 ADR (#185 epic) との切り分け**: WT BG 入力経路の **新規実装** は本 audit 範囲外、ただし本 audit で発見した silent-success が WT BG 経路を必要とすれば #185 epic に carry-over
- **breaking change の即実施**: 検出した contract regression が breaking change 必要なら、本 audit はその起票のみ、実装は別 PR

## 8. 起動条件

本 doc が main に land + user 合意で issue 起票後、Phase 2 着手。Phase 2 は 2a (doc audit 机上 sweep、60 cell) / 2b (実機 scenario、60 cell) に分割し、各 sub-phase を 1 session 内で完遂目標とする (実機検証含む 2b は密度高、1 session 上限)。

## 9. Related Files

- 規範: `docs/operation-verification-matrix.md`
- error code SSOT: `src/tools/_errors.ts`
- tool registration: `src/tools/*.ts`
- stub catalog (Linux): `src/stub-tool-catalog.ts`
- Phase 3 closure: PR #208 (audit 例の参考)
- Phase 4 ADR (別 epic): #185

---

END OF LLM Operation Audit Plan (Draft, Phase 1 起草).
