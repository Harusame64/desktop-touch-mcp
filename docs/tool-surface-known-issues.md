# Tool Surface Reduction — Known Issues & Phase Handoff

- 作成: 2026-04-25 (Phase 1 + Phase 2 完了時点)
- 目的: 各 Phase の懸念事項・引継ぎ事項を 1 箇所に集約。Phase 3 以降の設計書 §7 Known traps が参照する元となる。
- 関連: `docs/tool-surface-reduction-plan.md` (上位プラン) / `docs/tool-surface-phase{1,2}-*.md` (各 Phase 設計書)

---

## 1. Phase 1 完了時点の懸念事項 (PR #35 merged → main `2954e29`)

### 1.1. コメント内の旧名残留 9 箇所 (NIT、Phase 4 polish 候補)

LLM 非露出 (TS / jsdoc コメントのみ)、機能影響ゼロ。Phase 4 の docs polish で一括対応推奨:

- `src/server-windows.ts:195` — `// Anti-Fukuwarai v2: desktop_see / desktop_touch (opt-in)`
- `src/engine/uia-bridge.ts:401` — `// Focused element / element-at-point (for get_context & post narration)`
- `src/tools/desktop-constraints.ts:51, 74` — jsdoc 内 `desktop_see` / `desktop_touch`
- `src/engine/vision-gpu/backend.ts:36` — `// next desktop_see returns the same entities`
- `src/tools/desktop-executor.ts:2` — file header `// Route desktop_touch actions`
- `src/tools/desktop-providers/ocr-provider.ts:59` — `// next desktop_see returns the same entities`
- `src/tools/desktop.ts:156` — `// DesktopFacade — desktop_see / desktop_touch surface`
- `src/engine/world-graph/lease-ttl-policy.ts:42` — `/** view mode from desktop_see */`

### 1.2. E2E pre-existing flaky 2 件 (Phase 4b dogfood と同根)

本 PR (#35) 起因ではない、Phase 1 + Phase 2 で再現確認済:

- `tests/e2e/context-consistency.test.ts > C3: hasModal real dialog detection > hasModal:true and pageState:'dialog' when Save-As dialog is open`
  - 原因候補: Win11 で Notepad 新版 (MSStore UWP) が Save-As ダイアログの MODAL_RE にマッチしない (`feedback_notepad_launcher_msstore_hang.md`)
- `tests/e2e/rich-narration-edge.test.ts > B1: Chromium narrate:rich → chromium_sparse`
  - 原因候補: Chrome の `keyboard_press` フォーカス環境依存

**対応**: Phase 5 dogfood で再確認、または別 flaky 修正 PR で対応。

### 1.3. vitest unit 1 fail — `replay-backend.test.ts` (タイミングフレーキー)

Phase 1 では発生、Phase 2 では再現せず (2052 pass / 0 fail)。本 PR 起因ではない、別 PR で flaky 対策候補。

### 1.4. `desktop_state.attention` の HotTargetCache 依存 (B1 修正の実装詳細)

- `getSlotSnapshot()` 経由で hot-target-cache から focused HWND の attention を取得
- `SlotAttention → AttentionState` マッピング: `not_found → 'guard_failed'` / `ambiguous → 'ok'`
- Auto Perception OFF 時のデフォルト: `'ok'` (safe baseline §3.1)

**dogfood で要確認**: multi-monitor / virtual desktop / focus stealing で意図通り動くか、エッジケースで attention が誤検知しないか。

### 1.5. engine 層 LLM 露出 type の audit 体制 (Phase 4 引継ぎ)

Phase 1 では設計書 §9 Forbidden で「engine 層変更禁止」だったが、Opus レビューで **`SuggestedFix.tool` の literal type が LLM レスポンスに直接出力される** ことが判明し、例外条項を追加。Phase 4 で `events_*` / `perception_*` 入り口塞ぎ + `set_element_value` 吸収する際、engine 層に他の LLM 露出 type が残っていないか **事前 audit が必要**。

**audit コマンド** (Phase 4 着手時に実行):
```bash
grep -rn "browser_connect\|browser_click_element\|browser_fill_input\|browser_get_form\|browser_get_interactive\|browser_find_element\|get_context\|desktop_see\|desktop_touch\|engine_status\|keyboard_type\|keyboard_press\|clipboard_read\|clipboard_write\|pin_window\|unpin_window\|dock_window\|scroll_to_element\|smart_scroll\|scroll_capture\|terminal_read\|terminal_send" src/engine/
```

---

## 2. Phase 2 完了時点の懸念事項 (PR #36)

### 2.1. `run_macro` DSL の旧名 mapping (Phase 4 必須)

`src/tools/macro.ts:46-80` の `TOOL_REGISTRY` は run_macro DSL が受け付ける tool 名 mapping。Phase 2 では設計書 §2 Files to touch に含まれておらず、現在も旧名 (`keyboard_type` / `pin_window` / `clipboard_read` 等) が internal キーとして残っている。

**現状の挙動**:
- LLM が `run_macro({steps:[{tool:'keyboard_type', params:{text:'hello'}}]})` を呼ぶと動く (TOOL_REGISTRY が旧名を持っているため)
- LLM が `keyboard_type({text:'hello'})` を直接呼ぶと InputValidationError (公開ツール一覧にない)

**LLM 視点の混乱**:
- run_macro description の examples (line 220) で旧名 (`keyboard_type`) を使っている → LLM がこれを覚えて `keyboard_type` を直接呼ぼうとする → 失敗
- 整合性破れ

**Phase 4 で対応**:
- `TOOL_REGISTRY` を新 dispatcher 名 (`keyboard` / `clipboard` / `window_dock` / `scroll` / `terminal`) に移行
- `ToolEntry` 型を `z.ZodTypeAny` に拡張 (discriminated union 対応)
- run_macro examples を新 dispatcher 形式に書き換え (`{tool:'keyboard', params:{action:'type', text:'hello'}}`)
- breaking change として CHANGELOG に追記

### 2.2. `SuggestedFix.tool` literal type を `"keyboard"` に統一済 (情報共有)

Phase 2 の BLOCKING 修正 (`647498a`) で `SuggestedFix.tool` の literal を `"keyboard_type"` → `"keyboard"` に変更。今後 fix flow で type/press を区別する必要がある場合は `args.action` を見る。

現状 fix flow は type/press を区別しない (両方 `validateAndPrepareFix(fixId, "keyboard")` で受ける)。

### 2.3. Sonnet モデル選択ミス (Phase 2 incident、教訓)

Phase 2c (terminal `run` workflow 新規実装) と Phase 2d (LLM 露出文字列 audit) を Sonnet に委譲したのは判断ミスだった。

**経緯**:
- Sonnet は 2a/2b/2c の 3 commit を push 完了
- Phase 2d で詰まり、E2E を **4 回繰り返した** (memory `feedback_sonnet_e2e_twice_delegate.md` の 2 回上限ルール違反)
- 約 40 分浪費、ターミナルにログ残らず透明性ゼロ
- Opus が引き取って 2 commit (`647498a` + `891940a`) で短時間決着

**根本原因**:
1. 大規模 dispatcher 化 + 新規 workflow 実装は Sonnet には荷が重い (handbook §2 Step B 原則「判断系は Opus 直」を厳守すべきだった)
2. Stop condition の自律判断が不十分 — Pre-existing flaky 2 件を「Phase 2 起因」と誤判断
3. macro.ts が設計書 §2 Files to touch に含まれていなかった (Opus 設計時の audit 不足)

**Phase 3 以降の改善** (memory `feedback_sonnet_model_selection.md`):
- 判断系作業 (新規 schema / workflow / 外部 SDK 互換性確認 / 大規模 audit) は **Opus 直実装**
- Sonnet 委譲は機械的リネーム / lint 修正 / generator 再生成のみ
- 各 Phase 設計書 §10 サブ batch 分割で「機械的 / 判断系」をラベリング
- Phase 設計書 §7 Known traps に Pre-existing flaky リストを明記

### 2.4. Sonnet trace-ability 改善 (Phase 3 prompt template に組込予定)

memory `feedback_sonnet_trace.md` (新規予定) として、以下の仕組みで担保:

1. **作業ログファイル必須化** — `docs/phase{N}-sonnet-work-log.md` に逐次追記、各 sub batch / 各試行 / 各エラー / 各判断を時刻付きで記録
2. **チェックポイント commit + push 強制** — sub batch ごとに必ず commit + push (たとえ未完成でも WIP commit、remote に状態保全)
3. **時間 budget** — prompt に「max 45 分、超過時は WIP commit + 状況要約 + return」
4. **handbook §2 Step B 原則徹底** — Sonnet 委譲は機械的繰り返しのみ、判断系は Opus 直

### 2.5. engine 層 jsdoc 内の旧名 mention (Phase 4 polish)

Phase 1 §1.1 と同根、追加で Phase 2 関連:

- `src/engine/uia-bridge.ts:657` — `/** Only filled by smart_scroll */`
- `src/tools/desktop-constraints.ts:55,56,76,84` — jsdoc 内 `terminal_read` / `terminal_send`
- `src/engine/layer-buffer.ts:376,398` — `// Used by smart_scroll image path`
- `src/engine/ocr-bridge.ts:286` — `// Used by terminal_read OCR fallback`

LLM 非露出、Phase 4 docs polish で一括対応。

### 2.6. テスト出力ファイルが untracked で commit に含まれた可能性

`.vitest-out-e2e.txt` 等の test output が `git add -A` で誤って commit されている可能性。**.gitignore 強化推奨** (Phase 3 着手前に確認):

```
# .gitignore に追加候補
.vitest-out*.txt
.vitest-out*.json
```

---

## 3. Phase 3 完了時点の懸念事項 (実装済 — 2026-04-26)

### 3.1. 実装済内容

設計書 `docs/tool-surface-phase3-browser-rearrangement-design.md` (Status: Implemented) に従い:

- `browser_launch` → `browser_open({launch:{...}})` に吸収 (optional launch param、idempotent)
- `browser_get_dom` / `browser_get_app_state` → `browser_eval` discriminatedUnion (action='dom'|'appState') に吸収
- `browser_disconnect` 非公開化 (handler 残置、入り口削除のみ)
- LLM 露出文字列修正 (`_errors.ts` `BrowserNotConnected.suggest` / `desktop-state.ts` `get_document_state` description)
- `.gitignore` 強化 (`.vitest-out*.txt` / `.vitest-out*.json` ワイルドカード化、Phase 2 §2.6 引継ぎ)

公開面: 13 → 9 browser_* tools (-4)。

### 3.2. Phase 4 polish 候補 (LLM 非露出、Phase 4 で一括対応)

- `src/utils/launch.ts:4` のコメント `// Extracted from workspace.ts so that browser.ts (browser_launch) can ...` — Phase 4 で `browser_open` に書換
- `src/tools/browser.ts` 内のコメント (`browser.ts:64` / `:1462` / `:1755`) — 旧 tool 名言及、polish のみ
- `scripts/measure-tools-list-tokens.ts:38,45` — Tier 分類が pre-Phase 1 の旧名のまま (`get_context` / `keyboard_type` / `dock_window` / `browser_connect` / `browser_launch` / `browser_get_dom` / `browser_get_app_state` / `browser_disconnect` 等)。ad-hoc 計測スクリプトで LLM 非露出。Phase 4 で一括 refresh または削除候補

### 3.3. registry-lru.test.ts 全 unit suite 実行時の test-isolation 失敗 (Phase 3 と無関係)

- 症状: `npm run test:capture` 全 unit suite で `tests/unit/registry-lru.test.ts` の 5 ケースが `Error: Window not found matching titleIncludes: "TestWindow"` で fail
- 単独実行 (`npx vitest run --project=unit tests/unit/registry-lru.test.ts`) では 5/5 passing
- 原因: 別 unit テストが `vi.mock("../../src/engine/win32.js", ...)` の mock を leak/破壊している可能性 (vitest module mock 分離問題)
- Phase 3 の browser 系編集は perception/registry に触っていないため本 PR と無関係
- Phase 4 で test 分離確認 (vitest config の `isolate: true` 確認、または問題のあるテストの mock 解除順を見直す)

### 3.4. browser_disconnect facade 化判断 (Phase 5 dogfood)

- 現状: server.tool 登録削除 + handler internal export 残置
- engine 層の自動 cleanup (process 終了時 `disconnectAll`) で実用上の問題なし想定
- Phase 5 dogfood で接続リーク有無を確認、問題あれば facade として復活 (Phase 4 または別 PR)

### 3.5. instructions text の browser section 追加見送り

- 設計書 §3.5 の判断: Phase 3 では追加しない
- Phase 5 dogfood で実機 LLM の迷い度を観察してから判断
- 早期追加すると後で削るときに breaking になりやすい

### 3.6. Phase 3 で対応した Phase 1+2 残課題

- §2.6 `.gitignore` 強化 (実施済)
- §1.5 engine 層 LLM 露出 type の audit (browser 系で実施、`_errors.ts` / `desktop-state.ts` の修正で完了)

### 3.7. Phase 1+2 残課題 (Phase 4 に再持越し)

- §1.1 / §2.5 コメント内旧名 (`desktop_see` / `desktop_touch` / `smart_scroll` / `terminal_read` 等) — Phase 3 では browser 関連のみ部分対応、その他は Phase 4 で一括 polish

---

## 4. Phase 4 完了時点の懸念事項 (実装済 — 2026-04-26)

### 4.1. 実装済内容

設計書 `docs/tool-surface-phase4-privatize-absorb-design.md` (Status: Implemented) に従い、stub catalog 46 → 26 entries (-20):

- **入り口削除 10**: `events_*` 4 + `perception_*` 4 + `get_history` + `mouse_move` (handler / schema / engine 層は internal export 残置)
- **screenshot 吸収 3**: `mode='background'` (former `screenshot_background`) / `detail='ocr'` + `ocrLanguage` (former `screenshot_ocr`) / `region` (former `scope_element` after `desktop_discover` exposes element bounds)
- **desktop_act 吸収 1**: `action='setValue'` (former `set_element_value`)
- **desktop_state include* 拡張 4**: `focusedWindow` (former `get_active_window`) / `includeCursor` (former `get_cursor_position`) / `includeDocument` (former `get_document_state`) / `includeScreen` (former `get_screen_info`)
- **desktop_discover response 確認 2**: `actionable[]` (former `get_ui_elements`) / `windows[]` (former `get_windows`)
- **run_macro DSL TOOL_REGISTRY 移行**: pre-Phase-1 名を v1.0.0 dispatcher 名に統一 (Phase 2 §2.1 引継ぎ)
- **コメント polish 16+ 箇所**: Phase 1 §1.1 / Phase 2 §2.5 / Phase 3 §3.2 引継ぎ
- **measure-tools-list-tokens.ts Tier refresh**: Phase 3 §3.2 引継ぎ
- **LLM 露出文字列 audit**: Phase 4 contract test に allowed-context 検出付きで組込 (`former X` migration breadcrumbs / `failWith` handler tags / error template literals)

公開面: stub catalog 26 + dynamic v2 (`desktop_discover` / `desktop_act`) 2 = **28 public tools**。

### 4.2. Phase 5 dogfood に持ち越す確認事項

- **multi-monitor / virtual desktop での `desktop_state.includeScreen=true`** — monitor info の正確性 (Phase 1 §1.4 carryover)
- **`desktop_act({action:'setValue'})` の UIA ValuePattern 失敗時の挙動** — suggestedFix の提示等
- **`screenshot({detail:'ocr'})` の OCR 言語自動判定** — Phase 4 では明示 `ocrLanguage` のみ
- **`mouse_move` 削除後の hover 系 UI 影響** — facade 復活判断
- **`events_*` / `perception_*` 削除後の代替動線** — `wait_until` で全部カバーできるか
- **Pre-existing flaky 2 件** (Phase 1 §1.2 carryover):
  - `tests/e2e/context-consistency.test.ts` C3 (Save-As dialog 検出 — Win11 MSStore Notepad)
  - `tests/e2e/rich-narration-edge.test.ts` B1 (Chromium narrate:rich)
- **`registry-lru.test.ts` test-isolation flake** (Phase 3 §3.3 carryover) — vitest `vi.mock` leak

### 4.3. v1.0.0 release smoke test (Phase 5)

- 別マシンで `npx -y @harusame64/desktop-touch-mcp` → tools/list が 28 ツール
- run_macro DSL: 旧名 → fail / 新名 → OK を確認
- Glama listing / MCP Registry 更新

---

## 5. Phase 5 dogfood で要確認事項

### 5.1. `desktop_state.attention` の実機動作 (§1.4)

- Multi-monitor 環境で focused HWND の attention が正しく取得されるか
- Virtual desktop 切替時の attention 更新タイミング
- Focus stealing 発生時の `'guard_failed'` 検出

### 5.2. terminal `run` workflow (Phase 2 §4)

- 5 つの completion reason (`quiet` / `pattern_matched` / `timeout` / `window_closed` / `window_not_found`) が全部実機で発火するか
- Polling logic (200ms 間隔) で window_closed 検出が race condition で失敗しないか
- 長時間 command (build 等、10 分超) で `until.timeoutMs` が正しく機能するか

### 5.3. E2E pre-existing flaky 2 件 (§1.2)

dogfood 中に再現するか、再現条件は何か。MSStore Notepad 関連 (`feedback_notepad_launcher_msstore_hang.md`) との関連性。

### 5.4. v1.0.0 release smoke test

- npm 公開 → 別マシンで `npx -y @harusame64/desktop-touch-mcp` → tools/list が新 dispatcher のみ返すこと
- run_macro の旧名 DSL (Phase 4 で更新前なら) が動くこと
- Glama listing / MCP Registry の更新

---

## 6. Phase 横断の運用ルール

### 6.1. handler 残置方針 (memory `feedback_disable_via_entry_block.md`)

ツール非公開化時、`server.tool(...)` 登録のみ削除、handler / engine 層 / unit test は残置。実装資産の温存と attack surface 縮小の両立。

### 6.2. E2E 2 回目で Opus 委譲 (memory `feedback_sonnet_e2e_twice_delegate.md`)

Sonnet が E2E を 2 回以上回したら必ず Opus 委譲。1 回目失敗時点で Opus 相談、再実行可否は Opus 判断。

### 6.3. モデル選択ルール (memory `feedback_sonnet_model_selection.md`)

判断系作業は Opus 直実装、Sonnet 委譲は機械的繰り返しのみ。Phase 設計書 §10 サブ batch 分割で「機械的 / 判断系」をラベリング。

### 6.4. LLM 露出文字列 audit (Phase 1+2 教訓)

Phase 完了前に必ず以下を grep audit:
- `description` / `suggest[]` / `error.message` / `failWith(err, "tool_name", ...)` の第 2 引数 / engine 層の `literal type` (例: `SuggestedFix.tool`)

コメント (`/** */` / `//`) は LLM 非露出なので Phase 4 polish で OK。

### 6.5. v1.0.0 までは alias なし即破壊 (`tool-surface-reduction-plan.md` §16.1)

各 Phase で旧名は完全削除、deprecation alias は作らない。breaking change として CHANGELOG に逐次追記。

---

## 7. 改訂履歴

- 2026-04-25 (Phase 1 + Phase 2 完了): 初版作成。Phase 3-5 への引継ぎ事項を集約。
