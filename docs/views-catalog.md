# Views Catalog — L3 Compute で実装する全 view 一覧

- Status: **Draft (起草中)**
- Date: 2026-04-29
- Authors: Claude (Opus, max effort)
- Scope: ADR-008 (L3 Compute) で実装する materialized view の一覧と契約
- 役割: D2 着手前に view 数・shape・consumer を確定し、実装担当者がブレずに進められるようにする
- 関連:
  - 統合書 (SSOT): `docs/architecture-3layer-integrated.md`
  - 制約: `docs/layer-constraints.md` §4 (L3 Compute)
  - 詳細: `docs/adr-008-reactive-perception-engine.md`

---

## 1. 役割と運用

### 1.1 本書の位置づけ

ADR-008 D2 は「主要 view 4 つを declarative に実装」を完了基準にしているが、4 つだけでは envelope 組立て (ADR-010) や server_status 拡張 (統合書 §13) を支えきれない。

本書は **L3 view 全体のカタログ** として、

- view 名 (Rust API として一意)
- input arrangement / collection
- output collection の shape (Rust struct)
- consumer (どの ADR / どの envelope セクションが消費するか)
- SLO (latency / memory)
- phase (どのリリースで実装)

を全 view について定める。

### 1.2 view 追加プロセス

新しい view が必要になった場合:

1. 本書に **行を追加** (名前 / input / output shape / consumer / SLO / phase)
2. ADR-008 D2 のチェックリストに **未着手として登録**
3. PR で view 実装と同時に本書を **`Implemented` に flip**
4. envelope セクションへの projection を ADR-010 で追記 (consumer が L4 の場合)

### 1.3 命名規則

- snake_case (Rust 識別子と整合)
- 名詞句、動詞は使わない (例: `current_focused_element` ✓、`get_focused_element` ✗)
- 複数形は集約に使う (例: `dirty_rects_aggregate`)
- 時間窓は suffix で示す (例: `recent_changes_5s`)
- 投機 / 派生は prefix で示す (例: `predicted_post_state`、`replay_focused_element`)

---

## 2. View の分類 (5 カテゴリ)

| カテゴリ | 性質 | 例 |
|---|---|---|
| **state** | 現在値、1 row | current_focused_element, current_modal |
| **aggregate** | 集計、N rows | dirty_rects_aggregate, fallback_events |
| **event-stream** | delta 連続、subscribe 配信 | semantic_event_stream |
| **projection** | 既存 view の整形 | tier_dispatch_stats, worker_lag_metrics |
| **cyclic** | 不動点 / iterative | lens_attention |

特殊系:
- **dry-run subgraph**: read-only fork 上の view (本番 arrangement に書き戻さない)
- **time-travel point query**: arrangement の time slice に対する一発 query (連続 view ではない)

---

## 3. 主要 view 一覧 (Phase 別)

### 3.1 D1: 最小成立 (1 view)

| view 名 | category | input | output (Rust struct) | consumer | SLO | phase | status |
|---|---|---|---|---|---|---|---|
| `current_focused_element` | state | `UiaFocusChanged` events from L1 | `UiElementRef { name, automation_id, control_type, window_title }` | L4 envelope.data (desktop_state) | **lookup** p99 < 1ms (達成、D1: ~145ns / D2-A v3.8: 300ns)<br>**update** p99 < 1ms (**setup-dependent**: D1-5 旧 baseline `shift=0` ~4.7ms / v3.7 暫定 `shift=0`+max+1 release 3.04ms = N2 違反で**撤回** / **D2-A v3.8 production 相当 `shift=default` ~127ms** = release が `shift_ms` に律速される構造的下限)、engine-perception 単独 SLO 比較は本 D2-A で結論を出さず D2-B-4 MCP round-trip 計測で再評価 (ADR-008 D2 plan §10 OQ #16) | D1 / D2-A | **Implemented + Benched (D1-3 + D1-5 + D2-A v3.8 watermark-shift restored)** |

> **D1-3 実装完了 (2026-04-30)**: operator graph 本体を `crates/engine-perception/src/views/current_focused_element.rs` に新設。`map(FocusEvent → (hwnd, ((wallclock, sub), UiElementRef)))` → `reduce(per-hwnd last-by-time)` → `inspect(diff bookkeeping)` → `Arc<RwLock<HashMap<u64, BTreeMap<UiElementRef, i64>>>>` 読み取り API (`get(hwnd)` / `snapshot()` / `len()` / `is_empty()`)。pivot 4 フィールド (`source_event_id` / `wallclock_ms` / `sub_ordinal` / `timestamp_source`) は output から除外し L4 envelope 側で別途搬送。
>
> **idle frontier advance (PR #91 P2 review fix)**: real L1 capture には heartbeat がないため、focus が変化して停止すると watermark が進まず、最新 event が永久に view に出ない問題を発見。`worker_loop` の idle 分岐で `last_event_anchor: (wallclock_ms, Instant)` から real elapsed 時間を加算して `latest_wallclock_ms` を projection、watermark を進めるように変更 (`crates/engine-perception/src/input.rs::worker_loop`)。これで quiescent focus も view に materialise される。production の monotone real-time wallclock では legitimate な後続 event を back-dated 扱いにすることはない。
>
> **D1-5 bench 完了 (2026-04-30)**: `crates/engine-perception/benches/d1_view_latency.rs` (criterion、3 fn) + `benches/d1_ts_baseline.mjs` (Node)。
>
> - **steady-state lookup**: `view_get_hit` ~145ns / `view_get_miss` ~21ns。TS baseline (`uiaGetFocusedElement`) p99 ≈ 11.2ms → **ratio ~75,000×** で「lookup 1/10」acceptance を大幅クリア。
> - **update latency** (engine-perception ingestion): `view_update_latency` ~4.7ms (`handle.push_focus → view.get` 反映、`WATERMARK_SHIFT_MS=0` 設定下)。TS p99 の **2.4× faster にとどまり、`update p99 < 1ms` SLO は未達**。worker_loop の 1ms idle sleep がボトルネック、tuning は D2 carry-over (`docs/adr-008-d1-followups.md` §2.5)。
> - **「real L1 input ベース」 (L1 EventRing 込み全経路) bench は未実施**: `FocusInputHandle::push_focus` 直接呼び出しから計測 (engine-perception 境界、cdylib 制約のため)。D2 で `desktop_state` を view 経由置換時に MCP transport 込み bench と同時実装、followups §2.3。
>
> 詳細: `benches/README.md` §2.3 D1-5 measured numbers。
>
> **D2-A revised tuning 完了 (2026-04-30、PR-β v3.8 後)**: `worker_loop` を batch-drain + step_until_idle に書き換え (ADR-008 D2 plan §4.2)。phase 1 で `recv_timeout(1ms)` で cmd 即起床、phase 2 で `try_recv` drain (cap 64)、phase 3 で `update_at` × batch + N3 partial-order guard、phase 4 で `event_count > 0` ガード後 **`advance_to(watermark_for(max_wc, shift_ms))` (= D1 watermark-shift 互換)** + `step_until_idle` (cap 32)。bench harness に true p99 抽出 (`b.iter_custom` + `target/criterion/d2_summary.jsonl`、followups §2.1 Resolved)。
>
> - **lookup**: `view_get_hit` p50/p95/p99/p999 = 200/300/300/500 ns、`view_get_miss` p50/p95/p99/p999 = 0/100/100/300 ns。SLO `< 1ms` 余裕クリア継続
> - **update**: `view_update_latency` の数値は **bench setup 依存** (Codex v10 P1/P2 修正で N2 contract 維持を優先した結果、release が `idle-advance` projection に律速される構造):
>   - `shift_ms = default 100ms` + wc 200ms 増分 (production-相当): p50/p95/p99/p999 = 125/127/**127**/127 ms、release が `shift_ms` 周期に律速される構造的下限
>   - `shift_ms = 0` + 大増分: ~32ms (idle-advance race の artefact、production と無関係)
>   - D2-A v3.7 暫定 (max+1 release、N2 違反、Codex v10 撤回): 3.04ms ← この数値は **N2 contract 違反下** での値、retain 不可
>   - D1 baseline (`shift=0`、bench old): 4.7ms ← 同様に N2 acceptance window 0 設定下の値
> - **engine-perception 単独 SLO 比較は本 D2-A で結論を出さない**: production caller (MCP tool) から見た実質 latency は napi + JSON-RPC + L1 ring + focus_pump + view を含む別物。**D2-B-4 の `d2_desktop_state_roundtrip.mjs` (MCP transport 込み) が SLO の本来の指標**。option C (parking_lot::Condvar 等 signal-driven) は MCP 数値を見てから判断 (ADR-008 D2 plan §10 OQ #16、ユーザー判断 2026-04-30)
> - SLO `< 1ms` の表記は **緩和しない** (ユーザー判断)、bench harness は production-相当条件 (`shift=default`、wc 200ms 増分) に確定済 (`crates/engine-perception/benches/d1_view_latency.rs`)
> - partial-order test 5 件 (`same_wallclock_different_sub_ordinal_all_observed` 等) で N3 acceptance を直接 pin、stuck-worker fixture (`Cmd::BlockForTest`) で OQ #15 (Codex v9 P2-17 retry-fail branch) も Resolved

### 3.2 D2: 主要 view 4 つ (本書の主スコープ)

| view 名 | category | input | output | consumer | SLO | phase |
|---|---|---|---|---|---|---|
| `current_focused_element` | state | (D1 と同じ) | (D1 と同じ) | (D1 と同じ) | (D1 と同じ) | D1 (carry-over) |
| `dirty_rects_aggregate` | aggregate | `DirtyRect` events (DXGI) | `Vec<Rect> + summary { count, total_area }` | L4 envelope.invariants_held + screenshot diff 判定 | p99 < 2ms | D2 |
| `semantic_event_stream` | event-stream | `UiaFocusChanged`, `WindowChanged`, `DirtyRect`, `ScrollChanged` | `SemanticEvent { kind: ModalAppeared/FocusMoved/ScrollSettled/..., ts, context }` | L4 envelope.caused_by + subscribe 配信 | p99 < 3ms | D2 |
| `predicted_post_state` | dry-run subgraph | tool_call (仮想) + 現 state | `StateDelta { focus, modal, dirty_rect_estimate, confidence }` | L4 envelope.if_you_did | p99 < 50ms | D2 (subgraph 構造、計算の本格化は D5) |

### 3.3 D2.5: working / episodic memory (ADR-010 P6 と擦合せ)

| view 名 | category | input | output | consumer | SLO | phase |
|---|---|---|---|---|---|---|
| `recent_changes_5s` | aggregate | 全 EventEnvelope (5s 窓) | `Vec<EventSummary>` (compact) | L4 envelope.caused_by.recent_window (`include=working:N`) | p99 < 3ms | D2.5 |
| `tool_call_history` | aggregate | `ToolCallStarted` / `ToolCallCompleted` events | `Vec<ToolCallSummary { tool, args_redacted, outcome, ts, elapsed }>` | L4 envelope.caused_by.tool_call_history (`include=episodic:N`) | p99 < 3ms | D2.5 |

### 3.4 D3: time-travel (point query)

| view 名 | category | input | output | consumer | SLO | phase |
|---|---|---|---|---|---|---|
| `state_at(t: wallclock_ms)` | time-travel point query | arrangement の time slice | 上記 state/aggregate の t 時点値 | envelope.query_past 経由 | p99 < 5ms | D3 |
| `diff(t1, t2)` | time-travel diff | arrangement の 2 time slice | `StateDelta` | envelope.query_past.diff_since_last_call | p99 < 10ms | D3 |

注: `state_at` は view ではなく **arrangement への point query** だが、L3 API 表面では view 同様に扱う。compaction frontier 範囲内の t に対してのみ正しい結果を返す (制約 layer-constraints §3.3)。

### 3.5 D4: cyclic (RPG lens)

| view 名 | category | input | output | consumer | SLO | phase |
|---|---|---|---|---|---|---|
| `lens_attention` | cyclic (fixed-point) | `current_focused_element` + lens spec map + lens dependencies | `Vec<LensState { id, focus_score, attention, hot_targets }>` | L4 envelope (desktop_state attention 部) + 既存 RPG | max iter 100、p99 < 5ms (settle 含む) | D4 |
| `modal_state` | state | UIA dialog event + window class match | `Option<ModalRef { name, kind, blocker_for }>` | L4 envelope.if_unexpected.blocker | p99 < 1ms | D4 |
| `attention_signal` | projection | lens_attention + dirty_rects_aggregate | `AttentionLevel { ok | changed | dirty | settling | stale }` | L4 envelope.confidence、既存 RPG | p99 < 1ms | D4 |

### 3.6 D5: HW-accelerated (Tier 3 動作する view)

| view 名 | category | input | output | consumer | SLO | phase |
|---|---|---|---|---|---|---|
| `change_fraction_per_window` | aggregate (GPU 対応) | DXGI dirty rect + screenshot pixel | `f64 per window` | screenshot 判定、anti-fukuwarai | Tier 3: p99 < 0.5ms (1080p)、Tier 0: < 4ms | D5 |
| `dhash_per_window` | projection (GPU 対応) | screenshot frame | `u64 per window` | scroll/screenshot 重複検出 | Tier 3: p99 < 0.3ms、Tier 0: < 2ms | D5 |

### 3.7 server_status 拡張 view (統合書 §13.2)

| view 名 | category | input | output | consumer | SLO | phase |
|---|---|---|---|---|---|---|
| `tier_dispatch_stats` | aggregate | 全 op の tier hit/miss event | `Map<OpKind, TierStats { T0, T1, T2, T3 }>` | server_status data | p99 < 1ms | D2 (統合書 §13.2 と同期) |
| `worker_lag_metrics` | projection | timely worker frontier vs wallclock | `LagStats { p50, p95, p99 }` | server_status data | p99 < 1ms | D2 |
| `arrangement_size_metrics` | projection | arrangement 内部 stat | `Map<ViewName, SizeStats>` | server_status data | p99 < 1ms | D2 |
| `recent_failures_log` | event-stream | `Failure` / `TierFallback` events | `Vec<FailureRecord { op, tier, vendor, reason, ts }>` (LRU 100) | server_status data | p99 < 2ms | D2 |

---

## 4. 特殊 view の追加詳細

### 4.1 `predicted_post_state` の subgraph 構造

```
本番 worker:
  L1 input → arrangement A (read-write、本番)
                    │
                    │ (read-only fork)
                    ▼
  Dry-run subgraph (別 worker thread or sub-region):
    投機 input (tool_call, 仮想) → arrangement A の copy → predicted_post_state view
                                                                │
                                                                ▼
                                                        L4 envelope.if_you_did

副作用なし、本番 arrangement 不変。
```

入力契約:
- `tool_call_id` 必須 (どの呼び出しの予測か)
- `tool` + `args` (実際の commit 形式と同じ shape)
- 制約: 投機実行は **副作用を持つ tool 限定** (commit 軸のみ、ADR-010 §3 のリストと同じ)

出力契約:
```rust
pub struct PredictedPostState {
    pub predicted_focus: Option<UiElementRef>,
    pub predicted_modal: Option<ModalRef>,
    pub predicted_dirty_rect: Option<Rect>,
    pub confidence: ConfidenceLevel,   // High | Medium | Low
    pub computation_ms: u32,
}
```

### 4.2 `lens_attention` の cyclic 構造 (D4)

```rust
worker.dataflow::<u64, _, _>(|scope| {
    let focused = current_focused_element_input(scope);
    let lens_specs = lens_spec_input(scope);

    let attention = scope.iterative::<u32, _, _>(|inner| {
        let focused_inner = focused.enter(inner);
        let specs_inner = lens_specs.enter(inner);

        // 1) lens spec ごとに binding を解決
        let bindings = resolve_bindings(&focused_inner, &specs_inner);

        // 2) maintain key を展開して fluent-store query
        let lens_states = compute_lens_states(&bindings);

        // 3) attention level を派生
        let attention = derive_attention(&lens_states);

        // 不動点に達するまで内側で iterate
        attention.leave()
    });

    attention.inspect(|x| /* push to subscribers */);
});
```

不動点判定 = `lens_states` の delta が空 (Z-set 加減算で 0)。

### 4.3 `state_at(t)` の実装

```rust
pub fn state_at<V>(arrangement: &Arrangement<...>, t: u64) -> Result<V> {
    if t < arrangement.compaction_frontier() {
        return Err(typed_error("TimeCompacted"));  // 専用 enum (ADR-010 §5.4)
    }
    arrangement
        .as_collection()
        .as_of(t)               // timely の time slice 操作
        .first()                // state view は 1 row 想定
        .ok_or(typed_error("EntityNotFound"))
}
```

compaction frontier の管理は L2 担当 (制約 layer-constraints §3.3)。

---

## 5. View の同期保証

### 5.1 view 間の整合性

複数 view の値を envelope に同梱するとき、すべて **同じ logical_time** で取得することを保証。

```rust
let cap = scope.capability_for(t);
let focused = current_focused_element.read_at(cap);
let modal = modal_state.read_at(cap);
let dirty = dirty_rects_aggregate.read_at(cap);
// すべて t 時点の atomic snapshot
```

この atomic 取得が **観測整合性** を保証 (envelope.invariants_held の根拠)。

### 5.2 frontier 進行と SLO の関係

- worker frontier が advance する周期 = view 更新の最小単位
- frontier がいつまでも止まると view が古い → `confidence: stale`
- frontier 進行は **L1 input 到着 + Reflex/DXGI tick** で driven
- アイドル時は `Heartbeat` event を L1 から流して frontier を進める (制約 §2.7)

---

## 6. View 計算と HW Tier の対応

| view | Tier 0 (Pure Rust) | Tier 1 (OS API) | Tier 3 (Vendor compute) |
|---|---|---|---|
| current_focused_element | ✓ scalar | (n/a) | (n/a — UIA は CPU only) |
| dirty_rects_aggregate | ✓ scalar | ✓ DXGI dirty rect 直接利用 | (n/a) |
| semantic_event_stream | ✓ scalar | (n/a) | (n/a) |
| predicted_post_state | ✓ scalar | (n/a) | (n/a — semantic 推論は L1 NPU 経由) |
| change_fraction_per_window | ✓ scalar | ✓ rayon SIMD | ✓ CUDA Graph reduce |
| dhash_per_window | ✓ scalar | ✓ rayon SIMD | ✓ CUDA / HIP / L0 kernel |
| lens_attention | ✓ scalar | (n/a — 純粋 Rust) | (n/a) |
| modal_state | ✓ scalar | (n/a) | (n/a) |
| attention_signal | ✓ scalar | (n/a) | (n/a) |
| 全 server_status view | ✓ scalar | (n/a) | (n/a) |

→ Tier 3 が効くのは **change_fraction / dhash の数値計算系 2 view** に集中。それ以外は CPU で十分。

---

## 7. View 数のサマリ

| Phase | 新規 view 数 | 累積 | 主な consumer |
|---|---|---|---|
| D1 | 1 | 1 | desktop_state minimum |
| D2 | 7 (主要 4 + server_status 4 のうち 1 carry) | 8 | desktop_state full + server_status |
| D2.5 | 2 | 10 | working / episodic memory |
| D3 | (point query 2 件、view としては既存活用) | 10 | time-travel |
| D4 | 3 | 13 | RPG cyclic + modal + attention |
| D5 | 2 | 15 | HW-accelerated |

**最終的に L3 view は 15 程度**。tool 数 28 と比べてはるかに少ない (1 view が複数 tool の data を提供)。

---

## 8. Acceptance Criteria

各 view について bench で計測する KPI:

| view | KPI | 目標 |
|---|---|---|
| current_focused_element | 更新 latency | p99 < 1ms |
| dirty_rects_aggregate | 更新 latency + memory | p99 < 2ms / < 50MB |
| semantic_event_stream | delta 配信遅延 | p99 < 3ms |
| predicted_post_state | dry-run latency | p99 < 50ms |
| state_at(t) | point query latency | p99 < 5ms |
| lens_attention | settle latency (max iter 込) | p99 < 5ms |
| change_fraction_per_window (Tier 3) | 1080p latency | p99 < 0.5ms |
| 全 server_status view 合計 | 集約 query | p99 < 5ms |

bench harness (`bench/`) で全 view を CI 計測 (制約 §13.1)。

---

## 9. Open Questions

| # | OQ | 決定タイミング |
|---|---|---|
| 1 | recent_changes の窓サイズ default (3s / 5s / 10s) | D2.5 着手時 |
| 2 | tool_call_history の args_redacted 方針 (PII / secret 検出) | D2.5 着手前 |
| 3 | predicted_post_state の confidence 計算式 | D5 着手時 |
| 4 | state_at(t) の compaction 範囲外エラー codes (LeaseExpired ではなく専用 code が要るか) | D3 着手時 |
| 5 | lens_attention の max iter default (100 で十分か) | D4 着手時、bench 経由 |
| 6 | change_fraction / dhash の Tier 3 dispatch 単位 (per-window or per-frame) | D5 着手時 |

---

## 10. Related Files

- 統合書: `docs/architecture-3layer-integrated.md`
- 制約: `docs/layer-constraints.md` §4 (L3 Compute)
- ADR-008: `docs/adr-008-reactive-perception-engine.md` (D1-D6 の本体)
- ADR-010: `docs/adr-010-presentation-layer-self-documenting-envelope.md` (consumer 側)
- (起草予定) `bench/` crate skeleton (本書 §8 を測定するハーネス)

---

END OF Views Catalog (Draft).
