# ADR-013 follow-ups (post-merge backlog)

- Status: **Active** (PR #240 merge 後の follow-up backlog)
- Date: 2026-05-10
- Authors: Claude (Sonnet) + Opus PR #240 Round 1+2 review
- Related: ADR-013 (`docs/adr-013-wt-bg-input.md`)、本実装 plan (`docs/adr-013-option-e-impl.md` v3)
- Owner: TBD (Phase 2 mandatory gate 結果次第で priority 決定)

---

## 1. 趣旨

PR #240 で land した Option E (`foreground_flash` channel) 本実装の **post-merge follow-up backlog**。CLAUDE.md 強制命令 9「残件・todo・backlog は memory ではなく docs/ に書く」「最初から docs に書く」に整合させるため、Round 1 / Round 2 で defer 判断した item を本 doc に永続化。

---

## 2. defer された fix items (本 PR scope 外、別 PR で扱う)

### 2.1 [P1 candidate] Clipboard race over-detection の semantic 検証 (Round 1 P1-1、Opus 提起 / dubious 判断)

**背景**: Round 1 で Opus が「`SetClipboardData(CF_UNICODETEXT)` の OS format synthesize (CF_TEXT / CF_OEMTEXT / CF_LOCALE auto-conversion) で sequence number が bump → 我々の inject 後に偽 race として検出 → `clipboardRestored: false` で常時 skip → user clipboard 喪失」を P1 として提起。

**現状判断 (本 PR)**: MSDN docs 解釈上 dubious (synthesize は on-demand 変換、sequence は内容変更のみで bump、`MSDN GetClipboardSequenceNumber` 注記)。defensive monitoring + dogfood 観測項目化で defer。

**Follow-up trigger**: dogfood で `hints.clipboardRestored: false` が想定外頻度で観測されたら別 issue 起票、以下の選択肢を検討:
- (a) `EnumClipboardFormats` で snapshot 時の format 集合 + 主要 hash を保存して比較
- (b) tolerance window 導入 (`seq_before_restore - seq_after_inject <= small tolerance` で synthesize 範囲を許容)
- (c) `RestoreOutcome::SkippedDueToRace` を `os_synthesized_or_external_race` に細分化

### 2.2 [P2] kbd_hook worker thread の `DispatchMessageW` 防御 (Round 1 P2-4、Opus 提起)

**背景**: `src/win32/kbd_hook.rs:106-114` worker thread で `PeekMessageW(NULL, ...)` で全 window message を吸って `DispatchMessageW` するが、worker thread は window を持たないため実用上 stray message 0、`DispatchMessageW` は no-op に近い。ただし `WM_QUIT` / `WM_TIMER` 等が来た場合の対応が未定義。

**Follow-up**: 別 PR で `PeekMessageW(thread)` で thread 専用 queue 限定、または `TranslateMessage` のみで `DispatchMessageW` を skip する防御的書き方に refactor。

### 2.3 [P2] `clipboard_flash` 経路 replaceAll の native 側支援 (Round 2 P1-3、Opus 提起)

**背景**: `src/tools/keyboard.ts` の clipboard_flash 経路で `replaceAll: true` を caller が指定したとき、本 PR では `ReplaceAllNotSupportedOnClipboardFlash` warning を返すのみ (PR #240 Round 2 で `postKeyComboToHwnd(channel.hwnd, "ctrl+a")` が WT XAML pipeline で silent drop される dead path と判明、Codex Round 1 P2-A の素直な実装は不可)。

**Follow-up**: 別 PR で `win32_foreground_flash_inject` に `select_all_first: bool` option を追加、native 側 foreground steal 完了後に `SendInput(Ctrl+A)` → 30ms 待 → `SendInput(Ctrl+V)` 順送信。WT が SendInput 受け入れることは Phase 2 bench で確認可能。

### 2.4 [P2] OLE `IDataObject` snapshot 評価 (plan v3 Phase 1.5、本 ADR §7 OQ #10)

**背景**: 本 PR の HGLOBAL MVP 限定で「画像 / メタファイル等が clipboard 復元できない」事実は `clipboardSkippedFormats` hints で observable。dogfood で頻度が高いと判明したら OLE `OleGetClipboard` / `OleSetClipboard` snapshot を採用。

**Follow-up**: 別 PR で OLE binding (COM apartment STA 必須)、HGLOBAL skip と OLE snapshot の trade-off を実機 spike + memory 比較。

### 2.5 [P2] Hidden owner thread の dedicated worker + message loop refactor (plan v3 §3.2.1 deviation、Round 1 P2-1)

**背景**: 本 PR では hidden owner window を per-call create + destroy (calling thread)。~80ms の短い session で他 process 由来 message 受取り不要 + dedicated thread 管理コスト回避という trade-off で MVP 採用。

**Follow-up trigger**: dogfood で「1 秒に複数 inject」など performance 顕在化したら別 PR で:
- `ensure_clipboard_owner_thread()` lazy init + dedicated thread + `RegisterClassExW` + `WM_RENDERFORMAT` 最低限 handle
- engine shutdown で `WM_QUIT` 送信 → thread join + window dispose

### 2.6 [P3] `_UNUSED_FORMATS` constants の意図明記 (Round 1 P3-1)

**背景**: `src/win32/clipboard_snapshot.rs:475-477` の `_UNUSED_FORMATS` const 配列は `dead_code` allow で残留、定数集合の意図が unclear。

**Follow-up**: 別 PR で removal or docstring 明記 (例: 「将来 docs で format support coverage 表に再利用」)。

### 2.7 [P3] `target_pid` unused parameter の wire scope 整理 (Round 1 P3-3)

**背景**: `win32_foreground_flash_inject(target_hwnd, target_pid, text, options)` の `target_pid` は将来 `AllowSetForegroundWindow(target_pid)` 予約で未使用。

**Follow-up**: Option F (cooperative bridge) 等で必要になったら revival。それまでは公開 napi signature 安定性のため残置 (削除は wire 破壊)。

### 2.8 [P3] `escape_sent: false` 観測の hints surface 化 (Round 1 P2-3)

**背景**: `wt_dialog_scan.rs::PasteWarningScanOutcome` に `escape_sent` field を追加したが、`foreground_flash.rs` caller 側では `outcome.detected` のみ反映、`escape_sent: false` (= "intercepted but Esc failed") は当面 silent。

**Follow-up**: 別 PR で `hints.pasteWarningEscapeSent: boolean` を追加 → caller が `detected: true && escape_sent: false` を観測できるようにする (= dialog 残置 risk が hint で見える化)。

### 2.9 [P2] kbd_hook worker thread の panic safety (Round 2 で Opus が言及していないが、本実装の検証で気付いた)

**背景**: `src/win32/kbd_hook.rs::install_low_level_keyboard_block` の worker thread panic 時の `UnhookWindowsHookEx` 呼出しは保証されていない (= `std::panic::catch_unwind` で wrap していない)。Drop guard は worker thread 外側 (caller thread) で動くため、worker 内 panic は hook leak につながり得る。

**Follow-up**: 別 PR で worker thread 内側を `catch_unwind` で wrap、panic 時も最低限 `UnhookWindowsHookEx` を呼ぶ + L1 panic counter に加算。

### 2.10 [P2] flash_duration_ms 最適化 (Phase 2 bench で plan §6.1 acceptance 未達)

**背景**: §3.1 実機計測 (2026-05-10) で `flash_duration_ms` が plan §6.1 acceptance `<= 80ms` を超過:
- scan OFF: mean 96.65ms / p99 122ms (target 80ms に対し +17ms)
- scan ON (default): mean 202.94ms / p99 281ms (target 80ms に対し +123ms)

**原因 breakdown**:

| 構成要素 | cost | 区分 |
|---|---|---|
| `PASTE_WARNING_SCAN_TIMEOUT_MS = 100ms` polling (scan ON のみ) | ~100ms | 構造的固定 |
| `PASTE_REFLECT_DELAY_MS = 30ms` Sleep (Ctrl+V 後の WT XAML 反映待ち) | 30ms | 構造的固定 |
| `wait_focus_ready` polling (max 30ms / interval 2ms) | 5-15ms | 半構造的 |
| `verify_foreground_returned` (max 10ms × 2 retry) | 5-10ms | 半構造的 |
| Hidden owner window create + destroy (per-call lifecycle) | 2-5ms | 環境依存 (§2.5 と統合候補) |
| Clipboard save (`OpenClipboard` retry + `EnumClipboardFormats` + `GetClipboardData`×N) | 5-15ms | 環境依存 (clipboard 内容次第) |
| Clipboard set + restore (`OpenClipboard` + `EmptyClipboard` + `GlobalAlloc` + `SetClipboardData`) | 8-20ms | 環境依存 |
| Foreground steal ladder 段 1 (`AttachThreadInput` + `SetForegroundWindow` + `BringWindowToTop`) | 5-15ms | 環境依存 |
| `SendInput(Ctrl+V)` | 1-3ms | 環境依存 |

→ scan OFF の構造的下限 ~50-80ms (paste reflect + focus polling + verify + Win32 syscall stack)、scan ON では +100ms。

**Follow-up 候補** (推定削減 / trade-off):

1. **paste reflect Sleep(30ms) を UIA polling 化**: -10〜20ms / WT TextPattern access cost で逆に重い可能性、要 profile (ADR-007 P5c-2 知見では WT TextPattern は重い側)
2. **`scan_paste_warning_dialog` を UIA event hook 化**: -80〜100ms (scan ON path) / UIA event 登録 cost + WT 専用 hook 設計、別 ADR scope 候補
3. **Dedicated owner thread + lazy init refactor**: -5〜10ms / §2.5 と統合、`RegisterClassExW`/`CreateWindowExW` を 1 回で済ませる
4. **`PASTE_REFLECT_DELAY_MS` 30ms → 15ms 短縮**: -15ms / WT 反映 race risk、50 連続 stress test で安全性確認必要

**Trigger**: dogfood で「flash visible すぎる」「latency 体感不快」report 集まったら別 PR で着手。**Phase 2 R1 ladder gate (本来の最重要 acceptance) は §3.1 で達成済**のため、本 item は performance polish 性質。

---

## 3. Phase 2 mandatory gate (実機検証、本 ADR §5.4.2 acceptance)

### 3.1 実行結果 (2026-05-10、PR #240 + PR #241 land 後)

**環境**:
- Windows 11、target = 別 WT window (`BenchTarget-Unique-12345` ユニーク title) を起動
- caller (Bash 経由 spawn された node + MCP server child) は非 foreground、Claude Code WT が foreground
- target ≠ foreground 条件で foreground steal ladder を確実に試行できる状態

**実行コマンド**: `node benches/adr013_foreground_flash_ladder.mjs --iters=50 --window-title="BenchTarget-Unique-12345"`

**ladder success counts**:

| iter 数 | Stage 1 (AttachThreadInput) | Stage 2 (alt_unlock) | already_foreground | total ladder success |
|---|---|---|---|---|
| 50 | **50** | 0 | 0 | **50/50 = 100.0%** ✅ (>= 80% gate) |
| 20 (warmup) | 20 | 0 | 0 | 20/20 = 100.0% ✅ |

→ 段 1 (`AttachThreadInput` dance) で全件成功、段 2 (`alt_unlock`) は fallback として未発火。production-like 環境 (caller 非 foreground、target 非 foreground) で AttachThreadInput が確実に動作することを実証。

**flash_duration_ms (success-only)**:

| 構成 | n | mean | p50 | p95 | p99 |
|---|---|---|---|---|---|
| default (paste warning scan ON) | 50 | 202.94 | 202 | 211 | 281 |
| `DESKTOP_TOUCH_FOREGROUND_FLASH_DISABLE_DIALOG_SCAN=1` | 20 | 96.65 | 95 | 122 | 122 |

差分 ~100ms = `PASTE_WARNING_SCAN_TIMEOUT_MS = 100ms` 固定 polling cost (§2.10 参照)。

### 3.2 acceptance gate 判定

- [x] **R1 ladder success rate >= 80%**: 100.0% で **PASS**、Phase 2 mandatory gate 達成 (ADR §5.4.2 acceptance)
- [ ] flash_duration_ms <= 80ms (plan §6.1): mean 97ms (scan OFF) / 203ms (scan ON) で **未達**、§2.10 (flash duration optimization) で別 PR 扱い (= performance polish、本来の最重要 acceptance ではない)

### 3.3 ADR-013 Status 昇格判断

R1 ladder gate PASS で Status: Draft → Accepted の **prerequisite** は満たした。実 release (v1.5.0+) 時に user 判断で実機 dogfood 期間 (BG 入力 path の degraded report 不在確認) を経て flip する想定。本 PR では Status は Draft のまま、ADR §9 に v1.4.5 entry で本 gate PASS narrative を embed。

### 3.4 design review fallback (gate 未達の場合の original 候補、本 PR では発火せず)

- (a) `block_keyboard_during_flash` default ON 化 (`DESKTOP_TOUCH_FOREGROUND_FLASH_BLOCK_KEYBOARD=1` を engine 標準 env に) — **不要** (R1 100% PASS)
- (b) Option F (cooperative bridge) priority shift (= Option E は短期解として残し、長期解 Option F を別 PR で着手) — **長期方針として継続検討**、本 R1 PASS とは独立 (ADR §3.6 outline 維持)
- (c) Option E ROI 悪い判定で本 PR を revert / Status: Rejected 化 — **不要** (R1 100% PASS で Implementation Land 妥当性確認済)

### 3.5 関連 issue close plan

| Issue | Close timing | Action |
|---|---|---|
| **#185** (ADR-013 Phase 4 stretch tracking) | 本 PR set (#240 + #241) merge 済の現時点で close 可 | 「ADR §3.5 fully landed + Phase 2 R1 PASS」comment で明記してから close |
| **#173** (parent audit、WT silent fail discovery) | v1.5.0 release narrative 後 (dogfood 1-2 週間で degraded report 不在 → Status: Accepted flip → release CHANGELOG narrative → close) | parent audit issue として long-tail 性格、release narrative で正式 closure narrative を embed してから close する方が history 整合性高い |

---

## 4. Decision History

| Date | Status | Author | Rationale |
|---|---|---|---|
| 2026-05-10 | Active (v1) | Claude (Sonnet) + Opus PR #240 Round 1+2 review | Round 1+2 で defer 判断した 9 item を集約 (Opus P1×1 + P2×4 + P3×3 + 自己発見 P2×1)、強制命令 9 違反 (永続化 docs 不在) を closure。Phase 2 mandatory gate も本 doc で永続化 |
