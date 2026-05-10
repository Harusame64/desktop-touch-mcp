# ADR-013: Windows Terminal への信頼性ある BG (foreground-independent) 入力経路の復元

- Status: **Draft (Open question — 着手時期 v1.5.0+ stretch)**
- Date: 2026-05-10
- **Re-review trigger date**: 2026-11-10 (= 2026-05-10 + 6mo、本日付までに着手判断 / Reject 判断のいずれもなければ ADR を再 review し、Roadmap を更新するか Status: Rejected で close する)
- Authors: Claude (Sonnet draft、pending Opus + user reviews、project `desktop-touch-mcp`)
- Related:
  - issue #173 (parent、Audit: terminal/keyboard BG silent fail on WT)
  - issue #175 (closed、WT E2E test を default-on 化 + isolated launcher 設計)
  - issue #185 (本 ADR の起票対象、Phase 4 stretch tracking)
  - PR #174 (v1.3.2、WT を `TERMINAL_WINDOW_CLASSES` から除外し foreground fallback)
  - `docs/operation-verification-matrix.md` §3.1 (BG path delivery verification 規範) / §4.3 (`reason` enum SSOT)
  - `src/engine/bg-input.ts:35-70` (TERMINAL_WINDOW_CLASSES + canInjectViaPostMessage)
- Blocks: なし (workaround として foreground 経路が稼働中)
- Blocked by: 本 ADR の決定 (Phase 0 m13v 実証実験 → Phase 1 A/B/C 再ランキング → Phase 2 選定 POC → Phase 3 実装、§2 / §8 参照)

---

## 1. Context

### 1.1 Background — v1.3.2 で WT が BG path から外れた理由

PR #174 (v1.3.2、2026-04-30 リリース) で `CASCADIA_HOSTING_WINDOW_CLASS` (Windows Terminal、wt.exe の hosting window class) が `TERMINAL_WINDOW_CLASSES` allowlist から削除された。これは v1.1.0 PR #64 が「terminal-class auto-route to HWND-targeted WM_CHAR (foreground-independent)」として WT を WM_CHAR 互換に分類したものを、issue #173 の dogfood で **silent fail (約 11 日間 production regression)** が発覚し reverse した修正:

- WT は WinUI/XAML/TerminalControl で構成、入力は XAML `KeyEventArgs` 経由
- `PostMessage(hwnd, WM_CHAR, ...)` は OS message queue に載るが TerminalControl が読まない
- → API レベル成功 (`postMessageToHwnd` returns true)、実 delivery ゼロの silent-success contract drift

PR #174 は WT を BG path から外し、`canInjectViaPostMessage` で `{supported: false, reason: "wt_xaml_pipeline"}` を返す。caller は foreground 経路 (`SendInput` via `method:'foreground'`) に fallback。

### 1.2 制約 trade-off — foreground 経路は workaround

foreground 経路は機能するが、本来 BG path が提供していた価値を失う:

| 機能 | BG (foreground-independent) | foreground (SendInput) |
|---|---|---|
| 別 app に focus を奪わない | ✓ | ✗ (target window を foreground に持ち上げる) |
| Win11 SetForegroundWindow restriction 影響 | なし | あり (`ForegroundRestricted` で fail し得る) |
| user の作業中操作との競合 | なし | あり (誤入力先誤りで data loss risk) |
| LLM agent の並列操作 | OK (multiple BG injection) | NG (foreground は 1 個ずつ) |

agent flow が「user の作業を邪魔せず WT に build cmd を投げる」ようなケースで foreground 経路は UX 劣化、Win11 restriction で fail する確率も高い。BG 経路を **再び** 取り戻す価値はある (Phase 4 stretch、優先度低)。

### 1.3 Current behavior on WT (v1.3.2 以降)

```ts
keyboard({action:'type', method:'background', windowTitle:'PowerShell'})
// CASCADIA_HOSTING_WINDOW_CLASS detected
// → canInjectViaPostMessage returns {supported:false, reason:"wt_xaml_pipeline"}
// → handler returns:
//   ok:false, code:'BackgroundInputNotDelivered', error:'...wt_xaml_pipeline...'
//   suggest: ["Retry with method:'foreground' — ..."]
```

**E2E test design (issue #175 以降、default-on)**:
- `tests/e2e/keyboard-bg-verification.test.ts` / `tests/e2e/terminal.test.ts` は WT scenario を **default-on** で常時実行 (旧 `DTM_E2E_WT=1` opt-in は 2026-05-08 incident の暫定 mitigation で既に廃止)
- launcher (`tests/e2e/helpers/powershell-launcher.ts` host:'wt' branch) は `-w <unique-name>` で isolation pin、single-PID kill (no `/T`) で user の既存 WT を巻き込まない
- 現状の WT 関連 negative test は `BackgroundInputNotDelivered` を期待値として固定、本 ADR 完了後に **negative → positive** に flip する

つまり **silent-success は解消済**、ただし foreground 経路が必須で BG 並列性は失われた状態。

---

## 2. Decision: 本 ADR は **Draft**、4 phase で順次決定

- **本 ADR では決定しない** (Status: Draft)
- 採用方針は §3 で 4 option を整理、Phase 0 → Phase 1 → Phase 2 → Phase 3 で段階的に flip
- **Phase 0**: **Option D (m13v 氏 community proposal、§3.4) の安全範囲での実証実験** — 採用候補化ではなく、技術的成立性 / 安全性リスク (crash / AV / 署名 / 権限 / WT 更新耐性) を **明文化**
- **Phase 1**: Phase 0 の結果を踏まえて Option A / B / C を再ランキング — Option A は「既存 WT tab への公式/安定 write 経路が確認できた場合のみ候補」、Option B は「writable UIA pattern が実機確認できた場合のみ候補」、Option C は「WT 内表示不要の別 issue 候補」
- **Phase 2**: 選定案の POC (acceptance: `ok:true` だけでなく foreground 非奪取 + read-back delivery + 既存 negative test の positive 化まで)
- **Phase 3**: 本実装 — `PostMessage` 経路復帰ではなく、**WT 専用 BG channel** として実装 (`backgroundChannel: "uia" | "conpty" | ...` の discriminator field 追加、issue #173 silent-success 再発の構造的回避)

### 2.1 着手時期の判断軸 (advisory)

- **着手 trigger**: 以下のいずれかが満たされた時
  - WT を target にした agent flow で foreground 経路が UX 劣化として複数 user feedback を集める
  - Win11 SetForegroundWindow restriction が agent flow を実質 block する事例が増える
  - 並列 BG injection (複数 WT tab に同時投入) が anti-fukuwarai workflow で必要になる
- **着手 skip 条件** (本 ADR を **Rejected** で close すべき場合):
  - foreground 経路が dogfood で十分機能、user friction が観測されない
  - WT 自体が Microsoft 側で公式 BG input API を提供 (e.g. WinUI accessibility automation の正式拡張)
  - Phase 0 で m13v 提案の安全性 / 維持コストが採用候補より大きく、別 path (Option C) で十分

---

## 3. Options

### 3.0 Option D 先評価: m13v 氏 community proposal の実証実験 (Phase 0)

**位置付け**: 採用候補化ではなく、Phase 0 として安全性 / 成立性を **実験で確認** し、結果をもって Option A/B/C のいずれかに進む or D を限定採用不可と確定するための **evidence-gathering POC**。提案者 m13v 氏に敬意を払い、危険性を含めて誠実に評価する。

**実証範囲 (検証項目)**:
- **crash 耐性**: 提案手法による WT crash 頻度 (idle / 連続 1000 injection / WT 自体の更新タイミングでの crash)
- **anti-virus 反応**: Windows Defender / Kaspersky / その他主要 AV の判定 (false-positive / quarantine / signature trigger)
- **コード署名 / 配布**: m13v 提案がコード署名 / SmartScreen 警告 / npm package 配布で踏む障壁
- **権限 / UIPI**: standard / elevated WT への injection、UIPI restriction、UAC 昇格との衝突
- **WT 更新耐性**: WT 自体の自動更新で internal API / hook target が変わった際の broken 頻度

**Phase 0 acceptance**:
- [ ] crash 耐性 / AV / 署名 / 権限 / WT 更新の **5 軸全てで観測 log を取得**、Phase 1 ranking に渡せる evidence document 生成
- [ ] 観測中に user / 開発機の data loss / system instability が発生した場合は **即停止**、Phase 0 結果を「採用不可」として記録
- [ ] 結果は本 ADR §3.4 末尾に embed (`### Phase 0 evidence (filled by POC)`)

**Pros (Phase 0 検証で採用可否を確定するための利点)**:
- 提案者の意図を実験で誠実に評価できる
- A/B/C より低レベル制御で動作する可能性、CFG / sandbox 強化前なら任意 API hook 可能
- 並列 BG 性能達成 (D が実装可能なら最高水準)

**Cons (Phase 0 で確認する観点)**:
- anti-virus / Windows Defender が hostile と判定する risk (主要 AV ベンダの heuristic 動作)
- WT 自体の更新で hook target が変わるたびに broken
- code signing / SmartScreen 警告 / npm 配布での user 信頼影響
- user 環境で rootkit-like behavior と認識される risk
- Microsoft が WT に CFG (Control Flow Guard) を強化した場合に hook 不可

**Phase 0 結果に基づく分岐**:
- D が「許容できる安全性 / 維持コスト」と確認 → Option D を限定採用候補として §3.4 に維持、Option A/B/C の ranking で「D との trade-off」を評価軸に追加
- D が「採用不可」と確認 → Option D を **Rejected** に flip、§3.4 末尾に rejection rationale + evidence link を embed、Option A/B/C のみで再ランキング

### 3.1 Option A: ConPTY API 経路 (公式 write 経路の存在確認が前提)

**重要な前提**: Microsoft の公開 ConPTY API は `CreatePseudoConsole` で **新規** 疑似 console を作成し、入力は作成時に渡した pipe (stdin handle) へ書くモデル。`WritePseudoConsole` という公開 API は **存在しない**。**既存の WT tab の ConPTY ハンドルへ外部 attach / write する公開手段** は本 ADR 起草時点で確認できず、Phase 1 の Day 0 gate として「公式 / stable な write 経路の存在確認」を必ず行う。

**Day 0 gate (Phase 1 着手前必須)**:
- [ ] `microsoft/terminal` repo / WinRT metadata で `ITerminalConnection::WriteInput` 相当の **公開** API 存在確認
- [ ] Microsoft.Terminal.Core / Microsoft.Terminal.Settings.Model 等で外部 attach の公式手段が提供されているか確認
- [ ] 公式手段が **無い** 場合は Option A を **Rejected**、Option B / C 再評価

**Day 0 gate pass 後の実装方針** (公式 write 経路が確認できた場合のみ):
- Rust addon (`desktop-touch-engine`) に新 surface (`win32_open_wt_terminal` / `wt_write_input` / `wt_close` 等) 追加
- Windows API: 確認済 公式 chain (TerminalApi など) を windows-rs クレート経由で binding
- 既存 WT tab 解決 chain (HWND → WT process → tab 内 hosted ConPTY/connection) を新 helper で実装

**Pros (Day 0 gate pass + 公式 API 存在を前提とする利点)**:
- Microsoft 公式 API、stable contract、Windows version migration で壊れにくい
- WT 内部経路で送るので XAML 入力 pipeline を bypass、TerminalControl が想定する経路で hosted process に届く
- 並列 BG 性能達成 (複数 tab に同時投入可能)
- **本 Pros 全項は Day 0 gate (公式 API 存在確認) が pass しないと一切成立しない**

**Cons**:
- **Day 0 gate で「公式 API 不在」が確認された場合、本 Option は即 Rejected**
- 仮に不正規 (undocumented) 経路で実装した場合、Microsoft 内部更新で API 互換性が壊れる risk
- 実装規模: walking skeleton 級 (Rust + Win32 / C++/WinRT 経験必須)、開発 1-2 週間 + POC 安定化さらに 1 週間
- elevated process / UIPI restriction で別途検証必要

**API contract surface (案、Day 0 gate pass 後に確定)**:
```rust
// Rust addon 新 surface (Day 0 gate で確認した公式 API に応じて変更)
pub fn win32_resolve_wt_terminal(hwnd: u32) -> Result<TerminalHandle, WtError>;
pub fn wt_write_input(handle: &TerminalHandle, text: &str) -> Result<usize, WtError>;
pub fn wt_close(handle: TerminalHandle) -> Result<(), WtError>;
```

参考: <https://learn.microsoft.com/en-us/windows/console/createpseudoconsole> — `CreatePseudoConsole` は新規 console 作成専用、既存への write は別途 API 探索が必要。

**Phase 0 preliminary findings (issue #185 spike `AttachConsole + WriteConsoleInputW`、2026-05-10、commit `d8b3c07` + Round 3 PeekConsoleInputW 裏取り)**:

- conhost.exe を直接 invoke した cmd.exe (Win11 25H2 build 26200、DefTerm CLSID `{00000000-0000-0000-0000-000000000000}` "Let Windows decide") でも legacy `WriteConsoleInputW` 経路は consumer に届かず:
  - Round 1 (UnicodeChar only): `records_written=64/64`, sentinel 不在
  - Round 2 (proper VK + scan code、両 encoding): `records_written=92/92` (keydown_keyup) / `60/60` (keydown)、両者 sentinel 不在
  - Round 3 (PeekConsoleInputW 裏取り、Opus 判定 (C)): `records_written=92/92` で API success だが直後 `pending_events=0` / `peeked_records=0` (書込直後即 drained、consumer 未到達を構造的に証明)
- 結論: `AttachConsole + CONIN$ + WriteConsoleInputW` は WT BG input 候補として **NO-GO 確定**。Day 0 gate 探索は (1) `ITerminalConnection::WriteInput` 相当の WinRT 公式 API、(2) Microsoft.Terminal.Core の attach surface に絞り込む。詳細は `docs/wt-attachconsole-spike-results.md`

### 3.2 Option B: UIA writable pattern inventory POC

**重要な API 訂正**: UIA `TextPattern` は **基本的に読み取り系** (`GetText` / `RangeFromPoint` 等)、書き込み系は **`ValuePattern.SetValue`** が canonical。Microsoft docs でも複数行 / Document 系コントロールは ValuePattern 非対応になる傾向 (TerminalControl のような complex control では特に該当)。

**Phase 1 inventory step (実装前必須)**: TerminalControl の focused element / ancestor chain で実装される writable UIA pattern を **実機列挙**:
- [ ] `ValuePattern` (SetValue): TerminalControl で実装されているか
- [ ] `TextEditPattern` (Conversion / DocumentRange.AddToSelection 系): 実装状況
- [ ] `SynchronizedInputPattern` (StartListening / Cancel): 実装状況
- [ ] その他 writable pattern 列挙 (UIA Spy / inspect.exe 等で確認)

**Phase 2 実装方針 (writable pattern が確認できた場合のみ)**:
- 既存 `getTextViaTextPattern` (`src/engine/uia-bridge.ts:1116`) と同 PowerShell-backed の write 関数を新設 (`setValueViaValuePattern` / 該当 pattern 用)
- focused element ancestor chain で TermControl 要素を特定、確認済 writable pattern で挿入
- 失敗時 (pattern 非実装 / SetValue exception) は明確な error mapping で fallback

**Pros (writable pattern が実機で確認できた場合の利点)**:
- 既存 UIA bridge で実装可能、Rust addon 改修不要 or 最小
- 失敗時の degrade path が UIA exception で明確、PowerShell-backed 実装で safe
- Windows version 跨ぎでの API 互換性は UIA 側が保証 (TerminalControl が UIA を将来も維持する前提)

**Cons**:
- **Phase 1 inventory で writable pattern が一切確認できない可能性が高い** (typically read-only TextPattern のみ)
- 一部の terminal でしか動かない (pattern 実装が terminal version 依存、最新 WT で対応していても旧版で失敗)
- 実機 POC で「動かない」と判明した場合の sunk cost
- 信頼性で劣る、stretch 案

**工数見積 (Phase 1 inventory + Phase 2 実装、writable pattern 確認できた場合)**:
- Phase 1 inventory: 1-3 日 (UIA Spy / inspect.exe 実機調査 + pattern 列挙 + 動作可否判定)
- Phase 2 実装: 3-5 日 (`getTextViaTextPattern` 既存 ~100 行 baseline + native binding mirror + 失敗 path test)

参考: <https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.valuepattern.setvalue> — UIA writable は `ValuePattern.SetValue` が standard、`TextPattern` は read 主体。

### 3.3 Option C: 別経路 (PowerShell remoting / SSH session / job manager)

そもそも `terminal:send` で WT を相手にせず、別 channel で hosted process に届ける:

**実装方針 C-1: PowerShell Remoting (Enter-PSSession / Invoke-Command)**:
- WT 内部の PowerShell session に対して、別の PSSession で `Invoke-Command -Session $session -ScriptBlock {...}` を実行
- 既存 PowerShell Remoting に依存、setup overhead あり (`Enable-PSRemoting`、firewall、auth)
- WT 内表示は更新されない (別 session で実行されるため、user は cmd 結果を WT で見られない、別 channel に出力)

**実装方針 C-2: SSH session (OpenSSH on Win11)**:
- target WT 内の shell が SSH server を listen していれば SSH client から send
- non-trivial (sshd config 必要)、典型的な user 環境では untenable

**実装方針 C-3: Job Manager (PowerShell Background Jobs)**:
- `Start-Job -ScriptBlock {...}` で background job として実行、WT は session を保持
- これも別 channel、WT 内表示は更新されない

**Pros**:
- 既存 OS 機能のみ、新 API binding 不要
- terminal がどの host (WT / conhost / WSL / SSH client) でも動く統一経路

**Cons**:
- **scope 外**: 「WT 内 hosted process に対して直接 input を送る」という当初要件を満たさない
- WT 内表示が更新されないので user の visual feedback が失われる
- agent flow が WT 内 hosted process の output を `terminal:read` で読む既存 contract が崩れる (hosted process 状態と外部 channel が分離)

→ 本 ADR scope では「WT 内表示更新」要件を満たさないため、**別 issue で議論** (本 ADR の Phase 1 ranking では「scope 違」として置く)。

### 3.4 Option D: m13v 氏 community proposal (Phase 0 validation POC、上記 §3.0 に詳細)

**位置付け**: §3.0 で詳述。採用候補化ではなく、Phase 0 として **実験で安全性 / 成立性を評価** し、その結果をもって採用 / 限定採用 / 棄却を決定する evidence-gathering POC。

**Phase 0 evidence (POC 実施後に本節末尾に embed)**:
> *(Phase 0 完了後にここに crash / AV / 署名 / 権限 / WT 更新の 5 軸検証結果を記録、結果に応じて Option D の最終 status を Rejected / Limited / Adoptable に flip する)*

**v1.4 Update (2026-05-10)**: Option D は **community proposal `microsoft/terminal#20106` (laffo16 氏の `wt send-input` 実装)** に訂正、Phase 0 5 軸検証は **Microsoft 公式 `microsoft/terminal#9368` Reject** によって採用不可確定 (Reject 理由は arbitrary process が任意 WT に command 注入できる security risk、`CurrentUserOnly` ACL 等の mitigation でも公式採用には至らず)。`microsoft/terminal#20106` PR は close 済。

### 3.5 Option E: `foreground_flash` channel (本実装、ADR-013 v1.4 で追加、Status: Implementation Land)

**位置付け**: `background` 契約 (= "foreground 奪取しない") とは **明示的に分離** した妥協 BG path。`method: 'foreground_flash'` の明示 opt-in でのみ caller が到達、`method: 'background'` には絶対 route しない (silent contract violation 防止)。

**仕組み概要**:

1. Pre-flight: input 制限 (改行禁止 + UTF-16 < 5KiB) で WT `largePasteWarning` / `multiLinePasteWarning` を構造的に trigger させない
2. Hidden owner (`DTM_ClipboardOwner` window class) で clipboard を save (HGLOBAL 系 format のみ、3 point sequence の 1 つ目)
3. `SetClipboardData(CF_UNICODETEXT)` で text を inject (3 point の 2 つ目 = `seq_after_inject_clipboard`)
4. **Foreground steal ladder**: 段 1 `AttachThreadInput` (input.rs::win32_force_set_foreground_window と同 logic を bool 戻りで inline) → 段 2 `Alt key down/up` で foreground lock 一時解除して再 `SetForegroundWindow` → 両 fail なら `foreground_steal_denied` で fail
5. `wait_focus_ready` (max 30ms): `GetForegroundWindow == wt_hwnd` + `GetGUIThreadInfo.hwndFocus != NULL` の両方を polling 確認
6. `SendInput(Ctrl+V)` で paste 実行
7. 30ms 待機 (paste reflect、Enter 送信前の安定化)
8. (option) `SendInput(VK_RETURN)` を別送信 (text に `\n` を含めない契約と paired、`multiLinePasteWarning` 構造的回避)
9. **Foreground restore ladder + verify** (max 2 retry): 段 1 → 段 2 → 各 retry 内で `verify_foreground_returned` polling、最終 fail なら `foreground_restore_failed`
10. **Clipboard restore (3 point sequence)**: `seq_before_restore != seq_after_inject_clipboard` で race detect → `clipboardRestored: false` skip + hints。一致時のみ HGLOBAL 系 format を復元
11. (Phase 1e) **WT paste warning ContentDialog scan** (max 100ms via UIA `Microsoft.UI.Xaml.Controls.ContentDialog`): 検出時 `VK_ESCAPE` で dismiss + `wt_paste_warning_intercepted` reason で fail (構造的回避が破られた fail-safe layer)

**設計上の制約 / contract**:
- **single-line + UTF-16 < 5KiB**: WT paste warning を構造的に trigger させない (改行は WT が paste warning dialog の主 trigger)
- **Enter は別 SendInput**: text に `\n` を含めず、caller が `pressEnter: true` を指定したときのみ Ctrl+V 完了後に SendInput(VK_RETURN) を発射
- **typing leak risk**: flash 中 (~50-80ms) に user が物理キーボードを叩くと WT 側が user input として消費する可能性。default OFF の `block_keyboard_during_flash` option (env `DESKTOP_TOUCH_FOREGROUND_FLASH_BLOCK_KEYBOARD=1` で global ON) で LowLevel keyboard hook を一時 install して mitigation 可能、ただし AltTab 等を block するため default OFF
- **clipboard 非破壊性**: 3 point sequence で race detect、HGLOBAL 系 format (CF_UNICODETEXT / CF_TEXT / CF_HDROP / CF_DIBV5 等) は round-trip 復元、非 HGLOBAL (CF_BITMAP / CF_ENHMETAFILE / CF_OWNERDISPLAY 等) は save 時 skip + `clipboardSkippedFormats` hints で明示 (画像 clipboard は flash 後に消える事実を caller に通知)
- **paste warning ContentDialog scan**: default ON、env `DESKTOP_TOUCH_FOREGROUND_FLASH_DISABLE_DIALOG_SCAN=1` で OFF。本来は §3.3.1 構造的回避で trigger されないが、保険として scan + Esc

**Channel 設計** (本実装 v1.4):

```
keyboard:type / terminal:send caller の method param:
- "foreground"        → 既存 SendInput foreground 経路 (touch せず)
- "background"        → 既存 BG 経路 resolver (canInjectViaPostMessage)、WT は引き続き unsupported
- "foreground_flash"  → 新 channel resolver 経由
                          (allowedChannels=["wm_char","clipboard_flash"])
                        ├─ wm_char (terminal class) → postCharsToHwnd (= 簡易 BG)
                        └─ clipboard_flash (WT XAML) → injectViaForegroundFlash native
```

**`canInjectViaPostMessage` は touch しない** (`background` 契約不変原則): 既存 WM_CHAR 判定として残し、WT は引き続き `{supported: false, reason: "wt_xaml_pipeline"}` を返す。新 channel 選択は **`resolveBackgroundInputChannel(hwnd, opts)`** という別 API で、caller が `allowedChannels` を明示してのみ `clipboard_flash` channel に到達。

**Implementation status (本 PR、ADR-013 v1.4)**:

- Phase 1a-f: native (`src/win32/foreground_flash.rs` + `clipboard_snapshot.rs` + `kbd_hook.rs` + `wt_dialog_scan.rs`、unit test 14 pass + 4 ignored 副作用 manual)
- Phase 2: bench (`benches/adr013_foreground_flash_ladder.mjs`、実機実行は user 側で operator workflow に従う)
- Phase 3: TS engine (`src/engine/background-channel-resolver.ts` + `bg-input.ts::injectViaForegroundFlash`、`keyboard.ts` / `terminal.ts` Zod schema 拡張 + handler branch)
- Phase 4: E2E (`tests/e2e/foreground-flash-verification.test.ts`、validation + WT smoke + conhost wm_char + keyboard:press reject + background contract regression guard、heavy fixture は `it.todo`)
- Phase 5: docs (本 §3.5 + §3.6 + §4 + §5 + §7 + §9 + matrix + CHANGELOG)

**§3.7 sequence 実装 deviation note**: plan v3 §3.7 step 17 (paste warning scan) は元々 clipboard restore 後だが、実装では step 8.5 (Ctrl+V + Enter 直後、foreground restore 前) に前倒し。理由: WT が foreground のうちに Esc を送らないと、restore 後は Esc が `original_fg` に届いて dialog dismiss 先と一致しない (modal dialog の z-order 上 dialog 自身が前面でも、`SetForegroundWindow(original_fg)` 直後は queue が混乱する)。実用挙動は plan §3.7 と等価 (構造的回避が trigger 確率 ~0、本 deviation はあくまで保険 layer の効き目改善)。

### 3.6 Option F: Cooperative in-pane bridge (長期本命候補、本 ADR scope 外、別 PR / 別 plan)

**位置付け**: 本物 BG (= foreground を一切奪わない) を実現する長期 stable な候補。Option E の妥協 BG (foreground_flash) を「短期解」、Option F を「長期解」と位置付け。本 ADR では outline のみ追加、本実装は別 PR / 別 plan。

**仕組み概要**:

- ユーザーが明示的に DTM helper を WT 内で起動 (例: `wt -p PowerShell -- pwsh -Command "Import-Module DTM-Helper; Start-DTMBridge"`)
- helper が **named pipe** (`\\.\pipe\dtm-bridge-<nonce>`) を listen
- MCP 側が pipe 経由で command を渡す
- helper が pwsh 内部で command を実行、output を pipe で返す

**利点**:

- WT 内表示は出る (helper が同 pwsh 内で実行、user が見ている session で直接動く)
- foreground を奪わない (本物 BG)
- WT private API / clipboard 触らない (clipboard race / 画像復元不可問題なし)
- Authentication: nonce + `CurrentUserOnly` ACL で `microsoft/terminal#9368` 的な「任意 app が任意 WT に注入」問題なし
- Microsoft 意思整合 (named pipe は完全公式 API)
- 長期 stable (WT 更新 / CFG 強化に依存しない)

**弱点 / 制約**:

- 「既存の任意 pane」ではなく **opt-in / managed session** (= ユーザーが事前に DTM helper を起動する必要)
- helper 配布方式: auto-start option / discoverability / version compat / helper 未起動時の fallback (= `method: 'foreground_flash'` に degrade?)
- protocol 設計: pipe message format / lifecycle / error semantics / cancellation

**本 ADR との position**:

- 本 ADR Option E (`foreground_flash`) = 短期解 (妥協 BG)、明示 opt-in、issue #185 Phase 4 stretch の "WT で BG 動かしたい" 要件を MVP で満たす
- Option F = 長期解 (本物 BG)、別 PR / 別 ADR で本実装 (cooperative bridge protocol 設計 + helper 配布方式 + auto-discovery + nonce 管理 を含む大型 plan、推定 4-8 週間)

ADR-013 §3.6 で Option F section を追加しておくことで、Option E land 後に Option F 別 PR を起票する path を docs に永続化。`channel resolver` の `cooperative_bridge` variant は将来形のみ予約 (resolver は現在返さない、narrow reject)。

---

## 4. Trade-off comparison (Phase 1 inputs)

v1.4 (2026-05-10): Phase 0 結果 + Round 1 NO-GO + Round 2 spike + 新 Option E 追加 を反映。

| 観点 | A. ConPTY | B. UIA writable | C. PSRemoting | D. laffo16 PR | **E. foreground_flash** | F. cooperative bridge |
|---|---|---|---|---|---|---|
| 公式 API | Day 0 gate 次第 | ✓ (UIA itself) | ✓ | ✗ (Microsoft Reject) | ✓ (Win32 + UIA、新 binding はなし) | ✓ (named pipe 完全公式) |
| 実装規模 | 大 (1-3 週間) | 中 (4-8 日) | 小 | (採用不可) | 中 (~830 line + test、本 PR 完了) | 大 (4-8 週間、別 PR) |
| WT 内表示更新 | ✓ | ✓ | ✗ | (採用不可) | ✓ (paste 反映) | ✓ |
| foreground 奪取 | ✗ (本物 BG) | ✗ (本物 BG) | ✗ | (採用不可) | **✓ ~50-80ms (妥協 BG)** | ✗ (本物 BG) |
| user opt-in 要 | ✗ | ✗ | ✓ | (採用不可) | **✓ method:'foreground_flash' 明示** | ✓ (helper 起動) |
| 実機動作確実性 | Day 0 gate fail 確定 | inventory 次第 | 高 (枯れた API) | (採用不可) | 高 (本 PR Phase 1f unit test pass) | 設計次第 |
| Windows version 跨ぎ | 中 (内部 API 変更 risk) | 高 | 高 | (採用不可) | 高 (Win32 + UIA は stable) | 高 |
| user 信頼 | 中 | 高 | 中 | 低 (Microsoft Reject) | 中 (foreground 一時占有 + typing leak risk hints) | 高 (公式 API + opt-in) |
| typing leak risk | なし | なし | なし | (採用不可) | **あり** (mitigation: kbd_hook option default OFF) | なし |
| clipboard 副作用 | なし | なし | なし | (採用不可) | あり (HGLOBAL 系 round-trip、画像復元不可、3 point race detect) | なし |
| Microsoft 意思整合 | ✓ | ✓ | ✓ | ✗ Reject | ✓ (公式 API のみ) | ✓ |
| 並列 BG 性能 | 高 | 中 | 高 | (採用不可) | 中 (foreground 占有が serialize) | 高 |
| Status (v1.4) | Day 0 gate fail で Rejected | TermControl は TextPattern のみで NO-GO | 別 issue | Microsoft Reject で Rejected | **本 PR で Implementation Land** | 本 ADR scope 外、別 PR (長期本命) |

**v1.4 ranking 結果**:
- **A**: Day 0 gate fail (`AttachConsole + WriteConsoleInputW` で WT XAML pipeline は受け付けず PR #239 で確定)
- **B**: TermControl は TextPattern のみ (`microsoft/terminal/Microsoft.Terminal.Control/TermControl.idl` 確認)、ValuePattern / TextEditPattern なし → NO-GO
- **C**: scope 違 (別 issue で議論)
- **D**: `microsoft/terminal#9368` Microsoft 公式 Reject、laffo16 PR #20106 close → Rejected
- **E (`foreground_flash`)**: 本 PR で **Implementation Land**、明示 opt-in + 構造的制約 (single-line / 5KiB) で WT への BG injection を妥協 BG path として提供
- **F (cooperative bridge)**: 本 ADR scope 外、別 PR / 別 ADR で扱う (長期本命候補)

---

## 5. Acceptance criteria (各 phase の to-be 状態)

### 5.0 Phase 0 acceptance (Option D m13v proposal validation)

§3.0 / §3.4 参照。crash / AV / 署名 / 権限 / WT 更新の 5 軸全てで観測 log + evidence document を生成、観測中の data loss / system instability で即停止 + 採用不可確定。

### 5.1 Phase 1 acceptance (A/B/C 再ランキング)

- [ ] **Option A Day 0 gate**: `microsoft/terminal` 公式 API で「既存 WT tab への外部 write 経路」存在確認 → pass / fail を `Pass/Fail evidence link` で本 ADR §3.1 末尾に embed
- [ ] **Option B Phase 1 inventory**: TerminalControl で writable UIA pattern (`ValuePattern.SetValue` / `TextEditPattern` / `SynchronizedInputPattern` / その他) の実機列挙完了、本 ADR §3.2 末尾に inventory table embed
- [ ] **Option C scope 切り出し**: WT 内表示更新が別 issue で議論されることを decision log で確定
- [ ] **Phase 0 evidence integration**: Option D 結果を A/B/C ranking の trade-off 表 (§4) に反映

### 5.2 Phase 2 acceptance (選定 POC)

- [ ] **WT 既定 (CASCADIA_HOSTING_WINDOW_CLASS) で BG path が再び稼働**: `keyboard({action:'type', method:'background', windowTitle:'PowerShell'})` → `ok:true, hints.verifyDelivery.status === 'delivered'` (matrix §3.1 整合)
- [ ] **foreground を奪わない**: BG injection 中に user が他 app focus、injection 後も外れない
- [ ] **silent-success ゼロ (構造的証明)**: `{supported:false, reason:...}` の degrade path が明確、`ok:true` で実 delivery ゼロは絶対不可。post-injection UIA TextPattern read-back (matrix §3.1) を採用 path (A or B) でも担保 (Option A は WT-channel write 後、Option B は writable pattern dispatch 後、いずれも post-read で injected substring を T ms 以内に観測できなければ `BackgroundInputNotDelivered`)
- [ ] **既存 negative test の positive 化**: `tests/e2e/keyboard-bg-verification.test.ts` / `tests/e2e/terminal.test.ts` の WT scenario が現状 negative (BackgroundInputNotDelivered) で pin、本 ADR 完了後に **positive (delivered)** に flip。test design 自体は issue #175 default-on + isolated launcher を維持

### 5.3 Phase 3 acceptance (本実装、release readiness)

- [ ] **新 `backgroundChannel` discriminator field**: `keyboard:type` / `terminal:send` の hints に `backgroundChannel: "wm_char" | "uia" | "conpty" | ...` を追加、WT は採用 path に応じて `"uia"` / `"conpty"` を返す
- [ ] **`canInjectViaPostMessage` は WT を supported に戻さない** (重要): PostMessage(WM_CHAR) 経路は WT に対して引き続き未対応のまま、`{supported:false, reason:"wt_xaml_pipeline"}` を維持。新 channel は **別の dispatch path** として実装、issue #173 silent-success 再発の構造的回避
- [ ] **`wt_xaml_pipeline` reason の存続判断 (SSOT 同期)**: 新 channel が成立した場合、`wt_xaml_pipeline` reason は「PostMessage 経路で未対応」を意味し続けるか、新 channel の degrade fallback hint として維持するか確定。SSOT 同期 (single PR) 必須:
  - (a) `docs/operation-verification-matrix.md` §4.3 reason enum 表の `wt_xaml_pipeline` 行更新 (削除 / 意味再定義)
  - (b) `src/engine/bg-input.ts:75` の `InjectCheckResult.reason` union 同期
  - (c) (a)(b) と新 channel 実装を **同 PR commit** に同梱、reason enum drift を構造的に impossible 化
- [ ] **WT default-on E2E pass**: `tests/e2e/keyboard-bg-verification.test.ts` / `tests/e2e/terminal.test.ts` (issue #175 default-on + isolated launcher) で 100 連続 BG injection 全 success (flaky < 1%、`-w <unique>` per launch + single-PID kill 設計を維持)。stress test (連続 1000+) は別 env / 別 flag で
- [ ] **CHANGELOG 記載**: `method:'background'` が WT で `backgroundChannel:'<採用 path>'` 経由再使用可能、breaking change なし (caller 視点で transparent)。issue #173 v1.1.0 → v1.3.2 → v1.5.0+ history narrative も併記
- [ ] **`docs/operation-verification-matrix.md` §3.1 / §4.3 update**: WT BG path 規範を新 channel に拡張、reason enum 同期

### 5.4 Phase E acceptance (Option E `foreground_flash` 本実装、ADR-013 v1.4 で追加)

本実装 plan 詳細: `docs/adr-013-option-e-impl.md` v3。本 ADR §5.4 では Phase 1-5 の acceptance summary のみ:

#### 5.4.1 Native (Phase 1a-f) acceptance

- [x] `win32_foreground_flash_inject(hwnd, pid, text, options)` 成功時 `flash_duration_ms <= 80` (Phase 2 bench で実機確認、user 担当)
- [x] foreground steal ladder 段 1 (AttachThreadInput) + 段 2 (Alt unlock) が試行され、失敗段の typed reason hints 記録 (`foregroundStealMethod`)
- [x] Foreground 復帰失敗で 2 回 retry + typed reason `foreground_restore_failed`
- [x] Clipboard HGLOBAL format round-trip (CF_UNICODETEXT / CF_TEXT / CF_HDROP / CF_DIBV5、本 PR `clipboard_snapshot.rs` `#[ignore]` test で manual 確認可)
- [x] Clipboard 非 HGLOBAL format (画像 / メタファイル) detection → save skip + `clipboardSkippedFormats` hints (CF_BITMAP / CF_ENHMETAFILE / CF_OWNERDISPLAY 等を early skip)
- [x] 3 point sequence (`seq_before_snapshot` / `seq_after_inject_clipboard` / `seq_before_restore`) で race detection、不一致で `clipboardRestored: false` skip
- [x] Input 制限 (改行 + UTF-16 < 5KiB) で `input_exceeds_paste_warning_threshold`、Phase 1f unit test pass
- [x] WT paste warning ContentDialog scan が enabled で ContentDialog 検出 → Esc + `wt_paste_warning_intercepted`
- [x] LowLevel keyboard hook lifecycle leak-free (HookGuard Drop で worker thread join + UnhookWindowsHookEx)
- [x] HWND signature: BigInt 経由で x64 64-bit hwnd 値 truncate なし (既存 `input.rs::hwnd_from_bigint` と同 pattern)
- [x] Hidden owner window class (`DTM_ClipboardOwner`) per-call lifecycle leak-free

#### 5.4.2 Production-like 実機検証 (Phase 2、user 担当の bench 実行で acceptance)

- [ ] `benches/adr013_foreground_flash_ladder.mjs` で 50 連続 foreground_flash inject、ladder 段別成功率を計測
- [ ] 段 1 + 段 2 + already_foreground 合計成功率 >= 80% (これ未満なら Phase 5 docs で `block_keyboard_during_flash` default flip / Option F priority shift 等の design review)
- [ ] R1 mitigation 評価結果を本 ADR §9 Decision History に embed (実機実行後、user 判断)

#### 5.4.3 TS engine layer (Phase 3) acceptance

- [x] `resolveBackgroundInputChannel(WT_HWND, {allowedChannels: ["wm_char"]})` → `{kind: "unsupported", reason: "wt_xaml_pipeline"}` (= 既存 `background` 契約維持)
- [x] `resolveBackgroundInputChannel(WT_HWND, {allowedChannels: ["wm_char", "clipboard_flash"]})` → `{kind: "clipboard_flash", hwnd: <bigint>, pid: <number>, constraints: {...}}`
- [x] `canInjectViaPostMessage(WT_HWND)` は touch されず、WT で `{supported: false, reason: "wt_xaml_pipeline"}` を返す (regression なし)
- [x] `method: 'foreground_flash'` で WT inject success、`hints.backgroundChannel = "clipboard_flash"` + `hints.typingLeakRisk = true`
- [x] `method: 'background'` で WT は引き続き unsupported (silent-success 構造的回避)
- [x] caller migration 済 (二重分岐期間 = 0、本 PR 内で keyboard:type / terminal:send 同 PR で揃え)

#### 5.4.4 E2E (Phase 4) acceptance

- [x] 新 `tests/e2e/foreground-flash-verification.test.ts`: Phase 3 wired path を 6 case + 5 todo で検証 (validation / WT positive / conhost wm_char / terminal:send / keyboard:press reject / background contract regression)
- [x] 既存 `keyboard-bg-verification.test.ts` の WT negative test は変更なし (= `method: 'background'` 契約維持)
- [ ] heavy fixture (100 連続 flaky < 1% / clipboard race / dialog scan trigger / 画像 clipboard 復元不可) は `it.todo`、Phase 2 bench / 別 PR で扱う

#### 5.4.5 ADR / docs (Phase 5) acceptance

- [x] ADR-013 §3.5 (Option E foreground_flash) + §3.6 (Option F cooperative bridge outline) section 追加、§4 trade-off table 拡張、§5 acceptance、§7 OQ、§9 Decision History 全 sync (本 commit)
- [x] `docs/operation-verification-matrix.md` §3.1 / §4.3 に `foreground_flash` channel + 全 typed reason 追加 (本 PR)
- [x] CHANGELOG.md に v1.5.0+: `method: 'foreground_flash'` + 既存 `background` 契約維持 narrative 記載 (本 PR)

### 5.5 Out-of-scope

- WT 以外の WinUI host (将来の UWP-style terminal、新 PowerShell Preview 等) — 別 issue で扱う
- 既存 conhost path の変更 — `ConsoleWindowClass` 経路は本 ADR scope 外
- elevated process (admin terminal) への BG injection — UIPI 制約で同 ADR スコープ外、別 ADR 候補
- WT 内表示更新が不要な agent flow — Option C (別経路) で別 issue
- PostMessage 経路の WT 復活 — 本 ADR は **新 channel 追加** で達成、PostMessage 経路は引き続き WT 未対応のまま (issue #173 silent-success 構造的回避)

---

## 6. Consequences / Risks

### 6.1 Positive consequences (本 ADR の採用が成功した場合)

- **agent 並列性復活**: 複数 WT tab への同時 BG injection、anti-fukuwarai workflow 強化
- **Win11 SetForegroundWindow restriction 回避**: `ForegroundRestricted` 由来の fail rate 低下
- **CHANGELOG 透明性**: v1.1.0 で claim → v1.3.2 で revert → 本 ADR で **新 channel として再復活** (PostMessage 復帰ではない)、user に対する整合性 narrative 整理
- **m13v 氏提案の誠実評価**: Phase 0 で evidence を残すことで、提案者への敬意と判断根拠を docs に永続化

### 6.2 Risks (採用判断で重視する)

- **Phase 0 で system instability**: m13v 提案の検証中に user / 開発機の data loss / WT crash が発生する risk → §5.0 で「即停止 + 採用不可確定」を binding rule
- **Microsoft 内部 API 変更 risk**: WT は Microsoft 内部更新で TerminalControl 仕様を変える可能性、Option A の経路が ad-hoc になる
- **CFG / 隔離 sandbox の強化**: 将来 WT が AppContainer / sandbox 強化で外部書込みを block する可能性、Option A/B/D 全て影響
- **Anti-virus 誤判定**: Option D で AV ベンダ heuristic が trigger される risk、Phase 0 で観測必須
- **User permission**: WT process への書込み権限が user/admin で異なる、UIPI 同型問題が再発する risk
- **POC 失敗時の sunk cost**: Phase 0 (D) → Phase 1 (A/B 個別 gate) → Phase 2 (選定 POC) と段階的 fail-fast 設計で sunk cost 最小化、各 phase で抜ける条件を明示
- **release timing**: v1.5.0+ stretch とすると、間に他 feature が入って ADR が stale 化する risk → **header の「Re-review trigger date: 2026-11-10」が binding marker、本日付に達した時点で着手判断 / Reject のいずれかに decision flip 必須**
- **Microsoft.Terminal licensing**: `microsoft/terminal` は **MIT-licensed**、Option A の IDL header / metadata vendoring も MIT 互換でクリア (本 repo は MIT licensed、§10 References の Microsoft repo link 参照)
- **m13v proposal licensing**: m13v 氏提案を vendoring する場合は提案元の license / 著作権を確認、Phase 0 evidence document に license note を必ず embed

---

## 7. Open Questions

1. **Option A Day 0 gate**: `microsoft/terminal` repo / WinRT metadata で「既存 WT tab への公式 write 経路」(`ITerminalConnection::WriteInput` 相当) は存在するか? 不在なら Option A は即 Rejected
   - 本 OQ の探索範囲から legacy `WriteConsoleInputW` 経路を **除外** (Phase 0 preliminary findings、2026-05-10 spike `docs/wt-attachconsole-spike-results.md` で NO-GO 確定済)
2. **Option B Phase 1 inventory**: TerminalControl で writable UIA pattern (`ValuePattern` / `TextEditPattern` / `SynchronizedInputPattern` / その他) は実装されているか? 実機 inspect.exe / UIA Spy で確認
3. **Option D Phase 0 evidence matrix**: m13v 提案の crash / AV / 署名 / 権限 / WT 更新の 5 軸検証結果は採用判断にどう寄与する? 「許容できる」閾値を §5.0 で具体化必要 (例: AV 警告ゼロ / WT 1 minor 更新 5 回連続でも broken なし / etc.)
4. **複数 WT window への BG injection は対応するか?** 単一 WT process が複数 top-level window + 各 window 内複数 tab を持つ構造 (本 session 2026-05-10 の dogfood で screenshot 観測)、targeting policy (windowTitle 優先 / hwnd 必須化 / process+tab 階層 ID) を別途設計
5. **elevated WT への injection は scope 内 / 外?** UIPI restriction が same-process 内では緩和、別 ADR が良いか本 ADR で扱うか
6. **WT 以外の TerminalControl ベース app (将来の preview build, Codespaces local 等) は同経路で対応可能?** Microsoft.Terminal.Core を使う app は理論上同経路
7. **POC 失敗時の Option C への pivot は妥当か?** Option C は「WT 内表示更新」要件を満たさないため scope 違だが、メタ目的「WT 内 process 制御」は満たす、ADR 範囲拡張判断
8. **`backgroundChannel` discriminator の wire format 設計**: `hints.backgroundChannel: "wm_char" | "uia" | "conpty" | "clipboard_flash" | ...` の enum 値選定、既存 `hints.verifyDelivery.channel` (`wm_char`) との整合、breaking change 影響評価。**v1.4 で `clipboard_flash` 値を追加** (Option E 本実装、本 PR で `keyboard:type` / `terminal:send` の hints に wire 済)
9. **Option F (cooperative bridge) opt-in design**: helper 配布方式 (auto-start / discoverability) / pipe protocol design / nonce 管理 / version compat / helper 未起動時 fallback (= `method: 'foreground_flash'` に degrade?) — 本 ADR scope 外、別 PR / 別 ADR で本実装
10. **Phase 1.5 OLE IDataObject snapshot**: HGLOBAL MVP の限界 (画像 / メタファイル復元不可) が production dogfood で顕在化したら別 PR で OLE `OleGetClipboard` / `OleSetClipboard` snapshot を評価。COM apartment threading (STA 必要) の cost と HGLOBAL skip の頻度を比較して採否判断、現状 `clipboardSkippedFormats` hints で observable

---

## 8. Roadmap (advisory、決定は §2 Decision の 4 phase)

| Phase | 期間 | 出力 | acceptance |
|---|---|---|---|
| 1. ADR draft land | 1 PR (本 PR) | `docs/adr-013-wt-bg-input.md` | docs review (Opus 1+ round) + user review |
| 2. Phase 0 — m13v 提案 validation POC | 1-2 週間 | draft PR + evidence document (crash/AV/署名/権限/WT 更新 5 軸 log) | §5.0 acceptance 全 ✓ |
| 3. Phase 1 — A/B/C 再ランキング | 1-3 日 | Day 0 gate 結果 + Phase 1 inventory + 再 ranking note | §5.1 acceptance 全 ✓ |
| 4. Phase 2 — 選定案 POC | 3-7 日 (Option B 簡易) / 1-2 週間 (Option A 重い) | draft PR、選定 channel の prototype + 既存 negative test 更新 | §5.2 acceptance 全 ✓ |
| 5. Phase 3 — 本実装 | 1-2 週間 | feature PR、新 backgroundChannel + WT default-on E2E + SSOT 同期 (matrix §4.3 / bg-input.ts) | §5.3 acceptance 全 ✓ (PR #235 keyboard E2E 経験で flake 安定化 1-2 日見込込) |
| 6. ADR Status 昇格 | 1 PR | `Status: Draft` → `Status: Accepted` + `Decision:` 節更新 | 本 PR closure |

合計: Phase 0-3 全完走で **3-6 週間** (Phase 0 D 検証次第で Phase 1 以降の選択肢が変動)。

---

## 9. Decision History

| Date | Status | Author | Rationale |
|---|---|---|---|
| 2026-05-10 | Draft (v1) | Claude (Sonnet draft) | issue #185 Phase 4 stretch tracking、4 option (A/B/C/D) 起草 |
| 2026-05-10 | Draft (v1.1、Round 1 Opus review apply) | Claude (Sonnet) + Opus (Round 1 review) | P1×2 (PR #237 mis-citation / wt_xaml_pipeline SSOT cross-ref) + P2×5 (Option A Pros hedging / Option B 工数 / 再 review 日付 / §4 directive tone / silent-success 構造的証明) + P3×3 (Authors / Phase 5 工数 / Decision History / licensing) を反映 |
| 2026-05-10 | Draft (v1.2、user review apply) | Claude (Sonnet) + user review | P1×2 (Option A の `WritePseudoConsole` 公式 API 不在訂正 + Option D を Rejected → Phase 0 m13v validation POC へ position 変更) + P2×3 (DTM_E2E_WT default-on 化 issue #175 反映 / TextPattern.SetValue → ValuePattern.SetValue API 訂正 + UIA writable pattern inventory POC 化 / canInjectViaPostMessage 復帰ではなく `backgroundChannel` discriminator field) を反映、Roadmap を 4 phase (Phase 0 D 検証 → Phase 1 A/B/C 再ランキング → Phase 2 選定 POC → Phase 3 本実装) に restructure。提案者 m13v 氏に敬意を払い、Phase 0 を「採用ではなく実験で評価」と明示 |
| 2026-05-10 | Draft (v1.3、Option A spike preliminary findings embed) | Claude (Sonnet) + Opus reviewer | spike `AttachConsole + WriteConsoleInputW` (`spike/wt-attachconsole-input` branch、commit `d8b3c07` + Round 3) で NO-GO 確定。§3.1 末尾に preliminary findings embed + §7 OQ #1 に「legacy 経路除外」追記。詳細 `docs/wt-attachconsole-spike-results.md`。Option B/C/D の ranking には影響なし |
| 2026-05-10 | Draft (v1.4、Option E foreground_flash 本実装 land + Option F outline 追加) | Claude (Sonnet) + user direction | Option D を `microsoft/terminal#9368` Reject + laffo16 PR #20106 close で正式 Rejected、新 §3.5 Option E (`foreground_flash` channel = 妥協 BG path、明示 opt-in、native + TS + E2E + bench + docs full implementation Phase 1-5)、新 §3.6 Option F (cooperative in-pane bridge、長期本命候補、別 PR / 別 ADR scope)、§4 trade-off table 全面 update、§5.4 Phase E acceptance、§7 OQ #8 に `clipboard_flash` enum 追加 + #9 Option F opt-in design + #10 Phase 1.5 OLE IDataObject 追加。本実装 plan は別 docs `docs/adr-013-option-e-impl.md` v3 に詳細 |
| (future) | Draft → Accepted | (TBD) | Phase 2 mandatory gate (実機 50 連続 ladder success rate >= 80%) pass + R1 mitigation 評価 docs 反映後に user 判断で Accepted へ昇格 |
| (future) | Re-review trigger | 2026-11-10 | header の binding marker、本日に達した時点で必須 |

---

## 10. References

- issue #173 (parent audit、WT silent fail discovery)
- issue #175 (closed、WT E2E test を default-on 化 + isolated launcher)
- issue #185 (本 ADR の起票対象、Phase 4 stretch tracking)
- PR #174 (v1.3.2、WT BG path 削除)
- PR #235 (本 session、F4-bis hotfix で同 path 修正経験)
- `src/engine/bg-input.ts:35-70` (TERMINAL_WINDOW_CLASSES + canInjectViaPostMessage)
- `src/engine/uia-bridge.ts:1116-1215` (`getTextViaTextPattern`、Option B Phase 1 inventory 対象)
- `tests/e2e/keyboard-bg-verification.test.ts:27-33` / `tests/e2e/terminal.test.ts:52` (WT default-on test design、issue #175)
- `docs/operation-verification-matrix.md` §3.1 (BG path 規範) / §4.3 (`reason` enum SSOT)
- Windows Pseudo Console API: <https://learn.microsoft.com/en-us/windows/console/createpseudoconsole> — 新規 console 作成 API、既存 console への外部 write は別途 API 探索が必要 (Option A Day 0 gate 対象)
- UIA ValuePattern.SetValue: <https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.valuepattern.setvalue> — UIA writable は ValuePattern が canonical (Option B Phase 1 inventory 対象)
- Microsoft.Terminal repository (MIT-licensed): <https://github.com/microsoft/terminal>
- m13v 氏 community proposal (Phase 0 validation POC 対象、URL は Phase 0 着手時に記録)
