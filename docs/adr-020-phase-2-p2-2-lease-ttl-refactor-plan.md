# ADR-020 Phase 2 PR-P2-2 — F refactor: computeLeaseTtlMs input 拡張 sub-plan

- Status: **Drafted (2026-05-17、Round 6 = PR Opus Round 4 P2×3+P3×1 + Codex Round 4 P2 sampleSeq monotonic token 反映)**
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

A. **`LeaseStore` に `recordAct(viewId)` method 追加** (Round 3 P2-1 反映で signature 訂正、no-arg + 内部 nowFn 使用):
   - per-session で「最後に act が実行された wallclock」を保持する field 追加 (`private lastActAtMs?: number`)
   - act 実行 hook (`src/engine/world-graph/guarded-touch.ts` の `touch()` 内 execute 直前 pre-record path) で `session.leaseStore.recordAct(lease.viewId)` を呼ぶ (timestamp は LeaseStore 内部 `nowFn()` 経由 = fake timer 自動対応)
   - viewId は per-session で 1 つ (`SessionState.viewId` は see() のたびに新 UUID 発行、`leaseStore` は session-bound) なので **viewId 別に保持する意味は薄い**: 単一 field `private lastActAtMs?: number` で十分 (YAGNI)
   - **判断**: 単一 field + signature `recordAct(viewId)` (viewId 引数は将来 per-viewId Map 拡張余地として受け取り、timestamp は内部 nowFn 経由でテスト時 fake 自動適用)

B. **`LeaseStore` に `peekObservedRoundTripMs()` / `commitObservedRoundTripMs(sampleSeq)` / `consumeObservedRoundTripMs()` 3 method 追加 (read-once + CAS-guarded セマンティクス、Opus High #2 + Codex Round 2/3/4 反映)**:
   - **`peekObservedRoundTripMs(): { elapsedMs: number, sampleSeq: number } | undefined`** — 副作用なし read。`lastActAtMs` 未 set なら `undefined`、set 済なら `{ elapsedMs: nowFn() - lastActAtMs, sampleSeq: lastActSeq }` を返す (clear なし)。`sampleSeq` は monotonic counter で CAS token として commit に渡す
   - **`commitObservedRoundTripMs(sampleSeq: number): void`** — CAS-guarded clear。`lastActSeq === sampleSeq` の場合のみ `lastActAtMs = undefined` (no-op safe、stale token は newer sample 保持)
   - **`consumeObservedRoundTripMs()`** — token-less composite shorthand (peek + 無条件 clear)。tests / 単純な one-shot caller 向け BC API、production は CAS path 使用
   - **production `see()` path は peek + CAS commit 2 段階を使う**:
     - **Codex R2 (failure preservation)**: see() entry で `peek`、TTL 計算 + output 構築まで成功した後 (return 直前) で `commit`。snapshot 失敗で throw すると関数を抜けるため commit が実行されず、sample は staged 状態で次 see() に持ち越される (`act → 失敗 see → 次成功 see` の wallclock を正しく回収)
     - **Codex R3 (concurrent race)**: HTTP-mode facade が process-global、see() の await 経路 (snapshot / window enum) で concurrent recordAct() が走る → 無条件 commit は新 sample stomp。CAS commit で stale token = no-op、newer sample 保持
     - **Codex R4 (same-ms collision)**: CAS token に `sampleAtMs` (ms timestamp) を使うと同 ms 内 recordAct で token 衝突 → CAS guard が false positive で newer stomp。`sampleSeq` (monotonic counter) は collision なし、ms 解像度に依存しない構造的保証
   - **read-once が必要な理由**: 「act→next see() の wallclock 差」は **次 see() で 1 回だけ消費**するべき値。`peek` だけだと 1 回 act 後の 2 回目、3 回目の see で古い `lastActAtMs` から測り続け = 「最後に act した時刻からの累積経過」になり、本来の round-trip wallclock 意味から離れる (Opus High #2)。production path で `peek` 後 `commit` を return 直前に置くことで per-see サイクルで 1 回だけ消費、未 act 期間 / failure path / concurrent race / same-ms collision で sample 保持を両立
   - method naming: `peek*` (副作用なし read) / `commit*` (CAS clear) / `consume*` (token-less composite) — 副作用と CAS semantics を命名で明示

C. **`computeLeaseTtlMs` input 拡張 + return shape 変更**:
   - input shape: `{ view, entityCount, payloadBytes }` → `{ view, entityCount, payloadBytes, observedRoundTripMs? }`
   - return shape: `number` → `{ ttlMs: number, refreshRequired: boolean }`
   - cap 内 (`observedRoundTripMs ≤ cap`) 挙動: `clamp(max(raw, observedRoundTripMs ?? 0), floor, cap)` → `{ ttlMs, refreshRequired: false }`
   - cap 超え (`observedRoundTripMs > cap`) 挙動: `{ ttlMs: cap, refreshRequired: true }`
   - 既存 `LEASE_TTL_POLICY.cap = 60_000` 不変

D. **`computeSoftExpiresAtMs` callsite 整合**:
   - 現状 `computeSoftExpiresAtMs(issuedAtMs, ttlMs)` で number 引数 — `computeLeaseTtlMs` 新 return shape に合わせて `policyTtl.ttlMs` を渡す形に変更
   - `computeSoftExpiresAtMs` signature は不変 (number 引数のまま、refreshRequired は別経路)

E. **`desktop.ts` callsite 移行 (production 1 件、`defaultTtlMs` branch 含む、Opus High #1 + Codex Round 1 P2 反映)**:

**Codex Round 1 P2 fix (Round 3 反映)**: `consumeObservedRoundTripMs()` の呼出は **`see()` 関数の entry point 直後 (snapshot await より前)** で行う。後ろに置くと `ingress.getSnapshot` / `candidateProvider` / `windowsProvider` の現 see() backend latency が `observedRoundTripMs` に混入し、本来の「act → next see() 開始時点」より長い値が出る (measurement contamination)。`see()` entry でローカル変数 `observedRoundTripMs` に hold し、後ほど `computeLeaseTtlMs` に渡す。


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
             observedRoundTripMs,                                        // ← see() entry で peek 済 (CAS path)
           });
     // commit はこの後 return 直前で peekedRoundTrip.sampleSeq token guard 付きで呼ぶ
     ```
   - `session.leaseStore.issue(e, newViewId, policyTtl.ttlMs)` で数値だけ渡す (`LeaseStore.issue` API 不変、本 epic 範囲外維持)
   - `computeSoftExpiresAtMs(issuedAtMs, policyTtl.ttlMs)` (同様に object unwrap)
   - `policyTtl.refreshRequired` は **本 PR では使わない** (= envelope surface NOT、§0 user 確定方針)、将来 LLM 通知時に consume できるよう値は計算しておく
   - **observedRoundTripMs 取得は see() entry で `peekObservedRoundTripMs()` 経由** (Codex R1 location / R2 failure preservation / R3 concurrent race / R4 same-ms collision 全 fix path 整合)。`computeLeaseTtlMs` 呼出後、return 直前で `commitObservedRoundTripMs(peekedRoundTrip.sampleSeq)` を CAS token 付きで呼ぶ
   - **Opus High #1 教訓**: `defaultTtlMs` branch 移行抜けは silent fail (`policyTtl.ttlMs` 参照で `undefined.ttlMs` runtime error) → 必ず正規化する

F. **`guarded-touch.ts:328-333` 周辺 (execute 試行 = recordAct、Opus Medium 反映で hook 揺れ解消)**:
   - **hook 位置確定: execute 直前 pre-record pattern** (try/catch の execute 直前 1 箇所のみで `recordAct` を呼ぶ)
   - 確定 pattern:
     ```ts
     // 5. Execute — no await between validate and execute (TOCTOU prevention).
     // ADR-020 PR-P2-2: record act attempt timestamp before execute. Captures
     // LLM thinking time (act attempt = end-of-thinking), independent of
     // execute success/failure. Read by peek + commit (CAS-guarded production
     // path) or consume (BC composite for one-shot/test callers) on the next
     // see() call.
     this.leaseStore.recordAct(lease.viewId);
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
   - 既存 lease-store test (もしあれば) は recordAct / peekObservedRoundTripMs / commitObservedRoundTripMs / consumeObservedRoundTripMs を mock しない、デフォルト挙動 (= 未呼出 = undefined) で pass 維持

H. **新規 test 追加**:
   - `tests/unit/lease-ttl-policy.test.ts` 既存ファイルに **2-branch contract test** 追加:
     - cap 内: `observedRoundTripMs` 各値で `ttlMs ≥ observedRoundTripMs` + `refreshRequired === false`
     - cap 超え: `ttlMs === cap` + `refreshRequired === true`
     - 純粋関数 unit test (fast-check は PR-P2-3 で導入予定、本 PR では table-based でも property-based でもよい、本 PR では table-based 採用で軽量)
   - `tests/unit/lease-store.test.ts` (もし存在しなければ新規) に `recordAct` + `peek/commit (CAS)` + `consume (BC)` の round-trip test 追加 (3-4 base + CAS guard + same-ms collision の 6-8 case)

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
3. **`recordAct` hook が execute 直前 pre-record path で呼ばれる** (validation early-return 経路は構造的にバイパス、failure path での誤計測ゼロ): `observedRoundTripMs` が実際の round-trip wallclock を反映

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
- 既存 method: `issue / validate / get / evictExpired` (Opus Low 反映、`clear` は存在しない、`recordAct` / `peekObservedRoundTripMs` / `commitObservedRoundTripMs` / `consumeObservedRoundTripMs` + `lastActAtMs` / `lastActSeq` / `nextActSeq` field は新規)
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
| `src/engine/world-graph/lease-store.ts` | `lastActAtMs` + `lastActSeq` + `nextActSeq` field + `recordAct(viewId)` + `peekObservedRoundTripMs()` + `commitObservedRoundTripMs(sampleSeq)` + `consumeObservedRoundTripMs()` 追加 | +50-70 |
| `src/engine/world-graph/lease-ttl-policy.ts` | input shape 拡張 + return shape 変更 + 2-branch logic | +25-35 |
| `src/tools/desktop.ts` | `:392` callsite 移行 (return shape unwrap + observedRoundTripMs 引数追加) + `:421` `computeSoftExpiresAtMs` 引数を `policyTtl.ttlMs` に | +5-10 |
| `src/engine/world-graph/guarded-touch.ts` | `touch()` 内 execute 直前 pre-record path で `recordAct` hook 追加 | +3-5 |
| `tests/unit/lease-ttl-policy.test.ts` | 既存 case を新 return shape 対応 + 2-branch contract test 追加 | +50-100 (新規 + 修正) |
| `tests/unit/lease-store.test.ts` | (存在すれば修正、なければ新規) recordAct + peek/commit (CAS) + consume (BC) round-trip test + CAS guard + same-ms collision test | +80-120 |

### 4.2 import / export 変更

- `LeaseTtlInput` type に `observedRoundTripMs?: number` 追加 (既存 export 維持)
- `LeaseTtlResult` (新規 type) export: `{ ttlMs: number; refreshRequired: boolean }`
- `computeLeaseTtlMs` return type 変更 (signature breaking change だが production callsite 1 件のみで scope 限定、test も同 PR で修正)

---

## 5. BC (Backward Compatibility) 確認

- **production user-facing API**: 不変 (`DesktopSeeOutput` shape 不変、`computeSoftExpiresAtMs` signature 不変)
- **internal `computeLeaseTtlMs` signature**: breaking change (number → object return)、ただし production callsite 1 件 + test のみで scope 限定、本 PR 内で全件移行
- **`LeaseStore.issue()` signature**: 不変 (`ttlMs?: number` 引数のまま)
- **`LeaseStore` 新 method (`recordAct` / `peekObservedRoundTripMs` / `commitObservedRoundTripMs` / `consumeObservedRoundTripMs`)**: 追加のみ、既存 method 不変

---

## 6. Risks

| R# | risk | 対策 |
|----|------|------|
| R1 | `recordAct` hook が failure path で呼ばれて `observedRoundTripMs` が無効値を返す | sub-plan §1.1 F で「execute 直前 pre-record path、validation early-return はバイパス」と明示、impl review で hook 位置を Opus + Codex sweep |
| R2 | `computeLeaseTtlMs` return shape 変更で既存 test が breaking、本 PR scope を超える | grep で test file 把握済 = `tests/unit/lease-ttl-policy.test.ts` 1 file のみ、test 修正を本 PR scope に含める |
| R3 | `observedRoundTripMs` 計算が「act→next see()」だが per-session で `lastActAtMs` を 1 つしか持たず、複数 session 並走時に競合 | LeaseStore は per-session bound (SessionRegistry が session 別 LeaseStore 保持)、global state 共有なし |
| R4 | cap 超え時の `refreshRequired: true` marker が LLM に届かない (envelope surface NOT 方針) ため LLM の thinking 時間 超過で lease expire が continue する | §0 user 確定: LLM 通知は本 epic 範囲外、将来別 work で `DesktopSeeOutput.refreshRequired` 追加検討 |
| R5 | sub-plan §1.1 のコード設計と impl が乖離 (PR-P2-1 P3-1 同型 docs drift) | sub-plan §1.1 + §4 のコード位置 / hook 位置 / signature を impl と bit-equal sync、Opus phase-boundary review で fact 整合 sweep 必須 |

---

## 7. Acceptance criteria

- `LeaseStore.recordAct(viewId)` + `LeaseStore.peekObservedRoundTripMs()` + `LeaseStore.commitObservedRoundTripMs(sampleSeq)` + `LeaseStore.consumeObservedRoundTripMs()` export + JSDoc 完備 (CAS pattern + same-ms collision protection 明示)
- `computeLeaseTtlMs` 新 return shape `{ ttlMs, refreshRequired }` + 2-branch contract 実装
- `desktop.ts:392` + `:421` callsite 移行
- `guarded-touch.ts` `touch()` 内 execute 直前 pre-record path で `recordAct` hook 動作
- 既存 `lease-ttl-policy.test.ts` 全 case 新 shape 対応 + 2-branch contract test 新規追加
- 新規 `lease-store.test.ts` (or 既存修正) `recordAct` / `peek/commit (CAS)` / `consume (BC)` round-trip + CAS guard (concurrent recordAct) + same-ms collision test 追加
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
- Round 3 反映点 (PR #337 Opus Round 1 P2-1 + P3-1 + Codex Round 1 P2):
  - **Opus P2-1**: Round 2 で §1.1 B のみ `consumeObservedRoundTripMs` rename + signature 変更を反映したが、sub-plan §1.1 A / §4.1 / §5 / §7 / §8 の **`getObservedRoundTripMs` 旧名 5 箇所 + `recordAct(viewId, timestampMs)` 旧 signature 4 箇所** が sync 漏れ → 全 8 箇所 bit-equal sync (CLAUDE.md §3.1 fact 整合 sweep 教訓、Round 2 改訂時に Grep ですべきだった)
  - **Opus P3-1**: `lease-store.ts:115` `recordAct(_viewId)` JSDoc に `@param _viewId currently unused, accepted for future per-viewId Map expansion` 1 行追記
  - **Opus P3-2**: flaky note baseline 実証は本 PR scope 外、Opus 自身 defer 判定で本 round では不対応
  - **Codex P2 (Opus 見逃しの補完軸、runtime semantics)**: `consumeObservedRoundTripMs()` 呼出位置を `see()` entry 直後に移動 (元: `computeLeaseTtlMs` 引数 inline at line 401)。元の位置だと `ingress.getSnapshot` / `candidateProvider` / `windowsProvider` の現 see() backend latency が `observedRoundTripMs` に汚染、本来の「act → next see() 開始時点」より長い値が出る。`desktop.ts` `see()` 関数 entry 直後でローカル変数に hold + `computeLeaseTtlMs` 引数で渡す形に修正
- Round 3 教訓:
  - (CLAUDE.md §3.1 同型再発): Round 2 で 1 箇所 rename 後の全 docs grep を実施していれば即検出可能、sub-plan 起草 / 改訂時の `Grep <symbol>` sweep を運用化 (PR-P2-3 sub-plan で先取り遵守)
  - (memory `feedback_ai_multi_reviewer.md` Codex 強み「runtime path / nested call semantics」軸再実証): Opus は計測 location の semantic accuracy を見逃し、Codex は async snapshot await → window enum → computeLeaseTtlMs runtime 経路で wallclock 汚染を検出。production code 改修 PR は Codex 並走必須 (CLAUDE.md §3.3 Step 0)
- Round 4 反映点 (PR #337 Opus Round 2 P2 + P3 + Codex Round 2 P2):
  - **Opus R2 P2**: sub-plan §1.1 F line 92 で旧 2-arg `recordAct(lease.viewId, this.nowFn())` 残存 (Round 1 P2-1 sync 漏れの **同型再発**) → `recordAct(lease.viewId)` に sync
  - **Opus R2 P3**: 「`touch()` 完了直後 / 完了 path」5 箇所が Round 2 確定の「execute 直前 pre-record pattern」と矛盾 (§1.1 A / §2 / §3.3 / §4.1 / §7) → 全 5 箇所「execute 直前 pre-record path」に統一
  - **Codex R2 P2 (Opus 見逃しの runtime semantics 第 2 波)**: Round 1 fix で `consumeObservedRoundTripMs()` を see() entry に移動した結果、snapshot/provider が throw すると **sample が clear されたまま TTL 計算に使われない** = one-shot sample が失われる新規副作用検出 → **peek + commit pattern** に拡張: `peekObservedRoundTripMs()` (副作用なし read) / `commitObservedRoundTripMs()` (clear、no-op safe) / `consumeObservedRoundTripMs()` (composite BC API)。production `see()` path は peek + commit 2 段階で「TTL 計算成功 + return 直前で commit」、failure path は throw で関数を抜けるため commit 未実行 → sample 保持
  - 新規 test 6 case (`lease-store.test.ts` peek + commit pattern describe block): peek 副作用なし / undefined / commit clear / commit no-op / failure scenario sample preservation / consume composite BC
- Round 4 教訓:
  - **同型 §3.1 sweep 漏れの二重発生** (Round 2 で「§3.1 sweep 運用化」と書きながら同 round で line 92 を見逃した) → CLAUDE.md §3.3 Step 1 で「修正対象 fact のキーワード全 docs grep」を **rename 系の全リスト** (旧 method 名 / 旧 signature の全 occurrence) で網羅、Round 内で再度 grep を運用化
  - **Codex 補完軸の二段波** (Round 1 = location contamination / Round 2 = one-shot loss in failure path): 「fix がさらなる副作用を生む」pattern。Round n+1 fix の前に **「この fix で何が壊れるか」を Codex 視点で sweep** する preventive pattern が望ましい (memory `feedback_ai_multi_reviewer.md` 追記候補)
- Round 5 反映点 (PR #337 Opus Round 3 P2 + P3×2 + Codex Round 3 P2):
  - **Opus R3 P2**: sub-plan §1.1 A line 34 で「`touch()` 完了直後」が Round 2 P3 確定の「execute 直前 pre-record path」と矛盾 (= **§3.1 sweep 漏れの三重再発**、Round 3 changelog 自体が「全 5 箇所統一」と claim していたのに drift 残存) → §1.1 A line 34 を「`touch()` 内 execute 直前 pre-record path」に sync
  - **Opus R3 P3 (×2)**: `guarded-touch.ts:330` JSDoc + `lease-ttl-policy.ts:67` JSDoc が旧 `consumeObservedRoundTripMs` 用語のみ参照、production path は peek + commit が正 → 両 file JSDoc を「peek + commit (CAS-guarded production path) または consume (BC composite for one-shot/test)」に統一
  - **Codex R3 P2 (Opus 見逃しの runtime semantics 第 3 波)**: HTTP mode で facade が process-global、`see()` の peek↔commit の間 (await 複数あり) に concurrent `recordAct()` が走ると、新 sample が `commitObservedRoundTripMs()` で **無条件 clear** され失われる race → **CAS pattern** に拡張:
    - `peekObservedRoundTripMs()` の return type 変更: `number | undefined` → `{ elapsedMs: number, sampleAtMs: number } | undefined` (`sampleAtMs` = CAS token)
    - `commitObservedRoundTripMs(sampleAtMs: number): void` で token guard 追加 (`lastActAtMs === sampleAtMs` の場合のみ clear、stale token は no-op で newer sample 保持)
    - `consumeObservedRoundTripMs()` は token-less composite として独立化 (test 用 BC、production は CAS path 使用)
    - production `see()` callsite: `peekedRoundTrip = peek(); ... commit(peekedRoundTrip.sampleAtMs)` 形に変更
  - 新規 test 1 case (`lease-store.test.ts` peek+CAS commit describe): "CAS commit with a stale token is a no-op (does not clear newer sample)" で concurrent recordAct シミュレーション pin
- Round 5 教訓:
  - **§3.1 sweep 漏れの三重再発** (Round 1 → 2 → 3 連続) → CLAUDE.md §3.3 Step 1 改訂候補: 「changelog で `claim` した修正リストを実体 grep で fact-check する」=「修正したと書いたら必ず grep で 0 件確認」を運用化、claim と impl の bit-equal sync 強制
  - **Codex 補完軸の三段波** (Round 1 location / Round 2 failure loss / Round 3 concurrent race) — 3 round 連続で「fix が新副作用」: production code 改修 PR は **Codex review を merge ブロッカー化する preventive sweep** が必須 (single Opus Approved は危険、Codex 並走で副作用波を都度検出)、memory `feedback_ai_multi_reviewer.md` 「wrapper 中央化 drift 3 軸」を **「fix の副作用波 3 round pattern」軸として更新**推奨
- Round 6 反映点 (PR #337 Opus Round 4 P2×3 + P3×1 + Codex Round 4 P2):
  - **Opus R4 P2 (×3)**: sub-plan §1.1 B (line 38-44) + §1.1 E callsite 例 (line 77) + §1.1 F コード例 JSDoc (line 92) が CAS pattern 拡張前 / consume only mention のまま (= §3.1 sweep 漏れの **四重再発**、Round 5 changelog で「全件反映」claim 直後に同 commit で sub-plan body drift 残存) → §1.1 B を peek/commit/consume + sampleSeq + CAS pattern 完全記述、§1.1 E callsite 例を see() entry peek + return commit に書き換え、§1.1 F コード例 JSDoc を peek + commit + consume 全 mention に統一
  - **Opus R4 P3**: §3 / §4 table / Acceptance criteria / BC 確認の 8 箇所 `consumeObservedRoundTripMs` 単独参照を 3 method 体制に統一 (line 114 / 121 / 158 / 176 / 181 / 196 / 214 / 219)。historical changelog (line 38/41/62/246/252/255/262/269/273) は意図的 historical fact pin、変更不要
  - **Codex R4 P2 (Opus 見逃しの runtime semantics 第 4 波)**: Round 3 fix の CAS token に `sampleAtMs` (= `Date.now()` ms timestamp) を採用したが、HTTP mode concurrent requests で **同 ms 内 2 つの recordAct** が write すると新 sample も `lastActAtMs = t` で衝突 → stale commit(t) が numeric equality で false positive → newer sample stomp → **monotonic counter token** に変更:
    - `lastActSeq` (counter) + `nextActSeq` (incrementing) field 追加、`recordAct()` で `lastActSeq = nextActSeq++` で unique token 発行
    - `peekObservedRoundTripMs()` return type: `{ elapsedMs, sampleAtMs }` → `{ elapsedMs, sampleSeq }` に変更
    - `commitObservedRoundTripMs(sampleSeq: number)` で `lastActSeq === sampleSeq && lastActAtMs !== undefined` 比較 (seq 一致 + sample 存在の double check)
    - desktop.ts callsite: `peekedRoundTrip.sampleSeq` token pass
  - 新規 test 1 case: "CAS commit is immune to same-millisecond timestamp collisions" で同 nowFn() ms 内 2 recordAct シミュレーション pin
- Round 6 教訓:
  - **§3.1 sweep 漏れの四重再発** (Round 1 → 2 → 3 → 4 連続) — changelog ↔ sub-plan body の bit-equal sync 自体が Round 内で実体 grep を要する。CLAUDE.md §3.3 Step 1 改訂候補を更に強化: 「Round 内 sub-plan 全文 re-read を mandatory 化」(changelog だけでなく規範 section が改訂後 spec と一致するか目視 confirm)、Round n の commit message 作成前に sub-plan を closing-tag-to-opening-tag full re-read
  - **Codex 補完軸の四段波** (R1 location → R2 failure loss → R3 concurrent race → R4 same-ms collision) — 「fix の副作用波 N round pattern」が N=4 まで到達。「ms timestamp は CAS token に向かない」「monotonic counter が安全」は API design の一般教訓、memory `feedback_ai_multi_reviewer.md` 「fix の副作用波 N round pattern」軸に **「CAS token の monotonic 性確保」** を追記候補。LeaseStore 実装は今後の reference impl として活用可能
