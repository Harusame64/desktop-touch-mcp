# LLM Operation Audit — Phase 2a Doc Sweep Results

- Status: **Phase 2a 完了 (doc audit 机上 sweep のみ、実機 scenario は Phase 2b)**
- Date: 2026-05-09
- Authors: Claude (Opus, max effort) — user (Harusame64) 主導
- Branch: `feature/llm-audit-phase2a-doc-sweep`
- Origin: epic #211 Phase 2、Plan SSOT `docs/llm-operation-audit.md` §5 Phase 2
- Scope: Tier 1 commit 軸 15 actions × 4 doc 項目 = **60 cell**

---

## 1. Audit 対象 (matrix §3.1 line 137-151)

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

## 2. Audit cells (15 actions × 4 doc 項目)

判定値 (Plan §4.3 整合):

- `pass` — contract bit-equal、SSOT 同期済
- `fix carry-over (doc gap)` — production fact は規範通りだが description / examples で LLM に伝わっていない
- `fix carry-over (contract drift)` — SUGGESTS / classify / matrix の SSOT 三者間 bit-equal 違反
- `breaking change candidate` — fix が API contract 変更を要する
- `unverifiable accepted` — `verifyDelivery: focus_only / unverifiable` 等の hint で degradation を明示済 (matrix §1.3 北極星整合)

### 2.1 terminal (3 actions)

| # | Action | desc/examples | SUGGESTS | classify | matrix row | 判定 |
|---|---|---|---|---|---|---|
| 1 | terminal:send BG | gap | pass | pass | pass | fix carry-over (doc gap) — F1 |
| 2 | terminal:send FG | gap | pass | pass | pass | fix carry-over (doc gap) — F2 |
| 3 | terminal:run | pass | pass | pass | pass | **pass** |

### 2.2 keyboard (4 actions)

| # | Action | desc/examples | SUGGESTS | classify | matrix row | 判定 |
|---|---|---|---|---|---|---|
| 4 | keyboard:type BG | partial | pass | pass | pass | fix carry-over (doc gap) — F3 |
| 5 | keyboard:type FG | partial | drift | drift | partial | **fix carry-over (contract drift)** — F4 |
| 6 | keyboard:press BG | gap | pass | pass | pass | fix carry-over (doc gap) — F5 |
| 7 | keyboard:press FG | gap | pass | pass | pass | fix carry-over (doc gap) — F2 同断 |

### 2.3 mouse (2 actions)

| # | Action | desc/examples | SUGGESTS | classify | matrix row | 判定 |
|---|---|---|---|---|---|---|
| 8 | mouse_click | gap | pass | pass | pass | fix carry-over (doc gap) — F6 |
| 9 | mouse_drag | gap | pass | pass | pass | fix carry-over (doc gap) — F7 |

### 2.4 scroll (5 actions)

| # | Action | desc/examples | SUGGESTS | classify | matrix row | 判定 |
|---|---|---|---|---|---|---|
| 10 | scroll:raw | gap | pass | pass | pass | fix carry-over (doc gap) — F8 |
| 11 | scroll:to_element | pass | pass | pass | pass | **pass** |
| 12 | scroll:smart | partial | pass | pass | pass | fix carry-over (doc gap) — F9 |
| 13 | scroll:capture | pass | N/A | N/A | pass | **pass** |
| 14 | scroll:read | pass | N/A | N/A | pass | **pass** |

### 2.5 clipboard (1 action)

| # | Action | desc/examples | SUGGESTS | classify | matrix row | 判定 |
|---|---|---|---|---|---|---|
| 15 | clipboard:write | gap | pass | pass | pass | fix carry-over (doc gap) — F10 |

### 2.6 集計

- `pass`: **5 cells** (terminal:run, scroll:to_element, scroll:capture, scroll:read, + 内 cell 単位の partial pass を除く)
- `fix carry-over (doc gap)`: **9 actions** (F1, F2 ×2, F3, F5, F6, F7, F8, F9, F10)
- `fix carry-over (contract drift)`: **1 action** (F4)
- `breaking change candidate`: 0
- `unverifiable accepted`: 0

## 3. Findings 詳細 (issue 起票候補)

### F1: terminal description に hidden_input_prompt verifyDelivery hint 言及不在

- **matrix §3.1 line 137 規範 (terminal:send BG)**: `hints.verifyDelivery: {status:"unverifiable", reason:"hidden_input_prompt", channel:"wm_char", fallback:"method:'foreground'"}` を hidden-input prompt 検出時に返す
- **production 実装事実**: `src/tools/terminal.ts` line 553-637 で baseline 末尾行 password / passphrase / sudo / `Password for ` / `^>$` パターン検出 → `verifyReason = "hidden_input_prompt"` → line 633-640 で SSOT shape の hint emit
- **terminal description fact (`src/tools/terminal.ts` line 1553-1564 buildDesc)**: caveats / examples いずれにも `hidden_input_prompt` / `verifyDelivery: unverifiable` 言及なし
- **LLM 視点 impact**: `ok:true + hints.verifyDelivery: unverifiable` envelope を読み取って `method:'foreground'` fallback すべき判断材料が description / examples から得られない
- **推奨 fix**: caveats に「password / sudo / Read-Host -AsSecureString 等の hidden-input prompt 入力では `hints.verifyDelivery` が `{status:'unverifiable', reason:'hidden_input_prompt'}` を返す。credential entry は `method:'foreground'` で送信」を追記

### F2: terminal / keyboard / focus_window description に ForegroundRestricted recovery path 不在

- **matrix §3.1 line 138, 141, 143, 152 規範**: `code: ForegroundRestricted` を Win11 foreground refusal 2 段 ladder 共拒否時に emit
- **production 実装事実**: `terminal.ts` line 723 / `keyboard.ts` line 892, 1292 / `mouse.ts` line 517 で `new Error("ForegroundRestricted")` failWith
- **description fact**: terminal / keyboard / mouse_click いずれの description にも typed code 名 `ForegroundRestricted` の direct 言及なし。recovery path は `_errors.ts` SUGGESTS 経由でのみ提供 (4 actionable suggest 完備)
- **LLM 視点 impact**: failure envelope を見れば SUGGESTS は読めるが、tool 仕様の段階で「Win11 foreground refusal 時に typed code が返る」予告がない → 計画段階で fallback path を組めない
- **推奨 fix**: terminal / keyboard / mouse description の caveats に「Win11 foreground refusal (UIPI cross-elevation / admin-only target / from background process / service) 時は `code:'ForegroundRestricted'` ok:false で early return、recovery は windowTitle 直接受ける tool 経路に切替」を追記
- **横展開**: focus_window description (matrix §3.1 line 152、別 audit phase で扱う) にも同型 fact があるため統一 wording

### F3: keyboard:type description に BackgroundInputNotDelivered recovery example 不在

- **matrix §3.1 line 140 規範 (keyboard:type BG)**: `terminal:send BG と同型: pre-send focused-element value 採取 → WM_CHAR 送信 → UIA TextPattern / ValuePattern read-back`
- **production 実装事実**: `keyboard.ts` line 773, 831 で `new Error("BackgroundInputNotDelivered")` failWith
- **description fact (`keyboard.ts` line 1521-1531 buildDesc)**: examples 4 行に BG path / verifyDelivery 検証の使用例なし、caveats では BG mode auto-engage 言及あるが failure recovery example 不在
- **推奨 fix**: examples に BG path failure 後の `method:'foreground'` retry の chain 例を追加

### F4 (重要): FocusLostDuringType typed code が SUGGESTS / classify に未登録 — contract drift

- **production 実装事実**: `keyboard.ts` line 1002 で `new Error("FocusLostDuringType")` を `failWith` に通すが、handler が context オブジェクトに `suggest: [...3 strings...]` を hard-code 同梱
- **failWith 経路 (`_errors.ts` line 422-456) の挙動**:
  1. `classify("FocusLostDuringType")` → どの pattern にも match しない → `code: "ToolError"`, `suggest: []` を返す
  2. handler が渡した context.suggest は `ROOT_HOISTED_KEYS` (`_perceptionForPost` / `_richForPost` / `hints`) に含まれず、`context.suggest` として nest される
  3. 最終 envelope: `{ok:false, code:"ToolError", error:"keyboard:type failed: FocusLostDuringType", context:{suggest:[...], typed, remaining, ...}}`
- **standard envelope shape との乖離**:
  - 期待: `{ok:false, code:"FocusLostDuringType", suggest:[...]}` (top-level)
  - 実際: `{ok:false, code:"ToolError", context:{suggest:[...]}}` (nested)
- **description fact**: keyboard description (line 1525) は `FocusLostDuringType` typed identifier を caveats で明示している → description vs SSOT で乖離
- **推奨 fix** (production code 改修、別 PR、Codex 必須):
  1. `_errors.ts` SUGGESTS に `FocusLostDuringType` entry 追加 (handler の hard-coded 3 strings を移動 + matrix doc §3.1 line 141 への reference comment)
  2. `_errors.ts` classify() に `if (m.includes("focuslostduringtype") || m.includes("focus lost during type")) return { code: "FocusLostDuringType", suggest: SUGGESTS.FocusLostDuringType };` を追加
  3. handler 内 hard-coded suggest を削除 (classify が automatic 解決)
- **検証 pin**: `tests/unit/keyboard-leash-guard.test.ts` (既存) に envelope shape contract pin 追加 (`code === "FocusLostDuringType"`、`suggest` が top-level、`context.typed/remaining` 維持)
- **教訓**: failWith caller が `context.suggest` を hard-code する pattern は SSOT bypass で contract drift の温床。`_errors.ts` SUGGESTS / classify を SSOT として SOLE source とする原則に従う

### F5: keyboard:press BG description に BackgroundKeyNotDelivered + verification scope 言及不在

- **matrix §3.1 line 142 規範**: `BackgroundKeyNotDelivered` typed code、verification は terminal-class targets のみ、enter / tab / arrow keys のみ read-back-verified
- **production 実装事実**: `keyboard.ts` line 1227 で `new Error("BackgroundKeyNotDelivered")` emit
- **description fact**: keyboard.ts line 1521-1531 description は press の言及あるが `BackgroundKeyNotDelivered` typed code への direct 言及なし、verification scope (which combos が verifyDelivery:'unverifiable' に流れるか) は SUGGESTS 内のみ説明
- **推奨 fix**: caveats に「`action:'press'` BG path verification は terminal-class target の enter/tab/arrow のみ read-back 検証、その他 combo は `verifyDelivery:'unverifiable'`、verification 失敗時は `code:'BackgroundKeyNotDelivered'`」を追記

### F6: mouse_click description に verifyDelivery 3 値 hint + ForegroundRestricted 言及不在

- **matrix §3.1 line 144 規範**: `verifyDelivery.status` 3 値 (`delivered` / `focus_only` / `unverifiable`)、`MouseClickNotDelivered` typed code は §5.2 で予約のみ (false-positive risk)、`ForegroundRestricted` で early-return (#202)
- **production 実装事実**:
  - `mouse.ts` line 622-639 で `verifyDeliveryHint = classifyDelivery(preSnapshot, postSnapshot, "send_input")` 3 値生成
  - `mouse.ts` line 517 で homing path foreground refusal 時 `new Error("ForegroundRestricted")` early-return
- **description fact (`mouse.ts` line 1241 plain string description)**: `post.perception` への言及あり、`verifyDelivery` 3 値 hint / `ForegroundRestricted` typed code への言及なし
- **推奨 fix**: description に「`hints.verifyDelivery: {status: 'delivered'|'focus_only'|'unverifiable'}` で配信検証結果を表現。homing path で Win11 foreground refusal 検出時は `code:'ForegroundRestricted'` early-return (誤クリック防止)」を追記

### F7: mouse_drag description に verifyDelivery hint + MouseDragNotDelivered 予約状態言及不在

- F6 同型: `mouse.ts` line 815-829 で `classifyDelivery` 3 値 hint emit、line 1247 description で同等言及不在
- **推奨 fix**: F6 と並行 fix。`MouseDragNotDelivered` typed code は SUGGESTS 登録済 (6 actionable suggest) かつ予約のみ — emit せず hint で表現する設計を description で明示

### F8: scroll:raw description に ScrollNotDelivered + page-end disambiguation 不在

- **matrix §3.1 line 146 規範**: `ScrollNotDelivered` typed code、page-end disambiguation (`pre.percent at boundary, post equal → page-end success` vs `pre off-boundary, post equal → silent drop`)
- **production 実装事実**: `mouse.ts` line 1102 で page-end disambiguation logic、line 1105 で `new Error("ScrollNotDelivered")` failWith
- **description fact (`scroll.ts` line 248-260)**: typed code 直接言及なし
- **推奨 fix**: caveats に「`action:'raw'` 後 wheel が silently swallowed (overlay window above target / non-scrollable container / UIPI low-IL → elevated app) 時は `code:'ScrollNotDelivered'`、page boundary 既到達は success として扱う disambiguation あり」を追記

### F9: scroll:smart description に typed code recovery path 略記

- **matrix §3.1 line 148 規範**: `OverflowHiddenAncestor` / `VirtualScrollExhausted` / `MaxDepthExceeded` typed code を strategy 別失敗時に emit
- **production 実装事実**: 上記 typed codes の SUGGESTS / classify は完備、actionable な recovery path 提供
- **description fact**: scroll.ts line 248-260 で 多 strategy explanation あるが typed code 名の direct 言及なし
- **推奨 fix**: caveats に typed code 列挙 (`OverflowHiddenAncestor` → `expandHidden:true` 試行 / `VirtualScrollExhausted` → `virtualIndex` 提供 / `MaxDepthExceeded` → `maxDepth` 拡張) を追記

### F10: clipboard description が 1 行で ClipboardWriteNotDelivered + verification 不在

- **matrix §3.1 line 151 規範 (clipboard:write)**: `Set-Clipboard` 後 `Get-Clipboard -Raw` で read-back → byte 単位 (UTF-16LE) 一致確認、不一致時 `code:'ClipboardWriteNotDelivered'`
- **production 実装事実**: `clipboard.ts` line 108 で `new Error("ClipboardWriteNotDelivered")` failWith
- **description fact (`clipboard.ts` line 199 plain string)**: 1 行のみ、verification 設計 / typed code 言及なし
- **推奨 fix**: description を 5-6 行化、`buildDesc` に切替、`verifyDelivery: write→readback` 設計と `ClipboardWriteNotDelivered` typed code (clipboard manager intercept / DLP / RDP transcoding 等の cause) を caveats 化、examples 追加

## 4. Issue 起票候補 (Phase 5 closure に向けて)

| # | 内容 | 優先度 | 性質 | 推奨 PR 単位 |
|---|---|---|---|---|
| **I1** | F4 fix — `FocusLostDuringType` SSOT 登録 (SUGGESTS + classify、handler hard-coded suggest 削除、envelope shape contract pin 追加) | **High** | production code 改修 | 単独 PR、Opus + **Codex 必須** (CLAUDE.md §3.3 Step 0) |
| **I2** | F1 + F5 + F6 + F7 + F8 + F9 + F10 — description / caveats / examples 補強 (各 tool description 内 typed code 名 + verifyDelivery hint shape + recovery path の LLM 教育材料化) | Medium | docs only | 1 PR にまとめる、Opus 1+ round (Codex 推奨) |
| **I3** | F2 + F3 — cross-tool `ForegroundRestricted` recovery path 統一 wording (terminal / keyboard / mouse / focus_window 横断) | Medium | docs only | I2 と同 PR or 別 PR、cross-file consistency 軸 |

I1 のみ contract drift fix で immediate priority、I2 / I3 は v1.4 milestone の release readiness 判定材料として doc enrichment。

## 5. Phase 2a closure conditions (本 PR スコープ)

- [x] 15 actions × 4 doc 項目 audit 完了 (60 cell 全埋まり)
- [x] 不整合 list (F1-F10) を本 doc に永続化
- [x] 判定値 (pass / fix carry-over (doc gap) / fix carry-over (contract drift) / breaking change candidate / unverifiable accepted) 記入
- [x] Issue 起票候補リスト (I1-I3) 作成 + PR 単位 / 優先度提案
- [x] CLAUDE.md §3.1 multi-table fact 整合 sweep — `verifyDelivery hint shape` / `ForegroundRestricted typed code` / `BackgroundInputNotDelivered` 各 fact を matrix §3.1 / production code / SUGGESTS / classify / description で 5 view 整合確認

## 6. Out of scope (本 PR)

- production code 改修 (本 PR は docs only、F4 の SSOT fix も I1 として別 PR)
- 実機 scenario (Phase 2b、別 session、Plan §5 に従い `tests/integration/llm-audit/` か `docs/llm-audit/dogfood-scenarios/` で永続化)
- 28 tool 残 13 actions の commit 軸 audit (Phase 3、Plan §5)
- 11 tool query 軸 audit (Phase 4、Plan §5)
- F4 以外の typed code SSOT bit-equal sweep (Phase 2a で発見した F4 と同型 pattern が他 tool にあるかは Phase 3 / 4 で同 sweep)

## 7. Related Files

- Plan SSOT: `docs/llm-operation-audit.md` (Phase 1 起草、PR #210 で land)
- 規範 doc: `docs/operation-verification-matrix.md` §3.1 (Phase 3 SSOT)
- error code SSOT: `src/tools/_errors.ts` (SUGGESTS + classify + failWith + ROOT_HOISTED_KEYS)
- production code: `src/tools/{terminal,keyboard,mouse,scroll,scroll-*,clipboard}.ts`
- Phase 4 ADR (別 epic): #185
- Phase 3 closure 参考: PR #208

---

END OF Phase 2a Doc Audit Results.
