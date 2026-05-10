# ADR-013 Option E (`foreground_flash` channel) — 本実装 plan v3

- Status: **Draft (v3、user review v2 apply 後の修正、再 user 目視確認 → ExitPlanMode → 実装 begin)**
- Date: 2026-05-10
- Authors: Claude (Sonnet 起草、user review v1→v2→v3 反復、Opus + Codex review pending)
- Related:
  - ADR-013 (`docs/adr-013-wt-bg-input.md`) — 親 ADR、本 plan で §3 に新 Option E + Option F section 追加 + Phase 4 trajectory flip
  - issue #185 — Phase 4 stretch tracking
  - PR #239 (merged) — Round 1 NO-GO (`AttachConsole + WriteConsoleInputW`)
  - spike branch `spike/wt-attachconsole-input` — Round 2 探索 + Option E light/typing 検証
  - `docs/wt-bg-spike-round2-findings.md` — Round 2 全 finding
  - memory `feedback_clipboard_flash_design_pitfalls.md` — v1/v2 plan で User が指摘した P1×7 + P2×3 + Option F 提案 + OLE IDataObject 提案
- Blocks: なし
- Blocked by: 本 plan v3 の user 確認 + ExitPlanMode

---

## 1. Context

PR #239 で `AttachConsole + WriteConsoleInputW` 経路を NO-GO 確定後、ADR-013 §3 の A/B/C/D 4 候補以外を平行調査:

- **Option A (ConPTY 公式 API)**: Day 0 gate fail
- **Option B (UIA writable pattern POC)**: NO-GO 確定 (TermControl は TextPattern のみ)
- **Option C (PSRemoting)**: scope 違 → 別 issue
- **Option D (laffo16 PR #20106 community proposal)**: v1 plan で「m13v 氏」と取り違えていた (User review で訂正、m13v 氏は issue comment の助言者として残す)、Microsoft 公式 Reject (`microsoft/terminal#9368`) 済
- **新 Option E (Clipboard + foreground flash)**: light + typing 干渉 spike 完了 → 本 plan で本実装 (`foreground_flash` channel として `background` 契約から完全分離)
- **新 Option F (Cooperative in-pane bridge)**: User 提案、本物 BG + Microsoft 意思整合 + 長期 stable = **長期本命候補**。本 plan §9 で ADR §3.6 に追加 (本実装は別 PR / 別 plan)

`microsoft/terminal#9368` で `wt send-input` が Microsoft 公式 Reject されている事実を踏まえ、本 plan の Option E は **`background` 契約とは明示的に分離した `foreground_flash` channel** として実装。`background` 契約 (= "foreground 奪取しない") を破る path に default route しない。

---

## 2. Decision

### 2.1 本 plan での実装範囲

- **Option E** を **`foreground_flash` channel** として本実装 (= `method: 'foreground_flash'` で明示 opt-in)
- **既存 `method: 'background'` channel は WT 不対応のまま維持** (PR #174 で reverse 済の WT XAML pipeline 不対応を維持、issue #173 silent-success 構造的回避)
- **Option F (Cooperative bridge)** は ADR-013 §3.6 に **新候補として追加 (docs only)**、本実装は別 PR / 別 plan
- **OLE `IDataObject` snapshot** は MVP scope 外、別 spike phase で評価 (User 提案、§10 Roadmap の Option C-Phase で扱う)

### 2.2 Channel 設計

```
┌─────────────────────────────────────────────────────────────────┐
│ keyboard:type / terminal:send caller                             │
│  method: 'foreground'                       │ method: 'background' │ method: 'foreground_flash' (新)│
└─────────────────────────────────────────────────────────────────┘
                  │                                  │                                  │
                  ▼                                  ▼                                  ▼
        SendInput foreground 経路               BG 経路 resolver 経由                      Option E (本 plan)
        (既存、WT 含む全 hwnd 対応)          (新) resolveBackgroundInputChannel()        専用 channel:
                                              ├─ wm_char (既存、WT 不対応のまま維持)            'foreground_flash'
                                              ├─ clipboard_flash ← 本 plan の Option E         明示 opt-in、別 method
                                              └─ cooperative_bridge ← Option F (将来別 PR)
```

**`canInjectViaPostMessage` は touch しない**: 既存 WM_CHAR 判定として残し、WT は引き続き `{supported: false, reason: "wt_xaml_pipeline"}` を返す。新 channel 選択は **`resolveBackgroundInputChannel(hwnd, opts)`** という新 API を導入し、`"wm_char" | "clipboard_flash" | "cooperative_bridge" | null` を discriminator として返す。**caller migration は本 plan PR 内で一気に揃える** (二重分岐期間 = 0)。

---

## 3. Option E (`foreground_flash` channel) 設計

### 3.1 Foreground steal 設計

`AllowSetForegroundWindow(targetPid)` は **target 側に foreground 設定権を譲る** API で caller 自身の SetForegroundWindow restriction は bypass しない (Microsoft docs)。caller 自身が foreground 権を持っているか / `AttachThreadInput` で偽装するかが本質。

**Ladder design (既存 + 新規追加 を明示分離)**:

| 段 | 機構 | 既存 / 新規 |
|---|---|---|
| 1 | `restoreAndFocusWindow(hwnd, {force: true})` (既存 `src/engine/win32.ts`、内部で **native `win32_force_set_foreground_window`** = `src/win32/input.rs:53` 経由 `AttachThreadInput` ladder) | **既存流用** |
| 2 | `keybd_event(VK_MENU, 0, 0, 0); keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);` (Alt key down/up) で foreground lock を temporary release してから再 `SetForegroundWindow(wtHwnd)` | **本 plan で新規追加** |
| 3 | 上記でも fail なら **channel fail** (`reason: "foreground_steal_denied"`) で error envelope、caller に `method: 'foreground'` への明示 fallback を suggest | (本 plan で実装) |

ladder 各段の成否を hints に記録 (`hints.foregroundSteal: { method: "AttachThreadInput" | "alt_unlock" | "denied", attempts: <number> }`)、observability で degraded path 検出可能。

**実装場所**:
- 既存 段 1: 触らない (TS `src/engine/win32.ts::restoreAndFocusWindow` → native `src/win32/input.rs::win32_force_set_foreground_window`)
- 新規 段 2 (Alt unlock): 新 file `src/win32/foreground_flash.rs` 内 helper (`alt_unlock_then_set_foreground`、napi 非公開の internal fn)

### 3.2 Clipboard rigorous handling

#### 3.2.1 Hidden owner HWND

`OpenClipboard(hiddenOwner)` で使う message-only window:

- **専用 window class** (`STATIC` 流用ではなく、`DTM_ClipboardOwner` のような専用 class を `RegisterClassExW` で登録)
- **WndProc 実装**: `DefWindowProcW` 呼出のみ (我々は遅延 rendering 提供しないので NULL response でも安全)
- **lifecycle**: per-call create + destroy (calling thread で `with_hidden_owner` scope 内、~80ms の flash 中のみ存続)

**Implementation deviation (PR #240 Round 1 P2-1 反映)**: 本 plan 起草時は engine 起動時 lazy init + dedicated thread + message loop pumping を要求していたが、実装は **per-call lifecycle (calling thread)** に縮小。理由:
- clipboard 操作は ~80ms の短い session、`OpenClipboard` 〜 `CloseClipboard` 間で他 process 由来の `WM_RENDERFORMAT` を受け取る必要がない (我々は HGLOBAL 系のみ書込み、遅延 rendering 提供しない)
- dedicated thread + message loop は engine lifecycle 管理が必要で複雑度高、MVP scope 外
- per-call の overhead は `RegisterClassExW` + `CreateWindowExW` で ~1ms 以下 (`CLASS_REGISTERED` AtomicBool で 2 回目以降 register skip)

将来 dogfood で performance 顕在化 (= 1 秒に複数 inject など) したら別 PR / Phase 1.5 で dedicated thread に refactor 予定 (`docs/adr-013-followups.md` に永続化候補)。

#### 3.2.2 Sequence number 比較 (3 point)

```rust
// 1. Save 前
let seq_before_snapshot = GetClipboardSequenceNumber();
let snapshot = save_clipboard_all_supported_formats(hidden_owner);

// 2. Inject 後
SetClipboardDataUnicode(text, hidden_owner);
let seq_after_inject_clipboard = GetClipboardSequenceNumber();

// 3. (Ctrl+V 送信、復帰、もろもろ後)
let seq_before_restore = GetClipboardSequenceNumber();

// Restore skip 判定: 我々の inject 以降に他者が触ったか?
if seq_before_restore != seq_after_inject_clipboard {
    // skip + warn
    return RestoreOutcome::SkippedDueToRace { hint: "user_clipboard_modified_during_flash" };
}
restore_clipboard_all_supported_formats(snapshot, hidden_owner);
```

**3 point の意義**: 自分の `SetClipboardData` で必ず sequence は変動する → snapshot 時点と比較する v1 design は常に skip 判定になる。`seq_after_inject_clipboard` を基準にして restore 直前と比較する形が正しい race detection。

#### 3.2.3 サポート format 範囲 (MVP)

**MVP は HGLOBAL 系限定**:
- `CF_UNICODETEXT` / `CF_TEXT` / `CF_OEMTEXT` (text 系)
- `CF_HDROP` (file list、HGLOBAL based)
- `CF_LOCALE` (locale identifier、HGLOBAL based)
- `CF_DIBV5` / `CF_DIB` (HGLOBAL based bitmap)
- private format で HGLOBAL のもの (`EnumClipboardFormats` で発見、`GetClipboardData(fmt)` 経由 `GlobalLock` で安全に bytes 取り)

**MVP で skip する format (save snapshot に warn 残す、restore 不可)**:
- `CF_BITMAP` (HBITMAP handle、生 bytes 化 NG)
- `CF_ENHMETAFILE` (HENHMETAFILE handle)
- `CF_PALETTE` (HPALETTE handle)
- `CF_OWNERDISPLAY` / `CF_DSPxxx` (遅延 rendering / display owner)
- 不明な private format (HGLOBAL でない可能性あり、`GlobalSize` 失敗で skip)

**snapshot 結果に skip 情報を含める**:

```rust
pub struct ClipboardSnapshot {
    pub sequence_number: u32,
    pub supported_formats: HashMap<u32, Vec<u8>>,    // HGLOBAL 系 bytes
    pub skipped_formats: Vec<(u32, &'static str)>,   // (format, reason) "non_hglobal" / "deferred_render" / "unknown_private"
}
```

restore 時に `skipped_formats` が non-empty なら hints で warn (`hints.clipboardRestoreSkippedFormats: [{format: 8, reason: "non_hglobal"}, ...]`)、user に「画像/メタファイル等は復元されません」を明示。

#### 3.2.4 OpenClipboard lock contention

`OpenClipboard(hiddenOwner)` retry: 上限 100ms / 10 retry (10ms 間隔)、超過なら channel fail (`reason: "clipboard_lock_contention"`)。

#### 3.2.5 OLE IDataObject 検討は別 spike phase

User 提案: OLE `OleGetClipboard` / `OleSetClipboard` で `IDataObject` snapshot は format / 遅延 rendering を自然に扱える。本 MVP scope 外、§10 Roadmap の Phase 1.5 (option) として spike を予定 (HGLOBAL MVP の限界が production で顕在化したら採用検討)。

### 3.3 WT paste warning constraint

#### 3.3.1 Input 制限 (warning trigger 構造的回避)

- **Single-line only**: clipboard text に **改行を含まない** (改行は paste warning の主 trigger)
- **5KiB 未満** (UTF-16 で 2500 chars 程度) — `largePasteWarning` の閾値 (1KiB default、user 設定で変動可) より余裕を取る
- **Implementation update (Round 1 P1-3)**: 改行と 5KiB 超の reason を分離:
  - `reason: "input_contains_newline"` (改行 LF / CR 含、caller suggest = 改行除去 + 分割 inject)
  - `reason: "input_exceeds_paste_warning_threshold"` (UTF-16 >= 5KiB、caller suggest = 分割 inject or `method: 'foreground'`)

#### 3.3.2 Enter は別 SendInput で送る (text に含めない)

- caller が末尾 Enter を望む場合、**clipboard text には Enter を含めない**
- paste 完了 verify 後 (= 後述 §3.5 focus-ready 確認後 + Ctrl+V 後の delay)、**別 SendInput(VK_RETURN) を送る**
- 例: `keyboard:type({text: "echo HELLO", method: "foreground_flash", pressEnter: true})` → clipboard には `"echo HELLO"` のみ、Ctrl+V 後 50ms wait + SendInput(VK_RETURN)

これにより `multiLinePasteWarning` を構造的に発生させない (clipboard 改行ゼロ → warning trigger ゼロ)。

#### 3.3.3 Warning dialog scan (default ON、保険)

本命は §3.3.1+§3.3.2 の構造的回避だが、保険として:
- flash 直後に UIA で `Microsoft.UI.Xaml.Controls.ContentDialog` を 100ms scan
- 検出時は Esc 送信 + channel fail (`reason: "wt_paste_warning_intercepted"`)
- env で OFF 可能 (`DESKTOP_TOUCH_FOREGROUND_FLASH_DISABLE_DIALOG_SCAN=1`)

### 3.4 Typing leak mitigation

本 channel は **`foreground_flash` 明示 opt-in method** (`method: 'foreground_flash'`、`background` とは別 path):

- **`method: 'background'` の caller には本 channel は絶対 route しない** (silent contract violation 防止)
- **caller が明示的に `method: 'foreground_flash'` を指定** することで「foreground を奪う妥協を許容」を契約
- keyboard block (LowLevel hook) は **default OFF**、env opt-in (`DESKTOP_TOUCH_FOREGROUND_FLASH_BLOCK_KEYBOARD=1`)
  - 「telemetry で漏れ報告」ではなく「**dogfood + GitHub issue report + hints 集計**」で default flip 判断する
- **typing 漏れ risk を hints で明示**: `hints.foregroundFlash: { typingLeakRisk: true, mitigation: "userTypingDuringFlashMayLeakToWT" }` を毎 inject で返す

### 3.5 Focus-ready 判定

```rust
fn wait_focus_ready(wt_hwnd: HWND, timeout_ms: u32) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(timeout_ms as u64) {
        if GetForegroundWindow() == wt_hwnd {
            let mut info: GUITHREADINFO = zeroed();
            info.cbSize = size_of::<GUITHREADINFO>() as u32;
            let wt_tid = GetWindowThreadProcessId(wt_hwnd, null_mut());
            if GetGUIThreadInfo(wt_tid, &mut info).as_bool() {
                if info.hwndFocus != HWND::default() {
                    return true;
                }
            }
        }
        Sleep(2);
    }
    false
}
```

`GetForegroundWindow() == wt_hwnd` + `GetGUIThreadInfo` で focus 確認、polling 上限 30ms。失敗時は channel fail (`reason: "focus_wait_timeout"`)。

(`WaitForInputIdle` は process handle 用、focus-ready 判定不適、却下)

### 3.6 Native signature (HWND は pointer-sized で揃える)

既存 `src/win32/input.rs` の pattern (`hwnd_from_bigint` helper + `napi_safe_call` wrap) に follow:

```rust
// src/win32/foreground_flash.rs (新 file、napi binding 同居 = 既存 win32 module pattern)

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::Win32::Foundation::HWND;
use super::safety::napi_safe_call;     // 既存 panic guard
// hwnd_from_bigint は input.rs と同 pattern (ローカル fn or super:: 経由)

#[napi]
pub fn win32_foreground_flash_inject(
    target_hwnd: BigInt,                  // ← x64 64-bit safe (既存 input.rs と同 pattern)
    target_pid: u32,
    text: String,
    options: ForegroundFlashOptions,
) -> napi::Result<ForegroundFlashResult> {
    napi_safe_call("win32_foreground_flash_inject", || {
        let target = hwnd_from_bigint(target_hwnd);
        // ... §3.7 sequence の実装 ...
    })
}

// Rust internal
fn alt_unlock_then_set_foreground(target: HWND) -> bool { ... }
```

新 file は `src/win32/foreground_flash.rs` として配置、`src/win32/mod.rs` に `pub(crate) mod foreground_flash;` 追加で登録。

### 3.7 全体 sequence (v3 修正版)

```
[external process (desktop-touch-mcp engine)]
  // Pre-flight
  1. Validate inputText: NO newlines (fail "input_contains_newline") + < 5KiB UTF-16 (fail "input_exceeds_paste_warning_threshold")
  2. Resolve channel via resolveBackgroundInputChannel(wtHwnd) → confirm "clipboard_flash"

  // Save state (rigorous)
  3. originalForegroundHwnd = GetForegroundWindow()
  4. seq_before_snapshot = GetClipboardSequenceNumber()
  5. clipboardSnapshot = SaveClipboardSupportedFormats(hiddenOwnerHwnd)   ※ HGLOBAL 系のみ、非 HGLOBAL は skip+warn

  // Set new clipboard (text only, no Enter)
  6. SetClipboardDataUnicode(inputText, hiddenOwnerHwnd)
  7. seq_after_inject_clipboard = GetClipboardSequenceNumber()

  // Foreground steal (ladder)
  8. ladder_step_1: restoreAndFocusWindow(wtHwnd, {force: true}) → 失敗なら
     ladder_step_2: alt_unlock_then_set_foreground(wtHwnd) → 失敗なら
     fail("foreground_steal_denied")

  // Wait WT focus ready
  9. WaitFocusReady(wtHwnd, max 30ms) → 失敗なら fail("focus_wait_timeout")

  // Inject Ctrl+V (NOT Enter)
 10. SendInput(Ctrl+V)
     ※ Optional: keyboard block hook installed if env=1

  // Paste verify (短い delay で WT が paste reflect するの待ち)
 11. Sleep 30ms

  // Send Enter (separate SendInput, AFTER paste reflected)
 12. if options.press_enter: SendInput(VK_RETURN)

  // Restore foreground (ladder + verify)
 13. restoreAndFocusWindow(originalForegroundHwnd, {force: true}) (ladder)
 14. VerifyForegroundReturned (max 10ms loop) → 不一致なら 2 回 retry → fail("foreground_restore_failed")

  // Restore clipboard (3 point sequence check)
 15. seq_before_restore = GetClipboardSequenceNumber()
 16. if seq_before_restore != seq_after_inject_clipboard:
        skip + hints.clipboardRestoreSkipped
     else:
        RestoreClipboardSupportedFormats(clipboardSnapshot, hiddenOwnerHwnd)

  // Detect WT paste warning dialog (default ON、保険)
 17. ScanForWtPasteWarningDialog (max 100ms via UIA) → 検出時 Esc + fail

  // Caller-side readback (既存 terminal:read 契約)
 18. ReadbackVerify(SLO p99 < 200ms)
```

**Implementation deviation (PR #240 Round 1 P3-2 反映)**: 上記 step 17 (paste warning scan) は本実装で **step 8.5 (Ctrl+V + 必要な Enter 直後、foreground restore より前)** に前倒し。理由: WT が foreground のうちに `VK_ESCAPE` を SendInput で送らないと、step 13 後 (`SetForegroundWindow(originalForegroundHwnd)` 後) は Esc が `originalForegroundHwnd` に届いて dialog dismiss 先と一致しない (modal dialog の z-order 上 dialog 自身が前面でも、`SetForegroundWindow` で original を取り戻した直後は queue が混乱する)。実用挙動は本 sequence と等価 (構造的回避 §3.3.1 で trigger 確率 ~0、本 deviation は保険 layer の効き目改善のみ)。本 deviation は ADR-013 v1.4 §3.5 末尾でも言及。

---

## 4. Channel resolver 分離

### 4.1 既存 API を破壊しない方針

- **`canInjectViaPostMessage(hwnd)` は touch しない**: WM_CHAR 判定として機能維持、WT は `{supported: false, reason: "wt_xaml_pipeline"}` を返し続ける
- 新 API **`resolveBackgroundInputChannel(hwnd, opts)`** を導入

### 4.2 新 API signature (TS hwnd は bigint で統一)

```ts
type BackgroundInputChannel =
  | { kind: "wm_char"; hwnd: bigint }
  | {
      kind: "clipboard_flash";
      hwnd: bigint;
      pid: number;
      constraints: { maxBytes: 5120; singleLineOnly: true };
    }
  | { kind: "cooperative_bridge"; sessionId: string; pipeName: string }   // Option F (将来)
  | { kind: "unsupported"; reason: BackgroundUnsupportedReason };

type BackgroundUnsupportedReason =
  | "elevated_target"
  | "no_supported_channel"
  | "wt_xaml_pipeline"
  | "user_disabled_foreground_flash";

interface ResolveBackgroundInputOptions {
  /** caller が許可している channel kinds (default: ["wm_char"]) */
  allowedChannels?: Array<"wm_char" | "clipboard_flash" | "cooperative_bridge">;
}

function resolveBackgroundInputChannel(
  hwnd: bigint,
  opts?: ResolveBackgroundInputOptions
): BackgroundInputChannel;
```

`hwnd: bigint` で既存 `WindowZInfo.hwnd: bigint` と統一、native BigInt と round-trip safe。

### 4.3 caller-side migration (本 plan PR 内で一気に揃える)

- `method: 'background'` の caller は **`allowedChannels: ["wm_char"]`** (デフォルト) で呼び、WT は引き続き unsupported
- `method: 'foreground_flash'` の caller は `allowedChannels: ["wm_char", "clipboard_flash"]` で呼び、WT で `clipboard_flash` channel を取得
- `keyboard:type` / `terminal:send` の dispatch logic で `method` 値に応じて `allowedChannels` を pass
- **二重分岐期間 ゼロ** (既存 `canInjectViaPostMessage` 経路は WM_CHAR 用に維持、新 resolver 経由 caller を 1 PR で全揃え)

---

## 5. Implementation phases

### 5.1 Phase 1: Native Win32 layer (Rust)

既存構造: napi-rs 0.62 + windows-rs 0.62、root `Cargo.toml` 1 lib (cdylib)、`src/win32/mod.rs` で各 module 登録、`#[napi]` マクロで JS 公開。Cargo.toml の `[target.'cfg(windows)'.dependencies]` で windows features を gate。

**新 file**: `src/win32/foreground_flash.rs` (主 file、napi binding 同居)
- `#[napi] pub fn win32_foreground_flash_inject(target_hwnd, target_pid, text, options) -> napi::Result<ForegroundFlashResult>`
- internal `fn alt_unlock_then_set_foreground(target: HWND) -> bool` (§3.1 ladder 段 2 新規)
- `ForegroundFlashOptions { max_focus_wait_ms, foreground_restore_retries, block_keyboard_during_flash, scan_paste_warning_dialog, press_enter }`
- `ForegroundFlashError` (napi error variant、Round 1 P1-3 で 7 → 8 種): `input_contains_newline` / `input_exceeds_paste_warning_threshold` / `foreground_steal_denied` / `focus_wait_timeout` / `clipboard_lock_contention` / `foreground_restore_failed` / `wt_paste_warning_intercepted` / `send_input_failed`
- 既存 `win32_force_set_foreground_window` (`input.rs:53`) を ladder 段 1 として呼び出し (Rust 内部 function call、TS 経由しない)

**新 file**: `src/win32/clipboard_snapshot.rs` — Clipboard rigorous handling (§3.2)
- `with_hidden_owner(f) -> Result<R, ClipboardError>` — per-call lifecycle で hidden owner window を create + closure 実行 + destroy (§3.2.1 deviation note 参照、Round 1 P2-1 で plan 起草時の lazy + dedicated thread + message loop 要件から縮小)
- `save_clipboard_supported_formats(owner) -> Result<ClipboardSnapshot, ClipboardError>` — HGLOBAL 系のみ save、非 HGLOBAL は skipped_formats に
- `restore_clipboard_supported_formats(snapshot, owner) -> Result<RestoreOutcome, ClipboardError>` — 3 point sequence check 込み
- `ClipboardSnapshot` (§3.2.3 構造)
- napi 非公開 (foreground_flash.rs から内部 call のみ)

**新 file**: `src/win32/kbd_hook.rs` (option only) — LowLevel keyboard hook
- `install_low_level_block(duration_ms: u32) -> Result<HookGuard, HookError>` — Drop で uninstall

**新 file**: `src/win32/wt_dialog_scan.rs` (option only) — UIA で `Microsoft.UI.Xaml.Controls.ContentDialog` scan + Esc 送信
- 既存 ADR-007 P5c-1 で UIA bindings 経験あり (`Win32_UI_Accessibility` features 既に Cargo.toml に含む)

**修正**: `src/win32/mod.rs` に新 4 module を `pub(crate) mod foreground_flash; pub(crate) mod clipboard_snapshot; pub(crate) mod kbd_hook; pub(crate) mod wt_dialog_scan;` で登録 (`#[cfg(windows)]` gate 込み)

**修正**: `Cargo.toml` の windows-rs features に追加 (clipboard / hook 用):
- `Win32_System_DataExchange` (clipboard API: `OpenClipboard` / `EmptyClipboard` / `SetClipboardData` / `GetClipboardData` / `EnumClipboardFormats` / `GetClipboardSequenceNumber`)
- `Win32_System_Memory` (HGLOBAL: `GlobalAlloc` / `GlobalLock` / `GlobalUnlock` / `GlobalSize`)
- `Win32_System_LibraryLoader` (`GetModuleHandleW` for hidden window class registration)
- `Win32_UI_WindowsAndMessaging` 既存 + `RegisterClassExW` / `CreateWindowExW` / `DestroyWindow` / message loop API

`Win32_UI_Input_KeyboardAndMouse` 既存 (`SendInput` / `keybd_event` / `MapVirtualKeyW`) で SendInput / Alt unlock 対応可。`Win32_UI_Accessibility` 既存で UIA dialog scan 対応可。

**unit test** (`src/win32/foreground_flash.rs` / `clipboard_snapshot.rs` 同 file):
- HGLOBAL format round-trip (CF_UNICODETEXT / CF_TEXT / CF_HDROP mock)
- 非 HGLOBAL format save → skip + warn 確認
- 3 point sequence number check (race fixture)
- foreground steal ladder の各段 (mock)
- Alt unlock trick 単体 (foreground lock fixture)
- focus-ready 判定 timeout
- paste warning input 制限
- Hidden owner window class 登録 + 解除 leak-free

**実装規模**: ~500 line Rust + ~80 line napi binding + ~200 line unit test

### 5.2 Phase 1.5 (option): OLE IDataObject snapshot spike

User 提案による option phase。MVP HGLOBAL 限定で「画像復元できない」が production で顕在化したら本 phase で OLE snapshot 採用検討。

- `OleGetClipboard(IDataObject**)` / `OleSetClipboard(IDataObject*)` で IDataObject snapshot 取得 / 復元
- COM apartment threading (STA 必要)、clipboard 操作 thread は STA 化必要
- 既存 HGLOBAL snapshot との比較 spike (どちらが production data 復元成功率高いか)

**判断軸**: Phase 1 native land 後に dogfood で「画像復元できない」report を集める → 必要なら Phase 1.5 で別 PR、不要なら HGLOBAL MVP のまま

### 5.3 Phase 2: production-like 実機検証 (mandatory gate)

R1 (foreground steal 成功率) mitigation。Phase 1 native 完了 → TS engine 統合 (Phase 3) 前の **mandatory gate**。

- production の MCP server (Node.js child process) を実際に spawn
- MCP 経由で `foreground_flash_inject` を invoke
- foreground steal ladder の各段成否を実機計測 (~50 回連続)
- ladder 段 1 (既存 `restoreAndFocusWindow`) の成功率
- ladder 段 2 (Alt unlock) の成功率
- 全 fail (`foreground_steal_denied`) 率
- 結果次第で R1 mitigation 設計 review

**判断**: 段 1+2 の合計成功率 < 80% なら Phase 3 着手前に design review (LowLevel hook を default ON 化検討、または Option F 優先で Option E は ROI 悪い判定 等)。

### 5.4 Phase 3: TS engine layer

**新 file**: `src/engine/background-channel-resolver.ts`
- `resolveBackgroundInputChannel(hwnd, opts)` の TS 実装、§4.2 signature

**修正**: `src/engine/bg-input.ts`
- `canInjectViaPostMessage` は touch しない
- 新 dispatch helper `dispatchBackgroundInjection(hwnd, text, channel, opts)` で channel 別 routing
  - `wm_char`: 既存 `postCharsToHwnd` (touch しない)
  - `clipboard_flash`: 新 `injectViaForegroundFlash` (native `win32_foreground_flash_inject` 呼び出し、既存 `src/engine/win32.ts` の koffi/napi pattern に follow)
  - `cooperative_bridge`: 将来 (Option F、本 plan 外、`throw new Error("not implemented")`)

**修正**: `src/tools/keyboard.ts` / `src/tools/terminal.ts`
- `method: 'foreground_flash'` を accept、`resolveBackgroundInputChannel(hwnd, {allowedChannels: ["wm_char", "clipboard_flash"]})` で channel 取得
- response hints に `backgroundChannel: "clipboard_flash"` と `typingLeakRisk: true` を追加
- Zod schema 拡張 (`method` enum に `"foreground_flash"` 追加)

**実装規模**: ~150 line resolver + ~100 line bg-input.ts + ~80 line tool 修正 + ~80 line Zod schema 拡張

### 5.5 Phase 4: E2E test

**新 file**: `tests/e2e/foreground-flash-verification.test.ts`
- `method: 'foreground_flash'` 明示で WT に inject、success 確認
- 100 連続 inject で flaky < 1%
- foreground 復帰失敗 fixture (Win11 lock simulation) で typed reason 観測
- clipboard race fixture: flash 中に別 process が `SetClipboardData` → 3 point sequence で skip 観測 + hints 確認
- input 制限超過 fixture: 改行ありで `input_contains_newline` / 6KiB で `input_exceeds_paste_warning_threshold` 観測 (Round 1 P1-3 で reason 分離)
- WT paste warning dialog scan: dialog 出る大きい input で `wt_paste_warning_intercepted` 観測 (scan default ON)
- HGLOBAL 系 format round-trip (text の clipboard が flash 後に復元される)
- 非 HGLOBAL format (画像 etc) が clipboard にあるとき、save snapshot で skipped_formats に記録、restore 後画像 clipboard が消える事実を観測 + hints `clipboardRestoreSkippedFormats` 確認

**修正**: 既存 `tests/e2e/keyboard-bg-verification.test.ts` / `tests/e2e/terminal.test.ts`
- WT scenario の現状 negative test は **そのまま維持** (= `method: 'background'` で WT 不対応の契約は破らない)
- `method: 'foreground_flash'` での positive case は新 file に追加

**実装規模**: ~300 line E2E test (新規) + 既存 test 触らず

### 5.6 Phase 5: ADR-013 docs update + CHANGELOG

`docs/adr-013-wt-bg-input.md` 更新:
- §3 末尾に **新 §3.5 Option E: `foreground_flash` channel** section 追加 (本 plan §2-§4 を 1:1 transcribe + clear scope: `background` 契約とは分離)
- §3 末尾に **新 §3.6 Option F: Cooperative in-pane bridge** section 追加 (本 plan §9 概要、別 PR で実装される旨明示)
- §4 trade-off table に Option E (`foreground_flash`) + Option F 列追加
- §5 Phase 1/2/3 acceptance に Option E `foreground_flash` 専用 criteria 統合
- §7 Open Questions に「Option F の opt-in design」「Phase 1.5 OLE IDataObject 評価」を新規追加
- §9 Decision History に v1.4 (Option E `foreground_flash` + Option F docs 追加 + Option D を laffo16 PR #20106 に訂正) 行追加

`CHANGELOG.md`:
- v1.5.0+: `method: 'foreground_flash'` 新 channel 追加 (WT BG injection 用、`background` 契約とは分離した妥協 path)
- breaking change: なし、既存 `method: 'background'` の WT 不対応は維持

`docs/operation-verification-matrix.md` §3.1 / §4.3:
- 新 `foreground_flash` channel 規範追加
- 新 typed reasons (Round 1 P1-3 で 7 → 8 種): `input_contains_newline` / `input_exceeds_paste_warning_threshold` / `foreground_steal_denied` / `focus_wait_timeout` / `clipboard_lock_contention` / `foreground_restore_failed` / `wt_paste_warning_intercepted` / `send_input_failed` 追加

**実装規模**: ~120 line docs

### 5.7 PR 構成

1 PR で全 phase 一括: ~830 line (production) + ~300 line (test) + ~120 line (docs) = 中規模 PR。

**review loop** (CLAUDE.md §3.3 復活):
- Opus phase-boundary review 1+ round (本 plan land 時 + production PR 時)
- Codex 必須 (production code 改修なので §3.3 Step 0 で Codex 必須分類)
- §3.1 (複数表 fact 整合) + §3.2 (carry-over scope shrink) sweep を Opus prompt に必ず組込み

---

## 6. Acceptance Criteria

### 6.1 Native layer (Phase 1)
- [ ] `foreground_flash_inject(hwnd, pid, text, options)` 成功時 `flash_duration_ms <= 80` (clipboard save + steal ladder + focus wait + SendInput + restore + clipboard restore 含む実測)
- [ ] foreground steal ladder の各段 (既存 + Alt unlock 新規) が試行され、失敗段の typed reason が hints に記録
- [ ] foreground 復帰失敗時に 2 回 retry + typed reason `foreground_restore_failed`
- [ ] **clipboard HGLOBAL format round-trip** (text / RTF / unicode 各 format で round-trip 成功、controlled fixture)
- [ ] **clipboard 非 HGLOBAL format** (画像) 検出 → save skip + skipped_formats に記録、restore で消える事実 observable
- [ ] **3 point sequence check** で race detection: flash 中の別 process `SetClipboardData` 後 `seq_before_restore != seq_after_inject_clipboard` を観測 → restore skip + `clipboardRestoreSkipped: true` hints
- [ ] **input 制限**: 改行含む input で `input_contains_newline` / 5KiB 超で `input_exceeds_paste_warning_threshold` (Round 1 P1-3 で typed reason 分離)
- [ ] **WT paste warning dialog scan** が enabled なら ContentDialog 検出 → Esc + `wt_paste_warning_intercepted`
- [ ] LowLevel keyboard hook lifecycle が leak-free (HookGuard Drop 検証)
- [ ] **HWND signature**: BigInt 経由で x64 64-bit hwnd 値が truncate されないこと
- [ ] **Hidden owner thread**: 専用 window class 登録 + message loop + clipboard ownership lifecycle leak-free (engine shutdown で thread join + window dispose)

### 6.2 production-like 実機検証 (Phase 2)
- [ ] Node.js MCP server 実機環境 (= caller が foreground 権を持たない typical condition) で foreground steal ladder の各段成否を 50 回連続計測
- [ ] 段 1 + 段 2 合計成功率 >= 80% (これ未満なら design review 必要、§5.3)
- [ ] ladder 段別の成功率を docs (本 plan or 別 docs) に記録 → R1 mitigation 評価根拠化

### 6.3 TS engine layer (Phase 3)
- [ ] `resolveBackgroundInputChannel(WT_HWND, {allowedChannels: ["wm_char"]})` が `{kind: "unsupported", reason: "wt_xaml_pipeline"}` (= 既存 `background` 契約維持)
- [ ] `resolveBackgroundInputChannel(WT_HWND, {allowedChannels: ["wm_char", "clipboard_flash"]})` が `{kind: "clipboard_flash", hwnd: <bigint>, pid: <number>, constraints: {...}}`
- [ ] `canInjectViaPostMessage(WT_HWND)` は touch されず、WT で `{supported: false, reason: "wt_xaml_pipeline"}` を返す (regression なし)
- [ ] `method: 'foreground_flash'` で WT inject success、`hints.backgroundChannel = "clipboard_flash"` + `hints.typingLeakRisk = true`
- [ ] `method: 'background'` で WT は引き続き unsupported (silent-success 構造的回避)
- [ ] caller migration 済 = 既存 `bg-input.ts` 内 caller が新 resolver 経由に揃う (二重分岐期間 ゼロ)

### 6.4 E2E (Phase 4)
- [ ] 新 `foreground-flash-verification.test.ts`: WT 100 連続 inject で flaky < 1%
- [ ] 既存 `keyboard-bg-verification.test.ts` の WT negative test は **変更なし** (= `method: 'background'` 契約維持)
- [ ] foreground lock simulation で `foreground_restore_failed` typed reason 観測
- [ ] clipboard race fixture で `clipboardRestoreSkipped: true` hints 観測
- [ ] input 6KiB ASCII で `input_exceeds_paste_warning_threshold` 観測 / 改行を含む text で `input_contains_newline` 観測 (Round 1 P1-3 で reason 分離)
- [ ] WT paste warning dialog fixture で `wt_paste_warning_intercepted` 観測
- [ ] 画像 clipboard 状態で flash → 画像が消える事実 + hints `clipboardRestoreSkippedFormats` 観測

### 6.5 ADR / docs (Phase 5)
- [ ] ADR-013 §3 に Option E (`foreground_flash`) + Option F (cooperative bridge) section 追加、§4 trade-off table、§5 acceptance、§7 OQ、§9 Decision History 全 sync
- [ ] `docs/operation-verification-matrix.md` §3.1 / §4.3 に `foreground_flash` channel + 全 typed reason 追加
- [ ] CHANGELOG.md に v1.5.0+: `method: 'foreground_flash'` + 既存 `background` 契約維持 narrative 記載

---

## 7. Risks

- **R1 — Foreground steal 成功率 (production-like)**: production の MCP server (Node.js child) が foreground 権を持たない条件で ladder 段 1 (既存 `restoreAndFocusWindow`) + 段 2 (Alt unlock) がどこまで成功するか不明。**Phase 2 = mandatory gate** で 50 連続実機計測、合計成功率 >= 80% 達成しなければ design review (LowLevel hook default ON / Option F 優先 / Option E ROI 悪い判定 等)
- **R2 — Clipboard race**: rigorous design (3 point sequence) で skip-or-restore は明確、ただし「user の copy 操作と完全並走」を完璧 handle はできない。skip + hints で observability + caller 側責任に委譲
- **R3 — WT paste warning dialog**: input 制限 (single-line + 5KiB) で trigger 確率は構造的にゼロ化、`largePasteWarning` の閾値変更や future WT update で trigger される risk は dialog scan で fail-safe
- **R4 — LowLevel hook overhead**: opt-in default OFF、UX 試して様子見。dogfood / GitHub issue / hints 集計で漏れ報告が来るなら default ON 切替検討
- **R5 — Microsoft 将来 mitigation**: 本 plan は Microsoft 意思整合 (公式 OS API のみ) だが、将来 WT 自体が `SetForegroundWindow` を XAML レベルで block する変更を入れる risk あり。中長期 monitoring で対応
- **R6 — `method: 'foreground_flash'` の caller 普及**: 既存 caller (LLM agent prompt) は `method: 'background'` を使う、明示的に `method: 'foreground_flash'` を選ぶには prompt 側の guidance 必要。production 化と同時に LLM agent guidance docs (`CLAUDE.md` の terminal usage section) を update する必要
- **R7 — 非 HGLOBAL format 復元不可**: MVP HGLOBAL 限定、画像 / メタファイル等が clipboard にあると flash 後に消える。dogfood で顕在化したら **Phase 1.5 OLE IDataObject snapshot** で別 PR 対応

---

## 8. Open Questions (本 plan v3 = user review v2 で resolved 化)

| # | OQ | user review 回答 (v3 で resolve) |
|---|---|---|
| 1 | m13v 取り違え | **Resolved**: `laffo16 PR #20106` に書き換え + m13v 氏は **issue comment の助言者として残す** (Option D 候補名から外す) |
| 2 | Phase 2.5 production-like 実機検証 | **Resolved**: **mandatory gate として挿入** (R1 mitigation、§5.3 Phase 2) |
| 3 | Keyboard block default | **Resolved**: default OFF + **dogfood / GitHub issue report / hints 集計** で flip 判断 (telemetry → dogfood に表現修正) |
| 4 | Paste warning dialog scan default | **Resolved**: default ON、ただし **本命は「単一行 + 5KiB 未満 + Enter 別送信」で warning 発生させない**、scan は保険 (§3.3.1-§3.3.3) |
| 5 | Hidden owner HWND lifecycle | **Resolved**: engine 起動時 lazy + shutdown dispose、**`STATIC` ではなく専用 window class + WndProc** + clipboard 操作 thread の **message loop** 必要 (§3.2.1) |
| 6 | Channel resolver migration | **Resolved**: **一気に移行** (`canInjectViaPostMessage` はそのまま残す、resolver 導入 PR 内で caller 全揃え、§4.3) |

### 8.1 残 OQ (本 plan v3 で新規)

7. **OLE IDataObject snapshot 採用判断 (Phase 1.5)**: HGLOBAL MVP の限界が dogfood でいつ顕在化するか? Phase 1.5 を本 plan PR と同 PR にするか別 PR か? 推奨: 別 PR (HGLOBAL MVP land 後の dogfood 結果次第で判断)

---

## 9. Option F (Cooperative in-pane bridge) — ADR §3.6 追加 outline (本 plan 外、別 PR で実装)

User 提案: 本物 BG を実現する **長期本命候補**。本 plan では ADR-013 §3.6 に概要のみ追加、本実装は別 PR / 別 plan で扱う。

### 9.1 仕組み

- ユーザーが明示的に DTM helper を WT 内で起動 (例: `wt -p PowerShell -- pwsh -Command "Import-Module DTM-Helper; Start-DTMBridge"`)
- helper が **named pipe** (`\\.\pipe\dtm-bridge-<nonce>`) を listen
- MCP 側が pipe 経由で command を渡す
- helper が pwsh 内部で command を実行、output を pipe で返す

### 9.2 利点

- WT 内表示は出る (helper が同 pwsh 内で実行)
- foreground を奪わない (本物 BG)
- WT private API / clipboard 触らない
- Authentication: nonce + `CurrentUserOnly` ACL で `microsoft/terminal#9368` 的な「任意 app が任意 WT に注入」問題なし
- Microsoft 意思整合 (named pipe は完全公式 API)
- 長期 stable (WT 更新 / CFG 強化に依存しない)

### 9.3 弱点 / 制約

- 「既存の任意 pane」ではなく **opt-in / managed session**
- helper を管理する仕組み: auto-start option / discoverability / version compat / helper 未起動時の fallback (= `method: 'foreground_flash'` に degrade?)

### 9.4 本 plan との position

- 本 plan = **短期 / 妥協**: Option E (`foreground_flash`) で `background` ではなく明示 opt-in channel として先行実装
- Option F = **長期本命**: 別 PR / 別 ADR で本実装、cooperative bridge protocol 設計 + helper 配布方式 + auto-discovery + nonce 管理 を含む大型 plan

ADR-013 §3.6 で Option F section を追加しておくことで、本 plan land 後に Option F 別 PR を起票する path を確保。

---

## 10. Roadmap (advisory)

| Phase | 期間 | 出力 | acceptance |
|---|---|---|---|
| 1. plan v3 land | 1 PR (本 plan) | `docs/adr-013-option-e-impl.md` (v3) | user 目視確認 + Opus 1+ round |
| 2. Phase 1 native | 5-7 日 | Rust impl (`foreground_flash` + `clipboard_snapshot` + `kbd_hook` + `wt_dialog_scan` + `alt_unlock`) + napi binding + unit test | §6.1 |
| 3. **Phase 2 prod-like 実機検証 (mandatory gate)** | 1-2 日 | Node.js MCP server で foreground_steal ladder 実機計測 + R1 mitigation 確認 + design review (必要なら) | §6.2 |
| 4. Phase 3 TS engine | 3-4 日 | `background-channel-resolver` + `bg-input.ts` 修正 + tools/keyboard・terminal 修正 + Zod schema | §6.3 |
| 5. Phase 4 E2E | 3-4 日 | tests/e2e/foreground-flash-verification.test.ts + 既存 keyboard-bg-verification 維持 | §6.4 |
| 6. Phase 5 docs | 1 日 | ADR-013 §3.5/§3.6/§4/§5/§7/§9 + matrix + CHANGELOG | §6.5 |
| 7. PR review loop | 3-7 日 | Opus 3+ round + Codex 必須 | review loop (CLAUDE.md §3.3) |
| 8. ADR-013 Status flip | 同 PR | `Status: Draft` → `Status: Accepted` (Option E 採用) | 本 PR closure |

合計: **3-4 週間** (中規模 production PR、CLAUDE.md §3.3 review loop 込み、Phase 2 mandatory gate 込み)

**Phase 1.5 (option、別 PR)**: OLE IDataObject snapshot — Phase 1 land 後の dogfood で「画像復元できない」report 集まったら起票 (推定 +1-2 週間)。

**Option F は別 PR / 別 plan で扱う** (本 roadmap 外)。

---

## 11. Decision History

| Date | Status | Author | Rationale |
|---|---|---|---|
| 2026-05-10 | Draft (v1) | Claude (Sonnet) | spike Round 2 完了後の本実装 plan 初版、Option E 採用 + mitigation 4 つ |
| 2026-05-10 | Draft (v2、user review apply、全面書き直し) | Claude (Sonnet) + user review v1 | P1×4 + P2×1 + 追加注意 2 件 + Option F 提案 を全面反映 |
| 2026-05-10 | Draft (v3、user review v2 apply、再書き直し) | Claude (Sonnet) + user review v2 | P1×3 (Single-line/Enter 矛盾 / sequence 比較 3 point / HGLOBAL MVP 限定) + P2×2 (TS hwnd bigint / file reference fix + Alt trick 新規明示) + OQ 6 件 user 推奨回答 resolve + OLE IDataObject Phase 1.5 提案 を全面反映 |
| (future) | user 確認 + Opus review apply | (TBD) | plan v3 land 確認 |
| (future) | ExitPlanMode + Phase 1 開始 | (TBD) | 実装 begin |

---

## 12. References

- ADR-013 (`docs/adr-013-wt-bg-input.md`)
- spike Round 2 findings: `docs/wt-bg-spike-round2-findings.md` (`spike/wt-attachconsole-input` branch)
- spike scripts: `scripts/spikes/wt-{attachconsole-helper,attachconsole-orchestrator,uia-inventory,clipboard-flash,clipboard-flash-typing-test}.ps1`
- PR #239 (Round 1 NO-GO `AttachConsole + WriteConsoleInputW`)
- issue #185 (Phase 4 stretch tracking、Round 2 報告 issuecomment-4414321413)
- microsoft/terminal#9368 (`wt send-input` Microsoft 公式 Reject)
- microsoft/terminal#20106 (laffo16 `wt send-input` 実装、close)
- Microsoft.Terminal.Control TermControl.idl: https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalControl/TermControl.idl
- Win32 `SetForegroundWindow`: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow
- Win32 `AllowSetForegroundWindow`: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-allowsetforegroundwindow
- Win32 `SendInput`: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput
- Win32 Clipboard formats: https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats
- Win32 `OleGetClipboard` / `OleSetClipboard`: https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-olegetclipboard
- WT interaction paste warnings: https://learn.microsoft.com/en-us/windows/terminal/customize-settings/interaction
- LowLevelKeyboardProc: https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc
- 既存 implementation `src/engine/win32.ts::restoreAndFocusWindow` (foreground steal ladder 段 1)
- memory: `feedback_clipboard_flash_design_pitfalls.md` (本 v3 書き直しの根拠 = User review v1 + v2)
