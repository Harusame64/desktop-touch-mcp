# ADR-008 D2-E0 — walking skeleton S1 / G1 alignment (dataflow scope refactor)

- Status: **Drafted (2026-05-01)**
- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.4) §4 **S1** (line 175-189) + §5 **G1 ゲート** (line 327, line 341) の最小実装。本 sub-plan は trunk S1 PR の scope を確定する
- Trigger: ADR-008 D2 plan §3 PR 表 PR-η (D2-E0)、PR #103 merged 2026-05-01 (`1d3bc1a`) で walking skeleton trunk selection が確定したため次 phase = S1 着手可
- 親 plan: `docs/adr-008-d2-plan.md` §D2-E0 (line 703-739) + §3 PR 表 PR-η 行 (line 803) + §11.2 (line 1198)
- 概念設計: `docs/adr-008-reactive-perception-engine.md` §3 + `docs/views-catalog.md` §4.1 (predicted_post_state subgraph 構造、D2-E で本 D2-E0 を import)
- 対象 sub-batch: walking skeleton **S1 (PR 1)** — `build_*(scope, stream) -> (Arranged, View)` signature 統一 + `Arranged` を `worker.dataflow` closure 内に閉じ込める refactor
- 後続: S2 (= D2-C impl PR、`docs/adr-008-d2-c-plan.md`) は **本 S1 merged が前提条件**

---

## 0. walking skeleton S1 位置付け note

本 sub-plan は walking skeleton trunk (`docs/walking-skeleton-trunk-selection.md` Proposed v0.4) の **最初の sub-batch S1**。trunk 選定で「contract spike として最小実装」方針が確定済 (§3.2)、本 S1 はその contract spike の base を作る:

- **S1 (★ 本 PR)**: dataflow scope refactor — `build_*(scope, stream) -> (Arranged, View)` signature 統一、`Arranged` を closure 内に閉じ込める
- **S2 (PR-ε D2-C impl)**: count-only `dirty_rects_aggregate` を S1 の同 scope に追加 (`build_dirty_rects_aggregate` を S1 確立 signature に揃える、`docs/adr-008-d2-c-plan.md` §3.3)
- **S3 (ADR-010 P1)**: envelope minimal wrapper + compat mode
- **S4**: `desktop_discover/act` commit 軸 wrapper + lease 4-tuple validation
- **S5**: `caused_by` linkage cross-layer (★ 最重要 contract)
- **S6**: trunk 完了判定 + CI assert 化 + expansion plan 起草

S1 は **production code 改修 PR** (Rust 内部 signature 変更)、外部 API (TS/napi/MCP)・既存 view consumer 経路は不変。

**G1 ゲートの目標** (`docs/walking-skeleton-trunk-selection.md` §4 S1 完了基準 line 184-188):

| # | walking-skeleton §4 S1 目標 | 本 sub-plan 検証手段 |
|---|---|---|
| 1 | 既存 D1/D2-A/D2-B integration test 全 pass | §3.5 cargo test workspace 全 pass + §3.6 push 6 ガード |
| 2 | 新 scope で `current_focused_element` が回帰なし | §3.5 既存 unit test (32 in-file + 11 integration、`current_focused_element` view test 含む) 無修正で pass |
| 3 | **Gate G1 判定**: D2-E0 refactor 後、複数 view を S2 で同 scope に置ける形になっているか | §3.5 `build_*` signature に統一感あり + §6 R6 で `build_dirty_rects_aggregate` の S2 想定 signature と整合確認、判定結果を §3.7 で `docs/walking-skeleton-trunk-selection.md` Appendix C に append |

**review 観点の再定義**: 本 PR は「scope refactor の完成度」ではなく **「S1/G1 contract が最短で検証できるか + S2 着手時に scope 内 mechanical コピーで進められる base が固まっているか」** で評価する。view のロジック改修 (per-hwnd diff bookkeeping / singleton key 等) は不変、`Arranged` を外に持ち出さない設計を型システムで pin することが本 PR の最重要 contract。

---

## 1. Scope (trunk / expansion / carry-over の 3 分類)

### 1.1 [S1 trunk] 本 sub-plan で扱う (G1 contract 必須)

A. **`build_current_focused_element` signature 変更** — `(events: Collection, view: View)` → `<G: Scope>(scope: &mut G, focus_stream: &Collection<G, FocusEvent, isize>) -> (Arranged<G, ...>, CurrentFocusedElementView)` (親 plan §D2-E0-2 line 717、Codex v2 P2-9 反映)
B. **`build_latest_focus` signature 変更** — 同 pattern、ただし latest_focus は singleton key で他 subgraph から import 用途無し (predicted_post_state は per-hwnd current_focused_element を import 想定) → `<G: Scope>(scope: &mut G, focus_stream: &Collection<G, FocusEvent, isize>) -> LatestFocusView` (Arranged 返却なし、OQ #2 で確認)
C. **`spawn_perception_worker` の `worker.dataflow` closure 内 wiring** — 新 signature 経由で両 view を build、`cfe_arranged` を closure scope 内で受けて `_` で drop (S2 で `dirty_rects_aggregate`、D2-E で `predicted_post_state` 経由で borrow される)
D. **既存 view の internal `apply_diff` / 内部 state は不変** — `Arc<RwLock<HashMap>>` 経由 read 経路、diff bookkeeping、idle frontier advance、watermark shift 等は本 PR scope 外 (D1-3 PR #91 + D2-A PR #95 + D2-B-1 PR #96 で確立済)
E. **既存 read API (`view.get(hwnd)` / `view.snapshot()` / `view.len()` / `view.is_empty()`) は不変** — caller (`src/l3_bridge/mod.rs` の `view_get_focused` napi binding 等) も無修正で pass
F. **既存 `spawn_perception_worker` 戻り値 4-tuple は維持** — `(PerceptionWorker, FocusInputHandle, CurrentFocusedElementView, LatestFocusView)` の shape はそのまま、`Arranged` は closure 内 lifetime で破棄
G. **G1 ゲート判定 + Appendix C append** — `docs/walking-skeleton-trunk-selection.md` Appendix C 末尾に `| G1 | 2026-05-XX | (継続/shrink) | (...) | (...) |` を append (本 sub-plan §3.7、impl PR merge 後に実施、ledger 永続化)

### 1.2 [expansion] G1 通過後の expansion phase で実装 (本 PR scope 外)

trunk 完了 (G1 通過) 後の expansion phase で実装、本 PR では scope 外として明示:

- **別 worker / 別 scope への arrangement import** (`docs/adr-008-d2-plan.md` §D2-E0-2 line 732 既明示「別 scope (別 worker) からの import は本 D2 では不要」): 同 worker 内 1 scope で全 view を完結させる方針、別 worker からの import は D5 以降の HW-accelerated view (Tier 3) 検討時に再評価
- **`build_*` 関数の docstring / 命名 / module 構造の標準化**: trunk では既存 `build` を `build_current_focused_element` に rename + signature 変更のみ、命名 convention の整理 / mod.rs 経由 re-export / docstring の統一は expansion で吸収可能
- **bench 新規追加**: 本 PR では `view_get_hit` / `view_update_latency` の **regression 0 を D2-A baseline (~145ns / shift_ms-bound) と比較** (§3.5)、新規 bench は追加しない (SLO 改善は trunk 完了後 expansion で別 PR)
- **`Arranged` の compaction frontier / trace policy tuning**: `arrange_by_key()` のデフォルト trace 設定でまず動かす、tuning は arrangement_size_metrics 計測後 (D2-G server_status 経由) に判断

### 1.3 [carry-over] §3.bis ledger / OQ で永続化 (別 phase)

- **`FocusInputHandle` リネーム (`→ PerceptionInputHandle`)**: D2-C sub-plan §8 OQ #1 で carry-over、本 S1 では rename しない方針 (§8 OQ #1 推奨)。理由: S1 で rename すると grep 範囲が広がり (`FocusInputHandle` は `engine-perception` crate + `src/l3_bridge/` + 多数のテストで使用)、本 PR の本来 scope (signature refactor) と混在。S2 で `push_dirty_rect` method 追加するときに「機能拡張と名前変更を同 PR」で吸収する方が自然 — Opus 判断委譲
- **`build_*` cross-view docstring 統一 / naming convention 文書化**: trunk 完了後に `docs/views-catalog.md` への build API guideline section 追加で吸収
- **`Arranged` を返す build 関数の戻り値型 alias** (`type CfeArranged<G> = Arranged<...>`): expansion で読みやすさ向上目的の type alias 導入、本 PR では型を inline で記述

### 1.4 北極星整合 + walking skeleton G1 contract

- **N1 (pivot 必ず保持)**: `source_event_id` 等の pivot field は `FocusEvent` 既存 struct で保持済、本 PR で改修しない
- **N2 (watermark で frontier 進行)**: D1-3 idle frontier advance + D2-A v3.8 watermark-shift restored は `worker_loop` 内のロジックで本 PR では touch しない
- **N3 (partial-order)**: `out_of_order_events_settle_to_latest_by_time` 等の既存 partial-order test を本 PR で **無修正で pass** することが G1 contract の一部
- **CLAUDE.md 強制命令 3.1 (ADR/plan 複数表 fact 整合)**: 本 PR では sub-plan / 親 plan §D2-E0 / 親 plan §3 PR 表 PR-η 行 / `docs/walking-skeleton-trunk-selection.md` §4 S1 / `docs/views-catalog.md` (該当 row 注記不要、view shape 不変) の 4 SSOT を bit-equal に揃える
- **CLAUDE.md 強制命令 3.2 (carry-over scope shrink、PR #102 教訓)**: 本 PR は既存 `Arranged` を closure 外に持ち出していないことを **型システムで pin** (lifetime escape 試行が `cargo check` で fail するように構造で防ぐ) — 過渡的に「外に持ち出してから後 PR で閉じ込める」設計は禁止 (carry-over 解釈で既存契約を壊さない)
- **walking skeleton G1 contract**: S2 (D2-C) で `build_dirty_rects_aggregate(scope, dirty_rect_stream) -> (Arranged, View)` を **mechanical コピー** で同 scope に追加できる base が固まること。本 PR の `build_current_focused_element` 新 signature が S2 着手時の template として機能する

---

## 2. 設計判断

### 2.1 `build_current_focused_element` 新 signature

#### [S1 trunk] 新 signature

```rust
// crates/engine-perception/src/views/current_focused_element.rs

use timely::dataflow::Scope;
use differential_dataflow::Collection;
use differential_dataflow::operators::arrange::arrangement::Arranged;
use differential_dataflow::trace::implementations::ord_neu::OrdValSpine;

/// Wire the `current_focused_element` operator graph onto `focus_stream`,
/// updating the supplied [`CurrentFocusedElementView`] handle as the
/// dataflow processes events.
///
/// Returns the `(arranged, view)` pair: `arranged` is the per-hwnd
/// arrangement that other subgraphs in the **same `worker.dataflow`
/// closure** can `import`/borrow (D2-E `predicted_post_state` consumer);
/// `view` is the read-side handle exposed to callers outside the worker.
///
/// `arranged` is bound to the `Scope`'s lifetime — callers MUST consume
/// it inside the same closure (or `_` it). Storing it in an outside
/// struct is **statically rejected by timely's lifetime model**
/// (Codex v2 P2-9, see `docs/adr-008-d2-plan.md` §D2-E0-1).
// Note: DD 0.23 actual API uses lifetime-parameterised
// `VecCollection<'scope, T, D, R>`, not the older `Collection<G: Scope, D, R>`
// (impl PR sync 2026-05-01、Opus round 1 P1-1 反映)
pub fn build_current_focused_element<'scope>(
    focus_stream: &VecCollection<'scope, LogicalTime, FocusEvent, isize>,
) -> (
    Arranged<'scope, TraceAgent<ValSpine<u64, UiElementRef, LogicalTime, isize>>>,
    CurrentFocusedElementView,
) {
    let view = CurrentFocusedElementView::new();
    let view_for_inspect = view.clone();

    let reduced = focus_stream
        .map(|ev: FocusEvent| {
            let key = ev.hwnd;
            let ts: (u64, u32) = (ev.wallclock_ms, ev.sub_ordinal);
            let value = UiElementRef::from_event(&ev);
            (key, (ts, value))
        })
        .reduce(|_key, input, output| {
            // (D1-3 logic 不変、last-by-time 選択)
            let mut best: Option<&((u64, u32), UiElementRef)> = None;
            for (val_ref, diff) in input.iter() {
                if *diff <= 0 { continue; }
                let cand: &((u64, u32), UiElementRef) = *val_ref;
                match best {
                    None => best = Some(cand),
                    Some(b) if cand.0 > b.0 => best = Some(cand),
                    _ => {}
                }
            }
            if let Some((_, ui_ref)) = best {
                output.push((ui_ref.clone(), 1));
            }
        });

    // inspect 経由で per-hwnd diff bookkeeping (D1-3 不変)
    reduced
        .inspect(move |((hwnd, ui_ref), _time, diff)| {
            view_for_inspect.apply_diff(*hwnd, ui_ref.clone(), *diff as i64);
        });

    // arrange_by_key で per-hwnd arrangement を作る (D2-E が import 用)
    let arranged = reduced.arrange_by_key();

    (arranged, view)
}
```

`Arranged` の具体型は trace spine 種別で複数 candidate あり、本 PR では `OrdValSpine` (default) を採用。type alias は §1.2 expansion で導入候補。

#### [現状] 既存 signature (D1-3、PR #91 で land)

```rust
pub fn build<'scope>(
    events: VecCollection<'scope, LogicalTime, FocusEvent, isize>,
    view: CurrentFocusedElementView,
) {
    // ...
}
```

差分:
- view を引数で受ける → 関数内で生成 (caller の `let view = View::new()` 重複削除)
- 戻り値 `()` → `(Arranged, View)`
- `events` (Collection) → `&focus_stream` (借用、複数 view が同 stream を fan-out するため `Clone` 不要)
- `Arranged` を取るために `arrange_by_key()` 経由

### 2.2 `build_latest_focus` 新 signature

#### [S1 trunk] 新 signature

```rust
// crates/engine-perception/src/views/latest_focus.rs

/// Wire the `latest_focus` operator graph onto `focus_stream`. Returns
/// the read-side handle only — singleton-key reduce produces 1 row,
/// no `arrange_by_key` exposure for downstream import (no D2-E
/// consumer planned, see `docs/adr-008-d2-e0-plan.md` §1.3).
// DD 0.23 actual API (impl PR sync 2026-05-01、Opus round 1 P1-1 反映)
pub fn build_latest_focus<'scope>(
    focus_stream: &VecCollection<'scope, LogicalTime, FocusEvent, isize>,
) -> LatestFocusView {
    let view = LatestFocusView::new();
    let view_for_inspect = view.clone();

    focus_stream
        .map(|ev: FocusEvent| {
            let ts = ev.logical_time();
            let value = UiElementRef::from_event(&ev);
            ((), (ts, value))
        })
        .reduce(|_unit, input, output| {
            // (D2-B-1 logic 不変)
            let mut best: Option<&(LogicalTime, UiElementRef)> = None;
            for (val_ref, diff) in input.iter() {
                if *diff <= 0 { continue; }
                let cand: &(LogicalTime, UiElementRef) = *val_ref;
                match best {
                    None => best = Some(cand),
                    Some(b) if cand.0 > b.0 => best = Some(cand),
                    _ => {}
                }
            }
            if let Some((ts, ui_ref)) = best {
                output.push(((ts.clone(), ui_ref.clone()), 1));
            }
        })
        .inspect(move |(unit_and_value, _time, diff)| {
            let (_unit, (ts, ui_ref)) = unit_and_value;
            view_for_inspect.apply_diff(ts.clone(), ui_ref.clone(), *diff as i64);
        });

    view
}
```

`Arranged` を返さない理由: latest_focus は singleton key (`()`) reduce、他 subgraph から import される設計上の用途が現時点で無い (`docs/adr-008-d2-plan.md` §7 / §D2-E は per-hwnd `cfe_arranged` を borrow する設計、`latest_focus_arranged` は出てこない)。仮に将来 import 用途が出たら別 PR で `Arranged` 返却版に拡張、本 PR では戻り値 `LatestFocusView` のみで simplify。

**OQ #2 (Opus 判断委譲)**: `build_latest_focus` も `(Arranged, View)` 統一形にして expansion 見越しで揃えるか、現時点 用途無しなので `View` のみに simplify するか — §8 OQ #2 で確定。

### 2.3 `spawn_perception_worker` の `worker.dataflow` closure 内 wiring

#### [S1 trunk] 新 wiring (option α、§2.3 後段で確定)

```rust
// crates/engine-perception/src/input.rs::spawn_perception_worker (一部)

// closure return type を 3-tuple に拡張 → 外で destructure。
// 旧版 `let mut input = worker.dataflow(...)` (return = InputSession) との差分:
// closure return が `(InputSession, View, LatestView)` に拡張、`mut input` は
// 1 要素目の destructure 受け取り。
let (mut input, cfe_view, latest_view): (
    InputSession<LogicalTime, FocusEvent, isize>,
    CurrentFocusedElementView,
    LatestFocusView,
) = worker.dataflow::<LogicalTime, _, _>(|scope| {
    let (input, focus_stream) = scope.new_collection::<FocusEvent, isize>();
    // S1 (本 PR): build_* を新 signature 経由で呼ぶ
    let (cfe_arranged, cfe_view) =
        current_focused_element::build_current_focused_element(scope, &focus_stream);
    let latest_view = latest_focus::build_latest_focus(scope, &focus_stream);
    // `cfe_arranged` は scope 内で `_` 化 — S2/D2-E で他 subgraph から
    // borrow される設計 (本 S1 では consumer 不在、warning 抑制)。
    // 型システム上、scope を抜けた時点で drop され、外部 struct への
    // 持ち出しは static error になる (Codex v2 P2-9 lifetime guard、§2.5)。
    let _ = cfe_arranged;

    // build_* が view を生成する new shape に揃ったので、parent 側の
    // `let view = View::new()` + `let view_for_worker = view.clone()` 重複行
    // は削除する。closure 外で `view_for_worker = cfe_view.clone()` /
    // `latest_view_for_worker = latest_view.clone()` を作って worker_loop に
    // move (§2.3 closure 後 worker_loop wiring + §3.3 D2-E0-3 checklist)。

    // 戻り値: 3-tuple `(input, cfe_view, latest_view)` を closure 外に
    // export (option α、§2.3 後段で判断確定)。`cfe_arranged` は同 closure
    // 内で `_` 化済、`Arranged<G, ...>` を tuple に含めると lifetime 'scope
    // が逃げて static error (§2.5)、3-tuple は値型 view handle のみで安全。
    (input, cfe_view, latest_view)
});
```

#### 差分要約

- 旧: parent 側で `let view = CurrentFocusedElementView::new()` + `let view_for_worker = view.clone()` → closure 内で `current_focused_element::build(stream.clone(), view.clone())`
- 新: parent 側 `let view` 生成削除 → closure 内で `let (cfe_arranged, cfe_view) = build_current_focused_element(scope, &focus_stream)` → 戻り値 `cfe_view` を closure 外に export する shape

closure 外に view handle を持ち出す方法 (worker_loop へ渡す等):
- option α: closure return tuple を `(InputSession, View, LatestView)` に拡張 → closure 外で受け取り → `worker_loop` に move
- option β: parent 側 `Arc<Mutex<Option<View>>>` 経由 (重い)
- option γ: closure 内で `view.clone()` を `view_for_worker_loop` に渡す変数に直接束縛 (closure 内 captured)

**判断 (推奨)**: option α — `worker.dataflow(|scope| { ... (input, view, latest_view) })` で 3-tuple 返却、closure 外で受けて `view_for_worker = view.clone()` / `latest_view_for_worker = latest_view.clone()` を作って `worker_loop` に move。option β/γ は所有権 / locking で複雑化、α が最も自然。**Opus 判断委譲 §8 OQ #3**。

#### closure 後 worker_loop wiring (差分なし)

```rust
let join = thread::Builder::new()
    .name("l3-perception".into())
    .spawn(move || {
        worker_loop(rx, processed_clone, view_for_worker, latest_view_for_worker)
    })
    .expect("spawn l3-perception thread");
```

worker_loop の signature (`fn worker_loop(rx, processed, view, latest_view)`) は **不変**、本 PR では closure 内 wiring の変更のみ。

### 2.4 既存 view 内部 state / API は不変

- `CurrentFocusedElementView::apply_diff` / `get` / `snapshot` / `len` / `is_empty` / `new` は API + 実装ともに不変
- `LatestFocusView` 同型
- `inspect` callback の per-(hwnd, value) diff bookkeeping logic は不変 (Codex v3 P1-1 inspect-order tolerance pattern)
- caller (`src/l3_bridge/mod.rs::view_get_focused` napi binding / `desktop_state.ts` view 経由 path / production-pipeline lifecycle test 等) は **無修正で pass**

### 2.5 `Arranged` を closure 外に持ち出さない型システム pin

本 PR の最重要 contract: `Arranged<G, ...>` を `worker.dataflow(|scope| {...})` closure 外に持ち出す試行は、**型システムで自動的にコンパイルエラー**になる。

```rust
// これは失敗する (closure return type に Arranged を含めると lifetime 'scope が逃げる):
let mut input = worker.dataflow::<LogicalTime, _, _>(|scope| {
    let (input, focus_stream) = scope.new_collection::<FocusEvent, isize>();
    let (cfe_arranged, cfe_view) = build_current_focused_element(scope, &focus_stream);
    (input, cfe_arranged, cfe_view)  // ❌ cfe_arranged の 'scope が closure 外に逃げる
});
```

`cfe_arranged` は closure 内で `_` 化 (consume) するか、同 closure 内の他 subgraph に borrow させる。これは Codex v2 P2-9 の正しい解釈で、parent 側で `Arranged<...>` を保持する shape を timely が物理的に拒否する。

**§3.5 検証**: `cargo check --workspace` が clean、`cargo doc --no-deps` で `Arranged` の lifetime escape が静的に防がれていることを確認。意図的に escape を試行する compile_fail test は §1.2 expansion で追加候補 (本 PR では `cargo check` で十分、過剰 test は scope outside)。

### 2.6 既存 caller への影響範囲

`current_focused_element::build` を呼ぶ caller の grep:

```bash
$ grep -rn "current_focused_element::build\|latest_focus::build" crates/ src/
crates/engine-perception/src/input.rs:624:                current_focused_element::build(stream.clone(), view.clone());
crates/engine-perception/src/input.rs:625:                latest_focus::build(stream, latest_view.clone());
```

caller は **`spawn_perception_worker` の closure 1 箇所のみ**。本 PR で全更新。test 内では view を直接 `View::new()` + `apply_diff` で driving しているため (`current_focused_element.rs` / `latest_focus.rs` の `#[cfg(test)] mod tests`)、build 関数を経由しないので影響なし。

`spawn_perception_worker` の戻り値 4-tuple 自体は不変 (§1.1 F)、production lifecycle (`src/l3_bridge/mod.rs::spawn_pipeline_inner` 内 `let (worker, handle, view, latest_focus_view) = spawn_perception_worker();`) も無修正で pass。

---

## 3. 実装 sub-batch (本 PR 内、S1 trunk scope)

### 3.1 D2-E0-1: `current_focused_element::build_current_focused_element` signature 変更 (~80 line) [S1 trunk]

- [ ] `crates/engine-perception/src/views/current_focused_element.rs`:
  - [ ] 旧 `pub fn build<'scope>(events: VecCollection<...>, view: View)` を削除
  - [ ] 新 `pub fn build_current_focused_element<'scope>(focus_stream: &VecCollection<'scope, LogicalTime, FocusEvent, isize>) -> (Arranged<'scope, TraceAgent<ValSpine<u64, UiElementRef, LogicalTime, isize>>>, CurrentFocusedElementView)` を新設 (§2.1、DD 0.23 actual API)
  - [ ] 関数内で `let view = CurrentFocusedElementView::new()` を生成 (caller の重複行を削除する shape)
  - [ ] `arrange_by_key()` 経由で arrangement を組み、`(arranged, view)` を return
  - [ ] inspect closure 内 logic は不変
- [ ] `differential_dataflow::operators::arrange::{Arranged, TraceAgent}` + `differential_dataflow::trace::implementations::ValSpine` import 追加 (DD 0.23 public re-export 経由)
- [ ] doc comment に Codex v2 P2-9 / lifetime 制約説明を追加 (§2.1 docstring template 採用)

### 3.2 D2-E0-2: `latest_focus::build_latest_focus` signature 変更 (~50 line) [S1 trunk]

- [ ] `crates/engine-perception/src/views/latest_focus.rs`:
  - [ ] 旧 `pub fn build<'scope>(events: VecCollection<...>, view: View)` を削除
  - [ ] 新 `pub fn build_latest_focus<'scope>(focus_stream: &VecCollection<'scope, LogicalTime, FocusEvent, isize>) -> LatestFocusView` を新設 (§2.2、DD 0.23 actual API、`Arranged` 返却なし simplify)
  - [ ] 関数内で `let view = LatestFocusView::new()` 生成
  - [ ] `Arranged` 返却なし (singleton key、import 用途無し、§2.2 / OQ #2)
  - [ ] inspect closure 内 logic は不変

### 3.3 D2-E0-3: `spawn_perception_worker` closure 内 wiring 変更 (~30 line) [S1 trunk]

- [ ] `crates/engine-perception/src/input.rs::spawn_perception_worker`:
  - [ ] parent 側 `let view = CurrentFocusedElementView::new(); let latest_view = LatestFocusView::new(); let view_for_worker = view.clone(); let latest_view_for_worker = latest_view.clone();` を削除 (build_* 関数内で生成する shape に統一)
  - [ ] closure 内を build_* 経由 shape に変更:
    - `let (input, stream) = scope.new_collection::<FocusEvent, isize>();`
    - `let (cfe_arranged, cfe_view) = current_focused_element::build_current_focused_element(&stream);`
    - `let latest_view = latest_focus::build_latest_focus(&stream);`
    - `let _ = cfe_arranged;` (S2/D2-E consumer 不在の warning 抑制、S2 着手時に `cfe_arranged` を borrow する形に書き換え)
    - 戻り値選択 (Opus round 1 P1-2 反映、impl 採用は **option α'**): closure return は既存通り `input` の `InputSession` 単独、view handle の parent 受領は `crossbeam_channel::bounded(1)` 経由で `view_tx.send` → 親 `view_rx.recv()`。option α (closure return 3-tuple `(input, cfe_view, latest_view)`) も型 system 上成立するが、**closure は worker thread 上で実行**され、view handle は parent thread (`spawn_perception_worker` の caller) 側で必要なため、いずれの選択でも channel が必要 (option α では channel 経由 + 3-tuple destructure と冗長になる)。capacity 1 (vs rendezvous 0): worker `view_tx.send` を timely event loop 起動前に non-blocking で完了させるため
  - [ ] `spawn_perception_worker` 戻り値 4-tuple は不変 (`(PerceptionWorker, FocusInputHandle, View, LatestView)`)

### 3.4 D2-E0-4: docstring / mod.rs export 整合 (~10 line) [S1 trunk]

- [ ] `crates/engine-perception/src/views/mod.rs`:
  - [ ] 既存 `pub mod current_focused_element;` / `pub mod latest_focus;` は不変
  - [ ] mod-level docstring が必要なら追記 (本 PR scope 内で軽微な範囲のみ、新規 doc 大量追加は §1.2 expansion)
- [ ] `crates/engine-perception/src/lib.rs` の views 説明 docstring:
  - [ ] `views` mod の docstring で「D2-E0 で `build_*(scope, stream) -> (Arranged, View)` signature に統一済」を 1 行追記 (§3.1 / §3.2 の changes を docstring level で trace 可能に)

### 3.5 D2-E0-5: 検証 (cargo check + cargo test workspace + bench regression 0、~0 line 改修) [S1 trunk]

- [ ] `cargo check --workspace`: clean (vision-gpu pre-existing warning は許容、本 PR で **新規 warning 発生 0** が pin)
- [ ] `cargo test -p engine-perception`: 全 pass (`current_focused_element` 6 unit test + `latest_focus` 5 unit test + `input` ~30 test + integration test 11 件、無修正で pass)
- [ ] `cargo test -p desktop-touch-engine --no-default-features --lib l3_bridge`: 全 pass (production-pipeline lifecycle test 8 件 / 5-cycle test / helper-pair test、`spawn_perception_worker` 戻り値 shape 不変なので無修正で pass)
- [ ] **`view_get_hit` p99 regression 0**: `cargo bench -p engine-perception --bench d1_view_latency -- --quick` で `view_get_hit` p99 が D2-A baseline (~145ns、`docs/views-catalog.md` §3.1 line 73) と同等を確認 (`arrange_by_key` 追加で operator chain が 1 段増えるが、read 経路は `Arc<RwLock<HashMap>>` 直 lookup なので影響なし — 想定)
- [ ] **`view_update_latency` regression 0**: 同 bench で D2-A v3.8 baseline (`shift_ms`-bound、~127ms p99) と同等を確認 (arrangement 1 段追加分は worker step が吸収、`shift_ms` 律速なので影響なし — 想定)
- [ ] **`cargo doc --no-deps` で Arranged lifetime escape が static error**: `Arranged` を closure 外に出す pseudo code を `cargo check` で意図的に試行 (本 PR では追加 test なし、実装中の 1 度の手動確認で十分、§1.2 expansion で compile_fail test 追加候補)

### 3.6 D2-E0-6: G1 ゲート判定 + Appendix C append (~5 line、impl PR merge 後) [S1 trunk]

- [ ] impl PR merged 後、`docs/walking-skeleton-trunk-selection.md` Appendix C 末尾に判定結果を append:
  ```markdown
  | G1 | 2026-05-XX | 継続 | D1/D2-A/D2-B integration test 全 pass、新 scope で current_focused_element 回帰 0、build_* signature が S2 着手時の mechanical コピー template として機能、Arranged lifetime escape が型システムで pin。S2 (D2-C count-only impl) に進む価値あり、scope shrink 不要 | (なし) |
  ```
- [ ] 判定値が「shrink」になった場合は S2 (D2-C) の scope を sub-plan §1.1 から削る判断を本 sub-plan §6 follow-up に記録

### 3.7 D2-E0-7: Push 6 ガード + Opus + Codex review (CLAUDE.md 強制命令 3 + 3.1 + 3.2) [S1 trunk]

- [ ] `cargo check --workspace`: clean
- [ ] `cargo test -p engine-perception`: 全 pass
- [ ] `cargo test -p desktop-touch-engine --no-default-features --lib l3_bridge`: 全 pass
- [ ] `npm run check:napi-safe` / `check:native-types` / `check:stub-catalog` / `npm run build`: 全 pass (**全て無修正で pass を期待** — 本 PR は napi 改修なし、TS SoT 改修なし、stub-catalog 改修なし)
- [ ] **Opus phase-boundary review** (強制命令 3 + 3.1 + 3.2): 指摘ゼロまで反復。本 sub-plan §4「対 Opus 単独判断盲点 sweep」を review prompt に明示組込
- [ ] **Codex re-review** (`@codex review` トリガー、CLAUDE.md 3.2 運用 rule): production code 改修 PR のため Opus + Codex 両方必須。Codex API contract 軸が `Arranged` の lifetime model を補強、`feedback_ai_multi_reviewer.md` 延長線

---

## 4. 対 Opus 単独判断盲点 sweep (Lesson 1-4 防御、PR #99/#102/#103 連続再発 pattern)

memory `project_adr008_d2_c_plan_done.md` Lesson 1-4 で確立された User reviewer による Opus 単独 sweep 補正 pattern が PR #99/#102/#103 で **3 連続再発**。本 PR では Opus review prompt に以下を明示組込、最初から防御:

### 4.1 contract 自体の妥当性 review (keyword sweep だけでは catch できない)

**確認項目**:
- [ ] `build_current_focused_element` 新 signature が、S2 (D2-C `build_dirty_rects_aggregate`) で mechanical コピー可能な template になっているか? S2 sub-plan §3.3 (`(Arranged, DirtyRectsAggregateView)` 戻り型) と shape が integral か?
- [ ] `Arranged` を closure 外に持ち出さない設計が S2 (D2-C dirty_rects view、import 用途無し) / D2-D (semantic_event_stream `FocusMoved` variant) / D2-E (predicted_post_state、cfe_arranged を borrow) で十分か?
- [ ] `build_latest_focus` の `Arranged` 非返却 (§2.2) が将来 import 用途を阻害しないか? expansion で必要になったら別 PR で signature 拡張する戦略で十分か?
- [ ] §2.3 option α (closure 3-tuple 返却) が timely の lifetime model で本当に成立するか? `InputSession` と view handle を同 closure return tuple に含めて parent 側で受けるパターンが他 timely サンプルで前例ありか?

### 4.2 compile-time guard 過信判定 (cargo check 通っただけで OK 判定しない)

**確認項目**:
- [ ] `cargo check --workspace` が通るだけでなく、**`cargo test -p desktop-touch-engine --no-default-features --lib l3_bridge` の production-pipeline lifecycle test 8 件**が全 pass するか? `Arranged` の trace 持続でメモリ leak していないか? (D2-A v3.8 watermark-shift restored 経路で arrangement compaction が動くか runtime で確認)
- [ ] `view_get_hit` / `view_update_latency` の bench regression 0 が cargo check に紛れて隠れていないか? `arrange_by_key` 1 段追加分は **計測値で確認** (D2-A baseline ~145ns / shift_ms-bound 比較)
- [ ] napi binding (`view_get_focused` / `view_focused_pipeline_status`) が runtime で動作するか? 本 PR は napi 改修なしだが、`spawn_perception_worker` 戻り値経由で取得した `LatestFocusView` が pipeline 経由で expose される経路は **runtime で 1 回呼出 smoke** (`scripts/check-engine-status.mjs` 等で確認、または既存 production lifecycle test の `arc_clone_outliving_shutdown_is_safe` で呼出経路 pin 済)

### 4.3 両 doc 順序矛盾 (S1 → S2 直列前提 keyword sweep)

**確認項目**:
- [ ] `docs/walking-skeleton-trunk-selection.md` §4 S1 + §4.1 直列前提 / `docs/adr-008-d2-plan.md` §3 PR 表 PR-η 行 (line 803) + §3.bis ledger L1 (line 820 「S1 (PR-η) が impl PR 着手前に merged されている必要あり」) / `docs/adr-008-d2-c-plan.md` §1.1 R7 (line 425「S1 (D2-E0) shape に依存、S1 が遅れると本 S2 も遅れる」) / 本 sub-plan §0 (line 25-30) の 4 SSOT で **S1 → S2 着手順序が一致**しているか?
- [ ] `Grep "S1 → S2|S1 (PR-η)|D2-E0 が前提|D2-E0 完了"` で 4 SSOT の表記揺れがないか?
- [ ] 本 PR が「S1 = trunk start」と明示する一方、親 plan §3 PR 表 PR-η 行 line 803 が `walking skeleton: S1 (trunk start)` 列で同期しているか?

### 4.4 restore 後 numeric count sync 漏れ (carry-over → restore で件数表記更新)

**確認項目**:
- [ ] 本 PR では新規 carry-over → restore は無いが、§3 sub-batch 数 (D2-E0-1 〜 D2-E0-7 = 7 件) / §8 OQ 件数 (3 件) / §7 Risks 件数 (R1-R9 = 9 件、Codex round 1 P2 反映で R9 追加) が本 sub-plan 内 / 親 plan §3 PR 表 PR-η size 想定 (~200-300 line) と整合か?
- [ ] `Grep "200-300 line\|7 件\|3 件\|9 件"` で本 sub-plan 内 numeric counts が bit-equal か? (acceptance / sub-batch / OQ / risks の各表で件数を引用している箇所が同期しているか)
- [ ] **G1 ゲート判定後**、§3.6 で Appendix C に append する内容が本 sub-plan §1.1 G acceptance と bit-equal か?

### 4.5 既存 public API 破壊禁止 (CLAUDE.md §3.2 PR #102 教訓延長)

**確認項目**:
- [ ] `spawn_perception_worker` 戻り値 4-tuple が **不変** (本 sub-plan §1.1 F + §2.6) か? `src/l3_bridge/mod.rs::spawn_pipeline_inner` line 394 の destructure と shape integral か?
- [ ] `CurrentFocusedElementView::get(hwnd)` / `LatestFocusView::snapshot()` の **既存 public read API が不変** (本 sub-plan §1.1 E + §2.4) か? caller (`view_get_focused` napi binding / `desktop_state.ts` view 経路) が無修正で pass か?
- [ ] `FocusInputHandle` が **本 PR で rename されない** (本 sub-plan §1.3 + §8 OQ #1) か? rename を S1 で起こすと既存 caller 多数の更新が必要 → S2 で `push_dirty_rect` 拡張と一緒に検討

---

## 5. PR 切り方

| sub-batch (1 PR で land、分割しない) | 範囲 | size 想定 |
|---|---|---|
| **D2-E0 (本 PR、merged sub-batch)** | 3.1 build_current_focused_element signature 変更 + 3.2 build_latest_focus signature 変更 + 3.3 spawn_perception_worker closure wiring + 3.4 docstring/export 整合 + 3.5 検証 + 3.6 G1 ゲート判定 + 3.7 push 6 ガード + Opus + Codex review | **200-300 line** (親 plan §3 PR 表 PR-η size 想定 line 803 と整合) |

**1 PR で land**、sub-batch 分割しない (refactor scope は internal signature 変更のみで完結)。Opus + Codex 両 review で指摘ゼロ後 merge。

`docs/walking-skeleton-trunk-selection.md` §4.1 の S1 概算 **2-3 日** に整合 (line 302「S1 D2-E0 scope refactor: 2-3 日 / Opus review 2-3 round」)。

---

## 6. follow-up (carry-over、§3.bis ledger / OQ で永続化)

trunk + expansion 完了後の別 phase で carry-over:

- **`FocusInputHandle` → `PerceptionInputHandle` rename**: D2-C sub-plan §8 OQ #1 と同 carry-over、本 S1 では rename しない、S2 着手時に Opus 判断委譲 (§8 OQ #1)
- **`build_*` cross-view docstring 統一 / naming convention 文書化**: trunk 完了後 `docs/views-catalog.md` への build API guideline section 追加で吸収
- **`Arranged` 戻り値型 alias** (`type CfeArranged<G> = ...`): expansion で読みやすさ向上目的の type alias 導入
- **compile_fail test for `Arranged` lifetime escape**: 意図的に escape を試行する pseudo code を `compile_fail` doctest で pin、本 PR では `cargo check` で十分とし carry-over

---

## 7. Risks / Mitigation

| # | Risk | 影響 | Mitigation |
|---|---|---|---|
| R1 | `arrange_by_key()` 追加で memory 増加 (per-hwnd arrangement の trace 持続) | 中 | trace compaction はデフォルト動作、D1-3 の inspect 経由 read と同型コスト。bench で memory 計測は §1.2 expansion で別 PR、本 PR は test pass + bench regression 0 で gate |
| R2 | `Arranged` の trace policy が D2-A v3.8 watermark-shift restored 経路と衝突 | 中 | `arrange_by_key()` のデフォルト trace は watermark advance に追従、idle frontier advance (PR #91 P2 retained) と整合。production-pipeline lifecycle test 8 件で runtime 確認 (§3.5) |
| R3 | timely lifetime model で option α (closure 3-tuple 返却) が成立しない | 中 | 本 PR 着手前に小さな PoC で確認、もし不成立なら option β (`Arc<Mutex<Option<View>>>`) / option γ (closure 内 `view.clone()` 直 capture) に切替、§2.3 OQ #3 で Opus 判断 |
| R4 | `build_current_focused_element` 新 signature が S2 (D2-C) で `build_dirty_rects_aggregate` の mechanical コピー template にならない | 中 | §4.1 contract 妥当性 review で sub-plan §3.3 (D2-C sub-plan) との shape integral を Opus 確認、不整合なら本 PR で先行 `Arranged` 返却型を一般化 |
| R5 | `build_latest_focus` の `View` のみ返却 simplification が将来 import 用途を阻害 | 低 | §1.2 expansion で signature 拡張 (`(Arranged, View)` 統一形に upgrade) は別 PR で対応可、本 PR では simplify を優先。OQ #2 で Opus 判断 |
| R6 | G1 ゲート判定が「shrink」になり、S2 (D2-C) の scope を sub-plan §1.1 から削る決定 | 中 | §3.6 で判定結果を Appendix C に append + S2 sub-plan §1.1 を必要に応じて修正、`docs/walking-skeleton-trunk-selection.md` §5.1 「scope shrink 内容」列に記載 (G1 例: 「S2 の dirty rect view を count-only にさらに絞る (`monitor_index` field は維持)」) |
| R7 | `Arranged` を closure 外に持ち出す型エラーが意図せず通る (lifetime escape が成立してしまう) | 低 | `cargo check` で意図的 escape 試行 (§3.5)、`Arranged<G, ...>` の `G` lifetime parameter が closure 戻り値型に含まれる場合 timely が拒否することを確認 |
| R8 | sub-plan PR (本 PR) と impl PR の間で walking skeleton trunk が更新され、S1 scope が変わる | 低 | sub-plan PR merged 後すぐ impl PR を起こす、間に walking skeleton trunk 改訂が入った場合は impl PR 着手前に本 sub-plan を再 sync (User feedback 2026-05-01 PR #103 で確立 pattern) |
| R9 | DD `Collection<G, ...>` の `reduce` 戻り値を `inspect` と `arrange_by_key` の両方に feed する 2-borrow shape (§2.1 コード例) が DD API で成立しない (現実装 D1-3 は method chain 1 回 borrow のみで 2-borrow パターンは本 PR で新規導入) | 低-中 | 実装着手前に minimal PoC (`reduce` 結果に対し `inspect` + `arrange_by_key` を両方呼ぶ small dataflow を `cargo check`) を必ず通す。DD `Collection` は通常 `Clone` 実装するので、不成立なら `let reduced_for_inspect = reduced.clone()` で 2 handle に分離 (Codex review 2026-05-01 P2 反映) |

---

## 8. Open Questions (S1 trunk-relevant に絞る、3 件)

| # | OQ | 決定タイミング | 推奨 (Opus 判断委譲) |
|---|---|---|---|
| 1 | `FocusInputHandle` を `PerceptionInputHandle` にリネームするか、既存名を保持するか | S1 着手時 Opus 判断委譲 (D2-C sub-plan §8 OQ #1 と統合) | **私の推奨**: S1 では rename しない (本 sub-plan §1.3 + §6)。理由: S1 scope (signature refactor) と混在、S2 で `push_dirty_rect` method 追加と一緒に rename する方が自然。Opus 判断 |
| 2 | `build_latest_focus` も `(Arranged, View)` 統一形にするか、`View` のみ simplify か | S1 着手時 Opus 判断委譲 | **私の推奨**: simplify (`View` のみ)。理由: latest_focus は singleton key で他 subgraph から import 用途無し、将来必要なら別 PR で signature 拡張 (R5 mitigation)。Opus 判断 |
| 3 | `worker.dataflow` closure 内で view handle を closure 外に持ち出す方法 | S1 実装着手時、PoC で確認 | **私の推奨**: option α (3-tuple 返却)。理由: timely サンプルで前例あり、所有権が parent 側で集約されて cleanest。option β/γ は所有権 / locking で複雑化。PoC で不成立なら β/γ に切替 |

---

## 9. ADR-008 D2 + walking skeleton 全体図 (本 PR の位置づけ)

```
Walking skeleton trunk:
┌──────────────────────────────────────────────────────────────────────┐
│  S1: D2-E0 dataflow scope refactor (★ 本 PR、PR 1 = PR-η)            │
│      ↓                                                                │
│  S2: D2-C dirty_rects_aggregate count-only (PR 2 = PR-ε)             │
│      ↓                                                                │
│  S3: ADR-010 P1 envelope minimal wrapper (PR 3)                      │
│      ↓                                                                │
│  S4: desktop_discover/act commit 軸 wrapper (PR 4)                   │
│      ↓                                                                │
│  S5: caused_by linkage cross-layer (PR 5、★ 最重要 contract)          │
│      ↓                                                                │
│  S6: trunk 完了判定 + CI assert + expansion plan (PR 6)              │
└──────────────────────────────────────────────────────────────────────┘

D2-E0 内部の dataflow scope 図 (本 PR の改修範囲):

[before、D1-3 + D2-B-1 PR #91/#96]                       [after、本 S1 PR-η land 後]
spawn_perception_worker                                  spawn_perception_worker
  │                                                        │
  │ let view = View::new();                                │
  │ let view_for_worker = view.clone();                    │
  │ let latest_view = LatestView::new();                   │
  │ let latest_view_for_worker = latest_view.clone();      │
  ▼                                                        ▼
worker.dataflow(|scope| {                                worker.dataflow(|scope| {
    let (input, stream) = scope.new_collection();            let (input, focus_stream) = scope.new_collection();
    current_focused_element::build(stream.clone(),           let (cfe_arranged, cfe_view) =
        view.clone());                                           current_focused_element::build_current_focused_element(
    latest_focus::build(stream, latest_view.clone());                scope, &focus_stream);
    input                                                    let latest_view = latest_focus::build_latest_focus(
})                                                               scope, &focus_stream);
                                                             let _ = cfe_arranged;  // S2/D2-E consumer 不在の warning 抑制
                                                             // S2 (D2-C 翌 impl PR、count-only):
                                                             // let (dirty_arranged, dirty_view) =
                                                             //     dirty_rects_aggregate::build_dirty_rects_aggregate(
                                                             //         scope, &dirty_rect_stream);
                                                             // S5 (D2-E、trunk 後 expansion):
                                                             // let (predicted_input, predicted_view) =
                                                             //     build_predicted_post_state(scope, &cfe_arranged);
                                                             (input, cfe_view, latest_view)
                                                         })

view consumer 経路 (改修なし):
view_get_focused() → ensure_perception_pipeline() → PerceptionPipeline.latest_focus_view.snapshot() → ...
desktop_state.ts → view_get_focused() → ...
production-pipeline lifecycle test 8 件 → spawn_perception_worker 4-tuple destructure (不変) → ...
```

---

## 10. References

- **signature SSOT 注釈**: `build_current_focused_element` / `build_latest_focus` の signature SSOT は本 sub-plan §2.1 / §2.2 (`Arranged<G, TraceAgent<OrdValSpine<u64, UiElementRef, G::Timestamp, isize>>>` の full 展開)。親 plan §D2-E0-2 line 717 の `Arranged<...>` 省略表記は backward-compat 表現で、impl 着手時は本 sub-plan を参照 (Opus round 1 P2-3 反映)
- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.4) §4 S1 + §5 G1 ゲート + §3.2 contract spike 方針
- 親 plan: `docs/adr-008-d2-plan.md` §D2-E0 (line 703-739) + §3 PR 表 PR-η 行 (line 803) + §11.2 (line 1198) + §3.bis ledger L1 (line 820) + §7 (line 1078)
- 後続 sub-plan (S2): `docs/adr-008-d2-c-plan.md` §1.1 + §3.3 (S1 で確立した shape を import) + §7 R7 (S1 完了が前提)
- views-catalog: `docs/views-catalog.md` §3.1 (current_focused_element row) + §3.1.bis (latest_focus row)、本 PR では shape 不変
- 既存実装:
  - view: `crates/engine-perception/src/views/current_focused_element.rs:180` (旧 build) / `crates/engine-perception/src/views/latest_focus.rs:137` (旧 build)
  - spawn: `crates/engine-perception/src/input.rs:499-528` (spawn_perception_worker 4-tuple) + line 612-628 (worker.dataflow closure)
  - production lifecycle: `src/l3_bridge/mod.rs:393-406` (spawn_pipeline_inner) + line 287-322 (ensure_perception_pipeline) + 5-cycle / 8 production-pipeline lifecycle test
- governance: CLAUDE.md 強制命令 3 (Opus 再レビュー義務) + 3.1 (ADR/plan 複数表 fact 整合) + 3.2 (carry-over scope shrink、PR #102 教訓) + 7 (仕組みで対応) + 8 (main 直 push 禁止) + 9 (残件は memory ではなく docs/)
- memory: `project_adr008_d2_c_plan_done.md` Lesson 1-4 (User reviewer による Opus 単独 sweep 補正 pattern、本 sub-plan §4 で防御化) + `feedback_carry_over_scope_shrink.md` (PR #102 教訓) + `feedback_north_star_reconciliation.md` (pivot 提案前に北極星照合) + `feedback_opus_plan_sonnet_impl.md` (Opus 計画 → Sonnet 実装 → Opus レビュー workflow) + `feedback_ai_multi_reviewer.md` (Opus + Codex 両 review が補完的)
- 同型先例:
  - signature 変更: D2-B-1 PR #96 (`spawn_perception_worker` 3-tuple → 4-tuple、両 view を同 closure 内 build)
  - lifecycle 確認: D2-0 PR #94 (production-pipeline lifecycle 8 test) + D2-A PR #95 (worker tuning revised + watermark-shift restored)
  - sub-plan 構造: D2-C sub-plan PR #103 (count-only contract spike + 3 分類 trunk/expansion/carry-over)

---

## Appendix A: 改訂履歴

| version | date | author | summary |
|---|---|---|---|
| Drafted v0.1 | 2026-05-01 | Claude (Sonnet) | 初稿起草、walking skeleton S1 sub-plan、build_*(scope, stream) -> (Arranged, View) signature 統一 + Arranged closure 内閉込 + spawn_perception_worker closure wiring 変更 + G1 ゲート判定 |
| Drafted v0.2 | 2026-05-01 | Claude (Sonnet) | Opus round 1 + Codex round 1 review 反映: P1-1 (D2-C sub-plan §6 line 410 と本 §1.1 A/B の S1 scope 解釈不一致) → 案 A 採用で D2-C sub-plan 側を D1 view 両方 S1 で signature 統一に sync 修正 / Codex P2 + Opus P2-4 (§2.3 closure return が `input` のみで §3.3 3-tuple 要求と矛盾、命名揺れ `latest_view_built` vs `latest_view`) → §2.3 wiring 全面書き直し + 3-tuple destructure を type-annotated 形で明示 / Opus P2-1 (§5 表 column header 即読性) / P2-2 (§7 R9 追加: `reduced` 2-borrow risk、Codex P2 と同源) / P2-3 (§10 References に signature SSOT 注釈追加) / P3-1 (walking-skeleton-trunk-selection.md line 492 末尾 `(Proposed v0.3)` → `(Proposed v0.4)` 同梱修正) / §4.4 numeric count 更新 (Risks 9 件に bump) |
| Drafted v0.3 | 2026-05-01 | Claude (Sonnet) | impl PR #105 sync (Opus round 1 P1-1 反映): §2.1 / §2.2 build_* signature を DD 0.23 actual API に書き換え (`<G: Scope>(scope: &mut G, focus_stream: &Collection<G, ...>)` → `<'scope>(focus_stream: &VecCollection<'scope, LogicalTime, ...>)`、`OrdValSpine` → `ValSpine` 統一)、§3.1 / §3.2 / §3.3 checklist signature も同じく sync。§3.3 D2-E0-3 戻り値選択を **option α' (channel 経由) 採用** に明記 (Opus P1-2 反映: closure は worker thread 上で実行、view handle は parent thread 必要 → option α/α' いずれも channel 必須、option α' が冗長性最小、capacity 1 vs rendezvous 0 trade-off も注釈) |

---

END OF ADR-008 D2-E0 sub-plan (Drafted v0.3)。
