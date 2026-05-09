# Dogfood Scenarios — keyboard (action: type / press)

- Status: **manual / dogfood scenarios for Phase 2b execution audit**
- Date: 2026-05-09
- Origin: `docs/llm-audit/phase2b-execution-audit.md` §3.2 carry-over
- Scope: keyboard:type BG / FG / keyboard:press BG / FG の実機 GUI 依存シナリオ
- Parent audit section: 本 doc §2.x は `phase2b-execution-audit.md` §3.2 (keyboard、cell 4-7) の carry-over scenario。各シナリオは parent table の cell 内 `dogfood-scenarios/keyboard.md §2.x` 参照と相互リンク

---

## 2. keyboard シナリオ

### 2.1 keyboard:type BG — Notepad real PostMessage WM_CHAR round-trip

**目的**: matrix §3.1 line 140 規範「pre-send focused-element value 採取 → WM_CHAR 送信 → UIA TextPattern read-back」が real Notepad で end-to-end 動作することを確認。`tests/e2e/keyboard-bg-verification.test.ts` の補強 audit。

**手順**:
1. Notepad 起動、新規ファイル開く (focus 設定済)
2. `keyboard({action:'type', method:'background', windowTitle:'Notepad', text:'hello world'})` 呼出
3. response 観測: `ok:true`、`hints.verifyDelivery.status === 'delivered'` (read-back 一致)
4. Notepad 文書欄に `hello world` が visible

**期待**: BG path で keystroke 配信成功 + UIA read-back 一致。
**Anti-pattern**: silent `ok:true` で読み戻し未確認 → BG silent drop (#177 同型)。

### 2.2 keyboard:type BG — auto-routing class 判定 (#173 WT exclusion)

**目的**: `tests/unit/keyboard-method-resolution.test.ts:122-167` で pin した auto-pick allowlist (WT excluded、conhost included) が real Windows session で同等動作することを確認。

**手順**:
1. **WT path**: Windows Terminal 起動 → `keyboard({action:'type', method:'auto', windowTitle:'PowerShell - Windows Terminal', text:'echo hi'})` → 内部で `auto` 判定 → foreground fallthrough → 通常 SendInput
2. **conhost path**: `Start-Process conhost.exe -ArgumentList 'pwsh'` → conhost host で起動 → `keyboard({action:'type', method:'auto', windowTitle:'pwsh', text:'echo hi'})` → 内部で `background-auto` 判定 → PostMessage WM_CHAR

**期待**: WT は foreground / conhost は BG path、各 envelope の `hints.method` 等で経路明示。
**Anti-pattern**: WT で auto → BG → silent drop (#173 reactivated)、または conhost で foreground unnecessarily steal focus。

### 2.3 keyboard:type FG — surrogate pair (emoji-heavy text) chunk boundary

**目的**: `tests/unit/keyboard-leash-guard.test.ts:320-359` で pin した surrogate pair handling が real Windows app で正しく landing することを確認。

**手順**:
1. Notepad 起動
2. `keyboard({action:'type', method:'foreground', windowTitle:'Notepad', text:'😀hello world 🎉日本語', abortOnFocusLoss:true})` (chunk size default 8)
3. Notepad 内に絵文字を含む完全な文字列が visible

**期待**: chunk 境界 (8 codepoints) で surrogate pair が分割されず、`😀` `🎉` が完全な codepoint として landing。
**Anti-pattern**: lone high surrogate (`\uD83D`) が landing → 文字化け / Notepad 表示崩れ。

### 2.4 keyboard:press BG — combo semantic verification (manual)

**目的**: matrix §3.1 line 142 規範「combo の semantic 効果は target ごとに分岐するため `verifyDelivery: unverifiable` で degradation 明示、enter / tab / arrow は terminal-class なら read-back-verified」を実機確認。E2 (automated combo edge pin gap) の代替 SoT。

**手順**:
- **enter (terminal-class、verified)**: PowerShell 起動 → `keyboard({action:'press', method:'background', windowTitle:'PowerShell', keys:'enter'})` → `hints.verifyDelivery.status === 'delivered'` (next-line 観測で確認)
- **ctrl+a (non-terminal、unverifiable)**: Notepad → `keyboard({action:'press', method:'background', windowTitle:'Notepad', keys:'ctrl+a'})` → `hints.verifyDelivery.status === 'unverifiable'` + reason に SelectionPattern read 観測経路 unavailable
- **arrow (terminal-class、verified)**: PowerShell → `keys:'down'` → 次 history line 表示 + verifyDelivery: delivered

**期待**: enter/tab/arrow は terminal-class で verified、ctrl+a 等 combo は unverifiable hint 明示。
**Anti-pattern**: silent ok:true で hint 不在 → combo silent drop。

### 2.5 keyboard:press FG — modifier ordering / Ctrl+Shift+Tab focus shift edge (E2 dogfood SoT)

**目的**: Ctrl+Shift+Tab で foreground swap → 同 keyboard:press 内で focus 失う edge case を実機確認。E2 (automated pin gap) の代替 SoT。

**手順**:
1. 複数 Chrome window を開く
2. Chrome window A をフォーカス
3. `keyboard({action:'press', method:'foreground', windowTitle:'Chrome', keys:'ctrl+shift+tab'})` 呼出
4. response 観測: `ok:false`、`code:"FocusLostDuringType"` (combo 自身が focus shift を起こす edge)、`suggest[]` に re-target 推奨

**期待**: combo 自身による focus shift を `FocusLostDuringType` で検出 + actionable suggest。
**Anti-pattern**: silent ok:true で別 window に combo landing → cross-window keystroke regression。

`Win+Tab` (task view) / `Alt+Esc` (window cycle) も同型 edge、組合せ確認推奨。

### 2.6 keyboard:type → keyboard:type retry chain (typed/remaining)

**目的**: `tests/unit/keyboard-leash-guard.test.ts:280-298` の typed/remaining contract が real focus theft scenario で retry chain として機能することを確認。

**手順**:
1. Notepad focus 状態
2. **side-channel**: 別 PowerShell で `Start-Sleep 1; Start-Process notepad` を起動 → 1 秒後に新 Notepad が foreground 奪取
3. 同時に `keyboard({action:'type', method:'foreground', windowTitle:'(元 Notepad)', text:'long text that takes time to type', abortOnFocusLoss:true, chunkSize:8})` 呼出
4. response 観測: `ok:false`、`code:"FocusLostDuringType"` (top-level、PR #218 / I1 fix 後)、`suggest:[...3 strings...]` (top-level、`_errors.ts` SUGGESTS 自動解決)、`context.typed` に部分送信文字数、`context.remaining` に未送信文字列、`context.total / context.chunkSize / context.focusLost` も single-nest
5. element re-locate 後、`keyboard({action:'type', method:'foreground', windowTitle:'(元 Notepad)', text: <step4 remaining>})` で retry chain
6. 文書全体が結合された姿で landing

**期待**: typed/remaining が UTF-16 code unit 単位で一貫、retry chain で完全送信。
**Anti-pattern**: typed だけ codepoint・remaining だけ UTF-16 で乖離 → retry で文字 dup / drop。

---

## 共通操作上の note

- **focus theft 再現**: `Start-Process` + `Start-Sleep` で side-channel に新 process 起動するのが最も確実。Win11 Focus Assist 設定が干渉する場合は無効化推奨。
- **chunk size env**: `DTM_LEASH_CHUNK_SIZE=4` に設定すれば 8-char text で 2 chunk、focus theft 検証が容易。本 audit では `chunkSize:8` でも env override の `4` でもどちらも有効。
- **combo whitelist 確認**: `keyboard:press` の `keys` フィールドは `+` 区切り (例: `ctrl+shift+a`)、case-insensitive、modifier は `ctrl/shift/alt/win/meta` の 5 種。
