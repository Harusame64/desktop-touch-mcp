# ADR-008 D2 — 主要 view 4 つ + desktop_state focus path view 経由置換プラン

- Status: **Draft v3.5 (起草中、Opus、2026-04-30) — Codex review v1 + v2 + v3 + v4 + v6 + v7 + v8 反映済 + Opus phase-boundary review (D2-0 phase) 完了**
- Date: 2026-04-30
- Authors: Claude (Opus, max effort) — `desktop-touch-mcp`
- 親 ADR: `docs/adr-008-reactive-perception-engine.md` §4 D2 / §8 D2
- SSOT: `docs/architecture-3layer-integrated.md`、`docs/views-catalog.md` §3.2、`docs/layer-constraints.md` §4 (L3 Compute)
- 前段 plan: `docs/adr-008-d1-plan.md` (Implemented)、`docs/adr-008-d1-2-plan.md` (Implemented)
- Carry-over 元: `docs/adr-008-d1-followups.md` (本書で §3.5 を除き全消化)

---

## 0. 改訂履歴 (Codex review 反映)

### v1 (初稿、2026-04-30)
B 案合意のもと起草。worker tuning option B + desktop_state 「全部」 view 経由 + 主要 view 4 + D1-3 残 5 項目を 7 PR で直列 merge する案。

### v2 (Codex review 反映、2026-04-30)
Codex から P1×3 / P2×3 の指摘。要点:
- **P1-1**: 現行 `desktop_state` は focus 以外に at-point/modal/window-list/attention などを束ねる。「全部 view 経由」を v1 D2-B 単独で達成は不可 — D2 では **focus-only first replacement** に縮小、attention/modal は D4 完了まで分散と明記
- **P1-2**: option B (`advance_to((wc + ε, 0))`) は同 wc 異 sub_ordinal の後着 event を back-dated 化するリスクで N3 (partial-order) と緊張 — **batch drain + observed max logical time release** に再設計 (§4 §4.2)
- **P1-3**: `DirtyRect (=0)` / `WindowChanged (=5)` / `ScrollChanged (=6)` は payload 定義のみで emit site 未実装 — **D2-C0 readiness gate** を新設、未実装なら ADR-007 P5c-2/3/4 を prerequisite として外出し
- **P2-4**: `spawn_perception_pipeline_for_test` は test 用 helper、production lifecycle 不在 — **D2-0 production pipeline lifecycle** を新設 (D2-B より前)
- **P2-5**: 既存 `hints.focusedElementSource = "uia" | "cdp"` がある — `meta.focus_source` 新設ではなく **sentinel 拡張 `"view"`** で互換維持
- **P2-6**: 現 view は `inspect → Arc<RwLock<HashMap>>` 経由で arranged collection は未公開 — **D2-E0 arrangement export refactor** を新設 (D2-E より前)

PR 構成も v1 7 PR → v2 10 PR に再分割。

### v3 (Codex review v2 反映、2026-04-30)
Codex から P1×2 / P2×3 の指摘。要点:
- **P1-3 (controlType bit-equal)**: 現行 `desktop_state.ts:184` は `focused.controlType` を **文字列**として `type` フィールドに出している (例: `"Button"` / `"Pane"`)。D1 view `UiElementRef.control_type: u32` は raw `UIA_CONTROLTYPE_ID` のままで、view 経由化すると数値化して bit-equal 衝突 — **D2-B-1 で UIA control type id → 既存文字列への変換を明記**、view export 戻り値を `controlType: string` に揃える (§2 D2-B-1)
- **P1-4 (hwnd lookup miss)**: `focus_pump.rs:221` で `hwnd: after.hwnd` (= focused element hwnd) を採用、これは foreground window hwnd と一致しない (child / control hwnd / unresolved 0)。`view_get_focused(activeHwnd)` だと miss して UIA fallback、置換率が不安定 — **`latest_focus` 1-row view を新設**、本 D2 では「最新 focus event 1 件 (global)」を別 view で公開 (§2 D2-B-2、§5.bis 新設)
- **P2-7 (OnceLock 直置き)**: 既存 lib は `L1_SLOT: OnceLock<Mutex<Option<Arc<L1Inner>>>>` (`worker.rs:227`) パターンで shutdown / restart を回している。`OnceLock<PerceptionPipeline>` 直置きでは shutdown 後の再 init が不可 — **D2-0 で既存 L1_SLOT パターンを踏襲**、`PERCEPTION_SLOT: OnceLock<Mutex<Option<Arc<PerceptionPipeline>>>>` に修正
- **P2-8 (shutdown-only batch frontier 歪み)**: revised tuning 擬似コードで `Cmd::Shutdown` 単独 batch でも `advance_to((0, 1))` + `processed_count += 1` してしまう — **§4.2 擬似コードに `event_count > 0` ガード追加**、shutdown-only batch では advance/flush/processed_count スキップ
- **P2-9 (Arranged scope lifetime)**: timely `Arranged` は `worker.dataflow` closure scope に lifetime 結びつき、外部 struct で保持不可 — **D2-E0 設計を「同 dataflow closure 内で arranged + view 両方を build、predicted_post_state も同 scope 内に配線」に変更** (§2 D2-E0、§7)

おすすめ着手順序 (Codex 提案): **D2-0 → D2-A → D2-B proof → D2-C0 gate**。
- D2-0 で production lifecycle の所有権を固める (既存 L1_SLOT パターン踏襲)
- D2-A で worker loop の batch/frontier tuning (revised) を入れる
- D2-B は `controlType` 文字列互換と `latest_focus` view を **proof PR** として小さく潰す
- DXGI/UIA の追加 emit site は ADR-007 prerequisite 化する公算大、D2-C/D は D2-C0 gate 後に go/no-go 判断

### v3.1 (Codex review v3 反映、2026-04-30)
Codex から P1×1 / P2×2 の指摘。要点:
- **P1-5 (latest_focus inspect 順序で stale/None)**: §5.bis の `Arc<RwLock<Option<UiElementRef>>>` 直接 set/clear 設計は DD reduce inspect が assertion/retraction を任意順で発火する仕様と衝突 — **D1 view と同 pattern (`BTreeMap<(LogicalTime, UiElementRef), i64>` + `count > 0 を rev walk`) に修正** (§5.bis.4)
- **P2-10 (Arc clone 残存下 shutdown)**: `Arc<PerceptionPipeline>` clone が他 caller に残ると `slot=None` にしても内部 thread が停まらない — **既存 `L1Inner::shutdown_with_timeout(&self)` パターンを踏襲**、`Mutex<Option<JoinHandle>>` を `take()` + shutdown signal で thread 停止、view read handle は thread 不要なので clone 残存は無害 (§2 D2-0-1 + D2-0-3 新規 test + R15)
- **P2-11 (§7 古い記述)**: §7 が `current_focused_element_arranged.import(scope)` の v2 古い記述のまま — **v3 D2-E0 / D2-E と同じ「同 scope 内 borrow」設計に修正** (§7)

D2-B の最初に diff-bookkeeping materialization test を置く Codex 推奨も採用 (§5.bis.4 末尾)。共通 helper 抽出 (D1 D2-F-1 と D2-B-2 の共通化) は §10 OQ #13 で記録。

### v3.3 (Codex review v6 反映、PR #94 review、2026-04-30)
PR #94 (D2-0 PR-α) に対する Codex round 6 で **P1 級バグ** 発見:

- **P1-7 (timeout 後 degraded pipeline)**: v3.2 設計の `PerceptionPipeline.{worker, pump}: Mutex<Option<...>>` は consume-shutdown を `take()` 後に呼ぶ shape。pump or worker の `shutdown` が Err を返すと、その leg は `None` として永久に失われる → slot は元 Arc retain (Codex v4 P1-6) しているが、その Arc の中身が degraded (片肺 or 両肺欠損)。次回 shutdown は `None` leg を no-op で `Ok(())` 返却 → slot clear → `ensure_perception_pipeline()` が新 worker 生成 → **二重 worker spawn の北極星違反**

**修正 (Codex round 6 + 別ライン Codex 通知 反映)**:
1. **`PerceptionWorker` / `FocusPump` 自体を retain-on-timeout 型に refactor**: `join: Mutex<Option<JoinHandle<()>>>` を持ち、`shutdown_with_timeout(&self, timeout) -> Result<...>` を新設。L1 `worker.rs:174-194` と完全同型で、timeout 失敗時は handle を retain → 後続 `shutdown_with_timeout(longer)` で再 try 可能
2. **`PerceptionPipeline` を `Mutex` 不要に簡素化**: `worker: PerceptionWorker / pump: FocusPump` を直接保持、`shutdown_with_timeout(&self, timeout)` は `pump.shutdown_with_timeout(half) → worker.shutdown_with_timeout(half)` の薄い委譲のみ
3. **既存の consume-form `shutdown(self, timeout)` も互換維持** (test 互換のため、内部で `shutdown_with_timeout` に delegate)
4. **OQ #14 carry-over だった 2 timeout 失敗 test を本実装** (refactor で fixture 不要化、`Duration::from_nanos(1)` で deadline 強制超過):
   - `shutdown_timeout_failure_retains_slot`: 1ns timeout → Err → slot retain → 同 Arc → 長 timeout 再 try で Ok
   - `pipeline_recovers_from_partial_shutdown`: 1ns timeout 失敗 → 長 timeout retry で完了 (両 leg JoinHandle retain で resume polling)
5. OQ #14 を Resolved 化、§2 D2-A-0 carry-over 解消

これで「shutdown 失敗時に二重 worker を作らない」北極星が **設計 + 実装 + test 3 重で pin** された。L1 layer と完全同型。

### v3.4 (Codex review v7 P2 反映、PR #94 round 2、2026-04-30)
v3.3 の P1 修正に対し Codex round 7 で **P2 を発見**:

- **P2-14 (shutdown signal が full channel で block)**: `PerceptionWorker::shutdown_with_timeout` の最初で `self.tx.send(Cmd::Shutdown)` を呼ぶが、`crossbeam_channel::Sender::send` は **bounded channel が full の場合 block する**。production の UIA rate (< 10/s) vs capacity 8192 で実質 fill しないが、stuck worker / panicked worker / stress test で channel が満杯になると **deadline を作る前に send が block** → timeout が効かない

**修正**:
1. `PerceptionWorker::shutdown_with_timeout` の `self.tx.send(Cmd::Shutdown)` を **`self.tx.try_send(Cmd::Shutdown)`** に変更 — full / disconnected で即 Err、deadline 経路に進める
2. `PerceptionWorker::Drop` も同様に `try_send` 化 (Drop は best-effort、block 不可)
3. `push_focus` 経路の `tx.send(Cmd::PushFocus(...))` は **不変** (event push、ordering 保持のため block 仕様、capacity vs rate ratio で実質 block しない)
4. **新 regression test `shutdown_with_timeout_does_not_block_on_full_channel`**: bounded(1) を fill した状態で stuck dummy worker を spawn、`shutdown_with_timeout(50ms)` が 500ms 以内に Err を返すことを measure。`send` への regression があれば 3 秒 block して fail
5. cargo test: engine-perception 24 → **25 pass** (新 test 含む)、root 55 維持

これで「shutdown が channel-full で block しない」が **コード + コメント + 直接 measure test の 3 重 pin**。

### v3.5 (Codex review v8 反映、PR #94 round 3、2026-04-30)
v3.4 の修正に対し Codex round 8 で **2 P2** を発見:

- **P2-15 (full-channel で shutdown signal が drop される)**: `try_send(Cmd::Shutdown)` が `Full` を返すと shutdown 命令が discard される。channel が full のまま worker が backlog を drain して empty になっても、shutdown signal は届かず `Disconnected` も観測しない → 健全な worker でも shutdown timeout で Err
- **P2-16 (失敗 pipeline shutdown で half-stopped state が永続化)**: pump 成功 → worker 失敗のシナリオで pump.join は take 済 + pump shutdown flag set だが、retain Arc は slot 占有。後続 `ensure_perception_pipeline()` が degraded pipeline (L1 event 転送停止済) を返してしまい、新 caller が「使える」と思って取得 → contract violation

**修正**:
1. **P2-15: `try_send` retry loop**: `PerceptionWorker::shutdown_with_timeout` を **2-phase 化** — phase 1 で `try_send(Cmd::Shutdown)` を deadline 内で retry (Full なら poll_interval sleep して再 try、Disconnected/Ok なら break)、phase 2 で従来の `is_finished()` polling。channel が transient pile-up でも deadline 内で送れれば成功
2. **P2-16: poison flag + ensure eviction**:
   - `PerceptionPipeline.poisoned: AtomicBool` を追加、`shutdown_with_timeout` 失敗時に set
   - `ensure_perception_pipeline()` で existing が `is_poisoned()` なら best-effort `shutdown_with_timeout(100ms)` 再試行 → slot を `None` → fresh pipeline spawn
   - `is_poisoned()` は public method で、stale Arc を持つ caller も状態を観測可能 (view 等の read は post-poison でも safe)
3. **既存 test 更新**: `shutdown_timeout_failure_retains_slot` を v3.5 設計反映で `shutdown_timeout_failure_poisons_slot_and_evicts_on_next_ensure` にリネーム + 仕様変更 (poison + evict 動作を直接 assert)
4. **新 regression test**:
   - `shutdown_with_timeout_retries_send_when_channel_drains` (engine-perception): pre-fill channel + drain-eventually worker で retry loop が cmd を deliver して Ok を返すことを直接 measure
5. cargo test: root 55 pass + engine-perception 26 pass (+1 新) = **81 pass / 0 fail**

### v3.2 (Codex review v4 反映、2026-04-30)
Codex から P1×1 / P2×2 の指摘。要点:
- **P1-6 (shutdown API が L1_SLOT パターンの安全条件を落としている)**: v3.1 の `shutdown_perception_pipeline_for_test() -> bool` 表記は実 `L1Inner::shutdown_with_timeout` (`worker.rs:174-194`) の `Result<(), &'static str>` + 「成功時のみ slot clear / 失敗時は元 Arc を保持 / `Arc::ptr_eq` で同一インスタンス確認」の安全条件を落としている。失敗時に slot 空にすると二重 worker を生む — **D2-0 の API signature と slot-clear protocol を実 L1 と完全同型に修正** (§2 D2-0-1 / D2-0-2 / D2-0-3、R17)
- **P2-12 (shutdown_with_timeout 擬似コードが timeout を使っていない)**: v3.1 の擬似コードは `JoinHandle::join()` 直呼びで timeout 無効。pump/worker が停止しないと無期限 block — **既存 `L1Inner::shutdown_with_timeout` (`worker.rs:174-194`) と同じ `deadline + is_finished() polling` shape に修正** (§2 D2-0-1 + R16)
- **P2-13 (latest_focus operator graph が timestamp を落として読める)**: §5.bis.4 で `apply_diff(ts, element, diff)` に修正したが §5.bis.3 graph はまだ `collection<UiElementRef>` 表記、inspect 側で `LogicalTime` をどこから取るか曖昧 — **graph を `collection<(LogicalTime, UiElementRef)>` に修正、inspect data に `(ts, ui_ref)` が残る shape を明記** (§5.bis.3)

D2-0 の **「成功時のみ slot clear」を北極星扱い**で明記 (Codex v4 推奨、後続の flaky 二重 worker 問題を予防)。

---

## 1. Scope

ADR-008 §4 D2 完了基準は本質的に複数 phase に跨る (`desktop_state` の全 fields は modal_state / attention_signal を含み D4 完了が必要)。本 D2 では以下を明確に切り分ける。

### 1.1 D2 で完結させるもの (本書のスコープ)

A. **production pipeline lifecycle** (`ensure_perception_pipeline()` / `shutdown_perception_pipeline()`) — D2-B 以降の土台
B. **worker_loop tuning (revised)** — batch drain + observed max logical time release で `update p99 < 1ms` 達成、partial-order 維持
C. **bench harness 強化** — 真の p99 / production gap (`uiaGetFocusedAndPoint`) / MCP transport / real L1 ring → view 全経路
D. **`desktop_state` focus-only path 置換** — focus 取得を view 経由に、`hints.focusedElementSource = "view"` で観測、bit-equal 回帰 0
E. **L1 emitter readiness gate (D2-C0)** — DXGI dirty rect / UIA window-change / scroll の emit site 実装状況確認、未実装なら本 D2 から retire
F. **新規 view 2-3 つ** (gate 結果に依存):
   - `dirty_rects_aggregate` (`EventKind::DirtyRect` emit 済の場合)
   - `semantic_event_stream` (`UiaFocusChanged` 単独でも `FocusMoved` variant のみで成立可)
   - `predicted_post_state` subgraph 構造 (D5 で本格化)
G. **D1-3 残 follow-up 5 項目** (`docs/adr-008-d1-followups.md` §3.1〜§3.4, §3.6)
H. **arrangement export refactor** (D2-E0) — `current_focused_element` view を arranged collection と read handle の両方で expose、`predicted_post_state` の subgraph import を可能化

### 1.2 D2 では実装しないもの (D4 / 後続 phase に分散)

- **`desktop_state.modal`**: modal_state view の実装は D4 (views-catalog §3.5 cyclic 系)
- **`desktop_state.attention`**: attention_signal view は D4 (cyclic 系、lens_attention の派生)
- **at-point / cursor-over element**: 既存 `uiaGetFocusedAndPoint` 経路維持、view 化は D4 以降の別 view を新設してから (本 D2 OQ #5)
- D2.5: `recent_changes_5s` / `tool_call_history` (working / episodic memory)
- D2.5: server_status 拡張 4 view
- D3: `state_at(t)` time-travel
- D5: HW-accelerated view
- D6: replay / WAL

### 1.3 ADR-008 §4 D2 acceptance との対応

ADR-008 §4 D2 表記「既存 `desktop_state` を全部 view 経由に置換、tool 結果が同一 (回帰なし)」は v1 で文字通り解釈したが、本書 v2 では:

- **focus path** → 本 D2 で view 経由化 (D2-B、bit-equal 回帰 0)
- **modal path** → D4 で view 経由化 (modal_state view)
- **attention path** → D4 で view 経由化 (attention_signal view)
- **at-point path** → 別 view 新設 phase (本 D2 では既存維持)

ADR-008 §4 / §8 の D2 行は本書 D2-G で「focus path 完了、modal / attention は D4 carry-over」表記に書き換える。**「全部」を D2 単独で文字通り達成する v1 の解釈は撤回**。

### 1.4 北極星整合 (v2 で再確認)

- **N1 (pivot 必ず保持)**: D1 と同じ方針 (view output には pivot を含めず、L4 envelope で別搬送、ADR-010 担当)
- **N2 (watermark で frontier 進行)**: D2-A の **revised tuning** で N3 を壊さずに idle wait を排除 (§4 §4.2)
- **N3 (partial-order)**: option B (`wc + ε` 単独) を撤回、batch drain + max-observed time release に再設計

---

## 2. Sub-batch 分解 (checklist)

実装担当者は完了したら `[ ]` → `[x]` に flip する。**Phase 境界 (D2-0 〜 D2-G) で必ず Opus phase-boundary review** (強制命令 3)。

### D2-0: production pipeline lifecycle (PR 5)

**目的**: `ensure_perception_pipeline()` / `shutdown_perception_pipeline()` の production API を新設、D2-B 以降の土台。

#### D2-0-1: 設計 (既存 L1_SLOT パターン踏襲、Codex v2 P2-7 + v3 P2-2 反映)

- [ ] `src/l3_bridge/mod.rs` に **`PERCEPTION_SLOT: OnceLock<Mutex<Option<Arc<PerceptionPipeline>>>>`** を新設 — 既存 `L1_SLOT: OnceLock<Mutex<Option<Arc<L1Inner>>>>` (`src/l1_capture/worker.rs:227`) と完全同型
  - `OnceLock<T>` 直置きでは shutdown 後の slot reset が不可 (Codex v2 P2-7)。既存 lib 全体で採用済の `OnceLock<Mutex<Option<Arc<T>>>>` パターンに合流
- [x] **`PerceptionWorker` / `FocusPump` 自体に retain-on-timeout 型 `shutdown_with_timeout(&self, ...)` を追加** (Codex v6 P1 反映、L1 `worker.rs:174-194` と完全同型):
  ```rust
  // crates/engine-perception/src/input.rs::PerceptionWorker
  pub struct PerceptionWorker {
      join: Mutex<Option<JoinHandle<()>>>,  // ← Mutex で wrap、timeout 失敗時 retain
      tx: Sender<Cmd>,
      processed_count: Arc<AtomicU64>,
  }
  impl PerceptionWorker {
      pub fn shutdown_with_timeout(&self, timeout: Duration) -> Result<(), &'static str> {
          let _ = self.tx.send(Cmd::Shutdown);
          let deadline = Instant::now() + timeout;
          let poll_interval = Duration::from_millis(10);
          loop {
              let finished = {
                  let mut g = self.join.lock().unwrap_or_else(|e| e.into_inner());
                  match g.as_ref() {
                      Some(h) if h.is_finished() => {
                          let h = g.take().expect("just observed Some");
                          let _ = h.join();
                          true
                      }
                      Some(_) => false,
                      None => true,
                  }
              };
              if finished { return Ok(()); }
              if Instant::now() >= deadline { return Err("perception worker join timed out"); }
              thread::sleep(poll_interval);
          }
      }
      // 既存 consume-form は互換維持
      pub fn shutdown(self, timeout: Duration) -> Result<(), &'static str> {
          self.shutdown_with_timeout(timeout)
      }
  }
  ```
  `FocusPump` も同パターン (`src/l3_bridge/focus_pump.rs::FocusPump::shutdown_with_timeout`)。
- [x] **`PerceptionPipeline` は `Mutex` 不要に簡素化** (Codex v6 P1 反映):
  ```rust
  pub struct PerceptionPipeline {
      pub view: CurrentFocusedElementView,
      pub handle: FocusInputHandle,
      worker: PerceptionWorker,  // ← 普通の field、内部に retain-Mutex
      pump: FocusPump,            // ← 同
  }
  impl PerceptionPipeline {
      pub fn shutdown_with_timeout(&self, timeout: Duration) -> Result<(), &'static str> {
          let half = timeout / 2;
          self.pump.shutdown_with_timeout(half)?;     // ← 失敗時 handle 内部 retain
          self.worker.shutdown_with_timeout(half)?;   // ← 同
          Ok(())
      }
  }
  ```
  v3.2 までの「pipeline 側で `Mutex<Option<PerceptionWorker>>` を持って take する」設計は **撤回** (Codex v6 P1 = take 後 consume で Err になると leg が永久に失われる degraded pipeline 問題)。retain は `PerceptionWorker` / `FocusPump` 自体に押し下げ、pipeline は薄い委譲のみ。実装は `src/l3_bridge/mod.rs::PerceptionPipeline::shutdown_with_timeout` を参照。
- [x] **`Arc<PerceptionPipeline>` の clone が他 caller に残っていても shutdown 可能** (Codex v3 P2-2): `&self` 経由で内部 thread を停止、`view` の read handle clone は無害に残せる
- [x] **timeout 失敗時の per-leg handle retain** (Codex v4 P2-12 + v6 P1): pump/worker 各々の `shutdown_with_timeout` が `Err` を返しても **JoinHandle は内部 `Mutex<Option<>>` に retain される** → 後続の `shutdown_with_timeout(longer)` で同一 thread の polling を resume 可能。「片肺 degraded pipeline」状態は発生しない。pipeline 単位 retain は `PERCEPTION_SLOT` の slot-clear-on-success-only protocol で同時達成 (D2-0-2 / Codex v4 P1-6)
- [ ] Drop は **行わない**: 明示 `shutdown_perception_pipeline_for_test()` で slot を None に戻す (既存 `shutdown_l1_for_test` と同パターン、`worker.rs:243` のコメント参照)。production process では process 終了で OS が回収する設計
- [ ] **依存**: 起動時に L1 ring (`ensure_l1()`) と UIA event hook (`ensure_uia()` 系) が初期化済であることを assert (既存 lazy init チェーン経由)

#### D2-0-2: API (Codex v4 P1-6 反映、実 L1 と完全同型 / slot-clear-on-success-only を北極星扱い)

- [ ] **`pub fn ensure_perception_pipeline() -> Arc<PerceptionPipeline>`** (root crate `src/l3_bridge/mod.rs`、`ensure_l1()` と同シグネチャ) — slot None なら spawn して `Arc<PerceptionPipeline>` を返す、既存値があればそれを clone
- [ ] **`pub(crate) fn shutdown_perception_pipeline_for_test(timeout: Duration) -> Result<(), &'static str>`** (実 `shutdown_l1_for_test` (`worker.rs:252`) と完全同シグネチャ):
  ```rust
  pub(crate) fn shutdown_perception_pipeline_for_test(timeout: Duration) -> Result<(), &'static str> {
      let cell = match PERCEPTION_SLOT.get() {
          Some(c) => c,
          None => return Ok(()),  // 一度も init されていない → no-op
      };
      // slot から Arc を borrow するが、まだ None にしない
      let inner_arc = {
          let guard = cell.lock().unwrap_or_else(|e| e.into_inner());
          match guard.as_ref() {
              Some(arc) => Arc::clone(arc),
              None => return Ok(()),
          }
      };
      match inner_arc.shutdown_with_timeout(timeout) {
          Ok(()) => {
              // 成功時のみ slot clear、ただし concurrent caller が既に re-init している
              // 可能性があるので Arc::ptr_eq で同一インスタンス確認 (worker.rs:269-284 と同型)
              let mut guard = cell.lock().unwrap_or_else(|e| e.into_inner());
              if guard.as_ref().map(|c| Arc::ptr_eq(c, &inner_arc)).unwrap_or(false) {
                  *guard = None;
              }
              Ok(())
          }
          Err(e) => {
              // ★ 北極星: 失敗時は slot を空にしない。元 Arc を保持し、次の
              // ensure_perception_pipeline() は同じ (まだ動いている可能性のある) 
              // インスタンスを返す。これで二重 worker spawn を防ぐ。
              // (Codex v4 P1-6 / worker.rs:287-292 と同型)
              Err(e)
          }
      }
  }
  ```
- [ ] **`#[napi]` binding は不要** (D2-B-1 の view 関数経由で間接 ensure)
- [ ] 既存 `spawn_perception_pipeline_for_test` は **そのまま残す** (test 専用、Drop 順序を即時検証する用途、layer-constraints §3.8 と整合)
- [ ] **slot-clear-on-success-only は北極星** (Codex v4 推奨): 後続 PR で誤って失敗時 slot clear を入れると二重 worker invariant が壊れる。本 D2-0 PR で contract test を pin、後続 PR が壊さないよう regression test として保持

#### D2-0-3: lifecycle 検証 (既存 L1_SLOT 5-cycle test と同水準)

- [ ] **shutdown ordering**: `pump.shutdown(2s)` → `worker.shutdown(2s)` → `pump` Drop → `worker` Drop (D1 plan §5.3 と整合)
**実装済 7 test** (`src/l3_bridge/mod.rs::production_pipeline_lifecycle_tests`、v3.3 で 5 → 7):

- [x] **`ensure_returns_same_arc_under_concurrent_calls`**: 並行 32 thread から `ensure_perception_pipeline()` を叩き、全 thread が同じ `Arc<PerceptionPipeline>` を取得 (既存 `ensure_l1_returns_same_instance` と同パターン、`worker.rs:337`)
- [x] **`double_shutdown_is_idempotent`**: `shutdown_perception_pipeline_for_test(...)` を 2 回呼んで panic しない、2 回目は `Ok(())` (slot None なので no-op)
- [x] **`five_cycle_ensure_shutdown`**: `ensure → shutdown(Ok) → ensure → shutdown(Ok) → ...` × 5 で再 init が成立、各 cycle が Arc clone 残存に block されない (Arc identity は test 5 で別途 pin)
- [x] **`arc_clone_outliving_shutdown_is_safe`** (Codex v3 P2-2 反映): `let p = ensure_perception_pipeline(); let hold = p.clone(); shutdown_perception_pipeline_for_test(2s).unwrap()` で内部 thread が停止、`hold.view.is_empty()/len()/get()` 等は post-shutdown でも panic しない (read-only snapshot は thread 不要)
- [x] **`slot_clears_after_clean_shutdown`** (Codex v4 P1-6 partial coverage): clean shutdown 後 slot が None、ensure で repopulate を slot 内部状態に直接 assert (heap reuse race 回避)
- [x] **`shutdown_timeout_failure_retains_slot`** (v3.3 新規、Codex v6 P1 北極星 regression): `Duration::from_nanos(1)` で timeout 強制 → `Err` → slot に元 Arc retain → `Arc::ptr_eq` で同一性確認 → 長 timeout retry で `Ok` (二重 worker spawn 防止)
- [x] **`pipeline_recovers_from_partial_shutdown`** (v3.3 新規、Codex v6 P1 partial-shutdown recovery): 1ns timeout 失敗 → slot retain → 長 timeout retry で完了 (両 leg JoinHandle retain で resume polling) → slot clear → ensure で fresh pipeline。「片肺 degraded pipeline」が永久に発生しないことを pin

**v3.3 で本実装した 2 timeout-failure test** (Codex v6 P1 refactor で fixture 不要化、`Duration::from_nanos(1)` で deadline 強制超過):

- [x] **`shutdown_timeout_failure_retains_slot`** (Codex v4 P1-6 + v6 P1 北極星 regression): 1ns timeout → `Err` → slot に元 Arc retain → ensure で同一 Arc → 長 timeout retry で `Ok`
- [x] **`pipeline_recovers_from_partial_shutdown`** (Codex v6 P1 partial-shutdown recovery): 1ns timeout 失敗 → 長 timeout retry で完了 (両 leg JoinHandle retain で resume polling)、slot clear、ensure で fresh pipeline

詳細は §10 OQ #14 (Resolved)。

- [x] cargo test --workspace 全 pass、既存 test 0 regression — **55 (root) + 24 (engine-perception) = 79 全 pass** (production_pipeline_lifecycle_tests 全 7 件 pass)、vitest 2435 pass / 28 skipped (D1-5 baseline と一致)

#### D2-0-4: 検証

- [x] **Opus phase-boundary review** (2026-04-30 完了): subagent (`general-purpose` + `opus`) で 4 者一致 (概念設計 / plan §2 D2-0 / 実装 / test) を確認、結論「P1 = 0 件、phase 境界閉じている、D2-A 着手 OK」。P2 改善余地 3 件:
  1. ✅ doc comment 修正 (`mod.rs` "we re-insert" → "we never removed it from the slot")
  2. ✅ D2-A 内 D2-A-0 として OQ #14 fixture 整備を明示 (本書 §2 D2-A-0)
  3. (info) `shutdown_with_timeout` の half-half 配分は L1 同型維持で OK、不変

### D2-A: worker_loop tuning (revised) + true p99 bench (PR 6)

**目的**: D1 followups §2.5 の core 課題を **partial-order を壊さない設計** で解決、`update p99 < 1ms` SLO 達成、D1 acceptance honest 化。

#### D2-A-0: ~~OQ #14 test-only fixture 整備~~ → **解消 (v3.3 で本実装、PR #94)**

v3.2 で carry-over していた「timeout 失敗時 handle retain test」「partial-shutdown recovery test」の 2 件は、v3.3 の `PerceptionWorker` / `FocusPump` retain-on-timeout refactor (Codex v6 P1) で **fixture 不要に解消**。`Duration::from_nanos(1)` で deadline を強制超過させるだけで Err 経路を triggered できるようになった。本 D2-A では D2-A-1 から直接着手して OK。

(v3.2 までの D2-A-0 は historical artifact、§10 OQ #14 は Resolved)

#### D2-A-1: revised tuning 実装 (`crates/engine-perception/src/input.rs::worker_loop`)

詳細 §4.2 参照。要点:

- [ ] **batch drain**: `cmd_rx.recv_timeout(idle_recv_timeout)` で初回 1 件取得後、`try_recv` で連続吸い出し (上限 `MAX_BATCH_SIZE=64`)
- [ ] batch 内全 cmd の `update_at` を完了後、**`max_observed_time = batch.iter().map(|c| (c.wc, c.sub_ord)).max()`** を計算
- [ ] frontier を **`(max_observed_time.0, max_observed_time.1 + 1)`** (sub_ordinal++、physical wc 不変) に push
  - 同 wc + 大 sub_ordinal の後続 event は前進 frontier の範囲内で受け入れ可能 (N3 維持、§4.3 invariant)
  - 同 wc + 同 sub_ordinal の event は L1 invariant 上発生しない (layer-constraints §2.3 invariant 2)
  - 小 wc / 小 sub_ordinal は drop 妥当 (back-dated、既存 watermark shift ロジックに合流)
- [ ] **`step_until_idle`**: cmd 分岐内で `worker.step()` を `MAX_STEPS_PER_CMD=32` 回または `made_progress=false` まで回す (operator chain 全段消化、followups §2.5.1 (B) 対応)
- [ ] **idle 分岐**: 既存の idle frontier advance (D1-3 PR #91 P2 fix、real elapsed projection) は **そのまま維持**。cmd 分岐で frontier を `max_observed + 1 sub_ord` まで進めた後の idle 分岐は noop or forward の判定 (monotone 維持)
- [ ] **環境変数**:
  - `DESKTOP_TOUCH_IDLE_RECV_TIMEOUT_MS` (default 1)
  - `DESKTOP_TOUCH_MAX_BATCH_SIZE` (default 64)
  - `DESKTOP_TOUCH_MAX_STEPS_PER_CMD` (default 32)
  - 既存 `DESKTOP_TOUCH_WATERMARK_SHIFT_MS` (default 100) は idle frontier advance 用に維持

#### D2-A-2: partial-order 検証

- [ ] **新規 unit test `same_wallclock_different_sub_ordinal_all_observed`**: `(W, 0)` `(W, 1)` `(W, 2)` を順次 push、view が全 event を順番に reflect する (frontier `(W, 1)`/`(W, 2)`/`(W, 3)` で push 後 advance)
- [ ] **新規 unit test `out_of_order_same_wallclock_settles_correctly`**: `(W, 1)` `(W, 0)` 順 push でも last-by-(wc, sub_ord) で `(W, 1)` が勝つ
- [ ] **新規 unit test `cmd_branch_does_not_back_advance_frontier`**: `(W2, 0)` push 後に `(W1, 0)` push (W1 < W2) → 後者は drop + warning
- [ ] **新規 unit test `idle_advance_after_cmd_push_is_noop_or_forward`**: cmd 分岐で frontier が進んだ直後の idle 分岐 advance は `last_advanced` を超えない場合 noop

#### D2-A-3: 真の p99 計測 (followups §2.1)

- [ ] `crates/engine-perception/benches/d1_view_latency.rs` を `b.iter_custom` パターンに変更し、各 sample の `Duration` を `Vec<Duration>` に蓄積、bench 終了時に sort して **p50/p95/p99/p99.9** を `target/criterion/.../d2_summary.json` に書き出し
- [ ] `view_get_hit` / `view_get_miss` / `view_update_latency` 全て対応
- [ ] criterion mean ± CI report は維持 (plot 等)

#### D2-A-4: 検証

- [ ] **`view_update_latency` p99 < 1ms** (D1 SLO 達成、未達なら option C `parking_lot::Condvar` 検討を Opus 委譲)
- [ ] **`view_get_hit` p99 ~145ns 維持** (regression 0)
- [ ] **partial-order test 全 pass** (D2-A-2 の 4 test)
- [ ] cargo test --workspace 全 pass、`npm run test:capture` 0 regression
- [ ] **Opus phase-boundary review**: 「revised tuning が N3 を壊していないか + SLO 達成」を確認、指摘ゼロまで反復

### D2-B: `desktop_state` focus-only path 置換 + MCP transport bench (PR 7)

**目的**: focus 取得を view 経由化、bit-equal 回帰 0 を pin、production gap 込み bench で D1 acceptance を honest に閉じる。

#### D2-B-1: napi 経由 view export (Codex v2 P1-3 反映: controlType 文字列変換)

- [ ] `src/l3_bridge/mod.rs` に **`#[napi] pub fn view_get_focused() -> Option<FocusedElementJs>`** 追加 (引数なし、後述 D2-B-2 で `latest_focus_view` を読む)
  - 内部で `ensure_perception_pipeline()` → `pipeline.latest_focus_view.snapshot()` (§5.bis)
- [ ] **戻り値 shape (bit-equal 制約)**: `{ name: string, automationId: string | null, controlType: string, windowTitle: string }`
  - **`controlType` は string** (現行 `desktop_state.ts:184` が `type: focused.controlType` で文字列を出している、`focused.controlType !== "Pane"` で文字列比較もしている)
  - D1 view `UiElementRef.control_type: u32` (raw `UIA_CONTROLTYPE_ID`) を **napi binding 内で UIA control type id → 文字列名にマップ** (例: `50000 → "Button"`, `50033 → "Pane"`, `50029 → "Edit"` 等)
  - 変換 table は **既存 UIA bridge の同等経路 (UIA `Element::control_type_name()` 相当)** を新設するか、既存があるかを D2-B 着手時に grep で確認 (§10 OQ #11)
  - bit-equal を pin する contract test を追加 (D2-B-5)
- [ ] **first call で worker 起動 (lazy init)**: 既存 UIA worker / L1 ring の lazy init チェーンに合流
- [ ] view が miss (latest_focus 未 capture) の場合は `None` 返却 (panic 禁止、layer-constraints §2.3 invariant 6)
- [ ] **`#[napi] pub fn view_focused_pipeline_status() -> { initialized: bool, processed_count: number }`** で diagnostics 公開 (server_status と同パターン)

#### D2-B-2: `latest_focus_view` 経由化 (Codex v2 P1-4 反映: hwnd lookup miss 解消)

D1 `current_focused_element` view は `hwnd` を key にした per-hwnd state (focused element の hwnd で keying)。これは **foreground window hwnd と一致しない**ケースがある:
- `focus_pump.rs:221` の `hwnd: after.hwnd` は UIA event payload の `UiElementRef.hwnd` = focused element の所属 window
- 場合によって child / control hwnd / unresolved 0 が入る (P5c-1 plan §4 P5c-0b で議論済)
- `view_get_focused(activeHwnd)` で activeHwnd ≠ focus.hwnd だと miss して UIA fallback、置換率と bench が不安定 (Codex v2 P1-4)

**解決**: `current_focused_element` (per-hwnd state) は維持しつつ、**`latest_focus` 1-row global view を新設** (§5.bis)。
- input は `current_focused_element` と同じ `FocusEvent` collection
- output: `Option<UiElementRef>` (logical_time global max の event 1 件、最新 focus)
- `desktop_state.ts` の focus 取得は **`view_get_focused()`** (引数なし、global latest) を first try
- 既存 `current_focused_element` (per-hwnd) は `predicted_post_state` の subgraph や、将来 D4 で modal 連携時に活用

- [ ] focus 取得経路 (`uiaGetFocusedAndPoint` 前) で **first try `view_get_focused()`** → hit したら view 値を採用、miss なら従来 UIA 直叩きに fallback
- [ ] **`hints.focusedElementSource` の sentinel 拡張**: 既存 `"uia" | "cdp"` (`desktop_state.ts:188 / 214 / 231`) に `"view"` を追加 — 新フィールド追加ではない、互換維持
- [ ] 既存 `at-point` / `cursor-over` / `window-list` / `modal heuristic` / `attention` 取得経路は **不変**
- [ ] **既存 contract test** (`test/contract/desktop-state.test.ts` 等) で戻り値 shape が bit-equal を保つこと、`controlType` 文字列の数値型化が起きないこと
- [ ] description 更新 (Tier 化 description ガイドラインに従う、必要なら): "focused element may come from L3 view (faster) or UIA direct (fallback); hints.focusedElementSource reports which path"

#### D2-B-3: production gap bench (followups §2.2)

- [ ] `benches/d1_ts_baseline.mjs` に **`--with-point-query`** mode 追加: `uiaGetFocusedAndPoint(0, 0)` で計測
- [ ] D2-B 着手時に両 mode (`uiaGetFocusedElement` 単独 / `uiaGetFocusedAndPoint` 統合) で baseline 取得、view 経由置換後の比較は `with-point` baseline で実施

#### D2-B-4: MCP transport 込み bench (followups §2.3, §2.4)

- [ ] `benches/d2_desktop_state_roundtrip.mjs` 新規 (Node、`benches/README.md` §2.4 に手順追記)
- [ ] **MCP tool round-trip**: `desktop_state` を JSON-RPC で 1000 回呼ぶ、p50/p95/p99 を計測
- [ ] **「real L1 input ベース」 acceptance**: focus 変化を別 thread で induce する手段 (例: `keybd_event` で Tab、`workspace_launch` で window 切替) で UIA event を発生させ、L1 ring → focus_pump → view → MCP tool 戻りまでの latency p99 を計測
- [ ] cdylib 制約 (Cargo bench から L1 ring 直 push 不可) は **Node bench から MCP tool 経由** で迂回 (followups §2.3 注の方針)
- [ ] flaky 対策: warmup 100 + measure 1000、外れ値除外せず p99 で評価、必要なら 3 回中央値を採用 (R8)

#### D2-B-5: 検証

- [ ] **bit-equal 回帰 0**: `desktop_state` 戻り値が view 経由 / UIA 直叩きで shape 一致 (既存 contract test 全 pass)
- [ ] **`hints.focusedElementSource = "view"` が production で観測される**: focus_pump が動いている状態で test
- [ ] D2-B-4 bench で MCP transport 込み p99 を `benches/README.md` §2.4 に landed
- [ ] **Opus phase-boundary review**: 「focus-only replacement で核を押さえた」「modal/attention は D4 carry-over として明記」を確認

### D2-C0: L1 emitter readiness gate (PR 8、go/no-go decision)

**目的**: D2-C/D の前提となる L1 emit site の実装状況を確認、go/no-go を判定。`docs/adr-008-d2-plan.md` v1 で OQ #1, #3 にしていた疑問を本 phase で具体的に解消。

#### D2-C0-1: emit site 確認

- [ ] **`EventKind::DirtyRect` (=0)**:
  - payload: `src/l1_capture/payload.rs:48` に `DirtyRectPayload` 定義済 (P5c-2 で emit 予定)
  - **emit site の存在を確認**: `src/duplication/` で `ring.push(EventKind::DirtyRect ...)` を grep
  - 未実装なら → ADR-007 P5c-2 を **本 D2 の prerequisite として外出し**、本 D2 では `dirty_rects_aggregate` を deferred
- [ ] **`EventKind::WindowChanged` (=5)**:
  - payload: `src/l1_capture/payload.rs:68` に定義済 (P5c-3 で emit 予定)
  - emit site の grep
  - 未実装なら → ADR-007 P5c-3 を prerequisite、本 D2 では `WindowChanged` variant を SemanticEvent から除外
- [ ] **`EventKind::ScrollChanged` (=6)**:
  - payload: `src/l1_capture/payload.rs:78` に定義済 (P5c-4 で emit 予定)
  - emit site の grep
  - 未実装なら → ADR-007 P5c-4 を prerequisite、本 D2 では `ScrollSettled` variant を SemanticEvent から除外

#### D2-C0-2: go/no-go matrix

| EventKind | 実装状況 | D2 での対応 |
|---|---|---|
| `UiaFocusChanged` | ✅ Production (P5c-1 完了 PR #88) | D2-D で `FocusMoved` variant 利用 |
| `DirtyRect` | (D2-C0-1 で確認) | 実装済なら D2-C 進行、未実装なら D2-C を deferred |
| `WindowChanged` | (D2-C0-1 で確認) | 実装済なら D2-D で `WindowChanged` variant 含む、未実装なら除外 |
| `ScrollChanged` | (D2-C0-1 で確認) | 実装済なら D2-D で `ScrollSettled` variant 含む、未実装なら除外 |

#### D2-C0-3: D2 scope 最終確定

- [ ] D2-C0-2 matrix 結果を本書 §1.1 F の `dirty_rects_aggregate` / `semantic_event_stream` の variant set に反映
- [ ] **最低限 acceptance**: `UiaFocusChanged` のみ実装済の場合でも、`semantic_event_stream` は `FocusMoved` variant 単独で declarative に成立可 (current_focused_element の delta から派生)
- [ ] `dirty_rects_aggregate` が deferred になる場合: ADR-008 §4 D2 の「主要 view 4」が 3 view (current_focused / semantic_event / predicted_post_state subgraph) に縮小、本書 §11 acceptance を更新

#### D2-C0-4: 検証 + Opus 判断

- [ ] D2-C0-1 grep 結果を本書 §10 OQ #1 #3 に書き戻し、go/no-go を Resolved 化
- [ ] **Opus phase-boundary review**: 「不足 emit site を ADR-007 で先行するか、D2 内で同時実装するか」を Opus 判断、決定を本書 §10 に記録

### D2-C: `dirty_rects_aggregate` view (PR 9、D2-C0 結果次第で deferred 可)

**目的**: views-catalog §3.2 の `dirty_rects_aggregate` を declarative に実装。

D2-C0 で **DXGI dirty rect emit が未実装** と判断された場合、本 PR は **ADR-007 P5c-2 完了後** に着手。

#### D2-C-1〜D2-C-4

(v1 と同等、変更なし。詳細 §5 参照)

- [ ] `src/l3_bridge/dirty_rect_pump.rs` 新設、focus_pump と同パターン
- [ ] `crates/engine-perception/src/views/dirty_rects_aggregate.rs` 新設、`map → reduce(concat rects + summary) → inspect`
- [ ] partial-order test (out-of-order frame_id)
- [ ] SLO `update p99 < 2ms` を bench で計測
- [ ] **Opus phase-boundary review**

### D2-D: `semantic_event_stream` view (PR 10)

**目的**: views-catalog §3.2 の `semantic_event_stream` を実装、D2-C0 結果に応じた variant set で。

#### D2-D-1: SemanticEvent enum 確定 (D2-C0 結果反映)

- [ ] D2-C0-2 で利用可能と判定された L1 event のみから派生する variant を closed enum で定義:
  - `FocusMoved` (always、`UiaFocusChanged` 単独で成立)
  - `ModalAppeared` (UIA dialog event の grep 結果次第、focus event + window class match で代替可能性検討)
  - `WindowChanged` (D2-C0-2 で go なら、no-go なら除外)
  - `ScrollSettled` (D2-C0-2 で go なら、no-go なら除外)

#### D2-D-2〜D2-D-4

(v1 と同等。pump 拡張は D2-C0-2 で go の event のみ対象)

- [ ] operator graph: 各 input collection を `flat_map → concat → inspect`
- [ ] internal read API: `recent_n` / `since`
- [ ] SLO `delta 配信遅延 p99 < 3ms`
- [ ] partial-order test (out-of-order UIA event)
- [ ] **Opus phase-boundary review**

### D2-E0: dataflow scope refactor (arranged + view を同 scope で build) (PR 11、Codex v2 P2-9 反映)

**目的**: D2-E (`predicted_post_state`) が同 dataflow scope 内で `current_focused_element` の arranged collection を import できるよう、build API を変更。

#### D2-E0-1: 現状 (D1) の構造 と timely lifetime 制約

- D1 view: `spawn_perception_worker()` の中で `worker.dataflow(|scope| { ... })` の closure 内で `current_focused_element` collection を build、`inspect → Arc<RwLock<HashMap>>` で外部 struct (`CurrentFocusedElementView`) に view handle だけ持ち出す
- timely `Arranged<G, K, V, R>` は **`G: Scope` の lifetime に lifetime 結びつき**、`worker.dataflow` closure を抜けると drop される
- → `Arranged<...>` を外部 struct (`CurrentFocusedElement { arranged, view }`) に保持して持ち出すことは **timely の lifetime model 上不可能** (Codex v2 P2-9)

#### D2-E0-2: refactor (同 scope 内で全 view を build)

正しい設計: **`build_*` 関数は `&mut G (=scope)` と input stream を受け取り、`(arranged, view_handle)` を返す**。`view_handle` は外部に持ち出せる軽量 read handle (Arc<RwLock<HashMap>>)、`arranged` は同 scope 内で他 dataflow に渡すために使う。

- [ ] `crates/engine-perception/src/views/current_focused_element.rs::build_current_focused_element` の signature を **`<G: Scope>(scope: &mut G, focus_stream: &Collection<G, FocusEvent, isize>) -> (Arranged<...>, CurrentFocusedElementView)`** に変更
- [ ] `spawn_perception_worker()` 内の `worker.dataflow` closure で:
  ```rust
  worker.dataflow(|scope| {
      let focus_stream = input.to_collection(scope);
      let (cfe_arranged, cfe_view) = build_current_focused_element(scope, &focus_stream);
      let latest_focus_view = build_latest_focus(scope, &focus_stream);  // §5.bis 追加
      // D2-E で predicted_post_state の subgraph も同 scope 内で組む:
      let (predicted_input, predicted_view) = build_predicted_post_state(scope, &cfe_arranged);
      // view handle を return、arranged は scope の lifetime で破棄
      (cfe_view, latest_focus_view, predicted_view, predicted_input)
  });
  ```
- [ ] **`Arranged` を外部 struct に格納する設計は採用しない** — Codex v2 P2-9 の lifetime 制約
- [ ] 既存の `CurrentFocusedElementView::get(hwnd)` 等 read API は不変
- [ ] 別 scope (別 worker) からの import は本 D2 では不要 (同 worker 内 1 scope で全 view を完結)

#### D2-E0-3: 検証

- [ ] 既存 D1 test (32 in-file + 11 integration) 全 pass、view consumer 側の API は不変
- [ ] `view_get_hit` p99 が D2-A baseline (~145ns) を維持 (regression 0)
- [ ] cargo doc / cargo check で `Arranged` の lifetime escape が静的に防がれていること (型システムで自然に block される)
- [ ] **Opus phase-boundary review**: 「scope refactor が D2-E のために十分か、Arranged を外に持ち出していないか」を確認

### D2-E: `predicted_post_state` subgraph 構造 (PR 12、D2-E0 と同 scope 配線)

**目的**: views-catalog §4.1 の dry-run subgraph 構造を実装、計算は D5 で本格化、本 D2 では shape 確定 + dummy implementation。

#### D2-E-1: 同 scope 配線 (Codex v2 P2-9 反映)

- [ ] `build_predicted_post_state(scope: &mut G, current_focused_arranged: &Arranged<...>) -> (PredictionInputHandle, PredictedPostStateView)` を新設
- [ ] **D2-E0 の `worker.dataflow` closure 内で `current_focused_arranged` を直接渡す** — `import` を別 scope から行う構造ではなく、**同 scope 内で arranged を borrow して subgraph を組む**
- [ ] 投機 input は別 channel (`PredictionInputHandle`)、push されたら subgraph 内で本番 arranged と join
- [ ] 投機 input drop 後に本番 arrangement の state は変化しない (read-only borrow、layer-constraints §4.3 invariant 5)

#### D2-E-2: dummy implementation

- [ ] D2 では `predict_for_click(spec, current_state)` を identity dummy (current state そのまま、`confidence: ConfidenceLevel::Low`, `computation_ms: 0`)
- [ ] D5 で NPU/CUDA 経由の本格化、本 D2 では subgraph 経路と shape のみ pin

#### D2-E-3: output 契約

- [ ] views-catalog §4.1 と完全一致 (v2 §7 と同じ struct)

#### D2-E-4: 検証

- [ ] cargo unit test: subgraph 内で投機 input を push → output が dummy 通りに出る
- [ ] **本番 arrangement 不変 assertion**: speculation 後 `cfe_view.get(hwnd)` / `latest_focus_view.snapshot()` が不変
- [ ] SLO `dry-run p99 < 50ms` (dummy では < 1ms)
- [ ] **Opus phase-boundary review**: 「subgraph shape が D5 本格化を阻害しない、Arranged lifetime を violate していない」を確認

### D2-F: D1-3 残 follow-up 5 項目 (PR 13)

(v1 と同等。詳細は v1 §2 D2-F を参照)

- [ ] §3.1 transient stale read 強化 — `BTreeMap<(LogicalTime, UiElementRef), i64>` 拡張
- [ ] §3.2 tie-breaker `>` vs `>=` test pin
- [ ] §3.3 starvation reader/writer bench、必要なら `parking_lot::RwLock` / `arc-swap` 導入
- [ ] §3.4 reduce 経由 hwnd 死活遷移 test
- [ ] §3.6 shutdown drain 検証
- [ ] §3.5 L4 envelope pivot 搬送 — **deferred to ADR-010**、§10 OQ #5
- [ ] **Opus phase-boundary review**

### D2-G: ドキュメント整合 + メモリ更新 (PR 14)

- [ ] `docs/views-catalog.md` §3.2 を実装した view ごとに `Implemented + Benched` flip + 実測値追記
- [ ] **ADR-008 §8 D2 行を「focus path 完了、modal / attention は D4 carry-over」明記**で更新
- [ ] 本 plan §11 Acceptance を全 [x] flip
- [ ] `docs/adr-008-d1-followups.md` の対応項目を Resolved 化 (§3.5 のみ carry-over)
- [ ] memory `project_adr008_d2_done.md` 新規 + `MEMORY.md` index 更新

---

## 3. PR 切り方 (v3、10 PR、Codex v2 おすすめ順序反映)

着手順序 = PR-α → PR-β → PR-γ proof → PR-δ gate → ... の Codex 推奨パス。

| PR | 範囲 | risk | size 想定 |
|---|---|---|---|
| **PR-α (D2-0)** | production pipeline lifecycle (既存 `L1_SLOT` パターン踏襲) | 中 (lazy init / shutdown ordering / 5-cycle test) | ~200-300 line |
| **PR-β (D2-A)** | worker tuning revised (batch drain + max-time release + event_count guard) + true p99 bench | 中 (batch drain semantics、N3 維持確認) | ~250-350 line |
| **PR-γ (D2-B)** | desktop_state focus-only replacement (latest_focus view + controlType 文字列変換) + MCP transport bench | 中-大 (napi binding + tool 改修 + bench、bit-equal 回帰 0) | ~500-600 line |
| **PR-δ (D2-C0)** | L1 emitter readiness gate (research-only PR、go/no-go 判断) | 低 (調査 + 判断記録) | ~100 line (docs only) |
| **PR-ε (D2-C)** | dirty_rects_aggregate (D2-C0 go の場合) | 中 | ~300-400 line |
| **PR-ζ (D2-D)** | semantic_event_stream (variant set は D2-C0 結果反映) | 中 | ~400-500 line |
| **PR-η (D2-E0)** | dataflow scope refactor (build_* signature 変更、`Arranged` を外部に持ち出さない設計) | 中 (D1 build 関数 shape 変更、view 内部のみ、外部 API 不変) | ~200-300 line |
| **PR-θ (D2-E)** | predicted_post_state subgraph (D2-E0 と同 scope 配線) | 中 (timely subgraph 経験少) | ~200-300 line |
| **PR-ι (D2-F)** | D1-3 残 follow-up | 低-中 | ~300-400 line |
| **PR-κ (D2-G)** | docs / memory 最終整合 | 低 | ~150 line |

直列 merge、各 phase 完了で Opus phase-boundary review (強制命令 3)。

---

## 4. worker_loop tuning revised (option B 撤回、batch drain + max-time release)

### 4.1 v1 option B の問題 (Codex P1-2 反映)

v1 の `advance_to((wc + frontier_push_epsilon_ms, 0))` 案は:
- 同 wc + 異 sub_ordinal の **後着 event** が back-dated 化される (例: `(W, 0)` push → frontier `(W+1, 0)` → 直後に `(W, 1)` が来ると drop)
- `ε < production event interval` の仮定が UIA 実測に依存、複数 producer (UIA + DXGI + tool) が同 wc を共有するケースで脆弱
- N3 (partial-order) を実質的に犠牲にする設計

**撤回**。

### 4.2 revised: batch drain + max-observed time release

```rust
// crates/engine-perception/src/input.rs::worker_loop (擬似コード v2)
loop {
    let mut batch: Vec<Cmd> = Vec::with_capacity(MAX_BATCH_SIZE);

    // ① 1 件目を timeout 付き wait (cmd 即起床、idle CPU 浪費しない)
    match cmd_rx.recv_timeout(idle_recv_timeout) {
        Ok(cmd) => batch.push(cmd),
        Err(RecvTimeoutError::Timeout) => {
            // idle 分岐: 既存の idle frontier advance を維持 (real elapsed projection)
            run_idle_frontier_advance(&last_event_anchor, &mut last_advanced, &input);
            worker.step();
            continue;
        }
        Err(RecvTimeoutError::Disconnected) => break,
    }

    // ② 残りを non-blocking で drain (batch 化)
    while batch.len() < MAX_BATCH_SIZE {
        match cmd_rx.try_recv() {
            Ok(cmd) => batch.push(cmd),
            Err(_) => break,
        }
    }

    // ③ batch 内全 cmd の update_at を完了 (event_count を別計数)
    let mut max_observed = (0u64, 0u32);
    let mut event_count: u64 = 0;
    let mut shutdown_requested = false;
    for cmd in &batch {
        match cmd {
            Cmd::PushFocus(ev) => {
                let event_time = (ev.wallclock_ms, ev.sub_ordinal);
                input.update_at(ev.clone(), Pair::new(event_time.0, event_time.1), 1);
                if event_time > max_observed { max_observed = event_time; }
                event_count += 1;
            }
            Cmd::Shutdown => { shutdown_requested = true; }
        }
    }

    // ④ event があった時のみ advance/flush/processed_count 更新
    //    (Codex v2 P2-8 反映: shutdown-only batch で frontier/processed_count を歪めない)
    if event_count > 0 {
        // batch 内 max logical time の「次の sub_ordinal」まで frontier 進行
        //   physical wc は max_observed と同じ、sub_ordinal は +1
        //   → 同 wc + 大 sub_ordinal の後着 event は frontier 内で受け入れ可能
        //   → 同 wc + 同 sub_ordinal は L1 invariant 上発生しない
        //   → 小 wc / 小 sub_ordinal は drop 妥当
        let advance_target = Pair::new(max_observed.0, max_observed.1.saturating_add(1));
        if last_advanced.less_than(&advance_target) {
            input.advance_to(advance_target.clone());
            last_advanced = advance_target;
        }
        input.flush();
        last_event_anchor = (max_observed.0, Instant::now());

        // ⑤ DD operator chain 全段消化 (followups §2.5.1 (B) 対応)
        let mut steps = 0;
        while steps < MAX_STEPS_PER_CMD {
            if !worker.step() { break; }
            steps += 1;
        }

        processed_count.fetch_add(event_count, Ordering::Relaxed);
    }

    if shutdown_requested { break; }
}
```

### 4.3 invariant (revised)

| # | invariant | 検証 |
|---|---|---|
| 1 | `last_advanced` は monotone (`Pair` の lex-total `<=`) | `cmd_branch_does_not_back_advance_frontier` |
| 2 | 同 wc + 大 sub_ordinal の後着 event は frontier 内で受け入れ可能 | `same_wallclock_different_sub_ordinal_all_observed` |
| 3 | 同 wc + 同 sub_ordinal の event は L1 invariant 上発生しない | layer-constraints §2.3 invariant 2 |
| 4 | 小 wc / 小 sub_ordinal は drop + warning 計数 | 既存 watermark shift 検証ロジックに合流 |
| 5 | idle 分岐 frontier advance と cmd 分岐 frontier-push が monotone 衝突しない | `idle_advance_after_cmd_push_is_noop_or_forward` |
| 6 | batch 内 cmd 順序が partial-order を壊さない (batch = atomic update) | `out_of_order_same_wallclock_settles_correctly` |
| 7 | shutdown-only batch (event_count = 0) では advance/flush/processed_count 更新スキップ | `shutdown_only_batch_does_not_advance_frontier` (新規 unit test、Codex v2 P2-8 反映) |

### 4.4 期待 latency 内訳

- ① `recv_timeout` 1ms: cmd 到着で **即起床** (空回り 0)
- ② `try_recv` drain: ns オーダ (channel 空までの数 iteration)
- ③ `update_at` × batch: batch 1 件で ns オーダ、平均 batch sz は production focus event 頻度 (~10ms 間隔) に対し 1 件
- ④ `advance_to` + `flush`: ns オーダ
- ⑤ `worker.step` × N: DD operator chain、reduce + inspect で µs オーダ
- 合計: **batch 平均 1 件 + idle wait 即起床 → push to view materialize で sub-millisecond** (cmd 到着即起床 + frontier 即進行 + step until idle)

未達の場合の retreat: option C (`parking_lot::Condvar` + 短 timer による idle-advance 周期化)。Opus 委譲。

### 4.5 環境変数

| ENV | 効果 | default |
|---|---|---|
| `DESKTOP_TOUCH_IDLE_RECV_TIMEOUT_MS` | idle 分岐 `recv_timeout` 値 | 1 |
| `DESKTOP_TOUCH_MAX_BATCH_SIZE` | batch drain 上限 | 64 |
| `DESKTOP_TOUCH_MAX_STEPS_PER_CMD` | step 回数 cap | 32 |
| `DESKTOP_TOUCH_WATERMARK_SHIFT_MS` (既存) | idle frontier advance shift | 100 |

---

## 5. `dirty_rects_aggregate` view 仕様 (D2-C0 go の場合のみ)

(v1 §5 と同等、変更なし)

- input: `DirtyRectEvent { source_event_id, frame_id, hwnd, rect, wallclock_ms, sub_ordinal, timestamp_source }`
- output: `DirtyRectsAggregate { frame_id, rects: Vec<Rect>, summary: { count, total_area } }`
- operator: `map → reduce(concat + summary) → inspect`
- SLO: `update p99 < 2ms`, memory < 5MB (100ms 窓)

---

## 5.bis. `latest_focus` view 仕様 (D2-B-2 で新設、Codex v2 P1-4 反映)

### 5.bis.1 動機

D1 `current_focused_element` は per-hwnd state (focused element の hwnd で keying)。`desktop_state.ts` の focus 取得は **「現在 OS が認識している唯一の focus」** = global latest を求める。activeHwnd lookup では:
- `view_get_focused(activeHwnd)` の activeHwnd は foreground window hwnd
- D1 view の key は focused element の所属 hwnd (child / control 等)
- 両者が一致しないケースで miss → UIA fallback、置換率と bench が不安定

→ **global latest 1 row を直接保持する別 view を新設**。

### 5.bis.2 input / output

- input: `current_focused_element` と同じ `FocusEvent` collection (root crate `FocusInputHandle` から push される event を共有)
- output 概念上: 「logical_time global max の event 1 件」(positive count かつ ts 最大)
- internal read API: `LatestFocusView::{snapshot() -> Option<UiElementRef>, len() -> usize}`

### 5.bis.3 operator graph (Codex v4 P2-13 反映、`(LogicalTime, UiElementRef)` を flow に保持)

```
FocusEvent collection (with LogicalTime = (wallclock_ms, sub_ordinal))
    │
    │ map: FocusEvent → ((), (LogicalTime, UiElementRef))
    │       (singleton key、value に LogicalTime を含めて時刻を保持)
    │
    ▼
arrange_by_key + reduce(output: (LogicalTime, UiElementRef))
    │       reduce 内で last-by-(wallclock_ms, sub_ordinal) を選択
    │       output value は (ts, ui_ref) tuple として保持
    │
    ▼
collection<((), (LogicalTime, UiElementRef))>  (1 row global max、ts 込み)
    │
    │ map: ((), (ts, ui_ref)) → (ts, ui_ref)
    │
    ▼
inspect: |((ts, ui_ref), time, diff)| view.apply_diff(ts, ui_ref, diff)
    │       (assertion / retraction を diff-sum bookkeeping、ts は data に乗っている)
    │
    ▼
Arc<RwLock<BTreeMap<(Pair<u64, u32>, UiElementRef), i64>>>
```

- **重要**: reduce output の value 型を `(LogicalTime, UiElementRef)` にすることで、inspect callback の `data` フィールドから `(ts, ui_ref)` を **直接** 取り出せる (Codex v4 P2-13)。`collection<UiElementRef>` だと inspect 側で時刻情報をどこから取るかが曖昧になる
- `current_focused_element` は per-hwnd key、`latest_focus` は **singleton key (`()`)** で reduce するので 1 row。両 view は同じ input stream を共有 (D2-E0 の同 scope 内 build で input collection を borrow)
- `current_focused_element` を D2-F-1 (§3.1) で同 pattern に拡張するときも、reduce output の value 型を `(LogicalTime, UiElementRef)` に揃える

### 5.bis.4 inspect 順序対策 (Codex v3 P1-1 反映、D1 view と同 pattern)

DD reduce 出力の inspect は **assertion / retraction の任意順序** で発火する (D1 `current_focused_element` の D1-3 review §2 で既知)。`Option<UiElementRef>` を直接 set/clear すると:
- assertion 後に old retraction が来て `None` 化
- 古い値への戻り
が起きる。

**解決**: D1 `current_focused_element` の per-hwnd diff bookkeeping パターンを singleton key で踏襲。
- materialized state: **`BTreeMap<(LogicalTime, UiElementRef), i64>`** (key に LogicalTime を含めて時刻も保持、Codex v3 P1-1 注の collection<UiElementRef> では時刻が落ちる問題対応)
- `apply_diff(ts, element, diff)`: entry の i64 を加算、0 なら remove
- `snapshot()`: `.iter().rev().find(|(_, c)| **c > 0)` で「count > 0 の最大 LogicalTime entry」の `UiElementRef` を返す
- これにより assertion / retraction が任意順で来ても、**convergent state** に settle する (D1 view §3.1 follow-up と同パターン)
- D1 D2-F-1 (§3.1 transient stale read 強化) で `current_focused_element` を `BTreeMap<(LogicalTime, UiElementRef), i64>` に拡張する作業と **同時に共通 helper を抽出** することを推奨 (PR-ι D2-F で D1 view 強化、PR-γ D2-B で latest_focus 新規実装、共通 helper を crates/engine-perception/src/views/diff_bookkeeping.rs 等に切り出す案を §10 OQ #13 で記録)

### 5.bis.5 SLO

- `lookup` p99 < 1ms (D1 と同等水準、`BTreeMap` reverse walk で最初の positive count を見つける ~O(retraction 数)、production では ~O(1))
- `update` p99 < 1ms (D2-A revised tuning と同水準)
- メモリ: 直近 retraction 群 + 最新 1 entry、production frontier 進行下では < 5KB (1 row + 数 retraction)

### 5.bis.6 invariant

- D1 `current_focused_element` (per-hwnd) と **同じ event source / 同じ logical_time** で更新される (input stream を共有するため)
- view 間の atomic 取得は views-catalog §5.1 の同 logical_time read で成立
- assertion / retraction 任意順序耐性 = `BTreeMap<(LogicalTime, UiElementRef), i64>` の diff-sum + `count > 0 を rev walk` で達成 (Codex v3 P1-1)

---

## 6. `semantic_event_stream` view 仕様 (variant set は D2-C0 結果次第)

### 6.1 SemanticEvent enum (D2-C0-2 結果反映)

```rust
pub enum SemanticEvent {
    FocusMoved {  // always
        ts: Pair<u64, u32>,
        from_hwnd: Option<u64>,
        to_hwnd: u64,
        from_name: Option<String>,
        to_name: String,
    },
    // 以下 variant は D2-C0-2 で go の場合のみ含む:
    ModalAppeared { ts, dialog_hwnd, dialog_name, blocking_for_hwnd },  // UIA dialog event 経路次第
    WindowChanged { ts, hwnd, kind },                                    // EventKind::WindowChanged
    ScrollSettled { ts, hwnd, scroll_offset, settled_for_ms },           // EventKind::ScrollChanged
}
```

- D2-C0-2 で no-go の variant は本 D2 では未定義、後続 phase で追加 (closed enum 拡張は版番号 bump、test で variant 一覧を pin)

### 6.2 〜 6.4

(v1 §6 と同等)

- operator: 各 input flat_map → concat → inspect
- internal read API: `recent_n` / `since` / `len`
- SLO: `delta 配信遅延 p99 < 3ms`, memory < 100KB (LRU 100)

---

## 7. `predicted_post_state` subgraph 構造 (D2-E0 同 scope 配線、Codex v3 P2-3 反映)

D2-E0 / D2-E と整合: **`Arranged` を外部 struct に保持せず、同 `worker.dataflow` closure 内で `cfe_arranged` を直接 borrow して subgraph に渡す**。`import(scope)` を別 scope から行う構造ではない。

- subgraph 配線: `build_predicted_post_state(scope: &mut G, cfe_arranged: &Arranged<G, ...>) -> (PredictionInputHandle, PredictedPostStateView)` を `worker.dataflow` closure 内で呼ぶ
  ```rust
  worker.dataflow(|scope| {
      let focus_stream = input.to_collection(scope);
      let (cfe_arranged, cfe_view) = build_current_focused_element(scope, &focus_stream);
      let latest_focus_view = build_latest_focus(scope, &focus_stream);
      let (pred_input, pred_view) = build_predicted_post_state(scope, &cfe_arranged);
      // arranged は scope 内で 1 回 borrow 済、closure を抜ければ drop される
      (cfe_view, latest_focus_view, pred_view, pred_input)
  });
  ```
- dummy implementation: identity (current state そのまま、`confidence: Low`、`computation_ms: 0`)
- output: views-catalog §4.1 完全一致
- invariant: subgraph は本番 arrangement に書き戻さない (read-only borrow、layer-constraints §4.3 invariant 5)、test で pin
- v1 / v2 の「`current_focused_element_arranged.import(scope)` で外部 scope から import」の記述は **撤回** (Codex v3 P2-3)

---

## 8. Bench Harness 強化詳細

### 8.1 真の p99 計測 (followups §2.1)

(v1 §8.1 と同等、`b.iter_custom` で sample 蓄積、`d2_summary.json` に書き出し)

### 8.2 production gap bench (followups §2.2)

`benches/d1_ts_baseline.mjs` に `--with-point-query` mode 追加 (`uiaGetFocusedAndPoint(0, 0)` baseline)。

### 8.3 MCP transport 込み bench (followups §2.3, §2.4)

`benches/d2_desktop_state_roundtrip.mjs` 新規。MCP server を spawn、stdio JSON-RPC で `desktop_state` を 1000 回 call。focus 変化 induce 手段:
- 別 thread で `keybd_event` (Tab) を一定間隔で送出
- または `workspace_launch` で window を 2 つ起動して `focus_window` 切替
- warmup 100 + measure 1000、外れ値除外せず p99 評価

### 8.4 acceptance gate (D2 全体)

| KPI | 目標 |
|---|---|
| `view_update_latency` p99 (D2-A 後) | < 1ms |
| `view_get_hit` p99 (D2-F 後) | ~145ns 維持 (D1 baseline) |
| `desktop_state` MCP round-trip p99 (D2-B 後) | < TS baseline `with-point` p99 / 5 (production gap が広いため、OQ #6 で再評価) |
| `dirty_rects_aggregate` update p99 (D2-C 後) | < 2ms |
| `semantic_event_stream` delta p99 (D2-D 後) | < 3ms |
| `predicted_post_state` dummy p99 (D2-E 後) | < 1ms |

---

## 9. Risks / Mitigation

| # | Risk | 影響 | Mitigation |
|---|---|---|---|
| R1 | revised tuning でも `update p99 < 1ms` 未達 | 中 | option C (`parking_lot::Condvar`) を Opus 委譲、本書 §10 OQ #2 |
| R2 | batch drain で `MAX_BATCH_SIZE` を超える burst が発生し worker が burst 後の event を 1 cycle 遅らせる | 低 | `MAX_BATCH_SIZE=64` は production の UIA event 頻度 (10ms 間隔) に対し十分、必要なら env で調整 |
| R3 | `desktop_state` view 経由で focus 値の shape が UIA 直叩きと microscopic にズレ (null 表現 / 数値型) | 高 | 既存 contract test で bit-equal pin、`hints.focusedElementSource = "view"` で production 観測、ズレ検知時は per-test record + Opus 判断 |
| R4 | D2-C0 で全 emit site (DirtyRect / WindowChanged / ScrollChanged) 未実装で D2 scope が大幅縮小 | 中 | scope 縮小自体は「妥協なし」原則と整合 (ADR-007 P5c-2/3/4 を先行)。D2 acceptance は「少なくとも `current_focused_element` view 化 + focus path replacement」で核を押さえた上で、追加 view を後続 PR phase に分散 |
| R5 | D2-E0 で arranged collection 公開が D1 view shape を壊し既存 test が落ちる | 中 | refactor を pure additive (既存 `view.get(hwnd)` API は不変) に保つ、D1 test 全 pass で gate |
| R6 | `predicted_post_state` subgraph が本番 arrangement に書き戻し | 高 | layer-constraints §4.3 invariant 5 を test で機械的に pin (`speculation drop 後 view.get(hwnd) 不変` assertion) |
| R7 | D2-F-1 (BTreeMap key 拡張) で `view_get_hit` regression | 中 | D2-A の bench harness で D2-F 着手前後で p99 比較、regression 時 Opus 直対応 |
| R8 | bench `d2_desktop_state_roundtrip.mjs` で UIA event induce が flaky | 中 | warmup 100 + measure 1000、外れ値除外せず p99、3 回中央値採用も検討 |
| R9 | D2-0 で `OnceLock` 経由 production lifecycle が Drop タイミングで shutdown ordering を壊す | 高 | 明示 `shutdown_perception_pipeline()` を提供、Drop は backup、test で 5-cycle (D1-2 と同水準) を D2-0-3 で pin |
| R10 | Opus phase-boundary review で各 phase が長期化、PR merge 滞留 | 中 | sub-batch を独立 PR にし review 単位を小さく保つ、Sonnet が trial & error 2 回で即 Opus 委譲 (強制命令 4) |
| R11 | UIA control type id → 文字列変換 table が既存実装と微妙にズレ、bit-equal 衝突 (Codex v2 P1-3) | 高 | D2-B-1 着手時に既存変換経路 (`uiaGetFocusedAndPoint` の内部) を grep で確認、同一 table を共有する形で実装、contract test で 1 件ずつ pin (典型 ~20 control type) |
| R12 | `latest_focus` と `current_focused_element` 併存で arrangement memory が 2 倍に (Codex v2 P1-4) | 中 | D2-A bench で memory profiling、過大なら singleton 化を考慮するが、両者は input stream を共有 (= raw event は 1 つ、arrangement diff のみ 2 系統) なので増分小と見込む。OQ #12 で再評価 |
| R13 | `Arranged` の lifetime escape を試みて compile error (Codex v2 P2-9) | 低 | timely 型システムが静的に block するので silent failure はあり得ない。compile-time に bounce、設計変更で対応 |
| R14 | `latest_focus` で reduce inspect の retraction/assertion 順序により Option set/clear が stale 化 (Codex v3 P1-1) | 高 | D1 view と同 pattern (`BTreeMap<(LogicalTime, UiElementRef), i64>` + `count > 0 を rev walk`) で convergent state を保証。D2-B 着手の最初に diff-bookkeeping unit test を pin (snapshot は assertion / retraction 任意順で settle) |
| R15 | `Arc<PerceptionPipeline>` clone が他 caller に残った状態で shutdown を呼ぶと内部 thread が停まらない (Codex v3 P2-2) | 高 | 既存 `L1Inner::shutdown_with_timeout(&self)` パターンと同型 (`Mutex<Option<JoinHandle>>` を take()、shutdown signal で worker 停止) を D2-0-1 に明記、Arc clone 残存下 test (D2-0-3) で pin |
| R16 | `JoinHandle::join()` を直呼びすると timeout が無効で test が無期限 block (Codex v4 P2-12) | 高 | 既存 `worker.rs:174-194` と同じ `deadline + is_finished() polling` pattern に修正、D2-0-3 で timeout 失敗 test を pin (worker_loop を block する fixture で意図的に Err 経路を踏む) |
| R17 | shutdown 失敗時に slot を空にして二重 worker を spawn する flaky 障害 (Codex v4 P1-6、北極星) | 高 | API signature を `Result<(), &'static str>` に修正、**成功時のみ slot clear / `Arc::ptr_eq` で同一インスタンス確認 / 失敗時は元 Arc retain** を D2-0-2 に北極星扱いで明記、regression test (D2-0-3 の 3 test) で後続 PR が壊さないよう pin |
| R18 | timeout 失敗時に pump or worker leg が consume されて degraded pipeline が永久化、retry が `Ok(())` no-op で slot clear → 二重 worker spawn (Codex v6 P1 北極星 violation) | 高 | `PerceptionWorker` / `FocusPump` 自体に retain-on-timeout 型 `shutdown_with_timeout(&self, ...)` を実装 (`Mutex<Option<JoinHandle>>` で is_finished polling、L1 同型)、`PerceptionPipeline` 側は `Mutex` なしで薄い委譲のみ。`shutdown_timeout_failure_retains_slot` / `pipeline_recovers_from_partial_shutdown` の 2 test で `Duration::from_nanos(1)` を使い直接 pin |
| R19 | shutdown signal の `tx.send` が bounded channel full で block、deadline を作る前に止まり timeout が効かない (Codex v7 P2) | 中 | `try_send` を使用 (`shutdown_with_timeout` + `Drop` の Cmd::Shutdown 送信箇所)、push_focus は ordering 保持のため `send` 維持。`shutdown_with_timeout_does_not_block_on_full_channel` test で channel-full + stuck worker シナリオを直接 measure (regression 時は 3s block で fail) |
| R20 | `try_send(Cmd::Shutdown)` が一発で Full なら signal drop、worker drain 後も signal 不届きで shutdown が空回り timeout (Codex v8 P2-15) | 中 | `shutdown_with_timeout` を 2-phase 化、phase 1 で `try_send` を deadline 内 retry (Full なら poll_interval sleep して再 try)、phase 2 で従来 polling。`shutdown_with_timeout_retries_send_when_channel_drains` test で drain-eventually worker から retry 成功経路を直接 measure |
| R21 | failed shutdown が pipeline を half-stopped state で slot 占有、後続 `ensure_perception_pipeline()` が degraded pipeline を新 caller に渡す (Codex v8 P2-16) | 高 | `PerceptionPipeline.poisoned: AtomicBool` を追加、shutdown 失敗時 set。`ensure_perception_pipeline` で `is_poisoned()` 検出時 best-effort 再 shutdown → slot evict → fresh spawn。`shutdown_timeout_failure_poisons_slot_and_evicts_on_next_ensure` test で full sequence (poison set / stale Arc 観測 / fresh ensure) を pin |

---

## 10. Open Questions

| # | OQ | 決定タイミング |
|---|---|---|
| 1 | `EventKind::DirtyRect` emit site の実装状況 (ADR-007 P5c-2 の進捗) | **D2-C0 で確定**、未実装なら ADR-007 を prerequisite |
| 2 | revised tuning でも SLO 未達の場合の option C (`parking_lot::Condvar`) 移行 | D2-A bench 結果次第、Opus 委譲 |
| 3 | `EventKind::WindowChanged` / `ScrollChanged` emit site の実装状況 (ADR-007 P5c-3/P5c-4) | **D2-C0 で確定**、未実装 variant は D2-D scope から除外 |
| 4 | `parking_lot::RwLock` / `arc-swap` 切替判断 | D2-F-3 concurrent reader/writer bench 結果 |
| 5 | L4 envelope pivot 搬送経路 (D1-3 残 §3.5) の本実装 | ADR-010 起草時、本 D2 では deferred |
| 6 | `desktop_state` MCP round-trip acceptance を 1/10 にするか 1/5 にするか | D2-B-3 baseline 測定後、Opus 判断 |
| 7 | `semantic_event_stream` の subscribe API (MCP notification 配信) | D2.5 / ADR-010 起草時、本 D2 では internal Rust callback のみ |
| 8 | `predicted_post_state` subgraph で speculation を tool_call_id 単位で GC する方針 | D5 着手時、dummy 実装では全 retain |
| 9 | `desktop_state.modal` / `attention` の view 化 (D4 担当) | D4 着手時 |
| 10 | `desktop_state` の at-point / cursor-over element の view 化 | 別 view 新設 phase で OQ 化、本 D2 では既存維持 |
| 11 | UIA control type id (u32) → 既存文字列名への変換 table の在処 (Rust 側 napi binding に新設 / 既存 UIA bridge に存在 / TS 側 helper) | D2-B-1 着手時に grep、なければ napi binding に新設 (Codex v2 P1-3) |
| 12 | `latest_focus` view と `current_focused_element` の併存 (両方 D2-E0 同 scope 内 build) で arrangement memory が 2 倍にならないか | D2-A bench harness で測定、view 単独 vs 両者併存で memory 比較 (Codex v2 P1-4) |
| 13 | diff bookkeeping helper (BTreeMap diff-sum + count > 0 rev walk) を `current_focused_element` (per-hwnd) と `latest_focus` (singleton) で共通化するか別実装か | D2-F-1 (current_focused_element の §3.1 強化) と D2-B-2 (latest_focus 新設) のどちらが先かで判断、後発で共通 helper 抽出 (Codex v3 P1-1) |
| ~~14~~ | ~~D2-0 lifecycle test の timeout 失敗系 2 件 fixture~~ | **Resolved (v3.3, PR #94)**: `PerceptionWorker` / `FocusPump` の retain-on-timeout refactor で fixture 不要化、2 test (`shutdown_timeout_failure_retains_slot` / `pipeline_recovers_from_partial_shutdown`) を `Duration::from_nanos(1)` で本実装 |

---

## 11. Acceptance Criteria (v2、ADR-008 §8 D2 + Codex review 反映)

### 11.1 ADR-008 §8 D2 部 (再解釈、v2)

- [ ] **`desktop_state` focus path を view 経由化、bit-equal 回帰 0** — D2-B、`hints.focusedElementSource = "view"` で観測
- [ ] **`desktop_state` の modal / attention path は D4 carry-over として明記** — D2-G で ADR-008 §4 / §8 を更新
- [ ] **主要 view 4 の declarative 実装** (D2-C0 結果次第):
  - [x] `current_focused_element` (D1 完了)
  - [ ] `dirty_rects_aggregate` (D2-C、D2-C0 go の場合) — no-go なら ADR-007 P5c-2 後に carry-over
  - [ ] `semantic_event_stream` (D2-D、variant set は D2-C0 結果反映) — `FocusMoved` 単独でも成立
  - [ ] `predicted_post_state` subgraph 構造 (D2-E、本格化は D5)

### 11.2 D2 で完結させる土台 (v2 + v3 で追加)

- [ ] **production pipeline lifecycle** (D2-0): `ensure_perception_pipeline()` / `shutdown_perception_pipeline_for_test()` の API + double-init / 5-cycle restart test、既存 `L1_SLOT` パターン (`OnceLock<Mutex<Option<Arc<T>>>>`) 踏襲 (v3 Codex P2-7)
- [ ] **dataflow scope refactor** (D2-E0): `build_current_focused_element(scope, stream) -> (Arranged, View)` への signature 変更、`Arranged` を外部に持ち出さない (v3 Codex P2-9)
- [ ] **`latest_focus` view 新設** (D2-B-2、§5.bis): global latest 1-row view、`view_get_focused()` (引数なし) で `desktop_state.ts` から呼ぶ (v3 Codex P1-4)
- [ ] **`controlType` 文字列変換** (D2-B-1): UIA control type id (u32) → 既存文字列 (例: `"Button"` / `"Pane"` / `"Edit"`) への変換、bit-equal 回帰 0 (v3 Codex P1-3)

### 11.3 D1 acceptance honest 化 (B 案で追加、v2 で revised)

- [ ] **`view_update_latency` p99 < 1ms** — D2-A の **revised tuning (batch drain + max-time release)** で達成 (option B 撤回、N3 維持)
- [ ] **真の p99 抽出** — bench harness で stdout + JSON 出力 (followups §2.1)
- [ ] **production gap baseline** — `uiaGetFocusedAndPoint` baseline (followups §2.2)
- [ ] **MCP transport 込み bench** — `d2_desktop_state_roundtrip.mjs` で round-trip 計測 (followups §2.3, §2.4)
- [ ] **「real L1 input ベース」** — D2-B-4 で MCP tool round-trip として達成

### 11.4 D1-3 残 follow-up (B 案で追加)

- [ ] §3.1 transient stale read 強化 — D2-F-1
- [ ] §3.2 tie-breaker semantics 明示 — D2-F-2
- [ ] §3.3 starvation リスク再評価 — D2-F-3
- [ ] §3.4 reduce 経由 hwnd 死活遷移 test — D2-F-4
- [ ] §3.6 shutdown drain 検証 — D2-F-5
- [ ] §3.5 L4 envelope pivot 搬送 — **deferred to ADR-010**、§10 OQ #5

### 11.5 全体

- [ ] CI green、`npm run build:rs` / `npm test` 回帰 0
- [ ] cargo test --workspace 全 pass、追加 unit + integration test 全 pass
- [ ] vitest `npm run test:capture` 0 regression
- [ ] 各 phase 完了で **Opus phase-boundary review** 実施、指摘ゼロまで反復 (強制命令 3)
- [ ] D2-G で docs / memory 整合: views-catalog §3.2 の Implemented view 全て flip、ADR-008 §8 D2 を「focus path 完了、modal/attention は D4 carry-over」明記、D1-followups §3 を Resolved 化 (§3.5 除く)

---

## 12. 関連

- 親 ADR: `docs/adr-008-reactive-perception-engine.md`
- SSOT: `docs/architecture-3layer-integrated.md`
- view 契約: `docs/views-catalog.md` §3.2 / §4.1
- 制約: `docs/layer-constraints.md` §4 (L3 Compute)
- D1 plan: `docs/adr-008-d1-plan.md` (Implemented)
- D1-2 plan: `docs/adr-008-d1-2-plan.md` (Implemented)
- D1 followups: `docs/adr-008-d1-followups.md` (本書で §3.5 除き全消化)
- L1 base: ADR-007 P5a 完了 (`memory/project_adr007_p5a_done.md`)
- L1 拡張 prerequisite: ADR-007 P5c-2 (DXGI dirty rect emit) / P5c-3 (UIA window event emit) / P5c-4 (UIA scroll event emit) — D2-C0 で go/no-go 判定
- 関連 PR (履歴):
  - #79 (main-push guard、merged)
  - #80 (P5b defer、merged)
  - #81 (D1-0 workspace、merged `a1cd5e8`)
  - #82 (D1-1 timely + DD deps、merged `f8877a8`)
  - #88 (P5c-1 UIA Focus hook、merged)
  - #89 (build-rs auto-target、merged `d091e9e`)
  - #90 (D1-2 focus_pump、merged `0c795e9`)
  - #91 (D1-3 current_focused_element view、merged `2288333`)
  - #92 (D1-5 bench、merged `ab71ffd`)
  - #93 (D1-followups docs、merged `dacc4e1`)

---

END OF ADR-008 D2 plan v2 (Draft)。
