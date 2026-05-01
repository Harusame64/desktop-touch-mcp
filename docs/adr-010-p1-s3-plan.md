# ADR-010 P1 — walking skeleton S3 / G3 alignment (envelope minimal wrapper + compat mode)

- Status: **Drafted (2026-05-01)**
- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.4) §4 **S3** (line 211-231) + §5 **G3 ゲート** (line 343) の最小実装。本 sub-plan は trunk S3 PR の scope を確定する
- Trigger: ADR-008 D2-C S2 impl PR #108 merged 2026-05-01 (`7986838`) + post-merge follow-up PR #109 merged で walking skeleton trunk S2 完了、次 phase = S3 着手可
- 親 plan: `docs/walking-skeleton-trunk-selection.md` §4 S3 (line 211-231) + §6.1 expansion swimlanes + ADR-010 §7 Implementation Phases (P1) + 統合書 §11.2 (compat mode)
- 概念設計: `docs/adr-010-presentation-layer-self-documenting-envelope.md` §5 (envelope schema) + §5.6 (size SLO) + §10 P1 acceptance
- 対象 sub-batch: walking skeleton **S3 (PR 1)** — `_envelope.ts` skeleton + **compat mode** (raw shape default、env / include flag で opt-in envelope) + `desktop_state` のみ実適用 + envelope size SLO bench harness
- 後続: S4 (= `desktop_discover/act` commit 軸 wrapper + lease 4-tuple validation) は **本 S3 merged が前提条件**、既存 envelope skeleton を commit-side にも適用

---

## 0. walking skeleton S3 位置付け note

本 sub-plan は walking skeleton trunk (`docs/walking-skeleton-trunk-selection.md` Proposed v0.4) の **S3 sub-batch**。trunk 選定で「contract spike として最小実装」方針が確定済 (§3.2)。S1 (D2-E0、PR #105) → S2 (D2-C、PR #108) で **L3 view 経路** が確立済、S3 は **L4/L5 envelope 経路の skeleton** を起こし、S4-S6 で commit/causal_by を載せていく base となる:

- S1 (PR-η D2-E0 完了): dataflow scope refactor — `build_*(scope, stream) -> (Arranged, View)` signature 統一
- S2 (PR-ε D2-C 完了): count-only `dirty_rects_aggregate` を S1 の同 scope に追加
- **S3 (★ 本 PR)**: envelope minimal wrapper + compat mode + `desktop_state` 実適用 + size SLO bench
- S4 (PR-?): `desktop_discover/act` commit 軸 wrapper + lease 4-tuple validation
- S5 (PR-? 最重要): `caused_by` linkage cross-layer (★ trunk 最重要 contract)
- S6 (PR-?): trunk 完了判定 + CI assert 化 + expansion plan 起草

S3 は **TypeScript-dominant PR** (engine-perception Rust 改修ほぼなし、小さな napi getter 追加検討あり)。production code 改修だが scope が L5 wrapper + 1 tool に局限され、Rust 慎重コストは低い。Walking skeleton §4.1 line 304 の通り **Codex re-review は skip 可** (Opus 1 round で十分、ただし phase 境界 plan PR は推奨)。

**G3 ゲートの目標** (`docs/walking-skeleton-trunk-selection.md` §4 S3 完了基準 line 223-228):

| # | walking-skeleton §4 S3 目標 | 本 sub-plan 検証手段 |
|---|---|---|
| 1 | 既存 LLM session で `desktop_state` 回帰 0 (raw shape 期待 e2e test 無修正で pass) | §3.5 既存 vitest unit + e2e tests を **compat mode default** で回す、無修正 pass |
| 2 | envelope skeleton のサイズ < 1KB (ADR-010 §5.6.1) | §3.6 envelope size bench harness で計測、CI で 5% warning / 20% fail (ADR-010 §5.6.2) |
| 3 | `_version: "1.0"` stamp | §3.3 `_envelope.ts` の skeleton 関数で固定 stamp |
| 4 | `confidence` が `fresh` / `degraded` の 2 値で観測される integration test | §3.5 `confidence` field に対する pin test 追加 (size 超過で degraded、通常 fresh) |
| 5 | envelope size SLO の CI bench harness が main で動く | §3.6 `benches/l4_envelope_size.mjs` 新設、CI 統合は §3.7 |
| 6 | **G3 ゲート判定**: commit wrapper と既存 ToolCallStarted/Completed event payload 確定が `desktop_discover/act` の挙動を壊していない、`LeaseExpired` typed reason が 1 path 動作 | (※ G3 は S4 完了時、本 PR scope 外。S3 完了時は G3 判定材料を S4 に持ち越す形) |

**review 観点の再定義**: 本 PR は「envelope の完成度」ではなく **「S3/G3 contract が最短で検証できるか + S4 commit 軸 wrapper で mechanical コピーで進められる base が固まっているか」** で評価する。`caused_by` / `if_unexpected` / `query_past` 等の他フィールドは S4-S5 で追加、本 S3 では skeleton のみ。

---

## 1. Scope (trunk / expansion / carry-over の 3 分類)

### 1.1 [S3 trunk] 本 sub-plan で扱う (G3 contract 必須)

A. **`src/tools/_envelope.ts` 新設** — `wrapEnvelope(rawData, options)` skeleton 関数 + `_version: "1.0"` 固定 stamp + `as_of.wallclock_ms` + `confidence: "fresh" | "degraded"` 2 値分岐
B. **compat mode 必須** (統合書 §11.2、walking-skeleton §4 S3 line 217-218): default で **raw shape** を維持 (`data` field を top-level に hoist)、opt-in flag (env `DESKTOP_TOUCH_ENVELOPE=1` or include 引数 `["envelope"]` のいずれか) で envelope shape 要求 → 既存 LLM client (Claude CLI 等 raw shape 期待) を破壊しないことが必須条件
C. **`src/tools/desktop-state.ts` を envelope 経由に置換** (skeleton のみ、`caused_by` / `if_unexpected` / `query_past` は S4/S5 で carry-over) — 既存 `_post.ts::withPostState` wrapper の **後段** に envelope wrap layer を挿入、`post` block と envelope 共存 (詳細 §2.4)
D. **`as_of.wallclock_ms` の source 確定** — trunk skeleton では `Date.now()` approximation (server 側観測時刻) を採用、accurate L1 event wallclock は **carry-over** (§1.3 OQ #1)
E. **`confidence` 2 値判定** — `fresh` default、size 超過時 / view poisoned 時 / `view_focused_pipeline_status.poisoned == true` 時 `degraded` 降格 (`if_unexpected.most_likely_cause: "EnvelopeSizeExceeded"` は本 trunk 段階では typed enum を**含めず**、text-only marker で carry-over)
F. **envelope size SLO bench harness 新設** — `benches/l4_envelope_size.mjs` (Node bench、既存 `benches/d1_ts_baseline.mjs` 同型 pattern) + bench で `desktop_state` の minimal/degraded 両 envelope size を計測、CI で前回 main から 5% 増 warning / 20% 増 fail (ADR-010 §5.6.2、G3 #2 必須)
G. **G3 ゲート判定 + Appendix C append** — `docs/walking-skeleton-trunk-selection.md` Appendix C 末尾に `| G3 | 2026-05-XX | (継続/shrink) | (...) | (...) |` を append (本 sub-plan §3.6、impl PR merge 後に実施、ledger 永続化、§3.6 D2-E0-6 と同 pattern)

### 1.2 [expansion] G3 通過後の expansion phase で実装 (本 PR scope 外)

trunk 完了 (G3 通過) 後の expansion phase で実装、本 PR では scope 外として明示:

- **全 tool への envelope rollout**: 本 trunk では `desktop_state` 1 tool のみ。残 ~25 tool (`click_element` / `mouse_click` / `keyboard` / `screenshot` 等) への envelope wrap rollout は L5 swimlane で worktree 並走 (`docs/walking-skeleton-trunk-selection.md` §6.1 line 363)
- **accurate `as_of.wallclock_ms`** (L1 event 由来): napi getter 追加 (`view_get_latest_focus_wallclock() -> Option<u64>` 等) or 既存 `view_focused_pipeline_status` 拡張で view が観測した最新 L1 event の wallclock を expose、Date.now() approximation を置換 (§1.3 OQ #1)
- **`confidence` 残 3 値**: `cached` / `inferred` / `stale` 判定ロジック (cache hit detection / view freshness threshold / time-since-last-event 等)、ADR-010 §17.6.1 値域 SSOT を完全実装
- **envelope `if_unexpected.most_likely_cause` typed enum 化**: ADR-010 §5.4 の 37 typed reason codes 全網羅、`_errors.ts::SUGGESTS` を typed `try_next: TypedAction[]` に進化させる (P2 work、ADR-010 §10 P2 acceptance)
- **`include` 引数 routing**: ADR-010 §5.2 の `causal` / `invariants` / `time_travel` / `working:N` / `episodic:N` の各 include 値の routing 実装 (P3-P6 work)
- **subscribe API envelope**: ADR-008 D2 subscribe 系 tool への envelope 適用 (`docs/adr-010-presentation-layer-self-documenting-envelope.md` §11 OQ #7)

### 1.3 [carry-over] §3.bis ledger / OQ で永続化 (別 phase)

- **OQ #1 — accurate `as_of.wallclock_ms` source**: 本 trunk では Date.now() approximation。S4 commit 軸 wrapper で `caused_by.elapsed_ms` 計測時に同様に L1 event wallclock が必要になる (`ToolCallStarted`/`Completed` の wallclock 比較)、その時点で source を確定して両者を統合実装するのが合理的。本 sub-plan §8 OQ #1 で carry-over
- **OQ #2 — `_post.ts` (existing) と `_envelope.ts` (new) の役割境界**: 統合書 §5.6.2 + walking-skeleton §7 OQ #7 で「`_post.ts` perception envelope + history ring buffer と新 `_envelope.ts` の役割重複 / 機能 fragmentation」が **Phase 境界 OQ** として明示、本 sub-plan §8 OQ #2 で carry-over (S6 で finalize)
- **OQ #3 — compat mode opt-in source**: env / include 引数 / 両方 — 本 sub-plan §2.2 で **両方サポート** に確定 (env で server 全体 default 切替、include で per-call 上書き)、両方の優先順位 (include > env) も §2.2 で明示
- **既存 LLM client 破壊禁止 (CLAUDE.md §3.2 PR #102 教訓延長)**: compat mode が default raw shape を維持することで担保、既存 e2e test 無修正 pass を §3.5 で pin

### 1.4 北極星整合 + walking skeleton G3 contract

- **N1 (pivot 必ず保持)**: envelope の `as_of.wallclock_ms` + 後続 S5 で `caused_by.based_on.events: [event_id]` が L1 event_id pivot を carry — 本 trunk では `as_of` のみで N1 partial 充足
- **N2 (watermark で frontier 進行)**: envelope は read-only projection、worker frontier 進行に影響しない (impact なし)
- **CLAUDE.md 強制命令 3.1 (ADR/plan 複数表 fact 整合)**: 本 PR では sub-plan / 親戦略 walking-skeleton §4 S3 / ADR-010 §5 / 統合書 §11.2 / 既存 `_post.ts` の 4 SSOT を bit-equal に揃える
- **CLAUDE.md 強制命令 3.2 (carry-over scope shrink、PR #102 教訓)**: compat mode 必須 — **既存 raw shape を default で維持** することは「既存 public API の正しい振る舞いを破壊しない」軸の最重要適用例、PR #102 教訓を envelope 化に拡張
- **walking skeleton G3 contract**: S4 で `desktop_discover/act` の commit-side response も同じ envelope skeleton を **mechanical コピー** で wrap できる base が固まること。本 PR の `wrapEnvelope` 関数 + compat mode が S4 着手時の template として機能する

---

## 2. 設計判断

### 2.1 `_envelope.ts` 新 API

#### [S3 trunk] skeleton 関数

```typescript
// src/tools/_envelope.ts

export interface EnvelopeOptions {
  /** Per-call opt-in to envelope shape. Overrides env-default. */
  envelopeOptIn?: boolean;
  /** Pre-computed view freshness signal (from caller, optional). */
  viewPoisoned?: boolean;
}

export interface EnvelopeMinimalShape<T = unknown> {
  /** Schema version (ADR-010 §5、`_version: "1.0"` for P1). */
  _version: "1.0";
  /** Tool-specific result (raw shape that the tool would return pre-envelope). */
  data: T;
  /** Self-attestation: when the data was observed.
   *  S3 trunk: `Date.now()` approximation (server-side, OQ #1 carry-over
   *  for accurate L1 event wallclock). */
  as_of: { wallclock_ms: number };
  /** Confidence: `fresh` (default) / `degraded` (size-over OR view-poisoned).
   *  S3 trunk: 2-value subset; `cached` / `inferred` / `stale` lands in expansion. */
  confidence: "fresh" | "degraded";
}

/**
 * Wrap a tool's raw result in envelope shape iff envelope is opted in
 * (per-call `envelopeOptIn` arg OR env `DESKTOP_TOUCH_ENVELOPE=1`),
 * else return the raw shape unchanged (compat mode default).
 *
 * **G3 contract** (sub-plan §0): existing LLM clients expecting raw
 * shape MUST observe no behavioural difference when envelope is
 * not requested. Per-call `envelopeOptIn=true` overrides the env
 * setting, so test fixtures can pin both modes deterministically.
 */
export function wrapEnvelope<T>(
  data: T,
  options?: EnvelopeOptions,
): T | EnvelopeMinimalShape<T>;

/**
 * Compute estimated payload size of an envelope (or raw shape).
 * Used by the size SLO bench harness + the `confidence: degraded`
 * downgrade trigger when envelope size exceeds the per-Phase
 * threshold (ADR-010 §5.6.1).
 */
export function envelopePayloadSizeBytes(payload: unknown): number;

/**
 * Minimal-envelope size threshold (ADR-010 §5.6.1: `< 1KB` for P1).
 * Exceeding this triggers `confidence: degraded` downgrade in
 * `wrapEnvelope`.
 */
export const ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES: number;
```

### 2.2 compat mode opt-in 詳細 (OQ #3 確定)

Default behavior: **raw shape** (no envelope). Opt-in via either:

- **env**: `DESKTOP_TOUCH_ENVELOPE=1` set at server start → server-wide default to envelope shape for all envelope-aware tools
- **per-call include argument**: `desktop_state(include=["envelope"])` → forces envelope on for that call only
- **per-call override**: `desktop_state(include=["raw"])` → forces raw on for that call only (override env if envelope is server-default)

**Priority order** (highest to lowest):
1. Per-call `include=["raw"]` (explicit raw request) → raw
2. Per-call `include=["envelope"]` → envelope
3. env `DESKTOP_TOUCH_ENVELOPE=1` → envelope
4. Default → raw (compat mode、既存 LLM client 互換)

The `include` arg is a TS array passed via the MCP tool's normal args (Zod schema에 string[] field 追加)。env is parsed once at server startup. `wrapEnvelope` resolves the priority chain based on `EnvelopeOptions.envelopeOptIn`.

### 2.3 `desktop_state` での適用 (skeleton のみ)

#### [S3 trunk] desktopStateHandler 内変更点

既存 `desktopStateHandler` は `withPostState(...)` wrapper で `post` block を埋め込む shape。本 PR では **`withPostState` の後段** に envelope wrap layer を挿入:

```typescript
// 概念 pseudo code
async function desktopStateHandler(args: DesktopStateArgs): Promise<ToolResult> {
  const raw = await /* existing logic */;
  // S3: post-state injection (existing _post.ts wrapper)
  const withPost = await wrapWithPostState(raw, ...);
  // S3 NEW: envelope wrap (compat mode aware)
  const envelopeOptIn = resolveEnvelopeOptIn(args.include);
  const finalResult = wrapEnvelope(withPost, { envelopeOptIn, viewPoisoned: ... });
  return finalResult;
}
```

`post` block (from `_post.ts`) は **`data` field の中** に埋め込まれた状態で envelope に wrap される (envelope の `data` = withPost、内部に `post` 含む)。

#### [carry-over] 既存 `_post.ts` との role boundary (OQ #2)

OQ #2 (sub-plan §8) で「`_post.ts` perception envelope と新 `_envelope.ts` の責務分担」を S6 で finalize。本 trunk では:
- `_post.ts`: 既存 `post` block (focusedWindow / focusedElement / windowChanged / elapsedMs / rich / perception) の埋め込み + history ring buffer 維持
- `_envelope.ts`: 本 trunk で新規、ADR-010 envelope skeleton (`_version` / `data` / `as_of` / `confidence`) を `withPostState` の **後段** に wrap

両 layer 共存 = `data` 内 `post` block + envelope outer の二重構造。S6 で:
- (a) 統合: `_post.ts` を `_envelope.ts` の `caused_by` 系セクションに移行 (ADR-010 §5.2 `caused_by.your_last_action` / `produced_changes`)
- (b) 共存維持: post block を ADR-010 envelope の **L4 narration extension** として独立 layer 維持

判断は S6 で確定 (本 sub-plan §8 OQ #2 で永続化)。

### 2.4 `as_of.wallclock_ms` source (Date.now() approximation、OQ #1)

walking-skeleton §4 S3 line 219 は「L1 ring の最新 event を読む (既存 `view_get_focused` が wallclock を持つ前提、なければ S1 で view 戻り値に追加)」と記載。

S1 で view return 値に wallclock 追加は実施せず (PR #105 では touch していない)、本 S3 trunk では **Date.now() approximation** を採用:

- **trunk shape**: `as_of.wallclock_ms = Date.now()` (server 側の wrapEnvelope 呼出時刻)
- **trade-off**: server observation time vs L1 event time のズレ (UIA event arrival → focus_pump → view materialise → handler → wrapEnvelope の latency 分、production 観測で ~5-50ms typically)
- **expansion で改善** (carry-over OQ #1): napi getter 追加 (`view_get_focused_with_wallclock() -> { focused: NativeFocusedElement | null, latest_event_wallclock_ms: u64 | null }` 等) で view の最新 L1 event wallclock を expose、`Date.now()` を置換
- **carry-over の正当性**: ADR-010 §5 envelope shape contract は **「`as_of.wallclock_ms: number`」だけが必須**、source の精度は性能 / 信頼性レベルで段階的改善可能 (ADR-010 §5.5 Phase 別構造、本 trunk = P1 = 「envelope 必須最小」spec を満たせば足る)

### 2.5 `confidence` 2 値分岐 (size 超過 + view poisoned 判定)

- **`fresh`** (default): envelope size < `ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES` (= 1024 bytes、ADR-010 §5.6.1) AND view non-poisoned
- **`degraded`**: 上記いずれかの条件 fail
  - size 超過: `JSON.stringify(envelope).length > 1024` (envelope 全体 size 推定)
  - view poisoned: `view_focused_pipeline_status.poisoned === true` (D2-B-1 で expose 済 napi binding)

実装上 `wrapEnvelope` は:
1. envelope skeleton 構築 (`fresh` 仮定で size 推定)
2. size > threshold OR view poisoned → `confidence: "degraded"` 上書き
3. final shape return

`if_unexpected.most_likely_cause: "EnvelopeSizeExceeded"` typed enum stamp は **本 trunk では含まない** (§1.1 E)、ADR-010 §5.4 typed reason 全網羅は P2 expansion。

### 2.6 envelope size SLO bench harness (G3 #2/#5)

- **bench file**: `benches/l4_envelope_size.mjs` (既存 `benches/d1_ts_baseline.mjs` / `benches/d2_desktop_state_roundtrip.mjs` 同型 pattern、Node script)
- **計測対象**: `desktop_state` を 5 シナリオ (前提: server 起動済 + envelope mode opt-in) で呼出、各 envelope の `JSON.stringify().length` 記録:
  1. **Minimal envelope, no events**: 起動直後の envelope size
  2. **Minimal envelope, after 10 focus events**: 通常負荷時 size
  3. **Minimal envelope, after 1 dirty rect event**: dirty rect view も active 時
  4. **Degraded envelope (induced via large `data`)**: confidence: degraded 経路の envelope size
  5. **Raw shape (compat mode default)**: envelope なし (baseline)
- **CI 連携** (G3 #5): `.github/workflows/bench-envelope-size.yml` (新設) で main push 時に実行、前回 main の bench 結果と比較:
  - 5% 増 → warning (`continue-on-error: true` で job fail しないが notification)
  - 20% 増 → fail (PR merge block)
- **結果保存**: `benches/results/l4_envelope_size_*.json` に JSONL 形式で記録、git tracked (CI が自動 commit)

### 2.7 既存 caller への影響範囲

`desktop_state` ツール 1 件のみ touch。他 tool は本 trunk で envelope 化しない (expansion で rollout、§1.2)。`desktop_state` の Zod schema に `include: z.array(z.string()).optional()` を追加 (既に他 tool で同様 field の前例あり) — 既存 LLM client が引数指定しなくても動作 (default: raw shape)。

`_post.ts::withPostState` は無修正で動作。envelope wrap は `withPostState` の **outer** に挿入されるだけで、`post` block は `data` 内に保持。

---

## 3. 実装 sub-batch (本 PR 内、S3 trunk scope)

### 3.1 D2-E0-1 → S3-1: `_envelope.ts` skeleton 関数 (~80 line) [S3 trunk]

- [ ] `src/tools/_envelope.ts` 新設:
  - [ ] `EnvelopeMinimalShape<T>` interface 定義 (§2.1)
  - [ ] `wrapEnvelope<T>(data, options) -> T | EnvelopeMinimalShape<T>` 実装 (compat mode resolve + skeleton 構築 + size 判定 + confidence 2 値)
  - [ ] `envelopePayloadSizeBytes(payload)` helper (`JSON.stringify(payload).length` ベース)
  - [ ] `ENVELOPE_MINIMAL_SIZE_THRESHOLD_BYTES = 1024` const
  - [ ] `resolveEnvelopeOptIn(include?: string[]) -> boolean` helper (priority chain §2.2 実装)
  - [ ] env `DESKTOP_TOUCH_ENVELOPE` parsing (server startup 時 1 回、cached)
- [ ] doc comment に ADR-010 §5 schema reference + walking-skeleton §4 S3 reference 追記

### 3.2 S3-2: `desktop-state.ts` 統合 (~40 line) [S3 trunk]

- [ ] `src/tools/desktop-state.ts`:
  - [ ] Zod schema に `include: z.array(z.string()).optional()` 追加 (前例: 他 tool に既存)
  - [ ] handler 末尾で `wrapEnvelope(withPost, { envelopeOptIn: resolveEnvelopeOptIn(args.include), viewPoisoned: ... })` 呼出
  - [ ] `viewPoisoned` 判定: `await viewFocusedPipelineStatus()` の `poisoned` field 読み取り (既存 napi binding 活用)
  - [ ] include 引数の Zod schema description を ADR-010 §5.2 reference で更新 (`"envelope"` / `"raw"` を opt-in/out として明記、他 値は **本 trunk では reject** (Zod refine で validation、`InvalidArgs` error 返却))

### 3.3 S3-3: `desktop_state` envelope contract test (~80 line) [S3 trunk]

- [ ] `tests/unit/desktop-state-envelope.test.ts` 新設:
  - [ ] **Test G3-1**: default (env unset, no include) → raw shape return、既存 `desktopStateHandler` 戻り値と bit-equal
  - [ ] **Test G3-2**: `include=["envelope"]` → envelope shape 返却、`_version: "1.0"` / `data` / `as_of.wallclock_ms` / `confidence` 4 field 必須
  - [ ] **Test G3-3**: env `DESKTOP_TOUCH_ENVELOPE=1` → envelope shape (per-call include 不要)
  - [ ] **Test G3-4**: `include=["envelope", "raw"]` (両指定) → priority chain で raw 優先 (§2.2)
  - [ ] **Test G3-5**: `include=["unknown_value"]` → `InvalidArgs` error (Zod refine validation)
  - [ ] **Test G3-6**: envelope size > 1024 byte induced → `confidence: "degraded"`
  - [ ] **Test G3-7**: `viewFocusedPipelineStatus.poisoned: true` mock → `confidence: "degraded"`

### 3.4 S3-4: envelope size bench harness (~60 line) [S3 trunk]

- [ ] `benches/l4_envelope_size.mjs` 新設:
  - [ ] 5 シナリオ計測 (§2.6)
  - [ ] 結果を `benches/results/l4_envelope_size_<timestamp>.json` に JSONL 出力
  - [ ] stdout に summary table (シナリオ名 / size bytes / threshold 比 / pass/warn/fail)
- [ ] `package.json` `bench:envelope-size` script 追加 (`node benches/l4_envelope_size.mjs`)

### 3.5 S3-5: 検証 (npm test + bench + size SLO ガード) [S3 trunk]

- [ ] `npm test` (vitest unit): 既存 + 新 G3-1〜G3-7 全 pass
- [ ] `npm run bench:envelope-size`: 全 5 シナリオ計測完了、minimal envelope size < 1024 byte 確認
- [ ] e2e test 既存無修正 pass (compat mode default で raw shape 維持)
- [ ] `npm run check:napi-safe` / `check:native-types` / `check:stub-catalog` / `npm run build`: 全 pass (本 PR は napi/Rust 改修なし、stub-catalog 影響なし、tsc clean)

### 3.6 S3-6: G3 ゲート判定 + Appendix C append (~5 line、impl PR merge 後) [S3 trunk]

- [ ] impl PR merged 後、`docs/walking-skeleton-trunk-selection.md` Appendix C 末尾に判定結果を append:
  ```markdown
  | G3 | 2026-05-XX | 継続 | envelope skeleton (4 必須 field) + compat mode が既存 LLM session 回帰 0 で wrap 可能、`confidence` 2 値分岐 + size SLO bench harness CI 統合済、S4 commit 軸 wrapper で `desktop_discover/act` の response も同 skeleton を mechanical コピーで適用可能。`caused_by` / `if_unexpected` / `query_past` は S4-S5 で carry-over | (なし) |
  ```
- [ ] 判定が「shrink」になった場合は S4 (commit wrapper) の scope を次 sub-plan §1.1 から削る判断を本 sub-plan §6 follow-up に記録

### 3.7 S3-7: CI workflow + Push guard 統合 [S3 trunk]

- [ ] `.github/workflows/bench-envelope-size.yml` 新設 (CI 統合、G3 #5):
  - main push 時 trigger
  - `npm run bench:envelope-size` 実行
  - 前回 main commit の `benches/results/l4_envelope_size_*.json` と比較、5% / 20% 判定
  - 自動 commit で結果ファイル保存
- [ ] **Opus phase-boundary review** (CLAUDE.md §3.3 Step 1): 指摘ゼロまで反復
- [ ] **Codex re-review** (CLAUDE.md §3.3 Step 2): plan PR は recommended skip 可、production code 改修 PR (本 S3) は **plan-PR phase 境界推奨**で 1 round 試行

---

## 4. 対 Opus 単独判断盲点 sweep (Lesson 1-4 防御、PR #99/#102/#103/#104/#105/#107/#108/#109 で 8 連続再発 pattern)

memory `project_adr008_d2_c_plan_done.md` Lesson 1-4 + `feedback_autonomous_phase_transition.md` で蓄積済 User reviewer による Opus 単独 sweep 補正 pattern を本 sub-plan で防御化:

### 4.1 contract 自体の妥当性 review (keyword sweep だけでは catch できない)

**確認項目**:
- [ ] `wrapEnvelope` skeleton 関数 signature が S4 (`desktop_discover/act` commit 軸 wrapper) で **mechanical コピー可能** か? S4 sub-plan で同 wrap pattern を `desktop_act` の response に適用するときに shape integral か? (commit response も `data` field に副作用結果が入る前提で envelope skeleton と整合)
- [ ] compat mode の priority chain (`include=raw` > `include=envelope` > env > default raw) が e2e test で deterministic に再現可能か? race condition (env parsing time vs handler call time) なし?
- [ ] `confidence: degraded` の判定が 2 条件 (size 超過 OR view poisoned) で十分か? 他 degraded triggering 候補 (worker_lag 超過、L1 ring overflow 等) は expansion carry-over として明示されているか?
- [ ] `as_of.wallclock_ms` Date.now() approximation の **trade-off が production 観測で許容範囲** (~5-50ms ズレ) か? S4 caused_by elapsed_ms 計測時に同 source を使うとき integral か?

### 4.2 compile-time guard 過信判定 (cargo check 通っただけで OK 判定しない)

**確認項目**:
- [ ] `npm run build` (tsc) clean だけで envelope wrap が **runtime で正しく動作** することは保証されない、unit test G3-1〜G3-7 で各 priority chain path を runtime 確認必須
- [ ] envelope size bench harness が **CI で実際に走る** ことを `.github/workflows/bench-envelope-size.yml` で確認、main push trigger + 結果保存 + 5%/20% 判定が実機で動くか dry-run

### 4.3 両 doc 順序矛盾 (S3 → S4 直列前提 keyword sweep)

**確認項目**:
- [ ] `docs/walking-skeleton-trunk-selection.md` §4 S3 line 211-231 + §4.1 line 304 直列前提 / 親 plan ADR-010 §7 P1 acceptance / 本 sub-plan §0 (line 25-30) の 4 SSOT で **S3 → S4 着手順序が一致**しているか?
- [ ] `Grep "S3 → S4|S4 (commit|envelope skeleton.*commit"` で 4 SSOT の表記揺れがないか?

### 4.4 restore 後 numeric count sync 漏れ (carry-over → restore で件数表記更新)

**確認項目**:
- [ ] §3 sub-batch 数 (S3-1〜S3-7 = 7 件) と §8 OQ 件数 (3 件) が本 sub-plan 内 / 親 plan walking-skeleton §4.1 line 304 size 想定 (1-2 日 / 200-300 line) と整合か?
- [ ] `Grep "200-300 line\|1-2 日\|7 件\|3 件\|G3 #1-#5"` で本 sub-plan 内 numeric counts が bit-equal か?

### 4.5 既存 public API 破壊禁止 (CLAUDE.md §3.2 PR #102 教訓延長)

**確認項目** (本 trunk の最重要 contract):
- [ ] `desktop_state` の **default behavior が raw shape 維持** (compat mode、§1.1 B + §2.2) — env unset + include 引数なしで既存 e2e test 無修正 pass か?
- [ ] `desktop_state` Zod schema に追加した `include: z.array(z.string()).optional()` が既存 caller の引数指定不要で動作するか? (`.optional()` で defensive 設計)
- [ ] `_post.ts::withPostState` API は本 trunk で **無修正** (§1.1 C + §2.3) か? envelope wrap は outer layer として挿入のみ、`post` block は `data` 内に保持
- [ ] `viewFocusedPipelineStatus` napi binding の `processedCount` field が S2 PR #109 で focus-only 化された後の意味 (Codex P2-B + Round 4 P2-B docs sync) を本 sub-plan で binding 経路として正しく利用しているか? (`poisoned` field のみ参照、processedCount は本 trunk で参照不要)

---

## 5. PR 切り方

| sub-batch | 範囲 | size 想定 |
|---|---|---|
| **S3 (本 PR、merged sub-batch)** | 3.1 _envelope.ts skeleton + 3.2 desktop-state.ts 統合 + 3.3 envelope contract test 7 件 + 3.4 envelope size bench harness + 3.5 検証 + 3.6 G3 ゲート判定 + 3.7 CI workflow + push guard | **200-300 line** (walking-skeleton §4.1 line 304 「S3 envelope minimal wrapper + compat mode + size SLO bench harness」size 想定 1-2 日 / 1 PR で land と整合) |

**1 PR で land**、sub-batch 分割しない (TS-dominant scope、Rust 改修なし、L5 wrapper + 1 tool で完結)。Opus 1 round で十分、Codex re-review は plan-PR phase 境界として **1 round 試行** (CLAUDE.md §3.3 Step 2 production code 改修 PR 推奨、Codex 軸: TypeScript type contract / compat mode behavioural regression)。

`docs/walking-skeleton-trunk-selection.md` §4.1 の S3 概算 **1-2 日 / Opus 1-2 round** に整合 (line 304)。

---

## 6. follow-up (carry-over、§3.bis ledger / OQ で永続化)

trunk + expansion 完了後の別 phase で carry-over:

- **expansion**: 残 ~25 tool への envelope rollout (L5 swimlane で worktree 並走、`docs/walking-skeleton-trunk-selection.md` §6.1 line 363)
- **expansion**: accurate `as_of.wallclock_ms` source 確定 (OQ #1)
- **expansion**: `confidence` 残 3 値 (`cached` / `inferred` / `stale`) 判定 logic
- **expansion**: ADR-010 §5.4 typed reason 37 codes 全網羅 (P2 expansion work)
- **S6 finalize**: `_post.ts` (existing) と `_envelope.ts` (new) の役割境界 (OQ #2)

---

## 7. Risks / Mitigation

| # | Risk | 影響 | Mitigation |
|---|---|---|---|
| R1 | compat mode default が誤って envelope shape になり、既存 LLM client 破壊 | **High** | §3.5 既存 e2e test 無修正 pass を G3 #1 完了基準として pin、env unset + include なしの default path test (Test G3-1) で bit-equal regression guard |
| R2 | `Date.now()` approximation で `as_of.wallclock_ms` がズレ、L4 envelope の "freshness" semantic が不正確 | 中 | OQ #1 carry-over、ADR-010 §5 envelope shape contract は number 型のみ要求 (精度は段階改善可)、production 観測で ~5-50ms ズレを許容 |
| R3 | envelope size threshold 1024 byte が想定外に低く、本 trunk 段階で頻繁に degraded 降格 | 中 | §3.4 size bench harness 5 シナリオで実測、threshold 調整必要なら §2.5 + ADR-010 §5.6.1 + 本 sub-plan §1.1 E を bit-equal sync (Lesson 4 numeric count sync 軸) |
| R4 | `_post.ts` (existing) と `_envelope.ts` (new) の責務重複でメンテ負荷増加 | 中 | OQ #2 で S6 finalize、本 trunk では共存維持 ("`data` 内 `post` block + envelope outer" 二重構造)、混乱回避のため §2.3 carry-over note を `_envelope.ts` 冒頭 doc comment に明記 |
| R5 | `include` 引数の Zod refine validation が既存 caller の引数を誤って reject | 中 | §3.3 Test G3-5 で `include=["unknown_value"]` の InvalidArgs 動作確認、`include` 自体が optional なので default invocation は影響なし |
| R6 | env `DESKTOP_TOUCH_ENVELOPE` parsing が test 環境で stale (test 順序依存) | 低 | env parsing は server startup 時 1 回 cached、test では `vi.stubEnv` 等で per-test isolation、global shared state 回避 |
| R7 | envelope size bench harness の前回 main 比較が CI で flaky (測定誤差で 5% / 20% threshold 跨ぐ) | 中 | Min/Max ではなく median 採用、3 回計測で外れ値除外、bench warm-up runs ≥ 5 で安定化 |

---

## 8. Open Questions (S3 trunk-relevant に絞る、3 件)

| # | OQ | 決定タイミング | 推奨 (Opus 判断委譲) |
|---|---|---|---|
| 1 | `as_of.wallclock_ms` source = Date.now() approximation を採用、accurate L1 event wallclock は expansion で改善。S4 で `caused_by.elapsed_ms` 計測時に同様 wallclock source 必要、その時点で source を確定して両者統合実装 | S4 着手前 | **採用** (本 trunk Date.now() approximation、expansion accurate source、S4 tied)。理由: 本 trunk skeleton で十分、accurate source は napi getter 拡張 (`view_get_focused_with_wallclock`) を S4 と同 timing で起こす方が ROI 高 |
| 2 | `_post.ts` (existing) と `_envelope.ts` (new) の役割境界 — 統合するか共存維持か | S6 finalize | **共存維持** 暫定推奨。理由: trunk 中に `_post.ts` 統合は scope creep、`post` block は ADR-010 envelope の `caused_by` 系セクションに移行可能だが S6 後 expansion で一括対応する方が一貫性高い |
| 3 | compat mode opt-in source = env / include 引数 / 両方 | S3 着手時に確定 (本 sub-plan §2.2) | **両方サポート** に確定済、priority chain (per-call include > env > default raw) も §2.2 で明示。実装上は `resolveEnvelopeOptIn(include)` helper で chain 解決 |

---

## 9. ADR-010 P1 + walking skeleton 全体図 (本 PR の位置づけ)

```
Walking skeleton trunk:
┌──────────────────────────────────────────────────────────────────────┐
│  S1 (PR-η D2-E0): dataflow scope refactor                ✅ merged  │
│      ↓                                                                │
│  S2 (PR-ε D2-C): count-only dirty_rects_aggregate         ✅ merged  │
│      ↓                                                                │
│  S3 (★ 本 PR): ADR-010 P1 envelope minimal wrapper       ⏳ 着手     │
│      + compat mode + desktop_state 適用 + size bench                  │
│      ↓                                                                │
│  S4: desktop_discover/act commit 軸 wrapper (lease 4-tuple)           │
│      ↓                                                                │
│  S5: caused_by linkage cross-layer (★ 最重要 contract)                │
│      ↓                                                                │
│  S6: trunk 完了判定 + CI assert + expansion plan 起草                 │
└──────────────────────────────────────────────────────────────────────┘

S3 内部の envelope wrap layer 図 (本 PR の改修範囲):

[before、S2 merged shape]                          [after、本 S3 PR-? land 後]
desktop_state (raw shape)                          desktop_state (compat mode)
  │                                                   │
  │ existing _post.ts::withPostState                 │ existing _post.ts::withPostState
  ▼                                                   ▼
{ data..., post: { ... } }                         { data..., post: { ... } }
                                                       │
                                                       ▼
                                                    NEW: wrapEnvelope (S3)
                                                       │
                                                       ├ raw mode (default、env / include なし):
                                                       │     return raw  ← bit-equal regression guard
                                                       │
                                                       └ envelope mode (env DESKTOP_TOUCH_ENVELOPE=1
                                                             OR include=["envelope"]):
                                                             {
                                                               _version: "1.0",
                                                               data: { ...raw },
                                                               as_of: { wallclock_ms: Date.now() },
                                                               confidence: "fresh" | "degraded"
                                                             }

view_focused_pipeline_status.poisoned (D2-B-1 napi binding) → wrapEnvelope の degraded 判定 input
envelope size > 1024 byte (ADR-010 §5.6.1) → wrapEnvelope の degraded 判定 input
```

---

## 10. References

- 上位戦略: `docs/walking-skeleton-trunk-selection.md` (Proposed v0.4) §4 S3 (line 211-231) + §5 G3 ゲート (line 343) + §3.2 contract spike 方針
- 概念設計 (parent ADR): `docs/adr-010-presentation-layer-self-documenting-envelope.md` §5 (envelope schema、`_version` / `data` / `as_of` / `confidence`) + §5.5 (Phase 別 P1 構造) + §5.6 (size SLO + bench harness) + §7 P1 acceptance + §10 P1 acceptance criteria
- 統合書 (SSOT): `docs/architecture-3layer-integrated.md` §11.2 (compat mode hoist semantic) + §17.6.1 (`confidence` 値域 SSOT)
- 既存実装:
  - `src/tools/_post.ts` (existing perception envelope + history ring buffer、本 trunk で role boundary OQ #2)
  - `src/tools/desktop-state.ts` (本 trunk で envelope wrap 統合対象、~588 line 既存)
  - `index.d.ts::viewFocusedPipelineStatus` napi binding (D2-B-1、本 trunk で `poisoned` field 参照)
- governance: CLAUDE.md 強制命令 3 (Opus 再レビュー義務) + 3.1 (ADR/plan 複数表 fact 整合) + 3.2 (carry-over scope shrink、PR #102 教訓 → compat mode 必須化に拡張) + 3.3 (PR レビューループ定型) + 7 (仕組みで対応) + 8 (main 直 push 禁止) + 9 (残件は memory ではなく docs/)
- memory: `project_adr008_d2_c_plan_done.md` Lesson 1-4 (User reviewer 補正 pattern、本 sub-plan §4 で防御化) + `feedback_autonomous_phase_transition.md` (新運用モード、phase 移行 autonomous + post-PR review 後追い iteration)
- 同型先例:
  - sub-plan 構造: D2-E0 sub-plan PR #104 (S1) + D2-C sub-plan PR #103 (S2) — count-only contract spike + 3 分類 trunk/expansion/carry-over
  - compat mode 設計: 統合書 §11.2 + 既存 LLM client 互換 e2e test ベース
  - bench harness 設計: D1-5 PR #92 (`benches/d1_view_latency.rs` + `benches/d1_ts_baseline.mjs`) + D2-B PR #98 (`benches/d2_desktop_state_roundtrip.mjs`) — 既存 mjs Node bench pattern を踏襲

---

## Appendix A: 改訂履歴

| version | date | author | summary |
|---|---|---|---|
| Drafted v0.1 | 2026-05-01 | Claude (Sonnet) | 初稿起草、walking skeleton S3 sub-plan、ADR-010 P1 envelope minimal wrapper + compat mode + `desktop_state` 1 tool 適用 + size SLO bench harness + G3 ゲート判定 |

---

END OF ADR-010 P1 S3 sub-plan (Drafted v0.1)。
