# ADR-007 P2 — Implementation Design Proposal (for Opus review)

- Status: **Approved by Opus 2026-04-29 (GO with changes、4 件の必須対応を本書 §11 に反映)**
- Date: 2026-04-29
- Author: Claude Sonnet (this session)
- Reviewer: Opus (CLAUDE.md 強制命令 3)
- Scope: GDI/DC + Monitor enumeration + DPI APIs (`PrintWindow` / `GetDC` / `ReleaseDC` / `CreateCompatibleDC` / `CreateCompatibleBitmap` / `SelectObject` / `DeleteObject` / `DeleteDC` / `GetDIBits` / `EnumDisplayMonitors` / `GetMonitorInfoW` / `MonitorFromWindow` / `GetDpiForMonitor` / `SetProcessDpiAwareness` = 14 koffi defs)

---

## 1. 設計方針サマリ

P1 と異なり「primitive 1:1 binding」一辺倒は**良くない**。GDI には `CreateCompatibleDC`/`DeleteDC`、`GetDC`/`ReleaseDC`、`CreateCompatibleBitmap`/`DeleteObject` の lifetime ペアがあり、JS 側で個別 binding を握ると **ハンドルリーク** + **失敗時のリソース不解放**が起きやすい。Monitor 列挙も `EnumDisplayMonitors` callback + per-monitor `GetMonitorInfoW` + `GetDpiForMonitor` の 3 ステップ複合操作。

そこで **hybrid** を採用:

| 層 | 戦略 | 理由 |
|---|---|---|
| **High-level**: `win32_print_window_to_buffer(hwnd, flags) -> NativePrintWindowResult` | 9 GDI 関数 + RAII + BGRA→RGBA 変換を 1 native call に集約 | 失敗時 RAII で確実にリソース解放、FFI hop も削減 |
| **High-level**: `win32_enum_monitors() -> Vec<NativeMonitorInfo>` | `EnumDisplayMonitors` callback + `GetMonitorInfoW` + `GetDpiForMonitor` を集約 | callback panic 安全 + 1 native call で全結果取得 |
| **Mid-level**: `win32_get_window_dpi(hwnd) -> u32` | `MonitorFromWindow` + `GetDpiForMonitor` を 1 関数に折り畳む | 常に paired で呼ばれる、別 export にする利益なし |
| **Primitive**: `win32_set_process_dpi_awareness(level) -> ()` | 単一 syscall、起動時 1 回のみ | 折り畳み余地なし |

**4 native export** で 14 koffi binding を置換。

P1 とは違い、TS 側の `printWindowToBuffer` / `enumMonitors` / `getWindowDpi` の **内部はほぼ消える** (1 行のネイティブ呼び出しになる)。**外側シグネチャは完全不変** (Tool Surface 不変原則 P7)。

---

## 2. 公開する 4 native 関数

### 2.1 `win32_print_window_to_buffer`

```rust
#[napi(object)]
pub struct NativePrintWindowResult {
    pub data: Buffer,        // RGBA8, top-down, length = w*h*4
    pub width: u32,
    pub height: u32,
}

#[napi]
pub fn win32_print_window_to_buffer(
    hwnd: BigInt,
    flags: u32,              // PrintWindow flags (0 / 2 / 3)
) -> napi::Result<NativePrintWindowResult>
```

内部:
1. `GetWindowRect(hwnd)` で width/height 取得 (失敗 = `Err`)
2. `GetDC(NULL)` でスクリーン DC 取得
3. `CreateCompatibleDC` + `CreateCompatibleBitmap` + `SelectObject`
4. `PrintWindow(hwnd, memDC, flags)`
5. `GetDIBits` でビット列を BGRA バッファにコピー
6. SIMD or scalar で BGRA → RGBA + alpha=255 設定
7. **RAII guard** が SelectObject 巻き戻し / DeleteObject / DeleteDC / ReleaseDC を保証 (panic / Err どちらでも漏れない)

エラー時は `napi::Error::from_reason("PrintWindow: <step> failed")` で typed reason を返す。

**TS 側の `printWindowToBuffer`** は次のようになる (75 行 → 5 行):

```typescript
export function printWindowToBuffer(hwnd: unknown, flags = 2): { data: Buffer; width: number; height: number } {
  if (typeof hwnd !== "bigint") throw new Error("printWindowToBuffer requires a bigint hwnd");
  const r = requireNativeWin32().win32PrintWindowToBuffer!(hwnd, flags);
  return { data: r.data, width: r.width, height: r.height };
}
```

### 2.2 `win32_enum_monitors`

```rust
#[napi(object)]
pub struct NativeMonitorInfo {
    pub handle: BigInt,        // HMONITOR (TS 側で `unknown` 扱いだったが BigInt で OK)
    pub primary: bool,
    pub bounds_left: i32,
    pub bounds_top: i32,
    pub bounds_right: i32,
    pub bounds_bottom: i32,
    pub work_left: i32,
    pub work_top: i32,
    pub work_right: i32,
    pub work_bottom: i32,
    pub dpi: u32,              // effective DPI X (Y は同値前提、TS 側既存挙動)
}

#[napi]
pub fn win32_enum_monitors() -> napi::Result<Vec<NativeMonitorInfo>>
```

内部: `EnumDisplayMonitors` callback で `Vec<NativeMonitorInfo>` を構築。callback ボディは `catch_unwind` で wrap (P1 の EnumWindows と同パターン、Windows ABI 越え panic を防ぐ)。各 monitor について `GetMonitorInfoW` + `GetDpiForMonitor(MDT_EFFECTIVE_DPI=0)` を呼んで埋める。

**TS 側の `enumMonitors`** は変換層のみ残す (~30 行 → 15 行):

```typescript
export function enumMonitors(): MonitorInfo[] {
  const raw = requireNativeWin32().win32EnumMonitors!();
  return raw.map((m, id) => ({
    id,
    handle: m.handle,                       // bigint (旧: unknown だったが互換)
    primary: m.primary,
    bounds: { x: m.boundsLeft, y: m.boundsTop, width: m.boundsRight - m.boundsLeft, height: m.boundsBottom - m.boundsTop },
    workArea: { x: m.workLeft, y: m.workTop, width: m.workRight - m.workLeft, height: m.workBottom - m.workTop },
    dpi: m.dpi || 96,
    scale: Math.round(((m.dpi || 96) / 96) * 100),
  }));
}
```

注意: 既存 `MonitorInfo.handle` は `unknown` 型なので `bigint` への変更は **拡大** であり破壊変更ではない (callers は handle を opaque に扱うのみ)。

### 2.3 `win32_get_window_dpi`

```rust
#[napi]
pub fn win32_get_window_dpi(hwnd: BigInt) -> napi::Result<u32>
```

内部: `MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST=2)` → `GetDpiForMonitor(MDT_EFFECTIVE_DPI=0)`。失敗時は 96 (= 100% baseline) を返す既存挙動を維持。

### 2.4 `win32_set_process_dpi_awareness`

```rust
#[napi]
pub fn win32_set_process_dpi_awareness(level: i32) -> napi::Result<bool>
```

内部: `SetProcessDpiAwareness(level)` を呼ぶだけ。戻り値は HRESULT が `S_OK` なら true / それ以外 false (既存 try/catch swallow と同等)。

TS 側 module init (line 276):

```typescript
try {
  requireNativeWin32().win32SetProcessDpiAwareness!(2); // PROCESS_PER_MONITOR_DPI_AWARE
} catch { /* already set or unsupported */ }
```

---

## 3. Rust 実装スケッチ

### 3.1 ファイル構成

```
src/win32/
├── mod.rs            # 既存 + gdi / monitor / dpi を追加
├── safety.rs         # napi_safe_call (既存、再利用)
├── types.rs          # 新規: NativePrintWindowResult, NativeMonitorInfo
├── window.rs         # P1 で実装済 (10 関数)
├── gdi.rs            # ★ 新規: print_window_to_buffer (RAII)
├── monitor.rs        # ★ 新規: enum_monitors (callback)
└── dpi.rs            # ★ 新規: get_window_dpi, set_process_dpi_awareness
```

### 3.2 `src/win32/gdi.rs` の核 (RAII 抜粋)

```rust
//! GDI helpers — `print_window_to_buffer` consolidates the 9-call sequence
//! (GetWindowRect → GetDC → CreateCompatibleDC → CreateCompatibleBitmap →
//! SelectObject → PrintWindow → GetDIBits → cleanup) into one safe entry
//! point. Every Win32 handle is owned by a small RAII guard so a `?` early
//! return cannot leak DCs / bitmaps even mid-failure.

use windows::Win32::Graphics::Gdi::{
    BITMAPINFOHEADER, BI_RGB, CreateCompatibleBitmap, CreateCompatibleDC,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDIBits, HBITMAP, HDC,
    HGDIOBJ, ReleaseDC, SelectObject,
};
use windows::Win32::UI::WindowsAndMessaging::{GetDC, PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::Foundation::{HWND, RECT};

struct DcGuard {
    target: HWND,        // None when this is a memory DC
    dc: HDC,
    is_mem: bool,
}
impl Drop for DcGuard {
    fn drop(&mut self) {
        unsafe {
            if self.is_mem { let _ = DeleteDC(self.dc); }
            else { ReleaseDC(Some(self.target), self.dc); }
        }
    }
}

struct BitmapGuard(HBITMAP);
impl Drop for BitmapGuard {
    fn drop(&mut self) { unsafe { let _ = DeleteObject(HGDIOBJ(self.0.0 as *mut _)); } }
}

struct SelectGuard {
    dc: HDC,
    old: HGDIOBJ,
}
impl Drop for SelectGuard {
    fn drop(&mut self) { unsafe { let _ = SelectObject(self.dc, self.old); } }
}
```

`print_window_to_buffer` の本体は `?` で early-return してもこれら guard が drop されて handle は確実に解放される。

BGRA → RGBA 変換は `chunks_exact_mut(4)` で write-back、SIMD は P5a 以降で検討 (P2 acceptance には scalar で十分高速)。

### 3.3 `src/win32/monitor.rs` の callback

P1 の `EnumWindows` callback と同パターン:

```rust
unsafe extern "system" fn enum_monitor_collect(
    hmonitor: HMONITOR,
    _hdc: HDC,
    _lprc: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let vec = unsafe { &mut *(lparam.0 as *mut Vec<NativeMonitorInfo>) };
        if let Some(info) = build_monitor_info(hmonitor) {
            vec.push(info);
        }
    }));
    if result.is_err() {
        super::safety::PANIC_COUNTER.fetch_add(1, Ordering::Relaxed);
        BOOL(0)  // stop enumeration
    } else {
        BOOL(1)
    }
}
```

`build_monitor_info` は `GetMonitorInfoW` + `GetDpiForMonitor` を呼んで `NativeMonitorInfo` を作る。失敗時 `None` を返して push せずスキップ (既存 TS 挙動と互換)。

---

## 4. Cargo features

`Cargo.toml` の `windows` features に追加:

```toml
"Win32_Graphics_Gdi",   # CreateCompatibleDC, GetDIBits, etc.
"Win32_UI_HiDpi",       # SetProcessDpiAwareness, GetDpiForMonitor, MONITOR_DEFAULTTONEAREST
```

`MonitorFromWindow` / `EnumDisplayMonitors` は `Win32_Graphics_Gdi` 配下、`GetDC` / `ReleaseDC` / `PrintWindow` は P1 で既に追加した `Win32_UI_WindowsAndMessaging` 配下。

---

## 5. TS 配線

### 5.1 index.d.ts に追加

```ts
export interface NativePrintWindowResult { data: Buffer; width: number; height: number }
export interface NativeMonitorInfo {
  handle: bigint
  primary: boolean
  boundsLeft: number; boundsTop: number; boundsRight: number; boundsBottom: number
  workLeft: number; workTop: number; workRight: number; workBottom: number
  dpi: number
}

export declare function win32PrintWindowToBuffer(hwnd: bigint, flags: number): NativePrintWindowResult
export declare function win32EnumMonitors(): NativeMonitorInfo[]
export declare function win32GetWindowDpi(hwnd: bigint): number
export declare function win32SetProcessDpiAwareness(level: number): boolean
```

### 5.2 NativeWin32 interface 拡張

`src/engine/native-engine.ts` の `NativeWin32` に 4 メソッド追加 (全部 optional)。

### 5.3 `src/engine/win32.ts` の差分

- 14 koffi 定義削除 (PrintWindow / GetDC / ReleaseDC / CreateCompatibleDC / CreateCompatibleBitmap / SelectObject / DeleteObject / DeleteDC / GetDIBits / MonitorEnumProcProto / EnumDisplayMonitors / GetMonitorInfoW / MonitorFromWindow / GetDpiForMonitor / SetProcessDpiAwareness)
- module-init `SetProcessDpiAwareness(2)` を `nativeWin32.win32SetProcessDpiAwareness!(2)` に
- `enumMonitors()` 内部: koffi.register callback + EnumDisplayMonitors → `nativeWin32.win32EnumMonitors!()` + `.map(...)` 変換層のみ
- `printWindowToBuffer()` 内部: 75 行の GDI dance → `nativeWin32.win32PrintWindowToBuffer!(hwnd, flags)` 1 行
- `getWindowDpi()` 内部: `nativeWin32.win32GetWindowDpi!(hwnd)`

`getVirtualScreen()` は内部で `enumMonitors()` を呼ぶだけなので無修正で動く。

### 5.4 互換テスト要点

- `printWindowToBuffer` 戻り値の `data` が RGBA で alpha=255、`width`/`height` が窓サイズ
- `enumMonitors` の `MonitorInfo.handle` 型を `bigint` に拡張するが、callers (`desktop-state.ts` / `dock.ts`) は handle を opaque に扱うのみで読み出さないので型互換 OK
- `getWindowDpi(null)` は P1 と同じく `if (typeof hwnd !== "bigint") return 96` の defensive guard を TS wrapper 側に追加

---

## 6. テスト

### 6.1 panic-fuzz 拡張 (`tests/unit/native-win32-panic-fuzz.test.ts`)

既存 27 cases に追加:

- `win32PrintWindowToBuffer(0n, 2)` / `(stale, 2)` / `(all-ones, 2)` — それぞれ throw or returns valid buffer (panic しない)
- `win32GetWindowDpi(0n)` / `(stale)` — 96 / 0 / 既存値が返る (panic しない)
- `win32SetProcessDpiAwareness(99)` (invalid level) — false が返る or throw、panic しない
- `win32EnumMonitors()` 連続 50 回呼び出し、RSS 50MB 以下

### 6.2 bench (`scripts/bench-print-window.mjs` 新規)

`printWindowToBuffer` 100 回実行、p50/p99 計測。P1 の `bench-enum-title.mjs` と同形式。 acceptance criterion:「screenshot/printWindow latency 計測」(ADR-007 §6 P2)。

---

## 7. リスク

| # | リスク | 軽減 |
|---|---|---|
| 1 | RAII guard の drop 順序ミス → 二重解放 | 各 guard は単一 handle 所有、drop 順序は LIFO で確定 |
| 2 | BGRA→RGBA 変換が SIMD なしで遅い | 1080p 想定で scalar でも < 5ms、後続 P5a で SIMD 検討 |
| 3 | EnumDisplayMonitors callback 内 panic | P1 EnumWindows と同パターンで catch_unwind |
| 4 | HMONITOR が P2 で `bigint` になることで MonitorInfo.handle 型変化 | callers は opaque、互換性なし問題なし |
| 5 | `GetDIBits` の bitfield calc 失敗 | top-down 32bpp BI_RGB は既存 TS で動作実績あり、shape 同じ |
| 6 | Cargo features 競合 | P1 で `Win32_UI_WindowsAndMessaging` 既存、`Win32_Graphics_Gdi` + `Win32_UI_HiDpi` 追加のみ |

---

## 8. Implementation Phases (commit 単位)

1. **commit 1**: Rust 基盤 (`src/win32/{gdi,monitor,dpi}.rs` + types.rs 追記 + mod.rs / lib.rs / Cargo.toml)
2. **commit 2**: TS 配線 (index.d.ts / index.js / native-types.ts / native-engine.ts / win32.ts)
3. **commit 3**: テスト + bench (panic-fuzz 拡張 + `bench-print-window.mjs`)

各 commit で `cargo check` + `npm run build` + `npm run check:napi-safe` + `npm run check:native-types` がグリーンであること。

---

## 9. Opus に判断委譲したい点

1. **§1 hybrid 採用**: 4 high-level/mid-level export で 14 koffi 置換、合理的か?
2. **§2.1 BGRA→RGBA 変換の Rust 実装位置**: native 内部 (本提案) vs TS 残置 — native 推奨だが、SIMD 入れない scalar 実装で latency SLO 守れるか?
3. **§2.2 NativeMonitorInfo の field flat化** (`boundsLeft/Top/Right/Bottom` vs nested struct): Rust → JS の cost / TS 側変換層の量で判断
4. **§4 Cargo features 追加内容**: `Win32_Graphics_Gdi` / `Win32_UI_HiDpi` で必要な API 全部カバーされるか
5. **§5.3 `MonitorInfo.handle` 型変更** (`unknown` → `bigint`): 互換 OK 判定で良いか
6. **§6.2 bench スコープ**: `printWindowToBuffer` のみで十分か、`enumMonitors` も計測対象に入れるべきか

---

## 11. Opus レビュー指摘 (2026-04-29、必須対応)

実装中に絶対に外さない 4 件 + 補助的な 5 件。

### 11.1 (核心) `MonitorInfo.handle` 型を `unknown` 据え置き
本書 §5 で「`bigint` に拡張」と書いていたが、Opus 指摘で **TS interface 宣言は `unknown` のまま据え置き**。実値は bigint で来るが、opaque 契約を保持することで将来 HMONITOR を struct 化したくなった時に互換破壊にならない。callers (`tools/desktop-state.ts` / `tools/dock.ts`) は `m.handle` を読み出さないので OK。

### 11.2 `SelectGuard.old` を `Option<HGDIOBJ>` に
`SelectObject` 失敗 (NULL 戻り) 時に Drop で NULL を SelectObject に巻き戻すのを防ぐ:

```rust
struct SelectGuard {
    dc: HDC,
    old: Option<HGDIOBJ>,
}
impl Drop for SelectGuard {
    fn drop(&mut self) {
        if let Some(old) = self.old.take() {
            unsafe { let _ = SelectObject(self.dc, old); }
        }
    }
}
```

`SelectObject` の戻り値が `HGDIOBJ(NULL)` の時は `old = None` で構築する。

### 11.3 `SetProcessDpiAwareness` の `E_ACCESSDENIED` を成功扱い
旧 TS 実装は `try { SetProcessDpiAwareness(2) } catch {}` で全エラーを swallow していた。新実装でも「既に他 API で設定済み」(`E_ACCESSDENIED`) は成功扱い:

```rust
let result = unsafe { SetProcessDpiAwareness(PROCESS_DPI_AWARENESS(level)) };
// S_OK = 0, E_ACCESSDENIED は既に設定済みなので success 扱い (TS 旧挙動互換)
Ok(result.is_ok() || result == E_ACCESSDENIED)
```

### 11.4 cargo features 確認 (Opus Q4)
本書 §4 の features 名は正しいが、commit 1 で `cargo build` を通す前に **`cargo doc --features '...' --open`** で各 API のドキュメント道筋を一度確認する (P1 で `MonitorFromWindow` を `Win32_UI_HiDpi` 配下と誤記した過去事故あり)。

### 11.5 GDI guard drop 順序のコメント明示
`gdi.rs` 冒頭に Win32 作法と LIFO drop 順序の対応を明記:

```rust
//! drop order is LIFO; select must unwind before bitmap is destroyed,
//! bitmap before its memory DC, memory DC before its source screen DC.
//! Therefore the let order in `print_window_to_buffer` is:
//!   screenDC → memDC → bitmap → select_guard
```

### 11.6 panic-fuzz は P1 と粒度を揃える
本書 §6.1 で「`win32EnumMonitors()` 連続 50 回 / RSS 50MB」と書いていたが、P1 の `bench-enum-title.mjs` は 1000 iter / RSS 50MB だった。**panic-fuzz suite の RSS 検査は 100 回呼び出し / 増分 5MB 以下** に揃える (回帰検出力を上げる)。

### 11.7 bench 2 サイズ実測
`scripts/bench-print-window.mjs` は **1080p デスクトップサイズと 4K の 2 ケース** で p50/p99/RSS を計測。ADR-007 §6 P2 acceptance「latency 計測」のエビデンスとして PR description に数字を貼る。

### 11.8 `MonitorEnumProcProto` の koffi.proto 削除漏れ
`enumMonitors` 削除時、`MonitorEnumProcProto` の `koffi.proto` 行 (line 137) も削除すること。残すと next reload で「proto already exists」が出る可能性。

### 11.9 4K 計測の取り扱い
4K capture latency は `printWindowToBuffer` の単独計測のみで OK。実機 (テストマシン) が 4K display を持っていない場合は `printWindowToBuffer` を裏で 3840x2160 dummy hwnd で叩く形ではなく、**現環境の最大 monitor を使って計測**、`bench-print-window.mjs` 出力にその実 size を表示する。

---

## 12. やらないリスト (scope creep 防止)

| やらない | 理由 |
|---|---|
| Toolhelp32 / Process / SetWindowPos / AttachThreadInput | P3 |
| sensors-win32.ts の koffi 撤去 | P4 |
| koffi npm package 削除 | P4 |
| L1 Capture コア新設 | P5a-d |
| napi_safe_call 既存 sync export 拡大 | P5a |
| GDI 操作の SIMD 化 | 必要なら P5a 以降 |
| MonitorInfo schema の互換破壊 (id/scale 等のリネーム) | 不要 |
| `SetProcessDpiAwareness` を `SetProcessDpiAwarenessContext` (Win10 1703+) に upgrade | P3 / 別 ADR |
| `printWindowToBuffer` 戻り値に metadata (timestamp / monitor id) 追加 | L1 Capture (P5a) |
| `NativeMonitorInfo` に `device_name` (MONITORINFOEX) 追加 | 必要時に追加 PR |

---

END OF P2 DESIGN PROPOSAL
