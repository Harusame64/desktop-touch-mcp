# ADR-008 D1 — 最小成立プラン

- Status: **Draft (起草中、Opus)**
- Date: 2026-04-29
- 親 ADR: `docs/adr-008-reactive-perception-engine.md`
- SSOT: `docs/architecture-3layer-integrated.md`、`docs/views-catalog.md` §3.1
- 完了基準 (ADR-008 §8 D1 行): **1 view が incremental に更新、bench で TS 版より latency 1/10**

---

## 1. Scope

L3 Compute (timely + differential-dataflow) を本リポジトリに組込み、**L1 Capture ring → timely input → `current_focused_element` view** の 1 経路を最小成立させる。LLM への露出 (napi 経由 export, MCP tool 改修) は **D2 以降のスコープ**、本 D1 では engine 内部完結。

### 1.1 D1 で実装するもの

- 新 crate `engine-perception` (workspace member 化)
- timely-dataflow + differential-dataflow への依存
- L1 ring から `UiaFocusChanged` event を pull して timely input session に push する adapter
- `current_focused_element` view の operator graph 実装
- view から「最新値」を read する Rust API (engine 内部、napi 経由 export はしない)
- unit test (deterministic 入力 → 期待 view 値)
- bench harness で TS 版 (既存 `desktop_state` の focus 取得) と比較して 1/10 達成

### 1.2 D1 で実装しないもの (D2 以降)

- `desktop_state` 等の MCP tool の view 経由置換 (D2)
- 他 view (dirty_rects_aggregate / semantic_event_stream / predicted_post_state) (D2)
- working / episodic memory view (D2.5)
- time-travel `state_at(t)` (D3)
- cyclic / lens (D4)
- HW-accelerated view (D5)
- replay / WAL 統合 (D6)

### 1.3 D1-2 着手前の前提 (ADR-007 P5c-1)

D1-0 / D1-1 は既に完了 (PR #81 / #82) だが、**D1-2 (real L1 adapter) 着手前に ADR-007 P5c-1 完了が前提**:

- P5c-1 で **UIA Focus Changed event hook → L1 ring に `UiaFocusChanged` event push** が実装される
- これがないと bridge が pump する input が空、D1 acceptance「TS 版より 1/10」が synthetic 比較に格下げ → 北極星「Whole-System Dataflow」と矛盾
- 詳細経緯: `docs/adr-007-p5c-plan.md`、判断 lesson: `memory/feedback_north_star_reconciliation.md`

---

## 2. Workspace 化方針

| 選択肢 | 内容 | 採否 |
|---|---|---|
| **A. root を `crates/engine/` に移動** | 既存 `src/` を `crates/engine/src/` に移動、root は `[workspace]` のみ | ✗ history が大きく汚れる、build pipeline 全面修正 |
| **B. root を `[workspace] + [package]` 兼用** | 既存 root crate (`desktop-touch-engine`) はそのまま、新 crate を `crates/engine-perception/` に置く | **✓ 採用** |
| **C. workspace 化せず同 crate 内モジュール** | `src/perception/` として既存 crate に内蔵 | △ fallback。timely+DD compile time が本体に乗るのでエディタ体験悪化、crate 分離の本質的価値 (依存スコープ分離・independent compile) を失う |

**B 採用理由:**
- 既存 napi build (`scripts/build-rs.mjs` / `napi build`) は root crate に対して動く → 影響最小
- `engine-perception` crate は **napi 非依存**、純 Rust crate にできる (timely + DD のみ)
- 将来 `crates/` 配下に proc-macros (P5b 復活) / winml (ADR-006) を増やす土台
- workspace `target/` 共有でビルド成果物のキャッシュは引き継がれる

**Workspace 構成 (D1 完了時、root owns integration 反映):**

```
desktop-touch-mcp/
├── Cargo.toml          # [workspace] + [package] desktop-touch-engine
├── Cargo.lock
├── src/                # root crate (重い: napi / vision-gpu / windows-rs)
│   ├── l1_capture/     # 既存 + P5c で観測系 payload 追加
│   ├── uia/            # 既存 + P5c で event_handlers/ 拡張
│   ├── duplication/    # 既存 + P5c-2 で L1 emit fork
│   └── l3_bridge/      # 新設 (PR-P5c-0b scaffold、D1-2 で fill)
│       ├── mod.rs
│       └── focus_pump.rs   # L1 ring → decode → engine_perception::FocusInputHandle::push
├── crates/
│   └── engine-perception/   # 純 Rust crate (timely + DD のみ、napi 非依存維持)
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs
│           ├── input.rs         # L1Sink trait + FocusEvent 純データ型 (PR-P5c-0b scaffold)
│           └── views/           # D1-3 で実装
│               └── current_focused_element.rs
└── benches/
    ├── README.md       # 既存 (skeleton)
    └── d1_view_latency.rs  # D1-5 で実装
```

**依存方向**: root → engine-perception (workspace path、PR-P5c-0b で `Cargo.toml` に追加)。逆方向 (engine-perception → root) は採用しない (Codex review v2 P1 で確定、`docs/adr-007-p5c-plan.md` §2.2 / §6 / §12 と整合)。

---

## 3. Sub-batch 分解 (checklist)

実装担当者は完了したら `[ ]` → `[x]` に flip する。

### D1-0: workspace 化 + 空 crate (PR 1) — **完了 PR #81 (`a1cd5e8`)**
- [x] root `Cargo.toml` を `[workspace] + [package]` 兼用に変換、`members = [".", "crates/engine-perception"]`
- [x] `crates/engine-perception/Cargo.toml` 新設 (空、`[package]` のみ)
- [x] `crates/engine-perception/src/lib.rs` 新設 (空)
- [x] `npm run build:rs` がエラーなく通ること (既存 napi build に影響なし)
- [x] CI green、`scripts/check-no-koffi.mjs` / `check-napi-safe.mjs` / `check-native-types.mjs` が pass
- [x] `default-members` + `check:rs-workspace` script で全 workspace member が CI で type check される (Codex P2 fix `58c1199`)

### D1-1: timely + DD 依存追加 (PR 2) — **完了 PR #82 (`f8877a8`)**
- [x] `crates/engine-perception/Cargo.toml` に `timely = "0.29"` `differential-dataflow = "0.23"` 追加
- [x] `cargo check --workspace` が通る (engine-perception 含む)
- [x] root crate の build が依然 pass (Cargo.lock の影響は engine-perception の transitive のみ、root crate 経由 dep は変化なし)
- [x] timely / DD の crates.io latest stable を確認、決定根拠を本書 §6 に追記

### D1-2: root → engine-perception Input Adapter (PR 3 の前半、root owns integration)

**前提**: ADR-007 P5c-1 完了 (UIA Focus Changed event hook → ring に `UiaFocusChanged` event push 経路成立)。詳細: `docs/adr-007-p5c-plan.md` §11.3。

- [ ] **`src/l3_bridge/focus_pump.rs`** (root crate 側、PR-P5c-0b で scaffold 済) に adapter thread 実装
- [ ] **`EventRing` の broadcast 化** (subscribe 別 cursor):
  - 既存 destructive `poll()` (single consumer) は維持
  - 新規 `subscribe()` API を追加、subscriber ごとに cursor を保持、non-destructive read
  - 詳細実装は本 sub-batch 内で確定 (P5c plan §8 (A) で「ADR-008 D1-2 で実装」と確定済)
- [ ] adapter thread が `ring.subscribe()` で broadcast 受信、`EventKind::UiaFocusChanged` のみ filter (D1 スコープ、他 event は drop)
- [ ] L1 EventEnvelope を decode → `UiaFocusChangedPayload` (`{ before, after: UiElementRef, window_title }`) を取り出す
- [ ] **`engine_perception::FocusEvent`** に変換: `{ hwnd, name, automation_id, control_type, window_title, wallclock_ms, sub_ordinal }`
- [ ] **`crates/engine-perception/src/input.rs`** (PR-P5c-0b で scaffold 済) に `FocusInputHandle::push_focus(FocusEvent)` 実装 (timely InputSession への push)
- [ ] `(wallclock_ms, sub_ordinal)` を `Pair<u64, u32>` (logical_time) に変換
- [ ] L1 worker / UIA thread / 本 adapter thread の shutdown 順序 (本書 §5.3 で確定)
- [ ] L1 worker が停止しても adapter thread が deadlock しない (subscribe 側 timeout or shutdown signal)

### D1-3: `current_focused_element` view (PR 3 の後半)
- [ ] `crates/engine-perception/src/views/current_focused_element.rs` 新設
- [ ] input: `UiaFocusChanged` event collection
- [ ] operator: per-window `last-by-time` で current focus 1 row を維持 (state view)
- [ ] output struct: `UiElementRef { name, automation_id, control_type, window_title }` (views-catalog §3.1)
- [ ] arrangement で multi-version 保持、internal read API で最新値を取得

### D1-4: unit test (PR 3 内)
- [ ] `crates/engine-perception/tests/d1_minimum.rs`
- [ ] event を inject → view 更新を verify
- [ ] **partial-order test**: out-of-order event を入れても deterministic な結果になる
- [ ] shutdown sequence で deadlock しない

### D1-5: bench harness (PR 4)
- [ ] `benches/d1_view_latency.rs` 新規 (criterion crate ベース、または simple `#[bench]`)
- [ ] TS 版 baseline 計測手順を README に追記 (既存 `desktop_state` の focus 取得を直接呼ぶ Node script)
- [ ] **acceptance: TS 版より latency 1/10 達成** (acceptance criterion)
- [ ] `bench/` README に SLO 表を追加 (統合書 §13.1 と整合)

### D1-6: ドキュメント整合とメモリ更新 (PR 4 内 or 別 PR)
- [ ] `docs/views-catalog.md` §3.1 の `current_focused_element` 行を `Implemented` に更新
- [ ] ADR-008 §4 D1 行に PR 番号 + commit hash 追記
- [ ] memory `project_3layer_architecture_design.md` を「ADR-008 D1 完了」に更新
- [ ] memory `MEMORY.md` index 更新

---

## 4. PR 切り方

| PR | 範囲 | risk | size 想定 |
|---|---|---|---|
| **PR-α (D1-0)** | workspace 化 + 空 crate | 中 (build pipeline) | ~50 line |
| **PR-β (D1-1)** | timely + DD 依存追加 | 低 (空 crate に dep 追加だけ) | ~10 line |
| **PR-γ (D1-2 + D1-3 + D1-4)** | adapter + view + unit test | 中 (新規ロジック) | ~300-500 line |
| **PR-δ (D1-5 + D1-6)** | bench + docs | 低 | ~150 line |

**PR を 4 つに割る理由:**
- workspace 化 (PR-α) が他の変更と混ざると review が難しくなる
- timely + DD 依存追加 (PR-β) は一発で merge できるよう独立化
- adapter+view (PR-γ) はロジックの中核、テストとセットで review
- bench (PR-δ) は数値の妥当性レビューが主、コードレビューと分離

PR-α が merge されないと PR-β 以降が衝突するので、stack PR ではなく直列 merge。

---

## 5. L1 → engine-perception Input Adapter 仕様 (root owns integration)

`docs/adr-007-p5c-plan.md` §6 / §12 で確立した「root crate 内 bridge が L1 ring を所有して decode、engine-perception には純データ (`FocusEvent`) を push」経路の D1 側仕様。

### 5.1 Adapter 構造

```rust
// src/l3_bridge/focus_pump.rs (root crate 側、擬似コード)
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::sync::atomic::AtomicBool;

use crate::l1_capture::{EventRing, EventEnvelope, EventKind, UiaFocusChangedPayload};
use engine_perception::input::{FocusInputHandle, FocusEvent};

pub(crate) struct L1ToPerceptionPump {
    handle: JoinHandle<()>,
    shutdown: Arc<AtomicBool>,
}

impl L1ToPerceptionPump {
    pub(crate) fn spawn(
        ring: Arc<EventRing>,                 // root crate 内、L1Inner の ring 借用
        input: FocusInputHandle,              // engine-perception 側 InputSession wrapper
    ) -> Self {
        // adapter thread:
        //   ring.subscribe(my_cursor) → loop:
        //     for env in ring.poll_since(cursor, max):
        //       if env.kind == UiaFocusChanged as u16:
        //         let payload = bincode::decode(env.payload_bytes);
        //         let ev = FocusEvent {
        //             hwnd: payload.after.hwnd,
        //             name: payload.after.name,
        //             automation_id: payload.after.automation_id,
        //             control_type: payload.after.control_type,
        //             window_title: payload.window_title,
        //             wallclock_ms: env.wallclock_ms,
        //             sub_ordinal: env.sub_ordinal,
        //         };
        //         input.push_focus(ev);  // engine-perception InputSession に流す
    }

    pub(crate) fn shutdown(self, timeout: Duration) -> Result<(), ShutdownError> { /* ... */ }
}
```

```rust
// crates/engine-perception/src/input.rs (純 Rust crate 側、抜粋)
pub struct FocusEvent {
    pub hwnd: u64,
    pub name: String,
    pub automation_id: Option<String>,
    pub control_type: u32,
    pub window_title: String,
    pub wallclock_ms: u64,
    pub sub_ordinal: u32,
}

pub trait L1Sink: Send + Sync {
    fn push_focus(&self, event: FocusEvent);
    // P5c-3/4 拡張で push_dirty_rect / push_window_change / push_scroll を追加
}

pub struct FocusInputHandle {
    inner: Arc<Mutex<InputSession<Pair<u64, u32>, FocusEvent, isize>>>,
}

impl L1Sink for FocusInputHandle {
    fn push_focus(&self, event: FocusEvent) { /* InputSession に advance + insert */ }
}
```

### 5.2 EventEnvelope → Differential 4-tuple 変換

| L1 EventEnvelope フィールド | timely / DD 表現 |
|---|---|
| `event_id: u64` | (engine 内部の trace key、L3 では使わず) |
| `wallclock_ms: u64` + `sub_ordinal: u32` | logical_time = `Pair<u64, u32>` |
| `payload_bytes` (decoded `UiaFocusChangedPayload`) → `FocusEvent` | `FocusEvent` row、diff = +1 |
| (前回 focus row の retraction) | 同 logical_time に diff = -1 (state view の last-by-time semantics) |

D1 範囲では `EventKind::UiaFocusChanged` のみ拾い、他 event kind は drop。

### 5.3 Shutdown ordering (統合書 §17.6 / `docs/adr-007-p5c-plan.md` §6.4 と整合)

```
shutdown 開始
  ↓
1. l3_bridge::focus_pump.shutdown(2s)  ← adapter thread に signal、ring subscribe を drop
  ↓
2. timely worker join (engine-perception 内、graceful drain)
  ↓
3. shutdown_uia_for_test(3s)  (P5c-0b で追加、UIA event handler を Drop で Remove*)
  ↓
4. shutdown_l1_for_test(3s)
  ↓
ring 全 drop 完了
```

UIA / DXGI event は L1 ring に push される側、L1 を先に止めると orphan ring に push して Failure event 量産 → 逆順 (Bridge → timely → UIA → L1) が正しい (`docs/adr-007-p5c-plan.md` §6.4 と整合)。

---

## 6. timely / differential-dataflow バージョン選定 (D1-1 で確定)

| crate | 採用 | 採用根拠 |
|---|---|---|
| `timely` | **0.29** | crates.io latest stable @ 2026-04-29。ADR-008 §2 の "0.13+" baseline は drafting 時点の情報、現実は大きく進んでいる。0.29 系で採用 |
| `differential-dataflow` | **0.23** | crates.io latest stable @ 2026-04-29、timely 0.29 と互換 |

`Cargo.lock` 影響: 12 新規 transitive crate (timely 系 5 / DD 系 4 / 補助 3、bincode の duplicated version 含む)。`engine-perception` 専用、root crate の build pass・現行 napi 経由は不変。

ADR-008 §2 / 統合書の "0.13+" 文言は historical baseline として残置 (PR-D 系の整合性更新で別途追従)。本書 §6 が D1 着手時点の確定情報。

decision criteria:
- crates.io latest stable major を採用 (採用前に breaking change の有無を `cargo check` で確認)
- breaking change ある場合は本書 §6 と ADR-008 を後追い更新

---

## 7. `current_focused_element` view 仕様 (views-catalog §3.1 完全準拠)

### 7.1 input

```rust
pub struct FocusEvent {
    pub hwnd: u64,                 // window handle
    pub name: String,              // UIA name
    pub automation_id: Option<String>,
    pub control_type: u32,         // UIA control type ID
    pub window_title: String,
    pub timestamp: Pair<u64, u32>, // (wallclock_ms, sub_ordinal)
}
```

### 7.2 output (views-catalog §3.1 と同一)

```rust
pub struct UiElementRef {
    pub name: String,
    pub automation_id: Option<String>,
    pub control_type: u32,
    pub window_title: String,
}
```

### 7.3 operator graph

```
FocusEvent collection
    │
    │ map: (hwnd, FocusEvent) → keyed input
    │
    ▼
arrange_by_key + reduce(last-by-time)
    │
    ▼
collection<UiElementRef>  (1 row per current foreground hwnd)
```

「foreground 1 つに絞る」は別 view (D2 以降) または internal read API でフィルタ。D1 では各 window の最新 focus を維持するだけ。

### 7.4 SLO (views-catalog §3.1)

- 更新 latency: **p99 < 1ms**
- メモリ: arrangement 1 view 分、< 1MB 想定 (1 row × N window × multi-version compaction frontier 範囲)

---

## 8. Bench Harness 設計

### 8.1 比較対象

| ベース | 計測内容 |
|---|---|
| **TS 版 (current)** | `mcp__desktop-touch__desktop_state` 経由で focus 取得、JSON serialize 込み round-trip |
| **D1 view (new)** | `engine-perception::current_focused_element::read_latest()` を Rust から直接 call |

### 8.2 計測指標

- p50 / p95 / p99 latency (μs)
- ingest throughput (events/sec)
- arrangement memory (MB)

### 8.3 acceptance gate

- D1 view の p99 < TS 版 p99 / 10
- ingest 10k events/sec で arrangement memory < 5MB
- 100 連続 event で deterministic (replay 一致)

---

## 9. Risks / Mitigation

| # | Risk | 影響 | Mitigation |
|---|---|---|---|
| ~~R1~~ | ~~`napi build` が workspace 化で壊れる~~ | — | **解消済** (PR #81 / #82 で wkspc 化 + Codex P2 fix `58c1199` 完了) |
| ~~R2~~ | ~~timely 0.13/0.14 に compile-time~~ | — | **解消済** (timely 0.29 / DD 0.23 採用済、PR #82) |
| R3 | adapter thread が L1 worker / UIA thread と deadlock | 中 | broadcast subscribe + shutdown signal (本書 §5.3 ordering)、timeout subscribe |
| R4 | partial-order semantics を間違えて view が deterministic にならない | 中 | unit test で out-of-order event を必ず covers (D1-4) |
| R5 | bench で 1/10 達成しない | 中 | プロファイリング後に operator graph を最適化、最悪 D2 に carry over (acceptance 再評価) |
| R6 | windows-rs / vision-gpu feature gate との衝突 | 低 | `engine-perception` は windows-rs 直接依存しない (`FocusEvent` は純データ型)、root crate の vision-gpu は本 D1 で触らない |
| R7 | broadcast 化で既存 napi `l1Poll` 経路が壊れる | 中 | broadcast 追加時、既存 destructive `poll()` API は **そのまま維持** (single consumer 用)、新規 `subscribe()` API を別ルートで実装 (本書 §5.1 / D1-2 sub-batch で詳細化) |
| R8 | UIA / DXGI / Bridge / L1 の shutdown ordering で deadlock | 中 | 本書 §5.3 と `docs/adr-007-p5c-plan.md` §6.4 で integrated form を確定、5 サイクル shutdown/restart test (P5a と同水準) |

---

## 10. Open Questions

| # | OQ | 決定タイミング |
|---|---|---|
| ~~1~~ | ~~timely 0.13 vs 0.14 どちらを採用~~ | **解決済** (timely 0.29 / DD 0.23、PR #82、本書 §6) |
| 2 | L1 `Arc<L1Inner>` 共有 API のシグネチャ (既存 worker と干渉しない形) | D1-2 着手前、既存 `src/l1_capture/worker.rs` を読む |
| 3 | `current_focused_element` の "current" の定義 (foreground 1 つ vs 全 window 最新) | D1-3 着手前、ADR-008 / views-catalog を再確認 |
| 4 | bench harness の TS 版測定方法 (criterion から MCP tool を呼ぶか、Node 別プロセスか) | D1-5 着手時 |
| 5 | engine-perception を private にするか、将来公開する API surface 設計 | D2 着手前 |

---

## 11. Acceptance Criteria (ADR-008 §8 D1 と完全一致)

- [ ] **ADR-007 P5c-1 完了**を前提として、real L1 input (UIA Focus Changed event) が ring 経由で bridge → engine-perception に流れる
- [ ] **`src/l3_bridge/focus_pump.rs`** が `EventRing` broadcast subscribe → decode → `engine_perception::FocusInputHandle::push_focus()` で動作 (root owns integration、`docs/adr-007-p5c-plan.md` §12.3 と整合)
- [ ] 1 view が incremental に更新される (`current_focused_element`)
- [ ] unit test pass (partial-order 含む)
- [ ] bench で TS 版より latency 1/10 (real L1 input ベース、synthetic ではない)
- [ ] CI green、`npm run build:rs` / `npm test` 回帰なし、`check:rs-workspace` で engine-perception 含む
- [ ] D1-6 完了 (ドキュメント / メモリ整合)

---

## 12. 関連

- 親 ADR: `docs/adr-008-reactive-perception-engine.md`
- SSOT: `docs/architecture-3layer-integrated.md`
- view 契約: `docs/views-catalog.md` §3.1
- 制約 (起草中): `docs/layer-constraints.md` §3-§4 (本書執筆時、参照のみ)
- L1 base: ADR-007 P5a 完了 (`src/l1_capture/`、`memory/project_adr007_p5a_done.md`)
- **D1-2 前提**: ADR-007 P5c-1 完了 (`docs/adr-007-p5c-plan.md`)
- 関連 PR (履歴):
  - #79 (main-push guard、merged)
  - #80 (P5b defer、merged)
  - #81 (D1-0 workspace + plan tracking、merged `a1cd5e8`)
  - #82 (D1-1 timely + DD deps、merged `f8877a8`)
