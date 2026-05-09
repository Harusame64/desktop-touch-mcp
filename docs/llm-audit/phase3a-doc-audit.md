# LLM Operation Audit — Phase 3a Doc Sweep Results

- Status: **Phase 3a 完了 (Tier 2 commit 軸 doc audit 机上 sweep のみ、実機 scenario は Phase 3b)**
- Date: 2026-05-09
- Authors: Claude (Opus, max effort) — user (Harusame64) 主導
- Branch: `feature/llm-audit-phase3a-doc-sweep`
- Origin: epic #211 Phase 3、Plan SSOT `docs/llm-operation-audit.md` §5 Phase 3
- Predecessor: Phase 2a doc audit (`docs/llm-audit/phase2a-doc-audit.md`、PR #212)、Phase 2b execution audit (`docs/llm-audit/phase2b-execution-audit.md`、PR #213)
- Scope: Tier 2 commit 軸 13 actions × 4 doc 項目 = **52 cell**

---

## 1. Audit 対象 (matrix §3.1 line 152-164)

Phase 2a / 2b で扱った Tier 1 (15 actions、過去 issue 多発) 以外の Tier 2 actions。

| # | Action | Tool registration file | matrix §3.1 row |
|---|---|---|---|
| 16 | `focus_window` | `src/tools/window.ts` | 152 |
| 17 | `desktop_act` | `src/tools/desktop-register.ts` (handler delegates → `desktop-activation.ts`) | 153 |
| 18 | `click_element` | `src/tools/ui-elements.ts` | 154 |
| 19 | `window_dock` | `src/tools/window-dock.ts` (delegates → `pin.ts` / `dock.ts`) | 155 |
| 20 | `workspace_launch` | `src/tools/workspace.ts` | 156 |
| 21 | `run_macro` | `src/tools/macro.ts` | 157 |
| 22 | `notification_show` | `src/tools/notification.ts` | 158 |
| 23 | `browser_click` | `src/tools/browser.ts` | 159 |
| 24 | `browser_eval` | `src/tools/browser.ts` | 160 |
| 25 | `browser_navigate` | `src/tools/browser.ts` | 161 |
| 26 | `browser_fill` | `src/tools/browser.ts` | 162 |
| 27 | `browser_form` | `src/tools/browser.ts` | 163 |
| 28 | `browser_open` | `src/tools/browser.ts` | 164 |

## 2. Audit cells (13 actions × 4 doc 項目)

判定値 (Plan §4.3 整合、Phase 2a と同):

- `pass` — contract bit-equal、SSOT 同期済
- `fix carry-over (doc gap)` — production fact は規範通りだが description / examples で LLM に伝わっていない
- `fix carry-over (contract drift)` — production fact ≠ matrix 規範で SSOT 同期不能 (production code 改修必須)
- `breaking change candidate` — fix が API contract 変更を要する
- `unverifiable accepted` — `verifyDelivery: focus_only / unverifiable` 等で degradation を明示済 (matrix §1.3 北極星整合)

### 2.1 OS-level / window 操作 (4 actions)

| # | Action | desc/examples | SUGGESTS | classify | matrix row | 判定 |
|---|---|---|---|---|---|---|
| 16 | focus_window | gap | pass | pass | pass | fix carry-over (doc gap) — G2 |
| 17 | desktop_act | pass | N/A (V2 lease delegation) | N/A | pass | **pass** |
| 18 | click_element | gap | pass | pass | pass | fix carry-over (doc gap) — G3 |
| 19 | window_dock | pass | N/A (delegation、no typed codes) | N/A | pass | **pass** |

### 2.2 launcher / macro / OS notification (3 actions)

| # | Action | desc/examples | SUGGESTS | classify | matrix row | 判定 |
|---|---|---|---|---|---|---|
| 20 | workspace_launch | partial | (delegates to wait_until) | (delegates) | pass | **pass** |
| 21 | run_macro | pass | (per-step delegation、no direct codes) | (delegates) | pass | **pass** |
| 22 | notification_show | drift | N/A | N/A | **drift** | **fix carry-over (contract drift)** — G1 |

### 2.3 browser_* (6 actions)

| # | Action | desc/examples | SUGGESTS | classify | matrix row | 判定 |
|---|---|---|---|---|---|---|
| 23 | browser_click | gap | pass | pass | **drift** (status enum 3値↔2値) | fix carry-over (doc gap + matrix narrowing) — G7 + G13 |
| 24 | browser_eval | partial | pass | pass | pass | fix carry-over (doc gap) — G8 |
| 25 | browser_navigate | partial | (uses BrowserNotConnected via classify) | (via classify) | pass | fix carry-over (doc gap) — G11 |
| 26 | browser_fill | partial | pass | pass | partial (family inheritance) | fix carry-over (doc gap) — G9 (G13 family inheritance note) |
| 27 | browser_form | pass | (per-step delegation) | (delegates) | pass | **pass** |
| 28 | browser_open | gap | pass | pass | pass | fix carry-over (doc gap) — G12 |

### 2.4 集計

- `pass`: **5 actions** — 17 (desktop_act)、19 (window_dock)、20 (workspace_launch)、21 (run_macro)、27 (browser_form)
- `fix carry-over (doc gap)`: **6 actions** (purely doc gap、matrix も bit-equal) — G2 / G3 / G8 / G9 / G11 / G12 (focus_window / click_element / browser_eval / browser_fill / browser_navigate / browser_open)
- `fix carry-over (doc gap + matrix narrowing)`: **1 action** — G7 + G13 (browser_click、description gap + matrix line 159 「3 値」 ↔ production 2 値 drift)
- `fix carry-over (contract drift)`: **1 action** — G1 (notification_show、production fact ≠ matrix §3.1 line 158 規範)
- `breaking change candidate`: 0
- `unverifiable accepted`: 0

合計 13 actions。distinct findings **9 件** (G1/G2/G3/G7/G8/G9/G11/G12/G13、G7 (description gap) + G13 (matrix narrowing) は cell 23 を共有するが軸が独立した distinct finding)。

## 3. Findings 詳細 (issue 起票候補)

### G1 (重要、contract drift): notification_show verifyDelivery hint emit 不在 — production fact ≠ matrix 規範

- **matrix §3.1 line 158 規範 (notification_show)**: 「toast が user に reach したかは原理的に観測不能 (OS が consent UI を出すか sink するかは user の Focus Assist 設定依存)。`hints.verifyDelivery: "unverifiable"` + reason: "user_visible_side_effect_uninspectable" を返す」
- **production 実装事実**: `src/tools/notification.ts` line 69 で `return ok({ ok: true, title, body })` のみ、`hints.verifyDelivery` を含む `hints` フィールド emit 不在
- **description fact**: line 112 description は「Focus Assist (Do Not Disturb) mode suppresses balloon tips; the tool still returns ok:true in that case」 — production の現状動作 (silent ok:true、hint なし) を反映、matrix 規範 (`unverifiable` hint で degradation 明示) と乖離
- **LLM 視点 impact**: Focus Assist active / consent UI suppress 等で notification が user に届かない場合でも `ok:true` のみで観測経路なし → silent-success regression (#173 / #202 同型 silent ok:true 北極星違反)
- **推奨 fix** (production code 改修、別 PR、Codex 必須):
  1. `notification.ts` handler に `hints: { verifyDelivery: { status: "unverifiable", reason: "user_visible_side_effect_uninspectable", channel: "win32_balloon_tip" } }` を `ok({...})` 内に追加
  2. description を更新「`hints.verifyDelivery: 'unverifiable'` で degradation を明示 (toast が user に reach したかは原理的に観測不能、Focus Assist 設定依存)」
  3. `tests/unit/notification-hint.test.ts` 新設で hint shape contract pin 追加
- **検証 pin**: 現状 `tests/unit/` に notification 系 test 不在、新 test と production fix 同 PR で land
- **教訓**: matrix §3.1 規範を「現状維持」/「現状で SSOT 候補」と表現せず明確に「規範」と書いた行 (line 158 ←→ line 152-157 / 159 と異なる) は production 未実装の可能性あり、Phase 5 closure 前の SSOT bit-equal sweep で類似行を要確認

### G2: focus_window description で ForegroundRestricted typed code 名 direct 言及不在 (Phase 2a F2 同型横展開)

- **matrix §3.1 line 152 規範**: Win11 foreground refusal 2 段 ladder で共拒否時 `ForegroundRestricted` typed code emit (#197)、silent ok:true は禁止
- **production 実装事実**: `src/tools/window.ts` line 176 で `failWith(new Error("ForegroundRestricted"), ...)`
- **description fact (`window.ts` line 261-266)**: caveats に「focus may be immediately stolen back (modal dialogs, UAC prompts) — verify with desktop_state」記述あるが typed code 名 `ForegroundRestricted` direct 言及不在
- **LLM 視点 impact**: failure envelope を見れば SUGGESTS は読めるが、tool 仕様の段階で「Win11 foreground refusal 時に typed code が返る」予告がない → 計画段階で fallback path を組めない
- **推奨 fix**: caveats に「Win11 foreground refusal (UIPI cross-elevation / admin-only target / from background process / service) 時は `code:'ForegroundRestricted'` ok:false で early return、recovery は windowTitle 直接受ける tool 経路 (`keyboard / desktop_act / browser_click`) に切替」を追記
- **横展開 note**: Phase 2a F2 (terminal / keyboard / mouse) と同型、Phase 2a I3 issue と統合管理候補

### G3: click_element description で典型的 typed code (InvokePatternNotSupported / ElementDisabled / GuardFailed) direct 言及不在

- **matrix §3.1 line 154 規範**: `InvokePatternNotSupported` / `ElementDisabled` (既存) 典型 typed code、Indirect 検証 (post-perception)
- **production 実装事実**: `ui-elements.ts` で `failWith` 経由 (line 127 GuardFailed / line 269 SetValueAllChannelsFailed)、`_errors.ts` classify が `InvokePatternNotSupported` / `ElementDisabled` / `GuardFailed` を解決
- **description fact (`ui-elements.ts` line 403-408)**: caveats に「Requires InvokePattern — some custom controls do not expose it; fall back to mouse_click」記述あるが typed code 名 `InvokePatternNotSupported` direct 言及不在、`ElementDisabled` / `GuardFailed` は完全に未言及
- **推奨 fix**: caveats を 3 行化「`code:'InvokePatternNotSupported'` の場合は `mouse_click` に fallback、`code:'ElementDisabled'` は precondition 未充足 (state 確認後 retry)、`code:'GuardFailed'` は perception envelope を読み取って attention/guard 詳細から recovery action を選択」

### G7: browser_click description で verifyDelivery 3 値 hint / BrowserClickNotDelivered 予約状態 言及不在

- **matrix §3.1 line 159 規範**: `verifyDelivery.status` 3 値 (`delivered` / `focus_only` / `unverifiable`)、`BrowserClickNotDelivered` typed code は §5.2 で予約のみ — false-positive risk のため emit せず、`unverifiable` hint で degradation 表現
- **production 実装事実**: `browser.ts` line 1126-1145 で 3 値 hint emit (`anySignal` で `delivered` / iframe で `unverifiable iframe_context_mismatch` / no signal で `unverifiable no_dom_mutation`)、`failWith(new Error("BrowserClickNotDelivered"), ...)` direct 呼出は production 経路不在 (line 1192 catch-block の generic err propagation)、SUGGESTS と classify は完備 (`_errors.ts:208-214`、`:396-398`)
- **description fact (`browser.ts` line 2662-2667)**: scrollIntoView caveat あり、`verifyDelivery` hint shape / `BrowserClickNotDelivered` 予約状態 への言及不在
- **推奨 fix**: caveats に「`hints.verifyDelivery: {status: 'delivered'|'focus_only'|'unverifiable', reason}` で post-click DOM mutation / URL change / activeElement change 観測結果を 3 値表現。`BrowserClickNotDelivered` typed code は予約のみ (false-positive risk のため emit せず、degradation は `unverifiable` hint で表現、SUGGESTS / classify は登録済)」を追記
- **横展開 note**: Phase 2a F6 / F7 (mouse_click / mouse_drag) と同型 doc gap、I2 (description 補強 issue) と統合管理候補

### G8: browser_eval description で BrowserNotConnected / AutoGuardBlocked typed code 言及不在

- **matrix §3.1 line 160 規範**: `BrowserNotConnected` (CDP 接続失敗、既存)、Strict 検証 (`result.value` 返却済)
- **production 実装事実**: `browser.ts` line 1261 で `AutoGuardBlocked` failWith、line 1303 / 1383 / 1386 で generic failWith (CDP 切断時に `BrowserNotConnected` classify 解決される shape)、SUGGESTS は `_errors.ts:56-` で完備 (BrowserNotConnected)
- **description fact (`browser.ts` line 2669-2695)**: 3 actions (js/dom/appState) 詳細あり、controlled inputs / DOM nodes circular ref caveat あり、typed code 名 言及不在
- **推奨 fix**: caveats に「CDP 接続切断時は `code:'BrowserNotConnected'`、page loading 中の auto-guard block は `code:'AutoGuardBlocked'`、いずれも `browser_open` で再接続 / `wait_until(ready_state)` で待機後 retry」を追記

### G9: browser_fill description で BrowserFillNotDelivered typed code 名 direct 言及不在 (concept は反映済)

- **matrix §3.1 line 162 規範**: `BrowserFillNotDelivered` (新規、`BrowserClickNotDelivered` 同系)、Indirect 強化 (post-fill `element.value` read-back)
- **production 実装事実**: `browser.ts` line 684 で `failWith(new Error("BrowserFillNotDelivered"), ...)` real emit (predicted-only ではない)、`_errors.ts:222-228` SUGGESTS / `:399-401` classify 完備
- **description fact (`browser.ts` line 2704-2709)**: 「element.value 後の actual」 mention あり concept 反映、典型 typed code 名 `BrowserFillNotDelivered` direct 言及不在
- **推奨 fix**: caveats に「value mismatch 検出時は `code:'BrowserFillNotDelivered'` (false-positive: React controlled input が onChange で値を変換した場合は配信成功でも mismatch、`hints.verifyDelivery.subReason: 'controlled_input_transform'` で SUGGESTS に明示)、`actual` 値が authoritative」を追記
- **note**: 他 browser_* G7/G8/G11/G12 と異なり、本 finding は description が **concept は反映済** (= partial)、typed code 名 direct 言及のみ追加で十分 — Low priority

### G11: browser_navigate description で frameStoppedLoading / loaderId 観測経路 言及不在

- **matrix §3.1 line 161 規範**: Indirect — `frameStoppedLoading` / `loaderId` 観測
- **production 実装事実**: `browser.ts` line 1430 で AutoGuardBlocked、line 1520 で generic failWith (BrowserNotConnected classify 解決)
- **description fact (`browser.ts` line 2697-2702)**: 「Does not block until page load completes — follow with wait_until(element_matches) or repeated browser_eval polling for slow pages」 記述あり (recovery path 完備)、verification 経路 frameStoppedLoading / loaderId observation 言及不在
- **推奨 fix**: caveats に「navigate API は `Page.navigate` ack のみ確認 (frameStoppedLoading / loaderId 内部観測で navigate 自身の delivery は確認済)、page load 完了は `wait_until(ready_state)` で別途確認」を追記
- **note**: wait_until follow-up は明示済のため Low priority、recovery path に空白なし

### G13 (重要、matrix narrowing): browser_click `verifyDelivery.status` matrix「3 値」↔ production「2 値」 drift

- **matrix §3.1 line 159 規範**: 「`verifyDelivery.status` 3 値 (#181)」 — `delivered` / `focus_only` / `unverifiable` の 3 値を mouse_click family と並列で記載
- **production 実装事実**: `src/tools/browser.ts:560` で TypeScript 型定義 `status: "delivered" | "unverifiable"` (2 値のみ)、`browser.ts:1095-1158` で `delivered` / `unverifiable` のみ emit (grep `focus_only` in `browser.ts` returns 0 hits)。CDP 経路では `focus_only` (UIA 観測経路の "focus 変化のみで他観測なし" 区別) は semantic に N/A
- **family inheritance impact**: browser_fill (matrix §3.1 line 162) は `BrowserClickNotDelivered 同系` と family inheritance 言及あり、production `browser.ts:699/722` も同 2 値 pattern。matrix 162 自体は明示的 3 値 言及なしだが family contract で同 drift
- **LLM 視点 impact**: matrix を読んだ LLM は browser_click の verifyDelivery hint shape を 3 値 (focus_only 含む) で expect、production envelope は 2 値 のみ → schema unexpected (LLM serialiser reject) / fallback path 設計 mismatch
- **推奨 fix** (docs only、matrix narrow):
  1. `docs/operation-verification-matrix.md` line 159 を 「`verifyDelivery.status` 2 値 (`delivered` / `unverifiable`、`focus_only` は CDP 経路 semantic N/A のため emit せず — UIA 経路 mouse_click family でのみ 3 値)」 に narrow
  2. line 162 (browser_fill) の family inheritance 注記を line 159 narrowing と同期
  3. `phase3a-doc-audit.md` cell 23 / 26 matrix column を `pass` に更新 (matrix narrowed 後 bit-equal 復帰)
- **教訓**: matrix line 159 は #181 issue 起票時点で mouse_click family の文言を CDP 経路に流用、CDP 経路独自の semantic narrowing を未反映。matrix row 自身の family inheritance pattern が drift 温床になりうる pattern (Lesson 4 numeric count sync の matrix-row 軸版)

### G12: browser_open description で BrowserNotConnected typed code 名 direct 言及不在

- **matrix §3.1 line 164 規範**: `BrowserNotConnected` (既存) typed code、Indirect (attach 後 target list rebuild)
- **production 実装事実**: `browser.ts` line 910 / 1873 で generic failWith (CDP 接続失敗時に `BrowserNotConnected` classify 解決)、SUGGESTS / classify 完備
- **description fact (`browser.ts` line 2644-2653)**: 「CDP connection is per-process; if Chrome restarts, call browser_open again」 caveat あり (recovery 完備)、typed code 名 direct 言及不在
- **推奨 fix**: caveats に「CDP endpoint 不在 / 接続失敗時は `code:'BrowserNotConnected'`、`launch:{}` で auto-spawn (idempotent)、Chrome restart 後は再 attach 必要」を追記

## 4. Issue 起票候補 (Phase 5 closure に向けて、Phase 2a I1-I3 + Phase 2b E1-E5 と統合管理)

| # | 内容 | 優先度 | 性質 | 推奨 PR 単位 |
|---|---|---|---|---|
| **J1** | G1 fix — notification_show `hints.verifyDelivery: 'unverifiable'` emit 追加 + description sync + tests/unit/notification-hint.test.ts new pin | **High** | production code 改修 | 単独 PR、Opus + **Codex 必須** (CLAUDE.md §3.3 Step 0、F4/I1 と同型 production code改修 PR 規律) |
| **J2** | G2 + G3 + G7 + G8 + G12 — typed code description 補強 (focus_window / click_element / browser_click / browser_eval / browser_open) | Medium | docs only | 1 PR にまとめる、Opus 1+ round (Codex 推奨)、Phase 2a I2 と統合可 |
| **J3** | G9 + G11 — description minor enrichment (browser_fill typed code 名直接言及 / browser_navigate verification 経路明示) | Low | docs only | J2 と同 PR or defer |
| **J4** | G13 — matrix §3.1 line 159 (browser_click) status enum 3 値 → 2 値 narrowing + line 162 family inheritance 注記 sync | Medium | docs only (matrix update) | 単独 PR、Opus 1+ round (Codex 推奨で matrix bit-equal 確認)。production code 改修なし、matrix narrowing で SSOT bit-equal 復帰 |

統合 carry-over 整理 (Phase 2a I1-I3 + Phase 2b E1-E5 + Phase 3a J1-J4):

| # | Source | Priority | Type | Status |
|---|---|---|---|---|
| **I1** (Phase 2a F4) | `FocusLostDuringType` SSOT register | **High** | production code (Codex 必須) | **Resolved** PR #218 |
| **J1** (Phase 3a G1) | `notification_show` `hints.verifyDelivery` emit | **High** | production code (Codex 必須) | **Resolved** PR #217 |
| **I2** (Phase 2a F1+F3+F5+F6+F7+F8+F9+F10) | description 補強 | Medium | docs only | **Resolved** PR #219 |
| **J2** (Phase 3a G2+G3+G7+G8+G12) | description 補強 | Medium | docs only | **Resolved** PR #219 |
| **I3** (Phase 2a F2) | cross-tool ForegroundRestricted 統一 wording | Medium | docs only | open |
| **E1-E4** (Phase 2b) | automated pin gap | Medium / Low | new test only | open |
| **J3** (Phase 3a G9+G11) | description minor enrichment | Low | docs only | **Resolved** PR #219 |
| **J4** (Phase 3a G13) | matrix §3.1 line 159/162 browser_click verifyDelivery status enum narrowing | Medium | docs only (matrix update) | open |
| **E5** (Phase 2b) | scroll:capture frame seam | **Defer** | optional | defer |

I1 + J1 production contract drift 解消 (PR #218 / #217、Phase 5 closure 北極星達成)、I2 + J2 + J3 description enrichment 解消 (PR #219 統合 land)、残 I3 + J4 + E1-E4 は Phase 5 follow-up PR。

## 5. Phase 3a closure conditions (本 PR スコープ)

- [x] 13 actions × 4 doc 項目 audit 完了 (52 cell 全埋まり)
- [x] 不整合 list (G1-G12) を本 doc に永続化
- [x] 判定値記入 (pass / fix carry-over (doc gap) / fix carry-over (contract drift) / breaking change candidate / unverifiable accepted)
- [x] Issue 起票候補リスト (J1-J3) 作成 + Phase 2a/2b 統合管理表
- [x] CLAUDE.md §3.1 multi-table fact 整合 sweep — 各 fact を 5 view (matrix §3.1 / production code / 既存 unit pin / Phase 2a 判定 / 本 phase cell 判定) で bit-equal 確認:
  - 「`ForegroundRestricted` typed code family contract」 (G2 = focus_window が Phase 2a F2 family と同型 fact、I3 統合 candidate)
  - 「`BrowserClickNotDelivered` 予約状態」 (G7 = Phase 2a F6/F7 mouse 軸 と同型 fact、production line 1192 catch-block は generic err propagation で direct emit なし)
  - 「`hints.verifyDelivery: 'unverifiable'` 規範 emit」 (G1 = matrix §3.1 line 158 規範を production 未実装、F4 同型 contract drift fact pattern)
  - 「`verifyDelivery.status` enum 3 値 vs 2 値」 (G13 = matrix §3.1 line 159 「3 値」 ↔ production browser.ts:560 type 定義 2 値、family inheritance pattern drift で line 162 browser_fill にも同型 sync 影響、matrix narrow recommendation)

## 6. Out of scope (本 PR)

- production code 改修 (G1 / J1 fix も別 PR で Codex 必須)
- 実機 scenario (Phase 3b、別 session、Plan §5)
- 11 tool query 軸 audit (Phase 4、Plan §5)
- description 補強 (J2 / J3 は別 PR、I2 と統合可)

## 7. Related Files

- Plan SSOT: `docs/llm-operation-audit.md` (PR #210)
- Phase 2a 結果: `docs/llm-audit/phase2a-doc-audit.md` (PR #212)
- Phase 2b 結果: `docs/llm-audit/phase2b-execution-audit.md` (PR #213)
- 規範 doc: `docs/operation-verification-matrix.md` §3.1 line 152-164
- error code SSOT: `src/tools/_errors.ts` (SUGGESTS + classify + failWith + ROOT_HOISTED_KEYS)
- production code: `src/tools/{window,desktop-register,desktop-activation,ui-elements,window-dock,workspace,macro,notification,browser}.ts`
- Phase 4 ADR (別 epic): #185

---

END OF Phase 3a Doc Audit Results.
