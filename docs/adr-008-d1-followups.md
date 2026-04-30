# ADR-008 D1 Follow-ups (post D1 phase closure)

- Status: **Active (D1 phase merged 2026-04-30、項目は D2 着手時に第一 pass で再評価)**
- Date: 2026-04-30 (D1 phase closure 時点で起こし)
- 親 ADR: `docs/adr-008-reactive-perception-engine.md` (§4 D2 で本書を参照)
- D1 plan: `docs/adr-008-d1-plan.md` (本書末尾で本書を参照)

---

## 1. 趣旨

D1 phase (PR #81 / #82 / #90 / #91 / 本 D1-5 PR) で `current_focused_element` view を timely + differential-dataflow で incremental に materialise + bench で TS 版の 75,000× 速いことを確認。Acceptance criteria 全 [x]、D1 完了表記済。

しかしレビュー過程 (Codex / 自己 review / Opus phase-boundary review) で以下の **D1 acceptance 範囲外だが D2 で再評価すべき項目** が発見された。memory に書くと揮発するので (強制命令 9)、本 docs に永続記録する。

---

## 2. D2 で対応すべき bench harness 強化

### 2.1 真の p99 計測 (criterion mean ではなく samples 直接抽出)

現状 (D1-5):
- criterion は `view_get_hit` の **mean ± confidence interval** だけ報告 (148 ns ±2.4%)
- 真の p99 は `target/criterion/view_get_hit/new/sample.json` から手動抽出が必要
- D1 acceptance は「TS p99 / 10」で view 側は mean で代用 (ratio 75,000× の余裕で許容)

D2 で対応:
- `crates/engine-perception/benches/d1_view_latency.rs` 内で samples 直アクセスして p99 を bench out に書き出し
- もしくは criterion の plugin / custom measurement で true p99 を summary に直接出す
- D2 で MCP transport overhead 込み bench を入れる時に同時更新

### 2.2 production gap: `uiaGetFocusedAndPoint` vs `uiaGetFocusedElement`

現状 (D1-5):
- TS baseline (`benches/d1_ts_baseline.mjs`) は napi `uiaGetFocusedElement` 単独
- production の `desktop_state` ハンドラ (`src/tools/desktop-state.ts:180`) は実際は `uiaGetFocusedAndPoint` 経由 (focus + at-point query 同時)
- production はもっと重い → view 比は本実測値より更に有利
- D1 acceptance は最良ケース下限で十分クリアしているので問題なし

D2 で対応:
- `benches/d1_ts_baseline.mjs` に `--with-point-query` mode 追加、`uiaGetFocusedAndPoint(0, 0)` で計測
- D2 で `desktop_state` を view 経由置換した時の **整合 baseline** として両 mode 計測

### 2.3 「Real L1 input ベース」 bench (L1 EventRing → focus_pump → handle → view 全経路)

現状 (D1-5):
- 全 bench は `FocusInputHandle::push_focus` を直接呼ぶ — engine-perception 境界からの計測
- L1 `EventRing` への push、`src/l3_bridge/focus_pump.rs` の broadcast subscribe + bincode decode + filter (UIA only) の hop は **bench 範囲外**
- 該当 hop は `recv_timeout(100ms)` + bincode (~µs) で bounded、correctness は `src/l3_bridge/mod.rs::lifecycle_tests::five_cycle_pipeline_spawn_push_shutdown` で pin 済だが latency 下では未検証
- D1 acceptance プラン§11 の「real L1 input ベース」文言は本 bench で実証されていない (D1-5 PR で narrow して honest 化済)
- 制約: root crate `crate-type = ["cdylib"]` で bench 外部からの L1 ring 直 push は不可、引き当てには D2 で `desktop_state` view 経由置換時に MCP tool round-trip として測るのが筋

D2 で対応:
- `desktop_state` を view 経由実装 → MCP tool 経由 round-trip の両 path bench (`benches/d1_ts_baseline.mjs` を `desktop_state` MCP call に変更し、view 版と直接比較)
- 真の production p99 (MCP transport + JSON serialize + napi + L1 ring push + focus_pump decode + view fetch) で再 acceptance

### 2.4 MCP transport / JSON-RPC overhead 込み bench

現状 (D1-5):
- view 側は `view.get(hwnd)` を Rust から直接 call、napi boundary も MCP transport も除外
- TS 側も napi 直接 (MCP transport 除外)
- 「同条件比較」として acceptance は OK だが、production の MCP tool 経由 latency は別物

D2 で対応:
- §2.3 と統合: `desktop_state` view 経由置換と同タイミングで MCP transport 込み bench も実装

### 2.5 worker_loop idle sleep tuning (update latency `p99 < 1ms` SLO 達成)

現状 (D1-5):
- `view_update_latency` 実測 ~4.7 ms、views-catalog §3.1 の SLO「p99 < 1ms」未達
- ボトルネックは `crates/engine-perception/src/input.rs::worker_loop` の `TryRecvError::Empty` 分岐内 `thread::sleep(Duration::from_millis(1))`
- `WATERMARK_SHIFT_MS=0` を設定済の bench で測ってもこの sleep に律速されている (push → 次の worker idle iteration までの待ちが ~0.5-1ms)
- production の focus 変化頻度 (秒オーダ) に対して 5ms latency は十分許容範囲だが、SLO は未達

#### 2.5.1 ボトルネックの内訳 (PR #92 review 過程で発見した分析)

「メモリ操作だけのはずなのになぜ ~5ms かかるのか」を時系列で分解すると、**遅延要因はメモリ操作ではなく worker_loop の polling pattern + DD operator chain の伝搬コスト** に集約される。

```
main thread:                    worker thread (l3-perception):
                                  loop {
[T+0]  handle.push_focus()          try_recv() → Empty
       ↓ tx.send (~µs cmd channel)  thread::sleep(1ms)        ← ← ← (A) 1ms sleep
                                                                     最悪 1ms 待つ
       ↑ Cmd queued during sleep    worker.step()               平均 0.5ms 待つ
[T+~0.5ms]                        try_recv() → Ok(PushFocus)
                                    input.update_at(...)        (~ns)
                                    input.advance_to(...)       (~ns)
                                    input.flush()               (~µs)
                                  worker.step()                 ← ← ← (B) op 1 step
                                                                       (input batch 開く)
                                  try_recv() → Empty
                                  worker.step()                 ← ← ← (B) op 2 step
                                                                       (reduce が走る)
                                  thread::sleep(1ms)            ← ← ← (A) 再び 1ms sleep
                                  worker.step()                 ← ← ← (B) op 3 step
                                                                       (inspect が emit、
                                                                        view.apply_diff →
                                                                        RwLock write ~100ns)
[T+~4-5ms] view.get(...) で新 name 検出 (spin-loop が即気付く)
```

支配項:
- **(A) `thread::sleep(1ms)`**: `TryRecvError::Empty` 時の固定遅延。Cmd 到着検知の最大 1ms 遅延 + dataflow step 間に毎回 sleep が挟まる。
- **(B) DD operator chain 伝搬**: `input → map → reduce → inspect` の 4 op を 1 つの `worker.step()` で全部回せない (timely の progress tracker は op 単位で activation を回す)。push 1 件で **2-3 step が必要**、各 step の間に sleep が挟まると累積。

非支配項 (測ってもほぼゼロ):
- crossbeam channel send (cmd 1 件 ~µs)
- DD `input.update_at` / `advance_to` / `flush` の純計算 (~ns 〜 µs)
- inspect closure 内の `apply_diff` (HashMap entry + BTreeMap insert + RwLock write、合計 **~100-200 ns**)
- 同じ inspect 内 `view.get` (RwLock read + HashMap lookup + BTreeMap iter、~145 ns で `view_get_hit` bench に出ている値)

**総和の見積**: (A) 平均 0.5-1ms + (B) 2-3 ms (op chain × sleeps) + メモリ操作 ~µs = **~3-5ms**。実測 4.7 ms と整合。

#### 2.5.2 修正案 (option 比較、D2 で実装)

| 案 | 想定 update latency | CPU コスト | 実装複雑度 | コメント |
|---|---|---|---|---|
| 現状 (`sleep 1ms`) | ~4.7 ms | 低 (idle ~0%) | — | base case |
| **option A**: `sleep 100µs` 等に短縮 | ~500 µs | 中 (idle ~5%) | 最小 (1 行) | 試金石として最初に当たる手 |
| **option B**: Cmd 後 `step until idle` + idle 時 `recv_timeout(1ms)` | <200 µs | 低 (cmd 駆動) | 中 (worker_loop 構造変更) | dataflow を寝かさず drain |
| **option C**: `parking_lot::Condvar` で park/unpark | <100 µs | 最小 (signal 駆動) | 高 (idle-advance schedule 別 thread or timer 必要) | 究極形、SLO 大幅クリア |

D2 で `desktop_state` を view 経由置換するときに option B+C 系を再評価。option A は B/C 採用までの transit として merge してもよい。

#### 2.5.3 production への影響評価

「~5ms update latency」は production の以下のシナリオで観測される:
- user が新しい window に focus を移した瞬間 → MCP agent が即座に `desktop_state` を呼ぶケース
- 連続的な focus 変化 (キーボードナビゲーション等) → 各遷移で view が「ひとつ前」を返すウィンドウ ~5ms

production 上の許容範囲か:
- ✅ **read-dominated**: 1 回 push (focus 変化) → N 回 read (agent query) のとき、read 側 ~145ns で N 回回せるので update の 5ms は分母で薄まる
- ⚠ **write-after-write**: focus が連続変化する場合、最新値を読みに来た agent が「ひとつ古い」を読む確率が ~5ms 分上昇
- 60 Hz UI 同期 (~16.67 ms/frame) には収まっているので体感影響なし
- D2 で `desktop_state` の attention signal 計算が `dirty` / `settling` を返すロジックで 5ms 窓は dirty 扱いされるはず → SLA 違反にはならない見込み

### 2.6 criterion features 整合 (skeleton 矛盾)

現状:
- `crates/engine-perception/Cargo.toml`: `criterion = { default-features = false, features = ["plotters", "rayon", "cargo_bench_support"] }`
- `benches/README.md` §3.1 skeleton 例: `criterion = { features = ["html_reports"] }`
- 両者矛盾 (engine-perception は default を一旦剥がした上で 3 feature を再 opt-in、html_reports は exit、ただし plotters で部分 report は出る)

D2 で対応:
- L3 系 bench を増設するときに skeleton 例と実宣言を整合
- `html_reports` を engine-perception 側でも有効化するか / skeleton 側を実宣言に合わせるか判断

---

## 3. D1-3 残 follow-up (本 D1 phase で deferred、D2 で再評価)

D1-3 PR #91 Opus review (2026-04-30) で発見、D1-5 phase boundary でも引き続き carry over。

### 3.1 transient stale read 強化 (D1-3 review §2)

現状:
- `apply_diff` の中間状態で UiElementRef Ord 順最初の live が返り得る (true last-by-time でない)
- DD の inspect callback ordering は assertion / retraction が任意順
- **対象 race window は microseconds オーダ** (DD の inspect batch 内)、production 影響は実質ゼロ
- ただし真の last-by-time 一貫性は保証していない

D2 検討:
- `BTreeMap<UiElementRef, i64>` を `BTreeMap<(LogicalTime, UiElementRef), i64>` に拡張
- `get()` を `.iter().rev().find(c > 0)` で最大 ts 返却
- `apply_diff` シグネチャに ts も渡す (build から ts を伝搬)
- consumer (envelope) の attention 計算が中間状態に sensitive かどうかで判断

### 3.2 tie-breaker `>` vs `>=` semantics 明示 (D1-3 review §1, §3)

現状:
- reduce 内 `cand.0 > b.0` (strict)
- 同 wallclock_ms + 同 sub_ordinal の event は L1 capture から発生しない (sub_ordinal は per-thread 単調増加)
- `>` を選んだことの test は `last_by_time_per_hwnd` (sub_ordinal=0 揃え) のみ

D2 検討:
- 「同 wallclock + 異 sub_ordinal で sub_ordinal 大きい方が勝つ」test 追加で挙動を pin
- もしくは `>=` に変更して「sort 順最後」で deterministic にする

### 3.3 starvation リスク再評価 (D1-3 review §6)

現状:
- `Arc<RwLock<HashMap<...>>>` を std::sync::RwLock で実装
- writer-starvation 保証なし (POSIX 実装次第)
- D1 では reader は internal Rust API で短期間 read、worker write は ns オーダ → 問題なし

D2 検討:
- D2 で多数 client が view を query するシナリオで `parking_lot::RwLock` (writer-preferring 選択可) または `arc-swap` (lock-free snapshot 提供) 導入を検討

### 3.4 reduce 経由の hwnd 死活遷移 test (D1-3 review §8)

現状:
- 「focus が hwnd A から hwnd B に完全移行」シナリオで A が view から消える挙動の test なし
- in-file unit `apply_diff_insert_then_retract_evicts_hwnd` で apply_diff レベルの挙動は pin 済
- reduce 経由 (operator graph 全体) で同シナリオを検証する integration test がない

D2 検討:
- `crates/engine-perception/tests/d1_minimum.rs` に「focus が A → B に移行で view から A が消える」 test 1 件追加

### 3.5 L4 envelope 側 pivot 搬送経路の実装 (D1-3 review §7)

現状:
- view 出力 `UiElementRef` は 4 fields のみ (pivot fields `source_event_id` 等は除外)
- 北極星 N1「pivot 必ず保持」は **L4 envelope 側の責務** で、view から落とすこと自体は契約違反ではない
- ただし L4 envelope 側 pivot 搬送経路は **未実装** (D2 scope)

D2 検討:
- ADR-010 (presentation layer) で envelope.data に source_event_id 等の pivot slot 追加
- view fetch 時に pivot data を別 view (D2 で `causal_trail` 等) から取得して合体する経路設計

### 3.6 shutdown 時の frontier 上 event drain (D1-3 review §9)

現状:
- 5-cycle lifecycle test で seq 2 (frontier 上) が release されないまま shutdown
- `execute_directly` の drain は input が閉じる際に frontier を inf に進めるはずだが未検証
- D1 acceptance には影響なし

D2 検討:
- shutdown 時の drain 挙動を unit test で pin
- production で query タイミングと shutdown が race した時の挙動

---

## 4. D1 phase で完結している項目 (再 carry over 不要)

| 項目 | 達成 PR / commit |
|---|---|
| 1 view が incremental に更新 | D1-3 PR #91 `2288333` |
| `current_focused_element` operator graph (map → reduce → inspect) | 同上 |
| view 読み取り API (`get`/`snapshot`/`len`/`is_empty`) | 同上 |
| pivot field 漏洩防止 (compile-time check) | 同上 |
| idle frontier advance (quiescent focus materialise) | 同上 (PR review P2 fix) |
| unit test pass (in-file 6 + integration 10 + lifecycle 2) | 同上 |
| bench で TS 版より latency 1/10 達成 (75,000× ratio) | D1-5 PR (本書元) |
| docs / memory 整合 | 同上 |

---

## 5. 関連

- 親 ADR: `docs/adr-008-reactive-perception-engine.md` §4 D2
- D1 plan: `docs/adr-008-d1-plan.md` §11 acceptance
- D1-2 plan: `docs/adr-008-d1-2-plan.md` (Implemented)
- views-catalog: `docs/views-catalog.md` §3.1 (Implemented + Benched)
- bench README: `benches/README.md` §2.3 (D1 SLO + 実測値)
- D1-3 PR #91: https://github.com/Harusame64/desktop-touch-mcp/pull/91
- memory: `project_adr008_d1_2_done.md` / `project_adr008_d1_3_done.md` / `project_adr008_d1_5_done.md`

---

END OF ADR-008 D1 Follow-ups。
