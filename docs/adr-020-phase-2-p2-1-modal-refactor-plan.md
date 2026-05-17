# ADR-020 Phase 2 PR-P2-1 — D refactor: classifyModal 切り出し sub-plan

- Status: **Drafted (2026-05-17)**
- 親 ADR: `docs/adr-020-path-class-refactor-plan.md` (epic plan、merged 2026-05-17 PR #335)
- 該当 Phase / 軸: Phase 2 PR-P2-1 (D refactor、scope §4.4 D bullet)
- 関連 issue: #327 item D (closed by PR #331、本 sub-plan で構造除去完了)
- 関連 PR (baseline): #331 (`isChromeControlType` 共有 helper 抽出 + `isModalLike` 同期 = D tactical fix)

---

## 0. 親 ADR + user 判断引き継ぎ (2026-05-17 session で先取り確定)

本 sub-plan は ADR-020 land 直後の user judgment session (2026-05-17) で以下が確定済:

**auto-mode 運用パラメータ**:
- PR 分割粒度: 都度判断
- production code 改修 PR の merge: Opus + Codex 両 Approved で AI merge OK
- release timing: Phase 3 完了で一括 v1.7.0 minor (本 PR-P2-1 は no release、CHANGELOG entry 不要)
- branch 削除: PR merged 直後 auto

**Phase 2 design 判断 (本 sub-plan に直接影響)**:
- D refactor: `classifyModal(entity, context)` 切り出し方針 (ADR-020 §4.4)、本 sub-plan で signature 詳細確定
- 既存 helper export 整理: minimum、production callsite から consume される形を pin (ADR-020 §4.6 acceptance)

**Phase 3 design 判断 (本 sub-plan の範囲外、参考)**:
- SR-1 CapabilityRegistry: 新規 module `src/capabilities/registry.ts` 新設
- SR-4 DXGI broker: subscription handle pattern
- PR-P2-2 (F refactor) の `observedRoundTripMs` 計測: act→next see() wallclock 差

---

## 1. Scope (本 PR の範囲)

### 1.1 [in scope] 本 PR-P2-1 で扱う

A. **`classifyModal(entity, context, options?)` 新規 export** (`src/engine/world-graph/session-registry.ts` 内、既存 `isChromeControlType` の近傍):
   - signature: `classifyModal(entity: UiEntity, context: "pre-touch" | "post-touch-diff", options?: { excludeSelf?: UiEntity }): boolean`
   - core 判定ロジック: `entity.sources.includes("uia") && entity.role === "unknown" && !isChromeControlType(entity.controlType)`
   - context = "pre-touch" + `options.excludeSelf` 指定時: `entity.entityId !== options.excludeSelf.entityId` を追加判定
   - context = "post-touch-diff": self-exclusion 不要 (post snapshot は touched 自身を別 layer で扱うため)

B. **`isModalCandidate(target, candidate)` の deprecate 化**:
   - 内部実装を `classifyModal(candidate, "pre-touch", { excludeSelf: target })` へ delegate
   - export 維持 (内部 callsite から `isModalCandidate` を呼んでいる箇所 = `session-registry.ts:313, 318` を `classifyModal` 経由に移行する PR scope に含む)
   - JSDoc に `@deprecated Use classifyModal(candidate, "pre-touch", { excludeSelf: target }) directly` 追記、Phase 3 SR-3 で削除 (= ADR-020 §5.1 で SR-3 削除済のため、deprecate のまま完了)

C. **`isModalLike(e)` (guarded-touch.ts 内 private function) の deprecate 化**:
   - 内部実装を `classifyModal(e, "post-touch-diff")` へ delegate
   - `function` → `const` に変換 (export しないため deprecate 注釈のみ)
   - 内部 callsite (`guarded-touch.ts:260, 261, 267`) を直接 `classifyModal(e, "post-touch-diff")` に移行

D. **既存 callsite 移行**:
   - `session-registry.ts:313`: `s.entities.some((e) => isModalCandidate(entity, e))` → `s.entities.some((e) => classifyModal(e, "pre-touch", { excludeSelf: entity }))`
   - `session-registry.ts:318`: `s.entities.find((e) => isModalCandidate(entity, e))` → 同上
   - `guarded-touch.ts:260, 261`: `appeared.filter(isModalLike)` / `removed.filter(isModalLike)` → `appeared.filter((e) => classifyModal(e, "post-touch-diff"))` / 同上
   - `guarded-touch.ts:267`: `appeared.filter((e) => !isModalLike(e))` → `appeared.filter((e) => !classifyModal(e, "post-touch-diff"))`

E. **既存 test の維持 + 新規 test 追加**:
   - 既存 `tests/unit/modal-candidate.test.ts` + `tests/unit/guarded-touch.test.ts` は全 pass 維持 (BC 確認)
   - 新規 `tests/unit/classify-modal.test.ts`: `classifyModal` の 2 context × core 判定 4 軸 (UIA / role unknown / non-chrome / self-exclusion) 直接 unit test

### 1.2 [out of scope] 本 PR で扱わない

- `classifyModal` を export する `_helpers.ts` barrel: ADR-020 §4.4 で「observable marker public export 整理のみ」と書いたが、`classifyModal` は production API でありかつ既存 `session-registry.ts` export 規約に乗るため barrel 不要
- Phase 2 contract test (`tests/unit/path-class-contract/`): PR-P2-3 で land、本 PR-P2-1 は `classifyModal` API surface を確立するのみ
- F refactor (`computeLeaseTtlMs` input 拡張): PR-P2-2 で land
- Phase 3 SR-1〜SR-4: 各 SR sub-plan で

---

## 2. 北極星 (本 sub-plan)

ADR-020 §2 全 4 項目を継承 + 本 PR 固有:

1. **`classifyModal` 1 関数化により modal 判定の 2 関数分裂 (D drift) を構造的に解消** (= ADR-020 §1.1 D 軸の根本対策)
2. **既存 `isModalCandidate` / `isModalLike` の挙動を bit-equal で維持** (BC、ADR-020 §2 #3): deprecate wrapper が完全に既存挙動と一致することを既存 test (modal-candidate / guarded-touch) で機械保証
3. **`isChromeControlType` 共有 helper を `classifyModal` 内 private 化しない** (= PR #331 で確立済の export を維持、SR-1 でも consume される可能性、ADR-020 §5.1 SR-1 参照)

---

## 3. 既存コード状況 (grep 確認済)

### 3.1 既存 export / helper

- `isChromeControlType(controlType)` — `session-registry.ts:51-53` で定義、`guarded-touch.ts:4` import + 両 file で使用 (PR #331 で共有抽出済)
- `NON_MODAL_CHROME_CONTROL_TYPES` — `session-registry.ts:28-37` で private 定数 (export なし)
- `isModalCandidate(target, candidate)` — `session-registry.ts:93-99` で export
- `isModalLike(e)` — `guarded-touch.ts:194-199` で private function (export なし)

### 3.2 既存 callsite

| caller | line | 現コード |
|--------|------|---------|
| `session-registry.ts` | 313 | `s.entities.some((e) => isModalCandidate(entity, e))` |
| `session-registry.ts` | 318 | `s.entities.find((e) => isModalCandidate(entity, e)) ?? null` |
| `guarded-touch.ts` | 260 | `appeared.filter(isModalLike)` |
| `guarded-touch.ts` | 261 | `removed.filter(isModalLike)` |
| `guarded-touch.ts` | 267 | `appeared.filter((e) => !isModalLike(e))` |

### 3.3 既存 test

- `tests/unit/modal-candidate.test.ts` — `isModalCandidate` の unit test
- `tests/unit/guarded-touch.test.ts` — `guarded-touch` 経由の `isModalLike` 振る舞いを統合的に test

---

## 4. 統合戦略 (案 A 採用、案 B/C 不採用論拠)

### 4.1 案 A (採用): `classifyModal(entity, context, options?)` 3 引数 unified API

```ts
export function classifyModal(
  entity: UiEntity,
  context: "pre-touch" | "post-touch-diff",
  options?: { excludeSelf?: UiEntity }
): boolean {
  // Pre-touch self-exclusion FIRST (load-bearing per-clause order — preserves
  // legacy isModalCandidate ordering where `entityId === target.entityId` is
  // the first early-return). Keep this clause at line 1 of the body.
  if (context === "pre-touch" && options?.excludeSelf?.entityId === entity.entityId) return false;
  // Core: UIA-sourced + unknown role + non-chrome
  if (!entity.sources.includes("uia")) return false;
  if (entity.role !== "unknown") return false;
  if (isChromeControlType(entity.controlType)) return false;
  return true;
}
```

**論拠**:
- ADR-020 §4.4 の `classifyModal(entity, context)` 文言と整合 (options 引数は補助、core signature は (entity, context) 2 引数)
- pre-touch / post-touch の文脈差分を **context 引数で明示**、core 判定は共有 (drift 構造的不能)
- self-exclusion は **pre-touch 固有の要件**を options で表現、post-touch では使わない (post snapshot は touched 自身を別 layer で扱うため不要)
- 既存 `isModalCandidate(target, candidate)` は thin wrapper として deprecate (= delegate)、`isModalLike(e)` は private function なので直接 callsite 移行

### 4.2 案 B (不採用): signature 別、共通 core helper のみ統合

```ts
function isModalEntity(e: UiEntity): boolean { /* core 共通 */ }
export function isModalCandidate(target, candidate) { return candidate.entityId !== target.entityId && isModalEntity(candidate); }
function isModalLike(e) { return isModalEntity(e); }
```

**不採用論拠**:
- ADR-020 §4.4 「`classifyModal(entity, context)` 1 関数化」と矛盾 (案 B は 2 関数のまま、core helper 抽出のみ)
- 「2 関数分裂 (D drift) を構造的に解消」(本 sub-plan §2 北極星 #1) を達成しない、core 共通化は **再分裂を許す構造** (新規 context 拡張時に case-by-case で再分裂し得る)

### 4.3 案 C (不採用): context 引数 + `isModalCandidate` を composition

```ts
classifyModalEntity(e, context: "pre-touch-candidate" | "post-touch-diff"): boolean
isModalCandidate(target, candidate) = candidate.entityId !== target.entityId && classifyModalEntity(candidate, "pre-touch-candidate")
```

**不採用論拠**:
- context 値が `"pre-touch-candidate"` という long string + `isModalCandidate` の composition が冗長
- 案 A の `options.excludeSelf` 方式が同等表現力 + より読みやすい

---

## 5. 実装内訳 (PR 単一、推定 ~150-250 line)

### 5.1 新規追加

- `session-registry.ts`: `classifyModal(entity, context, options?)` export 追加 (line ~100 周辺、`isModalCandidate` の直前)、JSDoc 完備 (3 contexts / options / core 判定 4 軸 / D drift 教訓)

### 5.2 既存改修

- `session-registry.ts:93-99`: `isModalCandidate(target, candidate)` 内部を `classifyModal(candidate, "pre-touch", { excludeSelf: target })` へ delegate、`@deprecated` JSDoc 追記
- `session-registry.ts:313, 318`: 既存 callsite を `classifyModal` 直接 call に移行
- `guarded-touch.ts:194-199`: `isModalLike(e)` 内部を `classifyModal(e, "post-touch-diff")` へ delegate、`function` 宣言維持 (private なので export なし、JSDoc に `@deprecated, use classifyModal directly` 追記)
- `guarded-touch.ts:260, 261, 267`: 既存 callsite を `classifyModal(e, "post-touch-diff")` に移行

### 5.3 test 追加

- `tests/unit/classify-modal.test.ts` 新規:
  - 2 context × 4 core 判定軸 = 8 case + self-exclusion 2 case = 計 10 case
  - 既存 `modal-candidate.test.ts` の test fixture を再利用可能

### 5.4 既存 test pass 維持 (BC 機械保証)

- `tests/unit/modal-candidate.test.ts`: `isModalCandidate(target, candidate)` の挙動が deprecate wrapper 経由でも 100% 同一 → 全 pass 維持で BC 保証
- `tests/unit/guarded-touch.test.ts`: `guarded-touch` 経由の `isModalLike` 振る舞いが `classifyModal` 経由でも 100% 同一 → 全 pass 維持で BC 保証

---

## 6. BC (Backward Compatibility) 維持確認

- `isModalCandidate` export 維持 (deprecate wrapper)、外部 import 経路は不変
- `isChromeControlType` export 不変 (PR #331 確立済 SSOT)
- `NON_MODAL_CHROME_CONTROL_TYPES` private 維持 (export なし)
- `isModalLike` は元から private function なので外部影響なし
- 新規 export `classifyModal` 追加のみ、既存 export 削除なし

---

## 7. Risks

| R# | risk | 対策 |
|----|------|------|
| R1 | `classifyModal` の signature design が後続 Phase 3 (SR-1 CapabilityRegistry) と矛盾する API shape で固まる | ADR-020 §8 R7 で fact 整合 sweep を SR-1 sub-plan 起草時に明示済、本 sub-plan の signature は ADR-020 §4.4 と bit-equal sync 確認済 |
| R2 | `isModalCandidate` deprecate wrapper の挙動が既存と微妙にズレ (e.g. options.excludeSelf undefined 時の挙動) | 既存 `modal-candidate.test.ts` 全 pass を merge ブロッカー化 (Phase 2 §4.6 同型 acceptance) |
| R3 | `classifyModal` を export する場所 (`session-registry.ts` vs 新規 `modal-classifier.ts`) で迷い | 本 sub-plan §1.1 で `session-registry.ts` 内 export 確定 (既存 `isChromeControlType` と同居が natural、新 file 作成は YAGNI) |

---

## 8. Acceptance criteria

- `classifyModal(entity, context, options?)` が `session-registry.ts` から export され、JSDoc 完備
- `isModalCandidate` / `isModalLike` 内部実装が `classifyModal` へ delegate、`@deprecated` JSDoc 追記
- 既存 5 callsite (§3.2) 全て `classifyModal` 直接 call に移行
- 新規 `tests/unit/classify-modal.test.ts` 10 case 全 pass
- 既存 `tests/unit/modal-candidate.test.ts` + `tests/unit/guarded-touch.test.ts` 全 pass 維持 (BC 機械保証)
- 既存 vitest suite 全 pass + tsc build pass
- Opus + Codex 各 1+ round Approved (production code 改修 PR、CLAUDE.md §3.3 Step 0)
- ADR-020 carry-over ledger L3 (D) を sub-plan land 後の commit message で strikethrough 候補化 (実際の strikethrough は PR-P2-3 contract test land 時 = D drift 構造除去完了 trigger)

---

## 9. Open Questions

### 残存

- **OQ #1**: `isModalCandidate` の deprecate を「内部 re-export 残し + JSDoc deprecated」止めで完了するか、それとも本 PR-P2-1 で完全削除するか? 内部 callsite を全て `classifyModal` 直接 call に移行するため、export 削除 = breaking change にはならない (外部 import がない前提、grep 確認: src 外で `isModalCandidate` import している file はテスト 1 件のみ = `tests/unit/modal-candidate.test.ts`)。判断: deprecate 維持で Phase 3 完了時に再諮問 (SR-3 削除済のため永続 deprecate も option)、本 PR では deprecate のみ
- **OQ #2**: `tests/unit/modal-candidate.test.ts` を `tests/unit/classify-modal.test.ts` 内に merge するか、別 file 維持か? 判断: 別 file 維持 (deprecated API の test も残しておく、BC pin として)

---

## 10. 起草 metadata

- 起草日: 2026-05-17
- 起草 session: ADR-020 land 直後の Phase 2 PR-P2-1 起動 (auto-mode、user 指示「本 session で PR-P2-1 起動、auto-mode で land まで」)
- 起草前 read 済: ADR-020 全体 + `src/engine/world-graph/session-registry.ts` + `src/engine/world-graph/guarded-touch.ts` + grep 確認 (`isModalCandidate` / `isModalLike` / `NON_MODAL_CHROME_CONTROL_TYPES` / `isChromeControlType` の caller / test)
- 次のステップ: 本 sub-plan を chat 表示 → user 目視確認 → 修正なければ feature branch + impl + commit + PR + Opus/Codex 並列 review + auto-mode merge
