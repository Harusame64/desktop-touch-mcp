# ADR-021 — Result type adoption + drift prevention (Round 3 draft)

- Status: **Draft (Round 3)** — Round 2 grounded review (user + self-Opus) で writer ownership / payload field naming / scope boundary を再整理
- Date: 2026-05-19
- Trigger: ADR-020 §11 carry-over L6 (G partial) + L10 (`failWith` migrate 判断、OQ-SR2-4) + L8 起草 trigger 解除済 (v1.7.0 release 2026-05-19)
- 関連 ADR: ADR-020 path-class refactor (Phase 3 SR-2 直系の後継)
- Authors: Claude (Opus draft) — user 主導指示 (2026-05-19、ADR-021 主題を「LLM E2E harness」から「Result migration + drift prevention」に振り直し) + user Round 1 / Round 2 grounded review (2026-05-19)

---

## 0. 主題の振り直し経緯 + Round 改稿経緯

**Round 0** (LLM-driven E2E harness 案): user feedback「Sonnet に bug 探させる、なんか負けた気がする」で破棄。本 ADR から削除済、概要は memory `feedback_no_llm_in_loop_test.md` に保存 (future contributor は本 §0 と memory 参照)。

**Round 1**: Result migration + drift prevention 案。user grounded review で acceptance の過剰約束を撃ち落とし:
- 「F1/F2 silent-success が compile error」: `TOOL_REGISTRY` / `ToolHandler` Result 化が前提
- 「全 176 callsite bit-equal」: 検証困難、sampling に弱める
- `failWith` thin wrapper 化: 情報伝搬経路 (`toolName`/`message`/`context`/`rootExtras`) が未設計
- `_post.ts` 再設計: target shape + 二重 attach 抑止が未定
- ESLint rule 3 件: marker SSOT registry / Result 完全採用が前提の rule あり

**Round 2** で上記を反映、Phase 2 に PR-P2-0 (typed error payload 拡張) を前提作業として追加、Phase 3 を 3a + Phase 5 carry-over に分解、shape 検証を representative matrix + sampling に弱める、lint を 1 rule に縮約。

**Round 3** (本 doc、2026-05-19) で user grounded review + 自己 Opus review の合計 11 findings を反映:

**user review 3 件**:
- (H) `_post.ts` の writer ownership: `obj.post` container は `_post.ts:withPostState` (`_post.ts:121-133` で `focusedWindow/focusedElement/windowChanged/elapsedMs` を wrapper-level snapshot から構築) が単独 writer。Round 2 「converter が `obj.post` 単独 writer」は incorrect、handler 内 converter は wrapper-level snapshot を持たない
- (M) `HandlerError` の `message` 衝突: `HandlerError extends Error` (`src/errors/typed-errors.ts:15`)、`Error.message: string` が継承で既存。payload 拡張で `message?: string` を追加すると shadow / 型衝突 risk、`displayMessage` / `failureMessage` 等の別名にすべき
- (M) Phase 3a `workspace_launch` 不適切: `workspace_launch` は process spawn + window polling の **単体 handler** (`src/tools/workspace.ts`)、inner tool result を持たない。「inner-result 伝搬」対象は `run_macro` 1 件に絞り、`workspace_launch` は「macro 内で呼ばれる tool entry として adapter 経由になる」程度の言及に縮約

**自己 Opus review 8 件**:
- (P2-1) PR-P2-0 で `classify(message)` の code 決定 location 未定 (caller / class / dispatcher 3 案)
- (P2-2) Codemod sampling specification gap (seed / category / 自動化 / CI gate 未定)
- (P2-3) `ToolFailure` 型 location 誤記: `_types.ts` 起点 (`_errors.ts:1` で import)、`_errors.ts:685-719` 削除と並んで `_types.ts` の alias 化を別項目で書くべき
- (P2-4) Phase 2 LOC underestimate: realistic 2500-3500 LOC、Round 2 「1500-2000」は楽観
- (P2-5) §2.2 非ゴール (production runtime 変更 NO) と §5 R5 「`_time.ts` SSOT 新設」が矛盾
- (P2-6) §3.1 table Phase 5 行が scope outline 不足、§3.6 で薄く outline を書くか table から削除
- (P3-1) Round 0 削除で future contributor が context 失う、§0 で memory 参照を明示 (本 Round 3 で対応)
- (P3-2) PR-P1-1 と PR-P2-0 の test file growth strategy 不明 (同 file 拡張 vs 別 file)

**Round 4 trigger**: user feedback で着手判断確定後、本 doc 改稿または Phase 1 PR 着手

---

## 1. 背景

### 1.1 ADR-020 SR-2 が達成したこと + 残したこと

SR-2 (PR-SR2-1/2/3, 2026-05-18) で:
- `src/types/result.ts` に `Result<T, E>` 型を新設
- `src/errors/typed-errors.ts` に `HandlerError` (base) + `ExecutorFailedError` 等の typed error を導入 (`HandlerError extends Error`、constructor で `name` 設定)
- `src/tools/_envelope.ts:1241-1264` に `toFailureEnvelope(result, opts)` converter helper を集約 (現状は `result.error.name` だけで `buildFailureEnvelope` を call、`Error.message` / `context` は envelope に surface しない)
- 4/6 wrapper internal callsite (memory tools) を converter 経由に統一

**残:**
- **L6 OQ-SR2-5** (Round 4 carry-over): 2 wrapper internal callsite (`_envelope.ts:2978` lease validation + `:3058` handler throw fallback) + `desktopActRawHandler:596-606` executor_failed return path 統一は shape bit-equal の機械保証 risk で post-SR-2 carry-over
- **L10 OQ-SR2-4** (User 明示要求 carry-over): `failWith(...)` 経由の handler 内部標準 failure path **176 callsite** + `_types.ts` 定義の `ToolFailure` shape (`_errors.ts:1` から import) は SR-2 で touch せず、`Result.err` + `toFailureEnvelope` に migrate するかの判断を post-SR-2 milestone (本タイミング) で実施

### 1.2 drift の本質を再定義

v1.6.1 で land した 6 件の tactical fix (PR #328-#333) を path-class 別に分解すると、共通パターンは:

> **同一意味の値を、複数の production code path がそれぞれ独立に計算していた。一方が改修されてももう一方が drift して silent な不整合が成立した。**

例 (SR-{1,4,5} + P2-{1,2} で構造除去済):
- `cacheState` — vision-gpu / DirtyRectRouter / Stage5 が parallel writer → SR-4 で broker SSOT 統合
- `TouchResult.downgrade` marker — capability check が複数箇所 → SR-1 で CapabilityRegistry SSOT
- `classifyModal` predicate — pre-touch / post-touch 2 predicate → P2-1 で 1 関数統合
- `keyboardTypeBg` fallback ladder — internal-only / first-class advertised の 2 path → SR-5 で advertised 統一
- `LEASE_TTL_POLICY` baseMs — observation 無視の固定 → P2-2 で `computeLeaseTtlMs(observedRoundTripMs?)` 関数 SSOT

### 1.3 残された drift surface (本 ADR-021 の対象)

ADR-020 が **既存** drift を構造除去した一方、以下が **新規** drift surface として残存:

| Drift surface | 性質 | 構造予防の手段 | 本 ADR 該当 Phase |
|---|---|---|---|
| **A) `failWith` + `ToolFailure` shape vs `toFailureEnvelope` + envelope shape** の 2 並立 | handler 内部標準 failure path が 2 系統並立、新規 PR が `failWith` を踏襲し続ける限り converter 集約 (北極星 1) が完了しない | L10 OQ-SR2-4 を migrate (案 b) で確定 → `failWith` 176 callsite を Result 経路に統一、ただし `toFailureEnvelope` の API 拡張 (`toolName` / `displayMessage` / `context` / `rootExtras` / `suggestOverride` を envelope に surface) が前提 (`HandlerError` 既存の `Error.message` 継承との shadow 回避で `displayMessage` 命名) | Phase 2 |
| **B) `ok: false` の outer envelope 伝搬漏れ** (run_macro F1/F2 canonical) | inner step が ok:false でも outer step が ok:true を return できる現状。既に runtime regression は `tests/unit/run-macro-stop-on-error-inner-envelope.test.ts:46` で pin、構造的封鎖は **`ToolHandler` 自体を Result returning に変える typed adapter boundary 導入後にのみ compile-time check 可能** | Phase 3a (`run_macro` 内 adapter helper、runtime test pin 維持) + Phase 5 (`TOOL_REGISTRY` Result 化、compile-time pin、carry-over) | Phase 3a |
| **C) 新規 envelope 構築の by-pass** (`{ok: false, code, error}` object literal を converter 経由せず手書きする callsite) | converter を bypass された envelope が将来増殖する余地 | ESLint custom rule `no-tool-failure-shape-direct-construct` で AST 禁止 (registry-registered SSOT が不要、scope 最小) | Phase 4 |
| **D) 過去 drift case の回帰** | run_macro F1/F2 のような構造除去済 case が「別 path で同型再発」する余地 | deterministic regression scenario (hand-script tool-call sequence + envelope assertion、`tests/unit/path-class-contract/` 延長で実装、stdio spawn なし、vitest `vi.useFakeTimers()` で時間決定論化) | Phase 4 |

本 ADR は A-D を順に潰す。**marker field の parallel writer (旧 Round 1 §1.3 row C)** は SSOT registry 設計が必要、本 ADR 非ゴール (§2.2)、別 ADR carry-over。

---

## 2. North Star

> 「**単体 OK / 繋ぐと破綻**」型 drift を **書ける状態にしない**。Test で検出ではなく、type / lint / SSOT で **production code レベルで書けなくする**。

ただし「書けなくする」の **段階性** を Round 2/3 で明示:
- **Phase 1-2**: 既存 SR-2 converter (`toFailureEnvelope`) を「情報量保存版」に拡張し、`failWith` 176 callsite を converter 経由 1 形に収束。Handler 内部の failure path は **1 形** (Result.err + converter) に統一、`ToolFailure` shape は外部 envelope shape と bit-equal な互換層として keep (LLM client 不破壊)
- **Phase 3a**: `run_macro` の inner-result 伝搬を **`runInnerToolAsResult` adapter helper** で 1 形化、existing runtime regression test (`run-macro-stop-on-error-inner-envelope.test.ts:46`) を `Result<T, E>` API 経由 assertion に書き直し
- **Phase 5** (carry-over、本 epic 外 or 終結後別 ADR): `TOOL_REGISTRY` / `ToolHandler` 自体を `Result<ToolSuccess, ToolFailure>` returning に格上げ、F1/F2 silent-success が **compile error** になる構造的封鎖達成

### 2.1 成功の定義 (Round 3 改訂)

1. **(Phase 2)** `failWith` 経路の callsite が converter 経由に統一、`ToolFailure` shape は converter 出力と bit-equal (代表 shape matrix で実証、全 176 callsite 個別 bit-equal は **codemod 駆動 sampling fixtures** で代替)
2. **(Phase 3a)** `run_macro` の inner-result 伝搬が `runInnerToolAsResult` adapter 経由のみ、既存 runtime regression test が API 書き換え後も green、production code revert で必ず fail
3. **(Phase 4)** ESLint rule `no-tool-failure-shape-direct-construct` が land、`{ok: false, code, error}` 直接 construction が **新規追加できない**
4. **(Phase 4)** Past drift case (run_macro F1/F2 + DXGI broker cacheState + classifyModal pre/post-touch) を deterministic regression scenario として `tests/unit/path-class-contract/` 配下に最低 3 件 pin

### 2.2 非ゴール (明示)

- LLM driver / nightly E2E harness の新設 (Round 0 で破棄)
- `ToolFailure` shape の **外部 API contract** 変更 (LLM client 含む existing envelope shape は 100% backward compatible 維持、shape bit-equal は代表 matrix + sampling fixtures で実証)
- production runtime behavior の変更 (内部 type / lint / regression test の追加のみ、env unset で bit-equal)
- **`src/_time.ts` SSOT 等の production timer wiring 変更** (Round 2 で R5 に書いた `_time.ts` 新設 idea は本 epic 非ゴール、Phase 4 deterministic regression scenario は vitest 内 `vi.useFakeTimers()` で時間決定論化、production timer の SSOT 化は別 ADR)
- 全 envelope marker への即時 SSOT 強制 (registry 設計が新規必要、別 ADR carry-over)
- `TOOL_REGISTRY` / `ToolHandler` 自体の Result returning 化 (本 epic Phase 5 carry-over、orchestrator F1/F2 を **compile error** で pin する強い言い切りは本 epic Phase 3a acceptance には含めない)
- **全 176 callsite の JSON.stringify bit-equal を 1 件ずつ機械保証する gate** (代わりに代表 shape matrix + codemod 駆動 sampling fixtures で sample 検証)
- `workspace_launch` 等の **単体 handler** の Result 化 (`workspace_launch` は process spawn + window polling、inner tool result を持たない、Phase 3a primary scope 外。`workspace_launch` が `run_macro` 内 step として呼ばれる場合のみ Phase 3a adapter 経由になる)

---

## 3. 範囲 (Scope)

### 3.1 Phase 構成 (Round 3 改訂)

| Phase | 主題 | drift surface | size 想定 | PR 想定 |
|---|---|---|---|---|
| **Phase 1** | L6 OQ-SR2-5 完全 closure | A の残 2 callsite + executor_failed return path | 小 (~300 LOC) | 1-2 |
| **Phase 2** | typed error payload 拡張 (前提) + `failWith` → converter migration | A (PR-P2-0 拡張 → 176 callsite migrate → `_post.ts` writer ownership clarify) | **大 (~2500-3500 LOC)** | 6-7 |
| **Phase 3a** | `run_macro` inner-result 伝搬の `runInnerToolAsResult` adapter 経由化 (runtime test pin 維持、compile-time pin は Phase 5 carry-over) | B (typed adapter boundary 設計 + runtime test 書き換え) | 中 (~400 LOC) | 1-2 |
| **Phase 4** | ESLint rule `no-tool-failure-shape-direct-construct` + deterministic regression scenario | C + D | 小 (~300 LOC + scenario fixtures) | 2-3 |
| **Phase 5 (本 ADR carry-over)** | `TOOL_REGISTRY` / `ToolHandler` の Result returning 化 (F1/F2 compile-time pin) | B' (typed adapter boundary 完成版) | 大 (~1500 LOC、別 ADR 想定) | 別 ADR (e.g. ADR-022 or 本 ADR Phase 5 sub-plan) |

総計 (Phase 1-4) **10-14 PR**、estimated 2-3 ヶ月 part-time。

### 3.2 Phase 1 詳細 — L6 OQ-SR2-5 完全 closure

ADR-020 SR-2 sub-plan §9 OQ-SR2-5 で定義済の **case 2** を選択。

**PRs**:
1. **PR-P1-1** (snapshot test land): 新規 file `tests/unit/path-class-contract/to-failure-envelope-shape-snapshot.test.ts` を独立に新設 (既存 `to-failure-envelope.test.ts` は logic test として keep)、現行 4 converter callsite + 2 残 callsite + executor_failed return path の全 envelope JSON を fixture 化、bit-equal を pin
2. **PR-P1-2** (signature 拡張 + 残 2 callsite 統一): `toFailureEnvelope(result, { tryNext?, extras? })` の option 拡張、`_envelope.ts:2978` (lease validation) + `:3058` (handler throw fallback) を converter 経由に置換、snapshot test 全 green
3. **PR-P1-3** (executor_failed return path 統一): `desktopActRawHandler:596-606` の `{...result, if_unexpected}` spread を converter 経由に置換

**Acceptance**: L6 (G) を ADR-020 §11 で **完全 strikethrough**、§9 acceptance criteria 3 個目 PARTIAL CLOSURE 注記を削除 + 完全 closure に flip。

### 3.3 Phase 2 詳細 — typed error payload 拡張 + `failWith` migration

#### 3.3.1 前提認識 (Round 2/3 user review 反映)

現 `toFailureEnvelope` (`src/tools/_envelope.ts:1241-1264`) は `result.error.name` だけで `buildFailureEnvelope` を呼ぶ。`Error.message` / `context` / `rootExtras` / `suggest override` を envelope に surface しない。これに対して `failWith` (`src/tools/_errors.ts:685-718`) は:
- `classify(message)` で **message pattern → code + suggest 動的決定**
- `error: ${toolName} failed: ${message}` を envelope に乗せる
- `context` を `ROOT_HOISTED_KEYS` (`_perceptionForPost`, `_richForPost`, `hints`、`_errors.ts:14`) と nested に分離して hoist
- `_post.ts:140-161` の post-perception hook は failure root の `_perceptionForPost` を `obj.post.perception` に move + temp key 削除 (`_post.ts:121-133` で `obj.post` container 自体を wrapper-level snapshot から構築)

`failWith` を converter 経由互換層に置き換えるには、**先に typed error payload + converter API を「`failWith` の付加情報」を loss なく carry できる shape に拡張する必要がある**。

#### 3.3.2 PR sequence

1. **PR-P2-0** (前提、本 Phase の最初): typed error payload 拡張 + 代表 shape matrix 確立
   - `HandlerError` (or 派生 typed error class) に optional field 追加:
     - `toolName?: string`
     - **`displayMessage?: string`** (Round 3 改訂: `message` は `Error.message` (`HandlerError extends Error`、`typed-errors.ts:15`) と shadow するため別名、`failWith` の `error: ${toolName} failed: ${message}` 用の dynamic source)
     - `context?: Record<string, unknown>`
     - `rootExtras?: Record<string, unknown>`
     - `suggestOverride?: SuggestArray`
   - **code 決定 location** (Round 3 P2-1 反映、OQ-7 で user 諮問): 以下 3 案から 1 つを PR-P2-0 で確定:
     - (a) **caller-side で `classify(message)`**: 176 callsite が `const { code, suggest } = classify(message)` を書く → boilerplate 爆発
     - (b) **typed error class constructor 内**: `new ToolFailureError({displayMessage})` 内で classify を呼ぶ → typed error と message dispatch が tight coupling
     - (c) **中間 dispatcher**: `errorFromMessage(message, toolName, context): ToolFailureError` 専用 factory を新設、caller は factory を呼ぶだけ → 新規層 1 個追加、loose coupling、推奨
   - `toFailureEnvelope(result, { tryNext?, extras?, hoistRootExtras? })` の signature を拡張、envelope 出力の `error` field を `${toolName} failed: ${displayMessage}` 形に組み立てる branch、`context` を nested に置く branch、`rootExtras` を envelope root に hoist する branch を新設
   - 既存 4 callsite (SR-2 land 済) の envelope shape は **bit-equal を機械保証** (`to-failure-envelope-shape-snapshot.test.ts` 既存 snapshot を kept as-is で diff 0)、新 option は optional / default off
   - 新規 `tests/unit/path-class-contract/to-failure-envelope-payload.test.ts` で 8 形 (toolName 有無 × displayMessage 有無 × context 有無 × rootExtras 有無 の主要 combination) を代表 shape matrix として fixture 化、bit-equal を pin

2. **PR-P2-1** (`_post.ts` writer ownership clarify、Round 3 改訂で High finding 反映):
   - **writer 分界 contract** (Round 3 新規明示):
     - `obj.post` container の単独 writer = **`_post.ts:withPostState`** (`_post.ts:121-133` で wrapper-level snapshot から `focusedWindow/focusedElement/windowChanged/elapsedMs` 構築)
     - `obj._perceptionForPost` temp marker の writer = **converter** (`toFailureEnvelope` が `Result.err.perception` payload を envelope JSON root に encode、または `failWith` 経由現行 root hoist 経路を維持)
     - `obj.post.perception` の writer = **`_post.ts:withPostState`** (現行 `_post.ts:140-161` の `obj._perceptionForPost` → `obj.post.perception` move + temp delete 経路を keep)
     - `obj.post.{focusedWindow, focusedElement, windowChanged, elapsedMs}` の writer = **`_post.ts:withPostState`** (wrapper のみが before/after snapshot を持つ、handler / converter は構造的に書けない)
   - **二重 attach 抑止**: 各 field の writer は **exactly one**、上記 4 行を path-class-contract test で機械 pin (`tests/unit/path-class-contract/post-writer-ownership.test.ts` を Round 3 提案で新設)
   - **migration 工程**: converter は `Result.err.perception` payload を `obj._perceptionForPost` root field として encode、`_post.ts` は既存通り `obj._perceptionForPost` → `obj.post.perception` move を実行。`failWith` 経由 callsite が PR-P2-3 で codemod されるまで両 path (failWith root hoist + Result.err payload) が並立、両 path とも最終 `obj._perceptionForPost` を produce する contract で互換
   - 既存 134 memory test + 全 handler test が green、shape regression 0

3. **PR-P2-2** (`failWith` を deprecated thin wrapper に + codemod 検証 helper):
   - `failWith` 内部実装を Result.err + 拡張版 `toFailureEnvelope` 呼び出しに切り替え (PR-P2-0 で確定した code 決定 location に従い、(c) なら `failWith` 内部で `errorFromMessage(message, toolName, context)` を call)
   - shape bit-equal を **代表 shape matrix (PR-P2-0 で land 済の 8 形)** + **codemod-generated fixtures** で確認
   - **codemod fixtures 仕様** (Round 3 P2-2 反映):
     - `scripts/extract-failwith-shape-fixtures.mjs` (Round 3 提案で新設) が 176 callsite を AST scan し、各 callsite の `(err, toolName, context)` 形を fixture として抽出、pre-migration shape を JSON snapshot 化
     - sampling: callsite を **toolName 別に bucket 化** (e.g. desktop/browser/keyboard/mouse/screenshot/terminal/clipboard 等)、各 bucket から **最低 2 件 + 全体の 10% を上回る件数**、 deterministic seed (`MIGRATION_FIXTURE_SEED=2026-05-19`) で reproducible
     - 自動化: PR-P2-2 PR の CI gate に「fixture diff = 0」を gate、shape regression を CI fail
   - `failWith` import を **新規 deprecated 警告** (TypeScript `@deprecated` JSDoc + ESLint rule warn、PR-P4-1 で error 昇格)
   - 既存 176 callsite は **動作 unchanged**、shape は wrapper 経由で converter 出力と互換

4. **PR-P2-3a/3b/3c** (Round 3 改訂で a/b/c 3 分割 → **a/b/c/d 4 分割** に増やす、~45 callsite/PR、P2-4 LOC underestimate 反映):
   - 既存 `failWith(err, toolName, context)` callsite を `Result.err(...)` 直接 return + envelope 化は wrapper-handler 共通 pattern に置換 (PR-P2-0 で確定した code 決定 location 案 (a/b/c) に従い codemod 適用)
   - PR-P2-3a/b/c/d: tool category 別に bucket migration (a = desktop / desktop_act / discover、b = browser、c = keyboard / mouse / clipboard / terminal / screenshot、d = workspace / focus / window / scroll / notification / wait_until / excel / run_macro)
   - 各 PR で codemod diff + PR-P2-2 fixture sampling の shape diff = 0 を CI gate

5. **PR-P2-4** (`failWith` 互換 wrapper 削除 + `ToolFailure` 型 alias 化、Round 3 P2-3 反映で 2 step 明示分割):
   - **Step 1**: `failWith` 0 callsite 確認 (`grep -r "failWith\b" src/`)、`src/tools/_errors.ts:685-719` から `failWith` 定義削除、`_errors.ts:14-15` の `ROOT_HOISTED_KEYS` は `_post.ts` 経路として保持
   - **Step 2** (Round 3 P2-3 新規明示、Round 3 Codex P2 反映で error payload alias に修正): `src/tools/_types.ts` 上の `ToolFailure` 型 (現状 `_errors.ts:1` で import 元) を **`ToolFailureError` payload type の alias** に簡約 (`type ToolFailure = ToolFailureError`、または既存 `ToolFailure` structural shape を keep して `ToolFailureError implements ToolFailure` で命名整合)。**`Result<never, ...>` の Result wrapper には alias しない** (Phase 5 で `Promise<Result<ToolSuccess<T>, ToolFailure>>` を採るとき nested Result `Result<ToolSuccess, Result<never, ToolFailureError>>` になり single success/failure boundary が崩れるため、Round 3 Codex review §line 197 で指摘済)。**事前 reach 調査**: PR-P2-3d land 後の acceptance gate に「`grep -r "ToolFailure\b" src/ tests/` で external consumer リスト化 + type 互換性確認」を追加、内部 type 名で外部 LLM client が分離されていることを実証 (Round 3 P2-3 反映)

#### 3.3.3 Phase 2 acceptance (Round 3 改訂)

- [ ] PR-P2-0 land: typed error payload 拡張 + 代表 shape matrix 8 形が `tests/unit/path-class-contract/to-failure-envelope-payload.test.ts` で bit-equal pin + code 決定 location 確定 (a/b/c から 1 案)
- [ ] PR-P2-1 land: `obj.post` container / `obj._perceptionForPost` / `obj.post.perception` / `obj.post.{focusedWindow,...}` の **field-level writer ownership** を `tests/unit/path-class-contract/post-writer-ownership.test.ts` で機械 pin、二重 attach 不可能化
- [ ] PR-P2-2 land: `failWith` 内部実装が converter 経由互換層、codemod fixtures (bucket 別 最低 2 件 + 全体 10% 以上、deterministic seed) で shape diff = 0 を CI gate
- [ ] PR-P2-3a/b/c/d land: 176 callsite が `Result.err` 経由に置換、各 PR で codemod diff + fixture shape diff = 0 検証
- [ ] PR-P2-4 land: Step 1 (`failWith` 0 callsite + 定義削除) + Step 2 (`ToolFailure` 型 alias 化 + reach 調査 acceptance gate)
- ~~全 176 callsite の JSON.stringify bit-equal を 1 件ずつ機械保証~~ (Round 1 で書いた強い言い切り、Round 2/3 で代表 shape matrix + codemod-generated sampling fixtures に弱める)

### 3.4 Phase 3a 詳細 — `run_macro` inner-result 伝搬の adapter 経由化 (Round 3 改訂、`workspace_launch` 除外)

#### 3.4.1 前提認識 (Round 3 user review 反映)

`run_macro` (`src/tools/macro.ts:465-496`) は現状 `entry.handler(validated)` の `ToolResult` を `result.content[0].text` (JSON string) としてだけ受け取り、それを **改めて JSON.parse して `parsed.ok === false` を runtime 判定**。`TOOL_REGISTRY` / `ToolHandler` 自体を Result returning に変えていないため、orchestrator が inner step の ok:false を **compile-time に検知することは現状不可能**。

既存 runtime pin (`tests/unit/run-macro-stop-on-error-inner-envelope.test.ts:46` `describe("run_macro: stop_on_error halts on inner ok:false envelope (Phase 6 F1 fix)"`) が「JSON parse 経路で ok:false を inner-step ok に反映」する behavior を runtime test で保証している。

**`workspace_launch` (`src/tools/workspace.ts:208,260`) は inner tool result を持たない単体 handler** (process spawn + window polling)、本 Phase 3a primary scope 外 (Round 3 user review 反映)。`workspace_launch` が `run_macro` 内 step として呼ばれる場合のみ Phase 3a adapter 経由になる (= step entry として `runInnerToolAsResult` が処理する形、`workspace_launch` 自体の handler 改修 不要)。

#### 3.4.2 Phase 3a で達成する範囲 (Round 3 縮約)

- `run_macro` の inner step 呼び出しを `runInnerToolAsResult(entry, validated): Promise<Result<ToolSuccess, ToolFailure>>` adapter 経由化
- Adapter は内部で従来通り `entry.handler(validated)` を呼び、`ToolResult.content[0].text` を Result 化して return (JSON parse は adapter 内のみ、`run_macro` 側は Result API のみ consume)
- 既存 runtime test (`run-macro-stop-on-error-inner-envelope.test.ts`) を Result API 経由 assertion に書き直し、runtime regression を Result-aware に再 pin

#### 3.4.3 PR sequence (Round 3 縮約)

1. **PR-P3a-1**: `runInnerToolAsResult(entry, validated)` adapter helper 新設、`run_macro` の inner step 呼び出しを adapter 経由に置換 (orchestrator 側 JSON parse 削除、stop_on_error 判定を `result.ok` で実施)
2. **PR-P3a-2** (optional): 他 orchestrator audit (`desktop_act` retry chain、`keyboard({action: 'sequence'})` 等) が `run_macro` パターン (inner tool entry を呼ぶ) に該当するか調査、該当しなければ Phase 3a closure

#### 3.4.4 Phase 3a acceptance (Round 3 改訂)

- [ ] `run_macro` が inner step ok を `result.ok` (= Result API) 経由で判定、JSON parse path は adapter 内のみ
- [ ] 既存 runtime test (`run-macro-stop-on-error-inner-envelope.test.ts`) が Result-aware assertion に書き直し、production code revert で必ず fail (検出力実証)
- [ ] PR-P3a-2 audit で他 orchestrator が該当しないことを文書化 (or 該当があれば追加 PR でカバー)
- ~~F1/F2 silent-success が compile error~~ (Round 1 強い言い切り、Round 2/3 で **Phase 5 carry-over** に sink)
- ~~`workspace_launch` を adapter 経由化~~ (Round 3 改訂で Phase 3a primary scope から除外、`workspace_launch` 自体は単体 handler、`run_macro` 内で呼ばれる場合のみ adapter 経由)

### 3.5 Phase 4 詳細 — ESLint rule + deterministic regression

#### 3.5.1 ESLint rule (Round 2 改訂、scope 縮約)

初回 land する rule は **1 件のみ**:

- **`no-tool-failure-shape-direct-construct`**: AST level で `{ ok: false, code: ..., error: ..., ... }` の object literal を直接 return / spread する callsite を reject、converter (`toFailureEnvelope` or `failWith` 互換 wrapper) 経由のみ allow
- scope: `src/tools/**/*.ts` を対象、`src/tools/_envelope.ts` (converter 自身) と `src/tools/_errors.ts` (互換 wrapper) は exempt
- 段階導入: PR-P4-1 で warn 化 land → 1 sprint 観察 → false positive 0 で error 昇格

Round 1 で書いた `no-direct-envelope-marker-write` (marker SSOT registry 依存) と `no-silent-result-discard` (Result 型完全採用後にのみ正しく動く) は **Phase 4 後半 carry-over** に sink、本 epic 内では deferred:
- `no-direct-envelope-marker-write` は **marker SSOT registry 設計** が前提 (本 ADR 非ゴール §2.2)、別 ADR
- `no-silent-result-discard` は **Phase 2 完了 + Phase 3a 完了** が前提、Phase 4 後半 carry-over として `tests/unit/path-class-contract/no-silent-result-discard-eslint.test.ts` 起草余地を残す

#### 3.5.2 Deterministic regression scenario (Round 3 改訂、`_time.ts` SSOT 撤回)

`tests/unit/path-class-contract/` 配下に **hand-script tool-call sequence + envelope assertion** で 3 件最低 land。時間決定論化は **vitest 内 `vi.useFakeTimers()` + 既存 mock 機構** で実装、production timer wiring の新 SSOT (`_time.ts` 等) は **本 epic 非ゴール** (§2.2 改訂で明示)。

- **PR-P4-2**: `run-macro-stop-on-error-propagation.test.ts` (F1/F2 canonical、stop_on_error: true で inner ok:false が outer に伝搬することを envelope shape で pin、production code revert で必ず fail)
- **PR-P4-3**: `dxgi-broker-cacheState-coexistence.test.ts` (SR-4 dogfood の cacheState 連続性、実 DXGI subscription は **既存 vision-gpu ReplayBackend** (`src/engine/vision-gpu/replay-backend.ts`) を mock として活用、broker SSOT 改修 (specifically PR-SR4-1 #350 の `DirtyRectBroker` introduction) を revert で必ず fail)
- **PR-P4-4**: `classifyModal-pre-post-consistency.test.ts` (P2-1 で統合した pre/post-touch modal predicate の bit-equal を envelope shape で pin)

scenario 1 件あたり PR 1 件、Phase 4 は段階追加。

#### 3.5.3 Phase 4 acceptance (Round 2/3 改訂)

- [ ] PR-P4-1 land: `no-tool-failure-shape-direct-construct` warn 化、1 sprint 観察後 error 昇格
- [ ] PR-P4-2/3/4 land: 3 件 deterministic regression scenario が `tests/unit/path-class-contract/` 配下に pin、revert 実証で必ず fail
- ~~ESLint rule 3 件全 land~~ (Round 1 強い言い切り、Round 2/3 で 1 rule + 2 件 carry-over に弱める)
- ~~`src/_time.ts` SSOT 新設~~ (Round 2 R5 mention、Round 3 で §2.2 非ゴールと整合させて撤回)

### 3.6 Phase 5 (本 ADR carry-over) 詳細 outline (Round 3 P2-6 反映)

Phase 5 は本 ADR-021 の Phase 1-4 完了後に **別 ADR (e.g. ADR-022)** または **本 ADR Phase 5 sub-plan** として起草。Round 3 で scope outline を以下に確定:

#### 3.6.1 Phase 5 主題

`TOOL_REGISTRY` / `ToolHandler` 自体を `Result<ToolSuccess, ToolFailure>` returning に格上げ、orchestrator の inner-result 伝搬を **compile-time に封鎖** (F1/F2 silent-success が compile error 化)。

#### 3.6.2 Phase 5 対象 surface (estimate)

- 全 29 tool entry の handler signature: `(args: T) => Promise<ToolResult>` → `(args: T) => Promise<Result<ToolSuccess<T>, ToolFailure>>`
- `_post.ts:withPostState` も Result-aware に書き換え、`ToolResult` 出力は最終 boundary でのみ converter 経由生成
- `TOOL_REGISTRY` schema を Result-aware 化、各 tool の typed `ToolSuccess<T>` を脱-string-JSON 化 (現状は JSON.parse 経由、Result 化で型レベル access 可能)

#### 3.6.3 Phase 5 着手 trigger

本 ADR-021 Phase 1-4 完了 + 6 ヶ月 dogfood で Phase 2/3a 後の drift 0 件確認後、effort 評価 + scope 切り出しで起草判断。

#### 3.6.4 Phase 5 size estimate

~1500 LOC (29 handler signature × 50 LOC 平均) + `_post.ts` redesign + `TOOL_REGISTRY` schema 変更 = 別 ADR 想定の中規模 epic。

---

## 4. Acceptance criteria (epic 全体、Round 3 改訂)

- [ ] **Phase 1** L6 完全 closure: ADR-020 §11 L6 を `[x]` + `~~~~` flip、§9 acceptance criteria 3 個目 PARTIAL CLOSURE 注記削除
- [ ] **Phase 2** `failWith` → Result migration: `failWith` 0 callsite (or PR-P2-2 までで明示 keep 判断)、PR-P2-1 で `obj.post` / `obj._perceptionForPost` / `obj.post.perception` / `obj.post.{focusedWindow,...}` の field-level writer ownership 確立、代表 shape matrix + codemod-generated sampling fixtures で shape 互換性実証、PR-P2-4 Step 2 で `ToolFailure` 型 alias 化 + reach 調査
- [ ] **Phase 3a** `run_macro` inner-result 伝搬の adapter 経由化: `runInnerToolAsResult` 経由、既存 runtime test を Result API assertion に書き直し + revert 実証 (Round 3 改訂で `workspace_launch` 除外)
- [ ] **Phase 4** ESLint rule 1 件 (`no-tool-failure-shape-direct-construct`) land + deterministic regression scenario 3 件 (run_macro + DXGI + modal) land、時間決定論化は vitest `vi.useFakeTimers()` 経由 (`_time.ts` SSOT 新設 不要)
- [ ] ADR-020 §11 L6 / L8 / L10 strikethrough、L9 (UiEntity engine field collapse + ADVISORY_TEXT rule-shape derive) は本 ADR で closure 不要 (別 ADR carry-over 余地維持)

**Carry-over (本 epic 完了時の next milestone trigger)**:
- **Phase 5** (`TOOL_REGISTRY` / `ToolHandler` Result returning 化、F1/F2 compile-time pin): §3.6 で scope outline 確定、本 ADR 完了後 + 6 ヶ月 dogfood で drift 0 件確認後に effort 評価 + 別 ADR 起草
- **Phase 4 後半** ESLint rule 2 件 (`no-direct-envelope-marker-write` + `no-silent-result-discard`): 各 rule の前提 (marker SSOT registry / Result 採用完了) が満たされた段階で個別 PR

---

## 5. Risks (Round 3 改訂)

| R# | risk | 対策 |
|----|------|------|
| R1 | Phase 2 で `_post.ts` writer ownership 設計が誤って失われ post-perception attach 経路を壊す | PR-P2-1 で **field-level writer ownership** (`obj.post` container / `obj._perceptionForPost` / `obj.post.perception` / `obj.post.{focusedWindow,...}`) を `tests/unit/path-class-contract/post-writer-ownership.test.ts` で機械 pin、二重 attach 不可能化 |
| R2 | `failWith` 互換 wrapper 経由の遷移で 2 系統並立期間が長引く | PR-P2-2 同時に **`failWith` import を deprecated 化** (TypeScript `@deprecated` + ESLint warn)、新規 callsite 追加を block、PR-P4-1 で error 昇格 |
| R3 | Phase 3a `run_macro` adapter refactor で existing handler type error 大量発生 | adapter helper を 1 関数 `runInnerToolAsResult` で局所化、`run_macro` のみが consume、`ToolHandler` 自体の型は keep (Phase 5 carry-over)。`workspace_launch` 等の単体 handler は Phase 3a primary scope 外 (Round 3 改訂) |
| R4 | ESLint rule の false positive が developer experience を毀損 | PR-P4-1 を warn 化 land → 1 sprint 観察 → error 昇格、allow-list 機構を rule design に含める |
| R5 | deterministic regression scenario が OS-dependent flake で fail | scenario は **mock / vitest `vi.useFakeTimers()` / 既存 ReplayBackend** (`src/engine/vision-gpu/replay-backend.ts`) で OS surface を decouple、`src/_time.ts` SSOT 等の production timer wiring 変更は本 epic 非ゴール (§2.2 明示) |
| R6 | 本 epic 進行中に v1.7.0 後の new feature (e.g. issue #352 advisory hints) が並走、merge conflict | Phase 1 + Phase 2 PR-P2-0/-1/-2 完了までは new feature を pause、Phase 2 PR-P2-3 系の codemod は別 branch で先 stash |
| R7 | `Result<T, E>` の `E` 部分の type design が hand-rolled で運用負担 | PR-P2-0 で `defineTypedError(code, suggests, payloadSchema)` のような helper macro を提案、boilerplate を抑制 |
| R8 | PR-P2-0 typed error payload 拡張で `toFailureEnvelope` API が **既存 4 callsite (SR-2 land 済)** の envelope shape を変える | PR-P2-0 PR で既存 4 callsite の shape を **bit-equal を機械保証** (`to-failure-envelope-shape-snapshot.test.ts` 既存 snapshot を kept as-is で diff 0)、新 option (`extras`, `hoistRootExtras`) は optional / default off で既存呼び出しは behavior unchanged |
| R9 | Phase 3a adapter helper が JSON parse path を 2 重 wrap して overhead | `runInnerToolAsResult` 内の JSON parse は **`run_macro` の現行 logic を そのまま relocate**、performance overhead 0 を bench (`benches/` 配下に micro-bench 追加余地)、production code path 数は不変 |
| R10 | Phase 2 LOC が realistic 2500-3500 で当初想定 1500-2000 を超過、Phase 2 完了 timing が後ろ倒し | §3.1 phase table size を Round 3 で 2500-3500 に改訂、PR-P2-3 を a/b/c/d 4 分割に増やしてレビュー単位を縮約 (~45 callsite/PR)、Phase 2 完了 milestone を 1.5-2 ヶ月想定 |
| R11 | PR-P2-0 code 決定 location 案 (a)(b)(c) で codemod 適用後の典型 callsite が想定外に膨らむ | OQ-7 で user 着手前確定、(c) factory 案を推奨理由 (loose coupling + boilerplate 抑制) を明示、PR-P2-0 内で 5 件 sample callsite を pilot 適用して LOC growth 計測 |

---

## 6. Open Questions (Round 3 — user 諮問)

### OQ-1 — Phase 2 で `failWith` を完全削除 vs 最終形として小数残置

(Round 1 から継続)

**(a) 完全削除** (`failWith` 0 callsite、`ToolFailure` shape は `ToolFailureError` payload type の alias に簡約 — Phase 5 で `Result<ToolSuccess, ToolFailure>` を採るため、`Result<never, ...>` wrapper への alias は nested Result になるので不可、PR-P2-4 Step 2 参照)
**(b) 互換層として keep**、`failWith` 経由 callsite は新規追加禁止 (lint rule)、既存 176 件はそのまま動く wrapper として永続化
**(c) hybrid**: 一部の handler-internal callsite (e.g. `_post.ts` 内部) は `failWith` keep、外部 callsite は Result migrate

→ **Round 3 推奨 (a)**: 2 系統並立を完全解消。Phase 2 PR-P2-4 Step 1 で実現。

### OQ-2 — `_post.ts` post-perception attach の **field-level writer ownership** (Round 3 改訂)

**(a) Round 3 §3.3.2 PR-P2-1 で確立する field-level writer 分界**:
- `obj.post` container = `_post.ts:withPostState`
- `obj._perceptionForPost` = converter (or `failWith` legacy hoist)
- `obj.post.perception` = `_post.ts:withPostState`
- `obj.post.{focusedWindow,...}` = `_post.ts:withPostState`

**(b) `withPostState` が Result を受け取って最後に converter を呼ぶ設計** (Phase 5 carry-over で実現するのが自然、Phase 2 では over-scope)

→ **Round 3 推奨 (a)**: Phase 2 範囲で実現可、`_post.ts` の wrapper-level snapshot 構築責務を破壊しない。(b) は Phase 5 で TOOL_REGISTRY Result 化と合わせて自然に統合される (Round 3 改訂で user High finding 反映)。

### OQ-3 — Phase 3a の adapter helper 設計

**(a) `runInnerToolAsResult(entry, validated): Promise<Result<ToolSuccess, ToolFailure>>` 新設** (Round 2/3 提案)
**(b) `ToolHandler` の戻り値型 alias を変えて Result type も accept 可能化** (Phase 5 で取り上げる、Phase 3a では過剰)
**(c) Phase 3a 自体を skip して Phase 5 (TOOL_REGISTRY Result 化) に統合**

→ **Round 3 推奨 (a)**: adapter helper 1 関数で局所化、`ToolHandler` 型は keep、`run_macro` が Result API のみ consume。`workspace_launch` 等は Phase 3a primary scope 外 (Round 3 user feedback 反映)。Phase 5 (TOOL_REGISTRY Result 化) は本 epic carry-over として残置。

### OQ-4 — Phase 2 の shape 互換性検証手法

**(a) 代表 shape matrix (8 形) + codemod-generated fixtures (bucket 別 最低 2 件 + 全体 10% 以上、deterministic seed)** (Round 3 改訂で具体化)
**(b) 全 176 callsite JSON.stringify bit-equal 機械保証** (Round 1 案、Round 2/3 で却下)
**(c) Manual review per PR + sampling 不要**

→ **Round 3 推奨 (a)**: 代表 matrix で main の shape 種類網羅、codemod fixtures helper (`scripts/extract-failwith-shape-fixtures.mjs` 提案) で deterministic 抽出 + CI gate、全件 bit-equal は scope creep。

### OQ-5 — Phase 4 ESLint rule の初回 scope

**(a) `no-tool-failure-shape-direct-construct` 1 件のみ** (Round 2/3 提案、scope 縮約)
**(b) `no-tool-failure-shape-direct-construct` + `no-silent-result-discard` 2 件** (Round 1 中間案)
**(c) 3 件全 land** (Round 1 当初案、Round 2/3 で却下)

→ **Round 3 推奨 (a)**: marker SSOT registry / Result 完全採用 が前提の rule は別 PR carry-over。

### OQ-6 — 本 ADR の起草 number / Phase 1 着手 timing

(Round 1 から継続)

**(a) ADR-021 で確定**、本 doc を land 後すぐ Phase 1 PR-P1-1 着手
**(b) ADR-021 起草 + Phase 1 を同 PR で bundle**
**(c) ADR-022 にずらす**

→ **Round 3 推奨 (a)**: 番号 021 確定、本 doc は plan-only で merge、Phase 1 は別 PR で順次着手。

### OQ-7 — PR-P2-0 code 決定 location (Round 3 新規 P2-1 反映)

**(a) caller-side で `classify(message)`** (176 callsite に boilerplate)
**(b) typed error class constructor 内** (tight coupling)
**(c) 中間 dispatcher `errorFromMessage(message, toolName, context)` factory** (新規層 1 個、loose coupling)

→ **Round 3 推奨 (c)**: `failWith` 内部の `classify(message)` 呼び出しを `errorFromMessage` factory に移し、PR-P2-2 で `failWith` 互換 wrapper が factory を call、PR-P2-3 codemod で 176 callsite が factory を直接 call する形に統一。typed error class は thin、classify は factory 1 箇所に集約。

---

## 7. 参照

- ADR-020 (`docs/adr-020-path-class-refactor-plan.md`) §11 L6/L8/L10
- ADR-020 SR-2 sub-plan (`docs/adr-020-phase-3-sr-2-handler-result-boundary-plan.md`) §9 OQ-SR2-4 / OQ-SR2-5
- 既存 Result 実装: `src/types/result.ts`, `src/errors/typed-errors.ts:15:HandlerError`, `src/tools/_envelope.ts:1241-1264:toFailureEnvelope`
- `src/tools/_errors.ts:685-718` `failWith` 定義 + `_errors.ts:14-15` `ROOT_HOISTED_KEYS`
- `src/tools/_types.ts` `ToolFailure` 型定義 (`_errors.ts:1` で import 元)
- `src/tools/_post.ts:115-161` `withPostState` post-perception hook (特に :121-133 で `obj.post` container 構築、:140-161 で perception move)
- `src/tools/macro.ts:465-496` `run_macro` inner-step JSON parse 経路
- `src/tools/workspace.ts:208,260` `workspace_launch` 単体 handler (Phase 3a primary scope 外)
- 既存 runtime pin: `tests/unit/run-macro-stop-on-error-inner-envelope.test.ts:46`
- 既存 vision-gpu ReplayBackend: `src/engine/vision-gpu/replay-backend.ts`
- 過去 drift case canonical: `docs/llm-audit/phase6-dogfood-findings.md` §F1 (run_macro silent-success)、ADR-020 §11 L1-L7 closure 経緯

---

## 8. 起草 metadata

- **Round 1** (2026-05-19 早い段階): Claude (Opus) draft、scope に compile-time pin + 全 callsite bit-equal の強い言い切りを含む
- **Round 2** (2026-05-19): user grounded review (4 件) で過剰約束を撃ち落とし → Phase 構成・acceptance・OQ を改訂
- **Round 3** (本 doc、2026-05-19): user grounded review (3 件: writer ownership / HandlerError.message 衝突 / workspace_launch 不適切) + 自己 Opus review (8 件: P2x6 + P3x2) を fold → 以下で改訂:
  - **§3.3.2 PR-P2-1** `obj.post` writer ownership を **field-level 4 分界** で明示 (user High finding 反映)
  - **§3.3.2 PR-P2-0** payload field `message` を `displayMessage` に rename (user Medium finding 反映、`HandlerError extends Error` 継承の `Error.message` shadow 回避)
  - **§3.4 Phase 3a** primary scope から `workspace_launch` を除外、`run_macro` 1 件に縮約 (user Medium finding 反映)
  - **§3.3.2 PR-P2-0** code 決定 location を OQ-7 として user 諮問新設 (自己 review P2-1)
  - **§3.3.2 PR-P2-2** codemod fixtures sampling 仕様 (bucket 別 + deterministic seed + CI gate) を明示 (自己 review P2-2)
  - **§3.3.2 PR-P2-4** を Step 1 (`failWith` 削除) + Step 2 (`ToolFailure` 型 `_types.ts` alias 化 + reach 調査) に分割 (自己 review P2-3)
  - **§3.1 phase table** Phase 2 size を 2500-3500 LOC に改訂、PR-P2-3 を a/b/c/d 4 分割 (自己 review P2-4)
  - **§2.2 / §3.5.2 / §5 R5** `src/_time.ts` SSOT mention を撤回、Phase 4 deterministic regression scenario は vitest `vi.useFakeTimers()` で時間決定論化 (自己 review P2-5)
  - **§3.6** Phase 5 (carry-over) scope outline を新設 (自己 review P2-6)
  - **§0** Round 0 削除の memory 参照を明示 (自己 review P3-1)
  - **§3.2 PR-P1-1** 新規 file `-shape-snapshot.test.ts` 独立新設を明示 (自己 review P3-2)
- **Round 3 post-PR fix** (2026-05-19、Codex auto-review P2 反映): PR-P2-4 Step 2 + OQ-1(a) の `ToolFailure` alias target を `Result<never, ToolFailureError>` から **`ToolFailureError` payload type** に修正。Phase 5 で `Result<ToolSuccess, ToolFailure>` signature を採るとき nested Result 化を回避、single success/failure boundary を保持
- **Round 4 trigger**: OQ-1〜OQ-7 への user feedback で着手判断確定後、本 doc 改稿または Phase 1 PR 着手

### Round 1 → Round 2 → Round 3 で却下された / 弱められた強い言い切り

| Round 1 記述 | Round 2 改訂 | Round 3 改訂 |
|---|---|---|
| F1/F2 silent-success が compile error | Phase 3a runtime test pin + Phase 5 carry-over | (同左、変更なし) |
| 全 176 callsite bit-equal 機械保証 | 代表 shape matrix (8 形) + 10% sampling | + codemod-generated fixtures (bucket 別 + deterministic seed + CI gate) |
| `failWith` を thin wrapper 化 (情報伝搬詳細未定) | PR-P2-0 で typed error payload 拡張を前提作業 | + `displayMessage` 命名 (user Medium 反映) + code 決定 location OQ-7 (P2-1) |
| `_post.ts` redesign (target shape 未定) | PR-P2-1 で single-writer contract | **field-level writer 4 分界** (user High 反映) |
| ESLint rule 3 件全 land | 1 rule + 2 件 carry-over | (同左、変更なし) |
| Phase 3a に workspace_launch 含む | (同左) | `workspace_launch` 除外、run_macro 1 件 (user Medium 反映) |
| `src/_time.ts` SSOT 新設 (R5) | (Phase 4 carry-over) | **撤回、vitest `vi.useFakeTimers()` で代替** (自己 review P2-5) |
