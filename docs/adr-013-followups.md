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

---

## 3. Phase 2 mandatory gate (実機検証、本 ADR §5.4.2 acceptance)

PR #240 の `benches/adr013_foreground_flash_ladder.mjs` を user が実機で実行し、以下を判断:

- [ ] **段 1 + 段 2 + already_foreground 合計成功率 >= 80%** → ADR §9 Decision History の v1.4 → Accepted 昇格判断
- [ ] **未達の場合**: 以下の design review:
  - (a) `block_keyboard_during_flash` default ON 化 (`DESKTOP_TOUCH_FOREGROUND_FLASH_BLOCK_KEYBOARD=1` を engine 標準 env に)
  - (b) Option F (cooperative bridge) priority shift (= Option E は短期解として残し、長期解 Option F を別 PR で着手)
  - (c) Option E ROI 悪い判定で本 PR を revert / Status: Rejected 化

実機計測結果を本 doc §3 末尾に append、ADR §9 にも v1.5 行で embed。

---

## 4. Decision History

| Date | Status | Author | Rationale |
|---|---|---|---|
| 2026-05-10 | Active (v1) | Claude (Sonnet) + Opus PR #240 Round 1+2 review | Round 1+2 で defer 判断した 9 item を集約 (Opus P1×1 + P2×4 + P3×3 + 自己発見 P2×1)、強制命令 9 違反 (永続化 docs 不在) を closure。Phase 2 mandatory gate も本 doc で永続化 |
