# Changelog

## [Unreleased]

### Added

- **`method: 'foreground_flash'` channel for `keyboard:type` / `terminal:send` (ADR-013 v1.4 / Option E、本 PR).** Windows Terminal (`CASCADIA_HOSTING_WINDOW_CLASS`) は WinUI/XAML pipeline で `WM_CHAR` を silent drop するため、issue #173 で `method: 'background'` 経路から WT を除外していた (v1.3.2、PR #174)。本 PR で **明示 opt-in な妥協 BG path** として `method: 'foreground_flash'` channel を追加、WT を含む WM_CHAR 不対応 window への BG injection を offer。
  - **仕組み (~50-80ms 全体所要時間)**: native `win32_foreground_flash_inject` (Rust) が pre-flight validation (改行禁止 + UTF-16 < 5KiB)、hidden owner window (`DTM_ClipboardOwner`) で clipboard を 3 point sequence で save、`SetClipboardData(CF_UNICODETEXT)` で text を inject、foreground steal ladder (段 1 `AttachThreadInput` → 段 2 `Alt unlock` → fail で `foreground_steal_denied`)、`GetGUIThreadInfo` で focus-ready polling (max 30ms)、`SendInput(Ctrl+V)`、optional `SendInput(VK_RETURN)` (text と分離して `multiLinePasteWarning` 構造的回避)、foreground restore ladder + verify (max 2 retry)、3 point sequence で clipboard race 検出 → restore-or-skip、UIA `Microsoft.UI.Xaml.Controls.ContentDialog` scan (max 100ms、検出時 Esc + `wt_paste_warning_intercepted`)。
  - **Channel resolver**: 新 `src/engine/background-channel-resolver.ts::resolveBackgroundInputChannel(hwnd, opts)` が `BackgroundInputChannel` discriminated union (`wm_char` / `clipboard_flash` / `cooperative_bridge` / `unsupported`) を返却、caller が `allowedChannels` で channel 許可 set を明示。`canInjectViaPostMessage` は **touch せず**、WT は引き続き `{supported: false, reason: "wt_xaml_pipeline"}` を返す (= `background` 契約 不変原則、§4.1)。
  - **Hints (`hints.backgroundChannel`)**: `"clipboard_flash"` (WT XAML 経路) / `"wm_char"` (terminal-class target は resolver が picking、無駄 steal 回避)。clipboard_flash 経路では `typingLeakRisk: true` + `typingLeakMitigation: "userTypingDuringFlashMayLeakToWT"` + `flashDurationMs` + `foregroundStealMethod` (`AttachThreadInput` / `alt_unlock` / `already_foreground`) + `foregroundRestored` + **`foregroundRestoreMethod`** (`AttachThreadInput` / `alt_unlock` / `none`、Round 1 P1-2 で steal 側と対称化) + `clipboardRestored` + `clipboardSkippedFormats[]` (非 HGLOBAL 系 = 画像 / メタファイル等は復元不可 → caller に明示)。
  - **Typed reasons** (8 種、Round 1 P1-3 で `input_contains_newline` を追加し改行と size を分離): **`input_contains_newline`** (改行 LF/CR 含、suggest = 改行除去 + 分割 inject) / `input_exceeds_paste_warning_threshold` (UTF-16 >= 5KiB、suggest = 分割 inject) / `foreground_steal_denied` / `focus_wait_timeout` / `clipboard_lock_contention` / `foreground_restore_failed` / `wt_paste_warning_intercepted` / `send_input_failed`。`docs/operation-verification-matrix.md` §4.3 に 8 reason 追加 (SSOT)。`keyboard:press` で `method: 'foreground_flash'` を渡すと `ForegroundFlashNotApplicableToKeyPress` で早期 reject (key combo paste は semantics 不一致)。
  - **Options + env**: `block_keyboard_during_flash: false` (default、env `DESKTOP_TOUCH_FOREGROUND_FLASH_BLOCK_KEYBOARD=1` で global ON、LowLevel keyboard hook で flash 中の keystroke を block して typing leak risk mitigation、Alt+Tab 等も block するため default OFF)、`scan_paste_warning_dialog: true` (default、env `DESKTOP_TOUCH_FOREGROUND_FLASH_DISABLE_DIALOG_SCAN=1` で OFF)、`max_focus_wait_ms: 30`、`foreground_restore_retries: 2`、`press_enter: false` (`keyboard:type`) / `pressEnter` 透過 (`terminal:send`)。
  - **Files**: native (`src/win32/foreground_flash.rs` + `clipboard_snapshot.rs` + `kbd_hook.rs` + `wt_dialog_scan.rs`、Phase 1f unit test 14 pass + 4 ignored 副作用 manual)、TS engine (`src/engine/background-channel-resolver.ts` + `bg-input.ts::injectViaForegroundFlash`)、tools (`src/tools/keyboard.ts` / `terminal.ts` で Zod schema + handler branch)、E2E (`tests/e2e/foreground-flash-verification.test.ts`、6 case + 5 todo)、bench (`benches/adr013_foreground_flash_ladder.mjs`、Phase 2 mandatory gate 用 50 連続 ladder success rate 計測)。
  - **Breaking change なし**: 既存 `method: 'background'` の WT 不対応は維持、`method: 'foreground'` も touch せず、新 channel は明示 opt-in のみ。silent-success 構造的回避 (issue #173 が motivate した invariant) は不変。
  - **plan**: `docs/adr-013-option-e-impl.md` v3 (実装 plan 全 phase 詳細)、ADR-013 v1.4 §3.5 (本 channel) / §3.6 (Option F cooperative bridge outline、長期本命候補、別 PR / 別 ADR)。

### Fixed

- **F4-bis ValuePattern fallback gate hybrid (b)+(c)-light land (PR #235).** §F4-bis Resolved 化。`src/tools/keyboard.ts:741` で `valueBaseline` 常時保持 + `if (verifiable)` 内 2nd-defense VP delta layer 追加 (TP slicing が `unverifiable` 確定時に valueBaseline + post-VP delta で `delivered` 判定)。`src/engine/uia-bridge.ts` `getTextViaTextPattern` で score-0 候補 strict drop (Window/MenuItem/Title/Button 等を除外、Custom score 2 は WT/conhost 温存で regression なし)。`tests/unit/phase7-f4-value-pattern-fallback.test.ts` に dual-stage flow 9 case 追加 (合計 19/全 pass)。v1.4.2 release で Win11 New Notepad の `keyboard:type method:'background'` が `delivered` を返却するようになる予定 (実機 dogfood Step 1 で確認後 Closed 昇格)。

### docs

- **Phase 6 dogfood F4 re-open + §F4-bis 起票 (PR #234).** v1.4.1 dogfood Step 1 (Win11 New Notepad、`keyboard:type method:'background'`) で `hints.verifyDelivery.status === "unverifiable"` が再現、PR #233 の ValuePattern fallback path が gate 条件不足で実機 dead path 化していることが判明。`docs/llm-audit/phase6-dogfood-findings.md` の F4 を **Re-opened** に更新、§F4-bis に実機証拠 + 7 step root cause + 4 候補 (a/b/c/d) + Opus 諮問結果 (推奨 Hybrid (b) + (c)-light) + 9 verification gate + 8 unit test pin + 4 carry-over OQ を永続化。**v1.4.1 リリース時の F4 Fixed claim は実機未達成、本 hotfix が land するまで Win11 Notepad の BG type は `unverifiable` を返していた → 本 [Unreleased] PR #235 で `main` 上は解消済**。Phase 5 北極星「silent-success / contract drift = 0」の F4 entry は v1.4.2 release で完全達成扱い。

## [1.4.1] - 2026-05-09 — Phase 7 carry-over (F3 SpawnFailed + F4 ValuePattern fallback + ADR-010 §5.4 catalog reconcile + F5 scenario doc)

> **2026-05-10 追補**: 本 release で `delivered` 返却を claim した F4 ValuePattern fallback (PR #233) は v1.4.1 dogfood Step 1 で gate 条件不足が露呈、Win11 New Notepad の実機経路では発火せず `unverifiable` を維持することが判明。詳細・修正方針は `docs/llm-audit/phase6-dogfood-findings.md` §F4-bis (PR #234)、hotfix は **v1.4.2 candidate (PR #235 main land 済、release 待ち)**。本 release の F3 / F5 / catalog reconcile は影響なし。

epic #211 Phase 6 dogfood で発見した carry-over findings 4 件を patch release で全消化。Phase 6 PR-A/PR-B が typed code dictionary を整理した直後の dogfood 実機検証で見つかった silent-success / contract drift / docs SoT divergence を解消し、production code の typed code 体系を 38 codes (live) + 12 ADR-added = **50 codes** で完全 sync。

### Added

- **`SpawnFailed` typed code (Phase 7 F3、PR #232).** `workspace_launch` (および `browser_open` 等他の `spawnDetached` caller) で OS 拒否 (ENOENT / EACCES / EPERM / 他) が generic `ToolError` に fall through していた silent typed-code gap を解消。`src/utils/launch.ts` で `new Error(\`SpawnFailed: ...\`)` を inline literal で投げ、`_errors.ts::classify()` が typed enum に昇格 + 5 SUGGESTS hints (full path / permission / elevation / built-in commands / Windows policy) を提供。agent flow が typed code 経由 retry pattern を構成可能。`tests/unit/issue-211-classify-branch-producer-pin.test.ts` (§4.bis CI sweep) が新 branch の producer を機械検出。
- **`getTextViaValuePattern` UIA helper + keyboard:type BG ValuePattern fallback (Phase 7 F4、PR #233).** Win11 New Notepad の RichEditD2DPT 等 ValuePattern-only な focused element で TextPattern 失敗時に `verifyDelivery: 'unverifiable / read_back_unsupported'` で degrade していた contract 弱点を解消。`src/engine/uia-bridge.ts` に新 helper、focused element の `ValuePattern.Value` を返す PowerShell-backed 関数 (TreeWalker scoping で focused が target window 内に居ることを確認)。`src/tools/keyboard.ts` BG type path で TextPattern + ValuePattern baseline を `Promise.all` で並列取得し、cold path causal window を sum → max に短縮。delta 比較 (`postValue.includes(checkText)` AND (`delta > 0` OR `!baseline.includes(checkText)`)) で delivered 判定、両者一致+長さ不変は false-positive 防御で `unverifiable` 維持。matrix doc §3.1 line 140 の forward-looking 記述 "TextPattern / ValuePattern read-back" が initial alignment 達成。

### Changed

- **ADR-010 §5.4 typed enum catalog full reconcile (Phase 7、PR #231).** Phase 6 PR-A Round 3 で発見された ADR catalog (subset 23 codes baseline) と live `_errors.ts` SUGGESTS dictionary の数値乖離を解消、live SSOT を bit-equal で吸収。累積 14 entries (post-issue #178/#179/#180/#181/#197/#207 + Phase 5 I1 + Phase B B-1〜B-4) を `// Browser` / `// Wait scroll` / `// 入力チャネル` 既存 section + `// Cognitive memory` 新 section に配置。本 v1.4.1 land 時点で **catalog 38 + ADR 12 = 50 codes**。cascade 8 docs (adr-007 / adr-011 main+phase-b / adr-010-p1-s3/s4/s6 / walking-skeleton trunk-selection+expansion-plan) で `35→50 codes` / `残 36→残 49` を全 17 occurrences sync、catalog drift invariant 維持の仕組み確立 (CLAUDE.md §3.1 fact 整合 sweep の lesson 反映)。
- **launcher-macro.md §1.1 dogfood scenario doc fix (Phase 7 F5、PR #230).** `notepad.exe` (Win11 New Notepad は multi-instance) → `chrome.exe` (truly single-instance) に変更。`§3` 末尾共通 note との fact 整合 + 「対象 app の選定」subsection 新設で truly single-instance / multi-instance の区別を明示、§1.3 にも multi-instance Notepad 適合 note を追加 (順読時の見かけ矛盾解消)。production behavior は不変、scenario doc の SoT outdated を解消。

### docs

- `docs/llm-audit/phase6-dogfood-findings.md` の F1〜F5 全 entries を **Status: Fixed** で履歴 lock。F1/F2 は v1.4.0 release 内 (PR #229)、F3/F4/F5 は本 v1.4.1 release で消化、F3 + F4 は production code 改修 + 10/6 unit case で contract pin。
- `docs/adr-010-followups.md` を **Status: Resolved** に更新、§3 各 subsection に **✓ Done** mark + Phase 7 fix narrative + cascade 9 docs sync 履歴 (catalog SSOT 本体 1 doc + cascade 8 docs)。

## [1.4.0] - 2026-05-09 — Phase 6 closure + run_macro silent-success fix + dogfood release gate

epic #211 Phase 6 closure を release に lift up。Phase 5 で達成した北極星 (silent-success / contract drift = 0) を Phase 6 で **typed code 体系の整理 + dogfood で発見した run_macro contract drift fix** で完全達成。**dogfood pass を release gate に格上げ** (v1.3 教訓、強制命令 7 仕組み化)。

### Added

- **AutoGuardBlocked typed code (epic #211 Phase 6 PR-B 6-4、PR #228).**
  14 emit sites (browser_click / browser_eval / browser_navigate / mouse_click / mouse_drag / keyboard / click_element / set_element_value / withActionGuard 共通 wrapper) で envelope `code` 値が `"ToolError"` → `"AutoGuardBlocked"` に昇格。`AutoGuardStatus` enum 9 値 (ambiguous_target / target_not_found / blocked_by_modal / browser_not_ready / needs_escalation / identity_changed / unsafe_coordinates / ok / unguarded) に応じた SUGGESTS 7 entries を提供、LLM agent が auto-guard refusal の status enum と 1:1 で recovery action を選択可能。`error.message.startsWith("AutoGuardBlocked:")` への依存は format 不変で継続動作。
- **`run_macro` `warnings[]` top-level field (Phase 6 F2、PR #229).**
  `stop_on_error: false` で全 step 実行時、nested step ok:false の `{step, tool, code?, error}` を summary 直下に集約。LLM caller が `text[0]` を JSON.parse せずに partial failure を catch 可能。failure ゼロ時は field 不在で backward compat 維持。
- **dogfood scenarios (`docs/llm-audit/dogfood-scenarios/*.md`).** 7 scenario file (browser-tier2 / clipboard / keyboard / launcher-macro / mouse / scroll / terminal) を Tier 1/2 軸で永続化、release gate として `docs/release-process.md` Preflight section に組込。

### Changed

- **`run_macro` `stop_on_error: true` が tool inner ok:false envelope で halt するよう契約 honor (Phase 6 F1 北極星違反 fix、PR #229).**
  Before: handler が exception を投げない限り step-level `ok:true`、`text[0]` 内 `ok:false` envelope を parse する path 不在 → silent-success drift。After: `JSON.parse(textLines[0])` で safely parse、`parsed.ok === false` で step-level に伝播 + `stop_on_error: true` で `break`。silent state corruption (e.g. focus_window 失敗後の keyboard:type 誤入力) 解消。matrix §3.1 line 157 規範整合。
- **browser_eval / browser_navigate description sync (PR #228).** typed code direct 言及形に更新、旧 `envelope code は ToolError` 記述廃止、`code:'AutoGuardBlocked'` を recovery hint と共に明示。
- **dogfood pass を release gate に格上げ (`docs/release-process.md` Preflight、v1.3 教訓).** Step 1 smoke (~5min) / Step 2 Phase-N-fix path (~20min) / Step 3 Tier-1 north-star (~30-60min) / Step 4 Tier-2 carry-over (~15min) を release 必須プロトコルとして codify。F1 (run_macro silent-success drift) を canonical case study として位置付け、「automated test + doc audit では catch 不能」教訓を仕組み化。

### Removed

- **3 dead typed codes from `_errors.ts` (epic #211 Phase 6 PR-A、PR #227).** `LensBudgetExceeded` / `TerminalMarkerStale` / `MaxDepthExceeded` を classify+SUGGESTS dictionary から削除 (production producer 不在を Phase 5 §4.bis CI sweep で確認済、Phase 6 で structural cleanup)。`tests/unit/issue-211-classify-branch-producer-pin.test.ts` `DEAD_ALLOW_LIST` は空 Set 化、今後同型 dead code drift は CI で構造的に block。

### Fixed (carry over from accumulated [Unreleased])

- **fix(terminal,keyboard): WT explicit BG (`method:'background'`) を Strict fail に揃える (issue #195).**
  `terminal({action:'send'})` と `keyboard({action:'type'})` の `method:'background'` で、Windows Terminal を target にしたときの silent ok:true / 不整合な error code を解消。matrix doc §3.1 line 140 + §4.3 (`wt_xaml_pipeline → BackgroundInputNotDelivered` Strict fail) 整合。
  - **`src/tools/terminal.ts`**: `useBg` 分岐の入口で `canInjectViaPostMessage` を確認、`reason === "wt_xaml_pipeline"` のとき `BackgroundInputNotDelivered` を early return。post-send UIA read-back が WT XAML buffer の noise で `sliced.matched=false` → `verifiedDelivery="unverifiable"` ですり抜け silent ok:true を返していた既存 regression を解消。`chromium` / `uwp_sandboxed` / `class_unknown` reason は既存 `BackgroundInputUnsupported` 契約 (`browser_fill` 案内 suggest) を維持。
  - **`src/tools/keyboard.ts`**: 既存 `BackgroundInputUnsupported` early reject を reason 分岐化。`wt_xaml_pipeline` のみ `BackgroundInputNotDelivered` で `keyboard:type BG WT` を terminal:send BG WT と同 code に揃える (matrix §3.1 SSOT)。他 reason は既存 suggest contract 維持。
  - **`tests/e2e/keyboard-bg-verification.test.ts:88`**: `[Windows Terminal] type BG > returns BackgroundInputNotDelivered` の expected が **PR #174 land 後の現挙動と乖離**していた問題を解消 (PR #188 land 時の同期漏れ、PR #192 launcher fix で顕在化)。
  - 影響範囲: caller-facing で WT 経路の error code が `BackgroundInputUnsupported` → `BackgroundInputNotDelivered` に変わる (matrix doc §3.1 SSOT 通り)。`browser_fill` recovery が必要な chromium 経路は既存 `BackgroundInputUnsupported` のまま。

### Changed (carry over from accumulated [Unreleased])

- **feat(terminal): `terminal({action:'send', method:'background'})` に hidden-input prompt 自動検出を追加 (issue #183, Phase 3).**
  `docs/operation-verification-matrix.md` §3.1 (terminal action:send BG row) で「将来 detect」と予約されていた挙動の本実装。post-send UIA read-back の直前に baseline UIA 末尾行を検査し、`/(password|passphrase|secret|sudo)[\s:]*$/i` / `/Password for /` / `/^>\s*$/` のいずれかにマッチする echo 抑制 prompt なら verification を skip し、`hints.verifyDelivery: {status:"unverifiable", reason:"hidden_input_prompt", channel:"wm_char", fallback:"method:'foreground'"}` (matrix doc §4.2 規範 shape, §4.3 reason enum) を付けて `ok:true` を返す。これにより `Read-Host -AsSecureString` / `sudo` / `ssh` パスワード入力 BG 送信が `BackgroundInputNotDelivered` の false-positive で失敗していた既知問題を解消。regex set は意図的に narrow（end-anchor 必須）で start するため、scrollback 中に password と書かれていても誤検出しない設計。
- **feat(browser): CDP `browser_click` / `browser_fill` に DOM 配信検証を追加 (issue #181, Phase 3).**
  `docs/operation-verification-matrix.md` §3.1 規範実装。
  - `browser_click`: クリック直前に `Runtime.evaluate` 経由で `MutationObserver(document.body, {subtree, childList, attributes})` を install → mouse click → 500ms 経過後に observer + URL + `document.activeElement` の差分を読み戻し。いずれかの signal が観測できれば `hints.verifyDelivery.status = "delivered"`、500ms で 0 signal なら `unverifiable` (reason: `no_dom_mutation`)。SPA ボタンに event listener が attach されていない silent-fail を catch する目的。selector が iframe 内 element だった場合は top-frame の Runtime.evaluate scope では観測不能なので `unverifiable` (reason: `iframe_context_mismatch`) を返す。
  - `browser_fill`: fill dispatch 後に `el.value` を read-back して要求値と完全一致するか確認。不一致時は `BrowserFillNotDelivered` で fail。React/Vue controlled input が onChange で値を変換した場合（numbers-only filter / max-length / format mask 等）は false-positive 候補なので、actual length が requested length 以下なら `subReason: "controlled_input_transform"`、そうでなければ `value_not_retained` を `hints.verifyDelivery.subReason` で明示。caller は actual を authoritative として読めば retry 不要なケースを区別できる。

### Added (carry over from accumulated [Unreleased])

- **新 typed error code: `BrowserClickNotDelivered` / `BrowserFillNotDelivered` (`src/tools/_errors.ts` SUGGESTS + classify()).**
  `docs/operation-verification-matrix.md` §5.2 の命名規則に従う。`BrowserClickNotDelivered` は現行実装では fail として返さず `unverifiable` hint で表現するが（OS 層では click が dispatch 済 = ack 成功なので fail に escalate しない方針）、SUGGESTS dictionary は将来の strict 化に備えて登録。`BrowserFillNotDelivered` は read-back 不一致で確実に fail を返す。
- **`hints` を `_errors.ts:ROOT_HOISTED_KEYS` に追加.** typed delivery code でも success path と同じ位置に `hints.verifyDelivery` を配置するため。
- **e2e: `tests/e2e/browser-cdp-verification.test.ts` 新規.**
  - probe primitive (install + read) は headless で動く。
  - `browser_click` 完全 path は nut-js 物理マウス必須なので `HEADED=1` gate で skip 可。
  - `browser_fill` は CDP のみで完結するので headless でも regression guard 可能。

## [1.3.2] - 2026-05-08 — Windows Terminal silent fail in terminal/keyboard BG path

v1.1.0 以降 約 11 日間 production にあった regression の修正。Windows
Terminal を「既定のターミナルアプリ」にしている環境で `terminal({action:'send'})`
が **silent fail** していた（PostMessage は OS 層で成功するが Windows Terminal
の WinUI/XAML 入力 pipeline が `WM_CHAR` を消化せず、ハンドラは `ok:true` を
返すが実際には何も入力されない）。E2E test は skip-on-failure path で silent
pass していたため CI で検知されなかった。

### Fixed

- **fix(bg-input): Windows Terminal を `WM_CHAR` fast-path から除外（issue #173）.**
  `TERMINAL_WINDOW_CLASSES` から `CASCADIA_HOSTING_WINDOW_CLASS` を削除し、
  `canInjectViaPostMessage` で WT クラスと `WindowsTerminal.exe` プロセス名を
  非対応扱い (`reason:"wt_xaml_pipeline"`) に分類。これにより
  `terminal({action:'send', method:'auto'})` および
  `keyboard({action:'type'/'press', method:'auto'})` で WT を target にした
  場合は自動的に foreground (clipboard paste) 経路にフォールバックする。
- **fix(terminal): BG path に post-send UIA read-back delivery 検証を追加.**
  WM_CHAR 送出後に少 delay → UIA TextPattern で再読 → diff (since baseline) に
  入力文字列が含まれていない場合 `BackgroundInputNotDelivered` で fail。
  `method:'background'` を明示要求した場合（auto-route から外れた未知の terminal
  でも）silent ok:true は返さない構造に変更。Enter は delivery 検証後にのみ
  送る。
- **fix(changelog): v1.1.0 Phase A の "terminal-class auto-route to HWND-targeted
  WM_CHAR" 記述に補正を追加** — Windows Terminal はこの auto-route から外れる
  旨を明記。

### Changed

- **behaviour: `terminal({action:'send'})` が WT 環境で foreground 経路に変わる.**
  これは bug fix だが behavior change でもある。`method:'background'` を強制指定
  していた呼び出しは、target が WT の場合 `BackgroundInputNotDelivered` で失敗
  するようになる（旧来は嘘の `ok:true` を返していた）。caller は
  `method:'foreground'` または `method:'auto'` に切り替えるか、conhost を既定
  ターミナルにすること。

### Known limitations

- **`method:'background'` で **echo 抑制 prompt** に送ると false-positive する.**
  `sudo` / `ssh` のパスワード入力、`Read-Host -AsSecureString` 等は WM_CHAR を
  受信してもターミナルに表示しない。post-send UIA read-back は echo を見て
  delivery を判定する設計のため、このようなケースは正常な BG 送信でも
  `BackgroundInputNotDelivered` を返す。`SUGGESTS.BackgroundInputNotDelivered`
  の最終行で false-positive 原因として明記、回避策は `method:'foreground'`
  への切替（SendInput はキー event を直接注入するので echo の有無に依存しない）。
  自動検出は別 issue (Phase 3 の operation-verification-matrix) で扱う。
- **public schema: `terminal({action:'run'})` の `completion.reason` enum に
  `send_failed` を追加.** alive な window で send 自体が失敗した時（典型例:
  `method:'background'` 強制で `BackgroundInputNotDelivered` を引いた case）
  に返る。旧コードは同状況を `window_not_found` に誤分類していた。`warnings`
  には基底 error code が付随する (`terminal(action='send') failed: <code>`)
  ので caller はそこで分岐できる。tool description (caveats) と
  `stub-tool-catalog.ts` も同期。

### Tests

- **test(e2e): `[conhost, WindowsTerminal]` parameterized matrix を `tests/e2e/terminal.test.ts` に追加.**
  既存の skip-on-failure path を product invariant 違反では fail させる構造に
  変更し、env 起因 skip は `ForegroundNotTransferred` warning に限定。WT 専用
  ケースとして `method:'background'` 強制 → `BackgroundInputNotDelivered` を
  pin、conhost 専用ケースとして BG path の正常成功を pin。
  - **WT host scenario は `DTM_E2E_WT=1` 指定時のみ実行（opt-in）.** デフォルト
    で WT host を回さない理由: launcher 経由で spawn された PowerShell が
    既存 WT インスタンスにタブ attach され、cleanup の `taskkill /T` が
    ユーザの WT process tree 全体を巻き込んだ事故が発生（2026-05-08）。
    launcher の kill path は `/T` を外して PID 単発に hardening 済みだが、
    WT 単一プロセス・複数ウィンドウ仕様への独立した isolation 整備までは
    opt-in に留める。WT の非対応化自体は unit test (`canInjectViaPostMessage`
    の `wt_xaml_pipeline` 分類 + `keyboard-method-resolution.test.ts`)
    と conhost 側 E2E でカバー。
- **test(unit): bg-input.test.ts と keyboard-method-resolution.test.ts の
  WT 期待値を反転.**

## [1.3.1] - 2026-05-08 — discriminatedUnion ツール 6 件の parse 全失敗を修正

v1.3.0 で **`keyboard` / `clipboard` / `window_dock` / `scroll` / `terminal` /
`browser_eval` の 6 tool が引数の中身に関わらず "Invalid discriminated union
option at index 0" で全失敗** していた production bug を修正する patch
リリース。`include` API 自体や CoALA 4 layer memory には影響なし、それ以外の
22 tool は v1.3.0 と同じ挙動。

### Fixed

- **fix(envelope): resolve discriminator via `_def` for Zod v4 (#171, #172).**
  v1.3.0 直前の dependabot PR #153 が `zod` を 4.3.6 → 4.4.3 に bump した結果、
  `ZodDiscriminatedUnion.discriminator` の public field が `_def.discriminator`
  配下に移動した。`src/tools/_envelope.ts` の `withEnvelopeIncludeForUnion` が
  旧 path のまま `union.discriminator` を読み続け、v4 では `undefined` を
  `z.discriminatedUnion(undefined, options)` に渡してしまう結果、6 tool 全部の
  registration schema が parse 時に discriminator を解決できず、どの variant に
  も dispatch できなくなっていた。`_def.discriminator ?? union.discriminator` の
  二段アクセスに変更し、Zod v3 / v4 両対応かつ将来の major bump で同型 silent
  breakage が再発した場合は明示的に throw する。
- **test: registration-schema parse の回帰テストを 6 tool 分追加.**
  `tests/unit/envelope-discriminated-union.test.ts` を新設、
  `keyboard` / `clipboard` / `window_dock` / `scroll` / `terminal` /
  `browser_eval` の registration schema を直接 parse して valid input + 別
  variant + `include:["envelope"]` opt-in 維持 + invalid discriminator → typed
  Zod error の 4 軸を pin する (20 件)。既存 unit test は wrap 後 schema を
  parse する経路がカバーされていなかったため bug を見逃していた。

### Migration

v1.3.0 から v1.3.1 への upgrade で **挙動変更は「壊れていた 6 tool が動くように
なる」のみ**。`include` keyword (raw / envelope / causal / working:N / episodic:N
/ semantic:K / procedural:K / memory_strict|balanced|open) の semantics、env
変数 (`DESKTOP_TOUCH_MEMORY_PERSIST` / `DESKTOP_TOUCH_MEMORY_REDACT_TITLES`)、
permanent storage path (`%USERPROFILE%\.desktop-touch-mcp\memory\`) は v1.3.0
と完全同一。

## [1.3.0] - 2026-05-07 — LLM の認知メモリ拡張 (CoALA 4 layer + per-call security tier)

`include` オプションに **4 つの新しい memory keyword** が追加され、LLM が
「直近の自分の操作」「過去の操作履歴の rich shape」「過去成功した UI 操作
パターン」「過去成功した repeated workflow 候補」を 1 call で受け取れるよう
になった。**既存呼び出しは完全に互換**: `include` 不在 / `include: ["raw"]` /
`include: ["envelope"]` / `include: ["causal"]` の既存挙動は不変、新 keyword
は **opt-in** のみ動作。

LLM 側のユースケース:
- 「今 macro を実行する前に、自分が直近何をしたかおさらいしたい」 → `include: ["working:5"]`
- 「失敗 step を fix する前に過去の同型 step の lease/timing 詳細を見たい」 → `include: ["episodic:3"]`
- 「この window で過去どんな commit pattern が成功してたか hint を欲しい」 → `include: ["semantic:3"]`
- 「同じ workflow を再実行したい、suggest 出して」 → `include: ["procedural:3"]`
- 「この call は機密扱い、redact 強制」 → `include: ["semantic:3", "memory_strict"]`

### Added

- **feat(memory): `include: ["working:N"]` で直近 N 件の commit summary (#162).**
  応答に `current_state.recent_events` (最大 N=50、default 10) を載せる。compact
  shape (tool_call_id / tool / args 64 char / ok / is_compound)、in-flight commit
  含む。LLM が「macro 直前に何をしたか」をおさらいする用途。

- **feat(memory): `include: ["episodic:N"]` で過去 commit の rich shape (#164).**
  応答に `tool_call_history.episodes` (最大 N=100、default 5) を載せる。rich
  shape (lease_token_summary / event_id_started/completed / elapsed_ms / args 512
  char) で、Working との差別化 = compact vs rich。completed only (in-flight skip)。
  LLM が「失敗時 fixup 前に類似 step の timing/lease 詳細を確認」する用途。

- **feat(memory): `include: ["semantic:K"]` で過去成功した UI 操作パターン (#165).**
  応答に `learned_ui_pattern.patterns` (最大 K=10、default 3) を載せる。**rule-based
  抽出** = 同 windowTitle で連続 3+ commit 全成功 → 1 pattern (FNV-1a hash で
  fingerprint)、in-memory LRU 100 patterns + JSON 永続化 (env opt-in、#167)。
  LLM が「この window で過去に成功した commit 列を hint 化」する用途。

- **feat(memory): `include: ["procedural:K"]` で過去成功した repeated workflow (#168).**
  応答に `successful_macros.suggestions` (最大 K=10、default 3) を載せる。
  `run_macro` 完了時に outcome (tool sequence + success/failure + destructive flag)
  を集計、suggest filter は **strict** (success>=3 + failure==0 + no destructive)。
  destructive 候補は `mouse_click` / `keyboard` / `terminal` / `clipboard` /
  `browser_click` / `browser_fill` / `browser_eval` / `workspace_launch` /
  `notification_show` 等 (entry 不在 = default destructive、query allowlist 11 件
  のみ explicit safe)。**destructive macro suggest は意図的に non-goal** で
  構造的に出ない設計、in-memory LRU 100 outcomes + JSON 永続化 (env opt-in)。

- **feat(memory): per-call security tier `include: ["memory_strict|balanced|open"]` (#169).**
  応答に `security_tier_active` (~50-100B) を載せる。env (operator ceiling) +
  LLM include axis (per-call request) の二重 axis。3 tier:
  - `memory_strict`: redact ON + persist 表示 OFF + procedural expose OFF (env 設定無視で max security 強制)
  - `memory_balanced` (default): env 既定値踏襲
  - `memory_open`: env ceiling 範囲内で max expose
  
  **Security floor 原則**: LLM は env を **open 側へ超えられない**
  (env=redact_ON は include=open で OFF にできない、env=persist_OFF は
  include=open で ON にできない)、strict 方向のみ env を超えられる。

- **feat(memory): JSON 永続化 (env opt-in、#167).**
  `DESKTOP_TOUCH_MEMORY_PERSIST=1` で `%USERPROFILE%\.desktop-touch-mcp\memory\`
  配下に `ui-patterns.json` (B-3) / `macro-outcomes.json` (B-4) を atomic write
  (`<file>.tmp` → `fs.rename`)、起動時 load + 5s debounced flush + shutdown 時
  immediate flush。`DESKTOP_TOUCH_MEMORY_REDACT_TITLES=1` で window_title を
  hash 化 (irreversible)、tool 名は PII でないため redact 影響なし。

### Compatibility

- **既存呼び出し全件互換** — `include` 不在 / `include: ["raw"]` / `include: ["envelope"]` /
  `include: ["causal"]` は v1.2.1 と完全同じ応答。
- **環境変数は default OFF** (`DESKTOP_TOUCH_MEMORY_PERSIST=0` /
  `DESKTOP_TOUCH_MEMORY_REDACT_TITLES=0`)、env 不在で永続化ゼロ + redact ゼロ。

### Caveats

- B-3/B-4 の永続化先は **cross-LLM-client global** (session_id key 不使用)。
  user A の使用 pattern が user B の suggest に出る可能性あり (filter 経由 safe
  pattern のみ expose で軽減)。multi-LLM-client deploy で privacy 重視なら
  env を OFF のまま運用、または `include: ["memory_strict"]` で per-call
  redact + procedural suppress。
- **destructive macro 自動 suggest は Phase B では non-goal**。`run_macro` で
  destructive tool (mouse_click 等) を含む macro が成功しても `procedural:K`
  に出てこない。これは fail-safe inversion 設計、将来 explicit consent UX で
  別 PR 検討。
- B-3 semantic memory の **同 run 続き re-extraction trade-off**: 1 度 pattern 化
  された run に同 windowTitle で commit を重ねても、追加 success_count としては
  カウントされない (cursor 経路の意図された副次効果、polling-heavy client での
  pattern 認識精度低下)。実害は通常の「macro 完了 → 1 度 query」用途では発生
  しない。

## [1.2.1] - 2026-05-03 — オプションで envelope / 因果情報を返せるようになった (互換維持)

全 28 tool に **オプション引数 `include`** が追加され、応答に構造化メタデータ (envelope) や直前操作との因果関係 (causal) を載せられるようになった。**`include` を渡さない既存呼び出しは従来とまったく同じ応答** が返るため、利用者の既存設定・既存マクロ・既存 tool 呼び出しには互換影響なし。LLM 側で「この情報はいつ取得したか」「直前の自分の操作との関係はあるか」を 1 call で判定したい場合の opt-in 機能。

Note: v1.2.0 を tag した時点で CI ビルドが失敗し (release workflow が削除済の `koffi` ランタイム依存を参照していた)、v1.2.0 は npm publish も GitHub Release も生成されていない。**npm から `@harusame64/desktop-touch-mcp@1.2.0` を直接指定すると 404 になる** ので、v1.1 系から上げる場合は v1.2.1 を使うこと。v1.2.1 は v1.2.0 と同じ機能セット + リリースワークフロー修正。

### Added

- **feat(all 28 tools): 応答に envelope を要求できる `include` オプション (#126-#147).**
  全 tool の入力に `include?: string[]` フィールドが追加された。`include: ["envelope"]` を渡すと従来の応答が `{ _version, data, as_of, confidence }` の形に包まれて返り、応答が「いつ時点の情報か (`as_of`)」「engine 側の確信度 (`confidence`)」を含む。`include` 省略 / `include: ["raw"]` は従来通りの生応答 (`_version` などの追加 field なし) で、既存呼び出しは完全に互換。対象 tool は副作用のある操作系 (mouse_click / mouse_drag / keyboard / clipboard / scroll / focus_window / window_dock / notification_show / terminal / workspace_launch / click_element / desktop_act / browser_open / browser_navigate / browser_click / browser_fill / browser_form / browser_eval / run_macro) と読み取り系 (desktop_state / desktop_discover / screenshot / browser_overview / browser_locate / browser_search / wait_until / workspace_snapshot / server_status) の 28 tool 全部。
- **feat(desktop_state): `include: ["causal"]` で直前の操作との因果関係を取得 (#126-#147).**
  `desktop_state({ include: ["causal"] })` を呼ぶと、応答に「直前にどの tool を呼んだか (`your_last_action`)」と「その後 UI 側でどんなイベントが起きたか (`events`)」が載る。旧来は screenshot や desktop_state の差分から推測していた「自分の click が効いたか」「click 後にダイアログが出たか」が 1 call で確認できる。他の query tool (desktop_discover / screenshot 等) も `include: ["causal"]` を受け取るが現時点では `your_last_action` 等を返さない (将来拡張用に schema だけ受け付ける)。
- **feat(run_macro): macro 実行を 1 つの境界として記録 (#147).**
  `run_macro` で N step の macro を実行すると、内部イベントログに「macro 全体の境界マーカー 1 件 + 各 step ごとに 1 件」の合計 N+1 件が記録される。これにより `desktop_state(include=causal)` が「直前は run_macro 全体だった」と「直前は macro 内のどの step だったか」を区別できる。caveat: イベントログは内部的に ring buffer で、step 数が 8 を超える長い macro では古い step の記録が押し出される可能性あり (causal 応答にその step が出てこない)。

### Fixed

- **fix(release.yml): v1.2.0 リリース失敗 (古い `koffi` 依存参照) を修正.**
  v1.0 系で削除済の `koffi` ランタイム依存を release workflow の依存コピーリストが参照し続けており、v1.2.0 を tag した時点で `npm install` が `must provide string spec` で失敗 (`package.json` 一時ファイルに `"koffi": null` が書かれた)。`koffi` エントリを除去し、ランタイム依存リストを `package.json` の実依存 5 件 (`@modelcontextprotocol/sdk` / `@nut-tree-fork/nut-js` / `sharp` / `ws` / `zod`) に揃えた。v1.2.1 はこの修正込みで再 release した版。

## [1.1.3] - 2026-04-28 — `browser_launch` killExisting + `scroll(action='read')` + stub catalog fixes

Two v1.1 enhancements ship together with a stub-catalog generator fix that
exposes nested `z.object` schemas to non-Windows tool discovery. Both new
features are gated behind explicit args (`killExisting:true` / `action:'read'`)
so existing callers are unaffected.

- **feat(browser): add `killExisting` option to `browser_launch` (#22, #70).**
  When true, terminate existing `chrome.exe` / `msedge.exe` / `brave.exe`
  before spawning with `--remote-debugging-port`. Resolves the case where
  a Chromium instance is already running without CDP and `browser_launch`
  silently inherits into the existing profile, leaving the port closed.
  `taskkill.exe` is invoked by absolute `%SystemRoot%\System32\taskkill.exe`
  path to defeat PATH-hijack (Codex P1). The return JSON gains `killed: string[]`
  on both `alreadyRunning` and freshly-launched paths.
- **feat(scroll): add `action='read'` for OCR + dedupe long-doc reading (#25, #71).**
  Scrolls a window page-by-page, OCRs each viewport, deduplicates overlapping
  lines, and returns the stitched text in one MCP call. OCR is bound to the
  resolved hwnd (no title-based lookup drift); scroll keys are dispatched via
  `postKeyComboToHwnd` gated by `canInjectAtTarget` so foreground changes do
  not redirect the keystroke. Falls back to nut-js global keyboard with
  re-focus on Chromium / WebView2 hosts where PostMessage is silently dropped.
  Dedupe window is bounded by the current frame length so `scrollKey:'ArrowDown'`
  (line-by-line, near-full-viewport overlap) works correctly. OCR language is
  auto-detected from the OS locale (BCP-47 primary tag passed verbatim — no
  hardcoded allowlist). Capture / OCR failures surface as a structured
  ToolResult (`ok:false` on first page, `ok:true` + `stoppedReason:"ocr_failed"` +
  partial text on later pages) instead of escaping as a tool execution error.
- **fix(stub-catalog): expand nested `z.object` schemas recursively (#71).**
  `scripts/generate-stub-tool-catalog.mjs` previously collapsed every nested
  `z.object(...)` field to an opaque `{type:'object'}`, hiding the inner
  property contract from non-Windows clients. The generator now recurses into
  the inner shape so `browser_open.launch` (`browser` / `userDataDir` / `url` /
  `waitMs` / `killExisting`), `mouse_click.origin` (`x` / `y`), and
  `screenshot.region` (`x` / `y` / `width` / `height`) all appear in
  `STUB_TOOL_CATALOG` with full property contracts. `z.record` / `z.union` /
  `z.discriminatedUnion` stay opaque (their shape is not a fixed property map).

## [1.1.2] - 2026-04-28 — stdio server defers shutdown while tool calls are in flight

Bug fix: when the MCP client closed its stdin write-end while a long-running
tool call (`terminal(action='run')`, `wait_until`, large UIA polls) was still
running, the stdio server immediately called `process.exit(0)` and the in-flight
response was lost — the client saw `MCP error -32000: Connection closed` and
retried the call from scratch. The server now defers shutdown until the
in-flight JSON-RPC requests drain (60s safety timeout), so the response is
delivered before the process exits. HTTP transport (`--http`) was unaffected.

- **fix(server): defer shutdown while tool calls are in flight (#68).**
  `process.stdin.on('end')` and `process.stdout.on('error')` now go through a
  new `requestShutdown()` path that waits for `inflightIds` (a transport-level
  JSON-RPC request id set tracked via wrapped `transport.onmessage` /
  `transport.send`) to reach zero before calling `shutdown()`. Explicit
  `SIGINT` / `SIGTERM` / `disconnect` still terminate immediately. JSON-RPC
  ids are stored with their original type (`Set<string | number>`) so a
  spec-compliant client sending both numeric and string ids in the same
  session is not undercounted (Codex P2). The wrap forwards all SDK
  options/extra args via rest-spread for forward compatibility. Closes #68.
- **chore(repro): remove unused `t0` in `tests/repros/stdin-eof-shutdown.repro.mjs`
  (CodeQL `js/unused-local-variable` #104).**

## [1.1.1] - 2026-04-28 — `modal_blocking` response surfaces blocker identity

`desktop_act` now tells the LLM *which* modal to dismiss when a touch is
blocked, closing a one-syscall gap surfaced by Haiku 4.5 during a 3-model
dogfood run on Outlook PWA. Backwards-compatible patch — the new field is
optional and engines that cannot identify the blocker still return
`modal_blocking` without it.

- **feat(desktop_act): include `blockingElement` in `modal_blocking` response (#63).**
  When a `desktop_act` call fails with `reason: "modal_blocking"`, the response now
  carries `blockingElement: { name, role, automationId? }` identifying the offending
  modal. The LLM can dismiss it directly via `click_element(name=blockingElement.name)`
  without taking an extra screenshot to figure out what to close. The session-aware
  default predicate is shared between `isModalBlocking` and the new `findBlockingModal`
  hook so the pair cannot diverge. When the caller overrides exactly one of the pair,
  the other is derived from the override (Codex P1) — `blockingElement` is omitted
  rather than surfacing an entity unrelated to the actual blocking predicate. Closes
  #63 (Haiku 4.5 dogfood feedback from 3-model comparison run on Outlook PWA).

## [1.1.0] - 2026-04-27 — Focus Leash System (Phase A + B)

Stray-write defense for keyboard automation when the user changes
foreground mid-stream. Two layers landed in this minor: terminal-class
windows auto-route through HWND-targeted WM_CHAR (foreground-independent),
and non-terminal SendInput sends are chunked with a per-chunk foreground
guard that aborts and returns `typed`/`remaining` for resumable retry.
Backwards-compatible — explicit `method` values, `DTM_BG_AUTO=1`, and the
clipboard path are unchanged.

- **feat(keyboard): Focus Leash Phase B — per-chunk foreground guard for
  non-terminal apps.** When `keyboard(action:'type')` targets a non-terminal
  window via the foreground keystroke path, the send is now split into chunks
  (default 8 chars; override via `DTM_LEASH_CHUNK_SIZE` env, range 1-1024) and
  the target's foreground state is verified between chunks via
  `checkForegroundOnce` (a no-settle variant of `detectFocusLoss`). If the user
  grabs focus mid-stream, the call aborts with `FocusLostDuringType` and the
  response includes `context.typed` (chars delivered) plus `context.remaining`
  (unsent tail) so the caller can re-focus and resume. New `abortOnFocusLoss`
  param (default true when `windowTitle` is set) disables the leash when set
  to false. Clipboard path (atomic Ctrl+V) and BG path (HWND-targeted
  WM_CHAR — Phase A) are unaffected.
  - Modifier release safety valve: on abort or unexpected exception inside
    the chunked send, explicit KeyUp is emitted for L/R Ctrl/Alt/Shift so a
    leaked modifier cannot leave the user's session with a stuck-down
    Shift/Ctrl/Alt (defense-in-depth — KeyUp is idempotent at the OS level).
  - Chunk boundaries are code-point-aware (`Array.from`) so non-BMP
    characters (emoji etc.) never get bisected between chunks; resume
    semantics (`typed` / `remaining`) stay coherent in UTF-16 code units.

- **feat(keyboard, terminal): Focus Leash Phase A — terminal-class auto-route to WM_CHAR.**
  When `keyboard(action, method:'auto')` or `terminal(action:'send', method:'auto')`
  targets a known terminal window (`CASCADIA_HOSTING_WINDOW_CLASS` for Windows
  Terminal / `ConsoleWindowClass` for cmd/PowerShell/conhost), the engine now
  automatically uses HWND-targeted PostMessage delivery instead of the foreground
  keystroke path. Keystrokes intended for a terminal can no longer be diverted to
  other windows when the user grabs focus mid-stream. Existing `DTM_BG_AUTO=1`
  env flag continues to enable BG input globally for non-terminal apps; other
  apps still default to the foreground path.
  - **2026-05-08 correction (issue #173):** the `CASCADIA_HOSTING_WINDOW_CLASS`
    half of this claim was wrong. Windows Terminal is built on WinUI/XAML and
    consumes input via `KeyEventArgs`; `PostMessage(WM_CHAR)` is queued at the
    OS layer but `TerminalControl` never reads it, so input is silently dropped.
    The auto-route quietly broke `terminal(action:'send')` for any user whose
    default terminal app was Windows Terminal, while CI (which runs under
    conhost) saw green. Fixed in v1.3.2 — WT is removed from the BG fast-path
    and a post-send UIA read-back surfaces `BackgroundInputNotDelivered` if the
    BG path is still requested explicitly.

## [1.0.5] - 2026-04-27 — Security and stability patch

Bundle of correctness fixes found after `v1.0.4`, plus a guard rail to prevent
stdio regressions from coming back.

- **fix(image_processing):** prevent `u64` underflow in the Sauvola integral-image
  sum. Large ROIs could underflow the running difference and corrupt the
  thresholded output.
- **fix(browser):** correct the `\s+` regex escape in a CDP-injected template
  literal. Whitespace matching in selector-injection paths now behaves as
  intended.
- **fix(action-guard):** replace a dead null/undefined check with `pid === 0`
  (CodeQL #103). Removes unreachable code flagged by static analysis.
- **fix(launcher-test):** skip the stdio shutdown test when the sha256 manifest
  is `PENDING`. The check ran on the release commit before CI populated the
  hash and produced a false failure.
- **chore(lint):** add an ESLint rule that guards the MCP stdio JSON-RPC stream
  (#61). Catches future `console.log` / direct `stdout` writes that would
  re-introduce the v1.0.4 issue.

## [1.0.4] - 2026-04-27 — stdio JSON-RPC stream fix (Issue #60)

Some MCP clients run the launcher with `console.debug` mapped to `stdout`,
which corrupted the JSON-RPC framing on the stdio transport (Issue #60).
All `console.debug` calls in the runtime are replaced with `console.error`
so stdout remains exclusively MCP protocol traffic.

Documentation cleanup shipped alongside the fix:

- README rewritten to match the v1.0.x positioning (28 tools, World-Graph
  default-on).
- Tool count corrected from 56 to 28 in `package.json` and `glama.json`.
- Site navigation standardized across pages; v1.0 milestone article added.

## [1.0.3] - 2026-04-26 — Release infrastructure fix

The v1.0.0 tag built the GitHub Release zip successfully but the `npm-publish`
job failed because `npm publish --ignore-scripts` still triggered the
`prepare: tsc` lifecycle and `node_modules` was missing on the ubuntu-latest
runner — TypeScript could not resolve `@types/node`, the MCP SDK, or zod.

Add an explicit `npm ci` step in `release.yml` so the prepare lifecycle has
the dev dependencies it needs. v1.0.1 contains no functional changes from
v1.0.0; the surface, lease hardening, security fixes, and CI Rust coverage
are identical.

## [1.0.0] - 2026-04-26 — Tool Surface Reduction (Phase 1+2+3+4) + V2 World-Graph default-on + lease hardening

### Highlights

- **65 → 28 public tools.** Tool Surface Reduction Phase 1 (naming redesign), Phase 2 (family-merge dispatchers), Phase 3 (browser rearrangement), Phase 4 (privatize / absorb) all shipped. The MCP catalogue is 26 stub-catalog entries plus 2 dynamic v2 World-Graph tools (`desktop_discover` / `desktop_act`).
- **Anti-Fukuwarai v2 (World-Graph) is the default surface.** `desktop_discover` issues entity leases; `desktop_act` consumes them. Kill switch `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` exposes a v1 fallback tool set (`get_windows` / `get_ui_elements` / `set_element_value`) for troubleshooting only.
- **Lease hardening.** Payload-size aware TTL with a soft-expiry advisory (`response.softExpiresAtMs` ≈ 60 % of the TTL window) tells the LLM when to refresh proactively; cap raised to 60 s for large explore + payload combos. Session eviction is now wired into a `.unref`'d 30 s timer so long-running processes don't leak.
- **Security audit pass.** CWE-94 in CDP `cdpFill` fixed (raw selector interpolation → JSON.stringify), HTTP CORS narrowed from `*` to a localhost-origin allowlist with proper `Vary: Origin`, native vision-backend Mutex poison handled.
- **CI gains Rust regression coverage.** windows-latest CI now runs the napi-rs build (`build:rs:debug`) on every PR, so any drift in the FFI shape / `build.rs` / Cargo features fails fast.
- **Two new browser DX wins.** `wait_until(url_matches)` waits on `location.href`; `browser_get_dom` now attaches a body-structure hint to ElementNotFound errors so the LLM gets an alternative-selector starting point.



### Breaking Changes — Phase 1 (Naming Redesign, 10 tools)

This phase renames 10 tools with **no aliases**.

| Old name | New name | Notes |
|---|---|---|
| `get_context` | `desktop_state` | Read-only desktop observation (returns `attention` field) |
| `desktop_see` | `desktop_discover` | Lease-emitting entity discovery |
| `desktop_touch` | `desktop_act` | Lease-consuming entity action (returns `attention` field) |
| `engine_status` | `server_status` | MCP server status diagnostic |
| `browser_connect` | `browser_open` | CDP connect + list tabs |
| `browser_click_element` | `browser_click` | Find + click via CSS selector |
| `browser_fill_input` | `browser_fill` | Fill controlled inputs via CDP |
| `browser_get_form` | `browser_form` | Inspect form fields |
| `browser_get_interactive` | `browser_overview` | List all interactive elements |
| `browser_find_element` | `browser_locate` | CSS selector → screen coords |

### Breaking Changes — Phase 2 (Family Merge, 13 tools → 5 dispatchers)

This phase merges 13 tools into 5 family dispatchers via discriminated `action` parameter.

| Old name | New invocation |
|---|---|
| `keyboard_type({text})` | `keyboard({action:"type", text})` |
| `keyboard_press({keys})` | `keyboard({action:"press", keys})` |
| `clipboard_read()` | `clipboard({action:"read"})` |
| `clipboard_write({text})` | `clipboard({action:"write", text})` |
| `pin_window({title, duration_ms?})` | `window_dock({action:"pin", title, duration_ms?})` |
| `unpin_window({title})` | `window_dock({action:"unpin", title})` |
| `dock_window({title, corner, ...})` | `window_dock({action:"dock", title, corner, ...})` |
| `scroll({direction, amount, ...})` | `scroll({action:"raw", direction, amount, ...})` |
| `scroll_to_element({...})` | `scroll({action:"to_element", ...})` |
| `smart_scroll({...})` | `scroll({action:"smart", ...})` |
| `scroll_capture({...})` | `scroll({action:"capture", ...})` |
| `terminal_read({windowTitle, ...})` | `terminal({action:"read", windowTitle, ...})` |
| `terminal_send({windowTitle, input, ...})` | `terminal({action:"send", windowTitle, input, ...})` |

**New `terminal({action:"run", ...})` workflow** — sends input, waits, and reads in one call. Returns `completion={reason, ...}` with reasons: `quiet | pattern_matched | timeout | window_closed | window_not_found`.

```js
terminal({action:"run", windowTitle:"PowerShell", input:"npm test",
          until:{mode:"pattern", pattern:"npm test:"}, timeoutMs:30000})
// → {output, completion:{reason:"pattern_matched", elapsedMs, matchedPattern}}
```

### Breaking Changes — Phase 3 (Browser Rearrangement, 4 tools absorbed/privatized)

This phase reorganizes the browser CDP family from 13 → 9 tools by absorbing
two pairs of related tools into discriminated unions and privatizing one.

| Old call | New call |
|---|---|
| `browser_launch({})` | `browser_open({launch:{}})` |
| `browser_launch({browser, port, userDataDir, url, waitMs})` | `browser_open({port, launch:{browser, userDataDir, url, waitMs}})` |
| `browser_open({port})` (connect-only) | `browser_open({port})` (unchanged — `launch` is optional) |
| `browser_eval({expression})` | `browser_eval({action:"js", expression})` |
| `browser_eval({expression, withPerception})` | `browser_eval({action:"js", expression, withPerception})` |
| `browser_get_dom({selector, maxLength})` | `browser_eval({action:"dom", selector, maxLength})` |
| `browser_get_app_state({selectors, maxBytes})` | `browser_eval({action:"appState", selectors, maxBytes})` |
| `browser_disconnect({port})` | (removed — process exit auto-cleanup) |

Notes:
- `browser_open({launch:{}})` is **idempotent**: when a CDP endpoint is already
  live on the target port, the spawn step is skipped and connect proceeds.
  Pass `launch:{}` to use defaults (chrome → edge → brave auto-resolution,
  `C:\tmp\cdp` profile, no initial URL); omit `launch` entirely for pure connect.
- `browser_eval({action:'dom'|'appState'})` is wrapped with `withPostState` so
  all three actions (`js` / `dom` / `appState`) attach `post.perception` when
  guards run. Previously only `browser_eval` did.
- `browser_eval({expression})` (without `action`) now fails validation —
  callers must supply `action:'js'`.
- `browser_open({launch:{...}})` returns the connect payload (`tabs[].active`).
  The former `browser_launch` extras (`alreadyRunning`, `launched.{browser,path}`)
  are dropped from the LLM-facing response; spawn state can be inferred from
  whether tabs[] returns immediately vs after a short delay.

### Breaking Changes — Phase 4 (Privatize / Absorb, 20 tools)

The largest reduction phase — 20 tools either privatized (entry-point removed,
internal handlers retained for tests / future facades) or absorbed into the
World-Graph core (desktop_state / desktop_discover / desktop_act) plus the
unified screenshot tool.

#### Privatized (10 — handler retained as internal export)

| Old call | New path |
|---|---|
| `events_subscribe` / `events_poll` / `events_unsubscribe` / `events_list` | Use `wait_until` for one-shot waits (`condition='window_appears'`/`'terminal_output_contains'`/`'element_matches'`/`'focus_changes'`). Multi-event monitoring removed; revive via facade in a later phase if dogfood shows it's needed. |
| `perception_register` / `perception_read` / `perception_forget` / `perception_list` | Auto Perception (v0.12+) attaches `attention` to `desktop_state` / `desktop_act` responses automatically. Action tools auto-guard when given `windowTitle`. |
| `get_history` | Debug-only tool — removed from public surface. |
| `mouse_move` | Hover-trigger UIs are rare; use `mouse_click` for click targets. |

#### Absorbed into `screenshot` (3)

| Old call | New call |
|---|---|
| `screenshot_background({windowTitle})` | `screenshot({windowTitle, mode:'background'})` |
| `screenshot_ocr({windowTitle, language})` | `screenshot({windowTitle, detail:'ocr', ocrLanguage})` |
| `scope_element({windowTitle, name, automationId, ...})` | Discover element bounds via `desktop_discover`, then `screenshot({windowTitle, region:{x,y,width,height}})`. The UIA child-tree return value is no longer surfaced — `desktop_discover` already exposes that structure. |

#### Absorbed into `desktop_act` (1)

| Old call | New call |
|---|---|
| `set_element_value({windowTitle, value, name, automationId})` | `desktop_act({action:'setValue', lease, text:value})`. Lease comes from `desktop_discover`. UIA ValuePattern path or CDP fill path selected automatically based on entity source. |

#### Absorbed into `desktop_state` response fields (4)

| Old call | New call |
|---|---|
| `get_active_window()` | `desktop_state().focusedWindow` (always returned) |
| `get_cursor_position()` | `desktop_state({includeCursor:true}).cursor` |
| `get_document_state({port,tabId})` | `desktop_state({includeDocument:true,port?,tabId?}).document` |
| `get_screen_info()` | `desktop_state({includeScreen:true}).screen` |

#### Absorbed into `desktop_discover` response fields (2)

| Old call | New call |
|---|---|
| `get_ui_elements({windowTitle, ...})` | `desktop_discover({target:{windowTitle}}).entities[]` (`entityId` / `label` / `role` / `confidence` / `sources` / `primaryAction` / `lease`; `rect` only when `debug:true`) |
| `get_windows()` | `desktop_discover().windows[]` (`zOrder` / `title` / `hwnd` / `region` / `isActive` / `isMinimized` / `isMaximized` / `processName`) |

The legacy `get_windows.isOnCurrentDesktop` virtual-desktop flag is **not**
included in `desktop_discover.windows[]` because it requires an async
PowerShell call. Callers needing virtual-desktop awareness can keep using
the internal `getWindowsHandler` (still exported for tests / facades).
Other action tools (`screenshot`, `mouse_click`, `keyboard`, …) accept
`hwnd` strings directly from `windows[].hwnd` for exact-handle workflows.

#### `run_macro` DSL TOOL_REGISTRY migrated to v1.0.0 names

The pre-Phase-1 compatibility layer in `run_macro` was retired. The macro DSL
now accepts only the v1.0.0 dispatcher names — for example
`{tool:'keyboard', params:{action:'type', text:'hello'}}` instead of
`{tool:'keyboard_type', params:{text:'hello'}}`. Macros built for v0.x must
be rewritten alongside direct tool calls.

#### v2 kill-switch fallback (Codex PR #41 round 6)

Anti-Fukuwarai v2 (`desktop_discover` / `desktop_act`) is on by default since
v0.17. Phase 4 absorbs `get_ui_elements` / `get_windows` /
`set_element_value` into v2's response fields and dispatcher actions; to
keep `DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1` deployments capability-complete,
those three V1 tools are **re-published as fallback** when the kill switch
is set:

```
DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1
  → desktop_discover / desktop_act       NOT registered
  → get_windows / get_ui_elements / set_element_value  registered (V1 fallback)
```

The descriptions are prefixed with `[V1 fallback — registered only when ...]`
so the LLM sees they are a fallback layer, not the primary surface. The
`run_macro` DSL mirrors the same gate: in v2 mode the fallback entries
short-circuit with a `"v2 mode use ..."` hint instead of executing.

Other Phase 4 privatizations have non-v2 replacements (`desktop_state.include*`
flags / `screenshot` dispatcher / `wait_until` / `mouse_click`) and stay
private regardless of the kill switch.

### Tool Count

- Phase 1 + Phase 2 + Phase 3 + Phase 4 combined: **65 → 28 public tools** (about 57% reduction; matches plan §13 target of 27 ± 1).
- Stub catalog: **26 entries** (v2 `desktop_discover` / `desktop_act` are dynamic, registered at startup, not in static catalog → 26 + 2 = 28 public surface).

### Phase 4 Outstanding (deferred to Phase 5)

- Pre-existing test-isolation flakiness in `tests/unit/registry-lru.test.ts` (Phase 3 §3.3) — unrelated to Phase 4, vitest `vi.mock` leak issue. Tracked for Phase 5.
- Pre-existing E2E flakiness in `tests/e2e/context-consistency.test.ts` C3 (Save-As dialog detection on Win11 MSStore Notepad) and `tests/e2e/rich-narration-edge.test.ts` B1 (Chromium narrate:rich) — Phase 5 dogfood will verify.
- `browser_disconnect` / `mouse_move` facade revival decision — Phase 5 dogfood will confirm whether the privatized capability is missed.
- MCP server instructions text (`src/server-windows.ts`) extension for the new screenshot mode/detail/region values and desktop_state include* flags — deferred to Phase 5 dogfood judgement to avoid preemptive surface bloat.
- Performance / token-cost release notes generation via the refreshed `scripts/measure-tools-list-tokens.ts`.

### Changed

- `src/server-windows.ts` instructions text updated for Phase 1 + Phase 2 naming + Phase 4 WindowNotFound recovery.
- `src/stub-tool-catalog.ts` regenerated (26 entries after Phase 4).
- All LLM-visible strings (description / suggest / error.message / engine layer literal types / `failWith` tool labels) updated:
  - `_errors.ts` SUGGESTS for `WindowNotFound` / `ElementNotFound` / `InvokePatternNotSupported` / `TerminalWindowNotFound` rewritten to point at `desktop_discover` / `desktop_act({action:'setValue'})` / `screenshot({region})` / `terminal({action:'send'})`.
  - `_errors.ts` `BrowserNotConnected.suggest` → `browser_open({launch:{}})` (Phase 3).
  - `_errors.ts` `GuardFailed` / `LensNotFound` / `LensBudgetExceeded` rewritten away from privatized perception_* tools.
  - `engine/perception/guards.ts` (10) + `resource-model.ts` (2) `suggestedAction` → `desktop_state` (was: `perception_read`).
  - `desktop-state.ts` description: declares which former `get_*` tools are absorbed via `include*` flags.
  - `desktop-register.ts` (`desktop_discover` description): V1 fallback list `get_ui_elements` → `click_element`.
  - `screenshot.ts` `failWith` tags inside `screenshotBgHandler` / `screenshotOcrHandler` re-attribute to `"screenshot"` (the public dispatcher name).
  - `keyboard.ts` / `mouse.ts` / `dock.ts` / `window-dock.ts` / `workspace.ts` / `screenshot.ts` schema descriptions: hwnd hints "from `get_windows`" → "from `desktop_discover`"; monitor hints "from `get_screen_info`" → "from `desktop_state({includeScreen:true})`".
  - `browser.ts` `failWith` calls re-attribute internal handlers to their public dispatcher names (`browser_get_dom` / `browser_get_app_state` → `browser_eval`; `browser_launch` → `browser_open`).
- `README.md`, `README.ja.md`, `docs/system-overview.md`, `docs/tool-surface-reduction-plan.md`, `docs/tool-surface-known-issues.md` updated for Phase 4.
- `.gitignore` strengthened: `.vitest-out*.txt` / `.vitest-out*.json` wildcards (Phase 2 §2.6 follow-up).
- `scripts/measure-tools-list-tokens.ts` Tier sets refreshed for the v1.0.0 surface.
- Comment-only references to pre-Phase-1/2/3 names in `src/engine/` and `src/tools/` polished to current dispatcher names (16+ touchpoints across uia-bridge, vision-gpu, world-graph, layer-buffer, ocr-bridge, desktop-executor, desktop-providers, desktop, server-windows, utils/launch).

---

## [Unreleased] — browser_eval IIFE wrapping

### Added
- **`browser_eval` IIFE auto-wrapping**: snippets are now automatically wrapped in an async IIFE
  before CDP evaluation. This prevents `const`/`let` redeclaration errors when calling
  `browser_eval` multiple times in the same tab with identical variable names.
- Expression-shaped snippets are wrapped as `;(async () => (expr))()` to preserve the return
  value without requiring an explicit `return`.
- Statement-shaped snippets fall back to an `eval()`-based wrapper that preserves completion
  values (e.g. `const x = 1; x` still returns `1`). On pages with CSP that blocks `unsafe-eval`,
  the wrapper automatically falls back to a plain IIFE block so the snippet still runs (completion
  value may be lost but no error is thrown).
- Explicitly-wrapped IIFE expressions are passed through unchanged.

### Changed
- **`browser_eval` schema description** updated to document the IIFE wrapping behavior and
  note that `window.*` / `globalThis.*` should be used when state must persist across calls.

### Breaking Changes
- **Variable declarations do not persist across `browser_eval` calls.** Previously, `var`
  declarations evaluated in the same CDP session were visible in subsequent calls; they are
  now scoped to each individual snippet. Migrate persistent state to `window.myVar = …` or
  `globalThis.myVar = …`.

## [0.14.0] - 2026-04-18 — Background Input (WM_CHAR) + SetValue Chain + Terminal BG Fast-Path

### Added
- **Background input engine** (`src/engine/bg-input.ts`): WM_CHAR/WM_KEYDOWN injection via
  `PostMessageW` — delivers keystrokes to a target HWND without changing the foreground window.
  Works for standard Win32 controls, Windows Terminal, conhost, cmd, and PowerShell.
  Chromium (Chrome/Edge/Electron) and UWP sandboxed apps are automatically excluded.
- **`keyboard_type` / `keyboard_press`**: new `method:"auto"|"background"|"foreground"` parameter.
  `"background"` injects via WM_CHAR without bringing the window to front.
  `"auto"` selects BG when `DTM_BG_AUTO=1` and the target supports injection, else foreground.
- **`terminal_send`**: new `method` + `chunkSize` parameters. BG mode sends in 100-char chunks
  to avoid queue saturation. Windows Terminal and conhost are fast-pathed as always-supported.
  Duplicate Enter is suppressed when input already ends with CR/LF.
- **`set_element_value` channel chain**: ValuePattern → TextPattern2 → keyboard fallback.
  Enabled via `DTM_SET_VALUE_CHAIN=1` (default off for safety). Uses `TryGetCurrentPattern`
  for locale-independent TextPattern2 detection.
- New error codes: `BackgroundInputUnsupported`, `BackgroundInputIncomplete`,
  `SetValueAllChannelsFailed`.

### Fixed
- **Modal false-positive** (`Windows 入力エクスペリエンス` IME window detected as modal):
  Added `SYSTEM_RESIDENT_CLASSES` blocklist; `WS_EX_TOPMOST` demoted from standalone modal
  trigger to confidence booster (+0.03). Fixes `safe.keyboardTarget` guard always blocking
  with lensId on Japanese Windows.
- **Tab-strip drag detection** (`mouse_drag`): horizontal drags starting in the title-bar area
  of tabbed apps (Notepad, Terminal, Chrome, VS Code, etc.) are now blocked by default with
  `TabDragBlocked` error. Pass `allowTabDrag:true` to rearrange or detach tabs intentionally.
- **`getFocusedChildHwnd`**: guard `targetThread === 0` and `attached=false` before calling
  `GetFocus()` — prevents reading caller-thread focus when `AttachThreadInput` fails.

### Changed
- Default mouse movement speed increased from 1500 → 3000 px/sec.
  Override with `DESKTOP_TOUCH_MOUSE_SPEED` env var or per-call `speed` parameter.

### Feature Flags (default OFF — zero impact on existing users)
- `DTM_BG_AUTO=1`: enables automatic BG channel selection for `keyboard_type` / `keyboard_press`
  / `terminal_send` when `method:"auto"` and the target supports WM_CHAR injection.
- `DTM_SET_VALUE_CHAIN=1`: enables TextPattern2 + keyboard fallback in `set_element_value`.

### Compatibility
- 56 tools unchanged (no additions or removals).
- All new parameters are optional with backward-compatible defaults.
- `DTM_BG_AUTO=0` and `DTM_SET_VALUE_CHAIN=0` (both default) preserve all existing behavior.

## [0.13.1] - 2026-04-18 — CodeQL fixes + MCP Registry listing

### Fixed
- `browser_click_element`: removed `JSON.stringify(selector)` from `suggest` hint string to eliminate
  CWE-94 code-injection false-positive flagged by CodeQL (alerts #67/#68). The hint is now a
  generic fixed string instead of an interpolated selector value.
- `_action-guard.ts`: removed duplicate `consumeFix` from local `import` statement (alert #69).
  It is still re-exported for callers via `export { ... } from`.

### Chore
- Removed unused `vi` import from `browser-ready-policies.test.ts` (alert #70).
- Removed unused `forgetLens`, `readLens`, `refreshWin32Fluents`, `buildWindowIdentity` from
  `registry-lru.test.ts` (alerts #71-73).
- Added `server.json` MCP Registry manifest for future listing on `registry.modelcontextprotocol.io`.
- Added `mcpName` field to `package.json` per MCP Registry requirements.

### Compatibility
- No behavior change. All existing tool APIs unchanged.

---

## [0.13.0] - 2026-04-18 — v3 Auto-Perception Final Closure

### Added (Phase D — Target-Identity Timeline)
- **Semantic target-scoped event timeline** with 13 event kinds: `target_bound`,
  `action_attempted`, `action_succeeded`, `action_blocked`, `title_changed`,
  `rect_changed`, `foreground_changed`, `navigation`, `modal_appeared`,
  `modal_dismissed`, `identity_changed`, `target_closed`, `compacted`.
  Retention: per-target ring (32), global cap (256), session-scoped.
  Events older than 15 minutes are automatically compacted into summary entries.
- `get_history` now includes a compact `recentTargetKeys` array (3 most recent
  target keys; does not include event bodies — prevents history bloat).
- `perception_read(lensId)` now includes `recentEvents` (up to 10 events) for
  the lens's target, each containing `tsMs`, `semantic`, `summary`, optional
  `tool` and `result` fields.
- MCP resources `perception://target/{targetKey}/timeline` and
  `perception://targets/recent` behind the existing
  `DESKTOP_TOUCH_PERCEPTION_RESOURCES=1` flag, with push notifications on new
  events (per-URI 300ms debounce). Client disconnect cleans up listeners via
  `server.onclose`.
- Sensor-sourced timeline events (`title_changed`, `rect_changed`,
  `foreground_changed`, `navigation`, `modal_appeared`, `modal_dismissed`,
  `identity_changed`) emitted from native WinEvent / CDP fluent changes
  (200ms leading-edge debounce per (targetKey, semantic) pair; action/post
  events are never debounced to preserve failure traces).

### Added (Phase G — SuggestedFix full tool coverage)
- `keyboard_type({ fixId })`, `click_element({ fixId })`,
  `browser_click_element({ fixId })` now accept one-shot `fixId` approvals
  (15s TTL). `SuggestedFix.tool` union widened to all 4 tools specified
  in v3 §7.1: `"mouse_click" | "keyboard_type" | "browser_click_element" |
  "click_element"`.
- `fixId` approval includes target-fingerprint revalidation (window: `pid +
  processStartTimeMs` via Win32; browser tab: deferred to subsequent guard).
  Returns `FixTargetMismatch` if the target process changed.
- SuggestedFix emission extended to keyboard identity drift, UIA identity
  change, and browser tab readiness drift.

### Added (Phase I — `mouse_drag` endpoint guard)
- `mouse_drag` now guards **both** start and end coordinates. Cross-window
  drags (including dragging to the desktop/wallpaper) are blocked by default.
  Pass `allowCrossWindowDrag: true` to opt in for deliberate cross-window or
  desktop-range-selection drags.

### Added (Phase J — `browser_eval` structured response)
- `browser_eval({ withPerception: true })` returns structured JSON
  `{ ok, result, post }` with `post.perception` attached. Default `false`
  preserves the raw-text return for backwards compatibility. Circular
  references, functions, and BigInt in eval results are handled safely via
  `WeakSet`-based serialization.

### Changed (Phase E — Manual Lens LRU)
- Manual lens eviction is now **LRU (touch-on-use)** instead of FIFO.
  `evaluatePreToolGuards`, `buildEnvelopeFor`, and `readLens` promote the
  accessed lens to most-recently-used. `listLenses`, `getLens`, sensor loops,
  and resource reads do not touch. MAX=16 unchanged.

### Changed (Phase F — Browser readiness action-sensitive policies)
- `browser_click_element`: `readyState !== "complete"` is now a **pass-with-note**
  when the target selector is already in-viewport (policy `selectorInViewport`).
- `browser_navigate`: `readyState === "interactive"` passes with a warn note
  (policy `navigationGate` — navigation-in-progress is acceptable for pre-nav
  guard).
- `browser_eval`: strict block on `readyState !== "complete"` retained (default
  policy `strict`). Use `withPerception: true` to receive a structured response
  with guard status.

### Chore (Phase H — Code Scanning cleanup)
- Removed 1 trivial conditional and 6 unused local variables / imports flagged
  by GitHub Code Scanning (CodeQL). No behavior change.

### Compatibility
- Existing `lensId` workflows unchanged.
- Existing `post.perception` shape unchanged.
- New optional fields `recentEvents`, `recentTargetKeys` are additive.
- `browser_eval` default return is unchanged (raw text); structured mode is
  opt-in via `withPerception: true`.
- `mouse_drag` cross-window/desktop drags are now blocked by default (new
  behavior). Pass `allowCrossWindowDrag: true` for prior behavior. In-window
  drags are unaffected.
- `DESKTOP_TOUCH_AUTO_GUARD=0` rollback path unchanged.

---

## [0.12.0] - 2026-04-17

### Added (Auto Perception)
- **Auto guard for action tools**: `mouse_click`, `mouse_drag`, `keyboard_type`,
  `keyboard_press`, `click_element`, `set_element_value`, `browser_click_element`,
  `browser_navigate` now auto-guard using `windowTitle` / `tabId` / `port`
  without requiring `perception_register`.
- `post.perception` is now attached on both success **and failure** responses so
  LLMs can recover from guard blocks without taking another screenshot.
- **HotTargetCache**: hidden short-term target cache (6 slots, idle TTL 90s, hard
  TTL 10 min, bad TTL 15s) for repeated actions on the same window/tab.
  Improves guard performance on consecutive actions; does not consume manual lens
  budget (16 slots).
- **SuggestedFix + `mouse_click({ fixId })`**: one-shot recovery approval when a
  guard detects recoverable coordinate drift or identity change. `fixId` TTL is
  15s. The server revalidates the target fingerprint before executing.
- Environment variable `DESKTOP_TOUCH_AUTO_GUARD=0` to disable all auto-guard
  behavior and revert to v0.11.12 semantics.

### Fixed
- **`mouse_click` guard now evaluates the FINAL click coordinate** (after
  `origin`/`scale` conversion and homing), not the stale input coordinate.
  Previously the guard could silently pass a click whose final screen coordinate
  was outside the lens rect. Manual `lensId` users may see new `GuardFailed`
  errors for cases that were previously silently passing — this is intentional;
  verify the click is actually where you intend.

### Changed
- Tool descriptions for 8 action tools now prefer `windowTitle`/`tabId`
  arguments over explicit `lensId`. `perception_register` is now advertised
  as an advanced/debug API.
- `post.perception` type widened to `PerceptionEnvelope | AutoGuardEnvelope`
  (discriminated by `kind`: `"manual"` vs `"auto"`).

### Compatibility
- Existing `lensId`-based workflows continue to work unchanged.
- `perception_register` / `perception_read` / `perception_forget` /
  `perception_list` API is unchanged.
- `DESKTOP_TOUCH_AUTO_GUARD=0` restores v0.11.12 behavior exactly.
