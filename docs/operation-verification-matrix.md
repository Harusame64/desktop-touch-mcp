# Operation Verification Matrix — 各 operation tool の delivery 検証契約 (SSOT)

- Status: **Draft (起草、Phase 3 SSOT)**
- Date: 2026-05-08
- Authors: Claude (Opus, max effort)
- Scope: 28 tool 中 side-effect を起こす全 tool に対し「送り → 観測 → ok 判定」の規範を SSOT 化
- 役割: issue #173 §S-1 の silent-success 監査を進める Phase 3 child issues (#177-#181) の実装規範
- 関連:
  - 親 issue: #173 (audit) / #184 (Phase 3 epic)
  - child: #177 keyboard / #178 mouse_click / #179 scroll / #180 clipboard / #181 browser_*
  - 規範モデル: PR #174 (v1.3.2) `terminal({action:'send'})` BG path に WM_CHAR + UIA TextPattern read-back を実装済
  - error code SSOT: `src/tools/_errors.ts` (SUGGESTS dictionary + classify())
  - layer 構造: `docs/architecture-3layer-integrated.md` / `docs/layer-constraints.md` (L4 Cognitive Projection / L5 MCP Tool Surface)

---

## 1. 本書の役割と読み方

### 1.1 位置づけ

issue #173 で Windows Terminal silent fail が 11 日間 production で `ok:true` を返し続けていた regression を発見した。直接の原因は `bg-input.ts` の `TERMINAL_WINDOW_CLASSES` 分類ミスだったが、**「送ったあとに何を観測して `ok` を判定するか」が tool ごとに揃っていなかった** ことが根の問題。

本書は v1.3.2 で確立した terminal verification (post-send UIA read-back + tail-N fallback + typed `BackgroundInputNotDelivered`) を **規範モデル** として、他の operation tool 全部に同じ契約を要求するための SSOT。

各 child issue (#177-#181) は本書の該当行に書いてある verification 契約をそのまま実装規範として使う。後続の PR レビューで「ok 判定の手前で何を verify すべきか」を毎回議論しないで済むよう、ここで先に決める。

### 1.2 読み方

各 tool は以下の 6 観点で 1 行に整理する。

| 観点 | 意味 |
|---|---|
| **Tool** | MCP に register された tool 名 (28 tool 不変原則 / `docs/layer-constraints.md` §6.3 invariant 6) |
| **API レイヤ** | side-effect を発射する OS / プロトコル境界 (PostMessage WM_CHAR / SendInput / SetClipboardData / CDP / SetForegroundWindow / UIA InvokePattern など) |
| **現在の post-verification** | v1.3.2 時点で実装されている事後検証。「なし」は ack 値だけで `ok` を判定している silent-success 候補 |
| **期待される verification** | 送信後に観測すべき副作用と判定方法。terminal の post-send UIA read-back と同じ厚みを目標 |
| **失敗時 signal** | 配信未確認時に envelope に載せる signal。3 種別を prefix で区別する: `code:` (typed error code、`src/tools/_errors.ts` SUGGESTS dictionary 登録) / `reason:` (envelope.reason または completion.reason field) / `warning:` (warnings 配列要素)。SSOT として混在を許すが prefix で明示する |
| **関連 child issue / PR** | 実装担当 issue 番号、すでに land 済なら PR 番号 |

### 1.3 verification の 3 階梯

各 tool の検証は以下のいずれか 1 段以上を満たす:

1. **Strict** — side-effect を引き起こした **直後** に副作用そのものを別 API で読み戻し、bit-level で照合する (terminal({action:'send'}) BG path の UIA TextPattern read-back、clipboard 期待実装の `GetClipboardData` 読戻し)
2. **Indirect** — side-effect の代理指標を観測する (mouse_click 後の focus 維持、scroll 後の scrollPos diff、browser_click 後の DOM mutation)
3. **Unverifiable** — 観測経路が無いか false-positive 率が高すぎて strict / indirect どちらも不可。**`ok:true` のまま黙って返さない**: 必ず `hints.verifyDelivery: "unverifiable"` + 理由を明示 (§4 hint shape 参照)

`ok:true` を返してよいのは「Strict / Indirect で確認できた」または「Unverifiable と明示した」のいずれかに限る。**ack だけで `ok:true` は禁止**。

### 1.4 28 tool 中 verification 対象の境界

L5 MCP Tool Surface (§6) は 28 tool 不変。本書の対象は **side-effect を起こす tool** に限り、pure-observation tool (screenshot / desktop_state / desktop_discover / wait_until / clipboard:read / terminal:read / server_status / browser_overview / browser_search / browser_locate / workspace_snapshot) は §3 で **side-effect: none → verification: N/A** として一括 justify する。

Justify の理由: query 軸 tool は L5 invariant 2 (副作用ゼロ、event_id を新規発行しない、`docs/layer-constraints.md` §6.3) に縛られるため、本書が要求する「送り → 観測 → ok 判定」契約はそもそも構文的に存在しない。silent-success という failure mode は副作用 commit 軸 tool 限定の概念。

---

## 2. 規範モデル: terminal({action:'send'}) BG path (v1.3.2)

後続の child issue が参照する規範実装。何を真似すればよいかを最初に固定する。

### 2.1 何をしているか (実装位置: `src/tools/terminal.ts:299-496`)

```
Phase 1: pre-send baseline 採取
  baselineRaw   = await getTextViaTextPattern(win.title)
  baselineMarker = makeMarker(stripAnsi(baselineRaw))     # SHA-256 hash of last 256 chars

Phase 2: side-effect injection
  for chunk of input.chunks(chunkSize):
    postCharsToHwnd(hwnd, chunk)        # PostMessage WM_CHAR
    if not result.full:
      → fail BackgroundInputIncomplete   # partial write は double-input 防止のため fail

Phase 3: settle
  await sleep(150ms)                     # conhost render time

Phase 3.5: verifiable gate (実コード terminal.ts:423-424)
  verifiable = verificationNeeded                     # method:'background' OR DTM_BG_AUTO=1 (non-terminal)
            && textPatternAvailable(win.title)        # UIA TextPattern provider あり
            && !checkText.includes("\n")              # embedded newline は prompt 割込みで substring includes() false-fail (§4.3 reason 参照)
  # verifiable=false の場合 verifiedDelivery は初期値 "unverifiable" のまま、Phase 4 を skip

Phase 4: post-send read-back (verifiable=true のときのみ実行)
  verifiedDelivery = "unverifiable"        # 初期値、Phase 4 で上書きされる
  if verifiable:
    postRaw     = await getTextViaTextPattern(win.title)
    diff        = applySinceMarker(stripAnsi(postRaw), baselineMarker)
    exact       = diff.text.includes(checkText)
    tail        = checkText.replace(/\s+/g, "").slice(-8)
    tailMatch   = tail.length >= 4 && diff.text.replace(/\s+/g, "").includes(tail)
    verifiedDelivery = exact || tailMatch     # boolean で上書き

Phase 5: 判定
  if verifiedDelivery === false:
    → fail BackgroundInputNotDelivered       # WT silent drop / UIPI / etc
  if verifiedDelivery === "unverifiable":
    → ok with hints.verifyDelivery = "unverifiable" (§4、verifiable=false 由来)
  else:                                       # verifiedDelivery === true
    → ok                                     # 正常配信
```

### 2.2 なぜこの形か

| 設計判断 | 理由 |
|---|---|
| pre-send baseline + diff | scrollback の prior history で false-positive を起こさない。marker SHA-256 で boundary が再帰可能 |
| 150ms settle | conhost render に十分、かつ tool round-trip SLO (commit p99 < 200ms、`docs/layer-constraints.md` §6.4) 内に収まる |
| exact substring + tail-N fallback | 短い single-line は exact、console-width soft-wrap が混じる長文は tail-N で救済。tail-N 4 字未満は noise なので gate (PR #174 Codex P1 round 2) |
| whitespace strip 対称 | 片側だけ strip は dead code (PR #174 Codex round 3 P2) — 両側 strip で soft-wrap 改行を相殺 |
| embedded newline は verifiable=false | conhost が CR で行確定 → 次行の前に prompt が割り込み、includes() が false-fail。multi-line silent fail 検出は本 patch の scope 外 (PR #174 P2-1) |
| `verificationNeeded` gate (`method:'background'` 明示 OR `DTM_BG_AUTO=1` && non-terminal) | conhost 経由 auto-route は well-tested、150ms 余分 read-back はコスト負担に見合わない (PR #174 P2-4) |
| BackgroundInputNotDelivered は SSOT 化 | `_errors.ts:130` SUGGESTS dictionary 登録。call site の inline suggest は禁止 (PR #174 round 2 P1-1) — 同 code を返す全箇所が同 suggest を返す保証 |

### 2.3 後続 child issue が継承する原則

1. **必ず pre-send baseline を取る** — 副作用 commit 後に「何が変わったか」を語るには before/after の差分が要る
2. **typed code を `_errors.ts` SUGGESTS に登録** — 命名規則 `<Channel>InputNotDelivered` / `<Channel>NotDelivered` (`BackgroundInputNotDelivered`、`MouseClickNotDelivered`、…) で揃える
3. **read-back が原理的にできないケースは Unverifiable hint を返す** — `ok:true + hints.verifyDelivery` で曖昧さを明示 (§4 規範 shape)
4. **suggest[] は call site でなく `_errors.ts:SUGGESTS` で集中管理** — 同 code が違う suggest を返す inconsistency を SSOT で禁止

---

## 3. Tool 別 verification 契約

28 tool 中、側面別の整理:

- **§3.1 commit 軸 (verification 対象)**: 17 tool / 28 — 本書の主対象
- **§3.2 query 軸 (verification: N/A)**: 11 tool / 28 — side-effect なしのため対象外、justify のみ

### 3.1 Commit 軸 — verification 契約あり

表中 "現在の post-verification" は v1.3.2 時点の実装事実、"期待される verification" は本 SSOT が要求する目標。両者の差分が child issue (#177-#181) の実装スコープ。

| Tool | API レイヤ | 現在の post-verification | 期待される verification | 失敗時 signal | 関連 child issue / PR |
|---|---|---|---|---|---|
| `terminal` (action:`send` BG) | PostMessage WM_CHAR | **Strict** — pre-send baseline + UIA TextPattern read-back (exact + tail-N fallback、150ms settle) | (現状で SSOT 規範) hidden-input prompt detect 済 (#183 完了): baseline 末尾行が password / passphrase / secret / sudo / `Password for ` / `^>$` パターンならverificationを skipし `hints.verifyDelivery: {status:"unverifiable", reason:"hidden_input_prompt", channel:"wm_char", fallback:"method:'foreground'"}` を返す | code: `BackgroundInputNotDelivered` ✅ (既存) / hint: `verifyDelivery.reason='hidden_input_prompt'` (#183) | (PR #174 完了 / #183 完了) |
| `terminal` (action:`send` FG) | SetForegroundWindow + SendInput / clipboard paste | **Strict (focus 不到達 → suppress)** — focus 不到達なら `ForegroundRestricted` typed code で keystrokes 抑止、focus 取れた場合のみ送信 → `detectFocusLoss` で post-send 焦点維持確認 | (現状で SSOT 規範) — FG path は SendInput 射出時 focus 必要、不到達なら silent ok:true ではなく ok:false で early return | code: `ForegroundRestricted` (#202、focus_window と共通) | (PR #202) |
| `terminal` (action:`run`) | send → wait → read 合成 | **Strict** — completion.reason = `quiet`/`pattern_matched`/`timeout`/`window_closed`/`window_not_found`/`send_failed` を区別、`send_failed` は send 側 code を warnings に surface | (現状で SSOT 規範) | reason: `completion.reason='send_failed'` + nested send code (warnings 配列) | (PR #174 完了) |
| `keyboard` (action:`type` BG) | PostMessage WM_CHAR | **None** — `postCharsToHwnd.full=true` の ack のみ | **Strict** — terminal({action:'send'}) BG と同型: pre-send focused-element value 採取 → WM_CHAR 送信 → UIA TextPattern / ValuePattern read-back で input substring 確認 | code: `BackgroundInputNotDelivered` (terminal と共有、同 channel WM_CHAR / 同症状 silent drop) | #177 |
| `keyboard` (action:`type` FG) | SendInput | **Strict (focus 不到達 → suppress)** — focus 不到達なら `ForegroundRestricted` typed code で keystrokes 抑止、focus 取れた場合のみ送信 → `detectFocusLoss` で post-send focus 維持確認 | (現状で SSOT 規範) — terminal:send FG / focus_window と同型 contract | code: `ForegroundRestricted` (#202、focus_window と共通) | (PR #202) |
| `keyboard` (action:`press` BG) | PostMessage WM_KEYDOWN/UP | **None** — `postKeyComboToHwnd` の ack のみ | **Indirect** — combo の semantic 効果 (e.g. ctrl+a で全選択 → SelectionPattern read、ctrl+s で title bar の dirty mark 消失) は target ごとに分岐するため `verifyDelivery: "unverifiable"` hint で degradation を明示。**例外**: enter / tab / arrow は terminal-class なら post-send UIA read-back で文字位置 / 行追加で検出可 | code: `BackgroundKeyNotDelivered` (新規、§5) | #177 |
| `keyboard` (action:`press` FG) | SendInput VK_* | **Strict (focus 不到達 → suppress)** — focus 不到達なら `ForegroundRestricted` typed code で combo 抑止、focus 取れた場合のみ送信 → `detectFocusLoss` で post-send focus 維持確認 | (現状で SSOT 規範) — terminal:send FG / keyboard:type FG / focus_window と同型 contract | code: `ForegroundRestricted` (#202、focus_window と共通) | (PR #202) |
| `mouse_click` | SendInput MOUSEEVENTF_LEFTDOWN/UP | **Indirect (限定)** — `detectFocusLoss` で foreground 変化のみ確認、click が届いたかと focus 維持の区別なし | **Strict (focus 不到達 → suppress) + Indirect (強化、hint で表現)** — homing 経路で foreground 不到達 (Win11 refusal) を検出した時点で **click 自体を suppress** し `ForegroundRestricted` typed code で early return (誤クリック防止)。focus 取れた場合のみ pre-click element under cursor (UIA `ElementFromPoint`) と post-click foregroundWindow / focusedElement / scrollPos の diff で「click が何かに届いた」を確認、`verifyDelivery` 値を 3 値化: `delivered` / `focus_only` / `unverifiable`。**`MouseClickNotDelivered` typed code は §5.2 で予約のみ** — false-positive risk (click が target に消費されたが side-effect が観測経路を持たない app) が高すぎるため emit せず、degradation は `verifyDelivery: focus_only` / `unverifiable` hint で表現する (#178 PR #190 で確定した実装判断、SUGGESTS と classify() は登録済) | code: `ForegroundRestricted` (#202、early-return); hint: `verifyDelivery.status` 3 値 (#178、click 後 verification の表現) | #178 / #202 |
| `mouse_drag` | SendInput sequence | **None** — drag 完了後の状態確認なし | **Indirect (hint で表現)** — drag start/end 周囲の `ElementFromPoint` diff、または target window scroll/move の鏡映観測。tab-drag は別 heuristic (既存 `detectTabDragRisk`) が前段で gate 済なので drag 自体の delivery 検証はその下流。**`MouseDragNotDelivered` typed code は §5.2 で予約のみ** — drag は click より false-positive 率さらに高 (modifier-key state / mid-drag release / dragdrop API target 状態) のため emit せず、`verifyDelivery` hint で degradation 表現 (#178 PR #190 と同実装判断、SUGGESTS と classify() は登録済) | hint: `verifyDelivery.status` 3 値 (#178); code: 予約のみ | #178 (子のサブ) |
| `scroll` (action:`raw`) | SendInput WHEEL_DELTA | **None** — wheel 送信の ack のみ、scroll が起きたかは未確認 | **Indirect** — pre/post で UIA `ScrollPattern` の `VerticalScrollPercent` / `HorizontalScrollPercent` diff、なければ window 内 image hash diff (overflow:hidden ancestor で吸われた case を catch)。**page-end disambiguation**: pre.percent が境界値 (V=0/100、H=0/100) で post も同値 → page-end success (no fail)、pre が境界外で post も同値 → silent drop (`ScrollNotDelivered` fail)。Win32 scrollbar が無い (Chromium overlay) target は既存 `ScrollbarUnavailable` で fallback 案内済 | code: `ScrollNotDelivered` (新規、§5) | #179 |
| `scroll` (action:`to_element`) | UIA ScrollItemPattern + CDP `scrollIntoView` | **Indirect** — element bounds が visible viewport 内に入ったか確認済 (既存実装) | (現状維持) `entity_outside_viewport` 復帰の代理指標として既に厚い | (現状で SSOT 候補、追加 code 不要) | — |
| `scroll` (action:`smart`) | 多経路 (CDP / UIA / image) | **Indirect** — 各 strategy の成功条件を strategy 別に判定 (CDP: scrollIntoView 後の rect、UIA: ScrollItemPattern、image: perceptual hash diff) | (現状維持) | code: strategy 別既存 (`VirtualScrollExhausted` / `OverflowHiddenAncestor`) | — |
| `scroll` (action:`capture`) | screenshot loop + scroll | **Indirect** — frame seam + sizeReduced flag で degradation 表現 | (現状維持) | (現状で SSOT 候補) | — |
| `scroll` (action:`read`) | scroll + OCR | **Indirect** — `stopWhenNoChange` で page-end 検出 | (現状維持) | (現状で SSOT 候補) | — |
| `clipboard` (action:`write`) | Set-Clipboard (PowerShell ラッパ) | **None** — `Set-Clipboard` が成功 (powershell.exe exit 0) のみ確認 | **Strict** — write 直後に `Get-Clipboard -Raw` (= clipboard:read 同経路) で読み戻し → 書込み内容と byte 単位 (UTF-16LE) で一致確認。clipboard format 衝突 (他 app が割り込み Set した) で 不一致のとき surface | code: `ClipboardWriteNotDelivered` (新規、§5) | #180 |
| `focus_window` | SetForegroundWindow + AttachThreadInput **auto-escalate ladder** (default → 100ms wait → re-enum → force → re-enum) | **Indirect (強化)** — post enum で `isActive` 確認、SW_RESTORE 後の rect 取得、Win11 foreground refusal を 2 段 ladder で吸収 | (現状で SSOT 候補) — Win11 foreground-stealing protection で 2 段共拒否時は `ForegroundRestricted` typed code で fail。**silent ok:true は禁止** (#197 で除却済) | code: `WindowNotFound` または `ForegroundRestricted` (#197); 補助 hint: `hints.forceFocusEscalated:true` (default 失敗 → force 成功時) | #197 |
| `desktop_act` | UIA InvokePattern / TogglePattern / setValue / etc | **Strict (per pattern)** — invoke 後の attention signal (`changed` / `dirty` / `settling`) と `next` hint で post-state を caller に明示 | (現状で SSOT 候補) — pattern ごとの成功確認 + attention で曖昧さ吸収 | reason: `executor_failed` (既存、recovery hint 付き) | — |
| `click_element` | UIA InvokePattern / mouse_click fallback | **Indirect** — `isAutoGuardEnabled` の post-perception | (現状維持) — desktop_act の subset、検証契約は同等 | code: `InvokePatternNotSupported` / `ElementDisabled` (既存) | — |
| `window_dock` | SetWindowPos + WM_SIZE | **Indirect** — post.rect 確認 | (現状維持) | (現状で SSOT 候補) | — |
| `workspace_launch` | start app exe + wait | **Indirect** — wait_until で window_appears | (現状維持) | code: `WaitTimeout` (既存) | — |
| `run_macro` | tool sequence 合成 | **per-step verification** — 各 step は所属 tool の verification 契約を継承 | (現状で SSOT 候補) — 本書の他行が直接 apply | (per-step: 各 step の signal が warnings 配列に集約) | — |
| `notification_show` | Win32 toast | **Unverifiable hint emit** (PR #217 / J1 land 後) — `hints.verifyDelivery: {status: "unverifiable", reason: "user_visible_side_effect_uninspectable", channel: "win32_balloon_tip"}` を successful response 全件に emit | **Unverifiable** (規範) — toast が user に reach したかは原理的に観測不能 (OS が consent UI を出すか sink するかは user の Focus Assist 設定依存)。`hints.verifyDelivery: {status: "unverifiable", reason: "user_visible_side_effect_uninspectable", channel: "win32_balloon_tip"}` を返す (channel 値は production NotifyIcon API surface 由来) | (unverifiable hint で表現、追加 code 不要) | PR #217 (J1) |
| `browser_click` | CDP `Runtime.evaluate` で click() dispatch | **Indirect** — element が viewport 内、click() 後の DOM ack | **Indirect (強化、hint で表現)** — click() 直前 / 直後で DOM mutation (例: `aria-pressed` toggle、URL 変化、window onload) のいずれかを確認 + 一定時間内に **何も変わらない** click は `unverifiable` hint。SPA ボタンが何も attach されていない silent-fail を catch。**観測経路 (規範)**: `Runtime.evaluate` で `MutationObserver(document.body, {subtree:true,childList:true,attributes:true})` を click 直前に install → click() dispatch → 500ms timeout で `anySignal = mutationCount > 0 \|\| urlChanged` を判定。`activeElementChanged` は `observedSignals` で報告するが **delivery 信号には含めない** (focusable control への click は handler 不在でも focus を更新するため、focus-only を `delivered` に流すと silent-fail regression を見逃す — browser.ts:1107-1114 で意図的に除外、PR #181 Codex P1 の出発点)。`anySignal` 0 件 → `unverifiable` (reason ∈ {`iframe_context_mismatch`, `no_dom_mutation`, `probe_install_failed`, `probe_read_failed`})。**`BrowserClickNotDelivered` typed code は §5.2 で予約のみ** — false-positive risk が高いため emit せず、degradation は `verifyDelivery: unverifiable` hint で表現 (browser.ts:1136 「we don't escalate to BrowserClickNotDelivered fail」と整合、SUGGESTS と classify() は登録済) | hint: `verifyDelivery.status` **2 値** (`delivered` / `unverifiable`) — CDP 経路では `focus_only` は semantic N/A (UIA 経路 mouse_click family でのみ 3 値、PR #219 J4 narrow); code: 予約のみ | #181 |
| `browser_eval` | CDP `Runtime.evaluate` | **Strict** — `result.value` を返却済 (eval は値を返す API、ack ≠ 値) | (現状維持) | code: `BrowserNotConnected` (既存、CDP 接続失敗) | — |
| `browser_navigate` | CDP `Page.navigate` | **Indirect** — frameStoppedLoading / loaderId | (現状維持) | (現状で SSOT 候補) | — |
| `browser_fill` | CDP `Input.dispatchKeyEvent` + value set | **None** — `Input.dispatchKeyEvent` ack のみ、`element.value` の検証なし | **Indirect (強化)** — fill 後に `element.value` が指定値と一致するか CDP `Runtime.evaluate` で read-back。値が一致しない場合は `BrowserFillNotDelivered` (false-positive 注意: React controlled input が onChange で値を変換した場合は配信成功でも mismatch、§5.2 命名 justify 参照) | code: `BrowserFillNotDelivered` (新規、§5、`BrowserClickNotDelivered` 同系); hint: `verifyDelivery.status` **2 値** (browser_click と同じ CDP 経路 narrowing — `focus_only` は UIA 経路 mouse_click family のみ、PR #219 J4 family inheritance sync) | #181 |
| `browser_form` | fill + submit composite | **per-step verification** — 各 fill は browser_fill の契約を継承、submit は browser_navigate と同等の loaderId 観測 | (現状維持) | (per-step: 各 fill/submit signal が warnings 配列に集約) | — |
| `browser_open` | CDP target attach + tab list | **Indirect** — attach 後の target list rebuild | (現状維持) | code: `BrowserNotConnected` (既存) | — |

合計: **17 commit 軸 tool / 28 行**(複数 action を持つ tool は action 別に行を立てる)。**Phase 3 epic #184 の 8 child issue (#176-#183) と #197/#202 で全 9 行 verification 実装完了**: keyboard(type BG / press BG) #177 / `mouse_click` `mouse_drag` #178 / scroll(raw) #179 / clipboard(write) #180 / `notification_show` (Unverifiable 規範) / `browser_click` `browser_fill` #181 / focus_window auto-escalate #197 / FG path foreground-refusal 統一 #202。`terminal` 各 action は v1.3.2 (PR #174) で完了済のため対象外。**`MouseClickNotDelivered` / `MouseDragNotDelivered` / `BrowserClickNotDelivered` typed code は SUGGESTS と classify() に登録済 + 予約状態** (false-positive risk のため hint level で degradation 表現する実装判断、上記 3 行と §5.2 false-positive policy に詳細注記)。

**Regression test pin**: keyboard:type の foreground-refusal contract は `tests/unit/issue-184-foreground-refusal-pin.test.ts` で pin 済 (PR #208)。残る 3 tool (`keyboard:press` は同 helper `focusWindowForKeyboard` を共有 → 同 pattern 即適用可、`mouse_click` は別 helper `applyHoming` で homing block 内 ladder、`terminal:send` は inline 5-retry + auto-escalate ladder で `findTerminalWindow` mock 必要) の pin は **issue #207 で carry-over** (handler 別 mock scaffolding 固有のため、representative pin の reuse 範囲を超える)。

### 3.2 Query 軸 — side-effect: none → verification: N/A

L5 invariant 2 (`docs/layer-constraints.md` §6.3 invariant 2: query 軸 tool は副作用ゼロ、event_id を新規発行しない) に縛られるため、本書の「送り → 観測 → ok 判定」契約は構文的に存在しない。下表は完全性のため列挙する。

| Tool | 副作用 | 備考 |
|---|---|---|
| `screenshot` | none | LLM 観測専用、PNG 返却 |
| `desktop_state` | none | focused window/element + attention signal |
| `desktop_discover` | none | actionable entities + lease (lease 発行は L4 内部 state、L1 commit ではない) |
| `wait_until` | none | polling 観測のみ。検出した state change を caller に返却 |
| `clipboard` (action:`read`) | none | `Get-Clipboard -Raw` |
| `terminal` (action:`read`) | none | UIA TextPattern / OCR、`sinceMarker` で incremental |
| `server_status` | none | tier 状態など metric 取得 |
| `browser_overview` | none | DOM tree summary |
| `browser_search` | none | DOM 探索 |
| `browser_locate` | none | DOM 解決 |
| `workspace_snapshot` | none | window enum |

合計: **11 query 軸 tool**(verification 対象外)。17 + 11 = 28、tool 不変原則 (§6.3 invariant 6) と整合。

---

## 4. Unverifiable hint の規範 shape

§3.1 で `unverifiable` を選んだ tool は次の形で envelope に hint を載せる。Acceptance Criteria 4 番目 (issue #176) の必須項目。

### 4.1 hint 配置位置

L4 envelope (`docs/architecture-3layer-integrated.md` ADR-010 §5) の `hints` フィールド配下、tool 個別 key として `verifyDelivery` を予約する。既存 hint shape (`hints.target` / `hints.warnings` / `hints.terminalMarker` / `hints.caches`) と同層。

### 4.2 規範 shape

```jsonc
{
  "ok": true,
  // ... tool 固有の payload
  "hints": {
    "verifyDelivery": {
      "status": "unverifiable",                 // "delivered" | "focus_only" | "unverifiable"
      "reason": "wt_xaml_pipeline",             // §4.3 enum 参照
      "channel": "wm_char",                     // 送信した API 経路
      "fallback": "method:'foreground'"          // caller が試すべき次の手 (任意)
    }
  }
}
```

### 4.3 `reason` の typed enum (初期値、追加は本書の §4.3 を直接更新する)

| reason | 意味 | 該当ケース |
|---|---|---|
| `read_back_unsupported` | 送信先が観測経路を提供しない | UIA TextPattern 不在の terminal、browser_eval result が `undefined` |
| `hidden_input_prompt` | echo を抑制する入力 | password / sudo / ssh / Read-Host -AsSecureString。terminal で false-positive 元 |
| `wt_xaml_pipeline` | Windows Terminal XAML host が WM_CHAR を sink するが echo は出る環境差 | `wt_xaml_pipeline` は今は `BackgroundInputNotDelivered` (Strict fail) で扱うが、edge case で degradation 表現が必要なときに使う |
| `embedded_newline` | multi-line input は prompt 割込みで substring includes() が false-fail | terminal({action:'send'}) BG で input に `\n` 含む場合 |
| `multi_strategy_dispatch` | scroll(action:'smart') 等で strategy が image fallback まで降りた | strategy 名と confidence は別 hint で表現 |
| `user_visible_side_effect_uninspectable` | OS / user 環境にしか観測点がない | notification_show、focus assist で suppressed されたかは server から見えない |
| `tier_pinned_observation_missing` | Tier fallback (`server_status` 参照) で観測経路が degraded | hardware-assisted observation が disable な環境 |

`reason` enum の追加は **本書の §4.3 を直接更新する PR を切る** こと。`_errors.ts` の SUGGESTS 拡張と同様の SSOT 扱い。

### 4.4 status 3 値の意味

- `delivered` — Strict / Indirect verification を **passed**。`ok:true` の単独で十分だが、明示が要るときに付与
- `focus_only` — focus 維持は確認できたが click/keystroke が target に消費されたかは未確認 (mouse_click / keyboard FG の Indirect 限界)
- `unverifiable` — Strict / Indirect どちらの観測経路も使えなかった。`reason` 必須

`status` を省略した場合のデフォルトは `delivered`。query 軸 tool は `verifyDelivery` 自体を出さない (副作用が無いので status の概念がない)。

---

## 5. 新規 error code の命名 justify

§3.1 で提案した新 code は `_errors.ts:SUGGESTS` に追加が必要。命名は既存 code (`BackgroundInputNotDelivered` 等) との整合を最優先。

### 5.1 命名規則

`<Channel><Action>NotDelivered` — channel は API 経路 (Background / Mouse / Scroll / Clipboard / Browser…)、action は省略可 (channel から自明な場合)。`NotDelivered` は send 系で配信未確認のとき限定 (受信側 disable / not-found は別 code、`ElementDisabled` / `ElementNotFound` 等の既存)。

### 5.2 提案 code 一覧と justify

| 新 code | 由来 | 状態 | なぜこの命名か |
|---|---|---|---|
| `BackgroundKeyNotDelivered` | keyboard(action:`press` BG) | ✅ Emitted | `BackgroundInputNotDelivered` は WM_CHAR (文字) 軸。WM_KEYDOWN/UP (key combo) は別 channel (postKey vs postChar の API 区別)。combo の semantic 検証は target ごとに違うので、failure mode を別 code にした方が classify と suggest の対応が乱れない |
| `MouseClickNotDelivered` | mouse_click | **🔒 Reserved (not emitted)** | issue #176 body の表に既出。`Background…` 系列とは channel が SendInput で別、SUGGESTS は click 固有 (UIA InvokePattern fallback、focus 維持確認 vs click 配信の区別、desktop_act 経路)。**§3.1 line 144 で「false-positive policy」により emit 格下げ**: click が target に消費されたが side-effect が観測経路を持たない app で false escalation する risk が高いため、production は `verifyDelivery: focus_only / unverifiable` hint で degradation を表現。SUGGESTS と classify() は将来の opt-in に備えて pre-register |
| `MouseDragNotDelivered` | mouse_drag | **🔒 Reserved (not emitted)** | drag は click sequence の特殊形だが failure mode が click とは質的に違う: sequence 中断 (途中で release が抜ける)、modifier-key state (drag 中に Shift/Ctrl が外れる)、tab-drag 検出 (`detectTabDragRisk` 後段)、dragdrop API 経路 (DROPEFFECT 取得失敗) など。`MouseClickNotDelivered` と suggest が異なるので分離 (SUGGESTS dictionary の 1:1 mapping を保つ)。**§3.1 line 145 で同 policy** — false-positive 率が click より高いため reserved |
| `ScrollNotDelivered` | scroll(action:`raw`) | ✅ Emitted | wheel SendInput の delivery 失敗。`OverflowHiddenAncestor` / `ScrollbarUnavailable` は **検出済** の degradation case で既に区別がある。`ScrollNotDelivered` は scroll が API ack 成功したのに ScrollPercent が動いていない silent drop case 用 |
| `ClipboardWriteNotDelivered` | clipboard(action:`write`) | ✅ Emitted | clipboard format 衝突 / 他 app の Set 割り込みで Set-Clipboard 成功後に値が変わっている case。`Write` 明示は read action (副作用なし、対象外) との非対称性を表記 |
| `BrowserClickNotDelivered` | browser_click | **🔒 Reserved (not emitted)** | CDP で click() dispatch が成功しても DOM が応答しない silent SPA-button case。`browser_click` 名前空間で `Browser*` prefix を維持、既存 `BrowserNotConnected` / `BrowserSearchNoResults` 等と命名整合。**§3.1 line 159 で同 policy** — DOM mutation observer の false-positive (CSS animation / unrelated DOM change) で escalate する risk が高いため reserved (`browser.ts:1136` "we don't escalate to BrowserClickNotDelivered fail" と整合) |
| `BrowserFillNotDelivered` | browser_fill | ✅ Emitted | input.value が dispatchKeyEvent 後も指定値にならない case (React controlled input が onChange で書き戻すなど) |

**False-positive policy (PR #208 audit で明文化)**: typed code emit と hint level degradation 表現は SSOT 上 **同等価値**。北極星「`ok:true` を返してよいのは Strict / Indirect / Unverifiable と明示」(§1.3) は hint level でも満たせるため、false-positive risk が高い tool では `verifyDelivery: focus_only / unverifiable` hint で degradation を伝え、typed code は SUGGESTS / classify() に pre-register して将来の policy 反転に備える。**Reserved の 3 code を Emitted に昇格させる場合は別 ADR 起票** (false-positive 率の measurement + opt-in policy 設計)。

### 5.3 既存 code との衝突チェック

`_errors.ts:SUGGESTS` 現行 entry (確認済、Phase 6 cleanup 後 = PR-A -3 + PR-B +1): `InvalidArgs` / `WindowNotFound` / `ElementNotFound` / `InvokePatternNotSupported` / `BlockedKeyCombo` / `UiaTimeout` / `ElementDisabled` / `BrowserNotConnected` / `TerminalWindowNotFound` / `TerminalTextPatternUnavailable` / `BrowserSearchNoResults` / `BrowserSearchTimeout` / `ScopeNotFound` / `WaitTimeout` / `ScrollbarUnavailable` / `OverflowHiddenAncestor` / `VirtualScrollExhausted` / `GuardFailed` / `AutoGuardBlocked` / `LensNotFound` / `BackgroundInputUnsupported` / `BackgroundInputIncomplete` / `BackgroundInputNotDelivered` / `SetValueAllChannelsFailed` / `WorkingMemoryNUpperBoundExceeded` / `EpisodicMemoryNUpperBoundExceeded` / `SemanticMemoryKUpperBoundExceeded` / `ProceduralMemoryKUpperBoundExceeded`

§5.2 の新 code 7 件 (`BackgroundKeyNotDelivered` / `MouseClickNotDelivered` / `MouseDragNotDelivered` / `ScrollNotDelivered` / `ClipboardWriteNotDelivered` / `BrowserClickNotDelivered` / `BrowserFillNotDelivered`) はすべて未使用。collision なし。

### 5.4 `_errors.ts:classify()` への登録

新 code は `_errors.ts` の以下 2 箇所に登録する:

1. `SUGGESTS` dictionary に key と suggest[] 配列を追加
2. `classify()` で `m.includes("...notdelivered")` 系の lowercase substring match を 1 行追加 (既存の `BackgroundInputNotDelivered` パターン参照)

実装時の例 (#177-#181 PR で実コード化):

```ts
// _errors.ts SUGGESTS 内
MouseClickNotDelivered: [
  "Retry with elementName + windowTitle to use UIA InvokePattern (more reliable than pixel click)",
  "Verify the element receives focus on click — some apps consume click without changing foreground",
  "Use desktop_act(lease, action='click') with a freshly-discovered lease",
],

// _errors.ts classify() 内
if (m.includes("mouseclicknotdelivered") || m.includes("mouse click not delivered")) {
  return { code: "MouseClickNotDelivered", suggest: SUGGESTS.MouseClickNotDelivered };
}
```

---

## 6. Acceptance Criteria コード化

issue #176 の Acceptance Criteria に対する本書の対応:

| AC | 対応箇所 | status |
|---|---|---|
| `docs/operation-verification-matrix.md` が main にマージされている | 本書 | (PR merge 待ち) |
| 28 tool 中 "side-effect を起こす" 全 tool の行が表に存在 | §3.1 (17 行) + §3.2 で justify (11 行)、合計 28 一致 | ✅ |
| 各 tool の「失敗時に返すべき code」が明記 | §3.1 各行 "失敗時 error code" 列、新 code 6 件は §5 で justify | ✅ |
| `unverifiable` (検証不能) ケースの hint shape も規範化 | §4 全体 (shape / reason enum / status 3 値) | ✅ |

---

## 7. 後続 child issue の実装手順 (テンプレ)

各 #177-#181 PR は本書の該当行を参照しながら以下を実装する。レビューで「何を verify すべきか」議論を回避する目的。

1. **本書の §3.1 該当行を読む** — "期待される verification" 列をそのまま実装目標にする
2. **`_errors.ts` 拡張** — §5.4 のテンプレに従って新 code を SUGGESTS + classify() に登録
3. **handler 実装** — terminal({action:'send'}) BG path (`src/tools/terminal.ts:299-496`) を規範に、pre-side-effect baseline → side-effect → post-state read-back → 判定
4. **unverifiable case の hint** — §4.2 規範 shape で `hints.verifyDelivery` を返す
5. **E2E テスト** — 本書の verification を skip path で silent-pass しないよう、`tests/e2e/` の skip を `productBugCandidate` / `envOnly` に分類する (#182、Phase 3 残作業)
6. **CHANGELOG** — Changed セクションに新 code 追加、Known limitations に false-positive 既知のものを記載 (terminal の hidden-input 例参照、CHANGELOG v1.3.2 entry)

---

## 8. Out of scope (本書が扱わないもの)

- **各 tool の実コード変更** — 本 PR は doc 起草のみ。実装は #177-#181
- **既存 silent-success の retroactive fix** — 各 child issue で個別対応
- **hidden-input prompt 自動 detect** — #183 で完了。`isHiddenInputPrompt(baselineRaw)` が src/tools/terminal.ts に export される
- **E2E skip path 分類** — 別 issue (#182、Phase 3 残作業)
- **Windows Terminal への信頼性ある BG 入力経路** — Phase 4 (#185、ConPTY ADR)、本 SSOT の verification 契約とは独立

---

## 9. Related Files

- 規範実装: `src/tools/terminal.ts:299-496` (terminal({action:'send'}) BG path)
- error code SSOT: `src/tools/_errors.ts` (SUGGESTS dictionary + classify())
- BG input engine: `src/engine/bg-input.ts` (`canInjectViaPostMessage`、TERMINAL_WINDOW_CLASSES、WT exclusion)
- envelope architecture: `docs/adr-010-presentation-layer-self-documenting-envelope.md`
- L4/L5 layer 制約: `docs/layer-constraints.md` §5-6
- Phase 3 epic: issue #184
- Audit 起源: issue #173 (Phase 1)

---

END OF Operation Verification Matrix (Draft, Phase 3 SSOT).
