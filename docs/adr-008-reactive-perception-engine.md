# ADR-008: Reactive Perception Engine via Differential Dataflow

- Status: **Proposed (Draft for review)**
- Date: 2026-04-29
- Authors: Claude (Opus, max effort) — project `desktop-touch-mcp`
- Related:
  - ADR-005: `docs/visual-gpu-backend-adr-v2.md` (Phase 4b 完了、本 ADR の前段)
  - ADR-006: `docs/adr-006-winml-rust-binding.md` (Draft、Layer 5 の NPU 投影で参照)
  - ADR-007: koffi → Rust 全面移行 (Draft、本 ADR の Layer 1 = センサー層を担う)
  - 後続: ADR-009 (HW Acceleration Plane の Tier 別実装ガイド)
  - 後続: ADR-010 (LLM-facing Presentation Layer、view → tool 結果の整形)
- 北極星: 観測コスト log(N) + 時間軸 first-class + cyclic RPG + 公開価値 (世界初の埋め込み MVCC+IVM agent runtime)

---

## 1. Context

### 1.1 これまでの痛点

現状 `desktop-touch-mcp` の観測は以下の問題を抱える。

1. **再 poll cost**: `desktop_state` を呼ぶたびに UIA を叩き直し。LLM context が同じ情報を何度も食う
2. **時間文脈なし**: 「2 秒前と今でどう変わったか」を引く API がない。LLM が screenshot を 2 回撮って比較
3. **副作用検証が手作業**: click が成功したか LLM が再観測で確認
4. **失敗の局所化が弱い**: koffi sigsegv で Node プロセス全滅
5. **raw event の山**: LLM が UIA event / pixel diff の生データを処理

### 1.2 LLM が真に欲しいもの

「Tool の量」ではなく以下が境界条件 (詳細はチャット議論参照、ADR-010 で再整理)。

| 要求 | 現状 |
|---|---|
| 観測キャッシュ + 差分 | ❌ 毎回 refetch |
| 時間文脈 (過去 / 直前) | ❌ なし |
| 副作用予測 / dry-run | ❌ なし |
| 失敗局所化 | ⚠️ 部分 (catch_unwind なし) |
| 意味イベント (raw でなく) | ⚠️ 部分 (RPG attention のみ) |
| 情報密度 (融合 atomic) | ❌ tool 1 呼び 1 段 |

### 1.3 物理基盤側 (ADR-007 で構築するもの)

センサー層 = Layer 1 Capture は ADR-007 で:

- **DXGI Desktop Duplication** (`GetFrameDirtyRects` / `GetFrameMoveRects`) — Windows DWM が GPU 側で計算済みの dirty 矩形をそのまま使う
- UIA event + tool call + 副作用 → 統一 event ring buffer
- HW assist (任意): Intel DSA (memcpy offload) / NVENC (frame 圧縮) / Intel PT (命令 trace)
- 時刻同期: NVIDIA Reflex Latency API / DXGI Present statistics / `DwmGetCompositionTimingInfo` の hw timestamp

これは観測の **物理基盤**。本 ADR-008 はその上の **データ層** = 計算 + 保管モデルを定める。

### 1.4 SSOT 参照

本 ADR の不変条件・SLO・境界は **統合書** (`docs/architecture-3layer-integrated.md` §4-§5、§17) と **`docs/layer-constraints.md` §3-§4** (L2 Storage / L3 Compute) を SSOT とする。本 ADR で記述された規約と SSOT の間に齟齬が生じた場合、SSOT を優先し、本 ADR は後追い更新する (統合書 §16.1 のルール)。

主な参照対応:
- 識別子ヒエラルキー (event_id / lease_token 等) → 統合書 §4
- 時刻モデル (wallclock_ms canonical、sub_ordinal、Reflex 等の優先順) → 統合書 §5
- L2 Storage 制約 (materialize p99 < 100μs、`state_at(t)` p99 < 5ms 等) → layer-constraints §3
- L3 Compute 制約 (view 更新 p99 < 1ms、cyclic max iter 100 等) → layer-constraints §4
- Tier 0-3 dispatch (op 単位独立、`server_status` で集約) → 統合書 §9

---

## 2. Decision

### 2.1 主要決定 (10 項目)

| # | 項目 | 決定 |
|---|---|---|
| 1 | 計算モデル | `differential-dataflow` 0.13+ on `timely-dataflow` 0.13+ |
| 2 | 保管モデル | arrangement = built-in MVCC store。別 store 不要 |
| 3 | 時間モデル | timely logical time = `Pair<u64, u32>` = `(wallclock_ms, sub_ordinal)` の **partial-order** |
| 4 | 外部時刻同期 | NVIDIA Reflex / DXGI Present statistics / `DwmGetCompositionTimingInfo` の hw timestamp で input frontier 進行 |
| 5 | I/O インタフェース | L1 ring buffer → timely input、subscribe API は timely capability で実装 |
| 6 | Cyclic | RPG lens 依存を timely `Loop` で表現 (fixed-point) |
| 7 | HW 接続 | `trait DataflowAccelerator` の裏に CUDA Graph / HIP Graph / Level Zero command list を隠す。**Tier 0-3** の段階で fallback あり (§5 参照) |
| 8 | 永続化 | arrangement snapshot + WAL で replay 可。Intel PT trace を組合せて hw replay |
| 9 | DBSP | **不採用** (linear synchronous time が UIA out-of-order と非互換)。将来 SQL UI が必要なら上に乗せる選択肢として残す |
| 10 | Hydroflow | **不採用** (distributed は overshoot)。複数 agent 共有 perception の話が出たら再評価 |

### 2.2 決め手 — UI 観測ドメインは partial-order の世界

- UIA event は遅れて届く (ProviderProxy 遅延、AccessDenied 復活など) → out-of-order datapoint を後から差し込みたい
- tool 呼び出しと環境変化が並行 → 同 wallclock の 2 event が因果的に独立
- Reflex hw timestamp は CPU/GPU/scan-out で別軸 → 1 次元 linear time に潰せない
- RPG lens 依存 = cyclic、fixed-point computation が一級

DBSP の linear synchronous time は上記すべてで詰まる。**partial-order + cyclic + production 実績で differential-dataflow が一択**。

### 2.3 重要発見 — Arrangement = 無料の MVCC

Materialize blog の実装解説より:

> "An index becomes version-aware and becomes a multiversion index, or more specifically, a map from key -> versions -> list of values, which is roughly analogous to arrangements in the Rust implementation."

timely + DD の `arrangement` は `(key, val, time, diff)` 4-tuple の LSM-tree 風 sorted batch を **multi-version** で保持する。つまり、

- 設計の **L2 (MVCC time-travel store)** と **L3 (IVM compute)** が **同一構造体で実現**
- 別の MVCC store を実装する必要が **無い**
- `state_at(t)` は arrangement の time slice をなぞるだけ

設計書では別レイヤーに見えていたものが、実装上は **1 個のデータ構造に畳まれる**。複雑度が大幅に下がる重要シグナル。

---

## 3. Architecture

### 3.1 5 層との位置づけ

```
┌─────────────────────────────────────────────────────────┐
│ L5: MCP Tool Surface             ← ADR-010 (起草予定)   │
│     既存ツールが view を read/subscribe/commit する    │
│     薄いクライアントになる                              │
├─────────────────────────────────────────────────────────┤
│ L4: Cognitive Projection         ← ADR-010             │
│     working / episodic / semantic / procedural を view  │
├─────────────────────────────────────────────────────────┤
│ L3: Compute (IVM)                ← 本 ADR-008 ★        │
│     differential-dataflow operator graph                │
│     change_fraction / semantic_event / dirty_rect /     │
│     predicted_post_state を declarative に維持          │
├─────────────────────────────────────────────────────────┤
│ L2: Storage (MVCC)               ← 本 ADR-008 ★        │
│     arrangement = (key, val, time, diff) の 4-tuple     │
│     time-travel query は time slice 走査                │
├─────────────────────────────────────────────────────────┤
│ L1: Capture (event ring buffer)  ← ADR-007             │
│     DXGI dirty rect + UIA + tool call + 副作用を       │
│     統一 event log に押し出す                           │
│     HW assist tier 別 (§5)                             │
└─────────────────────────────────────────────────────────┘
```

### 3.2 主要 view の例 (D2 で実装する 4 view)

| view 名 | 入力 | 用途 | 旧 tool との対応 |
|---|---|---|---|
| `current_focused_element` | UIA focus event | 現在 focus 要素 | `desktop_state.focused` |
| `dirty_rects_aggregate` | DXGI dirty/move rect event | 直近 dirty 矩形集約 | `screenshot` の差分判定 |
| `semantic_event_stream` | raw UIA + dirty rect + Reflex tick | "modal_appeared" / "scroll_settled" 等 | `desktop_state.attention` の高度化 |
| `predicted_post_state` | tool call (仮想) + 現 state | dry-run 投機実行 | (新規) |

### 3.3 cyclic / fixed-point の表現

RPG の lens 再計算は: focus 変化 → lens 評価 → attention 更新 → さらに focus へ影響、というループ。timely の `iterative` で:

```rust
worker.dataflow::<u64, _, _>(|scope| {
    let focus_events = make_focus_input(scope);
    let attention = scope.iterative::<u32, _, _>(|inner| {
        let focused = focus_events.enter(inner);
        let lenses = compute_lenses(&focused);
        let attention = derive_attention(&lenses);
        // 不動点に達するまで内側で iterate
        attention.leave()
    });
    attention.inspect(|x| /* push to subscribers */);
});
```

`iterate` は **不動点に到達した値だけ外に出す** ので、lens 再計算が settle してから LLM へ通知される。

### 3.4 時刻モデルの統合

```
external clock (hw)        timely internal frontier
    │                              │
    ├─ Reflex Latency API ─────────┤
    ├─ DXGI Present statistics ────┤  → InputFrontier::advance(t)
    ├─ DwmGetCompositionTimingInfo ┤
    │                              │
    └─ wallclock fallback ─────────┘
```

各 input event は `(wallclock_ms, sub_ordinal)` でタグ。同じ wallclock の事象は sub_ordinal で順序付け。Reflex 等が利用不可な環境では wallclock のみ → partial-order 性は保たれる。

---

## 4. Implementation Phases

| Phase | 範囲 | 完了基準 |
|---|---|---|
| **D1: 最小成立** | timely + DD を `engine-perception` crate に組込み、event log → `current_focused_element` の最小 view | 1 view が incrementally 更新、unit test pass、TS 版より latency 1/10 |
| **D2: 主要 view 4 つ** | `dirty_rects_aggregate` / `semantic_event_stream` / `predicted_post_state` を declarative に | 既存 `desktop_state` を全部 view 経由に置換、tool 結果が同一 (回帰なし) |
| **D3: time-travel** | arrangement の time slice で `state_at(t)` 実装 | 「2 秒前の state」が引ける、p95 latency < 5ms |
| **D4: cyclic RPG** | lens 依存を timely `iterative` で実装 | lens 再計算が fixed-point で settle、無限ループなし |
| **D5: HW operator hybrid** | `DataflowAccelerator` trait + Tier 0-3 実装 + dispatch | `change_fraction` が Tier 3 で動作、Tier 0 fallback も動作 |
| **D6: replay** | arrangement snapshot + WAL + (任意) Intel PT 統合 | 1 セッション replay で bit-for-bit 同一結果 |

---

## 5. HW Acceleration Tiers

ドライバ成熟度に応じた段階分け。各 op は **fallback chain** で順次落ちる。

### 5.1 Tier 定義

| Tier | 名前 | 範囲 | 環境要件 | 期待 perf |
|---|---|---|---|---|
| **Tier 0** | Pure Rust fallback | `std::iter` + `rayon` のみ | どの環境でも 100% 動作 | ベースライン (×1) |
| **Tier 1** | Vendor-neutral OS API | DXGI Desktop Duplication + Direct3D 11 compute shader | Windows 11 全環境 | ×3〜5 |
| **Tier 2** | HW assist optional | Intel DSA (memcpy offload) / NVENC・QuickSync・AMF (frame 圧縮) / Reflex Latency API | capability detect で activate | ×10〜30 |
| **Tier 3** | Full vendor compute | CUDA Graph / HIP Graph / Level Zero command list | 各 vendor SDK + driver 必要 | ×30〜100 |

### 5.2 Vendor 別の成熟度 (2026-04 時点の現実認識)

| Vendor | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| NVIDIA | ✓ DXGI 標準 | ✓ NVENC (production 級) / Reflex (production) | ✓ CUDA Graph (production、CUDA 12+) |
| AMD | ✓ DXGI 標準 | ✓ AMF (一定品質) / Anti-Lag (game 限定) | △ HIP Graph on Windows (ROCm Windows は若い) |
| Intel | ✓ DXGI 標準 | ✓ Quick Sync (production) / DSA (Sapphire Rapids+ サーバ限定) | △ Level Zero (Arc/Battlemage で着実に成熟中) |

→ **Tier 1 は全環境で確実に動作**、Tier 2/3 は capability detect で安全に activate、failure 時は自動 fallback。

### 5.3 trait 案

```rust
pub enum Tier {
    T0Fallback,   // pure Rust
    T1OsApi,      // DXGI / D3D11
    T2HwAssist,   // DSA / NVENC / Reflex
    T3VendorCompute, // CUDA / HIP / Level Zero
}

pub struct Capability {
    pub vendor: Vendor,
    pub tier_max: Tier,
    pub supported_ops: Vec<OpKind>,
}

pub trait DataflowAccelerator: Send + Sync {
    fn tier(&self) -> Tier;
    fn capability(&self) -> Capability;
    fn cost_hint(&self, op: &OpSpec) -> CostHint;  // dispatch 判断用
    fn launch(&self, op: &OpSpec, inputs: &[ArrangedView])
        -> Result<ArrangedView, AccelError>;
}
```

### 5.4 Dispatch ポリシー

```
起動時:
  capability_detect() → Vec<Box<dyn DataflowAccelerator>>
  各 accelerator を tier 順に登録

各 op 実行時:
  for tier in [T3, T2, T1, T0]:
      if let Some(accel) = registry.find(op, tier):
          match accel.launch(op, inputs):
              Ok(result) => return result
              Err(transient) => fallthrough
              Err(fatal) => log + fallthrough
  unreachable!  // T0 は必ず動く
```

### 5.5 環境変数による Tier pin

ベンチや trouble shoot 用に env で上限を固定できる。

| ENV | 効果 |
|---|---|
| `DESKTOP_TOUCH_MAX_TIER=0` | T0 のみ (純 Rust) — 性能下限ベンチ |
| `DESKTOP_TOUCH_MAX_TIER=1` | T0-T1 — DXGI までの環境を再現 |
| `DESKTOP_TOUCH_MAX_TIER=2` | T0-T2 — Tier 3 の bug を切り分け |
| `DESKTOP_TOUCH_MAX_TIER=3` | 全 tier (default) |
| `DESKTOP_TOUCH_DISABLE_VENDOR=amd` | 特定 vendor の Tier 2/3 を無効化 |

---

## 6. Alternatives Considered

### 6.1 DBSP / Feldera

- 強み: SQL の自動 IVM、数学的に綺麗 (chain rule)、新しい
- 弱み: **linear synchronous time** のため UIA out-of-order を表現できない (DBSP 自身が論文で認める制約)
- 判定: **不採用**。将来 SQL UI を出す価値が立証されたら、DBSP を上に "logical operator layer" として乗せる選択肢を残す (DD と DBSP は競合ではなく層が異なる)

### 6.2 Hydroflow / Hydro

- 強み: distributed correctness、CALM 系、POPL'25 Flo semantics
- 弱み: 本番例まだ少ない (2024-2025)、単一ノードには overshoot、Rust API がまだ unstable
- 判定: **不採用**。複数 LLM agent が共有 perception を持つ協調デバッグの話が来たら再評価

### 6.3 自前 IVM

- 強み: 最小依存、初期はシンプル
- 弱み: partial-order time の正しい実装は 10 年級の研究、arrangement 相当の MVCC store を再実装する工数が膨大
- 判定: **不採用**。「世界初」の公開価値を出すなら標準実装に乗るほうが説得力が高い

---

## 7. Risks

| # | リスク | 影響度 | 軽減策 |
|---|---|---|---|
| 1 | timely-dataflow の API は低レベル、学習曲線 | Medium | Materialize blog の chunked ramp-up を Phase D1 で薄く始める |
| 2 | Rust async と timely thread モデルの衝突 | High | timely は専用 worker thread、napi-rs `AsyncTask` で wrap (UIA bridge と同パターン) |
| 3 | arrangement のメモリ消費が膨らむ | High | compaction policy を時間 budget で制御。古い epoch を圧縮、`state_at(t)` の対象期間外は強制 compact |
| 4 | GPU tier 選択 bug で動かない環境 | Medium | env で tier pin、E2E で全 tier 通す、Tier 3 失敗時は static log で警告 |
| 5 | Reflex API が NVIDIA 限定 | Low | DXGI Present statistics と `DwmGetCompositionTimingInfo` を fallback (これは全環境動作) |
| 6 | replay determinism が壊れる (副作用順序入替) | High | timely logical time で順序固定、UI 副作用は L1 Capture で `(wallclock, sub_ordinal)` を二重 tag |
| 7 | DBSP を将来導入したくなった時の互換性 | Low | view query は意味で書く (query rewrite 可)、operator graph は DD と DBSP で互換性高い |
| 8 | Tier 3 driver が突然壊れる (NVIDIA driver update 等) | Medium | Tier 3 は **常に optional**、起動時の自己診断で broken 検出時は Tier 2 に固定 |
| 9 | Intel PT 記録が全 session で容量爆発 | Medium | デフォルトは bug 報告時のみ、`DESKTOP_TOUCH_PT_RECORD=always` で常時 |

---

## 8. Acceptance Criteria

| Phase | 完了基準 |
|---|---|
| D1 | **完了 (2026-04-30)**: 1 view が incremental に更新 (PR #91 `2288333` `current_focused_element`)、bench で TS 版より latency 1/10 — **steady-state lookup で達成** (PR #92 D1-5、view ~145ns vs TS p99 11.2ms = 75,000× 比)。**update latency (~4.7ms) は TS の 2.4× にとどまり 1/10 未達**、real L1 ring 込み bench も未実施 (cdylib 制約)、worker idle sleep tuning + ring 全経路 bench は D2 carry-over: `docs/adr-008-d1-followups.md` §2.3, §2.5 |
| D2 | 既存 `desktop_state` を全部 view 経由に置換、tool 結果が同一 (回帰なし) |
| D3 | `state_at(now-2s)` で過去 state が引ける、p95 latency < 5ms |
| D4 | lens 再計算が fixed-point で settle、無限ループ自動検出 (max iter cap) |
| D5 | `change_fraction` が Tier 3 で動作、Tier 0 fallback も動作、tier pin で挙動切替確認 |
| D6 | 1 セッション replay で bit-for-bit 同一結果 (arrangement snapshot 経由) |

---

## 9. Open Questions

| # | 質問 | 検討タイミング |
|---|---|---|
| 1 | `state_at(t)` を全 view にするか、選択 view のみか (compaction コスト次第) | D3 着手時 |
| 2 | Subscribe API は WebSocket / MCP notification / 内部 callback どれで配るか | ADR-010 で決定 |
| 3 | arrangement snapshot の disk format (bincode / capnproto / 自前) | D6 着手時 |
| 4 | Intel PT 記録は全 session か bug 報告時のみか (ストレージ vs カバレッジ) | D6 + 運用フィードバック |
| 5 | HIP Graph on Windows の本番投入時期 (ROCm Windows の成熟度待ち) | D5 完了後の re-check |
| 6 | DBSP を logical layer として後から乗せるための protocol 互換要件 | 将来課題 |

---

## 10. 公開価値 (北極星の片翼)

論文ネタとして見ると、本 ADR の成果物だけで独立に書ける論文が複数:

1. **"GPU-accelerated incremental view maintenance for LLM agent perception"** — DXGI dirty rect + CUDA Graph + DBSP/DD の組み合わせ。SIGMOD/VLDB 系
2. **"Hardware-assisted deterministic replay for LLM agent debugging"** — Intel PT + arrangement snapshot で agent bug を bit-for-bit 再現。USENIX ATC / ASPLOS 系
3. **"Sub-millisecond UI observation timestamps via Reflex Latency API"** — race-free agent observation。CHI / UIST 系

ナラティブ: 「Microsoft が WinAppSDK Rust を archive して撤退した一方、Intel/AMD/NVIDIA の hw assist を Rust で結合した Windows MCP server が本番投入される」 — 領域的に空白で差別化が立つ。

---

## 11. Related Artifacts (起草予定)

- 本 ADR (`docs/adr-008-reactive-perception-engine.md`)
- ADR-009: HW Acceleration Plane の Tier 別実装ガイド (DXGI / D3D11 compute / DSA / NVENC / CUDA Graph / HIP / Level Zero の各実装詳細)
- ADR-010: LLM-facing Presentation Layer (view → tool 結果の整形、self-attestation / causal trail / recovery hints / time-travel link / confidence bands / what-if previews)

---

END OF ADR-008 (Draft).
