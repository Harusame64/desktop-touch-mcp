# ADR-020 Phase 2 PR-P2-3 — contract test 6 件 land + fast-check 導入 sub-plan

- Status: **Drafted (2026-05-17、Round 4 = PR Opus Round 1 P1×2 + P2×3 + P3×2 反映、C/E test を production-invoke (createDesktopExecutor + ExecutorDeps mock) で revert/diff 検出力成立)**
- 親 ADR: `docs/adr-020-path-class-refactor-plan.md` (epic plan、merged PR #335) — 本 sub-plan は親 ADR §4.5 「PR-P2-3 = `fast-check` dev dep 導入 + 6 contract test 全件 land」に対応 (命名は contract-test 性質を反映、refactor 接尾辞なし)
- 該当 Phase / 軸: Phase 2 PR-P2-3 (contract test land、scope §4.2 + §4.5 + §4.6)
- 関連 sub-plan: `docs/adr-020-phase-2-p2-1-modal-refactor-plan.md` (merged PR #336、classifyModal 既出) + `docs/adr-020-phase-2-p2-2-lease-ttl-refactor-plan.md` (merged PR #337、computeLeaseTtlMs 既出)
- 関連 issue: #327 全 6 件 (B/C/D/E/F/G、tactical fix → Phase 2 で構造除去確定)

---

## 0. 親 ADR + user 判断引き継ぎ (2026-05-17 session で先取り確定)

本 sub-plan は ADR-020 land + PR-P2-1 + PR-P2-2 land 直後の user judgment session (2026-05-17) で以下が確定済:

**Phase 2 contract test design (本 sub-plan に直接影響)**:
- 6 不変条件 (ADR-020 §4.2): D (property-based) / B (property-based) / C (table + generated variants) / G (table + generated variants) / F (純粋関数 unit test) / E (table + generated variants)
- library: `fast-check` 採用 (ADR-020 OQ #2 Resolved)、ただし全件 property-based にしない
- 配置: `tests/unit/path-class-contract/*.test.ts` (既存 `vitest.config.ts` `unit` project glob で自動 include、config 変更不要)
- 代表 2-3 件 (D + F + 1 件) で v1.6.1 fix 意図的 revert/diff し検出力実証、6 件全部の revert PR は不要 (ADR-020 §4.6)
- 3 件目 recommended = **C** (`TouchResult.downgrade` marker、revert cost 最小、ADR-020 §4.6 + Round 6 P3-1 反映)

**memory 教訓引き継ぎ (本 PR で必ず適用)**:
- `feedback_sub_plan_opus_review_first.md`: 本 sub-plan は draft 完了直後に **Opus phase-boundary review を必ず通す** (user 諮問前)、PR-P2-1/P2-2 同型運用の救済不要に
- `feedback_sub_plan_full_reread.md`: Round 内 sub-plan 全文 re-read mandatory 化、rename 系は全 occurrence grep で 0 件 verify
- `feedback_codex_side_effect_wave.md`: Codex 補完軸の副作用波を preventive sweep する、production code 改修 PR は Codex 必須

---

## 1. Scope

### 1.1 [in scope] 本 PR-P2-3 で扱う

A. **`fast-check` dev dependency 導入**: `npm install -D fast-check` (grep 確認: `package.json` devDependencies + `package-lock.json` で 0 件、未インストール)
B. **`tests/unit/path-class-contract/` directory 新設** (既存 `vitest.config.ts` `unit` project の `tests/unit/**/*.test.ts` glob で自動 include、config 変更不要)
C. **6 不変条件 contract test land** (5 file 新設 + F は PR-P2-2 既 land で重複排除):
   - `path-class-contract/d-modal-classifier.test.ts` (D 軸、property-based with fast-check)
   - `path-class-contract/b-dxgi-cache-state.test.ts` (B 軸、property-based with fast-check) ※純粋関数 surface 探索が impl 段階で必要
   - `path-class-contract/c-executor-downgrade.test.ts` (C 軸、table + generated variants)
   - `path-class-contract/g-suggests-dict.test.ts` (G 軸、table + generated variants)
   - `path-class-contract/e-uia-fallback-ladder.test.ts` (E 軸、table + generated variants)
   - **F は本 PR では新規 file 不作成** (Round 2 Opus P2-3 反映): PR-P2-2 で `tests/unit/lease-ttl-policy.test.ts` に既 land 済の 2-branch contract test 10 case が F 軸の `computeLeaseTtlMs` 純粋関数 contract を pin 済 (重複防止)。代表 3 件 (D + F + C) revert/diff 実証で F は **既 land file を対象**として扱う
D. **代表 3 件 (D + F + C) で revert/diff 検出力実証** (C は recommended、PR-P2-3 review で user 最終確定):
   - D revert = PR #331 `isChromeControlType` 共有抽出 + `isModalLike` 同期 を意図的に巻き戻し → `d-modal-classifier.test.ts` が fail することを手元 diff で確認、commit hash + 期待 fail を PR-P2-3 説明に明記
   - F revert = PR #328 `LEASE_TTL_POLICY.baseMs` 5_000 戻し + `observedRoundTripMs` 引数削除を意図的に revert → **`tests/unit/lease-ttl-policy.test.ts:120` 以降 `observedRoundTripMs 2-branch contract (F)` describe block** (PR-P2-2 既 land 10 case) の branch (a)/(b)/defensive case が fail (Round 3 High 反映、削除した `f-lease-ttl-2branch.test.ts` 参照を訂正)
   - C revert = PR #332 `TouchResult.downgrade` marker 削除を意図的に revert → `c-executor-downgrade.test.ts` の silent fallback 禁止 case が fail
E. **helper export 整理** (minimum):
   - D: `classifyModal` 既出 (`session-registry.ts`)、追加 export なし
   - F: `computeLeaseTtlMs` 既出 (`lease-ttl-policy.ts`)、追加 export なし
   - B: **既存 observable surface を使用** (Round 3 Medium 反映、新 helper 切り出しは SR-4 carry-over): `src/engine/any-change.ts:195` `DirtyRectSubscriptionCache.acquireWithState()` + `invalidate()` で既に state 観測可能 (PR #333 で `cacheState` 5-value instrumentation 追加済)。test は `acquireWithState()` の戻り値 `cacheState` field を pin、純粋 helper 新設は **SR-4 (DXGI broker) carry-over** (本 PR は runtime 不変原則維持)。Round 2 P1-1 訂正: 元 draft で `src/perception/visual-motion-cache.ts` と書いたが grep で directory 不存在
   - C: `preferredExecutors` + `TouchResult.downgrade` marker 探索 — `src/tools/desktop-capabilities.ts` + `src/tools/desktop-executor.ts` 周辺 (PR #332 で marker 追加) に純粋判定関数 expose
   - G: `SUGGESTS` dict 既出 (`src/tools/_errors.ts`)、`if_unexpected` description 取得 helper の export 確認
   - E: **既存 observable surface を使用** (Round 3 Medium 反映、新 API 不作成): `src/tools/desktop-capabilities.ts` `deriveEntityCapabilities()` (advertised entity の `preferredExecutors` 取得) + `src/tools/desktop-executor.ts` `createDesktopExecutor()` (UIA setValue failure → keyboard fallback emit) を直接呼び、`preferredExecutors[0] === "uia"` + UIA setValue failure → keyboard fallback marker 動作を pin。`executionPlan / plan trail` 等の新 API は本 PR scope 外 (= 既存 export のみ使用、runtime 不変)

### 1.2 [out of scope] 本 PR で扱わない

- `vitest.config.ts` 拡張 (`tests/contract/**` 等): 本 PR は既存 `tests/unit/` glob で完結、§4.3 user 確定方針通り
- Phase 3 SR-1 〜 SR-4 (構造改修): 各 SR sub-plan で扱う、本 PR は contract test pin のみ
- runtime behavior 変更: 本 PR は test 追加 + helper export 整理のみ、production runtime 不変
- 6 件全部の revert PR: 代表 3 件 (D + F + C) のみ、§4.6 user 確定方針通り

---

## 2. 北極星 (本 sub-plan)

ADR-020 §2 全 4 項目を継承 + 本 PR 固有:

1. **Phase 2 全 6 contract test green safety net 完成** (= ADR-020 §4 acceptance): Phase 3 SR-1/5/2/4 の構造改修中に v1.6.1 不変条件が後退しないことを機械的に pin する
2. **代表 3 件 revert/diff 検出力実証** (= ADR-020 §4.6): contract test が brittle に終わらず本物の regression を捕捉できることを手元実証 + PR 説明 pin
3. **production code runtime 不変**: helper export 整理 (= 既存 internal helper を test 用に export 拡張するだけ)、runtime behavior 変更ゼロ

---

## 3. 既存コード状況 (探索結果)

### 3.1 grep 確認済

- `fast-check`: package.json に未存在 (PR-P2-3 で `-D` 追加)
- `tests/unit/path-class-contract/`: directory 未作成 (本 PR で新設)
- `vitest.config.ts`: `unit` project `tests/unit/**/*.test.ts` glob (config 変更不要)
- `classifyModal` (D): `src/engine/world-graph/session-registry.ts:93-110` 既 export (PR #336)
- `computeLeaseTtlMs` (F): `src/engine/world-graph/lease-ttl-policy.ts:97-110` 既 export (PR #337)

### 3.2 impl 段階で探索が必要 (本 sub-plan 起草時点で未確定)

- **B (DXGI cacheState 既存 surface 使用)**: `src/engine/any-change.ts:195` `DirtyRectSubscriptionCache.acquireWithState()` 戻り値 `cacheState` field を test pin (Round 3 Medium 反映、純粋 helper 切り出しは SR-4 carry-over、本 PR runtime 不変)。Round 2 P1-1 訂正: 元 draft で `src/perception/visual-motion-cache.ts` と書いたが grep で directory 不存在
- **C (preferredExecutors + downgrade marker)**: `src/tools/desktop-capabilities.ts` `deriveEntityCapabilities()` (preferredExecutors emit、line 64) + `src/tools/desktop-executor.ts` `createDesktopExecutor` factory closure :212-217 (downgrade marker emit、PR #332 追加) を read (Round 2 P1-2 訂正: 元 draft で `executePreferred + line 158-172` と書いたが grep で 0 件、`createDesktopExecutor` factory + line 212-217 が実体)
- **G (SUGGESTS dict + if_unexpected description)**: `src/tools/_errors.ts` (`SUGGESTS` dict 既出、PR #329 で `ExecutorFailed` entry 追加) + tool description 取得経路 (= `desktop-register.ts` or `_envelope.ts`) を read
- **E (既存 capabilities + executor surface 使用)**: `src/tools/desktop-capabilities.ts` `deriveEntityCapabilities()` (preferredExecutors emit) + `src/tools/desktop-executor.ts` `createDesktopExecutor()` (UIA setValue failure → keyboard fallback、PR #330 で `keyboardTypeBg` 追加) を直接呼び test pin (Round 3 Medium 反映、`executionPlan / plan trail` 新 API は本 PR scope 外)

これら 4 軸の helper export 整理が必要なら、PR-P2-3 内で minimum 追加 export (= test 用 named export 拡張のみ、runtime behavior 不変)。

---

## 4. 実装内訳 (PR 単一、推定 ~400-600 line)

### 4.1 新規追加

| file | 内容 | 推定 line |
|------|------|----------|
| `package.json` | `devDependencies` に `fast-check` 追加 | +2 |
| `tests/unit/path-class-contract/d-modal-classifier.test.ts` | D 軸 property-based test (fast-check arbitrary entity generator + 不変条件 `classifyModal(e, "pre-touch") with no excludeSelf ⇔ classifyModal(e, "post-touch-diff")` 100 runs / shrinking) | +80-100 |
| `tests/unit/path-class-contract/b-dxgi-cache-state.test.ts` | B 軸 property-based test (fast-check elapsedMs + failureKind arbitrary + 5-value cacheState 純粋遷移 100 runs) | +80-100 |
| `tests/unit/path-class-contract/c-executor-downgrade.test.ts` | C 軸 table + generated variants (advertise preferredExecutors entity / mouse fallback 経路で `response.downgrade` marker 必須) | +60-80 |
| `tests/unit/path-class-contract/g-suggests-dict.test.ts` | G 軸 table + generated variants (`SUGGESTS` dict が tool description `if_unexpected` の全 entry を cover) | +60-80 |
| `tests/unit/path-class-contract/e-uia-fallback-ladder.test.ts` | E 軸 table + generated variants (advertised entity の executionPlan.executors[0]==="uia" 固定保証 + fallback ladder marker 必須) | +60-80 |
| ~~`tests/unit/path-class-contract/f-lease-ttl-2branch.test.ts`~~ | **本 PR では新規作成しない** (Round 2 P2-3 反映: PR-P2-2 で `tests/unit/lease-ttl-policy.test.ts` に 10 case 既 land 済、本 PR で重複防止)。F 軸代表 revert 実証は既 land file が対象 | — |
| `tests/unit/path-class-contract/_helpers.ts` (新規 if needed) | 共通 arbitrary generator (entity arbitrary / failure-code arbitrary 等) | +50-80 |

### 4.2 既存改修 (minimum、test 用 export 拡張)

- B / C / E / G で純粋判定 helper の export 拡張が必要な file (§3.2 探索結果次第): minimum 追加 export、runtime behavior 不変
- impl 段階で具体 file が判明、本 sub-plan §1.1 E に範囲は明示済

---

## 5. acceptance criteria

- `fast-check` dev dep 追加 + **6 軸 contract test 全件 green** (新規 5 file = `path-class-contract/` 配下の D/B/C/G/E + 既存 F test = `tests/unit/lease-ttl-policy.test.ts:120` 以降 10 case、Round 3 Medium 反映で「6 test 全件」表現を実 scope に sync)
- property-based test (D / B) が 100 random runs / shrinking 有効で安定 pass (CI で 2-3 run 連続 verify)
- 代表 3 件 (D + F + **C recommended、PR-P2-3 review で user 最終確定**) で v1.6.1 fix revert/diff し対応 test fail を手元 diff で確認、PR-P2-3 説明に commit hash + 期待 fail 一覧 pin (Round 2 P2-2 反映で確定/未確定揺れ解消)
- ADR-020 carry-over ledger L1-L6 (B/C/D/E/F/G) 全件 **strikethrough 候補化** (formal close は Phase 3 完了時、本 PR で contract test pin により構造除去完了 trigger)
- 既存 vitest suite 全 pass + tsc clean
- Opus + Codex 各 1+ round Approved (production code 改修ほぼなし + test land だが Phase 2 完了 trigger PR のため Opus phase-boundary review 必須、§3.3 Step 0 production-touching PR 扱い)
- Phase 3 SR-1 (CapabilityRegistry) 起草 trigger 解除

---

## 6. Risks

| R# | risk | 対策 |
|----|------|------|
| R1 | fast-check 導入で test 実行時間が膨らむ | 100 runs / per-property 上限、CI 並列実行、純粋関数 (F) + table (C/G/E) は fast-check 不使用で軽い |
| R2 | property-based test が brittle (`internal helper signature 直接 assert` で実装変更で easily 壊れる) | contract test は **observable behavior** を assert (§4 R5 ADR-020 継承)、`classifyModal` / `computeLeaseTtlMs` 等の **production API 経由のみ** pin、internal helper 直接 assert 禁止 |
| R3 | revert/diff 検出力実証で代表 3 件 (D + F + C) の選定根拠が弱い | ADR-020 §4.6 で C recommended 根拠 (revert cost 最小 + downgrade marker contract が C 軸そのものを pin) を継承、PR-P2-3 review で user 最終確定 |
| R4 | B / C / E / G の純粋判定 helper export が runtime behavior 変更を伴う | minimum export 拡張 (= 既存 internal を named export として外出しのみ、関数本体は不変)、Opus phase-boundary review で sweep |
| R5 | sub-plan §3.2 探索結果が impl 段階で予想と乖離 (helper が無い / refactor 大きい) | impl 段階で Opus / user 諮問、本 sub-plan §3.2 に「探索結果次第で sub-plan 改訂」明示 |
| R6 | sub-plan 起草直後の Opus phase-boundary review を本 PR で漏れる (PR-P2-1/P2-2 同型再発) | memory `feedback_sub_plan_opus_review_first.md` 準拠で **本 sub-plan land 前に Opus review trigger 必須** (本 §13 metadata 末尾に明示) |

---

## 7. Open Questions

### 残存

- ~~**OQ #1**: B 軸 helper 探索~~ → **Round 3 で Resolved**: 既存 `DirtyRectSubscriptionCache.acquireWithState()` (`src/engine/any-change.ts:195`) で cacheState 観測可能、test 直接 pin で完結。純粋 helper 切り出しは SR-4 (DXGI broker) carry-over (runtime 不変原則維持)
- **OQ #2**: 6 contract test file 命名規約 — `d-modal-classifier.test.ts` / `b-dxgi-cache-state.test.ts` 形 (`<軸>-<内容>.test.ts`) で OK か、もしくは `modal-classifier-d.test.ts` / `dxgi-cache-state-b.test.ts` (`<内容>-<軸>.test.ts`) か → 軸先頭で alphabetical sort 整列が読みやすい (採用)
- **OQ #3**: 代表 3 件 (D + F + C) の C 確定 — ADR-020 §4.6 + Round 6 P3-1 + 本 sub-plan §1.1 D / §5 で **C recommended、PR-P2-3 review で user 最終確定 (G / B も option)** と確定/未確定 揺れを解消済 (Round 2 P2-2 反映)

---

## 8. 起草 metadata

- 起草日: 2026-05-17 (Round 1)、Round 2 反映: 2026-05-17 (Opus phase-boundary review)
- 起草 session: PR-P2-2 land 直後 (commit `dcc69b03`、auto-mode で PR-P2-3 起動 user 確定)
- 起草前 read 済: ADR-020 全体 + PR-P2-1 sub-plan + PR-P2-2 sub-plan + `package.json` (fast-check 未確認) + `vitest.config.ts` (unit project glob) + `tests/unit/path-class-contract/` (未作成) + memory `feedback_sub_plan_opus_review_first.md` / `feedback_sub_plan_full_reread.md` / `feedback_codex_side_effect_wave.md`
- Round 2 反映点 (Opus phase-boundary review P1×2 + P2×3 + P3×1):
  - **P1-1 (§3.2 B file path 不存在)**: 元 draft `src/perception/visual-motion-cache.ts` (directory 不存在) → `src/engine/any-change.ts` + `src/tools/_input-pipeline.ts:558` に訂正 (grep 確認: `cacheState` + `DirtyRectSubscriptionCache` 実体)
  - **P1-2 (§3.2 C 関数名誤り)**: 元 draft `executePreferred + line 158-172` (関数不存在) → `createDesktopExecutor` factory closure :212-217 (downgrade marker emit) に訂正
  - **P2-1 (sub-plan 命名規約 mismatch)**: §0 冒頭で「親 ADR §4.5 PR-P2-3 = 本 sub-plan、命名は contract-test 性質を反映」を 1 行明示
  - **P2-2 (C 確定/未確定 揺れ)**: §1.1 D + §5 acceptance + §7 OQ #3 で「C recommended、PR-P2-3 review で user 最終確定」と弱化済表記に sync (元 §1.1 D / §5 が確定形と §7 OQ #3 未確定形が drift)
  - **P2-3 (F contract test 重複)**: `f-lease-ttl-2branch.test.ts` を本 PR scope から **削除** (5 file 構成に縮約)、PR-P2-2 で `tests/unit/lease-ttl-policy.test.ts` に 10 case 既 land 済を pin 利用 (F 軸 revert 実証は既 land file 対象)
  - **P3-1 (grep 表現具体化)**: §1.1 A で `grep "fast-check" .` → `grep "fast-check" package.json + package-lock.json で 0 件` と表現具体化
- Round 2 教訓:
  - **§3.1 fact 整合 sweep 漏れ起草直後再発 risk**: 親 ADR から carry-over した stale file path / 関数名 (`src/perception/visual-motion-cache.ts` / `executePreferred`) が sub-plan 起草直後 Opus review (Round 1) で検出 = `feedback_sub_plan_opus_review_first.md` 運用が功を奏した (= PR-P2-1/P2-2 同型 user 救済を回避)。ただし起草直後 grep fact-check で更に preventive 検出可能 → 教訓追記候補 (memory `feedback_sub_plan_full_reread.md`「起草時 grep fact-check」を sub-plan 起草の標準 step に組込み)
  - **親 ADR §1.1 C 行も同型 drift の可能性** (`executePreferred` 表記): Opus 自身が「本 PR では out-of-scope だが指摘として残す」と発言、別 PR (例: 後続 epic sweep or 軽量 docs PR) で親 ADR 全 file path / 関数名 grep 実施推奨
- Round 3 反映点 (user 提供 Opus 第 2 round review: High×1 + Medium×3 + Low×1):
  - **High (F file 参照訂正)**: §1.1 D F revert 行で削除済 `f-lease-ttl-2branch.test.ts` 参照を `tests/unit/lease-ttl-policy.test.ts:120` 以降 `observedRoundTripMs 2-branch contract (F)` describe block に訂正 (PR-P2-2 既 land 10 case)
  - **Medium (acceptance 表現)**: §5 で「6 test 全件 green」を「6 軸 contract test 全件 green (新規 5 file + 既存 F test)」に sync、実 scope と表現の bit-equal 維持
  - **Medium (E 軸 scope creep 防止)**: §1.1 E + §3.2 で `executionPlan / plan trail` 新 API 言及を **既存 `deriveEntityCapabilities()` + `createDesktopExecutor()` surface 直接呼び** に書き換え (新 API 不作成、runtime 不変原則維持)
  - **Medium (B 軸 scope creep 防止)**: §1.1 E + §3.2 で「純粋判定 helper 切り出し」言及を **既存 `DirtyRectSubscriptionCache.acquireWithState() + invalidate()` (`any-change.ts:195`) 観測** に書き換え、純粋 helper 切り出しは **SR-4 (DXGI broker) carry-over** に明示
  - **Low (stale 完全除去)**: OQ #1 (元 `src/perception/visual-motion-cache.ts` 言及) を Resolved 化、本文 norm spec から stale 完全除去 (historical changelog + strikethrough のみ残存、§3.1 sweep 完了相当)
- Round 3 教訓:
  - **scope creep 防止の Opus 軸が機能**: 「新 helper 切り出し / 新 API 作成」を sub-plan で許容してしまうと impl 段階で scope が膨らむ → Opus が「既存 observable surface で済むか」を sweep する preventive 軸として有効。本 PR は test 追加 + minimum export 拡張のみで Phase 2 完了 trigger を達成 (Phase 3 SR-1 への自然 hand-off)
  - **「runtime 不変原則」の強い hedge**: 本 PR 北極星 #3 (production code runtime 不変) を §2 + §6 R4 + §3.2 B/E bullet で **3 重 pin**、Opus / Codex review でも sweep 対象明確化
- 次のステップ (本 sub-plan land 前 mandatory):
  1. ~~**本 sub-plan 起草直後に Opus phase-boundary review trigger**~~ (Round 1 で実施済、`feedback_sub_plan_opus_review_first.md` 準拠運用成功)
  2. ~~Opus review 結果反映 (P1/P2 解消)~~ (本 Round 2 で実施済)
  3. **user 諮問** (sub-plan 最終確認、修正点あれば応答) ← 次
  4. impl + PR + Opus + Codex review iteration + auto-mode merge
