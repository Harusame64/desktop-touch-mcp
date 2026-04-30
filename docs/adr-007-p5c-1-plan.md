# ADR-007 P5c-1 — UIA Focus Changed event hook プラン

- Status: **Implemented (2026-04-30、本 PR `feat/adr-007-p5c-1-focus-hook`)** — plan v3 (Codex plan-only review v2 反映) の実装が完了。下記「実装後 refinement」section 参照
- Date: 2026-04-30 (plan v3) / 実装完了 2026-04-30 (本 PR)

## 0. 実装後 refinement (本 PR closure 時点、2026-04-30)

実装中に判明した plan v3 からの scope 調整:

### 0.1 §3.4.2 / §8.5 acceptance の refine
- **§3.4.2 Test 1 (Notepad live focus event push) → vitest follow-up に分離**: Win11 で Notepad は MSStore App Execution Alias 経由で UWP 起動するため AttachThreadInput / 起動 hang の既知問題あり (`memory/feedback_notepad_launcher_msstore_hang.md`)。Live integration は別 fixture window or 別アプリで検討、本 PR scope 外
- **§3.4.2 Test 4 (cached path `slow_path == 0`) → 別 follow-up**: tracing instrumentation を別途追加してから測定、本 PR scope 外
- **§3.4.2 Test 2 (5-cycle shutdown/restart) → 既存 `thread.rs::shutdown_and_restart_5_cycles` で代替**: `com_thread_main` 改修により handler register/Remove 経路も自動 exercised、新規 test 不要
- **§3.4.2 Test 3 (handler panic safety) → focus.rs `#[cfg(test)] mod tests` で minimal smoke**: synthetic panic 経路は live UIA delivery 必要のため最小実装。Code review で panic-catch ロジック検査

### 0.2 追加の build infra finding
- **`windows-core = "0.62"` を Cargo.toml に直 dep 追加が必要** (`#[implement]` macro が `::windows_core::IUnknownImpl` を absolute path で参照、`windows` crate 経由 transitive dep だけでは resolve されない)
- これは plan v3 §3.1 / §3.2 では未明記、実装中に判明 → §3.5 docs flip で adr-007 P5c-1 の sub-batch checklist に追記済

### 0.3 verify 結果
- `cargo check --workspace` → 0 errors / 5 既存 unused-import warnings (本 PR 由来でない)
- `cargo test --lib --no-default-features uia::event_handlers::focus` → 1/1 pass (handler 構築 sanity)
- `cargo test --lib --no-default-features uia::thread::tests::shutdown_and_restart_5_cycles` → 1/1 pass (handler 経路含む)
- `npm run test:capture --force` → **2435 pass / 0 fail / 28 skip** (前回 R12 PR と完全同数、regression 0)

### 0.4 follow-up 起票候補
1. vitest live integration test (Notepad 別 fixture or 別アプリ + napi `l1Poll` ring drain)
2. tracing 経由の cached-path `slow_path == 0` 計測 (P5c plan §11.3 acceptance 補完)
3. 既知 baseline failure (uia::thread test-binary ACCESS_VIOLATION / vision_backend cargo test 4件 / build:rs toolchain mismatch) は本 PR から独立した別 follow-up

---
- 親 plan: `docs/adr-007-p5c-plan.md` (P5c-1 sub-batch §4 / §6 / §11.3)
- 親 ADR: `docs/adr-007-koffi-to-rust-migration.md`
- SSOT: `docs/architecture-3layer-integrated.md`
- 後続 blocker: `docs/adr-008-d1-plan.md` D1-2 (real L1 adapter)
- 前提 (全て完了): P5c-0b (PR #84) + R11 (PR #86) + R12 (PR #87)
- review history:
  - v1 → Codex (P1×1 privacy + P2×2 window_title 不安定 / acceptance baseline) → v2
  - v2 → Codex (P1×1 残 privacy: `payload` module も private、struct は re-export 経由必要) → **v3 (本書)**

---

## 1. Background

### 1.1 P5c-0b で揃った基盤 (本 PR ですぐ使える)

| 構成要素 | location | 状態 |
|---|---|---|
| `UiElementRef`, `UiaFocusChangedPayload { before, after, window_title }` | `src/l1_capture/payload.rs:26-44` | ✅ 定義済 |
| `UiaFocusInfoExt { hwnd, name, control_type, automation_id }` | `src/uia/types.rs:98-103` | ✅ 定義済 |
| `cached_element_to_focus_info(elem) -> Option<UiaFocusInfoExt>` | `src/uia/focus.rs:139` (内部 `mod cached_focus_info`) | ✅ 実装済、`#[allow(dead_code)]` で待機中 |
| `UIA_NativeWindowHandlePropertyId` cache 化 | `src/uia/thread.rs::configure_cache_properties` | ✅ P5c-0b で追加済 (cached path で hwnd 解決) |
| UIA thread shutdown 機構 (`UiaThreadHandle`, `shutdown_uia_for_test`, `ensure_uia_thread`) | `src/uia/thread.rs:52-183` | ✅ P5c-0b + R11/R12 fix 完了 (`Arc::ptr_eq` guard 含) |
| **`EventRing` の `Arc` clone path**: `pub use ring::EventRing` (mod.rs:15) + `L1Inner.ring` は `pub` field (worker.rs:153) → `ensure_l1().ring.clone()` で `Arc<EventRing>` 取得可 | `src/l1_capture/{mod,worker,ring}.rs` | ✅ visibility 確認済 (本 v2 で重要) |
| `EventKind::UiaFocusChanged = 1` | `src/l1_capture/envelope.rs` | ✅ P5a で定義済 |
| L3 bridge scaffold | `src/l3_bridge/mod.rs` | ✅ P5c-0b で scaffold 済 (実装は ADR-008 D1-2) |
| `engine-perception::input::{L1Sink, FocusEvent}` | `crates/engine-perception/src/input.rs` | ✅ P5c-0b で scaffold 済 |

### 1.2 P5c-1 で埋める gap

P5c-0b までで「ring に push できる箱」は全て揃っているが、**push する emitter (UIA event handler) 自体が無い**。本 PR で:

1. `IUIAutomationFocusChangedEventHandler` を `#[implement]` で実装する `FocusEventHandler` 構造体
2. handler を所有して `Drop` で `RemoveFocusChangedEventHandler` を呼ぶ `UiaEventHandlerOwner`
3. UIA thread の起動時に handler を register、shutdown 時に Drop 経由で unregister
4. handler の delivery callback で `cached_element_to_focus_info()` → root 正規化した hwnd で window_title 取得 → `UiaFocusChangedPayload` 構築 → `ring.push(EventKind::UiaFocusChanged)`

**この PR が ADR-008 D1-2 (real L1 adapter) の最後の blocker**。完了で D1 acceptance「TS 版より latency 1/10」が synthetic 比較から real L1 input ベースに格上げされる。

### 1.3 副次 findings (本 PR で対処)

#### (a) win32 Rust 直 helper の不足 — 2 件
- `src/win32/window.rs::win32_get_window_text` は napi wrapper (`BigInt → napi::Result<String>`) のみで Rust 直 caller 用 helper が無い → 本 PR で `pub(crate) fn get_window_text(hwnd: HWND) -> String` を extract
- **`GetAncestor(hwnd, GA_ROOT)` の Rust 直 helper も無い** (TS 側 `src/engine/win32.ts` には `GA_ROOTOWNER` 用 wrapper があるが Rust 側に無い) → 本 PR で `pub(crate) fn get_root_hwnd(hwnd: HWND) -> HWND` を新設

#### (b) `cached_element_to_focus_info` の hwnd は focused element 自身 (root 正規化なし) — Codex v1 P2 #1
- 現状 `cached_element_to_focus_info` は walker で root へ辿らず、**focused element の `CachedNativeWindowHandle` をそのまま返す** (`src/uia/focus.rs:150-159`)
- focus が Edit / TextBox 等の child control の場合、その HWND は **child の HWND**で、`GetWindowTextW` しても top-level title ではなく空文字や control text が返る
- → handler 側で `payload.window_title` 取得時に **`get_root_hwnd()` で top-level に正規化してから** `get_window_text` を呼ぶ
- **payload の field 役割分離**: `UiElementRef.hwnd` は **focused element 自身の hwnd** (child でも child のまま、P5c plan §4 P5c-0b の「`hwnd: 0` は unresolved」spec と整合) / `UiaFocusChangedPayload.window_title` は **containing top-level window の title** という分離

#### (c) handler が必要とする L1 権限は ring push のみ — Codex v1 P1
- v1 では `FocusEventHandler { l1: Arc<L1Inner> }` だったが、`L1Inner` は private (worker module 自体が private、`L1Inner` の re-export なし) で **そのままだと privacy で compile fail**
- handler が必要なのは `ring.push()` のみ → **`FocusEventHandler { ring: Arc<EventRing> }`** に scope を絞る
- 取得経路: `let ring = crate::l1_capture::ensure_l1().ring.clone();` (`ensure_l1()` は `pub(crate)` re-exported、`L1Inner.ring` は `pub` field、`Arc::clone` は cheap)
- これで handler 側が import するのは `crate::l1_capture::EventRing` のみ、`L1Inner` を一切触らない

---

## 2. Scope

### 2.1 本 PR で実装するもの

- `src/uia/event_handlers/{mod,focus,owner}.rs` 新設
- `src/uia/mod.rs` に `pub(crate) mod event_handlers;` 追加
- `src/uia/thread.rs::com_thread_main` に handler register / Drop 経路を統合 (shutdown ordering: handler Drop → CoUninitialize)
- **`src/win32/window.rs` の Rust 直 helpers extract / 新設 (2 件)**:
  - `pub(crate) fn get_window_text(hwnd: HWND) -> String` — 既存 `win32_get_window_text` の中身を extract (副次 refactor、外部挙動不変)
  - `pub(crate) fn get_root_hwnd(hwnd: HWND) -> HWND` — `GetAncestor(hwnd, GA_ROOT)` 新規 wrap (返り値 0 のときは入力 hwnd をそのまま返す = best-effort)
- integration test (Notepad target で focus 移動、5-cycle shutdown/restart、handler panic で全滅しない)
- ADR-007 §6.1 / §9.1 P5c row + ADR-008 D1 plan §1.3 の checklist 進捗 flip

### 2.2 本 PR で実装しないもの (担当 phase 明示)

| 項目 | 担当 phase | 備考 |
|---|---|---|
| **before-focus tracking** (`UiaFocusChangedPayload.before`) | D2 以降で必要なら追加 | 本 PR では `before: None` 固定 (P5c plan §6.3 と整合) |
| DXGI dirty rect emit | P5c-2 | 別 PR |
| WindowChanged hooks (Window opened/closed/foreground) | P5c-3 | 別 PR、API 形が違う (5 引数 `AddAutomationEventHandler`) |
| ScrollChanged hooks | P5c-4 | 別 PR、API 形が違う (5 引数 `AddPropertyChangedEventHandler`) |
| L3 bridge `focus_pump.rs` 実装 | ADR-008 D1-2 | 本 PR で scaffold は既に存在 (P5c-0b)、本 PR では fill しない |
| `EventRing::subscribe()` (broadcast 化) | ADR-008 D1-2 | P5c plan §8 (A) で「D1-2 で実装」確定済 |
| `UiaTreeChanged` / `UiaInvoked` / `UiaValueChanged` emit | 将来 (ADR-008 D2 で必要が出たら) | enum / payload は reserved 状態 |
| MCP tool surface への露出 | ADR-008 D2 以降 | 本 PR は engine 内部完結 |
| **既知 baseline failure 修正** (`uia::thread` の test-binary ACCESS_VIOLATION / `cargo test --lib` の `vision_backend` 4 件 compile error) | 別 follow-up | 本 PR scope 外 (Codex v1 P2 #2 反映、§8.5 で acceptance を絞る) |

---

## 3. Sub-batch 分解 (checklist)

実装担当者は完了したら `[ ]` → `[x]` に flip する (CLAUDE.md `feedback_plan_checklist.md`)。

### 3.1 Refactor pre-step: win32 Rust helpers (2 件)

#### 3.1.1 `get_window_text` extract (既存 napi wrapper の refactor)
- [ ] `src/win32/window.rs` に `pub(crate) fn get_window_text(hwnd: HWND) -> String` を抽出 (現 `win32_get_window_text` の中身を move、buffer 512 wchar も維持、空 HWND / 失敗時は `String::new()`)
- [ ] 既存 `win32_get_window_text` napi wrapper は内部で `get_window_text(hwnd_from_bigint(hwnd))` を call するだけに簡素化 (panic safety / napi::Result wrapping は napi_safe_call で残す)
- [ ] 既存 vitest test に regression なし (`tests/unit/native-win32-*.test.ts` 系)

#### 3.1.2 `get_root_hwnd` 新設 (root 正規化、Codex v1 P2 #1)
- [ ] `src/win32/window.rs` に `pub(crate) fn get_root_hwnd(hwnd: HWND) -> HWND` を新設:
  - `unsafe { GetAncestor(hwnd, GA_ROOT) }` を call
  - **返り値が `HWND(0)` のとき**: 入力 hwnd をそのまま返す (best-effort、入力 hwnd 自体が既に root の場合 / 失敗時の degraded fallback)
  - GA_ROOT は `windows::Win32::UI::WindowsAndMessaging::GA_ROOT` (windows-rs 0.62 の `GET_ANCESTOR_FLAGS(2)` 相当)
- [ ] Cargo.toml の `Win32_UI_WindowsAndMessaging` feature は既に有効 (確認済) なので追加 dep なし
- [ ] unit smoke test: `cargo test --lib --no-default-features win32::window::tests` (既存 test に regression なし、新規 helper の compile/load 確認)

### 3.2 New module: src/uia/event_handlers/

#### 3.2.1 mod.rs
- [ ] `pub(crate) mod focus;`
- [ ] `pub(crate) mod owner;`
- [ ] `pub(crate) use owner::UiaEventHandlerOwner;`

#### 3.2.2 focus.rs (FocusEventHandler 実装、~140 LoC、Codex v1 P1 反映)
- [ ] imports: `crate::l1_capture::{EventRing, EventKind, encode_payload, build_event, make_failure_event, UiElementRef, UiaFocusChangedPayload}`、`crate::uia::focus::cached_element_to_focus_info`、`crate::win32::window::{get_window_text, get_root_hwnd}` (visibility は §1.1 表 + §1.3 (c) で確認済。**`payload` module 自体は private、struct は `pub use payload::{...}` で mod.rs:9-14 から re-export 済 — Codex v2 P1 反映**)
- [ ] `#[implement(IUIAutomationFocusChangedEventHandler)]` 付きの `pub(crate) struct FocusEventHandler { ring: Arc<EventRing> }` ← **`Arc<L1Inner>` ではなく `Arc<EventRing>` (Codex P1 反映)**
- [ ] `impl IUIAutomationFocusChangedEventHandler_Impl for FocusEventHandler_Impl` の `HandleFocusChangedEvent(&self, sender: Ref<'_, IUIAutomationElement>) -> windows::core::Result<()>`:
  - [ ] 全体を `std::panic::catch_unwind(AssertUnwindSafe(|| { ... }))` でラップ (R1)
  - [ ] panic catch 時: ring に `Failure` event を push (`make_failure_event("uia-event-handler", "HandleFocusChangedEvent", "HandlerPanic", Some(detail))`)
  - [ ] `sender.as_ref()` が `Some(elem)` の時のみ続行 (None 時は graceful skip)
  - [ ] `let info = cached_element_to_focus_info(elem)?;` (`Option<UiaFocusInfoExt>` → None 時 graceful skip)
  - [ ] **window_title 取得 (root 正規化、Codex v1 P2 #1)**:
    ```rust
    let window_title = if info.hwnd != 0 {
        let element_hwnd = HWND(info.hwnd as isize);
        let root_hwnd = get_root_hwnd(element_hwnd);  // child→top-level 正規化
        get_window_text(root_hwnd)
    } else {
        String::new()
    };
    ```
  - [ ] `payload`: `UiaFocusChangedPayload { before: None, after: Some(UiElementRef { hwnd: info.hwnd, name, automation_id, control_type }), window_title }` ← `UiElementRef.hwnd` は **元の (child) hwnd**、`window_title` は **root window の title** という field 役割分離
  - [ ] `event = build_event(EventKind::UiaFocusChanged as u16, encode_payload(&payload), None, None)`
  - [ ] `self.ring.push(event)` で ring に push
  - [ ] `Ok(())` で return (windows::core::Result)
- [ ] `pub(crate) fn make_focus_handler(ring: Arc<EventRing>) -> IUIAutomationFocusChangedEventHandler`:
  - [ ] `FocusEventHandler { ring }.into()` (windows-rs `#[implement]` が `IUIAutomationFocusChangedEventHandler` への変換を提供)

#### 3.2.3 owner.rs (UiaEventHandlerOwner with Drop、~80 LoC)
- [ ] `pub(crate) struct UiaEventHandlerOwner { automation: IUIAutomation, focus_handler: Option<IUIAutomationFocusChangedEventHandler> }`
- [ ] `impl UiaEventHandlerOwner`:
  - [ ] `pub(crate) fn new(automation: IUIAutomation) -> Self { Self { automation, focus_handler: None } }`
  - [ ] `pub(crate) fn register_focus(&mut self, cache_request: &IUIAutomationCacheRequest, handler: IUIAutomationFocusChangedEventHandler) -> windows::core::Result<()>`:
    - [ ] **`unsafe { self.automation.AddFocusChangedEventHandler(cache_request, &handler)? }`** ← 2 引数 (Codex P5c plan v2 P2 API mismatch)
    - [ ] `self.focus_handler = Some(handler);`
    - [ ] `Ok(())`
- [ ] `impl Drop for UiaEventHandlerOwner`:
  - [ ] `if let Some(h) = self.focus_handler.take() { unsafe { let _ = self.automation.RemoveFocusChangedEventHandler(&h); } }`
  - [ ] **`Remove*` の失敗は無視** (Drop で `?` できない、shutdown ordering で apartment が既に死んでる可能性も含めて best-effort、二重 unwind 回避)

### 3.3 Integration into src/uia/thread.rs

#### 3.3.1 mod.rs に追加
- [ ] `pub(crate) mod event_handlers;` (順序は alphabetical で `actions` の後)

#### 3.3.2 thread.rs::com_thread_main 改修
- [ ] `let mut event_owner = UiaEventHandlerOwner::new(ctx.automation.clone());` を `build_context()` 直後 + main loop 前に追加
- [ ] **L1 ring の取り出し (Codex P1 反映)**: `let ring = crate::l1_capture::ensure_l1().ring.clone();` ← `Arc<EventRing>` を取得 (l1_capture/mod.rs で `pub(crate) use worker::ensure_l1` 済、`L1Inner.ring` は `pub` field、`Arc::clone` は cheap)
- [ ] `let handler = event_handlers::focus::make_focus_handler(ring);`
- [ ] `event_owner.register_focus(&ctx.cache_request, handler)?;` (失敗時 eprintln + continue、CoUninitialize は呼ぶ — Tier 1 graceful disable と整合)
- [ ] main loop は変更なし (select! で task / shutdown_rx)
- [ ] loop exit 後、`drop(event_owner);` を **明示的に書く** (CoUninitialize の前に、Drop 実行を Rust の lexical scope に頼らず順序保証)
- [ ] `unsafe { CoUninitialize(); }` (既存)

### 3.4 Test

#### 3.4.1 Unit (Rust)
- [ ] `cargo test --lib --no-default-features uia::event_handlers::focus` で smoke (focus.rs が compile + load、`#[implement]` macro 展開が壊れていない)

#### 3.4.2 Integration (Rust + Notepad、~150 LoC)
- [ ] `tests/integration/uia_focus_hook.rs` 新規:
  - [ ] **Test 1 (focus event push)**: Notepad 起動 → `ensure_uia_thread` → focus 切替を `SetForegroundWindow(notepad_hwnd)` で生成 → 200ms wait → `l1_poll()` 経由で ring drain → `EventKind::UiaFocusChanged` event が 1 件以上 + `payload.after.hwnd != 0` を assert (window_title は (b) で root-resolved 限定 assert)
  - [ ] **Test 1b (root-resolved window_title)**: 上記 event のうち少なくとも 1 件で **`payload.window_title.contains("Notepad") || payload.window_title.contains("メモ帳")`** を assert (root 正規化が動いていれば Notepad の root window title が取れる、child Edit control にも focus 行くが root 正規化で top-level へ正規化されるはず)
    - **note**: `payload.window_title != ""` を全 event に強要しない (focus 先 root が title 持たない window の場合あり、Codex v1 P2 #1 反映)
  - [ ] **Test 2 (5-cycle shutdown/restart)**: 5 回 `ensure_uia_thread → shutdown_uia_for_test(3s)` を巡回、leak / crash / deadlock なし (P5c-0b の `shutdown_and_restart_5_cycles` と同水準、ただし handler register/Remove も毎サイクル実行される)
  - [ ] **Test 3 (handler panic safety)**: handler 内 panic を強制発生させる feature gate (`#[cfg(test)] static FORCE_PANIC: AtomicBool = ...`) で UIA thread / Node プロセスが落ちないことを確認、Failure event が ring に出ることも確認
  - [ ] **Test 4 (cached path 確認)**: `tracing` log で `cached_element_to_focus_info` 内 slow_path カウンタが 0 を確認 (UIA_NativeWindowHandlePropertyId が cache に乗っていないと `CachedNativeWindowHandle` が live UIA に fall back する)
  - [ ] **環境依存テストの skipIf**: `notepad.exe` 起動失敗時は `eprintln + return Ok(())` で graceful skip。Linux/Mac は `#[cfg(target_os = "windows")]` で除外
- [ ] integration test execution: `cargo test --test uia_focus_hook --no-default-features` で個別実行 (本 PR scope 内 acceptance、§8.4 と整合)

#### 3.4.3 Vitest regression (refactor 検証)
- [ ] `node scripts/test-capture.mjs --force` → 既存 2435 pass を維持 (win32 helper extract で既存 napi wrapper の挙動が壊れていないこと、特に `win32_get_window_text` を call する `desktop_state` 系)

### 3.5 Docs flip

- [ ] `docs/adr-007-koffi-to-rust-migration.md` §6.1 の P5c subphase 記述に「P5c-1 完了 (本 PR)」を追記
- [ ] `docs/adr-007-koffi-to-rust-migration.md` §9.1 P5c row の「UiaFocusChanged を **emit**」項目を実装済として表記
- [ ] `docs/adr-007-p5c-plan.md` §4 P5c-1 sub-batch checklist を `[x]` に flip
- [ ] `docs/adr-008-d1-plan.md` §1.3 D1-2 前提行 (P5c-1 完了) を満たした旨を記述、§3 D1-2 の「前提」section も update

---

## 4. PR 切り方

**単一 PR `feat/adr-007-p5c-1-focus-hook`** で行く。理由:
- mechanical な scope (handler 1 種類、L1 と同型 owner pattern)
- test と handler は同じ context で review すべき
- docs flip は 4 行程度の軽さ
- size 想定: code ~390 LoC + test ~150 LoC + win32 helpers extract/新設 ~50 LoC + docs ~30 LoC = **~620 LoC**
- P5c plan §5 の見積 300-400 line より大きいのは: integration test の充実 + win32 helper extract refactor + GA_ROOT 新設 込みのため

**事前 review 分け**:
- (a) Rust impl: handler / owner / thread.rs 統合 — Opus 直実装
- (b) win32 helpers: 機械的 extract + 1 新設、Sonnet 委譲可だが副作用テスト確認が必要
- (c) integration test: Notepad 環境依存、Opus が書く方が安全

→ **本 PR は全部 Opus 直実装** (R1 panic safety + R7 windows-rs `#[implement]` 初使用は判断系、Sonnet では risk)。

---

## 5. UIA event handler 実装方針

### 5.1 windows-rs 0.62 の `#[implement]` macro と IUIAutomationFocusChangedEventHandler (Codex v1 P1+P2#1 反映)

```rust
// src/uia/event_handlers/focus.rs (擬似コード — 詳細は実装で)

use std::sync::Arc;
use windows::core::{implement, Ref, Result};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Accessibility::{
    IUIAutomationElement,
    IUIAutomationFocusChangedEventHandler,
    IUIAutomationFocusChangedEventHandler_Impl,
};

// Codex v2 P1: `payload` module は private、struct は mod.rs の
// `pub use payload::{...}` (l9-14) で re-export されているので
// `crate::l1_capture::{...}` 経由で import する。
use crate::l1_capture::{
    build_event, encode_payload, make_failure_event, EventKind, EventRing,
    UiElementRef, UiaFocusChangedPayload,
};
use crate::uia::focus::cached_element_to_focus_info;
use crate::win32::window::{get_root_hwnd, get_window_text};

#[implement(IUIAutomationFocusChangedEventHandler)]
pub(crate) struct FocusEventHandler {
    // Codex v1 P1: Arc<L1Inner> ではなく Arc<EventRing> (privacy + scope 最小化)
    ring: Arc<EventRing>,
}

impl IUIAutomationFocusChangedEventHandler_Impl for FocusEventHandler_Impl {
    fn HandleFocusChangedEvent(
        &self,
        sender: Ref<'_, IUIAutomationElement>,
    ) -> Result<()> {
        // R1: handler 内 panic で UIA thread / Node プロセス全滅を防ぐ。
        // panic 時は ring に Failure event 化することで観測も可能に。
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let Some(elem) = sender.as_ref() else { return; }; // graceful skip
            let Some(info) = cached_element_to_focus_info(elem) else { return; };

            // Codex v1 P2 #1: child element の hwnd で GetWindowTextW すると
            // top-level title ではなく空文字 / control text が返る。
            // GA_ROOT で top-level に正規化してから title を取る。
            let window_title = if info.hwnd != 0 {
                let element_hwnd = HWND(info.hwnd as isize);
                let root_hwnd = get_root_hwnd(element_hwnd);
                get_window_text(root_hwnd)
            } else {
                String::new()
            };

            // Field 役割分離:
            //   UiElementRef.hwnd      → focused element 自身の hwnd (child でも child のまま)
            //   payload.window_title   → containing top-level window の title
            let payload = UiaFocusChangedPayload {
                before: None,                        // P5c-1 では before tracking しない
                after: Some(UiElementRef {
                    hwnd: info.hwnd,
                    name: info.name,
                    automation_id: info.automation_id,
                    control_type: info.control_type,
                }),
                window_title,
            };

            let event = build_event(
                EventKind::UiaFocusChanged as u16,
                encode_payload(&payload),
                None, None,
            );
            self.ring.push(event);
        }));

        if let Err(panic_payload) = result {
            let detail = if let Some(s) = panic_payload.downcast_ref::<&'static str>() {
                (*s).to_string()
            } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "<non-string panic payload>".to_string()
            };
            let event = make_failure_event(
                "uia-event-handler",
                "HandleFocusChangedEvent",
                "HandlerPanic",
                Some(detail),
            );
            self.ring.push(event);
        }

        Ok(()) // 常に Ok を返して COM caller に panic を漏らさない
    }
}

pub(crate) fn make_focus_handler(ring: Arc<EventRing>) -> IUIAutomationFocusChangedEventHandler {
    FocusEventHandler { ring }.into()
}
```

### 5.2 register API: `AddFocusChangedEventHandler` は 2 引数 (Codex P5c plan v2 P2)

windows-rs 0.62 の `IUIAutomation::AddFocusChangedEventHandler` signature:

```rust
unsafe fn AddFocusChangedEventHandler<P0, P1>(
    &self,
    cacherequest: P0,
    handler: P1,
) -> windows::core::Result<()>
where
    P0: Param<IUIAutomationCacheRequest>,
    P1: Param<IUIAutomationFocusChangedEventHandler>,
```

→ **2 引数 (cache_request, handler)、scope なし、root element 指定なし**。これは focus event がプロセス全体 (desktop 全体) を default scope とするため。WindowChanged / Scroll の `AddAutomationEventHandler` (5 引数) / `AddPropertyChangedEventHandler` (5 引数) と形が違うことに注意。

### 5.3 UiaEventHandlerOwner の Drop 安全性

```rust
// src/uia/event_handlers/owner.rs (擬似コード、handler factory が Arc<EventRing> 受け取りに変わったため
// owner 自体の signature は v1 から変化なし)

use windows::Win32::UI::Accessibility::{
    IUIAutomation, IUIAutomationCacheRequest, IUIAutomationFocusChangedEventHandler,
};

pub(crate) struct UiaEventHandlerOwner {
    automation: IUIAutomation,
    focus_handler: Option<IUIAutomationFocusChangedEventHandler>,
    // P5c-3 で追加: window_handler: Option<IUIAutomationEventHandler>,
    // P5c-4 で追加: scroll_handler: Option<IUIAutomationPropertyChangedEventHandler>,
}

impl UiaEventHandlerOwner {
    pub(crate) fn new(automation: IUIAutomation) -> Self {
        Self { automation, focus_handler: None }
    }

    pub(crate) fn register_focus(
        &mut self,
        cache_request: &IUIAutomationCacheRequest,
        handler: IUIAutomationFocusChangedEventHandler,
    ) -> windows::core::Result<()> {
        unsafe {
            self.automation.AddFocusChangedEventHandler(cache_request, &handler)?;
        }
        self.focus_handler = Some(handler);
        Ok(())
    }
}

impl Drop for UiaEventHandlerOwner {
    fn drop(&mut self) {
        // R3: Remove 忘れリーク防止。Drop で ? できないので best-effort。
        // failure 時も log のみで panic させない (Drop 内 panic は二重 unwind 危険)。
        if let Some(h) = self.focus_handler.take() {
            unsafe {
                if let Err(e) = self.automation.RemoveFocusChangedEventHandler(&h) {
                    eprintln!("[uia-event-handler] RemoveFocusChangedEventHandler failed: {e}");
                }
            }
        }
    }
}
```

### 5.4 Shutdown ordering (P5c plan §6.4 / D1 plan §5.3 と完全整合)

```
shutdown 開始 (現状: P5c-1 単独で完結する範囲)
  ↓
1. shutdown_uia_for_test(3s) ← UIA thread に shutdown_tx で signal
  ↓
2. com_thread_main の select! が shutdown_rx を受信して loop exit
  ↓
3. drop(event_owner) で UiaEventHandlerOwner::Drop 実行
   → automation.RemoveFocusChangedEventHandler(&handler)
  ↓
4. unsafe { CoUninitialize(); } (既存、apartment 終了)
  ↓
5. shutdown_l1_for_test(3s) (R11 fix の polling shape で recoverable)
  ↓
ring 全 drop 完了
```

将来 ADR-008 D1-2 完成時は `0. l3_bridge::focus_pump.shutdown(2s)` が先頭に追加 (D1 plan §5.3)。本 PR では bridge 未実装なので 1 から始まる。

### 5.5 com_thread_main 統合の最小 diff (Codex v1 P1 反映)

```rust
// src/uia/thread.rs::com_thread_main の追加分のみ抜粋

fn com_thread_main(rx: Receiver<UiaTask>, shutdown_rx: Receiver<()>) {
    unsafe { /* CoInitializeEx 既存 */ }

    let ctx = match build_context() { /* 既存 */ };

    // ─── P5c-1 追加: UIA event handlers register ─────────────────────────
    let mut event_owner = event_handlers::UiaEventHandlerOwner::new(ctx.automation.clone());
    // Codex v1 P1: Arc<EventRing> を取り出す (L1Inner は private、ring field は pub)
    let ring = crate::l1_capture::ensure_l1().ring.clone();
    let focus_handler = event_handlers::focus::make_focus_handler(ring);
    if let Err(e) = event_owner.register_focus(&ctx.cache_request, focus_handler) {
        eprintln!("[uia-com] AddFocusChangedEventHandler failed: {e} -- focus events disabled");
        // continue without focus handler -- non-fatal (Tier 1 graceful disable と整合)
    }
    // ─────────────────────────────────────────────────────────────────────

    loop { /* 既存 select! */ }

    // ─── P5c-1 追加: handler を CoUninitialize 前に明示 drop ─────────────
    drop(event_owner);
    // ─────────────────────────────────────────────────────────────────────

    unsafe { CoUninitialize(); } // 既存
}
```

`ctx.automation.clone()` は `IUIAutomation` (COM interface) の clone で、`AddRef` 相当。Drop で `RemoveFocusChangedEventHandler` 呼ぶときに同じ COM interface を参照するため、handler register 時の automation と Drop 時の automation が同一インスタンスである必要がある (これは clone で同じ COM object を指すので OK)。

---

## 6. Risks / Mitigation

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **R1** | UIA event handler 内 panic で UIA thread 全滅 → 以後 event 来ない | 致命 | handler 内最外周で `catch_unwind`、panic 時 ring に Failure event push (handler 自体も graceful 続行)。com_thread_main の task loop も既存の `catch_unwind` で二重保護 |
| **R2** | UIA event delivery thread が deadlock or block | 高 | handler 内は **すべて Cached* methods のみ**、live UIA call 禁止 (P5c plan §4 P5c-0b で確定)。`get_window_text` (Win32 GetWindowTextW) は < 1ms 想定だが念のため bench で確認 |
| **R3** | `RemoveFocusChangedEventHandler` 忘れによるリーク | 中 | `Drop for UiaEventHandlerOwner` で必ず Remove。shutdown ordering を §5.4 で確定、5-cycle test で leak なし確認 |
| **R4** | windows-rs 0.62 の `#[implement]` macro が `IUIAutomationFocusChangedEventHandler` trait を正しく扱えるか (本リポジトリ初使用) | 中 | windows-rs 0.62 docs + sample で確認 (sample 例: <https://github.com/microsoft/windows-rs/tree/master/crates/samples>)。ダメな場合: 手動 vtable で代替 |
| **R5** | UIA cache request に `UIA_NativeWindowHandlePropertyId` が **load されていない** インスタンスが渡される | 低 | P5c-0b で `configure_cache_properties` に追加済 (`thread.rs:283`)、本 PR では同 cache_request を `register_focus` に渡すので一致。test §3.4.2 Test 4 で slow_path == 0 を確認 |
| **R6** | hwnd → window_title の `GetWindowTextW` が削除済 window で blocking や空文字、または **child hwnd で空文字 → acceptance fail** (Codex v1 P2 #1) | **中** | (a) 既存 `win32_get_window_text` の挙動 (空文字 return) を踏襲。delivery thread でも < 1ms。(b) **`get_root_hwnd(GA_ROOT)` で top-level に正規化してから取得**することで child focus の場合も Notepad 等の root window title が安定取得可。(c) acceptance §8.1 で「root-resolved case で title 非空」と限定 (root が title を持たない window はそのまま空 OK) |
| **R7** | integration test で Notepad が pre-installed じゃない (CI runner / 一部 Win 環境) | 低 | `notepad.exe` 起動失敗時は `eprintln + return Ok(())` で graceful skip。Linux/Mac は `#[cfg(target_os = "windows")]` で除外 |
| **R8** | ~~handler 内で `ensure_l1()` を呼ぶと recursive lock の可能性~~ → **Codex v1 P1 反映で構造的解決** | (解消) | handler 構築時に **`Arc<EventRing>`** を握って handler 内に保持 (`make_focus_handler(ring)` 経由)、handler 内で `ensure_l1()` を呼ばない & `L1Inner` を一切触らない構造。**privacy 問題も同時解消** (`L1Inner` import 不要、`EventRing` のみ import) |
| **R9** | win32 helper extract で既存 napi wrapper の挙動が変わる | 低 | extract は中身 move のみ、`win32_get_window_text` の `napi_safe_call` wrap は維持。既存 vitest test で regression 確認 (§3.4.3) |
| **R10** | Drop 内で `RemoveFocusChangedEventHandler` 失敗時の panic で二重 unwind | 中 | Drop 内は `if let Err(e) = ... { eprintln!() }` で必ず吸収、panic させない (擬似コード §5.3) |
| **R11** | `GetAncestor(hwnd, GA_ROOT)` が `HWND(0)` を返した場合 (失敗 / 既に root / 入力が破損 hwnd) の handling | 低 | `get_root_hwnd` 内で `0` を返したら入力 hwnd をそのまま返す best-effort fallback (§3.1.2 確定) |

---

## 7. Open Questions

| # | OQ | 決定タイミング |
|---|---|---|
| 1 | windows-rs 0.62 の `#[implement]` で `Ref<'_, IUIAutomationElement>` の handling 細部 (`as_ref()` の正確な戻り値型) | 実装着手時、windows-rs 0.62 source 確認 |
| 2 | integration test の target window として Notepad / 自前 fixture window のどちらを使うか | test 書く時、Notepad の方が「実環境に近い」が fixture window の方が deterministic — Notepad で start、不安定なら fixture window に切替 |
| 3 | `tracing` log で cache hit/miss を計測する level (info / debug) | implement 後、production noise を見て判断 |
| 4 | `UIA_FocusChangedEvent` が child element に対しても発火する頻度 → ring overflow の可能性 | implement 後 bench で測定、必要なら rate limit (本 PR 範囲では rate limit なし、観測後に判断) |
| 5 | `cached_element_to_focus_info` の現状 doc コメント (「The bridge handles `hwnd == 0` explicitly」) を P5c-1 で「root 正規化は handler 側、bridge 側は `hwnd == 0` をそのまま渡す」に明示更新するか | 本 PR で update する (focus.rs cached_focus_info module 内 docコメントの軽微更新、§3.5 docs flip に追記候補) |

---

## 8. Acceptance Criteria

P5c plan §11.3 と完全一致 + 細分化:

### 8.1 機能 (Codex v1 P2 #1 反映で window_title 条件を refine)
- [ ] safe target (Notepad) で UIA focus 移動 → `EventKind::UiaFocusChanged` event が ring に push される
- [ ] resolvable focus event で **`payload.after.hwnd != 0`** (P5c plan §11.3 + Codex review v3 P2 + v4 P2-2)
- [ ] **少なくとも 1 件の event で `payload.window_title` が root window 由来の非空 string** (本 PR で `get_root_hwnd(GA_ROOT)` 正規化が実装されているため Notepad の root window title が取れるはず、Test 1b で確認)
- [ ] `payload.window_title == ""` 自体は **valid** (root が title を持たない window の場合、本 PR では graceful)
- [ ] unresolvable case (`hwnd == 0` / `payload.after == None` 相当) でも graceful (skip / panic / abort なし)
- [ ] `payload.before` は None (本 PR scope)

### 8.2 API 形 (Codex P5c plan v2 P2 mismatch 対策)
- [ ] `AddFocusChangedEventHandler(cache_request, handler)` を **2 引数**で正しく呼び出し (5 引数の `AddAutomationEventHandler` と混同しない)

### 8.3 性能・安全
- [ ] **`UIA_NativeWindowHandlePropertyId` cache hit 確認**: integration test §3.4.2 Test 4 で `slow_path == 0` (cached_element_to_focus_info 内で live call が走らない)
- [ ] handler 内 panic で UIA thread / Node プロセス全滅しない (integration test §3.4.2 Test 3)
- [ ] handler 内 panic 時、ring に `Failure` event が push される (観測可能)

### 8.4 shutdown / lifecycle
- [ ] shutdown 時 `RemoveFocusChangedEventHandler` が呼ばれる (Drop trace で確認)
- [ ] **5-cycle `ensure_uia_thread → shutdown_uia_for_test`** で leak / crash / deadlock なし (integration test §3.4.2 Test 2、P5c-0b の `shutdown_and_restart_5_cycles` と同水準だが handler register/Remove も巡回)

### 8.5 既存 path 不変 (Codex v1 P2 #2 反映で baseline failure 切り出し)
- [ ] **`cargo check --workspace`** pass (workspace 全体 type check、既存 baseline failure と独立)
- [ ] **`cargo test --lib --no-default-features uia::event_handlers`** pass (新規 module の compile + smoke)
- [ ] **`cargo test --test uia_focus_hook --no-default-features`** pass (本 PR の integration test)
- [ ] **vitest 2435 pass / 0 regression** (§3.4.3、`desktop_state` 等の UIA 経由 napi tool が壊れていないこと、特に win32 helper extract の副作用確認)
- [ ] **既知 baseline failure は本 PR scope 外** (別 follow-up):
  - `cargo test --lib --no-default-features uia::thread` の test-binary ACCESS_VIOLATION (R12 PR で main 状態でも再現確認済、stash 検証済)
  - `cargo test --lib` の `vision_backend` 4 件 compile error (memory `project_2026_04_29_session.md` §γ)
  - `npm run build:rs` の toolchain mismatch (rustup gnu vs napi-cli msvc target dir)

### 8.6 docs
- [ ] ADR-007 §6.1 / §9.1 P5c row 進捗 update
- [ ] `docs/adr-007-p5c-plan.md` §4 P5c-1 sub-batch checklist `[x]` flip
- [ ] `docs/adr-008-d1-plan.md` §1.3 D1-2 前提が満たされた旨を記述
- [ ] (任意) `src/uia/focus.rs` cached_focus_info module の doc コメント update (root 正規化は handler 側責務、§7 OQ#5)

---

## 9. ADR-008 D1 への接続 (本 PR 完了で blocker 解除)

PR-P5c-1 merged 時点で:
- L1 ring に **real `UiaFocusChanged` event** が流れ始める
- ADR-008 D1-2 (`src/l3_bridge/focus_pump.rs` 実装) が着手可能になる
- D1 plan §1.3 「D1-2 着手前の前提 (ADR-007 P5c-1)」が解除
- D1 acceptance「TS 版より latency 1/10」が **real input** で計測可能に

**次の作業 (本 PR 完了後)**:
1. ADR-008 D1-2 (`src/l3_bridge/focus_pump.rs` 実装 + EventRing broadcast 化) — D1 plan §3 D1-2 sub-batch
2. ADR-008 D1-3 (`current_focused_element` view in engine-perception) — D1 plan §3 D1-3
3. ADR-008 D1-4 (unit test) — D1 plan §3 D1-4
4. ADR-008 D1-5 (bench harness) — D1 plan §3 D1-5

これにより ADR-008 D1 acceptance「Whole-System Dataflow」(統合書 §1.1 / P3) が成立。

---

## 10. 関連

- 親 plan: `docs/adr-007-p5c-plan.md` (Draft v4)
- 親 ADR: `docs/adr-007-koffi-to-rust-migration.md` (§6.1 / §9.1 / §8 R11/R12 Resolved)
- D1 blocker plan: `docs/adr-008-d1-plan.md` §1.3 / §3 D1-2 / §11
- 既存 UIA module: `src/uia/{thread,focus,types}.rs`
- 既存 L1: `src/l1_capture/{ring,worker,payload,envelope,mod}.rs` (本 v2 で visibility 確認済: `EventRing` `pub` re-exported / `L1Inner.ring` `pub` field)
- 既存 win32 helper: `src/win32/window.rs` (本 PR で `get_window_text` extract + `get_root_hwnd` 新設)
- L3 bridge scaffold: `src/l3_bridge/mod.rs` (本 PR では fill しない)
- 関連 PR (履歴):
  - #84 (P5c-0b foundation、`e612aad`)
  - #86 (R11 L1 worker shutdown fix、`9fcfdeb`)
  - #87 (R12 UIA shutdown race fix、`6d30170`)
  - #本 PR (P5c-1 UIA Focus Changed hook、ADR-008 D1 blocker 解除)
- judgment lesson: `memory/feedback_north_star_reconciliation.md` (synthetic pivot 否決の経緯)
- Codex review 履歴:
  - v1 → Codex (P1×1 privacy + P2×1 window_title 不安定 + P2×1 acceptance baseline 過剰要求) → v2
  - **v2 → Codex (P1×1 残 privacy: `payload` module も private、struct は re-export 経由必要) → v3 (本書)**
  - 実装後 PR review (Sonnet 委譲しないため Opus self-review + Codex review 1-2 ラウンド想定)
