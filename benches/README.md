# Bench Harness — Layer SLO Verification

- Status: **D1-5 first bench landed** (ADR-008 D1: `current_focused_element` view + TS baseline measured)
- Date: 2026-04-29 (skeleton) / 2026-04-30 (D1 bench landed)
- Scope: 統合書 §17.3 + `docs/layer-constraints.md` §8 の KPI を CI 計測する Rust ベンチハーネス
- 場所: 既存 `desktop-touch-engine` crate (root Cargo.toml) の `[[bench]]` として配置

---

## 1. 役割

各層の SLO 違反を **CI で fail にする** ためのベンチマークハーネス。

- 設計時の絵に描いた餅ではなく、実装が SLO を守っているかを継続検証
- bench の数値が `server_status` ツールの `tier_dispatch_stats` 等と相互参照可能
- regression を主目的とし、絶対値より「今の main から劣化したか」を重視

---

## 2. 計測対象 (KPI 一覧)

### 2.1 L1 Capture (`benches/l1_capture.rs`)

| KPI | 目標 (制約 §2.4) | bench fn |
|---|---|---|
| event ingest throughput | 10k events/sec | `bench_event_ingest_throughput` |
| event ingest latency p99 | < 1ms | `bench_event_ingest_latency` |
| dirty rect detect cycle | DXGI 60Hz 同期 (16.67ms 周期) | `bench_dirty_rect_60hz` |
| WAL write latency p99 | < 5ms | `bench_wal_fsync_batch` |
| ring buffer overflow rate | < 0.001% | `bench_ring_buffer_overflow_rate` |

### 2.2 L2 Storage (`benches/l2_storage.rs`)

| KPI | 目標 (制約 §3.4) | bench fn |
|---|---|---|
| materialize latency p99 | < 100μs/event | `bench_materialize_latency` |
| `state_at(t)` p99 | < 5ms | `bench_state_at_query` |
| arrangement memory budget | < 512MB (default) | `bench_arrangement_memory_budget` |

### 2.3 L3 Compute (`crates/engine-perception/benches/d1_view_latency.rs` + `benches/d1_ts_baseline.mjs`)

| KPI | 目標 (制約 §4.4 + views-catalog §8) | bench fn | status |
|---|---|---|---|
| current_focused_element 更新 p99 | < 1ms (view side) / TS p99 / 10 (acceptance) | `view_get_hit` / `view_get_miss` (Rust criterion) + `d1_ts_baseline.mjs` (Node) | **Landed (D1-5、`feat/adr-008-d1-5-bench`)** |
| dirty_rects_aggregate 更新 p99 | < 2ms | `bench_view_dirty_rects_aggregate` | D2 |
| semantic_event_stream delta 配信 p99 | < 3ms | `bench_view_semantic_event_stream` | D2 |
| predicted_post_state dry-run p99 | < 50ms | `bench_view_predicted_post_state` | D2 (subgraph) |
| lens_attention settle p99 | < 5ms (max iter 100) | `bench_view_lens_attention` | D4 |

#### D1-5 measured numbers (local run, Windows 11 / Ryzen, release build, 2026-04-30)

| Path | mean | what it measures |
|---|---|---|
| **view_get_hit** (D1 view, populated row) | ~145 ns ±2.4% | **steady-state lookup**: `view.get(hwnd)` returning a cached `UiElementRef` (Arc<RwLock<HashMap>> read) — the post-watermark, frontier-released steady state |
| **view_get_miss** (D1 view, missing key) | ~21 ns ±1.4% | steady-state miss path (HashMap miss) |
| **view_update_latency** (engine-perception ingestion) | **~4.7 ms** ±1.2% | **end-to-end update**: `handle.push_focus(ev)` → `view.get(hwnd)` reflecting the new event's name. Includes cmd-channel hop, worker idle sleep (~1ms), DD reduce, inspect, RwLock write. `WATERMARK_SHIFT_MS=0` set in bench so frontier catches up promptly via idle-advance |
| **uiaGetFocusedElement** (TS baseline, UIA tree walk) | p50 1.7 ms / p95 2.9 ms / **p99 11.2 ms** | `addon.uiaGetFocusedElement()` napi call (`benches/d1_ts_baseline.mjs`, 1000 iters + 100 warmup) — production `desktop_state`'s focus-fetch core (without MCP transport / JSON serialize) |

**Acceptance interpretation (ADR-008 D1 §11)**:

- **Steady-state lookup vs TS UIA fetch**: ratio ≈ **75,000×** (TS p99 11.2 ms / view ~145 ns) — TS / 10 acceptance dramatically met. This is the dominant production read pattern: agent calls `desktop_state` repeatedly to query focus, and each call hits the view's cached state instead of walking the UIA tree.
- **Update latency vs TS UIA fetch**: ratio ≈ **2.4×** (TS p99 11.2 ms / view update ~4.7 ms) — modestly faster than TS, but **does not** beat by 1/10. This is bounded by the perception worker's 1 ms idle-sleep cycle (`worker_loop`'s `TryRecvError::Empty` branch). Tunable to <500 µs by reducing the sleep or switching to a parking primitive — see `docs/adr-008-d1-followups.md` §2.5.
- **The view's value proposition**: in production, *reads dominate updates* by orders of magnitude, so the steady-state-lookup ratio is what materially compounds. Update latency at ~5 ms is comfortably within UI-responsiveness budgets (60 Hz frame ≈ 16.67 ms) but does not yet meet the aspirational `views-catalog` §3.1 SLO of "p99 < 1 ms"; that SLO is reaffirmed as a D2 follow-up in the followups doc.

caveats:

1. **Numbers are criterion's mean ± CI**, not strict p99. Multiplied by 10 for a worst-case bound, the steady-state ratio is still > 7,000×; for update latency the worst-case bound (~50 ms) would slip past TS p99 — D2 should extract true p99 from `target/criterion/.../sample.json`.
2. **"Real L1 input" is not measured here**. The bench pushes through `FocusInputHandle::push_focus` directly, skipping the L1 `EventRing` + `src/l3_bridge/focus_pump.rs` decode hop. That hop is bounded by `recv_timeout(100ms)` + bincode decode (~µs) and exercised for *correctness* by `src/l3_bridge/mod.rs::lifecycle_tests::five_cycle_pipeline_spawn_push_shutdown`, but not under load. A true ring-to-view bench is deferred to D2 (where `desktop_state` will exercise the full path under MCP transport — see followups §2.3).

### 2.4 L4 Envelope Assembly (`benches/l4_envelope.rs`)

| KPI | 目標 (制約 §5.4 + ADR-010 §5.6) | bench fn |
|---|---|---|
| envelope assembly p99 (include 最大時) | < 5ms | `bench_envelope_assembly_full` |
| envelope assembly p99 (必須最小) | < 2ms | `bench_envelope_assembly_minimal` |
| typed reason coverage | > 95% | `bench_typed_reason_coverage` |
| **envelope size (必須最小)** | **< 1KB** | `bench_envelope_size_minimal` |
| **envelope size (失敗 envelope)** | **< 5KB** | `bench_envelope_size_failure` |
| **envelope size (フル include)** | **< 10KB** | `bench_envelope_size_full` |
| `include=causal` の size 加算 | +1KB 以内 | `bench_envelope_size_causal_delta` |
| `include=invariants` の size 加算 | +0.5KB 以内 | `bench_envelope_size_invariants_delta` |
| `include=working:N` の size 加算 | +N×0.3KB 以内 | `bench_envelope_size_working_delta` |
| `include=episodic:N` の size 加算 | +N×0.5KB 以内 | `bench_envelope_size_episodic_delta` |
| `query_past` リンク | +0.1KB | `bench_envelope_size_query_past_delta` |

regression policy: 前回 main から **5% 増で warning、20% 増で fail**。

### 2.5 L5 Tool Surface (`benches/l5_tool_surface.rs`)

| KPI | 目標 (制約 §6.4) | bench fn |
|---|---|---|
| query tool round-trip p99 | < 50ms | `bench_query_round_trip` |
| commit tool round-trip p99 | < 200ms | `bench_commit_round_trip` |
| subscribe push 遅延 p99 | < 10ms | `bench_subscribe_push_latency` |

### 2.6 HW Tier 別 (`benches/tier_dispatch.rs`)

各 op を Tier 0-3 全パターンで計測、cascade 動作を確認。

| op | T0 | T1 | T2 | T3 |
|---|---|---|---|---|
| screen capture | ✓ | ✓ | ✓ | (n/a) |
| dirty rect detect | ✓ | ✓ | (n/a) | ✓ |
| memcpy bulk | ✓ | ✓ | ✓ | (n/a) |
| change_fraction | ✓ | ✓ | (none) | ✓ |
| dhash | ✓ | ✓ | (none) | ✓ |
| timestamp source | ✓ | ✓ | ✓ | ✓ |

env `DESKTOP_TOUCH_MAX_TIER=N` で各 tier に pin して計測。

### 2.6.1 Tier Fallback Overhead (Gemini review 指摘対応、統合書 §9.6)

| KPI | 目標 | bench fn |
|---|---|---|
| Tier N 失敗検出 + Tier N-1 cascade 開始 overhead p99 | < 500μs | `bench_tier_fallback_overhead` |
| 5 連続 Tier 3 失敗 → 強制 Tier 2 pin の動作確認 | (機能テスト) | `bench_tier_pin_after_consecutive_failures` |

これらは個別 op の SLO とは **独立に計測**、op 単位 SLO に含めない。

### 2.7 Replay (`benches/replay.rs`)

| KPI | 目標 (制約 §7.5) | bench fn |
|---|---|---|
| replay determinism | 100% (bit-for-bit 一致) | `bench_replay_determinism_check` |
| WAL→arrangement 再生 throughput | record 時の 5-10x (オフライン) | `bench_replay_throughput` |

---

## 3. ハーネス構造 (criterion ベース)

### 3.1 Cargo.toml 追加項目

```toml
[dev-dependencies]
criterion = { version = "0.5", features = ["html_reports"] }

[[bench]]
name = "l1_capture"
harness = false

[[bench]]
name = "l2_storage"
harness = false

[[bench]]
name = "l3_compute"
harness = false

[[bench]]
name = "l4_envelope"
harness = false

[[bench]]
name = "l5_tool_surface"
harness = false

[[bench]]
name = "tier_dispatch"
harness = false

[[bench]]
name = "replay"
harness = false
```

### 3.2 各 bench ファイル雛形

```rust
// benches/l1_capture.rs (skeleton)
use criterion::{criterion_group, criterion_main, Criterion, BenchmarkId};

fn bench_event_ingest_throughput(c: &mut Criterion) {
    // TODO(ADR-007 P5a 完了後): EventEnvelope を ring buffer に push
    todo!("Implement after ADR-007 P5a");
}

fn bench_event_ingest_latency(c: &mut Criterion) {
    todo!("Implement after ADR-007 P5a");
}

// ... (他の KPI 関数)

criterion_group!(benches,
    bench_event_ingest_throughput,
    bench_event_ingest_latency,
);
criterion_main!(benches);
```

実装は **対応する ADR Phase が完了してから** 各 bench fn を埋めていく。

---

## 4. 起動手順

```bash
# D1-5 (本書 §2.3 で landed): view path latency
cargo bench -p engine-perception --bench d1_view_latency

# D1-5: TS baseline (UIA path、Windows session 必須)
node benches/d1_ts_baseline.mjs           # 1000 iters (default)
node benches/d1_ts_baseline.mjs 5000      # 高精度

# 将来 (各 ADR Phase 完了で追加される bench)
cargo bench                                # 全 bench
cargo bench --bench l1_capture
cargo bench --bench l3_compute -- bench_view_lens_attention
DESKTOP_TOUCH_MAX_TIER=1 cargo bench --bench tier_dispatch
DESKTOP_TOUCH_MAX_TIER=3 cargo bench --bench tier_dispatch
```

結果は `target/criterion/` に HTML レポート出力。

---

## 5. CI 連動 (将来)

- main への merge 時に bench 実行
- 前回 main からの regression を検出 → 5% 劣化で warning、20% で fail
- `server_status` ツール経由で実運用環境の SLO とも相互参照
- (将来) GitHub Actions で nightly benchmark + push to gh-pages

---

## 6. KPI と Acceptance Criteria の対応

| ADR Phase | 検証する bench |
|---|---|
| ADR-007 P5a | `l1_capture::bench_event_ingest_*` |
| ADR-007 P5b | `replay::bench_replay_determinism_check` |
| ADR-007 P5c | `tier_dispatch::*` (Tier 1 DXGI dirty rect 動作確認) |
| ADR-008 D1 | `l3_compute::bench_view_current_focused_element` |
| ADR-008 D2 | `l3_compute::bench_view_*` (主要 4 view 全部) |
| ADR-008 D3 | `l2_storage::bench_state_at_query` |
| ADR-008 D4 | `l3_compute::bench_view_lens_attention` |
| ADR-008 D5 | `tier_dispatch::*` (Tier 3 動作)、`l3_compute::bench_view_predicted_post_state` |
| ADR-008 D6 | `replay::*` 全部 |
| ADR-010 P1 | `l4_envelope::bench_envelope_assembly_minimal` |
| ADR-010 P3 | `l4_envelope::bench_envelope_assembly_full` |
| ADR-010 P5 | `l3_compute::bench_view_predicted_post_state` 経由 |
| ADR-010 P6 | `l4_envelope::*` (working/episodic 含む include 経路) |

---

## 7. Skeleton の段階的肉付け

| Phase | ADR の前提 | 何を埋める |
|---|---|---|
| **現状** (Skeleton) | (準備のみ) | README のみ。Cargo.toml の [[bench]] と空関数の `.rs` 雛形は ADR-007 P5a 着手時に追加 |
| **ADR-007 P1-P4 完了後** | koffi 撤去完了 | bench 対象がまだ無いので skeleton のまま |
| **ADR-007 P5a 完了後** | EventEnvelope + ring buffer 動作 | `l1_capture::bench_event_ingest_*` を実装、CI ベースライン作成 |
| **ADR-007 P5b 完了後** | WAL + replay E2E | `replay::*` を実装 |
| **ADR-008 D1 完了後** | timely + DD 1 view 動作 | `l3_compute::bench_view_current_focused_element` を実装、ベースライン更新 |
| ... 以降、Phase 完了ごとに対応 bench を実装、CI で regression 監視 |

---

## 8. Related Files

- 統合書: `docs/architecture-3layer-integrated.md` §17.3 (KPI 総覧)
- 制約: `docs/layer-constraints.md` §8 (Acceptance Criteria 集約)
- ADR-007: `docs/adr-007-koffi-to-rust-migration.md`
- ADR-008: `docs/adr-008-reactive-perception-engine.md`
- ADR-010: `docs/adr-010-presentation-layer-self-documenting-envelope.md`
- views-catalog: `docs/views-catalog.md` §8

---

END OF Bench Harness README (Skeleton).
