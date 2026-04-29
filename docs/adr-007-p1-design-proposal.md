# ADR-007 P1 — Implementation Design Proposal (for Opus review)

- Status: **Approved by Opus 2026-04-29 (GO with changes、7 件の必須対応を本書 §10 に反映)**
- Date: 2026-04-29
- Author: Claude Sonnet (this session)
- Reviewer: Opus (CLAUDE.md 強制命令 3)
- Scope: Hot-path window APIs migration (10 functions: EnumWindows / GetWindowTextW / GetWindowRect / GetForegroundWindow / IsWindowVisible / IsIconic / IsZoomed / GetClassNameW / GetWindowThreadProcessId / GetWindowLongPtrW)

---

## 1. 設計方針サマリ

| 観点 | 決定 |
|---|---|
| TS API 互換 | `enumWindowsInZOrder` 等 **TS wrapper の外側シグネチャ完全不変**。`win32.ts` 内部で 10 koffi 定義 → `nativeEngine.xxx()` に置換のみ |
| 新 napi 公開関数の数 | 10 (1:1 対応、各 koffi binding に対応する prim) |
| Sync vs AsyncTask | **全部 sync** (μs オーダーの軽量 Win32 call、libuv main thread から直接呼んで OK) |
| Thread | dedicated thread 不要 (`HWND` は thread-safe、`EnumWindows` の callback も同期で完了) |
| HWND 表現 | JS 側 `bigint` (既存通り)、napi-rs `BigInt`、Rust 内部 `isize` → `windows::Win32::Foundation::HWND` |
| Panic containment | `napi_safe_call` ヘルパー関数 (proc_macro は §4 で議論、Opus 判断委譲) |
| index.d.ts / index.js | **手動メンテ** (build:rs が auto-generated を破棄)。10 export 分を追記 |
| Linux 動作 | `#[cfg(windows)]` で win32 module を gate、Linux build では native 関数自体が export されないので TS 側で `if (nativeEngine?.xxx)` 確認、未実装なら throw (既存パターン) |

---

## 2. 公開する 10 native 関数 (sync `#[napi]`)

Rust 名 (snake_case) → JS 名 (camelCase auto-derived by napi-rs):

| # | Rust 名 | 引数 | 戻り値 | 備考 |
|---|---|---|---|---|
| 1 | `win32_enum_top_level_windows` | (なし) | `Vec<BigInt>` (HWND 配列、`EnumWindows` 列挙順) | EnumWindows callback を Rust 内部で完結、JS callback round-trip 排除 |
| 2 | `win32_get_window_text` | `hwnd: BigInt` | `String` (失敗・空タイトル時は `""`) | 既存挙動互換 (失敗を空文字に丸める) |
| 3 | `win32_get_window_rect` | `hwnd: BigInt` | `Option<NativeWin32Rect>` (`{ left, top, right, bottom }`、null = 失敗) | TS 側 wrapper でさらに `{ x, y, width, height }` に変換 |
| 4 | `win32_get_foreground_window` | (なし) | `Option<BigInt>` (null = 0 / 失敗) | `getForegroundHwnd()` 互換 |
| 5 | `win32_is_window_visible` | `hwnd: BigInt` | `bool` | 失敗時 `false` |
| 6 | `win32_is_iconic` | `hwnd: BigInt` | `bool` | 失敗時 `false` |
| 7 | `win32_is_zoomed` | `hwnd: BigInt` | `bool` | 失敗時 `false` |
| 8 | `win32_get_class_name` | `hwnd: BigInt` | `String` | 失敗時 `""` |
| 9 | `win32_get_window_thread_process_id` | `hwnd: BigInt` | `NativeThreadProcessId` (`{ threadId: u32, processId: u32 }`) | 既存 koffi では out-pointer / 戻り値 (thread id) の 2 つに分かれていたが、struct 1 つに統合 |
| 10 | `win32_get_window_long_ptr_w` | `hwnd: BigInt`, `nIndex: i32` | `i64` (LONG_PTR、JS 側で `Number()` 化) | 64-bit LONG_PTR を正しく返す (現行 koffi は `long`=32bit で truncate 気味) |

prefix `win32_` は既存 `uia_*` / `vision_*` と並ぶ命名規則 (lib.rs ファミリ単位)。

### 2.1 napi 互換 struct (新規追加)

```rust
// src/win32/types.rs
#[napi(object)]
pub struct NativeWin32Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[napi(object)]
pub struct NativeThreadProcessId {
    pub thread_id: u32,
    pub process_id: u32,
}
```

`x/y/width/height` への変換は **TS 側 wrapper** (`getWindowRectByHwnd`) でやる (既存の責務分担を維持)。

### 2.2 index.d.ts への手動追記分

```ts
export interface NativeWin32Rect { left: number; top: number; right: number; bottom: number }
export interface NativeThreadProcessId { threadId: number; processId: number }

export declare function win32EnumTopLevelWindows(): bigint[]
export declare function win32GetWindowText(hwnd: bigint): string
export declare function win32GetWindowRect(hwnd: bigint): NativeWin32Rect | null
export declare function win32GetForegroundWindow(): bigint | null
export declare function win32IsWindowVisible(hwnd: bigint): boolean
export declare function win32IsIconic(hwnd: bigint): boolean
export declare function win32IsZoomed(hwnd: bigint): boolean
export declare function win32GetClassName(hwnd: bigint): string
export declare function win32GetWindowThreadProcessId(hwnd: bigint): NativeThreadProcessId
export declare function win32GetWindowLongPtrW(hwnd: bigint, nIndex: number): bigint
```

`win32GetWindowLongPtrW` の戻り値は `bigint` にして、TS 側で `Number(x) | 0` で i32 に切り出す。LONG_PTR 全幅を保ったまま境界で型変換させる方が安全。

### 2.3 index.js への手動追記分

10 個の `export const win32XXX = nativeBinding.win32XXX;` 行を追加。

---

## 3. Rust 実装スケッチ

### 3.1 ファイル構成

```
src/
├── lib.rs              # win32 mod 追加 + 10 #[napi] export
├── win32/              # 新設
│   ├── mod.rs
│   ├── types.rs        # NativeWin32Rect / NativeThreadProcessId
│   ├── window.rs       # 10 関数の実装
│   └── safety.rs       # napi_safe_call helper
└── ...
```

### 3.2 `src/win32/safety.rs` (panic containment)

```rust
//! Panic containment helpers (ADR-007 §3.4).
//!
//! Sync `#[napi]` exports MUST wrap their bodies in `napi_safe_call` so panics
//! never reach the libuv main thread (which would crash the Node process).
//! The atomic counter is exposed for `server_status.panic_rate_per_min`
//! monitoring (統合書 §17.6).

use std::panic::{catch_unwind, UnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};

pub static PANIC_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn napi_safe_call<T, F>(name: &'static str, f: F) -> napi::Result<T>
where
    F: FnOnce() -> napi::Result<T> + UnwindSafe,
{
    match catch_unwind(f) {
        Ok(r) => r,
        Err(payload) => {
            PANIC_COUNTER.fetch_add(1, Ordering::Relaxed);
            let detail = if let Some(s) = payload.downcast_ref::<&'static str>() {
                (*s).to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "<non-string panic payload>".to_string()
            };
            Err(napi::Error::from_reason(format!(
                "panic in {name}: {detail}"
            )))
        }
    }
}
```

**Counter の export**: P5a で `server_status` に組み込まれるまで読み出し API は不要。本 PR ではシンボルのみ用意。

### 3.3 `src/win32/window.rs` 抜粋

```rust
use napi::bindgen_prelude::*;
use napi_derive::napi;
use windows::Win32::Foundation::{HWND, LPARAM, BOOL, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, GetWindowTextLengthW, GetWindowRect,
    GetForegroundWindow, IsWindowVisible, IsIconic, IsZoomed,
    GetClassNameW, GetWindowThreadProcessId, GetWindowLongPtrW,
};

use super::safety::napi_safe_call;
use super::types::{NativeWin32Rect, NativeThreadProcessId};

// ── Helpers ──────────────────────────────────────────────────────────────

fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u128();
    HWND(val as isize as *mut std::ffi::c_void)
}

fn hwnd_to_bigint(h: HWND) -> BigInt {
    BigInt::from(h.0 as i64)  // BigInt::from(i64) signed
}

// ── 1. EnumWindows ───────────────────────────────────────────────────────

unsafe extern "system" fn enum_windows_collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let vec = unsafe { &mut *(lparam.0 as *mut Vec<isize>) };
    vec.push(hwnd.0 as isize);
    BOOL(1)  // TRUE = continue enumeration
}

#[napi]
pub fn win32_enum_top_level_windows() -> napi::Result<Vec<BigInt>> {
    napi_safe_call("win32_enum_top_level_windows", || {
        let mut hwnds: Vec<isize> = Vec::with_capacity(256);
        let lparam = LPARAM(&mut hwnds as *mut _ as isize);
        unsafe {
            EnumWindows(Some(enum_windows_collect), lparam)
                .map_err(|e| napi::Error::from_reason(format!("EnumWindows failed: {e}")))?;
        }
        Ok(hwnds.into_iter().map(|h| BigInt::from(h as i64)).collect())
    })
}

// ── 2. GetWindowTextW ────────────────────────────────────────────────────

#[napi]
pub fn win32_get_window_text(hwnd: BigInt) -> napi::Result<String> {
    napi_safe_call("win32_get_window_text", || {
        let h = hwnd_from_bigint(hwnd);
        unsafe {
            // 既存 koffi 互換: 512 wchar buffer 固定
            let mut buf = [0u16; 512];
            let len = GetWindowTextW(h, &mut buf);
            if len <= 0 {
                return Ok(String::new());
            }
            Ok(String::from_utf16_lossy(&buf[..len as usize]))
        }
    })
}

// ── 3. GetWindowRect ─────────────────────────────────────────────────────

#[napi]
pub fn win32_get_window_rect(hwnd: BigInt) -> napi::Result<Option<NativeWin32Rect>> {
    napi_safe_call("win32_get_window_rect", || {
        let h = hwnd_from_bigint(hwnd);
        let mut rect = RECT::default();
        unsafe {
            if GetWindowRect(h, &mut rect).is_err() {
                return Ok(None);
            }
        }
        Ok(Some(NativeWin32Rect {
            left: rect.left, top: rect.top,
            right: rect.right, bottom: rect.bottom,
        }))
    })
}

// ── 4-7: GetForegroundWindow / IsWindowVisible / IsIconic / IsZoomed ─────
// (素直な薄い wrapper、bool 失敗時 false)

#[napi]
pub fn win32_get_foreground_window() -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_get_foreground_window", || {
        let h = unsafe { GetForegroundWindow() };
        Ok(if h.0.is_null() { None } else { Some(hwnd_to_bigint(h)) })
    })
}

#[napi]
pub fn win32_is_window_visible(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_is_window_visible", || {
        Ok(unsafe { IsWindowVisible(hwnd_from_bigint(hwnd)).as_bool() })
    })
}

// (IsIconic / IsZoomed も同じパターン、省略)

// ── 8. GetClassNameW ─────────────────────────────────────────────────────

#[napi]
pub fn win32_get_class_name(hwnd: BigInt) -> napi::Result<String> {
    napi_safe_call("win32_get_class_name", || {
        let h = hwnd_from_bigint(hwnd);
        let mut buf = [0u16; 256];  // 既存 koffi 互換
        let len = unsafe { GetClassNameW(h, &mut buf) };
        if len <= 0 { return Ok(String::new()); }
        Ok(String::from_utf16_lossy(&buf[..len as usize]))
    })
}

// ── 9. GetWindowThreadProcessId ──────────────────────────────────────────

#[napi]
pub fn win32_get_window_thread_process_id(hwnd: BigInt) -> napi::Result<NativeThreadProcessId> {
    napi_safe_call("win32_get_window_thread_process_id", || {
        let h = hwnd_from_bigint(hwnd);
        let mut pid: u32 = 0;
        let tid = unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
        Ok(NativeThreadProcessId { thread_id: tid, process_id: pid })
    })
}

// ── 10. GetWindowLongPtrW ────────────────────────────────────────────────

#[napi]
pub fn win32_get_window_long_ptr_w(hwnd: BigInt, n_index: i32) -> napi::Result<BigInt> {
    napi_safe_call("win32_get_window_long_ptr_w", || {
        let h = hwnd_from_bigint(hwnd);
        let v = unsafe { GetWindowLongPtrW(h, windows::Win32::UI::WindowsAndMessaging::WINDOW_LONG_PTR_INDEX(n_index)) };
        Ok(BigInt::from(v as i64))
    })
}
```

### 3.4 lib.rs の差分

```rust
#[cfg(windows)]
mod win32;
```

10 napi 関数は `win32::window::*` 内の `#[napi]` で直接 export されるので lib.rs に再 export 不要 (napi-rs はモジュール深さに依存しない)。

### 3.5 Cargo.toml への feature 追加

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.62", features = [
    # 既存 features ...
    "Win32_UI_WindowsAndMessaging",  # 追加: EnumWindows, GetWindowTextW, etc.
] }
```

(既に他 features があるので features 配列に append のみ)

---

## 4. `#[napi_safe]` proc_macro vs ヘルパー関数 — Opus 判断仰ぐ

### 4.1 オプション A: ヘルパー関数 `napi_safe_call`（本提案の推奨）

- **Pros**: workspace 構成変更不要、proc_macro crate 追加不要、build/CI 既存パイプライン無傷、実装 30 行で済む
- **Cons**: 各 `#[napi]` 関数が手動で `napi_safe_call("name", || { ... })` を呼ぶ必要、**忘却防止は CI script** に頼る (`scripts/check-napi-safe.mjs` で grep 検査)

### 4.2 オプション B: `#[napi_safe]` proc_macro

- **Pros**: 構文上、適用漏れが目視で明確 (`#[napi_safe]` の有無で判別)、clippy ベースの deny ルール書きやすい
- **Cons**: 既存 root crate (cdylib) に proc_macro を含められない → **workspace 化必須**、proc_macro クレート追加 (build.rs / GH Actions release.yml への波及あり)、本 PR scope 拡大 (P1 acceptance criteria を超える可能性)

### 4.3 推奨

**P1 では オプション A**、**P5a (L1 Capture コア新設) で proc_macro 化を再評価**。

理由:
- ADR-007 §3.4 の Acceptance Criteria は「panic-fuzz CI でプロセス全滅 0 件」+「shutdown 完了 3s 以内」+「auto-restart 1s 以内」。**実装手段** (proc_macro vs helper) は規定していない
- P5a で `EventEnvelope` schema + ring buffer + WAL を入れる時、相当数の新規 `#[napi]` export が出る → そのタイミングで workspace 化 + proc_macro が自然
- P1 で workspace 化すると build.rs / release.yml / launcher zip 構成への波及範囲が広がる。**ADR-007 §6.1 の "P1-P4 は各 Phase を 1 PR で main 入れる (互換維持で段階導入)"** に反する

clippy lint の代替として、本 PR では `scripts/check-napi-safe.mjs` を CI に追加 (オプション A 採用時):
- 全 `*.rs` をスキャンして `#[napi]\s*\npub fn` (sync 形) が `napi_safe_call` を含まない場合 fail
- AsyncTask 形 (`-> AsyncTask<...>`) は除外
- 既存 UIA / vision 系の AsyncTask 形は無視 (P5a で個別評価)

---

## 5. 各層責務マトリクス変更点 (layer-constraints §2 への影響なし確認)

| 観点 | 本 PR での扱い |
|---|---|
| 入力契約 | 既存 koffi の入力と同一 (HWND を JS 側で BigInt として持つ、native 側で `isize` に変換) |
| 出力契約 | 既存と shape 同一、`getWindowRectByHwnd` 等の TS wrapper は変わらない |
| 不変条件 | §2.3 の #6 「hw failure は EventKind として emit、panic しない」を `napi_safe_call` で満たす |
| 性能 | enum+title 1000 回 latency 半減目標 (ADR-007 §6 P1 acceptance、bench は §6 で別途) |
| 失敗モード | UIA timeout 等は本 PR scope 外。本 PR は Win32 同期 API のみ |
| 境界 | L1 Capture 内の "primitive Win32 binding 提供" 範疇、計算しない、state 持たない |

**Tool Surface 不変原則 (P7)**: 本 PR は Rust 側に 10 関数を追加するが、**LLM 露出 tool は 1 つも変えない**。`enum_top_level_windows` は MCP tool ではなく、TS 側 wrapper 関数 (`enumWindowsInZOrder`) からのみ呼ばれる。

---

## 6. テスト計画

### 6.1 Unit (vitest)
既存の `tests/unit/win32-*.test.ts` (もしあれば) を pass させる。新規 unit test は薄く: 各 native 関数が以下を満たすか:
- 不正 HWND (`0n`、`9999999n`) で **panic しない**、Option None / 空文字 / false を返す
- 正常 HWND (テストプロセス自体の foreground window) で正しい値を返す

### 6.2 E2E
既存 e2e (`focus-integrity.test.ts` / `dock-window.test.ts` など `enumWindowsInZOrder` 経由) で **回帰 0 件**。`npm run test:capture > .vitest-out.txt` で 1 回取得して確認。

### 6.3 Panic-Fuzz (新規)
`tests/unit/native-panic-fuzz.test.ts` (新規):
- `win32GetWindowText(0n)` (null hwnd) — プロセス生存確認
- `win32GetWindowRect(99999999999n)` (大きすぎる hwnd) — プロセス生存確認
- `win32EnumTopLevelWindows()` を 100 回連続呼び出し — メモリリーク・panic 0 件

### 6.4 Bench (任意、ADR-007 §6 P1 acceptance)
`benches/win32_enum_title.rs` (新規、cargo bench):
- `EnumWindows + GetWindowText` を 1000 回実行
- koffi 版との比較は本 PR の post-merge bench で別途 (ベースライン採取のみ本 PR スコープ)

---

## 7. 実装順序 (commit 粒度)

1. **commit 1**: `src/win32/mod.rs` + `safety.rs` + `types.rs` (Rust 基盤)
2. **commit 2**: `src/win32/window.rs` 10 関数実装、Cargo.toml に `Win32_UI_WindowsAndMessaging` feature 追加、lib.rs に `mod win32` 追加
3. **commit 3**: `index.d.ts` / `index.js` / `src/engine/native-types.ts` / `src/engine/native-engine.ts` に native API 追加
4. **commit 4**: `src/engine/win32.ts` の 10 koffi 定義を `nativeEngine.xxx()` 経由に置換、TS wrapper シグネチャは不変
5. **commit 5**: `tests/unit/native-panic-fuzz.test.ts` 新規 + `scripts/check-napi-safe.mjs` 新規 + CI ワークフロー追加
6. **commit 6**: (任意) `benches/win32_enum_title.rs` ベースライン

各 commit で `npm run build:rs` + `npm test` が通ること。

---

## 8. リスク

| # | リスク | 軽減 |
|---|---|---|
| 1 | `index.d.ts` / `index.js` 手動更新の誤り | commit 3 後に `npm run build` + `npm test` で TS 型チェック |
| 2 | HWND BigInt 変換の精度 | i64 で受け渡し、`isize` に as cast、Win64 で十分。Win32 ビルドは launcher 外 |
| 3 | windows-rs API breaking change (`HWND` 型変更等) | `0.62.x` に pin (Cargo.toml 既存ピンに準拠) |
| 4 | EnumWindows コールバックの ABI | `unsafe extern "system" fn` で macOS / Linux クロスコンパイルできず → `#[cfg(windows)]` で gate (既存 UIA と同じパターン) |
| 5 | `GetWindowLongPtrW` の n_index 値 (`GWL_EXSTYLE = -20`) を i32 で渡す際の sign | windows-rs は `WINDOW_LONG_PTR_INDEX(i32)` newtype を受け取る、ABI 上 sign 付き int で OK |
| 6 | koffi の暗黙型変換 (`as bigint`、`as number`) と native の挙動差 | 既存 TS wrapper のキャスト箇所を 1 個ずつ確認、変換場所を TS 側に集約 |

---

## 10. Opus レビュー指摘 (2026-04-29、必須対応)

7 件、実装中に絶対に外さないこと。

### 10.1 (核心) HWND BigInt 符号 bug 修正

提案 §3.3 の `hwnd_from_bigint` は `get_u128()` を使っているが、これは **意図不明瞭**。napi-rs の `BigInt::get_u64()` で受けて `as isize` でビット列保存に修正:

```rust
fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (val_u64, _lossless) = b.get_u64();
    HWND(val_u64 as isize as *mut std::ffi::c_void)
}
```

`get_u64()` が安定 API か `get_i64()` を使うかは napi-rs 2.x の現行実装に従う。**roundtrip test 必須**:
- 合成 hwnd `0xFFFF_8000_0000_0000n` を JS → Rust → JS と渡して bit-for-bit 一致 (panic 発生しないことも確認)

### 10.2 EnumWindows コールバックの panic safety 強化

提案 §3.3 の `enum_windows_collect` callback は `Vec::push` の alloc panic 可能性に備え、callback ボディを `catch_unwind(AssertUnwindSafe(|| ...))` で wrap、panic 時は `BOOL(0)` で打ち切り:

```rust
unsafe extern "system" fn enum_windows_collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let vec = unsafe { &mut *(lparam.0 as *mut Vec<isize>) };
        vec.push(hwnd.0 as isize);
    }));
    if result.is_err() {
        super::safety::PANIC_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        BOOL(0)  // stop enumeration
    } else {
        BOOL(1)  // continue
    }
}
```

**理由**: Rust runtime が Windows ABI callback 境界を越えて unwind すると UB。

### 10.3 `forceSetForegroundWindow` / `getWindowProcessId` / `getFocusedChildHwnd` の TS 側 3 箇所すべて置換

`win32.ts:535, 583, 997` で `GetWindowThreadProcessId(hwnd, null|[pidOut])` が使われている。新 native 関数は **常に `{ threadId, processId }` を返す**ので、TS wrapper 側で `.threadId` / `.processId` のみ取り出す形に置換:

```typescript
// 旧
const fgThread = (GetWindowThreadProcessId(fg_before as unknown as bigint, null) as number) >>> 0;
// 新
const fgThread = nativeEngine.win32GetWindowThreadProcessId(fg_before).threadId >>> 0;
```

3 箇所すべて漏れなく置換すること。

### 10.4 panic-fuzz scope 明確化

ADR-007 §3.4.3 の 4 acceptance criteria のうち、本 PR で達成するのは **「panic-fuzz CI でプロセス全滅 0 件」のみ**。残り 3 件 (auto-restart 1s / shutdown 3s / clippy deny) は **P5a follow-up** と PR 説明に明記。

panic-fuzz テスト最小内容:
- 不正 HWND (`0n`、`9999999n`、`0xFFFF_FFFF_FFFF_FFFFn`) × 10 関数 = 30 ケースで Node プロセス生存
- `win32EnumTopLevelWindows()` 100 回連続 + RSS 50MB 増えたら fail
- HWND BigInt roundtrip テスト (§10.1)

### 10.5 `index.d.ts` drift 検出 CI を追加

現行 `build:rs` は `napi build` 後の auto-generated `index.d.ts` を `git restore` で破棄。**手動 d.ts と Rust `#[napi]` 定義のずれが TS コンパイル時に検出されない**。本 PR で 10 関数追加するタイミングで仕組み化:

`scripts/check-native-types.mjs` (新規):
- `napi build` を実行 → auto-generated `index.d.ts` を `/tmp/auto-index.d.ts` に保存
- 現行手動 `index.d.ts` から `export declare function` 行を抽出
- auto vs manual の `function` セットを diff、新規 export が手動側に無ければ fail

`package.json` scripts に `check:native-types` 追加、CI workflow から呼ぶ。

### 10.6 bench は本 PR 内に含める

ADR-007 §6 P1 acceptance「enum+title 1000 回 latency 半減」の根拠を PR 内で示す。`benches/win32_enum_title.rs` (Rust cargo bench) で:
- `win32_enum_top_level_windows() + win32_get_window_text()` を 1000 回ループ
- p50 / p99 を計測、ベースラインを PR 説明に記載

(koffi vs windows-rs の比較値は P4 (koffi 完全撤去時) で再採取、本 PR では windows-rs 単独の数字のみで OK)

### 10.7 scope creep 防止 (やらないリスト)

| やらない | 理由 |
|---|---|
| 既存 `compute_change_fraction` / `dhash_from_raw` / `hamming_distance` を `napi_safe_call` でラップ | scope 外、P5a で proc_macro 化時に一括 |
| workspace 化 + `#[napi_safe]` proc_macro crate 追加 | build.rs / release.yml / launcher zip に波及 |
| `koffi` を `package.json` から削除 | P4 の仕事 |
| `sensors-win32.ts` の koffi 撤去 | P4 の仕事 |
| `PrintWindow` / GDI 系 / Toolhelp32 / SetWindowPos / AttachThreadInput の Rust 化 | P2 / P3 |
| L1 Capture コア (EventEnvelope / ring buffer / WAL) | P5a-d |
| `GetWindowLongPtrW` を BigInt 化 | 互換維持優先、将来必要時に別 PR |
| `win32_*` namespace 化 (napi 2.x) | flat snake_case prefix で統一 |

---

## 11. Opus に判断委譲したい点 (元の設計提案、§10 で全件解消済み)

1. **§4 napi_safe 実装方式**: ヘルパー関数 (オプション A) vs proc_macro (オプション B)。本提案は A 推奨だが Opus が ADR-007 §3.4 を厳密解釈する場合 B
2. **§2 native 関数命名**: `win32_xxx` prefix vs `nativeWin32.xxx` ネームスペース化 (`#[napi(namespace = "win32")]`) — napi-rs サポート確認次第
3. **§7 commit 分割**: 4 commit 1 PR 構成で OK か、それとも sub-PR 化すべきか
4. **§6.4 bench**: P1 PR 内に bench 入れるか別 PR か
5. **`win32_get_window_long_ptr_w` の戻り値**: BigInt vs i32 (LONG_PTR は 64-bit だが現行 koffi は 32-bit truncate)

---

END OF DESIGN PROPOSAL
