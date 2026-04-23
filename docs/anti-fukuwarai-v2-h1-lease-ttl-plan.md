# Anti-Fukuwarai v2 — Batch H1 Lease / TTL Hardening 実装計画

作成: 2026-04-23
対象ブランチ: `desktop-touch-mcp-fukuwaraiv2`
入力: [`anti-fukuwarai-v2-h1-lease-ttl-instructions.md`](anti-fukuwarai-v2-h1-lease-ttl-instructions.md), [`anti-fukuwarai-v2-hardening-backlog.md`](anti-fukuwarai-v2-hardening-backlog.md), [`dogfood-incident-report.md`](dogfood-incident-report.md)

---

## 0. 背景と目的

dogfood（S1 browser-form / S3 terminal）で `desktop_see -> desktop_touch` 間の `lease_expired` が再発した。原因は TTL（固定 5,000 ms）が「UI 静止時間」だけを基準にしており、大きな `explore` 応答（50 entities）や LLM 推論時間を吸収できないこと。

本バッチは **response-size aware TTL** を導入し、重い view ほど少し長く、軽い view は現状維持に寄せる。stale lease safety は完全に維持する。

---

## 1. 変更ファイル一覧

| ファイル | 変更概要 |
|---|---|
| `src/engine/world-graph/lease-ttl-policy.ts` (新規) | `computeLeaseTtlMs()` の算定ロジックを 1 箇所に集約 |
| `src/engine/world-graph/lease-store.ts` | `DEFAULT_TTL_MS` を 5000 のまま維持、コメントを policy 委譲に更新 |
| `src/engine/world-graph/session-registry.ts` | `SessionCreateOpts.ttlPolicy` を option に追加（既存 `defaultTtlMs` は後方互換で残す） |
| `src/tools/desktop.ts` | `see()` 内で view / entity count を基に TTL policy を適用、`leaseStore.issue(entity, viewId, ttlMs)` に ttlMs を渡す |
| `tests/unit/lease-ttl-policy.test.ts` (新規) | TTL 算定ロジックの単体テスト |
| `tests/unit/desktop-facade.test.ts` | view / entity 数で TTL が変わる回帰テストを追加 |
| `tests/unit/guarded-touch.test.ts` | stale lease safety（generation / digest / expiry）の既存テストは無変更のまま通ることを確認 |

最小限の新規ファイル 2 つ、既存編集 3 つ。`guarded-touch.ts` / `types.ts` は触らない。

---

## 2. TTL policy の設計

### 2.1. 基本方針

- **基準 TTL = 5,000 ms**（現状維持）
- **view bonus**: `action` = 0、`explore` = +5,000 ms、`debug` = +10,000 ms
- **entity-count bonus**: 20 entities を超えた分について、1 entity あたり +100 ms 加算（ただし clamp される）
- **上限（cap）**: 30,000 ms（30 秒）
- **下限（floor）**: 2,000 ms（テスト注入時の異常値保護）

### 2.2. 算定式

```
ttlMs = clamp(
  base (5000)
    + viewBonus(view)           // action:0 / explore:+5000 / debug:+10000
    + entityBonus(entityCount), // max(0, (count - 20)) * 100
  floor: 2000,
  cap:   30000
)
```

| view | entity count | 計算 | TTL |
|---|---|---|---|
| action | 5 | 5000 + 0 + 0 | 5,000 ms |
| action | 20 | 5000 + 0 + 0 | 5,000 ms |
| action | 40 | 5000 + 0 + (20·100) | 7,000 ms |
| explore | 5 | 5000 + 5000 + 0 | 10,000 ms |
| explore | 50 | 5000 + 5000 + (30·100) | 13,000 ms |
| explore | 200 | 5000 + 5000 + (180·100) → clamped | 30,000 ms |
| debug | 50 | 5000 + 10000 + (30·100) | 18,000 ms |
| undefined (= action) | 10 | 5000 + 0 + 0 | 5,000 ms |

### 2.3. なぜこの数値か

- dogfood の S1（`explore`, ~50 entities）で LLM 処理時間は 5-10 秒。`explore` ベースラインを 10 秒にすれば余裕が生まれる。
- S3（terminal, `action` 相当）は実際には `action` view で数 entity のケースが多い。5 秒維持で stale 問題を起こさない。
- 30 秒 cap は stale lease safety のため。ユーザーが 30 秒以上考え込むケースでは `desktop_see` を取り直す方が安全。
- entity 数 bonus は「大きい応答ほど読むのに時間がかかる」前提の線形補正。20 までは penalty なし（action の default max）。

### 2.4. 拡張余地（将来バッチ用メモ）

policy 関数は input object 方式で `payloadBytes` / `operatorMode` を後から追加可能にする。今回は実装しない。

```ts
export interface LeaseTtlInput {
  view: "action" | "explore" | "debug" | undefined;
  entityCount: number;
  // --- 将来拡張（今回は未使用） ---
  payloadBytes?: number;
  operatorMode?: boolean;
}
```

---

## 3. stale lease safety の維持方法

TTL を伸ばしても、次は **一切変更しない**。

| 拒否経路 | 維持状態 |
|---|---|
| `expired` (TTL 超過) | そのまま。cap=30s なので「永遠に通る lease」にはならない |
| `generation_mismatch` | そのまま。`see()` が generation を bump する contract は無変更 |
| `entity_not_found` | そのまま |
| `digest_mismatch` | そのまま |
| touch-side grace | **入れない**（instructions 禁則事項） |
| auto-refresh | **入れない**（instructions 禁則事項） |

### 3.1. TOCTOU は無変更

`guarded-touch.ts` は触らない。validate → execute の同一 snapshot 契約は維持。

### 3.2. generation bump 時は TTL 関係なく即失効

`see()` が走れば generation が変わる → 古い lease は expired より先に `generation_mismatch` で落ちる。TTL 延長はこの安全機構と直交。

### 3.3. 既存テストで回帰確認

- `guarded-touch.test.ts` の「rejects expired lease」「rejects lease with generation mismatch」「rejects lease when evidenceDigest has changed」「rejects lease when entity no longer exists」は一切変更しない。これら全て通ることを `npm run build && npx vitest` で確認する。

---

## 4. 追加/更新するテストケース

### 4.1. 新規: `tests/unit/lease-ttl-policy.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { computeLeaseTtlMs, LEASE_TTL_POLICY } from "../../src/engine/world-graph/lease-ttl-policy.js";

describe("computeLeaseTtlMs — view dimension", () => {
  it("action view has no bonus (base 5000ms)", () => {
    expect(computeLeaseTtlMs({ view: "action", entityCount: 5 })).toBe(5_000);
  });

  it("undefined view defaults to action", () => {
    expect(computeLeaseTtlMs({ view: undefined, entityCount: 5 })).toBe(5_000);
  });

  it("explore view adds 5000ms bonus", () => {
    expect(computeLeaseTtlMs({ view: "explore", entityCount: 5 })).toBe(10_000);
  });

  it("debug view adds 10000ms bonus", () => {
    expect(computeLeaseTtlMs({ view: "debug", entityCount: 5 })).toBe(15_000);
  });

  it("explore TTL is strictly greater than action TTL for same entityCount", () => {
    const a = computeLeaseTtlMs({ view: "action", entityCount: 30 });
    const e = computeLeaseTtlMs({ view: "explore", entityCount: 30 });
    expect(e).toBeGreaterThan(a);
  });
});

describe("computeLeaseTtlMs — entity count dimension", () => {
  it("entityCount <= 20 yields no bonus", () => {
    expect(computeLeaseTtlMs({ view: "action", entityCount: 0 })).toBe(5_000);
    expect(computeLeaseTtlMs({ view: "action", entityCount: 20 })).toBe(5_000);
  });

  it("each entity above 20 adds 100ms", () => {
    // action(base 5000) + (40 - 20) * 100 = 7000
    expect(computeLeaseTtlMs({ view: "action", entityCount: 40 })).toBe(7_000);
    // explore(base 10000) + (50 - 20) * 100 = 13000
    expect(computeLeaseTtlMs({ view: "explore", entityCount: 50 })).toBe(13_000);
  });

  it("bonus is monotonically non-decreasing in entityCount (same view)", () => {
    let prev = -1;
    for (let n = 0; n <= 100; n += 5) {
      const ttl = computeLeaseTtlMs({ view: "explore", entityCount: n });
      expect(ttl).toBeGreaterThanOrEqual(prev);
      prev = ttl;
    }
  });
});

describe("computeLeaseTtlMs — clamping", () => {
  it("clamps to cap (30000ms) even for extreme inputs", () => {
    expect(computeLeaseTtlMs({ view: "explore", entityCount: 10_000 })).toBe(30_000);
    expect(computeLeaseTtlMs({ view: "debug",   entityCount: 10_000 })).toBe(30_000);
  });

  it("floor (2000ms) is respected if future config yields tiny values", () => {
    // Defensive: ensures floor is applied. Current policy never goes below 5000 naturally.
    const minTtl = computeLeaseTtlMs({ view: "action", entityCount: 0 });
    expect(minTtl).toBeGreaterThanOrEqual(LEASE_TTL_POLICY.floor);
  });
});

describe("computeLeaseTtlMs — invariants", () => {
  it("never returns a non-finite or negative number", () => {
    for (const view of ["action", "explore", "debug", undefined] as const) {
      for (const n of [0, 1, 20, 50, 100, 500]) {
        const t = computeLeaseTtlMs({ view, entityCount: n });
        expect(Number.isFinite(t)).toBe(true);
        expect(t).toBeGreaterThan(0);
      }
    }
  });
});
```

### 4.2. 追加: `tests/unit/desktop-facade.test.ts` 内に新 describe ブロック

```ts
describe("DesktopFacade — response-size aware lease TTL (H1)", () => {
  it("explore view issues longer TTL than action view for same entity set", async () => {
    const manyProvider: CandidateProvider = () =>
      Array.from({ length: 30 }, (_, i) => cand(`Item ${i}`, "uia", { digest: `d${i}` }));
    const facade = new DesktopFacade(manyProvider, { nowFn: () => 0 });

    const viewAction  = await facade.see({ view: "action" });
    const viewExplore = await facade.see({ view: "explore" });

    const expiryAction  = viewAction.entities[0].lease.expiresAtMs;
    const expiryExplore = viewExplore.entities[0].lease.expiresAtMs;

    expect(expiryExplore).toBeGreaterThan(expiryAction);
  });

  it("action view with few entities keeps TTL near base (5s)", async () => {
    const facade = new DesktopFacade(gameProvider, { nowFn: () => 0 });
    const view = await facade.see({ view: "action" });
    expect(view.entities[0].lease.expiresAtMs).toBe(5_000);
  });

  it("explore view with 50 entities adds meaningful TTL bonus", async () => {
    const manyProvider: CandidateProvider = () =>
      Array.from({ length: 60 }, (_, i) => cand(`Item ${i}`, "uia", { digest: `d${i}` }));
    const facade = new DesktopFacade(manyProvider, { nowFn: () => 0 });
    const view = await facade.see({ view: "explore" }); // 50 entities after maxEntities slice
    // 5000 base + 5000 explore + (50-20)*100 = 13000
    expect(view.entities[0].lease.expiresAtMs).toBe(13_000);
  });

  it("stale lease safety: TTL extension does NOT bypass generation_mismatch", async () => {
    const facade = new DesktopFacade(gameProvider, { nowFn: () => 0 });
    const view1 = await facade.see({ view: "explore" }); // longer TTL
    const oldLease = view1.entities[0].lease;
    await facade.see({ view: "explore" }); // bumps generation
    const result = await facade.touch({ lease: oldLease });
    expect(result.ok).toBe(false);
    // evicted from viewId index → entity_not_found (same as pre-H1 behavior)
    if (!result.ok) expect(result.reason).toBe("entity_not_found");
  });

  it("stale lease safety: expired lease still rejected past cap (30s)", async () => {
    let now = 0;
    const manyProvider: CandidateProvider = () =>
      Array.from({ length: 80 }, (_, i) => cand(`Item ${i}`, "uia", { digest: `d${i}` }));
    const facade = new DesktopFacade(manyProvider, { nowFn: () => now });
    const view = await facade.see({ view: "explore" });
    const lease = view.entities[0].lease;
    // TTL clamped to 30000; push past cap
    now = 40_000;
    const result = await facade.touch({ lease });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("lease_expired");
  });
});
```

### 4.3. 既存テスト: 変更しない

`guarded-touch.test.ts` は `defaultTtlMs` を明示指定しているので、新 policy の影響を受けない。そのまま通る。`desktop-facade.test.ts` の既存「touch with expired lease」は `defaultTtlMs: 1000` を明示している → 後方互換が必要（後述 §5.2）。

---

## 5. 実装手順

### 5.1. Step 1: 新規ファイル `src/engine/world-graph/lease-ttl-policy.ts`

```ts
/**
 * Lease TTL policy for Anti-Fukuwarai v2 (H1 hardening).
 *
 * Why this exists:
 *   Fixed 5s TTL is too short for `view=explore` or large responses because
 *   LLM read + reason + next-tool-call latency commonly exceeds 5s. Dogfood
 *   scenarios S1 (browser-form) and S3 (terminal) hit `lease_expired` there.
 *
 * Policy:
 *   ttlMs = clamp(base + viewBonus + entityBonus, floor, cap)
 *     base        = 5_000
 *     viewBonus   = action:0 / explore:+5_000 / debug:+10_000
 *     entityBonus = max(0, entityCount - 20) * 100
 *     floor       = 2_000  (defensive; never reached by current policy)
 *     cap         = 30_000 (stale-lease safety: LLMs that think >30s must see() again)
 *
 * Safety contract (unchanged by this policy):
 *   - generation_mismatch, digest_mismatch, entity_not_found are independent of TTL
 *   - TTL only controls the `expired` reason path
 *   - Cap ensures no lease lives unreasonably long
 *
 * Not in scope (future batches):
 *   - payload-size-aware TTL (when size metrics are available)
 *   - operator-mode (debug-session) extension
 *   - touch-side grace / auto-refresh (explicitly forbidden by instructions)
 */

export const LEASE_TTL_POLICY = {
  baseMs:             5_000,
  floor:              2_000,
  cap:                30_000,
  viewBonus: {
    action:  0,
    explore: 5_000,
    debug:   10_000,
  } as const,
  entityBonusThreshold: 20,
  entityBonusPerUnit:   100,
} as const;

export interface LeaseTtlInput {
  /** view mode from desktop_see. Undefined = "action" (default). */
  view: "action" | "explore" | "debug" | undefined;
  /** Number of entities issued in this view. */
  entityCount: number;
  // Reserved for future batches; not used today.
  // payloadBytes?: number;
  // operatorMode?: boolean;
}

function viewBonus(view: LeaseTtlInput["view"]): number {
  switch (view) {
    case "explore": return LEASE_TTL_POLICY.viewBonus.explore;
    case "debug":   return LEASE_TTL_POLICY.viewBonus.debug;
    case "action":
    case undefined:
    default:        return LEASE_TTL_POLICY.viewBonus.action;
  }
}

function entityBonus(count: number): number {
  const over = Math.max(0, count - LEASE_TTL_POLICY.entityBonusThreshold);
  return over * LEASE_TTL_POLICY.entityBonusPerUnit;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Compute the lease TTL (ms) for a given see() response shape.
 *
 * Deterministic and side-effect free — safe to call from any layer.
 */
export function computeLeaseTtlMs(input: LeaseTtlInput): number {
  const raw = LEASE_TTL_POLICY.baseMs + viewBonus(input.view) + entityBonus(input.entityCount);
  return clamp(raw, LEASE_TTL_POLICY.floor, LEASE_TTL_POLICY.cap);
}
```

### 5.2. Step 2: `src/tools/desktop.ts` を編集

`see()` の lease 発行箇所を policy 駆動にする。`defaultTtlMs` の後方互換は維持（明示指定があれば override）。

```ts
// desktop.ts の先頭 import 群に追加
import { computeLeaseTtlMs } from "../engine/world-graph/lease-ttl-policy.js";
```

`see()` 内、現状:

```ts
const entityViews: EntityView[] = resolved.map((e) => {
  const lease = session.leaseStore.issue(e, newViewId);
  ...
});
```

を次に置き換え:

```ts
// H1: response-size aware TTL (ignored when facade.defaultTtlMs explicitly set).
const policyTtl = this.opts.defaultTtlMs !== undefined
  ? this.opts.defaultTtlMs
  : computeLeaseTtlMs({
      view: input.view,
      entityCount: resolved.length,
    });

const entityViews: EntityView[] = resolved.map((e) => {
  const lease = session.leaseStore.issue(e, newViewId, policyTtl);
  const view: EntityView = {
    entityId: e.entityId,
    label: e.label,
    role: e.role,
    confidence: e.confidence,
    sources: [...e.sources],
    primaryAction: primaryActionFrom(e),
    lease,
  };
  if (input.debug) view.rect = e.rect;
  return view;
});
```

後方互換のポイント:
- facade constructor で `defaultTtlMs: 1000` を指定している既存テスト（`desktop-facade.test.ts` の "touch with expired lease"）は引き続き 1000 ms で動作する。
- production（`desktop-register.ts`）は `defaultTtlMs` を指定していない → policy 適用。

### 5.3. Step 3: `lease-store.ts` のコメント更新

実装変更は不要（`issue(entity, viewId, ttlMs)` は既に ttlMs オプション対応済み）。ただしコメントに policy 参照を追加:

```ts
// lease-store.ts 冒頭
import type { UiEntity, EntityLease, LeaseValidationResult } from "./types.js";

/**
 * Default TTL used when the caller does not pass `ttlMs` to issue().
 *
 * For production see() calls, the TTL is chosen by lease-ttl-policy.ts based
 * on `view` and entity count (H1 hardening). This default only applies to:
 *   - tests that construct LeaseStore directly
 *   - legacy callers that bypass the facade policy
 *
 * Safety: `cap` in lease-ttl-policy.ts bounds production TTLs so stale leases
 * cannot live indefinitely regardless of policy inputs.
 */
const DEFAULT_TTL_MS = 5_000;
```

### 5.4. Step 4: テスト追加

1. `tests/unit/lease-ttl-policy.test.ts` を新規作成（§4.1）
2. `tests/unit/desktop-facade.test.ts` に新 describe ブロックを追加（§4.2）
3. `npm run build` で型エラーが無いか確認
4. `npx vitest run tests/unit/lease-ttl-policy.test.ts tests/unit/desktop-facade.test.ts tests/unit/guarded-touch.test.ts tests/unit/desktop-providers.test.ts` で関連 test pass 確認

### 5.5. Step 5: docs 最小更新（optional、commit とは分離可）

- `docs/anti-fukuwarai-v2-hardening-backlog.md` の H1 セクションに「完了: YYYY-MM-DD, see h1-lease-ttl-plan.md」の一行を足す（実装完了後）
- `docs/anti-fukuwarai-v2-dogfood-log.md` の「Dogfood で見えた改善候補 § 1」に hardening commit の参照を足す

これは主目的ではないので、実装完了後の短い memo で良い。

### 5.6. Step 6: 検証

```bash
npm run build
npx vitest run tests/unit/lease-ttl-policy.test.ts tests/unit/desktop-facade.test.ts tests/unit/desktop-providers.test.ts tests/unit/guarded-touch.test.ts
```

全 pass で完了。

### 5.7. Step 7: Opus レビュー（強制命令 3）

完了報告前に Opus レビュー：
- Policy 数値が過度に緩くないか
- stale lease safety が壊れていないか
- テストが意図を表現しているか

### 5.8. Step 8: commit（release 作業は行わない）

```
feat(facade): make desktop touch leases aware of large explore responses

- Introduce lease-ttl-policy.ts with response-size aware TTL computation
- base 5s + view bonus (explore:+5s, debug:+10s) + entity bonus (>20: +100ms/ea)
- Cap 30s preserves stale-lease safety; generation/digest checks unchanged
- Add unit tests for policy boundaries and facade regression tests for S1/S3 shapes
- Preserve backward compat: explicit defaultTtlMs overrides policy (tests)

Refs: docs/anti-fukuwarai-v2-h1-lease-ttl-plan.md
Dogfood incidents addressed: L-1, L-2, L-3
```

---

## 6. 注意事項・落とし穴

### 6.1. 既存 test の後方互換

`desktop-facade.test.ts` 内「touch with expired lease returns ok:false reason:lease_expired」は `defaultTtlMs: 1000` を明示指定。この test を壊さないため、policy は **`opts.defaultTtlMs` が未指定のときだけ** 適用する。

### 6.2. `explore` 以外のリクエストで entity 数が大きい場合

`action` view でも `maxEntities: 100` を指定すれば entity bonus が効く。これは意図通り（size-aware なので view より count が支配的になるのは OK）。

### 6.3. `session.leaseStore` の constructor TTL

`session-registry.ts` で `new LeaseStore({ defaultTtlMs: opts.defaultTtlMs, nowFn: opts.nowFn })` している。`opts.defaultTtlMs` が undefined なら LeaseStore 側の DEFAULT_TTL_MS (5000) が使われる。**`issue(entity, viewId, ttlMs)` の第 3 引数で policy 由来 ttlMs を毎回渡すので、LeaseStore の default は本質的に使われない**（`desktop.ts` の呼び出しで必ず明示される）。念のため lease-store.ts のコメントで「default は fallback」と明記する。

### 6.4. `input.view` と実際の entity 数の整合性

`desktop_see` は view によって default `maxEntities` を変える（action=20, explore=50）。policy への入力は `resolved.length`（slice 後）で良い → ユーザーが `maxEntities: 200` を明示した場合でも現実のレスポンスサイズに連動する。

### 6.5. `view=debug` は operator 用だが、通常 debug session は長い

debug view は rect 情報を含む → operator が手で検証する。10 秒 bonus は適切な長さ。cap 30 秒で暴走防止。

### 6.6. TTL 変更は既存 dogfood incident 以外の回帰を生まないか

- `lease_generation_mismatch` → TTL 無関係。`see()` 呼び直しで bump されるため、TTL 延長は generation 侵害を広げない。
- `entity_not_found` → viewId index 経由、TTL 無関係。
- `digest_mismatch` → evidenceDigest は entity の内容依存、TTL 無関係。
- `modal_blocking` / `entity_outside_viewport` / `executor_failed` → TTL 経路と独立。

全ての fail reason について「TTL を延ばしたから通ってしまう」経路は存在しない。

### 6.7. Policy 関数の純粋性

`computeLeaseTtlMs` は入力に時刻を持たない（副作用なし）。テストは時刻注入不要で安定。

### 6.8. Future-proofing

`LeaseTtlInput` を object にしたので、後続の H4/H2/H3 で `payloadBytes` や `operatorMode` が必要になったときに signature 破壊なく足せる。

### 6.9. やらないこと（再掲）

- TTL を一律大幅延長（cap 30s 以上にするなど） — NG
- touch-side grace period — NG
- automatic lease refresh — NG
- `desktop_see` / `desktop_touch` API redesign — NG
- `guarded-touch.ts` / `types.ts` / `resolver.ts` の編集 — 不要
- release / npm version / tag / publish — NG（instructions §9）
- V1 tool の削除 — NG

---

## 7. 期待する到達点（チェックリスト）

- [ ] `src/engine/world-graph/lease-ttl-policy.ts` 作成
- [ ] `src/tools/desktop.ts` が policy を適用
- [ ] `src/engine/world-graph/lease-store.ts` コメント更新
- [ ] `tests/unit/lease-ttl-policy.test.ts` 追加（全 pass）
- [ ] `tests/unit/desktop-facade.test.ts` に H1 describe 追加（全 pass）
- [ ] `guarded-touch.test.ts` 既存テスト全 pass（stale lease safety 回帰なし）
- [ ] `npm run build` pass
- [ ] `view=action` は 5s 維持
- [ ] `view=explore` 50 entities で 13s
- [ ] cap 30s で頭打ち
- [ ] generation / digest / viewId index による拒否は TTL に依存せず機能
- [ ] Opus レビューで指摘ゼロ
- [ ] docs 最小更新
- [ ] commit 作成（release 作業は一切しない）

---

## 8. 完了時の docs 更新候補

実装完了後、次を最小限で更新する:

- `docs/anti-fukuwarai-v2-hardening-backlog.md` § H1 に完了 memo（1-2 行）
- `docs/anti-fukuwarai-v2-dogfood-log.md` § Dogfood で見えた改善候補 1 に commit hash 参照
- `docs/Anti-Fukuwarai-V2.md` § 9 関連ドキュメント末尾に `anti-fukuwarai-v2-h1-lease-ttl-plan.md` の参照を足す（任意）

これらは implementation commit とは別 commit で行って良い。
