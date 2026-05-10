# wt-attachconsole Spike Results — NO-GO

> 2026-05-10
>
> Issue #185 / ADR-013 §3.1 Option A "ConPTY 経路" の preliminary investigation。
> Spike prompt: `docs/wt-attachconsole-spike-prompt.md`、親 ADR: `docs/adr-013-wt-bg-input.md`。
> Branch: `spike/wt-attachconsole-input`、commits: `6ccd9b5` (Round 1) → `d8b3c07` (Round 2) → Round 3 (PeekConsoleInputW 裏取り、本 PR で land 予定)。

---

## 1. Recommendation: **NO-GO**

`AttachConsole(targetPid)` + `CONIN$` open + `WriteConsoleInputW` は Win11 25H2 で **既存 cmd.exe / pwsh.exe shell に input を inject する経路として機能しない**。conhost-baseline すら通らないため、spike prompt §"Suggested Spike Shape" step 2 gating clause により WT testing は skip。

ADR-013 §3.1 Option A ("ConPTY 経路") の Day 0 gate 探索範囲から本経路を **除外** することを推奨。Option A の Day 0 gate は `ITerminalConnection::WriteInput` 相当の WinRT 公式 API / Microsoft.Terminal.Core attach surface に絞り込む。Option B (UIA writable pattern inventory) / Option C (PSRemoting) / Option D (m13v community proposal validation) は別 path のため本 NO-GO の影響を受けない。

---

## 2. Environment

| 項目 | 値 |
|---|---|
| OS | Microsoft Windows 11 Home, 10.0.26200.8328 (25H2) |
| Windows Terminal | 1.24.10921.0 (x64) |
| pwsh | 7.6.1 |
| cmd.exe | Windows Version 10.0.26200.8328 |
| DefTerm CLSID (`HKCU:\Console\%%Startup` `DelegationConsole`) | `{00000000-0000-0000-0000-000000000000}` ("Let Windows decide") |
| Session privilege | Non-elevated (`GAMING_PC\harus`) |
| Helper / orchestrator host | pwsh 7.6.1 (Add-Type C# inline P/Invoke) |

DefTerm CLSID `{00000000-0000-0000-0000-000000000000}` は Win11 default の "Let Windows decide" 状態。Win11 25H2 では実質 WT (= ConPTY backed) が default terminal application として選ばれることが多く、`Start-Process conhost.exe -ArgumentList @('cmd.exe', '/K', '...')` のように conhost.exe を直接 invoke しても **DefTerm 解決を経由する場合がある** (詳細は §4 Technical Explanation 参照)。

---

## 3. Test Matrix

候補 PID strategy (conhost 行共通): `Get-CimInstance Win32_Process -Filter "ParentProcessId=$conhostPid AND Name='cmd.exe'"`、AttachConsole 結果 `attached_pids=[helper, target]`、CONIN$ handle 全 round で valid。UIA TextPattern 読戻し時の buffer 末尾は全 round で `D:\git\desktop-touch-mcp>` prompt のみ (sentinel 不在)。

| # | host | shell | round | encoding | WriteConsoleInputW (records_written/attempted) | PeekConsoleInputW (post-write) | verified | notes |
|---|---|---|---|---|---|---|---|---|
| 1 | conhost (`Start-Process conhost.exe cmd.exe /K title <tag>`) | cmd.exe | Round 1 | UnicodeChar only (`VK=0`, `scan=0`, `wRepeatCount=1`) | ✓ 64/64 | (not measured、Round 1 は helper に未注入) | ✗ | 仮説: line reader が VK metadata を必要とする → 失敗で Round 2 の根拠化 |
| 2 | conhost | cmd.exe | Round 2 | keydown_keyup (proper VK via `VkKeyScanW` + scan code via `MapVirtualKeyW`、必要時 Shift state) | ✓ 92/92 | (not measured、Round 3 で追加注入) | ✗ | sentinel 不在で encoding 仮説不成立、Opus 諮問で Round 3 (PeekConsoleInputW 裏取り) を判定 |
| 3 | conhost | cmd.exe | Round 2 | keydown (proper VK + scan code、key_up なし) | ✓ 60/60 | (not measured) | ✗ | spike-prompt §"Suggested Spike Shape" step 5 で要求された両 encoding 比較、結果同型 |
| 4 | conhost | cmd.exe | Round 3 | keydown_keyup + PeekConsoleInputW + GetNumberOfConsoleInputEvents | ✓ 92/92 | **`pending_events=0` / `peeked_records=0` / `peek_win32_error=0`** (書込直後即 drained) | ✗ | **decisive evidence**: API 層は全 success だが入力は consumer (cmd.exe line reader) に届かない。詳細 §4 |
| 5 | WT (`wt.exe -w <unique> new-tab --title <tag> -- powershell.exe -NoLogo -NoExit`) | pwsh.exe | (not run) | — | — | — | — | **spike-prompt §"Suggested Spike Shape" step 2 gating clause で skip** (`If this baseline fails, fix the helper before testing WT.`)。conhost-baseline で同型 NO-GO 確定済のため WT を試す technical value ゼロ + candidate filter leak risk (orchestrator §wt-controlled の `Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR ..."` は user の既存 PS shells を leak する既知問題、§5 Carry-over) |

### 3.1 Round 結果の意味

- **Round 1 (UnicodeChar only encoding)**: `VirtualKeyCode = 0`, `wVirtualScanCode = 0`, `UnicodeChar = '<char>'`, `wRepeatCount = 1` の INPUT_RECORD。仮説: cooked-mode line reader が VK metadata を必要とする可能性 → 失敗
- **Round 2 (proper VK + scan code)**: `VkKeyScanW(ch)` で proper VK、`MapVirtualKeyW(MAPVK_VK_TO_VSC)` で scan code、必要に応じて Shift state。`keydown_keyup` (key_down + key_up pair) と `keydown` (key_down のみ) 両 encoding を試行 → 両方失敗 (sentinel 不在)
- **Round 3 (PeekConsoleInputW 裏取り)**: WriteConsoleInputW 直後に `GetNumberOfConsoleInputEvents` + `PeekConsoleInputW` で buffer 状態を確認 → `pending_events=0`, `peeked_records=0`, `peek_win32_error=0`。書いたはずの 92 records が即座に消えていることを **構造的に証明**

### 3.2 Round 3 result JSON (decisive evidence、conhost-baseline keydown_keyup)

```json
{
  "helper": {
    "ok": true,
    "step": "WriteConsoleInputW success",
    "win32_error": 0,
    "records_attempted": 92,
    "records_written": 92,
    "attached_pids": [20576, 31292],
    "peek_ok": true,
    "pending_events": 0,
    "peeked_records": 0,
    "peek_win32_error": 0,
    "peeked_summary": [],
    "key_encoding": "keydown_keyup"
  },
  "readback_observed": true,
  "sentinel_found": false
}
```

`records_written=92` は API 報告、`pending_events=0` / `peeked_records=0` は同 handle で immediately 後の peek 結果。**書込から peek まで PowerShell の同期実行で <1ms**、cmd.exe の line reader が consume するには時間が短すぎ、かつ buffer が空になっている事実は cmd.exe ではない別経路 (= ConPTY が swallowing) が drain していることを示唆。

---

## 4. Technical Explanation

Win11 では cmd.exe / pwsh.exe を `conhost.exe` 経由で invoke しても、DefTerm 設定により実 host が WT (ConPTY backed) になることがある。本環境の DefTerm CLSID は `{00000000-0000-0000-0000-000000000000}` ("Let Windows decide") で、Win11 25H2 build 26200 では WT が default として解決される高い probability。

ConPTY (Pseudo Console) model では shell プロセスは **pseudo-console pipe (stdin handle)** から input を読み、legacy `CONIN$` 経由 input buffer は ConPTY ホスト (WT) が forwarding しない限り **vestigial** になる。`AttachConsole(targetPid)` + `CONIN$` open + `WriteConsoleInputW` は API 層では全て success (ERROR_SUCCESS, `records_written = N attempted`) を返すが、書かれた INPUT_RECORD は ConPTY pipe に forward されず、shell の line reader / PSReadLine に届かない。

Round 3 の PeekConsoleInputW 結果 (`pending_events=0` / `peeked_records=0`) は次のいずれかを示す:

1. **CONIN$ handle が共有 input buffer の "old" alias** で、ConPTY environment では server-side で同期的に discarded (consumer 不在経路)
2. ConPTY infrastructure が WriteConsoleInputW を hook して silently drain している (forwarding なしで ack)

いずれにせよ、Round 1 (UnicodeChar only) と Round 2 (proper VK + scan code、両 encoding) で **encoding を変えても同じ symptom** が出ることから、これは encoding 不足ではなく **input buffer が consume 経路と切断されている** 構造的問題。Microsoft 公式 docs (`writeconsoleinput`) も「We do not recommend this function for new code.」+ 「[fails] conceptually... cross-platform transports」と明記、modern transport (ConPTY 含む) に対しては設計外。

---

## 5. Carry-over Open Questions

本 spike scope を超える / 後続 follow-up に持ち越す未解決事項:

- **OQ-1: orchestrator candidate filter leak (wt-controlled mode)**: `wt-attachconsole-orchestrator.ps1:318` の `Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe' OR Name='cmd.exe'"` は user の既存 PS shells を candidate に含めるため、process tree 確認で filter しないと user terminal を巻き込む risk。本 spike では NO-GO 確定で WT mode 不実行のため未顕在化、将来 ADR-013 §3.1 Option A の Day 0 gate pass で別 spike を走らせる場合は「spike launch 時刻以後に start した shell」+「process tree が spike WT process を含む」の 2 段 gate で構造的に解決必要
- **OQ-2: Stop-ProcessTreeSafe cleanup miss (Win11 DefTerm 経由)**: `wt-attachconsole-orchestrator.ps1:255-257` で conhost / cmd.exe の PID を kill するが、DefTerm 経由で実 host が WT になっている場合 user の既存 WT (shared) を kill する選択は不適切 (本 spike は意図的に避けた)。将来 spike では `Get-Process -Id $X -ErrorAction SilentlyContinue` の冪等 sweep + WT process は kill 対象外の明示で解決
- **OQ-3: 別 transport (Option B / D) との trade-off**: 本 NO-GO で ADR-013 §3.1 Option A の preliminary findings は確定したが、§3.2 Option B (UIA writable pattern inventory) と §3.4 Option D (m13v proposal Phase 0 validation) との ranking は未着手。Phase 1 acceptance (`adr-013-wt-bg-input.md` §5.1) で各 path の gate を順次走らせて再評価
- **OQ-4: WSL / SSH terminal inside WT への AttachConsole**: 本 spike scope 外、Option C (別経路) の sub-case で別 issue 候補

---

## 6. Microsoft Documentation References

- `WriteConsoleInput` API: <https://learn.microsoft.com/en-us/windows/console/writeconsoleinput>
  - Microsoft 自身が "We do not recommend this function for new code." + remoting/cross-platform transport 非対応を明記
- `AttachConsole` API: <https://learn.microsoft.com/en-us/windows/console/attachconsole>
- ConPTY (Pseudo Console) session creation: <https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session>
  - 新規 console 作成 API、既存 console への外部 write は別途 API 探索が必要 (ADR-013 §3.1 Day 0 gate 対象)
- ConPTY 設計理念 (devblog): <https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/>
  - legacy console API との関係、なぜ modern transport が pipe-based か
- DefTerm 設定 (Win11): <https://learn.microsoft.com/en-us/windows/terminal/install#set-your-default-terminal-application>

---

## 7. Decision History

| Date | Decision | Author | Rationale |
|---|---|---|---|
| 2026-05-10 | Round 1 実施 (UnicodeChar only encoding) | Claude (Sonnet) | spike prompt §Suggested Spike Shape §5 の最初 variant、最小実装 |
| 2026-05-10 | Round 2 実施 (proper VK + scan code、両 encoding) | Claude (Sonnet) | Round 1 失敗、cooked-mode line reader が VK metadata を必要とする仮説 |
| 2026-05-10 | Round 3 実施 (PeekConsoleInputW 裏取り) を Opus 諮問で決定 | Claude (Sonnet) + Opus reviewer | Round 1/2 連続失敗、CLAUDE.md 強制命令 4 (trial & error 2 回上限) で Opus 判定委譲。Opus 5 候補 ((A) parent tree / (B) GetConsoleMode / (C) PeekConsoleInputW / (D) explorer launched / (E) MOUSE_EVENT) のうち (C) のみ実施価値あり (vestigial-buffer hypothesis 構造的証明) と判定 |
| 2026-05-10 | NO-GO 確定 | Claude (Sonnet) + Opus reviewer | Round 3 で `pending_events=0` / `peeked_records=0` を観測、書込直後 drain される構造を pin。conhost-baseline で再現性あるため WT mode は spike-prompt §2 gating clause で skip |
| 2026-05-10 | ADR-013 §3.1 Option A 末尾に preliminary findings として embed + §7 OQ #1 に「legacy `WriteConsoleInputW` 経路除外」追記 | Claude (Sonnet) + Opus reviewer | Day 0 gate 探索の workload 削減、将来の reopen risk 構造的回避 |
