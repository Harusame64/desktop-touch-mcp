# ADR-013: Windows Terminal への信頼性ある BG (foreground-independent) 入力経路の復元

- Status: **Draft (Open question — 着手時期 v1.5.0+ stretch)**
- Date: 2026-05-10
- Authors: Claude (Sonnet draft + Opus review、project `desktop-touch-mcp`)
- Related:
  - issue #173 (parent、Audit: terminal/keyboard BG silent fail on WT)
  - issue #185 (本 ADR の起票対象、Phase 4 stretch tracking)
  - PR #174 (v1.3.2、WT を `TERMINAL_WINDOW_CLASSES` から除外し foreground fallback)
  - `docs/operation-verification-matrix.md` §3.1 (BG path delivery verification 規範)
  - `src/engine/bg-input.ts:35-70` (TERMINAL_WINDOW_CLASSES + canInjectViaPostMessage)
- Blocks: なし (workaround として foreground 経路が稼働中)
- Blocked by: 本 ADR の決定 (3+ オプション、§3 参照) + POC 結果 (§5 acceptance criteria)

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

// または auto-route (DTM_BG_AUTO=1) では:
keyboard({action:'type', windowTitle:'PowerShell'}) // auto routing
// → wt_xaml_pipeline detected
// → handler routes to method:'foreground' transparently (Phase B leash)
// → SendInput dispatches via system input queue, target gets foreground
```

つまり **silent-success は解消済**、ただし foreground 経路が必須で BG 並列性は失われた状態。

---

## 2. Decision: 本 ADR は **Draft**、v1.5.0+ で再検討

- **本 ADR では決定しない** (Status: Draft)
- 採用方針 (a/b/c/d) は §3 で trade-off を整理、POC 結果と user dogfood feedback を経て v1.5.0+ で決定
- Phase 1: ADR draft land (本 PR、docs only)
- Phase 2: 候補絞り込み (Opus 諮問 + competitor research)
- Phase 3: POC 実装 (別 branch / draft PR、選んだ option を最小スコープで)
- Phase 4: 本実装 + E2E (`DTM_E2E_WT=1` で安定 pass、stretch 達成判断)
- Phase 5: CHANGELOG + ADR Status を **Accepted** へ昇格

### 2.1 着手時期の判断軸 (advisory)

- **着手 trigger**: 以下のいずれかが満たされた時
  - WT を target にした agent flow で foreground 経路が UX 劣化として複数 user feedback を集める
  - Win11 SetForegroundWindow restriction が agent flow を実質 block する事例が増える
  - 並列 BG injection (複数 WT tab に同時投入) が anti-fukuwarai workflow で必要になる
- **着手 skip 条件** (本 ADR を **Rejected** で close すべき場合):
  - foreground 経路が dogfood で十分機能、user friction が観測されない
  - WT 自体が Microsoft 側で公式 BG input API を提供 (e.g. WinUI accessibility automation の正式拡張)
  - ConPTY API の維持コストが採用候補より大きく、別 path (Option C) で十分

---

## 3. Options

### 3.1 Option A: ConPTY API 直接 (`CreatePseudoConsole`)

Windows 10 1809+ で導入された Pseudo Console API。WT は内部で ConPTY を使用しており、外部から ConPTY ハンドルに書き込めば WT 経由で hosted process (PowerShell / cmd / WSL 等) に届く。

**実装方針**:
- Rust addon (`desktop-touch-engine`) に新 surface (`win32_open_conpty` / `conpty_write` / `conpty_close`) 追加
- Windows API: `CreatePseudoConsole` / `WritePseudoConsole` / `ClosePseudoConsole` (windows-rs クレート経由)
- 既存 child process の ConPTY ハンドル再 attach は **公式 API 非対応** — ただし WT 自身が起動した child の ConPTY ハンドルへの書込みは ConPTY を **proxy** する形で可能性あり (POC で要検証、Microsoft TerminalApi の `ITerminalConnection::WriteInput` 相当)
- TerminalApi.WriteInput が COM 経由で公開されているかは未確認、要 winrt metadata 調査

**Pros**:
- Microsoft 公式 API、stable contract、Windows version migration で壊れにくい
- ConPTY 内部経路で送るので XAML 入力 pipeline を bypass、TerminalControl が想定する経路で hosted process に届く
- 並列 BG 性能達成 (複数 tab に同時投入可能、それぞれ ConPTY proxy 経由)

**Cons**:
- `CreatePseudoConsole` は **新 ConPTY 作成** 用 API、既存 WT tab の ConPTY ハンドルへの **write 専用 API は公式に存在しない**
- 「外部から既存 ConPTY ハンドルへの write」に該当する Microsoft 公式 API は **TerminalApi (Microsoft.Terminal.Core)** 経由になる可能性、ただし C++/WinRT 主体、Rust binding は手動生成必要
- WT 内部 protocol 変更で API 互換性が壊れる risk (Microsoft は WT 内部 API を public stable と位置付けていない)
- 実装規模: walking skeleton 級 (Rust + Win32 / C++/WinRT 経験必須)、開発 1-2 週間 + POC 安定化さらに 1 週間
- elevated process / UIPI restriction で PostMessage 同様に block される可能性 (要 POC 実機検証)

**API contract surface**:
```rust
// Rust addon 新 surface (案)
pub fn win32_resolve_wt_terminal(hwnd: u32) -> Result<TerminalHandle, ConPtyError>;
pub fn conpty_write_input(handle: &TerminalHandle, text: &str) -> Result<usize, ConPtyError>;
pub fn conpty_close(handle: TerminalHandle) -> Result<(), ConPtyError>;
```

`TerminalHandle` は `ITerminalConnection` (or proxy 相当) を内部に保持。`win32_resolve_wt_terminal` は HWND → WT process → tab 内 hosted ConPTY の解決 chain を実装。

### 3.2 Option B: UIAutomation TextPattern.SetValue / Send

WT が公開する UIA TextPattern (Microsoft.Terminal の UIA TermControl が実装) の SetValue / Send で挿入。

**実装方針**:
- 既存 `getTextViaTextPattern` (`src/engine/uia-bridge.ts:1116`) を拡張して `setTextViaTextPattern` 相当を新設、または ValuePattern.SetValue を試行
- WT TerminalControl が UIA pattern として **どの操作 verb をどの程度実装しているか** は実機で要検証 (typically TextPattern.GetText のみ実装、SetValue / DocumentRange.Insert などは未実装の可能性)
- focused element ancestor chain で TermControl 要素を特定、ValuePattern が通るか試す

**Pros**:
- 既存 UIA bridge で実装可能、Rust addon 改修不要
- 失敗時の degrade path が UIA exception で明確、PowerShell-backed 実装で safe
- Windows version 跨ぎでの API 互換性は UIA 側が保証 (TerminalControl が UIA を将来も維持する前提)

**Cons**:
- **TerminalControl の SetValue / Insert は実装されていない可能性が高い** (typically read-only TextPattern)
- 一部の terminal でしか動かない (文字列の bulk 挿入の semantics が terminal 実装依存、TermControl の最新版で対応していても旧 WT では失敗)
- 実機 POC で「動かない」と判明した場合の sunk cost
- 信頼性で劣る、stretch 案

**Verification**:
- POC で `Get-Process WindowsTerminal | ... | UIA TextPattern Set` を試行、SetValue が通るか確認
- 動かない場合は本 Option を即 Rejected で close

### 3.3 Option C: Inputに専念せず別経路 (PowerShell remoting / SSH session / job manager)

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

### 3.4 Option D: (carry-over candidate) Native Win32 Hook DLL Injection

DLL を WT process に inject して TerminalControl 内部経路を直接呼出。

**Pros**:
- 任意の API hook 可能、WT 内部完全制御

**Cons**:
- **anti-virus / Windows Defender が hostile と判定するリスク高**
- DLL 読込み時に WT crash の可能性
- Microsoft が今後 WT を CFG (Control Flow Guard) 強化した場合に hook 不可
- user の信頼を失う可能性 (rootkit-like behavior)
- **Rejected** 候補、実装非推奨

---

## 4. Trade-off comparison

| 観点 | A. ConPTY 直接 | B. UIA TextPattern | C. 別経路 (PSRemoting) | D. DLL Hook |
|---|---|---|---|---|
| 公式 API | ✓ | ✓ | ✓ | ✗ |
| 実装規模 | 大 (1-3 週間) | 小 (1-3 日) | 小 (既存 API 組合せ) | 中 (1 週間) |
| WT 内表示更新 | ✓ | ✓ | ✗ | ✓ |
| 実機動作確実性 (現時点) | 中 (POC で要検証) | 低 (TermControl SetValue 未実装の可能性) | 高 (枯れた API) | 中 (CFG リスク) |
| Windows version 跨ぎ | 中 (ConPTY API stable、内部 chain は不安定) | 高 (UIA stable) | 高 | 低 (anti-malware 強化で死) |
| user 信頼 | 高 | 高 | 中 (別 channel な不透明感) | 低 (rootkit-like) |
| 並列 BG 性能 | 高 | 中 | 高 | 高 |
| 採用順位 | **第 1 候補** | 第 2 候補 (POC 軽い) | 別 case (scope 違) | **Rejected** |

**Tentative recommendation**: **POC を Option B (UIA TextPattern SetValue/Insert) で 1-3 日で先行**、TermControl の UIA 対応有無を確定。失敗なら Option A (ConPTY proxy) に進む。Option C は本 ADR scope 外 (別 issue で議論)、Option D は Rejected。

---

## 5. Acceptance criteria (POC + 本実装段階)

### 5.1 POC acceptance

- [ ] **WT 既定 (CASCADIA_HOSTING_WINDOW_CLASS) で BG path が再び稼働**: `keyboard({action:'type', method:'background', windowTitle:'PowerShell'})` → `ok:true, hints.verifyDelivery.status === 'delivered'` (既存 verifyDelivery 規範 §3.1 整合)
- [ ] **foreground を奪わない**: BG injection 中に user が他 app focus、injection 後も外れない
- [ ] **silent-success ゼロ**: `{supported:false, reason:...}` の degrade path が明確、`ok:true` で実 delivery ゼロは絶対不可 (issue #173 同型 regression 防止、北極星「silent-success / contract drift = 0」)
- [ ] **既存 conhost / Other terminal に regression なし**: `tests/e2e/terminal.test.ts` 全 pass、`tests/e2e/keyboard-bg-verification.test.ts` の conhost / WT 両 case で `delivered` 返却 (現 main の conhost case は環境依存 flaky、安定化も含む)

### 5.2 本実装 acceptance

- [ ] **`DTM_E2E_WT=1` E2E 安定 pass**: WT 既定環境で 100 連続 BG injection 全 success (flaky < 1%)
- [ ] **`canInjectViaPostMessage` が WT を再 supported に昇格**: `wt_xaml_pipeline` reason 削除、TERMINAL_WINDOW_CLASSES allowlist 復帰 (要件: 復帰後の silent-success 検出が impossible である構造的証明)
- [ ] **CHANGELOG 記載**: `method:'background'` が WT で再使用可能、breaking change なし (caller 視点で transparent)
- [ ] **operation-verification-matrix.md §3.1 update**: WT BG path 規範を「ConPTY (or UIA) 経由 verifyDelivery」に拡張

### 5.3 Out-of-scope

- WT 以外の WinUI host (将来の UWP-style terminal、新 PowerShell Preview 等) — 別 issue で扱う
- 既存 conhost path の変更 — `ConsoleWindowClass` 経路は本 ADR scope 外
- elevated process (admin terminal) への BG injection — UIPI 制約で同 ADR スコープ外、別 ADR 候補

---

## 6. Consequences / Risks

### 6.1 Positive consequences (本 ADR の採用が成功した場合)

- **agent 並列性復活**: 複数 WT tab への同時 BG injection、anti-fukuwarai workflow 強化
- **Win11 SetForegroundWindow restriction 回避**: `ForegroundRestricted` 由来の fail rate 低下
- **CHANGELOG 透明性**: v1.1.0 で claim → v1.3.2 で revert → 本 ADR で再復活、user に対する整合性 narrative 整理
- **dogfood scenario `keyboard.md` §2.1 / §2.2 の WT case が `delivered` で通る**: Phase 5 北極星 silent-success / contract drift = 0 の WT 個別事例として完全達成

### 6.2 Risks (採用判断で重視する)

- **Microsoft 内部 API 変更 risk**: WT は Microsoft 内部更新で TerminalControl 仕様を変える可能性、Option A の ConPTY proxy 経路が ad-hoc になる
- **CFG / 隔離 sandbox の強化**: 将来 WT が AppContainer / sandbox 強化で外部書込みを block する可能性、Option A/B 両方影響
- **Anti-virus 誤判定 (Option A)**: ConPTY proxy 経由の write が「terminal injection」と誤判定される可能性
- **User permission**: WT process への書込み権限が user/admin で異なる、UIPI 同型問題が再発する risk
- **POC 失敗時の sunk cost**: Option B が 1-3 日試して動かない場合、A に切り替える際に共通 infrastructure (UIA bridge 拡張) が無駄になる risk
- **release timing**: v1.5.0+ stretch とすると、間に他 feature が入って ADR が stale 化する risk (本 ADR は **半年以上着手しない場合は再 review** マーカー必要)

---

## 7. Open Questions

1. **WT `ITerminalConnection::WriteInput` 相当の公式 API は存在するか?** TerminalApi metadata 調査必要 (POC 前段で 1 日以内)
2. **Option B の TextPattern.SetValue/Insert は TermControl で実装済か?** PowerShell-backed UIA 試行で実機検証 (POC 1 日目に判明)
3. **elevated WT への injection は scope 内 / 外?** UIPI restriction が same-process 内では緩和、別 ADR が良いか本 ADR で扱うか
4. **複数 WT window (PR #237 で見たように) への BG injection は対応するか?** 単一 WT 内複数 tab + 複数 window の組合せ
5. **WT 以外の TerminalControl ベース app (将来の preview build, Codespaces local 等) は同経路で対応可能?** Microsoft.Terminal.Core を使う app は理論上同経路
6. **POC 失敗時の Option C への pivot は妥当か?** PowerShell Remoting は scope 違いだが「WT 内 process 制御」というメタ目的は満たす、ADR 範囲拡張判断

---

## 8. Roadmap (advisory、決定は §2 Decision の Phase 1〜5)

| Phase | 期間 | 出力 | acceptance |
|---|---|---|---|
| 1. ADR draft land | 1 PR (本 PR) | `docs/adr-013-wt-bg-input.md` | docs review (Opus 1+ round) |
| 2. 候補絞り込み | 1-2 日 | Opus 諮問 + competitor research note | OQ #1, #2 が初期回答済 |
| 3. POC 実装 (Option B 先行) | 1-3 日 | draft PR、UIA SetValue 試行コード + 実機動作 log | OQ #2 が「動く」or「動かない」確定 |
| 4. POC 実装 (Option A、B 失敗時) | 1-2 週間 | draft PR、ConPTY proxy 経路 prototype | §5.1 POC acceptance 全 ✓ |
| 5. 本実装 + E2E | 1 週間 | feature PR、`DTM_E2E_WT=1` 安定 pass | §5.2 本実装 acceptance 全 ✓ |
| 6. ADR Status 昇格 | 1 PR | `Status: Draft` → `Status: Accepted` + `Decision:` 節更新 | 本 PR closure |

合計: 採用案次第で **2-4 週間** (Option B 動けば短縮、A まで進むと最大)。

---

## 9. References

- issue #173 (parent audit、WT silent fail discovery)
- issue #185 (本 ADR の起票対象、Phase 4 stretch tracking)
- PR #174 (v1.3.2、WT BG path 削除)
- PR #235 (本 session、F4-bis hotfix で同 path 修正経験)
- `src/engine/bg-input.ts:35-70` (TERMINAL_WINDOW_CLASSES + canInjectViaPostMessage)
- `src/engine/uia-bridge.ts:1116-1215` (`getTextViaTextPattern`、Option B 拡張対象)
- `docs/operation-verification-matrix.md` §3.1 (BG path 規範)
- Windows Pseudo Console API: <https://learn.microsoft.com/en-us/windows/console/pseudoconsoles>
- Microsoft.Terminal repository: <https://github.com/microsoft/terminal>
- ConPTY API reference: `CreatePseudoConsole` (kernel32.dll、Windows 10 1809+)
