# ADR-008 D2-C — walking skeleton S2 / G2 alignment (dirty_rects_aggregate count-only contract spike)

- Status: **Drafted (2026-05-01、walking skeleton S2 contract spike へ再整理 2026-05-01)**
- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.3) §4 **S2** と §5 **G2 ゲート** の最小実装。本 sub-plan は trunk 内 S2 PR の scope を確定する
- Trigger: ADR-008 D2 plan §3.bis carry-over ledger **L1 trigger 完了** (ADR-007 P5c-2 PR #102 merged 2026-05-01、`c535fc2`)
- 親 plan: `docs/adr-008-d2-plan.md` §D2-C / §5 / §11.1 / §3.bis ledger L1
- 概念設計: `docs/adr-008-reactive-perception-engine.md` §3.2 + `docs/views-catalog.md` §3.2
- 対象 sub-batch: walking skeleton **S2 (PR 2)** — `dirty_rects_aggregate` count-only view 簡易版 + DXGI pump + napi + focus view 共存 (S1 で確立した同 scope に追加)

---

## 0. 方針転換 note (2026-05-01)

本 sub-plan は当初「`dirty_rects_aggregate` の **完成計画**」(full RectId list / union 計算 / 100ms sliding window / recent_n / 6 unit test) として起草されたが、**walking skeleton trunk selection 確定 (Proposed v0.3)** で D2-C は trunk S2 (count-only contract spike) として scope を絞ることに方針転換。

本書では各セクションに以下の 3 分類を明示:

- **[S2 trunk]**: 本 PR で必ず実装、G2 ゲートを通すための最小 contract
- **[expansion]**: trunk 完了後 (G2 通過後) の expansion phase で実装、本 PR scope 外
- **[carry-over]**: §3.bis ledger / OQ で永続化、別 phase

**G2 ゲートの目標 (`docs/walking-skeleton-trunk-selection.md` §4 S2 完了基準より)** + **本 sub-plan での検証戦略**:

| # | walking-skeleton §4 S2 目標 | 本 sub-plan 検証手段 |
|---|---|---|
| 1 | DXGI emit (#102 で landed) を入力に view が更新される integration test | **Test G2-1** (per-frame count aggregation、§3.8 Rust mock L1Sink-based) |
| 2 | D2-E0 同 scope (S1 で確立) で focus view と dirty rects view が共存 | **Test G2-3** (focus + dirty 同 scope 共存、§3.8) |
| 3 | napi export が TS 側から呼べる | **compile-time guard** (`check:native-types` + `index.d.ts` 自動生成 + tsc build pass、§3.10 push 6 ガード) **+ Node smoke `Test G2-4`** (§3.8、Node `require` で `view_get_dirty_rects(0)` を 1 回呼出。native binding 登録 / JS export / runtime symbol mismatch / pipeline 未初期化 を検出。fixture-heavy な vitest live integration は不要、Notepad/Edge induce なしで `spawn(0)` 可不可関係なく Node から binding を呼べることだけを確認) |
| 4 | `monitor_index` field を含む view output が TS 側から observable | **compile-time guard** (`NativeDirtyRectsResult` 型に `monitor_index: u32` field 必須、`check:native-types` で TS SoT 同期確認) + **Test G2-2** (per-monitor isolation、Rust 側で `monitor_index` field の意味的分離を pin) **+ Test G2-4** (Node smoke で returned object に `monitor_index` field が含まれることを runtime で確認) |
| 5 | **G2 ゲート判定**: focus view + dirty rect view の共存が確認できた時点で、S3-S5 に進む価値と scope を再確認 | walking-skeleton-trunk-selection.md Appendix C に判定 append |

**検証粒度の判断 (User feedback 2026-05-01 反映)**: 当初 (post-pivot Round 1) は G2 #3 / #4 の runtime smoke を expansion へ carry-over (`check:native-types` + tsc build で十分) と判定したが、User feedback で「**型生成が通っても、native binding 登録漏れ / JS export 漏れ / runtime symbol mismatch / pipeline 未初期化は検出できない**。S3-S5 は TS/L5 からこの getter を読む前提なので、最低限 Node から `view_get_dirty_rects(0)` を呼ぶ smoke は S2/G2 内に戻すべき」と判定 → **Test G2-4 を S2 trunk scope に戻す** (Node から 1 回呼出のみ、fixture-heavy な vitest live integration は引き続き expansion へ carry-over、§1.3)。trunk size 200-300 line 制約は Test G2-4 の Node smoke (一行 require + 一行 call + monitor_index 検証 assertion) なら吸収可能。

**review 観点の再定義**: 本 PR は「`dirty_rects_aggregate` view の完成度」ではなく **「S2/G2 contract が最短で検証できるか」** で評価する。`monitor_index` field 維持 (PR #102 同型 regression 防止、CLAUDE.md §3.2) は trunk 段階から必須、それ以外の完成度は expansion で吸収可能。

---

## 1. Scope (trunk / expansion / carry-over の 3 分類)

### 1.1 [S2 trunk] 本 sub-plan で扱う (G2 contract 必須)

A. **`L1Sink` trait に `push_dirty_rect` method 追加** (`crates/engine-perception/src/input.rs`、L3 bridge から view へのチャネル拡張) — count-only でも pump → view の wiring に必須
B. **`DirtyRectEvent` 入力型** (`crates/engine-perception/src/input.rs`、L1 envelope を view が消費する shape) — count-only でも `monitor_index` / `frame_index` / `wallclock_ms` / `sub_ordinal` / `source_event_id` は維持 (北極星 N1 / N2 + CLAUDE.md §3.2)
C. **`crates/engine-perception/src/views/dirty_rects_aggregate.rs` 新設、count-only 簡易版** — `(monitor_index, frame_index) → count` 集約のみ (RectId list / union 計算は expansion)
D. **`src/l3_bridge/dirty_rect_pump.rs` 新設** — `focus_pump.rs` 同型 (parent-side subscribe + recv_timeout + bincode decode + filter by `EventKind::DirtyRect` + `sink.push_dirty_rect`)
E. **`spawn_perception_worker` tuple 拡張** — S1 (D2-E0 scope refactor) で確立した shape に `DirtyRectsAggregateView` を追加。focus view + dirty rects view が同 dataflow scope で共存
F. **`PerceptionPipeline` lifecycle 拡張** (`src/l3_bridge/mod.rs`、`dirty_rect_pump` を `focus_pump` と同パターンで spawn / shutdown)
G. **napi binding `view_get_dirty_rects(monitor_index)` 新設** — count を返す最小 getter (引数は既存 `DuplicationHandle::spawn(output_index)` public API と整合、CLAUDE.md §3.2 PR #102 教訓)
H. **bench 1 本** — latency p99 regression guard 用途 (SLO 達成は contract 成立後に判断、`docs/walking-skeleton-trunk-selection.md` §3.2)
I. **G2 contract 検証 minimal Rust integration test** (mock L1Sink-based、no DXGI 必要)
J. **§3.bis ledger L1 strikethrough + Resolved 化** (本 PR 冒頭 commit で同時消化、Opus PR #102 round 1 推奨) — 既に本 D2-C plan PR で実施済

### 1.2 [expansion] G2 通過後の expansion phase で実装 (本 PR scope 外)

trunk 完了 (G2 通過) 後の expansion phase で実装、本 PR では scope 外として明示:

- **`rects: Vec<Rect>` field**: count-only に絞る trunk では `Rect { x, y, width, height }` 構造体は不要 (count のみ集約)。expansion phase で `rects` field 復活、union 計算と RectId list を実装
- **`summary { count, total_area }` の `total_area`**: count のみが G2 contract、`total_area` は rects から計算するため expansion で復活
- **100ms sliding window eviction**: count-only かつ contract spike のため、view 内部 state は **常に最新 1-2 frames を保持する固定サイズ buffer** で simplify。100ms window-based eviction は expansion で導入
- **`recent_n(monitor_index, n)` / `recent_window()` API**: count-only の minimal getter (`get(monitor_index, frame_index) -> Option<u64>` のみ) を trunk で land、recent_* API は expansion
- **追加 unit test (per-frame aggregation 詳細 / per-monitor isolation 詳細 / 100ms eviction / recent_n / recent_window)**: G2 contract 検証は最小 1-2 test で足りる、詳細 6 unit test は expansion
- **L4 envelope 連携** (`envelope.invariants_held` への consumer wiring): walking skeleton S5 (caused_by linkage) で扱う、本 S2 では view declarative 構築まで
- **`bench_view_dirty_rects_aggregate` SLO `update p99 < 2ms` 計測**: 本 PR は regression guard bench のみ、SLO 達成は別 PR (`P5c-2-bench` または `D2-C-bench`) で

### 1.3 [carry-over] §3.bis ledger / OQ で永続化 (別 phase)

- **secondary monitor 専用機能** (`docs/adr-007-p5c-2-plan.md` §10 OQ #3 と同 carry-over): per-output 並行 thread / per-monitor 専用 view / secondary monitor 検出 logic
- **vitest live integration test** (Notepad/Edge fixture-based): P5c-2 sub-plan §5 follow-up と同じ phase で carry-over、本 PR では Rust mock-based のみ
- **D2-D-α (`SemanticEvent::WindowChanged` / `ScrollSettled` / `ModalAppeared` variant 拡張)**: §3.bis ledger L2/L3/L4
- **`recent_window(N_ms)` の time-travel API**: D3 で arrangement の time slice 機能と一緒に提供

### 1.4 北極星整合 + walking skeleton G2 contract

- **N1 (pivot 必ず保持)**: `source_event_id` を `DirtyRectEvent` に維持 (count-only でも維持必須)、view output には含めず L4 envelope 経由搬送 (S5 で扱う)
- **N2 (watermark で frontier 進行)**: D1 D2-A で確立済 worker_loop tuning を継承
- **CLAUDE.md 強制命令 3.1 (ADR/plan 複数表 fact 整合)**: 本 PR では sub-plan / 親 plan §5 / §3.bis ledger L1 / views-catalog §3.2 / ADR-008 §3.2 / `docs/walking-skeleton-trunk-selection.md` の 6 SSOT を bit-equal に揃える
- **CLAUDE.md 強制命令 3.2 (carry-over scope shrink、PR #102 教訓)**: P5c-2 emit が `monitor_index` を正しく載せている (PR #102 fix `db81fe2`)。view 側で **`monitor_index: 0` ハードコードや `monitor_index` field drop は禁止** — count-only 簡易版でも `(monitor_index, frame_index)` 複合 key を採用。「count-only 簡易版」とは aggregate 内の `rects: Vec<Rect>` / `total_area` を落とす意味であり、key 軸の `monitor_index` は trunk 段階から必須保持
- **walking skeleton G2 contract**: focus view + dirty rects view が **同 dataflow scope で共存**することが本 PR の最重要 contract。expansion で他 view 追加するときに同 scope 内 mechanical コピーで進められる base が固まる

---

## 2. 設計判断 (count-only contract spike として再整理)

### 2.1 view contract (count-only に簡素化)

#### [S2 trunk] output shape

```rust
/// One row per (monitor_index, frame_index) tuple. Count-only for the
/// walking-skeleton S2 contract spike — full Rect list and area
/// summary land in expansion (see §1.2).
pub struct DirtyRectsAggregate {
    pub monitor_index: u32,
    pub frame_index: u64,
    /// Number of dirty rects in this DXGI frame. The trunk contract
    /// only needs to count; geometry is reserved for expansion.
    pub count: u64,
}
```

`monitor_index` field は trunk 段階から必須保持 (CLAUDE.md §3.2)。

#### [expansion] 完成版 output shape

```rust
// expansion phase で復活
pub struct DirtyRectsAggregate {
    pub monitor_index: u32,
    pub frame_index: u64,
    pub count: u64,
    pub rects: Vec<Rect>,                  // expansion
    pub summary: DirtyRectsSummary,        // expansion (total_area)
}
pub struct Rect { x, y, width, height: i32 }   // expansion
pub struct DirtyRectsSummary { count, total_area: i64 }  // expansion
```

#### input shape (`DirtyRectEvent`、count-only でも維持)

```rust
pub struct DirtyRectEvent {
    /// 北極星 N1 traceability pivot.
    pub source_event_id: u64,
    /// Event-time data axis (北極星 N2).
    pub wallclock_ms: u64,
    pub sub_ordinal: u32,
    pub timestamp_source: u8,
    /// From `DirtyRectPayload` (P5c-2 emit、PR #102).
    pub monitor_index: u32,
    pub frame_index: u64,
    /// Trunk: kept for future expansion of the view; not aggregated yet.
    /// expansion phase で `rects: Vec<Rect>` 集約に使う。
    pub rect: Rect,
}
```

親 plan §5 spec 拡張 (CLAUDE.md §3.2 / §3.1 整合): `monitor_index` 追加、`hwnd` drop (P5c-2 emit に hwnd なし)、`frame_id → frame_index` 命名統一。

### 2.2 operator graph (count-only に簡素化)

```text
DirtyRectEvent collection (input)
    │
    │ map: DirtyRectEvent → ((monitor_index, frame_index), (LogicalTime, ()))
    ▼
reduce(): per (monitor_index, frame_index)、入力 row の **数を count**。
          1 row per key with diff = +1 (dirty rect は append-only)。
          [S2 trunk] 出力 = `(monitor_index, frame_index) → count: u64`
          [expansion] 出力に Vec<Rect> + summary を追加
    │
    ▼
inspect: (data, time, diff) を view の per-(monitor_index, frame_index) per-aggregate
         diff-sum HashMap に apply。live row は count > 0、count=0 で eviction。
```

`current_focused_element` との違い:
- **key**: per-hwnd vs **per-(monitor_index, frame_index) 複合 key** (CLAUDE.md §3.2)
- **retraction**: focus 移動で previous row を -1 → +1 に対し、dirty rect は **append-only**。diff bookkeeping は count > 0 確認のみで OK

### 2.3 read API (count-only に簡素化)

#### [S2 trunk] 最小 getter

```rust
impl DirtyRectsAggregateView {
    /// `(monitor_index, frame_index)` 直接 lookup (steady-state read)。
    /// Count-only trunk: returns `Some(count)` or `None`.
    pub fn get(&self, monitor_index: u32, frame_index: u64) -> Option<u64>;

    /// monitor_index 別の "live frames" の count (= view が現在 hold している
    /// frame の数)。napi `view_get_dirty_rects(monitor_index)` の返り値構築用。
    pub fn live_frame_count(&self, monitor_index: u32) -> usize;
}
```

#### [expansion] 完成版 read API

```rust
// expansion phase で追加
pub fn recent_n(&self, monitor_index: u32, n: usize) -> Vec<DirtyRectsAggregate>;
pub fn recent_window(&self) -> Vec<DirtyRectsAggregate>;
```

### 2.4 view 内部 state (固定サイズ buffer に simplify)

#### [S2 trunk] simplified buffer

view 内部 state は `Arc<RwLock<BTreeMap<(u32, u64), u64>>>` (count のみ保持、BTreeMap で `(monitor_index, frame_index)` 順序保持)。

**eviction**: trunk では **per-monitor で最新 N=8 frames** に固定 (60Hz × ~130ms 相当、固定サイズ buffer で実装簡素化)。100ms wallclock-based sliding window eviction は expansion で導入 (`docs/walking-skeleton-trunk-selection.md` §3.2「contract spike なので完成度は expansion 範囲」)。

#### [expansion] 完成版 eviction

```rust
// expansion phase: wallclock_ms ベース 100ms sliding window eviction
// 各 inspect で insert 後、自身の wallclock_ms から 100ms 古い entry を削除
```

### 2.5 dirty_rect_pump (`focus_pump.rs` 同型) [S2 trunk]

```text
EventRing.subscribe(8192) (parent-side、Codex v3 P1 race 回避)
    │
    │ recv_timeout(100ms) → SubscriptionEvent
    ▼
Filter: env.kind == EventKind::DirtyRect as u16
    │
    ▼
bincode decode: env.payload → DirtyRectPayload { rect: [i32; 4], monitor_index, frame_index }
    │
    ▼
DirtyRectEvent {
    source_event_id: env.event_id,
    wallclock_ms: env.wallclock_ms,
    sub_ordinal: env.sub_ordinal,
    timestamp_source: env.timestamp_source,
    monitor_index, frame_index,
    rect: Rect::from_array(payload.rect),  // trunk では view が aggregate しないが struct は维持
}
    │
    ▼
sink.push_dirty_rect(ev)
```

- shutdown 経路 (`shutdown_with_timeout` + retain on timeout) は `FocusPump` 同型
- `forwarded_count` / `decode_failure_count` メトリクスも同型
- `Subscription` channel capacity: 8192 (`focus_pump` と同設定)

### 2.6 spawn_perception_worker tuple 拡張 (S1 で確立した shape を継承)

S1 (D2-E0 scope refactor、`docs/walking-skeleton-trunk-selection.md` §4 S1) で確立される複数 view 戻り値 shape に本 PR で `DirtyRectsAggregateView` を追加。

現状 (D2-B-1 完了時):
```rust
pub fn spawn_perception_worker() -> (
    PerceptionWorker,
    FocusInputHandle,
    CurrentFocusedElementView,
    LatestFocusView,
)
```

S1 通過後 (`docs/walking-skeleton-trunk-selection.md` §4 S1 完了時) → 本 S2 で:
```rust
pub fn spawn_perception_worker() -> (
    PerceptionWorker,
    PerceptionInputHandle,  // FocusInputHandle → 改名 (S1 or S2、OQ #1)
    CurrentFocusedElementView,
    LatestFocusView,
    DirtyRectsAggregateView,  // 本 S2 で追加
)
```

`FocusInputHandle` は L1Sink trait の concrete type で `push_focus` のみ持つ。本 PR で `push_dirty_rect` 拡張するが、handle は **single worker / single Cmd enum** model:
- `Cmd::PushDirtyRect(DirtyRectEvent)` variant 追加
- worker が両方を捌く

`FocusInputHandle` リネーム (`PerceptionInputHandle`) は **OQ #1 で Opus 判断委譲** (詳細は §8)。

### 2.7 §3.bis ledger L1 同時消化 (Opus PR #102 round 1 推奨) [S2 trunk]

本 PR の **冒頭 commit** で `docs/adr-008-d2-plan.md` §3.bis ledger L1 row を更新:
- **trigger prerequisite 列**: 「**Resolved (P5c-2 PR #102 merged 2026-05-01、`c535fc2`)**」追記
- **復帰 PR 列**: 「本 PR (D2-C plan / impl)」追記、行を `~~strikethrough~~` 化
- **検証手順 列**: 「本 sub-plan §3 G2 contract test で view declarative 動作 pin」追記

ledger 運用ルール 3 (Opus review 経由) を本 PR で trigger、運用ルール 1 (trigger PR cross-reference) は P5c-2 PR #102 description が既に満たしている。

---

## 3. 実装 sub-batch (本 PR 内、S2 trunk scope)

### 3.1 D2-C-0: §3.bis ledger L1 同時消化 (本 PR 冒頭 commit、~10 line) [S2 trunk]

**[plan PR で実施済]** (本 D2-C plan PR、commit `72b0f7f` / `47d7be4`):
- [x] `docs/adr-008-d2-plan.md` §3.bis ledger L1 row を strikethrough + Resolved 化
- [x] 親 plan §5 spec を「`hwnd` drop + `monitor_index` 追加 + `frame_id → frame_index` 命名統一」+ trunk/expansion 二段表記に reconcile

**[impl PR で実施]** (本 plan PR merge 後の翌 PR、本 D2-C plan PR scope 外):
- [ ] 親 plan §11.1 「主要 view 4」項目で `dirty_rects_aggregate` 行を 🚧 → ✅ status へ flip — count-only での flip、完成形 (`Vec<Rect>` + `total_area` + 100ms window + recent_n/recent_window 揃った状態) での ✅ flip は trunk 完了後 expansion で別 PR
- [ ] `docs/views-catalog.md` §3.2 row の status 更新 (本 plan PR で trunk/expansion 注記追加済、impl 完了で status flip)

### 3.2 D2-C-1: `L1Sink` trait + `DirtyRectEvent` + `Cmd` 拡張 (~80 line) [S2 trunk]

- [ ] `crates/engine-perception/src/input.rs::L1Sink` trait に `fn push_dirty_rect(&self, event: DirtyRectEvent);` を追加
- [ ] `DirtyRectEvent` struct 新設 (§2.1 shape、`source_event_id` / `wallclock_ms` / `sub_ordinal` / `timestamp_source` / `monitor_index` / `frame_index` / `rect`)
- [ ] `Rect` struct 新設 (`{ x, y, width, height: i32 }`、count-only trunk では aggregate しないが struct 自体は input 側で必要)
- [ ] `Cmd` enum に `PushDirtyRect(DirtyRectEvent)` variant 追加
- [ ] `FocusInputHandle` を **`PerceptionInputHandle`** にリネーム (OQ #1、S1 or 本 S2 で確定)、`L1Sink::push_dirty_rect` impl 追加
- [ ] worker_loop の `match cmd` arm で `Cmd::PushDirtyRect` を `dirty_rect_input.update_at(...)` に向ける

### 3.3 D2-C-2: `dirty_rects_aggregate` view module (count-only、~80 line) [S2 trunk]

- [ ] `crates/engine-perception/src/views/dirty_rects_aggregate.rs` 新設
- [ ] `DirtyRectsAggregate` struct 定義 (count-only、§2.1)
- [ ] `build_dirty_rects_aggregate(scope, dirty_rect_stream) -> (Arranged, DirtyRectsAggregateView)` 関数 (S1 で確立した同 scope 内 build pattern、`Arranged` を外部に持ち出さない)
- [ ] operator graph 実装 (§2.2):
  - map: `DirtyRectEvent → ((monitor_index, frame_index), (LogicalTime, ()))`
  - reduce: per-key で count 集約 → 1 output row with `+1` diff
  - inspect: BTreeMap<(u32, u64), u64> に apply、固定 N=8 frames per-monitor で eviction
- [ ] `DirtyRectsAggregateView::get / live_frame_count` 実装 (§2.3 minimal getter)
- [ ] `crates/engine-perception/src/views/mod.rs` で `pub mod dirty_rects_aggregate;` 公開

### 3.4 D2-C-3: `spawn_perception_worker` tuple 拡張 (~50 line) [S2 trunk]

- [ ] S1 (D2-E0 scope refactor) で確立した shape に `DirtyRectsAggregateView` を追加
- [ ] worker の `dataflow(|scope| { ... })` closure 内で `build_dirty_rects_aggregate(scope, dirty_rect_stream)` を呼ぶ
- [ ] 既存 caller 全更新 (`src/l3_bridge/mod.rs` + integration test 等)
- [ ] focus view + dirty rects view が **同 dataflow scope で共存** (G2 contract 必須)

### 3.5 D2-C-4: `dirty_rect_pump.rs` (root crate、~150 line) [S2 trunk]

- [ ] `src/l3_bridge/dirty_rect_pump.rs` 新設 (`focus_pump.rs` 同型)
- [ ] `pub(crate) struct DirtyRectPump { join, shutdown, forwarded_count, decode_failure_count }`
- [ ] `DirtyRectPump::spawn(ring: Arc<EventRing>, sink: Arc<dyn L1Sink>) -> Self`:
  - parent-side `ring.subscribe(SUB_CAPACITY)` (Codex v3 P1)
  - worker thread spawn
- [ ] worker `run()` ループ:
  - `recv_timeout(RECV_TIMEOUT)` → `SubscriptionEvent`
  - filter `env.kind == EventKind::DirtyRect as u16`
  - bincode decode `DirtyRectPayload`
  - `DirtyRectEvent` 構築 → `sink.push_dirty_rect(ev)`
- [ ] `shutdown_with_timeout` / `Drop` impl も `focus_pump.rs` 同型 (retain on timeout、Codex v6 P1)

### 3.6 D2-C-5: `PerceptionPipeline` 拡張 (~50 line) [S2 trunk]

- [ ] `PerceptionPipeline` struct に `dirty_rect_pump` + `dirty_rects_view: Arc<DirtyRectsAggregateView>` field 追加
- [ ] `spawn_pipeline_inner()` で `DirtyRectPump::spawn(ring, sink)` 起動
- [ ] `shutdown_with_timeout` で `dirty_rect_pump → focus_pump → worker` の 3 段 shutdown 順序を確立
- [ ] `is_poisoned()` / `consume_shutdown()` 経路の更新 (D2-0 PR #94 整合)

### 3.7 D2-C-6: napi binding `view_get_dirty_rects(monitor_index)` (~50 line) [S2 trunk]

- [ ] `#[napi]` `view_get_dirty_rects(monitor_index: u32) -> NativeDirtyRectsResult` 新設
  - 戻り値: `{ monitor_index: u32, live_frame_count: u32, latest: Option<{ frame_index: u64, count: u64 }> }`
  - count-only trunk の最小 getter
- [ ] napi-safe (`napi_safe_call("view_get_dirty_rects", || { ... })`)
- [ ] `index.d.ts` 自動生成更新、`src/engine/native-types.ts` に `NativeDirtyRectsResult` 追加 (`check:native-types` 通過確認)
- [ ] D2-B-1 PR #96 の `view_get_focused` 先例同型で expose

### 3.8 D2-C-7: G2 contract minimal Rust integration test + Node smoke (~70 line) [S2 trunk]

**G2 contract 検証に必要な最小 test 4 件** (User feedback 2026-05-01 で Test G2-4 を S2 trunk に戻し):

- [ ] **Test G2-1: per-frame count aggregation** (Rust mock L1Sink-based): `(monitor=0, frame=1)` で 3 rects push → `view.get(0, 1)` で `Some(3)` を assert
- [ ] **Test G2-2: per-monitor isolation** (Rust mock-based、CLAUDE.md §3.2 PR #102 教訓): `(monitor=0, frame=1)` 2 rects + `(monitor=1, frame=1)` 3 rects → `view.get(0, 1) = Some(2)`、`view.get(1, 1) = Some(3)` (frame_index 衝突しても monitor で分離)
- [ ] **Test G2-3: focus view + dirty rects view 同 scope 共存** (Rust mock-based、G2 contract 必須): S1 で確立した同 scope に両 view を build、focus event push と dirty rect event push を交互に発行、両 view が独立に正しく更新される
- [ ] **Test G2-4: Node runtime smoke** (User feedback 2026-05-01 で S2 trunk に restore、~20 line):
  - `tests/unit/view-get-dirty-rects-smoke.test.ts` 新設 (vitest unit、`tryFindChrome` 等の DXGI 必須 fixture を **使わない** smoke 専用)
  - 中身: `await import("../../index.js")` で addon load → `addon.viewGetDirtyRects(0)` を 1 回呼出 → 戻り値が non-throw + `monitor_index: 0` field を含むことを assert (DXGI 不在で空 result でも構わない、smoke の主目的は **native binding 登録 / JS export / runtime symbol mismatch / pipeline 未初期化が起きていない確認**)
  - 検出できる regression: napi binding 登録漏れ / JS export 漏れ / runtime symbol mismatch / pipeline 未初期化 (compile-time guard では検出不可、User feedback 2026-05-01)
  - 検出 **しない** scope: DXGI live frame の actual rect count (それは expansion の vitest live integration で扱う)

[expansion] additional Rust tests (per-frame aggregation 詳細 / out-of-order partial-order / 100ms eviction / recent_n / recent_window) と vitest live integration (Notepad/Edge fixture-based) は trunk 完了後の expansion phase で追加。

### 3.9 D2-C-8: bench (regression guard、~30 line) [S2 trunk]

**命名 (本 sub-plan で確定)**:
- bench file: `crates/engine-perception/benches/d2_c_view_latency.rs` (D1 `d1_view_latency.rs` 同型 prefix)
- bench function: `bench_view_dirty_rects_aggregate` (`benches/README.md` §2.3 + ADR-008 D2 plan §11 の名称と整合)
- expansion で SLO 達成 PR を切る場合の PR 名 candidate: `D2-C-bench` (本 sub-plan §5 follow-up 言及済、`P5c-2-bench` と同 phase で進める判断は expansion 着手時)

- [ ] `crates/engine-perception/benches/d2_c_view_latency.rs` 新設 (`d1_view_latency.rs` 同型)
- [ ] criterion bench 1 本: `bench_view_dirty_rects_aggregate` (count return latency) — regression guard 用途
- [ ] **SLO 達成は本 PR scope 外** (`docs/walking-skeleton-trunk-selection.md` §3.2: 「performance bench は regression guard に留める。SLO を満たすための最適化は contract が成立してから判断」)

### 3.10 D2-C-9: Push 6 ガード + Opus + Codex review [S2 trunk]

- [ ] `cargo check --workspace`: clean (vision-gpu pre-existing warning は許容)
- [ ] `cargo test -p engine-perception`: 全 pass
- [ ] `cargo test -p desktop-touch-engine --no-default-features --lib l3_bridge::dirty_rect_pump::tests`: pump test pass
- [ ] `npm run check:napi-safe` / `check:native-types` / `check:stub-catalog` / `npm run build`: 全 pass
- [ ] **Opus phase-boundary review** (強制命令 3 + 3.1 + 3.2): 指摘ゼロまで反復
- [ ] **Codex re-review** (`@codex review` トリガー): production code 改修 PR は Opus + Codex 両方必須 (CLAUDE.md 3.2 運用 rule、特に `monitor_index` payload field 整合は Codex API contract 軸が強み、PR #102 教訓)

---

## 4. PR 切り方

| sub-batch | 範囲 | size 想定 |
|---|---|---|
| **D2-C (本 PR、merged sub-batch)** | 3.1 ledger 消化 + 3.2 trait/Cmd 拡張 + 3.3 view module (count-only) + 3.4 spawn 拡張 + 3.5 pump + 3.6 pipeline + 3.7 napi (count getter) + 3.8 G2 contract test 4 件 (Rust 3 件 + Node smoke 1 件、User feedback 2026-05-01 で Test G2-4 restore) + 3.9 bench (regression guard) + 3.10 ガード | **200-300 line** (count-only 簡素化で当初想定 300-450 → 200-300 に縮小、Test G2-4 Node smoke は ~20 line 増、trunk contract spike として最小) |

**1 PR で land**、sub-batch 分割しない (count-only / 複数 file 横断だが trunk 範囲で完結)。Opus + Codex 両 review で指摘ゼロ後 merge。

`docs/walking-skeleton-trunk-selection.md` §4.1 の S2 概算 **3-4 日** に整合。

---

## 5. expansion 範囲 (G2 通過後の expansion phase で実装)

trunk 完了後 (G2 通過後) の expansion phase で実装:

- **`rects: Vec<Rect>` field 復活** + union 計算 + RectId list (`crates/engine-perception/src/views/dirty_rects_aggregate.rs` の view を完成版に拡張)
- **`summary { count, total_area }` の `total_area` 復活**
- **100ms wallclock-based sliding window eviction** (固定 N=8 frames から wallclock-based に切替)
- **`recent_n(monitor_index, n)` / `recent_window()` API** 追加
- **詳細 unit test 6 件** (per-frame aggregation / out-of-order frame_index partial-order / 100ms eviction / recent_n ordering / recent_window cross-monitor / `(monitor_index, frame_index)` 衝突 edge case)
- **`bench_view_dirty_rects_aggregate` SLO 達成** (`update p99 < 2ms`、memory < 50MB)
- **L4 envelope 連携** (S5 caused_by linkage で `produced_changes` に dirty rect count を含める)
- **vitest live integration test** (Notepad/Edge fixture-based)

---

## 6. follow-up (carry-over、§3.bis ledger / OQ で永続化)

trunk + expansion 完了後の別 phase で carry-over:

- **secondary monitor 専用機能** (`docs/adr-007-p5c-2-plan.md` §10 OQ #3 と同 carry-over)
- **D2-E0 dataflow scope refactor の追加形 refactor (carry-over の対象は **追加形 のみ**、basic refactor は S1 trunk = walking skeleton PR-η で実施済前提)**: 本 S2 着手時点で S1 (D2-E0 PR-η) は既に merged 必須 (User feedback PR #103 review 2026-05-01、§7 R7 と整合)。S1 が land する basic refactor = `spawn_perception_worker` の signature 拡張 + 複数 view を返す shape の確立。本 carry-over に該当する **追加形 refactor** = D1 `current_focused_element` も `build_*(scope, stream) -> (Arranged, View)` signature に揃える後追い refactor (本 S2 では `build_dirty_rects_aggregate` のみ新 signature、D1 view は既存 shape 維持で OK、cross-view signature 統一は trunk 完了後の cleanup)
- **`recent_window(N_ms)` の time-travel API**: D3 で arrangement の time slice 機能と一緒に提供

---

## 7. Risks / Mitigation (S2 trunk-relevant に絞る)

| # | Risk | 影響 | Mitigation |
|---|---|---|---|
| R1 | `FocusInputHandle` リネーム (`→ PerceptionInputHandle`) で既存 caller 多数の更新が必要 | 中 | OQ #1 で確定 (S1 or S2)、grep で全 caller 列挙、`cargo check` で漏れ検出 |
| R2 | `Cmd` enum 拡張で worker_loop の partial-order N3 が壊れる | 中 | D1 D2-A revised tuning は channel 単一・cmd 多 variant 前提、enum 拡張は既存 N3 不変、test (`out_of_order_events_settle_to_latest_by_time` 等) で再確認 |
| R3 | count-only でも `(monitor_index, frame_index)` 複合 key で同 monitor の frame_index 重複が起きる (P5c-2 thread restart) | 中 | 固定 N=8 frames eviction で 8 frame 経過後は古い entry 消える、production 影響低い |
| R4 | dirty_rect_pump の `recv_timeout` が `focus_pump` と競合してどちらかの events を drop | 低 | `EventRing.subscribe` は per-subscription channel、両 pump が独立 buffer (Codex v3 P1) |
| R5 | `PerceptionPipeline` lifecycle に dirty_rect_pump 追加で shutdown 順序ミス | 高 | D2-0 PR #94 で確立した「成功時のみ slot clear / 失敗時は元 Arc 保持」パターン継承、test (`shutdown_timeout_failure_retains_slot` 同型) で 5 cycle 確認 |
| R6 | count-only から expansion で `rects: Vec<Rect>` 拡張時、shape が変わって既存 caller が壊れる | 中 | sub-plan §1.2 / §2.1 で「expansion で `DirtyRectsAggregate` shape 拡張」明示、本 PR の output shape を `#[non_exhaustive]` で marker するか OQ #2 |
| R7 | G2 contract test (focus view + dirty rects view 共存) が S1 (D2-E0) shape に依存、S1 が遅れると本 S2 も遅れる | 中 | `docs/walking-skeleton-trunk-selection.md` §4.1 の S1 → S2 直列前提、S1 完了済が前提条件、本 PR 着手前に S1 merged 確認 |

---

## 8. Acceptance Criteria

### 8.1 G2 contract (`docs/walking-skeleton-trunk-selection.md` §4 S2 完了基準、§0 検証戦略 matrix と整合、User feedback 2026-05-01 反映)

- [ ] **G2 #1 DXGI emit を入力に view が更新される** — Rust **Test G2-1** (§3.8 per-frame count aggregation、mock L1Sink-based)
- [ ] **G2 #2 同 scope で focus view と dirty rects view が共存** — Rust **Test G2-3** (§3.8 focus + dirty cohabitation)
- [ ] **G2 #3 napi export が TS 側から呼べる** — **compile-time guard** (§3.10 `check:native-types` + `index.d.ts` 自動生成 + `npm run build` pass) **+ Node smoke `Test G2-4`** (§3.8、Node から `view_get_dirty_rects(0)` を 1 回呼出、native binding 登録 / JS export / runtime symbol mismatch / pipeline 未初期化を検出)。fixture-heavy な vitest live integration は §1.3 carry-over (P5c-2 sub-plan §5 follow-up と同 phase)
- [ ] **G2 #4 `monitor_index` field を含む view output が TS 側から observable** — **compile-time guard** (`check:native-types` で `NativeDirtyRectsResult.monitor_index: u32` 強制) + Rust **Test G2-2** (§3.8 per-monitor isolation、CLAUDE.md §3.2 PR #102 教訓) **+ Test G2-4** (Node smoke で returned object に `monitor_index` field が含まれることを runtime で確認)
- [ ] **G2 #5 ゲート判定** — `docs/walking-skeleton-trunk-selection.md` Appendix C に判定結果 (date / decision / rationale) を append (impl PR merge 後に実施)

### 8.2 親 plan §11.1 acceptance との対応

- [ ] **主要 view 4 の declarative 実装** の `dirty_rects_aggregate` 行を 🚧 → ✅ に flip (count-only での flip、expansion で完成度向上を別 PR で)
- [ ] **§3.bis ledger L1 row を strikethrough + Resolved 化** (本 D2-C plan PR で実施済)

### 8.3 sub-plan 追加 acceptance (S2 trunk-relevant)

- [ ] D2-C-7 G2 contract test 4 件全 pass (Rust 3 件: per-frame count / per-monitor isolation / focus + dirty 共存 + Node smoke 1 件: `view_get_dirty_rects(0)` runtime 呼出 + `monitor_index` field 検証、User feedback 2026-05-01 で Test G2-4 restore)
- [ ] `view_get_dirty_rects(monitor_index)` napi binding が D2-B-1 `view_get_focused` 先例同型で expose
- [ ] `dirty_rect_pump` shutdown が `focus_pump` と同型で 5 cycle restart test pass
- [ ] cargo test workspace 全 pass (engine-perception + root crate 既存)
- [ ] `npm run check:napi-safe` / `check:native-types` / `check:stub-catalog` / `npm run build`: 全 pass
- [ ] **Opus phase-boundary review** (強制命令 3 + 3.1 + 3.2): 指摘ゼロまで反復
- [ ] **Codex re-review** (production code 改修 PR、CLAUDE.md 3.2 運用 rule): 指摘ゼロ確認

### 8.4 後続 trigger (G2 通過後)

- [ ] G2 ゲート判定 (focus view + dirty rect view の共存が確認できた時点で、S3-S5 に進む価値と scope を再確認、`docs/walking-skeleton-trunk-selection.md` §5.1)
- [ ] G2 通過判定を `docs/walking-skeleton-trunk-selection.md` Appendix C に append (date / decision / rationale)
- [ ] 次 phase: walking skeleton **S3** (envelope minimal wrapper + compat mode、`docs/walking-skeleton-trunk-selection.md` §4 S3)

---

## 9. Open Questions (S2 trunk-relevant に絞る)

| # | OQ | 決定タイミング |
|---|---|---|
| 1 | `FocusInputHandle` を `PerceptionInputHandle` にリネームするか、既存名を保持して機能拡張のみ行うか | S1 or S2 着手時に Opus 判断委譲。私の推奨は α (リネーム、名前と機能整合)、PR diff 規模次第で sub-batch 化検討 |
| 2 | `DirtyRectsAggregate` shape を `#[non_exhaustive]` で marker するか (expansion で `rects` / `total_area` 追加時の compat) | S2 着手時、Rust API guideline 整合で判断 |
| 3 | trunk 完了後の expansion で view shape を拡張する際の caller migration 戦略 | expansion phase 着手時、本 PR scope 外 |

---

## 10. ADR-008 D2 + walking skeleton 全体図 (本 PR の位置づけ)

```
Walking skeleton trunk:
┌──────────────────────────────────────────────────────────────────────┐
│  S1: D2-E0 dataflow scope refactor (PR 1)                            │
│      ↓                                                                │
│  S2: D2-C dirty_rects_aggregate count-only (★ 本 PR、PR 2)           │
│      ↓                                                                │
│  S3: ADR-010 P1 envelope minimal wrapper (PR 3)                      │
│      ↓                                                                │
│  S4: desktop_discover/act commit 軸 wrapper (PR 4)                   │
│      ↓                                                                │
│  S5: caused_by linkage cross-layer (PR 5、★ 最重要 contract)          │
│      ↓                                                                │
│  S6: trunk 完了判定 + CI assert + expansion plan (PR 6)              │
└──────────────────────────────────────────────────────────────────────┘

[L1 Capture (P5c-2 emit landed PR #102)]      [L3 bridge — root crate 内]            [engine-perception — 純 Rust]
src/duplication/thread.rs ─push─→  src/l3_bridge/dirty_rect_pump.rs ─push─→ crates/engine-perception/src/views/dirty_rects_aggregate.rs
  (P5c-2 PR #102 で実装済)        (本 PR で実装、focus_pump 同型)              (本 PR で count-only 実装)
                                                                                       │
                                                                                       ▼
                                                                            timely + DD operator graph:
                                                                              map → reduce(per-(monitor, frame) count) → inspect
                                                                                       │
                                                                                       ▼
                                                                            Arc<RwLock<BTreeMap<(u32, u64), u64>>>
                                                                                       │
                                                                                       ▼
                                                                            napi `view_get_dirty_rects(monitor_index)` (本 PR で TS expose、count-only)
                                                                                       │
                                                                                       ▼
                                                                            (S5 caused_by linkage で envelope.produced_changes に dirty rect count を含める)
```

---

## 11. References

- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.3) §4 S2 + §5 G2 ゲート + §3.2 contract spike 方針
- 親 plan: `docs/adr-008-d2-plan.md` §D2-C (line 649) + §5 (line 946) + §11.1 + §3.bis ledger L1
- ADR-008 概念設計: `docs/adr-008-reactive-perception-engine.md` §3.2 + §8
- views-catalog: `docs/views-catalog.md` §3.2 (`dirty_rects_aggregate` row、SLO p99 < 2ms は expansion で達成)
- P5c-2 emit: `docs/adr-007-p5c-2-plan.md` (PR #101 merged) + 実装 PR #102 merged 2026-05-01 (`c535fc2`)
- 同型先例:
  - view: `crates/engine-perception/src/views/current_focused_element.rs` (D1-3 PR #91)
  - pump: `src/l3_bridge/focus_pump.rs` (D1-2 PR #90)
  - napi: `src/l3_bridge/mod.rs::view_get_focused` (D2-B-1 PR #96)
  - lifecycle: `src/l3_bridge/mod.rs::PerceptionPipeline` (D2-0 PR #94)
- governance: CLAUDE.md 強制命令 3.1 (ADR/plan 複数表 fact 整合) + 3.2 (carry-over scope shrink、PR #102 教訓)
- memory: `feedback_carry_over_scope_shrink.md` / `feedback_north_star_reconciliation.md` / `feedback_ai_multi_reviewer.md`
