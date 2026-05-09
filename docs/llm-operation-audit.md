# LLM Operation Audit — 28 tool LLM-perspective 総点検

- Status: **Draft (Phase 1 起草、user 合意待ち)**
- Date: 2026-05-09
- Authors: Claude (Opus, max effort) — user (Harusame64) 主導の企画
- Origin: 1.3 版で silent-success / regression / contract drift が複数発見された反省 (PR #173 / #196 / #202 等)。LLM agent (Claude Code 等) が tool を呼ぶ実環境視点で **動作 + 文書 contract** を 28 tool 全件総点検し、漏れを潰す
- Related:
  - 規範 doc: `docs/operation-verification-matrix.md` (Phase 3 SSOT、本 audit のリファレンス)
  - 親 issue: 本 plan に対応する new issue (本 doc land 後に起票)
  - 過去 audit: PR #186-#194 (Phase 3 child issues、tool 別 verification)、PR #208 (Phase 3 closure audit)

---

## 1. Goal

LLM agent (Claude Code、Claude Desktop 等) が **実環境で 28 tool を呼んだとき、tool description / examples / matrix doc 規範通りに動作するか** を機械検証 + LLM 視点 doc audit のハイブリッドで網羅確認する。1.3 版で複数発見された下記 failure mode を 0 件に追い込む:

| Failure mode | 1.3 版での例 |
|---|---|
| Silent-success | terminal BG path WT silent drop (#173) |
| Contract drift | matrix §3.1 doc と production code fact ズレ (#208 audit で 3 件発見) |
| Schema reject (LLM serialiser) | terminal `until` JSON-string reject (#196) |
| Foreground refusal silent regression | `ok:true + warning` で keystroke 誤窓 landing (#202) |
| Test residue | WT graceful kill 不在で WT window 累積 (#204) |

## 2. Scope

ハイブリッド audit:

- **実機 scenario** (LLM-perspective integration test): Claude agent が 28 tool を順次呼び、正常 path / error path / edge case / chain (tool 結果が次 tool に feed される) を実機検証
- **Doc audit** (LLM-perspective): tool description / examples / suggest dictionary / classify pattern / matrix doc 各行を LLM 視点で「これ見て tool を正しく使えるか」観点で audit、fact 整合 + 不足を発見

実機と doc を交互に。実機で発見した違和感を doc に書き起こすか production を直すか判断、doc audit で不明な箇所を実機で trial で確認。

## 3. Tool list (L5 全 28 tool — commit 軸 28 行 + query 軸 11 tool)

数え方の単位は `docs/operation-verification-matrix.md` §1.4 に整合: L5 MCP Tool Surface (`docs/layer-constraints.md` §6.3 invariant 6) は **28 tool 不変**、本書もその数を継承。**commit 軸**は action 別に行を立てて **28 行** (matrix §3.1 と一致)、**query 軸**は **11 tool** (matrix §3.2 と一致)。同じ tool が両軸に出る場合あり (例: `terminal:send/run` は commit 軸、`terminal:read` は query 軸)。

### 3.1 Commit 軸 (副作用あり、verification 必須、28 行)

read 系 action は副作用なしのため §3.2 に集約、本表は副作用ある action のみ列挙。

| Tool | Action(s) | API レイヤ | matrix §3.1 row | 1.3 版で issue があった? |
|---|---|---|---|---|
| `terminal` | send / run | UIA TextPattern + WM_CHAR | 137-139 | yes (#173 #196 #202 #204) |
| `keyboard` | type BG / type FG / press BG / press FG | WM_CHAR + SendInput | 140-143 | yes (#177 #195 #198 #202) |
| `mouse_click` | (single action) | SendInput | 144 | yes (#178 #202) |
| `mouse_drag` | (single action) | SendInput sequence | 145 | yes (#178) |
| `scroll` | raw / to_element / smart / capture | WHEEL_DELTA + UIA + CDP | 146-149 | yes (#179) |
| `clipboard` | write | Set-Clipboard | 151 | yes (#180) |
| `focus_window` | (single action) | SetForegroundWindow + AttachThreadInput | 152 | yes (#197 #202) |
| `desktop_act` | (lease-driven actions) | UIA InvokePattern / setValue / etc | 153 | partial |
| `click_element` | (single action) | UIA InvokePattern + mouse_click fallback | 154 | partial |
| `window_dock` | (single action) | SetWindowPos + WM_SIZE | 155 | partial |
| `workspace_launch` | (single action) | start exe + wait_until | 156 | partial |
| `run_macro` | (composite) | tool sequence | 157 | partial |
| `notification_show` | (single action) | Win32 toast | 158 | none |
| `browser_click` / `browser_eval` / `browser_fill` / `browser_form` / `browser_navigate` / `browser_open` | (CDP based) | CDP Runtime/Page/Input | 159-164 | yes (#181) |

### 3.2 Query 軸 (副作用なし、verification N/A、11 tool)

| Tool | 副作用 |
|---|---|
| `screenshot` | none |
| `desktop_state` | none |
| `desktop_discover` | none (lease 発行は L4 内部) |
| `wait_until` | none (polling 観測のみ) |
| `clipboard:read` | none (commit 軸の `clipboard:write` と同 tool 名、別 action) |
| `terminal:read` | none (commit 軸の `terminal:send/run` と同 tool 名、別 action) |
| `scroll:read` | none (OCR + scroll polling、`stopWhenNoChange` 観測) |
| `server_status` | none |
| `browser_overview` / `browser_search` / `browser_locate` | none |
| `workspace_snapshot` | none |

L5 全 28 tool。commit 軸 28 行 (action 別) + query 軸 11 tool で matrix doc §3.1 / §3.2 と完全整合。

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

判定: `pass` / `fix carry-over` (新 issue 起票) / `breaking change candidate` (1.4 系で fix 案件)。

## 5. Phase 分割

Audit scope が巨大 (26 tool × 6 項目 = 156 item) のため Phase 分割:

### Phase 1: Plan + template land (本 doc)
本 doc を `docs/llm-operation-audit.md` に永続化、user 合意で issue 起票。

### Phase 2: Tier 1 commit 軸 (1 session 内、5-6 tool)

過去 issue 履歴で問題が多かった tool を優先:
- `terminal` (3 action)
- `keyboard` (4 row)
- `mouse_click` / `mouse_drag`
- `scroll` (5 action)
- `clipboard` (2 action)

実機 + doc 同時 audit、検出した不整合を新 issue 起票。

### Phase 3: Tier 2 commit 軸 (別 session、5-6 tool)

- `focus_window` / `desktop_act` / `click_element`
- `window_dock` / `workspace_launch` / `run_macro`
- `notification_show`
- browser_* 6 tool

### Phase 4: Tier 3 query 軸 (別 session、11 tool)

副作用なしだが LLM が読み解く対象として doc audit 重要:
- `screenshot` / `desktop_state` / `desktop_discover` / `wait_until`
- `clipboard:read` / `terminal:read` / `server_status` / `workspace_snapshot`
- `browser_overview` / `browser_search` / `browser_locate`

### Phase 5: Issue 起票 → fix → closure

各 Phase で発見した不整合を issue に切り出し、優先度別 fix。closure は v1.4.0 release tag (target milestone)。

## 6. Acceptance

- [ ] L5 全 28 tool (commit 軸 28 行 + query 軸 11 tool) が audit 表に存在
- [ ] 各行 8 項目 (実機 4 + doc 4) すべて埋まっている
- [ ] silent-success / contract drift / schema reject / fact ズレ 0 件
- [ ] 検出した不整合は new issue 起票 → 別 PR で fix
- [ ] **scenario の永続化を 2 経路に分離**:
  - **automated regression pins** (`tests/integration/llm-audit/` or `tests/unit/`): vitest で CI/ローカルから繰返し実行可能、Windows GUI 依存が少ない unit-mockable contract 軸を pin (例: focus-refusal / schema validation / classify pattern)。本 audit で発見した contract drift の future protection
  - **manual / dogfood scenarios** (`docs/llm-audit/dogfood-scenarios/`): GUI 操作 / 実環境依存が強いシナリオを Markdown 仕様で永続化、CI からは回さず audit session 都度の手動 / Claude session で trial。Windows GUI / WT / Chrome 実機依存の維持コストを CI に持ち込まない
- [ ] v1.4.0 milestone の **release readiness 判定材料** を提供 (タグ切り自体は `docs/release-process.md` の領域、本 audit はその blocking issues 解消が判定材料)

## 7. Out of scope

- **新機能追加**: 本 audit は既存 28 tool の動作確認、新 tool 追加は別 epic
- **Phase 4 ADR (#185 epic) との切り分け**: WT BG 入力経路の **新規実装** は本 audit 範囲外、ただし本 audit で発見した silent-success が WT BG 経路を必要とすれば #185 epic に carry-over
- **breaking change の即実施**: 検出した contract regression が breaking change 必要なら、本 audit はその起票のみ、実装は別 PR

## 8. 起動条件

本 doc が main に land + user 合意で issue 起票後、Phase 2 着手。Phase 2 は 1 session 内で完遂目標 (5-6 tool × 6 項目 = 30-36 item、密度高い実機検証含むため 1 session 上限)。

## 9. Related Files

- 規範: `docs/operation-verification-matrix.md`
- error code SSOT: `src/tools/_errors.ts`
- tool registration: `src/tools/*.ts`
- stub catalog (Linux): `src/stub-tool-catalog.ts`
- Phase 3 closure: PR #208 (audit 例の参考)
- Phase 4 ADR (別 epic): #185

---

END OF LLM Operation Audit Plan (Draft, Phase 1 起草).
