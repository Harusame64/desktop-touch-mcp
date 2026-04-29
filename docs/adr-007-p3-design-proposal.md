# ADR-007 P3 — Implementation Design Proposal (for Opus review)

- Status: **Approved by Opus 2026-04-29 (GO with changes、6 件の必須対応を本書 §12 に反映)**
- Date: 2026-04-29
- Author: Claude Sonnet (this session)
- Reviewer: Opus (CLAUDE.md 強制命令 3)
- Scope: Process/Thread + Input — 14 koffi defs across `src/engine/win32.ts`:
  `ShowWindow / SetForegroundWindow / SetWindowPos / BringWindowToTop / AttachThreadInput / GetCurrentThreadId / OpenProcess / GetProcessTimes / QueryFullProcessImageNameW / CreateToolhelp32Snapshot / Process32FirstW / Process32NextW / CloseHandle / GetScrollInfo / PostMessageW / GetFocus / MapVirtualKeyW`
  (15 primitives — `CloseHandle` is shared between OpenProcess and Toolhelp32 paths, but maps to a single binding in TS.)

---

## 1. 設計方針サマリ

P1 (primitive 1:1) と P2 (hybrid) のハイブリッド戦略を継承:

| 戦略 | 対象 | 理由 |
|---|---|---|
| **Hybrid (Rust 内 orchestration)** | 4 関数: process tree walk, process identity, force-focus, focused-child query | RAII で handle / AttachThreadInput pair を必ず解放、JS 側の解放責任を消す |
| **Specialized primitive** | 2 関数: `setWindowTopmost(hwnd, on: bool)`, `setWindowBounds(hwnd, x, y, w, h)` | SetWindowPos の `hwndInsertAfter` sentinel (-1 / -2) と flag bit field の誤用を排除 |
| **Plain primitive** | 6 関数: ShowWindow, SetForegroundWindow, GetScrollInfo, PostMessageW, GetFocus, MapVirtualKeyW | 軽量 1 次関数、orchestration 不要 |

合計 **12 native export** で 15 koffi 関数を置換。

### 1.1 各 native export 一覧

| # | Rust (snake_case) | 戦略 | 旧 koffi 関数群 | 旧 TS wrapper |
|---|---|---|---|---|
| 1 | `win32_show_window` | primitive | ShowWindow | `restoreAndFocusWindow` 内部 |
| 2 | `win32_set_foreground_window` | primitive | SetForegroundWindow | `restoreAndFocusWindow` 内部 (non-force path) |
| 3 | `win32_set_window_topmost` | specialized | SetWindowPos (HWND_TOPMOST/HWND_NOTOPMOST) | `setWindowTopmost`, `clearWindowTopmost` |
| 4 | `win32_set_window_bounds` | specialized | SetWindowPos (NULL ZORDER) | `setWindowBounds` |
| 5 | `win32_force_set_foreground_window` | hybrid | SetForegroundWindow + BringWindowToTop + AttachThreadInput pair | `forceSetForegroundWindow` |
| 6 | `win32_get_focused_child_hwnd` | hybrid | GetWindowThreadProcessId (P1) + GetCurrentThreadId + AttachThreadInput pair + GetFocus | `getFocusedChildHwnd` |
| 7 | `win32_build_process_parent_map` | hybrid | CreateToolhelp32Snapshot + Process32FirstW + Process32NextW + CloseHandle | `buildProcessParentMap` |
| 8 | `win32_get_process_identity` | hybrid | OpenProcess + GetProcessTimes + QueryFullProcessImageNameW + CloseHandle | `getProcessIdentityByPid` |
| 9 | `win32_get_scroll_info` | primitive | GetScrollInfo | `readScrollInfo` |
| 10 | `win32_post_message` | primitive | PostMessageW | `postMessageToHwnd` |
| 11 | `win32_get_focus` | primitive | GetFocus | `getFocusedChildHwnd` 内部 (same-thread path) |
| 12 | `win32_vk_to_scan_code` | primitive | MapVirtualKeyW | `vkToScanCode` |

`GetCurrentThreadId` / `BringWindowToTop` / `CloseHandle` / `Process32FirstW` / `Process32NextW` / `OpenProcess` / `GetProcessTimes` / `QueryFullProcessImageNameW` / `CreateToolhelp32Snapshot` は **standalone exports を作らず、hybrid 内に閉じ込め**。

---

## 2. ★Hybrid 4 関数の詳細

### 2.1 `win32_force_set_foreground_window`

```rust
#[napi(object)]
pub struct NativeForceFocusResult {
    pub ok: bool,
    pub attached: bool,
    pub fg_before: BigInt,
    pub fg_after: BigInt,
}

#[napi]
pub fn win32_force_set_foreground_window(hwnd: BigInt) -> napi::Result<NativeForceFocusResult>
```

内部:
1. `GetForegroundWindow()` → `fg_before`
2. 既に foreground なら early return `{ ok: true, attached: false, ... }`
3. `GetWindowThreadProcessId(fg_before)` → `fgThread`
4. `GetCurrentThreadId()` → `myThread`
5. `AttachThreadInput(myThread, fgThread, true)` if threads differ
6. `SetForegroundWindow(hwnd)` + `BringWindowToTop(hwnd)`
7. **RAII guard で AttachThreadInput(false) を Drop で必ず実行**
8. `GetForegroundWindow()` → `fg_after`、ok = (fg_after == hwnd)

### 2.2 `win32_get_focused_child_hwnd`

```rust
#[napi]
pub fn win32_get_focused_child_hwnd(target_hwnd: BigInt) -> napi::Result<Option<BigInt>>
```

内部:
1. `GetWindowThreadProcessId(target_hwnd)` → `target_thread`
2. `GetCurrentThreadId()` → `my_thread`
3. 同一 thread なら直接 `GetFocus()`
4. 別 thread なら `AttachThreadInput(my_thread, target_thread, true)` → `GetFocus()` → **RAII で detach**

### 2.3 `win32_build_process_parent_map`

```rust
#[napi(object)]
pub struct NativeProcessParentEntry {
    pub pid: u32,
    pub parent_pid: u32,
}

#[napi]
pub fn win32_build_process_parent_map() -> napi::Result<Vec<NativeProcessParentEntry>>
```

内部:
1. `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)` → snapshot handle
2. **RAII guard for snapshot** (CloseHandle on drop)
3. `Process32FirstW` + loop `Process32NextW`
4. 各 entry を `(pid, parent_pid)` として Vec に push

TS 側は Map<number, number> へ変換する薄い wrapper で受ける (callers は Map を期待)。

### 2.4 `win32_get_process_identity`

```rust
#[napi(object)]
pub struct NativeProcessIdentity {
    pub pid: u32,
    pub process_name: String,
    pub process_start_time_ms: f64,  // i64 を Number で渡す (~50bit 精度で十分)
}

#[napi]
pub fn win32_get_process_identity(pid: u32) -> napi::Result<NativeProcessIdentity>
```

内部:
1. `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)` → handle
2. **RAII guard for handle** (CloseHandle on drop)
3. `QueryFullProcessImageNameW` → process_name (basename without .exe)
4. `GetProcessTimes` → creation FILETIME → i64 ticks → ms

失敗時は `NativeProcessIdentity { pid, process_name: "", process_start_time_ms: 0.0 }` を返す (旧 koffi 挙動互換)。

---

## 3. Specialized primitive 2 関数

### 3.1 `win32_set_window_topmost`

```rust
#[napi]
pub fn win32_set_window_topmost(hwnd: BigInt, topmost: bool) -> napi::Result<bool>
```

内部: `SetWindowPos(hwnd, if topmost { HWND_TOPMOST=-1 } else { HWND_NOTOPMOST=-2 }, 0,0,0,0, SWP_NOMOVE | SWP_NOSIZE)`

### 3.2 `win32_set_window_bounds`

```rust
#[napi]
pub fn win32_set_window_bounds(hwnd: BigInt, x: i32, y: i32, w: i32, h: i32) -> napi::Result<bool>
```

内部: `SetWindowPos(hwnd, NULL, x, y, w, h, SWP_NOZORDER)`

旧 koffi では `intptr hWndInsertAfter` で -1/-2 を渡していた (sign bug の温床)。新 API は sentinel を Rust 内に閉じ込める。

---

## 4. Plain primitive 6 関数

```rust
#[napi] pub fn win32_show_window(hwnd: BigInt, n_cmd_show: i32) -> napi::Result<bool>;
#[napi] pub fn win32_set_foreground_window(hwnd: BigInt) -> napi::Result<bool>;
#[napi] pub fn win32_get_scroll_info(hwnd: BigInt, axis: String) -> napi::Result<Option<NativeScrollInfo>>;
#[napi] pub fn win32_post_message(hwnd: BigInt, msg: u32, w_param: BigInt, l_param: BigInt) -> napi::Result<bool>;
#[napi] pub fn win32_get_focus() -> napi::Result<Option<BigInt>>;
#[napi] pub fn win32_vk_to_scan_code(vk: u32) -> napi::Result<u32>;
```

```rust
#[napi(object)]
pub struct NativeScrollInfo {
    pub n_min: i32,
    pub n_max: i32,
    pub n_page: u32,
    pub n_pos: i32,
    pub page_ratio: f64,  // 0..1, 旧 TS 実装が caller に提供していた
}
```

`axis: String` で `"vertical"` / `"horizontal"` を受ける (旧 TS API と同じ)。Rust 内で `SB_VERT=1` / `SB_HORZ=0` に変換。

---

## 5. Cargo features 追加

windows-rs 0.62 で必要な features:

```toml
"Win32_System_Threading",            # OpenProcess, GetCurrentThreadId, GetProcessTimes, PROCESS_QUERY_LIMITED_INFORMATION
"Win32_System_ProcessStatus",        # QueryFullProcessImageNameW (実は別 module の可能性、要確認)
"Win32_System_Diagnostics_ToolHelp", # CreateToolhelp32Snapshot, Process32FirstW/NextW, PROCESSENTRY32W
"Win32_UI_Input_KeyboardAndMouse",   # AttachThreadInput, MapVirtualKeyW (実は WindowsAndMessaging かも、要確認)
```

`SetWindowPos` / `BringWindowToTop` / `ShowWindow` / `SetForegroundWindow` / `GetFocus` / `PostMessageW` / `GetScrollInfo` は P1 で追加済の `Win32_UI_WindowsAndMessaging` 配下。

実装着手時に `cargo doc --features ...` で各 API 解決を確認 (P2 と同じ手順、Opus pre-review §11.4 の習慣)。

---

## 6. TS 配線

### 6.1 index.d.ts / index.js / native-types.ts / native-engine.ts

3 つの新 struct:
- `NativeForceFocusResult { ok, attached, fgBefore, fgAfter }`
- `NativeProcessParentEntry { pid, parentPid }`
- `NativeProcessIdentity { pid, processName, processStartTimeMs }`
- `NativeScrollInfo { nMin, nMax, nPage, nPos, pageRatio }`

12 declare/export entries 追加。

### 6.2 src/engine/win32.ts の変化

| TS wrapper | 旧 (koffi) | 新 (P3 native) |
|---|---|---|
| `restoreAndFocusWindow` | ShowWindow + (forceFocus or SetForegroundWindow) + win32GetWindowRect | win32ShowWindow + (win32ForceSetForegroundWindow or win32SetForegroundWindow) + win32GetWindowRect |
| `forceSetForegroundWindow` | 30 行 koffi orchestration | `nativeWin32.win32ForceSetForegroundWindow(hwnd)` 1 行 + shape 整形 |
| `setWindowTopmost` / `clearWindowTopmost` | SetWindowPos(HWND_TOPMOST/HWND_NOTOPMOST,...) | `win32SetWindowTopmost(hwnd, true/false)` |
| `setWindowBounds` | SetWindowPos(0, ...) | `win32SetWindowBounds(hwnd, x, y, w, h)` |
| `getProcessIdentityByPid` | 30 行 OpenProcess + GetProcessTimes + QueryFullProcessImageNameW orchestration | `win32GetProcessIdentity(pid)` + 整形 |
| `buildProcessParentMap` | 25 行 Toolhelp32 walk | `win32BuildProcessParentMap()` + Map 変換 |
| `readScrollInfo` | GetScrollInfo + struct decode | `win32GetScrollInfo(hwnd, axis)` |
| `postMessageToHwnd` | PostMessageW | `win32PostMessage(hwnd, msg, wp, lp)` |
| `getFocusedChildHwnd` | 25 行 GetCurrentThreadId + AttachThreadInput pair + GetFocus | `win32GetFocusedChildHwnd(targetHwnd)` 1 行 |
| `vkToScanCode` | MapVirtualKeyW | `win32VkToScanCode(vk)` |

外側シグネチャ完全不変 (Tool Surface 不変原則 P7)。

### 6.3 残置する koffi defs (P4 へ持ち越し)

- `GetWindowHwnd` (`GetWindow` API) — `getWindowOwner` で使用
- `GetAncestor` — `getWindowRootOwner` で使用
- `IsWindowEnabled` — `isWindowEnabled` で使用
- `GetLastActivePopup` — `getLastActivePopup` で使用
- `_DwmGetWindowAttribute` (+ `_dwmapi` ロード) — `isWindowCloaked` で使用

これら 5 関数は ADR-007 §6 P3 リスト外の小ユーティリティで、`enumWindowsInZOrder` (P1 で wrapper を再書き込み済) の内部からも利用される。**P4 の "koffi 完全撤去" で一括移行** する方が clean。本 PR で触らない。

---

## 7. テスト

### 7.1 panic-fuzz 拡張 (`tests/unit/native-win32-panic-fuzz.test.ts`)

12 関数 × 不正引数の 30+ cases を追加:

- `win32ShowWindow(0n, SW_RESTORE)` — false 戻り
- `win32SetForegroundWindow(0n)` — false
- `win32SetWindowTopmost(0n, true/false)` — false
- `win32SetWindowBounds(0n, 0, 0, 100, 100)` — false
- `win32ForceSetForegroundWindow(0n)` — `{ok: false, attached: false, ...}` (panic しない)
- `win32GetFocusedChildHwnd(0n)` — null
- `win32BuildProcessParentMap()` 100 回連続 + RSS < 5MB
- `win32GetProcessIdentity(99999999)` (存在しない PID) — `{pid:99999999, processName:"", processStartTimeMs:0}` (panic しない)
- `win32GetProcessIdentity(0)` — 空 identity
- `win32GetScrollInfo(0n, "vertical")` — null
- `win32PostMessage(0n, 0, 0n, 0n)` — false
- `win32VkToScanCode(0xFFFF)` — 0 (invalid VK)
- HWND BigInt round-trip テスト (P1 と同様、合成 high-bit hwnd)

### 7.2 ADR-007 §6 P3 acceptance: sizeof gauntlet

ADR-007 §6 P3 の acceptance「sizeof 地雷 0 件達成 (gauntlet test)」を満たす:
- `win32BuildProcessParentMap()` を 1000 回連続実行 (旧 koffi で `PROCESSENTRY32W.dwSize` ハードコード事故が起きていた箇所)
- 戻り値の pid/parent_pid フィールドが期待される shape か検証 (entry が空でない、System pid 4 が含まれる等)
- 同様に `win32GetProcessIdentity` を 100 PID で実行、空文字や不正値が返らないこと

windows-rs `repr(C)` struct は Rust が sizeof を保証するので、原理的に sizeof 地雷は 0 件。Gauntlet test はその実装を **CI で証拠化** する。

### 7.3 bench (任意)

P3 acceptance には latency 計測項目はないが、軽い regression guard として:
- `bench-process-tree.mjs` 新規 — `win32BuildProcessParentMap()` 100 回 / p99 計測

---

## 8. 実装順序 (commit 単位)

1. **commit 1**: Rust 基盤 (`src/win32/{process,input,scroll,window_op}.rs` + types.rs 追記 + mod.rs / Cargo.toml)
2. **commit 2**: TS 配線 (index.d.ts / index.js / native-types.ts / native-engine.ts / win32.ts)
3. **commit 3**: テスト + (任意) bench

各 commit で `cargo check` + `npm run build` + `npm run lint` + `npm run check:napi-safe` + `npm run check:native-types` がグリーンであること (P2 で lint regression を CI で踏んだ反省)。

---

## 9. リスク

| # | リスク | 軽減 |
|---|---|---|
| 1 | AttachThreadInput pair の片方落ち (attach なのに detach 漏れ / 逆) | RAII guard `AttachGuard { attached: bool }`、Drop で attached=true なら detach |
| 2 | `SetWindowPos` の sentinel 整数化漏れ (HWND_TOPMOST = -1) | specialized API で sentinel を Rust 内に閉じ込め、JS から渡す概念ごと排除 |
| 3 | OpenProcess handle leak | `ProcessHandleGuard(HANDLE)` で Drop CloseHandle |
| 4 | Toolhelp32 snapshot leak | `SnapshotHandleGuard(HANDLE)` で Drop CloseHandle |
| 5 | FILETIME → ms 変換の i64 / f64 精度 | i64 ticks (100ns 単位) を 10000 で割って ms、f64 でも 280 万年分の精度 |
| 6 | `windows::Win32::System::ProcessStatus::QueryFullProcessImageNameW` の実 module 位置 | `cargo doc` で確認、実装着手時に補正 |
| 7 | TS 側 `getProcessIdentityByPid` の `unknown` パラメータ互換 | P1 と同パターンで `if (typeof pid !== "number") return ...` defensive guard |
| 8 | `restoreAndFocusWindow` の opts.force 分岐維持 | TS 側で force=true なら `win32ForceSetForegroundWindow`、それ以外 `win32SetForegroundWindow` の単純分岐で OK |

---

## 10. やらないリスト (scope creep 防止)

| やらない | 理由 |
|---|---|
| `GetWindowHwnd` / `GetAncestor` / `IsWindowEnabled` / `GetLastActivePopup` / `DwmGetWindowAttribute` 移行 | ADR-007 §6 P3 list 外の小ユーティリティ、P4 で一括 |
| `sensors-win32.ts` koffi 撤去 | P4 |
| `koffi` npm package 削除 | P4 (まだ user32/kernel32 koffi.load + 上記 5 utility が残る) |
| `_dwmapi` koffi.load 削除 | P4 (DwmGetWindowAttribute と運命を共にする) |
| `SendInput` / `SetCursorPos` / mouse_event の native 化 | nut-js 経由で動いている、scope 外 |
| `napi_safe_call` 既存 sync export 拡大 | P5a |
| L1 Capture コア新設 | P5a-d |

---

## 11. Opus に判断委譲したい点

1. **§1 hybrid 4 / specialized 2 / primitive 6 の分類は妥当か?** とくに `SetForegroundWindow` を hybrid `force` の中に閉じ込めずに standalone primitive として残すのは過剰か?
2. **§2.4 `process_start_time_ms: f64`** で良いか? i64 BigInt の方が future-proof か? (旧 TS は `number` として返していたので f64 互換は OK だが)
3. **§3 specialized API の名前**: `win32_set_window_topmost(hwnd, topmost: bool)` か `win32_set_window_topmost(hwnd)` + `win32_clear_window_topmost(hwnd)` の 2 関数か? bool 引数が読みにくければ後者
4. **§5 Cargo features**: `Win32_System_ProcessStatus` / `Win32_UI_Input_KeyboardAndMouse` の正確な features 名 — 実装着手時の `cargo doc` 確認で詰める前提で OK か?
5. **§7.2 gauntlet test** は本 PR scope か? それとも別 PR (P4 直前の "全 koffi sizeof 検証" として)?
6. **§10 やらないリスト 5 utility 持ち越し** で OK か? それとも P3 で fold して P4 を「sensors + koffi npm 撤去」に絞る方が良いか?

---

## 12. Opus レビュー指摘 (2026-04-29、必須対応)

実装中に絶対に外さない 6 件 + 補助的な 4 件。

### 12.1 (核心) specialized SetWindowPos API は 2 関数に分割
本書 §3.1 で「`win32_set_window_topmost(hwnd, topmost: bool)`」と書いていたが、Opus 指摘で **2 関数分割**:

```rust
#[napi] pub fn win32_set_window_topmost(hwnd: BigInt) -> napi::Result<bool>;
#[napi] pub fn win32_clear_window_topmost(hwnd: BigInt) -> napi::Result<bool>;
```

理由: 既存 TS wrapper も `setWindowTopmost` / `clearWindowTopmost` の 2 関数 + windows-rs idiom も `Set*` / `Clear*` 対が一般的 + bool 引数より直接的。

### 12.2 partial success の挙動明記 (§2.4 修正)
`win32_get_process_identity` の失敗時挙動を Opus 指摘で具体化:

- **完全失敗** (OpenProcess NULL handle): `{pid, processName: "", processStartTimeMs: 0.0}`
- **partial success** (image 取れたが creation 取れない): `{pid, processName: "powershell", processStartTimeMs: 0.0}` (取れた分だけ埋める、旧 TS 互換)
- **partial success** (image 取れず creation 取れた): `{pid, processName: "", processStartTimeMs: 1.234e15}`

旧 TS は `try { image; } catch {} try { creation; } catch {}` で順次取得していた。Rust 側も image / creation の各 step を独立 fallible として、片方の失敗を partial success として返す。

### 12.3 `forceSetForegroundWindow` field 名 snake_case 維持
本書 §2.1 で `NativeForceFocusResult { fg_before, fg_after }` (Rust snake_case) と書いた。napi-rs は JS export 時に camelCase 変換 (`fgBefore` / `fgAfter`)。**TS wrapper 側で snake_case に詰め直す**:

```typescript
export function forceSetForegroundWindow(hwnd: unknown) {
  const r = nativeWin32.win32ForceSetForegroundWindow!(hwnd as bigint);
  return {
    ok: r.ok,
    attached: r.attached,
    fg_before: r.fgBefore,  // snake_case 維持で旧 TS API 互換
    fg_after: r.fgAfter,
  };
}
```

旧 TS API 互換 (`fg_before` / `fg_after`) を変えると Tool Surface 不変原則 P7 違反になる。

### 12.4 リスク 5 の数値訂正
本書 §9 リスク 5「f64 でも 280 万年分の精度」は誤り。正しくは **「f64 整数精度で約 28 万年分の ms」** (Number.MAX_SAFE_INTEGER ≈ 2^53 ms ≈ 285,616 年)。Windows epoch (1601) からの ms は 2026 時点で約 13.4 兆 ≈ 2^43.6、53bit に余裕で収まるので f64 で OK。

### 12.5 ADR-007 §6 P4 行に「`git grep koffi` 行数 0」追加
P3 で 5 utility (`GetWindowHwnd` / `GetAncestor` / `IsWindowEnabled` / `GetLastActivePopup` / `DwmGetWindowAttribute`) を持ち越す代わりに、ADR-007 §6 の P4 行 acceptance に **`git grep "koffi\\."` 行数 0** を明記。本 PR で **同梱コミット** として ADR を更新する。

### 12.6 Cargo features の確定 (実装着手時)
本書 §5 の features を以下に修正 (Opus 指摘 + 実装着手時の cargo doc 確認):

| feature | 含まれる API |
|---|---|
| `Win32_System_Threading` | `OpenProcess` / `GetProcessTimes` / `QueryFullProcessImageNameW` (※ `ProcessStatus` ではない) / `GetCurrentThreadId` |
| `Win32_System_Diagnostics_ToolHelp` | `CreateToolhelp32Snapshot` / `Process32FirstW` / `Process32NextW` / `PROCESSENTRY32W` |
| `Win32_UI_Input_KeyboardAndMouse` | `AttachThreadInput` / `MapVirtualKeyW` |
| `Win32_UI_WindowsAndMessaging` (P1 既存) | `ShowWindow` / `SetForegroundWindow` / `SetWindowPos` / `BringWindowToTop` / `PostMessageW` / `GetFocus` / `GetScrollInfo` / `HWND_TOPMOST` / `HWND_NOTOPMOST` / `SWP_*` |
| `Win32_Foundation` (P1 既存) | `HANDLE` / `CloseHandle` / `INVALID_HANDLE_VALUE` |

**commit 1 の最初の `cargo check` でエラー出させて補正する**運用 (P2 PrintWindow が `Win32_Storage_Xps` 配下だった前例あり)。

---

## 13. 実装中に確認する補助項目 (Opus 補助観点)

### 13.1 AttachGuard の Drop ロジック
- `attach=false` (失敗時) は Drop で何もしない (旧 TS の "best-effort" を踏襲)
- detach 自体の失敗もログだけ吐いて握り潰す、catch_unwind 不要
- `napi_safe_call` の外側に AttachGuard を配置 (let-binding 順 = drop LIFO 順)

### 13.2 Toolhelp32 INVALID_HANDLE_VALUE
windows-rs `HANDLE` の `is_invalid()` メソッドを使う。旧 TS の `INVALID_HANDLE_VALUE_BIG = 0xffffffffffffffffn` 比較は不要 — sizeof 地雷消滅の副次効果。

### 13.3 PostMessageW wParam/lParam 型
`BigInt` で受ける (本書 §4 の通り)。32bit に収まる現用途より future-proof で WM_KEYDOWN/UP の lParam パターンも保つ。

### 13.4 panic-fuzz の HWND BigInt round-trip
`tests/unit/native-win32-panic-fuzz.test.ts` に既存 test 有り (P1 で書いた)、**重複追加禁止**。本 PR の panic-fuzz 拡張は P3 の 12 関数分のみに限定。

### 13.5 `getProcessIdentityByPid` の defensive guard
本書 §9 リスク 7 を具体化: **`if (typeof pid !== "number") return { pid: 0, processName: "", processStartTimeMs: 0 }`**。P1 の hwnd 系 (BigInt 期待) と pid 系 (number 期待) で内容が違う点に注意。

### 13.6 やらないリスト追加
- `_dwmapi` koffi.load 自体は P4 (`isWindowCloaked` が残置されるため P3 で消せない)
- `forceSetForegroundWindow` field の camelCase 化 (P7 違反)
- `restoreAndFocusWindow` の force 分岐簡略化
- `enumWindowsInZOrder` 内部 koffi の単発移行 (P4 一括)
- `bench-process-tree.mjs` の p99 SLO 設定 (regression guard のみ、SLO は P5a 以降)
- native error → `_errors.ts` SUGGESTS 経路 (ADR-010 P5a)
- `napi_safe_call` を P3 関数以上に拡大 (P5a)

---

END OF P3 DESIGN PROPOSAL
