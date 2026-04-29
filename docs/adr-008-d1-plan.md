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

**Workspace 構成 (D1 完了時):**

```
desktop-touch-mcp/
├── Cargo.toml          # [workspace] + [package] desktop-touch-engine
├── Cargo.lock
├── src/                # 既存 (root crate のまま)
├── crates/
│   └── engine-perception/
│       ├── Cargo.toml  # [package] engine-perception
│       └── src/
│           ├── lib.rs
│           ├── l1_input.rs
│           └── views/
│               └── current_focused_element.rs
└── benches/
    ├── README.md       # 既存 (skeleton)
    └── d1_view_latency.rs  # 新規
```

---

## 3. Sub-batch 分解 (checklist)

実装担当者は完了したら `[ ]` → `[x]` に flip する。

### D1-0: workspace 化 + 空 crate (PR 1)
- [ ] root `Cargo.toml` を `[workspace] + [package]` 兼用に変換、`members = ["", "crates/engine-perception"]`
- [ ] `crates/engine-perception/Cargo.toml` 新設 (空、`[package]` のみ)
- [ ] `crates/engine-perception/src/lib.rs` 新設 (空)
- [ ] `npm run build:rs` がエラーなく通ること (既存 napi build に影響なし)
- [ ] `npm test` (vitest) が回帰なく通ること
- [ ] `scripts/check-no-koffi.mjs` / `check-napi-safe.mjs` / `check-native-types.mjs` が pass
- [ ] `.github/workflows/release.yml` で workspace 認識を確認 (CI green)

### D1-1: timely + DD 依存追加 (PR 2)
- [ ] `crates/engine-perception/Cargo.toml` に `timely = "0.13"` `differential-dataflow = "0.13"` 追加
- [ ] `cargo check -p engine-perception` が通る
- [ ] root crate の build が依然 pass (依存関係 leak なし)
- [ ] timely / DD の最新メジャー (0.13 / 0.14) を crates.io で確認、決定根拠を本書 §6 に追記

### D1-2: L1 → timely Input Adapter (PR 3 の前半)
- [ ] `crates/engine-perception/src/l1_input.rs` 新設
- [ ] L1 ring の `Arc<L1Inner>` を借りる API を `src/l1_capture/` に追加 (e.g. `pub(crate) fn share_inner() -> Arc<...>` か、既存 worker 取得 API 流用)
- [ ] adapter が独立 thread で `ring.pop()` → timely input session に push
- [ ] `EventEnvelope` のうち `UiaFocusChanged` のみを filter (D1 スコープ限定)
- [ ] `(wallclock_ms, sub_ordinal)` を `Pair<u64, u32>` (logical_time) に変換
- [ ] L1 worker が停止してもこの thread が deadlock しない (timeout pop or shutdown signal)

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

## 5. L1 → timely Input Source 仕様

### 5.1 Adapter 構造

```rust
// crates/engine-perception/src/l1_input.rs (擬似コード)
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use timely::dataflow::operators::{Input, InputHandle};
use differential_dataflow::input::InputSession;

pub struct L1ToTimelyAdapter {
    handle: JoinHandle<()>,
    shutdown: Arc<AtomicBool>,
}

impl L1ToTimelyAdapter {
    pub fn spawn(
        l1_inner: Arc<L1Inner>,           // L1 ring の共有 handle
        input: InputSession<Pair<u64, u32>, FocusEvent, isize>,
    ) -> Self { /* ... */ }

    pub fn shutdown(self, timeout: Duration) -> Result<(), ShutdownError> { /* ... */ }
}
```

### 5.2 EventEnvelope → Differential 4-tuple 変換

| L1 EventEnvelope フィールド | timely / DD 表現 |
|---|---|
| `event_id: u64` | (engine 内部の trace key) |
| `wallclock_ms: u64` + `sub_ordinal: u32` | logical_time = `Pair<u64, u32>` |
| `kind: UiaFocusChanged { hwnd, name, ... }` | `FocusEvent { hwnd, ... }` row、diff = +1 |
| (前回の focus row の retraction) | 同 logical_time に diff = -1 |

D1 範囲では `UiaFocusChanged` のみ拾い、他 event kind は drop。

### 5.3 Shutdown ordering (制約 §17.6 / 統合書 §3.4 / SSOT layer-constraints と整合)

L5 → L1 逆順で shutdown する規約。adapter は L1 worker より先に止める：

```
1. adapter.shutdown(2s)  // ring pop loop に shutdown signal、timely input session を drop
2. timely worker join (timely 内部で graceful drain)
3. L1 worker shutdown (既存 P5a の l1_shutdown_for_test と同パターン)
```

---

## 6. timely / differential-dataflow バージョン選定

D1-1 で確認するが、現時点での想定:

| crate | 候補 | 採用根拠 (確定は D1-1) |
|---|---|---|
| `timely` | 0.13.x または 0.14.x | ADR-008 §2 で「0.13+」明示。crates.io の latest が 0.14 なら採用、0.13 のままなら 0.13 |
| `differential-dataflow` | 0.13.x | timely と同期 |

decision criteria:
- 最新 stable major を採用
- breaking change がある場合は本書 §6 と ADR-008 を更新

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
| R1 | `napi build` が workspace 化で壊れる | 高 | D1-0 で `npm run build:rs` を必ず通す。失敗時は root を `[package]` のみに戻し、選択肢 C (同 crate 内モジュール) に切替 |
| R2 | timely 0.13/0.14 に compile-time の重い transitive dep | 中 | `engine-perception` を napi 非依存に保ち、root crate の build に乗せない。CI cache で吸収 |
| R3 | L1 ring から pop する thread が L1 worker と deadlock | 中 | timeout pop (`recv_timeout(100ms)`) + shutdown flag |
| R4 | partial-order semantics を間違えて view が deterministic にならない | 中 | unit test で out-of-order event を必ず covers (D1-4) |
| R5 | bench で 1/10 達成しない | 中 | プロファイリング後に operator graph を最適化、最悪 D2 に carry over (acceptance を D1 メイル基準に変更し、再評価) |
| R6 | windows-rs / vision-gpu feature gate との衝突 | 低 | `engine-perception` は windows-rs 直接依存しない、L1 経由 event 受信のみ |

---

## 10. Open Questions

| # | OQ | 決定タイミング |
|---|---|---|
| 1 | timely 0.13 vs 0.14 どちらを採用 | D1-1 着手時、crates.io の latest stable を確認 |
| 2 | L1 `Arc<L1Inner>` 共有 API のシグネチャ (既存 worker と干渉しない形) | D1-2 着手前、既存 `src/l1_capture/worker.rs` を読む |
| 3 | `current_focused_element` の "current" の定義 (foreground 1 つ vs 全 window 最新) | D1-3 着手前、ADR-008 / views-catalog を再確認 |
| 4 | bench harness の TS 版測定方法 (criterion から MCP tool を呼ぶか、Node 別プロセスか) | D1-5 着手時 |
| 5 | engine-perception を private にするか、将来公開する API surface 設計 | D2 着手前 |

---

## 11. Acceptance Criteria (ADR-008 §8 D1 と完全一致)

- [ ] 1 view が incremental に更新される (`current_focused_element`)
- [ ] unit test pass (partial-order 含む)
- [ ] bench で TS 版より latency 1/10
- [ ] CI green、`npm run build:rs` / `npm test` 回帰なし
- [ ] D1-6 完了 (ドキュメント / メモリ整合)

---

## 12. 関連

- 親 ADR: `docs/adr-008-reactive-perception-engine.md`
- SSOT: `docs/architecture-3layer-integrated.md`
- view 契約: `docs/views-catalog.md` §3.1
- 制約 (起草中): `docs/layer-constraints.md` §3-§4 (本書執筆時、参照のみ)
- L1 base: ADR-007 P5a 完了 (`src/l1_capture/`、`memory/project_adr007_p5a_done.md`)
- 関連 PR (履歴): #79 (main-push guard、merged)、#80 (P5b defer、open)
