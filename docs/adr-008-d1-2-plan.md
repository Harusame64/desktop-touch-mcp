# ADR-008 D1-2 — Real L1 → engine-perception adapter プラン

- Status: **Implemented (2026-04-30、本 PR `feat/adr-008-d1-2-focus-pump`)** — Draft v3 → 実装完了。下記「§0 実装後 refinement」section 参照
- Date: 2026-04-30 (plan v3) / 実装完了 2026-04-30 (本 PR)

## 0. 実装後 refinement (本 PR closure 時点、2026-04-30)

実装中に判明した v3 plan からの scope 調整 / API 検証結果:

### 0.1 timely 0.29 / DD 0.23 API 検証 (OQ #1 解決)

`cargo doc` + crate source 直接確認で確定:
- **`differential_dataflow::input::InputSession`** (DD 0.23): `update_at(elem, time, change)` / `advance_to(time)` / `flush()` 全て plan 通り存在。`update_at` は `assert!(self.time.less_equal(&time))`、`advance_to` も同様 monotone 制約 — plan §3.2.4 の watermark 設計と整合
- **`timely::execute_directly`**: `FnOnce(&mut Worker) -> T + Send + Sync + 'static` を取り、closure 戻り後に `worker.has_dataflows()` 走査で残 dataflow を drain。**closure 内に main loop を入れる** plan のパターンで OK
- **`worker.dataflow::<T, _, _>(|scope| ...)`**: `T: Refines<()>` 制約。tuple `(u64, u32)` には impl 無し → **専用 `Pair<u64, u32>` を `time.rs` に新設** (DD `examples/multitemporal.rs::pair` を attribution 付きで port)
- **`scope.new_collection`**: `differential_dataflow::input::Input` trait extension 経由、`T: TotalOrder` 必要。`Pair` を **lex-total** で実装 (`PartialOrder` を `<=` で実装、`TotalOrder` marker 追加) — plan §3.2.4 の N2 watermark 検証は lex でも成立

### 0.2 `FocusEvent` derive 拡張 (DD `Data` trait 制約)

DD は `Data: Send + Any + Serialize + for<'a> Deserialize<'a>` 加えて arrangement 用に `Eq + Ord + Hash` も要求:
- **`FocusEvent` derive 追加**: `Eq + PartialEq + Ord + PartialOrd + Hash` (plan §3.2.1 で `Debug + Clone + Serialize + Deserialize` のみだったため追加)
- 全 field (`u64`, `String`, `Option<String>`, `u32`, `u8`) が Ord で問題なし

### 0.3 engine-perception Cargo.toml 依存追加 (plan §2.1 で「不要なら追加なし」だったが追加が必要)

- **`serde = { version = "1", default-features = false, features = ["derive", "std"] }`**: `Pair` と `FocusEvent` の Serialize/Deserialize 用 (DD ExchangeData 制約)
- **`crossbeam-channel = "0.5"`**: cmd channel 用 (root crate と同 version)
- timely / DD は plan 通り

### 0.4 helper signature 変更 (plan §3.4.1)

plan: `spawn_perception_pipeline_for_test() -> (PerceptionWorker, FocusPump)`
**実装: `(PerceptionWorker, FocusInputHandle, FocusPump)`** — `FocusInputHandle` も返す形に。理由:
- bench harness (D1-5) で test 側から直接 `handle.push_focus()` したいケースに対応
- pump は内部で `Arc<dyn L1Sink>` (= `Arc::new(handle.clone())`) を握るので handle 自体は別途返せる
- shutdown 順序は不変 (pump → worker)

### 0.5 5-cycle integration test の置き場 (plan §3.6 / Codex v1 P2-3)

plan: `tests/d1_pipeline_lifecycle.rs` (Cargo integration test)
**実装: `src/l3_bridge/mod.rs` 内 `#[cfg(test)] mod lifecycle_tests`** — 理由:
- 本 crate は `crate-type = ["cdylib"]` (napi addon)、Cargo integration test (`tests/*.rs`) は rlib 必要 → 入れると napi-build / `desktop-touch-mcp-windows.zip` 生成 pipeline 影響リスク
- Codex v1 P2-3 の本旨は「Cargo auto-discovery 経路に乗せる」(`tests/integration/` の nested 死角を避ける)、unit test も `cargo test --lib` / `cargo test --workspace` で auto 拾われるので intent 充足
- `mod.rs` 内に置いた説明 comment で「なぜ tests/ ではなく src/ に置いたか」を明示

### 0.6 lifecycle test の singleton ring 競合対策

`ensure_l1()` ring は test 間 singleton。`subscriber_count()` を assert する複数 lifecycle test を parallel 実行すると相互干渉 → **module-local `OnceLock<Mutex<()>>` で lifecycle_tests 内 test 同士のみ serialize**。他 unit test は parallel 維持。

### 0.7 Edition 2024 で `std::env::set_var` が unsafe

`engine-perception` は `edition = "2024"` (Cargo.toml)。Rust 1.85+ で `set_var` / `remove_var` が unsafe 化 → `watermark_shift_env_override` test 内で `unsafe { ... }` ブロック化。SAFETY コメントで「var 名は本 crate 専用、他 test と競合しない」と明示

### 0.8 `subscriber_count` を test API として `#[allow(dead_code)]`

ring の broadcast 側 method (subscribe 以外の Subscription / dropped_count / subscriber_count) は今 production caller (= focus_pump 経由 recv_timeout のみ) からは触られない。**意図明示のため `#[allow(dead_code)]` + 「D2 metrics endpoint で公開予定」comment** を付与 (cargo の dead_code 警告を消すため)

### 0.9 verify 結果 (本 PR closure 時点)

- `cargo check --workspace` → 0 errors / 6 warnings (全て pre-existing、本 PR 由来 0)
- `cargo test --workspace --lib --no-default-features` → **60 tests / 60 pass** (desktop-touch-engine 48 + engine-perception 12)
  - broadcast unit (新規 8) + focus_pump unit (新規 9) + lifecycle (新規 2) + engine-perception unit (新規 12) + 既存 29 全 pass
- `npm run build:rs` → 成功 (release profile、auto-target rustup detection)
- `npm run test:capture` → **2434 pass / 1 fail (benchmark-gates timing flake、再実行で 10/10 pass) / 28 skipped** (P5c-1 baseline 2435 pass と実質同水準、本 PR 由来 regression 0)

### 0.10 follow-up 起票候補 (本 PR scope 外)

1. timely worker thread が cmd 待ち時 `worker.step()` + `sleep(1ms)` で busy-loop 風味 → bench (D1-5) で CPU 測定、必要なら `condvar` ベースに改修
2. `FocusEvent.name: String` の hot-path clone → `Arc<str>` 移行 (D1-5 bench 結果次第)
3. drop-newest carry-over の D2 metrics 化 (`Subscription::dropped_count()` を tool surface に出す)
4. `Pair<u64, u32>` の lex-total → product partial-order 移行 (D2 で本物の partial-order が必要になったら `new_unordered_input` API に切替)
5. `crates/engine-perception/src/{runtime.rs, worker.rs}` への分離 (D1-3 で view を `views/` 下に追加するときに refactor、Codex v1 提案 OQ #8)

---

- 親 plan: `docs/adr-008-d1-plan.md` §3 D1-2 sub-batch
- 親 ADR: `docs/adr-008-reactive-perception-engine.md`
- SSOT: `docs/architecture-3layer-integrated.md`
- 前提 (全て完了): D1-0 (PR #81) + D1-1 (PR #82) + P5c-0b (PR #84) + R11/R12 (PR #86/#87) + **P5c-1 (PR #88)** + build:rs auto-target (PR #89)
- 後続: D1-3 (`current_focused_element` view) + D1-4 (deterministic / partial-order test) + D1-5 (bench harness)

---

## 1. Background

### 1.1 P5c-1 までで揃った基盤

| 構成要素 | location | 状態 |
|---|---|---|
| L1 ring buffer (`Arc<EventRing>`) | `src/l1_capture/ring.rs` | ✅ P5a + R11/R12 |
| `EventKind::UiaFocusChanged = 1` + `UiaFocusChangedPayload { before, after, window_title }` | `src/l1_capture/{envelope,payload}.rs` | ✅ P5c-0b |
| UIA Focus event hook (real L1 push) | `src/uia/event_handlers/focus.rs` | ✅ P5c-1 (PR #88) |
| L3 bridge scaffold (`src/l3_bridge/mod.rs` 空 module) | `src/l3_bridge/mod.rs` | ✅ P5c-0b |
| `engine-perception::input::{L1Sink, FocusEvent, FocusInputHandle}` (stub) | `crates/engine-perception/src/input.rs` | ✅ P5c-0b |
| timely 0.29 + DD 0.23 deps | `crates/engine-perception/Cargo.toml` | ✅ D1-1 |
| workspace build infra (`check:rs-workspace`) | root `Cargo.toml` + `package.json` | ✅ D1-0 |

### 1.2 D1-2 で埋める gap

P5c-1 で「ring に `UiaFocusChanged` event が流れる」状態にはなったが、**ring の subscriber 側 (engine-perception) が空っぽ**。本 sub-batch で:

1. `EventRing` に **broadcast subscribe API** を追加 (既存 destructive `pop()` 経路は不変)
2. `engine-perception::input::FocusInputHandle` を **timely worker thread + InputSession + watermark advance** で fill (現状は stub)
3. `src/l3_bridge/focus_pump.rs` を新設 — adapter thread で `ring.subscribe()` → decode → `sink.push_focus()` (event_id 保持)
4. shutdown ordering を D1 plan §5.3 通りに整備、5-cycle test で deadlock-free 確認

これで D1 plan §3 の D1-2 sub-batch が実装上 close、残るは D1-3 (view) / D1-4 (deterministic test) / D1-5 (bench)。

### 1.3 D1-3 / D1-4 を本 PR に含めない理由

- D1-2 単体で **「ring → bridge → InputSession に event が届く」までを切る**。InputSession の出口 (operator graph) が空でも測れる (input flush carry の確認)
- D1-3 で `current_focused_element` view を追加するときに worker_loop 内 `dataflow_builder` を 1 行拡張するだけで済む構造に寄せる
- D1-4 (partial-order / out-of-order test) は view が無いと assert 対象がない (view 出力を読まないと検証できない)
- → D1-2 / D1-3 / D1-4 を 3 PR に分けることで review focus を保つ (D1 plan §4 の "PR-γ" を 3 分割相当)

### 1.4 副次 findings (本 PR 範囲)

#### (a) 既存 `EventRing::push` は `InternalEvent` を consume する
- `push(event: InternalEvent)` は ArrayQueue に `force_push(event)` で move する → broadcast に流すには **push 入口で snapshot を作って subscribers に送り、その後 ring に move** する flow が必要
- `InternalEvent.payload: Vec<u8>` を毎 push で clone するのは重い → snapshot 用の payload は `Arc<[u8]>` で表現 (subscribers が空のときはそもそも snapshot を作らない)

#### (b) napi 公開境界型 `EventEnvelope` は subscriber 側で使えない
- `EventEnvelope` は `BigInt` / `Buffer` を含む napi 型。bridge (root crate Rust 側) で `BigInt::from` 経由は不要なオーバーヘッド
- → broadcast 用に **純 Rust の `SubscriptionEvent`** 型を新設、`Arc<[u8]>` payload で cheap clone

#### (c) timely worker thread は thread-local
- timely の `InputSession` は worker thread 内でしか操作できない
- 外部から `push_focus(ev)` を直接 InputSession に流すことはできず、**command channel 経由で worker thread に投げる** パターンが必要 (timely の examples もこの形)
- D1-2 段階では view operator 無し / probe 1 個だけの最小 dataflow を構築、D1-3 で operator を追加する

#### (d) timely frontier は **単調 (monotone)** 制約 — Codex P1-2
- `InputSession::advance_to(t)` の後で `t' < t` の event を投入すると panic / 破棄される
- per-event `advance_to(event_time)` で frontier を進めると **out-of-order event を後から受け入れられない** → D1-4 の partial-order deterministic test と本質的に衝突
- → frontier (watermark time) と event logical time を **設計上 分離**、event は data として `update_at(data, event_time, +1)` で投入、frontier は `advance_to(watermark)` で別軸進行
- 詳細は §1.5 制約 + §3.2.4 worker_loop 設計

#### (e) broadcast subscribe は historical replay ではない — Codex v1 P2-2
- `EventRing::subscribe(capacity)` は subscribe **以降** の push を受信
- subscribe 時点で ring に既に居る event は subscriber に届かない
- → unit test / integration test は必ず **`spawn → ring.push → recv` の順**
- **重要 (Codex v2 P1)**: 「`spawn → push` の順」だけでは不十分 — `spawn` 内で thread を起動し、その thread body の中で `subscribe` する設計だと、`spawn()` が返った直後の caller `push` が worker thread の `subscribe` 到達前に走るレース で取りこぼす。**parent 側で `subscribe()` を先に呼んで `Subscription` を thread に move する**ことで構造的に消す (§3.3.2 で実装制約として明記)

#### (f) bounded channel `try_send` Full は **新規** drop — Codex P2-1
- `crossbeam_channel::bounded` の `try_send` は full のとき **新しい snapshot** を返す (`TrySendError::Full(snapshot)`)
- 「drop oldest」ではなく「drop newest」挙動
- focus 系では最新を失うのは stale view 直撃だが、capacity 8192 で UIA focus rate (人間操作 < 10/s × focus_pump poll 100ms 余裕) に対して 約 13 分相当の buffering → **D1 範囲では実害 0** と判断、drop-newest 仕様で確定
- 将来 high-rate event (DirtyRect 等、P5c-2) を broadcast に乗せるときは drop-oldest queue (`Arc<Mutex<VecDeque>>` or `crossbeam_queue::ArrayQueue` 採用) を別途検討、本 PR scope 外

### 1.5 北極星制約 — Codex review 反映の設計 invariant

D1-3 / D1-4 / D1-5 で「速いけど意味論が薄い」方向に流れないための gate。本 PR の Acceptance §7.1 / §7.4 と一対一対応。

**N1. L3 input row は必ず L1 `event_id` を保持する**
- bridge → engine-perception 経路で `SubscriptionEvent.event_id` を絶対に棄てない
- `FocusEvent` に `source_event_id: u64` field を必須で持たせる (`hwnd: 0` のような unresolved case でも保持、`event_id == 0` は L1 ring の sentinel なので dataflow row には現れない)
- 副次に `timestamp_source: u8` (`StdTime=0/Dwm=1/Dxgi=2/Reflex=3`) も保持 — replay / WAL (D6) で時刻ソース再現に必須
- 北極星: SSOT「L1/L2/L3/L4 を event_id で trace 可能」設計に対して、D1-2 でここを落とすと後続 envelope (D2) / causal trail (D2) / replay (D6) で取り返しが効かない

**N2. logical time は `(wallclock_ms, sub_ordinal)` を保持するが、timely frontier advance は out-of-order replay を壊さない方式にする**
- `FocusEvent.wallclock_ms` / `sub_ordinal` は **data field** として保持 (event-time)、これは絶対 advance_to の引数にしない
- worker_loop での `InputSession::update_at(data, event_time, +1)` で event を投入
- frontier 進行は `advance_to(watermark)` で別軸 (watermark = `(max_wallclock_seen.saturating_sub(WATERMARK_SHIFT_MS), 0)`)
- WATERMARK_SHIFT_MS = 100ms (default、`DESKTOP_TOUCH_WATERMARK_SHIFT_MS` env で override 可)
- これで out-of-order event が watermark 範囲内に収まる限り D1-4 partial-order test で受け入れ可能、frontier 単調性も維持

**N3. D1-2 は tool surface へ出さず、real L1 input ベースの engine 内部経路だけを成立させる**
- napi entrypoint からの自動起動は本 PR で **入れない**
- MCP tool surface (`desktop_state` 置換等) は D2 以降
- 本 PR の `spawn_perception_pipeline_for_test` は test / future bench harness 用 helper のみ
- 北極星: D1 で「動いてるけど tool 出すには semantics 薄い」状態を経由しないため、D1-2 で出口を意図的に絞る

---

## 2. Scope

### 2.1 本 PR で実装するもの

- `src/l1_capture/ring.rs`: `subscribe()` / `Subscription` 型 / `SubscriptionEvent` (純 Rust snapshot 型) / `RwLock<HashMap<u64, SubscriberSlot>>` 管理
- `src/l1_capture/mod.rs`: 新型の re-export
- `src/l3_bridge/focus_pump.rs`: adapter thread (subscribe → filter → decode → push_focus)、**event_id / timestamp_source 保持** (N1)
- `src/l3_bridge/mod.rs`: `pub(crate) mod focus_pump;` 追加 + test 用 helper (`spawn_perception_pipeline_for_test` / `shutdown_perception_pipeline_for_test`)
- `crates/engine-perception/src/input.rs`: `FocusEvent` に `source_event_id` + `timestamp_source` 追加、`FocusInputHandle` を **timely worker thread spawn + command channel + InputSession + watermark advance** で fill
- unit test (broadcast subscribe / focus_pump decode / FocusInputHandle command roundtrip / 5-cycle shutdown)
- integration test (`tests/d1_pipeline_lifecycle.rs` — Codex P2-3 反映で `tests/integration/` ではなく `tests/` 直下)
- D1 plan §3 D1-2 checklist の `[x]` flip

### 2.2 本 PR で実装しないもの

| 項目 | 担当 phase | 備考 |
|---|---|---|
| `current_focused_element` view operator graph | D1-3 | worker_loop 内 `dataflow_builder` 拡張のみ、本 PR で受け皿は確保 |
| out-of-order / partial-order deterministic test | D1-4 | view 無いと assert 対象が無い、watermark 設計だけは本 PR で確定 |
| bench harness (TS 版 vs view、p99 1/10) | D1-5 | view 完成後 |
| MCP tool surface への露出 (`desktop_state` 置換等) | D2 以降 | engine 内部完結 (N3) |
| broadcast 経路を **napi 経由で TS 側に出す** API | 当面なし | `l1Poll` (destructive) で十分、broadcast は Rust 内 only |
| `DirtyRect` / `WindowChanged` / `ScrollChanged` 等の他 EventKind を bridge 経由で流す | P5c-2/3/4 + D2 | trait `L1Sink` に `push_dirty_rect` 等を増やすときに対応 |
| broadcast を drop-oldest queue 化 | 当面なし | UIA focus rate << capacity、本 PR は drop-newest で確定 (§1.4 (f)) |
| napi entrypoint からの production 自動起動 | D2 | N3 |

---

## 3. Sub-batch 分解 (checklist)

実装担当者は完了したら `[ ]` → `[x]` に flip する。

### 3.1 EventRing broadcast 化

#### 3.1.1 `SubscriptionEvent` 型 (純 Rust snapshot)
- [x] `src/l1_capture/ring.rs` に `pub struct SubscriptionEvent` 追加:
  ```rust
  #[derive(Clone, Debug)]
  pub struct SubscriptionEvent {
      pub event_id: u64,
      pub kind: u16,
      pub wallclock_ms: u64,
      pub sub_ordinal: u32,
      pub timestamp_source: u8,
      pub envelope_version: u32,
      pub payload: Arc<[u8]>,  // cheap clone via Arc
      pub session_id: Option<String>,
      pub tool_call_id: Option<String>,
  }
  ```
- [x] `From<&InternalEvent> for SubscriptionEvent` 実装 (payload は `Arc::from(e.payload.as_slice())` で 1 回コピー)
- [x] `napi` 型 (BigInt / Buffer) は **使わない** (subscribers は Rust 内 only)

#### 3.1.2 `Subscription` 型 (Drop で auto-unsubscribe)
- [x] `src/l1_capture/ring.rs` に追加:
  ```rust
  pub struct Subscription {
      rx: crossbeam_channel::Receiver<SubscriptionEvent>,
      id: u64,
      parent: Arc<EventRing>,
      drop_count: Arc<AtomicU64>,  // shared with parent's SubscriberSlot
  }
  
  impl Subscription {
      pub fn try_recv(&self) -> Result<SubscriptionEvent, crossbeam_channel::TryRecvError>;
      pub fn recv_timeout(&self, t: Duration) -> Result<SubscriptionEvent, crossbeam_channel::RecvTimeoutError>;
      pub fn recv(&self) -> Result<SubscriptionEvent, crossbeam_channel::RecvError>;
      /// 本 subscriber 専用の **drop-newest** counter (channel full で
      /// 受信できなかった件数)。Codex P2-1 反映で「oldest ではなく新規が落ちる」
      /// 仕様であることを明記。
      pub fn dropped_count(&self) -> u64;
  }
  
  impl Drop for Subscription {
      fn drop(&mut self) {
          self.parent.unsubscribe(self.id);
      }
  }
  ```

#### 3.1.3 `EventRing::subscribe` / `unsubscribe`
- [x] `EventRing` 構造体に追加:
  ```rust
  subscribers: RwLock<HashMap<u64, SubscriberSlot>>,
  subscriber_id_counter: AtomicU64,
  
  struct SubscriberSlot {
      tx: crossbeam_channel::Sender<SubscriptionEvent>,
      drop_count: Arc<AtomicU64>,  // shared with Subscription
  }
  ```
- [x] `pub fn subscribe(self: &Arc<Self>, capacity: usize) -> Subscription`
  - capacity は subscriber 側 channel 容量。default 8192 を bridge 側で指定 (§1.4 (f) 根拠)
  - `bounded(capacity)` で `(tx, rx)` 作成、id 採番、`Arc<AtomicU64>` 共有 drop_count を作る、HashMap insert、`Subscription` 構築
- [x] `fn unsubscribe(&self, id: u64)` (private、Subscription::Drop 経由のみ呼ばれる)
  - `subscribers.write().remove(&id)`、Sender drop で channel disconnect

#### 3.1.4 `EventRing::push` の broadcast 拡張 (drop-newest 仕様、§1.4 (f) Codex P2-1)
- [x] 現 `push` 実装の冒頭で `event.event_id` を採番した直後に:
  ```rust
  let subs_guard = self.subscribers.read();
  if !subs_guard.is_empty() {
      let snapshot = SubscriptionEvent::from(&event);
      for slot in subs_guard.values() {
          match slot.tx.try_send(snapshot.clone()) {
              Ok(_) => {},
              Err(crossbeam_channel::TrySendError::Full(_)) => {
                  // **drop-newest**: full のとき新規 snapshot が落ちる。
                  // Subscription::dropped_count() でカウント可視化。
                  slot.drop_count.fetch_add(1, Ordering::Relaxed);
              }
              Err(crossbeam_channel::TrySendError::Disconnected(_)) => {
                  // subscriber dropped between read-lock and try_send;
                  // 次の Subscription::Drop 経由 unsubscribe が slot を消す。No-op here.
              }
          }
      }
  }
  drop(subs_guard);
  ```
- [x] subscribers 0 のとき (`is_empty()`) は **snapshot 構築すら走らない** = 既存 SLO p99 < 1ms 完全維持
- [x] 既存の `force_push(event)` / push_count / drop_count 経路は不変

#### 3.1.5 mod.rs re-export
- [x] `src/l1_capture/mod.rs` に `pub use ring::{Subscription, SubscriptionEvent};` 追加

#### 3.1.6 unit test (broadcast 単独、Codex P2-1 / P2-2 反映)
- [x] `single_subscriber_receives_events`: **subscribe → push 3 件 → `try_recv` 3 回 → kind / event_id 一致** (Codex P2-2: subscribe を先にすること明記)
- [x] `multi_subscriber_each_receives_all`: 2 subscriber を先に作る、push 3 件、両方が 3 件受信
- [x] `subscribe_after_push_does_not_replay`: ring.push 3 件 → subscribe → try_recv で空 (broadcast は historical replay ではない、Codex P2-2)
- [x] `subscriber_drop_removes_slot`: subscribe → drop → ring.subscribers.read().is_empty()
- [x] `subscriber_full_drops_new_with_counter`: capacity 4、subscribe → push 10 件 → try_recv で 4 件取得、`dropped_count() == 6` (Codex P2-1 反映で「new」)
- [x] `existing_destructive_poll_unaffected`: subscribe + push 3 件、`ring.poll(0, 100)` も同 3 件取得 (両経路独立、destructive `pop()` は subscribers 状態と無関係)
- [x] `push_with_no_subscribers_avoids_snapshot`: subscribers 空のときの push が既存 SLO 内 (実時間アサート、loose、SLO は `bench` で厳密)

### 3.2 `engine-perception::input::FocusInputHandle` 本実装

#### 3.2.1 `FocusEvent` 拡張 (Codex P1-1 / N1 反映)
- [x] `crates/engine-perception/src/input.rs` の `FocusEvent` に **`source_event_id: u64`** + **`timestamp_source: u8`** を追加:
  ```rust
  /// L3 input row。**`source_event_id` は L1 ring の event_id を必ず保持**
  /// (北極星 N1)。replay / causal trail / WAL でこの値を pivot に L1 → L3
  /// を trace するため、bridge 側で絶対に棄てない。
  #[derive(Debug, Clone)]
  pub struct FocusEvent {
      pub source_event_id: u64,  // ← P1-1 新規 (L1 ring event_id pivot)
      pub hwnd: u64,
      pub name: String,
      pub automation_id: Option<String>,
      pub control_type: u32,
      pub window_title: String,
      pub wallclock_ms: u64,     // event-time (data field、advance_to に渡さない、N2)
      pub sub_ordinal: u32,      // event-time の高分解能成分
      pub timestamp_source: u8,  // ← P1-1 副次 (StdTime=0/Dwm=1/Dxgi=2/Reflex=3、replay 用)
  }
  ```

#### 3.2.2 設計: timely worker thread + command channel + watermark advance (N2 / Codex P1-2)
- worker_loop で 1 thread spawn、その中で `dataflow_builder` で `InputSession<(u64, u32), FocusEvent, isize>` 構築
- 外部からは `FocusInputHandle::push_focus(ev)` で `Cmd::PushFocus(ev)` を `crossbeam_channel::Sender` に送る
- worker_loop は cmd 受信 → **`InputSession::update_at(ev, event_time, +1)`** で event 投入 → **`InputSession::advance_to(watermark)`** で frontier 進行 → `flush()` → `worker.step()`
- watermark = `(max_wallclock_seen.saturating_sub(WATERMARK_SHIFT_MS), 0)`、frontier 単調性のため `max_wallclock_seen` は monotone に更新

#### 3.2.3 構造体 / API
- [x] 既存 stub を全面書き直し:
  ```rust
  use std::sync::Arc;
  use std::sync::atomic::{AtomicBool, Ordering};
  use std::thread::{self, JoinHandle};
  use std::time::{Duration, Instant};
  use crossbeam_channel::{bounded, Sender, Receiver};
  
  pub type LogicalTime = (u64, u32);
  
  /// FocusEvent は §3.2.1 で `source_event_id` / `timestamp_source` 拡張済
  pub struct FocusEvent { /* §3.2.1 */ }
  
  pub trait L1Sink: Send + Sync {
      fn push_focus(&self, event: FocusEvent);
  }
  
  enum Cmd {
      PushFocus(FocusEvent),
      Shutdown,
  }
  
  pub struct FocusInputHandle {
      tx: Sender<Cmd>,
  }
  
  pub struct PerceptionWorker {
      join: Option<JoinHandle<()>>,
      tx: Sender<Cmd>,
  }
  ```

#### 3.2.4 worker_loop 実装 (timely + DD + watermark advance、N2 / Codex P1-2)
- [x] watermark 計算 helper:
  ```rust
  /// `DESKTOP_TOUCH_WATERMARK_SHIFT_MS` env で override 可。default 100ms。
  fn watermark_shift_ms() -> u64 {
      std::env::var("DESKTOP_TOUCH_WATERMARK_SHIFT_MS")
          .ok()
          .and_then(|s| s.parse::<u64>().ok())
          .filter(|&n| n <= 60_000)  // 上限 60s (sanity)
          .unwrap_or(100)
      }
  
  fn watermark_for(latest_wallclock_ms: u64, shift: u64) -> LogicalTime {
      (latest_wallclock_ms.saturating_sub(shift), 0)
  }
  ```
- [x] worker_loop 本体:
  ```rust
  fn worker_loop(cmd_rx: Receiver<Cmd>) {
      let shift = watermark_shift_ms();
      let mut latest_wallclock_ms: u64 = 0;  // monotone-updated
      let mut current_watermark: LogicalTime = (0, 0);  // monotone-advanced
      
      timely::execute_directly(move |worker| {
          let mut input: differential_dataflow::input::InputSession<LogicalTime, FocusEvent, isize> = {
              worker.dataflow::<LogicalTime, _, _>(|scope| {
                  // D1-2: 入力 collection だけ作る (operator graph 空、probe は D1-3 で view 加える時に追加)
                  let (input, _stream) = scope.new_collection::<FocusEvent, isize>();
                  input
              })
          };
          
          loop {
              match cmd_rx.try_recv() {
                  Ok(Cmd::PushFocus(ev)) => {
                      let event_time: LogicalTime = (ev.wallclock_ms, ev.sub_ordinal);
                      
                      // N2: event は data として update_at で投入。advance_to の引数にしない。
                      // frontier より古い event_time を update_at に渡すと DD が
                      // panic / 破棄するため、watermark 範囲内のものだけ受け入れる。
                      // out-of-order event が watermark shift 内に収まる限り deterministic。
                      if event_time >= current_watermark {
                          input.update_at(ev.clone(), event_time, 1);
                      } else {
                          // frontier より古い: out-of-order shift を超過 → drop + counter (D1-5 で metric 化)
                          // ※ counter は §3.2.6 test では直接アサートしない (D1-4 で詳細検証)
                          eprintln!(
                              "[perception-worker] out-of-order event dropped: event_time={:?} watermark={:?}",
                              event_time, current_watermark
                          );
                      }
                      
                      // frontier 単調性を保ちつつ watermark を進める
                      if ev.wallclock_ms > latest_wallclock_ms {
                          latest_wallclock_ms = ev.wallclock_ms;
                          let new_watermark = watermark_for(latest_wallclock_ms, shift);
                          if new_watermark > current_watermark {
                              current_watermark = new_watermark;
                              input.advance_to(current_watermark);
                          }
                      }
                      input.flush();
                  }
                  Ok(Cmd::Shutdown) => break,
                  Err(crossbeam_channel::TryRecvError::Empty) => {
                      // ターン消化 + 軽い sleep (busy-loop 回避)
                      worker.step();
                      thread::sleep(Duration::from_millis(1));
                  }
                  Err(crossbeam_channel::TryRecvError::Disconnected) => break,
              }
              worker.step();
          }
      });
  }
  ```
- [x] **timely 0.29 / DD 0.23 の正確な API は実装時に確認**:
  - `timely::execute_directly` の closure signature
  - `worker.dataflow::<T, _, _>(|scope| { ... })` の戻り値構成 (今回 input だけ返す形)
  - `differential_dataflow::input::InputSession::update_at(data, time, diff)` の存在
  - `InputSession::advance_to(time)` / `flush()` の存在
  - 不一致あれば §6 OQ 1 で記録、必要に応じ closure structure 調整
- [x] D1-3 で view を加えるときは `dataflow_builder` の中身に `arrange_by_key + reduce(...)` を追加するだけ、worker_loop の cmd dispatch は変更不要

#### 3.2.5 `L1Sink` impl + spawn / shutdown API
- [x] `pub fn spawn_perception_worker() -> (PerceptionWorker, FocusInputHandle)`:
  - bounded command channel (capacity 8192) を作る
  - thread spawn して `worker_loop(cmd_rx)` を起動
  - `(PerceptionWorker { join, tx: tx.clone() }, FocusInputHandle { tx })` を返す
- [x] `impl PerceptionWorker { pub fn shutdown(self, timeout: Duration) -> Result<(), &'static str> }`:
  - `self.tx.send(Cmd::Shutdown)` (channel が Disconnected の場合は ignore)
  - JoinHandle を polling join (L1 worker と同型 `is_finished()` polling shape):
    ```rust
    let deadline = Instant::now() + timeout;
    if let Some(h) = self.join {
        loop {
            if h.is_finished() {
                let _ = h.join();
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("perception worker join timed out");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
    Ok(())
    ```
- [x] `impl Drop for PerceptionWorker`: `tx.send(Cmd::Shutdown)` ignore + best-effort `join` (panic 起こさない)
- [x] `impl L1Sink for FocusInputHandle`:
  ```rust
  fn push_focus(&self, event: FocusEvent) {
      // 失敗 (worker shutdown 後 send) は graceful ignore — bridge 側 metrics で観測
      let _ = self.tx.send(Cmd::PushFocus(event));
  }
  ```

#### 3.2.6 unit test (Codex P2-2 反映で順序明示)
- [x] `spawn_and_shutdown_clean`: **spawn → 即 shutdown → no panic**
- [x] `push_focus_roundtrip_smoke`: **spawn → handle.push_focus(ev) × 3 → shutdown(2s) Ok**
- [x] `5_cycle_spawn_shutdown`: **5 回連続で spawn → push 1 件 → shutdown**、leak / panic / deadlock 無し
- [x] `push_after_shutdown_silently_drops`: shutdown 後の push は silently drop (panic しない)
- [x] `l1sink_object_safety`: `Arc<dyn L1Sink>` に格納可能 (既存 stub の test を維持)
- [x] `event_carries_source_event_id_and_timestamp_source`: ev.source_event_id = 12345 + timestamp_source = 1 で push、worker 側で受信して保持される (FocusEvent shape の round-trip 確認、N1)
- [x] `out_of_order_within_watermark_accepted`: shift=100ms に対し event_time=t-50ms を後から push、out-of-order rejected カウンタが増えない (watermark 範囲内、D1-4 で view 経由 assert は別 PR)
  - 注: 本 PR では view が無いので「dropped にならない」だけ確認、deterministic semantics は D1-4 で assert
- [x] `out_of_order_exceeding_watermark_dropped`: shift=100ms に対し event_time=t-500ms を後から push、stderr に out-of-order log が出る (assert は loose、D1-4 で counter 化)

### 3.3 `src/l3_bridge/focus_pump.rs` 実装

#### 3.3.1 構造体 / API
- [x] `src/l3_bridge/focus_pump.rs` 新設:
  ```rust
  use std::sync::Arc;
  use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
  use std::thread::{self, JoinHandle};
  use std::time::{Duration, Instant};
  
  use crate::l1_capture::{EventRing, EventKind, SubscriptionEvent, UiaFocusChangedPayload};
  use engine_perception::input::{FocusEvent, L1Sink};
  
  pub(crate) struct FocusPump {
      join: Option<JoinHandle<()>>,
      shutdown: Arc<AtomicBool>,
      forwarded_count: Arc<AtomicU64>,
      decode_failure_count: Arc<AtomicU64>,
      after_none_skip_count: Arc<AtomicU64>,
  }
  ```

#### 3.3.2 spawn / run (Codex v1 P1-1 / N1 反映で event_id / timestamp_source 必ず保持、**Codex v2 P1 反映で parent-side subscribe**)
- [x] `pub(crate) fn spawn(ring: Arc<EventRing>, sink: Arc<dyn L1Sink>) -> Self`
- [x] thread spawn name `l3-focus-pump`
- [x] **`subscribe` は parent thread で実行、`Subscription` を thread に move** (Codex v2 P1: `spawn→subscribe` 競合を構造的に消す):
  ```rust
  pub(crate) fn spawn(ring: Arc<EventRing>, sink: Arc<dyn L1Sink>) -> Self {
      // ─── Codex v2 P1: parent-side subscribe ──────────────────────────────
      // worker thread の中で subscribe すると、spawn() が return した直後の
      // caller `ring.push()` が subscribe 完了前に走るレースが起きる。broadcast
      // は historical replay ではない (§1.4 (e)) のでこれは取りこぼし fail に直結。
      // → parent thread で subscribe してから worker thread に Subscription を move。
      // Subscription は Send (Receiver + Arc + u64 + Arc<AtomicU64>) なので move 可。
      let sub = ring.subscribe(8192);
      // ─────────────────────────────────────────────────────────────────────
      
      let shutdown = Arc::new(AtomicBool::new(false));
      let forwarded = Arc::new(AtomicU64::new(0));
      let decode_failures = Arc::new(AtomicU64::new(0));
      let after_none_skip = Arc::new(AtomicU64::new(0));
      
      let shutdown_clone = Arc::clone(&shutdown);
      let forwarded_clone = Arc::clone(&forwarded);
      let decode_failures_clone = Arc::clone(&decode_failures);
      let after_none_skip_clone = Arc::clone(&after_none_skip);
      
      let join = thread::Builder::new()
          .name("l3-focus-pump".into())
          .spawn(move || {
              run(sub, sink, shutdown_clone, forwarded_clone,
                  decode_failures_clone, after_none_skip_clone);
          })
          .expect("spawn l3-focus-pump");
      
      Self {
          join: Some(join),
          shutdown,
          forwarded_count: forwarded,
          decode_failure_count: decode_failures,
          after_none_skip_count: after_none_skip,
      }
  }
  ```
- [x] thread body は `Subscription` を所有して loop:
  ```rust
  fn run(
      sub: Subscription,                             // ← parent から move、ring.subscribe 不要
      sink: Arc<dyn L1Sink>,
      shutdown: Arc<AtomicBool>,
      forwarded: Arc<AtomicU64>,
      decode_failures: Arc<AtomicU64>,
      after_none_skip: Arc<AtomicU64>,
  ) {
      let poll_timeout = Duration::from_millis(100);
      
      loop {
          if shutdown.load(Ordering::SeqCst) {
              break;
          }
          match sub.recv_timeout(poll_timeout) {
              Ok(env) => {
                  if env.kind != EventKind::UiaFocusChanged as u16 {
                      continue;
                  }
                  let payload: UiaFocusChangedPayload = match bincode::serde::decode_from_slice(
                      &env.payload, bincode::config::standard()
                  ) {
                      Ok((p, _)) => p,
                      Err(_) => {
                          decode_failures.fetch_add(1, Ordering::Relaxed);
                          continue;
                      }
                  };
                  let Some(after) = payload.after else {
                      // None = focus dropped (UIA で resolvable な focus がない状態)。
                      // current_focused_element view を更新しない (D1 範囲)。
                      // 「focus dropped」を意味的に view に反映するのは D2 (semantic_event_stream)。
                      after_none_skip.fetch_add(1, Ordering::Relaxed);
                      continue;
                  };
                  let ev = FocusEvent {
                      source_event_id: env.event_id,           // ← N1: L1 event_id を保持
                      hwnd: after.hwnd,
                      name: after.name,
                      automation_id: after.automation_id,
                      control_type: after.control_type,
                      window_title: payload.window_title,
                      wallclock_ms: env.wallclock_ms,
                      sub_ordinal: env.sub_ordinal,
                      timestamp_source: env.timestamp_source,  // ← N1: replay 用
                  };
                  sink.push_focus(ev);
                  forwarded.fetch_add(1, Ordering::Relaxed);
              }
              Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
              Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
          }
      }
      // sub drop で自動 unsubscribe (§3.1.2 Subscription::Drop) — fn 末尾で sub の所有権が解ける
  }
  ```
- [x] `pub(crate) fn shutdown(self, timeout: Duration) -> Result<(), &'static str>`:
  - `shutdown.store(true)` + JoinHandle polling join (L1 worker と同型)
- [x] `impl Drop for FocusPump`: best-effort signal + best-effort join

#### 3.3.3 stats accessor (D2 で metrics 出すとき用、本 PR では test 用)
- [x] `pub(crate) fn forwarded_count(&self) -> u64`
- [x] `pub(crate) fn decode_failure_count(&self) -> u64`
- [x] `pub(crate) fn after_none_skip_count(&self) -> u64`

#### 3.3.4 mod.rs 統合
- [x] `src/l3_bridge/mod.rs` の future submodule comment を `pub(crate) mod focus_pump;` 実体化に置換

#### 3.3.5 unit test (synthetic ring + mock sink、Codex v1 P2-2 反映で **spawn → push** の順、**Codex v2 P1 反映で immediate-push race regression**)
- [x] `spawn_then_immediate_push_arrives`: **spawn focus_pump → 直後 (sleep なし) に ring.push 1 件 → 200ms 内に mock sink で受信** — Codex v2 P1 race の regression test。parent-side subscribe 実装が壊れたら必ず flaky fail する
- [x] `forwards_uia_focus_to_sink`: **spawn focus_pump → ring.push (`UiaFocusChangedPayload { after: Some(...) }` 1 件) → 200ms 内に mock sink が `FocusEvent` 1 件受信** (Codex v1 P2-2)
- [x] `forwarded_event_carries_source_event_id`: 上記 test の延長で受信 `FocusEvent.source_event_id == ring.push() の戻り値 event_id` を assert (N1)
- [x] `forwarded_event_carries_timestamp_source`: `FocusEvent.timestamp_source == env.timestamp_source` を assert
- [x] `skips_non_focus_events`: spawn → ring.push (`Heartbeat` 1 件) → mock sink が空のまま、forwarded_count == 0
- [x] `skips_focus_with_no_after`: spawn → ring.push (`after: None`) → mock sink 空、`after_none_skip_count == 1`、forwarded == 0
- [x] `decode_failure_increments_counter`: spawn → 不正 payload bytes (kind=UiaFocusChanged だが bincode decode fail) を直接 ring.push → `decode_failure_count == 1`
- [x] `shutdown_within_2s`: spawn → shutdown(2s) で deadlock 無し
- [x] `5_cycle_spawn_shutdown`: 5 回連続 spawn → push → shutdown、ring の subscribers が 0 に戻る (毎サイクル末で `ring.subscribers.read().is_empty()` 確認)

### 3.4 統合: ensure_l1 / spawn_perception_worker / focus_pump の wire-up

D1-2 段階では production 起動経路 (napi entrypoint からの自動起動) は **入れない** (北極星 N3)。理由:
- D1-3 / D1-5 で view + bench が完成するまで MCP tool surface に出さない (D2 scope)
- production 自動起動を入れると test 側で stop / start するための API も必要になり scope 膨張
- 本 PR ではあくまで **test / future bench harness 用に明示 spawn / shutdown する API** だけ用意

#### 3.4.1 test 用 helper (Codex v1 P2-2 反映で **spawn → push** の順、**Codex v2 P1 反映で `FocusPump::spawn` 内 parent-side subscribe** が race を構造的に消す)
- [x] `src/l3_bridge/mod.rs` に `pub(crate) fn spawn_perception_pipeline_for_test() -> (PerceptionWorker, FocusPump)`:
  - `let (worker, handle) = engine_perception::input::spawn_perception_worker();`
  - `let ring = crate::l1_capture::ensure_l1().ring.clone();`
  - `let pump = focus_pump::FocusPump::spawn(ring, Arc::new(handle));` — `FocusPump::spawn` は parent thread で `ring.subscribe(8192)` を完了させてから戻るため (§3.3.2)、helper が return した時点で **subscribe は登録済**
  - `(worker, pump)` を返す
  - 呼び出し側 (test): `let (worker, pump) = spawn_pipeline_for_test(); ring.push(...); ...; shutdown_pipeline_for_test(worker, pump);` の順 — `spawn_pipeline_for_test` 戻り直後の同期 `push` も取りこぼし無し (Codex v2 P1 解消済)
- [x] `pub(crate) fn shutdown_perception_pipeline_for_test(worker: PerceptionWorker, pump: FocusPump) -> Result<(), &'static str>`:
  - **shutdown 順序**: pump → worker → (UIA / L1 は呼ばない、既存 helpers がそれぞれ管理)
  - `pump.shutdown(Duration::from_secs(2))?` (Subscription drop で ring から unsubscribe)
  - `worker.shutdown(Duration::from_secs(2))?` (timely worker thread join)

#### 3.4.2 production 起動 (D2 以降の TODO、N3)
- [x] D1 plan §11 / `docs/architecture-3layer-integrated.md` §17 の production lifecycle に合わせ、D2 の MCP tool surface 露出時に napi entrypoint から自動起動するよう拡張 — 本 PR では起動しない (production OFF、N3)

### 3.5 Shutdown ordering (D1 plan §5.3 / P5c plan §6.4 と完全整合)

```
shutdown 開始 (test 経路)
  ↓
1. focus_pump.shutdown(2s)     ← Subscription drop で ring から unsubscribe
  ↓
2. perception_worker.shutdown(2s) ← timely worker thread join
  ↓
3. shutdown_uia_for_test(3s)   ← UIA event handler Drop / CoUninitialize (既存)
  ↓
4. shutdown_l1_for_test(3s)    ← L1 worker thread join (既存、R11 polling shape)
  ↓
ring 全 drop 完了 (subscribers が空、ring 自体は L1 Drop で解放)
```

**production の場合** (D2 で実装):
- `napi entrypoint shutdown` で同順、または逆順 (UIA → L1 → bridge → worker、ただし UIA event delivery 中に bridge が止まると last event が drop される) — D2 で詰める

### 3.6 5-cycle integration test (deadlock-free 確認、Codex P2-2 / P2-3 反映)

- [x] **`tests/d1_pipeline_lifecycle.rs`** 新規 (Codex P2-3 反映で `tests/integration/...` ではなく `tests/` 直下、Cargo auto-discovery 対象):
  - **重要 (Codex P2-2)**: 各サイクルで **`spawn → ring.push → assert receive → shutdown` の順** を厳守。`push → spawn` 順だと subscribe 漏れで test が誤って fail する
  - 5 回連続で:
    1. `let (worker, pump) = spawn_perception_pipeline_for_test();`
    2. `let ring = ensure_l1().ring.clone();`
    3. `ring.push(...)` で synthetic UiaFocusChanged event を 数件 inject (本物の UIA hook ではなく test-only synthetic event)
    4. 200ms 待って `pump.forwarded_count()` を確認 (sink 側に届いている)
    5. `shutdown_perception_pipeline_for_test(worker, pump)` で shutdown
    6. サイクル末で `ring.subscribers.read().is_empty()` を確認
  - leak / crash / deadlock 無し
- [x] vitest 経由 test は不要 (D2 で MCP tool 露出してから整備)

### 3.7 Vitest regression (既存 napi 経路への影響確認)

- [x] `node scripts/test-capture.mjs --force` → 既存 2435 pass を維持 (P5c-1 PR 時点と同じ baseline)
- [x] `l1_poll_events` (destructive) は不変動作、`l1_get_capture_stats` の `push_count` / `drop_count` も不変
- [x] subscribers 0 のときの push hot-path コストが既存と一致 (snapshot 作らない条件分岐)

### 3.8 Docs flip

- [x] `docs/adr-008-d1-plan.md` §3 D1-2 の checklist 各項目を `[x]` に flip
- [x] `docs/adr-008-d1-plan.md` §11 Acceptance のうち本 PR で達成する項目を `[x]` (view / partial-order test / bench は本 PR scope 外なので除く)
- [x] `docs/views-catalog.md` §3.1 `current_focused_element` 行に「pipeline 配線完了 (D1-2)、view operator graph は D1-3」と注記
- [x] memory `project_3layer_architecture_design.md` を「ADR-008 D1-2 配線完了、次は D1-3 view operator」に更新
- [x] memory `MEMORY.md` index 更新 (ADR-008 進捗行)

---

## 4. PR 切り方

**単一 PR `feat/adr-008-d1-2-focus-pump`** で行く。

理由:
- 3 つの module 改修 (`l1_capture/ring.rs`, `engine-perception/input.rs`, `l3_bridge/focus_pump.rs`) は **互いに依存** (broadcast 無いと bridge 動かない、bridge 無いと FocusInputHandle test できない)
- shutdown ordering は 3 module 跨ぎなので review を 1 PR で完結させる
- watermark 設計 (§3.2.4) は 3 module 跨ぎ実装の semantic 中核なので分割せず一括 review
- size 想定: code ~520 LoC (watermark + event_id 保持 で +40) + test ~220 LoC (event_id / timestamp_source / out-of-order test 追加) + docs ~30 LoC = **~770 LoC**

**事前 review 分け**:
- (a) broadcast 化 (ring.rs): ring hot path 改修、Opus 直
- (b) FocusInputHandle (input.rs): timely API 初使用 (worker spawn / dataflow_builder / InputSession + watermark)、Opus 直
- (c) focus_pump (focus_pump.rs): decode + sink dispatch + event_id 保持、Opus 直
- → 全部 Opus 直で実装 (CLAUDE.md強制命令3 + memory `feedback_sonnet_model_selection.md` 準拠)

---

## 5. Risks / Mitigation

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **R1** | broadcast 経路で push hot-path SLO (p99 < 1ms) を破る | 中 | subscribers 空のとき snapshot 構築すらしない (`is_empty()` 早期 return)、subscribers > 0 でも `Arc<[u8]>` payload で clone は cheap、try_send は non-blocking。bench (D1-5) で SLO 維持確認 |
| **R2** | timely 0.29 / DD 0.23 の API が ADR-008 §2 の 0.13+ baseline と乖離して書けない | 中 | timely 0.29 docs / examples を実装時に確認、API 不一致あれば本書 §6 OQ で記録、最悪 0.13 系に downgrade も検討 (D1-1 で `cargo check` 通っているので大枠は動くはず) |
| **R3** | timely worker thread が `worker.step()` で busy-loop して CPU を食う | 中 | cmd_rx Empty 時に `thread::sleep(1ms)` を入れる (本書 §3.2.4)、bench で CPU 測定 (D1-5) |
| **R4** | shutdown ordering で deadlock (focus_pump が ring.subscribe channel block、L1 が止まると recv_timeout 永久 wait) | 致命 | recv_timeout(100ms) + AtomicBool shutdown flag の組合せで必ず exit。5-cycle test で deadlock-free 確認 (本書 §3.6) |
| **R5** | broadcast subscriber 側 channel が full で event 落ちる → focus_pump で取りこぼし (drop-newest 仕様、§1.4 (f)) | 中 | capacity 8192 で UIA focus event レート (人間操作 < 10/sec) には十分過剰。bench で SLO drop_count 確認、不足なら capacity 増 or pump 側 batched recv。将来 high-rate (DirtyRect) 用に drop-oldest queue 化は別 ADR で検討 |
| **R6** | `Subscription::Drop` と `EventRing::push` が race して `try_send` が `Disconnected` で落ちる | 低 | push 側で Disconnected を graceful 扱い (`No-op + 次回 unsubscribe で slot 削除`)。Drop 順序は test (本書 §3.6) で確認 |
| **R7** | `FocusInputHandle::push_focus` が worker shutdown 後に呼ばれて panic | 低 | `let _ = self.tx.send(Cmd)` で Result を捨てる (channel disconnected は graceful)、test で確認 (本書 §3.2.6) |
| **R8** | `bincode::serde::decode_from_slice` が入力長より長く読もうとして panic | 低 | bincode 2.x は Result を返すので `match` で graceful、panic は出ない。decode 失敗は counter increment + skip |
| **R9** | InputSession の `update_at` / `flush` / `advance_to` 順序間違いで differential dataflow の semantics が壊れる | 中 | timely / DD docs で正しい順序を確認 (update_at → advance_to(watermark) → flush が標準)、D1-3 で view 加える時に bench で出力確認 |
| **R10** | `engine-perception` crate に thread spawn / Mutex を入れることで ADR-008 §2 「pure compute crate」契約に違反 | 低 | thread spawn は worker thread 1 本のみ (timely の標準パターン)、Mutex は cmd channel のみで「napi-free / windows-rs-free」契約は維持。Codex review v2 P1 の本旨は守れる |
| **R11** | `l1_capture::SubscriptionEvent` を pub にすると napi 公開境界に漏れる懸念 | 低 | `SubscriptionEvent` は napi 型を含まない pure Rust struct、`#[napi(object)]` ではなく純 struct → napi binding 生成にはそもそも乗らない。`l1_capture/napi.rs` は触らない |
| **R12** | watermark shift が短すぎると out-of-order event を drop / 長すぎると view 反映 latency 増 (Codex P1-2 反映) | 中 | default 100ms、`DESKTOP_TOUCH_WATERMARK_SHIFT_MS` env で調整可。D1-4 で out-of-order replay test、D1-5 bench で latency 確認、必要に応じ default を再計算。out-of-order drop 時は eprintln + counter (本書 §3.2.4)、D1-5 で metrics 化 |
| **R13** | `source_event_id` を持たせる FocusEvent サイズ増で broadcast / DD arrangement memory が増える (Codex v1 P1-1 反映の副次) | 低 | `u64` + `u8` 追加で +9 byte / event。UIA focus event は < 10/sec で arrangement 1MB 以内 SLO は変わらない。bench (D1-5) で実測 |
| **R14** | `FocusPump::spawn` 戻り直後の `ring.push` が thread の `subscribe` 到達前に走り flaky fail (Codex v2 P1) | 中 | parent thread で `ring.subscribe(8192)` を先に呼んで `Subscription` を thread に move (§3.3.2 実装制約)。regression test `spawn_then_immediate_push_arrives` (§3.3.5) で確認 |

---

## 6. Open Questions

| # | OQ | 決定タイミング |
|---|---|---|
| 1 | timely 0.29 の `execute_directly` / `worker.dataflow` / `differential_dataflow::input::InputSession::update_at` の正確な signature (0.13 から大きく動いている可能性) | 実装着手時、`cargo doc --open -p timely -p differential-dataflow` / examples 確認 |
| 2 | `worker.step()` を毎 cmd 後に呼ぶか、cmd batch 後に 1 回呼ぶか (latency vs CPU) | 実装着手時、bench (D1-5) でも確認 |
| 3 | `FocusEvent` の `name: String` を `Arc<str>` に変更するか (broadcast clone コスト最適化) | D1-5 bench で hot path が `String::clone` だったら検討 |
| 4 | `Subscription::recv_timeout` の poll_timeout 100ms は production で長すぎないか (focus → view 反映 latency に影響) | D1-5 bench で実測、p99 が 1/10 SLO に届かなければ短縮 |
| 5 | 本 PR で `Arc<dyn L1Sink>` を bridge に渡すか、concrete `FocusInputHandle` を渡すか (trait object cost) | 実装時、trait object 維持で contract 安定化を優先、性能差は bench 後に判断 |
| 6 | `engine-perception` crate を bridge から `Arc::new(FocusInputHandle)` で握ると Drop 順序がややこしい (FocusInputHandle.tx と worker thread JoinHandle が別管理) | 実装時、`PerceptionWorker.shutdown()` を呼ぶ前に `Arc<FocusInputHandle>` を全 drop する手続きを test helper で確定 |
| 7 | watermark shift default 100ms は人間操作の UIA focus interval (~ 数百 ms) に対し短すぎないか / 長すぎないか | D1-4 / D1-5 で実測、現状 default、env override 可で実装 |
| 8 | `engine-perception/src/input.rs` が worker lifecycle (PerceptionWorker / spawn_perception_worker) まで持つと膨らむ → 将来 `runtime.rs` / `worker.rs` に分け、`input.rs` は `FocusEvent` / `L1Sink` / command input 境界に寄せる (Codex 提案) | D1-3 で view が増えるタイミングで refactor、本 PR では `input.rs` 1 ファイルで完結 |

---

## 7. Acceptance Criteria

### 7.1 機能 (北極星 N1 / N2 と一対一)
- [x] `EventRing::subscribe()` で複数 subscriber が同 push を独立に受信 (本書 §3.1.6 unit test pass)
- [x] `Subscription::Drop` で ring 側 `subscribers` から自動削除
- [x] subscribers 0 のときの push hot-path コストが既存とほぼ等しい (snapshot 構築されない)
- [x] subscribe 前の push は subscriber に届かない (broadcast は historical replay ではない、Codex P2-2)
- [x] subscriber 側 channel full で **新規** snapshot が drop され `dropped_count()` がインクリメント (drop-newest 仕様、Codex P2-1)
- [x] `FocusPump::spawn` で adapter thread 起動 → ring に `UiaFocusChanged` event を inject すると `FocusInputHandle::push_focus` が呼ばれる (mock sink で確認)
- [x] **`FocusEvent.source_event_id == ring.push() の戻り値 event_id`** (北極星 N1)
- [x] **`FocusEvent.timestamp_source == env.timestamp_source`** (北極星 N1 副次)
- [x] **`FocusEvent.wallclock_ms` / `sub_ordinal` は data field として保持され、frontier `advance_to` の引数にされない** (北極星 N2)
- [x] **worker_loop の frontier 進行は watermark 経由** (`advance_to((max_wallclock - WATERMARK_SHIFT_MS, 0))`、北極星 N2)
- [x] watermark 範囲内の out-of-order event は受け入れられる (drop されない)、範囲外は eprintln + counter
- [x] `payload.after = None` の event は graceful skip (`forwarded_count` 進まない、`after_none_skip_count` 進む)
- [x] decode 失敗は graceful skip + `decode_failure_count` increment

### 7.2 lifecycle
- [x] `spawn_perception_pipeline_for_test → push 数件 → shutdown_perception_pipeline_for_test` を 5 cycle 連続実行で leak / crash / deadlock 無し (本書 §3.6 integration test、`tests/d1_pipeline_lifecycle.rs`)
- [x] shutdown 後 `ring.subscribers` が空
- [x] `FocusInputHandle::push_focus` が worker shutdown 後に呼ばれても panic しない

### 7.3 既存経路の不変
- [x] `cargo check --workspace` pass (engine-perception 含む)
- [x] `cargo test --lib --no-default-features` で既存 test 全 pass (broadcast 化が既存 destructive `pop()` に影響しない)
- [x] `npm run build:rs` 成功 (rustup auto-target で OK)
- [x] vitest 2435 pass / 0 regression (`l1_poll_events` / `l1_get_capture_stats` 経由の既存 test)
- [x] CI green (`check:rs-workspace` 含む)

### 7.4 北極星制約 (§1.5、本 PR 内で必ず満たす)
- [x] **N1**: bridge から engine-perception に渡る `FocusEvent` は L1 `event_id` を必ず保持 (`source_event_id` field、§3.2.1 / §3.3.2)。test `forwarded_event_carries_source_event_id` で assert
- [x] **N2**: timely frontier advance は watermark 経由 (`watermark_for(latest_wallclock, shift)`)、event-time は data field 保持。out-of-order event が watermark 内なら受け入れ、外なら drop (§3.2.4)
- [x] **N3**: napi entrypoint からの自動起動を入れない (本 PR では `spawn_perception_pipeline_for_test` のみ)。MCP tool surface への露出は D2 以降

### 7.5 docs
- [x] D1 plan §3 D1-2 sub-batch checklist 全項目 `[x]`
- [x] views-catalog §3.1 注記更新 (operator graph は D1-3)
- [x] memory `project_3layer_architecture_design.md` / `MEMORY.md` 更新

### 7.6 D1 plan §11 acceptance のうち本 PR で達成する項目 (本 PR merge 時に flip する到達目標、Codex P3-1 反映)
- [x] **ADR-007 P5c-1 完了** を前提として real L1 input が ring 経由で bridge → engine-perception に流れる経路が成立 (本 PR merge 時に flip)
- [x] `src/l3_bridge/focus_pump.rs` が動作 (subscribe → decode → push_focus、event_id 保持) (本 PR merge 時に flip)
- [ ] (D1-3) 1 view が incremental に更新 — 本 PR では受け皿のみ (本 PR では未到達)
- [ ] (D1-4) partial-order test pass — 本 PR scope 外 (本 PR では未到達)
- [ ] (D1-5) bench で TS 版より latency 1/10 — 本 PR scope 外 (本 PR では未到達)

---

## 8. ADR-008 D1 への接続

PR `feat/adr-008-d1-2-focus-pump` merged 時点で:
- ADR-008 D1 plan §3 D1-2 sub-batch 全項目 `[x]` flip
- 北極星 N1 / N2 / N3 を D1 全体で守れる出発点が confirm
- 次は **D1-3** (`current_focused_element` view operator graph in `crates/engine-perception/src/views/`)
- D1-3 完了で D1 acceptance「1 view が incremental に更新」が達成
- D1-4 で out-of-order / partial-order deterministic test (本 PR の watermark 設計が活きる)
- D1-5 bench で「TS 版より latency 1/10」確認、D1-6 で docs / memory 整合 → ADR-008 D1 全完了

---

## 9. 関連

- 親 plan: `docs/adr-008-d1-plan.md` (§3 D1-2 sub-batch / §5 / §11)
- 親 ADR: `docs/adr-008-reactive-perception-engine.md`
- SSOT: `docs/architecture-3layer-integrated.md` §17 (lifecycle)
- 前提 PR (履歴):
  - #79 (main-push guard、merged)
  - #80 (P5b defer、merged)
  - #81 (D1-0 workspace + plan tracking、merged `a1cd5e8`)
  - #82 (D1-1 timely + DD deps、merged `f8877a8`)
  - #83 (P5c plan + D1 plan reconcile、merged `fd66445`)
  - #84 (P5c-0b foundation、merged `e612aad`)
  - #86 (R11 L1 worker shutdown fix、merged `9fcfdeb`)
  - #87 (R12 UIA shutdown race fix、merged `6d30170`)
  - #88 (P5c-1 UIA Focus Changed event hook、merged `3eb66cf`)
  - #89 (build:rs auto-target、merged `d091e9e`)
  - #本 PR (D1-2 real L1 → engine-perception adapter、ADR-008 D1-3 blocker 解除)
- judgment lesson: `memory/feedback_north_star_reconciliation.md` (synthetic pivot 否決の経緯)
- Codex review 履歴:
  - v1 → Codex v1 (P1×2 [event_id 保持 / watermark vs frontier] + P2×3 [drop-newest / spawn 順 / tests path] + P3×1 [Draft acceptance] + 北極星 3 条件追記) → v2
  - **v2 → Codex v2 (P1×1 残ズレ: `spawn→subscribe` 競合 — parent-side subscribe で構造的に解消) → v3 (本書)**
  - 実装後 PR review (Sonnet 委譲しないため Opus self-review + Codex review 1-2 ラウンド想定)
