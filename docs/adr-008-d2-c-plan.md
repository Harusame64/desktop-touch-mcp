# ADR-008 D2-C — `dirty_rects_aggregate` view (sub-plan)

- Status: **Drafted (2026-05-01)**
- Trigger: ADR-008 D2 plan §3.bis carry-over ledger **L1 trigger 完了** — ADR-007 P5c-2 (PR #102 merged 2026-05-01、`c535fc2`) で `EventKind::DirtyRect` (=0) emit が production land。本 sub-plan は ledger L1 復帰 PR (PR-ε) の起草、ledger 運用ルール 1 (trigger PR merge 後の即復帰 PR) 遵守
- 親 plan: `docs/adr-008-d2-plan.md` §D2-C (line 649) + §5 (`dirty_rects_aggregate` view 仕様、line 946) + §11.1 (acceptance) + §3.bis ledger L1
- 概念設計: `docs/adr-008-reactive-perception-engine.md` §3.2 + `docs/views-catalog.md` §3.2
- 規模想定: 親 plan §3 PR 表 (line 797) で **carry-over** 印付け済、本 sub-plan で復帰、想定 **300-450 line** (D1 同型: view + pump + spawn 拡張 + napi + test)

---

## 1. Scope

### 1.1 本 sub-plan で扱う

A. **`L1Sink` trait に `push_dirty_rect` method 追加** (`crates/engine-perception/src/input.rs`、L3 bridge から view へのチャネル拡張)
B. **`DirtyRectEvent` 入力型** (`crates/engine-perception/src/input.rs`、L1 envelope を view が消費する shape に変換)
C. **`crates/engine-perception/src/views/dirty_rects_aggregate.rs` 新設** — `(monitor_index, frame_index)` keying の declarative view
D. **`src/l3_bridge/dirty_rect_pump.rs` 新設** — `focus_pump.rs` 同型 (parent-side subscribe + recv_timeout + bincode decode + filter by `EventKind::DirtyRect` + `sink.push_dirty_rect`)
E. **`spawn_perception_worker` 4-tuple → 5-tuple 拡張** (`DirtyRectsAggregateView` 追加、既存 caller 全修正)
F. **`PerceptionPipeline` lifecycle 拡張** (`src/l3_bridge/mod.rs`、`dirty_rect_pump` を `focus_pump` と同パターンで spawn / shutdown)
G. **napi binding `view_get_dirty_rects(frame_index_or_recent)` 新設** (TS 側 expose、D4 envelope 経由消費の seam)
H. **Rust unit test** (mock L1Sink-based、no DXGI 必要)
I. **§3.bis ledger L1 strikethrough + Resolved 化** (本 PR 冒頭 commit で同時消化、Opus PR #102 round 1 推奨)

### 1.2 本 sub-plan で扱わない (carry-over)

- **`bench_view_dirty_rects_aggregate`** (親 plan §11.4 / views-catalog §3.2 SLO `update p99 < 2ms`): 本 PR scope を「view declarative + integration」に絞る、bench は別 PR (`P5c-2-bench` と同 PR or 独立 `D2-C-bench`)。理由: P5c-2 で同方針採用済 (sub-plan §3.4 → 別 PR carry-over)、PR #94/#95 の Codex round 多発教訓 (sub-batch 切り効果) と整合
- **vitest live integration test** (Notepad/Edge fixture-based): P5c-2 sub-plan §5 follow-up と同様、本 PR では Rust mock-based のみ
- **L4 envelope 連携** (`envelope.invariants_held` への consumer wiring): ADR-010 起草時に view consumer を実装、本 sub-plan は view の declarative 構築まで
- **`recent_window(N_ms)` の time-travel API**: D3 で arrangement の time slice 機能と一緒に提供。本 PR は frame_index 直接 query + recent N frames に絞る
- **secondary monitor の高度機能** (per-output 並行 thread / 検出 logic): P5c-2 sub-plan §10 OQ #3 と同 carry-over。**ただし** `(monitor_index, frame_index)` keying と `monitor_index` field 維持自体は本 PR で扱う (§2 で詳述、CLAUDE.md 強制命令 3.2 適用)

### 1.3 北極星整合 (親 plan §1.4 + 強制命令 3.2)

- **N1 (pivot 必ず保持)**: `source_event_id` を `DirtyRectEvent` に維持、view output には含めず L4 envelope 経由搬送 (`current_focused_element` と同方針、`docs/adr-008-d1-followups.md` §3.5 ADR-010 carry-over)
- **N2 (watermark で frontier 進行)**: D1 D2-A で確立済 worker_loop tuning を継承
- **強制命令 3.1 (ADR/plan 複数表 fact 整合)**: 本 PR では sub-plan / 親 plan §5 / §3.bis ledger L1 / views-catalog §3.2 / ADR-008 §3.2 の 5 SSOT を bit-equal に揃える。`monitor_index` 追加は §5 spec 拡張なので親 plan §5 を同 commit batch で更新
- **強制命令 3.2 (carry-over scope shrink、PR #102 教訓)**: P5c-2 emit が `monitor_index` を正しく載せている (PR #102 fix `db81fe2`)。view 側で **`monitor_index: 0` ハードコードや `monitor_index` field drop は禁止** — 既存 emit の正しい意味論 (per-monitor frame_index 独立) を view で消費するため、`(monitor_index, frame_index)` 複合 key を採用

---

## 2. 設計判断

### 2.1 view contract (views-catalog §3.2 + 親 plan §5、本 PR で reconcile)

#### output shape (sub-plan で確定)

```rust
/// One row per (monitor_index, frame_index) tuple.
pub struct DirtyRectsAggregate {
    pub monitor_index: u32,
    pub frame_index: u64,
    pub rects: Vec<Rect>,
    pub summary: DirtyRectsSummary,
}

pub struct DirtyRectsSummary {
    pub count: usize,
    /// Sum of `width * height` across all rects, in virtual-screen pixels.
    /// `i64` so primary + secondary monitors at 4K each can't overflow.
    pub total_area: i64,
}

pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
```

親 plan §5 の `DirtyRectsAggregate { frame_id, rects, summary }` を本 sub-plan で **`monitor_index` 拡張**する (§1.3 強制命令 3.2 整合)。親 plan §5 の `frame_id` は本 sub-plan で `frame_index` (P5c-2 emit field 名と一致) と命名統一。同 commit batch で親 plan §5 spec を更新。

#### input shape (`DirtyRectEvent`)

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
    pub rect: Rect,
}
```

親 plan §5 の `DirtyRectEvent` から **`hwnd` を drop**: P5c-2 emit (`DirtyRectPayload`) は hwnd を持たない (DXGI dirty rect は output 単位、window 単位ではない)。親 plan §5 spec を本 sub-plan で `hwnd` drop + `monitor_index` 追加に reconcile。

### 2.2 operator graph (D1 `current_focused_element` 同型)

```text
DirtyRectEvent collection (input)
    │
    │ map: DirtyRectEvent → ((monitor_index, frame_index), (LogicalTime, Rect))
    ▼
reduce(): per (monitor_index, frame_index)、全 Rect を Vec に集約 + summary 計算。
          1 row per key with diff = +1 (dirty rect は append-only、retraction なし)。
    │
    ▼
inspect: (data, time, diff) を view の per-(monitor_index, frame_index) per-aggregate
         diff-sum HashMap に apply。live row は count > 0、count=0 で eviction。
```

`current_focused_element` との違い:
- **key**: per-hwnd vs **per-(monitor_index, frame_index) 複合 key**
- **retraction**: focus 移動で previous row を -1 → +1 に対し、dirty rect は **append-only** (frame 内で rect が「消える」概念がない)。diff bookkeeping は count > 0 確認のみで OK
- **eviction**: focus は hwnd close で eviction、dirty rect は **wallclock_ms ベースで 100ms 窓を超えたら drop** (sliding window、§2.4 詳述)

### 2.3 read API

```rust
impl DirtyRectsAggregateView {
    /// `(monitor_index, frame_index)` 直接 lookup (steady-state read)。
    pub fn get(&self, monitor_index: u32, frame_index: u64) -> Option<DirtyRectsAggregate>;

    /// monitor_index 限定で「最新 N frames」(view が hold している中での降順 N 件)。
    pub fn recent_n(&self, monitor_index: u32, n: usize) -> Vec<DirtyRectsAggregate>;

    /// (monitor 跨ぎ含む) 100ms 窓内で view が hold している全 aggregate。
    /// L4 envelope.invariants_held の "前 100ms に画面変化あり" 判定用。
    pub fn recent_window(&self) -> Vec<DirtyRectsAggregate>;
}
```

### 2.4 sliding window 100ms (eviction)

- view 内部 state は `Arc<RwLock<BTreeMap<(u32, u64), DirtyRectsAggregate>>>` (monitor_index, frame_index 順序保持)
- inspect callback で aggregate を BTreeMap に insert / update
- **eviction trigger**: 各 inspect で **insert 後**、自身の `wallclock_ms` から 100ms 古い entry を BTreeMap から削除 (lazy eviction、idle frontier advance では evict しない — D1 D2-B-2 latest_focus が watermark idle advance で materialise する pattern との違い)
- memory budget: 60Hz × 100ms = 6 frames × 1 monitor + per-monitor 並行 = 大きくとも数十 entry、views-catalog §3.2 「memory < 50MB」 (P5c-2 sub-plan §5 SLO) 比肩のうち極小

`current_focused_element` の per-hwnd HashMap と異なり **時間軸 eviction が必要**な点が D2-C 固有設計。

### 2.5 dirty_rect_pump (`focus_pump.rs` 同型)

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
    rect: Rect::from_array(payload.rect),
}
    │
    ▼
sink.push_dirty_rect(ev)
```

- shutdown 経路 (`shutdown_with_timeout` + retain on timeout) は `FocusPump` と同型
- `forwarded_count` / `decode_failure_count` メトリクスも同型
- `Subscription` channel capacity: 8192 (`focus_pump` と同設定。60Hz emit でも 100ms 分 = 6 frames × N rects 程度なので余裕)

### 2.6 spawn_perception_worker tuple 拡張

現状:
```rust
pub fn spawn_perception_worker() -> (
    PerceptionWorker,
    FocusInputHandle,
    CurrentFocusedElementView,
    LatestFocusView,  // D2-B-1 で追加
)
```

本 PR で 5-tuple へ:
```rust
pub fn spawn_perception_worker() -> (
    PerceptionWorker,
    FocusInputHandle,
    CurrentFocusedElementView,
    LatestFocusView,
    DirtyRectsAggregateView,  // 本 PR で追加
)
```

`FocusInputHandle` は L1Sink の concrete type で `push_focus` のみ持つ。本 PR で `push_dirty_rect` 拡張するが、handle は **focus 専用 channel** か **共通 channel** か判断:
- **Option A**: `FocusInputHandle` を `PerceptionInputHandle` にリネーム、`Cmd` enum に `PushDirtyRect(DirtyRectEvent)` variant 追加、worker が両方を捌く (single worker model)
- **Option B**: `DirtyRectInputHandle` 別新設、worker が両方の channel を `select!` で multiplex (multi-handle model)

採用: **Option A** (single worker、single handle、single Cmd enum)。理由:
1. 既存 D1 D2-B で確立した worker_loop tuning (batch drain + max-time release) が channel 単一前提の設計
2. `DirtyRectsAggregateView` が `current_focused_element` と同 dataflow scope 内で build される必要 (D2-E0 「dataflow scope refactor」と整合、`Arranged` を外部に出さない設計)
3. multi-handle の `select!` は worker_loop の partial-order N3 確認を複雑化するリスク (D2-A revised tuning の再検証が必要に)

`FocusInputHandle` は **`PerceptionInputHandle` にリネーム**、`L1Sink` trait method を 2 つ実装:
```rust
impl L1Sink for PerceptionInputHandle {
    fn push_focus(&self, event: FocusEvent) { /* tx.send(Cmd::PushFocus(event)) */ }
    fn push_dirty_rect(&self, event: DirtyRectEvent) { /* tx.send(Cmd::PushDirtyRect(event)) */ }
}
```

既存 `FocusInputHandle` 名を保持する代替: 別 trait `DirtyRectSink` 新設で role 分離。**採用しない** — L1Sink trait の docstring で既に「P5c-2 / P5c-3 / P5c-4 will extend this trait with `push_dirty_rect`, `push_window_change`, `push_scroll`」と明記済 (line 181-184)、本 sub-plan の方向性は trait 拡張で固定。

`FocusInputHandle` リネームは **既存 caller 多数** (root crate `src/l3_bridge/mod.rs` + integration test)、**OQ #1 で Opus 判断委譲**:
- option α: リネーム (`FocusInputHandle` → `PerceptionInputHandle`)、import 全更新
- option β: `FocusInputHandle` 名を保持し、複数 method を実装 (名前と機能が乖離)

私の推奨は **option α** (名前と機能を整合)、ただし PR diff 規模が肥大化する場合は本 sub-plan §3 で sub-batch 化検討。

### 2.7 §3.bis ledger L1 同時消化 (Opus PR #102 round 1 推奨)

本 PR の **冒頭 commit** で `docs/adr-008-d2-plan.md` §3.bis ledger L1 row を更新:
- **trigger prerequisite 列**: 「**Resolved (P5c-2 PR #102 merged 2026-05-01、`c535fc2`)**」追記
- **復帰 PR 列**: 「本 PR (D2-C plan / impl)」追記、行を `~~strikethrough~~` 化
- **検証手順 列**: 「本 sub-plan §3.6 Rust unit test で view declarative 動作 pin」追記

ledger 運用ルール 3 (Opus review 経由) を本 PR で trigger、運用ルール 1 (trigger PR cross-reference) は P5c-2 PR #102 description が既に満たしている。

---

## 3. 実装 sub-batch (本 PR 内)

### 3.1 D2-C-0: §3.bis ledger L1 同時消化 (本 PR 冒頭 commit、~10 line)

- [ ] `docs/adr-008-d2-plan.md` §3.bis ledger L1 row を strikethrough + Resolved 化 (上記 §2.7 の通り)
- [ ] 親 plan §5 spec を「`hwnd` drop + `monitor_index` 追加 + `frame_id → frame_index` 命名統一」に reconcile (§2.1 反映)
- [ ] 親 plan §11.1 「主要 view 3」項目で `dirty_rects_aggregate` 行を 🚧 → ✅ status へ flip (本 PR で実装完了)

### 3.2 D2-C-1: `L1Sink` trait + `DirtyRectEvent` + `Cmd` 拡張 (~80 line)

- [ ] `crates/engine-perception/src/input.rs::L1Sink` trait に `fn push_dirty_rect(&self, event: DirtyRectEvent);` を追加
- [ ] `DirtyRectEvent` struct 新設 (§2.1 shape)
- [ ] `Rect` struct 新設 (`{ x, y, width, height: i32 }`、`DirtyRectPayload.rect: [i32; 4]` から変換するため `from_array` 関連メソッド)
- [ ] `Cmd` enum に `PushDirtyRect(DirtyRectEvent)` variant 追加
- [ ] `FocusInputHandle` を **`PerceptionInputHandle`** にリネーム (OQ #1 確定後)、`L1Sink::push_dirty_rect` impl 追加 (`tx.send(Cmd::PushDirtyRect(event))`)
- [ ] worker_loop の `match cmd` arm で `Cmd::PushDirtyRect` を `dirty_rect_input.update_at(...)` に向ける

### 3.3 D2-C-2: `dirty_rects_aggregate` view module (~120 line)

- [ ] `crates/engine-perception/src/views/dirty_rects_aggregate.rs` 新設
- [ ] `DirtyRectsAggregate` / `DirtyRectsSummary` / `Rect` (output 用) struct 定義 (§2.1)
- [ ] `build_dirty_rects_aggregate(scope, dirty_rect_stream) -> (Arranged, DirtyRectsAggregateView)` 関数 (D2-E0 dataflow scope refactor 同型 signature、`Arranged` を外部に持ち出さない設計)
- [ ] operator graph 実装 (§2.2):
  - map: `DirtyRectEvent → ((monitor_index, frame_index), (LogicalTime, Rect))`
  - reduce: per-key で Vec<Rect> 集約 + summary 計算 → 1 output row with `+1` diff
  - inspect: BTreeMap<(u32, u64), DirtyRectsAggregate> に apply、wallclock_ms ベース 100ms eviction
- [ ] `DirtyRectsAggregateView::get / recent_n / recent_window` 実装 (§2.3)
- [ ] `crates/engine-perception/src/views/mod.rs` で `pub mod dirty_rects_aggregate;` 公開、`pub use` で view 型を re-export

### 3.4 D2-C-3: `spawn_perception_worker` 5-tuple 拡張 (~50 line)

- [ ] `crates/engine-perception/src/input.rs::spawn_perception_worker` を 5-tuple 化、`DirtyRectsAggregateView` を返す
- [ ] worker の `dataflow(|scope| { ... })` closure 内で `build_dirty_rects_aggregate(scope, dirty_rect_stream)` を呼ぶ
- [ ] 既存 caller 全更新 (`src/l3_bridge/mod.rs` + integration test 等):
  - `let (worker, handle, view, _latest_view, _dirty_view) = spawn_perception_worker();`
  - production caller (`spawn_pipeline_inner`) は `dirty_view` を `PerceptionPipeline` field に保持
- [ ] `PerceptionWorker::dataflow_metrics` 等の既存メトリクスに dirty_rect 入力経路を含めるか検討 (本 PR scope 外、OQ #2 で carry-over)

### 3.5 D2-C-4: `dirty_rect_pump.rs` (root crate、~150 line)

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
  - decode 失敗 / shutdown 経路は `focus_pump.rs` 同型
- [ ] `shutdown_with_timeout` / `Drop` impl も `focus_pump.rs` 同型 (retain on timeout、Codex v6 P1)

### 3.6 D2-C-5: `PerceptionPipeline` 拡張 (`src/l3_bridge/mod.rs`、~50 line)

- [ ] `PerceptionPipeline` struct に `dirty_rect_pump: Option<Arc<Mutex<Option<DirtyRectPump>>>>` + `dirty_rects_view: Arc<DirtyRectsAggregateView>` field 追加 (`focus_pump` / `current_focused_view` と同型)
- [ ] `spawn_pipeline_inner()` で `DirtyRectPump::spawn(ring, sink)` 起動
- [ ] `shutdown_with_timeout` で `dirty_rect_pump → focus_pump → worker` の 3 段 shutdown 順序を確立 (focus_pump 同様 retain-on-timeout)
- [ ] `is_poisoned()` / `consume_shutdown()` 経路の更新 (D2-0 production lifecycle PR #94 と整合)

### 3.7 D2-C-6: napi binding `view_get_dirty_rects` (`src/l3_bridge/mod.rs`、~70 line)

- [ ] `#[napi]` `view_get_dirty_rects(monitor_index: u32, frame_index_or_recent: ViewQueryShape) -> Vec<NativeDirtyRectsAggregate>` 新設
  - `ViewQueryShape` discriminated union (`{ kind: "frame", frame_index: u64 }` | `{ kind: "recent_n", n: u32 }` | `{ kind: "recent_window" }`)
- [ ] napi-safe (`napi_safe_call("view_get_dirty_rects", || { ... })`、ADR-007 §3.4 整合)
- [ ] `index.d.ts` 自動生成更新 (`napi build` で reflected)、`src/engine/native-types.ts` に `NativeDirtyRectsAggregate` 追加 (`check:native-types` 通過確認)
- [ ] D2-B-1 PR #96 の `view_get_focused` 先例同型で expose (TS 側 SoT 同期)

### 3.8 D2-C-7: Rust unit test (`crates/engine-perception/src/views/dirty_rects_aggregate.rs::tests`、~100 line)

mock L1Sink-based、no DXGI 必要:
- [ ] **Test 1: per-frame aggregation**: `(monitor=0, frame=1)` で 3 rects push → `view.get(0, 1)` で `rects.len() == 3`、`summary.count == 3`、`summary.total_area == sum(w*h)` を assert
- [ ] **Test 2: per-monitor isolation**: `(monitor=0, frame=1)` 2 rects + `(monitor=1, frame=1)` 3 rects → `view.get(0, 1)` rects=2、`view.get(1, 1)` rects=3 (frame_index 衝突しても monitor で分離)
- [ ] **Test 3: out-of-order frame_index partial-order**: frame_index=2 push 後 frame_index=1 push (event-time でずれる) → 両方 view に landing、各 frame の rects は正しく集約
- [ ] **Test 4: 100ms eviction**: wallclock_ms=0 で push、wallclock_ms=150 で別 push → 古い entry が view から消える
- [ ] **Test 5: `recent_n` ordering**: 5 frames push、`recent_n(monitor, 3)` が最新 3 frame_index 降順返却
- [ ] **Test 6: `recent_window` cross-monitor**: 2 monitors で push、`recent_window()` 全 entry 返却

各 test は `crates/engine-perception/src/views/current_focused_element.rs::tests` 同型 pattern で書く (timely scope spawn + mock input + step until convergence + view assertion)。

### 3.9 D2-C-8: Push 6 ガード + Opus + Codex review (~ガード実行のみ)

- [ ] `cargo check --workspace`: clean (vision-gpu pre-existing warning は許容)
- [ ] `cargo test -p engine-perception`: 全 pass (37 lib + 10 integration + new unit tests = 50+)
- [ ] `cargo test -p desktop-touch-engine --no-default-features --lib l3_bridge::dirty_rect_pump::tests`: pump test pass (P5c-2 と同じ vision-gpu 迂回 pattern)
- [ ] `npm run check:napi-safe` / `check:native-types` / `check:stub-catalog` / `npm run build`: 全 pass
- [ ] **Opus phase-boundary review** (強制命令 3、CLAUDE.md 3.1 + 3.2 適用): 指摘ゼロまで反復
- [ ] **Codex re-review** (`@codex review` トリガー): production code 改修 PR は Opus + Codex 両方必須 (CLAUDE.md 3.2 運用 rule)

---

## 4. PR 切り方

| sub-batch | 範囲 | size 想定 |
|---|---|---|
| **D2-C (本 PR、merged sub-batch)** | 3.1 ledger 消化 + 3.2 trait/Cmd 拡張 + 3.3 view module + 3.4 spawn 5-tuple + 3.5 pump + 3.6 pipeline + 3.7 napi + 3.8 test 6 件 + 3.9 ガード | **300-450 line** (sub-batch 多いが各機能 file 単位で独立、review しやすい) |

**1 PR で land**、sub-batch 分割しない (D1 同型実装で独立 component 多いが、相互依存が高いので分割すると review 単位で動作確認できない)。Opus + Codex 両 review で指摘ゼロ後 merge。

---

## 5. follow-up (carry-over)

- [ ] **`bench_view_dirty_rects_aggregate`**: 別 PR (`D2-C-bench`) で本実装、`update p99 < 2ms` SLO + memory < 50MB 計測。`P5c-2-bench` と同じ PR で進めても良い (sub-batch 切り効果)
- [ ] **vitest live integration test** (Notepad/Edge fixture-based): P5c-2 sub-plan §5 follow-up と同じ phase で carry-over
- [ ] **D2-E0 dataflow scope refactor**: 本 PR で `build_dirty_rects_aggregate(scope, stream) -> (Arranged, View)` 形を採用、D1 `current_focused_element` も同 signature に揃える refactor は別 PR (D2-E0 PR-η)
- [ ] **`recent_window(N_ms)` の time-travel API**: D3 で arrangement の time slice 機能と一緒に提供
- [ ] **L4 envelope 連携** (`envelope.invariants_held` consumer wiring): ADR-010 起草時
- [ ] **secondary monitor 高度機能** (P5c-2 sub-plan §10 OQ #3 と同 carry-over)

---

## 6. Risks / Mitigation

| # | Risk | 影響 | Mitigation |
|---|---|---|---|
| R1 | `FocusInputHandle` リネーム (`→ PerceptionInputHandle`) で既存 caller 多数の更新が必要、PR diff 肥大 | 中 | OQ #1 で確定後、grep で全 caller 列挙、`cargo check` で漏れ検出。リネームは mechanical で risk 低 |
| R2 | `Cmd` enum 拡張で worker_loop の partial-order N3 が壊れる | 中 | D1 D2-A revised tuning は channel 単一・cmd 多 variant を前提とした設計。enum 拡張は既存 N3 不変、test (`out_of_order_events_settle_to_latest_by_time` 等) で再確認 |
| R3 | `DirtyRectPayload.rect: [i32; 4]` から `Rect { x, y, width, height: i32 }` 変換で field 順序ミス | 低 | unit test (D2-C-7 Test 1) で sum(w*h) を pin、変換 ミスは即 fail |
| R4 | sliding window 100ms eviction で BTreeMap mutate 中の concurrent read が deadlock / 古い data 返却 | 中 | `Arc<RwLock<BTreeMap>>`、write は eviction 時のみ、reader (`get` / `recent_n` / `recent_window`) は read lock。eviction 中 read は古い snapshot 許容 (北極星 N2 watermark 整合) |
| R5 | `dirty_rect_pump` の `recv_timeout` が `focus_pump` と競合してどちらかの events を drop | 低 | `EventRing.subscribe` は per-subscription channel、両 pump が独立 buffer を持つ (Codex v3 P1 broadcast 設計)。drop は per-subscription dropped_count で観測可 |
| R6 | `(monitor_index, frame_index)` 複合 key で同 monitor の frame_index 重複が起きる (例: P5c-2 の `frame_index.fetch_add(1)` が thread restart で 0 から再採番) | 中 | P5c-2 で `frame_index` は thread-local AtomicU64、thread 再起動で 0 reset される。**view 側で eviction が `wallclock_ms` ベースなので 100ms 経過後は重複しても古い entry は消える**、production 影響は 100ms 窓内の同 frame_index 衝突のみ。test (D2-C-7 OQ #4 派生) で認識、production 影響低い場合は OK、必要なら view key を `(monitor_index, source_event_id)` に切替 |
| R7 | napi `ViewQueryShape` discriminated union で TS-Rust 型 mismatch | 低 | D2-B-1 `view_get_focused` 先例同型で `#[napi(object)]` + `#[napi(string_enum)]`、`check:native-types` で TS 側 SoT 同期確認 |
| R8 | `PerceptionPipeline` lifecycle に dirty_rect_pump 追加で shutdown 順序ミス → `is_poisoned` 状態で degraded pipeline 残置 | 高 | D2-0 PR #94 で確立した「成功時のみ slot clear / 失敗時は元 Arc 保持」パターンを `dirty_rect_pump` にも適用。test (`shutdown_timeout_failure_retains_slot` 同型) で全 pump 含む shutdown 順序を 5 cycle 確認 |

---

## 7. Acceptance Criteria

### 7.1 親 plan §11.1 acceptance との対応
- [ ] **主要 view 3 の declarative 実装 (D2-C0 ゲート確定 4 → 3 + 1 carry-over)** の `dirty_rects_aggregate` 行を 🚧 → ✅ に flip
- [ ] **§3.bis ledger L1 row を strikethrough + Resolved 化**

### 7.2 sub-plan 追加 acceptance
- [ ] D2-C-7 unit test 6 件全 pass (per-frame aggregation / per-monitor isolation / out-of-order partial-order / 100ms eviction / recent_n ordering / recent_window cross-monitor)
- [ ] `view_get_dirty_rects` napi binding が D2-B-1 `view_get_focused` 先例同型で expose (TS SoT 同期)
- [ ] `dirty_rect_pump` shutdown が `focus_pump` と同型で 5 cycle restart test pass
- [ ] cargo test workspace 全 pass (engine-perception 50+ + root crate 既存)
- [ ] `npm run check:napi-safe` / `check:native-types` / `check:stub-catalog` / `npm run build`: 全 pass
- [ ] **Opus phase-boundary review** (強制命令 3 + 3.1 + 3.2): 指摘ゼロまで反復
- [ ] **Codex re-review** (production code 改修 PR、CLAUDE.md 3.2 運用 rule): 指摘ゼロ確認

### 7.3 後続 trigger
- [ ] 本 PR merge を `docs/adr-008-d2-plan.md` §3.bis ledger L1 で **trigger 完了**として記録 (本 PR §3.1 で同時消化)
- [ ] 次 phase: D2-D plan (`semantic_event_stream` skeleton + FocusMoved seed) 着手 (User 直列案)

---

## 8. Open Questions

| # | OQ | 決定タイミング |
|---|---|---|
| 1 | `FocusInputHandle` を `PerceptionInputHandle` にリネームするか、既存名を保持して機能拡張のみ行うか | §3.2 着手時、Opus 判断委譲。私の推奨は α (リネーム、名前と機能整合)、PR diff 規模次第で sub-batch 化検討 |
| 2 | `PerceptionWorker::dataflow_metrics` 等の既存メトリクスに dirty_rect 入力経路の forwarded/decode_failure を含めるか | 本 PR scope 外、別 PR (D2-metrics) で carry-over |
| 3 | 100ms 窓 eviction の閾値を env var (`DESKTOP_TOUCH_DIRTY_RECT_WINDOW_MS`) で調整可能にするか | 本 PR scope 外、production 運用課題が出てから判断 |
| 4 | 同 monitor で frame_index が thread restart で 0 reset される場合の view 側衝突対策 (R6) — 100ms eviction で吸収 vs `(monitor, source_event_id)` 切替 | 本 PR で 100ms eviction 採用、production で衝突観測されたら別 PR で key 変更検討 |
| 5 | `view_get_dirty_rects` の `ViewQueryShape` discriminated union 形 — TS 側で `union` typestring vs `enum` どちらが採用しやすいか | §3.7 着手時、D2-B-1 先例 (`view_get_focused`) と TS 側 helper の使い勝手で判断 |

---

## 9. ADR-008 D2-D / D2-E への接続 (本 PR 完了後の道筋)

```
[L1 Capture (P5c-2 emit landed PR #102)]      [L3 bridge — root crate 内]            [engine-perception — 純 Rust]
src/duplication/thread.rs ─push─→  src/l3_bridge/dirty_rect_pump.rs ─push─→ crates/engine-perception/src/views/dirty_rects_aggregate.rs
  (P5c-2 PR #102 で実装済)        (本 PR で実装、focus_pump 同型)              (本 PR で実装)
                                                                                       │
                                                                                       ▼
                                                                            timely + DD operator graph:
                                                                              map → reduce(per-(monitor, frame) Vec<Rect> + summary) → inspect
                                                                                       │
                                                                                       ▼
                                                                            Arc<RwLock<BTreeMap<(u32, u64), DirtyRectsAggregate>>>
                                                                                       │
                                                                                       ▼
                                                                            napi `view_get_dirty_rects()` (本 PR で TS expose、D2-B-1 PR #96 先例同型)
                                                                                       │
                                                                                       ▼
                                                                            (D4 envelope.invariants_held consumer は ADR-010 起草時)
```

- 本 PR 完了で **ADR-008 §4 D2 「主要 view 3 + 1 carry-over」の dirty_rects_aggregate 完成**、§3.bis ledger L1 strikethrough
- 次 phase: **D2-D plan** (`semantic_event_stream` skeleton + `FocusMoved` seed) — User 直列案
- D2-D も `dirty_rect_pump` のような L3 bridge 経由で `EventKind::UiaFocusChanged` を消費、本 PR の `dirty_rect_pump.rs` が template として使える (`focus_pump.rs` + `dirty_rect_pump.rs` 同型 → `semantic_event_pump.rs`)

---

## 10. References

- 親 plan: `docs/adr-008-d2-plan.md` §D2-C (line 649) + §5 (line 946) + §11.1 + §3.bis ledger L1
- ADR-008 概念設計: `docs/adr-008-reactive-perception-engine.md` §3.2 + §8
- views-catalog: `docs/views-catalog.md` §3.2 (`dirty_rects_aggregate` row)
- P5c-2 emit: `docs/adr-007-p5c-2-plan.md` (PR #101 merged) + 実装 PR #102 merged 2026-05-01 (`c535fc2`)
- 同型先例:
  - view: `crates/engine-perception/src/views/current_focused_element.rs` (D1-3 PR #91)
  - pump: `src/l3_bridge/focus_pump.rs` (D1-2 PR #90)
  - napi: `src/l3_bridge/mod.rs::view_get_focused` (D2-B-1 PR #96)
  - lifecycle: `src/l3_bridge/mod.rs::PerceptionPipeline` (D2-0 PR #94)
- governance: CLAUDE.md 強制命令 3.1 (ADR/plan 複数表 fact 整合) + 3.2 (carry-over scope shrink、PR #102 教訓)
- memory: `feedback_carry_over_scope_shrink.md` / `feedback_north_star_reconciliation.md` / `feedback_ai_multi_reviewer.md`
