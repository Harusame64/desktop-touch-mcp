# ADR-020 Phase 2 PR-P2-2 — F refactor: computeLeaseTtlMs input 拡張 sub-plan

- Status: **Drafted (2026-05-17、Round 2 user 提供 Opus phase-boundary review High×2 + Medium + Low 反映)**
- 親 ADR: `docs/adr-020-path-class-refactor-plan.md` (epic plan、merged PR #335)
- 該当 Phase / 軸: Phase 2 PR-P2-2 (F refactor、scope §4.4 F bullet)
- 関連 issue: #327 item F (closed by PR #328、本 sub-plan で構造除去完了)
- 関連 PR (baseline): #328 (`LEASE_TTL_POLICY.baseMs` 5_000 → 15_000 = F tactical fix)
- 関連 sub-plan: `docs/adr-020-phase-2-p2-1-modal-refactor-plan.md` (PR-P2-1 D refactor、merged PR #336、本 sub-plan の pattern reference)

---

## 0. 親 ADR + user 判断引き継ぎ (2026-05-17 session で先取り確定)

本 sub-plan は ADR-020 land + PR-P2-1 land 直後の user judgment session (2026-05-17) で以下が確定済:

**Phase 2 F refactor design (本 sub-plan に直接影響)**:
- `observedRoundTripMs` 計測点: **act→next see() の wallclock 差** (LeaseStore に `last_act_at` timestamp 追加)
- `refreshRequired` 置き場所: **`computeLeaseTtlMs` return shape のみ** (`DesktopSeeOutput` envelope には surface しない、LLM 通知は本 epic 範囲外)
- callsite scope: production callsite = **`src/tools/desktop.ts:392` 1 件のみ** (`LeaseStore.issue(ttlMs?: number)` API は本 epic で touch しない、grep 確認済)

**auto-mode 運用 (PR-P2-1 と同じ)**:
- production code 改修 PR の merge: Opus + Codex 両 Approved で AI merge OK
- release timing: Phase 3 完了で一括 v1.7.0 minor (本 PR-P2-2 は no release、CHANGELOG entry 不要)
- branch 削除: PR merged 直後 auto

---

## 1. Scope

### 1.1 [in scope] 本 PR-P2-2 で扱う

A. **`LeaseStore` に `recordAct(viewId, timestampMs)` method 追加**:
   - per-session で「最後に act が実行された wallclock」を保持する field 追加 (`private lastActAtMsByViewId = new Map<string, number>()`)
   - act 実行 hook (`src/engine/world-graph/guarded-touch.ts` の `touch()` 完了直後) で `session.leaseStore.recordAct(lease.viewId, this.nowFn())` を呼ぶ
   - viewId は per-session で 1 つ (`SessionState.viewId` は see() のたびに新 UUID 発行、`leaseStore` は session-bound) なので **viewId 別に保持する意味は薄い**: 実装簡略化のため `private lastActAtMs?: number` の単一 field でも可、しかし将来の per-viewId 拡張余地として Map 採用が natural
   - **判断**: 単一 field `private lastActAtMs?: number` を採用 (per-session で 1 つあれば十分、YAGNI)、ただし method signature は `recordAct(viewId, timestampMs)` で viewId 引数を受け取り (将来拡張余地保持)

B. **`LeaseStore` に `consumeObservedRoundTripMs(): number | undefined` method 追加 (read-once セマンティクス、Opus High #2 反映)**:
   - `lastActAtMs` が未 set (= 初回 see、まだ act 未実行 / または前回 consume 後) なら `undefined`
   - set 済なら `nowFn() - lastActAtMs` を返し、**直後に `lastActAtMs = undefined` で clear** (read-once)
   - **read-once が必要な理由**: 「act→next see() の wallclock 差」は **次 see() で 1 回だけ消費**するべき値。`get` だけにすると 1 回 act 後の 2 回目、3 回目の see で古い `lastActAtMs` から測り続け = 「最後に act した時刻からの累積経過」になり、本来の round-trip wallclock 意味から離れる (Opus 指摘 High #2)。`consume` semantics で per-see サイクル (see→act→see→act→see…) ごとに新値を返し、未 act 期間は undefined を返す
   - method naming `consume*` は `get*` と区別 (side-effect 含み、命名で副作用明示)

C. **`computeLeaseTtlMs` input 拡張 + return shape 変更**:
   - input shape: `{ view, entityCount, payloadBytes }` → `{ view, entityCount, payloadBytes, observedRoundTripMs? }`
   - return shape: `number` → `{ ttlMs: number, refreshRequired: boolean }`
   - cap 内 (`observedRoundTripMs ≤ cap`) 挙動: `clamp(max(raw, observedRoundTripMs ?? 0), floor, cap)` → `{ ttlMs, refreshRequired: false }`
   - cap 超え (`observedRoundTripMs > cap`) 挙動: `{ ttlMs: cap, refreshRequired: true }`
   - 既存 `LEASE_TTL_POLICY.cap = 60_000` 不変

D. **`computeSoftExpiresAtMs` callsite 整合**:
   - 現状 `computeSoftExpiresAtMs(issuedAtMs, ttlMs)` で number 引数 — `computeLeaseTtlMs` 新 return shape に合わせて `policyTtl.ttlMs` を渡す形に変更
   - `computeSoftExpiresAtMs` signature は不変 (number 引数のまま、refreshRequired は別経路)

E. **`desktop.ts:390-396` callsite 移行 (production 1 件、`defaultTtlMs` branch 含む、Opus High #1 反映)**:
   - 現コード:
     ```ts
     const policyTtl = this.opts.defaultTtlMs !== undefined
       ? this.opts.defaultTtlMs                      // ← number
       : computeLeaseTtlMs({...});                   // ← 新 shape では { ttlMs, refreshRequired }
     ```
   - **両 branch を新 return shape に正規化**:
     ```ts
     const policyTtl: { ttlMs: number; refreshRequired: boolean } =
       this.opts.defaultTtlMs !== undefined
         ? { ttlMs: this.opts.defaultTtlMs, refreshRequired: false }   // ← object 正規化
         : computeLeaseTtlMs({
             view: input.view,
             entityCount: resolved.length,
             payloadBytes: estimatedPayloadBytes,
             observedRoundTripMs: session.leaseStore.consumeObservedRoundTripMs(),   // ← read-once consume
           });
     ```
   - `session.leaseStore.issue(e, newViewId, policyTtl.ttlMs)` で数値だけ渡す (`LeaseStore.issue` API 不変、本 epic 範囲外維持)
   - `computeSoftExpiresAtMs(issuedAtMs, policyTtl.ttlMs)` (同様に object unwrap)
   - `policyTtl.refreshRequired` は **本 PR では使わない** (= envelope surface NOT、§0 user 確定方針)、将来 LLM 通知時に consume できるよう値は計算しておく
   - **Opus High #1 教訓**: `defaultTtlMs` branch 移行抜けは silent fail (`policyTtl.ttlMs` 参照で `undefined.ttlMs` runtime error) → 必ず正規化する

F. **`guarded-touch.ts:328-333` 周辺 (execute 試行 = recordAct、Opus Medium 反映で hook 揺れ解消)**:
   - **hook 位置確定: execute 直前 pre-record pattern** (try/catch の execute 直前 1 箇所のみで `recordAct` を呼ぶ)
   - 確定 pattern:
     ```ts
     // 5. Execute — no await between validate and execute (TOCTOU prevention).
     // ADR-020 PR-P2-2: record act attempt timestamp before execute. Captures
     // LLM thinking time (act attempt = end-of-thinking), independent of
     // execute success/failure. read by consumeObservedRoundTripMs() on next
     // see() call.
     this.leaseStore.recordAct(lease.viewId, this.nowFn());
     let outcome: ExecutorKind | ExecutorOutcome;
     try {
       outcome = await this.env.execute(entity, concreteAction, text);
     } catch {
       return { ok: false, reason: "executor_failed", diff: [] };
     }
     ```
   - **採用論拠**: (a) execute 試行 = LLM 思考終了時点として正確 (実 execute の成功 / 失敗は OS / 対象アプリ都合で round-trip wallclock の意味を変えない)、(b) try/finally 案は finally で二重 recordAct 危険 + execute throw 後の recordAct が「失敗後 wallclock」になり微差、(c) pre-record は **1 箇所 1 行**で最も読みやすい
   - **failure path (validate 失敗 / lease_expired / modal_blocking / entity_outside_viewport) では recordAct しない** = execute 直前 hook 位置なので validation early-return 経路は通過しない (構造的保証)

G. **既存 test 修正**:
   - `tests/unit/lease-ttl-policy.test.ts` 既存 全 case を新 return shape 対応 (`.toBe(15_000)` → `.toEqual({ ttlMs: 15_000, refreshRequired: false })` または `expect(result.ttlMs).toBe(15_000); expect(result.refreshRequired).toBe(false)`)
   - 既存 case は概ね `observedRoundTripMs` 未指定 (= undefined) なので新 return shape のみの変更で意味論不変
   - 既存 lease-store test (もしあれば) は recordAct / getObservedRoundTripMs を mock しない、デフォルト挙動 (= 未呼出 = undefined) で pass 維持

H. **新規 test 追加**:
   - `tests/unit/lease-ttl-policy.test.ts` 既存ファイルに **2-branch contract test** 追加:
     - cap 内: `observedRoundTripMs` 各値で `ttlMs ≥ observedRoundTripMs` + `refreshRequired === false`
     - cap 超え: `ttlMs === cap` + `refreshRequired === true`
     - 純粋関数 unit test (fast-check は PR-P2-3 で導入予定、本 PR では table-based でも property-based でもよい、本 PR では table-based 採用で軽量)
   - `tests/unit/lease-store.test.ts` (もし存在しなければ新規) に `recordAct` + `getObservedRoundTripMs` の round-trip test 追加 (3-4 case)

### 1.2 [out of scope] 本 PR で扱わない

- **fast-check 導入**: PR-P2-3 で導入、本 PR は既存 vitest table-based のみ
- **`DesktopSeeOutput.refreshRequired` 追加 (envelope surface)**: §0 user 確定で **本 epic 範囲外**
- **`LeaseStore.issue()` API 拡張**: 既存 `(entity, viewId, ttlMs?: number)` signature 不変、本 epic 範囲外
- **PR-P2-3 contract test**: D + F + 1 件 (C 推奨) の contract test pin、本 PR は F 純粋関数 contract のみ
- **observedRoundTripMs の telemetry export**: 実測 p95 比較は将来別 work (本 epic 範囲外)

---

## 2. 北極星 (本 sub-plan)

ADR-020 §2 全 4 項目を継承 + 本 PR 固有:

1. **`computeLeaseTtlMs` を input-driven 純粋関数に強化** (= ADR-020 §1.1 F 軸の根本対策): TTL 算出が `observedRoundTripMs` を入力に取り、output が必ず input を下回らない (cap 内)
2. **cap 60s 不変、超過時の挙動は `refreshRequired` marker で明示** (Round 3 §1 教訓 = 言い切れない条件は marker で hedged): LLM-facing API は変えず、内部 return shape のみ拡張
3. **`recordAct` hook が touch 完了 path のみで呼ばれる** (failure path での誤計測を防ぐ): `observedRoundTripMs` が実際の round-trip wallclock を反映

---

## 3. 既存コード状況 (grep 確認済)

### 3.1 `computeLeaseTtlMs` callsite + test

| caller | line | 現コード |
|--------|------|---------|
| `src/tools/desktop.ts` | 392 | `computeLeaseTtlMs({ view, entityCount, payloadBytes })` |
| `tests/unit/lease-ttl-policy.test.ts` | 多数 | `.toBe(N)` 形式の number 比較 (~30 case 程度、見積) |

production callsite は **1 件のみ** (確認済)、test は同 file 内多数。

### 3.2 `LeaseStore` 現状

- `private readonly leases = new Map<string, EntityLease>()` で per-entity lease 保持
- `private readonly nowFn: () => number` 注入済 (テスト時 fake 可能)
- 既存 method: `issue / validate / get / evictExpired` (Opus Low 反映、`clear` は存在しない、`recordAct` / `consumeObservedRoundTripMs` は新規)
- `lease-store.ts` 全体は ~97 line (実測)、追加 30-40 line で足りる

### 3.3 `act` 実行 path

- `desktop.ts:513` で `session.leaseStore.validate(...)` を call
- `guarded-touch.ts:298` で `this.leaseStore.validate(lease, gen, live)` を call
- 実 touch (execute) は `guarded-touch.ts` の `touch()` method 内、validate 後の execute path
- `recordAct` hook は `guarded-touch.ts::touch()` 内 = lease 単位の per-session で記録

---

## 4. 実装内訳 (PR 単一、推定 ~250-350 line)

### 4.1 新規 / 改修 file

| file | 変更内容 | 推定 line |
|------|----------|----------|
| `src/engine/world-graph/lease-store.ts` | `lastActAtMs` field + `recordAct(viewId, timestampMs)` + `getObservedRoundTripMs()` 追加 | +30-40 |
| `src/engine/world-graph/lease-ttl-policy.ts` | input shape 拡張 + return shape 変更 + 2-branch logic | +25-35 |
| `src/tools/desktop.ts` | `:392` callsite 移行 (return shape unwrap + observedRoundTripMs 引数追加) + `:421` `computeSoftExpiresAtMs` 引数を `policyTtl.ttlMs` に | +5-10 |
| `src/engine/world-graph/guarded-touch.ts` | `touch()` 完了 path で `recordAct` hook 追加 | +3-5 |
| `tests/unit/lease-ttl-policy.test.ts` | 既存 case を新 return shape 対応 + 2-branch contract test 追加 | +50-100 (新規 + 修正) |
| `tests/unit/lease-store.test.ts` | (存在すれば修正、なければ新規) recordAct + getObservedRoundTripMs round-trip test | +30-50 |

### 4.2 import / export 変更

- `LeaseTtlInput` type に `observedRoundTripMs?: number` 追加 (既存 export 維持)
- `LeaseTtlResult` (新規 type) export: `{ ttlMs: number; refreshRequired: boolean }`
- `computeLeaseTtlMs` return type 変更 (signature breaking change だが production callsite 1 件のみで scope 限定、test も同 PR で修正)

---

## 5. BC (Backward Compatibility) 確認

- **production user-facing API**: 不変 (`DesktopSeeOutput` shape 不変、`computeSoftExpiresAtMs` signature 不変)
- **internal `computeLeaseTtlMs` signature**: breaking change (number → object return)、ただし production callsite 1 件 + test のみで scope 限定、本 PR 内で全件移行
- **`LeaseStore.issue()` signature**: 不変 (`ttlMs?: number` 引数のまま)
- **`LeaseStore` 新 method (`recordAct` / `getObservedRoundTripMs`)**: 追加のみ、既存 method 不変

---

## 6. Risks

| R# | risk | 対策 |
|----|------|------|
| R1 | `recordAct` hook が failure path で呼ばれて `observedRoundTripMs` が無効値を返す | sub-plan §1.1 F で「touch 完了 path のみ、execute 試行 = recordAct」と明示、impl review で hook 位置を Opus + Codex sweep |
| R2 | `computeLeaseTtlMs` return shape 変更で既存 test が breaking、本 PR scope を超える | grep で test file 把握済 = `tests/unit/lease-ttl-policy.test.ts` 1 file のみ、test 修正を本 PR scope に含める |
| R3 | `observedRoundTripMs` 計算が「act→next see()」だが per-session で `lastActAtMs` を 1 つしか持たず、複数 session 並走時に競合 | LeaseStore は per-session bound (SessionRegistry が session 別 LeaseStore 保持)、global state 共有なし |
| R4 | cap 超え時の `refreshRequired: true` marker が LLM に届かない (envelope surface NOT 方針) ため LLM の thinking 時間 超過で lease expire が continue する | §0 user 確定: LLM 通知は本 epic 範囲外、将来別 work で `DesktopSeeOutput.refreshRequired` 追加検討 |
| R5 | sub-plan §1.1 のコード設計と impl が乖離 (PR-P2-1 P3-1 同型 docs drift) | sub-plan §1.1 + §4 のコード位置 / hook 位置 / signature を impl と bit-equal sync、Opus phase-boundary review で fact 整合 sweep 必須 |

---

## 7. Acceptance criteria

- `LeaseStore.recordAct(viewId, timestampMs)` + `LeaseStore.getObservedRoundTripMs()` export + JSDoc 完備
- `computeLeaseTtlMs` 新 return shape `{ ttlMs, refreshRequired }` + 2-branch contract 実装
- `desktop.ts:392` + `:421` callsite 移行
- `guarded-touch.ts` `touch()` 完了 path で `recordAct` hook 動作
- 既存 `lease-ttl-policy.test.ts` 全 case 新 shape 対応 + 2-branch contract test 新規追加
- 新規 `lease-store.test.ts` (or 既存修正) `recordAct` / `getObservedRoundTripMs` round-trip test 追加
- 既存 vitest suite 全 pass + tsc clean
- Opus + Codex 各 1+ round Approved (production code 改修 PR、CLAUDE.md §3.3 Step 0)
- ADR-020 carry-over ledger L5 (F) を sub-plan land 後の commit message で 構造除去候補化 (formal strikethrough は PR-P2-3 contract test land 時)

---

## 8. Open Questions

### Resolved (Round 2 = user 提供 Opus phase-boundary review 反映)

- ~~**OQ #1**: `recordAct` hook 位置~~ → **execute 直前 pre-record pattern 確定** (§1.1 F、Opus Medium 反映で揺れ解消)、validation early-return path は通過しないため failure path での誤計測ゼロ

### 残存

- **OQ #2**: `LeaseStore` 内 `lastActAtMs` を単一 field vs Map<viewId, number> → 本 sub-plan §1.1 A で単一 field 採用判断済 (YAGNI)、ただし signature は viewId 引数受け取り (将来拡張余地)
- **OQ #3**: 2-branch contract test を fast-check property-based で書く vs table-based で書く → PR-P2-3 で fast-check 導入予定、本 PR では table-based で軽量、PR-P2-3 で property-based 化検討

---

## 9. 起草 metadata

- 起草日: 2026-05-17 (Round 1)、Round 2 反映: 2026-05-17 (user 提供 Opus phase-boundary review)
- 起草 session: PR-P2-1 land 直後 (commit `c791fede`、auto-mode で PR-P2-2 起動 user 確定)
- 起草前 read 済: ADR-020 全体 + PR-P2-1 sub-plan + `src/tools/desktop.ts:380-422` + `src/engine/world-graph/lease-store.ts:1-97` + `src/engine/world-graph/lease-ttl-policy.ts` + `tests/unit/lease-ttl-policy.test.ts:1-50` + grep 確認 (`computeLeaseTtlMs` callsite / `LeaseStore.issue` callsite) + `src/engine/world-graph/guarded-touch.ts:285-345` (recordAct hook 位置 精査)
- Round 2 反映 (Opus phase-boundary review 4 件):
  - **High #1**: §1.1 E + §4.1 で `defaultTtlMs` branch を object 正規化 (`{ ttlMs: defaultTtlMs, refreshRequired: false }`) 明示 (silent fail 防止)
  - **High #2**: §1.1 B で `getObservedRoundTripMs` → `consumeObservedRoundTripMs` rename、read-once セマンティクス明示 (累積経過化 防止)
  - **Medium**: §1.1 F で `recordAct` hook 位置を **execute 直前 pre-record pattern** 確定 (try/finally 案 / 試行全て案 揺れ解消)
  - **Low**: §3.2 LeaseStore 既存 method list 訂正 (`clear` 削除 → `evictExpired` 追加)
- Round 2 OQ: OQ #1 Resolved (recordAct hook 位置確定)、残存 OQ #2/#3
- **教訓 (memory `feedback_sub_plan_opus_review_first.md` 化済)**: PR-P2-1 同型運用で sub-plan 起草直後 user 諮問する前に **Opus phase-boundary review を必ず通す** (本 round で User が手動 Opus review を救済役で動かしたパターンを構造化、次 sub-plan = PR-P2-3 から auto-mode で先取り遵守)
- 次のステップ: Round 2 改訂 sub-plan を chat 表示 → user 目視確認 → 修正なければ feature branch + impl + commit + PR + Opus/Codex 並列 review + auto-mode merge
