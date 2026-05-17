# ADR-020 Phase 3 SR-1 — CapabilityRegistry SSOT 一本化 sub-plan

- Status: **Drafted (2026-05-17、Round 6 = Opus R5 P2-N1 反映 trivial sync、累積 25 件 closure、Opus Round 5 「修正後 Approved 推奨」判定済 = AI auto-mode merge 適格)**
- 親 ADR: `docs/adr-020-path-class-refactor-plan.md` §5.1 SR-1
- 着手 trigger: ADR-020 Phase 2 land (PR #335-#338 merged、**Phase 2 contract test 5 件 safety net + D/F 小 refactor 完了で L3/L5 構造除去達成**、L1/L2/L4/L6 は SR-4/SR-1/SR-5/SR-2 で順次構造除去、Round 4 P3-6 反映で正確化)
- baseline commit: `a7c77df` (main HEAD、PR-P2-3 land 直後)
- 着手順序: Phase 3 4 SR のうち **最初** (SR-1 → SR-5 → SR-2 → SR-4、親 ADR §5.1)
- 関連 SSOT: `src/tools/desktop-capabilities.ts` / `src/tools/desktop-executor.ts` / `src/tools/desktop-constraints.ts` / `src/tools/desktop.ts:466` / `src/tools/desktop-register.ts:800` / `src/engine/world-graph/types.ts:132`
- 北極星抜粋 (親 ADR §2 から SR-1 への refinement): **derivation source = consumption source = description source の 3 SSOT を 1 registry に集約**、advisory ⇔ execution の drift を構造的に発生不能化

---

## 1. 背景

### 1.1 baseline の drift 構造 (現状の SSOT 分裂)

ADR-020 §1.1 表 C 行で「`desktop-capabilities.ts` が `preferredExecutors: ["uia"]` を emit / `desktop-executor.ts::createDesktopExecutor` が UIA 失敗時 silent mouse fallback (marker なし)」が drift の核と整理された (現コード関数名に統一、Round 4 P3-5 で親 ADR 表記訂正の経緯は §12 metadata 参照)。baseline `a7c77df` の実装を逐行 grep した結果、drift の本質は **「`preferredExecutors` が advisory のみで execution layer に流れていない」** ことだった:

| layer | file:line | 現状の責任 | drift 結果 |
|-------|----------|----------|----------|
| **derivation (advisory side)** | `src/tools/desktop-capabilities.ts:64` `deriveEntityCapabilities(entity, viewConstraints?)` | 5 case 分岐 (Visual-only / UIA provider failed / Invoke / SelectionOnly / Toggle / Value / no-pattern rect) で `EntityCapabilities { preferredExecutors, unsupportedExecutors, fallbackHint }` を pure 関数返却 | LLM-facing advisory として `entityView.capabilities` に格納 (`src/tools/desktop.ts:468`) |
| **consumption (execution side)** | `src/tools/desktop-executor.ts:144-275` `createDesktopExecutor(target, deps)` の返す async function 本体 | **`entity.unsupportedExecutors` の負 gate のみ consume** (line 158-162 で `blocked = entity.unsupportedExecutors ?? []` → 各 route の `Xblocked` flag) | **`preferredExecutors` の正順序は consume されない**、route 順は **hardcoded ladder** `uia → cdp → terminal → mouse` |
| **description (advertise side)** | `src/tools/desktop-register.ts:800` 静的文字列 | tool description で「`capabilities.preferredExecutors[0]` が most likely succeed / `unsupportedExecutors` に `'uia'` 含めば mouse_click 直行」と advertise | **advertise した正順序を実際の executor が consume していない**、advertise と実装が drift |

= "registry SSOT" が無く、3 layer が **(1) `deriveEntityCapabilities` の pure 関数 (2) executor 内 hardcoded ladder + 局所 blocked check (3) hand-written description string** で個別に capability semantics を保持している状態。各 layer の rule table が drift しても merge ブロックされない (PR #332 dogfood で drift 顕在化、tactical fix で `TouchResult.downgrade` marker のみ追加し構造未解消)。

### 1.2 PR #332 (C tactical fix) baseline

`src/tools/desktop-executor.ts:198-218` で UIA click が throw して mouse fallback した場合に **`{ kind: "mouse", downgrade: { from: "uia", reason } }`** を return する hand-wired marker emit が追加済 (PR #332)。これは **uia → mouse の 1 経路 hardcoded** で、`preferredExecutors` 正順序を consume する registry 経由経路では **任意の `[from] → [to]` 組合せで marker emit が必要** になる。SR-1 PR-SR1-2 で registry consume 化する際に、この marker emit ロジックを **registry/executor 共通 boundary に昇格** して構造化する。

### 1.3 Phase 2 contract test の safety net role

PR-P2-3 (PR #338) で land した 5 contract test (`tests/unit/path-class-contract/*.test.ts`) が SR-1 refactor 中の regression を即検出する safety net 役を担う:

- `c-executor-downgrade.test.ts` — `createDesktopExecutor(target, mockDeps)` + UIA throw mock で **downgrade marker emit を wire-level pin** (PR #332 revert で fail)。SR-1 PR-SR1-2 で executor が `preferredExecutors` consume 化された後も、UIA → mouse fallback で downgrade marker が emit され続けることを継続 pin
- `e-uia-fallback-ladder.test.ts` — `preferredExecutors[0] == "uia"` を ValuePattern entity で固定保証 (SR-5 BC 機械 pin、Round 4 P2-4)。SR-1 で registry が `preferredExecutors[0]` を返す経路が変わっても本 test が pass し続けることで registry 出力の bit-equal 保証

= SR-1 の各 PR で「Phase 2 contract test 5 件全 green 維持」を必須 acceptance とし、refactor が advisory 出力を破壊した瞬間に merge ブロックされる仕組み。

### 1.4 ExecutorDeps DI 設計の保全 (Opus contract 真意 sweep 軸)

memory `feedback_opus_contract_truth_sweep.md` で確立した「contract test が production path を実 invoke するか」軸は、`createDesktopExecutor(target, deps)` の **`ExecutorDeps` interface mock injection 設計**に依存する。SR-1 で executor 内部を registry 経由経路に書き換える際、**`ExecutorDeps` interface shape は破壊しない** (PR-SR1-2 acceptance) + **`createDesktopExecutor(target, deps?)` signature 不変** (Round 4 P1-1 case β、Round 5 P1-N2 で stale 表記訂正: registry は `desktop.ts::see()` 内 1 callsite で呼び executor には渡さない、executor は entity 経由で全情報取得)。registry 自体は **`see()` 経路で DI 可能設計** (production: module-level `defaultRegistry` singleton、test: registry mock を `see()` injection で差し替え) とし、executor は registry 引数を受け取らない (北極星 6 signature 不変)。Phase 2 contract test C/E は **`createDesktopExecutor(target, mockDeps)` + entity に明示 `preferredExecutors` set** で real production fallback path を invoke、registry 経路は別 unit test (`tests/unit/capabilities-registry-invariant.test.ts`) で pin。

### 1.5 viewConstraints lifetime 構造制約 (Round 4 P1-1 新設、User judgment 救済)

**Round 1-3 で見落としていた構造盲点**: 私の Round 2 で「`createDesktopExecutor(target, deps?, registry?, viewConstraints?)` 第 4 引数追加で per-call 直接受け渡し」と決定 (option (b)) したが、**現コード `src/tools/desktop.ts:602` `_sessionOpts()` で `executorFactory: (target) => createDesktopExecutor(target, this.opts.executorDeps)` が session 作成時に固定**されている。`viewConstraints` は `desktop.ts:449` `see()` 内で per-call 算出される値で、session 作成時には存在しない → option (b) は **lifetime mismatch で破綻**。

**Round 4 採用案 (β: entity に pre-baked capabilities)**: 現状 `desktop.ts:468` `entityViews[i].capabilities = cap` で LLM-facing view に EntityCapabilities 全 field を attach 済 + `desktop.ts:469-471` で `entity.unsupportedExecutors = [...cap.unsupportedExecutors]` を engine internal field に書き戻し済。**SR-1 で `entity.preferredExecutors` (engine internal field 新設) + `entity.fallbackHint?` も同経路で書き戻し**、`see()` 内で registry.lookup を 1 回実行して結果を entity に bake、executor は entity 経由で全情報取得 — viewConstraints 自体は see() ↔ registry 間で完結、executor は viewConstraints を意識しない。

| 検討案 | 採否 | 理由 |
|--------|------|------|
| **α** SessionState に最新 viewConstraints 保持、executorFactory が session ref 経由取得 | 棄却 | SessionState 構造拡張 + executorFactory が session ref を持つ closure 必要 → executor lifetime と SessionState mutation timing が結合、複雑度高 |
| **β** entity.preferredExecutors / fallbackHint engine internal field 新設、executor は entity 経由消費 | **採用** | 既存 `entity.unsupportedExecutors` 書き戻し pattern (Issue #296 Phase 2、`desktop.ts:469-471`) と完全整合、executor は viewConstraints 非依存、`UiEntity` advisory inline shape の現状 JSDoc 設計意図 (`types.ts:127-132`) と一致 |
| **γ** `executorFactory(target, viewConstraints?)` シグネチャ拡張で per-call SessionState 経由渡し | 棄却 | session 内 `executorFactory` 呼び出し callsite (`src/engine/world-graph/session-registry.ts` 等) 全変更必要 + viewConstraints の SessionState 保持が依然必要、α と複雑度同等 |

**Round 1 棄却した option (a) との違い**: Round 1 option (a) は「`entity.unsupportedExecutors` 経由間接消費」だけ書いていたため `provider_failed` view bias loss が発生 (`preferredExecutors: ["mouse"]` 差し替えが entity に乗らない)。Round 4 案 β は **`preferredExecutors` 含む EntityCapabilities 全 field を entity に bake** することで bias loss を構造的に解消 (`entity.preferredExecutors` も書き戻すため `provider_failed` 時の `["mouse"]` bias が executor に伝わる)。

---

## 2. 北極星 (SR-1 不変条件、Round 4 で 7 → 8 件拡張)

親 ADR §2 北極星 4 件を SR-1 layer に refinement (Round 2 P1-2 で disjoint invariant 北極星 7 新設、Round 4 P1-1/P1-2 で entity bake invariant 北極星 8 新設):

1. **registry SSOT 1 箇所**: capability rule 定義は `src/capabilities/registry.ts` に **1 箇所のみ**存在する。`deriveEntityCapabilities` / `createDesktopExecutor` / tool description の 3 consumer は **registry lookup 経由でのみ** capability semantics を取得する (rule table の再実装 / 再宣言は merge ブロック対象)。
2. **`preferredExecutors` 正順序 consume** (Round 4 P1-1 反映で case β 経路): `createDesktopExecutor` は **`entity.preferredExecutors` (engine internal field、PR-SR1-2 で新設、`see()` 内で registry.lookup 結果を bake)** を **route 順序として consume** する。hardcoded `uia → cdp → terminal → mouse` ladder は **`entity.preferredExecutors` が undefined / 空 (registry lookup 不在 = test 直 invoke / legacy path) の時のみ fallback** として残存 (PR-SR1-2 で構造化)。registry.lookup は `see()` 内で 1 回だけ実行、executor は registry 非依存。
3. **downgrade marker 構造化**: registry が `preferredExecutors[0] = X` を返したのに runtime で `Y != X` 実行された場合、`ExecutorOutcome.downgrade` が **必ず emit** される (silent drift 禁止)。PR #332 の uia → mouse hand-wired marker は registry/executor 共通 boundary に昇格、任意 `[from] → [to]` 組合せで marker emit が機械的に保証される。
4. **既存 public API surface 不破壊**: `EntityCapabilities` type shape (`preferredExecutors / unsupportedExecutors / fallbackHint / canType / canClick`) は不変、`entityView.capabilities` の wire shape は backward compatible、`UiEntity.unsupportedExecutors` (engine internal field) も shape 不変 (内部 derivation 経路のみ registry 経由化、親 ADR §3 北極星 3 + 強制命令 10 整合)。
5. **Phase 2 contract test 5 件全 green 維持**: 各 PR で `tests/unit/path-class-contract/*.test.ts` が全 pass。registry 化が advisory 出力 / wire shape / fallback marker を破壊した瞬間に test fail で merge ブロックされる。
6. **`ExecutorDeps` DI 設計保全 + executor signature 最小拡張** (Round 4 P1-1 で第 4 引数案棄却): `createDesktopExecutor(target, deps?)` の signature は **不変** (Round 2 で提案した第 3/4 引数 `registry?` / `viewConstraints?` 追加は Round 4 で棄却、case β 採用で executor は entity 経由で全情報取得するため registry 引数不要)。`ExecutorDeps` interface も不変。Phase 2 contract test C/E の `createDesktopExecutor(target, mockDeps)` mock injection 経路は変更なし (Opus contract 真意 sweep 軸保全)。
7. **registry invariant: `preferredExecutors` と `unsupportedExecutors` は disjoint** (Round 2 P1-2 + Round 4 P2-3 型名変更): `registry.lookup(entity, viewConstraints?)` が返す `EntityCapabilities` は **`preferredExecutors ∩ unsupportedExecutors = ∅` (overlap 禁止)** + **`preferredExecutors.length ≥ 1` (空配列禁止)** + **`preferredExecutors ⊆ Array<AdvertisedExecutorKind>` (advertised executor narrow type、`AdvertisedExecutorKind = "uia"|"cdp"|"terminal"|"mouse"` の 4 種、SR-5 で `"keyboard"` first-class promotion 時に型 union 拡張)** の 3 invariant を満たす (`undefined` 返却は別)。invariant 違反は PR-SR1-1 内で **`lookupDefault` 出力 contract test** で機械検出 + production code 内 `assertCapabilitiesInvariant(cap)` で defensive check (PR-SR1-1 acceptance)。
8. **entity bake invariant** (Round 4 P1-1 新設、case β 構造保証): `desktop.ts:466-471` 周辺で registry.lookup 結果を **entity に bake する経路** が **常に `preferredExecutors` / `unsupportedExecutors` / `fallbackHint` を 1 batch で書き戻し** (現状の `unsupportedExecutors` のみ書き戻しを 3 field に拡張)。bake 不完全 (`preferredExecutors` だけ書き忘れ等) は `provider_failed` bias loss 等の silent drift を再発させるため、PR-SR1-2 で `bakeEntityCapabilities(entity, cap)` 共通 helper として中央化、`desktop.ts:469-471` の inline 書き戻しを helper 呼出に置換、helper 内で **`registry.lookup` から取得した cap の 3 field を必ず同時 bake**。bake invariant 違反は executor 側 `entity.preferredExecutors === undefined` 検出時に hardcoded fallback ladder + Codex review prompt 雛形 (§5.6) で「bake 漏れがないか callsite grep 確認」を必須項目化。

---

## 3. scope outline (3 PR 分割確定 + 4 番目 cleanup PR は親 ADR §11 carry-over へ昇格)

ADR-020 §5.1 SR-1 「~600-900 line を 3-4 PR sub-plan 分割」を **3 PR 構成** に確定。Round 2 P3-3 反映で **4 番目 PR (cleanup) は本 sub-plan OQ から外し、親 ADR §11 carry-over ledger に L9 新 entry として昇格** (`UiEntity.unsupportedExecutors` 重複 field collapse は ADR-020 全 SR 完了後判断、責任分界点明確化):

```
PR-SR1-1 (registry interface + rule table extraction + entity bake helper + type narrow 化、~300-450 line)
   = src/capabilities/registry.ts 新設、deriveEntityCapabilities ロジックを registry.lookup に移管
   = src/capabilities/registry.ts から AdvertisedExecutorKind type alias single SSOT 化 (Round 4 P2-3 = AdvertisedExecutorKind 改名で意図明確、SR-5 で型拡張)
   = desktop-constraints.ts:81 EntityCapabilities.preferredExecutors / unsupportedExecutors を AdvertisedExecutorKind[] に narrow (既存 inline shape と等価、Round 3 P2-N2)
   = bakeEntityCapabilities(entity, cap) 共通 helper 新設 (Round 4 P1-1 北極星 8、3 field 同時 bake)
   = src/engine/world-graph/types.ts UiEntity engine internal field 拡張: entity.preferredExecutors?: AdvertisedExecutorKind[] / entity.fallbackHint?: string 追加 (現状 entity.unsupportedExecutors 既存 pattern と整合)
   = desktop.ts:466-473 inline 書き戻しを bakeEntityCapabilities(entity, cap) 呼出に置換
   = deriveEntityCapabilities は registry.lookup の thin wrapper として backward compatible
   = registry invariant 3 件 (disjoint / 非空 / narrow type) を lookupDefault 出力 + assertCapabilitiesInvariant (runtime allowed set check 含む、Round 3 P3-N1) で pin (北極星 7)
   = behavior bit-equal (Phase 2 contract test 5 件 + 既存 desktop-capabilities.test.ts 全 green、entity bake は LLM-facing wire shape 不変)
   ↓
PR-SR1-2 (executor entity.preferredExecutors 正順序 consume + downgrade marker 構造化、~250-350 line)
   ‖ PR-SR1-3 と並走可能 (Round 3 P3-N2、scope disjoint: PR-SR1-2 = executor 改修 / PR-SR1-3 = description 改修)
   = createDesktopExecutor(target, deps?) signature 不変 (Round 4 P1-1 で第 3/4 引数 registry?/viewConstraints? 案棄却、case β 採用)
   = ループ内で entity.preferredExecutors を直接 consume (registry.lookup は executor で呼ばない、see() bake 結果を経由消費)
   = entity.preferredExecutors undefined / 空 → hardcoded fallback ladder ["uia","cdp","terminal","mouse"] (registry lookup 不在 = test 直 invoke / legacy path のみ、Round 4 P2-4 明示化)
   = routeExecutor(executor, entity, action, text, d) 内部 helper 戻り値: Promise<AdvertisedExecutorKind | "keyboard"> (Round 4 P1-2、observed kind 返却、UIA setValue 失敗 → keyboardTypeBg fallback 成功時 "keyboard" 返却で内部 fallback 観測性保全)
   = 外側 loop: intendedExecutor = entity.preferredExecutors[0] / observedKind = await routeExecutor(...) / observedKind !== intendedExecutor → downgrade marker emit
   = downgrade marker emit を任意 [from → to] 組合せに構造化 (PR #332 hand-wired を昇格)
   = Phase 2 contract test C/E green 維持 + 副作用波 8 件 preventive sweep を Codex review に必須化
   ↓
PR-SR1-3 (tool description registry derive、~100-200 line)
   ‖ PR-SR1-2 と並走可能 (Round 3 P3-N2)
   = desktop-register.ts:800 静的文字列を registry helper 経由生成に置換
   = registry に toolDescriptionAdvisory() helper 追加 (module-level const ADVISORY_TEXT、Round 3 P2-N1 = freeze no-op 解消で cache 不要)
   = uia-provider.ts JSDoc 文言 3 箇所更新 (PR-SR1-2 非依存、並走 OK)
   = Phase 2 contract test 全 green 維持

並走条件: PR-SR1-1 land 後、PR-SR1-2 と PR-SR1-3 は **scope disjoint で worktree 並走可能** (CLAUDE.md §3.4)。
ただし両 PR とも PR-SR1-1 の registry interface + AdvertisedExecutorKind type narrow + bake helper + entity engine field 拡張 land 前提。

PR-SR1-4 (4 番目 cleanup = UiEntity.unsupportedExecutors + 新規 preferredExecutors / fallbackHint engine field を EntityCapabilities 直参照に collapse) は **本 sub-plan scope 外**、親 ADR §11 carry-over ledger L9 新 entry として ADR-020 全 SR 完了後判断 (Round 2 P3-3 + Round 4 P1-1 で engine field 拡張分も L9 集約)
```

各 PR は **review loop 独立、production code 改修 PR (PR-SR1-1/2/3 全件) は Codex 必須** (CLAUDE.md §3.3 Step 0 + memory `feedback_codex_side_effect_wave.md`)。PR-SR1-2 は route 順序変更が副作用波を生む高 risk 改修のため preventive sweep を厚く実施 (Codex Round 1 で「fix が新副作用」軸を必ず明示確認、§5.3 副作用波 8 件 + §5.6 Codex prompt 雛形 sweep)。

---

## 4. PR-SR1-1 詳細 (registry interface + rule table extraction)

### 4.1 目的

`deriveEntityCapabilities` の pure 関数ロジックを **registry interface 経由の lookup** に refactor。**behavior bit-equal** が大前提 (Phase 2 contract test 5 件 + `tests/unit/desktop-capabilities.test.ts` 全 green、wire shape 不変)。**北極星 7 (registry invariant 3 件)** を lookupDefault 出力 + production assertion で pin。

### 4.2 新規 file: `src/capabilities/registry.ts`

```ts
// src/capabilities/registry.ts (新設、~150 line)

import type { UiEntity } from "../engine/world-graph/types.js";
import type { EntityCapabilities, ViewConstraints } from "../tools/desktop-constraints.js";

/**
 * Round 3 P2-N2 + Round 4 P2-3 (Lesson 2 compile-time guard 軸 + 意図明確化):
 * `AdvertisedExecutorKind` は **capability registry が advertise する 4 executor narrow union** で、
 * SR-5 で `"keyboard"` first-class promotion 時に本 alias 自体を拡張する。SR-1 段階では
 * `ExecutorKind` (5 種、`"keyboard"` 含む) は **internal fallback executor (keyboardTypeBg)**
 * も含む union として現状維持、`AdvertisedExecutorKind` は **advertise 対象のみの narrow set**。
 *
 * `desktop-constraints.ts:81` の `EntityCapabilities.preferredExecutors` / `unsupportedExecutors` は
 * 本 alias を直接型として採用 (cast 廃止、compile-time guard 有効化)。型 1 箇所改修で全 production
 * code narrow 拡張が伝播 (SR-5 で `"keyboard"` 追加 → registry が advertise 開始 → executor も
 * `entity.preferredExecutors` に `"keyboard"` 含む可能性、routeExecutor 内 keyboard case 追加で対応)。
 *
 * 元 `RouteExecutorKind` 案 (Round 2 で導入) → 「route 経路の全 executor」と読めて SR-5 後の
 * `"keyboard"` 追加で意味が変わるため、Round 4 で意図限定された `AdvertisedExecutorKind` に改名
 * (User judgment 反映、memory `feedback_no_prefilter_scope.md` 同型「scope 解釈の境界精緻化」軸)。
 */
export type AdvertisedExecutorKind = "uia" | "cdp" | "terminal" | "mouse";

/**
 * CapabilityRegistry — capability rule SSOT (ADR-020 SR-1 北極星 1).
 *
 * `deriveEntityCapabilities` / `createDesktopExecutor` / tool description 3 consumer
 * が capability semantics を取得する唯一の経路。rule table の再実装 / 再宣言は禁止
 * (北極星 1)。
 *
 * **Pure lookup invariant (北極星 1 + Round 2 P3-2 + Round 3 P2-N1)**: registry 実装は
 * internal state を持たない pure function 群。`defaultRegistry` module-level singleton は
 * 安全 (test 並列実行で race 不能、副作用波 6 防止)。constant data は module-level
 * `const ADVISORY_TEXT` 等で TS `const` guard 化する (Round 3 P2-N1: `Object.freeze` は
 * string primitive に no-op、object cache が必要な場合に限り `Object.freeze({...})` で wrap)。
 */
export interface CapabilityRegistry {
  /**
   * UiEntity から EntityCapabilities を pure に導出。pattern set / controlType /
   * source / rect + viewConstraints (UIA provider failed) を入力に取り、
   * Case 1-5 + 特殊分岐の優先順位で 1 つの EntityCapabilities を返す。
   *
   * **Invariant (北極星 7、Round 2 P1-2)**:
   *   返却 EntityCapabilities (undefined でない場合):
   *   (a) preferredExecutors.length ≥ 1 (空配列禁止)
   *   (b) preferredExecutors ∩ unsupportedExecutors = ∅ (overlap 禁止)
   *   (c) preferredExecutors ⊆ Array<"uia"|"cdp"|"terminal"|"mouse"> (narrow type、"keyboard" 混入禁止)
   *
   * (c) は SR-5 (`"keyboard"` first-class promotion) で type 拡張する際に
   * `EntityCapabilities.preferredExecutors` 型自体を拡張する形で行い、本 SR-1
   * 内では invariant 維持 (PR-SR1-2 routeExecutor の type narrowing も (c) に依存)。
   *
   * 既存 deriveEntityCapabilities と bit-equal な出力を保証する (PR-SR1-1 acceptance)。
   */
  lookup(entity: UiEntity, viewConstraints?: ViewConstraints): EntityCapabilities | undefined;

  /**
   * LLM-facing tool description の advisory section を rule table から生成。
   * registry の rule shape (preferredExecutors / unsupportedExecutors / fallbackHint)
   * を文章化することで、advertise 文言が rule table と bit-equal sync される (北極星 1)。
   *
   * **Pure / no internal state**: 内部 cache は immutable readonly のみ許容
   * (build-once、freeze 後 mutation 禁止、副作用波 6 防止)。PR-SR1-3 で実装。
   */
  toolDescriptionAdvisory(): string;
}

/** デフォルト registry (production singleton)。 */
export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  return {
    lookup: lookupDefault,
    toolDescriptionAdvisory: toolDescriptionAdvisoryDefault,  // PR-SR1-3 で実装
  };
}

// 既存 deriveEntityCapabilities のロジックをそのまま移管 (private function)
function lookupDefault(entity: UiEntity, viewConstraints?: ViewConstraints): EntityCapabilities | undefined {
  // ... src/tools/desktop-capabilities.ts:64-160 のロジックを完全移管 ...
  // 返却前に assertCapabilitiesInvariant(cap) で北極星 7 invariant defensive check
  // (production 経路でも assertion 走らせる、invariant 違反 = lookupDefault 改修 bug、即 throw)
}

function toolDescriptionAdvisoryDefault(): string {
  // PR-SR1-3 で実装。PR-SR1-1 時点では stub (現状 desktop-register.ts:800 文字列を return)
}

/** Round 3 P3-N1: narrow type runtime defense-in-depth (rule table 改修で意図せず "keyboard" emit する bug を runtime 検出)。 */
const ALLOWED_EXECUTORS: ReadonlySet<AdvertisedExecutorKind> = new Set<AdvertisedExecutorKind>(["uia", "cdp", "terminal", "mouse"]);

/** 北極星 7 invariant defensive check (Round 2 P1-2 + Round 3 P3-N1 narrow runtime check)。 */
export function assertCapabilitiesInvariant(cap: EntityCapabilities | undefined): void {
  if (cap === undefined) return;
  const preferred = cap.preferredExecutors ?? [];
  const unsupported = cap.unsupportedExecutors ?? [];
  if (preferred.length === 0) {
    throw new Error("CapabilityRegistry invariant violation: preferredExecutors.length === 0");
  }
  for (const e of preferred) {
    // Round 3 P3-N1: narrow type runtime defense-in-depth
    if (!ALLOWED_EXECUTORS.has(e as AdvertisedExecutorKind)) {
      throw new Error(`CapabilityRegistry invariant violation: "${e}" ∉ ALLOWED_EXECUTORS (narrow type breach, "keyboard" 等の混入)`);
    }
    if (unsupported.includes(e)) {
      throw new Error(`CapabilityRegistry invariant violation: overlap "${e}" in preferred ∩ unsupported`);
    }
  }
  // 北極星 7 (c) narrow type: PR-SR1-1 で desktop-constraints.ts:81 を AdvertisedExecutorKind[] に
  // narrow 化済 (Round 3 P2-N2)、TS compile-time で第 1 防衛層 + 本 runtime check で defense-in-depth
}
```

### 4.3 `src/tools/desktop-capabilities.ts` 改修

```ts
// src/tools/desktop-capabilities.ts (~10 line に縮約)

import { createDefaultCapabilityRegistry } from "../capabilities/registry.js";

const defaultRegistry = createDefaultCapabilityRegistry();

/** @deprecated SR-1 PR-SR1-1: 内部 registry 経由 lookup の thin wrapper。
 *  新規 callsite は createDefaultCapabilityRegistry().lookup() を直接使うことを推奨。 */
export function deriveEntityCapabilities(
  entity: UiEntity,
  viewConstraints?: ViewConstraints,
): EntityCapabilities | undefined {
  return defaultRegistry.lookup(entity, viewConstraints);
}
```

`@deprecated` tag は親 ADR §11 carry-over ledger L9 (Round 2 P3-3 で新設) として ADR-020 全 SR 完了後に判断 (本 sub-plan 内では removal 判断しない)。本 PR では back-compat re-export として残す。

### 4.4 既存 callsite 影響範囲 (grep 確認、Round 2 P1-3 で訂正)

`Grep "deriveEntityCapabilities"` 8 file の影響整理 (Opus Round 1 review で `uia-provider.ts` callsite を full read 確認、callsite 0 件 / JSDoc 言及 3 箇所のみと訂正):

| file | 役割 | PR-SR1-1 影響 |
|------|------|--------------|
| `src/tools/desktop-capabilities.ts` | 定義側 | thin wrapper に縮約 |
| `src/tools/desktop.ts:466` | production callsite (`desktop.see()` 内) | **無変更** (`deriveEntityCapabilities` thin wrapper 経由で動作維持) |
| `src/tools/desktop-providers/uia-provider.ts` line 43/87/94 | **JSDoc 言及のみ 3 箇所 / 実 callsite 0 件** (Round 2 P1-3 訂正、Opus full read 確認済) | PR-SR1-1 で **production code 触らない**、JSDoc 文言の `deriveEntityCapabilities` → `CapabilityRegistry.lookup` 一括更新は PR-SR1-3 で並行 (description 軸 update と同 commit) |
| `src/engine/world-graph/types.ts` | type 定義 + JSDoc | JSDoc の `deriveEntityCapabilities(...)` 言及部分が thin wrapper 経由動作になるが、文言更新は PR-SR1-3 で一括 |
| `tests/unit/desktop-capabilities.test.ts` | 既存 unit test | **無変更** (thin wrapper 経由で全 case pass) |
| `tests/unit/path-class-contract/c-executor-downgrade.test.ts` | Phase 2 C contract test | **無変更** (`deriveEntityCapabilities` import 経由) |
| `tests/unit/path-class-contract/e-uia-fallback-ladder.test.ts` | Phase 2 E contract test | 同上 |
| `src/engine/vision-gpu/types.ts` | JSDoc 言及のみ | **無変更** |

= production 経路は `desktop.ts:466` の 1 callsite + thin wrapper 経由動作維持。`uia-provider.ts` は **JSDoc 言及のみ 3 箇所で実 callsite 0 件** (Round 2 P1-3 訂正)、JSDoc 文言更新は PR-SR1-3 で description 軸と並行一括処理。

### 4.5 acceptance (PR-SR1-1)

- `src/capabilities/registry.ts` 新設 (rule table ロジックを `lookupDefault` private function に完全移管 + `assertCapabilitiesInvariant` 新設 + `AdvertisedExecutorKind` type alias single SSOT 化、Round 3 P2-N2 + Round 4 P2-3 改名)
- **`src/tools/desktop-constraints.ts:81` `EntityCapabilities.preferredExecutors` 型を `AdvertisedExecutorKind[]` に narrow 化** (Round 3 P2-N2、既存 inline shape `Array<"uia"|"cdp"|"terminal"|"mouse">` と等価で wire shape 不変、TS compile-time guard 復活、PR-SR1-2 cast 廃止)
- 同様に `EntityCapabilities.unsupportedExecutors` も `AdvertisedExecutorKind[]` に narrow 化 (compile-time guard 一貫化)
- **`bakeEntityCapabilities(entity, cap)` 共通 helper 新設** (Round 4 P1-1 北極星 8): `src/capabilities/registry.ts` or `src/tools/desktop-capabilities.ts` に export、`cap` の 3 field (`preferredExecutors / unsupportedExecutors / fallbackHint`) を entity に 1 batch で書き戻し、bake 不完全による silent drift を構造的に発生不能化
- **`src/engine/world-graph/types.ts` `UiEntity` engine internal field 拡張** (Round 4 P1-1): `entity.preferredExecutors?: AdvertisedExecutorKind[]` + `entity.fallbackHint?: string` 追加 (現状 `entity.unsupportedExecutors` inline shape pattern と整合、advisory import なし、`UiEntity` 設計意図 `types.ts:127-132` JSDoc と一致)
- **`src/tools/desktop.ts:466-473` inline 書き戻しを `bakeEntityCapabilities(entity, cap)` 呼出に置換** (Round 4 P1-1): 現状の `entity.unsupportedExecutors` のみ書き戻し pattern を 3 field 1 batch bake に拡張、bake 完全性を helper SSOT で保証
- `deriveEntityCapabilities` が thin wrapper に縮約 (`@deprecated` tag 付与、親 ADR L9 carry-over)
- **北極星 7 invariant 3 件 (disjoint / 非空 / narrow type) pin** (Round 2 P1-2 + Round 3 P3-N1):
  - `lookupDefault` 出力に対する unit test を `tests/unit/capabilities-registry-invariant.test.ts` 新設、全 5 case 分岐 + overlap test case + 不正 executor (`"keyboard"` 注入 mock) test case 含む 9+ case で invariant 機械保証
  - production 経路 (`defaultRegistry.lookup`) で `assertCapabilitiesInvariant(cap)` defensive check (PR-SR1-1 内に追加、`ALLOWED_EXECUTORS` runtime narrow check で defense-in-depth)
- 既存 `tests/unit/desktop-capabilities.test.ts` 全 case 無変更で green (bit-equal 出力 pin)
- Phase 2 contract test 5 件全 green (`c-executor-downgrade.test.ts` / `e-uia-fallback-ladder.test.ts` / D / F / B)
- 既存 vitest suite 全 pass + tsc clean
- Opus phase-boundary review (CLAUDE.md §3.3 Step 1 全 10 項目 + contract 真意 sweep + sub-plan 全文 re-read)
- Codex review 1+ round (production code 改修、§3.3 Step 0、§5.6 Codex prompt 雛形 PR-SR1-1 版を流用)

### 4.6 risk

- **R-SR1-1-a** (Round 2 P3-1 反映): `lookupDefault` 移管時に rule table の優先順位 (Case 1-5 + 特殊分岐) を 1 case でも入れ替えると wire shape 出力が drift。Phase 2 contract test 5 件 + 既存 unit test 27 case で機械検出可能。**対策**: PR description に `git show <SR1-1-commit-hash>` 範囲を明記、reviewer は `git show <hash>` で `src/tools/desktop-capabilities.ts` と `src/capabilities/registry.ts` を逐行 diff 確認 (CLAUDE.md §3.3 Step 1 reviewer full read 指示と整合)
- **R-SR1-1-b** ~~ (Round 2 P1-3 で削除、`uia-provider.ts` callsite 0 件確定済)~~

---

## 5. PR-SR1-2 詳細 (executor preferredExecutors 正順序 consume + downgrade marker 構造化)

### 5.1 目的

`createDesktopExecutor` が **`entity.preferredExecutors` (engine internal field、PR-SR1-1 で新設、`see()` 内で registry.lookup 結果を bake) を route 順序として consume** する。hardcoded `uia → cdp → terminal → mouse` ladder は **`entity.preferredExecutors` が undefined / 空 (registry lookup 不在 = test 直 invoke / legacy path のみ、Round 4 P2-4 明示化)** の時の fallback として残す。downgrade marker emit を **任意 `[from] → [to]` 組合せ対応** に構造化 (PR #332 hand-wired を昇格)。**Round 4 P1-1 反映: viewConstraints は executor 引数で渡さず、see() ↔ registry 間で完結 → entity に bake → executor 経由消費** (case β、Round 2 option (b) signature 拡張案は `_sessionOpts()` executorFactory 固定 lifetime と矛盾で棄却)。**Round 4 P1-2 反映: `routeExecutor` 戻り値を `Promise<AdvertisedExecutorKind | "keyboard">` (observed kind) に変更、内部 keyboard fallback 観測性保全**。

### 5.2 `createDesktopExecutor` 改修 outline (Round 4 case β + observed kind return)

```ts
// src/tools/desktop-executor.ts 改修 (~250-350 line、Round 4 で signature 不変化で規模 縮小)

import type { AdvertisedExecutorKind } from "../capabilities/registry.js";
import type { ExecutorKind, ExecutorOutcome, UiEntity } from "../engine/world-graph/types.js";

// Round 4 P1-1 (case β): createDesktopExecutor signature は不変
// (Round 2 で提案した第 3/4 引数 registry?/viewConstraints? 追加案は executorFactory lifetime 矛盾で棄却)。
// entity.preferredExecutors / unsupportedExecutors / fallbackHint は PR-SR1-1 の bakeEntityCapabilities
// 経由で desktop.see() 内で事前 bake 済 → executor は entity 経由でのみ全情報取得。
export function createDesktopExecutor(
  target: TargetSpec | undefined,
  deps?: ExecutorDeps,
): (entity: UiEntity, action: TouchAction, text?: string) => Promise<ExecutorKind | ExecutorOutcome> {
  const d = deps ?? getSharedRealDeps();
  return async (entity, action, text) => {
    // Round 4 case β: entity.preferredExecutors を直接 consume (registry.lookup は executor で呼ばない)
    // entity.preferredExecutors undefined / 空 → hardcoded fallback ladder
    // (registry lookup 不在 = test 直 invoke / legacy path のみ、Round 4 P2-4 明示化、北極星 8 entity bake invariant 経由で production 経路は必ず entity に bake 済)
    const preferredOrder: AdvertisedExecutorKind[] = (entity.preferredExecutors && entity.preferredExecutors.length > 0)
      ? entity.preferredExecutors
      : ["uia", "cdp", "terminal", "mouse"];
    const blocked: AdvertisedExecutorKind[] = entity.unsupportedExecutors ?? [];

    // 北極星 7 invariant (registry 経由 entity bake 経路): preferredOrder.length ≥ 1 + preferredOrder ∩ blocked = ∅ + narrow type
    // (副作用波 7 = overlap 全 skip → throw を assertCapabilitiesInvariant で事前 throw、
    //  副作用波 2 = 空配列 で全 skip → throw を invariant で構造的不能化、
    //  副作用波 8 = "keyboard" 混入 を AdvertisedExecutorKind narrow type で TS compile-time 防止)

    // 北極星 2 + 3: preferredOrder 配列順に try、最初成功した executor を採用
    // 第 1 候補以外で成功した場合 (or 内部 keyboard fallback で observed kind が intended と異なる場合) は downgrade marker 必須 emit
    const intendedExecutor: AdvertisedExecutorKind = preferredOrder[0]!;  // 北極星 7 (a) で length ≥ 1 invariant
    const errors: Array<{ executor: AdvertisedExecutorKind; err: unknown }> = [];

    for (const executor of preferredOrder) {
      if (blocked.includes(executor)) continue;
      try {
        // Round 4 P1-2: routeExecutor 戻り値で observed kind を返す
        // (UIA setValue 失敗 → keyboardTypeBg fallback 成功時 "keyboard" 返却、内部 fallback 観測性保全)
        const observedKind: AdvertisedExecutorKind | "keyboard" = await routeExecutor(executor, entity, action, text, d, target);
        if (observedKind !== intendedExecutor) {
          // 北極星 3: 任意 [from → to] 組合せの downgrade marker
          // 内部 keyboard fallback (observedKind === "keyboard" かつ executor === "uia") も同 emit path で覆う
          const firstErr = errors.find((e) => e.executor === intendedExecutor);
          const reason = firstErr?.err instanceof Error
            ? firstErr.err.message
            : (executor !== intendedExecutor
                ? String(firstErr?.err ?? "")
                : `internal fallback: ${intendedExecutor} → ${observedKind}`);  // 内部 fallback の reason
          return { kind: observedKind, downgrade: { from: intendedExecutor, reason } };
        }
        return observedKind;  // happy path: bare ExecutorKind (observedKind === intendedExecutor)
      } catch (err) {
        errors.push({ executor, err });
        continue;
      }
    }
    // 副作用波 4 対策: 全 throw 情報を集約、最終 throw で cause chain 保全
    const joinedReason = errors.map((e) => `${e.executor}=${e.err instanceof Error ? e.err.message : String(e.err)}`).join(" / ");
    throw new Error(
      `All preferred executors failed for "${entity.label ?? entity.entityId}": ${joinedReason}`,
      { cause: errors[errors.length - 1]?.err },
    );
  };
}

/**
 * Round 4 P1-2 戻り値: AdvertisedExecutorKind | "keyboard"
 * 入力 executor は AdvertisedExecutorKind (4 executor) のみ (北極星 7 (c))、
 * 内部 keyboard fallback (UIA setValue 失敗 → keyboardTypeBg) 成功時 "keyboard" を返却して observed kind を保全。
 * SR-5 で "keyboard" first-class promotion 時に AdvertisedExecutorKind 型拡張 +
 * routeExecutor 内 keyboard case 追加 (本 SR-1 外)。
 */
async function routeExecutor(
  executor: AdvertisedExecutorKind,
  entity: UiEntity,
  action: TouchAction,
  text: string | undefined,
  d: ExecutorDeps,
  target: TargetSpec | undefined,
): Promise<AdvertisedExecutorKind | "keyboard"> {
  // 既存 desktop-executor.ts:165-275 の各 route ロジックを抽象化、
  // uia / cdp / terminal / mouse の 4 case 分岐で各 d.X() 呼び出し。
  // executor === "uia" + action ∈ {"type","setValue"} の内側で UIA setValue 失敗時に
  // d.keyboardTypeBg(...) fallback、成功時 "keyboard" 返却 (現 desktop-executor.ts:180-197 動作維持)。
}
```

**重要 design 決定** (Round 4 case β + observed kind 反映):
- **case β entity pre-baked capabilities** (Round 4 P1-1、北極星 8 + 北極星 6 signature 不変): `createDesktopExecutor(target, deps?)` signature は **不変** (Round 2 で提案した第 3/4 引数 registry?/viewConstraints? 追加は `_sessionOpts()` line 602 `executorFactory: (target) => createDesktopExecutor(target, this.opts.executorDeps)` 固定 lifetime と矛盾で棄却)。executor は `entity.preferredExecutors / unsupportedExecutors / fallbackHint` を engine internal field 経由で消費、registry.lookup は executor 内で呼ばず `see()` ↔ registry 間で完結。viewConstraints も executor は意識しない。
- **`routeExecutor` 戻り値 = observed kind** (Round 4 P1-2): `Promise<AdvertisedExecutorKind | "keyboard">` で内部 keyboard fallback の observed kind を保全。外側 loop で `observedKind !== intendedExecutor` なら downgrade marker emit (`intendedExecutor === "uia"` + `observedKind === "keyboard"` の内部 fallback ケースも同 emit path で覆う、現 PR #332 が UIA → mouse のみ marker を **任意 [from → to] 組合せに昇格**)。
- **`AdvertisedExecutorKind` 型 narrowing** (Round 4 P2-3 改名、Lesson 2 compile-time guard): 入力 executor 型は `AdvertisedExecutorKind` 4 種、`"keyboard"` は **戻り値の possibility としてのみ許容**。型 alias は registry 1 箇所改修で全 production code narrow 拡張が伝播 (SR-5 で `"keyboard"` 追加 → 型拡張 → routeExecutor 内 keyboard case 追加で対応)。
- **`intendedExecutor` semantic 拡張余地** (Round 2 P2-2、§9 OQ #5): 本 SR-1 は `intendedExecutor = preferredOrder[0]` 固定、SR-5 後の LLM-指定 executor 経路が想定される → 引数化を §9 OQ #5 で明示、SR-5 sub-plan 起草時再諮問。

### 5.3 副作用波 preventive sweep (Round 2 P2-5 反映で 5 → 8 件に拡張、Codex 必須軸)

memory `feedback_codex_side_effect_wave.md` 軸で「fix が新副作用」を事前列挙 (Round 2 で 6/7/8 を新規追加):

| # | 想定副作用 | 検出経路 | 対策 |
|---|----------|---------|------|
| 1 | `preferredOrder` 配列順 route で UIA 成功時に `executor !== intendedExecutor` 判定誤動作 (`intendedExecutor === preferredOrder[0]` 不変判定の取り違え) | Phase 2 contract test C (happy path で bare "uia" string 返却 pin) | PR-SR1-2 内で `intendedExecutor` 定義を `preferredOrder[0]` 1 箇所に固定、再代入禁止 |
| 2 | `preferredOrder` が空配列 `[]` (registry が `{ preferredExecutors: [] }` 返却) で全 route skip → throw | **北極星 7 (a) で構造的不能化** (`lookupDefault` 出力 + `assertCapabilitiesInvariant` で空配列 throw、PR-SR1-1 invariant test pin) | PR-SR1-1 invariant unit test で空配列出力試行 → assertion throw 確認 |
| 3 | `preferredOrder` 順序が `["mouse", "uia"]` の case で UIA-blocked entity が mouse 直行する際に `intendedExecutor === "mouse"` で downgrade marker emit されない (silent success として正しい挙動だが、観測性低下) | Phase 2 contract test C で「intendedExecutor 成功 = bare string / そうでなければ downgrade marker」を pin | PR-SR1-2 で `intendedExecutor === executor` の bare string 返却を default として確立、観測性は SR-5 / 別 PR で追加 marker 検討 |
| 4 | `for...of` ループで `lastErr` 後続失敗で上書きされ最初の throw 情報消失 | Codex Round 1 で「fix の説明が真実か」軸 sweep | PR-SR1-2 で `errors: Array<{executor, err}>` 配列に全 throw を集約、最終 throw で全件 cause chain 保全 (現状 line 189-194 の uia + keyboard joint error message と同 pattern) |
| 5 | `viewConstraints` 受け渡し問題 (Round 4 P1-1 で case β に再変更): Round 2 option (b) signature 直接受け渡し案は `_sessionOpts()` line 602 `executorFactory: (target) => createDesktopExecutor(target, this.opts.executorDeps)` 固定 lifetime と矛盾 → **case β (entity pre-baked capabilities)** 採用で構造解決 | PR-SR1-2 では executor signature 不変 + `bakeEntityCapabilities` helper (PR-SR1-1 land 済) 経由で entity に bake 済前提を消費 | Phase 2 contract test C/E に「entity bake あり / なし両 case」+ `entity.preferredExecutors === undefined` での hardcoded fallback bit-equal pin 追加 (P2-4 と統合) |
| **6** (Round 2 P2-5 新規、Round 3 P2-N1 対策修正) | `defaultRegistry` module-level singleton の test 並列実行 state 共有 race | **北極星 1 + registry interface JSDoc で「pure lookup、internal state 持たない」invariant 明記** (副作用構造的不能化) | PR-SR1-1 で `CapabilityRegistry` JSDoc に「pure lookup invariant」明記、constant data は **module-level `const`** (Round 3 P2-N1)、将来 object cache 追加時は `Object.freeze({...})` で wrap (string primitive 直接 freeze は no-op) |
| **7** (Round 2 P1-2 関連) | `preferredExecutors` ↔ `unsupportedExecutors` overlap (`["uia"]` + `["uia"]`) → 全 skip throw | **北極星 7 (b) で構造的不能化** (`assertCapabilitiesInvariant` で overlap throw、PR-SR1-1 invariant test pin) | PR-SR1-1 invariant unit test で overlap 試行 → assertion throw 確認 |
| **8** (Round 2 P1-1 関連) | `preferredOrder` ループに `"keyboard"` 混入 (将来 SR-5 後の型拡張) → `routeExecutor` 未対応経路 throw | **北極星 7 (c) + AdvertisedExecutorKind type narrowing で構造的不能化** (TS compile-time error) | PR-SR1-2 で `AdvertisedExecutorKind = "uia" | "cdp" | "terminal" | "mouse"` narrow type 採用、SR-5 で型拡張 + `routeExecutor` keyboard case 追加 |

### 5.4 acceptance (PR-SR1-2、Round 2 P2-4 反映で test case 拡張)

- **`createDesktopExecutor(target, deps?)` signature 不変** (Round 4 P1-1 case β、北極星 6 + 北極星 8 entity bake 経由消費)
- route 順序が `entity.preferredExecutors` 配列順に変更 (hardcoded ladder は `entity.preferredExecutors` undefined / 空時の test 直 invoke / legacy fallback のみ、Round 4 P2-4 明示化)
- `routeExecutor` 戻り値が `Promise<AdvertisedExecutorKind | "keyboard">` で内部 keyboard fallback の observed kind 保全 (Round 4 P1-2)
- **`entity.preferredExecutors` 経由 bit-equal 動作 pin** (Round 4 P2-4 case β 整合):
  - Phase 2 contract test C/E 内に「`entity.preferredExecutors` を明示 set した entity で正順序 route + downgrade marker emit」「`entity.preferredExecutors === undefined` で hardcoded ladder が現状 `desktop-executor.ts:158-275` と bit-equal」を新規 case 追加
  - 内部 keyboard fallback case (UIA setValue throw + keyboardTypeBg 成功) で `outcome.downgrade.from === "uia"` + `outcome.kind === "keyboard"` を wire-level pin
  - `desktop.ts` 経路 (registry.lookup → bakeEntityCapabilities → entity.preferredExecutors set → createDesktopExecutor) と test 直 invoke 経路 (entity.preferredExecutors undefined → hardcoded fallback) の両 path で contract test green 維持
- downgrade marker emit が `intendedExecutor !== observedExecutor` 一般化形に構造化 (PR #332 の uia → mouse hand-wired は special case として包含)
- Phase 2 contract test 5 件全 green (特に C/E が wire-level bit-equal pin、downgrade marker emit 仕様維持)
- 既存 vitest suite 全 pass + tsc clean
- **Codex Round 1 で副作用波 8 件 sweep 明示確認** (preventive、§5.3 全件 check、§5.6 prompt 雛形使用)
- Opus phase-boundary review (contract 真意 sweep 軸 + sub-plan 全文 re-read)
- `ExecutorDeps` interface shape 不変 (Phase 2 contract test C/E の mock injection 経路保全、北極星 6)
- **dogfood 実機 smoke 必須** (PR-SR1-2 merge 前に `notification_show` 後 user 確認、R-SR1-2-a 対策)

### 5.5 risk

- **R-SR1-2-a**: route 順序の構造変更で実環境 (production smoke / dogfood) で hardcoded ladder 時代と挙動差が出る (e.g. CDP-only entity で UIA skip → CDP 直行が以前と異なる失敗 path に流れる)。**対策**: PR-SR1-2 merge 前に **dogfood 実機 smoke** を `notification_show` 後ユーザー確認 (CLAUDE.md ユーザー環境)
- **R-SR1-2-b**: `keyboardTypeBg` fallback (line 180-197) の SR-5 scope 衝突。**対策**: PR-SR1-2 では keyboardTypeBg 内部 ladder は現状維持 (`routeExecutor("uia", ...)` の内側で保持)、SR-5 で `AdvertisedExecutorKind` 型拡張 + `routeExecutor("keyboard", ...)` 統合
- **R-SR1-2-c**: Phase 2 contract test C/E が wire-level pin だが、registry lookup 出力の `preferredOrder` 順序が registry 内部実装変更で drift する可能性。**対策**: PR-SR1-1 で `lookupDefault` 出力 bit-equal pin (既存 `desktop-capabilities.test.ts` 27 case + Phase 2 contract test 5 件) を land した状態で PR-SR1-2 着手、registry 出力は機械的に固定
- ~~**R-SR1-2-d** (Round 2 P2-1 反映、Round 4 P1-1 case β 採用で削除): `viewConstraints` option (b) signature 直接受け渡し risk → case β 採用で `createDesktopExecutor` signature 不変、本 risk 消滅。代替 risk は §8 R9 で carry-over (entity bake 不完全による bias loss、北極星 8 + bakeEntityCapabilities helper で構造解決)~~

### 5.6 Codex review prompt 雛形 (Round 2 P2-3 新規追加)

PR-SR1-2 Codex review 起動時に必ず使用 (`@codex review` PR コメントで以下 prompt 明示)、PR-SR1-1 / PR-SR1-3 にも雛形流用:

```
ADR-020 Phase 3 SR-1 PR-SR1-2 review (Round 4 case β + observed kind 反映版):

【副作用波 preventive sweep (sub-plan §5.3 全 8 件 + Round 4 追加観点)】
1. intendedExecutor 取違え (entity.preferredExecutors[0] 固定の再代入有無)
2. 空配列副作用 (北極星 7 (a) + assertCapabilitiesInvariant で構造防止確認)
3. mouse 直行時 downgrade marker 非 emit (silent success 正しい挙動の confirm)
4. lastErr 上書き (errors 配列で全 throw 保全確認)
5. entity bake 経路で desktop.ts:466-473 が bakeEntityCapabilities 呼出に置換され 3 field
   (preferredExecutors / unsupportedExecutors / fallbackHint) 同時 bake 確認 (Round 4 P1-1 北極星 8)
6. defaultRegistry singleton state 共有 race (pure lookup invariant 維持確認、ADVISORY_TEXT module-level const 確認)
7. preferred ∩ unsupported overlap (北極星 7 (b) + assertCapabilitiesInvariant で構造防止確認)
8. "keyboard" 混入 (北極星 7 (c) + AdvertisedExecutorKind narrow type で TS compile-time 防止確認)

【Round 4 P1-2 observed kind 軸】
- routeExecutor 戻り値 Promise<AdvertisedExecutorKind | "keyboard"> で内部 keyboard fallback の observed kind 保全確認
- UIA setValue throw → keyboardTypeBg 成功時に外側 loop で outcome.downgrade.from === "uia" + outcome.kind === "keyboard" emit 確認
- 現 desktop-executor.ts:186 `return "keyboard"` 動作維持確認 (Phase 2 contract test C で内部 fallback case 追加)

【ExecutorDeps + signature 不変軸】
- ExecutorDeps interface shape 不変 (Phase 2 contract test C/E の mock injection 経路保全)
- createDesktopExecutor(target, deps?) signature 不変 (Round 4 case β、第 3/4 引数 registry?/viewConstraints? 追加せず entity 経由消費)
- ExecutorKind 型 (types.ts:36) ↔ EntityCapabilities.preferredExecutors (desktop-constraints.ts:81) の型不整合は AdvertisedExecutorKind narrow で吸収済か

【API contract 真意 sweep】
- Phase 2 contract test C/E が real production fallback path を invoke する設計が保たれているか
  (createDesktopExecutor(target, mockDeps) で entity.preferredExecutors 明示 set 経路 + undefined hardcoded fallback 経路の両方を invoke)
- PR #332 downgrade marker wire-level pin (outcome.downgrade.from === "uia") が任意 [from → to] 一般化 + 内部 keyboard fallback 包含で bit-equal 維持か

【追加 sweep (Round 4 P2-4 unsupportedExecutors fallback 明示化)】
- desktop.ts:466-473 既存 inline 書き戻しが bakeEntityCapabilities 呼出に完全置換されているか
- entity.unsupportedExecutors fallback (`entity.unsupportedExecutors ?? []`) が test 直 invoke / legacy fallback only と sub-plan §5.2 outline + §10 OQ #1 で明示と整合か
- UiEntity engine internal field 拡張 (preferredExecutors? / fallbackHint?) が advisory import なし inline shape で types.ts:127-132 JSDoc 設計意図と整合か

P1/P2/P3 分類 + file:line citation 必須、報告 < 600 words。
```

---

## 6. PR-SR1-3 詳細 (tool description registry derive)

### 6.1 目的

`src/tools/desktop-register.ts:800` の静的文字列 (`"Issue #296: entities[].capabilities (when present) advises executor selection. preferredExecutors[0] is the executor most likely to succeed; if unsupportedExecutors contains 'uia', go straight to mouse_click..."`) を **registry helper 経由生成** に置換、advertise と実装の drift を構造的に発生不能化 (北極星 1)。**JSDoc 言及 3 箇所 (`uia-provider.ts` line 43/87/94)** の `deriveEntityCapabilities` → `CapabilityRegistry.lookup` 文言更新も並行 (Round 2 P1-3 反映)。

### 6.2 registry helper 実装 (PR-SR1-1 で interface 定義済、PR-SR1-3 で実装)

```ts
// src/capabilities/registry.ts に追加 (~50 line、PR-SR1-3 で実装)

/**
 * Round 3 P2-N1 (Opus Round 2 検出): `Object.freeze` は string primitive に対する no-op、
 * 元 cache + freeze 案は invariant 矛盾。module-level `const ADVISORY_TEXT` で
 * **constant 化 + cache 不要** (string 生成コストは 1 回 const eval、副作用波 6 構造的不能化)。
 * 文字列再代入は `const` で TS compile-time guard、本変数の mutation 経路皆無。
 */
const ADVISORY_TEXT =
  "Issue #296: entities[].capabilities (when present) advises executor selection. " +
  "preferredExecutors[0] is the executor most likely to succeed; " +
  "if unsupportedExecutors contains 'uia', go straight to mouse_click instead of click_element " +
  "(saves a InvokePatternNotSupported round-trip on ListItem / TabItem / custom-drawn controls).";

function toolDescriptionAdvisoryDefault(): string {
  // 現状 desktop-register.ts:800 文字列と bit-equal な ADVISORY_TEXT を return
  // (R-SR1-3-a snapshot test pin、P2-N1 で freeze no-op 解消、cache 不要)
  return ADVISORY_TEXT;
}
```

### 6.3 `desktop-register.ts:800` 置換 + `uia-provider.ts` JSDoc 文言更新 (Round 2 P1-3 反映)

```ts
// src/tools/desktop-register.ts:797-801 改修

import { createDefaultCapabilityRegistry } from "../capabilities/registry.js";
const advisoryRegistry = createDefaultCapabilityRegistry();

// ... description string array ...
advisoryRegistry.toolDescriptionAdvisory(),  // line 800 置換
```

```ts
// src/tools/desktop-providers/uia-provider.ts line 43/87/94 JSDoc 更新

// (line 43 周辺) "downstream consumer (CapabilityRegistry.lookup) が pattern を normalised な形で見る..."
// (line 87 周辺) "Issue #296: ... CapabilityRegistry.lookup が advisory を emit する..."
// (line 94 周辺) "Downstream consumers (most importantly CapabilityRegistry.lookup)..."
```

### 6.4 acceptance (PR-SR1-3)

- `CapabilityRegistry.toolDescriptionAdvisory()` 実装 (rule shape ↔ 文章 sync + module-level `const ADVISORY_TEXT` 化、Round 3 P2-N1 反映、cache 不要 + TS `const` guard で mutation 構造的不能化)
- `desktop-register.ts:800` を registry helper 経由生成に置換
- `uia-provider.ts` JSDoc 言及 3 箇所 (`deriveEntityCapabilities` → `CapabilityRegistry.lookup`) 文言更新 (Round 2 P1-3 反映、本 PR で並行処理)
- tool description text の **runtime 出力が PR-SR1-3 land 前後で bit-equal** (CHANGELOG 不要、強制命令 10 範囲外: 内部 refactor で advertise 文言は同等)
  - 検証: `tests/unit/desktop-register-tool-description.test.ts` 等に snapshot test 新規追加、`registry.toolDescriptionAdvisory()` 出力を JSON.stringify で snapshot pin
- Phase 2 contract test 5 件全 green
- **PR-SR1-3 が `toolDescriptionAdvisory()` 呼出のため PR-SR1-1 land 前提** (Round 2 Lesson 3 順序矛盾 sweep 反映、明示依存)
- Opus phase-boundary review + Codex 1+ round (§5.6 prompt 雛形流用)

### 6.5 risk

- **R-SR1-3-a**: `toolDescriptionAdvisory()` 生成文言が現状静的文字列と bit-equal にならず LLM 挙動 drift。**対策**: PR-SR1-3 内で snapshot test (`tests/unit/desktop-register-tool-description.test.ts` 新規) で文言固定、`registry.toolDescriptionAdvisory()` 出力を JSON.stringify で snapshot pin。**carry-over (Round 5 P2-N1)**: 本 SR-1 は bit-equal 維持優先で `ADVISORY_TEXT` を hand-written const として実装、北極星 1 (registry SSOT) 完全達成は「rule shape (preferredExecutors / unsupportedExecutors / fallbackHint mapping) からの文言自動生成」が必要だが、本 SR-1 scope 外。**親 ADR §11 L9 carry-over に「ADVISORY_TEXT rule-shape derive 化」を追加** (rule table 変更時の手動文言更新負荷解消、SR-1 全 PR land 後判断)
- **R-SR1-3-b** (Round 2 P3-2 → Round 3 P2-N1 修正反映): cache 戦略で `cachedAdvisory` mutation 経路があると test 並列実行で race。**対策**: `Object.freeze(string)` は no-op で invariant 偽だったため (Round 3 P2-N1)、**`module-level const ADVISORY_TEXT` 化** で TS compile-time `const` guard により mutation 構造的不能化、cache 自体不要 (副作用波 6 統合対策)

---

## 7. acceptance (SR-1 epic 完了条件)

- PR-SR1-1 / PR-SR1-2 / PR-SR1-3 全 land + main HEAD で全 vitest + tsc clean
- `src/capabilities/registry.ts` 1 SSOT、3 consumer (`deriveEntityCapabilities` thin wrapper / `createDesktopExecutor` route order / `desktop-register.ts:800` description) 全部 registry 経由
- 北極星 7 invariant 3 件 (disjoint / 非空 / narrow type) が `lookupDefault` 出力 + production `assertCapabilitiesInvariant` で機械保証
- Phase 2 contract test 5 件全 green 維持 (refactor 完了状態で v1.6.1 不変条件保持)
- ADR-020 §11 carry-over ledger L2 (C 軸) strikethrough 化 (`[ ] L2 (C)` → `[x] L2 (C)` で構造除去達成 pin)
- **親 ADR §11 carry-over ledger に L9 新 entry 追加** (Round 2 P3-3 反映): `[ ] L9 (UiEntity.unsupportedExecutors ↔ EntityCapabilities engine/advisory boundary collapse)` を ADR-020 全 SR 完了後判断として追加、本 sub-plan 内では追加判断しない

---

## 8. Risks (SR-1 全体)

| R# | risk | 対策 |
|----|------|------|
| R1 | PR-SR1-1 rule table 移管で 1 case でも優先順位入替 → wire shape drift | Phase 2 contract test 5 件 + 既存 `desktop-capabilities.test.ts` 27 case で機械検出、PR description に `git show <SR1-1-commit-hash>` 範囲明記 (Round 2 P3-1) |
| R2 | PR-SR1-2 route 順序構造変更で実環境 hardcoded ladder 時代と挙動差 | dogfood 実機 smoke 必須 (notification_show + user 確認)、PR-SR1-2 merge 前に check |
| R3 | PR-SR1-2 副作用波 (空配列 / overlap / `intendedExecutor` 取違え / lastErr 上書き / "keyboard" 混入 / singleton race 等 8 件) | §5.3 で 8 件事前列挙、Codex Round 1 で sweep 明示確認 (§5.6 prompt 雛形使用、`feedback_codex_side_effect_wave.md` 軸)、北極星 7 invariant 3 件で構造的不能化 |
| R4 | `keyboardTypeBg` 内部 fallback (line 180-197) と SR-5 scope 衝突 | PR-SR1-2 では現状維持 (`routeExecutor("uia", ...)` 内側で保持)、SR-5 で `AdvertisedExecutorKind` 型拡張 + `routeExecutor("keyboard", ...)` 統合 |
| R5 | `ExecutorDeps` interface shape 不変保証が崩れ Phase 2 contract test mock 経路破壊 | 北極星 6 + acceptance に明記、PR-SR1-2 review で `ExecutorDeps` shape diff チェック必須 |
| R6 | PR-SR1-3 tool description 生成文言が現状静的文字列と bit-equal にならず LLM 挙動 drift | snapshot test で文言 pin (`registry.toolDescriptionAdvisory()` 出力 JSON.stringify 化) + **module-level `const ADVISORY_TEXT`** (Round 3 P2-N1、TS `const` guard で mutation 構造的不能化、R-SR1-3-b 統合) |
| R7 | sub-plan 全文 re-read 漏れ (memory `feedback_sub_plan_full_reread.md` 4 round 連続再発 pattern) | 各 Round commit 前に sub-plan 全文 re-read + 修正対象 fact キーワード grep、commit message claim 後 0 件 verify |
| R8 ~~ (Round 2 P1-3 で削除、`uia-provider.ts` callsite 0 件確定済)~~ | | |
| R9 (Round 2 P2-1 → Round 4 P1-1 case β 採用で再書換) | `bakeEntityCapabilities` helper 経由の entity bake が不完全で `entity.preferredExecutors === undefined` のまま executor に到達 → hardcoded fallback ladder 経路に流れ `provider_failed` view bias loss 再発 | 北極星 8 entity bake invariant + `bakeEntityCapabilities` 共通 helper の 3 field 1 batch 書き戻し設計 + Codex review prompt 雛形 (§5.6) で「bake 漏れ callsite grep 確認」必須項目化 + Phase 2 contract test C/E に「`entity.preferredExecutors` 明示 set / undefined 両 case」明示追加 (§5.4) |
| R10 (Round 2 P2-2 反映、Lesson 1 軸) | `intendedExecutor = preferredOrder[0]` 固定 semantic が SR-5 後の LLM 指定経路で破綻 | §9 OQ #5 で明示、SR-5 sub-plan 起草時に再諮問 (本 SR-1 内では固定 semantic) |

---

## 9. Open Questions (Round 2 で OQ #5 新設)

- ~~**OQ #1** (Round 2 で「option (b) 確定」→ Round 4 P1-1 で option (b) は `_sessionOpts()` lifetime 矛盾で棄却 → **case β entity pre-baked capabilities に再確定**)~~ → **Round 4 Resolved**: case β 採用、`createDesktopExecutor` signature 不変、entity 経由消費、`bakeEntityCapabilities` 共通 helper で bake 完全性保証 (北極星 8)。`desktop.ts:466-473` の inline 書き戻しを helper 呼出に置換。test 直 invoke 経路は `entity.preferredExecutors === undefined` → hardcoded fallback ladder (Round 4 P2-4 明示化、Phase 2 contract test C/E に両 case pin)
- **OQ #2** ~~ (Round 2 P3-3 で削除、親 ADR §11 L9 carry-over に昇格)~~
- **OQ #3**: SR-5 (`"keyboard"` first-class promotion) で `routeExecutor` 内 keyboard route を統合する際、PR-SR1-2 の `keyboardTypeBg` 内部 ladder (line 180-197) との merge 方針を SR-5 sub-plan 起草時確定。同時に `AdvertisedExecutorKind` 型拡張 (`"keyboard"` 追加) も SR-5 範囲
- **OQ #4**: registry を **module-level singleton** (`defaultRegistry`) で持つ vs **session ごとに新規生成** で持つかの選択。本 plan は singleton で起草、test mock injectable は signature 拡張で対応 (北極星 1 + 副作用波 6 = pure lookup invariant)。session-scoped registry が将来必要になる場合 (e.g. per-target capability 拡張) は別 epic で再設計
- **OQ #5** (Round 2 P2-2 新規、Lesson 1 causal window 軸): SR-5 後の LLM-指定 executor 経路で `intendedExecutor` semantic を「`preferredOrder[0]` 固定」から「LLM 指定 or `preferredOrder[0]` fallback」に拡張する余地。本 SR-1 内では固定 semantic を保持、SR-5 sub-plan 起草時に `intendedExecutor` 引数化を再諮問

---

## 10. Carry-over ledger sync (親 ADR §11)

SR-1 完了時 strikethrough:

- ADR-020 §11 **L2 (C)**: PR #332 `TouchResult.downgrade` observability marker → **SR-1 で構造除去** (PR-SR1-2 で downgrade marker emit を `intendedExecutor !== observedExecutor` 一般化形に昇格、PR #332 hand-wired は special case として包含)

SR-1 は L2 のみ closure 対象 (L4 = E 軸 = SR-5 / L1 = B 軸 = SR-4 / L6 = G 軸 = SR-2 が別 SR スコープ)。

**親 ADR §11 への新 entry 追加** (Round 2 P3-3 + Round 4 P1-1 case β + Round 5 P2-N1 で 2 軸集約、本 sub-plan で要請):
- **L9 (engine/advisory boundary collapse + advisory text derive 化)** (carry-over): SR-1 全 PR land 後に判断、ADR-020 全 SR 完了後 (Phase 4 想定?) で着手:
  - **L9-a (UiEntity engine field collapse)**: `src/engine/world-graph/types.ts:127-132` の `UiEntity.unsupportedExecutors` + Round 4 P1-1 で本 SR-1 が追加する `entity.preferredExecutors?` + `entity.fallbackHint?` の **3 engine internal field 重複**を `EntityCapabilities` 直参照に collapse する判断。JSDoc 設計意図「engine 層を advisory import 自由にする」と整合的に再設計
  - **L9-b (ADVISORY_TEXT rule-shape derive 化、Round 5 P2-N1 追加)**: 本 SR-1 PR-SR1-3 で実装する `ADVISORY_TEXT` hand-written const 化は bit-equal 維持優先のため rule shape (preferredExecutors / unsupportedExecutors / fallbackHint mapping) からの **文言自動生成**は本 SR-1 scope 外。北極星 1 (registry SSOT) 完全達成には rule table 変更時の手動文言更新負荷を解消する必要があり、L9-b として親 ADR §11 に carry-over (R-SR1-3-a `ADVISORY_TEXT` 維持の trade-off と表裏一体)

---

## 11. 関連 SSOT / 参照先

- `docs/adr-020-path-class-refactor-plan.md` §5.1 SR-1 + §11 carry-over ledger (L9 新 entry 追加対象 = L9-a UiEntity engine field collapse + L9-b ADVISORY_TEXT rule-shape derive 化 の 2 軸、Round 5 P2-N1)
- `src/tools/desktop-capabilities.ts:64` `deriveEntityCapabilities` (rule table 移管元)
- `src/tools/desktop-executor.ts:138-275` `createDesktopExecutor` (PR-SR1-2 主改修対象)
- `src/tools/desktop-constraints.ts:72-86` `EntityCapabilities` type (shape 不変保証対象)
- `src/tools/desktop.ts:466-473` production callsite (PR-SR1-1 で `bakeEntityCapabilities(entity, cap)` 共通 helper 呼出に置換、3 field 同時 bake、case β 経路で executor は entity 経由消費・signature 不変、Round 5 P1-N1 stale 表記訂正)
- `src/tools/desktop-register.ts:800` static description (PR-SR1-3 置換対象)
- `src/tools/desktop-providers/uia-provider.ts` line 43/87/94 JSDoc 言及 3 箇所 (Round 2 P1-3、PR-SR1-3 で文言更新並行)
- `src/engine/world-graph/types.ts:36` `ExecutorKind` (`"keyboard"` 含む 5 executor) + line 127-132 `UiEntity.unsupportedExecutors` (親 ADR §11 L9 cleanup 候補)
- `tests/unit/desktop-capabilities.test.ts` 既存 27 case (bit-equal pin 役)
- `tests/unit/path-class-contract/c-executor-downgrade.test.ts` Phase 2 C contract test (downgrade marker wire-level pin)
- `tests/unit/path-class-contract/e-uia-fallback-ladder.test.ts` Phase 2 E contract test (`preferredExecutors[0] == "uia"` 固定保証)
- `tests/unit/capabilities-registry-invariant.test.ts` (PR-SR1-1 新規、北極星 7 invariant 3 件 pin)
- `tests/unit/desktop-register-tool-description.test.ts` (PR-SR1-3 新規、snapshot test で R-SR1-3-a pin)
- memory `feedback_opus_contract_truth_sweep.md` (PR-SR1-2 で `ExecutorDeps` DI 保全 = contract test production-invoke 経路保全)
- memory `feedback_codex_side_effect_wave.md` (PR-SR1-2 副作用波 8 件 preventive sweep 必須、§5.6 Codex prompt 雛形)
- memory `feedback_sub_plan_full_reread.md` (各 Round commit 前 full re-read + grep verify)
- memory `feedback_auto_mode_merge_opus_judgment.md` (Opus + Codex 両 Approved で AI merge OK)
- CLAUDE.md §3.1 (複数表 fact 整合) / §3.2 (carry-over scope shrink) / §3.3 (review loop 定型) / 強制命令 7 (仕組み化) / 強制命令 9 (残件 docs 永続化) / 強制命令 10 (CHANGELOG: SR-1 は内部 refactor のみで CHANGELOG entry 不要)

---

## 12. 起草 metadata

- 起草日: 2026-05-17 (Round 1)、Round 2 反映: 2026-05-17 (Opus R1 P1×3 + P2×5 + P3×3 全件反映)
- 起草 session: ADR-020 Phase 2 全 closure (PR #335-#338 merged) + user 指示「Phase 3 SR-1 sub-plan 起草」
- baseline commit: `a7c77df` (main HEAD)
- Round 1 起草前 read 済:
  - `docs/adr-020-path-class-refactor-plan.md` 全文 (§5.1 SR-1 + §8 R7 + §11 ledger)
  - memory `MEMORY.md` + `feedback_sub_plan_opus_review_first.md` / `feedback_sub_plan_full_reread.md` / `feedback_codex_side_effect_wave.md` / `feedback_opus_contract_truth_sweep.md` / `feedback_auto_mode_merge_opus_judgment.md`
  - CLAUDE.md §3.1/§3.2/§3.3 (review loop 定型)
  - baseline コード: `src/tools/desktop-capabilities.ts` 全文 / `src/tools/desktop-executor.ts` 全文 / `src/tools/desktop-constraints.ts` 全文 / `src/engine/world-graph/types.ts` (capabilities 関連) / `src/tools/desktop-register.ts:797-801` / `src/tools/desktop.ts:464-471` / `tests/unit/path-class-contract/c-executor-downgrade.test.ts` 全文
  - `Grep deriveEntityCapabilities` 8 file 影響範囲 (Round 1 時点で `uia-provider.ts` callsite 未確認、Round 2 で full read 確認 → callsite 0 件 / JSDoc 言及 3 箇所に訂正)
- Round 2 反映点 (Opus R1 P1×3 + P2×5 + P3×3 全件):
  - **P1-1** (`ExecutorKind` ↔ `EntityCapabilities.preferredExecutors` 型不整合): §2 北極星 7 新設 (invariant (c) narrow type) + §5.2 `AdvertisedExecutorKind` type narrowing + §5.3 副作用波 8 新設 (TS compile-time 防止) + §8 R4 / §9 OQ #3 で SR-5 統合方針明示
  - **P1-2** (preferred ∩ unsupported overlap invariant 不在): §2 北極星 7 新設 (invariant (a) 非空 + (b) disjoint) + §4.2 `assertCapabilitiesInvariant` 実装 + §4.5 acceptance に invariant unit test 新規追加 (`tests/unit/capabilities-registry-invariant.test.ts`) + §5.3 副作用波 7 構造的不能化対策追記
  - **P1-3** (`uia-provider.ts` callsite 0 件): §4.4 表訂正 (callsite 0 件 / JSDoc 言及 3 箇所) + §6.3 PR-SR1-3 で JSDoc 文言更新並行 + §6.4 acceptance 追加 + §8 R-SR1-1-b 削除 + §10 OQ #2 削除
  - **P2-1** (option (a) viewConstraints 間接消費で provider_failed bias loss): §5.2 outline で option (a) → option (b) signature 直接受け渡しに変更 (`createDesktopExecutor` 第 4 引数 `viewConstraints?` 追加) + §5.4 acceptance で `desktop.ts` callsite 同時更新確認 + §5.3 副作用波 5 を構造解決対策に書換 + §8 R9 新設 + §9 OQ #1 更新
  - **P2-2** (`intendedExecutor` 単一固定の causal window 設計): §9 OQ #5 新規追加 (SR-5 後 LLM-指定経路で `intendedExecutor` 引数化余地) + §8 R10 新設 (Lesson 1 軸)
  - **P2-3** (Codex review prompt 雛形不在): §5.6 新規追加 (Codex review prompt 雛形、副作用波 8 件 + ExecutorDeps shape 保全 + ExecutorKind keyboard 型 invariant + API contract 真意 sweep + 追加 sweep の 4 block 構成)
  - **P2-4** (registry undefined 返却経路 bit-equal pin test 不在): §5.4 acceptance に「registry を `{ lookup: () => undefined }` で injection した場合の hardcoded ladder bit-equal 動作 pin」+ `viewConstraints` あり / なし両経路 test case 新規追加
  - **P2-5** (singleton state 共有 race): §5.3 副作用波 6 新設 (構造的不能化対策) + §4.2 `CapabilityRegistry` JSDoc に「pure lookup、internal state 持たない」invariant 明記 + §6.2 cache 戦略 (immutable readonly + `Object.freeze`) で mutation 構造的不能化
  - **P3-1** (PR description diff 全文添付 → `git show <hash>` 範囲): §4.6 R-SR1-1-a 対策修正
  - **P3-2** (`toolDescriptionAdvisory()` cache 戦略 + JSDoc 明記): §6.2 immutable readonly cache + `Object.freeze` 実装 + §4.2 JSDoc 「副作用なし pure lookup」明記 + §8 R-SR1-3-b 新設
  - **P3-3** (4 番目 PR cleanup を親 ADR §11 L9 carry-over に昇格): §3 PR 分割確定で「PR-SR1-4 は本 sub-plan scope 外、親 ADR §11 L9 として ADR-020 全 SR 完了後判断」と明示 + §7 acceptance に「L9 新 entry 追加」+ §10 L9 entry 詳細 + §9 OQ #2 削除
- Round 2 OQ 確定: OQ #1 更新 (option (b) 確定)、OQ #2 削除 (L9 carry-over 昇格)、OQ #3 更新 (SR-5 統合方針)、OQ #4 不変、OQ #5 新規追加 (Lesson 1 軸)
- Round 3 反映点 (Opus R2 P2×2 + P3×2、Lesson 2 compile-time guard 補強軸):
  - **P2-N1** (`Object.freeze(string)` no-op invariant 矛盾): §6.2 `cachedAdvisory + Object.freeze` 案を **module-level `const ADVISORY_TEXT`** に書換 (TS `const` guard で mutation 構造的不能化、cache 不要) + §8 R6 / §8 R-SR1-3-b 整合修正
  - **P2-N2** (`as AdvertisedExecutorKind[]` cast compile-time signal spoof): §4.2 で `AdvertisedExecutorKind` を single SSOT 化 (`src/capabilities/registry.ts` から export) + `EntityCapabilities.preferredExecutors` / `unsupportedExecutors` を `AdvertisedExecutorKind[]` に narrow 化 (`desktop-constraints.ts:81` 既存 inline `Array<"uia"|"cdp"|"terminal"|"mouse">` と等価で wire shape 不変) + §5.2 outline で cast 削除 + §4.5 acceptance に type narrow 化 + §3 PR-SR1-1 scope に type narrow 化追加
  - **P3-N1** (`assertCapabilitiesInvariant` narrow type runtime check 欠落): §4.2 `ALLOWED_EXECUTORS = new Set([...4 executor])` + runtime check 追加 (defense-in-depth、`"keyboard"` 等の意図せざる混入を runtime 検出) + §4.5 acceptance に「不正 executor 注入 test case」追加 (9+ case 化)
  - **P3-N2** (PR-SR1-2 ↔ PR-SR1-3 並走可否曖昧): §3 outline で「PR-SR1-1 land 後、PR-SR1-2 と PR-SR1-3 は **scope disjoint で worktree 並走可能** (CLAUDE.md §3.4)」明示 + 並走条件「両 PR とも PR-SR1-1 の registry interface + AdvertisedExecutorKind narrow land 前提」
- Round 3 累積 closure: Round 1 P1×3 + P2×5 + P3×3 (= 11 件) + Round 2 P2×2 + P3×2 (= 4 件) = **累積 15 件 closure**、新規 OQ 追加なし (Round 3 は Round 2 検出指摘の bit-equal 反映のみ)
- Round 4 反映点 (User judgment による補正 P1×2 + P2×2 + P3×2 = 6 件、Opus + 私の self-grep 3 round が見逃した構造盲点、memory `project_adr008_d2_c_plan_done.md` Lesson 1-4 同型 User reviewer 補正 PR #99/#102/#103/#104 4 連続 pattern と同型再発):
  - **User P1-1** (viewConstraints lifetime 構造矛盾): Round 2 で確定した option (b) `createDesktopExecutor(...,registry?,viewConstraints?)` 第 3/4 引数案は `src/tools/desktop.ts:602` `_sessionOpts()` の `executorFactory: (target) => createDesktopExecutor(target, this.opts.executorDeps)` 固定 lifetime と矛盾。3 案 (α SessionState 保持 / β entity pre-baked capabilities / γ executorFactory 拡張) のうち **case β を採用** (既存 `desktop.ts:469-471` `entity.unsupportedExecutors` 書き戻し pattern と完全整合)。§1.5 新設で構造分析明示、§2 北極星 6 を「signature 不変」に修正 + 北極星 8 entity bake invariant 新設、§3 PR-SR1-1 scope に `bakeEntityCapabilities` helper + `UiEntity` engine field 拡張 (`preferredExecutors?` / `fallbackHint?`) + `desktop.ts:466-473` 置換追加、§5.2 outline 全面書換 (signature 不変 + entity 経由消費)、§9 OQ #1 case β 確定で Resolved
  - **User P1-2** (`routeExecutor` return value で keyboard fallback observed kind 喪失): Round 2/3 `routeExecutor(...): Promise<void>` 設計だと内部 keyboard fallback (UIA setValue throw → keyboardTypeBg) 成功時 observed kind が `"uia"` のまま外側で扱われ、現 `desktop-executor.ts:186` の `return "keyboard"` 動作を破壊。**`Promise<AdvertisedExecutorKind | "keyboard">` に変更**、外側 loop で `observedKind !== intendedExecutor` で downgrade marker emit、内部 fallback ケースも同 emit path で覆う。§5.2 outline + §5.4 acceptance に observed kind pin 追加
  - **User P2-3** (`RouteExecutorKind` 型名意図不明確で SR-5 衝突): 「route 経路の全 executor」と読めて SR-5 後の `"keyboard"` 追加で意味が変わるため、**`AdvertisedExecutorKind` に改名** (advertised executor only と意図限定)。§4.2 JSDoc に「SR-5 で型拡張」明示、全 section で grep 一括置換 (Round 4 で `Edit replace_all` 実施)
  - **User P2-4** (registry SSOT 主張と `entity.unsupportedExecutors` fallback の矛盾): Round 1-3 で「`entity.unsupportedExecutors ?? []`」を 2nd source として温存していたが SR-1 closure 条件が曖昧。**「registry 取得不在 = test 直 invoke / legacy fallback only」と §3 PR-SR1-2 scope + §5.2 outline + §10 OQ #1 で明示**、本 SR-1 では engine internal field として保持 + L9 で final collapse
  - **User P3-5** (`executePreferred` 表記訂正): §1.1 表 row C の `desktop-executor.ts::executePreferred` → `desktop-executor.ts:144-275 createDesktopExecutor` に訂正 (現コードに `executePreferred` 関数なし、`createDesktopExecutor` が返す async function 本体)
  - **User P3-6** (trigger 文「ledger L1-L6 全件構造除去達成」過剰): SR-1 直接 closure は L2/C のみ (L4/E は SR-5、L6/G は SR-2、L1/B は SR-4)、Phase 2 land は L3/L5 構造除去 + L1/L2/L4/L6 tactical safety net 状態。**冒頭 trigger 行を「Phase 2 contract test 5 件 safety net + D/F 小 refactor 完了で L3/L5 構造除去達成、L1/L2/L4/L6 は SR-4/SR-1/SR-5/SR-2 で順次構造除去」に弱める**、§10 ledger sync section と整合
- Round 4 累積 closure: Round 1 (11) + Round 2 (4) + Round 4 (6) = **累積 21 件 closure**、新規 OQ 追加なし (OQ #1 は case β で Resolved 化)
- Round 5 反映点 (Opus R4 P1-N1 + P1-N2 + P2-N1、規範 section drift `feedback_sub_plan_full_reread.md` 4 連続再発 pattern と同型再発の自己救済):
  - **P1-N1** (§11 line 610 で Round 2 option (b) artifact「viewConstraints 引数追加」残存): case β 採用と直接矛盾、PR-SR1-2 着手時 reviewer が §11 を真と読めば signature 拡張改修に流れる risk。`bakeEntityCapabilities 経由 entity bake 置換 + executor 経由消費・signature 不変` に書換
  - **P1-N2** (§1.4 line 42 で `registry?` 第 3 引数案残存): case β signature 不変と矛盾。「registry は `desktop.ts::see()` 内 1 callsite で DI 可能設計、executor 自体は entity 経由で全情報取得 (北極星 6 signature 不変)」に書換
  - **P2-N1** (§6.5 R-SR1-3-a で bit-equal 維持 trade-off 明記): `ADVISORY_TEXT` hand-written const 化は本 SR-1 scope 内、rule-shape derive 化は親 ADR §11 L9 carry-over 追加 (rule table 変更時の手動文言更新負荷解消、SR-1 全 PR land 後判断)
  - **P3-N1** (§12 changelog 簡易追記、optional): 本 Round 5 changelog 自体が追記となるため skip
- Round 5 累積 closure: Round 1 (11) + Round 2 (4) + Round 4 (6) + Round 5 (3) = **累積 24 件 closure**、新規 OQ 追加なし
- Round 4 + Round 5 で **2 連続「規範 section drift 自己救済」発生**: memory `feedback_sub_plan_full_reread.md` 4 連続再発 pattern が機能、Round 4 で User judgment 6 件反映 → 規範 section drift 2 件 (§1.4 + §11) 取り残し → Opus Round 4 が即時検出 → Round 5 で全件解消 (sweep 構造の自己実証)
- Round 6 反映点 (Opus R5 P2-N1 trivial sync、§10/§11 への L9 carry-over 新項目 2 軸明示化):
  - **P2-N1** (§6.5 R-SR1-3-a で追加した「ADVISORY_TEXT rule-shape derive 化」carry-over が §10 + §11 で未集約): §10 L9 entry を **L9-a (UiEntity engine field collapse) + L9-b (ADVISORY_TEXT rule-shape derive 化)** の 2 軸構造に拡張、§11 関連 SSOT line 606 を「L9 新 entry 追加対象 (UiEntity collapse + ADVISORY_TEXT derive 化 の 2 軸)」に明示化
- Round 6 累積 closure: Round 1 (11) + Round 2 (4) + Round 4 (6) + Round 5 (3) + Round 6 (1) = **累積 25 件 closure**、新規 OQ 追加なし
- Round 4 + Round 5 + Round 6 で **3 連続「規範 section drift 自己救済」成功**: User judgment (Round 4) → Opus Round 4 検出 → Round 5 反映 → Opus Round 5 検出 → Round 6 反映 = sweep 構造の **3 連続正動作**、memory `feedback_sub_plan_full_reread.md` 仕組み化が完全機能
- **判定**: Opus Round 5 「修正後 Approved 推奨、修正 trivial」明示判定 + Round 6 修正 trivial (§10 + §11 計 2 文追記、規範 section drift sync 漏れ 1 件のみ、新規 design 変更ゼロ) → **Opus Round 6 re-review は overkill 判断**、grep verify で sync 確認のみで user 諮問へ進行 (memory `feedback_auto_mode_merge_opus_judgment.md` 整合、Opus Round 5 が明示 Approved 判定済)
- 次 step: 本 Round 6 反映後 → grep verify (L9-a / L9-b sync 確認) → user 最終承認 → PR-SR1-1 着手
