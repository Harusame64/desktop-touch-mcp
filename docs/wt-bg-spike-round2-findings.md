# WT BG Input/Output Spike — Round 2 Research (ADR-013 範囲外探索)

> 2026-05-10
>
> issue #185 / ADR-013 §3 の **A/B/C/D 4 候補 + Phase 0 NO-GO (AttachConsole)** **以外** の WT BG input / output 経路を探索した記録。
> 手元実機検証 + Background Agent (Opus) web research の結果を統合。
>
> 本 docs は **spike scope** (PR/review skip、commit ベース、`feedback_spike_pr_consolidation.md` 整合)。production 反映は別 phase。

---

## 1. 主要 4 finding (即報告候補)

### A. WT TermControl の writable UIA pattern は **一切実装されていない** (Option B Phase 1 inventory NEGATIVE)

`scripts/spikes/wt-uia-inventory.ps1` で実機 dump、TermControl element (`ControlType.Text`, `ClassName=TermControl`) は **`TextPattern` のみ** 実装。`ValuePattern` / `TextEditPattern` / `SynchronizedInputPattern` / `RangeValuePattern` / `InvokePattern` (text 入力に有用なもの) **全て不在**。

```
ControlType         ClassName     Name                  Patterns
ControlType.Tab     TabView       (none)                SelectionPattern
ControlType.List    ListView      TabListView           SelectionPattern, ScrollPattern
ControlType.SplitButton ...       新しいタブ            InvokePattern, ExpandCollapsePattern
ControlType.Custom  (none)        (none)                (none)
ControlType.Text    TermControl   DTM_UIA_INV_xxx       TextPattern  ← read-only
```

→ **ADR-013 §3.2 Option B (UIA writable pattern POC) は NO-GO 確定**。Phase 1 inventory の acceptance criterion を実機で fail。

### B. `wt send-input` subcommand は Microsoft 公式に **Reject 確定** (issue #9368、2026-04-13、DHowett)

WT 開発者 DHowett が issue #9368 を **"rejected"** で close、引用:
> "I have not stopped worrying about the security risk this opens up, and so I am going to move this to the rejected state"

draft PR #20106 (laffo16、2026-04-12) で実装が完成していたが、**同時に close**。これは **WT team の意思表示** で、将来の send-input 系機能 (Monarch COM 経由 / 内部 IPC 経由 / pipe 経由) **全般への構造的逆風**。

意味:
- ADR-013 全体の Phase 4 stretch trajectory に対し、**Microsoft が受け入れる方向の send-input route は永久に来ない**
- 将来 reverse engineering で発見した route (Monarch COM 経由等) を Microsoft が CFG 強化等で塞ぐ意思あり、長期 maintenance risk 大

### C. ADR-013 §3.4 の「m13v 氏 community proposal」は **Sonnet 前任の取り違え** 可能性高

Background Agent の調査結果:
- m13v 氏 = Matthew Diakonov (https://m13v.com / GitHub @m13v) は screenpipe / computer-use SDK の開発者
- 公開 repos 100+ を全列挙したが **WT 専用 BG input 提案 repo は不在**
- ADR-013 §3.4 の m13v proposal は、おそらく **PR #20106 (作者 laffo16) を Sonnet 前任が m13v 氏と取り違えた** 可能性

→ **要 user 確認**: m13v proposal の正しい author / URL を user が知っていれば hint が必要。知らなければ §3.4 Option D を「PR #20106 (laffo16) ベースの fork build proposal」に書き換え、proposal author 名を修正する候補。

### D. **新 Option E (Clipboard + foreground flash) が最有望 candidate** として浮上

Background Agent の最有望 1 案:
- `SetClipboardData(CF_UNICODETEXT, text)` → `AllowSetForegroundWindow(wt_pid)` → `SetForegroundWindow(wt_hwnd)` → `SendInput(Ctrl+V)` → 元 hwnd 復帰
- foreground 奪取 = 50-100ms flash 程度
- WT 内表示更新 = active pane に paste される (= 既存 `terminal:read` 契約維持)
- Win11 `SetForegroundWindow` restriction 回避: `AllowSetForegroundWindow(wt_pid)` を先に call
- 真 BG ではないが、ADR-013 §1.2 trade-off table の「foreground 経路」より damage 小

---

## 2. その他の候補一覧 (Background Agent 全 11 個から抜粋)

| # | 候補名 | 公式/非公式 | foreground 奪取 | WT 表示更新 | 備考 |
|---|---|---|---|---|---|
| 3 | **Monarch COM IPC** (WT 内部 IPC を外部 process から接続) | 公式内部、外部 callable 未公開 | 不明 (要 spike) | ✓ | `WindowManager.h` の `ProposeCommandline` 等、Day 0 gate 必要、send-input reject 影響あり |
| 4 | **Win32 InputInjector (UWP brokered)** | 公式 WinRT | system-wide foreground 必要 | ✓ | UWP package manifest 必須、Win32 npm 配布から到達不能 |
| 5 | **Microsoft.Terminal.Control 自前 host (NuGet)** | 公式 component | (自前) BG | ✓ (自前 host 内) | scope 違: 自前 terminal を立てる、既存 WT への送信ではない |
| 6 | **EasyWindowsTerminalControl (mitchcapper)** | 非公式 wrapper | (自前) BG | ✓ (自前) | 同上、別 ADR 候補 |
| 7 | **AutoHotkey ControlSend (CASCADIA host class)** | 非公式 community | BG | ✗ | issue #173 silent fail と同型、PR #174 で revert 済の路線、即除外 |
| 9 | **WH_KEYBOARD_LL hook (foreground 中だけ inject)** | 公式 hook API | foreground 前提 | ✓ | BG 要件不充足 |
| 10 | **PowerShell PSReadLine reflection (内側のみ)** | 半公式 | BG (内側のみ) | △ | scope 違、Option C と同枠 |
| 11 | **WT-internal named pipe / Action Endpoint reverse engineering** | 非公式 reverse | 不明 | 不明 | reverse + WT 更新追従 + #9368 reject 意思で塞がれる risk |

詳細 + reference link は Background Agent report (transcript: `C:\Users\harus\AppData\Local\Temp\claude\D--git-desktop-touch-mcp\b739a049-b9ff-428c-a153-ec692c157e5e\tasks\a42a5791bc05ba935.output`) 参照。

---

## 3. 実機検証済の追加 finding

### F-1. `wt -w split-pane` workaround は foreground 100ms 後に新 pane 奪取 (BG 要件不適合)

```
[3/6] Run wt -w spike-22edf8 split-pane to inject sentinel into NEW pane ...
  split-pane dispatched in 44.2 ms
  +0ms focused: テキスト エディター (notepad)
  +100ms focused: DTM_SPIKE_PANE_xxx (WT new pane に focus 移動)
  +300ms-2000ms+: focus は WT new pane のまま継続
sentinel observed in WT buffer: True
```

split-pane 自体は dispatch 44ms で完了、WT 内表示も達成 (新 pane で sentinel echo)、ただし **100ms 後に foreground を新 pane が奪い continue** = user が notepad で作業中なら 突然 keystroke が WT に流れる **危険 spike**。 「BG 入力」要件不適合。

### F-2. `Microsoft.Terminal.Control::ControlCore::SendInput(hstring)` 公開 API 存在確認

`microsoft/terminal` repo の `src/cascadia/TerminalControl/TermControl.cpp` / `MarkdownPaneContent.cpp` で `ShortcutAction::SendInput` 経由で実装あり。**API 自体は存在**。

ただし `TermControl.idl` 確認結果:
- `[activatable]` / `[oop_server]` / `[marshalable]` 属性 **無し**
- 外部 process から activate する factory / 既存 instance lookup method **無し**
- 完全 in-process consumption 専用 design

→ **ADR-013 §3.1 Day 0 gate**: API 存在 = YES、外部 attach route = NO (Microsoft.Terminal.Control direct path)。Monarch COM 経由 (#3) に賭ける場合のみ Day 0 gate pass 可能性、ただし B (send-input reject 意思) で長期 risk。

### F-4. **Option E typing 干渉 spike — user typing が WT に漏れる risk 確認** (2026-05-10)

`scripts/spikes/wt-clipboard-flash-typing-test.ps1` で flash 中 + flash 後 に user typing simulation (VK_X を 5ms 間隔 burst) を main thread interleave で挟んで実機計測。

**重大発見**: WT buffer tail で `PS C:\Users\harus> っっっっっっっっっっっっっっｘ` を観測。

- 15 個の VK_X が **日本語 IME 経由で "っ" (sokuon) 14 + "ｘ" (全角) 1 に変換** されて WT に流入
- `X{3,}` 正規表現で漏れ検出が空振り = false negative の罠 (script の bug)
- **本質**: **user typing は WT に確実に漏れている** (data leak 確認、IME 経由で値が化けるが leak 自体は決定的)
- notepad には何も来ない = `SetForegroundWindow($beforeFg)` での復帰が機能してない (Win11 foreground lock 仮説)

**production 化前必須 mitigation**:
1. **flash 期間最小化**: Ctrl+V Enter 直後すぐ foreground 復帰、`Sleep 30ms` を削る (現状 50ms → 数 ms)
2. **flash 後 foreground 復帰検証**: `GetForegroundWindow` で復帰確認、失敗なら retry / fallback
3. **flash 中 keyboard block** (option):
   - `BlockInput(true)` = admin 必須 (UIPI elevation)
   - LowLevel keyboard hook = non-admin で実装可、production overhead あり
4. **IME 状態考慮**: WT に paste した sentinel 自体が IME 化けする risk 別途 (本 spike では sentinel = ASCII 英数字のみで未影響)

**判定**: Option E light evaluation の "真 BG 妥協 + 公式 OS API のみ + 既存契約維持" は維持できるが、**production 化前に上記 4 mitigation の追加 spike 必須**。本 spike scope では risk 確認まで、design は本実装 PR で。

### F-3. **Option E (Clipboard + foreground flash) spike GO 確定** (2026-05-10)

`scripts/spikes/wt-clipboard-flash.ps1` で 5 iteration 連続実機計測:

| 計測項目 | 結果 |
|---|---|
| flash duration (ms) | min 45.5 / avg 50.5 / max 55.1 (variance 10ms 以内、極めて安定) |
| sentinel hit rate | **5/5 (100%)** - WT pane に sentinel 確実届く |
| foreground 復帰 rate | **5/5 (100%)** - 元 hwnd (notepad) に完全復帰 |
| clipboard 復元 | ✓ (4983 chars 元 text 保持) |
| Win11 `SetForegroundWindow` restriction | ✓ `AllowSetForegroundWindow(wt_pid)` で完全 bypass |

実装方式:
- `Get-Clipboard` (text) → save
- 各 iteration: `Set-Clipboard` (sentinel) → `AllowSetForegroundWindow(wt_pid)` → `SetForegroundWindow(wt_hwnd)` → `Sleep 30ms` (WT focus ready) → `SendInput(Ctrl+V Enter)` → `SetForegroundWindow(beforeFg)` → UIA TextPattern 読戻し
- 最後: `Set-Clipboard` (元 text) で復元

判定: **light evaluation で完全成功**。Microsoft 意思整合 (公式 OS API のみ) + WT 内表示更新 (active pane に paste) + 既存 `terminal:read` 契約維持。Option A/B/D の trade-off (WT API broken risk / UIA writable 不在 / DLL injection AV trigger) を全て回避。

**spike 範囲では検証していない注意点 (production 化時に追加 spike 必要)**:
- user が flash 期間中に typing 中だと keystroke が WT に流れる risk (本 spike では user typing なし環境のみ)
- user が clipboard を変更中 (例: copy 中) と race risk
- 並列実行不可 = sequential queue 強制 (複数 WT pane への同時投入は serialize 必要)
- 50ms flash は user 知覚閾値ぎりぎり = "真 BG" ではない (ADR-013 §1.2 trade-off table の core value "別 app に focus を奪わない" は break)

---

## 4. 現状 status と次ステップ (user 判断)

| 候補 | status | 次 |
|---|---|---|
| Option A (ConPTY 公式 API) | Day 0 gate fail (公開 attach route 無し) | Microsoft が API 拡張するまで closed |
| Option B (UIA writable) | NO-GO 確定 (本 docs §1.A) | closed |
| Option C (PSRemoting / SSH) | scope 違 (WT 内表示更新なし) | 別 issue |
| Option D (m13v proposal) | author 取り違え疑い → 要 user 確認 | user hint 待ち |
| **Option E (Clipboard + flash)** | **light evaluation GO** (本 docs §3.F-3) | production 化向け追加 spike (race / 並列 / typing 中干渉) |
| Spike Phase 0 NO-GO (AttachConsole) | NO-GO (PR #239) | closed |

### user 判断項目

1. **Option E を ADR-013 §3 に正式追加するか?** (本実装 PR で `docs/adr-013-wt-bg-input.md` §3 を update、Option E を新 section として embed)
2. **Option E production 化に向けた追加 spike 範囲**:
   - (a) user typing 中干渉 spike (= flash 期間中に user keystroke を fake、誤入力先 risk 計測)
   - (b) clipboard race spike (= flash 中に user の copy 操作が来た場合の挙動計測)
   - (c) sequential queue 設計 (複数 BG injection を serialize する production 設計)
3. **m13v 取り違え (心配 3)**: user が m13v に hint 持っていなければ §3.4 を laffo16 PR #20106 に書き換え可。

---

## 5. References

- **issue #9368** (`wt send-input` Microsoft 公式 Reject): https://github.com/microsoft/terminal/issues/9368
- **draft PR #20106** (laffo16 `wt send-input` 実装、close): https://github.com/microsoft/terminal/pull/20106
- **WT command line subcommands** (公式 7 + hidden 1): https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments
- **WT actions sendInput** (内部 key binding only): https://learn.microsoft.com/en-us/windows/terminal/customize-settings/actions
- **Microsoft.Terminal.Control IDL**: https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalControl/TermControl.idl
- **m13v GitHub**: https://github.com/m13v / blog https://m13v.com
- **Process Model 2.0 (Monarch/Peasant) PR #7240**: https://github.com/microsoft/terminal/pull/7240
- **InputInjector UWP API**: https://learn.microsoft.com/en-us/uwp/api/windows.ui.input.preview.injection.inputinjector
- **EasyWindowsTerminalControl (NuGet)**: https://github.com/mitchcapper/EasyWindowsTerminalControl
- 本 spike 実機 script:
  - `scripts/spikes/wt-uia-inventory.ps1` (Option B Phase 1 inventory)
  - `scripts/spikes/wt-clipboard-flash.ps1` (Option E light evaluation、§3.F-3)
- Background Agent transcript: `C:\Users\harus\AppData\Local\Temp\claude\D--git-desktop-touch-mcp\b739a049-b9ff-428c-a153-ec692c157e5e\tasks\a42a5791bc05ba935.output`
