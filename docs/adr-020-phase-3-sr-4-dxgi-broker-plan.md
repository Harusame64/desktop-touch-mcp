# ADR-020 Phase 3 SR-4 — vision-gpu / Stage 5 DXGI broker (broker owner 1 つ固定) sub-plan

- Status: **Drafted (2026-05-17、Round 2 = Opus Round 1 P1×3 + P2×6 + P3×4 反映)**
- 親 ADR: `docs/adr-020-path-class-refactor-plan.md` §5.1 SR-4 (Round 4 P3-2 で fail-soft semantics 2 軸縮約確定)
- 着手 trigger: ADR-020 SR-2 全 PR land 完了 (PR #346/#347/#348 merged、main HEAD `6d2a14e`、§11 L6 部分 closure 達成)
- baseline commit: `6d2a14e` (main HEAD、PR-SR2-3 merge 後)
- 着手順序: Phase 3 4 SR のうち **4 番目 = 最終 SR** (SR-1 → SR-5 → SR-2 → **SR-4**、親 ADR §5.1)
- 関連 SSOT:
  - `src/engine/any-change.ts` (Stage 5 orchestrator + `DirtyRectSubscriptionCache` + 5-value `CacheAcquireState` + negative-backoff marker、660 line)
  - `src/engine/vision-gpu/dirty-rect-source.ts` (`DirtyRectRouter`、`addon["DirtyRectSubscription"]` 未型 escape hatch + AccessLost backoff 100ms、133 line)
  - `src/duplication/{mod,device,thread,types}.rs` (PR #102 ADR-007 P5c-2 で land した DXGI session lifecycle + L1 ring fork、不変)
  - `src/engine/native-engine.ts` / `src/engine/native-types.ts` / `index.d.ts` / `index.js` (`DirtyRectSubscription` 型 SSOT)
  - `docs/adr-019-stage-5-plan.md` §2.6 (現行 fail-soft "documented coexistence" 文言、bit-equal sync 対象)
- 関連 ledger (親 ADR §11): **L1 (B)** = PR #333 negative-backoff marker + cacheState 5-value、**L7 (A defer)** = dormancy fix branch `feature/adr-019-stage-5-dormancy-fix-deferred` SHA `10982e2`、SR-4 完了で両者 strikethrough。**L6 (G 部分 closure)** は SR-2 carry-over OQ-SR2-5 (親 ADR §11)、本 SR-4 とは独立軸で touch しない (本 sub-plan baseline note `6d2a14e` で L6 部分 closure 達成済を pin、scope 外明示)
- 関連 OQ (親 ADR §10): なし新規 (本 sub-plan 内で SR-4 固有 OQ を §10 に起草)、親 ADR §11 L10 (`failWith` 経路 migrate 判断) は SR-4 着手前 mile-stone 参照確認結果を §10 OQ-SR4-7 で永続化
- 北極星抜粋 (親 ADR §2 から SR-4 への refinement): **DXGI subscription の owner を 1 つに固定 + consumer 2 件 (Stage 5 / vision-gpu) を broker subscribe API 経由でぶら下げ + factory failure / negative-backoff / dormancy semantics を broker 内に集約** で **race そのものを解消**、ADR-019 §2.6 lock 文言 (line 215 `NotCurrentlyAvailable / Unsupported / Other` の DXGI factory error 軸 3 種) のうち **race-loss `NotCurrentlyAvailable` 1 種のみを構造的に消滅** させ、broker 後の `dxgi_dirty_rect_unavailable` emit trigger を **(A) DXGI factory error 軸 2 種 (`Unsupported` / `Other` 系) + (B) resolver failure 軸 3 reason (`off_screen` / `no_monitors` / `out_of_range`、§2.1 step 5 別経路)** の 2 軸構造に再整理 (Round 2 P1-1: axes inventory bit-equal sync)

---

## 1. 背景

### 1.1 baseline L1 (B 軸) + L7 (A defer) の drift 構造

PR #333 (Issue #327 item B、2026-05-12 merged) + PR #334 (#327 item B follow-up、2026-05-17 merged) で `DirtyRectSubscriptionCache` に **negative-backoff marker** + **5-value `CacheAcquireState` 計装** を導入し、`sub.next()` 失敗時の 50ms factory re-init storm を tactical fix。**ただし以下の drift 構造は残存** (ADR-020 §1.1 B 行 + L7):

| 軸 | 現状 (baseline `6d2a14e`) | drift 結果 |
|----|---------|----------|
| **DXGI subscription owner 2 件並立** | (1) `src/engine/any-change.ts:339-345` `defaultFactory` 経由で **Stage 5 が `nativeDuplication.DirtyRectSubscription` を construct** (typed SSOT) / (2) `src/engine/vision-gpu/dirty-rect-source.ts:124-133` `createNativeSubscription` 経由で **vision-gpu が `addon["DirtyRectSubscription"]` を construct** (untyped escape hatch) | 両者が同一 output index に対し DXGI `DuplicateOutput` を別個に呼ぶ → `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE` race → 後発の subscriber が **fail-soft 縮退** (`dxgi_dirty_rect_unavailable`)、`negative-backoff` marker と cache TTL で症状緩和するも race 自体は構造的に残存 |
| **fail-soft race-loss 軸 (ADR-019 §2.6 lock)** | `verifyAnyChange` (`any-change.ts:556-560`) が `cache.acquireWithState()` で `null` 受領 → `degradeUnavailable(acquireState)` で `source: "dxgi_dirty_rect_unavailable"` emit、L1 ring fork (`thread.rs:297-313`) も race-loss 側で停止 | LLM-facing observation が **honest under-claim** で degrade、Stage 5 が真の `any_change` を observe できない window が発生 (vision-gpu activation 中の Stage 5 verify は構造的に degraded) |
| **dormancy semantics 二重実装** | (1) Stage 5: `negative-backoff` 2s + `unavailable` 60s + subscription idle 20s の 3-TTL state machine (`any-change.ts:97-119` + `:293-333`) / (2) vision-gpu: `_loop` 内 100ms `setTimeout` backoff + `E_DUP_DISPOSED` break で simple linear (`dirty-rect-source.ts:103-109`) | 同 DXGI 失敗 mode (`E_DUP_ACCESS_LOST`) に対する recovery 戦略が 2 consumer で divergent、`feature/adr-019-stage-5-dormancy-fix-deferred` (SHA `10982e2`) で land 予定だった foreground-fallback dormancy 拡張が 2 consumer 共存下では race と相互作用して L7 defer に至った |
| **`DirtyRectSubscription` 型 SSOT bypass** | vision-gpu の `addon["DirtyRectSubscription"]` (`dirty-rect-source.ts:124-133`) が `index.d.ts` の typed declaration を bypass、Stage 5 の `nativeDuplication.DirtyRectSubscription` (typed) と **型整合が機械保証されない** | 将来の `DirtyRectSubscription` API 変更 (e.g. `next(timeout_ms, options?)` 拡張) が vision-gpu 側で silent regression を生む risk |

**dormancy fix branch (`feature/adr-019-stage-5-dormancy-fix-deferred`、SHA `10982e2`)** は Stage 5 dogfood 中に発見した `foreground-hwnd fallback for tryVerifyAnyChange + drop unused type import` 改修を含む branch で、PR #325 (Stage 5 impl) merge 後の改修だが、**vision-gpu race 解消なしでは foreground-fallback semantics が race-loss 経路で空転する** ため A defer された (親 ADR §11 L7 / memory `project_v170_blockers_resolved.md` §「Item A defer 根拠」)。

### 1.2 SR-4 broker 設計の **race 解消 + fail-soft trigger inventory 再整理** (Round 2 P1-1)

**Race 解消の中核**: DXGI `IDXGIOutput::DuplicateOutput` は output index ごとに **同時に 1 subscription しか許さない** (`DXGI_ERROR_NOT_CURRENTLY_AVAILABLE`)。SR-4 では **broker owner を 1 つ固定** することで「2 consumer が同 output index を取り合う pattern」を **構造的に発生不能化**:

- broker (新規 `src/engine/dxgi-broker.ts`) が `DirtyRectSubscription` の **唯一の constructor caller**
- consumer 2 件 (Stage 5 `any-change.ts` / vision-gpu `dirty-rect-source.ts`) は broker の `subscribe(outputIndex, callback) / acquire(outputIndex)` API 経由でぶら下がる
- broker 内部で 1 つの実 subscription を multiplex (fan-out: 1 native subscription → N consumer callback)
- factory failure / negative-backoff / dormancy semantics は broker 内に集約、各 consumer は **marker / envelope だけ受け取る** (自前で DXGI 再 init 試行しない)

**ADR-019 §2.6 lock 文言と broker 後 trigger inventory** (Round 2 P1-1: 現行 lock 文言と bit-equal sync 再整理):

ADR-019 §2.6 line 215 lock 文言は `DirtyRectSubscriptionCache.acquire(0)` が **DXGI return error 軸** (`NotCurrentlyAvailable` / `Unsupported` / `Other`) を受領した場合に `dxgi_dirty_rect_unavailable` を emit する fail-soft 経路を明示。これとは別に `any-change.ts:533-535` の **resolver failure 軸** (`off_screen` / `no_monitors` / `out_of_range`) も同 enum value を `§2.1 step 5` 経路で emit するが、§2.6 lock 内には明示されていない (resolver failure は broker 以前の段階の判定で broker と独立)。

```
現行 (ADR-019 §2.6 line 215 lock + §2.1 step 5 別経路) の dxgi_dirty_rect_unavailable trigger inventory:

   (A) DXGI factory error 軸 (§2.6 lock 内明示、3 種):
        (A-1) race-loss (NotCurrentlyAvailable、vision-gpu / Stage 5 競合)
        (A-2) factory failure (Unsupported、RDP / virtual display / driver 不在)
        (A-3) Other (E_DUP_DISPOSED / unknown error 系、catch-all)
   (B) resolver failure 軸 (§2.1 step 5 別経路、3 reason):
        (B-1) off_screen (window center が全 monitor の外)
        (B-2) no_monitors (enumMonitors 0 件)
        (B-3) out_of_range (resolver 結果が STAGE5_MAX_OUTPUT_INDEX 超過)

SR-4 後 (本 sub-plan で確定) の dxgi_dirty_rect_unavailable trigger inventory:

   (A) DXGI factory error 軸 (broker 内集約、(A-1) race-loss は消滅):
        (A-2) factory failure (残存、broker 内 acquire で同じく emit)
        (A-3) Other (残存、broker 内 invalidate → unavailable marker)
   (B) resolver failure 軸 (broker と独立、3 reason 全残存):
        (B-1) off_screen / (B-2) no_monitors / (B-3) out_of_range

   構造的消滅: (A-1) race-loss 1 種のみ (broker owner 1 つ固定で同 output index concurrent DuplicateOutput が発生不能)
   残存 trigger: (A-2) + (A-3) + (B-1)+(B-2)+(B-3) = 5 trigger / 2 軸 (DXGI factory / resolver failure)
```

**AccessLost 軸は本縮約と独立**: `any-change.ts:567-574` の `E_DUP_ACCESS_LOST` キャッチは `source: "dxgi_dirty_rect"` (≠ `dxgi_dirty_rect_unavailable`) を emit するため、broker introduction でも source enum 切替なし。AccessLost recovery は broker 内 negative-backoff 2s に統一する semantics 変更のみ (§5 北極星 4 + §7.2 vision-gpu migration scope)。

**ADR-019 §2.6 文言の bit-equal sync が SR-4 sub-plan land の必須条件** (CLAUDE.md §3.1 fact 整合 sweep + 親 ADR §5.1 SR-4 fail-soft semantics shift)。**§6.3 表で「現行 §2.6 lock 文言 → broker 後文言」の対応関係を明示** (race-loss bullet 削除、(A-2)/(A-3) 残存 bullet 維持、resolver failure 軸を historical note として §2.6 内に追記、(B) 軸 全 reason 列挙)。

### 1.3 `failWith` / `ToolFailure` shape / Result 経路は SR-4 scope 外

SR-2 (PR #346-#348) で確立した **`toFailureEnvelope` + handler 最外周共通 pattern** は handler layer の failure path 統一であり、SR-4 改修は **`src/engine/` 内 DXGI subscription orchestration layer** で完結する。`failWith` 176 callsite migrate (OQ-SR2-4) は本 SR-4 と独立、Phase 3 完了後 / 別 epic carry-over (親 ADR §11 L10)。

---

## 2. 北極星 (SR-4 不変条件)

親 ADR §2 北極星 4 件 + SR-2/SR-1/SR-5 北極星継承 + SR-4 layer に refinement:

1. **DXGI `DirtyRectSubscription` constructor caller は broker 1 箇所のみ**: 新規 `src/engine/dxgi-broker.ts` が **唯一の `nativeDuplication.DirtyRectSubscription` / `addon["DirtyRectSubscription"]` construct 経路**、consumer 2 件 (Stage 5 / vision-gpu) は broker subscribe API 経由でぶら下がる。`addon["DirtyRectSubscription"]` untyped escape hatch は **完全削除** (typed SSOT `index.d.ts:DirtyRectSubscription` から derive)。
2. **race-loss `NotCurrentlyAvailable` (A-1) 1 種のみ構造的消滅** (Round 2 P1-1): 同 output index に対する concurrent `DuplicateOutput` 呼出を broker 内 multiplex (1 native subscription → N consumer callback) で構造的に発生不能化。ADR-019 §2.6 lock 文言 (line 215) の DXGI factory error 軸 3 種 (`NotCurrentlyAvailable` / `Unsupported` / `Other`) のうち **`NotCurrentlyAvailable` 1 種のみ消滅**、残 2 種 (`Unsupported` / `Other`) は broker 内集約後も emit trigger として残存。`out_of_range` を含む resolver failure 軸 (off_screen / no_monitors / out_of_range) は §2.1 step 5 別経路で broker と独立、broker 後も 3 reason 全残存。§2.6 文言を SR-4 PR-SR4-2 で **race-loss bullet 削除 + (A-2)/(A-3) 残存 bullet 維持 + resolver failure 軸 historical note 追記** で bit-equal sync (§6.3 表)。
3. **既存 user-facing API 不破壊**: tool description / envelope shape / `VisualMotionObservation.{source, motion, residual, cacheState, ...}` / `DirtyRectSubscription` napi class declaration 全て backward compatible (親 ADR §3 北極星 3 + 強制命令 10 整合)。`source: "dxgi_dirty_rect_unavailable"` enum slot は不変、broker 後 trigger inventory (Round 2 P1-1 整理: (A) DXGI factory error 軸 2 種残存 + (B) resolver failure 軸 3 reason) でも同 enum value 使用。
4. **factory failure / dormancy semantics broker 集約**: 現行 `DirtyRectSubscriptionCache` 3-TTL state machine (`subscription idle 20s` / `unavailable 60s` / `negative-backoff 2s`) は broker 内に **そのまま移植** (semantics 維持、callsite 変更のみ)、consumer は marker / observation だけ受け取る (自前で DXGI 再 init / backoff 試行しない)。**`CacheAcquireState` 5-value** (`hit-subscription` / `hit-unavailable` / `hit-negative-backoff` / `miss-init` / `miss-init-unavailable`) も broker layer に維持、consumer 側 `VisualMotionObservation.cacheState` は broker から bit-equal propagate。
5. **L1 ring fork は broker 経路で不変、reference count 0 時のみ一時停止** (Round 2 P2-2 refinement): `src/duplication/thread.rs:297-313` の L1 ring emit fork は **broker が少なくとも 1 consumer 参照中** の間 active、`dirty_rect_pump.rs` (`src/l3_bridge/dirty_rect_pump.rs`) は broker 経由で全 active consumer に対し L1 ring 経由 event 受領継続。**reference count 0 + idle timeout 20s 経過時のみ** broker が native subscription を dispose し L1 ring fork が一時停止 (任意 consumer 再 acquire/subscribe で broker が native subscription 再 init、fork 再開)。本一時停止 window は §11 R7 で test pin、`current_focused_element` view への影響は idle timeout 20s で抑制。
6. **dormancy fix branch revive 経路確保**: `feature/adr-019-stage-5-dormancy-fix-deferred` (SHA `10982e2`) は **broker semantics 確立後 rebase + 実機検証 → revive PR** で land、親 ADR §11 L7 closure。foreground-hwnd fallback for `tryVerifyAnyChange` が broker multiplex 経路で正しく機能することを **dual-monitor + vision-gpu activation 同時実行** dogfood で実証。
7. **gradual migration**: 本 SR-4 では 2 consumer migration を 2 PR に分割 (Stage 5 先 → vision-gpu 後)、各段階で **既存 test 全 green + dogfood smoke 完走** を確認。一括 cutover は §8 R3 で却下 (consumer 側 BC リスク + native binding 変更幅で review 不能化)。

---

## 3. scope outline (6 PR 分割確定、sub-plan land 含む)

親 ADR §5.1 SR-4「~1000-1500 line + native binding 改修、要 Opus 厚め + Codex 必須」を **6 PR 構成** (sub-plan land PR-SR4-0 + broker scaffold PR-SR4-1 + Stage 5 migrate PR-SR4-2 + vision-gpu migrate PR-SR4-3 + dormancy revive PR-SR4-4 + closure PR-SR4-5、Round 2 P1-2: 「5 PR 構成」と書いていた誤り訂正) に確定。**case (a) layer ごと分割** を採用 (理由: broker 単独 land → consumer 個別 migrate で各段階の bisect が容易、case (b) feature ごと一括 migrate は consumer 2 件同時 review で size 不能化):

```
PR-SR4-0 (sub-plan land、docs-only)
   = .gitignore whitelist + sub-plan land (SR-1/2/5 PR-SRx-0 と同 pattern)
   ↓
PR-SR4-1 (broker scaffold + interface land、~300-450 line + tests)
   = src/engine/dxgi-broker.ts 新規 (DirtyRectBroker class + acquire/subscribe API + 3-TTL state machine 移植)
   = src/engine/native-types.ts: BrokerSubscription interface 追加 (Round 2 P1-3: subscribe method なし、polling consumer の handle 専用)
   = ESM re-export pattern 維持 (index.js / index.d.ts は不変、broker は addon を直接参照しない、any-change.ts と同 pattern)
   = 新規 test: tests/unit/dxgi-broker.test.ts (acquire/subscribe / unsubscribe / dispose lifecycle + 3-TTL semantics + factory failure + 5-value CacheAcquireState)
   = ※ consumer migration は本 PR で行わない、broker は dormant land (まだ caller がいない状態で main に入る)
   ↓
PR-SR4-2 (consumer migration Phase A: Stage 5 any-change.ts → broker subscribe、~250-350 line)
   PR-SR4-1 land 後着手 (broker 型依存)
   = src/engine/any-change.ts: getSharedSubscriptionCache() を broker subscribe 経由に置換
     (DirtyRectSubscriptionCache class は broker layer 移管後 deprecated、internal helper として残置か削除は本 PR review で確定)
   = verifyAnyChange の cache.acquireWithState() → broker.acquire(outputIndex) + cacheState propagate
   = ADR-019 §2.6 文言 bit-equal sync (Round 2 P1-1: line 215 lock の DXGI factory error 軸 3 種のうち `NotCurrentlyAvailable` bullet 削除 + `Unsupported`/`Other` 2 種残存 + resolver failure 軸 historical note 追記、CLAUDE.md §3.1 grep 必須、§6.3 表)
   = 既存 test 全 green 維持 (envelope shape bit-equal、any-change-orchestrator.test.ts / dirty-rect-subscription-cache.test.ts は broker mock injection で動作維持)
   ↓
PR-SR4-3 (consumer migration Phase B: vision-gpu dirty-rect-source.ts → broker subscribe、~200-300 line)
   PR-SR4-2 land 後着手 (broker semantics 実証完了、Stage 5 で race 解消が dogfood 可能)
   = src/engine/vision-gpu/dirty-rect-source.ts: createNativeSubscription() + addon["DirtyRectSubscription"] 削除
   = DirtyRectRouter.start() → broker.subscribe(outputIndex, onRectsCallback) 経由
   = AccessLost recovery を broker dormancy semantics に統合 (vision-gpu 側 100ms setTimeout backoff は broker negative-backoff 2s に統一、divergence 解消)
   = untyped escape hatch (`addon["DirtyRectSubscription"]`) 完全削除、typed `BrokerSubscription` 経由のみ
   = 既存 test 全 green 維持 (vision-gpu DirtyRectRouter test は broker mock injection、subscriptionFactory option は broker 互換 shape に切替)
   ↓
PR-SR4-4 (dormancy fix branch revive + 実機検証、~100-200 line + 実機 dogfood)
   PR-SR4-3 land 後着手 (race 解消後、foreground-fallback dormancy が機能する前提揃う)
   = feature/adr-019-stage-5-dormancy-fix-deferred (SHA 10982e2) を main rebase
   = broker semantics に合わせて foreground-hwnd fallback for tryVerifyAnyChange を再 wiring
   = 実機検証: dual-monitor + vision-gpu activation 同時実行 dogfood で foreground-fallback dormancy が race-free に機能することを実証 (notification_show + user 確認)
   = ADR-019 stage-5-followups.md に dogfood report 永続化
   ↓
PR-SR4-5 (ledger closure + Phase 3 完了 announcement、docs-only)
   = 親 ADR §11 L1 (B) strikethrough + L7 (A defer) strikethrough
   = CHANGELOG.md (利用者向け英語、強制命令 10): "DXGI dirty-rect broker eliminates Stage 5 / vision-gpu race-loss on shared output"
   = docs/adr-019-stage-5-plan.md §2.6 文言を broker 後 fail-soft 2 軸に最終 sync
   = Phase 3 全 4 SR 完了 announcement (親 ADR §9 acceptance criteria 全件 strikethrough、v1.7.0 minor release trigger 解除、user 諮問で release 判断)
```

PR-SR4-1 と PR-SR4-2 は **直列必須** (broker land 後でないと consumer migrate 不能)。PR-SR4-2 と PR-SR4-3 は **scope disjoint** (any-change.ts vs vision-gpu/dirty-rect-source.ts) で worktree 並走可能だが、**PR-SR4-2 を先に main land して Stage 5 で broker semantics を実証してから PR-SR4-3 に進む** (vision-gpu 同時 migrate で broker semantics bug が混入した場合 bisect 困難、CLAUDE.md §3.4 並走判断軸 1「独立 scope」より「実証 → 拡大」優先)。PR-SR4-4 は PR-SR4-3 後の **必須直列** (race 解消後でないと dormancy fix が空転する)。**全 6 PR (PR-SR4-0 〜 PR-SR4-5) で SR-4 全工程完結** (sub-plan land + broker scaffold + Stage 5 migrate + vision-gpu migrate + dormancy revive + closure、Round 2 P1-2)。

---

## 4. PR-SR4-0 (sub-plan land) scope

### 4.1 改修対象 file

| file | 改修 | size 見積 |
|------|-----|---------|
| `.gitignore` | `docs/adr-020-phase-3-sr-4-dxgi-broker-plan.md` を release whitelist 追加 (SR-1/2/5 と同 pattern、`docs/.gitignore` は white-list 方式) | +1 line |
| `docs/adr-020-phase-3-sr-4-dxgi-broker-plan.md` | 本 sub-plan 新規 | +700-900 line |
| `docs/adr-020-path-class-refactor-plan.md` | §11 L1 (B) / L7 (A defer) の trigger 文言に "本 SR-4 sub-plan land で着手 trigger 解除" 注記追加 (changelog 化、SR-1/2/5 land 時と同 pattern) | +2-4 line |

### 4.2 acceptance criteria (sub-plan land PR)

- 本 sub-plan が `.gitignore` whitelist で git 追跡対象
- 親 ADR §11 L1 / L7 ledger 文言更新が bit-equal sync (CLAUDE.md §3.1)
- 既存 vitest suite 全 pass + 既存 cargo test 全 pass (sub-plan land で実コード変更ゼロ、regression 構造的不能)
- Opus phase-boundary review (本 sub-plan land 直後 background agent trigger) + Codex review 推奨 (Phase 境界 plan + API contract surface = broker interface design)

---

## 5. PR-SR4-1 (broker scaffold + interface) scope

### 5.1 北極星 PR-SR4-1 (broker 単独 land、consumer 未 migrate)

PR-SR4-1 は **broker が main に dormant land する PR**。consumer 2 件 (Stage 5 / vision-gpu) は本 PR では未 migrate、broker は **caller ゼロで test green** を維持。

- broker interface 設計を **API 設計の bit-equal lock** で確定 (consumer migration PR で interface 変更が出ると review 不能化)
- 既存 `DirtyRectSubscriptionCache` の 3-TTL state machine + 5-value `CacheAcquireState` を broker に **bit-equal 移植** (signature shape 維持で consumer migration 時の diff を最小化)

### 5.2 改修対象 file + interface 設計

| file | 改修 |
|------|-----|
| `src/engine/dxgi-broker.ts` (NEW) | `DirtyRectBroker` class + `BrokerSubscription` interface + `acquire(outputIndex) / subscribe(outputIndex, callback)` API + 3-TTL state machine 移植 + 5-value `CacheAcquireState` 維持 + factory injection (テスト用 mock 注入経路) + `disposeAll` lifecycle |
| `src/engine/native-types.ts` | `BrokerSubscription` re-exported interface (Round 2 P1-3: subscribe method なし、polling consumer 用 read-only handle、§5.2 草案参照)、`NativeDirtyRectSubscription` 既存 type は不変 |
| `tests/unit/dxgi-broker.test.ts` (NEW) | broker lifecycle test (~15-20 case): (a) subscribe / unsubscribe 単独 / (b) 同 output 2 consumer multiplex (race 解消検証) / (c) 3-TTL state machine (subscription idle 20s / unavailable 60s / negative-backoff 2s) / (d) factory failure → unavailable / (e) AccessLost → negative-backoff / (f) disposeAll all-consumers / (g) 5-value `CacheAcquireState` 各 branch / (h) DXGI factory mock injection |
| `tests/unit/path-class-contract/dxgi-broker-contract.test.ts` (NEW、Round 1 起草時点で候補) | 軸 B の path-class contract (broker 経由 race 解消) を property-based / table-based で pin。**※ Round 1 では候補のみ、Opus review で contract surface を確定後に追加判断** |

**broker interface 草案** (Round 2 P1-3 反映: `BrokerSubscription.subscribe` method 削除、fan-out は `DirtyRectBroker.subscribe()` 上位 API のみ、`acquire`/`subscribe` runtime semantics 二重 fan-out risk 解消):

```ts
/**
 * PR-SR4-1: per-consumer handle for polling consumer (Stage 5).
 * Read-only view onto broker-owned native subscription. fan-out は broker layer
 * のみで完結 — 本 handle 上に subscribe method は持たない (Round 2 P1-3 lock)。
 */
export interface BrokerSubscription {
  readonly outputIndex: number;
  readonly isDisposed: boolean;
  /** Polling drain from broker per-consumer queue (OQ-SR4-1 候補 (c)).
   *  Round 2 P1-3: subscribe method 削除済、本 next() のみが consumer 取り出し
   *  経路。callback consumer は DirtyRectBroker.subscribe() を経由。*/
  next(timeoutMs: number): Promise<DirtyRect[]>;
  dispose(): void;
}

export class DirtyRectBroker {
  constructor(
    private readonly factory: (outputIndex: number) => SubscriptionLike,
    private readonly nowFn: () => number = () => Date.now(),
    private readonly idleTimeoutMs: number = STAGE5_CACHE_IDLE_TIMEOUT_MS,
    private readonly unavailableTtlMs: number = STAGE5_UNAVAILABLE_TTL_MS,
  ) {}

  /**
   * Polling consumer API (Stage 5)、any-change.ts cache.acquireWithState 後継。
   * Round 2 P1-3: broker 内部で 1 native subscription を保持しつつ、各 consumer
   * は独立 BrokerSubscription handle (per-consumer queue cursor、OQ-SR4-1 候補 (c))
   * を受領。同 outputIndex に N consumer acquire しても native subscription は 1 つ。
   */
  acquire(outputIndex: number): { sub: BrokerSubscription | null; state: CacheAcquireState };

  /**
   * Callback consumer API (vision-gpu)、dirty-rect-source.ts subscriptionFactory 後継。
   * Round 2 P1-3: fan-out は本 method のみで完結 (BrokerSubscription 上には公開しない)。
   * 内部で broker が native subscription を poll し、登録された全 callback に fan-out。
   */
  subscribe(
    outputIndex: number,
    callback: (rects: DirtyRect[]) => void,
  ): { unsubscribe: () => void; state: CacheAcquireState };

  invalidate(outputIndex: number): void; // negative-backoff marker 設定 (既存 cache.invalidate と同 semantics)
  disposeAll(): void; // server shutdown hook 経由 (既存 cache.disposeAll と同 semantics)
}
```

**multiplex 設計** (Round 2 P1-3 lock + OQ-SR4-1 候補 (c) 採用方針): 1 output index に対する native `DirtyRectSubscription` は broker 内 1 つだけ生存。consumer 取り出し経路は 2 種類:
- **polling consumer (`acquire`)**: broker が consumer ごとに独立 queue cursor を割り当て、`BrokerSubscription.next(timeoutMs)` で個別 drain。consumer 間で event は **複製配布** (broker 内 N consumer 分 enqueue、後発 acquire でも先発 consumer の cursor に影響しない)
- **callback consumer (`subscribe`)**: broker 内 fan-out loop が `next()` 戻り値を全登録 callback に invoke、`BrokerSubscription` handle 経由ではない直接 callback 経路

**重要**: `BrokerSubscription` interface 上に `subscribe()` method は **公開しない** (Round 2 P1-3: 二重 fan-out 経路を構造的に禁止)。consumer は acquire (polling) / subscribe (callback) のいずれか 1 経路だけを使用、両者を同時に取得して二重 listening は禁止 (broker 内 reference count は 2 経路合算で管理、§5.3 test で機械保証)。

### 5.3 acceptance criteria (PR-SR4-1)

- broker single subscription per output index 不変条件: 同 output index に 2 consumer subscribe しても native `DirtyRectSubscription` 1 つだけ construct、test で機械保証
- 3-TTL state machine bit-equal: `STAGE5_CACHE_IDLE_TIMEOUT_MS` (20s) / `STAGE5_UNAVAILABLE_TTL_MS` (60s) / `NEGATIVE_BACKOFF_MS` (2s) を **broker 側私的定数として複製定義** (Round 2 P2-5、interim window risk 解消): broker と Stage 5 両方で同 numeric 値 (20_000 / 60_000 / 2_000) を保持、PR-SR4-1 land 後 PR-SR4-2 land 前の dormant window では **broker は caller ゼロ** のため runtime 影響ゼロ。PR-SR4-2 で broker 側を SSOT 化 + Stage 5 const を broker からの re-export に切替。本 PR の test で broker 側 numeric 値が Stage 5 既存 const と同値であることを assertion で機械保証
- 5-value `CacheAcquireState` bit-equal: `hit-subscription` / `hit-unavailable` / `hit-negative-backoff` / `miss-init` / `miss-init-unavailable` 全 branch が broker 内 reachable + 全 branch test pin
- **broker test production path 実 invoke 設計** (Round 2 P2-1、memory `feedback_opus_contract_truth_sweep.md` 整合): `tests/unit/dxgi-broker.test.ts` は **公開 factory (`new DirtyRectBroker(factory, nowFn, ...)`) + injection 経路 (`factory` 引数 mock)** 経由で production fallback path を実 invoke。hand-built fixture で形式論理のみ (`const state: CacheAcquireState = "hit-subscription"; expect(state).toBe(...)`) で終わる test は禁止。各 case が mental simulation で revert/diff 検出力 (例: broker 内 reference count logic を `count++` から `count--` に意図的に革命的破壊した場合 test が必ず fail) を持つことを review で確認
- 既存 vitest suite 全 pass (broker は caller ゼロで dormant land、既存 test に impact なし)
- broker 単独 unit test ~15-20 case 全 pass、coverage は existing `dirty-rect-subscription-cache.test.ts` と同等

---

## 6. PR-SR4-2 (Stage 5 consumer migration) scope

### 6.1 北極星 PR-SR4-2 (Stage 5 経由 broker semantics 実証)

PR-SR4-2 は **Stage 5 が broker 経由で機能することを実証する PR**。vision-gpu は本 PR では未 migrate (PR-SR4-3 で実施)、Stage 5 単独で race 解消の半分を達成 (vision-gpu activation 中の Stage 5 verify race は本 PR では構造的に残存、PR-SR4-3 完了で消滅)。

### 6.2 改修対象 file

| file | 改修 |
|------|-----|
| `src/engine/any-change.ts` | `getSharedSubscriptionCache()` / `defaultFactory` / `DirtyRectSubscriptionCache` class 削除、`getSharedDirtyRectBroker()` 経由 broker subscribe に置換。`verifyAnyChange` 内 `cache.acquireWithState()` → `broker.acquire(outputIndex)`、`cacheState` propagate 維持 (5-value enum 不変) |
| `src/engine/any-change.ts` 定数 | `STAGE5_POLL_BUDGET_MS` / `STAGE5_MAX_OUTPUT_INDEX` / `STAGE5_MIN_INTERSECTED_AREA_RATIO` は Stage 5 固有で残置、`STAGE5_CACHE_IDLE_TIMEOUT_MS` / `STAGE5_UNAVAILABLE_TTL_MS` / `NEGATIVE_BACKOFF_MS` は **PR-SR4-2 で broker 側 SSOT 化 + Stage 5 側 re-export 切替** (Round 2 P2-5: PR-SR4-1 では broker 側私的複製、PR-SR4-2 で SSOT shift)。`STAGE5_CONSTANTS` Object.freeze export は不変 (内部で broker re-export 経由になる差替のみ) |
| `docs/adr-019-stage-5-plan.md` §2.6 | fail-soft 文言を **broker 後構造**に sync (Round 2 P1-1: §2.6 line 215 lock の DXGI factory error 軸 3 種 (`NotCurrentlyAvailable` / `Unsupported` / `Other`) のうち race-loss `NotCurrentlyAvailable` bullet 削除 + `Unsupported`/`Other` 2 種残存 bullet 維持 + resolver failure 軸 (`off_screen` / `no_monitors` / `out_of_range`) を §2.1 step 5 別経路として historical note 追記)。**broker introduction 注記** + § 関連 file pin 更新 (`src/engine/any-change.ts` + `src/engine/vision-gpu/dirty-rect-source.ts` race 関連 fragment 削除)。詳細表 §6.3 |
| `docs/adr-019-stage-5-plan.md` §6 R10/R11 | R10 (`device.rs:77` placeholder、PR #322 で resolved) は不変、R11 (DXGI subscription coexistence with vision-gpu) を **broker introduction で structurally resolved** に書き換え、race-loss 軸消滅を pin |
| `tests/unit/any-change-orchestrator.test.ts` | 既存 test を broker mock injection で動作維持、`cache?` option を `broker?` に rename。**`Round 2 P3-1` grep verify**: `Grep "cache?:" tests/unit/any-change-orchestrator.test.ts` で **0 件** (既存 test は `_setSharedSubscriptionCacheForTest` 経由でグローバルキャッシュ差替、test option としての `cache?:` 直接使用は未現状)、deprecate-and-remove の影響範囲は **internal sharedCache helper のみ**。SR-2 で確立した sweep 規範に従い旧 cache option は削除 |
| `tests/unit/dirty-rect-subscription-cache.test.ts` | 削除 (broker test に統合済、PR-SR4-1 で `dxgi-broker.test.ts` に migrate 完了) |
| `tests/unit/path-class-contract/*` | 既存 contract test (SR-2 で確立) は broker 経由でも green 維持、必要に応じて broker 経由 verification 追加 (Round 1 では追加判断保留、Opus review で確定) |

### 6.3 ADR-019 §2.6 文言 sync 必須項目 (CLAUDE.md §3.1 fact 整合 sweep、Round 2 P1-1: §2.6 line 215 現行 lock 構造との bit-equal sync)

PR-SR4-2 land 時に `docs/adr-019-stage-5-plan.md` §2.6 内の以下文言を **現行 lock 構造から逐語的に差替**:

| 現行文言 (§2.6 line 番号) | 変更後文言 (broker 後) |
|--------------|--------------|
| line 206-209 (consumer 2 件列挙、`src/engine/vision-gpu/dirty-rect-source.ts:124-133` + `src/l3_bridge/dirty_rect_pump.rs`) | broker 経由 consumer 単一化に再整理: "DXGI subscription consumer is the broker (`src/engine/dxgi-broker.ts`); Stage 5 and vision-gpu both subscribe via broker API. The L1 ring fork in `thread.rs:297-313` remains unchanged. ADR-020 SR-4 introduced the broker, see `docs/adr-020-phase-3-sr-4-dxgi-broker-plan.md`." |
| line 211 ("DXGI's per-output `DuplicateOutput` typically returns `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE` for a second concurrent subscription...") | "DXGI's per-output `DuplicateOutput` rejects concurrent subscriptions on the same output. ADR-020 SR-4 broker eliminates this race by holding exactly one native subscription per output index and fan-out multiplexing to N consumers." |
| line 215 ("**Lock**: When `DirtyRectSubscriptionCache.acquire(0)` returns a DXGI error (`NotCurrentlyAvailable` / `Unsupported` / `Other`), Stage 5 emits...") | "**Lock (post-SR-4)**: When the broker's `acquire(0)` returns a DXGI factory error (`Unsupported` / `Other`), Stage 5 emits `motion: indeterminate` with `source: dxgi_dirty_rect_unavailable`. The `NotCurrentlyAvailable` race-loss path is **structurally eliminated** by broker owner-1-固定 (ADR-020 SR-4)." (race-loss bullet 削除、`Unsupported`/`Other` 2 種残存) |
| line 217 (現行 "When Stage 5 is NOT active (cache idle-timed-out OR Unsupported), vision-gpu may still create its own subscription on demand. The two consumers race for first-acquire...") | "When Stage 5 is NOT active (broker idle-timed-out), vision-gpu's subscribe path **re-acquires through the same broker** — no race possible (ADR-020 SR-4 structurally eliminated the race-loss code path)." (race ベース説明削除) |
| line 219 ("Stage 5b carry-over: a single shared `DirtyRectSubscriptionCache` for both Stage 5 + vision-gpu + future consumers is a clean follow-up...") | "Realised by ADR-020 SR-4 (broker)、Stage 5b OQ closed." (carry-over closure 化) |
| §2.1 step 5 resolver failure 経路 (line 112) | 既存文言維持、ただし §2.6 内に **historical note** として "resolver failure 軸 (`off_screen` / `no_monitors` / `out_of_range`) は §2.1 step 5 別経路で `dxgi_dirty_rect_unavailable` を emit、broker と独立 (SR-4 後も 3 reason 全残存)" を追記 (Round 2 P1-1: trigger inventory 完全列挙) |
| §7 OQ #5 | "Resolved by ADR-020 SR-4 broker introduction" 注記 (現行 "Resolution locked in §2.6: Stage 5 ships fail-soft coexistence" を SR-4 後に sync) |
| §6 R11 | "DXGI subscription coexistence" → "RESOLVED by ADR-020 SR-4 broker (broker owner 1 つ固定 + fan-out multiplex)、historical note kept for sub-plan provenance" |

**grep 確認手順** (CLAUDE.md §3.1):
1. `Grep "NotCurrentlyAvailable" docs/adr-019-stage-5-plan.md` → race 関連文脈の全件列挙 → 文言更新
2. `Grep "two .*consumers\|second concurrent" docs/adr-019-stage-5-plan.md` → 旧構造文言の全件列挙
3. `Grep "fail-soft coexistence\|fail-soft semantics" docs/adr-019-stage-5-plan.md` → 3 軸表記を 2 軸に sync
4. PR-SR4-2 commit message に grep 結果 0 件 (or sync 後 0 件) を明示

### 6.4 acceptance criteria (PR-SR4-2)

- Stage 5 `verifyAnyChange` が broker 経由で動作、既存 `tests/unit/any-change-orchestrator.test.ts` 全件 green (broker mock injection で同等動作)
- `cacheState` 5-value propagation bit-equal (`hit-subscription` / `hit-unavailable` / `hit-negative-backoff` / `miss-init` / `miss-init-unavailable` の `VisualMotionObservation.cacheState` 出力が baseline と同値)
- ADR-019 §2.6 文言 sync 完了 (§6.3 表全項目 grep verify、CLAUDE.md §3.1 mandate)
- 既存 vitest suite 全 pass、特に Stage 5 関連 test (any-change-orchestrator / resolve-output-index) で regression なし
- dogfood smoke (local 環境): `desktop_act` 単独実行で `hints.verifyDelivery.observation.cacheState = "hit-subscription"` (or `miss-init` 初回) を確認、`dxgi_dirty_rect_unavailable` への degrade が baseline と同条件下で発生しないこと

---

## 7. PR-SR4-3 (vision-gpu consumer migration) scope

### 7.1 北極星 PR-SR4-3 (race 解消完了 + untyped escape hatch 削除)

PR-SR4-3 は **race 解消を完了する PR** + **`addon["DirtyRectSubscription"]` untyped escape hatch を構造除去する PR**。本 PR land 後、ADR-019 §2.6 fail-soft race-loss 軸は **構造的に発生不能**、`docs/adr-019-stage-5-plan.md` §2.6 文言は PR-SR4-2 で先行 sync 済の状態を実装で実証。

### 7.2 改修対象 file

| file | 改修 |
|------|-----|
| `src/engine/vision-gpu/dirty-rect-source.ts` | `createNativeSubscription` + `addon["DirtyRectSubscription"]` 経路を完全削除、`DirtyRectRouter.start()` で `getSharedDirtyRectBroker().subscribe(outputIndex, onRectsCallback)` 経由。`subscriptionFactory` option (test injection) は broker 互換 shape (`(outputIndex) => BrokerSubscription`) に切替 |
| `src/engine/vision-gpu/dirty-rect-source.ts` AccessLost recovery | `_loop` 内 100ms `setTimeout` backoff を **削除**、broker negative-backoff 2s に統一 (broker 内 `invalidate(outputIndex)` 経由で marker 設定、router は broker callback 経由でしか rects 受領しないため自前 retry 不要)。`E_DUP_DISPOSED` break は broker `isDisposed` event で代替 |
| `src/engine/vision-gpu/dirty-rect-source.ts` DirtyRectRouter.stop() | `sub.dispose()` 直接呼出を **削除**、broker subscribe で受領した unsubscribe handle 経由で teardown (broker 側 reference count 管理、N consumer unsubscribe 完了で native subscription dispose) |
| `tests/unit/vision-gpu/dirty-rect-source.test.ts` (存在確認後) | broker mock injection 経由で test 維持、`subscriptionFactory` option mock を broker 互換 shape に切替。AccessLost test (`E_DUP_ACCESS_LOST` throw → 100ms backoff) は broker negative-backoff 2s に変更 (test 期待値 sync) |

### 7.3 acceptance criteria (PR-SR4-3)

- vision-gpu `DirtyRectRouter` が broker 経由で動作、`addon["DirtyRectSubscription"]` grep 結果 0 件 (untyped escape hatch 完全削除)
- 同 output index に Stage 5 + vision-gpu 同時 subscribe しても **`DXGI_ERROR_NOT_CURRENTLY_AVAILABLE` race が発生しない** (broker multiplex で native subscription 1 つだけ生存、test で機械保証)
- AccessLost recovery が broker negative-backoff 2s に統一、vision-gpu 側 100ms `setTimeout` divergence 解消
- 既存 vitest suite 全 pass、特に vision-gpu DirtyRectRouter test 全 green (broker mock injection で同等動作)
- dogfood smoke (local 環境): vision-gpu activation 中 (e.g. browser tool active) に `desktop_act` 実行 → race-loss 軸で `dxgi_dirty_rect_unavailable` に degrade しないことを実証 (現行 baseline では race-loss で degrade する scenario)

---

## 8. PR-SR4-4 (dormancy fix branch revive) scope

### 8.1 北極星 PR-SR4-4 (foreground-hwnd fallback の race-free 機能実証)

PR-SR4-4 は **`feature/adr-019-stage-5-dormancy-fix-deferred` (SHA `10982e2`) を broker semantics 下で revive する PR**。L7 (A defer) closure の最終 step、Phase 3 完了の penultimate PR。

### 8.2 改修対象 + 手順

1. **rebase OR cherry-pick** (Round 2 P3-2 代替案明示): `feature/adr-019-stage-5-dormancy-fix-deferred` は broker introduction 後 `src/engine/any-change.ts` 大幅改修で main から大幅 diverge、本 PR 着手時に **rebase conflict 大** が見込まれる。
   - 候補 (a) **rebase**: 元 branch を main rebase、conflict resolve を本 PR scope に含む。元 branch の commit history を保存
   - 候補 (b) **cherry-pick + redo**: 元 branch SHA `10982e2` から `foreground-hwnd fallback for tryVerifyAnyChange + drop unused type import` diff のみ抽出、main HEAD 上で **broker semantics に適合する新規実装として redo** (元 branch の `cache.acquireWithState` 直接参照は broker `acquire()` 経路に書き換え)
   - **Round 2 推奨**: 候補 (b) cherry-pick + redo (rebase conflict 大が見込まれるため、redo の方が review 容易 + history 線形)、PR-SR4-4 着手時に最終確定
2. **broker semantics 適合**: foreground-hwnd fallback for `tryVerifyAnyChange` が broker `acquire(outputIndex)` 経由でも機能するように再 wiring (元 branch は `cache.acquireWithState` 直接参照のため API shape 差分を吸収)。
3. **実機検証 dogfood (必須、user 確認必須)**:
   - dual-monitor host 環境で vision-gpu activation (e.g. browser tool で `browser_overview` 経由) + Stage 5 verify (`desktop_act`) を **同時実行**
   - foreground-hwnd fallback が **race-free に機能**することを confirm (race-loss 軸消滅後、fallback が空転しない)
   - notification_show で完了通知、user に dogfood 結果確認依頼
   - 不成立 → broker 設計再諮問、SR-4 plan 改訂 (親 ADR §7 dormancy fix branch revive 計画 step 5)
4. **revive PR land**: 検証成功後、本 PR を main merge
5. **docs sync**: `docs/adr-019-stage-5-followups.md` に dogfood report (≥ 1 dual-monitor + vision-gpu activation 同時実行 cycle) 永続化

### 8.3 acceptance criteria (PR-SR4-4)

- `feature/adr-019-stage-5-dormancy-fix-deferred` (SHA `10982e2`) の commit 内容が main に取り込まれる (rebase 後 OR cherry-pick + redo 後、§8.2 step 1 で確定)
- foreground-hwnd fallback for `tryVerifyAnyChange` が broker semantics 下で **race-free に機能**、実機 dogfood で実証 (user 確認済)
- **dogfood pass observable criteria** (Round 2 P2-3、user judgment 依存軽減で §8.4 trial & error 2 回上限カウント明確化):
  - **(a) race-free 実証**: dual-monitor + vision-gpu activation 同時実行で `VisualMotionObservation.cacheState == "hit-subscription"` を **N=10 cycle 連続観測** (race-loss 軸消滅実証)
  - **(b) baseline race-loss シナリオ消失**: vision-gpu activation 中の `desktop_act` で `source == "dxgi_dirty_rect_unavailable"` 発生 **0 cycle** (race-loss 由来 degrade が baseline で発生していた scenario 完全消去、§2.6 line 215 `NotCurrentlyAvailable` trigger 構造的消滅)
  - **(c) AccessLost recovery**: 任意の cycle 中に DXGI session 再起動を 1 回挿入し、`cacheState == "hit-negative-backoff"` → `"miss-init"` (2s 後) で recovery する遷移を 1 cycle 観測
  - 上記 (a)/(b)/(c) 全件達成で **PR-SR4-4 land 適格**、いずれか不達は §8.4 fallback 経路発動
- 既存 vitest suite 全 pass + 既存 cargo test 全 pass
- ADR-019 stage-5-followups.md に dogfood report 永続化 (上記 (a)/(b)/(c) 各 numeric 結果 + raw cycle log を含む)

### 8.4 実機検証不成立時の fallback (CLAUDE.md 強制命令 4 trial & error 2 回上限整合)

実機検証が 2 回連続失敗した場合、**3 回目は試さず即 Opus に判断委譲**:
- broker 設計改訂 / dormancy fix branch 改訂 / PR-SR4-4 scope 縮小 (例: foreground-fallback の broker semantics 再設計を別 PR-SR4-4b に分離) のいずれかを Opus 判断
- user 諮問で SR-4 全体 scope 改訂判断 (PR-SR4-4 を **L7 carry-over 化** + Phase 3 完了は PR-SR4-3 + PR-SR4-5 で達成、L7 は別 epic 化) の選択肢も保持

---

## 9. PR-SR4-5 (ledger closure + Phase 3 完了 announcement) scope

### 9.1 改修対象 file (docs-only)

| file | 改修 |
|------|-----|
| `docs/adr-020-path-class-refactor-plan.md` §11 | L1 (B) strikethrough + L7 (A defer) strikethrough、各 ledger 文言に "本 SR-4 PR-SR4-N で構造除去達成" 注記 |
| `docs/adr-020-path-class-refactor-plan.md` §9 | epic acceptance criteria 全件 strikethrough (Phase 3 全 4 SR land 完了 + Item A dormancy fix revive 完了 + v1.6.1 carry-over JSDoc pin 全件 strikethrough、親 ADR §9 全項目を機械的に確認) |
| `docs/adr-019-stage-5-plan.md` §2.6 | broker 後 fail-soft 2 軸最終文言 sync (PR-SR4-2 で先行 sync 済を最終確定、grep 0 件 verify) |
| `CHANGELOG.md` (利用者向け英語、強制命令 10) | "DXGI dirty-rect broker eliminates Stage 5 / vision-gpu race-loss on shared output" / "What changed / Why it matters / How to use" 三本柱で 1 entry、5-15 行程度 |

### 9.2 v1.7.0 minor release 判断 (user 諮問必須)

PR-SR4-5 merge 完了で **Phase 3 全 4 SR + Item A dormancy fix revive 全完了** = 親 ADR §9 epic acceptance criteria 全件達成。**v1.7.0 minor release 起動 trigger 解除**、user 諮問で release timing 確定 (CLAUDE.md §強制命令 1 release-process.md full read 必須、auto-merge ルール対象外)。

### 9.3 acceptance criteria (PR-SR4-5)

- 親 ADR §11 L1 / L7 ledger strikethrough 完了 (visually 確認可能、Markdown `~~text~~` syntax)
- 親 ADR §9 epic acceptance criteria 全件 strikethrough 完了 (Phase 3 epic completion 機械的確認)
- CHANGELOG entry 利用者向け英語遵守 (CLAUDE.md 強制命令 10 sweep: PR #/epic/Phase/carry-over/dogfood/北極星/silent-success/内部 path 等 0 件 grep verify)
- ADR-019 §2.6 文言 grep 0 件 (race-loss / 3 軸 fail-soft / 2 consumer 並立 関連の旧文言)

---

## 10. Open Questions (SR-4 固有、Round 1 起草時点)

### Open (Round 1)

- **OQ-SR4-1**: broker 内 multiplex 設計で **per-consumer cursor 管理** をどう実装するか?
  - 候補 (a): 1 internal buffer + per-consumer cursor (各 consumer の `next(timeoutMs)` が独立 advance)
  - 候補 (b): callback fan-out のみ (`acquire(outputIndex)` polling consumer は broker 内 batch buffer + atomic drain で simulate)
  - 候補 (c): consumer ごとに **subscription 共有なし** で別 buffer 確保 (broker は subscription dedup のみ、event delivery は per-consumer queue) — もっとも実装単純だが broker 内 memory pressure 増
  - **Round 1 推奨**: 候補 (c) を PR-SR4-1 で採用 (実装単純 + 既存 Stage 5 cache.acquire API shape 互換、memory cost は dirty rect 1 frame N rect × M consumer × 100ms budget で実用上問題なし)、PR-SR4-1 review で Opus 諮問確定
- **OQ-SR4-2**: broker `subscribe(outputIndex, callback)` の **reference count 管理**で、最後の consumer unsubscribe 後の **dispose timing** をどう決めるか?
  - 候補 (a): 即時 dispose (reference count 0 → native subscription 即 dispose)
  - 候補 (b): idle timeout `STAGE5_CACHE_IDLE_TIMEOUT_MS` (20s) 経過後 dispose (現行 cache 規範維持)
  - **Round 1 推奨**: 候補 (b) (現行 cache semantics 維持で consumer migrate 時の挙動変化 0、PR-SR4-1 で確定)
- **OQ-SR4-3**: ADR-019 §2.6 文言 sync で `"source: dxgi_dirty_rect_unavailable"` enum slot semantics に **race-loss 軸消滅注記**を入れるべきか?
  - LLM client (envelope consumer) は同 enum value を継続観測、semantics shift (race-loss → factory failure / output 無効 のみ) は **user-facing には silent**
  - 候補 (a): ADR-019 §2.6 内に historical note として明記 (developer-facing)
  - 候補 (b): CHANGELOG にも入れる (user-facing、positive impact として記載) — 利用者向けには broker 内部実装の話だが、impact は "fewer `dxgi_dirty_rect_unavailable` observations on multi-tool active session" + "Stage 5 verify reliability improved when vision-gpu is active concurrently" の positive change
  - **Round 2 推奨** (P3-3 反映): **候補 (b) 採用**、CHANGELOG は **"What changed / Why it matters / How to use" 三本柱**で broker 内部実装語を排除しつつ positive impact を user 視点で記載 (強制命令 10「How it affects me」整合)。書き方例: "Stage 5 visual-change verification is now race-free with concurrent vision-gpu activation — `desktop_act` verifyDelivery hints are more reliably populated when browser / OCR tools are active in the same session"。ADR-019 §2.6 historical note は (a) も併用 (developer-facing 詳細)
- **OQ-SR4-4**: PR-SR4-2 + PR-SR4-3 で `DirtyRectSubscriptionCache` class を **完全削除** vs **deprecated として残置** どちらが BC 安全か?
  - 候補 (a): PR-SR4-2 で完全削除 (export 削除、SR-2 sweep 規範に従い旧 API は削除)
  - 候補 (b): PR-SR4-2 で `@deprecated` jsdoc 追加 + 内部 broker wrapper、PR-SR4-3 完了後の独立 cleanup PR で削除
  - **Round 1 推奨**: 候補 (a) (`DirtyRectSubscriptionCache` は internal export `getSharedSubscriptionCache()` 経由でしか consume されない確認済、external consumer なし、SR-2 規範整合)、Opus review で `getSharedSubscriptionCache` の external usage grep 確認後確定

### Open (carry-over judgment trigger、Phase 3 完了後)

- **OQ-SR4-5 (Phase 3 完了 trigger)**: Phase 3 全 4 SR + Item A dormancy fix revive 完了後、**v1.7.0 minor release** vs **patch release for individual SR**: SR-4 完了で `__N__bytes` impact が大きい (broker 内部実装変更 + dormancy fix revive)、minor bump 妥当だが release timing は user 諮問必須 (CLAUDE.md §強制命令 1 release-process.md full read)
- **OQ-SR4-6 (post-SR-4 epic candidate)**: ADR-021 LLM E2E harness 起草 (親 ADR §6.1)、ADR-020 全 SR 完了 + Item A dormancy fix revive 完了で **trigger 解除**、user 判断で起草 timing 確定

### Resolved (Round 2、SR-4 着手前 mile-stone 参照確認、Round 2 P2-6 反映)

- **OQ-SR4-7 (親 ADR §11 L10 mile-stone 参照、SR-4 着手前判断)**: 親 ADR §11 L10 (`failWith` 経路 migrate 判断、176 callsite) は SR-2 全 PR land 後 / SR-4 着手前の mile-stone で参照確認要求あり (親 ADR §11 L10)。**判断結果 (2026-05-17 SR-4 着手前)**: **引続き別 epic carry-over**、本 SR-4 では touch しない。理由: (1) SR-4 改修は `src/engine/` 内 DXGI subscription orchestration layer で完結 (§1.3)、`failWith` 経路は handler layer で軸が異なる / (2) `failWith` 176 callsite migrate は size +1500-2000 line / PR 分割 4-5 / post-perception hook `withPostState` 再設計含む大規模 work で SR-4 同時実行は scope shrink 違反 / (3) L10 strikethrough は **Phase 3 完了時** mile-stone で再諮問 (親 ADR §11 L10 規範通り)。本 OQ で「SR-4 着手前確認 = 引続き carry-over」を docs 永続化、忘却防止 (CLAUDE.md 強制命令 9 整合)

---

## 11. Risks

| R# | risk | 対策 |
|----|------|------|
| R1 | broker introduction で既存 `DirtyRectSubscription` API contract が silent regression (e.g. `next(timeoutMs)` shape 変化、`isDisposed` semantics 変化) | PR-SR4-1 で broker `BrokerSubscription` interface を既存 `SubscriptionLike` interface と **bit-equal compatible** に lock (`next(timeoutMs): Promise<DirtyRect[]>` / `isDisposed: boolean` / `dispose(): void`)、native `DirtyRectSubscription` 自体は不変。consumer migration PR で interface compatibility regression test を追加 |
| R2 | PR-SR4-2 で Stage 5 既存 dogfood scenario (e.g. dual-monitor Excel scroll) が broker 経路で degrade | PR-SR4-2 acceptance criteria に dogfood smoke 必須項目 (§6.4)、CHANGELOG entry land 前に local smoke 完走確認 + Opus review で `verifyAnyChange` 内 cache 経路 grep sweep |
| R3 | PR-SR4-3 vision-gpu migration で `addon["DirtyRectSubscription"]` 削除に伴う test injection 経路破壊 | PR-SR4-3 で `subscriptionFactory` option を broker 互換 shape に切替 (test mock injection 経路維持)、既存 vision-gpu test 全 green を acceptance criteria 必須化。CLAUDE.md §3.2 carry-over scope shrink 整合 (既存 public API 不破壊) |
| R4 | PR-SR4-4 dormancy fix branch revive で foreground-hwnd fallback が broker semantics 下で空転 (rebase conflict resolve 不適切) | §8.4 fallback 経路 (CLAUDE.md 強制命令 4 trial & error 2 回上限) + Opus 判断委譲 + L7 carry-over 化の選択肢保持。実機検証 dogfood で 2 回連続失敗時は scope 改訂 |
| R5 | broker multiplex cursor 設計 (OQ-SR4-1) が後続 PR で interface 改訂を引き起こす | PR-SR4-1 で interface lock (草案: 候補 (c) per-consumer queue)、Opus phase-boundary review で確定後変更禁止。consumer migration PR で interface 違反検知時は PR-SR4-1 改修に戻る (CLAUDE.md §3.3 Step 0 規範) |
| R6 | ADR-019 §2.6 文言 sync が **PR-SR4-2 で先行**、**PR-SR4-3 land 前に実装が文言に追いつかない** window が発生 | PR-SR4-2 で §2.6 文言を **broker introduction 注記** + race-loss bullet 削除 (Round 2 P1-1 整理: §2.6 line 215 lock を `Unsupported`/`Other` 2 種残存 + resolver failure 軸 historical note 追記の構造) に sync するが、**race-loss 軸の structural elimination は PR-SR4-3 land で達成**と明示記載 (interim window の semantics を §2.6 内 historical note として残存)。PR-SR4-3 land で historical note 削除 + 最終文言に確定 (§6.3 + §9.1) |
| R7 | broker land 後、`src/duplication/thread.rs:297-313` L1 ring fork が **fan-out multiplex に依存しない** ことの確認漏れ + **reference count 0 時の L1 ring fork 一時停止 fallback** が未明示 (Round 2 P2-2) | PR-SR4-1 acceptance criteria に「L1 ring fork は broker 経路で動作不変」を明示、`dirty_rect_pump.rs` (Rust 側、`src/l3_bridge/dirty_rect_pump.rs`) 経由の `current_focused_element` view が broker 後も同一 event 受領を維持することを **cargo integration test (`cargo test dirty_rect_pump` 経由、Round 2 P3-4 修正: TS vitest ではなく Rust 側)** で再 verify。**reference count 0 時の挙動明示** (Round 2 P2-2 + §5 北極星 5 refinement): broker が全 consumer unsubscribe を受領 → reference count 0 → idle timeout 20s 経過後 native `DirtyRectSubscription.dispose()` 呼出 → `thread.rs` 内 `DuplicationCmd::Stop` (line 31) で thread 終了 → L1 ring fork 一時停止 → `dirty_rect_pump.rs` 経由 `current_focused_element` view 一時停止。**この一時停止 window は idle timeout 20s で抑制** (任意 consumer が再 acquire/subscribe すれば broker が native subscription 再 init、L1 ring fork 再開)、test で機械保証 (lifecycle test ~ 20 cycle で view 停止 → 再開遷移を pin) |
| R8 | PR-SR4-2 と PR-SR4-3 の **直列実行**で並走機会喪失、Phase 3 完了 timeline 延長 | CLAUDE.md §3.4 並走判断軸 1「独立 scope」を満たさない (broker semantics 実証 → 拡大の sequential 必要)、§3.4 適用外と判断。並走可能 work (CHANGELOG draft / ADR-019 §2.6 草案 / dogfood harness 整備) を background agent 経由で 並走 (CLAUDE.md §3.4 適性 list「散発的な docs sync」) |

---

## 12. Acceptance criteria (SR-4 epic 全体)

- **PR-SR4-0 〜 PR-SR4-5 全 6 PR land 完了** (sub-plan + scaffold + Stage 5 migrate + vision-gpu migrate + dormancy revive + closure、Round 2 P1-2: 「全 5 PR」誤記訂正、§3 構成と sync)
- 親 ADR §11 L1 (B) + L7 (A defer) **strikethrough 完了** (Phase 3 ledger 全件 closure、L6 は SR-2 carry-over OQ-SR2-5 で本 SR-4 とは独立)
- **ADR-019 §2.6 lock 文言が broker 後構造に bit-equal sync 完了** (Round 2 P1-1: §2.6 line 215 `NotCurrentlyAvailable` / `Unsupported` / `Other` 3 種列挙のうち race-loss `NotCurrentlyAvailable` 1 種を bullet 削除 + resolver failure 軸 historical note 追記、CLAUDE.md §3.1 grep 0 件 verify)
- **broker 後 `dxgi_dirty_rect_unavailable` emit trigger inventory は 2 軸 5 trigger** (Round 2 P1-1 整理): (A) DXGI factory error 軸 2 種 (`Unsupported` / `Other`、race-loss 消滅) + (B) resolver failure 軸 3 reason (`off_screen` / `no_monitors` / `out_of_range`、broker と独立)、broker introduction で **(A-1) `NotCurrentlyAvailable` 1 種のみ構造的消滅**
- `src/engine/vision-gpu/dirty-rect-source.ts:124-133` `addon["DirtyRectSubscription"]` untyped escape hatch **完全削除** (grep 0 件 verify)
- broker `src/engine/dxgi-broker.ts` が `DirtyRectSubscription` の唯一 constructor caller (`Grep "new.*DirtyRectSubscription\|nativeDuplication.DirtyRectSubscription" src/` で broker 内 1 箇所のみ verify)
- foreground-hwnd fallback for `tryVerifyAnyChange` が broker semantics 下で **race-free に機能** (PR-SR4-4 dogfood で §8.3 observable criteria (a)/(b)/(c) 全件達成、user 確認済)
- 既存 vitest suite 全 pass + 既存 cargo test 全 pass + dogfood smoke 完走
- Phase 3 全 4 SR + Item A dormancy fix revive **全完了**、親 ADR §9 epic acceptance criteria 全項目 strikethrough 完了 (v1.7.0 minor release trigger 解除、user 諮問で release timing 確定)
- CHANGELOG entry 利用者向け英語遵守 (CLAUDE.md 強制命令 10、PR #/epic/Phase/carry-over/北極星/内部 path 等 0 件 grep verify)

---

## 13. 関連 SSOT / 参照先

- `docs/adr-020-path-class-refactor-plan.md` — 親 ADR、§5.1 SR-4 / §11 L1+L7 / §9 epic acceptance criteria
- `docs/adr-019-anti-fukuwarai-v3-temporal-motion-observation.md` — Stage 5 parent ADR、§2.1 enum / §3 SSOT
- `docs/adr-019-stage-5-plan.md` §2.6 — fail-soft coexistence lock 現行文言 (line 215 DXGI factory error 軸 3 種列挙)、SR-4 で broker 後構造に sync (race-loss `NotCurrentlyAvailable` bullet 削除 + 残存 2 種維持 + resolver failure 軸 historical note 追記、本 sub-plan §6.3 表、Round 2 P1-1)
- `docs/adr-019-stage-5-followups.md` — dogfood 永続化先 (PR-SR4-4 で dual-monitor + vision-gpu 同時実行 cycle 追記)
- `src/engine/any-change.ts` — Stage 5 orchestrator、PR-SR4-2 で broker subscribe 経路に migrate
- `src/engine/vision-gpu/dirty-rect-source.ts` — vision-gpu DirtyRectRouter、PR-SR4-3 で broker subscribe 経路に migrate + untyped escape hatch 削除
- `src/duplication/{mod,device,thread,types}.rs` — PR #102 ADR-007 P5c-2 で land した DXGI session lifecycle、本 SR-4 で **不変** (Rust 側 native binding 改修なし)
- `src/engine/native-types.ts` / `src/engine/native-engine.ts` / `index.d.ts` / `index.js` — `DirtyRectSubscription` 型 SSOT、PR-SR4-1 で `BrokerSubscription` interface 追加
- `feature/adr-019-stage-5-dormancy-fix-deferred` (SHA `10982e2`) — A defer branch、PR-SR4-4 で revive
- memory `feedback_sub_plan_opus_review_first.md` — sub-plan 起草直後 Opus phase-boundary review mandate
- memory `feedback_sub_plan_full_reread.md` — Round 内 sub-plan 全文 re-read mandate
- memory `feedback_codex_side_effect_wave.md` — production code PR Codex 必須、CAS / lifecycle / lifetime 系副作用波 N round 検出 pattern
- memory `feedback_opus_contract_truth_sweep.md` — contract test 真意 sweep 軸 (broker test の revert/diff 検出力確認)
- memory `feedback_auto_mode_merge_opus_judgment.md` — Opus + Codex 両 Approved で AI auto-mode merge OK
- memory `project_path_class_refactor_pending.md` — path-class refactor epic 起草前 user 観察
- CLAUDE.md §3.1 (複数表 fact 整合) — ADR-019 §2.6 文言 bit-equal sync (§6.3)
- CLAUDE.md §3.2 (carry-over scope shrink) — broker introduction で `DirtyRectSubscription` typed SSOT consume 拡大、既存 public API 不破壊 (§北極星 3 + R3)
- CLAUDE.md §3.3 (PR review loop 定型) — 全 PR 必須遵守、production code PR (PR-SR4-1/2/3/4) は Codex 必須
- CLAUDE.md §3.4 (Max 20x 並走戦略) — PR-SR4-2 / PR-SR4-3 直列必須 (broker semantics 実証 → 拡大)、並走可能 work は background agent (R8)
- CLAUDE.md 強制命令 4 (trial & error 2 回上限) — PR-SR4-4 実機検証不成立時 fallback (§8.4)
- CLAUDE.md 強制命令 7 (仕組みで対応) — broker introduction 自体が「race を memory ではなく code で防ぐ」strict elaboration、§3.1 documentation 軸 analogue
- CLAUDE.md 強制命令 9 (残件は docs/) — OQ-SR4-1〜-6 を本 sub-plan §10 に永続化、memory に書かない
- CLAUDE.md 強制命令 10 (利用者向け英語) — CHANGELOG entry PR-SR4-5 で遵守

---

## 14. 起草 metadata

- 起草日: 2026-05-17 (Round 1)
- 起草 session: post-PR #348 (SR-2 PR-SR2-3) merge、user 指示「SR-4 sub-plan 起草」
- 起草前 read 済:
  - `docs/adr-020-path-class-refactor-plan.md` §5.1 SR-4 + §11 ledger (L1 / L6 / L7 / L10)
  - `docs/adr-019-stage-5-plan.md` §2.6 + §6 R10/R11 + §7 OQ #5
  - `src/engine/any-change.ts` (Stage 5 orchestrator 660 line full read)
  - `src/engine/vision-gpu/dirty-rect-source.ts` (vision-gpu DirtyRectRouter 133 line full read)
  - `src/duplication/thread.rs` 先頭 100 line (L1 ring fork + spawn 確認)
  - `docs/adr-020-phase-3-sr-2-handler-result-boundary-plan.md` 先頭 100 line (sub-plan 構造 template)
  - memory `feedback_sub_plan_opus_review_first.md` / `feedback_sub_plan_full_reread.md` / `feedback_codex_side_effect_wave.md` / `feedback_opus_contract_truth_sweep.md` / `feedback_auto_mode_merge_opus_judgment.md` / `project_path_class_refactor_pending.md`
  - 親 ADR §1.1 / §2 / §3 / §5.1 SR-4 / §8 R3+R7 / §9 / §11 L1+L7
- 着手前 grep verify:
  - `DirtyRectSubscription` consumer 2 件確認 (`src/engine/any-change.ts:339-345` Stage 5 typed + `src/engine/vision-gpu/dirty-rect-source.ts:124-133` vision-gpu untyped escape hatch)
  - dormancy fix branch SHA `10982e290f3f79ecf32bf158ba5e72c61d0986a4` 確認 (`git rev-parse feature/adr-019-stage-5-dormancy-fix-deferred`)
  - `dxgi_dirty_rect` emit caller 2 file (`src/engine/any-change.ts` + `src/tools/_input-pipeline.ts`) 確認
  - main HEAD `6d2a14e` (PR-SR2-3 merge 後) baseline 確認
- Round 1 反映: なし (起草、本 sub-plan が baseline)
- Round 2 反映 (Opus Round 1 P1×3 + P2×6 + P3×4):
  - **P1-1** (axes inventory bit-equal sync): §1.2 / §2 北極星 2 / §6.3 表 / §11 R6 / §12 acceptance を「現行 §2.6 line 215 lock 文言の DXGI factory error 軸 3 種 (`NotCurrentlyAvailable`/`Unsupported`/`Other`) + resolver failure 軸 3 reason」構造に bit-equal 再整理、broker 導入で消滅は **`NotCurrentlyAvailable` 1 種のみ** と限定。北極星抜粋 (line 16) も sync
  - **P1-2** (5 PR / 6 PR numeric count sync): §3 「5 PR 構成」→「6 PR 構成」、§3 末尾の補足、§12 「全 5 PR」→「全 6 PR」全件 sync。CLAUDE.md §3.1 Lesson 4 (numeric count sync) 同型盲点 (PR #99 D2-C0 round 3 教訓) 対応
  - **P1-3** (broker interface runtime semantics 二重 fan-out 解消): §5.2 broker interface 草案で `BrokerSubscription.subscribe` method を削除、fan-out は `DirtyRectBroker.subscribe(outputIndex, callback)` 上位 API のみで完結。consumer は acquire (polling) / subscribe (callback) のいずれか 1 経路のみ使用、二重 listening 禁止を §5.3 test で機械保証
  - **P2-1** (broker test production path 実 invoke): §5.3 acceptance に「公開 factory + injection 経路で production fallback path 実 invoke、mental simulation で revert/diff 検出力確認」明示 (memory `feedback_opus_contract_truth_sweep.md` 整合)
  - **P2-2** (reference count 0 + L1 ring fork lifecycle): §5 北極星 5 を「broker が少なくとも 1 consumer 参照中の間 active、reference count 0 + idle timeout 20s 経過時のみ一時停止」に refinement、§11 R7 に「test で機械保証 + 再 acquire/subscribe で再開」追記
  - **P2-3** (dogfood pass observable criteria): §8.3 に numeric/observable acceptance ((a) `cacheState == "hit-subscription"` N=10 cycle / (b) `dxgi_dirty_rect_unavailable` 0 cycle / (c) AccessLost recovery 1 cycle 観測) 追記、§8.4 trial & error 2 回上限カウント明確化
  - **P2-4** (L6 ledger scope 明示): line 14 関連 ledger に「L6 は SR-2 carry-over OQ-SR2-5、本 SR-4 と独立軸で touch しない」明示
  - **P2-5** (const 所有権 PR-SR4-1/2 境界): §5.3 で「PR-SR4-1 は broker 側私的複製、PR-SR4-2 で SSOT shift」明示、interim window risk 解消
  - **P2-6** (OQ-SR4-7 = 親 ADR §11 L10 mile-stone 参照): §10 Resolved (Round 2) に「SR-4 着手前判断 = 引続き別 epic carry-over」を docs 永続化
  - **P3-1** (`cache?:` option grep 結果): §6.2 表に「`Grep "cache?:" tests/unit/any-change-orchestrator.test.ts` で 0 件、deprecate-and-remove 影響範囲 internal helper のみ」明示
  - **P3-2** (rebase vs cherry-pick 代替案): §8.2 step 1 に「候補 (a) rebase / 候補 (b) cherry-pick + redo」両案明示、Round 2 推奨は (b) (rebase conflict 大の見込み)
  - **P3-3** (CHANGELOG positive impact): §10 OQ-SR4-3 を「候補 (b) 採用」に Round 2 推奨更新、CHANGELOG 書き方例も追記
  - **P3-4** (`dirty_rect_pump.rs` test path): §11 R7 を「TS vitest `tests/unit/dirty-rect-pump.test.ts`」→「Rust 側 `cargo test dirty_rect_pump`」に訂正
- Round 2 OQ 確定: OQ-SR4-7 Resolved (P2-6)、OQ-SR4-3 推奨更新 (P3-3 候補 (b))
- 次 step: Opus phase-boundary review Round 2 (background agent 再 trigger、Round 1 findings 全件反映後の P1 ゼロ + 北極星 7 件整合 + bit-equal sync 完了確認)
