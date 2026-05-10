# scripts/spikes/

issue #185 の Phase 0 / Phase 4 stretch 用 spike scripts。

**ここは production tool surface ではなく scratch experiment**。`docs/wt-attachconsole-spike-prompt.md` の Suggested Spike Shape に従って Go/No-Go 判定のため**だけ** に動作確認する。

## 現在の spike

- `wt-attachconsole-helper.ps1` — child PS で `FreeConsole` → `AttachConsole(targetPid)` → `CONIN$` 開く → `WriteConsoleInputW` → `GetNumberOfConsoleInputEvents` + `PeekConsoleInputW` (Round 3 vestigial-buffer hypothesis verification) → `FreeConsole`、結果 (Win32 GetLastError 含む) を JSON file に出力
- `wt-attachconsole-orchestrator.ps1` — target 起動 → 候補 PID 解決 → helper 呼出 → buffer 読戻し検証 → cleanup → 結果 print

## 実行方法

```powershell
# Phase A1: conhost baseline (cmd.exe legacy console)
.\scripts\spikes\wt-attachconsole-orchestrator.ps1 -Mode conhost-baseline -Verbose

# Phase A2: WT controlled (wt.exe new-tab で隔離 launch)
.\scripts\spikes\wt-attachconsole-orchestrator.ps1 -Mode wt-controlled -Verbose
```

## 安全規則 (`docs/wt-attachconsole-spike-prompt.md` Safety Rules 引用)

- Use only **controlled terminals launched for this spike** (user の既存 terminal は触らない)
- Send **harmless sentinel commands only** (`Write-Output "__DTM_ATTACHCONSOLE_SPIKE_<guid>__"` / `echo __DTM_ATTACHCONSOLE_SPIKE_<guid>__`)
- Never send secrets / destructive cmds / credential prompts
- Always verify delivery via buffer read-back
- Always call `FreeConsole` after `AttachConsole`
- Privilege mismatch detected → record + skip (no elevation attempt)

## Deliverable

`docs/wt-attachconsole-spike-results.md` に test matrix + GO/NO-GO/MAYBE 推奨。

**現状**: NO-GO 確定 (`docs/wt-attachconsole-spike-results.md` 参照、2026-05-10)。Round 3 PeekConsoleInputW 裏取りで `pending_events=0` / `peeked_records=0` を観測、書込直後 drain される構造を pin。
