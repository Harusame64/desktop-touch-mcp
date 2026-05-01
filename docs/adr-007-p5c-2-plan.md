# ADR-007 P5c-2 — DXGI dirty rect → L1 ring emit (sub-plan)

- Status: **Drafted (2026-05-01)**
- Trigger: ADR-008 D2-C0 ゲート (PR #99) で `EventKind::DirtyRect` (=0) emit site **皆無**確認、`docs/adr-008-d2-plan.md` §3.bis carry-over ledger L1 で **ADR-007 P5c-2 を D2-C `dirty_rects_aggregate` view の prerequisite として外出し**決定 (Opus 判断 D2-C0-4: prerequisite 先行案)
- 親 plan: `docs/adr-007-p5c-plan.md` §11.4 (acceptance) + §7 (DXGI dirty rect emit 方針) + §10 OQ #3 (DXGI secondary monitor 是非)
- 後続 trigger: 本 PR merge → 翌 PR で **PR-ε (D2-C `dirty_rects_aggregate` view)** 着手 (`docs/adr-008-d2-plan.md` §3.bis ledger L1)
- 規模想定: 親 plan §5 で **150-200 line** 想定、本 sub-plan で詳細化後に再見積

---

## 1. Scope (本 sub-plan で扱う / 扱わない)

### 1.1 本 sub-plan で扱う

A. **DXGI duplication thread に L1 ring emit fork 追加** (`src/duplication/thread.rs::acquire_dirty_rects` で得た `Vec<DirtyRect>` を `EventKind::DirtyRect` envelope として L1 ring に push)
B. **`enable_l1_emit: AtomicBool` flag** (graceful disable / 既存 napi `DirtyRectSubscription` 単独使用ケースとの両立)
C. **DXGI 利用不可時 graceful disable** (capability detect 失敗 → Failure event 1 度のみ + emit 永続停止)
D. **AccessLost 系 graceful 復旧** (既存の context recreate 経路と同居、Failure event 重複 spam 防止)
E. **integration test** (frame 取得経路の Rust integration test で `EventKind::DirtyRect` の `ring.push` を pin、本 PR では mock context-based / `spawn(0)` + `Next` cmd の Rust 経由のみ。Notepad/Edge fixture で実 UIA 操作経由 induce する live test は §5 follow-up へ carry-over)
F. **payload `DirtyRectPayload` 充足** (既に `src/l1_capture/payload.rs:48` に定義済、`#[allow(dead_code)] // P5c-2 emit` marker を本 PR で削除可能)

### 1.2 本 sub-plan で扱わない (carry-over)

- **secondary monitor 専用機能** (親 plan §10 OQ #3): per-output 並行 thread / per-monitor 専用 view / secondary monitor 検出ロジック等の高度機能は OQ #3 で別 phase。**ただし** 既存 `spawn(output_index)` で受け取った output index を payload `monitor_index` に正しく載せること自体は本 PR の責務 (Codex P1-Codex-3、2026-05-01 確定 — 「carry-over」を理由に既存 multi-monitor 経路を破壊する regression は出さない、北極星整合)
- **Tier dispatch / cascade** (親 plan §1.1 G + ADR-008 D5): P5c-2 は emit のみ、Tier 別 backend dispatch は D5 carry-over
- **`DirtyRect` event の rate throttling** (親 plan §11.4 / R4): scroll と違い dirty rect は frame 駆動で本来 60Hz 上限。明示的 rate limit は不要、ただし ring 飽和時の `drop_count` 監視は P5c 全体共通の責務として §6 で扱う
- **`dirty_rects_aggregate` view 実装**: ADR-008 PR-ε (D2-C) で別 PR、本 PR はあくまで emit
- **`DirtyRectRouter` (TS 側) との API 変更**: 既存 napi `DirtyRectSubscription::next()` 経路は無改修、本 PR は thread 内で fork するのみで TS side ABI 不変

### 1.3 北極星整合 (親 plan §1.4 D + §11.7)

- **N1 (副作用系の決定論的 replay は P5d carry-over)**: 本 PR は emit のみ、replay determinism は本 scope 外
- **強制命令 9 (memory ではなく docs/)**: 残課題は本 plan + ADR-008 §3.bis ledger に永続化済
- **強制命令 7 (仕組みで対応)**: `enable_l1_emit` flag は test / graceful disable の両用途で構造的、`#[allow(dead_code)] // P5c-2 emit` marker 削除も「emit 漏れ」を compile-time シグナル化する仕組み (memory `feedback_structural_fixes.md` 整合)

---

## 2. 設計判断: emit 経路 (option A vs option B)

### 2.1 観察された前提 (現状 architecture full read 結果)

- `src/duplication/thread.rs::run_loop`: `DuplicationCmd::Next { timeout_ms, reply }` を受信したら `acquire_dirty_rects(ctx, timeout_ms)` を呼び出し、結果を `reply` channel に送信。**Next cmd を受けるまで thread は idle**
- `src/engine/vision-gpu/dirty-rect-source.ts::DirtyRectRouter._loop` (L83-113): `tickMs ?? 16` 間隔で `await this.sub.next(tick)` を loop、つまり **router 動作中は ~16ms (60Hz) で Next cmd が連続発行される**
- `DirtyRectRouter` は `src/tools/desktop-register.ts:340` で **v2 default-on (v0.17+) のときに常時 instantiate**、kill switch (`DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1`) でのみ disable

### 2.2 option A (採用候補): 既存 `acquire_dirty_rects` 内で emit fork

```rust
// 擬似コード
fn acquire_dirty_rects(ctx, timeout_ms, ring: &Arc<EventRing>, enable_l1_emit: &AtomicBool, frame_index: &AtomicU64) -> Result<Vec<DirtyRect>, ...> {
    // 既存処理: AcquireNextFrame + GetFrameDirtyRects + Vec<DirtyRect> 構築
    let dirty_rects = /* 既存のまま */;

    // ★ P5c-2: enable_l1_emit が true で rects が非空のとき L1 ring に push
    if enable_l1_emit.load(Ordering::Relaxed) && !dirty_rects.is_empty() {
        let frame_idx = frame_index.fetch_add(1, Ordering::Relaxed);
        let monitor_idx: u32 = 0; // primary only、§1.2 で carry-over
        for r in &dirty_rects {
            let payload = DirtyRectPayload {
                rect: [r.x, r.y, r.width, r.height],
                monitor_index: monitor_idx,
                frame_index: frame_idx,
            };
            let event = build_event(EventKind::DirtyRect as u16, encode_payload(&payload), None, None);
            ring.push(event);
        }
    }

    Ok(dirty_rects) // 既存の TS pull 経路には影響なし
}
```

**Pros**:
- 新 thread 不要、既存 architecture を最小変更
- v2 default-on のとき router が ~60Hz で pull → emit cadence が production frame change rate と整合
- TS pull 経路 (`DirtyRectSubscription::next`) と同じ DXGI frame に対し同じ rect set を emit、両者の整合性が自動的に取れる

**Cons**:
- v2 kill switch (`DESKTOP_TOUCH_DISABLE_FUKUWARAI_V2=1`) で router が停止すると emit も停止 — 「v2 OFF / D2-C `dirty_rects_aggregate` view ON」という構成では emit が来ない
  - 本 sub-plan の判断: **v2 OFF + view ON は実用構成として優先度低い** (v2 が default-on の現状、kill switch は v2 系統そのものの調査用途)。必要なら option B に pivot 可能、本 sub-plan §10 OQ #1 で記録
- emit cadence が router の `tickMs` (default 16ms) に依存 — 将来 router 側で tick 拡大されると emit も粗くなる

### 2.3 option B (carry-over 候補): 別 always-on consumer thread を新設

新 thread が `AcquireNextFrame(timeout_inf)` を回し、frame 取得ごとに L1 ring に push。既存 `DirtyRectSubscription::next` 経路は別 cmd channel で並行動作。

**Pros**: v2 ON/OFF に依存せず emit 連続、emit cadence が router 側設定と独立
**Cons**: 新 thread / 新 cmd state machine、DXGI duplication object の **同 output に対し 1 instance のみ許可**制約と衝突するリスク (TS pull thread と always-on thread が同 `IDXGIOutputDuplication` を共有できないと、output ごとに 2 instance 必要 → DXGI 制約違反の可能性)

### 2.4 判断: option A 採用、option B は §10 OQ #1 で carry-over

**理由**:
1. v2 default-on の production 構成で 60Hz emit が保証されるため、D2-C view の input として十分
2. DXGI 1 instance 制約に option B は抵触する可能性、解決には output 共有機構 (`IDXGIOutputDuplication` の clone は不可) または ring buffer で frame 共有が必要 — 工数大
3. 「強制命令 9 memory ではなく docs/」「N1 (carry-over reversibility)」精神で、option B は OQ で永続化、必要時に独立 PR で着手

---

## 3. 実装 sub-batch (本 PR 内)

### 3.1 P5c-2-1: payload + thread 内 emit fork (中核)

**実装パターン明示**: P5c-1 (passive event-driven、UIA event handler が register された瞬間から push) と異なり、本 PR は **既存 `acquire_dirty_rects` 内に emit を fork する pull-driven 経路**。`UiaEventHandlerOwner` 同型 owner pattern は採らない。

**設計原則 (P0-1 構造的整合)**: `DuplicationContext` 構造体は **無改修** (`device.rs::create_context` signature 影響なし、R6 整合)。L1 emit 用の `ring` / `enable_l1_emit` / `frame_index` 3 個の `Arc` は `run_loop` の引数として追加し、duplication thread のローカル変数として保持する。

- [ ] `src/duplication/thread.rs::run_loop` signature 拡張: `run_loop(ctx: &mut DuplicationContext, rx: Receiver<DuplicationCmd>, output_index: u32, ring: Arc<EventRing>, enable_l1_emit: Arc<AtomicBool>, frame_index: Arc<AtomicU64>)` (`DuplicationContext` 無改修、§6 R6 整合)
- [ ] `acquire_dirty_rects` も同 3 引数追加 (`ring: &Arc<EventRing>`, `enable_l1_emit: &Arc<AtomicBool>`, `frame_index: &Arc<AtomicU64>`)、`Vec<DirtyRect>` 構築完了後 §2.2 擬似コード通りに emit fork 実行
- [ ] `frame_index` 仕様: **duplication thread ローカル `Arc<AtomicU64>`、frame ごとに 1 ずつ increment、同 frame 内の N rect は同 `frame_index` を共有** (OQ #4 確定、views-catalog §3.2 の `summary { count, total_area }` aggregation が frame 単位 grouping を要求するため、event_id (event 単位) では代替不可)
- [ ] `spawn(output_index)`: `crate::l1_capture::ensure_l1().ring.clone()` を取得、`enable_l1_emit = Arc::new(AtomicBool::new(true))` で初期化、`frame_index = Arc::new(AtomicU64::new(0))` で初期化、これら 3 つを `run_loop` に move 渡し、`enable_l1_emit` の clone を `DuplicationHandle` にも 1 本持たせる
- [ ] `DuplicationHandle` (mod.rs) API 拡張: `enable_l1_emit: Arc<AtomicBool>` field 追加 + `set_l1_emit_enabled(bool)` method 追加 (graceful disable / test 用、AtomicBool 直書き)
- [ ] `src/duplication/mod.rs` の napi `DirtyRectSubscription` は **napi expose は変えない** (TS pull 経路無干渉)、`set_l1_emit_enabled` は internal API (Rust unit test から触れる、TS expose 不要)
- [ ] `src/l1_capture/payload.rs:50` の `#[allow(dead_code)] // P5c-2 emit` marker を削除 (P5c-2 emit が landing したため dead_code 警告が解消されることを compile-time で確認)

### 3.2 P5c-2-2: graceful disable + AccessLost 復旧

- [ ] **DXGI 利用不可時** (`create_context` Err 経路、boot_tx で boot_rx に Err 返却): 既存 graceful disable 経路維持、追加で **L1 ring に 1 度だけ** Failure event を push:
  ```rust
  // 4 引数: layer / op / reason / panic_payload (worker.rs:54 同型)
  let event = make_failure_event("duplication", "create_context", reason_str, None);
  ring.push(event);
  ```
  ※ `make_failure_event` の戻り値は push 可能な envelope、`worker.rs:54` 参照 (P5a 完了)
- [ ] **AccessLost 復旧経路**: 既存 `run_loop` で `Err(DuplicationError::AccessLost) → create_context → 新 ctx 採用 → reply には Err を返す` フロー維持。emit 側は AccessLost のフレームでは 0 rect 扱いで emit せず、context recreate 後の次フレームから emit 再開。**Failure event は重複 push しない** (`access_lost_count: AtomicU32` を duplication thread のローカル変数として持たせ、`run_loop` 内で update、**5 連続失敗で 1 度だけ Failure push、成功時 reset**)
- [ ] **AtomicBool 経由 disable test**: `set_l1_emit_enabled(false)` 後 `acquire_dirty_rects` 呼出で `EventKind::DirtyRect` event が ring に push されないことを unit test で pin

### 3.3 P5c-2-3: integration test

- [ ] `src/duplication/thread.rs` の `#[cfg(test)] mod tests`:
  - **Test 1**: `spawn(0)` 成功 / `set_l1_emit_enabled(true)` / `Next` cmd 1 回 / 戻り値の `Vec<DirtyRect>` 件数と ring 内 `EventKind::DirtyRect` event 件数が一致することを assert
  - **Test 2**: `set_l1_emit_enabled(false)` 後の `Next` cmd で **ring に DirtyRect event が増えない**ことを assert
  - **Test 3**: AccessLost simulate (mock context、`acquire_dirty_rects` を直接呼んで Err 返却 5 回) → Failure event が 1 件のみ push されることを assert
- [ ] vitest 経由の live test は P5c-1 と同様に **別 fixture window** で frame 変化を induce する必要あり、本 PR scope では Rust unit + integration test に限定 (vitest live integration は §5 follow-up)
- [ ] integration test は `#[cfg(all(test, target_os = "windows"))]` で gate (P5c-1 と同型)、CI on Windows runner で実行

### 3.4 P5c-2-4: bench (carry-over 確定、別 PR)

**Opus 判断 (2026-05-01)**: 別 PR (`P5c-2-bench`) で carry-over 採用、本 PR scope 外。理由: 親 §11.4 acceptance に bench 含まれず、本 PR scope を「emit + integration test」に絞る方が PR #94/#95 の Codex round 多発教訓 (sub-batch 切り効果) と整合。

- (carry-over) `benches/l1_capture.rs::bench_dirty_rect_60hz` (既存 skeleton in `benches/README.md` §2.1) を別 PR で本実装、60Hz emit が ring 飽和を引き起こさないこと (drop_count = 0) を pin。`§5 follow-up` 参照

---

## 4. PR 切り方

| sub-batch | 範囲 | size 想定 |
|---|---|---|
| **P5c-2 (本 PR、merged sub-batch)** | 3.1 emit fork + 3.2 graceful disable + 3.3 integration test 3 件 | 親 plan §5 想定 (150-200 line) と整合、本 sub-plan で 200-250 line に微増想定 |

**1 PR で land**、sub-batch 分割しない (規模が中・risk 中・bit-equal contract 不要 = production code の追加のみ、既存経路無干渉)。Opus phase-boundary review (強制命令 3) は本 PR merge 前必須。

---

## 5. follow-up (carry-over)

- [ ] **vitest live integration test**: 別 fixture window (Notepad MSStore alias hang 回避、memory `feedback_notepad_launcher_msstore_hang.md` 参照) で frame 変化を induce、`l1_pop` 経由で `EventKind::DirtyRect` 受信を pin。本 PR では Rust integration test のみ
- [ ] **`benches/l1_capture.rs::bench_dirty_rect_60hz` 本実装**: §3.4 で carry-over 判断した場合、別 PR (P5c-2-bench) で着手
- [ ] **secondary monitor 対応**: §10 OQ #3 (親 plan §10 OQ #3 と同型)、`output_index` ごとに別 thread + ring emit、必要なら別 phase
- [ ] **option B (always-on consumer thread)** への pivot: §10 OQ #1、option A で v2 OFF 時 emit 不在が production 課題化したら別 PR

---

## 6. Risks / Mitigation

| # | Risk | 影響 | Mitigation |
|---|---|---|---|
| R1 | `DirtyRectRouter` 停止時 (v2 kill switch) emit 不在 | 中 (option A の Cons) | §2.4 で OQ #1 carry-over、production 影響低い (v2 default-on) |
| R2 | DXGI 60Hz emit で ring 飽和 | 中 | `EventRing` capacity (現状 `L1_RING_CAPACITY` = 16384) と drop_count 統計で監視、60Hz × 1 dirty rect/frame = 60 emit/s はキャパ十分 |
| R3 | `frame_index: AtomicU64` の wraparound | 極低 | u64 で 60Hz 連続 emit でも 9.7e9 年、現実的に発生せず |
| R4 | AccessLost loop で Failure event spam | 中 | §3.2 の 5 連続失敗で 1 度のみ Failure push 機構で抑制 |
| R5 | `acquire_dirty_rects` 内 emit が新規所要時間で TS pull latency 悪化 | 中 | emit 部分は 60 rect × `ring.push` (lock-free atomic) で µs オーダ、TS pull (DXGI Acquire 自体 ~1ms) と比べ無視可能。bench で pin (§3.4 carry-over) |
| R6 | `ring`/`enable_l1_emit`/`frame_index` を `DuplicationContext` 拡張で渡すと既存 `device.rs::create_context` signature に影響 | 低 | `DuplicationContext` を拡張せず、`run_loop` の引数に `ring: &Arc<EventRing>`、`enable_l1_emit: &Arc<AtomicBool>`、`frame_index: &Arc<AtomicU64>` を追加するパターンで実装、既存 `create_context` 無干渉 |
| R7 | DXGI duplication thread の COM apartment (MTA) と L1 ring (Send + Sync) の互換性 | 低 | `EventRing` は既に `Send + Sync` (P5a 完了)、push は lock-free atomic、COM apartment 制約に抵触せず |
| R8 | `DirtyRectRouter` の `tickMs` 設定が将来変更され emit cadence が劣化 (default 16ms から拡大されると view fidelity 低下) | 低 (現状 16ms 固定で問題なし) | `tickMs` 変更時は ADR-008 D2-C view bench で emit cadence への影響を確認、必要なら option B pivot を OQ #1 で trigger。本 R8 は §2.2 Cons の structural mitigation |

---

## 7. Acceptance Criteria

### 7.1 親 plan §11.4 (PR-P5c-2) acceptance との対応
- [ ] 画面変化で `EventKind::DirtyRect` event が ring push (§3.3 Test 1)
- [ ] 既存 napi polling と並行動作可 (§3.1 で TS pull 経路無干渉、§3.3 Test 1 で `Next` cmd reply の `Vec<DirtyRect>` と ring push の rect set が同一 frame に対し一致)
- [ ] DXGI 利用不可環境で graceful disable (§3.2、Failure event 1 度のみ)

### 7.2 本 sub-plan 追加 acceptance
- [ ] `enable_l1_emit = false` で emit 停止 (§3.3 Test 2)
- [ ] AccessLost 5 連続で Failure event 1 件のみ (§3.3 Test 3、§6 R4)
- [ ] `src/l1_capture/payload.rs:50` の `#[allow(dead_code)] // P5c-2 emit` marker 削除、cargo check で `dead_code` warning 0
- [ ] cargo test --workspace 全 pass、追加 unit + integration test 全 pass
- [ ] `npm run check:napi-safe` / `check:native-types` / `check:stub-catalog` 全 pass (本 PR は napi 経路無改修なので false alarm のみ想定)
- [ ] **Opus phase-boundary review** (強制命令 3)、指摘ゼロまで反復

### 7.3 後続 trigger
- [ ] 本 PR merge を `docs/adr-008-d2-plan.md` §3.bis ledger L1 で **trigger 完了**として記録、翌 PR で **PR-ε (D2-C `dirty_rects_aggregate`)** 着手

---

## 8. Open Questions

| # | OQ | 決定タイミング |
|---|---|---|
| 1 | option B (always-on consumer thread) への pivot 是非 — v2 kill switch 状態で emit 不在が production 課題化するか | P5c-2 merge 後、ADR-008 D2-C `dirty_rects_aggregate` view の bench 結果を踏まえ Opus 判断 |
| ~~2~~ | ~~`benches/l1_capture.rs::bench_dirty_rect_60hz` を本 PR で enable するか別 PR (P5c-2-bench) で carry-over するか~~ | **Resolved (Opus 判断、2026-05-01)**: 別 PR (`P5c-2-bench`) で carry-over 採用。理由: 親 §11.4 acceptance に bench 含まれず、本 PR scope を「emit + integration test」に絞る方が PR #94/#95 の Codex round 多発教訓 (sub-batch 切り効果) と整合 |
| 3 | secondary monitor の **高度機能** (per-output 並行 thread / per-monitor 専用 view / detection logic) — 親 plan §10 OQ #3 | 別 phase、production 需要があれば着手。**注**: `spawn(output_index)` 経由の output index を payload `monitor_index` に正しく載せること自体は本 PR で実装済 (§3.1 / Codex P1-Codex-3 fix、2026-05-01)。本 OQ は **新機能** の追加 (= 既存 multi-monitor 経路の正しい扱いとは別軸) を carry-over する意味 |
| ~~4~~ | ~~`frame_index` を duplication thread ローカル AtomicU64 にするか、L1 ring 全体共通の monotonic counter にするか~~ | **Resolved (Opus 判断、2026-05-01、§3.1 反映済)**: duplication thread ローカル `Arc<AtomicU64>` を採用、frame 単位採番 (1 frame で N rect が同 `frame_index` を共有)。理由: views-catalog §3.2 が `summary { count, total_area }` を frame 単位で aggregate する仕様で、`frame_index` は「同 frame の rect を束ねるキー」として必須、event_id (event 単位、ring 全体共通) では役割が違うため代替不可 |

---

## 9. ADR-008 D2-C view との接続 (本 PR 完了後の道筋)

```
[L1 Capture]                        [L3 bridge — root crate 内]              [engine-perception — 純 Rust]
src/duplication/thread.rs ─push─→  src/l3_bridge/dirty_rect_pump.rs ─push─→ crates/engine-perception/src/views/dirty_rects_aggregate.rs
  (本 PR でここを実装)              (PR-ε D2-C で実装、focus_pump 同型)        (PR-ε D2-C で実装)
                                                                                       │
                                                                                       ▼
                                                                            timely operator graph:
                                                                              map → reduce(concat rects + summary) → inspect
                                                                                       │
                                                                                       ▼
                                                                            Arc<RwLock<DirtyRectsAggregateState>>
                                                                                       │
                                                                                       ▼
                                                                            napi `view_get_dirty_rects()` (PR-ε D2-C で TS expose、D2-B-1 PR #96 先例同型)
```

- 本 PR が emit 配線、view 実装は ADR-008 PR-ε (D2-C) で着手
- `dirty_rect_pump.rs` は `focus_pump.rs` (D1-2 PR #90) と同パターン: L1 ring broadcast subscribe + bincode decode + filter (DirtyRect kind only) + engine-perception input handle に push
- 両 PR の境界で **bit-equal 整合 0** (本 PR は emit のみ、view 側は別 crate)

---

## 10. 参照
- 親 plan: `docs/adr-007-p5c-plan.md`
- ADR-008 D2 plan: `docs/adr-008-d2-plan.md` §3.bis carry-over ledger L1
- ADR-008 D2-C0 確定 PR: #99 (`2c7c5e3`)
- 同型先例: `docs/adr-007-p5c-1-plan.md` (UIA Focus Changed event hook)
- 既存実装: `src/duplication/thread.rs` (本 PR 改修対象) / `src/uia/event_handlers/focus.rs` (P5c-1 emit 同型 reference)
- views-catalog: `docs/views-catalog.md` §3.2 (`dirty_rects_aggregate` 仕様)
