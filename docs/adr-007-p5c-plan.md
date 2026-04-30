# ADR-007 P5c — 観測系 event 生成 (拡大スコープ) プラン

- Status: **Draft v4 (Codex review v3 反映、Opus)**
- Date: 2026-04-29
- 親 ADR: `docs/adr-007-koffi-to-rust-migration.md`
- SSOT: `docs/architecture-3layer-integrated.md`
- 後続: `docs/adr-008-d1-plan.md` (本書完了後に real L1 接続で復帰、PR-P5c-0a で同時更新)
- review history:
  - v1 → Codex (P1×1 + P2×4 + P3×1 + 整合性メモ) → v2
  - v2 → Codex (P1×1 + P2×3 + 漏れ 1) → v3
  - v3 → Codex (P2×1 + P3×1) → **v4 (本書)**

---

## 1. Background — なぜ scope 拡大か

### 1.1 P5a までの状態

ADR-007 §6.1 の P5 subphase 当初定義:
- P5a: EventEnvelope schema + ring buffer
- P5b: WAL + replay E2E
- P5c: **DXGI dirty rect 統合 + Tier dispatch**
- P5d: timestamp source 多重化

**P5a 完了** (2026-04-29): main 直 push 8 commits `20c95da..2b631bf` (PR 経由ではない、メモリ `project_adr007_p5a_done.md` 参照)。これで以下が揃った:
- `EventKind` enum 全種 (観測系 7 / 副作用系 3 / システム系 3 / replay 系 2、`src/l1_capture/envelope.rs:62-83`)
- ring buffer (`src/l1_capture/ring.rs`)
- worker thread (heartbeat / SessionStart / SessionEnd を push)
- 副作用系 + システム系 + replay 系の payload struct (`src/l1_capture/payload.rs:3-51`、`ToolCallStarted/Completed`、`HwInputPostMessage`、`Failure`、`Heartbeat`、`SessionStart/End`)
- napi exports 7 個 (l1Poll など)

### 1.2 P5b 名前空間の bookkeeping

PR #80 (`eea3d9e`、merged 2026-04-29) で `docs/adr-007-p5b-evaluation.md` を導入し、**`#[napi_safe]` proc_macro 化を「P5b」と呼んで保留決定**した。一方 ADR-007 本体 §6.1 / §9.1 / §10 では依然 **「P5b: WAL + replay E2E」** の記述が残っている。

→ **P5b の意味が二重定義**。本 plan §3 で ADR-007 を更新し、WAL/replay を **ADR-008 D6 へ移管** (SSOT §10.2 と整合)、P5b 名は proc_macro 評価で消費済として deprecate。

### 1.3 ADR-008 D1 着手前に判明した gap

`EventKind::UiaFocusChanged = 1` などの観測系 enum 値は P5a で定義済。しかし:
- **観測系 payload struct (`UiaFocusChangedPayload` / `DirtyRectPayload` / `WindowChangedPayload` / `ScrollChangedPayload`) は実装ゼロ** (副作用系 + システム系 + replay 系のみ存在)
- これらを ring に push する emitter code もゼロ
- ADR-007 のどの phase にも「観測系 event の生成」は割り当てられていない

→ **P5c のスコープを「観測系 event 全般 + Tier 1 graceful disable」に拡大**。判断の lesson: `memory/feedback_north_star_reconciliation.md`。

---

## 2. Scope

### 2.1 本 P5c で実装するもの

| # | 範囲 | 出力 EventKind | 後続 view (ADR-008) |
|---|---|---|---|
| **P5c-0** | payload struct 追加 + UIA thread shutdown 機構 + L3 bridge scaffold (root → engine-perception 依存) | (基盤) | (D1-2 が利用) |
| **P5c-1** | UIA Focus Changed event hook | `UiaFocusChanged` (=1) | `current_focused_element` (D1) |
| **P5c-2** | DXGI dirty rect → ring | `DirtyRect` (=0) | `dirty_rects_aggregate` (D2) |
| **P5c-3** | UIA Window Changed hooks (open/close/foreground) | `WindowChanged` (=5) | `semantic_event_stream` (D2) |
| **P5c-4** | UIA Scroll Changed hooks | `ScrollChanged` (=6) | `semantic_event_stream` (D2) |

### 2.2 本 P5c で実装しないもの (担当 phase 明示)

| 項目 | 担当 phase | 備考 |
|---|---|---|
| `UiaTreeChanged` (=2) / `UiaInvoked` (=3) / `UiaValueChanged` (=4) emit | 将来 (ADR-008 D2 で必要が出たら個別追加) | enum/payload struct は本 P5c では reserved |
| **WAL persistence + replay E2E** | **ADR-008 D6 へ移管** (元 P5b) | 本 plan §3 で ADR-007 §6.1 修正 |
| Tier dispatch 本格 cascade (T0/T1/T2/T3) | **ADR-008 D5** | 本 P5c では DXGI 利用不可時の graceful disable + Failure event log のみ |
| timestamp source 多重化 | **P5d** | 本 P5c では `TimestampSource::StdTime` 統一 |
| `#[napi_safe]` proc_macro 化 | P5b 保留決定 (PR #80) | 本 P5c では既存 manual `napi_safe_call` 流用 |
| **engine-perception → root crate 依存** | **採用しない** (Codex review v2 P1) | engine-perception は napi 非依存・純 Rust の約束を維持。代わりに **root crate 内の bridge 経由**で engine-perception に decoded data を push する (本 plan §6 / §12) |

---

## 3. ADR-007 への修正提案 (PR-P5c-0a で同梱)

### 3.1 §6.1 PR 単位 granularity

```diff
  - P5a: EventEnvelope schema + ring buffer (TS API は変えない)
- - P5b: WAL + replay E2E (record モード default off で導入)
- - P5c: DXGI dirty rect 統合 + Tier dispatch
+ - P5b: (consumed) `#[napi_safe]` proc_macro 評価 — 保留決定 (PR #80、`docs/adr-007-p5b-evaluation.md`)
+ - P5c: 観測系 event 生成 (UIA hooks + DXGI dirty rect + Scroll/Window) + Tier 1 graceful disable
+ - WAL + replay E2E は **ADR-008 D6 へ移管** (SSOT §10.2 / ADR-008 §4 D6 と整合)
  - P5d: timestamp source 多重化 (Reflex/DXGI/DWM)
```

### 3.2 §9.1 Phase 単位 acceptance

```diff
- | P5b | WAL に fsync 10ms batch、replay E2E で 1 session 再生成功 |
+ | P5b | (consumed) proc_macro 評価で保留決定 — acceptance: `docs/adr-007-p5b-evaluation.md` の「復活条件」が観測されないこと |
- | P5c | DXGI dirty rect を `EventKind::DirtyRect` として emit、Tier 1 cascade 動作 |
+ | P5c | 観測系 event 7 種 (UiaFocusChanged / DirtyRect / WindowChanged / ScrollChanged を **emit**、TreeChanged / Invoked / ValueChanged は enum + payload struct を **reserved**) を実装、Tier 1 graceful disable 動作。WAL/replay は本 ADR scope 外 (ADR-008 D6) |
```

### 3.3 §10 OQ + §11.3 (省略部分)

- OQ #2「WAL rotation サイズ」→ ADR-008 D6 へ移管 (本 ADR から削除)
- OQ #3「DXGI secondary monitor」→ P5c-2 着手時 (本 plan §10 OQ #3 と同期)
- §11.3 「replay 一致率」記述を「ADR-008 D6 で測定」に書き換え

---

## 4. Sub-batch 分解 (checklist)

### P5c-0a: plan + ADR-007 修正 + D1 plan 整合更新 (PR 1)
- [ ] `.gitignore` に `!docs/adr-007-p5c-plan.md` 追加 (tracking 化)
- [ ] 本 plan doc を tracked 化
- [ ] ADR-007 §6.1 / §9.1 / §10 / §11.3 の修正適用 (本 plan §3 通り)
- [ ] **`docs/adr-008-d1-plan.md` の整合更新** (Codex review v2 P2 D1 plan 不整合):
  - [ ] §3 D1-0 checkbox を `[x]` に flip (PR #81 で完了済)
  - [ ] §3 D1-1 checkbox を `[x]` に flip (PR #82 で完了済、本 plan の前任 PR で flip 漏れ)
  - [ ] §1.2 「D1 で実装しないもの」に「**D1-2 (real L1 adapter) 着手前**に ADR-007 P5c-1 完了が前提」を追記 (Codex review v3 P3、D1-0/D1-1 は完了済のため「D1 着手前」では衝突)
  - [ ] §2 / §5 を **root owns integration** 経路に更新: 「`Arc<L1Inner>` を engine-perception に渡す」→ 「**root crate 内の `src/l3_bridge/` adapter** が L1 ring を decode して engine-perception の `L1Sink` に push、engine-perception は napi 非依存・純 Rust crate のまま」
  - [ ] §3 D1-2 sub-batch checklist を新経路で書き直し (`engine-perception::FocusInput` / `L1Sink trait` / `crates/engine-perception/src/input.rs`)
  - [ ] §11 acceptance に「root crate 内 bridge が L1 ring → engine-perception sink 経路で動作」追加
- [ ] CI green (docs only、type check 影響なし)

### P5c-0b: 基盤コード (PR 2)
- [ ] `src/l1_capture/payload.rs` に観測系 payload struct を追加 (Codex review v3 P2: D1 が hwnd / window_title を復元できる shape にする):
  - **`UiElementRef { hwnd: u64, name: String, automation_id: Option<String>, control_type: u32 }`** ← ADR-007 §4.2 で未定義の shape を本 plan で確定。`hwnd: 0` は unresolved (focus element が child で window 解決不可) を示す
  - `UiaFocusChangedPayload { before: Option<UiElementRef>, after: Option<UiElementRef>, window_title: String }` (ADR-007 §4.2 の shape、top-level `window_title` あり)
  - `DirtyRectPayload { rect: [i32; 4], monitor_index: u32, frame_index: u64 }` (ADR-007 §4.2 の `DirtyRectPayload` 寄せ、`kind` は本 P5c では Update のみ)
  - `WindowChangedPayload { kind: WindowChangeKind, hwnd: u64, title: String, process_name: String }` (`enum WindowChangeKind { Opened, Closed, Foreground }`)
  - `ScrollChangedPayload { hwnd: u64, h_percent: f32, v_percent: f32 }`
- [ ] `mod.rs` の `pub use payload::{..., UiElementRef, UiaFocusChangedPayload, ...}` に追加
- [ ] **`src/uia/thread.rs` に shutdown 機構を追加** (本 plan §6.2):
  - 現状 `OnceLock<Sender<UiaTask>>` のみ → `OnceLock<Mutex<Option<Arc<UiaThreadHandle>>>>` に変更
  - `pub(crate) fn shutdown_uia_for_test(timeout: Duration)` を追加 (L1 と同型)
  - `UiaContext` に handler owner slot を保持できるよう拡張 (`event_owner: Option<Arc<UiaEventHandlerOwner>>`)
  - 5 サイクル shutdown/restart test (P5a と同等の検証)
- [ ] **`src/uia/thread.rs::configure_cache_properties` に `UIA_NativeWindowHandlePropertyId` を追加** (Codex review v3 P2: hwnd を Cached* で取得可能にするため必須)
- [ ] **`src/uia/focus.rs` に `pub(crate) fn cached_element_to_focus_info(elem: &IUIAutomationElement) -> Option<UiaFocusInfoExt>`** 新規追加 (Codex review v2 P2 + v3 P2):
  - Cached* methods のみ使用: `CachedName`, `CachedControlType`, `CachedAutomationId`, `CachedNativeWindowHandle` (上記 cache 追加で取得可)
  - 戻り値 `UiaFocusInfoExt`: 既存 `UiaFocusInfo { name, control_type, automation_id, value }` に **`hwnd: u64`** を追加した拡張 type (or `UiaFocusInfo` 自体に `hwnd: Option<u64>` を追加、既存 caller は None で互換維持)
  - **value は省略** (D1 範囲では `current_focused_element` view が value を要求しないため)。D2 以降で必要なら cached pattern 経由を検討
  - **`hwnd == 0` のとき** (`CachedNativeWindowHandle` が NULL = focus element が直接 window でない child): walker で root window へ辿って `CachedNativeWindowHandle` を取得 (cache に乗る)、それでも 0 ならそのまま 0 で返す (bridge 側で reject or default)
  - 既存 `element_to_focus_info` は napi polling 経由の caller (`get_focused_element` など) のため **そのまま残置**
- [ ] **`window_title` 取得は handler 側の責務**: hwnd 取得後に Win32 `GetWindowTextW` で window_title 取得 (既存 `src/win32/window.rs` の wrapper を流用、UIA polling より cheap、< 1ms 想定)
- [ ] **L3 bridge scaffold 新設** (本 plan §6 / §12 の核):
  - `Cargo.toml` の root crate dependencies に `engine-perception = { path = "crates/engine-perception" }` 追加
  - `src/l3_bridge/mod.rs` 新設 (空でも OK、実装は ADR-008 D1-2 で fill)
  - **root crate の `[lib] crate-type` は `["cdylib"]` のまま変更しない** (Codex review v2 P1: 逆方向の依存は採用しない、rlib 化不要)
- [ ] **`crates/engine-perception/src/input.rs` を新設**:
  - `pub trait L1Sink { fn push_focus(&self, event: FocusEvent); /* P5c-3/4 で window/scroll/dirty 追加 */ }`
  - `pub struct FocusEvent { hwnd: u64, name: String, automation_id: Option<String>, control_type: u32, window_title: String, wallclock_ms: u64, sub_ordinal: u32 }` (純データ型、windows-rs 依存なし)
  - 中身は scaffold (D1-2 で拡張)、`#[allow(dead_code)]` でも OK
- [ ] CI green、`build:rs:debug` artifact が従来 path に copy 成立、`check:rs-workspace` pass

### P5c-1: UIA Focus Changed event hook (PR 3、ADR-008 D1 の blocker) — **完了 (2026-04-30、`feat/adr-007-p5c-1-focus-hook`)**

詳細は `docs/adr-007-p5c-1-plan.md` (Draft v3、Codex plan-only review v2 反映)。Codex P1 (privacy) 反映で `Arc<L1Inner>` → `Arc<EventRing>` に変更、Codex P2 (window_title 不安定) 反映で `get_root_hwnd(GA_ROOT)` 正規化追加。

- [x] `src/uia/event_handlers/mod.rs` 新設
- [x] `src/uia/event_handlers/focus.rs`:
  - `IUIAutomationFocusChangedEventHandler` を windows-rs `#[implement]` で実装する `FocusEventHandler`
  - 内部 state: **`Arc<EventRing>`** (Codex review p5c-1 v1 P1: `L1Inner` は private、`EventRing` のみ re-exported のため scope 最小化)
  - `HandleFocusChangedEvent(sender)` で:
    - `catch_unwind` で panic catch、panic 時 `Failure` event を ring に push
    - `sender.ok()?` → `cached_element_to_focus_info()` (slow path 回避、Codex review v2 P2)
    - `get_root_hwnd(GA_ROOT)` で child→top-level 正規化 → `get_window_text(root)` で window_title 取得 (Codex review p5c-1 v1 P2 #1)
    - `UiaFocusChangedPayload` encode → `ring.push()`
- [x] `src/uia/event_handlers/owner.rs`:
  - `UiaEventHandlerOwner { automation: IUIAutomation, focus_handler: Option<IUIAutomationFocusChangedEventHandler> }`
  - **`Drop` 実装で `unsafe { automation.RemoveFocusChangedEventHandler(&handler) }`** (リーク防止、失敗時 eprintln only)
- [x] **register 経路** (Codex review v2 P2 API mismatch 反映):
  - **FocusChanged**: `automation.AddFocusChangedEventHandler(&cache_request, &handler)` ← **2 引数** (scope なし)
  - cache_request は既存 `UiaContext::cache_request` を流用 (P5c-0b で `UIA_NativeWindowHandlePropertyId` 追加済)
- [x] shutdown ordering (本 plan §6.4 で確定):
  1. `shutdown_uia_for_test(3s)` — UIA thread に signal
  2. UIA thread loop exit、明示的 `drop(event_owner)` → `UiaEventHandlerOwner.Drop` (`RemoveFocusChangedEventHandler`)
  3. `CoUninitialize`
  4. `shutdown_l1_for_test(3s)`
- [x] **win32 helpers extract / 新設** (副次 refactor、p5c-1-plan §3.1):
  - `pub(crate) fn get_window_text(hwnd: HWND) -> String` extract
  - `pub(crate) fn get_root_hwnd(hwnd: HWND) -> HWND` 新設 (`GetAncestor(GA_ROOT)`)
- [x] **`windows-core = "0.62"`** を Cargo.toml に直 dep 追加 (`#[implement]` macro が `::windows_core::IUnknownImpl` を参照するため)
- [x] integration test 代替 (本 PR では Notepad live は scope 外、follow-up):
  - Rust unit smoke (focus.rs `#[cfg(test)] mod tests`): handler 構築 + Drop sanity → 1/1 pass
  - 既存 5-cycle test (`thread.rs::shutdown_and_restart_5_cycles`): com_thread_main 改修により handler register/Remove 経路も自動 covered → 1/1 pass
  - vitest 2435 pass / 0 regression (win32 helper extract の副作用なし)
  - **follow-up**: vitest live integration test (Notepad MSStore alias hang 回避のため別 fixture window 検討) + tracing 経由の cached-path `slow_path == 0` 確認

### P5c-2: DXGI dirty rect emit (PR 4)
- [ ] `src/duplication/thread.rs` に `enable_l1_emit: AtomicBool` 追加、emit 経路を fork
- [ ] `device.rs` で DXGI 利用不可時 graceful disable + Failure event 1 度だけ log
- [ ] integration test

### P5c-3: WindowChanged hooks (PR 5、Codex review v2 P2 API shape 反映)
- [ ] `src/uia/event_handlers/window.rs`:
  - **`AddAutomationEventHandler(event_id, &root, scope, &cache_request, &handler)` ← 5 引数**
  - WindowOpened: `event_id = UIA_Window_WindowOpenedEventId`
  - WindowClosed: `event_id = UIA_Window_WindowClosedEventId`
  - foreground 切替は Win32 `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` で補完
- [ ] `UiaEventHandlerOwner` を拡張: `window_handler: Option<IUIAutomationEventHandler>`、`Drop` で `RemoveAutomationEventHandler` 呼び出し追加
- [ ] payload: `WindowChangedPayload { kind, hwnd, title, process_name }`
- [ ] integration test

### P5c-4: ScrollChanged hooks (PR 6、Codex review v2 P2 API shape 反映)
- [ ] `src/uia/event_handlers/scroll.rs`:
  - **`AddPropertyChangedEventHandler(&element, scope, &cache_request, &handler, &property_array)` ← 5 引数**
  - property_array: `[UIA_ScrollHorizontalScrollPercentPropertyId, UIA_ScrollVerticalScrollPercentPropertyId]`
  - element: 通常 `automation.GetRootElement()` (全 desktop)
- [ ] スロットリング: 16ms / frame ベース rate limit (`AtomicU64` last_emit_ms)
- [ ] `UiaEventHandlerOwner` を拡張: `scroll_handler: Option<IUIAutomationPropertyChangedEventHandler>`、`Drop` で `RemovePropertyChangedEventHandler`
- [ ] payload: `ScrollChangedPayload { hwnd, h_percent, v_percent }`
- [ ] integration test

---

## 5. PR 切り方

| PR | 範囲 | risk | size 想定 |
|---|---|---|---|
| **PR-P5c-0a** | plan doc tracking + ADR-007 §6.1/§9.1/§10/§11.3 修正 + **D1 plan §1.2/§2/§3/§5/§11 整合更新 + D1-0/D1-1 checkbox flip** | 極低 (docs only) | ~150 line + plan |
| **PR-P5c-0b** | payload struct + UIA thread shutdown 機構 + `cached_element_to_focus_info` + L3 bridge scaffold (root → engine-perception dep + `L1Sink` trait + `FocusEvent` 型) | 中 (root crate に engine-perception dep 追加が初体験) | 300-400 line |
| **PR-P5c-1** | UIA Focus Changed hook + handler owner + integration test (**ADR-008 D1 blocker**) | 高 (UIA COM event handling 初実装) | 300-400 line |
| **PR-P5c-2** | DXGI dirty rect emit | 中 | 150-200 line |
| **PR-P5c-3** | Window Changed hooks (UIA + Win32 EventHook) | 中 | 200 line |
| **PR-P5c-4** | Scroll Changed hooks (rate-limited) | 低 | 150 line |

PR-P5c-1 完了で **ADR-008 D1 着手可**。P5c-2/3/4 は ADR-008 D2 と並行進行可能。

---

## 6. UIA event handler 実装方針 (P5c-0b/P5c-1 中核)

### 6.1 既存 `src/uia/thread.rs` の現状 (full read 結果)

- COM thread: `OnceLock<Sender<UiaTask>>`、process-long、shutdown 経路なし
- COM mode: `CoInitializeEx(None, COINIT_MULTITHREADED)` (MTA、UIA event delivery と整合)
- task loop: `rx.recv()` で task 受信、panic は `catch_unwind` (eprintln のみ)
- `UiaContext`: `IUIAutomation` / walker / cache_request / control_view_condition、handler 保持なし
- cache_request: 7 property + 6 pattern が cache 済 (Name/ControlType/AutomationId/BoundingRectangle/IsEnabled/IsOffscreen/ClassName)

### 6.2 P5c-0b で追加する shutdown 機構

```rust
// 擬似コード — 既存 thread.rs を破壊的に変更しない、L1 worker と同型
pub(crate) struct UiaThreadHandle {
    sender: Sender<UiaTask>,
    shutdown_tx: Sender<()>,
    join_handle: Mutex<Option<JoinHandle<()>>>,
}

static UIA_THREAD: OnceLock<Mutex<Option<Arc<UiaThreadHandle>>>> = OnceLock::new();

pub(crate) fn ensure_uia_thread() -> Arc<UiaThreadHandle> { /* L1 と同型 */ }
pub(crate) fn shutdown_uia_for_test(timeout: Duration) -> Result<(), &'static str> { /* L1 と同型 */ }
```

ADR-007 §3.4.3 の「shutdown 3s 以内」を UIA thread にも適用。

### 6.3 UIA event handler の所有権 — register API は 3 系統で形が違う (Codex review v2 P2)

```rust
#[implement(IUIAutomationFocusChangedEventHandler)]
struct FocusEventHandler {
    l1: Arc<L1Inner>,
}

impl IUIAutomationFocusChangedEventHandler_Impl for FocusEventHandler_Impl {
    fn HandleFocusChangedEvent(
        &self,
        sender: Ref<'_, IUIAutomationElement>,
    ) -> windows::core::Result<()> {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if let Some(elem) = sender.as_ref() {
                if let Some(info) = crate::uia::focus::cached_element_to_focus_info(elem) {
                    // hwnd → window_title は Win32 GetWindowTextW (既存 windows-rs wrapper)。
                    // info.hwnd == 0 なら window_title 空、bridge 側 decode で reject 可。
                    let window_title = if info.hwnd != 0 {
                        crate::win32::window::get_window_title(info.hwnd).unwrap_or_default()
                    } else {
                        String::new()
                    };
                    let payload = UiaFocusChangedPayload {
                        before: None,                  // P5c-1 範囲では before track せず
                        after: Some(UiElementRef {
                            hwnd: info.hwnd,
                            name: info.name,
                            automation_id: info.automation_id,
                            control_type: info.control_type,
                        }),
                        window_title,                  // top-level (ADR-007 §4.2 shape)
                    };
                    let event = build_event(
                        EventKind::UiaFocusChanged as u16,
                        encode_payload(&payload),
                        None, None,
                    );
                    self.l1.ring.push(event);
                }
            }
        }));
        Ok(())
    }
}

struct UiaEventHandlerOwner {
    automation: IUIAutomation,
    focus_handler: Option<IUIAutomationFocusChangedEventHandler>,
    window_handler: Option<IUIAutomationEventHandler>,             // P5c-3
    scroll_handler: Option<IUIAutomationPropertyChangedEventHandler>, // P5c-4
}

impl Drop for UiaEventHandlerOwner {
    fn drop(&mut self) {
        // リーク防止 — 各 Remove* API も形が違う
        if let Some(h) = self.focus_handler.take() {
            unsafe { let _ = self.automation.RemoveFocusChangedEventHandler(&h); }
        }
        if let Some(h) = self.window_handler.take() {
            unsafe {
                let _ = self.automation.RemoveAutomationEventHandler(
                    UIA_Window_WindowOpenedEventId, /* root: */ &..., &h,
                );
                // WindowClosed も同様
            }
        }
        if let Some(h) = self.scroll_handler.take() {
            unsafe {
                let _ = self.automation.RemovePropertyChangedEventHandler(
                    /* element: */ &..., &h,
                );
            }
        }
    }
}
```

#### 各 register API の引数形 (windows-rs 0.62 / Microsoft docs ベース)

| Event 系 | Add API | 引数 | 対応 phase |
|---|---|---|---|
| FocusChanged | `AddFocusChangedEventHandler` | `(cache_request, handler)` 2 引数 (scope なし、root も指定しない — desktop 全体 default) | P5c-1 |
| AutomationEvent (WindowOpened/Closed) | `AddAutomationEventHandler` | `(event_id, root, scope, cache_request, handler)` 5 引数 | P5c-3 |
| PropertyChanged (Scroll) | `AddPropertyChangedEventHandler` | `(element, scope, cache_request, handler, property_array)` 5 引数 | P5c-4 |

### 6.4 shutdown ordering (統合書 §17.6 と整合)

```
shutdown 開始
  ↓
1. shutdown_uia_for_test(3s) ← UIA thread に signal
  ↓
2. UIA thread loop exit、UiaEventHandlerOwner Drop:
     - automation.RemoveFocusChangedEventHandler          (P5c-1 後)
     - automation.RemoveAutomationEventHandler            (P5c-3 後)
     - automation.RemovePropertyChangedEventHandler       (P5c-4 後)
  ↓
3. CoUninitialize
  ↓
4. shutdown_l1_for_test(3s)
  ↓
ring 全 drop 完了
```

UIA event は L1 ring を target にするため、L1 を先に止めると handler が orphan ring に push して Failure event 量産 → 逆順 (UIA → L1) が正しい。

---

## 7. DXGI dirty rect emit 方針 (P5c-2)

`src/duplication/` 既存 polling 経路に L1 emit fork 追加、capability detect 不可時は graceful disable + Failure event 1 度のみ log。本格 cascade は ADR-008 D5。

---

## 8. EventRing fan-out 戦略

現状 `EventRing::poll()` は **破壊的 drain** (single consumer 想定)。multi-consumer (既存 napi `l1Poll` + 将来 root-side bridge) 対応の時期:

**(A) P5c では emitter のみ追加、broadcast 化は ADR-008 D1-2 sub-batch に持ち越し** ← 推奨

理由:
- P5c の scope を「emitter の正しさ」に集中
- broadcast 化は consumer 設計 = ADR-008 側の関心事
- 北極星「次版送り禁止」と整合: D1 plan §3 D1-2 で必ず実装

PR-P5c-0a で D1 plan §3 D1-2 sub-batch 内に「ring を broadcast 化 (subscribe 別 cursor)」を明記 (現在の D1 plan からは欠けている、Codex review v2 P2 D1 plan 不整合への対応)。

---

## 9. Risks / Mitigation

| # | Risk | 影響 | Mitigation |
|---|---|---|---|
| R1 | UIA event handler 内 panic で UIA thread 全滅 → 以後 event 来ない | 致命 | handler 内で `catch_unwind` 必須、Failure event 化、UIA thread loop は既存の `catch_unwind` でも保護されている (二重) |
| R2 | UIA event delivery thread が deadlock or 死亡 | 高 | health-check thread (5s 周期 re-register attempt)、`server_status` に統計 |
| R3 | `Remove*EventHandler` 忘れリーク | 中 | `Drop for UiaEventHandlerOwner` で必ず Remove、shutdown ordering を §6.4 で確定 |
| R4 | 高頻度 event (Scroll) で ring 満杯、drop_count 急増 | 中 | P5c-4 で 16ms rate limit + drop メトリクス出力 |
| R5 | UIA cache_request hit せず slow path → p99 悪化 | 中 | `cached_element_to_focus_info()` で Cached* methods のみ使用、bench で hit rate 計測 |
| R6 | DXGI secondary monitor 扱い | 中 | P5c-2 着手時に decision、当面 primary monitor のみ |
| R7 | windows-rs 0.62 で `#[implement]` macro が UIA event handler trait を正しく扱えるか | 低 | windows-rs sample / docs で確認、ダメなら手動 vtable で代替 |
| R8 | root crate に engine-perception 依存追加で root build time が増加 | 低 | engine-perception は timely + DD のみ ~16s、root の vision-gpu/ORT/tokenizers と比べ加算は小、CI cache で吸収 |
| R9 | API mismatch を実装担当が踏む (FocusChanged 2 引数 vs Automation 5 引数) | 中 | 本 plan §6.3 表で API 形を明示、windows-rs sample へのリンクを sub-batch checklist に貼る |

---

## 10. Open Questions

| # | OQ | 決定タイミング |
|---|---|---|
| 1 | UIA event handler thread の COM mode 維持 (現状 MTA で OK か) | PR-P5c-0b 着手時、windows-rs sample 確認 |
| 2 | `EventRing::poll()` の broadcast 化実装方針 (cursor 別 / channel fan-out / etc) | ADR-008 D1-2 着手時 |
| 3 | DXGI secondary monitor 対応の是非 | P5c-2 着手時 |
| 4 | Scroll event rate limit 閾値 | P5c-4 着手時、bench 後 |
| 5 | `L1Sink` trait の API 名と method 数 (focus/dirty/window/scroll を 4 method or 1 method + enum) | PR-P5c-0b 着手時、ADR-008 D1-2 で実装する側の使い勝手を踏まえて |
| 6 | `cached_element_to_focus_info` の value 取得方針 (省略 / cached pattern / live ValuePattern) | D2 で `current_focused_element` 以外の view が value を要求した時 |

---

## 11. Acceptance Criteria

### 11.1 PR-P5c-0a (plan + ADR-007 修正 + D1 plan 整合)
- [ ] 本 plan doc tracked
- [ ] ADR-007 §6.1 / §9.1 / §10 / §11.3 が更新済 (P5b WAL 移管 / P5c 拡大スコープ)
- [ ] **D1 plan §3 D1-0 / D1-1 checkbox flip 済** (Codex 漏れ指摘)
- [ ] **D1 plan §1.2 / §2 / §5 / §3 D1-2 / §11 が「root owns integration」経路で書き直し済**
- [ ] CI green、`docs/` のみ変更で type check 影響なし

### 11.2 PR-P5c-0b (基盤コード)
- [ ] `payload.rs` に観測系 4 struct 追加、`mod.rs` re-export 追加
- [ ] `src/uia/focus.rs::cached_element_to_focus_info` 新規追加 (Cached* only、value 省略)
- [ ] `src/uia/thread.rs` に shutdown 機構追加、5 サイクル shutdown/restart test pass
- [ ] **`Cargo.toml` (root) に `engine-perception = { path = "crates/engine-perception" }`** 追加
- [ ] **root crate の `[lib] crate-type` は `["cdylib"]` のまま変更しない** (rlib 化なし)
- [ ] `src/l3_bridge/mod.rs` scaffold (空でも OK)
- [ ] `crates/engine-perception/src/input.rs` に `pub trait L1Sink` + `pub struct FocusEvent` 純データ型を追加
- [ ] CI green、`build:rs:debug` artifact が従来 path に copy 成立

### 11.3 PR-P5c-1 (UIA Focus hook、D1 blocker)
- [ ] safe target で UIA focus 移動 → `EventKind::UiaFocusChanged` event が ring に push
- [ ] **`AddFocusChangedEventHandler` を 2 引数 `(cache_request, handler)` で正しく呼び出し** (Codex P2 API mismatch)
- [ ] **resolvable な focus イベントで `payload.after.hwnd` が non-zero かつ `window_title` が空でない** (Codex review v3 P2 + v4 P2-2): bridge が `FocusEvent { hwnd, window_title, ... }` を組めることを ring 経由で verify。**unresolved case** (`hwnd == 0` / `payload.after == None`) も valid な data point として扱い、handler / bridge が panic / abort せず graceful に処理することを確認
- [ ] **`UIA_NativeWindowHandlePropertyId` が cache に乗っていることを確認** (`cached_element_to_focus_info` 内で slow path が走っていないか log で計測)
- [ ] handler 内 panic で UIA thread / Node プロセス全滅しない
- [ ] shutdown 時 `RemoveFocusChangedEventHandler` 呼ばれる、5 サイクル test
- [ ] integration test pass

### 11.4 PR-P5c-2 (DXGI dirty rect)
- [ ] 画面変化で `EventKind::DirtyRect` event が ring push
- [ ] 既存 napi polling と並行動作可
- [ ] DXGI 利用不可環境で graceful disable

### 11.5 PR-P5c-3 (Window Changed)
- [ ] WindowOpened / WindowClosed / Foreground 切替で event 発火
- [ ] `AddAutomationEventHandler` を 5 引数で正しく呼び出し
- [ ] integration test

### 11.6 PR-P5c-4 (Scroll)
- [ ] Scroll で event 発火、rate limit 効果確認
- [ ] `AddPropertyChangedEventHandler` を 5 引数で正しく呼び出し

### 11.7 全体共通
- [ ] CI green、`build:rs` / `check:napi-safe` / `check:rs-workspace` 全 pass
- [ ] ADR-007 §6.1 / §9.1 が拡大スコープに更新
- [ ] `docs/adr-008-d1-plan.md` が root owns integration 経路で整合

(担当者の auto-memory 更新は repo 外のローカル機構、本 plan acceptance には含めない)

---

## 12. ADR-008 D1 への接続 (root owns integration、Codex review v2 P1 反映)

### 12.1 経路図

```
[L1 Capture]                          [L3 bridge — root crate 内]            [engine-perception — 純 Rust]
src/l1_capture/ring.rs    ─poll─→  src/l3_bridge/focus_pump.rs  ─push─→  crates/engine-perception/src/input.rs
  (EventEnvelope を保持)              (decode + filter)                     (L1Sink trait + FocusInputHandle)
                                                                                       │
                                                                                       ▼
                                                                            timely InputSession
                                                                                       │
                                                                                       ▼
                                                                            crates/engine-perception/src/views/
                                                                            (current_focused_element view、D1-3)
```

### 12.2 PR-P5c-0b 完了時に確立される境界

- root crate (`desktop-touch-engine`):
  - L1 ring 所有 (`pub(crate) struct L1Inner`、変更なし — 公開しない)
  - `engine-perception` を dep として import
  - `src/l3_bridge/` で adapter 実装 (PR-P5c-0b は scaffold のみ、実装は ADR-008 D1-2)
- engine-perception:
  - **napi 非依存・純 Rust** (約束維持、Codex review v2 P1)
  - `L1Sink` trait、`FocusEvent` 純データ型、`FocusInputHandle` (timely InputSession wrapper) を public export
  - root crate 以外の external crate からは import されない (publish=false 維持)

### 12.3 ADR-008 D1-2 sub-batch (PR-P5c-0a で D1 plan を更新)

PR-P5c-0a で D1 plan §3 D1-2 を以下のように書き直す:

```diff
  ### D1-2: L1 → timely Input Adapter (PR 3 の前半)
- - [ ] `crates/engine-perception/src/l1_input.rs` 新設
- - [ ] L1 ring の `Arc<L1Inner>` を借りる API を `src/l1_capture/` に追加
- - [ ] adapter が独立 thread で `ring.pop()` → timely input session に push
+ - [ ] **`crates/engine-perception/src/input.rs`** (P5c-0b で scaffold 済) に `FocusInputHandle::push(FocusEvent)` 実装
+ - [ ] **`src/l3_bridge/focus_pump.rs`** (P5c-0b で scaffold 済、root crate 側) で adapter thread 実装
+ - [ ] adapter thread が `EventRing` を broadcast subscribe (cursor 別、本 plan §8 (A))
+ - [ ] L1 EventEnvelope を decode → `engine_perception::FocusEvent` に変換 → `FocusInputHandle::push()`
+ - [ ] `EventKind::UiaFocusChanged` のみを filter (D1 スコープ限定、他 event は drop)
+ - [ ] `(wallclock_ms, sub_ordinal)` を `Pair<u64, u32>` (logical_time) に変換
+ - [ ] L1 worker / UIA thread が停止しても adapter thread が deadlock しない
```

### 12.4 acceptance 達成

PR-P5c-1 完了で:
- L1 ring に **real `UiaFocusChanged` event** が流れる
- ADR-008 D1-2 で root crate 内 bridge が adapter thread で pump
- engine-perception 側 view (D1-3) が incremental に更新
- D1-5 bench で **real input** での「TS 版より latency 1/10」を真正に達成

これにより ADR-008 D1 acceptance「Whole-System Dataflow」(統合書 §1.1 / P3) が成立。

---

## 13. 関連

- 親 ADR: `docs/adr-007-koffi-to-rust-migration.md` (本 plan で §6.1 / §9.1 / §10 / §11.3 修正)
- SSOT: `docs/architecture-3layer-integrated.md` §1.1 / §3 P3 (Whole-System Dataflow) / §10.2 (replay は ADR-008 D6)
- 後続: `docs/adr-008-d1-plan.md` (本 plan PR-P5c-0a で §1.2/§2/§3/§5/§11 を root owns integration 経路に更新)
- 既存 UIA wrapper: `src/uia/{thread,focus,scroll,tree,actions,types}.rs`
- 既存 DXGI: `src/duplication/{device,thread,types,mod}.rs`
- 既存 L1: `src/l1_capture/{envelope,ring,worker,napi,payload,mod}.rs`
- review:
  - Codex v1 → 5 件 (P1×1 + P2×3 + P3×1 + 整合性メモ) 全件反映 (v2)
  - Codex v2 → 4 件 (P1×1 + P2×3) + 漏れ 1 全件反映 (v3)
  - Codex v3 → 2 件 (P2×1 payload shape + P3×1 D1 prerequisite 表現) 全件反映 (本 v4)
- judgment lesson: `memory/feedback_north_star_reconciliation.md`
