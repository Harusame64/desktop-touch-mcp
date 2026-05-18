# ADR-020 — Path-class refactor epic (advisory ↔ execution boundary 整理)

- Status: **Drafted (2026-05-17、Round 6 Opus Round 3 P2×1 + Codex Round 3 反映)**
- Trigger: v1.6.1 release 完了 (issue #327 全 7 件 closure、memory `project_v170_blockers_resolved.md`) + user 観察「path-class regression 増加、責任分界点を整理したい」(memory `project_path_class_refactor_pending.md`)
- 親 epic: なし (本 epic が path-class regression の構造改修 root plan)
- 関連 ADR: ADR-007 (L1 capture / Rust migration)、ADR-010 (presentation envelope)、ADR-011 (cognitive memory)、ADR-018 (input pipeline 3tier)、ADR-019 (Stage 5 visual motion)
- 後続 epic: **ADR-021 (LLM-driven E2E harness)** — 本 epic 元 Phase 1 (軸 1) を別 epic に分離 (Round 2 OQ #3 確定)
- 関連 issue: #327 (closed 2026-05-17)
- 概念設計: 本 ADR 自体 (v1.6.1 tactical fix 6 件の **共通 drift pattern を抽出 → 構造改修で根絶**)

---

## 1. 背景

### 1.1 v1.6.1 で land した tactical fix 6 件が同型 drift だった事実

issue #327 で集約した Stage 5 dogfood 由来 degrade 7 件は、PR #328-#334 で **tactical fix のみ**で closure した (CLAUDE.md §3.3 scope discipline、user 指示「リファクタリングのタイミングでやる」)。**6 件 (B/C/D/E/F/G) 全部が "advisory layer が contract を宣言し、execution / classification / envelope layer が独立に drift する" 同型 pattern** だった (A は別軸の DXGI multiplex で defer)。

| ID | Advisory (宣言側) | Execution / Classification (実行・判定側) | drift の核 |
|----|------------------|--------------------------------------|----------|
| B | DXGI subscription cache が hit/miss を返す API contract | `DirtyRectSubscriptionCache.invalidate()` が entry を即削除 → 50ms re-init burst | TTL / negative-backoff の意味論が cache 構造に内在化されていない |
| C | `desktop-capabilities.ts` が `preferredExecutors: ["uia"]` を emit | `src/tools/desktop-executor.ts` の `executePreferred` が UIA 失敗時に silent mouse fallback (marker なし) | preferredExecutors を「希望」とだけ受け取り「使ったか」を返さない |
| D | `isModalCandidate` (pre-touch、`session-registry.ts`) が `NON_MODAL_CHROME_CONTROL_TYPES` を honour | `isModalLike` (post-touch diff、`guarded-touch.ts`) が同 filter を持たず → Pane/Document を modal と誤判定 | modal 判定が **2 関数に分裂**、どちらも自分の入力 context だけ見て判定 |
| E | `desktop-capabilities.ts` が `ValuePattern` 対応を advertise | `makeSetElementValueScript` (`uia-bridge.ts`) の name filter で当該 entity が reject | advertise したことと name filter の整合性が wire されていない |
| F | `LEASE_TTL_POLICY.baseMs` が lease TTL を宣言 | round-trip wallclock (discover→act の往復) が `baseMs` を超過し lease 即 expire | TTL 算出が round-trip wallclock を input に取らない |
| G | tool description `if_unexpected` が `try_next` / `most_likely_cause` を advertise | `buildFailureEnvelope` は **throw 経由のみ** で fire、`executor_failed` return path は素通り → SUGGESTS に matching entry がない | failure path が **throw / return の 2 系統**で envelope hook が片方にしか刺さってない |

CLAUDE.md §3.1 (ADR/plan 複数表 fact 整合) は **docs 軸**の "宣言と実装が drift する" 構造対策で、本 epic はこれの **executor 軸 analogue** に相当する。

### 1.2 「単体 OK / 繋ぐと破綻」型を検出不能だった現テスト設計

`tests/e2e/` の半分は in-process で `desktopActRawHandler` 直叩き、wire を通さず `vi.useFakeTimers` で wallclock fake (memory `project_path_class_refactor_pending.md` §6)。**#327 の 7 件全部が layer 単体 OK / 繋ぐと破綻型** で、現テスト設計では構造的に検出不能だった。

本 epic の Phase 2 (contract test) は **純粋判定 / observable marker / silent drift 禁止**の 3 軸で contract を pin する (実測ベンチ / runtime 成功保証は flaky 化を招くため範囲外、Round 2 user feedback §2-3 反映)。

### 1.3 v1.6.1 tactical fix と本 epic の関係

v1.6.1 fix は **症状除去**であって構造改修ではない (user 指示「scope discipline 維持、tactical と refactor を混ぜない」)。各 PR の JSDoc が refactor 対象点を file:line で pin している (memory `project_v170_blockers_resolved.md` §「関連 file / branch」):

- PR #328 (F): `LEASE_TTL_POLICY.baseMs` 5_000 → 15_000 ← refactor で round-trip-aware TTL 関数化
- PR #329 (G): `desktopActRawHandler` 局所 attach + `SUGGESTS.ExecutorFailed` ← refactor で内部 Result 寄せ + 最外周 boundary central converter 化
- PR #330 (E): `keyboardTypeBg` fallback ladder + `ExecutorKind: "keyboard"` (internal-only) ← refactor で `"keyboard"` first-class promotion
- PR #331 (D): `isChromeControlType` helper 抽出 + `isModalLike` 同期 ← refactor で `classifyModal(entity, context)` production API 切り出し
- PR #332 (C): `TouchResult.downgrade` marker (observability-only、silent fallback 挙動不変) ← refactor で CapabilityRegistry 一本化 + downgrade not silent
- PR #333 (B): `negative-backoff` marker + `cacheState` 5-value instrumentation ← refactor で TTL/negative-backoff semantics を cache 構造に内在化
- A defer: `feature/adr-019-stage-5-dormancy-fix-deferred` (SHA `10982e2`) を保全 ← refactor で DXGI broker 完成後に revive

---

## 2. 北極星 (North Star)

本 epic 全体で守る不変条件:

1. **対象化した path-class では advisory ⇔ execution の bit-equal 整合**: capability hint / modal classifier / tool description が宣言したことは、runtime envelope / executor 挙動 / failure path で **必ず観測可能** (silent drift 禁止)。**「全 path-class で構造的に発生不能」と言い切らない** (本 epic で touch しない path は対象外、Round 2 user feedback §5 反映)。
2. **SSOT / central boundary / contract test の 3 層で silent drift を merge ブロック**: 同型 pattern (2 関数分裂 / silent fallback / 片刺し hook) を 3 層が連動して防ぐ。
3. **既存 user-facing API surface を破壊しない**: refactor は内部構造改修、tool description / envelope shape / typed error code は backward compatible (CLAUDE.md 強制命令 10、§3.2 carry-over scope shrink)。
4. **v1.6.1 tactical fix を後退させない**: refactor 完了時点で B/C/D/E/F/G の症状が再発しないことを **Phase 2 contract test で機械的に pin** (Phase 2 が Phase 3 より先に来る理由)。

---

## 3. Epic 構成 (2 phase、Phase 2 → Phase 3)

User 討議で合意済 (memory `project_path_class_refactor_pending.md` §4-5)、Round 2 OQ #3 で Phase 1 (軸 1 LLM E2E harness) は **別 epic ADR-021 に分離**:

```
Phase 2 (軸 2、cheap + immediate)
   = contract test 追加で v1.6.1 6 不変条件を機械的に pin
   = 性質に応じて property-based / table + generated variants / 純粋関数 contract を使い分け
   = contract-first + D/F の小 refactor を含む (classifyModal 切り出し + callsite 移行 + computeLeaseTtl input 拡張)
   ↓
Phase 3 (軸 3、deep 構造改修)
   = 4 sub-refactor (SR-1 → SR-5 → SR-2 → SR-4)、Round 3 OQ #6 で SR-3 を Phase 2 統合確定
   = Phase 2 contract test が refactor 進行中の regression を即検出する safety net 役
```

**後続 epic (ADR-021)**: 実 LLM 駆動 E2E harness は本 epic 完了後に scope 起草。本 epic で責任分界点が綺麗になってから着手することで、harness 自体が drift 吸収 shim だらけになるのを防ぐ (memory `project_path_class_refactor_pending.md` §5)。

---

## 4. Phase 2 詳細 (軸 2 — contract test + D/F 小 refactor)

### 4.1 目的 + scope 明文化 (Round 3 feedback §2 反映)

v1.6.1 で fix した 6 不変条件 (B/C/D/E/F/G) を test で機械的に pin する。**Phase 3 refactor が走る前に safety net として完成**させる (Phase 3 が contract test を壊さずに改修できるかで refactor の正しさを保証)。

**Phase 2 は「contract-first + 最小 production extraction」だけでなく、D/F の小 refactor を含む** と明示する (Round 3 §2):
- D: `classifyModal(entity, context)` 切り出し + 両 callsite 移行 + `isModalCandidate` / `isModalLike` deprecate (Round 3 OQ #6 で SR-3 を Phase 2 統合確定)
- F: `computeLeaseTtlMs` の input shape 拡張 (`observedRoundTripMs` 引数追加) + cap 整合 contract pin

E/C/G/B は **既存 marker / 既存関数の test pin のみ** (production 改修なし)。

### 4.2 6 不変条件 + 性質別 test 戦略 (Round 2 OQ #2 + §2-3 user feedback 反映)

| 軸 | 修正版 contract | 性質 | 戦略 | v1.6.1 PR |
|----|---------------|------|------|----------|
| **D** | `∀ entity. classifyModal(entity, "pre-touch") ⇔ classifyModal(entity, "post-touch-diff")` (NON_MODAL_CHROME_CONTROL_TYPES filter 共有) | 純粋判定 | **property-based** (fast-check で entity arbitrary 100 runs) | #331 |
| **B** | `∀ (DXGI factory failure, elapsed). cacheState(state, elapsed) ∈ {hit-unavailable (elapsed ≤ 60s), re-validating (elapsed > 60s), ...}` (純粋状態遷移関数) | 純粋判定 | **property-based** (fast-check で elapsed/failure type arbitrary) | #333 |
| **C** | `∀ (capabilities, observed_executor). observed_executor ∈ preferredExecutors(capabilities) ∨ response.downgrade != null` (silent drift 禁止) | observable marker | **table + generated variants** (核 case 列挙 + arbitrary で variant 展開) | #332 |
| **G** | `∀ failure_code ∈ desc.if_unexpected. ∃ envelope. envelope(failure_with_code).suggests ⊇ desc.suggests[failure_code]` | observable marker | **table + generated variants** (desc.if_unexpected 各 entry を table 化、failure shape を arbitrary) | #329 |
| **F** | **(a)** `∀ observedRoundTripMs ≤ cap. computeLeaseTtlMs({...input, observedRoundTripMs}).ttlMs ≥ observedRoundTripMs` **(b)** `∀ observedRoundTripMs > cap. computeLeaseTtlMs({...}).ttlMs == cap ∧ computeLeaseTtlMs({...}).refreshRequired == true` (cap 整合 + return-shape marker、§4.4 で envelope surface NOT 確定) | 純粋関数 | **純粋関数 unit test** + property-based (observedRoundTripMs arbitrary を `[0, 2*cap]` で展開、2 branch 両方を覆う) | #328 |
| **E** | (a) `∀ entity ∈ uiaSetValue.advertised. executionPlan(entity).executors[0] == "uia"` (advertise した executor が plan trail に現れる、**Round 4 P2-4 反映: SR-5 land 後も第 1 候補 `"uia"` 固定保証 = SR-5 BC を機械 pin**) (b) `∀ failure ∈ ladder. response.fallback OR response.downgrade marker 必須` (silent success 禁止) | observable marker | **table + generated variants** (advertised entity / ladder step 各組合せ) | #330 |

**Round 2 feedback §2 (F 修正)**: 元 draft の `actual_TTL ≥ p95(round_trip_wallclock)` は実測ベンチ寄りで flaky。`computeLeaseTtlMs` の input shape に `observedRoundTripMs` を追加し **純粋関数として contract pin**、実測 p95 比較は telemetry/bench 側責務。

**Round 3 feedback §1 + Round 5 Codex P2 #1 反映 (F cap 整合 + refreshRequired surface lock)**: 現実装 `src/engine/world-graph/lease-ttl-policy.ts:23` は **cap 60_000ms** を持ち、`computeLeaseTtlMs` 出力は `clamp(raw, floor, cap)` で頭打ち。元 Round 2 contract `TTL ≥ observedRoundTripMs` だと 90s 入力で必ず fail (正しく fail する)。Round 3 修正:
- **(a) `observedRoundTripMs ≤ cap` 範囲**: 純粋関数 contract `TTL ≥ observedRoundTripMs` を保持
- **(b) `observedRoundTripMs > cap` 範囲**: TTL は cap に saturate + **`refreshRequired: true` marker** を `computeLeaseTtlMs` の **return shape のみ** に乗せる (= 内部 refactor、`DesktopSeeOutput` envelope には surface しない、§4.4 SSOT 通り)。LLM 通知は本 epic 範囲外、将来別 work で検討
- 既存 `LEASE_TTL_POLICY.cap = 60_000` は不変、新規 contract は cap 内外の 2 branch 挙動を pin する。Phase 2 で `computeLeaseTtlMs` の input 拡張 + refreshRequired marker 追加が **D/F 小 refactor の F 部分** (§4.4)。

**Round 2 feedback §3 (E 修正)**: 元 draft の `fallback_ladder(entity).completed == true` は OS/focus/対象アプリ都合で失敗し得る。「成功保証」ではなく「advertise した executor が execution plan に現れる + 失敗時 explicit fallback/downgrade marker 必須 + silent success 禁止」に弱化。

### 4.3 test 配置 (Round 2 feedback §1 反映)

`vitest.config.ts` の現 `include` は `tests/unit/**`, `tests/e2e/**`, `tests/integration/**` のみ。本 plan では **`tests/unit/path-class-contract/*.test.ts`** に配置 (新 ディレクトリ作るが既存 include 規約に乗る、config 変更不要)。

代替案 (要諮問): `vitest.config.ts` に `tests/contract/**` を追加し `tests/contract/path-class/` 配下に置く形は config 変更が ADR scope 拡張になるため棄却 (Round 2 §1 で user 指摘の通り「config 変更を ADR に明記」しないなら既存規約に乗せる方が安全)。

### 4.4 production change の境界 (Phase 2 で許容する D/F 小 refactor)

Round 3 §2/§3 反映で Phase 2 は **contract-first + D/F 小 refactor** と明文化。以下のみ production 改修許容、それ以外の runtime 挙動変更は禁止 (それは Phase 3):

- **D: `classifyModal(entity, context)` production API 切り出し + callsite 移行 + deprecate** (Round 2 OQ #5 + Round 3 OQ #6 反映): 既存 `isModalCandidate` / `isModalLike` から `classifyModal(entity, context: "pre-touch" | "post-touch-diff")` の 1 関数化、両 callsite (`session-registry.ts` + `guarded-touch.ts`) を新 helper consume 化、`NON_MODAL_CHROME_CONTROL_TYPES` を classifier 内 private 定数化、旧 2 関数を deprecate (内部 re-export 残すか完全削除は PR-P2-1 review で確定)。Round 3 OQ #6 で **SR-3 を Phase 2 に統合確定**、Phase 3 から SR-3 削除。
- **F: `computeLeaseTtlMs` input 拡張 + refreshRequired marker 追加** (Round 3 §1 + Round 4 P2-1/P2-2 反映): 現 input shape (`view` / `entityCount` / `payloadBytes`) に `observedRoundTripMs?: number` 追加、cap 内は `max(raw, observedRoundTripMs)` を `clamp(_, floor, cap)`、cap 超え時 `refreshRequired: true` を return shape に乗せる (`computeLeaseTtlMs` 単純数値 return → `{ ttlMs, refreshRequired }` shape 変更)。
  - **callsite scope (Round 4 P2-1 grep 確認済)**: production callsite は **`src/tools/desktop.ts:392` 1 箇所のみ**。`LeaseStore.issue(entity, viewId, ttlMs?: number)` API は本 epic で touch しない (= `desktop.ts:392` で return shape を unwrap して `ttlMs` 数値だけ `lease-store.issue()` に渡す)。
  - **`refreshRequired` 置き場所 (Round 4 P2-2 確定: 案 1)**: marker は `computeLeaseTtlMs` の **return shape のみ**、`DesktopSeeOutput` envelope には surface しない (= 内部 refactor 完結、tool description 拡張 / CHANGELOG entry 不要、強制命令 10 範囲外)。LLM 通知 (>60s 思考は再 see() シグナル) は **本 epic 範囲外**、将来別 work で検討 (ADR-021 LLM E2E harness 起草時に pair で再諮問)。
- **observable marker 既存化**: v1.6.1 で導入済 `TouchResult.downgrade` / `cacheState` / `envelope.suggests` 等は Phase 2 で **public export 整理のみ** 許可 (型 export / barrel re-export)、新 marker 追加禁止 (E/C/G/B は marker 既存、Phase 3 で SSOT 化)。

### 4.5 Phase 2 sub-plan (PR 単位想定)

Phase 2 全体で 2-3 PR を想定 (D/F 小 refactor を独立 PR 化、test 群は最終 PR で一気に land):

- **PR-P2-1 (D refactor)**: `classifyModal(entity, context)` 切り出し + 両 callsite 移行 + `isModalCandidate` / `isModalLike` deprecate。production code 改修のみ、test pin は PR-P2-3 で。
- **PR-P2-2 (F refactor)**: `computeLeaseTtlMs` input 拡張 (`observedRoundTripMs?`) + return shape 変更 (`{ ttlMs, refreshRequired }`) + 全 callsite 移行 + cap 整合 logic 実装。production code 改修のみ、test pin は PR-P2-3 で。
- **PR-P2-3 (contract test)**: `fast-check` dev dep 導入 + 6 contract test 全件 land (D/F は PR-P2-1/-2 後の API shape を pin、E/C/G/B は既存 marker を pin) + helper export 整理。

PR-P2-1 と PR-P2-2 は **scope disjoint** (modal vs lease TTL)、worktree 並走可能 (CLAUDE.md §3.4)。PR-P2-3 は両者 land 後に着手。

### 4.6 Phase 2 acceptance criteria (Round 3 §4 反映で revert 実証コスト緩和)

- `fast-check` dev dep 導入 + `tests/unit/path-class-contract/` 6 test 全件 green
- 各 property-based test が **100 random runs / shrinking 有効** で安定 pass
- **各 contract が対応 regression fixture を持つ** (test ファイル内に「この fixture は PR #XXX の症状を再現」と JSDoc pin)
- **代表 2-3 件 (D + F + 1 件)** で v1.6.1 fix を意図的 revert/diff し対応 test が必ず fail (検出力実証、6 件全部の revert PR は作らず手元 diff 確認 + PR-P2-3 説明に commit hash + 期待 fail 一覧で pin)。**3 件目 candidate (Round 4 P3-1 反映で事前列挙)**: C (#332 `TouchResult.downgrade` marker は 1-line marker 追加が revert 単純) / G (#329 `SUGGESTS.ExecutorFailed` entry 削除 + `desktopActRawHandler` 局所 attach 削除で 2-block revert) / B (#333 `cacheState` 5-value instrumentation revert は state machine 複雑、revert cost 最大) のうち **C を recommend** (revert cost 最小 + downgrade marker contract が C 軸そのものを pin できる)、PR-P2-3 review で user 最終確定
- Phase 2 land 後、Phase 3 sub-plan PR で 1 件でも contract test が破れたら **merge 禁止**
- `classifyModal` / `computeLeaseTtlMs` (新 shape) が production callsite から consume されている (drift entry 経路を物理的に塞ぐ)

---

## 5. Phase 3 詳細 (軸 3 — 構造改修、4 SR、Round 3 OQ #6 で SR-3 Phase 2 統合確定)

### 5.1 sub-refactor 4 件 + 着手順序確定

着手順 (Round 2 OQ #1 + Round 3 OQ #6 反映): **SR-1 → SR-5 → SR-2 → SR-4** に縮約。SR-3 (modal classifier) は **Phase 2 PR-P2-1 に統合** (§4.4 参照)、Phase 3 から削除。

**warm-up 役の喪失について (Round 4 P2-3 反映で論拠補強)**: 元 Round 2 で SR-3 を warm-up に置いた狙いは「reviewer の refactor pattern 慣熟」だったが、Phase 2 全体 (PR-P2-1 + PR-P2-2 + PR-P2-3) で D/F 小 refactor + contract test 確立を経るため、Phase 3 SR-1 着手時には refactor pattern は既に十分慣熟されている (warm-up を別途置く必要なし)。

**ただし** Phase 2 D/F 慣熟は SR-1 (CapabilityRegistry 一本化、tool description 生成 / desktop-capabilities / desktop-executor の 3 SSOT 整合) と **domain が異なる** (Opus P2-3 指摘)。慣熟 transfer に依存せず、別経路で warm-up を担保する:
- SR-1 sub-plan 起草時に **API surface (CapabilityRegistry interface 定義 + consumer migration shape) を別途 Opus phase-boundary review** に晒す (CLAUDE.md §3.3 Step 1 phase-boundary review を SR-1 sub-plan PR でも適用)
- SR-1 は **既存 PR #332 (C tactical fix)** が `desktop-capabilities` 経路を既に局所触れている範囲を baseline として、SR-1 sub-plan は #332 の差分から段階的拡張する形に sub-plan で scope 確定
- 規模 600-900 line を **3-4 PR sub-plan 分割** (registry interface land → desktop-capabilities consumer 化 → desktop-executor 経路化 → tool description derive) を SR-1 sub-plan で具体化

#### SR-1: `CapabilityRegistry` 一本化

- **目的**: `desktop-capabilities.ts` / `desktop-executor.ts` / tool description を **1 SSOT から derive**、advertise と execution の drift を構造的に不能化。
- **scope outline**: 新規 `src/capabilities/registry.ts` で `CapabilityRegistry` interface 定義 → `desktop-capabilities` を registry consumer 化 → `desktop-executor` が registry から `preferredExecutors` を取得 → tool description 生成も registry derive。
- **影響 PR pin**: C (#332)、E (#330) — どちらも advisory ⇔ execution drift の核。
- **size 見積**: ~600-900 line (中規模 refactor、tool description 生成 helper の re-wire 含む)。

#### SR-5: `"keyboard"` ExecutorKind first-class promotion

- **目的**: E fix で internal-only として導入された `ExecutorKind: "keyboard"` を **advertised executor に昇格**、`preferredExecutors` で明示選択可能化。
- **scope outline**: `ExecutorKind` 型に `"keyboard"` を first-class member として追加 → `desktop-capabilities` (= SR-1 完了後の CapabilityRegistry) が `ValuePattern + KeyboardWritable` 両対応 entity に `preferredExecutors: ["uia", "keyboard"]` を emit → tool description の `executor` field 候補に `"keyboard"` 公開 → CHANGELOG entry (user-facing、CLAUDE.md 強制命令 10)。
- **影響 PR pin**: E (#330)
- **size 見積**: ~400-600 line + CHANGELOG。
- **依存**: SR-1 (CapabilityRegistry 一本化) 完了後の自然 follow-up。

#### SR-2: 内部 Result 寄せ + `_envelope.ts` central converter + handler 最外周 try/catch 共通 pattern (Round 4 P1-3 確定: (c)+(b) ハイブリッド)

- **目的**: 全 handler の failure path を **内部は `Result.err(typedError)` に寄せる**、**`_envelope.ts` 中の converter helper 1 箇所が Result.err と unexpected throw の両方を `buildFailureEnvelope` に変換 ((c) 中央集中)**、**各 tool handler の最外周 try/catch を共通 pattern で統一 ((b) handler-level boundary)**。`executor_failed` return path のような silent bypass を構造的に根絶しつつ、SDK Server prototype 拡張 ((a) 案) は BC リスクで採用しない。
- **scope outline (Round 4 P1-3 確定)**:
  - **(c) converter 中央集中**: `src/tools/_envelope.ts` 内に `toFailureEnvelope(result: Result<Ok, Err>): Envelope` (仮称) を **唯一の export converter** として配置。**Round 5 Codex P2 #2 で確認: `buildFailureEnvelope(...)` の実 caller は `_envelope.ts` 内 6 箇所のみ** (line 2910 / 2990 / 3252 / 3267 / 3282 / 3297、定義 line 1197)、`_errors.ts` / `desktop-register.ts` は comment / import / 名前参照のみで実 call なし → **(c) converter 中央集中は実質的に既達成**、SR-2 で追加する work は `_envelope.ts` 内 6 callsite を新 `toFailureEnvelope(result)` helper 経由に統一する形 (= file 単位の caller 整理 work は不要)
  - **(b) handler 最外周 try/catch 共通 pattern**: 各 tool handler (~30 件) の最外周 try/catch を `try { ... return ok } catch (e) { return toFailureEnvelope(toResultErr(e)) }` の共通 pattern で統一、handler 内部は throw / Result.err 両方許容。**SR-2 主 scope はこの部分** (Round 5 で (c) 既達成判明により明確化)
  - **(a) 案は不採用**: `src/server-windows.ts` の `server.tool()` register 時 wrapper 噛ませる案は MCP SDK Server prototype 拡張が変則 + handler 30+ 件 internal envelope 構築の全 rewrite で BC リスク高、北極星 3 (既存 user-facing API surface 不破壊) と衝突
  - **新規 type**: `src/types/result.ts` で `Result<Ok, Err>` 型 + helper 定義 → handler 内部 control flow を `Result.err(typedError)` に寄せ
  - **`executor_failed` の `return` 統一**: `Result.err(new ExecutorFailedError(...))` に書き換え + handler 最外周共通 pattern で envelope 化
  - **実コード status (Round 5 grep 確認済)**: `src/server-windows.ts` + `src/server-linux-stub.ts` の 2 file が MCP server entry、`buildFailureEnvelope` **実 caller は `_envelope.ts` 内 6 箇所のみ** (Round 4 で「caller 3 file」と書いたのは grep file count を caller と誤認、Codex P2 #2 で訂正)
- **影響 PR pin**: G (#329)
- **size 見積**: ~600-900 line (Round 5 で (c) 既達成判明により ~800-1200 から下方修正、handler 30+ 件の最外周 try/catch 統一 + `_envelope.ts` 内 6 callsite の `toFailureEnvelope` 経由化が主体、sub-plan で 2-3 PR 分割、R2 + §10 OQ #7 参照)
- **採用論拠**: SR-2 元意図「buildFailureEnvelope を唯一 hook」を **converter 関数 1 箇所** として実現、handler-level boundary は共通 pattern で形式統一、SDK prototype 非依存で内部 refactor / BC 維持を両立

#### SR-4: vision-gpu / Stage 5 DXGI broker (broker owner 1 つ固定、Round 2 OQ #4 反映)

- **目的**: 2 subscription 共存不能問題 (Item A defer、memory `project_v170_blockers_resolved.md` §「Item A defer 根拠」) を、**broker owner 1 つ固定 + consumer subscription/view ぶら下げ** 設計で構造解消。
- **scope outline (Round 2 OQ #4 確定)**:
  - **broker owner**: 1 つ固定 (新規 `src/perception/dxgi-broker.ts` で DXGI subscription lifecycle を独占管理)
  - **consumer**: vision-gpu `DirtyRectRouter` + Stage 5 visual-motion subscriber が **broker subscribe API** 経由でぶら下がる
  - **factory failure / negative-backoff / dormancy semantics**: 全て **broker 内に集約** (各 consumer は marker / envelope だけ受け取る、自前で DXGI 再 init 試行しない)
  - **dormancy fix branch revive**: broker 完成後に `feature/adr-019-stage-5-dormancy-fix-deferred` (SHA `10982e2`) を broker semantics に合わせて rebase → 実機検証 → revive PR
- **影響 PR pin**: A (defer), B (#333) — Item A の真の fix + B cache lifecycle の broker 経由統合
- **size 見積**: ~1000-1500 line (DXGI lifecycle 含む native binding 改修、要 Opus 厚め + Codex 必須)
- **risk**: 既存 vision-gpu user が dormant 中の挙動を broker 経由で破壊しないか、`docs/adr-019-stage-5-plan.md` §2.6 の "documented fail-soft" を維持できるか (§8 R3 参照)。
- **fail-soft semantics shift (Round 4 P3-2 反映)**: ADR-019 §2.6 既存 "fail-soft coexistence" は **vision-gpu と Stage 5 が DXGI 同一 output で race して `NotCurrentlyAvailable` → `dxgi_dirty_rect_unavailable` 縮退** という double-owner race 前提の fail-soft。SR-4 broker owner 1 つ固定はこの **race そのものを解消** する設計のため、fail-soft の発火条件が **race-loss 軸消滅** で `(a) DXGI factory failure / (b) output index 無効` の 2 軸のみに縮約される。SR-4 sub-plan 起草時に ADR-019 §2.6 文言と新 broker 設計の fail-soft 軸を bit-equal sync する fact 整合 sweep (CLAUDE.md §3.1) を必須化。

### 5.2 Phase 3 acceptance criteria

各 SR PR 共通:
- Phase 2 contract test 6 件全て green 維持 (refactor 完了状態でも v1.6.1 不変条件保持)
- 既存 vitest suite 全 pass + native cargo test 全 pass
- Opus 3+ round review + Codex 必須 1+ round (CLAUDE.md §3.3 Step 0 production code 改修 PR)
- CHANGELOG entry (user-facing) は SR-5 のみ必須 (他は内部 refactor、user 影響なし)

Phase 3 epic completion:
- **4 SR 全 land** (SR-1 / SR-5 / SR-2 / SR-4) + Item A dormancy fix revive 完了 (Round 4 P1-1 で "5 SR" → "4 SR" 同期、Round 3 OQ #6 で SR-3 を Phase 2 統合確定済)
- v1.6.1 tactical fix の JSDoc carry-over pin 全件 strikethrough (refactor で症状除去ではなく構造除去達成を pin)

---

## 6. 後続 epic 切り出し (ADR-021、Round 2 OQ #3 確定)

元 draft Phase 1 (実 LLM 駆動 E2E harness) は **別 epic ADR-021 に分離**。本 epic は Phase 2/3 で閉じる。

### 6.1 ADR-021 scope outline (起草は本 epic 完了時)

- `tests/e2e-real/llm-driver.ts` で stdio MCP server 実起動 + Anthropic SDK driver
- production hook 拡張 3 件: (i) "fake time off" mode、(ii) observability marker (本 epic Phase 3 後)、(iii) `ReplayBackend` extend
- CI nightly 専用 (重い、flaky 0 厳格)

### 6.2 ADR-021 起草 trigger

本 epic Phase 3 完了 + Item A dormancy fix revive 完了。それまで本 epic に集中、harness 設計は責任分界点が綺麗になった後で再検討する (memory `project_path_class_refactor_pending.md` §5)。

---

## 7. dormancy fix branch revive 計画 (SR-4 内付帯作業)

`feature/adr-019-stage-5-dormancy-fix-deferred` (SHA `10982e2`) は Item A defer 時に保全したブランチ。SR-4 (DXGI broker) 完了後に以下手順で revive:

1. SR-4 PR land → broker pattern が main に入る
2. dormancy fix branch を main rebase
3. broker subscribe API 経由で foreground-fallback dormancy semantics が成立するか実機検証
4. 成立 → 新 PR で revive land、Item A 完全 closure
5. 不成立 → broker 設計再諮問、SR-4 plan 改訂

---

## 8. Risks

| R# | risk | 対策 |
|----|------|------|
| R1 | Phase 2 fast-check 導入で test 実行時間が膨らむ | 100 runs / per-property に上限、CI で並列実行、純粋関数 contract (F) と table (C/G/E) は fast-check 不使用で実行時間軽い |
| R2 | Phase 3 SR-2 (Result 寄せ + central converter) が handler 多数で merge conflict 多発 | sub-plan で SR-2 を更に **2-3 PR 分割** (handler 群ごと、Round 6 で §5.1 SR-2 ~600-900 line 規模に sync、(c) 既達成判明により Round 5 で size 下方修正済) |
| R3 | Phase 3 SR-4 (DXGI broker) で vision-gpu user が dormant 中の挙動を broker 経由で破壊 | broker 完成後 dormancy fix revive で実機検証、`docs/adr-019-stage-5-plan.md` §2.6 fail-soft contract 維持 |
| R4 | Phase 2 contract test が **production runtime path の expression** に偏り、internal helper 実装変更で easily 壊れる brittle test 化 | helper export を **minimum** に絞る、contract test は **observable behavior** を assert (internal helper signature 直接 assert 禁止、ただし classifyModal は production API として切り出すので例外、§4.4) |
| R5 | Phase 3 refactor 中に v1.6.1 fix が後退 (regression) | Phase 2 contract test を **safety net** として merge ブロッカー化、§4.6 acceptance criteria 厳格遵守 |
| R6 | SR-5 (`"keyboard"` first-class promotion) で既存 LLM client が `preferredExecutors: ["uia"]` 既定挙動に依存 (e.g. 配列 `[0]` blind 取得 vs union 取得で behavior diverge) | CHANGELOG 警告 (CLAUDE.md 強制命令 10) **+ Phase 2 contract test E (a) で `executionPlan.executors[0] == "uia"` 固定保証を機械 pin** (Round 4 P2-4 反映、§4.2 E 行)、既存 envelope shape は backward compatible 維持 |
| R7 | Phase 2 で確立する `classifyModal` (PR-P2-1) / `computeLeaseTtlMs` 新 shape (PR-P2-2) が後続 Phase 3 4 SR (SR-1/5/2/4) の方針と矛盾する API shape に固まる (Round 5 Codex P2 #3+P3 反映: Phase 3 は 4 SR、SR-3 は Phase 2 統合済) | PR-P2-1 / PR-P2-2 review で **SR-1/5/2/4 sub-plan 起草前の API shape 確認** を Opus checklist に追加 (CLAUDE.md §3.1 fact 整合 sweep の拡張)。SR-1 (CapabilityRegistry SSOT) は `classifyModal` の context 引数を consumer 候補として接続点を持つので、PR-P2-1 land 後の SR-1 sub-plan 起草時に API shape bit-equal sync 必須 |

---

## 9. Acceptance criteria (epic 全体、Round 2 feedback §5 反映)

- ~~Phase 2 全 6 contract test green + v1.6.1 fix revert で必ず fail (検出力実証、§4.6 で代表 2-3 件に緩和)~~ — **CLOSED 2026-05-17 by Phase 2 PR-P2-3 (#338)**: 5 contract tests + fast-check property-based variants land, revert-and-fail evidence captured in the PR description per §4.6.
- ~~**Phase 3 全 4 SR land** (SR-1 / SR-5 / SR-2 / SR-4) + Item A dormancy fix revive 完了 + Phase 2 contract test 全 green 維持~~ — **CLOSED 2026-05-18 by ADR-020 SR-4 PR-SR4-0..PR-SR4-4 (#349 / #350 / #353 / #354 / #360)** on top of SR-1 / SR-5 / SR-2 land earlier in Phase 3. Item A revived in PR-SR4-4 (#360, see §11 L7). Phase 2 contract tests still green on `main`.
- v1.6.1 carry-over JSDoc pin (PR #328-#334) **全件 strikethrough** (構造的根絶を pin) — **PARTIAL CLOSURE 2026-05-19 (本項 strikethrough 化せず、L6 残存のため)**: L1 (B) + L7 (A defer) は PR-SR4-5 (#361) で flip 完了 (SR-4 epic 完了による構造除去)。**L2 (C) / L3 (D) / L4 (E) / L5 (F) は本 ledger 統一 PR (2026-05-19) で §11 checkbox を `[x]` + `~~text~~` flip 完了** — 構造除去 work はそれぞれ SR-1 (#340 / #341 / #342) / Phase 2 PR-P2-1 (#336) / SR-5 (#344 / #345) / Phase 2 PR-P2-2 (#337) で既 land 済、本 PR は ledger fact integrity の同期 sweep。**L6 (G) のみ partial closure** per Round 4 (2026-05-17) — `desktopActRawHandler` + 4/6 callsite SR-2 移行済、残 `_envelope.ts:2978`/`:3058` + `desktopActRawHandler:596-606` 統一は **OQ-SR2-5 carry-over** (別 epic / 別 PR で完全 closure 予定、§11 L6 行は `[ ]` のまま保持)。本項の strict reading は「全件 strikethrough」だが L6 G partial closure 残存のため、本項は **strikethrough 化せず "PARTIAL CLOSURE" 見出しを平文で残す**。完全 closure は OQ-SR2-5 解消後の別 PR で実施。
- ~~**本 epic で対象化した path-class (B/C/D/E/F/G) に限り、SSOT / central boundary / contract test の 3 層により silent drift が merge できない** (全 path-class に拡張する強い言い切りは避ける、Round 2 §5)~~ — **CLOSED 2026-05-18**: B (broker SSOT + cacheState contract test) / C (CapabilityRegistry SSOT + downgrade marker contract test) / D (`classifyModal` central boundary + modal classification contract test) / E (`keyboardTypeBg` central + observable marker contract test) / F (`computeLeaseTtlMs` pure helper + property-based contract test) / G (envelope converter central + handler最外周 try/catch、L6 部分 carry-over は OQ-SR2-5 残存だが「3 層 drift 検知不能」要件は SR-2 で達成済) の **3 層 silent-drift 検知体制が SSOT / central boundary / contract test の 3 軸で完成**。
- ~~ADR-021 (LLM E2E harness) 起草 trigger 解除~~ — **TRIGGER 解除条件達成 2026-05-18 (本 PR-SR4-5 merge 時点)**: §6.2 が定義する trigger 解除条件 (「Phase 3 完了 + Item A revive 完了」) が達成された。本 acceptance bullet は **「起草 trigger が解除可能な状態に到達」を満たす条件** であり、ADR-021 起草自体は未実施 (drafting timing は user 諮問、別 step)。「trigger 解除」 ≠ 「起草実施」。

---

## 10. Open Questions (Round 2 で確定 / 残存)

### Resolved (Round 2)

- ~~**OQ #1**: Phase 3 SR-1〜SR-5 着手順序~~ → Round 2 で **SR-3 → SR-1 → SR-5 → SR-2 → SR-4** 仮確定、Round 3 OQ #6 で SR-3 を Phase 2 統合し **Phase 3 は SR-1 → SR-5 → SR-2 → SR-4 の 4 SR 構成** に最終確定 (SR-4 先行は DXGI lifecycle 不確実性が大きく、Phase 2 safety net + 小型 refactor 経験値が入ってから着手)
- ~~**OQ #2**: fast-check 採用 vs 代替~~ → **fast-check 採用、ただし全件 property-based にしない**。D/B = property、C/G = table + generated variants、F/E = 純粋関数化 / observable marker contract (§4.2 表反映)
- ~~**OQ #3**: Phase 1 を本 epic 内 / 別 epic~~ → **別 epic ADR-021 に分離**、本 epic は Phase 2/3 で閉じる (§6 反映)
- ~~**OQ #4**: SR-4 broker pattern lifecycle~~ → **broker owner 1 つ固定、consumer は subscription/view としてぶら下げ、factory failure / negative-backoff / dormancy semantics は broker 集約** (§5.1 SR-4 反映)
- ~~**OQ #5**: D の helper 露出許容~~ → **`isModalLike` public 化ではなく、新規 `classifyModal(entity, context)` を production API として切り出し**、両 callsite + test がそれを consume (§4.4 反映)

### Resolved (Round 3)

- ~~**OQ #6**: SR-3 を Phase 3 に薄く残す vs Phase 2 統合~~ → **Phase 2 に統合確定** (§4.4 + §5.1)。Phase 3 から SR-3 削除、4 SR (SR-1/5/2/4) 構成に。

### 残存 (新規含む)

- **OQ #7**: SR-2 sub-plan 分割 (§8 R2) で handler 群ごとの境界をどう切るか? 候補: (a) tool category ごと (browser/desktop/excel/...) (b) failure path 系統ごと (executor_failed/timeout/validation/...) (c) その他。SR-2 sub-plan 起草時に再諮問。
- **OQ #8**: `vitest.config.ts` を将来 `tests/contract/**` 追加に拡張する判断 (§4.3 代替案)。本 epic では `tests/unit/path-class-contract/` で閉じるが、後続 epic で contract test が他軸 (UI / wire / API contract 等) に広がる場合、config 拡張を ADR-021 or 別 epic で扱うか?
### Resolved (Round 4)

- ~~**OQ #9**: F refactor の `computeLeaseTtlMs` return shape 移行 scope~~ → **Round 4 P2-1 grep で確認: production callsite は `desktop.ts:392` 1 箇所のみ**、`LeaseStore.issue(ttlMs?: number)` API は本 epic 範囲外で touch しない。**shape 変更を受け入れ 1 callsite 移行 (案 (b))** で PR-P2-2 scope に収まる、`desktop.ts:392` で unwrap (`{ ttlMs, refreshRequired }` → `ttlMs` 数値) して既存 `lease-store.issue()` API に渡す形 (§4.4 F bullet 反映済)。

---

## 11. Carry-over ledger (v1.6.1 PR JSDoc file:line pin + Round 2 追加)

本 epic 完了時に strikethrough。

- [x] ~~**L1 (B)**: PR #333 `DirtyRectSubscriptionCache.invalidate()` negative-backoff marker + `cacheState` 5-value instrumentation → SR-4 (broker 経由 cache lifecycle 統合) で構造除去 — **着手 trigger 解除 2026-05-17 (SR-4 sub-plan PR-SR4-0 land 時)**、SR-4 sub-plan `docs/adr-020-phase-3-sr-4-dxgi-broker-plan.md` §5 (PR-SR4-1) + §6 (PR-SR4-2) + §7 (PR-SR4-3) で broker introduction + consumer migration 完了時 strikethrough~~ — **CLOSED 2026-05-18 by ADR-020 SR-4 PR-SR4-0..PR-SR4-3 (#349 / #350 / #353 / #354)**: `DirtyRectSubscriptionCache` class was deleted in PR-SR4-2 (#353) and replaced by `src/engine/dxgi-broker.ts` (PR-SR4-1 #350). `cacheState` 5-value instrumentation moved to the broker SSOT (`BROKER_CONSTANTS` re-exported as `STAGE5_CONSTANTS`). `negative-backoff` is now broker-internal state, not a consumer-side marker. vision-gpu also migrated through the broker in PR-SR4-3 (#354), eliminating the untyped `addon["DirtyRectSubscription"]` escape hatch (grep 0 hits). Race-loss `NotCurrentlyAvailable` is **structurally impossible** on every consumer path.
- [x] ~~**L2 (C)**: PR #332 `TouchResult.downgrade` observability marker → SR-1 (CapabilityRegistry 一本化、downgrade not silent) で構造除去~~ — **CLOSED 2026-05-19 by ADR-020 SR-1 (#340 / #341 / #342)**: `src/capabilities/registry.ts` を SSOT として新設、`desktop-capabilities.ts` は thin wrapper に縮約 (#340)。`toolDescriptionAdvisory()` で advisory を registry から derive (#341)。`createDesktopExecutor` が `preferredExecutors` を block entry eligibility として consume するため、UIA→mouse の silent fallback は構造的に発生不能 — registry rule table に明示された executor 以外を実行する経路が存在しない (#342)。PR #332 で導入した `TouchResult.downgrade` marker は observability instrumentation として残置 (correctness 担保は registry 側に移行)。
- [x] ~~**L3 (D)**: PR #331 `isChromeControlType` helper 共有 → **Phase 2 PR-P2-1** で `classifyModal` 切り出し + 両 callsite 移行 + 旧 2 関数 deprecate で構造除去 (Round 3 OQ #6 で SR-3 を Phase 2 統合確定、Phase 3 SR-3 削除)~~ — **CLOSED 2026-05-19 by ADR-020 Phase 2 PR-P2-1 (#336)**: `classifyModal(entity, context, options?)` を `session-registry.ts` に新設、`isModalLike` private 関数は完全削除、`isModalCandidate` は thin deprecated wrapper として `classifyModal` に delegate。pre-touch / post-touch-diff 両 context の core predicate (UIA-sourced + `role:"unknown"` + non-chrome controlType) を **1 関数に統合** したことで chrome-exclusion clause の 2-function drift が構造的に発生不能。5 callsite (`session-registry.ts:327,332` + `guarded-touch.ts:260,261,267`) 全て移行済、`tests/unit/classify-modal.test.ts` 10 case で contract 機械 pin。
- [x] ~~**L4 (E)**: PR #330 `keyboardTypeBg` internal fallback ladder + `ExecutorKind: "keyboard"` (internal-only) → SR-5 (first-class promotion) で構造除去~~ — **CLOSED 2026-05-19 by ADR-020 SR-5 (#344 / #345)**: `AdvertisedExecutorKind` を 4 → 5 executor 拡張、`hasValue`-only rule table branch を `["uia", "keyboard"]` advertise に改修 (#344)。`createDesktopExecutor` に 5 番目 keyboard block を mouse fallback 直前に追加し、`preferredExecutors: ["keyboard"]` 単独 set の entity に対する **direct keyboard 経路を first-class で opening** (#345)。CHANGELOG entry も user-facing 英語で追加 (CLAUDE.md 強制命令 10)。OQ-SR5-1 は bare `"keyboard"` return contract (PR #330 確立) を維持する exit (1) で closure、UIA→keyboard internal recovery は `["uia", "keyboard"]` entity で bit-equal 動作。
- [x] ~~**L5 (F)**: PR #328 `LEASE_TTL_POLICY.baseMs` 15_000 既定値 → **Phase 2 PR-P2-2** で `computeLeaseTtlMs` input 拡張 (`observedRoundTripMs?`) + cap 整合 2 branch + `refreshRequired` marker 追加で構造除去 (cap 60s は不変、実測 p95-aware 化は telemetry 側責務で本 epic 範囲外、Round 3 §1 反映)~~ — **CLOSED 2026-05-19 by ADR-020 Phase 2 PR-P2-2 (#337)**: `computeLeaseTtlMs` の input に `observedRoundTripMs?` を追加、return shape を `number` → `{ ttlMs, refreshRequired }` に変更し cap-aware 2-branch contract を明示化 (branch (a): observed ≤ cap → `clamp(max(raw, observed), floor, cap)` + `refreshRequired=false` / branch (b): observed > cap → cap saturate + `refreshRequired=true`)。`LeaseStore.recordAct(viewId)` + `consumeObservedRoundTripMs()` を read-once semantics で新設、`guarded-touch.ts:328` の execute 直前 pre-record pattern で round-trip wallclock を捕捉。`desktop.ts:390-422` で defaultTtlMs / function 両 branch を `{ ttlMs, refreshRequired }` object に正規化 (silent-fail prevention)。`refreshRequired` は `computeLeaseTtlMs` return shape のみ、envelope surface しない (Round 4 P2-2 lock 維持)。
- [ ] **L6 (G) — 部分 closure** (Round 4 確定 2026-05-17): PR #329 `desktopActRawHandler` 局所 attach + `SUGGESTS.ExecutorFailed` → SR-2 で **4/6 callsite (memory upper bound) converter 経由統一 + handler 29 件 failWith 既存達成 = 部分 closure**。残 2 callsite (`_envelope.ts:2978` lease validation + `:3058` handler throw fallback) + `desktopActRawHandler:596-606` executor_failed return path 統一 = **OQ-SR2-5 carry-over** (SR-2 sub-plan §9 で永続化、shape bit-equal 機械保証必要)。L6 完全 strikethrough は OQ-SR2-5 解消後
- [x] ~~**L7 (A defer)**: `feature/adr-019-stage-5-dormancy-fix-deferred` (SHA `10982e2`) 保全 → SR-4 完了後に revive (§7) — **着手 trigger 解除 2026-05-17 (SR-4 sub-plan PR-SR4-0 land 時)**、SR-4 sub-plan `docs/adr-020-phase-3-sr-4-dxgi-broker-plan.md` §8 (PR-SR4-4) で broker semantics 確立後 rebase + 実機検証 + revive PR 完了時 strikethrough~~ — **CLOSED 2026-05-18 by ADR-020 SR-4 PR-SR4-4 (#360)**: SHA `10982e2` was cherry-pick + redo'd on top of the broker semantics. `DesktopFacade.resolveHwndForViewId` re-introduced the foreground-fallback ladder so `tryVerifyAnyChange` no longer goes dormant on `desktop_discover()` / `desktop_discover({ windowTitle })`. Dogfood (a) PASS (`cacheState == "hit-subscription"` 10/10) + (b) PASS (`source == "dxgi_dirty_rect_unavailable"` 0/10) at single-monitor + vision-gpu coexistence (sub-plan §8.5 receipt). (c) AccessLost recovery is carried over to a Lock/Unlock follow-up dogfood per §8.4, tagged in `docs/adr-019-stage-5-followups.md`.
- [ ] **L8 (LLM E2E harness)**: 元 draft Phase 1 → **ADR-021 carry-over** (§6)、本 epic 完了 trigger で起草
- [ ] **L9 (UiEntity engine field collapse + ADVISORY_TEXT rule-shape derive 化)** (carry-over): SR-1 sub-plan §10 L9-a/L9-b で 2 軸新規追加、ADR-020 全 SR 完了後判断 (`UiEntity.unsupportedExecutors` + SR-1/SR-5 で追加した `preferredExecutors?` / `fallbackHint?` 3 engine internal field 重複 collapse + `ADVISORY_TEXT` hand-written const から rule-shape 自動生成への migrate)
- [ ] **L10 (`failWith` 経路 migrate 判断、OQ-SR2-4 carry-over)** (User 明示要求 2026-05-17 で永続化、忘却防止): 176 callsite の `failWith(...)` 経由 handler 内部標準 failure path (`ToolFailure` shape `{ok:false, code, error, suggest, ...rootExtras}` return、`_errors.ts:685-719` 定義) を `Result.err` + `toFailureEnvelope` 経由 envelope に migrate するかの判断。SR-2 sub-plan `docs/adr-020-phase-3-sr-2-handler-result-boundary-plan.md` §9 OQ-SR2-4 で exit condition 3 案 (keep `ToolFailure` shape as final / migrate to `Result.err` + `toFailureEnvelope` / hybrid wrapper 互換層) 明示済。`_post.ts:withPostState` post-perception hook の `ROOT_HOISTED_KEYS` wiring が `failWith` 経由 root extras hoist に依存しているため migrate には post-perception 機構の再設計も必要 (size +1500-2000 line / PR 分割 4-5、別 epic 想定)。**SR-2 全 PR land 後 / SR-4 着手前 / Phase 3 完了時の各 mile-stone で必ず参照確認**、いずれかの exit condition を明示判断して strikethrough 化 (CLAUDE.md 強制命令 9 整合)。

---

## 12. 関連 SSOT / 参照先

- memory `project_v170_blockers_resolved.md` — v1.6.1 release blocker 全 closure 経緯、各 PR file:line pin
- memory `project_path_class_refactor_pending.md` — 本 epic 起草前 user 観察 + 3 軸 outline + scope discipline 経緯
- memory `feedback_ai_multi_reviewer.md` — Codex 強み「wrapper 中央化 drift」3 軸 (runtime join key / side effect axis / projection selection policy)、本 epic SR-1/SR-2/SR-5 review で再活用
- memory `feedback_no_prefilter_scope.md` — dogfood 観測の事前 scope filter 禁止、本 epic で degrade を見落とした事案
- `CLAUDE.md` §3.1 (複数表 fact 整合) — 本 epic は executor 軸 analogue
- `CLAUDE.md` §3.2 (carry-over scope shrink) — Phase 3 SR-5 で既存 user-facing API surface 破壊禁止 (R6)
- `CLAUDE.md` §3.3 (PR review loop 定型) — 全 Phase / SR PR で必須遵守
- `docs/adr-019-stage-5-plan.md` §2.6 — DXGI broker の "documented fail-soft" contract、SR-4 で維持必須
- `docs/release-process.md` — Phase 2/3 完了で release タイミング判断時に full read
- `vitest.config.ts` — Phase 2 test 配置の include 規約 SSOT (§4.3)

---

## 13. 起草 metadata

- 起草日: 2026-05-17 (Round 1)、Round 2 反映: 2026-05-17、Round 3 反映: 2026-05-17
- 起草 session: post-v1.6.1 release、user 指示「path-class refactor epic 起草」
- Round 1 起草前 read 済: CLAUDE.md §3.3、memory `project_path_class_refactor_pending.md`、memory `project_v170_blockers_resolved.md`、memory `feedback_ai_multi_reviewer.md`
- Round 2 反映点 (user feedback 5 件):
  - §1: vitest.config.ts 整合 (test 配置を既存 `tests/unit/` 規約に乗せる、§4.3)
  - §2: F 不変条件を純粋関数 contract に弱化 (`computeLeaseTtl(observedRoundTripMs)` 純粋関数化、§4.2 / §4.4)
  - §3: E 不変条件を observable marker contract に弱化 (advertise → plan trail / silent success 禁止、§4.2)
  - §4: SR-2 を「throw 統一」から「内部 Result 寄せ + 最外周 boundary central converter」に修正 (§5.1 SR-2)
  - §5: epic acceptance criteria を「全 path-class 構造的発生不能」から「対象化した path-class で SSOT / central boundary / contract test 3 層により silent drift merge 不可」に弱化 (§9)
- Round 2 OQ 確定: OQ #1〜#5 全て Resolved (§10)、新規 OQ #6〜#8 起草
- Round 3 反映点 (user feedback 4 件):
  - §1 (High): F contract に cap 60s 整合 — 2 branch contract (cap 内で `TTL ≥ observedRoundTripMs` / cap 超えで cap saturate + `refreshRequired` marker)、`computeLeaseTtlMs` return shape `{ ttlMs, refreshRequired }` 化 (§4.2 F 行 + §4.4 F bullet)
  - §2 (Medium): Phase 2 が「D/F 小 refactor を含む」明文化 (§4.1 + §3 epic 構成図 + §4.4 production change 境界書き直し)
  - §3 (Medium): classifyModal 二重配置解消 — SR-3 を Phase 2 統合確定 (Phase 3 4 SR 構成へ、§5.1 + OQ #6 Resolved + L3 ledger 更新)
  - §4 (Low): revert 実証コスト緩和 — 6 件全部 commit-level revert ではなく「各 contract が regression fixture 持つ + 代表 2-3 件で revert/diff 検出力実証」(§4.6)
- Round 3 OQ 確定: OQ #6 Resolved (§10)、新規 OQ #9 起草 (F refactor callsite 移行 scope)
- Round 4 反映点 (Opus P1×3 + P2×4 + P3×2 + Codex P2×1 dup):
  - P1-1 (Opus + Codex 共同検出): "5 SR" → "4 SR" 同期 (§5.2 line 201 + §9 line 251)
  - P1-2: §10 OQ #1 Resolved 文言を Round 3 後の 4 SR (SR-1/5/2/4) 構成に再表記
  - P1-3 (user 諮問確定: (c)+(b) ハイブリッド): §5.1 SR-2 を `_envelope.ts` converter 中央集中 + handler 最外周 try/catch 共通 pattern に確定、`src/server/*` 誤参照を `src/server-windows.ts` / handler-level boundary に訂正、(a) SDK Server prototype 拡張案は不採用
  - P2-1: §4.4 F bullet で「callsite = `desktop.ts:392` 1 件のみ、`LeaseStore.issue()` API は本 epic 範囲外」を grep 確認結果として明示
  - P2-2 (user 諮問確定: 案 1): §4.2 F 行 + §4.4 F bullet で「`refreshRequired` は `computeLeaseTtlMs` return shape のみ、envelope surface しない」を lock
  - P2-3: §5.1 warm-up 喪失論拠を「SR-1 sub-plan を別途 Opus phase-boundary review + #332 baseline + 3-4 PR 分割」で補強
  - P2-4: §4.2 E 行 + §8 R6 に「Phase 2 contract test E (a) が `executors[0] == "uia"` 固定保証で SR-5 BC を機械 pin」明記
  - P3-1: §4.6 acceptance に「3 件目 candidate = C/G/B のうち revert cost 最小の C を recommend、PR-P2-3 で user 最終確定」事前列挙
  - P3-2: §5.1 SR-4 bullet に「ADR-019 §2.6 fail-soft semantics shift = race-loss 軸消滅で 2 軸 (factory failure / output index 無効) に縮約、SR-4 sub-plan で fact 整合 sweep 必須化」明記
- Round 4 OQ 確定: OQ #9 Resolved (Round 4 P2-1 grep で 1 callsite + 案 (b) shape 変更受け入れ確定)
- Round 5 反映点 (Codex Round 2 P2×3 + P3×1、Opus Round 2 Approved だったが Codex 補完軸検出):
  - Codex P2 #1 (line 107): §4.2 F 行で `refreshRequired` を「LLM-facing signal を response に乗せる」と説明していた残存 → 「`computeLeaseTtlMs` return shape のみ、envelope surface しない、LLM 通知は本 epic 範囲外」と明示的 lock (Round 4 §4.4 lock の §4.2 への bit-equal sync)
  - Codex P2 #2 (line 181): SR-2 caller inventory 訂正 — Round 4 で `_errors.ts` / `desktop-register.ts` / `_envelope.ts` の 3 file を caller と書いたが、**grep file count を caller と誤認**。実 caller は `_envelope.ts` 内 6 箇所のみ (line 2910/2990/3252/3267/3282/3297、定義 line 1197)。SR-2 (c) converter 中央集中は実質的に既達成、SR-2 主 scope は (b) handler 最外周 try/catch 共通 pattern に明確化、size 見積 ~800-1200 line → ~600-900 line 下方修正
  - Codex P2 #3 + P3 (line 256): R7 が「SR-3 / SR-1〜SR-5」stale 表記 → 「SR-3 は Phase 2 統合済、Phase 3 4 SR (SR-1/5/2/4)」に sync、SR-1 sub-plan で `classifyModal` API shape bit-equal sync 必須化を明記
  - **教訓 (memory `feedback_ai_multi_reviewer.md` 「wrapper 中央化 drift」3 軸再実証)**: Opus Round 2 Approved 後に Codex が API contract surface (caller inventory) で P2 検出 = Codex 強み「runtime path / contract regression / nested call semantics 軸」が再び機能。「Opus Approved = merge OK」判定を Codex 並走で必ず補強する CLAUDE.md §3.3 Step 0 規範を再強化
- Round 5 OQ 確定: 新規 OQ 起草なし、残存 OQ #7/#8 は SR-2 sub-plan / 後続 epic 起草時諮問
- Round 6 反映点 (Opus Round 3 P2×1 + Codex Round 3):
  - Opus P2 (§8 R2): SR-2 PR 分割数の §5.1 (~600-900 line → 2-3 PR) と §8 R2 (3-4 PR、Round 5 size 下方修正で未 sync) fact 不整合 → §8 R2 を `2-3 PR 分割` に sync (案 a 採用)。**自己反省**: Opus が事前 prompt の懸念を自ら実証検出 (caller inventory 誤認の同型 = numeric count sync 一方表のみ修正)、Lesson 4 (numeric count sync) を Round 5 commit 時に Grep "PR 分割" を実行していれば即検出可能だった
  - Codex Round 3: **Approved (指摘ゼロ、+1 reaction only)** — Round 5 で反映済 Codex Round 2 findings 4 件が全て解消されたことを Codex 側も確認、新規 P2/P3 検出なし
- Round 6 OQ 確定: なし
- **判定**: Opus Round 3 P2×1 反映 (本 Round 6) + Codex Round 3 Approved → **auto-mode merge 適格** (memory `feedback_auto_mode_merge_opus_judgment.md` 準拠: docs only + git 削除なし + release 工程外、AI merge 可)。Opus P2 軽微 (numeric sync 単発、§5.1 既存値と R2 一致化) で Round 4 review trigger は overkill 判断、Round 6 commit で merge へ進行
