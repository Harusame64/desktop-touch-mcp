# ADR-007 P4 — Implementation Design Proposal (for Opus review)

- Status: **Approved by Opus 2026-04-29 (GO with minor changes、3 件の必須対応 + 6 件の補助確認を本書 §11 に反映)**
- Date: 2026-04-29
- Author: Claude Sonnet (this session)
- Reviewer: Opus (CLAUDE.md 強制命令 3)
- Scope: ADR-007 のフィナーレ。koffi 完全撤去。
  - 5 utility koffi.func: `GetWindow` / `GetAncestor` / `IsWindowEnabled` / `GetLastActivePopup` / `DwmGetWindowAttribute`
  - 2 koffi.load: `user32.dll` / `dwmapi.dll`
  - 1 koffi import: `import koffi from "koffi"` in `src/engine/win32.ts`
  - `enumWindowsInZOrder` 内部 3 koffi 呼び出し (`GetWindowHwnd(GW_OWNER)` / `IsWindowEnabled` / `_DwmGetWindowAttribute`)
  - `tests/unit/force-focus.test.ts` の `vi.mock("koffi", ...)` dead mock
  - `package.json` の `koffi: "^2.9.0"` devDependency

---

## 1. 設計方針サマリ

P3 までで koffi binding の大半 (45+) を撤去済。P4 は最後の 5 utility を片付けて **`git grep "koffi\\." == 0`** を達成、ADR-007 §6 P4 acceptance を satisfy する。

| 戦略 | 対象 | 理由 |
|---|---|---|
| **Plain primitive 5** | GetWindow / GetAncestor / IsWindowEnabled / GetLastActivePopup / DwmGetWindowAttribute | hybrid 化の利益なし (lifetime ペアなし、orchestration なし、単発 query のみ) |

P3 の hybrid (`AttachGuard` / RAII) は handle 寿命管理のため必要だったが、P4 の 5 utility はすべて handle を握らない単純関数。primitive 1:1 が最適。

合計 **5 native export** で 5 koffi 関数 + 2 dll load + 1 import を撤去。

### 1.1 各 native export 一覧

| # | Rust (snake_case) | 用途 | 旧 koffi | 旧 TS wrapper |
|---|---|---|---|---|
| 1 | `win32_get_window` | `GetWindow(hwnd, uCmd)` 任意 uCmd (GW_OWNER=4 etc.) | `GetWindowHwnd` | `getWindowOwner` + `enumWindowsInZOrder` 内部 |
| 2 | `win32_get_ancestor` | `GetAncestor(hwnd, gaFlags)` 任意 gaFlags (GA_ROOTOWNER=3 etc.) | `GetAncestor` | `getWindowRootOwner` |
| 3 | `win32_is_window_enabled` | `IsWindowEnabled(hwnd)` | `IsWindowEnabled` | `isWindowEnabled` + `enumWindowsInZOrder` 内部 |
| 4 | `win32_get_last_active_popup` | `GetLastActivePopup(hwnd)` | `GetLastActivePopup` | `getLastActivePopup` |
| 5 | `win32_is_window_cloaked` | `DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ...)` を **specialized** で 1 関数 | `_DwmGetWindowAttribute` | `isWindowCloaked` + `enumWindowsInZOrder` 内部 |

### 1.2 specialized DwmGetWindowAttribute の決定理由

`DwmGetWindowAttribute` は generic な属性 query API (DWMWA_NCRENDERING_ENABLED / DWMWA_CAPTION_BUTTON_BOUNDS / 等 ~30 種類) だが、本 codebase では **DWMWA_CLOAKED (= 14) のみ** 使用。generic primitive を expose して JS 側で uCmd 分岐を再現するより、specialized `win32_is_window_cloaked(hwnd) -> bool` の方が:
- 戻り値の型が明確 (bool vs Buffer/u32/whatever)
- DWMWA_CLOAKED の意味的シノニム (= "cloaked = boolean") を Rust 内に閉じ込め
- JS 側の uCmd 値覚え書きや buffer 切り出しコードが消える

generic API へのアクセスが将来必要になれば、その時に追加 export する (YAGNI)。

---

## 2. Rust 実装スケッチ

### 2.1 ファイル構成

```
src/win32/
├── mod.rs            # dwm モジュール追加
├── safety.rs         # 既存 napi_safe_call 再利用
├── types.rs          # 新 struct なし
├── window.rs         # P1
├── gdi.rs            # P2
├── monitor.rs        # P2
├── dpi.rs            # P2
├── process.rs        # P3
├── input.rs          # P3
├── window_op.rs      # P3
├── scroll.rs         # P3
└── dwm.rs            # ★ P4 新規 (5 utility)
```

新 struct なし — 5 関数すべて primitive スカラー戻り。

### 2.2 `src/win32/dwm.rs`

```rust
//! Owner-chain / ancestor / enabled / DWM-cloaked utility primitives
//! (ADR-007 P4 — final koffi removal).
//!
//! These were the last five koffi.func bindings in src/engine/win32.ts;
//! migrating them retires both `user32` and `dwmapi` koffi loads, the
//! `koffi` npm package itself, and unblocks ADR-007 §6 P4's acceptance
//! criterion `git grep "koffi\\." == 0`.

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetLastActivePopup, GetWindow, IsWindowEnabled,
    GET_ANCESTOR_FLAGS, GET_WINDOW_CMD,
};

use super::safety::napi_safe_call;

fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u64();
    HWND(val as isize as *mut std::ffi::c_void)
}

fn hwnd_to_optional_bigint(h: HWND) -> Option<BigInt> {
    if h.0.is_null() {
        None
    } else {
        Some(BigInt::from(h.0 as usize as u64))
    }
}

/// `GetWindow(hwnd, uCmd)` — owner / next / previous / etc. lookup.
/// Returns `None` for unowned / nonexistent results.
#[napi]
pub fn win32_get_window(hwnd: BigInt, u_cmd: u32) -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_get_window", || {
        let h = hwnd_from_bigint(hwnd);
        // GET_WINDOW_CMD is a u32 newtype; pass uCmd unchanged.
        let result = unsafe { GetWindow(h, GET_WINDOW_CMD(u_cmd)) };
        Ok(match result {
            Ok(other) => hwnd_to_optional_bigint(other),
            Err(_) => None,
        })
    })
}

/// `GetAncestor(hwnd, gaFlags)` — root / parent / root-owner traversal.
#[napi]
pub fn win32_get_ancestor(hwnd: BigInt, ga_flags: u32) -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_get_ancestor", || {
        let h = hwnd_from_bigint(hwnd);
        let ancestor = unsafe { GetAncestor(h, GET_ANCESTOR_FLAGS(ga_flags)) };
        Ok(hwnd_to_optional_bigint(ancestor))
    })
}

/// `IsWindowEnabled(hwnd)` — false when the window cannot accept input
/// (typically because a modal dialog is blocking it).
#[napi]
pub fn win32_is_window_enabled(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_is_window_enabled", || {
        Ok(unsafe { IsWindowEnabled(hwnd_from_bigint(hwnd)) }.as_bool())
    })
}

/// `GetLastActivePopup(hwnd)` — returns the last popup owned by `hwnd`,
/// or `None` when no owned popup exists (Win32 returns `hwnd` itself in
/// that case; we normalise to `None` to match the legacy TS contract).
#[napi]
pub fn win32_get_last_active_popup(hwnd: BigInt) -> napi::Result<Option<BigInt>> {
    napi_safe_call("win32_get_last_active_popup", || {
        let h = hwnd_from_bigint(hwnd);
        let popup = unsafe { GetLastActivePopup(h) };
        Ok(if popup.0 == h.0 || popup.0.is_null() {
            None
        } else {
            Some(BigInt::from(popup.0 as usize as u64))
        })
    })
}

/// Specialized `DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ...)`.
/// Returns true when the window is cloaked by DWM (e.g. UWP background
/// windows on another virtual desktop pass `IsWindowVisible` but are
/// not actually drawn). Returns false on any failure (including when
/// DWM composition is disabled — match the legacy fallback contract).
#[napi]
pub fn win32_is_window_cloaked(hwnd: BigInt) -> napi::Result<bool> {
    napi_safe_call("win32_is_window_cloaked", || {
        let h = hwnd_from_bigint(hwnd);
        let mut value: u32 = 0;
        let result = unsafe {
            DwmGetWindowAttribute(
                h,
                DWMWA_CLOAKED,
                &mut value as *mut u32 as *mut std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            )
        };
        Ok(result.is_ok() && value != 0)
    })
}
```

### 2.3 Cargo features

`Win32_Graphics_Dwm` を `Cargo.toml` に追加 (DwmGetWindowAttribute と DWMWA_CLOAKED 用)。`Win32_UI_WindowsAndMessaging` (P1 既存) は GetAncestor / GetWindow / GetLastActivePopup / IsWindowEnabled をすでにカバー (要 cargo doc 確認)。

```toml
"Win32_Graphics_Dwm",
```

---

## 3. TS 配線

### 3.1 `src/engine/win32.ts` の差分

#### 削除対象

```typescript
import koffi from "koffi";          // 削除
const user32 = koffi.load("user32.dll");  // 削除
let _dwmapi = ...;                   // 削除
const GetWindowHwnd = user32.func(...);   // 削除
const GetAncestor = user32.func(...);     // 削除
const IsWindowEnabled = user32.func(...); // 削除
const GetLastActivePopup = user32.func(...); // 削除
const _DwmGetWindowAttribute = _dwmapi?.func(...); // 削除
const GW_OWNER / GA_ROOTOWNER / DWMWA_CLOAKED 定数 // 削除 (ネイティブ側に閉じ込め)
```

#### 維持: GWL_EXSTYLE / WS_EX_TOPMOST 定数
本ファイル内 `isWindowTopmost` (P1 native call) と `enumWindowsInZOrder` の exStyle ビット演算が利用、削除不可。

#### 6 wrapper 内部書き換え

| TS wrapper | 旧 | 新 |
|---|---|---|
| `getLastActivePopup(hwnd)` | `GetLastActivePopup(hwnd)` | `nativeWin32.win32GetLastActivePopup(hwnd)` |
| `getWindowOwner(hwnd)` | `GetWindowHwnd(hwnd, GW_OWNER)` | `nativeWin32.win32GetWindow(hwnd, 4)` |
| `getWindowRootOwner(hwnd)` | `GetAncestor(hwnd, GA_ROOTOWNER)` | `nativeWin32.win32GetAncestor(hwnd, 3)` |
| `isWindowEnabled(hwnd)` | `IsWindowEnabled(hwnd)` | `nativeWin32.win32IsWindowEnabled(hwnd)` |
| `isWindowCloaked(hwnd)` | `_DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ...)` + buffer decode | `nativeWin32.win32IsWindowCloaked(hwnd)` |
| `enumWindowsInZOrder()` 内部 3 sites | (上記 3 つを inline で呼んでいた) | 同 wrapper 経由 (Rust side で merge) もしくは inline native call |

`enumWindowsInZOrder` 内部の 3 sites は per-window で呼ばれる (450+ windows × 3 = 1350+ calls/iteration)。FFI hop が増えるが、各 call は < 1μs なので合計 < 1.5ms — 既存 TS 計測 (`bench-enum-title.mjs` p99 0.5ms) を考えると気にならないレベル。**inline で `nativeWin32.win32_*` を呼ぶ**のが simplest。

#### TS wrapper シグネチャ完全不変
`getWindowOwner(hwnd: unknown): bigint | null` 等、すべての export は引数・戻り値型変えない (Tool Surface 不変原則 P7)。

### 3.2 index.d.ts / index.js / native-types.ts / native-engine.ts

5 export 追加 (struct 追加なし、すべて primitive)。

```ts
// index.d.ts
export declare function win32GetWindow(hwnd: bigint, uCmd: number): bigint | null
export declare function win32GetAncestor(hwnd: bigint, gaFlags: number): bigint | null
export declare function win32IsWindowEnabled(hwnd: bigint): boolean
export declare function win32GetLastActivePopup(hwnd: bigint): bigint | null
export declare function win32IsWindowCloaked(hwnd: bigint): boolean
```

`NativeWin32` interface に 5 optional method 追加。

---

## 4. koffi npm 依存削除

### 4.1 `package.json`

```jsonc
"devDependencies": {
  // ... 他依存 ...
-  "koffi": "^2.9.0",
  // ... 他依存 ...
}
```

`npm install` で `package-lock.json` も自動 sync。

### 4.2 `tests/unit/force-focus.test.ts`

`vi.mock("koffi", ...)` は dead mock (force-focus 経路の native 化で実 koffi import なし)。テスト本体は try/finally pattern を抽象的に検証しているのみで mock を実際に使っていない。**`vi.mock` ブロック全体を削除**。

### 4.3 Linux stub 維持確認

`src/server-linux-stub.ts` は `src/stub-tool-catalog.ts` のみ import し、win32.ts には触れない。koffi 依存もなし。**変更不要**、`npm run check:stub-catalog` で確認。

### 4.4 launcher zip size 計測

ADR-007 §6 P4 acceptance: 「zip size 削減量を memory に記録」。

`releases/desktop-touch-mcp-windows.zip` (GH Actions 生成物) のサイズを before / after で比較:
- **Before** (P3 main): koffi prebuilt binaries 同梱 (`node_modules/koffi/build/...` ~5-10MB)
- **After** (本 PR): koffi prebuilt なし

実測手順:
1. main の最新 release zip サイズを `gh release view --json assets` で取得
2. 本 PR で `npm install --omit=dev` 後の `node_modules` サイズを実測
3. **差分は launcher download 時の経済性 + cold start 速度** に効く

**目標**: zip 1MB+ 減 (koffi 本体 + prebuilt MSVC binary 分)。

---

## 5. 実装順序 (commit 単位)

1. **commit 1**: Rust 基盤 (`src/win32/dwm.rs` + `src/win32/mod.rs` 追記 + `Cargo.toml` features 追加)
2. **commit 2**: TS 配線 (`index.d.ts` / `index.js` / `native-types.ts` / `native-engine.ts` / `win32.ts` の koffi 完全撤去)
3. **commit 3**: Cleanup (`package.json` から koffi 削除 + `npm install` で lockfile sync + force-focus dead mock 削除 + コメント類更新)
4. **commit 4**: panic-fuzz 拡張 + design proposal doc

各 commit で `cargo check` + `npm run build` + `npm run lint` + `npm run check:napi-safe` + `npm run check:native-types` + `npm run check:stub-catalog` がグリーン。

最後に `git grep "koffi\\."` で 0 行確認 (PR description に証跡として貼る)。

---

## 6. テスト

### 6.1 panic-fuzz 拡張

5 関数 × 3 不正 hwnd = 15 cases 追加 (73→88 case)。新規追加なし、P3 までと同パターン:
- `win32GetWindow(0n, 4)` → null
- `win32GetAncestor(0n, 3)` → null
- `win32IsWindowEnabled(0n)` → false
- `win32GetLastActivePopup(0n)` → null
- `win32IsWindowCloaked(0n)` → false

各関数 × {`0n`, `9_999_999_999n`, `0xFFFF_FFFF_FFFF_FFFFn`} = 15 cases。

### 6.2 koffi 撤去 acceptance test

`tests/unit/koffi-removed.test.ts` (新規):
```typescript
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

describe("ADR-007 P4 acceptance: koffi fully removed", () => {
  it("git grep 'koffi\\.' returns 0 lines", () => {
    const out = execSync(
      'git grep -E "koffi\\.(load|func|struct|array|proto|pointer|register|unregister|sizeof)"',
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString().trim();
    expect(out).toBe("");
  });

  it("package.json does not list koffi as a dependency", () => {
    const pkg = JSON.parse(
      execSync("git show HEAD:package.json").toString(),
    );
    expect(pkg.devDependencies?.koffi).toBeUndefined();
    expect(pkg.dependencies?.koffi).toBeUndefined();
  });
});
```

このテストが pass することで「将来誰かが新規 koffi.X を書いた時 CI が即時に regression 検出」が仕組み化される (CLAUDE.md 強制命令 7「仕組みで対応」)。

---

## 7. リスク

| # | リスク | 軽減 |
|---|---|---|
| 1 | `enumWindowsInZOrder` 内部の per-window FFI hop 増加 (450+ × 3) | 計測: P1 baseline 0.5ms → P4 想定 < 2ms 程度。bench-enum-title.mjs で再計測、SLO 内なら OK |
| 2 | `DwmGetWindowAttribute` が DWM 無効 OS で失敗 | `result.is_ok() && value != 0` で false fallback (旧挙動互換) |
| 3 | `GetWindow` `uCmd` 値の整数互換 | `GET_WINDOW_CMD(u32)` newtype が GW_OWNER=4 を受け付ける、cargo check で確認 |
| 4 | Linux stub に絡む規制 | server-linux-stub.ts は win32.ts 触らない、変更ゼロを確認 |
| 5 | `koffi` を package-lock.json から sync 漏れ | `npm install` でロックファイル自動 sync、commit に含める |
| 6 | force-focus.test.ts mock 削除でテスト破綻 | テスト本体は try/finally 抽象パターンのみで mock 未使用、安全 |
| 7 | `getWindowOwner` 旧コードの `GW_OWNER=4` リテラル直渡し vs constant | 旧コードと同値でリテラル直渡し OK、可読性のため TS 側に GW_OWNER local const 残しても良い |

---

## 8. やらないリスト (scope creep 防止)

| やらない | 理由 |
|---|---|
| L1 Capture コア新設 | P5a-d |
| `napi_safe_call` 既存 sync export 拡大 (`compute_change_fraction` 等) | P5a |
| `DwmGetWindowAttribute` の generic API expose (DWMWA_NCRENDERING_ENABLED 等) | YAGNI、必要時に追加 |
| `GetWindow` の他 uCmd 値 (GW_HWNDFIRST=0 / GW_HWNDLAST=1 / GW_HWNDNEXT=2 / GW_HWNDPREV=3 / GW_OWNER=4 / GW_CHILD=5) を specialized API 化 | 現在 GW_OWNER のみ使用、generic primitive で柔軟性確保 |
| sensors-win32.ts の **再構造化** | P4 scope は「koffi 撤去」のみ、他のリファクタは別 PR |
| `koffi` 言及を含むコメントの **過去形書き換え** で Tool Surface 表現を変えること | コメントのみ更新、API は不変 |

---

## 9. Opus に判断委譲したい点

1. **§1 5 つすべて plain primitive で OK か** — P3 で hybrid 化したケース (Toolhelp32 / OpenProcess) と異なり、これらは handle 寿命なし。primitive で 5 export とする判断は妥当か?
2. **§1.2 specialized DwmGetWindowAttribute** — DWMWA_CLOAKED only に絞って `win32_is_window_cloaked` 1 関数とする vs generic `win32_dwm_get_window_attribute(hwnd, attr, size)` で expose の選択
3. **§3.1 enumWindowsInZOrder 内部のシナリオ** — per-window 3 native call (450+ × 3 = 1350+ calls/iter) は許容範囲か? FFI hop コストは 1μs 以下のはずだが、bench-enum-title.mjs で計測して SLO 内であれば OK との判断で良いか?
4. **§4.2 force-focus.test.ts の dead mock 削除** — テスト 3 件はすべて try/finally 抽象パターンのみで実 koffi mock を使っていない。削除して safe か?
5. **§6.2 koffi-removed acceptance test** — `execSync('git grep ...')` で CI ガード化する案。`scripts/check-no-koffi.mjs` として独立 script + ci.yml step にする方が綺麗か?
6. **§4.4 zip size 計測** — どこまで細かく measure すべきか? P4 acceptance「zip size 削減量を memory に記録」を満たすには「~5-10MB 削減」と定性的記述で十分か、それとも byte 単位の正確な before/after 数値が必要か?
7. **scope creep**: P4 で「sensors-win32.ts の追加リファクタ」「`napi_safe_call` 全 sync export 拡大」を持ち込まない判断 (§8) で OK か?

---

## 10. 最終 acceptance チェックリスト (PR 説明に転載)

- [ ] `cargo check` clean
- [ ] `npm run build:rs` (release) produces working `.node`
- [ ] `npm run build` (tsc) clean
- [ ] `npm run lint` clean (P2 で踏んだ前科対応)
- [ ] `npm run check:napi-safe` passes
- [ ] `npm run check:native-types` passes
- [ ] `npm run check:stub-catalog` passes (Linux stub 触らないことを確認)
- [ ] `npm run test:capture` clean (0 regression)
- [ ] panic-fuzz 73→88 cases 全 pass
- [ ] **`git grep "koffi\\." | wc -l` = 0** ← ADR-007 §6 P4 メイン acceptance
- [ ] `package.json` に `koffi` 依存なし
- [ ] launcher zip size before/after 記録

---

## 11. Opus レビュー指摘 (2026-04-29、必須 3 + 補助 6)

### 11.1 (核心) `koffi-removed` を CI script 化 (§5 / §6.2 修正)

vitest 内 `execSync('git grep ...')` 案を破棄、`scripts/check-no-koffi.mjs` + `ci.yml` step に置換。理由:
- 既存 `check-napi-safe.mjs` / `check-native-types.mjs` の pattern と一貫
- vitest 内 git 呼出は zip release 解凍後に false negative (git 不在)
- 違反箇所を行番号付きで列挙する出力が script の方が綺麗

**確定形 grep pattern** (API identifier 9 個に限定、`\b` 単語境界で `koffilint` 等 false positive 排除):

```regex
\bkoffi\.(load|func|struct|array|proto|pointer|register|unregister|sizeof)\b
```

これで散文の "koffi" 言及は通過、API call のみ捕捉。同 script で `package.json` の `dependencies?.koffi` / `devDependencies?.koffi` 不在チェックも合わせ実施。

### 11.2 enumWindowsInZOrder 内部は inline `nativeWin32.win32_*` 直呼び (補助 1)

TS wrapper 経由 (`getWindowOwner` 等) ではなく **inline 直呼び**。理由:
- 新 native は `Result<Option<BigInt>>` で失敗 → None 化済 (try/catch 不要)
- `enumWindowsInZOrder` は外側で `try { ... } catch { skip window }` 持つ → wrapper 経由だと冗長な二重 try/catch
- V8 frame 削減

**TS local const は残す**: `GW_OWNER = 4` / `GA_ROOTOWNER = 3` / `WS_EX_TOPMOST = 0x00000008`。リテラル直書きはメンテ性悪化、但し native 側に enum 化すると generic API 化の誘惑 (§8 違反)。

### 11.3 やらないリスト追加 (§8 拡張)

- **`MEMORY.md` 内 koffi 言及の cleanup** — 別 PR
- **`docs/system-overview.md` の大幅リライト** — 本 PR は acceptance grep pass のみ
- **`scripts/check-napi-safe.mjs` の SCAN_DIR 拡大 (lib.rs 取り込み)** — P5a follow-up 持ち越し
- **`benches/README.md` への P4 bench 追記** — bench 結果は PR description のみ
- **API identifier `koffi\.X` 以外の koffi 言及 (散文・コメント)** — pattern が API 限定なので散文残留 OK

### 11.4 補助確認事項 (実装中に守る)

| # | 項目 | 対応 |
|---|---|---|
| 1 | `GetLastActivePopup` 二重 null チェック削除 | Rust 側 `popup == hwnd \|\| null → None` で正規化、TS は `return native.win32GetLastActivePopup(hwnd)` 直 return + panic-fuzz `(self_hwnd) → null` ケース 1 件追加 |
| 2 | `GetAncestor` 失敗時挙動確認 | panic-fuzz `win32GetAncestor(0n, 3)` で実機戻り値確認、null 想定だが windows-rs 実装次第 |
| 3 | `Cargo.toml` features 配置 | `Win32_Graphics_Dwm` を既存 `Win32_Graphics_Dxgi` の隣に追加 (category 順) |
| 4 | `NativeWin32` interface 5 export `?:` optional | 既存 P1-P3 と同パターン、legacy `.node` build 互換 |
| 5 | `force-focus.test.ts` 削除後カバレッジ | panic-fuzz の `win32_force_set_foreground_window` ケース (P3 で追加済) が contract test として残ること を PR description に明記 |
| 6 | bench 結果を PR description に貼る | `bench-enum-title.mjs` 実測値 (per-window 3 native call 後の p99) を P1 baseline 0.5ms と並べて掲載 |

### 11.5 `getWindowOwner` 等の TS wrapper 内部も二重チェック削除

§3.1 の TS wrapper 表で「`win32GetLastActivePopup` 直 return」のように、Rust 側で正規化済の関数は TS 側で再判定しない:

```typescript
// 正規化を Rust 側に閉じ込めた後の理想形
export function getLastActivePopup(hwnd: unknown): bigint | null {
  if (typeof hwnd !== "bigint") return null;
  try {
    return requireNativeWin32().win32GetLastActivePopup!(hwnd);
  } catch { return null; }
}
```

`getWindowOwner` / `getWindowRootOwner` も同様 (Rust 側 `null hwnd → None` 正規化、TS は直 return)。

### 11.6 PR commit 構成見直し

設計提案 §5 の commit 4 を **「panic-fuzz 拡張 + design proposal status を Implemented に更新」** に変更。P1-P3 で「proposal を Approved → Implemented に更新する commit」を最後に同梱しているパターンと一貫させる。

### 11.7 Acceptance チェックリスト確定 (PR description 貼付け用)

§10 のチェックリストに以下を追加:

- [ ] `node scripts/check-no-koffi.mjs` exits 0 (新規 CI guard)
- [ ] `bench-enum-title.mjs` p99 < 2ms (per-window 3 native call 増の SLO 内確認)
- [ ] `tests/unit/native-win32-panic-fuzz.test.ts` 73→89 cases pass (P4 で 15 + GetLastActivePopup 1 = 16 case 追加)
- [ ] `git grep -E '\bkoffi\.(load|func|struct|array|proto|pointer|register|unregister|sizeof)\b' | wc -l` = 0
- [ ] `package.json` に `koffi` 依存なし
- [ ] launcher zip size before/after を memory に記録 (post-merge release 後)

---

END OF P4 DESIGN PROPOSAL
